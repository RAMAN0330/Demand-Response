"""REST API v1 + WebSocket stream."""

from __future__ import annotations

import asyncio
import copy
import json
import time
from dataclasses import asdict

import jwt as pyjwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from ..audit.log import AuditLog
from ..core.clock import Clock
from ..decide.flexibility import evaluate
from ..decide.optimizer import compare, optimize
from ..decide.policy import Envelope
from ..decide.twin import simulate
from ..grid.dsm import DEFAULT_DSM
from ..grid.network import solve
from ..grid.state import assess
from ..grid.topology import topology
from ..ingest.channels import channels
from ..ingest.field import Disturbance
from ..security.auth import Principal, decode_token, issue_token, verify_password

router = APIRouter(prefix="/api/v1")


def rt(request: Request):
    return request.app.state.runtime


def principal(request: Request) -> Principal:
    h = request.headers.get("authorization", "")
    if not h.lower().startswith("bearer "):
        raise HTTPException(401, "Missing bearer token")
    try:
        return decode_token(h[7:], request.app.state.runtime.settings.jwt_secret)
    except pyjwt.PyJWTError as e:
        raise HTTPException(401, f"Invalid token: {e}") from e


def need(perm: str):
    def dep(p: Principal = Depends(principal)) -> Principal:
        if not p.can(perm):
            raise HTTPException(403, f"Role '{p.role}' lacks permission '{perm}'")
        return p

    return dep


# ---------------------------------------------------------------- auth
class LoginIn(BaseModel):
    username: str
    password: str


@router.post("/auth/login")
async def login(body: LoginIn, request: Request):
    r = rt(request)
    u = await r.store.get_user(body.username)
    if not u or not u["active"] or not verify_password(body.password, u["password_hash"]):
        r.audit.append(r.clock.now(), "SECURITY", body.username, "Failed login")
        raise HTTPException(401, "Invalid credentials")
    p = Principal(u["username"], u["role"], u["display"])
    r.audit.append(r.clock.now(), "SECURITY", p.username, f"Login ({p.role})")
    return {"token": issue_token(p, r.settings.jwt_secret, r.settings.jwt_ttl_min), "user": p.to_dict()}


@router.get("/auth/me")
async def me(p: Principal = Depends(principal)):
    return p.to_dict()


# ---------------------------------------------------------------- static model
@router.get("/topology")
async def get_topology(request: Request, p: Principal = Depends(need("view"))):
    t = topology()
    roster = [{k: g.to_dict()[k] for k in ("id", "discom", "letter", "name", "channels", "protected", "lat", "lon")} for g in rt(request).roster.groups.values()]
    return {**t.raw, "channels": channels(), "roster": roster, "shed_policy": asdict(rt(request).roster.policy)}


# ---------------------------------------------------------------- live state & overview
@router.get("/state")
async def get_state(request: Request, p: Principal = Depends(need("view"))):
    f = rt(request).frame()
    if not f:
        raise HTTPException(503, "State not yet available")
    return f


@router.get("/overview")
async def overview(request: Request, p: Principal = Depends(need("view"))):
    r = rt(request)
    f = r.frame()
    if not f:
        raise HTTPException(503, "State not yet available")
    now = r.clock.now()
    hist = list(r.history)[-180:]
    active = r.alarms.active(now)
    incidents = [i.to_dict() for i in r.alarms.incidents.values() if i.open]
    d = r.engine.active()
    recent = sorted((x for x in r.engine.decisions.values() if not x.open), key=lambda x: -(x.closed_at or 0))[:5]
    return {
        "now": {"frame": f, "trend": hist},
        "risk": {"alarms": [a.to_dict() for a in active[:12]], "incidents": incidents, "data_issues": f["quality_issues"], "confidence": f["confidence"]},
        "next": r.forecast,
        "intent": {
            "active": d.to_dict() if d else None,
            "recent": [x.summary() for x in recent],
            "commands": [c.to_dict() for c in sorted(r.commands.commands.values(), key=lambda c: -c.created)[:12]],
        },
    }


