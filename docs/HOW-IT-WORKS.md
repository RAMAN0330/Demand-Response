# How ADRMS works

ADRMS — Automated Demand Response Management System.

This document explains what the platform does on every tick, which strategies it weighs, and exactly how each number on screen is calculated — the maths, the reasoning behind each choice, and worked numbers.

> **Deployment status: simulation and advisory prototype.** The architecture (monitor → assess → optimise → safety-check → approve → dispatch → measure → settle → audit) is a sound basis for SLDC decision support, but the platform is **not ready for autonomous grid control**. Before operational commands or load rotation are authorised it needs: authenticated, fresh SCADA/EMS telemetry (§2.1); the notified DSM table with all amendments (§3.4); a validated network model with AC voltage studies (§3.2, §5.5); the DISCOM's approved feeder roster (§7); and shadow-mode replay against historical operations (§13).
>
> **Illustrative values.** DSM multipliers, prices, participant bids, reliabilities, the frequency bias and the load-rotation roster ship as demonstration data. Which thresholds come from the grid code and which are this application's own policy is marked throughout.

---

## 1. The problem it solves

A state control area (here, Karnataka/KPTCL SLDC) must draw from the inter-state grid exactly what it scheduled. Any difference is a **deviation**, settled block by block (15 minutes) under the CERC **Deviation Settlement Mechanism (DSM)**:

- **Over-drawal** (drawing more than schedule) is charged, and charged harder outside a tolerance band and when frequency is low.
- **Under-drawal** is a potentially costly or low-value surplus condition; what it settles at depends on the applicable DSM provisions, the frequency and the volume band (§3.4).
- Large deviations also push frequency out of the IEGC band (49.90–50.05 Hz) and can overload transmission corridors.

Demand response (DR) closes the gap by paying flexible consumers, batteries and generators to move their output for a few blocks. The platform decides **who, how much, when and at what cost**. It then dispatches, proves delivery and settles payment, and uses load rotation only as the last resort.

---

## 2. The loop (every second)

```
SCADA / SLDC feed ─► quality ─► state estimate ─► assess ─► detect/alarms ─► decide ─► dispatch ─► M&V ─► settle ─► audit
                                     ▲                                           │
                                     └──────────── forecast (every sim minute) ◄─┘
```

| Stage | What happens |
| --- | --- |
| Ingest | Simulated field, or the live SLDC website (all DISCOM 220 kV load pages + StateGen) in hybrid mode |
| Quality | Every point validated and flagged GOOD / SUBSTITUTED / SUSPECT / STALE / MISSING |
| Estimate | Consistent grid state; missing bus loads filled in by load share; DC power flow |
| Assess | ACE, severity, direction, requirement, DSM exposure |
| Detect | Rule and anomaly alarms with on/off delays, correlated into incidents |
| Decide | Open or revise a DR event: flexibility → LP optimiser → Digital Twin → autonomy policy |
| Rotate | Roster manager proposes load rotation for the residual that flexibility can't cover |
| Act | HMAC-authenticated setpoint commands, acks, timeouts, dead-band |
| M&V / settle | Delivered vs expected energy, avoided DSM, payments, reliability learning |
| Audit | Every step appended to a SHA-256 hash chain |

Write-behind persistence runs every 10 s, and a watchdog degrades autonomy if the loop slows.

### 2.1 Four different clocks

A 1-second software loop is **not** 1-second grid telemetry. Measurement, control decision, command acknowledgement and physical response are separate clocks, and the platform keeps them separate:

| Clock | Reference (where one applies) | In this platform |
| --- | --- | --- |
| Frequency measurement | IEGC: measured at 1 s intervals | Target for the frequency input — only if the data is genuinely fresh. Every point is aged from its **source** timestamp (§3.1) |
| ACE computation / archival | IEGC: real time, archived at ≤ 10 s | A value counts as GOOD only while its source time is ≤ 10 s old |
| SLDC website (hybrid mode) | — | Polled every **300 s** by default; values keep their fetch time, so they age to SUBSTITUTED/STALE, and this source keeps the platform **advisory** (§5.6) |
| Primary response | IEGC: full primary response within 45 s for applicable resources | Not assumed for DR participants — each resource uses its own response delay and ramp |
| Secondary reserve (SRAS) | IEGC: start within 30 s, full within 15 min, sustain ≥ 30 min | SRAS/TRAS capacity is a separate service and is locked out of DR |
| Tertiary reserve (TRAS) | IEGC: within 15 min of instruction, sustain ≥ 60 min | Separate service class |
| RTM purchase | IEX: sessions every 30 min, delivery in the 4 blocks after the session | Cannot deliver inside the 4-block horizon (§5.3) |
| DR event opens after 60 s | **Application policy** | Tunable by severity, telemetry quality and tested false-alarm rate |
| Command ack timeout 90 s | **Application comms timeout** | Not a delivery guarantee: ack, first response, full output and delivered energy are tracked separately (§5.7) |
| Load-rotation proposal after 120 s | **Application trigger** | Separate from, and never a substitute for, approved UFR / df/dt protection (§7) |

Confirm exchange rules and grid-code provisions in force at implementation time.

---

## 3. Measuring the grid

### 3.1 Data quality and confidence

Each telemetry point has a range, a maximum plausible rate of change (spike check) and a time-to-live. **Age is measured from the source timestamp** (when the value was measured or fetched), never from when the platform re-read it — so a 5-minute-old web value re-delivered every second does not look fresh. A point is GOOD only while its source age is ≤ 10 s. Quality weights:

| Flag | Weight |
| --- | --- |
| GOOD | 1.00 |
| SUBSTITUTED (last good value, within TTL) | 0.85 |
| SUSPECT (failed range or spike check) | 0.50 |
| STALE (past TTL, estimated) | 0.30 |
| MISSING | 0.00 |

**Data confidence**

