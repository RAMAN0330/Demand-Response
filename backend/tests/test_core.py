"""Core engine tests: grid physics, DSM, LP, twin, policy, alarms, audit, KPTCL parsing, closed loop."""

from pathlib import Path

from ksfp.act.cmdauth import CommandVerifier, envelope
from ksfp.act.dispatch import CommandManager
from ksfp.audit.log import AuditLog
from ksfp.core.clock import Clock
from ksfp.decide.engine import DecisionEngine
from ksfp.decide.flexibility import evaluate
from ksfp.decide.optimizer import optimize
from ksfp.decide.policy import AutonomyPolicy
from ksfp.decide.twin import simulate
from ksfp.detect.alarms import AlarmManager, Condition
from ksfp.grid.dsm import Prices, dsm_charge, normal_rate
from ksfp.grid.network import solve
from ksfp.grid.state import assess
from ksfp.grid.topology import topology
from ksfp.ingest.estimator import estimate
from ksfp.ingest.field import Disturbance, SimulatedField
from ksfp.ingest.kptcl import KptclSource
from ksfp.ingest.quality import QualityLayer

FIX = Path(__file__).parent / "fixtures"


def base_injection(demand=17200.0):
    t = topology()
    share = sum(b["loadShare"] for b in t.internal)
    inj = {b["id"]: -demand * b["loadShare"] / share for b in t.internal}
    for g in t.generators:
        inj[g["bus"]] += g["baseMW"]
    return inj


def run_field(disturbances=(), seconds=180, start="15:00", step=5):
    c = Clock(1, start)
    f = SimulatedField(c, auto_disturbances=False)
    q = QualityLayer()
    t0 = c.now()
    for d in disturbances:
        d.start = t0 + d.start  # start is an offset (s) from the beginning of the run
        f.add(d)
    s = None
    for i in range(0, seconds, step):
        now = t0 + i
        f.step(now)
        s = estimate(q.process(f.read(now), now), now, q)
    return f, q, s


# ------------------------------------------------------------------ grid & DSM
def test_dsm_normal_rate_and_energy_basis():
    p = Prices(5.4, 7.2, 8.1)
    nr = normal_rate(p)
    assert nr.nr == 7.2 and nr.binding == "B"
    r = dsm_charge(22, 500, 49.95, Prices(5, 5, 5))
    assert abs(r.energy_mwh - 5.5) < 1e-9
    assert abs(r.amount_rs - 27500) < 1e-6  # 5.5 MWh × 1000 × ₹5 × 1.0


def test_power_flow_balanced_and_islanding_detected():
    r = solve(base_injection())
    assert abs(sum(v for k, v in r.injections.items() if k.startswith("X_")) - 5500) < 1  # ties carry net import
    r2 = solve(base_injection(), ("L4", "L40"))
    assert set(r2.islanded) == {"KOL", "X_TAL"}


def test_base_case_balanced_and_disturbance_alerts():
    _, _, s = run_field()
    a = assess(s)
    assert a.severity == "NORMAL" and abs(a.ace.ace) < 100
    _, _, s2 = run_field([Disturbance("re_drop", {"mw": 900}, 0, 3600, 30)], 300)
    a2 = assess(s2)
    assert a2.direction == "UP" and a2.requirement_mw > 500


def test_quality_layer_flags_stale_and_degrades_confidence():
    _, _, s = run_field([Disturbance("telemetry_loss", {"buses": ["NEL", "SOM"]}, 60, 3600, 0)], 300)
    assert s.quality.get("bus.NEL.load") == "STALE"
    assert s.confidence < 0.95


# ------------------------------------------------------------------ optimizer, twin, policy
def _assess_event():
    _, _, s = run_field([Disturbance("re_drop", {"mw": 800}, 0, 3600, 30), Disturbance("line_trip", {"line": "L4"}, 0, 3600, 0)], 120)
    a = assess(s)
    evals = [evaluate(x, a, 4, x["reliability"]) for x in topology().assets]
    return a, evals


def test_lp_covers_requirement_without_overcorrection():
    a, evals = _assess_event()
    p = optimize(a, evals, a.requirement_mw)
    assert p.solver["status"] == 0
    assert 95 <= p.coverage_pct <= 110
    assert p.costs["savings_rs"] > 0
    for al in p.allocations:  # respects availability
        e = next(x for x in evals if x.id == al.asset_id) if al.asset_id != "RTM" else None
        if e:
            assert max(al.mw_by_block) <= e.available_mw + 1e-6