@router.get("/history")
async def history(request: Request, minutes: int = 60, p: Principal = Depends(need("view"))):
    r = rt(request)
    since = r.clock.now() - minutes * 60
    return [h for h in r.history if h["ts"] >= since]


@router.get("/telemetry/{key}")
async def telemetry(key: str, request: Request, hours: float = 6, p: Principal = Depends(need("view"))):
    r = rt(request)
    return await r.store.telemetry(key, r.clock.now() - hours * 3600)


@router.get("/forecast")
async def forecast(request: Request, p: Principal = Depends(need("view"))):
    return rt(request).forecast


@router.get("/network")
async def network(request: Request, p: Principal = Depends(need("view"))):
    r = rt(request)
    s = r.state
    if not s:
        raise HTTPException(503)
    t = topology()
    lines = [
        {"id": ln["id"], "label": t.line_label(ln["id"]), "kv": ln["kv"], "limit": ln["limitMW"], "flow": s.flow.flows[ln["id"]], "loading": s.flow.loading[ln["id"]], "outaged": ln["id"] in s.outaged}
        for ln in t.lines
    ]
    return {"lines": sorted(lines, key=lambda x: -x["loading"]), "voltage": s.flow.voltage, "islanded": s.flow.islanded, "outaged": s.outaged}


# ---------------------------------------------------------------- alarms
@router.get("/alarms")
async def alarms(request: Request, status: str = "active", limit: int = 200, p: Principal = Depends(need("view"))):
    r = rt(request)
    now = r.clock.now()
    if status == "active":
        items = r.alarms.active(now, include_shelved=False)
    elif status == "shelved":
        items = [a for a in r.alarms.alarms.values() if a.shelved_until and a.shelved_until >= now]
    else:
        items = sorted(r.alarms.alarms.values(), key=lambda a: -a.raised_at)
    return {"items": [a.to_dict() for a in items[:limit]], "total": len(items), "incidents": [i.to_dict() for i in sorted(r.alarms.incidents.values(), key=lambda i: -i.opened_at)[:50]]}


@router.post("/alarms/{alarm_id}/ack")
async def ack(alarm_id: str, request: Request, p: Principal = Depends(need("ack_alarm"))):
    r = rt(request)
    if alarm_id not in r.alarms.alarms:
        raise HTTPException(404)
    async with r.lock:
        a = r.alarms.ack(alarm_id, p.username, r.clock.now())
        r.dirty_docs[("alarm", a.id)] = (a.raised_at, a.state, a.to_dict())
        r.audit.append(r.clock.now(), "ALARM", p.username, f"Acknowledged {a.title}", a.id)
    return a.to_dict()


@router.post("/alarms/ack-all")
async def ack_all(request: Request, p: Principal = Depends(need("ack_alarm"))):
    r = rt(request)
    async with r.lock:
        n = 0
        for a in r.alarms.active(r.clock.now()):
            if not a.acked:
                r.alarms.ack(a.id, p.username, r.clock.now())
                n += 1
        r.audit.append(r.clock.now(), "ALARM", p.username, f"Acknowledged {n} alarm(s)")
    return {"acked": n}


class ShelveIn(BaseModel):
    minutes: int = Field(30, ge=5, le=480)
    reason: str = Field(..., min_length=3)


@router.post("/alarms/{alarm_id}/shelve")
async def shelve(alarm_id: str, body: ShelveIn, request: Request, p: Principal = Depends(need("shelve_alarm"))):
    r = rt(request)
    if alarm_id not in r.alarms.alarms:
        raise HTTPException(404)
    async with r.lock:
        a = r.alarms.shelve(alarm_id, p.username, r.clock.now() + body.minutes * 60)
        r.audit.append(r.clock.now(), "ALARM", p.username, f"Shelved {a.title} for {body.minutes} min: {body.reason}", a.id)
    return a.to_dict()


