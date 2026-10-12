"""Command lifecycle: approval → send → ack → execute → verify, with timeouts and no blind resend.

    AWAITING_APPROVAL ─approve→ READY ─send→ SENT ─ack→ ACKED → EXECUTING → COMPLETED
                                              └ timeout → FAILED (asset excluded, alarm, re-solve)
    any non-terminal → CANCELLED (rejected/aborted) · SUPERSEDED (newer setpoint for the asset)
Commands are idempotent (command_id) and authenticated with HMAC-SHA-256 when sent (see cmdauth.py); the
gateway verifies the tag, freshness and replay independently and de-duplicates on command_id.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from typing import Protocol

from ..grid.topology import topology
from .cmdauth import envelope

ACK_TIMEOUT_S = 90.0
TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "SUPERSEDED"}


class Gateway(Protocol):
    def send_setpoint(self, asset_id: str, setpoint: float, command_id: str, now: float, auth: dict | None = None, decision_id: str = "", kind: str = "DISPATCH") -> None: ...

    def ack_time(self, asset_id: str, command_id: str) -> float | None: ...


@dataclass
class Command:
    id: str
    decision_id: str
    asset_id: str
    asset_name: str
    protocol: str
    setpoint: float
    expected_mw: float
    kind: str  # DISPATCH | RELEASE
    state: str
    created: float
    requires_approval: bool
    signature: str  # HMAC tag (hex) once sent; empty until then
    sent_at: float | None = None
    acked_at: float | None = None
    executing_at: float | None = None
    closed_at: float | None = None
    delivered_mw: float = 0.0
    under_delivering: bool = False
    auth: dict | None = None  # {alg, v, key_id, issued_at, mac}
    note: str = ""
    history: list[tuple[float, str]] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    def move(self, state: str, now: float, note: str = "") -> None:
        self.state = state
        self.history.append((now, state))
        if note:
            self.note = note
        if state in TERMINAL:
            self.closed_at = now


@dataclass
class CommandManager:
    key: str  # command-authentication key (shared with gateways under key_id)
    key_id: str = "k1"
    commands: dict[str, Command] = field(default_factory=dict)
    events: list[tuple[str, Command]] = field(default_factory=list)  # drained by runtime

    def create(self, decision_id: str, asset_id: str, setpoint: float, expected: float, requires_approval: bool, now: float, kind: str = "DISPATCH") -> Command:
        a = topology().asset(asset_id) if asset_id != "RTM" else {"name": "RTM purchase", "protocol": "Exchange API"}
        cid = "CMD-" + uuid.uuid4().hex[:10].upper()
        # supersede older live commands for the same asset
        for c in self.commands.values():
            if c.asset_id == asset_id and c.state not in TERMINAL:
                c.move("SUPERSEDED", now, f"superseded by {cid}")
                self.events.append(("superseded", c))
        cmd = Command(
            id=cid,
            decision_id=decision_id,
            asset_id=asset_id,
            asset_name=a["name"],
            protocol=a["protocol"],
            setpoint=round(setpoint, 2),
            expected_mw=round(expected, 2),
            kind=kind,
            state="AWAITING_APPROVAL" if requires_approval else "READY",
            created=now,
            requires_approval=requires_approval,
            signature="",
        )
        cmd.history.append((now, cmd.state))
        self.commands[cid] = cmd
        self.events.append(("created", cmd))
        return cmd

    def approve(self, decision_id: str, now: float) -> int:
        n = 0
        for c in self.commands.values():
            if c.decision_id == decision_id and c.state == "AWAITING_APPROVAL":
                c.move("READY", now, "approved")
                n += 1
        return n

    def cancel(self, decision_id: str, now: float, reason: str) -> int:
        n = 0
        for c in self.commands.values():
            if c.decision_id == decision_id and c.state in ("AWAITING_APPROVAL", "READY"):
                c.move("CANCELLED", now, reason)
                self.events.append(("cancelled", c))
                n += 1
        return n

    def live_setpoints(self) -> dict[str, float]:
        """Setpoint the field should currently be following, per asset (last ACKED/EXECUTING or in flight)."""
        out: dict[str, float] = {}
        for c in sorted(self.commands.values(), key=lambda c: c.created):
            if c.state in ("SENT", "ACKED", "EXECUTING", "COMPLETED") and c.kind in ("DISPATCH", "RELEASE"):
                out[c.asset_id] = c.setpoint
        return out

    def tick(self, now: float, gw: Gateway, asset_state: dict[str, dict]) -> None:
        for c in list(self.commands.values()):
            if c.state == "READY":
                if c.asset_id == "RTM":
                    c.move("EXECUTING", now, "RTM bid placed")
                    c.sent_at = c.acked_at = c.executing_at = now
                    self.events.append(("executing", c))
                    continue
                c.auth = envelope(self.key.encode(), self.key_id, c.id, c.decision_id, c.asset_id, c.setpoint, c.kind, now)
                c.signature = c.auth["mac"]
                gw.send_setpoint(c.asset_id, c.setpoint, c.id, now, c.auth, c.decision_id, c.kind)
                c.sent_at = now
                c.move("SENT", now)
                self.events.append(("sent", c))
            elif c.state == "SENT":
                ack = gw.ack_time(c.asset_id, c.id)
                if ack is not None:
                    c.acked_at = ack
                    if c.setpoint > 0:
                        c.executing_at = now
                        c.move("EXECUTING", now)
                    else:
                        c.move("COMPLETED", now, "released")
                    self.events.append(("acked", c))
                elif now - (c.sent_at or now) > ACK_TIMEOUT_S:
                    c.move("FAILED", now, f"no acknowledgement within {ACK_TIMEOUT_S:.0f} s — not resent; asset excluded and plan re-solved")
                    self.events.append(("failed", c))
            elif c.state == "EXECUTING" and c.asset_id != "RTM":
                spec = topology().asset(c.asset_id)
                c.delivered_mw = float(asset_state.get(c.asset_id, {}).get("mw", 0.0))
                settle = spec["responseMin"] * 60 + (c.setpoint / max(spec["rampMWpm"], 0.1)) * 60 + 120
                if now - (c.executing_at or now) > settle:
                    was = c.under_delivering
                    c.under_delivering = c.delivered_mw < 0.7 * c.expected_mw
                    if c.under_delivering and not was:
                        self.events.append(("under", c))

    def for_decision(self, decision_id: str) -> list[Command]:
        return sorted((c for c in self.commands.values() if c.decision_id == decision_id), key=lambda c: c.created)

    def prune(self, keep: int = 5000) -> None:
        if len(self.commands) > keep:
            done = sorted((c for c in self.commands.values() if c.state in TERMINAL), key=lambda c: c.created)
            for c in done[: len(self.commands) - keep]:
                self.commands.pop(c.id, None)