def test_lp_does_not_worsen_lines_within_limits():
    a, evals = _assess_event()
    base = a.state.flow.loading
    p = optimize(a, evals, a.requirement_mw)
    for lid, v in p.loading_after.items():
        if base[lid] <= 1.0:
            assert v <= 1.0 + 1e-3, lid


def test_twin_removes_asset_with_lost_heartbeat():
    _, _, s = run_field([Disturbance("re_drop", {"mw": 800}, 0, 3600, 30), Disturbance("comms_loss", {"assets": ["A_HAG"]}, 0, 3600, 0)], 300)
    a = assess(s)
    evals = [evaluate(x, a, 4, x["reliability"]) for x in topology().assets]
    p = optimize(a, evals, a.requirement_mw)
    assert any(al.asset_id == "A_HAG" for al in p.allocations)
    tw = simulate(p, a, evals, {})
    assert "A_HAG" in tw.exclude and not tw.ok


def test_policy_envelope_and_degradation():
    pol = AutonomyPolicy(level=2)
    allocs = [{"id": "A_PBESS", "type": "bess", "mw": 90}, {"id": "A_HAG", "type": "shiftable", "mw": 100}]
    c = pol.classify(allocs, "ALERT", 0.99, True)
    assert c["auto"] == ["A_PBESS"] and c["approval"] == ["A_HAG"]
    c2 = pol.classify(allocs, "ALERT", 0.5, True)  # low data confidence → advisory
    assert c2["auto"] == [] and c2["level"] == 1
    pol.suspended = True
    assert pol.classify(allocs, "ALERT", 0.99, True)["auto"] == []


# ------------------------------------------------------------------ alarms & audit
def test_alarm_on_delay_and_incident_correlation():
    am = AlarmManager()
    c1 = Condition("ACE:STATE", "ACE", "BALANCE", 2, "ACE -400", "", on_delay=30)
    assert am.evaluate([c1], 0) == []
    raised = am.evaluate([c1], 31)
    assert len(raised) == 1
    c2 = Condition("FREQ:LOW", "FREQ_LOW", "BALANCE", 2, "f low", "", on_delay=0)
    am.evaluate([c1, c2], 40)
    incs = [i for i in am.incidents.values() if i.open]
    assert len(incs) == 1 and len(incs[0].alarm_ids) == 2
    am.evaluate([], 200)  # condition false → off-delay starts
    am.evaluate([], 261)
    assert all(a.state == "CLEARED" for a in am.alarms.values())


def test_audit_chain_detects_tampering():
    log = AuditLog()
    for i in range(5):
        log.append(float(i), "EVENT", "test", f"entry {i}")
    rows = [e.to_dict() for e in log.entries]
    assert AuditLog.verify(rows)["ok"]
    rows[2]["message"] = "tampered"
    v = AuditLog.verify(rows)
    assert not v["ok"] and v["broken_at"] == 3


# ------------------------------------------------------------------ KPTCL adapter
def test_kptcl_parser_maps_all_discoms_and_generation():
    k = KptclSource()
    for url, st in k.status.items():
        if st.kind == "load" and "bescom" in url:
            k.ingest_html(st, (FIX / "discom_sample.html").read_text(), 0)
        if st.kind == "gen":
            k.ingest_html(st, (FIX / "stategen_sample.html").read_text(), 0)
    v = k.values
    assert v["ch.load.LD_PEENYA"] == 312.5
    for ch in ("LD_KAVOOR__MANGALURU", "LD_BELAGAVI", "LD_KALABURAGI", "LD_KADAKOLA__MYSURU"):  # MESCOM/HESCOM/GESCOM/CESC tables
        assert f"ch.load.{ch}" in v
    assert v["ch.gen.GS_RAICHUR_TPS"] == 1240.0  # actual generation, not installed capacity
    assert k.system["sys.frequency"] == 49.97
    assert any(u["label"] == "New Station XYZ" for u in k.unmapped.values())
    assert "ch.load.TOTAL" not in v


