"""Estimated grid state for one instant + IEGC assessment (ACE, severity, requirement)."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .dsm import DsmResult, Prices, dsm_charge
from .network import FlowResult
from .topology import topology


@dataclass
class GridState:
    ts: float
    frequency: float
    demand_mw: float
    schedule_mw: float
    drawal_mw: float
    state_gen_mw: float
    central_gen_mw: float
    re_mw: float
    gen_by_type: dict[str, float]
    gen_output: dict[str, float]
    bus_load: dict[str, float]
    prices: Prices
    outaged: tuple[str, ...]
    flow: FlowResult
    confidence: float
    quality: dict[str, str] = field(default_factory=dict)
    # asset id → {"mw": delivered response, "soc": .., "heartbeat_age_s": .., "available": ..}
    asset_state: dict[str, dict] = field(default_factory=dict)

    @property
    def deviation_mw(self) -> float:
        return self.drawal_mw - self.schedule_mw


@dataclass
class Ace:
    Ia: float
    Is: float
    bf: float
    fa: float
    fs: float
    freq_term: float
    ace: float


def compute_ace(s: GridState, offset: float = 0.0) -> Ace:
    """IEGC: ACE = (Ia − Is) − 10·Bf·(Fa − Fs) + Offset. Negative ⇒ the state is short."""
    bf = topology().meta["freqBiasMWPer0_1Hz"]
    Ia, Is = -s.drawal_mw, -s.schedule_mw
    freq_term = -10 * bf * (s.frequency - 50.0)
    return Ace(Ia, Is, bf, s.frequency, 50.0, freq_term, Ia - Is + freq_term + offset)


def classify(frequency: float, ace: float) -> str:
    if frequency < 49.8 or abs(ace) > 1500:
        return "EMERGENCY"
    if frequency < 49.9 or frequency > 50.05 or abs(ace) >= 100:
        return "ALERT"
    return "NORMAL"


def p90_margin(demand: float, re: float) -> float:
    return 1.28 * math.sqrt((0.005 * demand) ** 2 + (0.06 * re) ** 2)


@dataclass
class Assessment:
    state: GridState
    ace: Ace
    severity: str
    direction: str  # UP = needs more supply / less load; DOWN = absorb surplus
    requirement_mw: float
    margin_mw: float
    dsm: DsmResult
    dsm_cfg: dict | None = None  # the rule table in force — every later DSM calculation uses the same one

    @property
    def deviation_mw(self) -> float:
        return self.state.deviation_mw


def assess(s: GridState, dsm_cfg: dict | None = None) -> Assessment:
    ace = compute_ace(s)
    return Assessment(
        state=s,
        ace=ace,
        severity=classify(s.frequency, ace.ace),
        direction="UP" if ace.ace <= 0 else "DOWN",
        requirement_mw=abs(ace.ace),
        margin_mw=p90_margin(s.demand_mw, s.re_mw),
        dsm=dsm_charge(s.deviation_mw, s.schedule_mw, s.frequency, s.prices, dsm_cfg),
        dsm_cfg=dsm_cfg,
    )
