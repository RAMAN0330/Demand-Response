"""KPTCL SLDC public-website adapter (pilot data source).

Fetches *all* DISCOM 220 kV load pages and the state-generation page concurrently in one
cycle, parses their HTML tables, and maps rows to registry channels:

  DISCOM pages  → ch.load.<id>  (MW per 220 kV station)    e.g. https://kptclsldc.in/bescom.aspx
  StateGen page → ch.gen.<id>   (MW per generating station) https://kptclsldc.in/StateGen.aspx

Robustness: the parser does not assume fixed column positions. For each table it finds the
label column and the MW column (header containing "MW" but not "MVAR"; otherwise the first
numeric column after the label), skips total/summary rows, and records which DISCOM a table
belongs to from its page/heading. Unknown station names are kept (status "unmapped") so an
engineer can map them; they are still shown on the map near their DISCOM.

This is a *pilot* integration: for operations, SCADA/EMS data arrives via ICCP / IEC-104.
Polling is polite (default every 5 min, single concurrent request per page, identified UA).
"""

from __future__ import annotations

import asyncio
import os
import re
import ssl
import time
from dataclasses import dataclass, field
from html.parser import HTMLParser

import httpx

from .channels import channels, match, norm

DISCOM_NAMES = ("BESCOM", "MESCOM", "HESCOM", "GESCOM", "CESC")
NUM = re.compile(r"^-?\d{1,6}(?:\.\d+)?$")
SKIP = re.compile(r"\b(total|sub total|grand|sl\.? ?no|s\.? ?no|station name|name of|date|time|mw|mvar)\b", re.I)