# ------------------------------------------------------------------ closed loop
def test_closed_loop_supervised_autonomy_resolves_event():
    c = Clock(1, "14:58")
    f = SimulatedField(c, auto_disturbances=False)
    q = QualityLayer()
    cm = CommandManager("k")
    f.verifier = CommandVerifier({"k1": b"k"})  # gateway checks every command's HMAC, freshness and replay
    eng = DecisionEngine(cm, AutonomyPolicy(level=3), {a["id"]: a["reliability"] for a in topology().assets})
    t0 = c.now()
    f.add(Disturbance("re_drop", {"mw": 700}, t0 + 60, 45 * 60, 240))
    worst = 0.0
    for i in range(0, 110 * 60, 20):
        now = t0 + i
        f.step(now)
        s = estimate(q.process(f.read(now), now), now, q)
        a = assess(s)
        eng.step(a, now, None, None)
        cm.tick(now, f, s.asset_state)
        if 20 * 60 < i < 45 * 60:
            worst = max(worst, abs(a.ace.ace))
    d = list(eng.decisions.values())[0]
    assert worst < 400  # autonomy held ACE well below the ~700 MW disturbance
    assert d.state == "COMPLETED" and d.settlement and d.settlement["avoided_dsm_rs"] > 0
    # event performance curve is recorded for the DR Events view
    assert len(d.timeline) > 10 and max(p["delivered"] for p in d.timeline) > 100
    assert all(p["target"] >= 0 for p in d.timeline)


async def test_flush_keeps_audit_entries_appended_during_write(tmp_path):
    """Regression: entries appended by the state-loop thread while a flush awaits the DB must not be dropped."""
    import asyncio

    from ksfp.audit.log import AuditLog
    from ksfp.core.settings import Settings
    from ksfp.runtime import Runtime

    r = Runtime(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'a.db'}", jwt_secret="t", auto_disturbances=False))
    await r.store.init()
    real = r.store.flush

    async def slow_flush(*a):
        await asyncio.sleep(0)
        r.audit.append(1.0, "SYSTEM", "test", "appended during write")  # what the tick thread does mid-flush
        await real(*a)

    r.store.flush = slow_flush
    for i in range(3):
        r.audit.append(float(i), "SYSTEM", "test", f"entry {i}")
    await r._flush()
    r.store.flush = real
    await r._flush()
    rows = await r.store.audit_all()
    assert [e["seq"] for e in rows] == list(range(1, len(rows) + 1)) and len(rows) == 4
    assert AuditLog.verify(rows)["ok"]
    await r.store.engine.dispose()


# ------------------------------------------------------------------ BESS energy convention
def test_bess_energy_limit_counts_discharge_efficiency_once():
    """Stored energy E above the floor can deliver E·ηd; the plan must reach that, not E·ηd²."""
    from ksfp.decide.optimizer import BLOCK_H

    _, _, s = run_field([Disturbance("re_drop", {"mw": 1200}, 0, 3600, 30)], 300)
    t = topology()
    spec = t.asset("A_PBESS")
    bs = spec["bess"]
    soc0 = 0.2
    s.asset_state.setdefault("A_PBESS", {})["soc"] = soc0
    a = assess(s)
    assert a.direction == "UP"
    evals = [evaluate(x, a, 4, 0.99) for x in t.assets]
    plan = optimize(a, evals, 2000.0, 4, "BESS")
    al = next(x for x in plan.allocations if x.asset_id == "A_PBESS")
    stored = (soc0 - bs["socMin"]) * bs["energyMWh"]
    delivered = sum(al.mw_by_block) * BLOCK_H
    assert delivered <= stored * bs["etaD"] + 0.1
    assert delivered >= stored * bs["etaD"] - 0.6  # energy-limited: uses what is really there
    # the twin's minute-by-minute SoC must stay at or above the floor over consecutive blocks
    tw = simulate(plan, a, evals, {})
    assert min(tw.soc["A_PBESS"]) >= bs["socMin"] - 2e-3


