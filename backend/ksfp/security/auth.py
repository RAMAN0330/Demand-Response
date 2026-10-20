"""Authentication primitives and role-based access control.

- Passwords: PBKDF2-HMAC-SHA256 (200 000 rounds, per-user salt), checked in constant time; a password policy
  (length, character classes, no username, not a common password).
- Tokens: short-lived access JWT (HS256) bound to a server-side session id (`sid`); refresh tokens are opaque,
  stored only as a hash and rotated on every use (see service.py). Challenge tokens (MFA, forced password
  change) are separate JWT types that cannot be used as access tokens.
- Second factor: TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step, replay-protected) plus one-time recovery codes.

Production: front this with the utility identity provider (OIDC / LDAP / SAML) and keep RBAC here.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import struct
import time
from dataclasses import dataclass

import jwt

# SLDC / DR roles. Separation of duties: operators act, the shift-in-charge authorises, the programme manager owns
# participants and offers, the settlement officer closes money, the auditor only reads, the administrator manages access.
ROLES: dict[str, set[str]] = {
    "operator": {"view", "ack_alarm", "approve", "reject", "abort", "whatif", "shed_propose"},
    "shift_in_charge": {"view", "ack_alarm", "shelve_alarm", "approve", "approve_dual", "reject", "abort", "autonomy", "whatif", "resources", "shed_propose", "shed", "simulator", "reports"},
    "dr_manager": {"view", "whatif", "reports", "resources", "simulator"},
    "settlement_officer": {"view", "reports", "settle"},
    "auditor": {"view", "reports", "audit"},
    "admin": {"view", "ack_alarm", "shelve_alarm", "approve", "approve_dual", "reject", "abort", "autonomy", "whatif", "reports", "config", "simulator", "resources", "users", "shed_propose", "shed", "settle", "audit"},
}

ROLE_LABEL = {
    "operator": "SLDC Operator",
    "shift_in_charge": "Shift In-charge",
    "dr_manager": "DR Programme Manager",
    "settlement_officer": "Settlement Officer",
    "auditor": "Auditor",
    "admin": "Administrator",
}

# roles from earlier releases, mapped onto the current set at start-up
LEGACY_ROLES = {"analyst": "auditor", "engineer": "dr_manager"}

DEMO_USERS = [
    ("operator", "operator", "SLDC Operator (demo)"),
    ("sic", "shift_in_charge", "Shift In-charge (demo)"),
    ("manager", "dr_manager", "DR Programme Manager (demo)"),
    ("settlement", "settlement_officer", "Settlement Officer (demo)"),
    ("auditor", "auditor", "Auditor (demo)"),
    ("admin", "admin", "Administrator (demo)"),
]

# ------------------------------------------------------------------ passwords
_DUMMY = None  # a real hash to verify against for unknown users, so timing does not reveal who exists


def hash_password(password: str, salt: bytes | None = None, rounds: int = 200_000) -> str:
    salt = salt or os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, rounds)
    return f"pbkdf2_sha256${rounds}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    global _DUMMY
    if not stored or stored.count("$") != 3:
        _DUMMY = _DUMMY or hash_password("not-a-real-password")
        stored, ok = _DUMMY, False
    else:
        ok = True
    try:
        _, rounds, salt, dk = stored.split("$")
        test = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds))
        return ok and hmac.compare_digest(test.hex(), dk)
    except Exception:
        return False


COMMON = {
    "password", "password1", "password123", "passw0rd", "welcome", "welcome1", "welcome123", "qwerty", "qwerty123", "letmein",
    "admin", "admin123", "administrator", "changeme", "iloveyou", "12345678", "123456789", "1234567890", "abc123", "monkey",
    "dragon", "sunshine", "football", "baseball", "superman", "trustno1", "master", "secret", "login", "india123",
}
POLICY = {"min_length": 10, "classes": 3, "text": "At least 10 characters, using 3 of: lowercase, uppercase, digits, symbols; not your username; not a common password."}


def password_issues(password: str, username: str = "") -> list[str]:
    """Empty list = acceptable. Each entry is a human-readable reason."""
    out = []
    if len(password) < POLICY["min_length"]:
        out.append(f"at least {POLICY['min_length']} characters")
    classes = sum([any(c.islower() for c in password), any(c.isupper() for c in password), any(c.isdigit() for c in password), any(not c.isalnum() for c in password)])
    if classes < POLICY["classes"]:
        out.append("3 of: lowercase, uppercase, digits, symbols")
    if username and username.lower() in password.lower():
        out.append("must not contain the username")
    if password.lower() in COMMON or password.lower().rstrip("!0123456789") in COMMON:
        out.append("too common")
    return out


def temp_password() -> str:
    """A readable one-time password that satisfies the policy (shown to the administrator once)."""
    alphabet = "abcdefghjkmnpqrstuvwxyz"
    words = ["".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(3)]
    return f"{words[0].capitalize()}-{words[1]}-{words[2]}-{secrets.randbelow(90) + 10}"


# ------------------------------------------------------------------ TOTP (RFC 6238) and recovery codes
def totp_secret() -> str:
    return base64.b32encode(os.urandom(20)).decode().rstrip("=")


def _b32(secret: str) -> bytes:
    return base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)


def totp_code(secret: str, step: int, digits: int = 6) -> str:
    h = hmac.new(_b32(secret), struct.pack(">Q", step), hashlib.sha1).digest()
    o = h[-1] & 0x0F
    v = (struct.unpack(">I", h[o : o + 4])[0] & 0x7FFFFFFF) % 10**digits
    return f"{v:0{digits}d}"


def totp_verify(secret: str, code: str, now: float | None = None, last_step: int | None = None, window: int = 1) -> int | None:
    """Returns the matched time step, or None. A step at or before `last_step` is rejected (no replay)."""
    code = "".join(ch for ch in code if ch.isdigit())
    if len(code) != 6:
        return None
    step = int((now if now is not None else time.time()) // 30)
    for s in range(step - window, step + window + 1):
        if last_step is not None and s <= last_step:
            continue
        if hmac.compare_digest(totp_code(secret, s), code):
            return s
    return None


def totp_uri(secret: str, username: str, issuer: str = "ADRMS") -> str:
    return f"otpauth://totp/{issuer}:{username}?secret={secret}&issuer={issuer}&algorithm=SHA1&digits=6&period=30"


def recovery_codes(n: int = 8) -> list[str]:
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return ["-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(2)) for _ in range(n)]


def code_hash(code: str) -> str:
    return hashlib.sha256(code.strip().lower().replace(" ", "").encode()).hexdigest()


# ------------------------------------------------------------------ principals and tokens
@dataclass
class Principal:
    username: str
    role: str
    display: str
    sid: str | None = None

    @property
    def permissions(self) -> set[str]:
        return ROLES.get(self.role, set())

    def can(self, perm: str) -> bool:
        return perm in self.permissions

    def to_dict(self) -> dict:
        return {"username": self.username, "role": self.role, "role_label": ROLE_LABEL.get(self.role, self.role), "display": self.display, "permissions": sorted(self.permissions)}


def issue_token(p: Principal, secret: str, ttl_min: float, typ: str = "access", extra: dict | None = None) -> str:
    now = int(time.time())
    body = {"sub": p.username, "role": p.role, "name": p.display, "typ": typ, "iat": now, "exp": now + int(ttl_min * 60), "jti": secrets.token_hex(8)}
    if p.sid:
        body["sid"] = p.sid
    body.update(extra or {})
    return jwt.encode(body, secret, algorithm="HS256")


def decode_token(token: str, secret: str, typ: str = "access") -> Principal:
    data = jwt.decode(token, secret, algorithms=["HS256"])
    if data.get("typ", "access") != typ:
        raise jwt.InvalidTokenError(f"not a{'n' if typ[0] in 'aeiou' else ''} {typ} token")
    return Principal(data["sub"], data["role"], data.get("name", data["sub"]), data.get("sid"))


def decode_claims(token: str, secret: str, typ: str) -> dict:
    data = jwt.decode(token, secret, algorithms=["HS256"])
    if data.get("typ") != typ:
        raise jwt.InvalidTokenError(f"not a {typ} token")
    return data
