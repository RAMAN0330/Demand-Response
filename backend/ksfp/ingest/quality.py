"""Data-quality layer: validation, spike rejection, staleness, substitution, confidence.

Every value that leaves this layer carries a quality flag:
  GOOD · SUBSTITUTED (held last-good within TTL) · STALE (beyond TTL, estimated) ·
  SUSPECT (failed range/spike check, last-good used) · MISSING (never received)
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..grid.topology import topology

FRESH_S = 10.0  # a value is GOOD only while its *source* timestamp is this recent (IEGC: ACE archived ≤10 s)
QUALITY_WEIGHT = {"GOOD": 1.0, "SUBSTITUTED": 0.85, "SUSPECT": 0.5, "STALE": 0.3, "MISSING": 0.0}


@dataclass
class PointRule:
    lo: float
    hi: float
    max_rate: float  # max plausible change per second (sim)
    ttl_s: float  # beyond this the value is STALE


def rule_for(key: str) -> PointRule:
    if key == "sys.frequency":
        return PointRule(48.5, 51.5, 0.02, 30)
    if key == "sys.schedule":
        return PointRule(0, 30000, 50, 1800)
    if key.startswith("price."):
        return PointRule(0, 20, 1, 3600)
    if key.startswith("bus."):
        return PointRule(-500, 6000, 20, 60)
    if key.startswith("gen."):
        return PointRule(0, 3000, 25, 60)
    if key.endswith(".soc"):
        return PointRule(0, 1, 0.01, 120)
    if key.endswith(".hb"):  # heartbeat = epoch seconds of last gateway contact
        return PointRule(0, 1e11, 1e11, 1e11)
    if key.startswith("asset."):
        return PointRule(-5000, 5000, 1e6, 120)
    return PointRule(-1e6, 1e9, 1e9, 120)


@dataclass
class PointState:
    value: float | None = None
    ts: float = 0.0
    quality: str = "MISSING"
    rejected: int = 0


@dataclass
class QualityLayer:
    points: dict[str, PointState] = field(default_factory=dict)
    expected: list[str] = field(default_factory=list)
    stats: dict[str, int] = field(default_factory=lambda: {"received": 0, "rejected": 0, "stale": 0})

    def __post_init__(self) -> None:
        t = topology()
        self.expected = (
            ["sys.frequency", "sys.schedule"]
            + [f"bus.{b['id']}.load" for b in t.internal]
            + [f"gen.{g['id']}.mw" for g in t.generators]
        )

    def process(self, raw: dict[str, float], now: float, src_ts: dict[str, float] | None = None) -> dict[str, tuple[float | None, str]]:
        """src_ts: when each value was *measured/fetched* at the source. Ages are measured from that, never from
        when the platform happened to read it — re-reading a 5-minute-old web value does not make it fresh."""
        out: dict[str, tuple[float | None, str]] = {}
        src_ts = src_ts or {}
        for k, v in raw.items():
            ts_k = min(now, src_ts.get(k, now))
            ps = self.points.setdefault(k, PointState())
            if ps.value is not None and ts_k <= ps.ts:
                continue  # same (or older) sample re-delivered: nothing new, keep its original age
            self.stats["received"] += 1
            rule = rule_for(k)
            bad_range = not (rule.lo <= v <= rule.hi)
            bad_spike = False
            if ps.value is not None and ps.quality in ("GOOD", "SUBSTITUTED") and not k.endswith(".hb"):
                dt = max(1.0, now - ps.ts)
                bad_spike = abs(v - ps.value) > rule.max_rate * dt + 0.25 * abs(ps.value) + 5
            if bad_range or bad_spike:
                ps.rejected += 1
                self.stats["rejected"] += 1
                ps.quality = "SUSPECT" if ps.value is not None else "MISSING"
                continue
            ps.value, ps.ts, ps.quality = v, ts_k, "GOOD"
        keys = set(self.expected) | set(raw) | set(self.points)
        for k in keys:
            ps = self.points.get(k)
            if ps is None or ps.value is None:
                out[k] = (None, "MISSING")
                continue
            age = now - ps.ts
            if ps.quality == "GOOD" and age <= FRESH_S:
                out[k] = (ps.value, "GOOD")
            elif ps.quality == "SUSPECT" and age <= rule_for(k).ttl_s:
                out[k] = (ps.value, "SUSPECT")
            elif age <= rule_for(k).ttl_s:
                out[k] = (ps.value, "SUBSTITUTED")
            else:
                self.stats["stale"] += 1
                out[k] = (ps.value, "STALE")
        return out

    def age(self, key: str, now: float) -> float | None:
        ps = self.points.get(key)
        return None if ps is None or ps.value is None else max(0.0, now - ps.ts)

    @staticmethod
    def confidence(values: dict[str, tuple[float | None, str]]) -> tuple[float, dict[str, str]]:
        """Weighted share of trustworthy data: frequency 25 %, bus loads 60 % (by load share), generation 15 %."""
        t = topology()
        share = sum(b["loadShare"] for b in t.internal) or 1.0
        cap = sum(g["capacityMW"] for g in t.generators) or 1.0
        score = 0.25 * QUALITY_WEIGHT[values.get("sys.frequency", (None, "MISSING"))[1]]
        issues: dict[str, str] = {}
        for b in t.internal:
            q = values.get(f"bus.{b['id']}.load", (None, "MISSING"))[1]
            score += 0.6 * QUALITY_WEIGHT[q] * b["loadShare"] / share
            if q not in ("GOOD", "SUBSTITUTED"):
                issues[f"bus.{b['id']}.load"] = q
        for g in t.generators:
            q = values.get(f"gen.{g['id']}.mw", (None, "MISSING"))[1]
            score += 0.15 * QUALITY_WEIGHT[q] * g["capacityMW"] / cap
            if q not in ("GOOD", "SUBSTITUTED"):
                issues[f"gen.{g['id']}.mw"] = q
        fq = values.get("sys.frequency", (None, "MISSING"))[1]
        if fq not in ("GOOD", "SUBSTITUTED"):
            issues["sys.frequency"] = fq
        return round(score, 4), issues
