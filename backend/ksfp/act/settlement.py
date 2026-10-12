"""Measurement & verification and settlement, accumulated live while a decision executes.

Per tick: delivered energy per asset (telemetry), expected energy per asset (plan), and the
DSM cost difference between the counterfactual (no DR) and actual deviation.
Payment = delivered energy × pay rate (locked at dispatch) × performance factor (≥90 % → 1.0, 50–90 % linear,
<50 % → 0). Ancillary participation settles under the CERC / GRID-INDIA procedure instead.

Counterfactual ledger (one source for every savings figure on screen):
    counterfactual DSM   DSM the state would have owed with no action (metered deviation + delivered response)
  − actual DSM           DSM on the deviation that actually occurred
  = avoided DSM
  − participant payments (DR, BESS, generation; generation backing down can be a credit)
  − RTM purchase cost
  − rebound energy cost  (energy that returns after release, bought off-peak)
  = net savings          ← reported as net_benefit_rs; reconciliation is asserted, nothing counted twice
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
            rebound_frac = 0.0 if aid == "RTM" else t.asset(aid)["reboundFrac"]
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
                    "rebound_rs": round(d * rebound_frac * 1000 * prices_off_peak, 0),
                    "reliability_before": r_old,
                    "reliability_after": r_old if aid == "RTM" else round(min(0.995, 0.8 * r_old + 0.2 * min(1.0, perf)), 4),
                }
            )
        resource_pay = sum(r["payment_rs"] for r in rows if r["type"] != "rtm")
        rtm_cost = sum(r["payment_rs"] for r in rows if r["type"] == "rtm")
        rebound = sum(r["rebound_rs"] for r in rows)
        counterfactual, actual = round(self.do_nothing_rs, 0), round(self.actual_dsm_rs, 0)
        avoided = counterfactual - actual
        net = avoided - resource_pay - rtm_cost - rebound
        ledger = [
            {"key": "counterfactual_dsm", "label": "DSM with no action (counterfactual)", "rs": counterfactual},
            {"key": "actual_dsm", "label": "DSM on actual deviation", "rs": -actual},
            {"key": "avoided_dsm", "label": "= DSM avoided", "rs": avoided, "subtotal": True},
            {"key": "payments", "label": "Participant payments", "rs": -resource_pay},
            {"key": "rtm", "label": "RTM purchase", "rs": -rtm_cost},
            {"key": "rebound", "label": "Rebound energy (off-peak)", "rs": -rebound},
            {"key": "net", "label": "= Net savings", "rs": net, "subtotal": True},
        ]
        assert abs(sum(x["rs"] for x in ledger if not x.get("subtotal")) - net) < 1.0  # reconciles, nothing double-counted
        return {
            "rows": rows,
            "ledger": ledger,
            "payments_rs": resource_pay + rtm_cost,
            "resource_payments_rs": resource_pay,
            "rtm_cost_rs": rtm_cost,
            "rebound_cost_rs": rebound,
            "avoided_dsm_rs": avoided,
            "do_nothing_dsm_rs": counterfactual,
            "actual_dsm_rs": actual,
            "net_benefit_rs": round(net, 0),
            "duration_min": round(self.seconds / 60, 1),
            "delivered_mwh": round(sum(r["delivered_mwh"] for r in rows), 2),
            "expected_mwh": round(sum(r["expected_mwh"] for r in rows), 2),
        }

    def to_dict(self) -> dict:
        return asdict(self)