```
confidence = 0.25 · w(frequency)
           + 0.60 · Σ_bus w(bus load) · loadShare_bus / Σ loadShare
           + 0.15 · Σ_gen w(gen MW)   · capacity_gen  / Σ capacity
```

- Below **85%**, autonomy drops automatically to advisory (every command needs approval).
- Below 97% a P3 alarm is raised, and below 80% a P2 alarm.

**Hard vetoes.** An average can stay above 85% while one critical input is bad, so each of these forces advisory on its own, whatever the score:

- frequency not GOOD (stale, substituted or missing);
- interchange schedule stale, suspect or missing (ACE cannot be trusted);
- any breaker (line status) not current (topology uncertain);
- the source is the SLDC website (until authorised SCADA/EMS telemetry is connected).

Per-asset vetoes send just that asset to approval: gateway heartbeat lost (command path unproven), or BESS state-of-charge telemetry stale. The top bar's data pill shows the worst source age and lists every active veto.

### 3.2 State estimate

- A missing or bad bus load is estimated as `(Σ good loads / Σ their load shares) × this bus's load share`, so one failed RTU lowers confidence rather than corrupting the state.
- Demand = Σ bus loads. Generation is split into in-state and central share.
- A DC power flow gives line flows: `flows = H · p`.
  - `p` is net injection at each internal bus.
  - `H` is the PTDF matrix with distributed slack at the inter-state tie buses.
  - `H` is cached per outage set.
- Voltage is a **heuristic screening estimate**: `V ≈ 1.035 − 0.075·(worst adjacent loading)²` pu. A DC model does not solve voltage or reactive power, so this cannot certify voltage compliance.
- The DC model is a planning-level screen. Live use needs a validated network model — actual topology, impedances, transformer limits, line ratings, outage configurations — with AC load flow and the applicable contingency studies.

### 3.3 Area Control Error and severity

IEGC definition:

```
ACE = (Ia − Is) − 10 · Bf · (Fa − Fs) + Offset

Ia = −actual drawal       Is = −scheduled drawal       Fs = 50.00 Hz
Bf = frequency bias, MW per 0.1 Hz        Offset = 0 unless configured (supported in code)
```

- The IEGC defines the interchange sign convention and requires each SLDC to assess and declare its own frequency bias from its control-area response. **Bf is not a universal constant.** The value used here (−160 MW/0.1 Hz) is Karnataka configuration data **pending confirmation from the SLDC's declaration**.

- **Negative ACE** means the state is short (over-drawing). Direction is **UP**: reduce load or add supply.
- **Positive ACE** means the state is long. Direction is **DOWN**: absorb surplus.
- **Requirement** = |ACE| MW.

Severity:

| Severity | Condition | Source |
| --- | --- | --- |
| EMERGENCY | f < 49.80 Hz, or \|ACE\| > 1,500 MW | **Application policy** (not grid-code thresholds) |
| ALERT | f < 49.90 or f > 50.05 Hz | IEGC normal operating band |
| ALERT | \|ACE\| ≥ 100 MW | Application policy |
| NORMAL | otherwise | — |

**Forecast-error reserve (P90 margin)** is the flexibility kept free in case the forecast is wrong:

```
margin = 1.28 · √( (0.5% · demand)² + (6% · renewables)² )
```

### 3.4 DSM charge

**Normal Rate**

```
A  = DAM weighted ACP          (default ₹5.40/kWh)
B  = RTM ACP                   (default ₹7.20/kWh)
C  = (DAM + RTM + ancillary) / 3
NR = max(A, B, C)
```

The rule table is **versioned configuration**. Each table records its regulation, amendments applied, effective date, source and approver, and the platform refuses a table without a version, source and effective date (an engineer loads it under Administration → DSM rules). The table in force is used everywhere: assessment, optimiser, strategy comparison and M&V.

**Volume bands.** The 2024 structure prices successive slices of |deviation| differently. Each band's upper edge is the lower of a percentage of schedule and an MW cap:

```
edge_k = min(pct_k % × schedule, cap_k)       (edges never decrease; the last band is open-ended)

shipped default (structure of the 2024 general-buyer rules — numbers illustrative):
  band 1:  up to min(10% of schedule, 100 MW)      ← the tolerance band; also the load-rotation trigger (§7)
  band 2:  up to min(15% of schedule, 200 MW)
  band 3:  beyond
```

**Per-block charge** (15 min = 0.25 h), summed over the bands the deviation reaches:

```
amount = Σ_k  MW_in_band_k · 0.25 h · 1000 · m_k(frequency band, direction) · NR
```

Over-drawal is payable (+); under-drawal is receivable (−), with its own multipliers.

**Illustrative multipliers of NR** (load the notified values for the applicable buyer category):

| Frequency band | Over-drawal band 1 / 2 / 3 | Under-drawal band 1 / 2 / 3 |
| --- | --- | --- |
| LOW (f < 49.90) | 1.5 / 2.0 / 2.5 | 1.0 / 0.5 / 0.0 |
| NORMAL | 1.0 / 1.5 / 2.0 | 0.9 / 0.0 / 0.0 |
| HIGH (f ≥ 50.05) | 0.5 / 1.0 / 1.5 | 0.0 / 0.0 / 0.0 |

> **Regulatory status.** This reproduces the *structure* of the CERC DSM Regulations, 2024, not the notified settlement formula. Before any settlement use, load the principal regulations for the applicable buyer category, read with all subsequent amendments and orders (CERC lists a Third Amendment dated 7 September 2026 and an order of 3 October 2026 on Regulation 9(7)), and verify against official settlement statements, including boundary cases at each volume limit. Version-1 tables (one band + beyond) still load, as a two-band table.

**Marginal DSM rate** is the multiplier of the outermost band in use × NR — the ₹/kWh of the next MW of deviation. It is the price any paid flexibility has to beat, compared like for like with the flexibility's cost per delivered kWh (§5.2).

