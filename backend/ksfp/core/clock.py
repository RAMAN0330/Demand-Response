"""Injectable clock. Real deployments use wall time; the simulated source may accelerate it."""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
BLOCK_S = 15 * 60


class Clock:
    def __init__(self, time_scale: float = 1.0, start_hhmm: str | None = None) -> None:
        self.time_scale = time_scale
        self._real0 = time.monotonic()
        now = datetime.now(IST)
        if start_hhmm:
            h, m = (int(x) for x in start_hhmm.split(":"))
            now = now.replace(hour=h, minute=m, second=0, microsecond=0)
        self._sim0 = now.timestamp()

    def now(self) -> float:
        """Simulation-aware epoch seconds."""
        return self._sim0 + (time.monotonic() - self._real0) * self.time_scale

    def set_scale(self, time_scale: float) -> None:
        """Change speed without a jump: re-anchor the simulated time at the current instant."""
        self._sim0 = self.now()
        self._real0 = time.monotonic()
        self.time_scale = time_scale

    def dt(self) -> datetime:
        return datetime.fromtimestamp(self.now(), IST)

    def real_seconds(self, sim_seconds: float) -> float:
        return sim_seconds / self.time_scale

    @staticmethod
    def block_of(ts: float) -> int:
        d = datetime.fromtimestamp(ts, IST)
        return (d.hour * 60 + d.minute) // 15 + 1

    @staticmethod
    def block_start(ts: float) -> float:
        return ts - (ts % BLOCK_S)

    @staticmethod
    def hhmmss(ts: float) -> str:
        return datetime.fromtimestamp(ts, IST).strftime("%H:%M:%S")

    @staticmethod
    def hour_of_day(ts: float) -> float:
        d = datetime.fromtimestamp(ts, IST)
        return d.hour + d.minute / 60 + d.second / 3600