# ---------------------------------------------------------------- decisions
@router.get("/decisions")
async def decisions(request: Request, state: str | None = None, limit: int = 50, p: Principal = Depends(need("view"))):
    r = rt(request)
    items = sorted(r.engine.decisions.values(), key=lambda d: -d.opened_at)
    if state == "open":
        items = [d for d in items if d.open]
    elif state:
        items = [d for d in items if d.state == state]
    return {"items": [d.summary() for d in items[:limit]], "total": len(items)}


@router.get("/decisions/{decision_id}")
async def decision(decision_id: str, request: Request, p: Principal = Depends(need("view"))):
    r = rt(request)
    d = r.engine.decisions.get(decision_id)
    if not d:
        docs, _ = await r.store.docs("decision", 500)
        doc = next((x for x in docs if x.get("id") == decision_id), None)
        if not doc:
            raise HTTPException(404)
        return doc
    out = d.to_dict()
    out["commands"] = [c.to_dict() for c in r.commands.for_decision(d.id)]
    return out


class ReasonIn(BaseModel):
    reason: str = Field(..., min_length=3)


@router.post("/decisions/{decision_id}/approve")
async def approve(decision_id: str, request: Request, p: Principal = Depends(need("approve"))):
    r = rt(request)
    if decision_id not in r.engine.decisions:
        raise HTTPException(404)
    async with r.lock:
        try:
            d = r.engine.approve(decision_id, p.username, p.role, p.can("approve_dual"), r.clock.now())
        except PermissionError as e:
            raise HTTPException(403, str(e)) from e
        except ValueError as e:
            raise HTTPException(409, str(e)) from e
        r._drain(r.clock.now())
    return d.summary()


@router.post("/decisions/{decision_id}/reject")
async def reject(decision_id: str, body: ReasonIn, request: Request, p: Principal = Depends(need("reject"))):
    r = rt(request)
    if decision_id not in r.engine.decisions:
        raise HTTPException(404)
    async with r.lock:
        d = r.engine.reject(decision_id, p.username, body.reason, r.clock.now())
        r.audit.append(r.clock.now(), "OVERRIDE", p.username, f"Rejected decision: {body.reason}", d.id)
        r._drain(r.clock.now())
    return d.summary()


@router.post("/decisions/{decision_id}/abort")
async def abort(decision_id: str, body: ReasonIn, request: Request, p: Principal = Depends(need("abort"))):
    r = rt(request)
    if decision_id not in r.engine.decisions:
        raise HTTPException(404)
    async with r.lock:
        d = r.engine.abort(decision_id, p.username, body.reason, r.clock.now())
        r.audit.append(r.clock.now(), "OVERRIDE", p.username, f"Aborted decision (resources released): {body.reason}", d.id)
        r._drain(r.clock.now())
    return d.summary()


@router.get("/commands")
async def commands(request: Request, limit: int = 100, p: Principal = Depends(need("view"))):
    r = rt(request)
    items = sorted(r.commands.commands.values(), key=lambda c: -c.created)
    return {"items": [c.to_dict() for c in items[:limit]], "total": len(items)}


# ---------------------------------------------------------------- autonomy
class AutonomyIn(BaseModel):
    level: int | None = Field(None, ge=0, le=3)
    dual_auth_mw: float | None = Field(None, ge=0)
    envelope: dict | None = None


@router.get("/autonomy")
async def get_autonomy(request: Request, p: Principal = Depends(need("view"))):
    r = rt(request)
    eff, reasons = r.policy.effective(r.state.confidence if r.state else 1.0, r.loop_healthy)
    return {**r.asdict_policy(), "effective": eff, "reasons": reasons}


