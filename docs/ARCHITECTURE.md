# ADRMS — System Architecture

ADRMS (Automated Demand Response Management System): an autonomous demand-response and flexibility control system for the KPTCL SLDC control area.

## 1. Re-analysis of the previous version

| Previous version | Problem for real operations | Now |
| --- | --- | --- |
| All logic ran in the browser (TypeScript engine) | Nothing runs unless an operator has a tab open. There is no shared state, no continuous loop, and no authority over commands. | All intelligence runs in a **backend service** that is always on. The UI is a client. |
| Events were opened by a person ("Start decision") | This is not autonomous, and detection depends on attention. | **Continuous detection loop** with alarms, incidents and automatic decision generation. |
| Scenario injection changed the "live" grid | This mixed simulation with operations. | The **What-if** sandbox has no side effects. Field disturbances exist only in a clearly labelled *simulated data source* (Shift In-charge, DR Programme Manager or Administrator). |
| The optimizer was a greedy heuristic | Not optimal, and its constraint handling was ad hoc. | **Linear program solved by HiGHS** with network (PTDF), energy, ramp, duration and reserve constraints, run as rolling-horizon MPC. |
| One decision at a time, one-shot dispatch | Did not re-correct when delivery fell short. | **Closed loop.** The plan is re-solved every block, commands follow a lifecycle, and shortfall is corrected automatically. |
| No data-quality handling | Bad or missing telemetry flowed straight into decisions. | A **quality layer** handles staleness, range checks, spikes and substitution. Low confidence **degrades autonomy automatically**. |
| No users, roles or persistence | Not deployable. | JWT authentication, RBAC, dual authorisation, a database, a hash-chained audit log, metrics and health probes. |

## 2. Logical architecture

```
            ┌────────────────────────── Field / external systems ──────────────────────────┐
            │ SCADA/EMS (IEC-104/ICCP) · SEM meters · Asset gateways (OpenADR 3 / Modbus)  │
            │ Power exchanges (DAM/RTM) · GRID-INDIA ancillary · Weather                   │
            └───────────────┬──────────────────────────────────────────────▲────────────┘
                            │ telemetry / prices                           │ setpoints
                ┌───────────▼───────────┐                       ┌──────────┴──────────┐
                │ 1. INGESTION          │                       │ 8. DISPATCH          │
                │ source adapters       │                       │ command state machine│
                │ (+ simulated source)  │                       │ ack/timeout/no-blind │
                └───────────┬───────────┘                       │ resend · gateway     │
                ┌───────────▼───────────┐                       └──────────▲──────────┘
                │ 2. DATA QUALITY       │                                  │
                │ validate · stale ·    │                       ┌──────────┴──────────┐
                │ spike · substitute ·  │                       │ 7. AUTONOMY POLICY   │
                │ confidence score      │                       │ L0–L3 envelope ·     │
                └───────────┬───────────┘                       │ approvals · dual auth│
                ┌───────────▼───────────┐                       │ kill switch · dead-  │
                │ 3. STATE ESTIMATION   │                       │ man degrade          │
                │ snapshot · DC PF ·    │                       └──────────▲──────────┘
                │ ACE · deviation · DSM │                                  │
                └──┬────────┬───────────┘                       ┌──────────┴──────────┐
                   │        │                                   │ 6. DECISION ENGINE   │
       ┌───────────▼──┐ ┌───▼────────────┐                      │ flexibility → LP     │
       │ 4. FORECAST  │ │ 5. DETECTION   │──── incidents ──────▶│ (HiGHS) → Digital    │
       │ P10/P50/P90  │ │ rules+anomaly  │                      │ Twin → re-solve →    │
       │ predicted    │ │ alarms · corr- │                      │ explanation (S→I→P→  │
       │ violations   │ │ elation · prio │                      │ R→A→O)               │
       └──────────────┘ └────────────────┘                      └─────────────────────┘
                   │        │                  │                         │
   ════════════════╧════════╧══════════ EVENT BUS (topics) ══════════════╧════════════════
   telemetry.raw · state.snapshot · forecast.update · alarm.* · incident.* · decision.* · command.* · audit
                   │                    │                    │
          ┌────────▼───────┐   ┌────────▼────────┐  ┌────────▼────────┐
          │ 9. M&V + SETTLE│   │ 10. AUDIT       │  │ 11. API GATEWAY  │──▶ REST /api/v1 + WebSocket /ws
          │ learning (R)   │   │ hash-chained    │  │ auth · RBAC      │    (operator UI, integrations)
          └────────────────┘   └─────────────────┘  └──────────────────┘
                   │                    │
          ┌────────▼────────────────────▼──────────┐
          │ STORAGE: hot ring buffers (in-memory)   │
          │ + SQL (SQLite dev / PostgreSQL +        │
          │ TimescaleDB prod) with retention tiers  │
          └─────────────────────────────────────────┘
```

