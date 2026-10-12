"""Measurement & verification and settlement, accumulated live while a decision executes.

Per tick: delivered energy per asset (telemetry), expected energy per asset (plan), and the
DSM cost difference between the counterfactual (no DR) and actual deviation.
Payment = delivered energy × incentive × performance factor (≥90 % → 1.0, 50–90 % linear, <50 % → 0).
Ancillary participation settles under the CERC / GRID-INDIA procedure instead.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from ..grid.dsm import dsm_charge
from ..grid.state import Assessment
from ..grid.topology import topology


def perf_factor(p: float) -> float:
    if p >= 0.9:
        return 1.0
    if p <= 0.5:
        return 0.0
    return (p - 0.5) / 0.4


@dataclass
class Meter:
    delivered_mwh: dict[str, float] = field(default_factory=dict)
    expected_mwh: dict[str, float] = field(default_factory=dict)
    peak_mw: dict[str, float] = field(default_factory=dict)
    avoided_dsm_rs: float = 0.0
    do_nothing_rs: float = 0.0
    actual_dsm_rs: float = 0.0
    seconds: float = 0.0

    def tick(self, a: Assessment, expected_now: dict[str, float], dt: float) -> None:
        s = a.state
        h = dt / 3600
        sign = 1.0 if a.direction == "UP" else -1.0
        delivered_total = 0.0
        for aid, exp in expected_now.items():
            if aid == "RTM":
                mw = exp
            else:
                mw = float(s.asset_state.get(aid, {}).get("mw", 0.0))
            delivered_total += mw
            self.delivered_mwh[aid] = self.delivered_mwh.get(aid, 0.0) + mw * h
            self.expected_mwh[aid] = self.expected_mwh.get(aid, 0.0) + exp * h
            self.peak_mw[aid] = max(self.peak_mw.get(aid, 0.0), mw)
        frac = dt / 900
        without = dsm_charge(a.deviation_mw + sign * delivered_total, s.schedule_mw, s.frequency, s.prices, a.dsm_cfg).amount_rs * frac
        actual = dsm_charge(a.deviation_mw, s.schedule_mw, s.frequency, s.prices, a.dsm_cfg).amount_rs * frac
        self.do_nothing_rs += without
        self.actual_dsm_rs += actual
        self.avoided_dsm_rs += without - actual
        self.seconds += dt

    def settle(self, reliability: dict[str, float], rates: dict[str, float] | None = None, prices_off_peak: float = 3.2, rtm_price: float = 7.2) -> dict:
        """rates: pay rate per asset locked at dispatch (₹/kWh) — the same rate the optimiser costed."""
        rates = rates or {}
        t = topology()
        rows = []
        for aid, d in self.delivered_mwh.items():
            e = self.expected_mwh.get(aid, 0.0)
            if aid == "RTM":
                rate, pf, perf, name, typ = rates.get(aid, rtm_price), 1.0, 1.0, "RTM purchase", "rtm"
            else:
                spec = t.asset(aid)
                perf = d / e if e > 1e-6 else 1.0
                typ = spec["type"]
                rate = rates.get(aid, spec["bidRs"])
                pf = 1.0 if typ == "generation" else perf_factor(perf)
                name = spec["name"]
            r_old = reliability.get(aid, 1.0)
            rows.append(
                {
                    "asset_id": aid,
                    "name": name,
                    "type": typ,
                    "expected_mwh": round(e, 3),
                    "delivered_mwh": round(d, 3),
                    "peak_mw": round(self.peak_mw.get(aid, 0.0), 1),
                    "performance": round(perf, 3),
                    "rate_rs": rate,
                    "perf_factor": round(pf, 3),
                    "payment_rs": round(d * 1000 * rate * pf, 0),
                    "reliability_before": r_old,
                    "reliability_after": r_old if aid == "RTM" else round(min(0.995, 0.8 * r_old + 0.2 * min(1.0, perf)), 4),
                }
            )
        payments = sum(r["payment_rs"] for r in rows)
        return {
            "rows": rows,
            "payments_rs": payments,
            "avoided_dsm_rs": round(self.avoided_dsm_rs, 0),
            "do_nothing_dsm_rs": round(self.do_nothing_rs, 0),
            "actual_dsm_rs": round(self.actual_dsm_rs, 0),
            "net_benefit_rs": round(self.avoided_dsm_rs - payments, 0),
            "duration_min": round(self.seconds / 60, 1),
            "delivered_mwh": round(sum(r["delivered_mwh"] for r in rows), 2),
            "expected_mwh": round(sum(r["expected_mwh"] for r in rows), 2),
        }

    def to_dict(self) -> dict:
        return asdict(self)
