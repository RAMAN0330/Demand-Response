"""GridFlex: industrial offers gate dispatch, baseline M&V arithmetic, fair rotation ordering."""

from ksfp.core.clock import BLOCK_S, Clock
from ksfp.decide.shedding import RosterManager
from ksfp.gridflex.industrial import IndustrialRegistry
from ksfp.grid.topology import topology


def _ist(now: float, hhmm: str) -> float:
    """A timestamp on the same IST day as `now` at hh:mm."""
    h, m = map(int, hhmm.split(":"))
    day = (now + 19800) // 86400 * 86400 - 19800
    return day + h * 3600 + m * 60


def test_industry_is_usable_only_inside_an_accepted_offer_and_on_its_terms():
    reg = IndustrialRegistry()
    now = Clock(1, "15:00").now()
    pid = "A_JSW"
    a = topology().asset(pid)
    _, why = reg.terms(a, now)
    assert why == "No accepted offer covering this time window"
    o = reg.submit(pid, now, mw=40.0, window=("14:00", "18:00"), response_min=20, min_activation_min=30, max_duration_min=60,
                   recovery_min=90, price_rs_mwh=5200, availability_rs_mw_h=0, reliability=0.9, restrictions="", kind="voluntary")
    assert reg.terms(a, now)[1] == "Offer awaiting acceptance"
    reg.decide(o.id, "ACCEPTED", "sic", now)
    t, why = reg.terms(a, now)
    assert why is None and t["contractMW"] == 40.0 and t["bidRs"] == 5.2 and t["responseMin"] == 20 and t["maxDurationMin"] == 60
    assert reg.terms(a, _ist(now, "19:00"))[1] is not None  # outside the window again
    # an offer beyond the declared flexible range is refused
    try:
        reg.submit(pid, now, mw=5000, window=("14:00", "18:00"), response_min=20, min_activation_min=30, max_duration_min=60,
                   recovery_min=90, price_rs_mwh=5200, availability_rs_mw_h=0, reliability=0.9, restrictions="", kind="voluntary")
        raise AssertionError("oversized offer accepted")
    except ValueError:
        pass


def test_mv_baseline_verified_reduction_and_payment():
    reg = IndustrialRegistry()
    pid = "A_JSW"
    start = Clock(1, "15:00").now()
    start = start - start % BLOCK_S + BLOCK_S  # event starts on a block boundary
    o = reg.submit(pid, start - 3600, mw=60.0, window=("00:00", "23:59"), response_min=10, min_activation_min=30, max_duration_min=120,
                   recovery_min=60, price_rs_mwh=4000, availability_rs_mw_h=100, reliability=0.9, restrictions="", kind="committed")
    reg.decide(o.id, "ACCEPTED", "programme", start - 3600)
    for i in range(60):  # an hour of pre-event metering at 600 MW
        reg.record_meter(start - 3600 + i * 60, {pid: 600.0})
    assert abs(reg.baseline(pid, start) - 600.0) < 1e-6
    # block 1: accepted 60 MW, metered 560 → R 40, V 40; block 2: metered 530 → R 70, capped at A = 60
    for blk, metered in ((0, 560.0), (1, 530.0)):
        for i in range(15):
            ts = start + blk * BLOCK_S + i * 60
            reg.record_meter(ts, {pid: metered})
            reg.tick("DC-T", {pid: 60.0}, ts, 60.0)
    s = reg.settle("DC-T", start + 2 * BLOCK_S)[pid]
    rec = reg.mv[("DC-T", pid)]
    assert [b["V"] for b in rec.blocks] == [40.0, 60.0]
    assert abs(rec.energy_mwh - (40 + 60) * 0.25) < 1e-6  # E = ΣV·Δt = 25 MWh
    assert abs(rec.accepted_mwh - 30.0) < 1e-6
    perf = 25 / 30  # 83 % → performance factor (0.833 − 0.5)/0.4
    pf = (perf - 0.5) / 0.4
    energy_pay = 25 * 4000
    assert abs(s["payment_rs"] - round(energy_pay + 100 * 60 * 0.5 - energy_pay * (1 - pf))) <= 1
    reg.dispute("DC-T", pid, "baseline contested")
    assert reg.mv[("DC-T", pid)].status == "DISPUTED"
    reg.resolve("DC-T", pid, "baseline upheld", 0.0)
    assert reg.mv[("DC-T", pid)].status == "SETTLED"


def test_fair_rotation_prefers_the_least_burdened_group_and_explains_why():
    ro = RosterManager()
    now = Clock(1, "15:00").now()
    load = {}
    for g in ro.groups.values():
        for b in g.bus_frac:
            load[b] = 1000.0
    bescom = [g for g in ro.groups.values() if g.discom == "BESCOM"]
    a, b = bescom[0], bescom[1]
    a.history = [[now - 3 * 86400, now - 3 * 86400 + 2700], [now - 86400, now - 86400 + 2700]]  # two recent spells
    f = ro.fairness(now)
    assert f[a.id]["F"] > f[b.id]["F"] and f[a.id]["N"] == 2 and abs(f[a.id]["H_h"] - 1.5) < 1e-6
    o = ro.propose(150, "test", "auto", now)
    picked = ro.select(150, load, now, order=o)
    assert a not in picked  # the burdened group waits
    assert any(s["action"] == "picked" and "lowest burden" in s["reason"] for s in o.selection)
    # a group at its daily limit is excluded with a reason
    b.minutes_today = ro.policy.max_daily_min
    ro.select(150, load, now, order=o)
    assert any(s["group"] == b.id and s["action"] == "excluded" and "daily limit" in s["reason"] for s in o.selection)