The backend is a **modular monolith**. Each numbered box is a Python package with a narrow interface, and the packages communicate through the event bus. In the first deployment everything runs in one process, which keeps operations and failure analysis simple. The bus interface (`ksfp/core/bus.py`) is the seam where a Redis Streams or Kafka adapter can be swapped in when modules are split into separate services.

## 3. Control loops and cadence

| Loop | Cadence (sim time) | What it does |
| --- | --- | --- |
| Ingestion / state | 1 s | Pull telemetry, quality-check, estimate state, solve DC power flow, publish `state.snapshot`. |
| Detection | 1 s | Evaluate rules and anomalies, and raise, update or clear alarms. Correlate alarms into incidents. |
| Forecast | 1 min | Rolling P10/P50/P90 forecast of demand, RE, drawal deviation, ACE and line loading for 8 blocks. |
| Decision (MPC) | every 15-min block, and immediately on a new or escalated incident | Re-solve the 4-block plan, validate it in the twin, apply the autonomy policy, and issue or modify commands. |
| Dispatch watchdog | 1 s | Command timeouts, acknowledgement tracking, delivery verification, shortfall detection. |
| Persistence | 10 s / 1 min | Flush aggregates, alarms, decisions, commands and audit to the database. |
| Dead-man | 1 s | If the loop stalls or data confidence drops, autonomy degrades to advisory and an alarm is raised. |

Time comes from an injectable clock. Against real field systems it is wall-clock time. With the simulated source, `KSFP_TIME_SCALE` accelerates it so a 60-minute event can be exercised in minutes.

## 4. Velocity, Variability, Volume

**Velocity**
- Async ingestion. Telemetry queues use latest-value-wins coalescing, so a backlog never builds up stale state.
- Bounded queues with drop counters, which are exposed as metrics.
- WebSocket frames are throttled to 1 Hz per client. Event messages (alarms, decisions, commands) are pushed immediately.
- Heavy computation (LP, twin) runs in a worker thread so the 1 s loop is never blocked. Loop latency is a metric with an alarm threshold.

**Variability**
- Each point carries a quality flag (`GOOD`, `SUBSTITUTED`, `STALE`, `SUSPECT`, `MISSING`).
- **Spike rejection:** values outside the rate-of-change limit are rejected.
- **Range checks:** values outside physical limits are flagged suspect.
- **Staleness:** a value older than its TTL is marked stale and substituted with the last good value or an estimate.
- **Confidence score** (0–1) for the snapshot. Below a threshold, autonomous execution is suspended automatically (degrades to approval-required) and the reason is shown.
- Forecasts carry P10/P90 bands. The P90 margin is held as a reserve constraint.
- Assets that stop sending heartbeats are removed by the twin before any command is sent. Commands are never resent blindly.

