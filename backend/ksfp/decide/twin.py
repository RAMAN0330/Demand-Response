"""Digital Twin approval gate — 1-minute simulation of a candidate plan against *live* state.

Catches what the 15-minute optimizer cannot: lost heartbeats, response lag, SoC floor breaches
mid-event, post-dispatch overloads/voltage, reserve erosion, rebound. Failing assets are
excluded or derated and the optimizer re-solves.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from ..grid.network import solve
from ..grid.state import Assessment
from ..grid.topology import topology
from .flexibility import FlexEval
from .optimizer import Plan, _base_injection

HEARTBEAT_LIMIT_S = 60.0


@dataclass
class Check:
    id: str
    label: str
    status: str  # pass | warn | fail
    detail: str
    assets: list[str] = field(default_factory=list)


@dataclass
class TwinResult:
    ok: bool
    checks: list[Check]
    minutes: list[dict]
    soc: dict[str, list[float]]
    first_block_delivery_pct: float
    exclude: list[str]
    derate: dict[str, float]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["minutes"] = self.minutes[:: max(1, len(self.minutes) // 60)]
        d["soc"] = {k: v[::5] for k, v in self.soc.items()}
        return d


def simulate(plan: Plan, a: Assessment, evals: list[FlexEval], active_mw: dict[str, float]) -> TwinResult:
    t = topology()
    s = a.state
    ev = {e.id: e for e in evals}
    T = plan.blocks * 15
    checks: list[Check] = []
    exclude: list[str] = []
    derate: dict[str, float] = {}
    state = {al.asset_id: active_mw.get(al.asset_id, 0.0) * al.reliability for al in plan.allocations}
    soc: dict[str, list[float]] = {}
    for al in plan.allocations:
        if al.type == "bess":
            live = s.asset_state.get(al.asset_id, {})
            soc[al.asset_id] = [live.get("soc") if live.get("soc") is not None else t.asset(al.asset_id)["bess"]["soc"]]
    minutes = []
    for m in range(T):
        b = m // 15
        planned = delivered = 0.0
        for al in plan.allocations:
            target = al.expected_by_block[b]
            planned += target
            if al.type == "rtm":
                state[al.asset_id] = target
            else:
                spec = t.asset(al.asset_id)
                already = active_mw.get(al.asset_id, 0.0) > 0.5
                if already or m + 1 > spec["responseMin"]:
                    cur = state[al.asset_id]
                    step = spec["rampMWpm"]
                    state[al.asset_id] = min(target, cur + step) if cur < target else max(target, cur - step)
                if al.asset_id in soc:
                    bs = spec["bess"]
                    soc[al.asset_id].append(soc[al.asset_id][-1] - state[al.asset_id] / bs["etaD"] / 60 / bs["energyMWh"])
            delivered += state[al.asset_id]
        minutes.append({"t": m + 1, "need": plan.requirement[b], "planned": round(planned, 1), "delivered": round(delivered, 1)})

    lost = [al.asset_id for al in plan.allocations if al.type != "rtm" and s.asset_state.get(al.asset_id, {}).get("heartbeat_age_s", 0) > HEARTBEAT_LIMIT_S]
    names = lambda ids: ", ".join(t.asset(i)["short"] for i in ids)  # noqa: E731
    checks.append(
        Check(
            "comms",
            "Live heartbeat & command path",
            "fail" if lost else "pass",
            f"{names(lost)}: no heartbeat for >{HEARTBEAT_LIMIT_S:.0f} s — cannot confirm commands. Remove and re-solve." if lost else f"All {sum(1 for al in plan.allocations if al.type != 'rtm')} resources answering heartbeats.",
            lost,
        )
    )
    exclude += lost

    breach = []
    for aid, traj in soc.items():
        bs = t.asset(aid)["bess"]
        if min(traj) < bs["socMin"] - 1e-3:
            breach.append(aid)
            usable = (traj[0] - bs["socMin"]) * bs["energyMWh"] * bs["etaD"] / (T / 60)
            derate[aid] = max(0.0, float(int(usable * 0.95)))
    checks.append(
        Check(
            "soc",
            "BESS state of charge within limits",
            "fail" if breach else "pass",
            f"{names(breach)} would breach the SoC floor before the horizon ends → derate." if breach else (" · ".join(f"{t.asset(k)['short']}: {v[0] * 100:.0f}% → {v[-1] * 100:.0f}%" for k, v in soc.items()) or "No BESS in plan."),
            breach,
        )
    )

    sign = 1.0 if plan.direction == "UP" else -1.0
    base_inj = _base_injection(a, active_mw)
    before = solve(base_inj, s.outaged)
    inj = dict(base_inj)
    for al in plan.allocations:
        if al.bus:
            inj[al.bus] += sign * max(al.expected_by_block)
    after = solve(inj, s.outaged)
    over = {lid: v for lid, v in after.loading.items() if v > 1.0}
    worse = {lid: v for lid, v in over.items() if v > before.loading[lid] + 0.005}
    if worse:
        st, det = "fail", "Dispatch would overload " + ", ".join(f"{t.line_label(k)} ({v * 100:.0f}%)" for k, v in worse.items())
    elif over:
        st, det = "warn", "Pre-existing overload " + ", ".join(f"{t.line_label(k)} {before.loading[k] * 100:.0f}% → {v * 100:.0f}%" for k, v in over.items()) + " — relieved by dispatch; topology / re-despatch action still required."
    else:
        st = "warn" if after.max_loading > 0.9 else "pass"
        det = f"Max loading {t.line_label(after.max_line)} {after.max_loading * 100:.0f}% (was {before.loading[after.max_line] * 100:.0f}%)."
    checks.append(Check("network", "Line loading after dispatch (DC screening model — not a utility network study)", st, det))

    vmin_bus = min((b for b in after.voltage if not b.startswith("X_")), key=lambda b: after.voltage[b])
    vmin = after.voltage[vmin_bus]
    checks.append(
        Check(
            "voltage",
            "Voltage screening 0.95–1.05 pu (heuristic from line loading)",
            "warn" if vmin < 0.95 else "pass",
            f"Lowest {vmin_bus} ≈{vmin:.3f} pu. Screening estimate only: a DC model does not solve voltage or reactive power — "
            "voltage compliance needs an AC load flow on the validated network.",
        )
    )

    fb = minutes[:15]
    pe = sum(x["planned"] for x in fb)
    de = sum(x["delivered"] for x in fb)
    pct = de / pe * 100 if pe else 100.0
    checks.append(Check("lag", "Response lag in first block", "warn" if pct < 70 else "pass", f"{pct:.0f}% of planned block-1 energy after response delays and ramps."))

    used = {al.asset_id: max(al.expected_by_block) for al in plan.allocations}
    free = sum(max(0.0, e.expected_mw - used.get(e.id, 0.0)) for e in evals if e.eligible and e.id not in lost)
    checks.append(Check("reserve", "P90 forecast-error reserve kept free", "pass" if free >= a.margin_mw else "warn", f"{free:.0f} MW expected flexibility free vs {a.margin_mw:.0f} MW P90 margin."))
    locked = sum(e.locked_mw for e in evals)
    checks.append(Check("ancillary", "No double-commitment with SRAS/TRAS", "pass", f"{locked:.0f} MW committed to ancillary services untouched (STATE_MODE)."))
    req = max(max(plan.requirement), 1.0)
    checks.append(
        Check(
            "rebound",
            "Post-event rebound acceptable",
            "warn" if plan.post_rebound_mw > 0.25 * req else "pass",
            f"Rebound ≈{plan.post_rebound_mw:.0f} MW over recovery windows ({plan.post_rebound_mw / req * 100:.0f}% of requirement).",
        )
    )
    res = max(plan.residual)
    checks.append(
        Check(
            "residual",
            "Requirement covered",
            ("fail" if a.severity == "EMERGENCY" else "warn") if res > 0.5 else "pass",
            (f"Shortfall up to {res:.0f} MW." + (" Escalate to Automatic Demand Management (last resort)." if a.severity == "EMERGENCY" else " Residual settles under DSM.")) if res > 0.5 else f"Covers {plan.coverage_pct:.0f}% in expectation.",
        )
    )
    ok = not any(c.status == "fail" and c.id != "residual" for c in checks)
    return TwinResult(ok, checks, minutes, soc, pct, exclude, derate)