class _Tables(HTMLParser):
    """Collect every <table> as rows of cell text, plus the nearest preceding heading text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[dict] = []
        self._stack: list[dict] = []
        self._cell: list[str] | None = None
        self._row: list[str] | None = None
        self._last_text = ""

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._stack.append({"rows": [], "heading": self._last_text[-120:]})
        elif tag == "tr" and self._stack:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None and self._stack:
            if any(c for c in self._row):
                self._stack[-1]["rows"].append(self._row)
            self._row = None
        elif tag == "table" and self._stack:
            self.tables.append(self._stack.pop())

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)
        elif data.strip():
            self._last_text = (self._last_text + " " + data.strip())[-300:]


def _num(s: str) -> float | None:
    s = s.replace(",", "").strip()
    return float(s) if NUM.match(s) else None


def parse_tables(html: str) -> list[dict]:
    p = _Tables()
    p.feed(html)
    return p.tables


def extract_rows(html: str) -> list[dict]:
    """Return [{label, mw, discom_hint, table}] for every data row with a label and an MW value."""
    out = []
    for ti, t in enumerate(parse_tables(html)):
        rows = t["rows"]
        if not rows:
            continue
        mw_col = None
        for hr in rows[:3]:  # header detection: prefer actual/present generation over installed capacity
            cands = [(ci, cell.lower()) for ci, cell in enumerate(hr) if "mw" in cell.lower() and "mvar" not in cell.lower() and "mvr" not in cell.lower()]
            if not cands:
                continue
            pref = [ci for ci, c in cands if re.search(r"actual|present|current|gen|load|drawal|now", c) and not re.search(r"install|capacity|ic\b", c)]
            usable = [ci for ci, c in cands if not re.search(r"install|capacity", c)]
            mw_col = pref[0] if pref else (usable[-1] if usable else cands[-1][0])
            break
        heading = t.get("heading", "")
        hint = next((d for d in DISCOM_NAMES if d.lower() in heading.lower()), None)
        for r in rows:
            label_i = next((i for i, c in enumerate(r) if c and _num(c) is None and not re.fullmatch(r"\d+\.?", c)), None)
            if label_i is None:
                continue
            label = r[label_i]
            if hint is None:
                hint = next((d for d in DISCOM_NAMES if d.lower() == label.lower().strip(": ")), hint)
            low = label.lower()
            if "frequency" in low or "state demand" in low or low in ("demand", "state load"):
                v = next((_num(c) for c in r[label_i + 1 :] if _num(c) is not None), None)
                if v is not None:
                    out.append({"label": label, "mw": v, "discom_hint": None, "table": ti, "system": "sys.frequency" if "frequency" in low else "sys.state_demand"})
                continue
            if SKIP.search(label) and not match(label, "load") and not match(label, "gen"):
                continue
            val = None
            if mw_col is not None and mw_col < len(r) and mw_col != label_i:
                val = _num(r[mw_col])
            if val is None:
                val = next((_num(c) for c in r[label_i + 1 :] if _num(c) is not None), None)
            if val is None:
                continue
            out.append({"label": label, "mw": val, "discom_hint": hint, "table": ti})
    return out


@dataclass
class SourceStatus:
    url: str
    kind: str  # load | gen
    discom: str | None
    ok: bool = False
    http_status: int | None = None
    error: str | None = None
    fetched_at: float | None = None
    rows: int = 0
    matched: int = 0
    latency_ms: float | None = None


@dataclass
class KptclSource:
    """Polls KPTCL SLDC pages; exposes the latest values as channel points."""

    poll_s: float = float(os.environ.get("KSFP_KPTCL_POLL_S", "300"))
    timeout_s: float = 20.0
    values: dict[str, float] = field(default_factory=dict)  # ch.load.<id> / ch.gen.<id> → MW
    values_ts: dict[str, float] = field(default_factory=dict)  # same keys → when the page was fetched
    unmapped: dict[str, dict] = field(default_factory=dict)  # normalized label → {label, mw, discom, kind}
    system: dict[str, float] = field(default_factory=dict)  # page-level values (frequency, state demand) for cross-validation
    status: dict[str, SourceStatus] = field(default_factory=dict)
    last_cycle: float | None = None
    cycles: int = 0

    def __post_init__(self) -> None:
        src = channels()["sources"]
        for url in src["discom_pages"]:
            d = next((x for x in DISCOM_NAMES if x.lower() in url.lower()), None)
            self.status[url] = SourceStatus(url, "load", d)
        self.status[src["generation_page"]] = SourceStatus(src["generation_page"], "gen", None)

    def _client(self) -> httpx.AsyncClient:
        ca = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
        verify: ssl.SSLContext | bool = ssl.create_default_context(cafile=ca) if ca and os.path.exists(ca) else True
        return httpx.AsyncClient(timeout=self.timeout_s, verify=verify, trust_env=True, headers={"User-Agent": "KSFP-SLDC-pilot/1.0 (+data quality monitoring)"}, follow_redirects=True)

    async def _fetch(self, client: httpx.AsyncClient, st: SourceStatus) -> tuple[SourceStatus, str | None]:
        t0 = time.perf_counter()
        try:
            r = await client.get(st.url)
            st.http_status = r.status_code
            st.latency_ms = (time.perf_counter() - t0) * 1000
            if r.status_code != 200:
                st.ok, st.error = False, f"HTTP {r.status_code}"
                return st, None
            return st, r.text
        except httpx.ProxyError as e:
            st.ok, st.error = False, f"blocked by network egress policy ({str(e)[:80]})"
        except Exception as e:  # DNS, TLS, timeout
            st.ok, st.error = False, f"{type(e).__name__}: {str(e)[:120]}"
        st.latency_ms = (time.perf_counter() - t0) * 1000
        return st, None

    def ingest_html(self, st: SourceStatus, html: str, now: float) -> None:
        rows = extract_rows(html)
        st.rows, st.matched = len(rows), 0
        for row in rows:
            if row.get("system"):
                self.system[row["system"]] = row["mw"]
                continue
            ch = match(row["label"], st.kind)
            if ch:
                key = f"ch.{st.kind}.{ch['id']}"
                self.values[key] = row["mw"]
                self.values_ts[key] = now  # fetch time: the value's age is measured from here
                st.matched += 1
            else:
                self.unmapped[norm(row["label"])] = {"label": row["label"], "mw": row["mw"], "discom": row["discom_hint"] or st.discom, "kind": st.kind, "seen_at": now}
        st.ok, st.error, st.fetched_at = True, None if st.matched else "no rows matched the channel registry", now

    async def cycle(self, now: float) -> None:
        """Fetch every configured page concurrently (all DISCOMs + generation at once)."""
        async with self._client() as client:
            results = await asyncio.gather(*(self._fetch(client, st) for st in self.status.values()))
        for st, html in results:
            if html is not None:
                try:
                    self.ingest_html(st, html, now)
                except Exception as e:
                    st.ok, st.error = False, f"parse error: {e}"
        self.last_cycle = now
        self.cycles += 1

    def health(self) -> dict:
        ok = [s for s in self.status.values() if s.ok]
        return {
            "name": "KPTCL SLDC website (pilot)",
            "mode": "hybrid",
            "poll_s": self.poll_s,
            "last_cycle": self.last_cycle,
            "cycles": self.cycles,
            "pages_ok": len(ok),
            "pages_total": len(self.status),
            "channels_live": len(self.values),
            "system": self.system,
            "unmapped": list(self.unmapped.values())[:200],
            "pages": [s.__dict__ for s in self.status.values()],
        }
