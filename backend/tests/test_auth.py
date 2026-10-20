"""Sign-in, sessions, lockout, password policy, MFA and user administration."""

import time

import pytest
from fastapi.testclient import TestClient

from ksfp.core.settings import Settings
from ksfp.main import create_app
from ksfp.security.auth import password_issues, temp_password, totp_code, totp_verify

A = "/api/v1/auth"
STRONG = "Grid-Balance-2026"


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    db = tmp_path_factory.mktemp("db") / "auth.db"
    s = Settings(database_url=f"sqlite+aiosqlite:///{db}", jwt_secret="test-secret-for-auth-suite-0123456789", time_scale=30, auto_disturbances=False, lockout_attempts=3, lockout_minutes=15)
    with TestClient(create_app(s)) as c:
        yield c


def login(c, u, pw=None, remember=False):
    return c.post(A + "/login", json={"username": u, "password": pw if pw is not None else u + "123", "remember": remember})


def bearer(tok):
    return {"Authorization": "Bearer " + tok}


def admin(c):
    return bearer(login(c, "admin").json()["token"])


def new_user(c, name, role="operator"):
    """Create a user and complete the forced first sign-in; returns (headers, login response)."""
    r = c.post("/api/v1/admin/users", headers=admin(c), json={"username": name, "display": name.title(), "role": role})
    assert r.status_code == 200, r.text
    tmp = r.json()["temporary_password"]
    step = login(c, name, tmp).json()
    assert step["status"] == "password_change"
    done = c.post(A + "/password/required", json={"challenge": step["challenge"], "new_password": STRONG}).json()
    assert done["status"] == "ok"
    return bearer(done["token"]), done


def test_policy_and_temp_passwords():
    assert password_issues("short") and password_issues("alllowercaseletters")
    assert "must not contain the username" in password_issues("Operator-2026x", "operator")
    assert "too common" in password_issues("Password123!")
    assert password_issues(STRONG, "someone") == []
    for _ in range(20):
        assert password_issues(temp_password()) == []