@router.put("/autonomy")
async def put_autonomy(body: AutonomyIn, request: Request, p: Principal = Depends(need("autonomy"))):
    r = rt(request)
    if body.envelope is not None and not p.can("config"):
        raise HTTPException(403, "Changing the autonomy envelope requires the 'config' permission")
    async with r.lock:
        if body.level is not None:
            r.policy.level = body.level
        if body.dual_auth_mw is not None:
            r.policy.dual_auth_mw = body.dual_auth_mw
        if body.envelope is not None:
            r.policy.envelope = Envelope(**{**asdict(r.policy.envelope), **body.envelope})
        v = await r.store.put_config("autonomy", {"level": r.policy.level, "dual_auth_mw": r.policy.dual_auth_mw, "envelope": asdict(r.policy.envelope)}, p.username, r.clock.now())
        r.policy.version = v
        r.audit.append(r.clock.now(), "CONFIG", p.username, f"Autonomy policy v{v}: level L{r.policy.level}, dual-auth {r.policy.dual_auth_mw:.0f} MW, envelope {asdict(r.policy.envelope)}")
    return r.asdict_policy()


@router.post("/autonomy/suspend")
async def suspend(body: ReasonIn, request: Request, p: Principal = Depends(need("autonomy"))):
    r = rt(request)
    async with r.lock:
        r.policy.suspended, r.policy.suspended_by, r.policy.suspended_reason = True, p.username, body.reason
        r.audit.append(r.clock.now(), "OVERRIDE", p.username, f"AUTONOMY SUSPENDED (kill switch): {body.reason}")
    return r.asdict_policy()


@router.post("/autonomy/resume")
async def resume(request: Request, p: Principal = Depends(need("autonomy"))):
    r = rt(request)
    async with r.lock:
        r.policy.suspended, r.policy.suspended_by, r.policy.suspended_reason = False, None, None
        r.audit.append(r.clock.now(), "OVERRIDE", p.username, "Autonomy resumed")
    return r.asdict_policy()


# ---------------------------------------------------------------- resources
@router.get("/resources")
async def resources(request: Request, p: Principal = Depends(need("view"))):
    r = rt(request)
    s = r.state
    live_sp = r.commands.live_setpoints()
    out = []
    for a in topology().assets:
        st = s.asset_state.get(a["id"], {}) if s else {}
        out.append(
            {
                **{k: a[k] for k in ("id", "name", "short", "type", "discom", "bus", "lon", "lat", "contractMW", "reserve", "responseMin", "rampMWpm", "maxDurationMin", "reboundFrac", "bidRs", "protocol", "description", "baselineMW")},
                "bess": a.get("bess"),
                "reliability": r.reliability.get(a["id"], a["reliability"]),
                "out_of_service": a["id"] in r.engine.out_of_service,
                "live": {"mw": st.get("mw", 0.0), "soc": st.get("soc"), "heartbeat_age_s": st.get("heartbeat_age_s"), "setpoint": live_sp.get(a["id"], 0.0)},
            }
        )
    return out


class ResourceIn(BaseModel):
    out_of_service: bool
    reason: str = Field(..., min_length=3)


@router.patch("/resources/{asset_id}")
async def patch_resource(asset_id: str, body: ResourceIn, request: Request, p: Principal = Depends(need("resources"))):
    r = rt(request)
    async with r.lock:
        (r.engine.out_of_service.add if body.out_of_service else r.engine.out_of_service.discard)(asset_id)
        r.audit.append(r.clock.now(), "CONFIG", p.username, f"{asset_id} {'out of service' if body.out_of_service else 'back in service'}: {body.reason}", asset_id)
    return {"id": asset_id, "out_of_service": body.out_of_service}


# ---------------------------------------------------------------- emergency load management (rostering)
@router.get("/shedding")
async def shedding(request: Request, p: Principal = Depends(need("view"))):
    r = rt(request)
    s = r.state
    unshed = r.unshed_load(s.bus_load) if s else {}
    ro = r.roster
    groups = []
    for g in ro.groups.values():
        d = g.to_dict()
        d["mw_now"] = round(ro.group_mw(g, unshed), 1)
        d["load_mw"] = round(sum(unshed.get(b, 0.0) * f for b, f in g.bus_frac.items()), 1)
        groups.append(d)
    orders = sorted((o.to_dict() for o in ro.orders.values()), key=lambda o: -o["created"])[:30]
    return {"policy": asdict(ro.policy), "summary": ro.summary(unshed), "groups": groups, "orders": orders}


