"""GridFlex — C&I demand response: participants, flexible processes, offers, baselines and M&V.

An industry does not hand the grid an off-switch. It declares a *flexibility envelope* — what it can safely
change, how fast, for how long, how often, and at what price — as an offer for a time window. ADRMS may only
dispatch an industry inside an accepted offer and on that offer's terms.

Measurement & verification (per participant, per 15-min block t of an event):
    B_t  baseline demand (what it would have drawn without the event)          MW
    M_t  metered demand during the event (block average)                       MW
    R_t  = max(0, B_t − M_t)                     estimated reduction            MW
    A_t  accepted reduction (dispatched, capped at the offer)                   MW
    V_t  = min(R_t, A_t)                         verified reduction             MW
    E    = Σ_t V_t · Δt                          delivered energy               MWh
    pay  = E · P + availability (if the programme pays one) − adjustments      ₹
Adjustments: delivering under half the accepted energy forfeits the energy payment for the shortfall
band (performance factor, same rule as every other resource); disputes hold payment until resolved.

Baseline method (versioned): same-day pre-event average — mean metered demand over the hour before the event
(the last 4 blocks), bounded to ±10 % of the declared operating level so a pre-event ramp-down cannot inflate it.
Programme values (prices, windows, availability rates) here are demonstration data, not regulatory defaults.
"""

from __future__ import annotations

import hashlib
from collections import deque
from dataclasses import asdict, dataclass, field

from ..core.clock import BLOCK_S, Clock
from ..grid.topology import topology

BASELINE_METHOD = "SDA-1h-v1"  # same-day average of the hour before the event, ±10 % of declared level
BASELINE_DESC = "Mean metered demand over the 4 blocks before the event, bounded to ±10 % of the declared operating level"
BLOCK_H = 0.25

# flexible-process templates: (name, share of the flexible range, extra response min, max duration factor, restriction)
PROCESSES = [
    ("Process load trim inside approved envelope", 0.45, 0, 1.0, "Not below minimum stable load"),
    ("Batch / furnace rescheduling", 0.35, 5, 0.75, "No activation during a critical production stage"),
    ("Non-critical HVAC, compressors & pumping", 0.20, -5, 1.0, "Cooling of critical areas kept"),
]
# demonstration offer windows (sim-day hh:mm) — evening peak is the classic industrial DR window
WINDOWS = [("06:00", "23:00"), ("10:00", "22:00"), ("17:00", "23:30"), ("00:00", "23:59")]


