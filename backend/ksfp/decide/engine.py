"""Decision engine — the autonomous control loop (MPC) with human-in-the-loop.

A Decision is opened when an imbalance/constraint incident is detected and is *revised every
block* (and on material change) until the situation is resolved, then released, verified and
settled. Every revision stores its evidence and a narrative:

  Situation → Impact → Prediction → Recommendation → Action → Outcome
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from ..act.dispatch import TERMINAL, CommandManager
from ..act.settlement import Meter
from ..core.clock import Clock
from ..grid.state import Assessment
from ..grid.topology import topology
from .flexibility import evaluate
from .optimizer import STRATEGIES, compare, optimize
from .policy import AutonomyPolicy
from .twin import simulate

OPEN_STATES = {"PROPOSED", "AWAITING_APPROVAL", "EXECUTING", "RELEASING"}
TRIGGER_MW = 100.0  # |ACE| that opens a decision (IEGC alert threshold)
TRIGGER_HOLD_S = 60.0  # ... sustained for this long (sim seconds)
RESOLVE_MW = 60.0  # underlying requirement below which the decision winds down
HORIZON = 4
TIMELINE_S = 20.0  # sim-seconds between event performance samples
TIMELINE_MAX = 720


def fmt_rs(v: float) -> str:
    a = abs(v)
    s = "−" if v < 0 else ""
    if a >= 1e7:
        return f"{s}₹{a / 1e7:.2f} Cr"
    if a >= 1e5:
        return f"{s}₹{a / 1e5:.2f} L"
    return f"{s}₹{a:,.0f}"


@dataclass
class Decision:
    id: str
    incident_id: str | None
    opened_at: float
    severity: str
    direction: str
    state: str = "PROPOSED"
    updated_at: float = 0.0
    closed_at: float | None = None
    revision: int = 0
    revisions: list[dict] = field(default_factory=list)  # compact history
    current: dict = field(default_factory=dict)  # latest full evidence
    narrative: dict = field(default_factory=dict)
    approvals: list[dict] = field(default_factory=list)  # current approval round
    approval_history: list[dict] = field(default_factory=list)  # every approval ever given
    approved_mw: float = 0.0
    needs_dual: bool = False
    awaiting: list[str] = field(default_factory=list)  # asset ids awaiting approval
    auto: list[str] = field(default_factory=list)
    excluded: list[str] = field(default_factory=list)
    active_blocks: dict[str, int] = field(default_factory=dict)
    resolved_count: int = 0
    outcome: dict = field(default_factory=dict)
    timeline: list[dict] = field(default_factory=list)  # sampled event performance: target vs dispatched vs delivered
    settlement: dict | None = None
    closed_reason: str = ""
    final_state: str = "COMPLETED"
    meter: Meter = field(default_factory=Meter)
    rates: dict[str, float] = field(default_factory=dict)  # pay rate locked per asset at dispatch (₹/kWh)

    @property
    def open(self) -> bool:
        return self.state in OPEN_STATES

    def needs_dual_pending(self) -> bool:
        return self.needs_dual and len(self.approvals) < 2

    def summary(self) -> dict:
        plan = self.current.get("plan", {})
        return {
            "id": self.id,
            "incident_id": self.incident_id,
            "state": self.state,
            "severity": self.severity,
            "direction": self.direction,
            "opened_at": self.opened_at,
            "updated_at": self.updated_at,
            "closed_at": self.closed_at,
            "revision": self.revision,
            "headline": self.narrative.get("headline", ""),
            "requirement_mw": self.current.get("requirement_mw", 0.0),
            "planned_mw": plan.get("peak_mw", 0.0),
            "delivered_mw": self.outcome.get("delivered_mw", 0.0),
            "awaiting_mw": sum(x["mw"] for x in self.current.get("allocations", []) if x["id"] in self.awaiting),
            "auto_mw": sum(x["mw"] for x in self.current.get("allocations", []) if x["id"] in self.auto),
            "needs_dual": self.needs_dual,
            "approvals": self.approvals,
            "approval_history": self.approval_history,
            "closed_reason": self.closed_reason,
            "net_benefit_rs": (self.settlement or {}).get("net_benefit_rs"),
        }

    def to_dict(self) -> dict:
        d = self.summary()
        d.update(
            {
                "narrative": self.narrative,
                "current": self.current,
                "revisions": self.revisions[-20:],
                "outcome": self.outcome,
                "timeline": self.timeline,
                "settlement": self.settlement,
                "excluded": self.excluded,
                "awaiting": self.awaiting,
                "auto": self.auto,
            }
        )
        return d


@dataclass
class DecisionEngine:
    commands: CommandManager
    policy: AutonomyPolicy
    reliability: dict[str, float]
    out_of_service: set[str] = field(default_factory=set)
    decisions: dict[str, Decision] = field(default_factory=dict)
    cooldown_until: float = 0.0
    last_block: int = -1
    trigger_since: float | None = None  # anti-flapping: condition must persist TRIGGER_HOLD_S
    log: list[tuple[str, str, str]] = field(default_factory=list)  # (kind, decision_id, message) drained by runtime
    relief_mw: float = 0.0  # load currently shed by the roster manager (set by the runtime every tick)
    off_peak: float = 3.2  # ₹/kWh for rebound energy in settlement (follows live prices)

    # ---------------------------------------------------------------- helpers
    def active(self) -> Decision | None:
        return next((d for d in self.decisions.values() if d.open), None)

    def _active_mw(self, d: Decision | None, a: Assessment) -> dict[str, float]:
        """Currently delivered MW from our own live commands (telemetry), keyed by asset."""
        if not d:
            return {}
        live = self.commands.live_setpoints()
        out = {}
        for aid, sp in live.items():
            if sp > 0:
                out[aid] = float(a.state.asset_state.get(aid, {}).get("mw", 0.0)) if aid != "RTM" else sp
        return out

    def underlying_requirement(self, a: Assessment, d: Decision | None) -> float:
        delivered = sum(self._active_mw(d, a).values())
        if d is None:
            return a.requirement_mw + (self.relief_mw if a.direction == "UP" else 0.0)
        # requirement in the decision's direction, with our own delivery (and any load shed) backed out:
        # flexibility stays sized to the full over-drawal, so shedding is what gets released first
        signed = -a.ace.ace if d.direction == "UP" else a.ace.ace
        return max(0.0, signed + delivered + (self.relief_mw if d.direction == "UP" else 0.0))

    # ---------------------------------------------------------------- main entry (called every tick)
    def step(self, a: Assessment, now: float, forecast: dict | None, incident_id: str | None, loop_healthy: bool = True) -> list[Decision]:
        touched: list[Decision] = []
        self.off_peak = a.state.prices.off_peak
        d = self.active()
        block = Clock.block_of(now)
        new_block = block != self.last_block
        self.last_block = block
        lvl, _ = self.policy.effective(a.state.confidence, loop_healthy)
        if d is None:
            if self.policy.level == 0:
                return touched
            if a.requirement_mw < TRIGGER_MW:
                self.trigger_since = None
                return touched
            self.trigger_since = self.trigger_since or now
            held = now - self.trigger_since >= TRIGGER_HOLD_S or a.severity == "EMERGENCY"
            if held and (now >= self.cooldown_until or a.severity == "EMERGENCY"):
                self.trigger_since = None
                d = Decision(
                    id="DC-" + uuid.uuid4().hex[:6].upper(),
                    incident_id=incident_id,
                    opened_at=now,
                    severity=a.severity,
                    direction=a.direction,
                )
                self.decisions[d.id] = d
                self.log.append(("EVENT", d.id, f"Decision opened: {a.severity}, ACE {a.ace.ace:+.0f} MW, f {a.state.frequency:.3f} Hz"))
                self._revise(d, a, now, forecast, "opened", loop_healthy)
                touched.append(d)
            return touched
        # metering every tick
        expected_now = {x["id"]: x["expected_mw"] for x in d.current.get("allocations", []) if x["id"] in self._active_mw(d, a)}
        dt = max(0.0, now - (d.updated_at or now))
        if dt > 0:
            d.meter.tick(a, expected_now, dt)
        d.updated_at = now
        self._refresh_outcome(d, a)
        if d.state == "RELEASING":
            if not any(c.state not in TERMINAL for c in self.commands.for_decision(d.id)):
                self._close(d, now, "COMPLETED", d.closed_reason or "Situation resolved; resources released")
            touched.append(d)
            return touched
        underlying = self.underlying_requirement(a, d)
        failed = [c for c in self.commands.for_decision(d.id) if c.state == "FAILED" and c.asset_id not in d.excluded]
        for c in failed:
            d.excluded.append(c.asset_id)
        if underlying < RESOLVE_MW:
            d.resolved_count += 1
            if d.resolved_count >= 3:
                self.release(d, now, "Situation resolved — underlying requirement below threshold")
                touched.append(d)
                return touched
        else:
            d.resolved_count = 0
        prev_req = d.current.get("requirement_mw", 0.0)
        material = abs(underlying - prev_req) > max(80.0, 0.25 * prev_req)
        escalated = a.severity == "EMERGENCY" and d.severity != "EMERGENCY"
        if new_block or material or failed or escalated:
            reason = "new block (MPC re-solve)" if new_block else "material change in requirement" if material else "command failure" if failed else "escalated to EMERGENCY"
            self._revise(d, a, now, forecast, reason, loop_healthy)
            touched.append(d)
        return touched

    # ---------------------------------------------------------------- revision (optimize → twin → policy → commands)
    def _revise(self, d: Decision, a: Assessment, now: float, forecast: dict | None, reason: str, loop_healthy: bool) -> None:
        t = topology()
        d.revision += 1
        d.severity = a.severity if a.severity != "NORMAL" else d.severity
        active = self._active_mw(d, a)
        requirement = self.underlying_requirement(a, d) if d.revision > 1 else a.requirement_mw
        for aid in active:
            d.active_blocks[aid] = d.active_blocks.get(aid, 0) + (1 if reason.startswith("new block") else 0)
        evals = [evaluate(x, a, HORIZON, self.reliability.get(x["id"], x["reliability"]), x["id"] in self.out_of_service, d.active_blocks.get(x["id"], 0)) for x in t.assets]
        exclude = set(d.excluded)
        derate: dict[str, float] = {}
        passes = []
        plan = twin = None
        for n in range(1, 5):
            plan = optimize(a, evals, requirement, HORIZON, "OPTIMAL", exclude, derate, active)
            twin = simulate(plan, a, evals, active)
            changes = []
            for aid in twin.exclude:
                if aid not in exclude:
                    exclude.add(aid)
                    changes.append(f"removed {t.asset(aid)['short']}")
            for aid, mw in twin.derate.items():
                if derate.get(aid, 1e9) > mw:
                    derate[aid] = mw
                    changes.append(f"derated {t.asset(aid)['short']} to {mw:.0f} MW")
            passes.append({"pass": n, "ok": twin.ok, "note": "Twin approved" if twin.ok else ("Twin rejected → " + ", ".join(changes) + " → re-solve" if changes else "Twin rejected — no automatic fix")})
            if twin.ok or not changes:
                break
        assert plan is not None and twin is not None
        for aid in twin.exclude:
            if aid not in d.excluded:
                d.excluded.append(aid)
        strategies = compare(a, evals, requirement, HORIZON, active) if d.revision == 1 or reason != "new block (MPC re-solve)" else d.current.get("strategies", [])
        allocs = [
            {
                "id": al.asset_id,
                "name": al.name,
                "short": t.asset(al.asset_id)["short"] if al.asset_id != "RTM" else "RTM",
                "type": al.type,
                "bus": al.bus,
                "mw": al.mw_by_block[0],
                "mw_by_block": al.mw_by_block,
                "expected_mw": al.expected_by_block[0],
                "reliability": al.reliability,
                "effective_cost": al.effective_cost,
                "rate_rs": al.rate_rs,
                "cost_rs": al.cost_rs,
                "rank": al.rank,
                "caps": al.caps,
                "protocol": t.asset(al.asset_id)["protocol"] if al.asset_id != "RTM" else "Exchange API",
            }
            for al in plan.allocations
        ]
        for x in allocs:
            d.rates[x["id"]] = x["rate_rs"]
        policy = self.policy.classify([x for x in allocs if x["mw"] > 0.5], a.severity, a.state.confidence, twin.ok, loop_healthy)
        # approvals carry over across MPC revisions while within the approved envelope
        approved_ids = set()
        if d.approved_mw > 0 and sum(x["mw"] for x in allocs) <= d.approved_mw * 1.1 + 20:
            approved_ids = {x["id"] for x in allocs}
        awaiting = [i for i in policy["approval"] if i not in approved_ids]
        if awaiting and not d.awaiting:
            d.approvals = []  # plan grew beyond the approved envelope → new approval round
        auto = [i for i in policy["auto"]]
        d.auto, d.awaiting = auto, awaiting
        approval_mw = sum(x["mw"] for x in allocs if x["id"] in awaiting)
        d.needs_dual = approval_mw > self.policy.dual_auth_mw
        # commands: diff plan vs live setpoints
        live = self.commands.live_setpoints()
        pending = {c.asset_id: c for c in self.commands.for_decision(d.id) if c.state in ("AWAITING_APPROVAL", "READY")}
        for x in allocs:
            sp = round(x["mw"], 1)
            cur = live.get(x["id"], 0.0)
            pend = pending.get(x["id"])
            band = max(5.0, 0.08 * max(sp, cur))  # dead-band: don't churn setpoints on small re-solves
            if pend and abs(pend.setpoint - sp) < band:
                continue
            if abs(cur - sp) < band and not pend:
                continue
            needs = x["id"] in awaiting
            self.commands.create(d.id, x["id"], sp, x["expected_mw"], needs, now)
        planned_ids = {x["id"] for x in allocs if x["mw"] > 0.5}
        for aid, sp in live.items():
            if sp > 0 and aid not in planned_ids and any(c.asset_id == aid and c.decision_id == d.id for c in self.commands.commands.values()):
                self.commands.create(d.id, aid, 0.0, 0.0, False, now, kind="RELEASE")
        if awaiting:
            d.state = "AWAITING_APPROVAL"
        else:
            d.state = "EXECUTING"
        rec_best = min(strategies, key=lambda s_: s_["total_rs"]) if strategies else None
        d.current = {
            "ts": now,
            "reason": reason,
            "requirement_mw": requirement,
            "assessment": {
                "frequency": a.state.frequency,
                "ace": a.ace.ace,
                "ace_terms": {"Ia": a.ace.Ia, "Is": a.ace.Is, "bf": a.ace.bf, "freq_term": a.ace.freq_term},
                "deviation_mw": a.deviation_mw,
                "drawal_mw": a.state.drawal_mw,
                "schedule_mw": a.state.schedule_mw,
                "severity": a.severity,
                "direction": a.direction,
                "margin_mw": a.margin_mw,
                "confidence": a.state.confidence,
                "dsm": {
                    "nr": a.dsm.nr.nr,
                    "nr_terms": {"A": a.dsm.nr.A, "B": a.dsm.nr.B, "C": a.dsm.nr.C, "binding": a.dsm.nr.binding},
                    "per_block_rs": a.dsm.amount_rs,
                    "energy_mwh": a.dsm.energy_mwh,
                    "band_mw": a.dsm.band_mw,
                    "freq_band": a.dsm.freq_band,
                    "mult": [a.dsm.mult_within, a.dsm.mult_beyond],
                    "slices": [x for x in a.dsm.slices if x["mw"] > 0],
                    "version": a.dsm.version,
                    "marginal_rate": a.dsm.marginal_rate,
                },
            },
            "flexibility": [e.to_dict() for e in sorted(evals, key=lambda e: (not e.eligible, e.effective_cost))],
            "strategies": strategies,
            "allocations": allocs,
            "plan": {
                "peak_mw": plan.peak_mw(),
                "coverage_pct": plan.coverage_pct,
                "supplied": plan.supplied,
                "residual": plan.residual,
                "requirement": plan.requirement,
                "costs": plan.costs,
                "bindings": plan.bindings,
                "skipped": plan.skipped,
                "max_loading_after": plan.max_loading_after,
                "post_rebound_mw": plan.post_rebound_mw,
                "solver": plan.solver,
            },
            "twin": twin.to_dict(),
            "twin_passes": passes,
            "policy": policy,
        }
        d.revisions.append(
            {
                "rev": d.revision,
                "ts": now,
                "reason": reason,
                "requirement_mw": round(requirement, 1),
                "planned_mw": round(plan.peak_mw(), 1),
                "resources": len(allocs),
                "auto_mw": round(sum(x["mw"] for x in allocs if x["id"] in auto), 1),
                "awaiting_mw": round(approval_mw, 1),
                "twin_ok": twin.ok,
                "solve_ms": plan.solver["solve_ms"],
            }
        )
        d.narrative = self._narrative(d, a, plan, twin, policy, forecast, rec_best, allocs)
        self.log.append(
            (
                "ANALYSIS",
                d.id,
                f"Rev {d.revision} ({reason}): requirement {requirement:.0f} MW → {len(allocs)} resources, {plan.peak_mw():.0f} MW; "
                f"auto {sum(x['mw'] for x in allocs if x['id'] in auto):.0f} MW, awaiting approval {approval_mw:.0f} MW; twin {'OK' if twin.ok else 'REJECTED'} after {len(passes)} pass(es)",
            )
        )

    # ---------------------------------------------------------------- narrative
    def _narrative(self, d: Decision, a: Assessment, plan, twin, policy, forecast, best, allocs) -> dict:
        t = topology()
        s = a.state
        # describe the event's own need (with our delivery and any load shed added back), not the instantaneous
        # ACE — once flexibility and shedding act, the momentary reading can flip direction without the need being gone
        need = self.underlying_requirement(a, d)
        dirn = "short" if d.direction == "UP" else "long (surplus)"
        situation = (
            f"The control area is {('over' if a.deviation_mw >= 0 else 'under')}-drawing {abs(a.deviation_mw):.0f} MW against schedule at {s.frequency:.3f} Hz "
            f"(ACE {a.ace.ace:+.0f} MW). Underlying need: {dirn} by {need:.0f} MW ({d.severity})."
        )
        if self.relief_mw > 0.5 and d.direction == "UP":
            situation += f" {self.relief_mw:.0f} MW of load is currently shed under the roster."
        impact_bits = [f"DSM exposure {fmt_rs(a.dsm.amount_rs)} per 15-min block (NR ₹{a.dsm.nr.nr:.2f}/kWh, {a.dsm.freq_band} frequency band)."]
        if s.flow.max_loading >= 0.9:
            impact_bits.append(f"Network: {t.line_label(s.flow.max_line)} at {s.flow.max_loading * 100:.0f}%.")
        if s.confidence < 0.95:
            impact_bits.append(f"Data confidence {s.confidence * 100:.0f}%.")
        prediction = "No forecast available."
        if forecast and forecast.get("blocks"):
            nb = forecast["blocks"][:2]
            prediction = "Without further action: ACE " + ", ".join(f"{x['label']} {x['ace']['p50']:+.0f} MW (P10 {x['ace']['p10']:+.0f} / P90 {x['ace']['p90']:+.0f})" for x in nb) + "."
            v = [x for x in forecast.get("violations", []) if x.get("line")]
            if v:
                prediction += f" Predicted constraint: {v[0]['label']} {v[0]['loading'] * 100:.0f}% in {v[0]['lead_min']} min."
        top = sorted(allocs, key=lambda x: -x["mw"])[:3]
        recommendation = (
            f"Optimal mix (HiGHS LP, {plan.solver['solve_ms']:.0f} ms): {len(allocs)} resources, {plan.peak_mw():.0f} MW — "
            + ", ".join(f"{x['short']} {x['mw']:.0f} MW" for x in top)
            + (f" … Saves {fmt_rs(plan.costs['savings_rs'])} vs doing nothing over the horizon." if plan.costs["savings_rs"] > 0 else " Security-driven (IEGC: keep ACE near zero).")
        )
        if plan.bindings:
            recommendation += f" Binding: {plan.bindings[0]['label']}."
        auto_mw = sum(x["mw"] for x in allocs if x["id"] in policy["auto"])
        appr_mw = sum(x["mw"] for x in allocs if x["id"] in d.awaiting)
        action = f"{policy['level_name']}: {auto_mw:.0f} MW executing automatically" + (f"; {appr_mw:.0f} MW awaiting operator approval" + (" (dual authorisation)" if d.needs_dual else "") if appr_mw > 0.5 else "") + "."
        if not twin.ok:
            action += " Digital Twin flagged issues — see checks."
        headline = f"{d.direction} {need:.0f} MW · {len(allocs)} resources · {('awaiting approval' if d.awaiting else 'executing')}"
        return {
            "headline": headline,
            "situation": situation,
            "impact": " ".join(impact_bits),
            "prediction": prediction,
            "recommendation": recommendation,
            "action": action,
            "outcome": "Commands in flight — outcome will update live.",
            "reasons": policy["reasons"],
        }

    def _refresh_outcome(self, d: Decision, a: Assessment) -> None:
        active = self._active_mw(d, a)
        delivered = sum(active.values())
        expected = sum(x["expected_mw"] for x in d.current.get("allocations", []) if x["id"] in active)
        d.outcome = {
            "delivered_mw": round(delivered, 1),
            "expected_mw": round(expected, 1),
            "ace_now": round(a.ace.ace, 1),
            "frequency_now": round(a.state.frequency, 3),
            "avoided_dsm_rs": round(d.meter.avoided_dsm_rs, 0),
            "minutes": round(d.meter.seconds / 60, 1),
        }
        now = d.updated_at
        if not d.timeline or now - d.timeline[-1]["t"] >= TIMELINE_S:
            d.timeline.append(
                {
                    "t": now,
                    "target": round(d.current.get("requirement_mw", 0.0), 1),
                    "dispatched": round(sum(v for v in self.commands.live_setpoints().values() if v > 0), 1),
                    "expected": round(expected, 1),
                    "delivered": round(delivered, 1),
                    "ace": round(a.ace.ace, 1),
                }
            )
            del d.timeline[:-TIMELINE_MAX]
        if delivered > 0.5 or d.state in ("EXECUTING", "RELEASING"):
            d.narrative["outcome"] = (
                f"Delivering {delivered:.0f} MW of {expected:.0f} MW expected; ACE now {a.ace.ace:+.0f} MW, f {a.state.frequency:.3f} Hz; "
                f"DSM avoided so far {fmt_rs(d.meter.avoided_dsm_rs)} over {d.meter.seconds / 60:.0f} min."
            )

    # ---------------------------------------------------------------- operator actions
    def approve(self, decision_id: str, user: str, role: str, can_dual: bool, now: float) -> Decision:
        d = self.decisions[decision_id]
        if d.state != "AWAITING_APPROVAL":
            raise ValueError(f"Decision is {d.state}, not awaiting approval")
        if any(x["user"] == user for x in d.approvals):
            raise ValueError("Second approval must come from a different user")
        if d.approvals and not can_dual:
            raise PermissionError("Second (dual) authorisation requires the approve_dual permission")
        mw = sum(x["mw"] for x in d.current.get("allocations", []) if x["id"] in d.awaiting)
        d.approvals.append({"user": user, "role": role, "ts": now, "mw": mw})
        d.approval_history.append({"user": user, "role": role, "ts": now, "mw": mw, "revision": d.revision})
        if d.needs_dual and len(d.approvals) < 2:
            self.log.append(("APPROVAL", d.id, f"First approval by {user} ({role}) for {mw:.0f} MW — awaiting dual authorisation"))
            return d
        d.approved_mw = max(d.approved_mw, sum(x["mw"] for x in d.current.get("allocations", [])))
        n = self.commands.approve(d.id, now)
        d.awaiting = []
        d.state = "EXECUTING"
        self.log.append(("APPROVAL", d.id, f"Approved by {', '.join(x['user'] for x in d.approvals)} — {n} command(s) released for dispatch"))
        return d

    def reject(self, decision_id: str, user: str, reason: str, now: float) -> Decision:
        d = self.decisions[decision_id]
        self.commands.cancel(d.id, now, f"rejected by {user}")
        if any(sp > 0 for sp in self.commands.live_setpoints().values()):
            self.release(d, now, f"Rejected by {user}: {reason}", final_state="REJECTED")
        else:
            self._close(d, now, "REJECTED", f"Rejected by {user}: {reason}")
        self.cooldown_until = now + 30 * 60
        return d

    def abort(self, decision_id: str, user: str, reason: str, now: float) -> Decision:
        d = self.decisions[decision_id]
        self.commands.cancel(d.id, now, f"aborted by {user}")
        self.release(d, now, f"Aborted by {user}: {reason}", final_state="ABORTED")
        self.cooldown_until = now + 30 * 60
        return d

    def release(self, d: Decision, now: float, reason: str, final_state: str = "COMPLETED") -> None:
        live = self.commands.live_setpoints()
        mine = {c.asset_id for c in self.commands.for_decision(d.id)}
        for aid, sp in live.items():
            if sp > 0 and aid in mine:
                self.commands.create(d.id, aid, 0.0, 0.0, False, now, kind="RELEASE")
        self.commands.cancel(d.id, now, "decision closing")
        d.state = "RELEASING"
        d.closed_reason = reason
        d.final_state = final_state
        self.log.append(("COMMAND", d.id, f"Releasing resources — {reason}"))

    def _close(self, d: Decision, now: float, state: str, reason: str) -> None:
        d.state = d.final_state if state == "COMPLETED" else state
        d.closed_at = now
        d.closed_reason = reason
        d.settlement = d.meter.settle(self.reliability, d.rates, self.off_peak)
        for r in d.settlement["rows"]:
            if r["asset_id"] != "RTM" and r["expected_mwh"] > 0.05:
                self.reliability[r["asset_id"]] = r["reliability_after"]
        d.narrative["outcome"] = (
            f"Closed ({d.state}): delivered {d.settlement['delivered_mwh']:.1f} of {d.settlement['expected_mwh']:.1f} MWh expected; "
            f"DSM avoided {fmt_rs(d.settlement['avoided_dsm_rs'])}, payments {fmt_rs(d.settlement['payments_rs'])}, rebound {fmt_rs(d.settlement['rebound_cost_rs'])}, net savings {fmt_rs(d.settlement['net_benefit_rs'])}."
        )
        self.log.append(("SETTLEMENT", d.id, d.narrative["outcome"]))

__all__ = ["Decision", "DecisionEngine", "STRATEGIES"]