# ------------------------------------------------------------------ command authentication
def test_command_hmac_rejects_tamper_wrong_key_stale_and_replay():
    key, now = b"secret-key", 1_000_000.0
    env = envelope(key, "k1", "CMD-1", "DC-1", "A_PBESS", 42.5, "DISPATCH", now)
    assert len(env["mac"]) == 64  # full 256-bit tag, not truncated
    v = CommandVerifier({"k1": key})
    assert v.verify(env, "CMD-1", "DC-1", "A_PBESS", 42.5, "DISPATCH", now + 2) == (True, "ok")
    assert v.verify(env, "CMD-1", "DC-1", "A_PBESS", 42.5, "DISPATCH", now + 3)[1] == "replayed command id"
    fresh = CommandVerifier({"k1": key})
    assert not fresh.verify(env, "CMD-1", "DC-1", "A_PBESS", 99.0, "DISPATCH", now)[0]  # setpoint tampered
    assert not fresh.verify(env, "CMD-1", "DC-1", "A_OTHER", 42.5, "DISPATCH", now)[0]  # asset tampered
    assert not CommandVerifier({"k1": b"other"}).verify(env, "CMD-1", "DC-1", "A_PBESS", 42.5, "DISPATCH", now)[0]
    assert not CommandVerifier({"k2": key}).verify(env, "CMD-1", "DC-1", "A_PBESS", 42.5, "DISPATCH", now)[0]
    assert "stale" in CommandVerifier({"k1": key}).verify(env, "CMD-1", "DC-1", "A_PBESS", 42.5, "DISPATCH", now + 120)[1]
    assert "future" in CommandVerifier({"k1": key}).verify(env, "CMD-1", "DC-1", "A_PBESS", 42.5, "DISPATCH", now - 60)[1]
    assert not CommandVerifier({"k1": key}).verify(None, "CMD-1", "DC-1", "A_PBESS", 42.5, "DISPATCH", now)[0]


def test_gateway_refuses_commands_signed_with_the_wrong_key():
    c = Clock(1, "14:58")
    f = SimulatedField(c, auto_disturbances=False)
    f.verifier = CommandVerifier({"k1": b"gateway-key"})
    cm = CommandManager("control-centre-key-that-does-not-match")
    now = c.now()
    cmd = cm.create("DC-T", "A_PBESS", 20.0, 19.0, False, now)
    cm.tick(now, f, {})
    assert cmd.state == "SENT" and len(cmd.signature) == 64
    assert f.rejected and f.rejected[-1]["reason"] == "authentication tag mismatch"
    for i in range(1, 12):
        f.step(now + i * 10)
        cm.tick(now + i * 10, f, {})
    assert cmd.state == "FAILED"  # never acked: the asset did not act on it


# ------------------------------------------------------------------ one cost model end to end
def test_cost_model_is_coherent_from_ranking_to_settlement():
    from ksfp.act.settlement import Meter
    from ksfp.decide.optimizer import BLOCK_H

    _, _, s = run_field([Disturbance("re_drop", {"mw": 900}, 0, 3600, 30)], 300)
    a = assess(s)
    t = topology()
    evals = [evaluate(x, a, 4, x["reliability"]) for x in t.assets]
    for e in evals:
        assert abs(e.effective_cost - (e.pay_rs + e.rebound_rs)) < 1e-9  # no reliability mark-up
    plan = optimize(a, evals, a.requirement_mw, 4, "OPTIMAL")
    by_id = {e.id: e for e in evals}
    rebound = 0.0
    for al in plan.allocations:
        if al.type == "rtm":
            continue
        e = by_id[al.asset_id]
        assert al.rate_rs == e.pay_rs and al.effective_cost == e.effective_cost
        # plan payment = expected delivered energy × the pay rate (rebound is not inside it)
        assert abs(al.cost_rs - sum(al.expected_by_block) * BLOCK_H * 1000 * e.pay_rs) < 1.0
        rebound += t.asset(al.asset_id)["reboundFrac"] * sum(al.expected_by_block) * BLOCK_H * 1000 * a.state.prices.off_peak
    assert abs(plan.costs["rebound_rs"] - rebound) < 1.0  # costed once, separately
    # settlement pays the same rate for metered delivery
    al = next(x for x in plan.allocations if x.type != "rtm")
    m = Meter(delivered_mwh={al.asset_id: 2.0}, expected_mwh={al.asset_id: 2.0})
    row = m.settle({}, {al.asset_id: al.rate_rs})["rows"][0]
    assert row["rate_rs"] == al.rate_rs and abs(row["payment_rs"] - 2.0 * 1000 * al.rate_rs) < 1.0