---

## 4. Seeing ahead: the forecast

**Horizon:** 8 blocks (2 hours), each with P10, P50 and P90 values.

**1. Level correction.** Every update learns how far today is running from the day-ahead profile:

```
level_d  ← 0.7·level_d  + 0.3·(actual demand / profile demand)
level_re ← 0.7·level_re + 0.3·(actual RE / profile RE)
```

**2. Forecast for block b.** The correction fades with lead time:

```
decay   = 0.82^b
demand  = profile_demand · (1 + (level_d − 1)·decay)
RE      = profile_RE     · (1 + (level_re − 1)·decay)
dev     = demand − (in-state non-RE gen + RE) − schedule − held_flexibility
ACE_P50 = −dev
```

- `held_flexibility` assumes the DR now delivering stays for 2 blocks, then releases at 50% per block.

**3. Uncertainty** grows with √lead time:

```
σ_demand = 0.6% · demand · √b
σ_RE     = 8%   · RE     · √b
σ        = √(σ_demand² + σ_RE²)
P10/P90  = P50 ∓ 1.2816 · σ
```

**4. Predicted violations.**
- **Lines:** at blocks 1, 2 and 4, bus loads are scaled by the forecast demand ratio and RE output by the RE ratio, the power flow is re-solved, and any line ≥ 95% is flagged.
- **ACE:** a block is flagged when |ACE P50| ≥ 100 MW, or P10 ≤ −300, or P90 ≥ 300.
- Only the earliest violation per line is kept.

**5. Accuracy.** The 1-block-ahead demand forecast is scored against what happened, giving the **MAPE** over the last 96 samples.

**Anomaly detection:**
- An EWMA z-score runs on the demand forecast residual: α = 0.02, learning only from normal behaviour (|z| < 4).
- |z| ≥ 4 raises a demand-anomaly alarm.

The production ML ensemble (LightGBM / TFT) can replace this model behind the same interface, and the accuracy tracker scores whichever model is in use.

---

## 5. Deciding: the DR event engine

### 5.1 When an event opens, revises and closes

| Step | Rule |
| --- | --- |
| **Open** | \|ACE\| ≥ **100 MW**, sustained **60 s** (immediately in EMERGENCY); not at autonomy L0; outside the post-event cool-down. *Application policy, not a grid-code time* |
| **Revise** (MPC re-solve) | Every new 15-min block; on a material change in the requirement (> max(80 MW, 25%)); on a command failure; or on escalation to EMERGENCY |
| **Wind down** | Underlying requirement < **60 MW** for 3 consecutive ticks → release resources → close → settle |

**Underlying requirement** is what is actually needed, with our own actions backed out, so the event doesn't switch itself off while it is working:

```
underlying = (ACE in the event's direction) + MW our resources are delivering now + MW currently rotated out (UP only)
```

Rotated-out MW is counted on purpose: paid flexibility stays sized to the full over-drawal, so load rotation is what gets released first.

Each revision runs these steps:

```
flexibility of every asset ─► LP optimiser (OPTIMAL) ─► Digital Twin ─┬─ pass ─► autonomy policy ─► commands
                                   ▲                                  │
                                   └── exclude / derate, re-solve ◄───┘ fail (up to 4 passes)
```

### 5.2 What each resource can really give

**Technical headroom** in the event's direction:

| Type | UP (less load / more supply) | DOWN (absorb surplus) |
| --- | --- | --- |
| Demand (interruptible, shiftable, industrial, DER) | baseline − min load | max load − baseline |
| Generation | max − baseline | baseline − min |
| BESS | min(power, usable energy · η_d / duration), where usable = (SoC − SoC_min) · capacity | min(power, room to SoC_max / η_c / duration) |

**Available capacity:**

```
available = min(technical, state contract share + emergency share)
```

- The emergency share is released only in EMERGENCY.
- SRAS/TRAS (ancillary) commitments are **locked** and never dispatched for DR.

**Expected delivery and cost — one definition everywhere.** The platform pays only for delivered energy, so cost and reliability play different roles:

```
expected   = available · reliability                      ← reliability scales the MW we can count on, nothing else
pay rate   = ₹ paid per delivered kWh                      ← the same rate settlement pays (§6), locked at dispatch
rebound    = reboundFrac · off-peak price                  ← ₹ per delivered kWh for energy that returns after release
effective  = pay rate + rebound                            ← ₹ per delivered kWh: ranking, economic filter, LP, display
```

| Resource | Pay rate |
| --- | --- |
| Demand-side (interruptible, shiftable, industrial, DER) | Bid. The consumer's own opportunity cost is already priced into the bid |
| BESS discharging (UP) | Bid + recharge energy = bid + off-peak price / (η_c · η_d) |
| BESS charging (DOWN) | Degradation cost |
| Generation UP | Variable cost + wear |
| Generation DOWN | Credit: −60% of variable cost saved (part-load heat rate), plus wear |

An unreliable resource is not marked up in price: it contributes fewer expected MW, so the optimiser buys more capacity to cover the requirement.

**Timing: within-block response.** A resource that takes 12 minutes to respond delivers only the last 3 minutes of a 15-minute block. The platform credits each block with what the response trajectory actually delivers:

```
g(t)   = clamp((t − d) / τ, 0, 1)       d = response delay (min), τ = available MW / ramp rate (min)
φ_b    = (1/15) ∫ g(t) dt over block b  share of block b's energy delivered
E_i,b  = R_i · φ_i,b · x_i,b · 0.25 h   expected energy in block b
```

For example, a 12-minute response with an instant ramp gives φ = 0.2 in block 1 and 1.0 from block 2. A resource already delivering keeps full credit for what it delivers now, but any **increase** is a new instruction: the plant re-plans, so the increment goes through the response delay and ramp again — `φ_b = (current + φ_inc,b · (available − current)) / available`. The earliest usable block is the first with φ > 0. The remaining duration budget = max duration − blocks already used.

