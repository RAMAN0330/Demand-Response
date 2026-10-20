# ADRMS — Operator Experience & Information Architecture

## 1. Re-analysis of the previous UI

| Issue | Why it fails in a control room |
| --- | --- |
| Sidebar with six peer pages, plus a lifecycle rail | Two competing navigation systems. Neither tells the operator what needs attention. |
| Freq / ACE / Deviation / Demand in the top bar | Metrics posing as navigation. They take the most valuable screen space but carry no context: no trend, no threshold, no meaning. |
| Event flow started by the operator (8 steps) | A tutorial, not operations. An operator should **supervise** the system's decisions, not walk through them. |
| "Simulate" as a peer of "Decide" and "Act" | Puts what-if exploration on the same level as live control. |
| Settlement, Registry and Audit as top-level items | These are analyst and engineer tasks, not real-time operator needs. |

## 2. Who needs what (task analysis)

| Persona | Primary tasks | Frequency | Placement |
| --- | --- | --- | --- |
| **SLDC shift operator** | Know the state; see what is abnormal; approve or reject; acknowledge alarms; override | continuous | **Primary navigation** |
| Shift-in-charge | Dual approvals; autonomy level; suspend/resume | several times per shift | Primary nav + header controls |
| Analyst / planner | Forecast accuracy, DSM performance, settlement, reports, what-if | daily | Secondary (Forecast & Analysis, Reports) |
| Engineer | Resource registry, thresholds, integrations, simulator | weekly | **More ▾ → Administration** |
| Admin | Users, roles | rare | Administration |

## 3. Navigation model

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ADRMS │ Command Center │ Operations │ Decisions (2) │ Alarms (5) │ Forecast & Analysis │ More ▾ │  ◉ ALERT · L2 Supervised · Data 98% · 15:07:42 B61 │ 👤 │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
                                                                         More ▾ = What-if sandbox · Resources · Reports & Audit · Administration
```

> **Update:** navigation now lives in a grouped, role-filtered sidebar (Operate · Plan · Settle · System) and the top bar names the current page; see the README. The reasoning below still holds for the order of destinations.

**Primary (top bar).** Five operator destinations, ordered by the operator's loop *understand → act*. Counts show pending work:

1. **Command Center.** Home. Answers the four questions on one screen.
2. **Operations.** Live grid: 3D map, constraints, resources in action, manual controls.
3. **Decisions.** What the system intends, is doing and has done: approvals, overrides, explanation.
4. **Alarms.** Prioritised alarms and correlated incidents: acknowledge, shelve, history.
5. **Forecast & Analysis.** Next 2 h with uncertainty, predicted violations, DSM and performance analysis.

**Secondary (More ▾).** Contextual, role-dependent:
- What-if sandbox
- Resources
- Reports & Audit
- Administration (autonomy policy, thresholds, integrations & data sources, simulator, users)

**System status (right side of header, not navigation).** Always visible and compact, because it qualifies everything else on screen:
- grid state pill (NORMAL / ALERT / EMERGENCY)
- autonomy level, plus a **suspend** control for authorised roles
- data confidence
- clock and block number
- connection status

Frequency, ACE, deviation and demand are **not** in the header. They live in the Command Center's *Now* panel and in Operations, together with their trends and thresholds.

## 4. The Command Center: four questions

```
┌──────────── NOW: what is happening ───────────┬──── AT RISK: what is abnormal ────────────┐
│ Grid vitals (f · ACE · deviation · demand ·    │ Prioritised alarms (P1→P4), incidents,      │
│ drawal) with sparkline + threshold             │ data-quality issues, constraint risks       │
│ 3D Karnataka map (compact, live)               │                                             │
├──────────── NEXT: what will happen ───────────┼──── INTENT: what the system will do ───────┤
│ ACE / deviation forecast (P10–P90), predicted   │ Active decision story:                      │
│ violations with time-to-impact                 │ Situation → Impact → Prediction →            │
│                                                │ Recommendation → Action → Outcome            │
│                                                │ Pending approvals · executing · recent        │
└────────────────────────────────────────────────┴────────────────────────────────────────────┘
```

The highest-priority item always surfaces at the top of its quadrant. Everything drills down to its own page.

## 5. Page template (applied to every page)

1. **Page header.** Title, one-line state summary, context (time, block), and page-level actions.
2. **Primary information.** The two to five figures that matter for this page.
3. **Analysis / visualisation.** Map, chart or timeline.
4. **Exceptions.** Issues needing attention on this page.
5. **Actions.** What the operator can do here, placed next to what they affect.
6. **Details.** A side drawer or tabs for evidence (formulas, constraints, raw data). Never shown by default.

Fixed-viewport layout: pages don't scroll vertically. Lists paginate to fit, and details open in drawers or tabs.

## 6. Key workflows

**A. Supervised autonomy (normal day)**
1. The operator glances at the Command Center. All green, intent "Monitoring".
2. A cloud event triggers. A P2 alarm appears in *At risk*; *Intent* shows "BESS 150 MW auto-dispatched (within envelope)"; *Outcome* updates live.
3. Nothing needs approval. The operator can open the decision to see why.

**B. Approval required**
1. The decision exceeds the envelope (industrial DR, 320 MW). The **Decisions** badge shows 1 pending.
2. The decision page shows the story, the alternatives and the twin verdict.
3. The operator approves. Because it is over 200 MW, it waits for the shift-in-charge's second approval.
4. Commands go out, and the outcome is tracked live.

**C. Degraded data**
1. Telemetry for one corridor goes stale. A data-quality alarm is raised and data confidence falls below 85%.
2. The header shows autonomy **degraded to advisory**. Decisions continue, but all of them require approval until data recovers.

**D. Override**
1. The operator aborts a decision, with a mandatory reason. Resources are released and the action is audited.
2. Alternatively, the shift-in-charge suspends autonomy globally (kill switch).

## 7. Visual system

- **Tone:** soft light theme, with near-white surfaces and slate text.
- **Colour has meaning only:** green normal, amber attention, red critical, sky blue for system intent and information, violet for ancillary and ISTS.
- **Typography:** tabular monospace for every live number. Sentence case. Labels sit above values.
- **Density:** 12–13 px body in data areas, 14 px headings. Cards use 12 px radius and hairline borders.
- **Motion:** only to signal change, such as new alarms, command waves and value flashes. Never decorative.
