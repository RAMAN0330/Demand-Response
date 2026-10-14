import type { Severity } from '@/data/types'
import { IEGC } from '@/lib/standards'

export const SEVERITY_STYLE: Record<Severity, string> = {
  NORMAL: 'bg-emerald-50 text-emerald-700 ring-emerald-300/70',
  ALERT: 'bg-amber-50 text-amber-700 ring-amber-300/80',
  EMERGENCY: 'bg-rose-50 text-rose-700 ring-rose-300 animate-pulse',
}

/** True outside the emergency thresholds / outside the IEGC 2023 band. */
export const freqBad = (f: number) => f < IEGC.fEmergency || f > IEGC.fHighEmergency
export const freqWarn = (f: number) => f < IEGC.fLow || f > IEGC.fHigh

export function freqClass(f: number) {
  if (freqBad(f)) return 'text-red-500'
  if (freqWarn(f)) return 'text-amber-600'
  return 'text-emerald-600'
}

export const chartTooltip = {
  contentStyle: { background: '#ffffff', border: '1px solid #dde2e8', borderRadius: 10, fontSize: 12, boxShadow: '0 4px 14px rgba(15,23,42,0.08)' },
  labelStyle: { color: '#6a7686' },
}

/** "+12" / "−40" / "0" — avoids rendering "-0" for values that round to zero */
export function signed(v: number) {
  const r = Math.round(v)
  if (r === 0) return '0'
  return r > 0 ? `+${r}` : `${r}`
}