class ShedIn(BaseModel):
    mw: float = Field(..., gt=0, le=3000)
    reason: str = Field(..., min_length=3)


@router.post("/shedding/orders")
async def shed_propose(body: ShedIn, request: Request, p: Principal = Depends(need("shed_propose"))):
    r = rt(request)
    async with r.lock:
        try:
            o = r.roster.propose(body.mw, body.reason, f"operator:{p.username}", r.clock.now())
        except ValueError as e:
            raise HTTPException(409, str(e))
        r._drain_roster(r.clock.now())
    return o.to_dict()


@router.post("/shedding/orders/{order_id}/approve")
async def shed_approve(order_id: str, request: Request, p: Principal = Depends(need("shed"))):
    r = rt(request)
    async with r.lock:
        if order_id not in r.roster.orders:
            raise HTTPException(404)
        try:
            o = r.roster.approve(order_id, p.username, p.role, p.can("approve_dual"), r.clock.now(), r.unshed_load(r.state.bus_load))
        except ValueError as e:
            raise HTTPException(409, str(e))
        except PermissionError as e:
            raise HTTPException(403, str(e))
        r.field.shed_frac = r.roster.shed_fraction()
        r._drain_roster(r.clock.now())
    return o.to_dict()


@router.post("/shedding/orders/{order_id}/reject")
async def shed_reject(order_id: str, body: ReasonIn, request: Request, p: Principal = Depends(need("shed"))):
    r = rt(request)
    async with r.lock:
        if order_id not in r.roster.orders:
            raise HTTPException(404)
        try:
            o = r.roster.reject(order_id, p.username, body.reason, r.clock.now())
        except ValueError as e:
            raise HTTPException(409, str(e))
        r._drain_roster(r.clock.now())
    return o.to_dict()


@router.post("/shedding/restore")
async def shed_restore(body: ReasonIn, request: Request, p: Principal = Depends(need("shed"))):
    r = rt(request)
    async with r.lock:
        o = r.roster.restore_all(p.username, body.reason, r.clock.now())
        if not o:
            raise HTTPException(409, "No load-shedding order is open")
        r._drain_roster(r.clock.now())
    return o.to_dict()


class ShedPolicyIn(BaseModel):
    max_spell_min: float | None = Field(None, ge=5, le=240)
    max_daily_min: float | None = Field(None, ge=10, le=600)
    trigger_freq: float | None = Field(None, ge=49.5, le=50.0)
    emergency_freq: float | None = Field(None, ge=49.0, le=50.0)
    min_residual_mw: float | None = Field(None, ge=10, le=1000)
    od_limit_mw: float | None = Field(None, ge=0, le=2000)
    od_limit_follow_dsm: bool | None = None  # true → trigger follows the DSM deviation band again
    dual_auth_mw: float | None = Field(None, ge=0)


@router.put("/shedding/policy")
async def shed_policy(body: ShedPolicyIn, request: Request, p: Principal = Depends(need("config"))):
    r = rt(request)
    async with r.lock:
        upd = body.model_dump(exclude_none=True)
        follow = upd.pop("od_limit_follow_dsm", False)
        for k, v in upd.items():
            setattr(r.roster.policy, k, v)
        if follow:
            r.roster.policy.od_limit_mw = None
        v = await r.store.put_config("shed_policy", asdict(r.roster.policy), p.username, r.clock.now())
        r.audit.append(r.clock.now(), "CONFIG", p.username, f"Load-shedding policy v{v}: {body.model_dump(exclude_none=True)}")
    return asdict(r.roster.policy)


