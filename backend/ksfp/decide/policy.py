"""Autonomy policy: which actions the system may take on its own, and when it must ask.

L0 MONITOR    detect, forecast, alarm — no decisions
L1 ADVISORY   decisions generated, every command needs approval
L2 SUPERVISED commands inside the envelope execute automatically; the rest await approval
L3 AUTONOMOUS all state-mode resources execute automatically (ADMS always human)
Automatic degradation: low data confidence or loop stalls force advisory behaviour.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

LEVELS = {0: "MONITOR", 1: "ADVISORY", 2: "SUPERVISED", 3: "AUTONOMOUS"}


@dataclass
class Envelope:
    auto_types: list[str] = field(default_factory=lambda: ["bess", "generation"])
    max_auto_mw: float = 250.0
    min_confidence: float = 0.85
    allowed_severity: list[str] = field(default_factory=lambda: ["NORMAL", "ALERT", "EMERGENCY"])


@dataclass
class AutonomyPolicy:
    level: int = 2
    suspended: bool = False
    suspended_by: str | None = None
    suspended_reason: str | None = None
    dual_auth_mw: float = 200.0
    envelope: Envelope = field(default_factory=Envelope)
    version: int = 1
    # hard safety vetoes, recomputed every tick from telemetry health (never persisted): any entry forces
    # advisory regardless of the aggregate confidence score; asset vetoes send that asset to approval
    vetoes: list[str] = field(default_factory=list)
    asset_vetoes: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("vetoes", None)
        d.pop("asset_vetoes", None)
        d["level_name"] = LEVELS[self.level]
        return d

    def effective(self, confidence: float, loop_healthy: bool = True) -> tuple[int, list[str]]:
        """Effective level after safety degradations, with reasons."""
        reasons = []
        lvl = self.level
        if self.suspended:
            reasons.append(f"Autonomy suspended by {self.suspended_by or 'operator'}" + (f": {self.suspended_reason}" if self.suspended_reason else ""))
            lvl = min(lvl, 1)
        if confidence < self.envelope.min_confidence:
            reasons.append(f"Data confidence {confidence * 100:.0f}% < {self.envelope.min_confidence * 100:.0f}% — degraded to advisory")
            lvl = min(lvl, 1)
        if not loop_healthy:
            reasons.append("Control loop latency high — degraded to advisory")
            lvl = min(lvl, 1)
        for v in self.vetoes:
            reasons.append(v)
            lvl = min(lvl, 1)
        return lvl, reasons

    def classify(self, allocations: list[dict], severity: str, confidence: float, twin_ok: bool, loop_healthy: bool = True) -> dict:
        """Mark each allocation auto|approval. Returns {auto: [...ids], approval: [...ids], reasons, level}."""
        lvl, reasons = self.effective(confidence, loop_healthy)
        auto, approval = [], []
        auto_mw = 0.0
        vetoed = []
        for al in sorted(allocations, key=lambda x: x["mw"]):
            ok = False
            if al["id"] in self.asset_vetoes:
                vetoed.append(f"{al['id']}: {self.asset_vetoes[al['id']]}")
            elif lvl >= 3 and twin_ok and al["type"] != "rtm":
                ok = True
            elif lvl == 2 and twin_ok and al["type"] in self.envelope.auto_types and severity in self.envelope.allowed_severity:
                ok = auto_mw + al["mw"] <= self.envelope.max_auto_mw
            if ok:
                auto.append(al["id"])
                auto_mw += al["mw"]
            else:
                approval.append(al["id"])
        if lvl == 2 and approval:
            reasons.append(f"Outside autonomy envelope (auto classes {', '.join(self.envelope.auto_types)}, ≤{self.envelope.max_auto_mw:.0f} MW) → operator approval")
        if vetoed:
            reasons.append("Needs approval — " + "; ".join(vetoed))
        if not twin_ok:
            reasons.append("Digital Twin did not approve — human decision required")
        return {"level": lvl, "level_name": LEVELS[lvl], "auto": auto, "approval": approval, "auto_mw": auto_mw, "reasons": reasons}
