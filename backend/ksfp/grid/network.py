"""DC power flow with distributed slack at the ISTS tie points.

flows = H @ p, where p is the net injection (gen − load) at internal buses. Net import is
absorbed by the external tie buses in proportion to their participation factors; H is the
PTDF matrix for that slack distribution, cached per outage set.

Numerics: H is formed by solving the reduced susceptance system (np.linalg.solve on a symmetric
positive-definite matrix) rather than forming an explicit inverse, and every per-solve quantity
(flows, loading, bus voltage proxy, tie injections) is one vectorised expression over precomputed
index arrays. N-1 screening uses line outage distribution factors (LODF) derived from the same
model, so all single-line contingencies are evaluated with one L × L matrix expression.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .topology import topology


EARTH_R_KM = 6371.0088  # IUGG mean Earth radius


def great_circle_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine great-circle distance (numerically stable for short spans, unlike the law of cosines)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R_KM * math.asin(min(1.0, math.sqrt(h)))


def _km(a: dict, b: dict) -> float:
    # straight-line route length; floor at 15 km so very short ties keep a finite reactance
    return max(15.0, great_circle_km(a["lat"], a["lon"], b["lat"], b["lon"]))


def _reactance(line: dict) -> float:
    t = topology()
    per_km = 0.35 if line["kv"] == 765 else 1.0 if line["kv"] == 400 else 3.2
    return _km(t.bus(line["from"]), t.bus(line["to"])) * per_km * (0.6 if line.get("hvdc") else 1.0)


@dataclass(frozen=True)
class PtdfModel:
    line_ids: tuple[str, ...]
    internal_ids: tuple[str, ...]
    H: np.ndarray  # lines × internal buses
    limits: np.ndarray
    islanded: tuple[str, ...]  # buses cut off from the main network by the outage set
    alive: np.ndarray  # bool per line: in service and inside the main component
    isf: np.ndarray  # lines × buses injection shift factors (angle reference bus = 0 column)
    f_idx: np.ndarray  # per line: column of its from-bus in isf (−1 if not in the main component)
    t_idx: np.ndarray  # per line: column of its to-bus
    incidence: np.ndarray  # buses (all, topology order) × lines, True where the line ends at the bus
    ext_share: np.ndarray  # per external bus (topology order): share of net import it absorbs
    connected: np.ndarray  # bool per internal bus: inside the main component


def _main_component(lines: list[dict], outaged: tuple[str, ...]) -> set[str]:
    t = topology()
    adj: dict[str, set[str]] = {b["id"]: set() for b in t.buses}
    for ln in lines:
        if ln["id"] not in outaged:
            adj[ln["from"]].add(ln["to"])
            adj[ln["to"]].add(ln["from"])
    seen: set[str] = set()
    best: set[str] = set()
    for start in adj:
        if start in seen:
            continue
        comp, stack = set(), [start]
        while stack:
            u = stack.pop()
            if u in comp:
                continue
            comp.add(u)
            stack.extend(adj[u] - comp)
        seen |= comp
        if len(comp) > len(best):
            best = comp
    return best


@lru_cache(maxsize=64)
def ptdf_model(outaged: tuple[str, ...] = ()) -> PtdfModel:
    t = topology()
    lines = list(t.lines)
    alive_buses = _main_component(lines, outaged)
    ids = [b["id"] for b in t.buses if b["id"] in alive_buses]
    idx = {b: i for i, b in enumerate(ids)}
    n = len(ids)
    internal = [b["id"] for b in t.internal]
    ext = [e for e in t.external if e["id"] in alive_buses]
    part_sum = sum(e.get("participation", 0) for e in ext) or 1.0
    B = np.zeros((n, n))
    for ln in lines:
        if ln["id"] in outaged or ln["from"] not in idx or ln["to"] not in idx:
            continue
        y = 1 / _reactance(ln)
        i, j = idx[ln["from"]], idx[ln["to"]]
        B[i, i] += y
        B[j, j] += y
        B[i, j] -= y
        B[j, i] -= y
    # injection map: internal p → injection vector (connected ties absorb −Σp by participation).
    # Islanded internal buses get a zero column: their load/generation cannot reach the network.
    A = np.zeros((n, len(internal)))
    for k, bid in enumerate(internal):
        if bid not in idx:
            continue
        A[idx[bid], k] = 1.0
        for e in ext:
            A[idx[e["id"]], k] -= e.get("participation", 0) / part_sum
    keep = list(range(1, n))  # bus 0 is the angle reference
    Bf = np.zeros((len(lines), n))
    for li, ln in enumerate(lines):
        if ln["id"] in outaged or ln["from"] not in idx or ln["to"] not in idx:
            continue
        y = 1 / _reactance(ln)
        Bf[li, idx[ln["from"]]] = y
        Bf[li, idx[ln["to"]]] = -y
    # ISF = Bf · B⁻¹ restricted to non-reference buses: solve B_kk · Xᵀ = Bf_kᵀ instead of inverting B
    isf = np.zeros((len(lines), n))
    if keep:
        isf[:, keep] = np.linalg.solve(B[np.ix_(keep, keep)], Bf[:, keep].T).T
    H = isf @ A
    alive = np.array([ln["id"] not in outaged and ln["from"] in idx and ln["to"] in idx for ln in lines])
    f_idx = np.array([idx.get(ln["from"], -1) for ln in lines])
    t_idx = np.array([idx.get(ln["to"], -1) for ln in lines])
    pos = {b["id"]: i for i, b in enumerate(t.buses)}
    inc = np.zeros((len(t.buses), len(lines)), bool)
    for li, ln in enumerate(lines):
        inc[pos[ln["from"]], li] = inc[pos[ln["to"]], li] = True
    share = np.array([e.get("participation", 0) / part_sum if e["id"] in alive_buses else 0.0 for e in t.external])
    islanded = tuple(b["id"] for b in t.buses if b["id"] not in alive_buses)
    return PtdfModel(
        tuple(ln["id"] for ln in lines),
        tuple(internal),
        H,
        np.array([ln["limitMW"] for ln in lines], float),
        islanded,
        alive,
        isf,
        f_idx,
        t_idx,
        inc,
        share,
        np.array([bid in idx for bid in internal]),
    )


@dataclass
class FlowResult:
    flows: dict[str, float]
    loading: dict[str, float]
    voltage: dict[str, float]
    injections: dict[str, float]  # incl. ISTS tie injections (+ = import into Karnataka)
    max_line: str
    max_loading: float
    islanded: tuple[str, ...] = ()


def solve(injection: dict[str, float], outaged: tuple[str, ...] = ()) -> FlowResult:
    t = topology()
    m = ptdf_model(tuple(sorted(outaged)))
    p = np.fromiter((injection.get(b, 0.0) for b in m.internal_ids), float, len(m.internal_ids))
    f = np.where(m.alive, m.H @ p, 0.0)
    ld = np.abs(f) / m.limits
    # voltage proxy: 1.035 pu sagging with the square of the worst loading on any connected line
    worst = np.where(m.incidence & m.alive, ld, 0.0).max(axis=1)
    v = np.round(1.035 - 0.075 * worst * worst, 4)
    total = float(p[m.connected].sum())
    inj = dict(zip(m.internal_ids, p.tolist()))
    inj.update(zip((e["id"] for e in t.external), (-total * m.ext_share).tolist()))
    k = int(np.argmax(ld))
    flows = dict(zip(m.line_ids, f.tolist()))
    loading = dict(zip(m.line_ids, ld.tolist()))
    return FlowResult(flows, loading, dict(zip((b["id"] for b in t.buses), v.tolist())), inj, m.line_ids[k], float(ld[k]), m.islanded)


def lodf(outaged: tuple[str, ...] = ()) -> tuple[np.ndarray, np.ndarray]:
    """Line outage distribution factors for the network with `outaged` already out.

    LODF[l, k] is the share of line k's pre-outage flow that moves onto line l when k trips:
    f_l' = f_l + LODF[l, k] · f_k. Column k is PTDF_l(i→j) / (1 − PTDF_k(i→j)) for line k = i→j.
    Returns (LODF, radial) where radial[k] marks lines whose loss would island part of the grid
    (denominator ≈ 0); their columns are left at zero and must be reported as islanding instead.
    """
    m = ptdf_model(tuple(sorted(outaged)))
    L = len(m.line_ids)
    ok = m.alive & (m.f_idx >= 0) & (m.t_idx >= 0)
    ptdf = np.zeros((L, L))
    cols = np.flatnonzero(ok)
    ptdf[:, cols] = m.isf[:, m.f_idx[cols]] - m.isf[:, m.t_idx[cols]]
    denom = 1.0 - np.diag(ptdf)
    radial = ok & (np.abs(denom) < 1e-6)
    use = ok & ~radial
    out = np.zeros((L, L))
    out[:, use] = ptdf[:, use] / denom[use]
    out[use, use] = -1.0  # the tripped line itself carries nothing afterwards
    out[~m.alive, :] = 0.0
    return out, radial


@dataclass
class Contingency:
    line: str  # the tripped line
    worst_line: str | None  # the line most loaded afterwards
    worst_loading: float
    overloads: int  # lines above 100 % afterwards
    islanding: bool
    islanded: tuple[str, ...] = ()  # buses cut off by this outage (for a radial line)


def n1_screen(flows: dict[str, float], outaged: tuple[str, ...] = ()) -> tuple[list[Contingency], dict[str, float]]:
    """All single-line contingencies in one vectorised pass.

    Returns the contingencies ranked worst first and, per monitored line, its worst post-contingency
    loading (the N-1 security margin the 3D map shades by).
    """
    m = ptdf_model(tuple(sorted(outaged)))
    D, radial = lodf(outaged)
    f = np.array([flows.get(lid, 0.0) for lid in m.line_ids])
    post = f[:, None] + D * f[None, :]  # post[l, k]: flow on l after k trips
    ld = np.abs(post) / m.limits[:, None]
    ld[~m.alive, :] = 0.0
    trip = m.alive & ~radial
    ld[np.arange(len(f)), np.arange(len(f))] = 0.0  # the tripped line itself
    ld[:, ~trip] = 0.0
    res: list[Contingency] = []
    for k in np.flatnonzero(m.alive):
        if radial[k]:
            cut = tuple(b for b in ptdf_model(tuple(sorted({*outaged, m.line_ids[k]}))).islanded if b not in m.islanded)
            res.append(Contingency(m.line_ids[k], None, 0.0, 0, True, cut))
            continue
        w = int(np.argmax(ld[:, k]))
        res.append(Contingency(m.line_ids[k], m.line_ids[w], float(ld[w, k]), int((ld[:, k] > 1.0).sum()), False))
    res.sort(key=lambda c: (not c.islanding, -c.worst_loading))  # islanding first, then by severity
    worst_by_line = dict(zip(m.line_ids, ld.max(axis=1).tolist()))
    return res, worst_by_line


def ptdf_column(bus: str, outaged: tuple[str, ...] = ()) -> dict[str, float]:
    m = ptdf_model(tuple(sorted(outaged)))
    k = m.internal_ids.index(bus)
    return {lid: float(m.H[i, k]) for i, lid in enumerate(m.line_ids)}
