# Demand Response Platform

An autonomous demand-response operations platform for a grid control centre (SLDC). It runs the full DR loop continuously:

**detect the grid need → forecast it → choose the cheapest reliable mix of flexibility → dispatch under a human-in-the-loop policy → meter delivery against baseline → settle participants → learn their reliability**, with every step explained and written to a tamper-evident audit trail.

The reference deployment is configured for the Karnataka control area (KPTCL SLDC). Its 220 kV load channels and generating stations can be ingested live from the SLDC website. The platform itself is not tied to one state: topology, programmes and participants are all data.

```
backend/   FastAPI service: ingest, detect, forecast, decide, act, settle, audit (Python 3.13)
web/       Operator UI: React 19, Vite, Tailwind v4, shadcn/ui (Radix), zustand, react-three-fiber, Recharts
docs/      ARCHITECTURE.md (system design), UX-IA.md (information architecture & operator workflow)
```

## Run it

### Docker (full stack)

```bash
docker compose up --build                     # UI + API → http://localhost:8080
docker compose --profile db up --build        # + TimescaleDB (set KSFP_DATABASE_URL, see below)
docker compose --profile dev up               # Vite hot reload against the API container → http://localhost:5173
```

nginx serves the UI and proxies `/api`, `/ws` (live stream) and `/health|/ready|/metrics` to the API container.

### Local development

```bash
cd backend && python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/uvicorn ksfp.main:app --port 8000        # API + autonomous loops
.venv/bin/python -m pytest -q                      # backend tests

cd web && npm install && npm run dev               # http://localhost:5173 (proxies /api and /ws to :8000)
npm run build                                      # type-check + production bundle
```

Demo accounts (password = username + `123`): `operator`, `sic` (shift-in-charge), `analyst`, `engineer`, `admin`.

### Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `KSFP_DATABASE_URL` | `sqlite+aiosqlite:///./data/ksfp.db` | Use `postgresql+asyncpg://…` for PostgreSQL; telemetry becomes a TimescaleDB hypertable when the extension is present |
| `KSFP_JWT_SECRET` | random per start | **Set in production** (tokens must survive restarts) |
| `KSFP_COMMAND_KEY` / `KSFP_COMMAND_KEY_ID` | random per start / `k1` | **Set in production**: command-authentication key shared with field gateways (separate from the session secret) |
| `KSFP_SOURCE` | `simulated` | `hybrid` polls the SLDC website (all DISCOM 220 kV load pages + StateGen) and overrides/calibrates the simulated field |
| `KSFP_KPTCL_POLL_S` | `300` | SLDC website poll interval |
| `KSFP_TIME_SCALE` | `20` | Simulated-clock speed (1 in hybrid mode) |
| `KSFP_AUTO_DISTURBANCES` | `true` | Random field events for drills |
| `KSFP_DEMO_USERS` | `true` | Seed the demo accounts |

Hybrid mode needs outbound HTTPS to `kptclsldc.in` from the API host. **It is advisory only:** website values are up to one poll interval old (ages are measured from fetch time), so this source vetoes automatic control until authorised SCADA/EMS telemetry is connected. If a page can't be fetched, its channels stay simulated, and Administration → Data sources shows per-page health and any unmapped rows.

## Landing page & overview video

Visitors who aren't signed in see a public landing page: what the platform does, how the loop works, load shedding, governance, trust & standards, architecture, and a narrated **4-minute product overview video** (`web/public/media/demand-response-overview.mp4` with a WebM fallback and English captions). "Sign in" opens the console at `#/login`. The video is generated from the live product — see `docs/video/README.md` to regenerate it.

## Operator experience

Enterprise palette (navy-azure brand, steel neutrals; green, ochre and crimson reserved for status) defined once as design tokens in `web/src/index.css`. Spatial UI: the map is the primary workspace and every page uses glass panels over a soft spatial backdrop (see `.claude/skills/ui-style-selection`). Top-bar navigation follows the DR workflow (no sidebar, no vertical scrolling, no page titles; the selected tab names the page):

