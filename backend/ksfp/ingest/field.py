"""Simulated field: stands in for SCADA/EMS + asset gateways when no real source is connected.

It is a closed-loop plant model, not a playback: commands sent by the dispatch module change
asset behaviour, which changes bus loads, drawal, ACE and line flows. It also produces the
messiness of real telemetry (noise, dropouts, spikes, stale points, lost heartbeats) so the
data-quality and resilience paths are exercised continuously.

Real deployments replace this with protocol adapters (IEC 60870-5-104 / ICCP for SCADA,
OpenADR 3 VTN for aggregated DR, Modbus/OPC UA gateways) that implement the same two
methods: `read() -> dict[str, float]` and `send_setpoint(...)`.
"""

from __future__ import annotations

import hashlib
import math
import random
import uuid
from dataclasses import dataclass, field

from ..act.cmdauth import CommandVerifier
from ..core.clock import Clock
from ..grid.topology import topology
from .channels import channels

# Karnataka-like diurnal demand shape (fraction of the 15:00 peak), hourly knots
DEMAND_SHAPE = [0.66, 0.64, 0.63, 0.63, 0.65, 0.70, 0.78, 0.86, 0.92, 0.96, 0.98, 0.99, 0.99, 0.99, 1.00, 1.00, 0.98, 0.96, 0.95, 0.94, 0.90, 0.83, 0.76, 0.70]


def _interp(shape: list[float], h: float) -> float:
    i = int(h) % 24
    f = h - int(h)
    return shape[i] * (1 - f) + shape[(i + 1) % 24] * f


def demand_factor(h: float) -> float:
    return _interp(DEMAND_SHAPE, h)


def solar_factor(h: float) -> float:
    def raw(x: float) -> float:
        return max(0.0, math.sin(math.pi * (x - 6.3) / 12.4)) ** 1.2

    return raw(h) / raw(15.0)


REGIONS = ("BENGALURU", "NORTH", "STATEWIDE")


@dataclass
class Disturbance:
    kind: str  # demand_surge | re_drop | line_trip | freq_event | comms_loss | telemetry_loss | unit_trip | price_spike
    params: dict
    start: float
    duration_s: float
    ramp_s: float = 300.0
    label: str = ""
    source: str = "auto"  # auto | engineer
    id: str = field(default_factory=lambda: "D-" + uuid.uuid4().hex[:6].upper())

    def envelope(self, now: float) -> float:
        if now < self.start or now > self.start + self.duration_s:
            return 0.0
        t = now - self.start
        up = min(1.0, t / self.ramp_s) if self.ramp_s > 0 else 1.0
        down = min(1.0, (self.start + self.duration_s - now) / self.ramp_s) if self.ramp_s > 0 else 1.0
        return max(0.0, min(up, down))

    def active(self, now: float) -> bool:
        return self.start <= now <= self.start + self.duration_s

    def to_dict(self, now: float) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "params": self.params,
            "start": self.start,
            "end": self.start + self.duration_s,
            "active": self.active(now),
            "intensity": round(self.envelope(now), 3),
            "source": self.source,
        }


@dataclass
class FieldAsset:
    spec: dict
    setpoint: float = 0.0  # MW of flexibility requested (reduction for loads, injection for gen/BESS)
    actual: float = 0.0  # MW currently delivered
    perf: float = 1.0  # performance factor drawn per command
    command_ts: float = 0.0
    soc: float | None = None
    comms_ok: bool = True
    last_heartbeat: float = 0.0
    curtailed_mwh: float = 0.0
    rebound_owed_mwh: float = 0.0
    pending: list[tuple[float, float, str]] = field(default_factory=list)  # (apply_at, setpoint, command_id)
    acks: dict[str, float] = field(default_factory=dict)  # command_id → ack time


