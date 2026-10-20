"""API smoke tests (in-process app with live loops)."""

import time

import pytest
from fastapi.testclient import TestClient

from ksfp.core.settings import Settings
from ksfp.main import create_app


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    db = tmp_path_factory.mktemp("db") / "t.db"
    s = Settings(database_url=f"sqlite+aiosqlite:///{db}", jwt_secret="test", time_scale=30, auto_disturbances=False)
    with TestClient(create_app(s)) as c:
        time.sleep(2.5)
        yield c


def token(c, u):
    return {"Authorization": "Bearer " + c.post("/api/v1/auth/login", json={"username": u, "password": u + "123"}).json()["token"]}


def test_probes(client):
    assert client.get("/health").json()["status"] == "ok"
    assert client.get("/ready").status_code == 200
    assert "ksfp_loop_ms" in client.get("/metrics").text


def test_auth_and_rbac(client):
    assert client.get("/api/v1/state").status_code == 401
    assert client.post("/api/v1/auth/login", json={"username": "operator", "password": "nope"}).status_code == 401
    an = token(client, "auditor")
    assert client.get("/api/v1/state", headers=an).status_code == 200
    assert client.post("/api/v1/autonomy/suspend", headers=an, json={"reason": "test"}).status_code == 403


def test_state_overview_topology(client):
    op = token(client, "operator")
    st = client.get("/api/v1/state", headers=op).json()
    assert st["severity"] in ("NORMAL", "ALERT", "EMERGENCY") and len(st["channels"]) >= 100
    ov = client.get("/api/v1/overview", headers=op).json()
    assert set(ov) == {"now", "risk", "next", "intent"}
    topo = client.get("/api/v1/topology", headers=op).json()
    assert len(topo["channels"]["load_channels"]) == 90


def test_whatif_has_no_side_effects(client):
    an = token(client, "manager")
    before = len(client.get("/api/v1/commands", headers=an).json()["items"])
    r = client.post("/api/v1/whatif", headers=an, json={"re_drop_mw": 900}).json()
    assert r["assessment"]["requirement"] > 300 and r["plan"]["solver"]["status"] == 0
    assert len(client.get("/api/v1/commands", headers=an).json()["items"]) == before


def test_kill_switch_and_audit(client):
    sic = token(client, "sic")
    assert client.post("/api/v1/autonomy/suspend", headers=sic, json={"reason": "drill"}).json()["suspended"]
    assert client.get("/api/v1/autonomy", headers=sic).json()["effective"] <= 1
    client.post("/api/v1/autonomy/resume", headers=sic)
    assert client.get("/api/v1/audit/verify", headers=sic).status_code == 403  # verifying the chain is the auditor's job
    assert client.get("/api/v1/audit/verify", headers=token(client, "auditor")).json()["ok"]


def test_roles_separate_duties(client):
    roles = {r["role"]: set(r["permissions"]) for r in client.get("/api/v1/admin/roles", headers=token(client, "admin")).json()}
    assert set(roles) == {"operator", "shift_in_charge", "dr_manager", "settlement_officer", "auditor", "admin"}
    # the auditor can read everything and change nothing
    assert roles["auditor"] == {"view", "reports", "audit"}
    au = token(client, "auditor")
    assert client.get("/api/v1/gridflex/industrial", headers=au).status_code == 200
    assert client.post("/api/v1/whatif", headers=au, json={"re_drop_mw": 100}).status_code == 403
    # only the settlement officer (or admin) resolves an M&V dispute; the programme manager cannot
    body = {"outcome": "upheld", "adjust_rs": 0}
    assert client.post("/api/v1/gridflex/mv/X/Y/resolve", headers=token(client, "manager"), json=body).status_code == 403
    assert client.post("/api/v1/gridflex/mv/X/Y/resolve", headers=token(client, "settlement"), json=body).status_code == 404


def test_simulator_scenarios_clock_and_all_clear(client):
    en = token(client, "manager")
    an = token(client, "auditor")
    sc = client.get("/api/v1/admin/simulator/scenarios", headers=an).json()
    assert len(sc) >= 4 and all(s["steps"] for s in sc)
    assert client.post("/api/v1/admin/simulator/scenarios/evening_peak", headers=an).status_code == 403
    run = client.post("/api/v1/admin/simulator/scenarios/evening_peak", headers=en).json()
    ds = run["disturbances"]
    assert len(ds) == 3 and ds[0]["active"] and ds[1]["pending"]
    # speed change keeps simulated time continuous
    t0 = client.get("/api/v1/admin/simulator/clock", headers=an).json()["now"]
    ck = client.put("/api/v1/admin/simulator/clock", headers=en, json={"time_scale": 60}).json()
    assert ck["time_scale"] == 60 and ck["now"] >= t0 and ck["now"] - t0 < 600
    assert client.put("/api/v1/admin/simulator/clock", headers=en, json={"time_scale": 0}).status_code == 422
    client.put("/api/v1/admin/simulator/clock", headers=en, json={"time_scale": 30})
    ended = client.delete("/api/v1/admin/simulator/disturbances", headers=en).json()["ended"]
    assert {d["id"] for d in ds} <= set(ended)
    left = client.get("/api/v1/admin/simulator/disturbances", headers=an).json()
    assert not any(d["pending"] or (d["active"] and d["id"] in ended and d["intensity"] > 0.5) for d in left)
