// Regulatory constants, units and terminology used across the console, defined once.
// Terms follow Ministry of Power (MoP), CERC and CEA usage (British spelling: "programme", "metre" for length,
// "meter" for the instrument); the reference set matches docs/HOW-IT-WORKS.md.

/** CERC Indian Electricity Grid Code (IEGC) Regulations, 2023 — operating frequency band. */
export const IEGC = {
  fNominal: 50,
  fLow: 49.9,
  fHigh: 50.05,
  /** application thresholds for immediate emergency action (not IEGC band edges) */
  fEmergency: 49.8,
  fHighEmergency: 50.1,
} as const

/** A day is settled in 96 time blocks of 15 minutes (CERC DSM Regulations, 2024). */
export const BLOCK_MIN = 15
export const BLOCKS_PER_DAY = 96

/** Time block (1–96) of a time of day given in seconds since midnight. */
export function timeBlock(secondsOfDay: number): number {
  const s = ((secondsOfDay % 86400) + 86400) % 86400
  return Math.floor(s / (BLOCK_MIN * 60)) + 1
}

/** "Block 61 (15:00–15:15)" */
export function blockLabel(block: number): string {
  const start = (block - 1) * BLOCK_MIN
  const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  return `Block ${block} (${hm(start)}–${hm(start + BLOCK_MIN)})`
}

export interface BandStats {
  inPct: number
  belowPct: number
  abovePct: number
  mean: number
  std: number
  min: number
  max: number
}

/** Share of samples inside / below / above the IEGC band, with mean and population standard deviation (one pass, Welford). */
export function bandStats(samples: number[], lo: number = IEGC.fLow, hi: number = IEGC.fHigh): BandStats {
  let n = 0
  let mean = 0
  let m2 = 0
  let below = 0
  let above = 0
  let min = Infinity
  let max = -Infinity
  for (const x of samples) {
    if (!Number.isFinite(x)) continue
    n++
    const d = x - mean
    mean += d / n
    m2 += d * (x - mean)
    if (x < lo) below++
    else if (x > hi) above++
    if (x < min) min = x
    if (x > max) max = x
  }
  if (!n) return { inPct: 100, belowPct: 0, abovePct: 0, mean: IEGC.fNominal, std: 0, min: IEGC.fNominal, max: IEGC.fNominal }
  return { inPct: ((n - below - above) / n) * 100, belowPct: (below / n) * 100, abovePct: (above / n) * 100, mean, std: Math.sqrt(m2 / n), min, max }
}

// ── Units (SI symbols as used in CEA / Grid-India reporting) ───────────────────────────────────────────

const IN = (v: number, d = 0) => v.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d })

/** Energy: MWh below 1 000 MWh, MU (million units = GWh) above, as in MoP / CEA energy reporting. */
export function fmtEnergy(mwh: number): string {
  const a = Math.abs(mwh)
  return a >= 1000 ? `${IN(mwh / 1000, 2)} MU` : `${IN(mwh, a < 10 ? 2 : 1)} MWh`
}

/** Tariff / price: ₹/kWh (equivalently ₹ per unit). */
export const fmtTariff = (rsPerKwh: number) => `₹${rsPerKwh.toFixed(2)}/kWh`

/** Frequency always to three decimals (1 mHz resolution of the SCADA feed). */
export const fmtHz = (f: number) => `${f.toFixed(3)} Hz`

// ── Terminology ───────────────────────────────────────────────────────────────────────────────────────

/** Glossary shown in the console's reference panel. Plain definitions, in MoP / CERC wording. */
export const GLOSSARY: { term: string; def: string }[] = [
  { term: 'SLDC', def: 'State Load Despatch Centre: the apex body for integrated operation of the state power system.' },
  { term: 'RLDC / NLDC', def: 'Regional / National Load Despatch Centre (Grid Controller of India Ltd).' },
  { term: 'DISCOM', def: 'Distribution licensee (BESCOM, MESCOM, HESCOM, GESCOM, CESC in Karnataka).' },
  { term: 'Schedule', def: 'Drawal from the inter-state grid scheduled for each 15-minute time block.' },
  { term: 'Actual drawal', def: 'Metered net drawal of the state control area from the inter-state grid.' },
  { term: 'Deviation', def: 'Actual drawal minus schedule; positive = over-drawal, negative = under-drawal.' },
  { term: 'DSM', def: 'Deviation Settlement Mechanism: block-wise charges for deviation under the CERC DSM Regulations, 2024.' },
  { term: 'ACE', def: 'Area Control Error (IEGC 2023): interchange deviation corrected for frequency bias.' },
  { term: 'Time block', def: 'One of 96 fifteen-minute settlement intervals in a day (Block 1 = 00:00–00:15).' },
  { term: 'Demand response (DR)', def: 'A change in consumer load, against its baseline, in response to a grid signal or price.' },
  { term: 'Baseline', def: 'Counterfactual load the participant would have drawn without the DR event; delivery = baseline − metered.' },
  { term: 'M&V', def: 'Measurement and verification of delivered DR energy against the baseline.' },
  { term: 'Load rotation', def: 'Planned, rostered disconnection of non-essential feeders as the last resort, with essential loads protected.' },
  { term: 'BESS', def: 'Battery energy storage system.' },
  { term: 'SRAS / TRAS', def: 'Secondary / Tertiary Reserve Ancillary Service under the CERC Ancillary Services Regulations, 2022.' },
  { term: 'N-1', def: 'Security criterion: the grid stays within limits after the outage of any single element.' },
  { term: 'MU', def: 'Million units = 1 GWh = 1 000 MWh.' },
]

/** Instruments the console's rules and labels are aligned with. Status notes are in docs/HOW-IT-WORKS.md. */
export const REFERENCES: { body: string; title: string; applies: string }[] = [
  { body: 'CERC', title: 'Indian Electricity Grid Code (IEGC) Regulations, 2023', applies: 'Frequency band, ACE, control-area operation, reserves, demand management' },
  { body: 'CERC', title: 'Deviation Settlement Mechanism and Related Matters Regulations, 2024 (with amendments)', applies: 'Block-wise deviation volume limits and charges' },
  { body: 'CERC', title: 'Ancillary Services Regulations, 2022', applies: 'SRAS / TRAS kept separate from DR capacity' },
  { body: 'CEA', title: 'Grid Standards Regulations, 2010', applies: 'Operating limits for frequency, voltage and line loading' },
  { body: 'CEA', title: 'Advisories on minimising load shedding', applies: 'Load rotation as last resort, essential loads protected' },
  { body: 'SERC', title: 'State Commission (KERC) regulations and orders', applies: 'DR programme approval, baselines, compensation, intra-state settlement' },
  { body: 'MoP', title: 'Electricity (Rights of Consumers) Rules, 2020, as amended', applies: 'Consumer supply reliability and time-of-day tariff context' },
]
