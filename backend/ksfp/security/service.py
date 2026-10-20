"""Authentication service: sign-in steps, lockout, sessions with rotating refresh tokens, MFA, account and user admin.

Sign-in is a small state machine; each step returns one of
    {"status": "ok", token, refresh_token, expires_in, user}        signed in
    {"status": "mfa", challenge}                                     second factor needed
    {"status": "password_change", challenge, policy}                 must set a new password first
Challenges are short-lived JWTs of their own type; they cannot be used as access tokens.

Sessions live server-side (auth_sessions). The access token (15 min) carries the session id and is honoured only
while the session is active; the refresh token is `sid.secret`, stored as a SHA-256 hash and rotated on every use.
Presenting an already-rotated refresh token means it was copied: the whole session is revoked.

Lockout: 5 wrong passwords or codes lock an account for 15 minutes. Unknown usernames are counted and locked the same
way in memory, so the lock message does not reveal which accounts exist. A per-address throttle caps failures.
Auth uses wall-clock time (the simulator clock may run fast).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from collections import deque
from dataclasses import dataclass, field

from .auth import (
    POLICY,
    ROLE_LABEL,
    ROLES,
    Principal,
    code_hash,
    decode_claims,
    hash_password,
    issue_token,
    password_issues,
    recovery_codes,
    temp_password,
    totp_secret,
    totp_uri,
    totp_verify,
    verify_password,
)


class AuthError(Exception):
    def __init__(self, status: int, detail: str, **extra):
        super().__init__(detail)
        self.status, self.detail, self.extra = status, detail, extra


def _h(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


@dataclass
class AuthService:
    store: object
    secret: str
    audit: object  # callable(kind, actor, message, ref=None)
    access_min: float = 15.0
    session_hours: float = 12.0
    remember_days: float = 7.0
    lock_threshold: int = 5
    lock_minutes: float = 15.0
    ip_limit: int = 30  # failures per address per 10 minutes
    cache: dict = field(default_factory=dict)  # sid → (active, expires_at, checked_at)
    ghost: dict = field(default_factory=dict)  # unknown username → [failures, locked_until]
    ip_fail: dict = field(default_factory=dict)  # address → deque of failure times

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def now() -> float:
        return time.time()

    def user_view(self, u: dict) -> dict:
        p = Principal(u["username"], u["role"], u["display"])
        return {
            **p.to_dict(),
            "email": u.get("email"),
            "mfa_enabled": bool(u.get("mfa_enabled")),
            "must_change": bool(u.get("must_change")),
            "last_login_at": u.get("last_login_at"),
            "password_changed_at": u.get("password_changed_at"),
            "demo": bool(u.get("demo")),
        }

    def _throttle(self, ip: str) -> None:
        q = self.ip_fail.setdefault(ip, deque())
        cutoff = self.now() - 600
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= self.ip_limit:
            raise AuthError(429, "Too many failed sign-in attempts from this address. Try again in a few minutes.")

    async def _fail(self, username: str, u: dict | None, ip: str, why: str) -> None:
        self.ip_fail.setdefault(ip, deque()).append(self.now())
        until = None
        if u is None:  # unknown account: behave exactly like a real one
            g = self.ghost.setdefault(username.lower(), [0, 0.0])
            g[0] += 1
            if g[0] >= self.lock_threshold:
                g[0], g[1] = 0, self.now() + self.lock_minutes * 60
                until = g[1]
        else:
            n = (u.get("failed_attempts") or 0) + 1
            vals = {"failed_attempts": n}
            if n >= self.lock_threshold:
                until = self.now() + self.lock_minutes * 60
                vals = {"failed_attempts": 0, "locked_until": until}
                self.audit("SECURITY", username, f"Account locked for {self.lock_minutes:.0f} min after {n} failed attempts")
            await self.store.update_user(username, **vals)
        self.audit("SECURITY", username or "?", f"Failed sign-in ({why}) from {ip}")
        if until:
            raise AuthError(423, "Account temporarily locked after repeated failed attempts.", locked_until=until)
        raise AuthError(401, "Invalid username or password." if why == "password" else "Invalid verification code.")

    def _locked(self, username: str, u: dict | None) -> float | None:
        until = (u or {}).get("locked_until") if u else self.ghost.get(username.lower(), [0, 0.0])[1]
        return until if until and until > self.now() else None

    # ------------------------------------------------------------------ sign-in steps
    async def login(self, username: str, password: str, remember: bool, ip: str, agent: str, role: str | None = None) -> dict:
        self._throttle(ip)
        username = username.strip().lower()
        u = await self.store.get_user(username)
        until = self._locked(username, u)
        if until:
            verify_password(password, None)  # same work either way
            raise AuthError(423, "Account temporarily locked after repeated failed attempts.", locked_until=until)
        if not verify_password(password, u["password_hash"] if u else None) or u is None:
            await self._fail(username, u, ip, "password")
        if not u["active"]:
            self.audit("SECURITY", username, "Sign-in refused: account disabled")
            raise AuthError(403, "This account is disabled. Contact your administrator.")
        # the role picked on the sign-in page must be the account's own role (checked only after the password)
        if role and role != u["role"]:
            self.audit("SECURITY", username, f"Sign-in refused: picked role {role}, account role {u['role']}")
            raise AuthError(403, f"This account is not registered as {ROLE_LABEL.get(role, role)}. Pick {ROLE_LABEL.get(u['role'], u['role'])} or use another account.")
        await self.store.update_user(username, failed_attempts=0, locked_until=None)
        return await self._next_step(u, remember, ip, agent)

    async def _next_step(self, u: dict, remember: bool, ip: str, agent: str, done: tuple = ()) -> dict:
        p = Principal(u["username"], u["role"], u["display"])
        if u.get("must_change") and "password" not in done:
            ch = issue_token(p, self.secret, 10, "pwchange", {"rem": remember})
            return {"status": "password_change", "challenge": ch, "policy": POLICY["text"], "user": {"username": p.username, "display": p.display}}
        if u.get("mfa_enabled") and "mfa" not in done:
            ch = issue_token(p, self.secret, 5, "mfa", {"rem": remember})
            return {"status": "mfa", "challenge": ch, "user": {"username": p.username, "display": p.display}}
        return await self._open_session(u, remember, ip, agent)

    async def verify_mfa(self, challenge: str, code: str, ip: str, agent: str) -> dict:
        self._throttle(ip)
        c = self._claims(challenge, "mfa")
        u = await self.store.get_user(c["sub"])
        if not u or not u["active"] or not u.get("mfa_enabled"):
            raise AuthError(401, "Sign-in expired. Start again.")
        if self._locked(u["username"], u):
            raise AuthError(423, "Account temporarily locked after repeated failed attempts.", locked_until=u["locked_until"])
        step = totp_verify(u["mfa_secret"], code, last_step=u.get("mfa_last_step"))
        if step is not None:
            await self.store.update_user(u["username"], mfa_last_step=step, failed_attempts=0)
        else:
            codes = json.loads(u.get("recovery_codes") or "[]")
            h = code_hash(code)
            if h not in codes:
                await self._fail(u["username"], u, ip, "mfa")
            codes.remove(h)
            await self.store.update_user(u["username"], recovery_codes=json.dumps(codes), failed_attempts=0)
            self.audit("SECURITY", u["username"], f"Recovery code used ({len(codes)} left)")
        return await self._next_step(u, bool(c.get("rem")), ip, agent, done=("password", "mfa"))

    async def complete_password_change(self, challenge: str, new_password: str, ip: str, agent: str) -> dict:
        c = self._claims(challenge, "pwchange")
        u = await self.store.get_user(c["sub"])
        if not u or not u["active"] or not u.get("must_change"):
            raise AuthError(401, "Sign-in expired. Start again.")
        await self._set_password(u, new_password, actor=u["username"], why="required change at sign-in")
        u = await self.store.get_user(c["sub"])
        return await self._next_step(u, bool(c.get("rem")), ip, agent, done=("password",))

    def _claims(self, token: str, typ: str) -> dict:
        try:
            return decode_claims(token, self.secret, typ)
        except Exception as e:
            raise AuthError(401, "Sign-in expired. Start again.") from e

    # ------------------------------------------------------------------ sessions
    async def _open_session(self, u: dict, remember: bool, ip: str, agent: str) -> dict:
        now = self.now()
        sid = secrets.token_hex(16)
        sec = secrets.token_urlsafe(32)
        exp = now + (self.remember_days * 86400 if remember else self.session_hours * 3600)
        await self.store.create_session({"id": sid, "username": u["username"], "created_at": now, "last_seen": now, "expires_at": exp, "refresh_hash": _h(sec), "remember": int(remember), "ip": ip[:64], "user_agent": (agent or "")[:256]})
        await self.store.update_user(u["username"], last_login_at=now)
        self.cache[sid] = (True, exp, now)
        self.audit("SECURITY", u["username"], f"Signed in ({u['role']}{', remembered' if remember else ''}) from {ip}", sid)
        return self._tokens(u, sid, f"{sid}.{sec}", exp)

    def _tokens(self, u: dict, sid: str, refresh: str, exp: float) -> dict:
        p = Principal(u["username"], u["role"], u["display"], sid)
        return {"status": "ok", "token": issue_token(p, self.secret, self.access_min), "refresh_token": refresh, "expires_in": int(self.access_min * 60), "session_expires_at": exp, "user": self.user_view(u)}

    async def refresh(self, refresh_token: str) -> dict:
        try:
            sid, sec = refresh_token.split(".", 1)
        except ValueError as e:
            raise AuthError(401, "Session expired. Sign in again.") from e
        s = await self.store.get_session(sid)
        now = self.now()
        if not s or s["revoked_at"] or s["expires_at"] <= now:
            raise AuthError(401, "Session expired. Sign in again.")
        if not hmac.compare_digest(s["refresh_hash"], _h(sec)):
            # an old (already rotated) refresh token came back: it was copied — end the session
            await self.store.update_session(sid, revoked_at=now, revoked_reason="refresh token reuse")
            self.cache[sid] = (False, 0, now)
            self.audit("SECURITY", s["username"], "Session revoked: refresh token reused (possible theft)", sid)
            raise AuthError(401, "Session ended for security reasons. Sign in again.")
        u = await self.store.get_user(s["username"])
        if not u or not u["active"]:
            raise AuthError(401, "Session expired. Sign in again.")
        new = secrets.token_urlsafe(32)
        await self.store.update_session(sid, refresh_hash=_h(new), last_seen=now)
        self.cache[sid] = (True, s["expires_at"], now)
        return self._tokens(u, sid, f"{sid}.{new}", s["expires_at"])

    async def session_active(self, sid: str | None) -> bool:
        if not sid:
            return False
        now = self.now()
        c = self.cache.get(sid)
        if c and now - c[2] < 30:
            return c[0] and c[1] > now
        s = await self.store.get_session(sid)
        ok = bool(s) and not s["revoked_at"] and s["expires_at"] > now
        self.cache[sid] = (ok, s["expires_at"] if s else 0, now)
        return ok

    async def revoke(self, username: str, reason: str, except_sid: str | None = None, sid: str | None = None) -> int:
        now = self.now()
        if sid:
            s = await self.store.get_session(sid)
            if not s or s["username"] != username or s["revoked_at"]:
                raise AuthError(404, "No such active session")
            await self.store.update_session(sid, revoked_at=now, revoked_reason=reason)
            ids = [sid]
        else:
            ids = await self.store.revoke_sessions(username, now, reason, except_sid)
        for i in ids:
            self.cache[i] = (False, 0, now)
        return len(ids)

    async def sessions(self, username: str, current: str | None) -> list[dict]:
        rows = await self.store.list_sessions(username, True, self.now())
        return [{"id": r["id"], "created_at": r["created_at"], "last_seen": r["last_seen"], "expires_at": r["expires_at"], "ip": r["ip"], "user_agent": r["user_agent"], "remember": bool(r["remember"]), "current": r["id"] == current} for r in rows]

    # ------------------------------------------------------------------ account (self-service)
    async def _set_password(self, u: dict, new: str, actor: str, why: str) -> None:
        issues = password_issues(new, u["username"])
        if verify_password(new, u["password_hash"]):
            issues.append("must differ from the current password")
        if issues:
            raise AuthError(422, "Password does not meet the policy: " + "; ".join(issues) + ".", issues=issues)
        await self.store.update_user(u["username"], password_hash=hash_password(new), must_change=0, password_changed_at=self.now(), failed_attempts=0, locked_until=None, demo=0)
        self.audit("SECURITY", actor, f"Password changed for {u['username']} ({why})")

    async def change_password(self, p: Principal, current: str, new: str) -> None:
        u = await self.store.get_user(p.username)
        if not verify_password(current, u["password_hash"]):
            raise AuthError(403, "Current password is incorrect.")
        await self._set_password(u, new, actor=p.username, why="self-service")
        await self.revoke(p.username, "password changed", except_sid=p.sid)

    async def mfa_setup(self, p: Principal, password: str) -> dict:
        u = await self.store.get_user(p.username)
        if not verify_password(password, u["password_hash"]):
            raise AuthError(403, "Password is incorrect.")
        if u.get("mfa_enabled"):
            raise AuthError(409, "Two-factor authentication is already on.")
        sec = totp_secret()
        await self.store.update_user(p.username, mfa_secret=sec, mfa_last_step=None)
        return {"secret": sec, "uri": totp_uri(sec, p.username)}

    async def mfa_enable(self, p: Principal, code: str) -> dict:
        u = await self.store.get_user(p.username)
        if u.get("mfa_enabled") or not u.get("mfa_secret"):
            raise AuthError(409, "Start the set-up first.")
        step = totp_verify(u["mfa_secret"], code)
        if step is None:
            raise AuthError(422, "That code does not match. Check the time on your device and try again.")
        codes = recovery_codes()
        await self.store.update_user(p.username, mfa_enabled=1, mfa_last_step=step, recovery_codes=json.dumps([code_hash(c) for c in codes]))
        self.audit("SECURITY", p.username, "Two-factor authentication enabled")
        return {"recovery_codes": codes}

    async def mfa_disable(self, p: Principal, password: str, code: str) -> None:
        u = await self.store.get_user(p.username)
        if not verify_password(password, u["password_hash"]):
            raise AuthError(403, "Password is incorrect.")
        if not u.get("mfa_enabled"):
            raise AuthError(409, "Two-factor authentication is not on.")
        if totp_verify(u["mfa_secret"], code, last_step=u.get("mfa_last_step")) is None and code_hash(code) not in json.loads(u.get("recovery_codes") or "[]"):
            raise AuthError(422, "Invalid verification code.")
        await self.store.update_user(p.username, mfa_enabled=0, mfa_secret=None, mfa_last_step=None, recovery_codes=None)
        self.audit("SECURITY", p.username, "Two-factor authentication disabled")

    # ------------------------------------------------------------------ administration
    async def list_users(self) -> list[dict]:
        now = self.now()
        out = []
        for u in await self.store.list_users():
            active_sessions = len(await self.store.list_sessions(u["username"], True, now))
            out.append({**self.user_view(u), "active": bool(u["active"]), "created_at": u.get("created_at"), "locked": bool(u.get("locked_until") and u["locked_until"] > now), "locked_until": u.get("locked_until"), "failed_attempts": u.get("failed_attempts") or 0, "sessions": active_sessions})
        return sorted(out, key=lambda x: (not x["active"], x["username"]))

    async def _admins_left(self, excluding: str) -> int:
        return sum(1 for u in await self.store.list_users() if u["role"] == "admin" and u["active"] and u["username"] != excluding)

    async def create_user(self, admin: Principal, username: str, display: str, role: str, email: str | None) -> dict:
        username = username.strip().lower()
        if not username.replace(".", "").replace("_", "").replace("-", "").isalnum() or not 3 <= len(username) <= 32:
            raise AuthError(422, "Username: 3–32 characters, letters, digits, dot, dash or underscore.")
        if role not in ROLES:
            raise AuthError(422, f"Unknown role. Choose one of: {', '.join(ROLE_LABEL[r] for r in ROLES)}.")
        if await self.store.get_user(username):
            raise AuthError(409, "That username is already taken.")
        pw = temp_password()
        await self.store.upsert_user(username, role, display.strip() or username, hash_password(pw), email=(email or None), created_at=self.now(), must_change=1, password_changed_at=self.now())
        self.audit("SECURITY", admin.username, f"User {username} created ({ROLE_LABEL[role]}); one-time password issued")
        return {"username": username, "temporary_password": pw}

    async def update_user(self, admin: Principal, username: str, role: str | None, display: str | None, email: str | None, active: bool | None) -> None:
        u = await self.store.get_user(username)
        if not u:
            raise AuthError(404, "No such user")
        vals: dict = {}
        if role is not None and role != u["role"]:
            if role not in ROLES:
                raise AuthError(422, "Unknown role")
            if u["role"] == "admin" and await self._admins_left(username) == 0:
                raise AuthError(409, "This is the last active administrator: assign another administrator first.")
            vals["role"] = role
        if display is not None:
            vals["display"] = display.strip() or u["display"]
        if email is not None:
            vals["email"] = email.strip() or None
        if active is not None and bool(active) != bool(u["active"]):
            if not active and username == admin.username:
                raise AuthError(409, "You cannot disable your own account.")
            if not active and u["role"] == "admin" and await self._admins_left(username) == 0:
                raise AuthError(409, "This is the last active administrator: assign another administrator first.")
            vals["active"] = int(bool(active))
        if not vals:
            return
        await self.store.update_user(username, **vals)
        if "role" in vals or vals.get("active") == 0:
            await self.revoke(username, "role changed" if "role" in vals else "account disabled")
        self.audit("SECURITY", admin.username, f"User {username} updated: {', '.join(f'{k}={v}' for k, v in vals.items())}")

    async def reset_password(self, admin: Principal, username: str) -> dict:
        u = await self.store.get_user(username)
        if not u:
            raise AuthError(404, "No such user")
        pw = temp_password()
        await self.store.update_user(username, password_hash=hash_password(pw), must_change=1, failed_attempts=0, locked_until=None, password_changed_at=self.now(), demo=0)
        n = await self.revoke(username, "password reset by administrator")
        self.audit("SECURITY", admin.username, f"Password reset for {username}; {n} session(s) ended; one-time password issued")
        return {"username": username, "temporary_password": pw}

    async def unlock(self, admin: Principal, username: str) -> None:
        await self.store.update_user(username, failed_attempts=0, locked_until=None)
        self.audit("SECURITY", admin.username, f"User {username} unlocked")

    async def reset_mfa(self, admin: Principal, username: str) -> None:
        await self.store.update_user(username, mfa_enabled=0, mfa_secret=None, mfa_last_step=None, recovery_codes=None)
        await self.revoke(username, "two-factor reset by administrator")
        self.audit("SECURITY", admin.username, f"Two-factor authentication reset for {username}")

    async def admin_revoke(self, admin: Principal, username: str) -> int:
        n = await self.revoke(username, f"ended by {admin.username}")
        self.audit("SECURITY", admin.username, f"{n} session(s) ended for {username}")
        return n