**Volume**
- **Hot tier:** in-memory ring buffers (2 h at 1 s) for live views.
- **Warm tier:** 1-minute aggregates (min/avg/max), plus 15-minute block records for DSM.
- **Cold tier:** relational history of alarms, decisions, commands, settlements and the audit chain.
- **PostgreSQL + TimescaleDB in production:** hypertables, compression after 7 days, and retention policies (raw 48 h, 1-minute data for 13 months, block data indefinitely).
- All list APIs are paginated and filterable.

## 5. Autonomy model

| Level | Name | Behaviour |
| --- | --- | --- |
| L0 | Monitor | Detect, forecast and alarm only. No decisions are generated. |
| L1 | Advisory | Decisions are generated. **Every** command needs operator approval. |
| L2 | Supervised autonomy *(default)* | Decisions inside the **autonomy envelope** execute automatically. Anything outside it waits for approval. |
| L3 | Full autonomy (state DR) | All state-mode resources execute automatically. ADMS / load rotation **always** requires a person. |

**Envelope (configurable, versioned)**
- Resource classes allowed to run automatically: BESS and generation by default.
- Maximum auto-dispatched MW: 250 MW by default.
- Severity levels allowed.
- Minimum data confidence.
- The twin must have passed.

**Dual authorisation**
- Any manual approval above 200 MW needs a second approver with a different identity and the `approve_dual` permission.

**Overrides**
- **Global suspend (kill switch):** stops new automatic actions. Commands already executing continue unless aborted.
- **Per-decision reject or abort:** releases the resources.
- **Per-resource out-of-service flag.**

All overrides are audited with the actor and a reason.

## 6. Decision engine

1. **Assess.** Compute deviation, ACE (IEGC formula), severity, direction, requirement, P90 margin and DSM exposure (CERC DSM structure, energy-based).
2. **Flexibility.**
   - Per asset: `F = min(baseline − Pmin, contract_state (+ emergency share), technical/SoC limit)`, then `expected = F × reliability`.
   - SRAS/TRAS portions are excluded, so the same MW is never committed twice.
3. **Optimize** with a linear program solved by HiGHS over B blocks.
   - **Variables:** `x[i,b]` ≥ 0 (MW), `s[b]` ≥ 0 (unserved requirement), `v[l,b]` ≥ 0 (line overload slack).
   - **Objective:** `min Σ c_i·R_i·x[i,b]·Δt + λ·Σ s[b] + μ·Σ v[l,b]`, where `c_i` = bid + opportunity + rebound, λ = 3·NR (above any economic resource), and μ is far larger still.
   - **Balance:** `Σ R_i·x[i,b] + s[b] ≥ requirement[b]`.
   - **Network:** `|f0_l + Σ PTDF[l,bus_i]·dir·x[i,b]| ≤ limit_l + v[l,b]`.
   - **Capacity:** `x[i,b] ≤ avail_i`. Response time is enforced as `x[i,b] = 0` for blocks before the asset can respond.
   - **Ramp:** `|x[i,b] − x[i,b−1]| ≤ ramp_i·15`.
   - **BESS energy:** `Σ_b x[i,b]·Δt/η ≤ E_avail`.
   - **Duration budget:** `Σ_b x[i,b] ≤ maxBlocks_i·avail_i`.
   - **Economic rule:** in NORMAL severity, a resource is used only if its cost is below the DSM marginal rate. In ALERT and EMERGENCY the objective is security-first.
   - Minimum on/off time and start-up costs need binary variables. That is a MILP extension (`highspy`/Gurobi) using the same model builder.
4. **Digital Twin.** A 1-minute simulation of the candidate plan:
   - heartbeats (live), response lag and ramps, the SoC trajectory, and post-dispatch DC power flow and voltage proxy;
   - P90 reserve, SRAS/TRAS arbitration, rebound, and the residual.
   - On a failure the twin removes or derates the offending assets and the plan is **re-solved** (up to 4 passes).