| Module | What the operator gets |
| --- | --- |
| **Overview** (spatial workspace) | The live 3D territory map fills the screen; everything else floats over it as collapsible glass panels. Headline DR numbers on top (grid need, flexibility available, dispatched, delivering, participants online, event/value); *At risk*, *Next* and *Intent* (Situation → Impact → Prediction → Recommendation → Action → Outcome, with Approve) on the right. Selecting anything (a DR event, participant, substation, alarm, predicted overload, overloaded line) flies the camera there, pins a detail card beside it and lights up the affected lines and participants. The active DR event plays out on the map — dispatch going out to participants, acknowledgements and delivery — with a timeline along the bottom you can scrub, replay or snap back to live |
| **DR Events** | Today's summary, the event log with delivery progress and a live activity log (re-plans, approvals, authenticated dispatch, acks, settlement). Per event: target / dispatched / delivering / performance / duration / value, a target-vs-dispatched-vs-delivered curve, tabs for participants, grid need, options, safety checks, dispatch (ack · first response · full output), revisions and settlement (counterfactual ledger), and **Show / Replay on map**. Approve, reject or abort with reasons |
| **Programs** | Programme cards (available vs contracted MW, participants online, reliability, price, terms). Picking a programme lights up its participants on the map beside the registry; clicking a participant flies to it |
| **Load Shedding** | Emergency load management, the last resort for over-drawal. When paid flexibility can't cover it, the platform proposes an order. The trigger is uncovered over-drawal beyond the DSM deviation band (min(10% of schedule, 100 MW), taken live from the DSM rule table) or frequency below 49.90 Hz, sustained 2 min, or immediately below 49.80 Hz. An order **only acts after shift-in-charge approval** (dual above 200 MW) and is never autonomous. Non-essential 11 kV feeders in roster groups of ~4 stations per DISCOM are opened, split across DISCOMs by load share and least-shed first. Limits: spells ≤ 45 min, ≤ 120 min per group per day, and a full spell of rest after each. Hospitals, water works, railway traction and defence are never shed. Restoration is staged, and paid DR is kept on while shedding is released first. The page has a roster board (live MW, minutes today, rest timers), the 220 kV feeders on the map, the order lifecycle (approve, reject, restore all, propose) and an audited order log |
| **Grid** | Network loading, resources in action, every 220 kV load channel by DISCOM (live vs simulated) and every generating station. The 3D map shows every 220 kV feeder from its 400 kV substation, with animated flow scaled to its load; shed feeders turn red and stop flowing |
| **Forecast** | ACE / demand / renewables P10–P50–P90, predicted violations, recent behaviour, forecast accuracy |
| **Alarms** | ISA-18.2 style alarms (on/off delays, ack, shelve with reason) correlated into incidents |
| More → **What-if** | Run a hypothetical event on a copy of live state: strategies, optimal plan, safety gate; nothing is dispatched |
| More → **Settlement & Audit** | Settled events (each can be replayed on the map), energy vs baseline, payments, net benefit, participant reliability, and the hash-chained audit trail with one-click verification |
| More → **Administration** | Autonomy level and L2 envelope, dual-authorisation threshold, data-source health, simulator drills, DSM rule table, users and roles |

The status cluster (severity, autonomy level with kill switch, data confidence, clock, stream health, user) is always visible.

## Backend at a glance

- **Runtime loops:** 1 Hz state loop (ingest → quality → estimate → assess → detect → decide → dispatch), forecast every simulated minute, SLDC poller, write-behind persistence every 10 s, and a dead-man watchdog.
- **Decide:** a network-constrained multi-block LP (HiGHS) re-solved every block (MPC). Before any command, a Digital-Twin gate checks heartbeat, SoC, flows, voltage, reserve and rebound, and excludes or derates anything that fails.
- **Autonomy policy:** L0 Monitor, L1 Advisory, L2 Supervised (automatic only inside an envelope), L3 Autonomous. It degrades automatically on low data confidence or an unhealthy loop. Includes a kill switch and dual authorisation above a MW threshold.
- **Act:** setpoint commands authenticated with HMAC-SHA-256 (verified independently at the gateway: key id, freshness, replay), ack timeouts, a dead-band and no blind resend. Acknowledgement, first response, full output and delivered energy are tracked separately. Measurement & verification (M&V) runs per tick, with performance-factor settlement and reliability learning.
- **Trust:** JWT + RBAC (operator / shift-in-charge / analyst / engineer / admin), and a SHA-256 hash-chained audit log with a verify endpoint. Probes and Prometheus metrics are exposed at `/health`, `/ready` and `/metrics`.

See `docs/HOW-IT-WORKS.md` for how the loop works, the strategies it weighs and every calculation (with a worked example), and `docs/ARCHITECTURE.md` for the full design, scaling path and failure modes.

## Caveats

**Status: simulation and advisory prototype — not ready for autonomous grid control.** See `docs/HOW-IT-WORKS.md` §12 for what must be validated before a utility pilot.

- **DSM table is illustrative.** The engine implements the tiered structure of the CERC DSM Regulations, 2024 (versioned, with provenance), but the shipped numbers are not the notified table. Load the table for the applicable buyer category, read with all amendments and orders, via Administration / `PUT /api/v1/admin/config/dsm` before any settlement use.
- **Telemetry.** A 1-second software loop is not 1-second grid telemetry. Ages are measured from source timestamps; stale frequency, schedule or breaker status, or the SLDC-website source, keep the platform advisory.
- **The network is a screening model.** It is a simplified DC power flow with planning-level limits and a heuristic voltage estimate, not the utility's EMS model or an AC study.
- **The load-shedding roster is demonstration data** (generated groups, flat 30% sheddable share, generated protected counts). Use the DISCOM's approved feeder roster before any use. Independent UFR / df/dt protection is never delayed or overridden by the platform.
- **Thresholds.** The IEGC band (49.90–50.05 Hz) is from the grid code; the 49.80 Hz / 1,500 MW emergency rules, the 60 s event trigger, 90 s ack timeout and 120 s shedding hold are application policy. The frequency bias (−160 MW/0.1 Hz) is configuration pending the SLDC's declared value.
- **Demo data:** participant names, capacities, bids and reliabilities are representative demo data. The simulated field stands in for SCADA/EMS and DR gateways until real integrations are connected.
