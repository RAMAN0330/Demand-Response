"""ASGI entrypoint: `uvicorn ksfp.main:app`."""

from __future__ import annotations

import json
import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.routes import ops, router
from .core.settings import Settings, settings
from .runtime import Runtime


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return json.dumps({"ts": self.formatTime(record), "level": record.levelname, "logger": record.name, "msg": record.getMessage()})


def configure_logging() -> None:
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(JsonFormatter())
    logging.basicConfig(level=logging.INFO, handlers=[h], force=True)


def create_app(cfg: Settings | None = None) -> FastAPI:
    cfg = cfg or settings

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runtime = Runtime(cfg)
        app.state.runtime = runtime
        await runtime.start()
        yield
        await runtime.stop()

    app = FastAPI(title="ADRMS API — Automated Demand Response Management System", version="1.0.0", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in cfg.cors_origins.split(",")], allow_methods=["*"], allow_headers=["*"])
    app.include_router(router)
    app.include_router(ops)
    return app


configure_logging()
app = create_app()
