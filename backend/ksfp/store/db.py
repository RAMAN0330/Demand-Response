"""Persistence (SQLAlchemy async). SQLite for dev, PostgreSQL (+TimescaleDB) in production.

Write path is asynchronous write-behind: the control loop never waits on the database. If the
database is unavailable the platform keeps operating from memory, buffers writes, raises an
alarm and retries.

Tiers: hot (in-memory ring buffers) · warm (1-minute aggregates) · cold (documents + audit).
"""

from __future__ import annotations

import json
import os
from typing import Any

from sqlalchemy import JSON, Column, Float, Integer, MetaData, String, Table, Text, select, text
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

meta = MetaData()

users = Table(
    "users",
    meta,
    Column("username", String(64), primary_key=True),
    Column("role", String(32), nullable=False),
    Column("display", String(128), nullable=False),
    Column("password_hash", String(256), nullable=False),
    Column("active", Integer, nullable=False, default=1),
    # security state (added by migration on existing databases)
    Column("email", String(256)),
    Column("created_at", Float),
    Column("last_login_at", Float),
    Column("password_changed_at", Float),
    Column("failed_attempts", Integer, default=0),
    Column("locked_until", Float),
    Column("must_change", Integer, default=0),
    Column("mfa_enabled", Integer, default=0),
    Column("mfa_secret", String(64)),
    Column("mfa_last_step", Integer),
    Column("recovery_codes", Text),  # JSON list of SHA-256 hashes, each usable once
    Column("demo", Integer, default=0),
)
USER_MIGRATIONS = {
    "email": "VARCHAR(256)", "created_at": "REAL", "last_login_at": "REAL", "password_changed_at": "REAL",
    "failed_attempts": "INTEGER DEFAULT 0", "locked_until": "REAL", "must_change": "INTEGER DEFAULT 0",
    "mfa_enabled": "INTEGER DEFAULT 0", "mfa_secret": "VARCHAR(64)", "mfa_last_step": "INTEGER", "recovery_codes": "TEXT", "demo": "INTEGER DEFAULT 0",
}

sessions = Table(
    "auth_sessions",
    meta,
    Column("id", String(40), primary_key=True),
    Column("username", String(64), nullable=False, index=True),
    Column("created_at", Float, nullable=False),
    Column("last_seen", Float, nullable=False),
    Column("expires_at", Float, nullable=False),
    Column("refresh_hash", String(64), nullable=False),
    Column("remember", Integer, default=0),
    Column("ip", String(64)),
    Column("user_agent", String(256)),
    Column("revoked_at", Float),
    Column("revoked_reason", String(128)),
)

audit = Table(
    "audit_log",
    meta,
    Column("seq", Integer, primary_key=True),
    Column("ts", Float, nullable=False, index=True),
    Column("kind", String(24), nullable=False, index=True),
    Column("actor", String(64), nullable=False),
    Column("ref", String(64), index=True),
    Column("message", Text, nullable=False),
    Column("prev", String(64), nullable=False),
    Column("hash", String(64), nullable=False),
)

documents = Table(  # decisions, alarms, incidents, commands — upserted JSON documents
    "documents",
    meta,
    Column("kind", String(24), primary_key=True),
    Column("id", String(48), primary_key=True),
    Column("ts", Float, nullable=False, index=True),
    Column("state", String(32), index=True),
    Column("doc", JSON, nullable=False),
)

telemetry_1m = Table(
    "telemetry_1m",
    meta,
    Column("ts", Float, primary_key=True),
    Column("key", String(64), primary_key=True),
    Column("avg", Float),
    Column("min", Float),
    Column("max", Float),
)

config = Table(
    "config",
    meta,
    Column("key", String(64), primary_key=True),
    Column("version", Integer, nullable=False),
    Column("value", JSON, nullable=False),
    Column("updated_by", String(64)),
    Column("ts", Float),
)

reliability = Table(
    "reliability",
    meta,
    Column("asset_id", String(32), primary_key=True),
    Column("value", Float, nullable=False),
    Column("ts", Float),
)


