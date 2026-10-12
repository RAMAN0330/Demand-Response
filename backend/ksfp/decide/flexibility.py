"""Flexibility engine: what each resource can *really* deliver right now, and what it costs per delivered kWh.

  F_up      = min(baseline − P_min, contracted state share (+ emergency share), technical / SoC limit)
  expected  = F × reliability (learned)           ← reliability scales the MW we can count on, nothing else
  pay rate  = ₹ the platform pays per *delivered* kWh (the same rate settlement uses)
  effective = pay rate + rebound cost             ← ₹ per delivered kWh; used for ranking, the economic
                                                     filter (vs DSM ₹/kWh), the LP objective and the display
Payment is only for delivered energy, so unreliability is not a price mark-up: it shrinks expected MW and the
optimiser buys more capacity to cover the requirement in expectation.
SRAS/TRAS portions are locked (ANCILLARY_MODE) and never dispatched here.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..grid.state import Assessment

BLOCK_H = 0.25
BLOCK_MIN = 15.0


def delivery_factors(response_min: float, ramp_mw_per_min: float, mw: float, blocks: int, active: bool = False) -> list[float]:
    """Share of a block's energy actually delivered when commanded `mw` at the start of the horizon.

    Output is 0 until the response delay d, then ramps at the ramp rate to the setpoint (τ = mw / ramp):
        g(t) = clamp((t − d) / τ, 0, 1)          φ_b = (1/15) ∫ g(t) dt over block b
    so expected energy in block b is φ_b × setpoint × 15 min. A resource already delivering is at its
    setpoint (φ = 1); re-solves each block keep that true as the event goes on.
    """
    if active:
        return [1.0] * blocks
    d = max(0.0, response_min)
    tau = mw / ramp_mw_per_min if ramp_mw_per_min > 0 else 0.0

    def G(t: float) -> float:  # ∫_0^t g
        if t <= d:
            return 0.0
        if tau <= 1e-9:
            return t - d
        if t <= d + tau:
            return (t - d) ** 2 / (2 * tau)
        return tau / 2 + (t - d - tau)

    return [round((G((b + 1) * BLOCK_MIN) - G(b * BLOCK_MIN)) / BLOCK_MIN, 4) for b in range(blocks)]


@dataclass
class FlexEval:
    asset: dict
    technical_mw: float
    contract_state_mw: float
    emergency_mw: float
    locked_mw: float
    available_mw: float
    reliability: float
    expected_mw: float
    earliest_block: int
    max_blocks: int
    factors: list[float]  # per horizon block: share of the block's energy delivered (response delay + ramp)
    bid_rs: float
    opportunity_rs: float  # informational: the participant's own cost (priced into the bid for demand-side)
    pay_rs: float  # ₹ paid per delivered kWh (negative = credit, e.g. generation backing down)
    rebound_rs: float  # ₹ per delivered kWh for energy that returns after release (bought off-peak)
    effective_cost: float  # pay_rs + rebound_rs, ₹ per delivered kWh
    energy_mwh: float | None  # BESS usable energy (UP)
    current_mw: float  # currently delivered (from telemetry)
    eligible: bool
    exclusions: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def id(self) -> str:
        return self.asset["id"]

    def to_dict(self) -> dict:
        a = self.asset
        return {
            "id": a["id"],
            "name": a["name"],
            "short": a["short"],
            "type": a["type"],
            "discom": a["discom"],
            "bus": a["bus"],
            "technical_mw": self.technical_mw,
            "available_mw": self.available_mw,
            "expected_mw": self.expected_mw,
            "reliability": self.reliability,
            "locked_mw": self.locked_mw,
            "emergency_mw": self.emergency_mw,
            "response_min": a["responseMin"],
            "delivery_factors": self.factors,
            "effective_cost": self.effective_cost,
            "pay_rs": self.pay_rs,
            "rebound_rs": self.rebound_rs,
            "current_mw": self.current_mw,
            "eligible": self.eligible,
            "exclusions": self.exclusions,
            "notes": self.notes,
        }


def evaluate(
    asset: dict,
    a: Assessment,
    duration_blocks: int,
    reliability: float,
    out_of_service: bool = False,
    active_blocks: int = 0,
    exclusion: str | None = None,
) -> FlexEval:
    s = a.state
    up = a.direction == "UP"
    live = s.asset_state.get(asset["id"], {})
    duration_h = duration_blocks * BLOCK_H
    notes: list[str] = []
    excl: list[str] = []
    bid, opp = asset["bidRs"], asset["opportunityRs"]
    pay = bid  # demand-side: the bid is the price paid; the consumer's opportunity cost is already in it
    energy = None
    current = float(live.get("mw", 0.0))
    if asset["type"] == "bess" and asset.get("bess"):
        b = asset["bess"]
        soc = live.get("soc") if live.get("soc") is not None else b["soc"]
        power = asset["maxLoadMW"]
        if up:
            energy = max(0.0, (soc - b["socMin"]) * b["energyMWh"])
            e_mw = energy * b["etaD"] / duration_h
            technical = max(0.0, min(power, e_mw + 0.0))
            if e_mw < power:
                notes.append(f"SoC-limited: {soc * 100:.0f}% → {e_mw:.0f} MW for {duration_h:g} h")
            opp = s.prices.off_peak / (b["etaC"] * b["etaD"])  # recharge energy per kWh discharged
            pay = bid + opp
        else:
            room = (b["socMax"] - soc) * b["energyMWh"] / b["etaC"] / duration_h
            technical = max(0.0, min(power, room))
            bid, opp = b["degRs"], 0.0
            pay = bid  # absorbing surplus: battery wear only
    elif asset["type"] == "generation":
        technical = asset["maxLoadMW"] - asset["baselineMW"] if up else asset["baselineMW"] - asset["minLoadMW"]
        # UP: variable cost + wear; DOWN: backing down saves ~60 % of variable cost (part-load heat rate) less wear
        pay = bid + opp if up else -0.6 * bid + opp
        if not up:
            bid = -asset["bidRs"] * 0.6
    else:
        technical = asset["baselineMW"] - asset["minLoadMW"] if up else asset["maxLoadMW"] - asset["baselineMW"]
    contract_state = min(asset["reserve"]["state"], asset["contractMW"])
    emergency = asset["reserve"]["emergency"] if a.severity == "EMERGENCY" else 0.0
    locked = asset["reserve"]["sras"] + asset["reserve"]["tras"]
    available = max(0.0, min(technical, contract_state + emergency))
    if emergency:
        notes.append(f"+{emergency:g} MW emergency share released")
    if locked:
        notes.append(f"{locked:g} MW locked to ancillary (SRAS/TRAS)")
    if out_of_service:
        excl.append("Marked out of service by operator/engineer")
    if exclusion:
        excl.append(exclusion)  # e.g. GridFlex: no accepted offer covering this window
    if available < 0.5:
        excl.append("No headroom in this direction")
    rebound = asset["reboundFrac"] * s.prices.off_peak  # each delivered kWh brings back reboundFrac kWh later
    rel = max(0.05, min(0.995, reliability))
    eff = pay + rebound
    resp = asset["responseMin"]
    factors = delivery_factors(resp, asset["rampMWpm"], max(available, 1.0), duration_blocks, active=current > 0.5)
    earliest = next((b for b, x in enumerate(factors) if x > 0.01), duration_blocks)
    max_blocks = max(1, int(asset["maxDurationMin"] // 15) - active_blocks)
    if active_blocks:
        notes.append(f"active for {active_blocks} block(s); {max_blocks} remaining")
    return FlexEval(
        asset=asset,
        technical_mw=max(0.0, technical),
        contract_state_mw=contract_state,
        emergency_mw=emergency,
        locked_mw=locked,
        available_mw=round(available, 1),
        reliability=rel,
        expected_mw=available * rel,
        earliest_block=earliest,
        max_blocks=max_blocks,
        factors=factors,
        bid_rs=bid,
        opportunity_rs=opp,
        pay_rs=pay,
        rebound_rs=rebound,
        effective_cost=eff,
        energy_mwh=energy,
        current_mw=current,
        eligible=not excl,
        exclusions=excl,
        notes=notes,
    )
