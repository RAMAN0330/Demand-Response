"""Network-constrained multi-block dispatch as a linear program (HiGHS via scipy).

Decision variables, for resources i and blocks b:
  x[i,b] ≥ 0   MW commanded (setpoint)
  φ[i,b]       share of block b's energy actually delivered after response delay and ramp (flexibility.py),
               so expected delivery in block b is R_i·φ[i,b]·x[i,b] — never a full block from a slow starter
  s[b]   ≥ 0   unserved requirement (penalised at λ, above any economic resource)
  v[l,b] ≥ 0   overload slack on line l (penalised at μ ≫ λ; keeps the LP feasible when an
               overload pre-exists, and makes the solver *prefer* relieving resources)

min  Σ (pay+rebound)_i · R_i · φ[i,b] · x[i,b] · Δt·1000  +  λ Σ s[b]  +  μ Σ v[l,b]
     (₹ per delivered kWh × expected delivered energy — the same rate settlement pays)
s.t. Σ_i R_i φ[i,b] x[i,b] + s[b] ≥ req[b]                  (balance, expected block-average MW)
     ±(f0_l + Σ_i PTDF[l,bus_i]·dir·x[i,b]) − v[l,b] ≤ limit_l   (thermal limits, N-0)
     x[i,b] ≤ avail_i ;  x[i,b] = 0 for b < earliest_i       (capacity, response time)
     x[i,b] − x[i,b−1] ≤ ramp_i·15 (x[i,−1] = current MW)    (ramp)
     Σ_b φ[i,b] x[i,b]·Δt/ηd ≤ E_i (stored above SoC floor)  (BESS energy)
     Σ_b x[i,b] ≤ maxBlocks_i · avail_i                      (duration budget, LP relaxation)

Minimum on/off times and start-up costs need binaries — the same builder feeds a MILP
(highspy / Gurobi) in the production solver profile.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field

import numpy as np
from scipy.optimize import linprog

from ..grid.dsm import dsm_charge
from ..grid.network import ptdf_model, solve
from ..grid.state import Assessment
from ..grid.topology import topology
from .flexibility import BLOCK_H, FlexEval

STRATEGIES = {
    "NONE": {"label": "Do nothing", "types": set(), "desc": "Absorb the deviation and pay DSM charges."},
    "RTM": {
        "label": "Buy in RTM",
        "types": {"rtm"},
        "desc": "Real-Time Market purchase for a deficit — delivery in the 4 blocks after the session (≈1 h lead). Selling surplus is not modelled.",
    },
    "GEN": {"label": "Re-dispatch generation", "types": {"generation"}, "desc": "Ramp intra-state thermal/hydro headroom."},
    "BESS": {"label": "BESS only", "types": {"bess"}, "desc": "Discharge grid batteries."},
    "DR": {"label": "Demand response only", "types": {"interruptible", "shiftable", "industrial", "der"}, "desc": "Curtail or shift flexible demand."},
    "OPTIMAL": {
        "label": "Optimal mix",
        "types": {"generation", "bess", "interruptible", "shiftable", "industrial", "der", "rtm"},
        "desc": "Co-optimise all resources under network constraints.",
    },
}
RTM_LEAD_BLOCKS = 4


@dataclass
class Allocation:
    asset_id: str
    name: str
    type: str
    bus: str | None
    mw_by_block: list[float]
    expected_by_block: list[float]
    reliability: float
    effective_cost: float
    cost_rs: float  # payment for expected delivery (pay rate); rebound is costed separately in the plan
    rate_rs: float = 0.0  # pay rate, ₹/kWh — settlement pays this for metered delivery
    rank: int = 0
    caps: list[str] = field(default_factory=list)


@dataclass
class Plan:
    strategy: str
    direction: str
    blocks: int
    requirement: list[float]
    supplied: list[float]
    residual: list[float]
    allocations: list[Allocation]
    skipped: list[dict]
    bindings: list[dict]
    costs: dict
    coverage_pct: float
    max_loading_after: dict
    loading_after: dict[str, float]
    post_rebound_mw: float
    solver: dict

    def to_dict(self) -> dict:
        d = asdict(self)
        return d

    def peak_mw(self) -> float:
        return max((sum(a.mw_by_block[b] for a in self.allocations if a.type != "rtm") for b in range(self.blocks)), default=0.0)


def _base_injection(a: Assessment, active_mw: dict[str, float]) -> dict[str, float]:
    """Network injections with our own currently-delivered flexibility backed out (MPC baseline)."""
    s = a.state
    t = topology()
    inj = {b: -v for b, v in s.bus_load.items()}
    for g in t.generators:
        inj[g["bus"]] += s.gen_output.get(g["id"], 0.0)
    sign = 1.0 if a.direction == "UP" else -1.0
    for aid, mw in active_mw.items():
        bus = t.asset(aid)["bus"]
        inj[bus] -= sign * mw
    return inj


def optimize(
    a: Assessment,
    evals: list[FlexEval],
    requirement_mw: float,
    blocks: int = 4,
    strategy: str = "OPTIMAL",
    exclude: set[str] | None = None,
    derate: dict[str, float] | None = None,
    active_mw: dict[str, float] | None = None,
    dsm_cfg: dict | None = None,
) -> Plan:
    t0 = time.perf_counter()
    t = topology()
    s = a.state
    exclude = exclude or set()
    derate = derate or {}
    active_mw = active_mw or {}
    dsm_cfg = dsm_cfg or a.dsm_cfg  # same rule table as the assessment
    types = STRATEGIES[strategy]["types"]
    sign = 1.0 if a.direction == "UP" else -1.0
    dsm_marginal = dsm_charge(a.deviation_mw, s.schedule_mw, s.frequency, s.prices, dsm_cfg).marginal_rate

    cands: list[dict] = []
    skipped: list[dict] = []
    for e in evals:
        if e.asset["type"] not in types:
            continue
        if e.id in exclude:
            skipped.append({"asset_id": e.id, "name": e.asset["name"], "reason": "Removed by Digital Twin / command failure"})
            continue
        if not e.eligible:
            skipped.append({"asset_id": e.id, "name": e.asset["name"], "reason": "; ".join(e.exclusions)})
            continue
        if a.severity == "NORMAL" and e.effective_cost >= dsm_marginal:
            skipped.append({"asset_id": e.id, "name": e.asset["name"], "reason": f"Costlier (₹{e.effective_cost:.2f}) than DSM marginal ₹{dsm_marginal:.2f} — economic DR only in NORMAL"})
            continue
        avail = min(e.available_mw, derate.get(e.id, e.available_mw))
        cands.append(
            {
                "id": e.id,
                "name": e.asset["name"],
                "type": e.asset["type"],
                "bus": e.asset["bus"],
                "R": e.reliability,
                "unit_cost": e.effective_cost,  # pay + rebound, ₹ per delivered kWh
                "pay": e.pay_rs,
                "eff": e.effective_cost,
                "avail": avail,
                "earliest": e.earliest_block,
                "phi": list(e.factors[:blocks]) + [1.0] * max(0, blocks - len(e.factors)),
                "max_blocks": e.max_blocks,
                "ramp": e.asset["rampMWpm"] * 15,
                "current": e.current_mw,
                "energy": e.energy_mwh,  # stored energy above the SoC floor (MWh, before discharge losses)
                "etaD": e.asset["bess"]["etaD"] if e.asset.get("bess") else 1.0,
                "rebound": e.asset["reboundFrac"],
                "recovery_h": max(0.25, e.asset["recoveryMin"] / 60),
            }
        )
    if "rtm" in types and a.direction == "UP":
        cands.append(
            {
                "id": "RTM",
                "name": "RTM purchase (IEX/PXIL/HPX)",
                "type": "rtm",
                "bus": None,
                "R": 1.0,
                "unit_cost": s.prices.rtm_acp + 0.05,
                "pay": s.prices.rtm_acp + 0.05,
                "eff": s.prices.rtm_acp + 0.05,
                "avail": 5000.0,
                "earliest": RTM_LEAD_BLOCKS,
                "phi": [0.0 if b < RTM_LEAD_BLOCKS else 1.0 for b in range(blocks)],
                "max_blocks": 96,
                "ramp": 1e6,
                "current": 0.0,
                "energy": None,
                "etaD": 1.0,
                "rebound": 0.0,
                "recovery_h": 1.0,
            }
        )

    B = blocks
    req = [max(0.0, requirement_mw)] * B
    n_c = len(cands)
    out_t = tuple(sorted(s.outaged))
    m = ptdf_model(out_t)
    base = solve(_base_injection(a, active_mw), out_t)
    # lines that any candidate can affect
    sens = np.zeros((len(m.line_ids), n_c))
    for j, c in enumerate(cands):
        if c["bus"]:
            k = m.internal_ids.index(c["bus"])
            sens[:, j] = m.H[:, k] * sign
    line_idx = [i for i, lid in enumerate(m.line_ids) if lid not in out_t and np.any(np.abs(sens[i]) > 1e-3)]
    nL = len(line_idx)

    nx = n_c * B
    ns = B
    nv = nL * B
    N = nx + ns + nv

    def xi(j: int, b: int) -> int:
        return j * B + b

    def si(b: int) -> int:
        return nx + b

    def vi(li: int, b: int) -> int:
        return nx + ns + li * B + b

    nr = s.prices
    from ..grid.dsm import normal_rate

    lam = max(3 * normal_rate(nr).nr, 25.0) * BLOCK_H * 1000
    mu = 1e7
    c_vec = np.zeros(N)
    for j, c in enumerate(cands):
        for b in range(B):
            c_vec[xi(j, b)] = c["unit_cost"] * c["R"] * c["phi"][b] * BLOCK_H * 1000 + 1e-3 * j  # tiny tie-break → stable merit order
    for b in range(B):
        c_vec[si(b)] = lam
    for k in range(nv):
        c_vec[nx + ns + k] = mu

    A_rows: list[np.ndarray] = []
    b_rows: list[float] = []

    def row() -> np.ndarray:
        return np.zeros(N)

    # balance: −Σ R x − s ≤ −req
    for b in range(B):
        r = row()
        for j, c in enumerate(cands):
            r[xi(j, b)] = -c["R"] * c["phi"][b]
        r[si(b)] = -1
        A_rows.append(r)
        b_rows.append(-req[b])
    # no over-correction: expected supply ≤ requirement + tolerance (pushing ACE the other way is
    # not a congestion remedy — residual overload is reported for topology / re-despatch action)
    for b in range(B):
        r = row()
        for j, c in enumerate(cands):
            r[xi(j, b)] = c["R"] * c["phi"][b]
        A_rows.append(r)
        b_rows.append(req[b] * 1.05 + 20)
    # thermal limits (both directions)
    for li, i in enumerate(line_idx):
        f0 = base.flows[m.line_ids[i]]
        lim = m.limits[i]
        for b in range(B):
            r1, r2 = row(), row()
            for j in range(n_c):
                if abs(sens[i, j]) > 1e-6:
                    r1[xi(j, b)] = sens[i, j]
                    r2[xi(j, b)] = -sens[i, j]
            r1[vi(li, b)] = -1
            r2[vi(li, b)] = -1
            A_rows += [r1, r2]
            b_rows += [lim - f0, lim + f0]
    for j, c in enumerate(cands):
        # ramp
        for b in range(B):
            r = row()
            r[xi(j, b)] = 1
            if b == 0:
                b_rows.append(c["current"] + c["ramp"])
            else:
                r[xi(j, b - 1)] = -1
                b_rows.append(c["ramp"])
            A_rows.append(r)
        # BESS energy: stored energy drawn = delivered energy / ηd ≤ stored energy above the floor
        if c["energy"] is not None:
            r = row()
            for b in range(B):
                r[xi(j, b)] = c["phi"][b] * BLOCK_H / c["etaD"]
            A_rows.append(r)
            b_rows.append(c["energy"])
        # duration budget
        if c["max_blocks"] < B:
            r = row()
            for b in range(B):
                r[xi(j, b)] = 1
            A_rows.append(r)
            b_rows.append(c["max_blocks"] * c["avail"])

    bounds = []
    for j, c in enumerate(cands):
        for b in range(B):
            bounds.append((0.0, 0.0 if (b < c["earliest"] or c["phi"][b] <= 0.01) else c["avail"]))
    bounds += [(0.0, None)] * (ns + nv)

    res = linprog(c_vec, A_ub=np.array(A_rows) if A_rows else None, b_ub=np.array(b_rows) if b_rows else None, bounds=bounds, method="highs")
    solve_ms = (time.perf_counter() - t0) * 1000
    x = res.x if res.success else np.zeros(N)

    allocations: list[Allocation] = []
    for j, c in enumerate(cands):
        mw = [float(round(x[xi(j, b)], 2)) for b in range(B)]
        if max(mw) < 0.5:
            reason = "Not needed — requirement covered by cheaper resources"
            if c["earliest"] >= B:
                reason = f"Responds from block {c['earliest'] + 1} — outside the {B}-block horizon" if c["type"] != "rtm" else f"RTM delivers from block {RTM_LEAD_BLOCKS + 1} (gate closure) — beyond this horizon"
            skipped.append({"asset_id": c["id"], "name": c["name"], "reason": reason})
            continue
        exp = [v * c["R"] * c["phi"][b] for b, v in enumerate(mw)]  # block-average expected delivery
        mwh = sum(exp) * BLOCK_H
        caps = []
        if max(mw) < c["avail"] - 0.5 and c["type"] != "rtm":
            if c["energy"] is not None and sum(v * c["phi"][b] for b, v in enumerate(mw)) * BLOCK_H / c["etaD"] >= c["energy"] - 0.5:
                caps.append("Energy-limited (SoC floor)")
            if c["max_blocks"] < B and sum(mw) >= c["max_blocks"] * c["avail"] - 0.5:
                caps.append(f"Max duration {c['max_blocks'] * 15} min")
            if mw[0] >= c["current"] + c["ramp"] - 0.5:
                caps.append(f"Ramp-limited ({c['ramp'] / 15:g} MW/min)")
        allocations.append(
            Allocation(
                asset_id=c["id"],
                name=c["name"],
                type=c["type"],
                bus=c["bus"],
                mw_by_block=mw,
                expected_by_block=exp,
                reliability=c["R"],
                effective_cost=c["eff"],
                cost_rs=mwh * 1000 * c["pay"],
                caps=caps,
                rate_rs=c["pay"],
            )
        )
    allocations.sort(key=lambda al: al.effective_cost)
    for r_, al in enumerate(allocations, 1):
        al.rank = r_

    # binding network constraints from the duals (shadow prices)
    bindings: list[dict] = []
    if res.success and nL:
        marg = res.ineqlin.marginals if hasattr(res, "ineqlin") else None
        base_rows = 2 * B
        for li, i in enumerate(line_idx):
            lid = m.line_ids[i]
            for b in range(B):
                k1 = base_rows + (li * B + b) * 2
                dual = 0.0
                if marg is not None:
                    dual = float(min(marg[k1], marg[k1 + 1]))
                over = x[vi(li, b)]
                if dual < -1e-6 or over > 0.5:
                    affected = [cands[j]["name"] for j in range(n_c) if sens[i, j] * np.sign(base.flows[lid] or 1) > 1e-3]
                    bindings.append(
                        {
                            "line": lid,
                            "label": t.line_label(lid),
                            "block": b,
                            "shadow_price_rs_per_mw": round(-dual / (BLOCK_H * 1000), 2),
                            "overload_mw": round(float(over), 1),
                            "detail": (f"{t.line_label(lid)} at its limit in block {b + 1}" + (f" (pre-existing overload {over:.0f} MW being relieved)" if over > 0.5 else ""))
                            + (f" — limits {', '.join(affected[:3])}" if affected else ""),
                        }
                    )
                    break

    supplied = [sum(al.expected_by_block[b] for al in allocations) for b in range(B)]
    residual = [float(x[si(b)]) for b in range(B)]
    resource_rs = sum(al.cost_rs for al in allocations if al.type != "rtm")
    rtm_rs = sum(al.cost_rs for al in allocations if al.type == "rtm")
    # post-event rebound (load returning after release)
    post_rebound = 0.0
    rebound_rs = 0.0
    for al in allocations:
        c = next(cc for cc in cands if cc["id"] == al.asset_id)
        if c["rebound"] > 0:
            e_mwh = c["rebound"] * sum(al.expected_by_block) * BLOCK_H
            post_rebound += e_mwh / c["recovery_h"]
            rebound_rs += e_mwh * 1000 * s.prices.off_peak
    residual_dsm = 0.0
    do_nothing = 0.0
    for b in range(B):
        dev_after = a.deviation_mw - sign * supplied[b]
        residual_dsm += dsm_charge(dev_after, s.schedule_mw, s.frequency, s.prices, dsm_cfg).amount_rs
        do_nothing += dsm_charge(a.deviation_mw, s.schedule_mw, s.frequency, s.prices, dsm_cfg).amount_rs
    total = resource_rs + rtm_rs + rebound_rs + residual_dsm
    need = sum(req)
    # network after block-1 dispatch
    inj = _base_injection(a, active_mw)
    for al in allocations:
        if al.bus:
            inj[al.bus] += sign * al.expected_by_block[0]
    after = solve(inj, out_t)
    return Plan(
        strategy=strategy,
        direction=a.direction,
        blocks=B,
        requirement=req,
        supplied=supplied,
        residual=residual,
        allocations=allocations,
        skipped=skipped,
        bindings=bindings,
        costs={
            "resource_rs": resource_rs,
            "rtm_rs": rtm_rs,
            "rebound_rs": rebound_rs,
            "residual_dsm_rs": residual_dsm,
            "total_rs": total,
            "do_nothing_rs": do_nothing,
            "savings_rs": do_nothing - total,
        },
        coverage_pct=(sum(supplied) / need * 100) if need > 0 else 100.0,
        max_loading_after={"line": after.max_line, "label": t.line_label(after.max_line), "loading": after.max_loading},
        loading_after=after.loading,
        post_rebound_mw=post_rebound,
        solver={
            "engine": "HiGHS (LP)",
            "status": res.status,
            "message": str(res.message)[:120],
            "variables": N,
            "constraints": len(A_rows),
            "objective_rs": float(res.fun) if res.success else None,
            "solve_ms": round(solve_ms, 1),
        },
    )


def compare(a: Assessment, evals: list[FlexEval], requirement_mw: float, blocks: int = 4, active_mw: dict[str, float] | None = None) -> list[dict]:
    out = []
    for sid, meta in STRATEGIES.items():
        p = optimize(a, evals, requirement_mw, blocks, sid, active_mw=active_mw)
        out.append(
            {
                "id": sid,
                "label": meta["label"],
                "description": meta["desc"],
                "total_rs": p.costs["total_rs"],
                "resource_rs": p.costs["resource_rs"] + p.costs["rtm_rs"],
                "residual_dsm_rs": p.costs["residual_dsm_rs"],
                "coverage_pct": p.coverage_pct if sid != "NONE" else 0.0,
                "time_to_effect_min": min((topology().asset(al.asset_id)["responseMin"] if al.type != "rtm" else RTM_LEAD_BLOCKS * 15 for al in p.allocations), default=None),
                "max_line_loading": p.max_loading_after["loading"],
                "resources": len(p.allocations),
                # RTM here is a purchase: it can only help a deficit (UP); a surplus would need a sell path
                "applicable": not (sid == "RTM" and a.direction != "UP"),
            }
        )
    return out
