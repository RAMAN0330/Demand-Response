"""GridFlex coordination: one shortage ledger across industrial flexibility, other flexibility and load rotation.

    shortage            the over-drawal the active event is sized for (underlying requirement, UP direction)
  − industrial          verified reduction from industries in accepted offers (baseline − meter)
  − other flexibility   metered delivery from BESS, generation and other DR
  − load rotation       metered relief from feeders currently rotated out
  = residual            what is still unresolved — always from measured values, never from instructions

A 30 MW instruction is not a 30 MW reduction: planned, commanded and measured values are kept apart, and
the residual is recomputed from metering every tick. Emergencies (frequency below 49.80 Hz or EMERGENCY
severity) are flagged: authorised control-room procedure and independent protection take precedence over
any offer or roster sequence.

Scenario simulator: on a copy of the live state, compare no action, flexibility first, and rotation-assisted
for a chosen shortage, duration and industrial participation — utility cost, unresolved residual, and the
interruption it would take (MWh, feeder groups, stations). Nothing is dispatched.
"""

from __future__ import annotations

import copy
from dataclasses import replace

from ..decide.flexibility import evaluate
from ..decide.optimizer import optimize
from ..grid.dsm import dsm_charge
from ..grid.state import assess
from ..grid.topology import topology

BLOCK_H = 0.25
INTERRUPTION_COST_RS_KWH = 40.0  # ILLUSTRATIVE planning value for unserved energy; set per utility study


def _industrial_verified(rt) -> float:
    """Current verified industrial reduction: Σ min(max(0, B − M), A) over industries in the active event."""
    reg = rt.industrial
    d = rt.engine.active()
    if d is None:
        return 0.0
    live = rt.commands.live_setpoints()
    total = 0.0
    for (did, pid), rec in reg.mv.items():
        if did != d.id or rec.status != "VERIFYING":
            continue
        q = reg.meter.get(pid)
        m = q[-1][1] if q else rec.baseline_mw
        a = min(live.get(pid, 0.0), reg.offers[rec.offer_id].mw if rec.offer_id in reg.offers else live.get(pid, 0.0))
        total += min(max(0.0, rec.baseline_mw - m), a)
    return total


def ledger(rt) -> dict:
    a = rt.assessment
    if a is None:
        return {}
    eng, reg = rt.engine, rt.industrial
    d = eng.active()
    now = rt.clock.now()
    up = (d.direction if d else a.direction) == "UP"
    shortage = eng.underlying_requirement(a, d) if (d and up) else (a.requirement_mw if up and a.severity != "NORMAL" else 0.0)
    live = rt.commands.live_setpoints()
    st = a.state.asset_state
    ind_ids = set(reg.participants)
    ind_cmd = sum(v for k, v in live.items() if k in ind_ids)
    ind_meter = sum(st.get(k, {}).get("mw", 0.0) for k, v in live.items() if k in ind_ids and v > 0)
    ind_ver = _industrial_verified(rt)
    other_cmd = sum(v for k, v in live.items() if k not in ind_ids)
    other_meter = sum((v if k == "RTM" else st.get(k, {}).get("mw", 0.0)) for k, v in live.items() if k not in ind_ids and v > 0)
    sm = rt.roster.summary(rt.unshed_load(a.state.bus_load))
    rot_planned, rot_measured = sm["planned_mw"], sm["active_mw"]
    residual = max(0.0, shortage - ind_ver - other_meter - rot_measured) if up else 0.0
    emergency = a.severity == "EMERGENCY" or a.state.frequency < 49.80
    esc = []
    if emergency:
        esc.append("Emergency conditions: authorised control-room procedure and independent UFR / df/dt protection take precedence over offers and the roster.")
    o = sm["order"]
    if o and o.get("escalated"):
        esc.append(f"Load rotation {o['id']} is delivering {o['measured_mw']:.0f} of {o['planned_mw']:.0f} MW planned — residual re-estimated from metering.")
    for lag in rt.rot_residual.get("lagging", []):
        esc.append(f"{lag['name']}: metered {lag['metered_mw']:.0f} MW against {lag['expected_mw']:.0f} MW expected after its response window.")
    if residual > sm["od_limit_mw"] and not o:
        esc.append(f"Residual {residual:.0f} MW beyond the {sm['od_limit_mw']:.0f} MW band with no rotation order — a proposal follows if it persists.")
    phase = d.phases[-1]["phase"] if (d and d.phases) else ("DETECTED" if eng.trigger_since else "MONITORING")
    return {
        "phase": phase,
        "phases": d.phases if d else [],
        "event_id": d.id if d else None,
        "direction": "UP" if up else "DOWN",
        "shortage_mw": round(shortage, 1),
        "industrial": {"offered_mw": round(reg.offered_mw(now), 1), "activated_mw": round(ind_cmd, 1), "metered_mw": round(ind_meter, 1), "verified_mw": round(ind_ver, 1)},
        "other_flex": {"commanded_mw": round(other_cmd, 1), "metered_mw": round(other_meter, 1)},
        "rotation": {"planned_mw": rot_planned, "measured_mw": rot_measured, "order": o, "groups_out": sm["groups_out"]},
        "residual_mw": round(residual, 1),
        "rotation_residual": rt.rot_residual,
        "emergency": emergency,
        "escalations": esc,
    }


