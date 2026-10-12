"""Command authentication: HMAC-SHA-256 over a canonical message, verified independently at the gateway.

The control centre and each gateway share a key per key id (rotation = add a new id, retire the old one).
A command is authenticated when it is *sent*, so `issued_at` is the moment it leaves the control centre:

    message = canonical JSON {v, key_id, id, decision, asset, setpoint, kind, issued_at}
    mac     = HMAC-SHA-256(key[key_id], message)            (full 256-bit tag, hex)

The gateway recomputes the tag with its own copy of the key (constant-time compare), rejects unknown key ids,
messages older than `max_age_s` (or from the future beyond clock skew), and command ids it has already
accepted (replay). This is message authentication, not a public-key signature; deployments that need
non-repudiation at the gateway should swap in an asymmetric scheme (e.g. Ed25519) behind the same envelope.
The audit hash chain is a separate mechanism (tamper evidence for the log), not command authentication.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass, field

ALG = "HMAC-SHA256"
VERSION = 1


def canonical(cmd_id: str, decision_id: str, asset_id: str, setpoint: float, kind: str, issued_at: float, key_id: str) -> bytes:
    body = {
        "v": VERSION,
        "key_id": key_id,
        "id": cmd_id,
        "decision": decision_id,
        "asset": asset_id,
        "setpoint": f"{setpoint:.2f}",  # fixed decimal text: no float-formatting ambiguity between parties
        "kind": kind,
        "issued_at": f"{issued_at:.3f}",
    }
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def mac(key: bytes, message: bytes) -> str:
    return hmac.new(key, message, hashlib.sha256).hexdigest()


def envelope(key: bytes, key_id: str, cmd_id: str, decision_id: str, asset_id: str, setpoint: float, kind: str, issued_at: float) -> dict:
    msg = canonical(cmd_id, decision_id, asset_id, setpoint, kind, issued_at, key_id)
    return {"alg": ALG, "v": VERSION, "key_id": key_id, "issued_at": round(issued_at, 3), "mac": mac(key, msg)}


@dataclass
class CommandVerifier:
    """Gateway-side check. Holds its own key ring; never trusts anything but the message fields and its keys."""

    keys: dict[str, bytes]
    max_age_s: float = 30.0
    max_skew_s: float = 5.0
    seen: dict[str, float] = field(default_factory=dict)  # accepted command id → issued_at

    def verify(self, auth: dict | None, cmd_id: str, decision_id: str, asset_id: str, setpoint: float, kind: str, now: float) -> tuple[bool, str]:
        if not auth or auth.get("alg") != ALG or auth.get("v") != VERSION:
            return False, "missing or unsupported authentication"
        key = self.keys.get(auth.get("key_id", ""))
        if key is None:
            return False, f"unknown key id {auth.get('key_id')!r}"
        issued = float(auth.get("issued_at", 0.0))
        if now - issued > self.max_age_s:
            return False, f"stale command ({now - issued:.0f} s old)"
        if issued - now > self.max_skew_s:
            return False, "issued in the future (clock skew)"
        expect = mac(key, canonical(cmd_id, decision_id, asset_id, setpoint, kind, issued, auth["key_id"]))
        if not hmac.compare_digest(expect, str(auth.get("mac", ""))):
            return False, "authentication tag mismatch"
        if cmd_id in self.seen:
            return False, "replayed command id"
        self.seen[cmd_id] = issued
        if len(self.seen) > 20000:  # bounded memory: forget ids well past the freshness window
            cutoff = now - 10 * self.max_age_s
            self.seen = {k: v for k, v in self.seen.items() if v >= cutoff}
        return True, "ok"