def test_totp_window_and_replay():
    sec = "JBSWY3DPEHPK3PXP"
    now = 1_700_000_000.0
    step = int(now // 30)
    assert totp_verify(sec, totp_code(sec, step), now) == step
    assert totp_verify(sec, totp_code(sec, step - 1), now) == step - 1
    assert totp_verify(sec, totp_code(sec, step - 3), now) is None
    assert totp_verify(sec, totp_code(sec, step), now, last_step=step) is None  # replay


def test_public_config_and_demo_login(client):
    cfg = client.get(A + "/config").json()
    assert cfg["demo"] and {d["username"] for d in cfg["demo_users"]} >= {"operator", "admin"}
    r = login(client, "Operator", "operator123").json()  # usernames are case-insensitive
    assert r["status"] == "ok" and r["expires_in"] == 15 * 60 and r["user"]["role"] == "operator"
    assert "." in r["refresh_token"]


def test_uniform_errors_and_lockout(client):
    # unknown and known accounts answer identically, and both lock
    for u in ("ghost-user", "auditor"):
        for _ in range(2):
            r = login(client, u, "wrong-password")
            assert r.status_code == 401 and r.json()["detail"] == "Invalid username or password."
        r = login(client, u, "wrong-password")
        assert r.status_code == 423 and "locked" in r.json()["detail"]["message"]
    assert login(client, "auditor").status_code == 423  # even the right password while locked
    users = client.get("/api/v1/admin/users", headers=admin(client)).json()
    row = next(x for x in users if x["username"] == "auditor")
    assert row["locked"] and "password_hash" not in row and "mfa_secret" not in row
    assert client.post("/api/v1/admin/users/auditor/unlock", headers=admin(client)).status_code == 200
    assert login(client, "auditor").json()["status"] == "ok"


def test_ip_throttle(client):
    svc = client.app.state.runtime.auth
    svc.ip_fail.clear()
    old, svc.ip_limit = svc.ip_limit, 4
    try:
        codes = [login(client, f"nobody{i}", "x").status_code for i in range(5)]
        assert codes[:4] == [401] * 4 and codes[4] == 429
    finally:
        svc.ip_limit = old
        svc.ip_fail.clear()


def test_refresh_rotation_reuse_and_logout(client):
    r = login(client, "manager").json()
    r2 = client.post(A + "/refresh", json={"refresh_token": r["refresh_token"]}).json()
    assert r2["status"] == "ok" and r2["refresh_token"] != r["refresh_token"]
    assert client.get(A + "/me", headers=bearer(r2["token"])).status_code == 200
    # the rotated-out token comes back: treated as stolen, the whole session ends
    assert client.post(A + "/refresh", json={"refresh_token": r["refresh_token"]}).status_code == 401
    assert client.get(A + "/me", headers=bearer(r2["token"])).status_code == 401
    assert client.post(A + "/refresh", json={"refresh_token": r2["refresh_token"]}).status_code == 401
    # logout ends the session for its access token too
    r3 = login(client, "manager").json()
    assert client.post(A + "/logout", headers=bearer(r3["token"])).status_code == 200
    assert client.get("/api/v1/state", headers=bearer(r3["token"])).status_code == 401


def test_challenge_cannot_be_used_as_access_token(client):
    h, _ = new_user(client, "chal.user")
    pw = client.post("/api/v1/admin/users/chal.user/reset-password", headers=admin(client)).json()["temporary_password"]
    step = login(client, "chal.user", pw).json()
    assert step["status"] == "password_change"
    assert client.get(A + "/me", headers=bearer(step["challenge"])).status_code == 401
    assert client.get(A + "/me", headers=h).status_code == 401  # reset ended the earlier session
    bad = client.post(A + "/password/required", json={"challenge": step["challenge"], "new_password": "weak"})
    assert bad.status_code == 422 and bad.json()["detail"]["issues"]


def test_self_service_password_and_sessions(client):
    h, _ = new_user(client, "self.user")
    other = bearer(login(client, "self.user", STRONG).json()["token"])
    assert len(client.get(A + "/sessions", headers=h).json()) == 2
    assert client.post(A + "/password", headers=h, json={"current_password": "nope", "new_password": "Another-Pass-77"}).status_code == 403
    assert client.post(A + "/password", headers=h, json={"current_password": STRONG, "new_password": STRONG}).status_code == 422
    assert client.post(A + "/password", headers=h, json={"current_password": STRONG, "new_password": "Another-Pass-77"}).status_code == 200
    assert client.get(A + "/me", headers=other).status_code == 401  # other sessions ended
    sessions = client.get(A + "/sessions", headers=h).json()
    assert len(sessions) == 1 and sessions[0]["current"]
    assert login(client, "self.user", "Another-Pass-77").json()["status"] == "ok"


def test_mfa_enrol_sign_in_recovery_and_admin_reset(client):
    h, _ = new_user(client, "mfa.user")
    assert client.post(A + "/mfa/setup", headers=h, json={"password": "wrong"}).status_code == 403
    setup = client.post(A + "/mfa/setup", headers=h, json={"password": STRONG}).json()
    sec = setup["secret"]
    assert setup["uri"].startswith("otpauth://totp/ADRMS:mfa.user?")
    assert client.post(A + "/mfa/enable", headers=h, json={"code": "000000"}).status_code in (422,)
    step = int(time.time() // 30)
    codes = client.post(A + "/mfa/enable", headers=h, json={"code": totp_code(sec, step)}).json()["recovery_codes"]
    assert len(codes) == 8

    r = login(client, "mfa.user", STRONG).json()
    assert r["status"] == "mfa" and "token" not in r
    assert client.post(A + "/mfa", json={"challenge": r["challenge"], "code": totp_code(sec, step)}).status_code == 401  # replay
    ok = client.post(A + "/mfa", json={"challenge": r["challenge"], "code": totp_code(sec, step + 1)}).json()
    assert ok["status"] == "ok" and ok["user"]["mfa_enabled"]

    # a recovery code works once
    r = login(client, "mfa.user", STRONG).json()
    assert client.post(A + "/mfa", json={"challenge": r["challenge"], "code": codes[0].upper()}).json()["status"] == "ok"
    r = login(client, "mfa.user", STRONG).json()
    assert client.post(A + "/mfa", json={"challenge": r["challenge"], "code": codes[0]}).status_code == 401

    assert client.post("/api/v1/admin/users/mfa.user/reset-mfa", headers=admin(client)).status_code == 200
    assert login(client, "mfa.user", STRONG).json()["status"] == "ok"


def test_admin_user_management_and_guards(client):
    ad = admin(client)
    assert client.post("/api/v1/admin/users", headers=ad, json={"username": "x", "role": "operator"}).status_code == 422
    assert client.post("/api/v1/admin/users", headers=ad, json={"username": "new.op", "role": "superuser"}).status_code == 422
    h, _ = new_user(client, "new.op")
    assert client.post("/api/v1/admin/users", headers=ad, json={"username": "new.op", "role": "operator"}).status_code == 409
    op = bearer(login(client, "operator").json()["token"])
    assert client.get("/api/v1/admin/users", headers=op).status_code == 403

    # role change ends the user's sessions so the new permissions apply at once
    assert client.patch("/api/v1/admin/users/new.op", headers=ad, json={"role": "auditor", "email": "op@example.org"}).status_code == 200
    assert client.get(A + "/me", headers=h).status_code == 401
    me = client.get(A + "/me", headers=bearer(login(client, "new.op", STRONG).json()["token"])).json()
    assert me["role"] == "auditor" and me["email"] == "op@example.org"

    # disabled accounts cannot sign in
    assert client.patch("/api/v1/admin/users/new.op", headers=ad, json={"active": False}).status_code == 200
    assert login(client, "new.op", STRONG).status_code == 403
    assert client.patch("/api/v1/admin/users/new.op", headers=ad, json={"active": True}).status_code == 200

    # an administrator cannot disable themselves, and the last administrator cannot be demoted
    assert client.patch("/api/v1/admin/users/admin", headers=ad, json={"active": False}).status_code == 409
    assert client.patch("/api/v1/admin/users/admin", headers=ad, json={"role": "operator"}).status_code == 409
    h2, _ = new_user(client, "second.admin", role="admin")
    assert client.patch("/api/v1/admin/users/admin", headers=h2, json={"role": "dr_manager"}).status_code == 200
    assert client.patch("/api/v1/admin/users/admin", headers=h2, json={"role": "admin"}).status_code == 200

    audit = client.get("/api/v1/audit", headers=admin(client), params={"kind": "SECURITY", "limit": 200}).json()
    text = " ".join(e["message"] for e in (audit["items"] if isinstance(audit, dict) else audit))
    assert "User new.op created" in text and "Account locked" in text and "refresh token reused" in text


def test_picked_role_must_match_the_account(client):
    r = client.post(A + "/login", json={"username": "settlement", "password": "settlement123", "role": "admin"})
    assert r.status_code == 403 and "not registered as Administrator" in r.json()["detail"]
    ok = client.post(A + "/login", json={"username": "settlement", "password": "settlement123", "role": "settlement_officer"}).json()
    assert ok["status"] == "ok" and ok["user"]["role_label"] == "Settlement Officer"
    # a wrong password still says nothing about the role
    assert client.post(A + "/login", json={"username": "settlement", "password": "nope", "role": "admin"}).status_code == 401