5. **Explain.** Every decision stores a narrative of **Situation → Impact → Prediction → Recommendation → Action → Outcome**, plus the full evidence: formulas with values, the merit order, binding constraints, twin checks, and alternatives considered (Do-nothing, RTM, GEN, BESS, DR, mix).

## 7. Command lifecycle

```
PLANNED → AWAITING_APPROVAL ─approve→ APPROVED ─┐
        └────────── auto (policy) ─────────────▶ SENT → ACKED → EXECUTING → COMPLETED
                                                  │       │          └→ UNDER_DELIVERING → (shortfall → re-solve)
                                                  └ ACK_TIMEOUT → FAILED (asset excluded; no blind resend)
any non-terminal → ABORTED (operator) · SUPERSEDED (new MPC schedule)
```

- Commands are **idempotent**. Each carries a `command_id` and a signature, so a gateway can de-duplicate.
- Release at the end of an event is itself a command (setpoint 0).

## 8. Security

- **Authentication:** JWT (HS256, short expiry). Passwords are stored as PBKDF2-SHA256 hashes. Production should put the platform behind the utility's IdP (OIDC/LDAP).
- **RBAC roles and their key permissions:**

  | Role | Key permissions |
  | --- | --- |
  | `operator` (SLDC Operator) | view, ack alarms, approve, reject, abort, what-if, propose load rotation |
  | `shift_in_charge` (Shift In-charge) | + `approve_dual`, shelve alarms, approve load rotation, autonomy suspend/resume, resources, simulator, reports |
  | `dr_manager` (DR Programme Manager) | view, programmes and C&I offers (`resources`), what-if, simulator, reports |
  | `settlement_officer` (Settlement Officer) | view, reports, resolve M&V disputes (`settle`) |
  | `auditor` (Auditor) | read-only: view, reports, verify the audit chain (`audit`) |
  | `admin` (Administrator) | everything + users, config |

  The role picked on the sign-in page must match the account's role; it is checked only after the password. Roles from
  earlier releases are mapped at start-up (`analyst` → `auditor`, `engineer` → `dr_manager`).

- **Audit:** an append-only SHA-256 hash chain, verifiable through `GET /api/v1/audit/verify`.
- **Network:** OT/IT segmentation per the CEA Cyber Security Guidelines. Field adapters run in the OT DMZ. Commands use mTLS to the gateways. The API sits behind TLS termination.

## 9. Observability and reliability

| Concern | Provision |
| --- | --- |
| Health probes | `/health` (liveness), `/ready` (DB reachable + loops alive + data fresh) |
| Metrics | `/metrics` in Prometheus format: loop latency, tick counts, queue drops, data confidence, active alarms, decisions by state, command latency, LP solve time |
| Logging | Structured JSON logs |
| Graceful degradation | DB outage → keep operating from memory with buffered writes and raise an alarm. Data-confidence loss → autonomy degrades. Solver failure → fall back to the last valid plan, then advisory. |
| HA (deployment) | Two or more API replicas are stateless readers. Exactly one **control-loop leader** is elected with a PostgreSQL advisory lock (`KSFP_ROLE=leader\|replica`). |

## 10. Code map (`backend/ksfp`)

| Package | Responsibility |
| --- | --- |
| `core/` | clock, event bus, settings |
| `grid/` | topology, DC power flow & PTDF, ACE, DSM rule engine |
| `ingest/` | source adapters (simulated field), data-quality layer |
| `forecast/` | P10/P50/P90 short-term forecaster, predicted violations |
| `detect/` | detection rules, anomaly detection, alarm manager, incident correlation |
| `decide/` | flexibility, LP optimizer, digital twin, autonomy policy, decision engine |
| `act/` | dispatch / command lifecycle, field gateway, M&V & settlement |
| `audit/`, `security/`, `store/`, `obs/` | audit chain, auth & RBAC, persistence, metrics |
| `api/` | REST routers and WebSocket hub |
| `runtime.py` | wires modules and runs the loops |
