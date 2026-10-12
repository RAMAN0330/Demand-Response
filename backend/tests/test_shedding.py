"""Emergency load management: rostering covers only what flexibility cannot, rotates fairly, and restores in stages."""

from ksfp.act.dispatch import CommandManager
from ksfp.core.clock import Clock
from ksfp.decide.engine import DecisionEngine
from ksfp.decide.policy import AutonomyPolicy
from ksfp.decide.shedding import RosterManager, build_groups
from ksfp.grid.state import assess
from ksfp.grid.topology import topology
from ksfp.ingest.estimator import estimate
from ksfp.ingest.field import Disturbance, SimulatedField
from ksfp.ingest.quality import QualityLayer


def test_roster_groups_cover_every_220kv_station_once():
    groups = build_groups()
    stations = [c for g in groups for c in g.channels]
    assert len(stations) == len(set(stations)) == 90
    assert len([g for g in groups if g.discom == "BESCOM"]) == 9  # 33 stations → blocks of ~4
    assert all(len(g.channels) <= 4 for g in groups)
    assert all(sum(g.protected.values()) >= 1 for g in groups)  # every group carries protected (never-shed) feeders


def run(surge_mw: float, minutes: int, approve_at: float | None = None, surge_min: float = 200, oos: bool = True):
    c = Clock(1, "15:00")
    f = SimulatedField(c, auto_disturbances=False)
    q = QualityLayer()
    cm = CommandManager("k")
    eng = DecisionEngine(cm, AutonomyPolicy(level=3), {a["id"]: a["reliability"] for a in topology().assets})
    if oos:  # most flexibility unavailable → a residual only shedding can cover
        eng.out_of_service = {a["id"] for a in topology().assets if a["type"] != "bess"}
    ro = RosterManager()
    t0 = c.now()
    f.add(Disturbance("demand_surge", {"mw": surge_mw}, t0 + 30, surge_min * 60, 60))
    trace = []
    for i in range(0, minutes * 60, 20):
        now = t0 + i
        f.step(now)
        s = estimate(q.process(f.read(now), now), now, q)
        a = assess(s)
        unshed = {b: v / (1 - min(0.9, f.shed_frac.get(b, 0.0))) for b, v in s.bus_load.items()}
        eng.relief_mw = ro.shed_mw(unshed)
        eng.step(a, now, None, None)
        d = eng.active()
        res = eng.rotation_residual(a, now)["residual_mw"]
        ro.step(now, s.frequency, d.direction if d else a.direction, res, unshed)
        o = ro.open_order()
        if o and o.state == "PROPOSED" and approve_at is not None and i >= approve_at * 60:
            ro.approve(o.id, "sic", "shift_in_charge", True, now, unshed)
            if o.needs_dual:
                ro.approve(o.id, "admin", "admin", True, now, unshed)
        f.shed_frac = ro.shed_fraction()
        cm.tick(now, f, s.asset_state)
        trace.append((i, s.frequency, ro.shed_mw(unshed), sum(1 for g in ro.groups.values() if g.state == "SHED")))
    return ro, trace


def test_shedding_is_proposed_but_never_acts_without_approval():
    ro, trace = run(1600, 25, approve_at=None)
    orders = list(ro.orders.values())
    assert orders and orders[0].source == "auto" and orders[0].state == "PROPOSED"
    assert all(n == 0 for *_, n in trace)  # nothing shed without a human


def test_approved_shedding_raises_frequency_rotates_and_restores():
    ro, trace = run(1600, 290, approve_at=4)
    o = list(ro.orders.values())[0]
    shed_freq = [fr for _, fr, mw, _ in trace if mw > 0]
    before = [fr for i, fr, mw, _ in trace if mw == 0 and 3 * 60 < i < 4 * 60]
    assert shed_freq and before and max(shed_freq[5:40]) > min(before)  # load off → frequency recovers
    assert o.rotations >= 1  # 45-min spells hand over to the next group
    assert all(g.minutes_today <= ro.policy.max_daily_min + 1 for g in ro.groups.values())  # daily cap respected
    assert o.state == "COMPLETED" and all(g.state == "AVAILABLE" for g in ro.groups.values())  # surge over → all back
    # restoration was staged (groups came back one at a time)
    counts = [n for *_, n in trace]
    drops = [a - b for a, b in zip(counts, counts[1:]) if a > b]
    assert drops and max(drops) <= 2


def test_no_shedding_when_flexibility_covers_the_need():
    ro, _ = run(500, 25, approve_at=0, surge_min=20, oos=False)
    assert not ro.orders


def test_trigger_follows_the_dsm_deviation_band():
    ro = RosterManager()
    ro.dsm_band_mw = 100.0  # min(10 % of schedule, 100 MW cap) for a large state
    assert ro.needs_relief(50.00, 120) and not ro.needs_relief(50.00, 90)  # beyond the band at normal frequency
    assert ro.needs_relief(49.88, 60)  # low frequency: any worthwhile residual
    assert not ro.needs_relief(49.88, 30)  # below the 50 MW minimum
    ro.policy.od_limit_mw = 250.0  # an SLDC override
    assert not ro.needs_relief(50.00, 120)