# ---------------------------------------------------------------- what-if sandbox (no side effects)
class WhatIfIn(BaseModel):
    demand_shock_mw: float = 0
    region: str = "STATEWIDE"
    re_drop_mw: float = 0
    freq_offset_hz: float = 0
    outaged_lines: list[str] = []
    bess_availability: float = 1.0
    industrial_compliance: float = 1.0
    rtm_price: float | None = None
    horizon_blocks: int = Field(4, ge=1, le=8)


@router.post("/whatif")
async def whatif(body: WhatIfIn, request: Request, p: Principal = Depends(need("whatif"))):
    r = rt(request)
    if not r.state:
        raise HTTPException(503)
    t = topology()
    s = copy.deepcopy(r.state)
    buses = [b for b in t.internal if body.region == "STATEWIDE" or b.get("region") == body.region]
    tot = sum(b["loadShare"] for b in buses) or 1
    for b in buses:
        s.bus_load[b["id"]] += body.demand_shock_mw * b["loadShare"] / tot
    solar = [g for g in t.generators if g["type"] == "solar"]
    wind = [g for g in t.generators if g["type"] == "wind"]
    ssum = sum(s.gen_output[g["id"]] for g in solar) or 1
    wsum = sum(s.gen_output[g["id"]] for g in wind) or 1
    for g in solar:
        s.gen_output[g["id"]] = max(0.0, s.gen_output[g["id"]] - body.re_drop_mw * 0.7 * s.gen_output[g["id"]] / ssum)
    for g in wind:
        s.gen_output[g["id"]] = max(0.0, s.gen_output[g["id"]] - body.re_drop_mw * 0.3 * s.gen_output[g["id"]] / wsum)
    s.demand_mw = sum(s.bus_load.values())
    s.state_gen_mw = sum(v for k, v in s.gen_output.items() if next(g for g in t.generators if g["id"] == k)["owner"] != "Central")
    s.drawal_mw = s.demand_mw - s.state_gen_mw
    s.re_mw = sum(s.gen_output[g["id"]] for g in solar + wind)
    s.frequency += body.freq_offset_hz - (body.demand_shock_mw + body.re_drop_mw) / 22000
    s.outaged = tuple(sorted(set(s.outaged) | set(body.outaged_lines)))
    if body.rtm_price:
        s.prices.rtm_acp = body.rtm_price
    inj = {b: -v for b, v in s.bus_load.items()}
    for g in t.generators:
        inj[g["bus"]] += s.gen_output[g["id"]]
    s.flow = solve(inj, s.outaged)
    for aid, st in s.asset_state.items():
        st["mw"] = 0.0
    a = assess(s, r.dsm_cfg)
    evals = []
    for x in t.assets:
        x2 = dict(x)
        rel = r.reliability.get(x["id"], x["reliability"])
        if x["type"] == "industrial":
            rel *= body.industrial_compliance
        if x["type"] == "bess":
            x2 = {**x, "maxLoadMW": x["maxLoadMW"] * body.bess_availability}
        evals.append(evaluate(x2, a, body.horizon_blocks, rel, x["id"] in r.engine.out_of_service))

    def run():
        plan = optimize(a, evals, a.requirement_mw, body.horizon_blocks)
        tw = simulate(plan, a, evals, {})
        return plan, tw, compare(a, evals, a.requirement_mw, body.horizon_blocks)

    plan, tw, strategies = await asyncio.to_thread(run)
    return {
        "assessment": {"severity": a.severity, "direction": a.direction, "ace": a.ace.ace, "deviation": a.deviation_mw, "requirement": a.requirement_mw, "frequency": s.frequency, "dsm_per_block_rs": a.dsm.amount_rs, "nr": a.dsm.nr.nr, "margin": a.margin_mw},
        "network": {"max_line": t.line_label(s.flow.max_line), "max_loading": s.flow.max_loading, "loading": s.flow.loading, "islanded": s.flow.islanded},
        "strategies": strategies,
        "plan": {"allocations": [asdict(x) for x in plan.allocations], "costs": plan.costs, "coverage_pct": plan.coverage_pct, "bindings": plan.bindings, "solver": plan.solver, "loading_after": plan.loading_after, "max_loading_after": plan.max_loading_after},
        "twin": {"ok": tw.ok, "checks": [asdict(c) for c in tw.checks]},
        "note": "Sandbox evaluation on a copy of the live state — nothing was dispatched.",
    }


