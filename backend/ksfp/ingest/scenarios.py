"""Scripted drill scenarios for the field simulator.

Each scenario is a timed sequence of disturbances, the kind of composite event an SLDC rehearses in operator training
(CEA Grid Standards 2010 and IEGC 2023 both expect periodic mock drills). Steps start `at_min` simulated minutes after
the scenario is launched, so a single launch exercises detection, decision and settlement end-to-end.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Step:
    at_min: float
    kind: str
    params: dict
    duration_min: float
    ramp_min: float
    label: str


@dataclass(frozen=True)
class Scenario:
    id: str
    title: str
    summary: str
    exercises: str
    steps: tuple[Step, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "summary": self.summary,
            "exercises": self.exercises,
            "span_min": max((s.at_min + s.duration_min for s in self.steps), default=0),
            "steps": [s.__dict__ for s in self.steps],
        }


SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        "evening_peak",
        "Evening peak with solar ramp-down",
        "Bengaluru demand climbs while solar falls away; an RTM price spike follows.",
        "Over-drawal against schedule, DSM exposure, DR dispatch before load rotation",
        (
            Step(0, "demand_surge", {"mw": 650, "region": "BENGALURU"}, 75, 12, "Evening peak: Bengaluru +650 MW"),
            Step(5, "re_drop", {"mw": 900}, 60, 15, "Solar ramp-down: −900 MW RE"),
            Step(15, "price_spike", {"rtm": 12}, 40, 0, "RTM clearing price ₹12/kWh"),
        ),
    ),
    Scenario(
        "unit_trip_low_f",
        "Thermal unit trip during low frequency",
        "A Raichur unit trips while all-India frequency is already below the IEGC band.",
        "Frequency response, ACE recovery, fast BESS and DR reserves",
        (
            Step(0, "freq_event", {"delta_hz": -0.14}, 30, 1, "All-India frequency excursion −0.14 Hz"),
            Step(3, "unit_trip", {"gen": "G_RTPS", "mw": 500}, 60, 0.5, "Unit trip: RTPS −500 MW"),
        ),
    ),
    Scenario(
        "corridor_n1",
        "Corridor outage under heavy transfer",
        "The Tumakuru–Nelamangala 400 kV corridor trips while northern renewables are exporting south.",
        "N-1 security, post-contingency overloads, location-specific DR",
        (
            Step(0, "demand_surge", {"mw": 400, "region": "BENGALURU"}, 60, 8, "Bengaluru demand +400 MW"),
            Step(2, "line_trip", {"line": "L7"}, 45, 0, "Line trip: Tumakuru – Nelamangala 400 kV"),
        ),
    ),
    Scenario(
        "data_degraded",
        "SCADA and gateway degradation",
        "RTU telemetry drops at two northern substations and two BESS gateways lose comms.",
        "Data-confidence gating, state estimation, autonomy fallback to advisory",
        (
            Step(0, "telemetry_loss", {"buses": ["GUL", "BLY"]}, 35, 0, "RTU telemetry loss at GUL, BLY"),
            Step(4, "comms_loss", {"assets": ["A_PBESS", "A_HBESS"]}, 40, 0, "Gateway comms loss: A_PBESS, A_HBESS"),
            Step(8, "demand_surge", {"mw": 350, "region": "NORTH"}, 40, 6, "North demand +350 MW"),
        ),
    ),
    Scenario(
        "monsoon_wind_lull",
        "Monsoon wind lull",
        "Wind output across Chitradurga and Gadag collapses over half an hour, with a coal unit on forced outage.",
        "Day-ahead forecast error handling, intra-day DR, load rotation as last resort",
        (
            Step(0, "re_drop", {"mw": 1100}, 90, 25, "Wind lull: −1 100 MW RE"),
            Step(20, "unit_trip", {"gen": "G_BTPS", "mw": 400}, 70, 0.5, "Unit trip: BTPS −400 MW"),
        ),
    ),
)

BY_ID = {s.id: s for s in SCENARIOS}
