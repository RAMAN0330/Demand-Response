"""Emergency load management: load rotation (feeder rostering) — the last resort for over-drawal.

Order of resort for an over-drawal (OD): paid flexibility first (DR, BESS, generation, RTM). Only the
residual that flexibility cannot cover, while frequency is below the IEGC band, becomes a shedding
order — and an order only takes effect after shift-in-charge approval (never autonomous).

Each DISCOM's 220 kV stations are grouped into roster groups (A, B, C …) of about four stations. Shedding a group opens the
non-essential 11 kV feeders on its stations; essential feeders (hospitals, water works, railway
traction, defence) are never on the roster. Groups rotate so no area carries the outage:
a spell lasts at most `max_spell_min`, a group sheds at most `max_daily_min` a day, a group that
was just restored rests for a full spell, and the DISCOM split follows each DISCOM's share of load.
Restoration is staggered to avoid a rebound spike. Under-drawal is never addressed by shedding.
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field

from ksfp.core.clock import Clock
from ksfp.ingest.channels import channels

LETTERS = "ABCDEFGHIJKL"
# The shipped roster is DEMONSTRATION data: groups are built from 220 kV stations, the sheddable share is a flat
# 30 % and protected-feeder counts are generated. It cannot establish that any real feeder is safe to open —
# replace it with the DISCOM's approved feeder-level roster (measured loads, protected classifications,
# switching authority) before any operational use. Independent UFR / df/dt protection is never touched here.
ROSTER_SOURCE = "DEMO"
STATIONS_PER_GROUP = 4  # roster blocks of ~3–4 stations keep each step small (≈100–250 MW)
PROTECTED = ["Hospitals", "Water works", "Railway traction", "Defence"]


@dataclass
class ShedPolicy:
    max_spell_min: float = 45.0
    max_daily_min: float = 120.0
    trigger_freq: float = 49.90  # shedding may be proposed below this frequency (IEGC lower band) …
    # … or when uncovered over-drawal stays beyond the DSM deviation band at any frequency. None = follow the
    # DSM rule table live (min(band % of schedule, band cap) — 100 MW for a large state); a number overrides it.
    od_limit_mw: float | None = None
    emergency_freq: float = 49.80  # below this a proposal is raised without waiting for the hold
    min_residual_mw: float = 50.0  # residual OD (after flexibility) worth shedding for
    hold_s: float = 120.0  # residual must persist this long before a proposal
    restore_stagger_s: float = 120.0  # one group back every N seconds
    restore_margin_mw: float = 40.0  # hysteresis before giving load back
    sheddable_frac: float = 0.30  # share of a 220 kV station's load on rosterable (non-essential) feeders
    dual_auth_mw: float = 200.0
    protected: list[str] = field(default_factory=lambda: list(PROTECTED))
    # fairness score F = w_h·H + w_n·N + w_d·D over the last `history_days` (each term normalised 0–1 across groups):
    # H interruption hours, N number of interruptions, D length of the latest interruption. Lower F goes first.
    fairness_weights: tuple[float, float, float] = (0.5, 0.3, 0.2)
    history_days: float = 7.0
    shortfall_ratio: float = 0.9  # escalate when metered relief stays below this share of the planned MW …
    shortfall_hold_s: float = 120.0  # … for this long


@dataclass
class RosterGroup:
    id: str
    discom: str
    letter: str
    name: str
    channels: list[str]
    bus_frac: dict[str, float]  # parent bus → share of that bus's load on this group's stations
    lat: float
    lon: float
    protected: dict[str, int]
    state: str = "AVAILABLE"  # AVAILABLE | SHED | RESTORING
    since: float | None = None
    until: float | None = None
    minutes_today: float = 0.0
    spells_today: int = 0
    last_restored: float | None = None
    order_id: str | None = None
    history: list[list] = field(default_factory=list)  # [start, end|None] interruptions, kept for history_days
    fairness: dict = field(default_factory=dict)  # {F, H_h, N, D_min} — last computed

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ShedOrder:
    id: str
    created: float
    mw: float
    reason: str
    source: str  # "auto" or "operator:<user>"
    state: str = "PROPOSED"  # PROPOSED → ACTIVE → COMPLETED | REJECTED | CANCELLED
    approvals: list[dict] = field(default_factory=list)
    needs_dual: bool = False
    activated: float | None = None
    closed: float | None = None
    closed_reason: str = ""
    shed_minutes_mw: float = 0.0  # ∫ shed MW dt, MW·min (energy not served)
    peak_mw: float = 0.0
    rotations: int = 0
    log: list[dict] = field(default_factory=list)
    planned_mw: float = 0.0  # forecast relief of the groups currently off (roster model)
    measured_mw: float = 0.0  # metered relief (feeder metering)
    short_since: float | None = None
    escalated: bool = False
    selection: list[dict] = field(default_factory=list)  # why each group was picked or passed over (latest pick)

    def to_dict(self) -> dict:
        return asdict(self)


def _protected_counts(gid: str, n_stations: int) -> dict[str, int]:
    h = hashlib.sha256(gid.encode()).digest()
    return {"Hospitals": 1 + h[0] % (2 + n_stations), "Water works": 1 + h[1] % 3, "Railway traction": h[2] % 2, "Defence": h[3] % 2}


def build_groups(ch: dict | None = None) -> list[RosterGroup]:
    """Roster groups: each DISCOM's stations split north→south into contiguous blocks of ~4 stations (A, B, C …)."""
    ch = ch or channels()
    loads = ch["load_channels"]
    wsum: dict[str, float] = {}
    for c in loads:
        wsum[c["parent_bus"]] = wsum.get(c["parent_bus"], 0.0) + c["weight"]
    by_discom: dict[str, list[dict]] = {}
    for c in loads:
        by_discom.setdefault(c["discom"], []).append(c)
    groups: list[RosterGroup] = []
    for discom, cs in sorted(by_discom.items()):
        cs = sorted(cs, key=lambda c: (-c["lat"], c["lon"]))
        k = max(1, min(len(LETTERS), -(-len(cs) // STATIONS_PER_GROUP)))
        for i in range(k):
            members = cs[i * len(cs) // k : (i + 1) * len(cs) // k]
            frac: dict[str, float] = {}
            for c in members:
                frac[c["parent_bus"]] = frac.get(c["parent_bus"], 0.0) + c["weight"] / wsum[c["parent_bus"]]
            gid = f"RG_{discom}_{LETTERS[i]}"
            first, last = members[0]["name"], members[-1]["name"]
            groups.append(
                RosterGroup(
                    id=gid,
                    discom=discom,
                    letter=LETTERS[i],
                    name=f"{discom} {LETTERS[i]} · {first}" + (f"–{last}" if last != first else ""),
                    channels=[c["id"] for c in members],
                    bus_frac=frac,
                    lat=sum(c["lat"] for c in members) / len(members),
                    lon=sum(c["lon"] for c in members) / len(members),
                    protected=_protected_counts(gid, len(members)),
                )
            )
    return groups


class RosterManager:
    def __init__(self, policy: ShedPolicy | None = None) -> None:
        self.policy = policy or ShedPolicy()
        self.groups: dict[str, RosterGroup] = {g.id: g for g in build_groups()}
        self.orders: dict[str, ShedOrder] = {}
        self.events: list[tuple[str, dict]] = []  # drained by runtime → bus + audit + alarms
        self.need_since: float | None = None
        self.clear_since: float | None = None
        self.residual_mw = 0.0
        self.dsm_band_mw = 100.0  # refreshed every tick from the DSM rule table and schedule
        self.day = None
        self.last_tick: float | None = None
        self.last_restore: float = 0.0
        self._n = 0

    # ------------------------------------------------------------------ helpers
    def group_mw(self, g: RosterGroup, bus_load: dict[str, float]) -> float:
        return sum(bus_load.get(b, 0.0) * f for b, f in g.bus_frac.items()) * self.policy.sheddable_frac

    def shed_fraction(self) -> dict[str, float]:
        """Per-bus fraction of load currently disconnected — applied by the field model."""
        out: dict[str, float] = {}
        for g in self.groups.values():
            if g.state == "SHED":
                for b, f in g.bus_frac.items():
                    out[b] = out.get(b, 0.0) + f * self.policy.sheddable_frac
        return out

    def shed_mw(self, bus_load: dict[str, float]) -> float:
        return sum(self.group_mw(g, bus_load) for g in self.groups.values() if g.state == "SHED")

    @property
    def od_limit(self) -> float:
        return self.policy.od_limit_mw if self.policy.od_limit_mw is not None else self.dsm_band_mw

    def needs_relief(self, frequency: float, residual_mw: float) -> bool:
        """Uncovered over-drawal worth shedding for: low frequency, or beyond the DSM deviation band."""
        p = self.policy
        return residual_mw >= p.min_residual_mw and (frequency < p.trigger_freq or residual_mw > self.od_limit)

    def open_order(self) -> ShedOrder | None:
        return next((o for o in self.orders.values() if o.state in ("PROPOSED", "ACTIVE", "RESTORING")), None)

    def _emit(self, kind: str, msg: str, order: ShedOrder | None = None, **extra) -> None:
        payload = {"msg": msg, "order": order.to_dict() if order else None, **extra}
        if order:
            order.log.append({"t": self.last_tick, "kind": kind, "msg": msg})
        self.events.append((kind, payload))

    def _eligible(self, now: float, exclude: set[str]) -> list[RosterGroup]:
        p = self.policy
        out = []
        for g in self.groups.values():
            if g.state != "AVAILABLE" or g.id in exclude:
                continue
            if p.max_daily_min - g.minutes_today < 10:
                continue  # daily limit reached
            if g.last_restored is not None and now - g.last_restored < p.max_spell_min * 60:
                continue  # resting after its last spell
            out.append(g)
        return out

    def fairness(self, now: float) -> dict[str, dict]:
        """F_j = w_h·H_j + w_n·N_j + w_d·D_j, each term normalised by its maximum across groups (0 if none)."""
        p = self.policy
        since = now - p.history_days * 86400
        raw = {}
        for g in self.groups.values():
            g.history = [h for h in g.history if (h[1] or now) >= since]
            spells = [(max(h[0], since), h[1] or now) for h in g.history]
            hrs = sum(b - a for a, b in spells) / 3600
            last = (spells[-1][1] - spells[-1][0]) / 60 if spells else 0.0
            raw[g.id] = (hrs, len(spells), last)
        mx = [max((v[i] for v in raw.values()), default=0.0) or 1.0 for i in range(3)]
        w = p.fairness_weights
        out = {}
        for gid, (h, n, d) in raw.items():
            f = w[0] * h / mx[0] + w[1] * n / mx[1] + w[2] * d / mx[2]
            out[gid] = self.groups[gid].fairness = {"F": round(f, 3), "H_h": round(h, 2), "N": n, "D_min": round(d, 1)}
        return out

    def _why_not(self, g: RosterGroup, now: float, exclude: set[str]) -> str | None:
        p = self.policy
        if g.state != "AVAILABLE":
            return "already rotated out"
        if g.id in exclude:
            return "being replaced in this rotation"
        if p.max_daily_min - g.minutes_today < 10:
            return f"daily limit reached ({g.minutes_today:.0f}/{p.max_daily_min:.0f} min)"
        if g.last_restored is not None and now - g.last_restored < p.max_spell_min * 60:
            return f"resting until {Clock.hhmmss(g.last_restored + p.max_spell_min * 60)[:5]}"
        return None

    def select(self, mw: float, bus_load: dict[str, float], now: float, exclude: set[str] | None = None, order: ShedOrder | None = None) -> list[RosterGroup]:
        """Fair pick: split the MW across DISCOMs by load share, then the lowest fairness score F within each
        (least recent interruption burden). Hard exclusions (protected feeders are never on the roster; daily limit;
        rest after a spell) always win over the score. Every pick and every exclusion is recorded with its reason."""
        exclude = exclude or set()
        cand = self._eligible(now, exclude)
        fair = self.fairness(now)
        if order is not None:
            order.selection = [
                {"group": g.id, "name": g.name, "discom": g.discom, "action": "excluded", "reason": why, "F": fair[g.id]["F"]}
                for g in self.groups.values()
                if (why := self._why_not(g, now, exclude)) and why != "already rotated out"
            ]
        if mw <= 0 or not cand:
            return []
        load_by: dict[str, float] = {}
        for g in self.groups.values():
            load_by[g.discom] = load_by.get(g.discom, 0.0) + self.group_mw(g, bus_load)
        total = sum(load_by.values()) or 1.0
        quota = {d: mw * v / total for d, v in load_by.items()}
        pool = sorted(cand, key=lambda g: (fair[g.id]["F"], g.minutes_today, g.last_restored or 0.0, g.id))
        picked: list[RosterGroup] = []
        got = 0.0
        while got < mw and pool:
            # DISCOM furthest below its quota goes next
            d = max({g.discom for g in pool}, key=lambda d: quota.get(d, 0.0) - sum(self.group_mw(x, bus_load) for x in picked if x.discom == d))
            g = next(x for x in pool if x.discom == d)
            pool.remove(g)
            picked.append(g)
            gmw = self.group_mw(g, bus_load)
            got += gmw
            if order is not None:
                order.selection.append(
                    {"group": g.id, "name": g.name, "discom": g.discom, "action": "picked", "F": fair[g.id]["F"], "mw": round(gmw, 1),
                     "reason": f"lowest burden in {d} (F {fair[g.id]['F']:.2f}: {fair[g.id]['H_h']:.1f} h, {fair[g.id]['N']} interruption(s) in {self.policy.history_days:.0f} d); {d} below its load-share quota"}
                )
        if order is not None:
            order.selection += [{"group": g.id, "name": g.name, "discom": g.discom, "action": "next", "F": fair[g.id]["F"], "reason": "eligible — next in line"} for g in pool[:6]]
        return picked

    def _shed(self, g: RosterGroup, order: ShedOrder, now: float) -> None:
        p = self.policy
        spell = min(p.max_spell_min, p.max_daily_min - g.minutes_today) * 60
        g.state, g.since, g.until, g.order_id = "SHED", now, now + spell, order.id
        g.spells_today += 1
        g.history.append([now, None])

    def _restore(self, g: RosterGroup, now: float) -> None:
        g.state, g.since, g.until, g.order_id, g.last_restored = "AVAILABLE", None, None, None, now
        if g.history and g.history[-1][1] is None:
            g.history[-1][1] = now

    # ------------------------------------------------------------------ operator actions
    def propose(self, mw: float, reason: str, source: str, now: float) -> ShedOrder:
        if self.open_order():
            raise ValueError("A load-rotation order is already open")
        self._n += 1
        o = ShedOrder(id=f"LR-{Clock.hhmmss(now).replace(':', '')}-{self._n}", created=now, mw=round(mw, 0), reason=reason, source=source)
        o.needs_dual = o.mw > self.policy.dual_auth_mw
        self.orders[o.id] = o
        self._emit("proposed", f"Load rotation proposed: {o.mw:.0f} MW — {reason}", o)
        return o

    def approve(self, order_id: str, user: str, role: str, can_dual: bool, now: float, bus_load: dict[str, float]) -> ShedOrder:
        o = self.orders[order_id]
        if o.state != "PROPOSED":
            raise ValueError(f"Order is {o.state}, not awaiting approval")
        if any(a["user"] == user for a in o.approvals):
            raise ValueError("Second approval must come from a different user")
        if o.approvals and not can_dual:
            raise PermissionError("Second (dual) authorisation needs shift-in-charge authority")
        o.approvals.append({"user": user, "role": role, "ts": now})
        if o.needs_dual and len(o.approvals) < 2:
            self._emit("approval", f"First approval by {user} for {o.mw:.0f} MW load rotation — awaiting dual authorisation", o)
            return o
        groups = self.select(o.mw, bus_load, now, order=o)
        if not groups:
            o.state, o.closed, o.closed_reason = "CANCELLED", now, "No roster group eligible (daily limits / rest periods)"
            self._emit("exhausted", f"Load rotation {o.id} could not start: roster exhausted", o)
            return o
        for g in groups:
            self._shed(g, o, now)
        o.state, o.activated = "ACTIVE", now
        mw = sum(self.group_mw(g, bus_load) for g in groups)
        self._emit("activated", f"Load rotation {o.id} active: {len(groups)} group(s), {mw:.0f} MW — {', '.join(g.name for g in groups)}", o, groups=[g.id for g in groups])
        return o

    def reject(self, order_id: str, user: str, reason: str, now: float) -> ShedOrder:
        o = self.orders[order_id]
        if o.state != "PROPOSED":
            raise ValueError(f"Order is {o.state}")
        o.state, o.closed, o.closed_reason = "REJECTED", now, f"Rejected by {user}: {reason}"
        self._emit("rejected", o.closed_reason, o)
        return o

    def restore_all(self, user: str, reason: str, now: float) -> ShedOrder | None:
        o = self.open_order()
        if not o:
            return None
        if o.state == "PROPOSED":
            o.state, o.closed, o.closed_reason = "CANCELLED", now, f"Cancelled by {user}: {reason}"
        else:
            o.closed_reason = f"Restored by {user}: {reason}"
            o.state = "RESTORING"
        self._emit("restoring", o.closed_reason, o)
        return o

    # ------------------------------------------------------------------ every tick
    def step(self, now: float, frequency: float, direction: str, residual_mw: float, bus_load: dict[str, float], measured_mw: float | None = None) -> None:
        """residual_mw: over-drawal that paid flexibility does not cover (already includes MW being shed).
        measured_mw: metered relief from the feeders currently open — replaces the roster's planned MW wherever
        it is known, so a rotation that under-delivers is topped up instead of being marked successful."""
        p = self.policy
        dt = 0.0 if self.last_tick is None else max(0.0, now - self.last_tick)
        self.last_tick = now
        day = int((now + 19800) // 86400)  # IST calendar day
        if day != self.day:
            self.day = day
            for g in self.groups.values():
                g.minutes_today, g.spells_today = 0.0, 0
        od = direction == "UP"
        self.residual_mw = residual_mw if od else 0.0
        planned_now = self.shed_mw(bus_load)
        shed_now = measured_mw if measured_mw is not None else planned_now
        self.measured_mw = shed_now
        for g in self.groups.values():
            if g.state == "SHED":
                g.minutes_today += dt / 60
        o = self.open_order()
        if o and o.state in ("ACTIVE", "RESTORING"):
            o.shed_minutes_mw += shed_now * dt / 60
            o.peak_mw = max(o.peak_mw, shed_now)
            o.planned_mw, o.measured_mw = round(planned_now, 1), round(shed_now, 1)
            # reconcile planned vs metered relief; escalate once if it stays short
            if o.state == "ACTIVE" and planned_now > 20 and shed_now < p.shortfall_ratio * planned_now:
                o.short_since = o.short_since or now
                if not o.escalated and now - o.short_since >= p.shortfall_hold_s:
                    o.escalated = True
                    self._emit("shortfall", f"{o.id}: metered relief {shed_now:.0f} MW is {shed_now / planned_now * 100:.0f}% of the {planned_now:.0f} MW planned — residual re-estimated from metering; further groups follow the approved order", o)
            else:
                o.short_since = None

        # 1) propose when flexibility is exhausted and frequency is below the band
        if o is None:
            if od and self.needs_relief(frequency, self.residual_mw):
                self.need_since = self.need_since or now
                if now - self.need_since >= p.hold_s or frequency < p.emergency_freq:
                    mw = max(p.min_residual_mw, round(self.residual_mw / 10) * 10)
                    why = f"{frequency:.3f} Hz is below {p.trigger_freq:.2f} Hz" if frequency < p.trigger_freq else f"beyond the {self.od_limit:.0f} MW DSM deviation band"
                    self.propose(mw, f"Over-drawal of {self.residual_mw:.0f} MW not covered by flexibility — {why}", "auto", now)
                    self.need_since = None
            else:
                self.need_since = None
            return

        # 2) a proposal that is no longer needed lapses
        if o.state == "PROPOSED":
            if o.source == "auto" and (not od or self.residual_mw < p.min_residual_mw * 0.5):
                o.state, o.closed, o.closed_reason = "CANCELLED", now, "Lapsed — over-drawal now covered by flexibility"
                self._emit("lapsed", o.closed_reason, o)
            return

        shed = [g for g in self.groups.values() if g.state == "SHED" and g.order_id == o.id]

        # 3) spell limits always win: a group at the end of its spell comes back now — while the order is
        #    active the next fair group takes over (rotation); while restoring it simply comes back
        for g in list(shed):
            if g.until is not None and now >= g.until:
                mw = self.group_mw(g, bus_load)
                repl = self.select(mw * 0.9, bus_load, now, exclude={x.id for x in shed}, order=o) if o.state == "ACTIVE" else []
                for r in repl:
                    self._shed(r, o, now)
                self._restore(g, now)
                shed.remove(g)
                if o.state != "ACTIVE":
                    self._emit("restored", f"{g.name} restored (spell limit)", o, group=g.id)
                elif repl:
                    o.rotations += 1
                    shed.extend(repl)
                    self._emit("rotated", f"Rotation: {g.name} restored after {g.minutes_today:.0f} min today; {', '.join(r.name for r in repl)} now off", o, out=[r.id for r in repl], back=g.id)
                else:
                    self._emit("exhausted", f"Roster exhausted — {g.name} restored at its limit with no eligible replacement; {mw:.0f} MW uncovered", o)
        # groups may have changed above: rescale the model by this tick's metered/planned ratio
        realised = (shed_now / planned_now) if planned_now > 1.0 else 1.0
        shed_now = self.shed_mw(bus_load) * realised

        # 4) give load back: all of it when the over-drawal is gone, or one group when more is shed than needed
        relief_needed = self.residual_mw  # what shedding must still cover (the residual already counts shed MW)
        if o.state == "ACTIVE" and (not od or relief_needed < p.min_residual_mw * 0.5):
            o.state = "RESTORING"
            o.closed_reason = "Over-drawal resolved" if od else "State no longer over-drawing"
            self._emit("restoring", f"{o.id}: {o.closed_reason} — restoring load in stages", o)
        smallest = min((self.group_mw(g, bus_load) for g in shed), default=0.0)
        surplus = shed_now - relief_needed
        trim = o.state == "ACTIVE" and shed and surplus > smallest + p.restore_margin_mw
        if o.state == "RESTORING" or trim:
            # stagger: one group per interval, tightened while restoring so every group is back one at a time before
            # its spell limit would force several back together (a rebound spike)
            gap = p.restore_stagger_s
            if o.state == "RESTORING" and shed:
                soonest = min((g.until for g in shed if g.until), default=now + gap * len(shed))
                gap = min(gap, max(20.0, (soonest - now) / len(shed)))
            if shed and now - self.last_restore >= gap:
                if o.state == "RESTORING":
                    g = min(shed, key=lambda x: x.since or now)  # longest out goes back first
                else:  # shedding more than needed: give back the largest group that still leaves enough off
                    fits = [x for x in shed if self.group_mw(x, bus_load) <= surplus - p.restore_margin_mw]
                    g = max(fits, key=lambda x: self.group_mw(x, bus_load))
                self._restore(g, now)
                self.last_restore = now
                self._emit("restored", f"{g.name} restored", o, group=g.id)
                shed.remove(g)
            if o.state == "RESTORING" and not shed:
                o.state, o.closed = "COMPLETED", now
                self._emit("completed", f"Load rotation {o.id} complete — all feeders restored ({o.shed_minutes_mw / 60:.1f} MWh not served, {o.rotations} rotation(s))", o)
            return

        # 5) top up if the residual grew beyond what is shed
        if relief_needed - shed_now > p.min_residual_mw:  # the approved order covers the uncovered residual
            extra = self.select(relief_needed - shed_now, bus_load, now, exclude={g.id for g in self.groups.values() if g.state == "SHED"}, order=o)
            if extra:
                for r in extra:
                    self._shed(r, o, now)
                self._emit("extended", f"Over-drawal grew — {', '.join(r.name for r in extra)} added under {o.id}", o, out=[r.id for r in extra])

    # ------------------------------------------------------------------ views
    def summary(self, bus_load: dict[str, float]) -> dict:
        o = self.open_order()
        out = [g for g in self.groups.values() if g.state == "SHED"]
        planned = self.shed_mw(bus_load)
        measured = getattr(self, "measured_mw", planned) if out else 0.0
        return {
            "active_mw": round(measured, 1),  # metered relief
            "planned_mw": round(planned, 1),  # roster forecast for the groups currently out
            "groups_out": len(out),
            "residual_mw": round(self.residual_mw, 1),
            "order": {"id": o.id, "state": o.state, "mw": o.mw, "needs_dual": o.needs_dual, "approvals": len(o.approvals), "planned_mw": o.planned_mw, "measured_mw": o.measured_mw, "escalated": o.escalated} if o else None,
"od_limit_mw": round(self.od_limit, 1),
            "next_rotation": min((g.until for g in out if g.until), default=None),
            "roster_source": ROSTER_SOURCE,
            "shed_channels": {c: g.id for g in out for c in g.channels},
        }