def kpis(rt) -> dict:
    eng, reg, ro = rt.engine, rt.industrial, rt.roster
    closed = [d for d in eng.decisions.values() if d.settlement]
    pay = sum(d.settlement.get("payments_rs", 0.0) for d in closed)
    mwh = sum(d.settlement.get("delivered_mwh", 0.0) for d in closed)
    ok = [d for d in closed if d.settlement.get("expected_mwh", 0) > 0 and d.settlement["delivered_mwh"] >= 0.9 * d.settlement["expected_mwh"]]
    d = eng.active()
    fc = rt.forecast or {}
    fair = ro.fairness(rt.clock.now())
    groups = sorted(
        ({"group": g.id, "name": g.name, "discom": g.discom, "minutes_today": round(g.minutes_today, 1), "hours_7d": fair[g.id]["H_h"], "interruptions_7d": fair[g.id]["N"], "F": fair[g.id]["F"]} for g in ro.groups.values()),
        key=lambda x: -x["hours_7d"],
    )
    return {
        "flex_cost_rs_per_mwh": round(pay / mwh, 0) if mwh > 0 else None,
        "delivered_mwh": round(mwh, 2),
        "events_settled": len(closed),
        "event_success_rate": round(len(ok) / len(closed), 3) if closed else None,
        "forecast_mape_pct": (fc.get("accuracy") or {}).get("mape_1block_pct"),
        "rebound_mw": round(((d.current.get("plan") or {}).get("post_rebound_mw") or 0.0) if d else 0.0, 1),
        "disputes": sum(1 for r in reg.mv.values() if r.status == "DISPUTED"),
        "interruption_by_group": groups,
    }