# ------------------------------------------------------------------ within-block response
def test_slow_responder_is_credited_only_for_what_it_delivers_inside_the_block():
    from ksfp.decide.flexibility import delivery_factors

    # 12-min response, instant ramp: only the last 3 of 15 minutes of block 1 → 20 %, then full blocks
    assert delivery_factors(12, 1e6, 50, 3) == [0.2, 1.0, 1.0]
    # same delay with a 5-min ramp to setpoint
    f = delivery_factors(12, 10, 50, 2)
    # block 1: ramp 0→60 % over minutes 12–15 → 0.9 MWmin-equivalent of 15; block 2: rest of ramp (2.5 − 0.9) + 13 full minutes
    assert abs(f[0] - (3**2 / (2 * 5)) / 15) < 1e-3 and abs(f[1] - (2.5 - 0.9 + 13) / 15) < 1e-3
    assert delivery_factors(30, 100, 50, 3)[:2] == [0.0, 0.0]  # 30-min response: nothing in blocks 1–2
    assert delivery_factors(12, 1, 50, 2, active=True) == [1.0, 1.0]  # already at setpoint

    # in the plan, expected block-1 energy reflects the factor, so residual DSM is not understated
    _, _, s = run_field([Disturbance("re_drop", {"mw": 900}, 0, 3600, 30)], 300)
    a = assess(s)
    evals = [evaluate(x, a, 4, x["reliability"]) for x in topology().assets]
    plan = optimize(a, evals, a.requirement_mw, 4, "OPTIMAL")
    ev = {e.id: e for e in evals}
    for al in plan.allocations:
        if al.type == "rtm":
            continue
        phi = ev[al.asset_id].factors
        for b in range(4):
            assert abs(al.expected_by_block[b] - al.mw_by_block[b] * al.reliability * phi[b]) < 0.05


# ------------------------------------------------------------------ data freshness & hard vetoes
def test_redelivered_web_value_ages_from_its_fetch_time():
    q = QualityLayer()
    fetched = 1_000_000.0
    key = "ch.load.TEST"
    assert q.process({key: 120.0}, fetched, {key: fetched})[key][1] == "GOOD"
    # the platform keeps re-reading the same 5-minute poll result every second: it must not look fresh
    assert q.process({key: 120.0}, fetched + 9, {key: fetched})[key][1] == "GOOD"
    assert q.process({key: 120.0}, fetched + 30, {key: fetched})[key][1] == "SUBSTITUTED"
    assert q.process({key: 120.0}, fetched + 300, {key: fetched})[key][1] == "STALE"
    assert abs(q.age(key, fetched + 300) - 300) < 1e-9
    # a new poll resets the age
    assert q.process({key: 125.0}, fetched + 301, {key: fetched + 300})[key][1] == "GOOD"


def test_hard_vetoes_force_advisory_whatever_the_confidence_score():
    p = AutonomyPolicy(level=3)
    allocs = [{"id": "A_PBESS", "type": "bess", "mw": 40.0}, {"id": "A_GBESS", "type": "bess", "mw": 30.0}]
    assert p.classify(allocs, "ALERT", 1.0, True)["approval"] == []  # L3, healthy → all automatic
    p.asset_vetoes = {"A_GBESS": "state-of-charge telemetry stale"}
    r = p.classify(allocs, "ALERT", 1.0, True)
    assert r["auto"] == ["A_PBESS"] and r["approval"] == ["A_GBESS"]  # only the vetoed asset needs a human
    p.vetoes = ["Frequency measurement not fresh (stale, 45 s old) — automatic control blocked"]
    lvl, reasons = p.effective(confidence=1.0)
    assert lvl == 1 and reasons == p.vetoes
    assert p.classify(allocs, "ALERT", 1.0, True)["auto"] == []
    assert "vetoes" not in p.to_dict()  # runtime state, never persisted as policy