# ---------------------------------------------------------------- reports & audit
@router.get("/reports/summary")
async def report_summary(request: Request, p: Principal = Depends(need("view"))):
    r = rt(request)
    closed = [d for d in r.engine.decisions.values() if d.settlement]
    docs, _ = await r.store.docs("decision", 500)
    ids = {d.id for d in closed}
    hist = [x for x in docs if x.get("settlement") and x["id"] not in ids]
    rows = [d.to_dict() for d in closed] + hist
    tot = lambda k: sum((x["settlement"] or {}).get(k, 0) or 0 for x in rows)  # noqa: E731
    return {
        "decisions": len(rows),
        "avoided_dsm_rs": tot("avoided_dsm_rs"),
        "payments_rs": tot("payments_rs"),
        "net_benefit_rs": tot("net_benefit_rs"),
        "delivered_mwh": tot("delivered_mwh"),
        "expected_mwh": tot("expected_mwh"),
        "forecast_accuracy": (r.forecast or {}).get("accuracy"),
        "items": [
            {
                "id": x["id"],
                "state": x["state"],
                "severity": x["severity"],
                "opened_at": x["opened_at"],
                "closed_at": x["closed_at"],
                "headline": x.get("headline"),
                "closed_reason": x.get("closed_reason"),
                "settlement": {k: v for k, v in (x["settlement"] or {}).items() if k != "rows"},
            }
            for x in sorted(rows, key=lambda x: -(x["closed_at"] or 0))[:100]
        ],
        "reliability": r.reliability,
    }


@router.get("/audit")
async def audit(request: Request, limit: int = Query(50, le=500), offset: int = 0, kind: str | None = None, ref: str | None = None, p: Principal = Depends(need("view"))):
    r = rt(request)
    await r._flush()
    items, total = await r.store.audit_page(limit, offset, kind, ref)
    return {"items": items, "total": total}


@router.get("/audit/verify")
async def audit_verify(request: Request, p: Principal = Depends(need("view"))):
    r = rt(request)
    await r._flush()
    return AuditLog.verify(await r.store.audit_all())


# ---------------------------------------------------------------- admin: sources, simulator, config, users
@router.get("/admin/sources")
async def sources(request: Request, p: Principal = Depends(need("view"))):
    return rt(request).sources()


@router.post("/admin/sources/kptcl/poll")
async def poll_now(request: Request, p: Principal = Depends(need("config"))):
    r = rt(request)
    if not r.kptcl:
        raise HTTPException(409, "KPTCL source not enabled (set KSFP_SOURCE=hybrid)")
    await r.kptcl.cycle(r.clock.now())
    return r.kptcl.health()


class DisturbanceIn(BaseModel):
    kind: str
    params: dict = {}
    duration_min: float = Field(45, ge=1, le=600)
    ramp_min: float = Field(5, ge=0, le=60)
    label: str | None = None


@router.get("/admin/simulator/disturbances")
async def list_dist(request: Request, p: Principal = Depends(need("view"))):
    r = rt(request)
    now = r.clock.now()
    return [d.to_dict(now) for d in sorted(r.field.disturbances, key=lambda d: -d.start)[:50]]