Still to be learned per resource: time to first response, to 50% and to full output; sustained duration and availability windows; recovery and rebound profile; measurement, gateway and command delays; and proven reliability from metered output (not acknowledgements).

**Economic DR only in NORMAL.** When severity is NORMAL, a resource whose effective cost (₹ per delivered kWh) ≥ the DSM marginal rate (₹ per kWh of deviation) is skipped, because paying it would cost more than the deviation it removes.

### 5.3 The optimiser

A network-constrained, multi-block linear program, solved with HiGHS. Horizon = 4 blocks (1 hour), re-solved every block (model-predictive control).

**Dispatch priority.** Resources are used in strict tiers:

| Tier | Resources | Why this order |
| --- | --- | --- |
| 1 | **BESS** | Fastest, no consumer impact, fully controllable |
| 2 | **Industrial flexibility** | Contracted envelopes inside accepted offers (§11) |
| 3 | Other paid flexibility | Generation re-dispatch, interruptible, shiftable, DER |
| 4 | RTM purchase | About 1 h lead (§2.1) |
| last | **Load rotation** | Not in the optimiser: only the residual after every tier, with approval (§7) |

Each tier is used fully — up to network, ramp, state-of-charge, response-time and offer limits — before the next is touched; within a tier the cheapest goes first. This is enforced by a tier step π added per expected MWh, larger than the widest cost spread between resources, so priority dominates cost across tiers but cost still orders resources inside a tier. Reported costs never include π.

**Variables**
- `x[i,b]` — MW commanded (setpoint) from resource i in block b; expected delivery is `R_i · φ_i,b · x[i,b]`
- `s[b]` — unserved requirement
- `v[l,b]` — overload slack on line l

**Objective**

```
min  Σ (pay + rebound + π·(tier_i − 1))_i · R_i · φ_i,b · x[i,b] · 0.25 h · 1000   ← priority, then cost
   + λ · Σ s[b]                                     ← unserved; λ above the last tier, so a need is never left unserved while a lower tier has room
   + μ · Σ v[l,b]                                                   ← overload, μ = 10⁷ (≫ λ)
```

**Constraints**

```
Σ_i R_i·φ_i,b·x[i,b] + s[b] ≥ req                      balance (expected block-average MW)
Σ_i R_i·φ_i,b·x[i,b] ≤ 1.05·req + 20                   no over-correction
|f0_l + Σ_i PTDF[l,bus_i]·dir·x[i,b]| − v[l,b] ≤ limit_l   thermal limit, both directions
0 ≤ x[i,b] ≤ available_i ;  x = 0 where φ_i,b = 0       capacity, response time
x[i,b] − x[i,b−1] ≤ ramp_i · 15 min                     ramp (x[i,−1] = current MW)
Σ_b φ_i,b·x[i,b]·0.25/η_d ≤ (SoC − SoC_min)·capacity    BESS energy (stored energy; η_d applied once)
Σ_b x[i,b] ≤ maxBlocks_i · available_i                 duration budget
```

- `f0` is the base flow with our own current delivery backed out, so each re-solve starts from a "what if we weren't acting" baseline.
- A tiny index tie-break keeps the merit order stable between re-solves.
- **RTM** here is a **purchase for a deficit** (UP only), at RTM ACP + ₹0.05/kWh. Delivery comes in the four blocks after the session (about 1 h), so it can't deliver inside the 4-block horizon and shows "beyond this horizon". A surplus would need a separate, rule-compliant selling path, which is not modelled; the Options tab marks RTM n/a for a surplus.

**Outputs**
- Allocations by block, ranked by effective cost, with caps explained (energy-limited, max duration, ramp-limited).
- Skipped resources, each with the reason.
- **Binding lines** with their **shadow prices** (₹/MW). These are LP duals: how much one more MW of line capacity would save.
- Coverage, post-dispatch line loading and rebound MW.

**Costs of a plan**

```
resource_rs   = Σ expected MWh · 1000 · pay rate            (paid to DR / BESS / generation)
rtm_rs        = same, for the RTM purchase
rebound_rs    = Σ reboundFrac · expected MWh · 1000 · off-peak price      (costed once, not inside the pay rate)
residual_dsm  = Σ_blocks DSM(deviation − dir · supplied_b)  (DSM still owed; negative = credit)
total_rs      = resource_rs + rtm_rs + rebound_rs + residual_dsm
do_nothing_rs = Σ_blocks DSM(deviation)                      (the counterfactual)
savings_rs    = do_nothing_rs − total_rs
```

### 5.4 Strategies compared (the **Options** tab)

Each strategy is the same LP restricted to a set of resource types:

| Strategy | Resources allowed | When it wins |
| --- | --- | --- |
| **Do nothing** | none | Baseline: absorb the deviation and pay DSM |
| **Buy in RTM** | Real-Time Market purchase (deficit only) | Long shortages where a ~1 h lead is acceptable |
| **Re-dispatch generation** | Intra-state thermal/hydro headroom | When cheap headroom sits on unconstrained buses |
| **BESS only** | Grid batteries | Fast and short; limited by SoC |
| **Demand response only** | Interruptible, shiftable, industrial, DER | Peaks where consumer flexibility is cheapest |
| **Priority mix** | All of the above in priority order (BESS → industrial → others → RTM) under network limits | Chosen and dispatched |