def scenario(rt, shortage_mw: float, duration_blocks: int, participation_pct: float, interruption_cost_rs_kwh: float = INTERRUPTION_COST_RS_KWH) -> dict:
    """No action vs flexibility first vs rotation-assisted on a copy of the live state."""
    t = topology()
    now = rt.clock.now()
    s = copy.deepcopy(rt.state)
    s = replace(s, drawal_mw=s.schedule_mw + shortage_mw, frequency=50.0)  # ACE = −shortage exactly
    for st in s.asset_state.values():
        st["mw"] = 0.0
    a = assess(s, rt.dsm_cfg)
    B = max(1, min(8, int(duration_blocks)))
    part = max(0.0, min(1.0, participation_pct / 100))
    evals, derate = [], {}
    for x in t.assets:
        x2, why = rt.industrial.terms(x, now)
        e = evaluate(x2, a, B, rt.reliability.get(x["id"], x["reliability"]), x["id"] in rt.engine.out_of_service, 0, why)
        evals.append(e)
        if x["type"] == "industrial":
            derate[x["id"]] = e.available_mw * part  # only this share of the offered industries actually takes part
    band = a.dsm.band_mw
    no_action = sum(dsm_charge(shortage_mw, s.schedule_mw, s.frequency, s.prices, rt.dsm_cfg).amount_rs for _ in range(B))

    plan = optimize(a, evals, shortage_mw, B, "OPTIMAL", derate=derate)
    ind = {aid for aid in rt.industrial.participants}
    ind_mw = max((sum(al.expected_by_block[b] for al in plan.allocations if al.asset_id in ind) for b in range(B)), default=0.0)
    other_mw = max((sum(al.expected_by_block[b] for al in plan.allocations if al.asset_id not in ind) for b in range(B)), default=0.0)
    # the shortfall that persists after the ramp-in block
    steady = plan.residual[1:] if B > 1 else plan.residual
    resid = sum(steady) / len(steady)
    flex_cost = plan.costs["total_rs"]

    # rotation-assisted: rotate only the persistent residual beyond the policy minimum, then price what is left
    rot_mw = resid if resid >= rt.roster.policy.min_residual_mw else 0.0
    ro = copy.deepcopy(rt.roster)
    unshed = rt.unshed_load(rt.state.bus_load)
    picked = ro.select(rot_mw, unshed, now) if rot_mw > 0 else []
    rot_real = sum(ro.group_mw(g, unshed) for g in picked) * 0.92  # typical realisation of planned relief
    hours = B * BLOCK_H
    left = max(0.0, resid - rot_real)
    dsm_left = sum(dsm_charge(left, s.schedule_mw, s.frequency, s.prices, rt.dsm_cfg).amount_rs for _ in range(len(steady)))
    rot_cost = flex_cost - plan.costs["residual_dsm_rs"] + dsm_left
    unserved = min(rot_real, resid) * hours
    cases = [
        {"id": "none", "label": "No action", "utility_cost_rs": round(no_action), "residual_mw": round(shortage_mw, 1), "industrial_mw": 0, "other_flex_mw": 0, "rotation_mw": 0, "interruption_mwh": 0, "interruption_impact_rs": 0, "groups": 0, "stations": 0, "beyond_band": shortage_mw > band},
        {"id": "flex", "label": "Flexibility first", "utility_cost_rs": round(flex_cost), "residual_mw": round(resid, 1), "industrial_mw": round(ind_mw, 1), "other_flex_mw": round(other_mw, 1), "rotation_mw": 0, "interruption_mwh": 0, "interruption_impact_rs": 0, "groups": 0, "stations": 0, "beyond_band": resid > band, "rebound_mw": round(plan.post_rebound_mw, 1)},
        {
            "id": "rotation",
            "label": "Rotation-assisted",
            "utility_cost_rs": round(rot_cost),
            "residual_mw": round(left, 1),
            "industrial_mw": round(ind_mw, 1),
            "other_flex_mw": round(other_mw, 1),
            "rotation_mw": round(rot_real, 1),
            "interruption_mwh": round(unserved, 2),
            "interruption_impact_rs": round(unserved * 1000 * interruption_cost_rs_kwh),
            "groups": len(picked),
            "stations": sum(len(g.channels) for g in picked),
            "group_names": [g.name for g in picked],
            "beyond_band": left > band,
        },
    ]
    return {
        "inputs": {"shortage_mw": shortage_mw, "duration_blocks": B, "participation_pct": participation_pct, "interruption_cost_rs_kwh": interruption_cost_rs_kwh},
        "band_mw": round(band, 1),
        "industrial_offered_mw": round(sum(e.available_mw for e in evals if e.asset["type"] == "industrial"), 1),
        "cases": cases,
        "note": "Sandbox on a copy of the live state — nothing is dispatched. DSM multipliers and the interruption cost are illustrative.",
    }
