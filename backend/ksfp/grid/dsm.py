"""CERC DSM rule engine — energy-based, per 15-min block, with tiered volume bands.

The rule table is *versioned configuration*, never code. The shipped default reproduces the STRUCTURE of the
CERC (Deviation Settlement Mechanism and Related Matters) Regulations, 2024 for a general buyer — a Normal
Rate from market prices, frequency bands, and successive deviation volume bands each with its own
multiplier — but its NUMBERS ARE ILLUSTRATIVE. Before any settlement use, load the notified table for the
applicable buyer category, read with every subsequent amendment and order (e.g. the Third Amendment listed
by CERC on 7 Sep 2026 and the 3 Oct 2026 order on Regulation 9(7)), through PUT /api/v1/admin/config/dsm,
recording its source, amendments, effective date and approver. Verify against official settlement statements.

Config shape (version 2):
  bands:        [{"pct": 10, "cap_mw": 100, "combine": "min"}, {"pct": 15, "cap_mw": 200, "combine": "min"},
                 {"pct": null, "cap_mw": null}]   ← upper edge of each band; the last is open-ended
                 edge = min(pct % × schedule, cap_mw) (or max, if "combine": "max")
  overdrawal:   {"LOW": [m1, m2, m3], "NORMAL": [...], "HIGH": [...]}   multipliers of NR, one per band (payable)
  underdrawal:  {"LOW": [...], ...}                                     multipliers of NR, one per band (receivable)
Version-1 tables (band_pct, band_cap_mw, two multipliers) are read as a two-band table.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Prices:
    dam_acp: float = 5.4  # ₹/kWh, weighted avg ACP of integrated DAM
    rtm_acp: float = 7.2  # ₹/kWh, RTM
    asc: float = 8.1  # ₹/kWh, ancillary service charge
    off_peak: float = 3.2  # ₹/kWh, recharge / rebound energy


DEFAULT_DSM: dict = {
    "schema": 2,
    "version": "illustrative-tiered-2024-structure",
    "regulation": "CERC (Deviation Settlement Mechanism and Related Matters) Regulations, 2024 — structure only",
    "amendments_applied": [],
    "effective_from": None,
    "source": "Illustrative defaults shipped with the platform — NOT the notified table",
    "approved_by": None,
    "buyer_category": "General buyer (state control area) — illustrative",
    "freq_low": 49.90,
    "freq_high": 50.05,
    "bands": [
        {"label": "Band 1", "pct": 10.0, "cap_mw": 100.0, "combine": "min"},
        {"label": "Band 2", "pct": 15.0, "cap_mw": 200.0, "combine": "min"},
        {"label": "Band 3", "pct": None, "cap_mw": None},
    ],
    # multipliers of NR per band: payable for over-drawal, receivable for under-drawal (ILLUSTRATIVE)
    "overdrawal": {"LOW": [1.5, 2.0, 2.5], "NORMAL": [1.0, 1.5, 2.0], "HIGH": [0.5, 1.0, 1.5]},
    "underdrawal": {"LOW": [1.0, 0.5, 0.0], "NORMAL": [0.9, 0.0, 0.0], "HIGH": [0.0, 0.0, 0.0]},
}


def normalise(cfg: dict | None) -> dict:
    """Any accepted table → schema 2. Raises ValueError on an inconsistent table."""
    c = dict(cfg or DEFAULT_DSM)
    if "bands" not in c:  # schema 1: one band + beyond
        c["bands"] = [{"label": "Within band", "pct": c.get("band_pct", 10.0), "cap_mw": c.get("band_cap_mw", 100.0), "combine": "min"}, {"label": "Beyond band", "pct": None, "cap_mw": None}]
        c["schema"] = 2
    n = len(c["bands"])
    if n < 1 or c["bands"][-1].get("pct") is not None or c["bands"][-1].get("cap_mw") is not None:
        raise ValueError("the last band must be open-ended (pct and cap_mw null)")
    for side in ("overdrawal", "underdrawal"):
        for fb in ("LOW", "NORMAL", "HIGH"):
            m = c.get(side, {}).get(fb)
            if not isinstance(m, list) or len(m) != n:
                raise ValueError(f"{side}.{fb} needs {n} multipliers, one per band")
    if not c["freq_low"] < c["freq_high"]:
        raise ValueError("freq_low must be below freq_high")
    return c


@dataclass
class NormalRate:
    A: float
    B: float
    C: float
    nr: float
    binding: str


def normal_rate(p: Prices) -> NormalRate:
    A, B = p.dam_acp, p.rtm_acp
    C = (p.dam_acp + p.rtm_acp + p.asc) / 3
    nr = max(A, B, C)
    return NormalRate(A, B, C, nr, "A" if nr == A else "B" if nr == B else "C")


def freq_band(f: float, cfg: dict) -> str:
    return "LOW" if f < cfg["freq_low"] else "HIGH" if f >= cfg["freq_high"] else "NORMAL"


def band_edges(schedule_mw: float, cfg: dict) -> list[float]:
    """Upper edge (MW of |deviation|) of each band; the last is infinite. Edges never decrease."""
    out, prev = [], 0.0
    for b in cfg["bands"]:
        if b.get("pct") is None and b.get("cap_mw") is None:
            out.append(float("inf"))
            continue
        cands = [x for x in (abs(schedule_mw) * b["pct"] / 100 if b.get("pct") is not None else None, b.get("cap_mw")) if x is not None]
        edge = (max if b.get("combine") == "max" else min)(cands)
        prev = max(prev, edge)
        out.append(prev)
    return out


@dataclass
class DsmResult:
    deviation_mw: float
    deviation_pct: float
    energy_mwh: float
    freq_band: str
    band_mw: float  # upper edge of the first band (the tolerance band)
    within_mw: float  # deviation inside band 1
    beyond_mw: float  # deviation beyond band 1 (all higher bands)
    mult_within: float
    mult_beyond: float  # multiplier of the outermost band in use
    amount_rs: float  # per block; + payable by the state, − receivable
    nr: NormalRate
    marginal_rate: float  # ₹/kWh of the next MW of deviation (outermost band in use)
    slices: list[dict] = field(default_factory=list)  # per band: {label, from_mw, to_mw, mw, mult, rs}
    version: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def dsm_charge(deviation_mw: float, schedule_mw: float, frequency: float, prices: Prices, cfg: dict | None = None, block_h: float = 0.25) -> DsmResult:
    cfg = normalise(cfg)
    nr = normal_rate(prices)
    fb = freq_band(frequency, cfg)
    edges = band_edges(schedule_mw, cfg)
    mults = cfg["overdrawal" if deviation_mw >= 0 else "underdrawal"][fb]
    a = abs(deviation_mw)
    slices, lo, amt, last_used = [], 0.0, 0.0, 0
    for i, (hi, m) in enumerate(zip(edges, mults)):
        mw = max(0.0, min(a, hi) - lo)
        rs = mw * block_h * 1000 * m * nr.nr
        if mw > 0:
            last_used = i
        slices.append({"label": cfg["bands"][i].get("label", f"Band {i + 1}"), "from_mw": lo, "to_mw": hi if hi != float("inf") else None, "mw": mw, "mult": m, "rs": rs})
        amt += rs
        lo = hi
        if a <= hi:
            break
    return DsmResult(
        deviation_mw=deviation_mw,
        deviation_pct=deviation_mw / schedule_mw * 100 if schedule_mw else 0.0,
        energy_mwh=a * block_h,
        freq_band=fb,
        band_mw=edges[0],
        within_mw=slices[0]["mw"],
        beyond_mw=max(0.0, a - edges[0]),
        mult_within=mults[0],
        mult_beyond=mults[last_used] if last_used else (mults[1] if len(mults) > 1 else mults[0]),
        amount_rs=amt if deviation_mw >= 0 else -amt,
        nr=nr,
        marginal_rate=mults[last_used] * nr.nr,
        slices=slices,
        version=str(cfg.get("version", "")),
    )
