"""GridFlex API — C&I demand response (offers, M&V, disputes), the coordination ledger, KPIs and scenarios."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..gridflex.coordinator import INTERRUPTION_COST_RS_KWH, kpis, ledger, scenario
from ..gridflex.industrial import BASELINE_DESC, BASELINE_METHOD
from ..security.auth import Principal
from .routes import need, rt

gridflex = APIRouter(prefix="/api/v1/gridflex")


@gridflex.get("/overview")
async def overview(request: Request, p: Principal = Depends(need("view"))):
    r = rt(request)
    if r.assessment is None:
        raise HTTPException(503, "State not yet available")
    return {"ledger": ledger(r), "kpis": kpis(r)}


@gridflex.get("/industrial")
async def industrial(request: Request, p: Principal = Depends(need("view"))):
    r = rt(request)
    now = r.clock.now()
    reg = r.industrial
    return {
        "participants": reg.view(now, r.reliability, r.commands.live_setpoints()),
        "offers": sorted((o.to_dict() for o in reg.offers.values()), key=lambda o: -o["submitted_at"]),
        "mv": sorted((m.to_dict() for m in reg.mv.values()), key=lambda m: -m["started"])[:100],
        "baseline": {"method": BASELINE_METHOD, "description": BASELINE_DESC},
        "offered_mw": round(reg.offered_mw(now), 1),
    }


@gridflex.get("/industrial/{pid}/meter")
async def meter(pid: str, request: Request, p: Principal = Depends(need("view"))):
    r = rt(request)
    reg = r.industrial
    if pid not in reg.participants:
        raise HTTPException(404, "unknown participant")
    pts = list(reg.meter.get(pid, ()))[-360:]
    return {"participant": pid, "baseline_mw": round(reg.baseline(pid, r.clock.now()), 1), "points": [{"ts": ts, "mw": round(mw, 1)} for ts, mw in pts]}


class OfferIn(BaseModel):
    participant: str
    mw: float = Field(gt=0)
    window: tuple[str, str] = ("17:00", "23:00")
    response_min: float = Field(15, ge=0, le=240)
    min_activation_min: float = Field(30, ge=0, le=480)
    max_duration_min: float = Field(120, gt=0, le=720)
    recovery_min: float = Field(45, ge=0, le=1440)
    price_rs_mwh: float = Field(gt=0, le=50000)
    availability_rs_mw_h: float = Field(0, ge=0, le=5000)
    reliability: float = Field(0.9, ge=0.05, le=1.0)
    restrictions: str = ""
    kind: str = Field("voluntary", pattern="^(voluntary|committed)$")


@gridflex.post("/offers")
async def submit_offer(body: OfferIn, request: Request, p: Principal = Depends(need("resources"))):
    r = rt(request)
    now = r.clock.now()
    for hm in body.window:
        h, _, m = hm.partition(":")
        if not (h.isdigit() and m.isdigit() and int(h) < 24 and int(m) < 60):
            raise HTTPException(422, f"window time {hm!r} must be HH:MM")
    try:
        async with r.lock:
            o = r.industrial.submit(body.participant, now, **body.model_dump(exclude={"participant"}))
            r.audit.append(now, "CONFIG", p.username, f"GridFlex offer {o.id} recorded for {body.participant}: {o.mw:.0f} MW {o.window[0]}–{o.window[1]} at ₹{o.price_rs_mwh:.0f}/MWh ({o.kind})", o.id)
    except KeyError as e:
        raise HTTPException(404, "unknown participant") from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    return o.to_dict()


class DecideIn(BaseModel):
    note: str = ""


@gridflex.post("/offers/{offer_id}/{action}")
async def decide_offer(offer_id: str, action: str, body: DecideIn, request: Request, p: Principal = Depends(need("resources"))):
    r = rt(request)
    status = {"accept": "ACCEPTED", "reject": "REJECTED", "withdraw": "WITHDRAWN"}.get(action)
    if not status:
        raise HTTPException(404, "action must be accept, reject or withdraw")
    if status == "REJECTED" and len(body.note.strip()) < 3:
        raise HTTPException(422, "a reason is required to reject an offer")
    try:
        async with r.lock:
            o = r.industrial.decide(offer_id, status, p.username, r.clock.now(), body.note)
            r.audit.append(r.clock.now(), "APPROVAL", p.username, f"GridFlex offer {o.id} {status.lower()}" + (f": {body.note}" if body.note else ""), o.id)
    except KeyError as e:
        raise HTTPException(404, "unknown offer") from e
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    return o.to_dict()


class DisputeIn(BaseModel):
    reason: str = Field(min_length=3)


@gridflex.post("/mv/{decision_id}/{pid}/dispute")
async def dispute(decision_id: str, pid: str, body: DisputeIn, request: Request, p: Principal = Depends(need("resources"))):
    r = rt(request)
    try:
        async with r.lock:
            m = r.industrial.dispute(decision_id, pid, body.reason)
            r.audit.append(r.clock.now(), "SETTLEMENT", p.username, f"GridFlex M&V disputed for {pid} in {decision_id}: {body.reason}", decision_id)
    except KeyError as e:
        raise HTTPException(404, "no verification record") from e
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    return m.to_dict()


class ResolveIn(BaseModel):
    outcome: str = Field(min_length=3)
    adjust_rs: float = 0.0


@gridflex.post("/mv/{decision_id}/{pid}/resolve")
async def resolve(decision_id: str, pid: str, body: ResolveIn, request: Request, p: Principal = Depends(need("settle"))):
    r = rt(request)
    try:
        async with r.lock:
            m = r.industrial.resolve(decision_id, pid, body.outcome, body.adjust_rs)
            r.audit.append(r.clock.now(), "SETTLEMENT", p.username, f"GridFlex dispute resolved for {pid} in {decision_id}: {body.outcome} (adjustment ₹{body.adjust_rs:,.0f})", decision_id)
    except KeyError as e:
        raise HTTPException(404, "no verification record") from e
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    return m.to_dict()


class ScenarioIn(BaseModel):
    shortage_mw: float = Field(gt=0, le=5000)
    duration_blocks: int = Field(4, ge=1, le=8)
    participation_pct: float = Field(70, ge=0, le=100)
    interruption_cost_rs_kwh: float = Field(INTERRUPTION_COST_RS_KWH, ge=0, le=500)


@gridflex.post("/scenario")
async def run_scenario(body: ScenarioIn, request: Request, p: Principal = Depends(need("whatif"))):
    r = rt(request)
    if r.state is None:
        raise HTTPException(503, "State not yet available")
    return await asyncio.to_thread(scenario, r, body.shortage_mw, body.duration_blocks, body.participation_pct, body.interruption_cost_rs_kwh)