The Options tab pins the chosen plan first and ranks the rest by **total cost**. For each option it shows:
- paid cost vs DSM still owed;
- savings vs doing nothing;
- coverage %;
- time to effect (fastest resource's response; RTM = 60 min);
- the network effect on the worst line, compared with doing nothing.

If a cheaper option exists (by more than max(₹1,000, 0.5%)), the banner says what it gives up: lower coverage, a worse line loading, or slower action. Under-drawal settles at up to 0.9×NR, so over-covering can show up as a **DSM credit**.

### 5.5 Digital Twin safety gate

Before any command, the plan is simulated minute by minute against live state:

| Check | Fails / warns when | Automatic fix |
| --- | --- | --- |
| Heartbeat and command path | No gateway heartbeat for > 60 s | **Exclude** asset, re-solve |
| BESS state of charge | Trajectory would breach SoC_min | **Derate** to 95% of usable MW, re-solve |
| Line loading after dispatch (DC screening) | Dispatch makes any line worse than 100% (fail); pre-existing overload only relieved (warn) | Not dispatched if worse |
| Voltage screening (heuristic) | Estimate < 0.95 pu | warn — not an AC solution |
| Response lag | < 70% of planned block-1 energy after response delay and ramp | warn |
| P90 reserve kept free | Free expected flexibility < P90 margin | warn |
| Ancillary double-commitment | — | SRAS/TRAS always untouched |
| Rebound | Post-event rebound > 25% of requirement | warn |
| Requirement covered | Shortfall > 0.5 MW: fail in EMERGENCY (escalate to load management), warn otherwise | — |

Up to 4 optimise → twin passes. If the twin still fails, a human must decide.

The twin is a **pre-dispatch screening gate**, not a substitute for utility-grade network validation. A DC flow cannot establish that a real switching or dispatch action is safe.

### 5.6 Autonomy policy and approvals

| Level | Behaviour |
| --- | --- |
| L0 Monitor | Detect, forecast, alarm; no decisions |
| L1 Advisory | Plans generated; every command needs approval |
| L2 Supervised (default) | BESS and generation inside the envelope (≤ 250 MW total, twin passed) execute automatically; the rest await approval |
| L3 Autonomous | Every resource except RTM executes automatically once the twin passes |

**Automatic degradation to L1:**
- data confidence < 85%;
- any hard veto (§3.1): stale frequency, schedule or breaker status, or the SLDC-website source;
- control-loop latency high;
- kill switch (suspend) pressed.

Per-asset vetoes (lost heartbeat, stale SoC) send that asset to approval even at L2/L3.

**Dual authorisation:**
- Needed when the MW awaiting approval exceeds **200 MW**.
- The second approver must be a different user with dual authority.
- If a re-solve grows the plan beyond 1.1 × approved + 20 MW, a new approval round starts.

### 5.7 Dispatch

Command lifecycle:

```
AWAITING_APPROVAL → READY → SENT → ACKED → EXECUTING → COMPLETED
                                 └ no ack in 90 s → FAILED → asset excluded, alarm, re-solve
```

Any non-terminal command can end as CANCELLED (rejected or aborted) or SUPERSEDED (a newer setpoint for that asset).

- Commands are idempotent (command id) and there is **no blind resend**.
- **Authentication:** when a command is sent, the platform computes HMAC-SHA-256 over a fixed-format message (format version, key id, command id, DR event, resource, setpoint, command kind and issue time) with a dedicated command key (separate from the login/session secret; rotated by key id). The gateway verifies independently with its own copy of the key and refuses an unknown key id, a tag mismatch (constant-time compare), a message older than 30 s or from the future, or a replayed command id. This is message authentication, not a public-key signature; use an asymmetric scheme (e.g. Ed25519) where non-repudiation is required. The audit hash chain (§9) is a separate mechanism.
- **Four clocks per command:** acknowledgement (comms), first metered response (10% of the way to setpoint), full output (90%) and delivered energy (M&V). The Dispatch tab shows ack · first · full in seconds from send. The 90 s ack timeout is a comms limit, not a delivery guarantee.
- **Dead-band:** a new setpoint is sent only if it differs from the current one by more than max(5 MW, 8%). Small re-solves don't churn participants.
- **Under-delivery:** delivered < 70% of expected raises an alarm, and the next re-solve compensates.

---

## 6. Proving it and paying for it

**Measurement & verification** runs every tick while an event executes:

```
delivered MWh_i += telemetry MW_i · dt
expected  MWh_i += plan expected MW_i · dt
avoided DSM     += DSM(deviation + dir·Σ delivered) − DSM(deviation)     (counterfactual − actual)
```

**Performance and payment:**

```
performance p = delivered / expected
performance factor PF = 1.0                if p ≥ 90%
                      = (p − 0.5) / 0.4    if 50% < p < 90%
                      = 0                  if p ≤ 50%
payment = delivered MWh · 1000 · rate · PF
```

- `rate` = the pay rate locked at dispatch (§5.2) — the same rate the optimiser costed.
- Generation is always paid at PF = 1.
- RTM is paid at the RTM price.

**Counterfactual ledger.** Every savings figure for an event comes from one ledger, shown in the Settlement tab. It reconciles by assertion, with nothing counted twice:

```
  DSM with no action (counterfactual)
− DSM on the actual deviation
= DSM avoided
− participant payments          (DR, BESS, generation; backing-down generation can be a credit)
− RTM purchase
− rebound energy                (reboundFrac · delivered MWh · off-peak price)
= net savings
```

**Reliability learning** (used in the next event's expected MW):

```
reliability_new = min(0.995, 0.8 · reliability_old + 0.2 · min(1, p))
```

---

## 7. Last resort: load rotation

**Order of resort for over-drawal:** BESS, then industrial flexibility, then other paid flexibility (§5.3). Only the **residual** can become a load-rotation order. Under-drawal is never handled by load rotation.

**Residual for rotation** — measured wherever possible:

```
residual = planned shortfall that persists after ramp-in            min(residual block 1, residual block 2)
         + measured under-delivery after each response window       Σ (R·setpoint − metered)⁺ for commands past their window
```

A gap that flexibility closes within minutes never triggers rotation, and a resource that under-delivers is counted as soon as its response window has passed. MW already rotated out stay counted in, so rotation is what gets released first.

> **Three separate functions.** (1) The **DR optimiser** recommends the lowest-cost feasible response from enrolled resources. (2) The **load-management proposal** recommends a feeder-level residual action under the approved roster and approval rules. (3) **Independent protection** — under-frequency (UFR) and df/dt relays — operates under the approved protection scheme and the applicable Regional Power Committee settings. The platform never delays, disables or overrides it. The 49.80 Hz threshold below is a decision policy, not a relay setting.
>
> **Demo roster.** The shipped roster is demonstration data: groups built from 220 kV stations, a flat 30% rotatable share, and generated protected-feeder counts. It cannot establish that any real feeder is safe to open. Replace it with the DISCOM's verified feeder-level records (measured loads, protected classifications, approved roster, switching authority) before use. The Load Rotation page shows a DEMO ROSTER badge until then.

### Trigger

```
residual ≥ 50 MW  AND  ( frequency < 49.90 Hz   OR   residual > DSM band 1 = min(10% of schedule, 100 MW) )
sustained 120 s — or immediately when frequency < 49.80 Hz
```

The band follows the DSM rule table in force (its first band). An engineer can override it with a fixed MW. The 120 s hold is an application trigger.

### Approval

- An order proposes MW = residual, rounded to 10 MW (minimum 50 MW). It **never acts on its own**: shift-in-charge approval is required, plus dual authorisation above **200 MW**.
- An automatic proposal lapses if flexibility catches up first (residual < 25 MW).

### Roster groups

- Each DISCOM's 220 kV stations are split north to south into groups (A, B, C …) of about **4 stations**.
- A group's rotatable MW = Σ (its share of each parent bus's load) × **30%**. The 30% is the non-essential 11 kV feeder share.
- **Never rotated out:** hospitals, water works, railway traction, defence.

### Fair selection

1. Split the MW across DISCOMs in proportion to their load.
2. Repeatedly take the DISCOM furthest below its quota.
3. Within that DISCOM, take the eligible group with the **lowest fairness score**:

```
F_j = 0.5·H_j + 0.3·N_j + 0.2·D_j          (over the last 7 days; each term normalised by its maximum across groups)
H = interruption hours,  N = number of interruptions,  D = length of the latest interruption
```

Hard exclusions always win over the score. Every pick, every exclusion (daily limit reached, resting until hh:mm) and the next groups in line are recorded with their reason and shown on the order.

A group is eligible only if it is not already rotated out, has at least 10 min of its daily allowance left, and has rested at least one full spell since it was restored.

### Limits and rotation

| Rule | Value |
| --- | --- |
| Spell length | ≤ 45 min (a group at the end of its spell is swapped for the next fair group: **rotation**) |
| Daily limit | ≤ 120 min per group |
| Rest after a spell | One full spell (45 min) |
| Top-up | If the residual grows by > 50 MW beyond what is rotated out, more groups are added under the same order |
| Trim | If more than needed is rotated out (surplus > smallest group + 40 MW), give back the **largest group that still leaves enough off** |
| Restore | When the over-drawal is gone, restore in stages, longest-out first: one group every **120 s**, tightened to (time to the earliest spell limit ÷ groups still out) so no two groups are forced back together |
| Planned vs measured | Relief is **metered**, not assumed: if it stays below 90% of the planned MW for 2 min, the order escalates and the residual is re-estimated from metering (top-ups follow the approved order) |

**Energy not served** = ∫ rotated-out MW dt (MWh).

**Fairness** = most minus least minutes off today, across groups.

---

## 8. Alarms (ISA-18.2 style)

| Alarm | Priority | Condition | On-delay |
| --- | --- | --- | --- |
| Frequency low | P1 / P2 | < 49.80 / < 49.90 Hz | 10 s / 20 s |
| Frequency high | P3 | > 50.05 Hz | 30 s |
| ACE | P1 / P2 / P3 | \|ACE\| ≥ 1,000 / 300 / 100 MW | 20 / 30 / 60 s |
| Line overload / high loading | P1 / P3 | ≥ 100% / ≥ 90% | 20 / 60 s |
| Line out of service, islanding | P2, P1 | breaker open / island detected | immediate |
| Data confidence | P2 / P3 | < 80% / < 97% | 10 / 30 s |
| Telemetry stale or missing | P3 | point STALE or MISSING | 30 s |
| Asset heartbeat lost | P2 if in the active event | > 60 s without heartbeat | 30 s |
| Under-delivery | P2 | < 70% of expected | immediate |
| Demand anomaly | P3 | forecast residual \|z\| ≥ 4 | 30 s |
| Predicted overload | P3 | forecast line ≥ 100% within 30 min | 60 s |
| Autonomy degraded / suspended, loop latency | P2 / P3 / P2 | from policy and watchdog | immediate |

Alarm lifecycle:
- An alarm clears after its condition has been false for its **off-delay** (60 s), which suppresses chatter.
- An alarm stays on the active list until it is acknowledged, even after it clears.
- Alarms can be shelved, with a reason and an expiry.
- Related alarms are correlated into **incidents**, and an incident can open a DR event.

---

## 9. Trust and audit

- **RBAC:** operator, shift-in-charge, analyst, engineer, admin. JWT sessions.
- **Audit trail:** every event, analysis, twin result, approval, command, ack, alarm, override, config change and settlement is appended as:

  ```
  hash_n = SHA-256( [hash_{n−1}, seq, ts, kind, actor, ref, message] )      hash_0 = 0…0
  ```

  Changing any entry breaks every hash after it. **Verify** in Settlement & Audit re-computes the chain.

---

## 10. What the screen numbers mean

| Where | Number | Calculation |
| --- | --- | --- |
| Top bar | Data pill | Data confidence (§3.1), plus the worst source age when > 10 s; the tooltip lists ages for frequency, schedule, breakers and the SLDC fetch, and every active veto |
| Top bar | Block clock | Time block n of 96 (15-min DSM blocks); the bar shows progress through the day |
| Overview → **Grid need** | Need | Event requirement, or the live requirement when no event is open. Coverage bar = delivering (green) + rotated out (red) vs the need; gap = the rest |
| Overview → Grid need | ACE, DSM/block | §3.3 and §3.4, for the current block |
| DR Events → **Options** | Total, saves, coverage, acts in | §5.3 and §5.4 |
| DR Events → Safety | Checks | §5.5 |
| DR Events → Dispatch | Ack · first · full | Seconds from send to acknowledgement, first metered response and full output (§5.7) |
| DR Events → Settlement | Payment, PF, ledger, net savings | §6 |
| Grid | Demand Δ/blk | Demand change over the last 15 min of grid time |
| Grid | Most loaded corridor | max(\|flow\| / limit) from the DC power flow |
| Load Rotation | Uncovered OD vs limit | §7 trigger: residual vs DSM band |
| Load Rotation | Fairness, max x/120 | §7 |
| Load Rotation | Group tooltip F, order reasons, metered vs planned relief | §7 |
| Programmes → C&I | Offers, baseline vs meter, M&V | §11 |
| DR Events → Coordination | Lifecycle, shortage ledger | §11 |
| What-if → Shortage & rotation | Three cases | §11 |
| Forecast | ACE / Demand / RE next block | P50 for block 1 (§4); sparkline = P50 over the 8-block horizon |
| Forecast | Peak line loading (2 h) | Highest forecast loading across blocks 1, 2 and 4 |
| Forecast | MAPE | Mean absolute % error of the 1-block demand forecast |
| Alarms | Priority mix, oldest unacked | Over the active set (active, or cleared but not yet acknowledged) |

---

## 11. GridFlex: industrial flexibility and coordinated load rotation

GridFlex is part of ADRMS, not a separate product: industrial flexibility is the preferred controllable response after batteries, and load rotation is the governed fallback for what neither can cover.

### 11.1 Industrial participants and offers

An industry does not hand the grid an off-switch. It declares a **flexibility envelope** per time window:

| Offer term | Meaning |
| --- | --- |
| MW | Reduction offered (≤ the declared flexible range of its processes) |
| Window | Hours it applies (e.g. 17:00–23:30) |
| Response / min activation / max duration / recovery | Timing the plant can safely honour |
| Price ₹/MWh | Paid per verified MWh |
| Availability ₹/MW·h | Only if the programme pays for being available |
| Reliability | From metered past performance |
| Restrictions | e.g. no activation during a critical production stage |

Each industry lists its flexible processes (process load trim, batch or furnace rescheduling, non-critical HVAC and pumping) with MW, response, duration and restriction. **ADRMS may dispatch an industry only inside an accepted offer, and only on that offer's terms** (MW cap, price, response, duration); otherwise it is excluded with the reason ("no accepted offer covering this window", "offer awaiting acceptance"). Committed programme offers are accepted under the programme; voluntary offers wait for an operator.

### 11.2 Baseline and verified delivery (M&V)

Per participant, per 15-minute block t of an event:

```
B_t = baseline demand        mean metered demand over the 4 blocks before the event, bounded to ±10% of the declared level
M_t = metered demand         block average from the revenue meter (independent of the DR gateway)
R_t = max(0, B_t − M_t)      estimated reduction
A_t = accepted reduction     dispatched MW, capped at the offer
V_t = min(R_t, A_t)          verified reduction
E   = Σ V_t · Δt             delivered energy (MWh)
pay = E · P + availability − adjustment
adjustment = − E·P·(1 − PF),  PF = 1 (≥ 90% of accepted energy), linear 50–90%, 0 (≤ 50%)
```

Example: B = 600 MW, A = 60 MW. Block 1 metered 560 → R = 40, V = 40. Block 2 metered 530 → R = 70, V = 60 (capped). E = (40 + 60) × 0.25 = 25 MWh of 30 MWh accepted (83%, PF = 0.83). At ₹4,000/MWh and ₹100/MW·h availability: pay = 1,00,000 + 3,000 − 16,667 ≈ ₹86,333.

A difference between baseline and meter is not automatically proof of delivery, so the baseline method is versioned and every record can be **disputed** (payment held) and resolved with an audited adjustment. This M&V — not gateway telemetry — is the settlement of record for industrial participants.

### 11.3 One shortage ledger

```
  shortage            the over-drawal the event is sized for
− industrial          verified (min of baseline − meter and accepted)
− other flexibility   metered (BESS, generation, other DR)
− load rotation       metered relief
= residual            always from measured values — a 30 MW instruction is not a 30 MW reduction
```

Planned or commanded values sit beside the measured ones and are replaced as soon as metering is available. Escalations are raised for lagging resources, rotation delivering under plan, and a residual beyond the band with no order. **Emergencies are not a rigid sequence:** below 49.80 Hz or in EMERGENCY, authorised control-room procedure and independent UFR / df/dt protection take precedence over offers and the roster.

### 11.4 Event lifecycle

```
DETECTED → ASSESSED → PROPOSED → APPROVED → ACTIVATING → VERIFYING → RECOVERY → SETTLED
exceptions: REJECTED · CANCELLED · FAILED (every command failed) · DISPUTED
```

Phases come from the event state, its commands' clocks (acknowledged, first response, full output) and settlement. They only move forward within an event — a re-solve that briefly re-activates one resource does not send it back — except that a new approval round returns it to PROPOSED. Every transition is time-stamped.

### 11.5 Scenario simulator

On a copy of the live state, for a chosen shortage, duration and industrial participation (50 / 70 / 90%):

| Case | What it computes |
| --- | --- |
| No action | DSM on the full shortage over the duration |
| Flexibility first | The priority plan with industrial capacity scaled by participation: payments, rebound, DSM still owed, persistent residual |
| Rotation-assisted | The same, plus rotating the persistent residual (realised at ~92% of plan): groups and stations affected, unserved MWh, and its impact at an illustrative interruption cost (₹/kWh, set per utility study) |

### 11.6 Measures

Shortage MW; industrial offered / activated / verified MW; residual MW; rotation planned / measured MW; flexibility cost per delivered MWh; interruption hours and count per roster group (7 days); forecast MAPE; rebound MW; event success rate (delivered ≥ 90% of expected); M&V disputes.

> Programme values (prices, windows, availability rates, interruption cost) are demonstration data. Participation, baselines, compensation and dispute rules must come from the approved programme and the applicable State Commission regulations; until authorised, switching and dispatch stay with authorised operators.

---

## 12. Worked example

Situation:

- Schedule 5,300 MW, actual drawal 5,650 MW, so **over-drawal = 350 MW**.
- Frequency 49.95 Hz.
- Prices: DAM ₹5.40, RTM ₹7.20, ancillary ₹8.10.

**1. ACE** (Offset = 0; Bf = −160 MW/0.1 Hz as configured, pending the SLDC's declared value)

```
Ia − Is    = −5,650 − (−5,300)                = −350 MW
freq term  = −10 · (−160) · (49.95 − 50.00)   = −80 MW
ACE        = −350 − 80                        = −430 MW
```

ACE is short, so direction = **UP** and requirement = **430 MW**. |ACE| ≥ 100 MW, so severity = **ALERT** (application threshold; 49.95 Hz is inside the IEGC band).

**2. DSM exposure** (illustrative multipliers — not a CERC-settled amount)

```
NR    = max(5.40, 7.20, (5.40 + 7.20 + 8.10)/3 = 6.90) = ₹7.20/kWh  (RTM binding)
edges = min(10% · 5,300, 100) = 100 MW;  min(15% · 5,300, 200) = 200 MW;  then open
350 MW splits 100 / 100 / 150 across the three bands; f = 49.95 Hz → NORMAL multipliers 1.0 / 1.5 / 2.0
DSM   = (100·1.0 + 100·1.5 + 150·2.0) · 0.25 h · 1000 · 7.20
      = ₹1,80,000 + ₹2,70,000 + ₹5,40,000 = ₹9,90,000 per block
marginal rate = 2.0 · 7.20 = ₹14.40/kWh
```

So any flexibility cheaper than ₹14.40 per delivered kWh saves money. (With the earlier single-band table, the same deviation gave ₹8,55,000; the difference is exactly why the notified band table must be loaded.)

**3. A participant's effective cost**

An industrial participant bids ₹4.50/kWh, with rebound fraction 0.3 and reliability 0.90:

```
pay rate  = bid                         = ₹4.50 per delivered kWh
rebound   = 0.3 · 3.20                  = ₹0.96 per delivered kWh
effective = 4.50 + 0.96                 = ₹5.46 per delivered kWh   → well below ₹14.40, so it is dispatched
expected  = available MW · 0.90         (reliability shrinks the MW counted on, not the price)
```

If it responds in 12 minutes, block 1 counts only φ = 0.2 of its setpoint.

**4. Event.** The condition holds for 60 s, so an event opens.
- The LP fills the 430 MW of expected delivery in priority order — BESS first, then industries inside accepted offers (this one included), then other flexibility — cheapest-first within each tier, within line limits, ramps, SoC and each resource's response trajectory.
- The twin screens the plan.
- At L2, with no vetoes, BESS and generation up to 250 MW go automatically; the DR participants wait for approval. With any veto active, everything waits.
- If the MW awaiting approval exceeds 200, two approvers are needed.

**5. Settlement.** The participant was expected to deliver 10 MWh and delivered 7.6 MWh:

```
p  = 0.76  → PF = (0.76 − 0.5)/0.4 = 0.65
payment         = 7.6 · 1000 · ₹4.50 · 0.65 = ₹22,230      (pay rate locked at dispatch)
rebound energy  = 0.3 · 7.6 · 1000 · ₹3.20  = ₹7,296       (in the ledger)
new reliability = 0.8 · 0.90 + 0.2 · 0.76   = 0.872
```

The next event will count on 87.2% of their available MW.

**6. If flexibility runs out.** Suppose 180 MW stays uncovered for 2 minutes. 180 > 100 MW (band 1), so a **180 MW** load-rotation order is proposed and waits for shift-in-charge approval. On approval, roster groups are picked across DISCOMs by load share, least-rotated first, and rotated every ≤ 45 minutes until the over-drawal is covered. Load is then restored one group every 2 minutes. With the demo roster, this demonstrates the workflow only.

---

## 13. Validation before a utility pilot

| Area | Required before live use |
| --- | --- |
| Telemetry | Authorised SCADA/EMS (or equivalent) path with source timestamps; the SLDC-website mode stays advisory |
| DSM | Notified table for the buyer category with all amendments and orders, with provenance recorded; boundary tests against official statements |
| Network | Validated model (topology, impedances, ratings, transformers), AC load flow for voltage, applicable contingency studies |
| Load management | DISCOM-approved feeder roster with measured loads and protected classifications; switching stays with authorised operators |
| Resources | Per-resource response envelope (delays, ramp, duration, recovery) learned from metered data |
| Commands | Key management and rotation; gateway-side verification in the field equipment |
| Operations | Historical replay and shadow mode alongside existing operator decisions: false alarms, unserved requirement, delivery forecast error, line-limit violations, response delay, settlement reconciliation |

**Reference set:** CERC Indian Electricity Grid Code Regulations, 2023 (control-area operation, ACE, frequency response, ancillary services, demand management); CERC DSM Regulations, 2024, read with all amendments and applicable orders; IEX Real-Time Market rules (session and delivery timing); CEA advisories on minimising load shedding; the applicable State Commission regulations and DISCOM/SLDC operating procedures. Draft amendments (e.g. the draft Second Amendment to the IEGC, 2026) are consultation proposals, not in-force obligations.