class SimulatedField:
    """Plant + comms model. `step(now)` advances physics; `read(now)` returns raw telemetry."""

    name = "simulated-field"

    def __init__(self, clock: Clock, seed: int = 7, auto_disturbances: bool = True) -> None:
        self.t = topology()
        self.clock = clock
        self.rng = random.Random(seed)
        self.auto = auto_disturbances
        self.base_demand = self.t.meta["baseDemandMW"]
        self.share_sum = sum(b["loadShare"] for b in self.t.internal)
        self.disturbances: list[Disturbance] = []
        self.assets = {a["id"]: FieldAsset(a, soc=a["bess"]["soc"] if a.get("bess") else None) for a in self.t.assets}
        self.walk_f = 0.0
        self.walk_d = 0.0
        self.wind_walk = 1.0
        self.last_step = clock.now()
        self.next_auto = clock.now() + 8 * 60
        self.last_imbalance = 0.0
        # gateway-side command authentication (set by the runtime); None = accept unauthenticated (unit tests)
        self.verifier: CommandVerifier | None = None
        self.rejected: list[dict] = []  # commands the gateway refused, with the reason
        for fa in self.assets.values():
            fa.last_heartbeat = self.last_step
        # calibration from live measurements (hybrid mode): fast factors drive the plant,
        # slow factors drive the day-ahead view (schedule) so deviations remain meaningful
        self.bus_scale: dict[str, float] = {}
        self.gen_scale: dict[str, float] = {}
        self.bus_scale_slow: dict[str, float] = {}
        self.gen_scale_slow: dict[str, float] = {}
        ch = channels()
        self.ch_loads = ch["load_channels"]
        self.ch_gens = ch["gen_stations"]
        wsum: dict[str, float] = {}
        for c in self.ch_loads:
            wsum[c["parent_bus"]] = wsum.get(c["parent_bus"], 0.0) + c["weight"]
        self.ch_load_frac = {c["id"]: c["weight"] / wsum[c["parent_bus"]] for c in self.ch_loads}
        csum: dict[str, float] = {}
        for g in self.ch_gens:
            csum[g["model_gen"]] = csum.get(g["model_gen"], 0.0) + max(g["capacityMW"], 1.0)
        self.ch_gen_frac = {g["id"]: max(g["capacityMW"], 1.0) / csum[g["model_gen"]] for g in self.ch_gens}
        self.ch_noise: dict[str, float] = {c["id"]: 1.0 for c in self.ch_loads}
        # load shedding in force: fraction of each bus's load disconnected (set by the roster manager)
        self.shed_frac: dict[str, float] = {}
        # load rotation never removes exactly the planned share: embedded/captive supply and feeder ties keep some
        # load on — a fixed realisation factor per bus (85–98 %); rot_relief is what feeder metering would measure
        self.rot_realisation = {b["id"]: 0.85 + (int(hashlib.sha256(b["id"].encode()).hexdigest(), 16) % 1300) / 10000 for b in self.t.internal}
        self.rot_relief: dict[str, float] = {}

    def calibrate(self, bus_factor: dict[str, float], gen_factor: dict[str, float]) -> None:
        """Pull the plant toward live measurements (EWMA). Factors are measured / modelled."""
        for k, f in bus_factor.items():
            f = max(0.3, min(3.0, f))
            self.bus_scale[k] = 0.6 * self.bus_scale.get(k, 1.0) + 0.4 * f
            self.bus_scale_slow[k] = 0.95 * self.bus_scale_slow.get(k, 1.0) + 0.05 * f
        for k, f in gen_factor.items():
            f = max(0.0, min(3.0, f))
            self.gen_scale[k] = 0.6 * self.gen_scale.get(k, 1.0) + 0.4 * f
            self.gen_scale_slow[k] = 0.95 * self.gen_scale_slow.get(k, 1.0) + 0.05 * f

    # ------------------------------------------------------------------ profiles (day-ahead view)
    def profile(self, ts: float) -> dict:
        """Expected (day-ahead) demand & generation at ts — also the basis of the drawal schedule."""
        h = Clock.hour_of_day(ts)
        demand = self.base_demand * demand_factor(h)
        gen = {}
        for g in self.t.generators:
            if g["type"] == "solar":
                gen[g["id"]] = g["baseMW"] * solar_factor(h)
            elif g["type"] == "hydro":
                gen[g["id"]] = g["baseMW"] * (0.6 + 0.4 * demand_factor(h))
            else:
                gen[g["id"]] = g["baseMW"]
        if self.bus_scale_slow:
            demand = sum(demand * b["loadShare"] / self.share_sum * self.bus_scale_slow.get(b["id"], 1.0) for b in self.t.internal)
        for gid in gen:
            gen[gid] *= self.gen_scale_slow.get(gid, 1.0)
        state_gen = sum(v for g, v in gen.items() if self._owner(g) != "Central")
        return {"demand": demand, "gen": gen, "schedule": demand - state_gen}

    # ------------------------------------------------------------------ disturbances
    def add(self, d: Disturbance) -> Disturbance:
        self.disturbances.append(d)
        return d

    def clear(self, dist_id: str) -> bool:
        now = self.clock.now()
        for d in self.disturbances:
            if d.id == dist_id and d.active(now):
                d.duration_s = max(0.0, now - d.start + d.ramp_s * 0.2)
                return True
        return False

    def active_disturbances(self, now: float) -> list[Disturbance]:
        return [d for d in self.disturbances if d.active(now)]

    def _auto_schedule(self, now: float) -> None:
        if not self.auto or now < self.next_auto:
            return
        self.next_auto = now + self.rng.uniform(55, 110) * 60
        if len(self.active_disturbances(now)) >= 2:
            return
        r = self.rng
        kind = r.choices(
            ["re_drop", "demand_surge", "freq_event", "line_trip", "comms_loss", "telemetry_loss", "unit_trip"],
            weights=[28, 26, 12, 10, 10, 6, 8],
        )[0]
        dur = r.uniform(45, 100) * 60
        if kind == "re_drop":
            mw = r.choice([400, 600, 800, 1000])
            self.add(Disturbance(kind, {"mw": mw}, now, dur, 420, f"Cloud cover / wind lull: −{mw} MW RE"))
        elif kind == "demand_surge":
            region = r.choice(REGIONS)
            mw = r.choice([300, 450, 600, 800])
            self.add(Disturbance(kind, {"mw": mw, "region": region}, now, dur, 600, f"Demand surge +{mw} MW ({region.lower()})"))
        elif kind == "freq_event":
            dhz = r.choice([-0.08, -0.12, -0.16, 0.07])
            self.add(Disturbance(kind, {"delta_hz": dhz}, now, r.uniform(15, 35) * 60, 60, f"All-India frequency excursion {dhz:+.2f} Hz"))
        elif kind == "line_trip":
            line = r.choice(["L4", "L2", "L36", "L13", "L21"])
            self.add(Disturbance(kind, {"line": line}, now, dur, 0, f"Line trip: {self.t.line_label(line)}"))
        elif kind == "comms_loss":
            ids = r.sample([a["id"] for a in self.t.assets if a["type"] != "generation"], 2)
            self.add(Disturbance(kind, {"assets": ids}, now, dur, 0, f"Gateway comms loss: {', '.join(ids)}"))
        elif kind == "telemetry_loss":
            bus = r.choice(["NEL", "BLY", "MYS", "GUL"])
            self.add(Disturbance(kind, {"buses": [bus]}, now, r.uniform(20, 40) * 60, 0, f"RTU telemetry loss at {bus}"))
        elif kind == "unit_trip":
            g = r.choice(["G_RTPS", "G_BTPS", "G_UPCL"])
            mw = r.choice([250, 400, 500])
            self.add(Disturbance(kind, {"gen": g, "mw": mw}, now, dur, 30, f"Unit trip: {g} −{mw} MW"))

    # ------------------------------------------------------------------ gateway (command path)
    def send_setpoint(self, asset_id: str, setpoint: float, command_id: str, now: float, auth: dict | None = None, decision_id: str = "", kind: str = "DISPATCH") -> None:
        fa = self.assets[asset_id]
        if not self._asset_comms_ok(asset_id, now):
            return  # lost in transit — no ack will ever come
        if self.verifier is not None:
            ok, why = self.verifier.verify(auth, command_id, decision_id, asset_id, setpoint, kind, now)
            if not ok:
                self.rejected.append({"ts": now, "command_id": command_id, "asset_id": asset_id, "reason": why})
                del self.rejected[:-200]
                return  # refused: never acted on, never acked → times out as FAILED on the control-centre side
        latency = self.rng.uniform(4, 18)  # seconds (sim)
        fa.pending.append((now + latency, setpoint, command_id))

    def ack_time(self, asset_id: str, command_id: str) -> float | None:
        return self.assets[asset_id].acks.get(command_id)

    def _asset_comms_ok(self, asset_id: str, now: float) -> bool:
        if not self.assets[asset_id].comms_ok:
            return False
        for d in self.active_disturbances(now):
            if d.kind == "comms_loss" and asset_id in d.params.get("assets", []):
                return False
        return True

    # ------------------------------------------------------------------ physics
    def step(self, now: float) -> None:
        dt = max(0.0, min(120.0, now - self.last_step))
        self.last_step = now
        if dt == 0:
            return
        self._auto_schedule(now)
        r = self.rng
        self.walk_f = max(-0.035, min(0.035, self.walk_f * 0.97 + r.gauss(0, 0.004)))
        self.walk_d = max(-80, min(80, self.walk_d * 0.97 + r.gauss(0, 9)))
        self.wind_walk = max(0.7, min(1.3, self.wind_walk + r.gauss(0, 0.004)))
        for fa in self.assets.values():
            spec = fa.spec
            comms = self._asset_comms_ok(spec["id"], now)
            if comms:
                fa.last_heartbeat = now
            # apply delivered commands
            for item in list(fa.pending):
                apply_at, sp, cid = item
                if now >= apply_at:
                    fa.pending.remove(item)
                    fa.acks[cid] = apply_at
                    fa.command_ts = apply_at
                    if sp > 0 and fa.setpoint <= 0:
                        rel = spec["reliability"]
                        fa.perf = min(1.04, 0.94 + 0.1 * r.random()) if r.random() < rel + 0.03 else 0.5 + 0.35 * r.random()
                    if sp <= 0 < fa.setpoint and spec["reboundFrac"] > 0:
                        fa.rebound_owed_mwh += spec["reboundFrac"] * fa.curtailed_mwh
                        fa.curtailed_mwh = 0.0
                    fa.setpoint = sp
            target = fa.setpoint * fa.perf if fa.setpoint > 0 else 0.0
            if fa.soc is not None and spec.get("bess"):
                b = spec["bess"]
                if fa.soc <= b["socMin"] + 0.005:
                    target = 0.0
            if now - fa.command_ts >= spec["responseMin"] * 60 or target < fa.actual:
                step = spec["rampMWpm"] * dt / 60
                fa.actual = min(target, fa.actual + step) if fa.actual < target else max(target, fa.actual - step)
            if fa.actual > 0:
                fa.curtailed_mwh += fa.actual * dt / 3600
            if fa.soc is not None and spec.get("bess"):
                b = spec["bess"]
                if fa.actual > 0:
                    fa.soc -= fa.actual * dt / 3600 / b["etaD"] / b["energyMWh"]
                elif fa.setpoint <= 0:  # idle: trickle recharge toward 80 % off-event
                    fa.soc = min(b["socMax"], fa.soc + 0.02 * dt / 3600)
                fa.soc = max(0.0, min(1.0, fa.soc))
            if fa.rebound_owed_mwh > 0 and fa.setpoint <= 0:
                rate = fa.rebound_owed_mwh / max(0.25, spec["recoveryMin"] / 60)
                fa.rebound_owed_mwh = max(0.0, fa.rebound_owed_mwh - rate * dt / 3600)

    # ------------------------------------------------------------------ plant outputs
    def _state(self, now: float) -> dict:
        prof = self.profile(now)
        h = Clock.hour_of_day(now)
        demand_base = self.base_demand * demand_factor(h) + self.walk_d
        bus_load = {b["id"]: demand_base * b["loadShare"] / self.share_sum * self.bus_scale.get(b["id"], 1.0) for b in self.t.internal}
        gen = {gid: v / max(self.gen_scale_slow.get(gid, 1.0), 1e-6) * self.gen_scale.get(gid, 1.0) for gid, v in prof["gen"].items()}
        outaged: list[str] = []
        freq_offset = 0.0
        re_drop = 0.0
        rtm = 7.2
        for d in self.active_disturbances(now):
            e = d.envelope(now)
            if d.kind == "demand_surge":
                region = d.params.get("region", "STATEWIDE")
                buses = [b for b in self.t.internal if region == "STATEWIDE" or b.get("region") == region]
                tot = sum(b["loadShare"] for b in buses) or 1.0
                for b in buses:
                    bus_load[b["id"]] += d.params["mw"] * e * b["loadShare"] / tot
            elif d.kind == "re_drop":
                re_drop += d.params["mw"] * e
            elif d.kind == "line_trip":
                outaged.append(d.params["line"])
            elif d.kind == "freq_event":
                freq_offset += d.params["delta_hz"] * e
            elif d.kind == "unit_trip":
                gid = d.params["gen"]
                gen[gid] = max(0.0, gen[gid] - d.params["mw"] * e)
            elif d.kind == "price_spike":
                rtm = max(rtm, d.params.get("rtm", 11.0))
        self.rot_relief = {}
        for b, f in self.shed_frac.items():
            if b in bus_load and f > 0:
                relief = bus_load[b] * min(0.9, f) * self.rot_realisation.get(b, 0.95)
                bus_load[b] -= relief
                self.rot_relief[b] = relief
        solar = [g for g in self.t.generators if g["type"] == "solar"]
        wind = [g for g in self.t.generators if g["type"] == "wind"]
        s_sum = sum(gen[g["id"]] for g in solar) or 1.0
        w_sum = sum(g["baseMW"] for g in wind) or 1.0
        for g in wind:
            gen[g["id"]] = g["baseMW"] * self.wind_walk
        for g in solar:
            gen[g["id"]] = max(0.0, gen[g["id"]] - re_drop * 0.7 * gen[g["id"]] / s_sum)
        for g in wind:
            gen[g["id"]] = max(0.0, gen[g["id"]] - re_drop * 0.3 * g["baseMW"] / w_sum)
        # asset effects (closed loop)
        for fa in self.assets.values():
            spec = fa.spec
            if spec["type"] == "generation":
                gid = {"A_YTPS": "G_YTPS", "A_SHV": "G_SHV"}.get(spec["id"])
                if gid:
                    gen[gid] += fa.actual
            else:
                bus_load[spec["bus"]] -= fa.actual
                if fa.rebound_owed_mwh > 0 and fa.setpoint <= 0:
                    bus_load[spec["bus"]] += fa.rebound_owed_mwh / max(0.25, spec["recoveryMin"] / 60)
        demand = sum(bus_load.values())
        state_gen = sum(v for g, v in gen.items() if self._owner(g) != "Central")
        drawal = demand - state_gen
        imbalance = drawal - prof["schedule"]
        freq = 50.0 + self.walk_f + freq_offset - imbalance / 22000.0
        return {
            "bus_load": bus_load,
            "gen": gen,
            "frequency": freq,
            "schedule": prof["schedule"],
            "outaged": outaged,
            "prices": {"dam": 5.4, "rtm": rtm, "asc": 8.1, "off_peak": 3.2},
        }

    def _owner(self, gid: str) -> str:
        for g in self.t.generators:
            if g["id"] == gid:
                return g["owner"]
        return "State"

    def read(self, now: float) -> dict[str, float]:
        """Raw telemetry as a SCADA front-end would deliver it (with real-world imperfections)."""
        st = self._state(now)
        r = self.rng
        lost_buses: set[str] = set()
        for d in self.active_disturbances(now):
            if d.kind == "telemetry_loss":
                lost_buses.update(d.params.get("buses", []))
        pts: dict[str, float] = {}

        def put(key: str, value: float, noise: float = 0.0) -> None:
            if r.random() < 0.002:  # random dropout
                return
            v = value + (r.gauss(0, noise) if noise else 0.0)
            if r.random() < 0.0004:  # occasional spike / bad sample
                v *= 3.0
            pts[key] = v

        put("sys.frequency", st["frequency"], 0.002)
        put("sys.schedule", st["schedule"])
        for k, v in st["prices"].items():
            put(f"price.{k}", v)
        for b, v in st["bus_load"].items():
            if b not in lost_buses:
                put(f"bus.{b}.load", v, v * 0.002)
        for g, v in st["gen"].items():
            put(f"gen.{g}.mw", v, max(0.5, v * 0.002))
        for ln in self.t.lines:
            pts[f"line.{ln['id']}.status"] = 0.0 if ln["id"] in st["outaged"] else 1.0
        # 220 kV load channels (all DISCOMs) and generating-station channels
        for c in self.ch_loads:
            n = self.ch_noise[c["id"]] = max(0.8, min(1.2, self.ch_noise[c["id"]] + r.gauss(0, 0.002)))
            if c["parent_bus"] not in lost_buses:
                put(f"ch.load.{c['id']}", max(0.0, st["bus_load"].get(c["parent_bus"], 0.0)) * self.ch_load_frac[c["id"]] * n, 0.3)
        for g in self.ch_gens:
            put(f"ch.gen.{g['id']}", max(0.0, st["gen"].get(g["model_gen"], 0.0) * self.ch_gen_frac[g["id"]]), 0.3)
        for aid, fa in self.assets.items():
            if self._asset_comms_ok(aid, now):
                pts[f"asset.{aid}.mw"] = fa.actual
                pts[f"asset.{aid}.hb"] = fa.last_heartbeat
                if fa.soc is not None:
                    pts[f"asset.{aid}.soc"] = fa.soc
                pts[f"asset.{aid}.setpoint"] = fa.setpoint
            if fa.spec["type"] == "industrial":
                # revenue (ABT) meter, independent of the DR gateway: plant demand = operating level with a mild
                # daily shape, minus whatever it is curtailing for DR, plus meter noise
                lvl = fa.spec["baselineMW"] * (1 + 0.02 * math.sin(2 * math.pi * (Clock.hour_of_day(now) - 6) / 24))
                pts[f"asset.{aid}.load"] = max(0.0, lvl - fa.actual + r.gauss(0, 0.003 * fa.spec["baselineMW"]))
        return pts
