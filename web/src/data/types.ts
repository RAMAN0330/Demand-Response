// Types mirrored from the KSFP backend API (backend/ksfp).

export interface Bus {
  id: string
  name: string
  lon: number
  lat: number
  kv: number
  discom?: string
  loadShare: number
  external?: boolean
  participation?: number
  region?: string
}
export interface Line {
  id: string
  from: string
  to: string
  kv: number
  limitMW: number
  hvdc?: boolean
  name?: string
}
export interface Generator {
  id: string
  name: string
  bus: string
  type: 'coal' | 'hydro' | 'solar' | 'wind' | 'nuclear'
  capacityMW: number
  baseMW: number
  owner: string
  lon: number
  lat: number
}
export interface Asset {
  id: string
  name: string
  short: string
  type: 'interruptible' | 'shiftable' | 'bess' | 'industrial' | 'der' | 'generation'
  discom: string
  bus: string
  lon: number
  lat: number
  baselineMW: number
  maxLoadMW: number
  contractMW: number
  reserve: { state: number; sras: number; tras: number; emergency: number }
  responseMin: number
  rampMWpm: number
  maxDurationMin: number
  reboundFrac: number
  bidRs: number
  reliability: number
  protocol: string
  description: string
  bess?: { energyMWh: number; soc: number; socMin: number; socMax: number }
}
export interface LoadChannel {
  id: string
  name: string
  discom: string
  lat: number
  lon: number
  kv: number
  parent_bus: string
  weight: number
}
export interface GenStation {
  id: string
  name: string
  type: string
  owner: string
  lat: number
  lon: number
  capacityMW: number
  model_gen: string
}
export interface Topology {
  meta: { baseDemandMW: number; baseScheduleMW: number; freqBiasMWPer0_1Hz: number }
  sldc: { name: string; lon: number; lat: number }
  boundary: [number, number][]
  buses: Bus[]
  lines: Line[]
  generators: Generator[]
  assets: Asset[]
  channels: { load_channels: LoadChannel[]; gen_stations: GenStation[]; sources: { discom_pages: string[]; generation_page: string } }
  roster: RosterGroupDef[]
}
/** A load-shedding roster group: a DISCOM's block (A–D) of 220 kV stations whose non-essential feeders rotate. */
export interface RosterGroupDef {
  id: string
  discom: string
  letter: string
  name: string
  channels: string[]
  protected: Record<string, number>
  lat: number
  lon: number
}
export interface SheddingSummary {
  active_mw: number
  groups_out: number
  residual_mw: number
  od_limit_mw: number
  order: { id: string; state: string; mw: number; needs_dual: boolean; approvals: number } | null
  next_rotation: number | null
  shed_channels: Record<string, string>
}

export type Severity = 'NORMAL' | 'ALERT' | 'EMERGENCY'

export interface DecisionSummary {
  id: string
  incident_id: string | null
  state: string
  severity: Severity
  direction: 'UP' | 'DOWN'
  opened_at: number
  updated_at: number
  closed_at: number | null
  revision: number
  headline: string
  requirement_mw: number
  planned_mw: number
  delivered_mw: number
  awaiting_mw: number
  auto_mw: number
  needs_dual: boolean
  approvals: { user: string; role: string; ts: number; mw: number }[]
  closed_reason: string
  net_benefit_rs: number | null
}

export interface Frame {
  type: 'state'
  ts: number
  clock: string
  block: number
  time_scale: number
  severity: Severity
  direction: 'UP' | 'DOWN'
  frequency: number
  ace: number
  deviation: number
  requirement: number
  demand: number
  drawal: number
  schedule: number
  state_gen: number
  central_gen: number
  re: number
  gen_by_type: Record<string, number>
  gen_output: Record<string, number>
  bus_load: Record<string, number>
  flows: Record<string, number>
  loading: Record<string, number>
  injections: Record<string, number>
  outaged: string[]
  islanded: string[]
  max_line: { line: string; loading: number }
  assets: Record<string, { mw: number; soc: number | null; hb_age: number }>
  channels: Record<string, { mw: number; src: 'KPTCL' | 'SIM'; kind: 'load' | 'gen' }>
  confidence: number
  quality_issues: Record<string, string>
  dsm_per_block_rs: number
  nr: number
  autonomy: { level: number; effective: number; reasons: string[]; suspended: boolean; vetoes?: string[] }
  /** seconds since each critical input was measured at its source (null = never received) */
  data_age?: { frequency: number | null; schedule: number | null; breakers: number | null; sldc: number | null }
  counts: { alarms: number; p1: number; unacked: number; decisions_open: number; awaiting: number }
  active_decision: DecisionSummary | null
  shedding?: SheddingSummary
  live_setpoints: Record<string, number>
  source: { mode: string; kptcl: { ok: number; total: number; live: number } | null }
  loop_ms: number
}

export interface Alarm {
  id: string
  key: string
  rule: string
  category: string
  priority: number
  title: string
  detail: string
  value: number | null
  raised_at: number
  last_seen: number
  state: 'ACTIVE' | 'CLEARED'
  acked: boolean
  acked_by: string | null
  shelved_until: number | null
  cleared_at: number | null
  incident_id: string | null
}

export interface Command {
  id: string
  decision_id: string
  asset_id: string
  asset_name: string
  protocol: string
  setpoint: number
  expected_mw: number
  kind: string
  state: string
  created: number
  requires_approval: boolean
  signature: string
  sent_at: number | null
  acked_at: number | null
  first_response_at?: number | null
  full_output_at?: number | null
  auth?: { alg: string; key_id: string; issued_at: number; mac: string } | null
  delivered_mw: number
  under_delivering: boolean
  note: string
}

export interface User {
  username: string
  role: string
  role_label: string
  display: string
  permissions: string[]
}
