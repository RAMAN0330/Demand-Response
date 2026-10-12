"""Runtime configuration (12-factor: everything from environment variables)."""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _bool(name: str, default: bool) -> bool:
    return _env(name, str(default)).lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    env: str = field(default_factory=lambda: _env("KSFP_ENV", "dev"))
    database_url: str = field(default_factory=lambda: _env("KSFP_DATABASE_URL", "sqlite+aiosqlite:///./data/ksfp.db"))
    jwt_secret: str = field(default_factory=lambda: _env("KSFP_JWT_SECRET", "") or secrets.token_hex(32))
    # command-authentication key shared with field gateways (separate from the session secret); set in production
    command_key: str = field(default_factory=lambda: _env("KSFP_COMMAND_KEY", "") or secrets.token_hex(32))
    command_key_id: str = field(default_factory=lambda: _env("KSFP_COMMAND_KEY_ID", "k1"))
    # sign-in: short access tokens bound to a server-side session; refresh rotates within the session lifetime
    access_ttl_min: float = field(default_factory=lambda: float(_env("KSFP_ACCESS_TTL_MIN", "15")))
    session_hours: float = field(default_factory=lambda: float(_env("KSFP_SESSION_HOURS", "12")))
    remember_days: float = field(default_factory=lambda: float(_env("KSFP_REMEMBER_DAYS", "7")))
    lockout_attempts: int = field(default_factory=lambda: int(_env("KSFP_LOCKOUT_ATTEMPTS", "5")))
    lockout_minutes: float = field(default_factory=lambda: float(_env("KSFP_LOCKOUT_MINUTES", "15")))
    # data source: "simulated" (field simulator) — real adapters (iec104, iccp) plug in at ingest.sources
    source: str = field(default_factory=lambda: _env("KSFP_SOURCE", "simulated"))
    time_scale: float = field(default_factory=lambda: float(_env("KSFP_TIME_SCALE", "20")))
    sim_start: str = field(default_factory=lambda: _env("KSFP_SIM_START", "14:30"))
    auto_disturbances: bool = field(default_factory=lambda: _bool("KSFP_AUTO_DISTURBANCES", True))
    seed: int = field(default_factory=lambda: int(_env("KSFP_SEED", "7")))
    run_loops: bool = field(default_factory=lambda: _bool("KSFP_RUN_LOOPS", True))
    demo_users: bool = field(default_factory=lambda: _bool("KSFP_DEMO_USERS", True))
    cors_origins: str = field(default_factory=lambda: _env("KSFP_CORS_ORIGINS", "*"))


settings = Settings()