class Store:
    def __init__(self, url: str) -> None:
        if url.startswith("sqlite"):
            path = url.split("///")[-1]
            d = os.path.dirname(path)
            if d:
                os.makedirs(d, exist_ok=True)
        self.url = url
        self.engine: AsyncEngine = create_async_engine(url, future=True, pool_pre_ping=True)
        self.healthy = False
        self.failures = 0
        self.buffer: list[tuple[str, Any]] = []

    @property
    def dialect(self) -> str:
        return self.engine.dialect.name

    async def init(self) -> None:
        async with self.engine.begin() as conn:
            await conn.run_sync(meta.create_all)
            # in-place migration: add security columns to a users table created by an older version
            have = await conn.run_sync(lambda c: {col["name"] for col in sa_inspect(c).get_columns("users")})
            for name, ddl in USER_MIGRATIONS.items():
                if name not in have:
                    await conn.execute(text(f"ALTER TABLE users ADD COLUMN {name} {ddl}"))
            if self.dialect == "postgresql":  # optional TimescaleDB hypertable for telemetry
                try:
                    await conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb"))
                    await conn.execute(text("SELECT create_hypertable('telemetry_1m','ts', chunk_time_interval => 86400, if_not_exists => TRUE, migrate_data => TRUE)"))
                except Exception:
                    pass
        self.healthy = True

    async def ping(self) -> bool:
        try:
            async with self.engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            self.healthy = True
        except Exception:
            self.healthy = False
        return self.healthy

    # ------------------------------------------------------------------ users
    async def get_user(self, username: str) -> dict | None:
        async with self.engine.connect() as conn:
            r = (await conn.execute(select(users).where(users.c.username == username))).mappings().first()
            return dict(r) if r else None

    async def list_users(self) -> list[dict]:
        async with self.engine.connect() as conn:
            rows = (await conn.execute(select(users))).mappings().all()
            return [dict(r) for r in rows]

    async def upsert_user(self, username: str, role: str, display: str, password_hash: str | None, **extra: Any) -> None:
        async with self.engine.begin() as conn:
            existing = (await conn.execute(select(users.c.password_hash).where(users.c.username == username))).first()
            if existing:
                vals: dict[str, Any] = {"role": role, "display": display, **extra}
                if password_hash:
                    vals["password_hash"] = password_hash
                await conn.execute(users.update().where(users.c.username == username).values(**vals))
            else:
                await conn.execute(users.insert().values(**{"username": username, "role": role, "display": display, "password_hash": password_hash or "!", "active": 1, "failed_attempts": 0, "must_change": 0, "mfa_enabled": 0, "demo": 0, **extra}))

    async def update_user(self, username: str, **vals: Any) -> None:
        async with self.engine.begin() as conn:
            await conn.execute(users.update().where(users.c.username == username).values(**vals))

    # ------------------------------------------------------------------ sessions
    async def create_session(self, row: dict) -> None:
        async with self.engine.begin() as conn:
            await conn.execute(sessions.insert().values(**row))

    async def get_session(self, sid: str) -> dict | None:
        async with self.engine.connect() as conn:
            r = (await conn.execute(select(sessions).where(sessions.c.id == sid))).mappings().first()
            return dict(r) if r else None

    async def update_session(self, sid: str, **vals: Any) -> None:
        async with self.engine.begin() as conn:
            await conn.execute(sessions.update().where(sessions.c.id == sid).values(**vals))

    async def list_sessions(self, username: str | None = None, active_only: bool = True, now: float = 0.0) -> list[dict]:
        q = select(sessions)
        if username:
            q = q.where(sessions.c.username == username)
        if active_only:
            q = q.where(sessions.c.revoked_at.is_(None)).where(sessions.c.expires_at > now)
        async with self.engine.connect() as conn:
            rows = (await conn.execute(q.order_by(sessions.c.last_seen.desc()))).mappings().all()
            return [dict(r) for r in rows]

    async def revoke_sessions(self, username: str, now: float, reason: str, except_sid: str | None = None) -> list[str]:
        async with self.engine.begin() as conn:
            q = select(sessions.c.id).where(sessions.c.username == username).where(sessions.c.revoked_at.is_(None))
            ids = [r[0] for r in (await conn.execute(q)).all() if r[0] != except_sid]
            if ids:
                await conn.execute(sessions.update().where(sessions.c.id.in_(ids)).values(revoked_at=now, revoked_reason=reason))
            return ids

    # ------------------------------------------------------------------ write-behind
    async def flush(self, audit_rows: list[dict], docs: list[tuple[str, str, float, str, dict]], telem: list[tuple[float, str, float, float, float]]) -> None:
        async with self.engine.begin() as conn:
            if audit_rows:
                await conn.execute(audit.insert(), audit_rows)
            for kind, id_, ts, state, doc in docs:
                await conn.execute(documents.delete().where(documents.c.kind == kind, documents.c.id == id_))
                await conn.execute(documents.insert().values(kind=kind, id=id_, ts=ts, state=state, doc=json.loads(json.dumps(doc, default=str))))
            if telem:
                await conn.execute(telemetry_1m.insert(), [{"ts": t, "key": k, "avg": a, "min": mn, "max": mx} for t, k, a, mn, mx in telem])

    # ------------------------------------------------------------------ reads
    async def audit_page(self, limit: int, offset: int, kind: str | None, ref: str | None) -> tuple[list[dict], int]:
        async with self.engine.connect() as conn:
            q = select(audit)
            cq = select(audit.c.seq)
            if kind:
                q, cq = q.where(audit.c.kind == kind), cq.where(audit.c.kind == kind)
            if ref:
                q, cq = q.where(audit.c.ref == ref), cq.where(audit.c.ref == ref)
            rows = (await conn.execute(q.order_by(audit.c.seq.desc()).limit(limit).offset(offset))).mappings().all()
            total = len((await conn.execute(cq)).all())
            return [dict(r) for r in rows], total

    async def audit_all(self) -> list[dict]:
        async with self.engine.connect() as conn:
            return [dict(r) for r in (await conn.execute(select(audit).order_by(audit.c.seq))).mappings().all()]

    async def audit_head(self) -> tuple[int, str] | None:
        async with self.engine.connect() as conn:
            r = (await conn.execute(select(audit.c.seq, audit.c.hash).order_by(audit.c.seq.desc()).limit(1))).first()
            return (r[0], r[1]) if r else None

    async def docs(self, kind: str, limit: int = 100, offset: int = 0, state: str | None = None) -> tuple[list[dict], int]:
        async with self.engine.connect() as conn:
            q = select(documents.c.doc).where(documents.c.kind == kind)
            cq = select(documents.c.id).where(documents.c.kind == kind)
            if state:
                q, cq = q.where(documents.c.state == state), cq.where(documents.c.state == state)
            rows = (await conn.execute(q.order_by(documents.c.ts.desc()).limit(limit).offset(offset))).all()
            total = len((await conn.execute(cq)).all())
            return [r[0] for r in rows], total

    async def telemetry(self, key: str, since: float) -> list[dict]:
        async with self.engine.connect() as conn:
            rows = (await conn.execute(select(telemetry_1m).where(telemetry_1m.c.key == key, telemetry_1m.c.ts >= since).order_by(telemetry_1m.c.ts))).mappings().all()
            return [dict(r) for r in rows]

    async def get_config(self, key: str) -> dict | None:
        async with self.engine.connect() as conn:
            r = (await conn.execute(select(config).where(config.c.key == key))).mappings().first()
            return dict(r) if r else None

    async def put_config(self, key: str, value: Any, user: str, ts: float) -> int:
        async with self.engine.begin() as conn:
            r = (await conn.execute(select(config.c.version).where(config.c.key == key))).first()
            v = (r[0] + 1) if r else 1
            await conn.execute(config.delete().where(config.c.key == key))
            await conn.execute(config.insert().values(key=key, version=v, value=value, updated_by=user, ts=ts))
            return v

    async def load_reliability(self) -> dict[str, float]:
        async with self.engine.connect() as conn:
            return {r[0]: r[1] for r in (await conn.execute(select(reliability.c.asset_id, reliability.c.value))).all()}

    async def save_reliability(self, values: dict[str, float], ts: float) -> None:
        async with self.engine.begin() as conn:
            for k, v in values.items():
                await conn.execute(reliability.delete().where(reliability.c.asset_id == k))
                await conn.execute(reliability.insert().values(asset_id=k, value=v, ts=ts))
