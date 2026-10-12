"""Runtime: wires the modules together and runs the continuous control loops.

  state loop (1 Hz real)  : ingest → quality → estimate → assess → detect/alarm → decide (MPC) → dispatch
  forecast (1 min sim)    : P10/P50/P90 + predicted violations
  KPTCL poller (5 min)    : all DISCOM pages + generation page concurrently → live channels + calibration
  persistence (10 s)      : write-behind of audit, documents, 1-minute aggregates
  watchdog (1 s)          : dead-man — loop stall ⇒ autonomy degrades + alarm
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import asdict

from .act.dispatch import CommandManager
from .audit.log import AuditLog
from .core.bus import EventBus
from .core.clock import Clock
from .core.settings import Settings
from .decide.engine import DecisionEngine
from .decide.policy import AutonomyPolicy, Envelope
from .act.cmdauth import CommandVerifier
from .decide.shedding import RosterManager
from .detect.alarms import AlarmManager, Condition
from .detect.detector import AnomalyDetector, conditions
from .forecast.forecaster import Forecaster
from .grid.dsm import DEFAULT_DSM, normalise
from .grid.state import Assessment, GridState, assess
from .grid.topology import topology
from .ingest.channels import channels
from .ingest.estimator import estimate
from .ingest.field import SimulatedField
from .ingest.kptcl import KptclSource
from .ingest.quality import QualityLayer
from .obs.metrics import Metrics
from .security.auth import DEMO_USERS, hash_password
from .store.db import Store

log = logging.getLogger("ksfp.runtime")

VITAL_KEYS = ("frequency", "ace", "deviation", "demand", "drawal", "schedule", "re", "confidence")


class Runtime:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        hybrid = settings.source in ("hybrid", "kptcl")
        self.clock = Clock(1.0 if hybrid else settings.time_scale, None if hybrid else settings.sim_start)
        self.bus = EventBus()
        self.store = Store(settings.database_url)
        self.field = SimulatedField(self.clock, settings.seed, settings.auto_disturbances)
        self.kptcl = KptclSource() if hybrid else None
        self.quality = QualityLayer()
        self.forecaster = Forecaster(self.field.profile)
        self.alarms = AlarmManager()
        self.anomaly = AnomalyDetector()
        self.policy = AutonomyPolicy()
        self.dsm_cfg = dict(DEFAULT_DSM)
        self.audit = AuditLog()
        self.metrics = Metrics()
        self.reliability = {a["id"]: a["reliability"] for a in topology().assets}
        self.commands = CommandManager(settings.command_key, settings.command_key_id)
        # the simulated gateway verifies with its own key ring, exactly as a field gateway would
        self.field.verifier = CommandVerifier({settings.command_key_id: settings.command_key.encode()})
        self.engine = DecisionEngine(self.commands, self.policy, self.reliability)
        self.roster = RosterManager()
        self.lock = asyncio.Lock()
        self.state: GridState | None = None
        self.assessment: Assessment | None = None
        self.forecast: dict | None = None
        self.history: deque = deque(maxlen=3600)
        self.channel_src: dict[str, str] = {}
        self.channel_values: dict[str, float] = {}
        self.minute_acc: dict[str, list[float]] = {}
        self.minute_start = 0.0
        self.pending_telem: list[tuple[float, str, float, float, float]] = []
        self.dirty_docs: dict[tuple[str, str], tuple[float, str, dict]] = {}
        self.last_tick_real = time.monotonic()
        self.loop_ms = 0.0
        self.loop_healthy = True
        self.started = time.time()
        self.tasks: list[asyncio.Task] = []
        self.ticks = 0
        self.last_forecast = 0.0
        self.last_kptcl_cycle_seen = 0
        self.data_age: dict[str, float | None] = {}

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        try:
            await self.store.init()
            head = await self.store.audit_head()
            if head:
                self.audit.restore(*head)
            if self.settings.demo_users:
                for u, role, display in DEMO_USERS:
                    if not await self.store.get_user(u):
                        await self.store.upsert_user(u, role, display, hash_password(f"{u}123"))
            cfg = await self.store.get_config("autonomy")
            if cfg:
                v = cfg["value"]
                env = Envelope(**v.get("envelope", {}))
                self.policy.level = v.get("level", 2)
                self.policy.dual_auth_mw = v.get("dual_auth_mw", 200.0)
                self.policy.envelope = env
                self.policy.version = cfg["version"]
            dsm = await self.store.get_config("dsm_rules")
            if dsm:
                try:
                    self.dsm_cfg = normalise(dsm["value"])
                except ValueError:
                    log.exception("stored DSM table invalid — keeping defaults")
            sp = await self.store.get_config("shed_policy")
            if sp:
                for k, v in sp["value"].items():
                    if hasattr(self.roster.policy, k):
                        setattr(self.roster.policy, k, v)
            self.reliability.update(await self.store.load_reliability())
        except Exception as e:  # keep operating from memory
            log.exception("store init failed: %s", e)
        self.audit.append(self.clock.now(), "SYSTEM", "ksfp", f"Platform started (source={self.settings.source}, time_scale={self.clock.time_scale}, autonomy L{self.policy.level})")
        if self.settings.run_loops:
            self.tasks = [
                asyncio.create_task(self._state_loop(), name="state"),
                asyncio.create_task(self._persist_loop(), name="persist"),
                asyncio.create_task(self._watchdog(), name="watchdog"),
            ]
            if self.kptcl:
                self.tasks.append(asyncio.create_task(self._kptcl_loop(), name="kptcl"))

    async def stop(self) -> None:
        for t in self.tasks:
            t.cancel()
        await self._flush()
        await self.store.engine.dispose()

    # ------------------------------------------------------------------ loops
    async def _state_loop(self) -> None:
        while True:
            t0 = time.perf_counter()
            try:
                async with self.lock:
                    await asyncio.to_thread(self.tick)
            except Exception:
                log.exception("tick failed")
                self.metrics.inc("ksfp_tick_errors_total", help_="State-loop exceptions")
            self.loop_ms = (time.perf_counter() - t0) * 1000
            self.last_tick_real = time.monotonic()
            self.metrics.set("ksfp_loop_ms", self.loop_ms, "State-loop duration (ms)")
            self._publish_frame()
            await asyncio.sleep(max(0.05, 1.0 - (time.perf_counter() - t0)))

    async def _kptcl_loop(self) -> None:
        assert self.kptcl
        while True:
            try:
                await self.kptcl.cycle(self.clock.now())
                h = self.kptcl.health()
                self.metrics.set("ksfp_kptcl_pages_ok", h["pages_ok"], "KPTCL SLDC pages fetched OK in last cycle")
                self.metrics.set("ksfp_kptcl_channels_live", h["channels_live"], "Channels with live KPTCL values")
                self.audit.append(self.clock.now(), "SYSTEM", "kptcl-adapter", f"KPTCL cycle {h['cycles']}: {h['pages_ok']}/{h['pages_total']} pages OK, {h['channels_live']} live channels, {len(h['unmapped'])} unmapped")
            except Exception:
                log.exception("kptcl cycle failed")
            await asyncio.sleep(self.kptcl.poll_s)

    async def _persist_loop(self) -> None:
        while True:
            await asyncio.sleep(10)
            await self._flush()

    async def _watchdog(self) -> None:
        while True:
            await asyncio.sleep(1)
            stall = time.monotonic() - self.last_tick_real
            self.loop_healthy = stall < 5 and self.loop_ms < 900
            self.metrics.set("ksfp_loop_stall_s", stall, "Seconds since last completed state tick")

    # ------------------------------------------------------------------ one control cycle
    def tick(self) -> None:
        now = self.clock.now()
        self.ticks += 1
        self.field.step(now)
        raw = self.field.read(now)
        # hybrid: live KPTCL channels replace simulated ones; calibrate the plant model per bus/generator
        if self.kptcl and self.kptcl.values:
            for k, v in self.kptcl.values.items():
                raw[k] = v
            if self.kptcl.cycles != self.last_kptcl_cycle_seen:
                self.last_kptcl_cycle_seen = self.kptcl.cycles
                self._calibrate(raw)
        values = self.quality.process(raw, now, self.kptcl.values_ts if self.kptcl else None)
        s = estimate(values, now, self.quality)
        a = assess(s, self.dsm_cfg)
        self.state, self.assessment = s, a
        self.channel_values = {k: v for k, (v, _) in values.items() if k.startswith("ch.") and v is not None}
        live = self.kptcl.values if self.kptcl else {}
        self.channel_src = {k: ("KPTCL" if k in live else "SIM") for k in self.channel_values}
        self._safety_vetoes(values, s, now)
        # forecast
        if now - self.last_forecast >= 60 or self.forecast is None:
            self.forecaster.update(s)
            d = self.engine.active()
            held = sum(self.engine._active_mw(d, a).values()) if d else 0.0
            self.forecast = self.forecaster.forecast(s, held, 1.0 if (d and d.direction == "UP") else -1.0)
            self.last_forecast = now
        z = 0.0
        if self.forecast:
            z = self.anomaly.update(s.demand_mw - self.forecast["blocks"][0]["demand"]["p50"])
        # detection
        eff, reasons = self.policy.effective(s.confidence, self.loop_healthy)
        autonomy = {
            "degraded": eff < self.policy.level and not self.policy.suspended,
            "reasons": reasons,
            "suspended": self.policy.suspended,
            "suspended_reason": self.policy.suspended_reason,
            "loop_slow": not self.loop_healthy,
            "loop_ms": self.loop_ms,
        }
        d = self.engine.active()
        decision_assets = {x["id"] for x in d.current.get("allocations", [])} if d else set()
        issues = [(aid, "comms", 3) for aid, st in s.asset_state.items() if st["heartbeat_age_s"] > 60]
        issues += [(c.asset_id, "under", 2) for c in self.commands.commands.values() if c.state == "EXECUTING" and c.under_delivering]
        changed = self.alarms.evaluate(conditions(a, self.forecast, z, autonomy, issues, decision_assets), now)
        for al in changed:
            self.dirty_docs[("alarm", al.id)] = (al.raised_at, al.state, al.to_dict())
            if al.incident_id:
                inc = self.alarms.incidents[al.incident_id]
                self.dirty_docs[("incident", inc.id)] = (inc.opened_at, "OPEN" if inc.open else "CLOSED", inc.to_dict())
            if al.state == "ACTIVE" and al.raised_at == now:
                self.audit.append(now, "ALARM", "detector", f"P{al.priority} {al.title} — {al.detail}", al.id)
                self.bus.publish("alarm.raised", al.to_dict())
            elif al.state == "CLEARED":
                self.bus.publish("alarm.cleared", al.to_dict())
        # decide (MPC)
        inc = next((i.id for i in sorted(self.alarms.incidents.values(), key=lambda x: x.priority) if i.open and i.category in ("BALANCE", "NETWORK")), None)
        unshed = self.unshed_load(s.bus_load)
        self.engine.relief_mw = self.roster.shed_mw(unshed)
        touched = self.engine.step(a, now, self.forecast, inc, self.loop_healthy)
        for dd in touched:
            if dd.incident_id and dd.incident_id in self.alarms.incidents:
                self.alarms.incidents[dd.incident_id].decision_id = dd.id
            self.bus.publish("decision.updated", dd.summary())
        # emergency load management: shedding covers only what flexibility cannot (over-drawal, low frequency)
        dd = self.engine.active()
        residual = 0.0
        if dd and dd.direction == "UP":
            res = (dd.current.get("plan") or {}).get("residual") or [0.0]
            residual = max(0.0, float(res[0]))
        # follow the over-drawal the DR event was opened for: once feeders are open the instantaneous
        # direction can flip to under-drawal, which must not read as "need gone"
        self.roster.dsm_band_mw = a.dsm.band_mw  # first (tolerance) band of the rule table in force
        self.roster.step(now, s.frequency, dd.direction if dd else a.direction, residual, unshed)
        self.field.shed_frac = self.roster.shed_fraction()
        # dispatch
        self.commands.tick(now, self.field, s.asset_state)
        self._drain(now)
        # persistence bookkeeping
        for dd in self.engine.decisions.values():
            if dd.open or (dd.closed_at and now - dd.closed_at < 30):
                self.dirty_docs[("decision", dd.id)] = (dd.opened_at, dd.state, dd.to_dict())
        self._aggregate(now, s, a)
        self._metrics(s, a)
        self.alarms.prune()
        self.commands.prune()

    def _calibrate(self, raw: dict[str, float]) -> None:
        ch = channels()
        sim_vals = self.field.read(self.clock.now())
        live = self.kptcl.values if self.kptcl else {}
        bus_real: dict[str, float] = {}
        bus_sim: dict[str, float] = {}
        bus_cov: dict[str, float] = {}
        for c in ch["load_channels"]:
            k = f"ch.load.{c['id']}"
            if k in live and k in sim_vals:
                bus_real[c["parent_bus"]] = bus_real.get(c["parent_bus"], 0.0) + live[k]
                bus_sim[c["parent_bus"]] = bus_sim.get(c["parent_bus"], 0.0) + sim_vals[k]
                bus_cov[c["parent_bus"]] = bus_cov.get(c["parent_bus"], 0.0) + self.field.ch_load_frac[c["id"]]
        bus_factor = {b: bus_real[b] / bus_sim[b] for b in bus_real if bus_sim.get(b, 0) > 1 and bus_cov.get(b, 0) >= 0.5}
        gen_real: dict[str, float] = {}
        gen_sim: dict[str, float] = {}
        for g in ch["gen_stations"]:
            k = f"ch.gen.{g['id']}"
            if k in live and k in sim_vals:
                gen_real[g["model_gen"]] = gen_real.get(g["model_gen"], 0.0) + live[k]
                gen_sim[g["model_gen"]] = gen_sim.get(g["model_gen"], 0.0) + sim_vals[k]
        gen_factor = {gid: gen_real[gid] / gen_sim[gid] for gid in gen_real if gen_sim.get(gid, 0) > 1}
        if bus_factor or gen_factor:
            self.field.calibrate(bus_factor, gen_factor)
            self.audit.append(self.clock.now(), "SYSTEM", "kptcl-adapter", f"Model calibrated from live KPTCL data: {len(bus_factor)} buses, {len(gen_factor)} generators")

    def _safety_vetoes(self, values: dict[str, tuple[float | None, str]], s, now: float) -> None:
        """Hard vetoes: an averaged confidence score can stay above 85 % while one critical input is bad.
        Each of these forces advisory (or, per asset, approval) on its own."""
        q = lambda k: values.get(k, (None, "MISSING"))[1]  # noqa: E731
        age = lambda k: self.quality.age(k, now)  # noqa: E731
        fmt = lambda x: "never received" if x is None else f"{x:.0f} s old"  # noqa: E731
        v: list[str] = []
        if q("sys.frequency") != "GOOD":
            v.append(f"Frequency measurement not fresh ({q('sys.frequency').lower()}, {fmt(age('sys.frequency'))}) — automatic control blocked")
        if q("sys.schedule") in ("STALE", "MISSING", "SUSPECT"):
            v.append(f"Interchange schedule {q('sys.schedule').lower()} — ACE cannot be trusted; automatic control blocked")
        bad = [k.split(".")[1] for k, (_, qq) in values.items() if k.startswith("line.") and k.endswith(".status") and qq in ("STALE", "MISSING", "SUSPECT")]
        if bad:
            v.append(f"Breaker status not current for {len(bad)} line(s) ({', '.join(bad[:4])}) — topology uncertain; automatic control blocked")
        if self.kptcl:
            last = self.kptcl.last_cycle
            v.append(
                f"Source is the SLDC website, polled every {self.kptcl.poll_s:.0f} s (last fetch {fmt(None if not last else now - last)}) — "
                "advisory only until authorised SCADA/EMS telemetry is connected"
            )
        av: dict[str, str] = {}
        for aid, st in s.asset_state.items():
            if st["heartbeat_age_s"] > 60:
                av[aid] = "gateway heartbeat lost — command path unproven"
            elif st.get("soc") is not None and q(f"asset.{aid}.soc") in ("STALE", "MISSING", "SUSPECT"):
                av[aid] = f"state-of-charge telemetry {q(f'asset.{aid}.soc').lower()}"
        self.policy.vetoes, self.policy.asset_vetoes = v, av
        lines = [k for k in values if k.startswith("line.") and k.endswith(".status")]
        ages = [a for a in (age(k) for k in lines) if a is not None]
        self.data_age = {
            "frequency": age("sys.frequency"),
            "schedule": age("sys.schedule"),
            "breakers": max(ages) if ages else None,
            "sldc": (now - self.kptcl.last_cycle) if self.kptcl and self.kptcl.last_cycle else None,
        }

    def unshed_load(self, bus_load: dict[str, float]) -> dict[str, float]:
        """Bus load as it would be without shedding (the field reports load after feeders are opened)."""
        f = self.field.shed_frac
        return {b: v / (1.0 - min(0.9, f.get(b, 0.0))) for b, v in bus_load.items()}

    def _drain_roster(self, now: float) -> None:
        for kind, ev in self.roster.events:
            o = ev.get("order")
            ref = o["id"] if o else None
            self.audit.append(now, "SHED", "roster" if kind not in ("approval",) else "operator", ev["msg"], ref)
            self.bus.publish(f"shedding.{kind}", ev)
            if o:
                self.dirty_docs[("shed_order", o["id"])] = (o["created"], o["state"], o)
            if kind == "proposed":
                al = self.alarms.event(Condition(f"event:SHED:{ref}", "SHED_PROPOSED", "BALANCE", 1, f"Load rotation proposed: {o['mw']:.0f} MW", "Flexibility exhausted — shift-in-charge approval required"), now)
                self.dirty_docs[("alarm", al.id)] = (al.raised_at, al.state, al.to_dict())
            elif kind == "exhausted":
                al = self.alarms.event(Condition(f"event:SHEDX:{ref}:{now:.0f}", "ROSTER_EXHAUSTED", "BALANCE", 1, "Roster exhausted", ev["msg"]), now)
                self.dirty_docs[("alarm", al.id)] = (al.raised_at, al.state, al.to_dict())
        self.roster.events.clear()

    def _drain(self, now: float) -> None:
        self._drain_roster(now)
        for kind, did, msg in self.engine.log:
            self.audit.append(now, kind, "dr-engine" if kind not in ("APPROVAL",) else "operator", msg, did)
        self.engine.log.clear()
        for ev, c in self.commands.events:
            self.dirty_docs[("command", c.id)] = (c.created, c.state, c.to_dict())
            self.bus.publish(f"command.{ev}", c.to_dict())
            if ev in ("sent", "acked", "failed"):
                kind = "COMMAND" if ev == "sent" else "ACK" if ev == "acked" else "COMMAND"
                msg = {
                    "sent": f"Signed setpoint {c.setpoint:.0f} MW → {c.asset_name} via {c.protocol} ({c.id}, sig {c.signature})",
                    "acked": f"Acknowledged by {c.asset_name} ({c.id})",
                    "failed": f"FAILED {c.asset_name}: {c.note}",
                }[ev]
                self.audit.append(now, kind, "dispatch", msg, c.decision_id)
            if ev == "failed":
                a = self.alarms.event(Condition(f"event:CMD:{c.id}", "COMMAND_FAILED", "ASSET", 2, f"Command failed: {c.asset_name}", c.note), now)
                self.dirty_docs[("alarm", a.id)] = (a.raised_at, a.state, a.to_dict())
                self.bus.publish("alarm.raised", a.to_dict())
        self.commands.events.clear()

    def _aggregate(self, now: float, s: GridState, a: Assessment) -> None:
        vit = {
            "frequency": s.frequency,
            "ace": a.ace.ace,
            "deviation": a.deviation_mw,
            "demand": s.demand_mw,
            "drawal": s.drawal_mw,
            "schedule": s.schedule_mw,
            "re": s.re_mw,
            "confidence": s.confidence,
        }
        self.history.append({"ts": now, **{k: round(v, 4) for k, v in vit.items()}})
        if not self.minute_start:
            self.minute_start = now - now % 60
        for k, v in {**vit, **self.channel_values}.items():
            self.minute_acc.setdefault(k, []).append(v)
        if now - self.minute_start >= 60:
            for k, vs in self.minute_acc.items():
                if vs:
                    self.pending_telem.append((self.minute_start, k, sum(vs) / len(vs), min(vs), max(vs)))
            self.minute_acc = {}
            self.minute_start = now - now % 60

    def _metrics(self, s: GridState, a: Assessment) -> None:
        m = self.metrics
        m.set("ksfp_frequency_hz", s.frequency, "Estimated grid frequency")
        m.set("ksfp_ace_mw", a.ace.ace, "State Area Control Error")
        m.set("ksfp_data_confidence", s.confidence, "State-estimate data confidence 0..1")
        m.set("ksfp_alarms_active", len(self.alarms.active(s.ts)), "Active/unacknowledged alarms")
        m.set("ksfp_bus_dropped_total", self.bus.dropped, "Event-bus messages dropped by backpressure")
        m.set("ksfp_quality_rejected_total", self.quality.stats["rejected"], "Telemetry samples rejected by quality checks")
        m.set("ksfp_store_healthy", 1 if self.store.healthy else 0, "Database reachable")
        for st in ("AWAITING_APPROVAL", "EXECUTING", "COMPLETED", "REJECTED", "ABORTED"):
            m.set(f'ksfp_decisions{{state="{st}"}}', sum(1 for d in self.engine.decisions.values() if d.state == st), "Decisions by state")
        d = self.engine.active()
        if d and d.current.get("plan"):
            m.set("ksfp_lp_solve_ms", d.current["plan"]["solver"]["solve_ms"], "Last LP solve time (ms)")
        m.inc("ksfp_ticks_total", help_="State-loop ticks")

    async def _flush(self) -> None:
        # The state loop appends to these buffers from a worker thread while we await the DB, so swap them out first:
        # anything appended during the write lands in the fresh buffers instead of being cleared away unsaved.
        if not (self.audit.outbox or self.dirty_docs or self.pending_telem):
            return
        outbox, self.audit.outbox = self.audit.outbox, []
        dirty, self.dirty_docs = self.dirty_docs, {}
        telem, self.pending_telem = self.pending_telem, []
        audit_rows = [e.to_dict() for e in outbox]
        docs = [(k[0], k[1], v[0], v[1], v[2]) for k, v in dirty.items()]
        try:
            await self.store.flush(audit_rows, docs, list(telem))
            self.store.healthy = True
            if any(d.closed_at for d in self.engine.decisions.values()):
                await self.store.save_reliability(self.reliability, self.clock.now())
        except Exception as e:
            # put the batch back in front of anything newer; newer document versions win
            self.audit.outbox[:0] = outbox
            self.pending_telem[:0] = telem
            self.dirty_docs = {**dirty, **self.dirty_docs}
            self.store.healthy = False
            self.store.failures += 1
            log.warning("persist failed (%s) — buffering %d audit rows", e, len(self.audit.outbox))

    # ------------------------------------------------------------------ frames for the UI
    def frame(self) -> dict | None:
        s, a = self.state, self.assessment
        if s is None or a is None:
            return None
        eff, reasons = self.policy.effective(s.confidence, self.loop_healthy)
        active_alarms = self.alarms.active(s.ts)
        d = self.engine.active()
        return {
            "type": "state",
            "ts": s.ts,
            "clock": Clock.hhmmss(s.ts),
            "block": Clock.block_of(s.ts),
            "time_scale": self.clock.time_scale,
            "severity": a.severity,
            "direction": a.direction,
            "frequency": round(s.frequency, 4),
            "ace": round(a.ace.ace, 1),
            "deviation": round(a.deviation_mw, 1),
            "requirement": round(a.requirement_mw, 1),
            "demand": round(s.demand_mw, 1),
            "drawal": round(s.drawal_mw, 1),
            "schedule": round(s.schedule_mw, 1),
            "state_gen": round(s.state_gen_mw, 1),
            "central_gen": round(s.central_gen_mw, 1),
            "re": round(s.re_mw, 1),
            "gen_by_type": {k: round(v, 1) for k, v in s.gen_by_type.items()},
            "gen_output": {k: round(v, 1) for k, v in s.gen_output.items()},
            "bus_load": {k: round(v, 1) for k, v in s.bus_load.items()},
            "flows": {k: round(v, 1) for k, v in s.flow.flows.items()},
            "loading": {k: round(v, 4) for k, v in s.flow.loading.items()},
            "injections": {k: round(v, 1) for k, v in s.flow.injections.items() if k.startswith("X_")},
            "outaged": list(s.outaged),
            "islanded": list(s.flow.islanded),
            "max_line": {"line": s.flow.max_line, "loading": round(s.flow.max_loading, 4)},
            "assets": {k: {"mw": round(v["mw"], 1), "soc": v["soc"], "hb_age": round(min(v["heartbeat_age_s"], 9999), 0)} for k, v in s.asset_state.items()},
            "channels": {k.split(".", 2)[2]: {"mw": round(v, 1), "src": self.channel_src.get(k, "SIM"), "kind": k.split(".")[1]} for k, v in self.channel_values.items()},
            "confidence": s.confidence,
            "quality_issues": s.quality,
            "dsm_per_block_rs": round(a.dsm.amount_rs, 0),
            "nr": round(a.dsm.nr.nr, 2),
            "autonomy": {"level": self.policy.level, "effective": eff, "reasons": reasons, "suspended": self.policy.suspended, "vetoes": self.policy.vetoes},
            "data_age": {k: (None if v is None else round(v, 1)) for k, v in self.data_age.items()},
            "counts": {
                "alarms": len(active_alarms),
                "p1": sum(1 for x in active_alarms if x.priority == 1),
                "unacked": sum(1 for x in active_alarms if not x.acked),
                "decisions_open": sum(1 for x in self.engine.decisions.values() if x.open),
                "awaiting": sum(1 for x in self.engine.decisions.values() if x.state == "AWAITING_APPROVAL"),
            },
            "active_decision": d.summary() if d else None,
            "shedding": self.roster.summary(self.unshed_load(s.bus_load)),
            "live_setpoints": self.commands.live_setpoints(),
            "source": {"mode": self.settings.source, "kptcl": {"ok": self.kptcl.health()["pages_ok"], "total": len(self.kptcl.status), "live": len(self.kptcl.values)} if self.kptcl else None},
            "loop_ms": round(self.loop_ms, 1),
        }

    def _publish_frame(self) -> None:
        f = self.frame()
        if f:
            self.bus.publish("state.snapshot", f)

    def health(self) -> dict:
        stall = time.monotonic() - self.last_tick_real
        return {
            "status": "ok" if stall < 5 else "degraded",
            "uptime_s": round(time.time() - self.started, 1),
            "loop_ms": round(self.loop_ms, 1),
            "loop_stall_s": round(stall, 2),
            "store": {"healthy": self.store.healthy, "dialect": self.store.dialect, "failures": self.store.failures},
            "source": self.settings.source,
            "ticks": self.ticks,
            "data_confidence": self.state.confidence if self.state else None,
        }

    def sources(self) -> list[dict]:
        out = [
            {
                "name": "Simulated field (SCADA/EMS stand-in)",
                "kind": "simulated",
                "role": "frequency, schedule, DR asset telemetry & gateway" + ("" if self.kptcl else ", all load & generation channels"),
                "status": "OK",
                "points": len(self.quality.points),
                "quality": dict(self.quality.stats),
                "time_scale": self.clock.time_scale,
            }
        ]
        if self.kptcl:
            out.append({"kind": "kptcl", **self.kptcl.health()})
        return out

    def asdict_policy(self) -> dict:
        return {**self.policy.to_dict(), "envelope": asdict(self.policy.envelope)}