def _hm(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 3600 + int(m) * 60


def _h(seed: str) -> int:
    return int(hashlib.sha256(seed.encode()).hexdigest(), 16)


@dataclass
class Offer:
    id: str
    participant: str
    mw: float
    window: tuple[str, str]
    response_min: float
    min_activation_min: float
    max_duration_min: float
    recovery_min: float
    price_rs_mwh: float
    availability_rs_mw_h: float
    reliability: float
    restrictions: str
    kind: str  # "committed" (programme contract) | "voluntary"
    status: str = "SUBMITTED"  # SUBMITTED → ACCEPTED | REJECTED · WITHDRAWN
    submitted_at: float = 0.0
    decided_by: str | None = None
    decided_at: float | None = None
    note: str = ""

    def covers(self, now: float) -> bool:
        sec = int((now + 19800) % 86400)  # IST seconds of day
        a, b = _hm(self.window[0]), _hm(self.window[1])
        return a <= sec <= b if a <= b else (sec >= a or sec <= b)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class MV:
    """Per event × participant verification record."""

    decision_id: str
    participant: str
    offer_id: str | None
    baseline_mw: float
    baseline_method: str
    price_rs_mwh: float
    blocks: list[dict] = field(default_factory=list)  # {block, label, B, M, R, A, V}
    started: float = 0.0
    status: str = "VERIFYING"  # VERIFYING → SETTLED | DISPUTED
    energy_mwh: float = 0.0
    accepted_mwh: float = 0.0
    payment_rs: float = 0.0
    availability_rs: float = 0.0
    adjustment_rs: float = 0.0
    dispute: str | None = None
    _acc: dict = field(default_factory=dict)  # running block accumulator

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("_acc", None)
        return d


@dataclass
class IndustrialRegistry:
    participants: dict[str, dict] = field(default_factory=dict)
    offers: dict[str, Offer] = field(default_factory=dict)
    meter: dict[str, deque] = field(default_factory=dict)  # participant → (ts, MW) samples
    mv: dict[tuple[str, str], MV] = field(default_factory=dict)
    _n: int = 0

    def __post_init__(self) -> None:
        t = topology()
        for a in t.assets:
            if a["type"] != "industrial":
                continue
            flex = max(0.0, a["baselineMW"] - a["minLoadMW"])
            procs = []
            for i, (name, share, dresp, fdur, restr) in enumerate(PROCESSES):
                procs.append(
                    {
                        "id": f"{a['id']}-P{i + 1}",
                        "name": name,
                        "mw": round(flex * share, 1),
                        "response_min": max(2.0, a["responseMin"] + dresp),
                        "ramp_mw_per_min": round(a["rampMWpm"] * share, 1),
                        "max_duration_min": round(a["maxDurationMin"] * fdur),
                        "recovery_min": a["recoveryMin"],
                        "restriction": restr,
                    }
                )
            self.participants[a["id"]] = {
                "id": a["id"],
                "name": a["name"],
                "short": a["short"],
                "discom": a["discom"],
                "connection": f"{a['bus']} 220 kV",
                "contracted_demand_mw": a["maxLoadMW"],
                "declared_level_mw": a["baselineMW"],
                "min_stable_mw": a["minLoadMW"],
                "meter": f"ABT-{a['id'][2:]}-01",
                "control": a["protocol"],
                "operating_hours": "24×7 continuous process",
                "contact": "Plant energy control room",
                "description": a.get("description", ""),
                "processes": procs,
            }

    # ------------------------------------------------------------------ offers
    def seed_offers(self, now: float, reliability: dict[str, float]) -> None:
        """Demonstration offers for the day: committed programme offers are accepted; two voluntary offers wait."""
        t = topology()
        for k, (pid, p) in enumerate(self.participants.items()):
            a = t.asset(pid)
            h = _h(pid)
            mw = min(a["reserve"]["state"], a["contractMW"], sum(x["mw"] for x in p["processes"]))
            voluntary = k in (2, 6)
            o = self._new_offer(
                pid,
                mw=mw,
                window=WINDOWS[h % len(WINDOWS)],
                response_min=a["responseMin"],
                min_activation_min=30.0,
                max_duration_min=a["maxDurationMin"],
                recovery_min=a["recoveryMin"],
                price_rs_mwh=round(a["bidRs"] * 1000),
                availability_rs_mw_h=0.0 if voluntary else 150.0,
                reliability=reliability.get(pid, a["reliability"]),
                restrictions=p["processes"][1]["restriction"],
                kind="voluntary" if voluntary else "committed",
                now=now,
            )
            if not voluntary:
                o.status, o.decided_by, o.decided_at, o.note = "ACCEPTED", "programme", now, "Committed programme offer"

    def _new_offer(self, pid: str, now: float, **kw) -> Offer:
        self._n += 1
        o = Offer(id=f"OF-{self._n:03d}", participant=pid, submitted_at=now, **kw)
        self.offers[o.id] = o
        return o

    def submit(self, pid: str, now: float, **kw) -> Offer:
        if pid not in self.participants:
            raise KeyError(pid)
        p = self.participants[pid]
        flex = sum(x["mw"] for x in p["processes"])
        if not 0 < kw["mw"] <= flex + 1e-6:
            raise ValueError(f"offer must be between 0 and the declared flexible range ({flex:.0f} MW)")
        if kw["max_duration_min"] < kw["min_activation_min"]:
            raise ValueError("maximum duration is shorter than the minimum activation")
        for o in self.offers.values():  # one live offer per participant and window
            if o.participant == pid and o.status in ("SUBMITTED", "ACCEPTED") and o.window == tuple(kw["window"]):
                o.status, o.note = "WITHDRAWN", "superseded by a new offer"
        kw["window"] = tuple(kw["window"])
        return self._new_offer(pid, now, **kw)

    def decide(self, offer_id: str, status: str, user: str, now: float, note: str = "") -> Offer:
        o = self.offers[offer_id]
        if status == "WITHDRAWN":
            if o.status not in ("SUBMITTED", "ACCEPTED"):
                raise ValueError(f"offer is {o.status}")
        elif o.status != "SUBMITTED":
            raise ValueError(f"offer is {o.status}, not awaiting a decision")
        o.status, o.decided_by, o.decided_at, o.note = status, user, now, note
        return o

    def active_offer(self, pid: str, now: float) -> Offer | None:
        live = [o for o in self.offers.values() if o.participant == pid and o.status == "ACCEPTED" and o.covers(now)]
        return max(live, key=lambda o: o.submitted_at, default=None)

    def terms(self, asset: dict, now: float) -> tuple[dict, str | None]:
        """Asset as the optimiser may use it now: inside an accepted offer and on its terms, else excluded."""
        if asset["type"] != "industrial":
            return asset, None
        o = self.active_offer(asset["id"], now)
        if o is None:
            pending = any(x.participant == asset["id"] and x.status == "SUBMITTED" for x in self.offers.values())
            return asset, "Offer awaiting acceptance" if pending else "No accepted offer covering this time window"
        a = dict(asset)
        a["contractMW"] = min(asset["contractMW"], o.mw)
        a["reserve"] = {**asset["reserve"], "state": min(asset["reserve"]["state"], o.mw)}
        a["bidRs"] = o.price_rs_mwh / 1000
        a["responseMin"] = o.response_min
        a["maxDurationMin"] = o.max_duration_min
        a["recoveryMin"] = o.recovery_min
        return a, None

    def offered_mw(self, now: float) -> float:
        return sum(o.mw for pid in self.participants if (o := self.active_offer(pid, now)))

    # ------------------------------------------------------------------ metering & M&V
    def record_meter(self, now: float, loads: dict[str, float]) -> None:
        for pid, mw in loads.items():
            if pid in self.participants:
                q = self.meter.setdefault(pid, deque(maxlen=720))
                q.append((now, mw))

    def baseline(self, pid: str, start: float) -> float:
        p = self.participants[pid]
        pre = [mw for ts, mw in self.meter.get(pid, ()) if start - 4 * BLOCK_S <= ts < start]
        level = p["declared_level_mw"]
        b = sum(pre) / len(pre) if pre else level
        return max(0.9 * level, min(1.1 * level, b))

    def tick(self, decision_id: str | None, setpoints: dict[str, float], now: float, dt: float) -> None:
        """Accumulate block-average metered demand and accepted MW for every industry in the active event."""
        if not decision_id:
            return
        for pid, sp in setpoints.items():
            if pid not in self.participants:
                continue
            key = (decision_id, pid)
            rec = self.mv.get(key)
            if rec is None:
                if sp <= 0.5:
                    continue
                o = self.active_offer(pid, now)
                rec = self.mv[key] = MV(decision_id, pid, o.id if o else None, round(self.baseline(pid, now), 1), BASELINE_METHOD, o.price_rs_mwh if o else topology().asset(pid)["bidRs"] * 1000, started=now)
            if rec.status != "VERIFYING":
                continue
            q = self.meter.get(pid)
            m = q[-1][1] if q else rec.baseline_mw
            cap = (self.offers[rec.offer_id].mw if rec.offer_id in self.offers else sp)
            blk = Clock.block_of(now)
            acc = rec._acc
            if acc.get("block") != blk and acc.get("w", 0) > 0:
                self._close_block(rec)
            if acc.get("block") != blk:
                rec._acc = acc = {"block": blk, "label": Clock.hhmmss(now)[:5], "w": 0.0, "m": 0.0, "a": 0.0}
            acc["w"] += dt
            acc["m"] += m * dt
            acc["a"] += min(sp, cap) * dt

    def _close_block(self, rec: MV) -> None:
        acc = rec._acc
        w = acc["w"]
        B, M, A = rec.baseline_mw, acc["m"] / w, acc["a"] / w
        R = max(0.0, B - M)
        V = min(R, A)
        h = w / 3600
        rec.blocks.append({"block": acc["block"], "label": acc["label"], "hours": round(h, 3), "B": round(B, 1), "M": round(M, 1), "R": round(R, 1), "A": round(A, 1), "V": round(V, 1)})
        rec.energy_mwh += V * h
        rec.accepted_mwh += A * h
        rec._acc = {}

    def settle(self, decision_id: str, now: float) -> dict[str, dict]:
        """Close every open record for this event; returns overrides for the event settlement, per participant."""
        out = {}
        for (did, pid), rec in self.mv.items():
            if did != decision_id or rec.status != "VERIFYING":
                continue
            if rec._acc.get("w", 0) > 0:
                self._close_block(rec)
            o = self.offers.get(rec.offer_id or "")
            perf = rec.energy_mwh / rec.accepted_mwh if rec.accepted_mwh > 1e-6 else 1.0
            pf = 1.0 if perf >= 0.9 else 0.0 if perf <= 0.5 else (perf - 0.5) / 0.4
            energy_pay = rec.energy_mwh * rec.price_rs_mwh
            hours = sum(b["hours"] for b in rec.blocks)
            rec.availability_rs = round((o.availability_rs_mw_h if o else 0.0) * (o.mw if o else 0.0) * hours, 0)
            rec.adjustment_rs = round(-energy_pay * (1 - pf), 0)
            rec.payment_rs = round(energy_pay + rec.availability_rs + rec.adjustment_rs, 0)
            rec.status = "SETTLED"
            out[pid] = {"delivered_mwh": rec.energy_mwh, "expected_mwh": rec.accepted_mwh, "payment_rs": rec.payment_rs, "performance": perf, "perf_factor": pf, "rate_rs": rec.price_rs_mwh / 1000, "basis": f"baseline {BASELINE_METHOD}"}
        return out

    def dispute(self, decision_id: str, pid: str, reason: str) -> MV:
        rec = self.mv[(decision_id, pid)]
        if rec.status not in ("SETTLED", "VERIFYING"):
            raise ValueError(f"record is {rec.status}")
        rec.status, rec.dispute = "DISPUTED", reason
        return rec

    def resolve(self, decision_id: str, pid: str, outcome: str, adjust_rs: float = 0.0) -> MV:
        rec = self.mv[(decision_id, pid)]
        if rec.status != "DISPUTED":
            raise ValueError("record is not disputed")
        rec.adjustment_rs += adjust_rs
        rec.payment_rs = round(rec.payment_rs + adjust_rs, 0)
        rec.status, rec.dispute = "SETTLED", f"{rec.dispute} → resolved: {outcome}"
        return rec

    # ------------------------------------------------------------------ views
    def view(self, now: float, reliability: dict[str, float], live: dict[str, float]) -> list[dict]:
        out = []
        for pid, p in self.participants.items():
            o = self.active_offer(pid, now)
            # otherwise show the live offer that is waiting for its window or for acceptance
            shown = o or max((x for x in self.offers.values() if x.participant == pid and x.status in ("ACCEPTED", "SUBMITTED")), key=lambda x: x.submitted_at, default=None)
            hist = [r for (d, q), r in self.mv.items() if q == pid]
            settled = [r for r in hist if r.status in ("SETTLED", "DISPUTED")]
            q = self.meter.get(pid)
            out.append(
                {
                    **p,
                    "reliability": reliability.get(pid, topology().asset(pid)["reliability"]),
                    "metered_mw": q[-1][1] if q else None,
                    "baseline_now_mw": round(self.baseline(pid, now), 1),
                    "activated_mw": round(live.get(pid, 0.0), 1),
                    "offer": ({**shown.to_dict(), "in_window": shown.covers(now) and shown.status == "ACCEPTED"} if shown else None),
                    "events": len(hist),
                    "verified_mwh": round(sum(r.energy_mwh for r in settled), 2),
                    "paid_rs": round(sum(r.payment_rs for r in settled), 0),
                    "disputes": sum(1 for r in hist if r.status == "DISPUTED"),
                }
            )
        return out