# ------------------------------------------------------------------ DSM tiers (structure; numbers illustrative)
def test_dsm_tiers_boundaries_and_worked_example():
    import pytest

    from ksfp.grid.dsm import DEFAULT_DSM, band_edges, normalise

    p = Prices(5.4, 7.2, 8.1)  # NR = 7.20
    # large state: band edges min(10 %, 100) = 100, min(15 %, 200) = 200, then open
    assert band_edges(5300, DEFAULT_DSM)[:2] == [100.0, 200.0]
    # small schedule: the percentage binds — 10 % of 600 = 60, 15 % = 90
    assert band_edges(600, DEFAULT_DSM)[:2] == [60.0, 90.0]
    # exactly on the first edge: all in band 1
    r = dsm_charge(100.0, 5300, 49.95, p)
    assert r.within_mw == 100.0 and r.beyond_mw == 0.0 and abs(r.amount_rs - 100 * 250 * 1.0 * 7.2) < 1e-6
    # just past it: the next MW is priced at band 2
    r = dsm_charge(101.0, 5300, 49.95, p)
    assert abs(r.amount_rs - (100 * 1.0 + 1 * 1.5) * 250 * 7.2) < 1e-6 and r.marginal_rate == 1.5 * 7.2
    # the review's example: 350 MW over at 49.95 Hz splits 100 / 100 / 150 across three bands
    r = dsm_charge(350.0, 5300, 49.95, p)
    assert [round(x["mw"]) for x in r.slices] == [100, 100, 150]
    assert abs(r.amount_rs - (100 * 1.0 + 100 * 1.5 + 150 * 2.0) * 250 * 7.2) < 1e-6  # ₹9,90,000 (illustrative)
    assert r.marginal_rate == 2.0 * 7.2
    # under-drawal is a receivable (negative) and tiers too
    r = dsm_charge(-150.0, 5300, 49.95, p)
    assert r.amount_rs < 0 and abs(r.amount_rs + 100 * 0.9 * 250 * 7.2) < 1e-6  # band 2 under-drawal earns 0 here
    # low frequency raises over-drawal multipliers
    assert dsm_charge(50.0, 5300, 49.85, p).amount_rs > dsm_charge(50.0, 5300, 49.95, p).amount_rs
    # schema-1 tables still load as two bands; inconsistent tables are refused
    v1 = {"freq_low": 49.9, "freq_high": 50.05, "band_pct": 10, "band_cap_mw": 100, "overdrawal": {"LOW": [1.5, 2], "NORMAL": [1, 1.5], "HIGH": [0.5, 1]}, "underdrawal": {"LOW": [1, 0.5], "NORMAL": [0.9, 0], "HIGH": [0, 0]}}
    assert len(normalise(v1)["bands"]) == 2
    assert abs(dsm_charge(350.0, 5300, 49.95, p, v1).amount_rs - (100 * 1.0 + 250 * 1.5) * 250 * 7.2) < 1e-6
    bad = dict(DEFAULT_DSM, overdrawal={"LOW": [1, 2], "NORMAL": [1, 2], "HIGH": [1, 2]})
    with pytest.raises(ValueError):
        normalise(bad)


def test_settlement_ledger_reconciles():
    from ksfp.act.settlement import Meter

    m = Meter(delivered_mwh={"A_HSKT": 4.0, "RTM": 2.0}, expected_mwh={"A_HSKT": 5.0, "RTM": 2.0})
    m.do_nothing_rs, m.actual_dsm_rs = 300_000.0, 120_000.0
    s = m.settle({}, {"A_HSKT": 2.0, "RTM": 7.25}, prices_off_peak=3.2)
    pf = (0.8 - 0.5) / 0.4
    assert s["resource_payments_rs"] == round(4.0 * 1000 * 2.0 * pf)
    assert s["rtm_cost_rs"] == round(2.0 * 1000 * 7.25)
    assert s["rebound_cost_rs"] == round(4.0 * topology().asset("A_HSKT")["reboundFrac"] * 1000 * 3.2)
    assert s["avoided_dsm_rs"] == 180_000.0
    assert s["net_benefit_rs"] == round(180_000 - s["resource_payments_rs"] - s["rtm_cost_rs"] - s["rebound_cost_rs"])
    lines = {x["key"]: x["rs"] for x in s["ledger"]}
    assert lines["counterfactual_dsm"] + lines["actual_dsm"] + lines["payments"] + lines["rtm"] + lines["rebound"] == s["net_benefit_rs"]