@router.post("/admin/simulator/disturbances")
async def add_dist(body: DisturbanceIn, request: Request, p: Principal = Depends(need("simulator"))):
    r = rt(request)
    allowed = {"demand_surge", "re_drop", "line_trip", "freq_event", "comms_loss", "telemetry_loss", "unit_trip", "price_spike"}
    if body.kind not in allowed:
        raise HTTPException(422, f"kind must be one of {sorted(allowed)}")
    async with r.lock:
        d = r.field.add(Disturbance(body.kind, body.params, r.clock.now(), body.duration_min * 60, body.ramp_min * 60, body.label or body.kind, source=p.username))
        r.audit.append(r.clock.now(), "SYSTEM", p.username, f"Simulator disturbance injected: {d.label} {json.dumps(d.params)}", d.id)
    return d.to_dict(r.clock.now())


@router.delete("/admin/simulator/disturbances/{dist_id}")
async def del_dist(dist_id: str, request: Request, p: Principal = Depends(need("simulator"))):
    r = rt(request)
    async with r.lock:
        ok = r.field.clear(dist_id)
        r.audit.append(r.clock.now(), "SYSTEM", p.username, f"Simulator disturbance ended: {dist_id}", dist_id)
    return {"ok": ok}


@router.get("/admin/config/dsm")
async def get_dsm(request: Request, p: Principal = Depends(need("view"))):
    return rt(request).dsm_cfg


@router.put("/admin/config/dsm")
async def put_dsm(body: dict, request: Request, p: Principal = Depends(need("config"))):
    r = rt(request)
    for k in ("version", "source", "effective_from", "freq_low", "freq_high", "overdrawal", "underdrawal"):
        if k not in body:
            raise HTTPException(422, f"missing '{k}' — a rule table must say what it is, where it comes from and when it applies")
    try:
        cfg = normalise({**{k: v for k, v in DEFAULT_DSM.items() if k not in ("bands",)}, **body})
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    cfg["approved_by"] = body.get("approved_by") or p.username
    async with r.lock:
        r.dsm_cfg = cfg
        v = await r.store.put_config("dsm_rules", r.dsm_cfg, p.username, r.clock.now())
        r.audit.append(r.clock.now(), "CONFIG", p.username, f"DSM rule table v{v} loaded ({body.get('version', 'unversioned')})")
    return {"version": v}


@router.get("/admin/users")
async def users(request: Request, p: Principal = Depends(need("users"))):
    return await rt(request).store.list_users()


# ---------------------------------------------------------------- ops endpoints (unauthenticated for probes)
ops = APIRouter()


@ops.get("/health")
async def health(request: Request):
    return rt(request).health()


@ops.get("/ready")
async def ready(request: Request):
    r = rt(request)
    ok_db = await r.store.ping()
    h = r.health()
    ready_ = ok_db and h["loop_stall_s"] < 5 and r.state is not None
    if not ready_:
        raise HTTPException(503, {"db": ok_db, **h})
    return {"ready": True, **h}


@ops.get("/metrics", response_class=PlainTextResponse)
async def metrics(request: Request):
    return rt(request).metrics.render()


# ---------------------------------------------------------------- websocket
@ops.websocket("/ws")
async def ws(websocket: WebSocket, token: str = ""):
    r = websocket.app.state.runtime
    try:
        p = decode_token(token, r.settings.jwt_secret)
    except Exception:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    sub = r.bus.subscribe("*", maxsize=200)
    last_state = 0.0
    try:
        f = r.frame()
        if f:
            await websocket.send_json(f)
        await websocket.send_json({"type": "hello", "user": p.to_dict(), "server_time": time.time()})
        while True:
            topic, payload = await sub.queue.get()
            if topic == "state.snapshot":
                if time.monotonic() - last_state < 0.9:  # ≤1 Hz per client
                    continue
                last_state = time.monotonic()
                await websocket.send_json(payload)
            else:
                await websocket.send_json({"type": "event", "topic": topic, "data": payload})
    except WebSocketDisconnect:
        pass
    finally:
        r.bus.unsubscribe(sub)


__all__ = ["router", "ops", "Clock"]
