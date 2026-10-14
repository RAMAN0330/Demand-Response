// Alarm-system performance indicators (ISA-18.2 / IEC 62682, EEMUA 191 benchmarks), computed from alarm history.
// All times are grid-clock seconds, so the figures stay right when the simulator runs faster than real time.
import type { Alarm } from '@/data/types'

/** EEMUA 191 / ISA-18.2 per-operator benchmarks for a 10-minute window. */
export const ALARM_BENCH = {
  /** average alarms per 10 min that is "very likely to be acceptable" */
  acceptable: 1,
  /** average alarms per 10 min that is "manageable" */
  manageable: 2,
  /** ≥ this many alarms in any 10 min is an alarm flood */
  flood: 10,
  /** an alarm active longer than this is "standing" */
  standingS: 24 * 3600,
  /** the same alarm raised this many times inside one 10-min window is "chattering" */
  chatter: 3,
} as const

export interface AlarmKpi {
  /** alarms raised in each 10-min bucket, oldest first */
  buckets: number[]
  /** bucket start times (grid-clock s) */
  bucketStart: number[]
  avgPer10: number
  peakPer10: number
  floodPct: number
  standing: number
  chattering: string[]
  /** most frequent alarm sources (key → count), worst first */
  badActors: { key: string; title: string; n: number }[]
}

/**
 * One pass over the history: O(n) bucketing plus an O(n log n) sort per alarm key for chatter detection.
 * `windowS` is the look-back (default 2 h, i.e. twelve 10-min buckets).
 */
export function alarmKpi(alarms: Alarm[], now: number, windowS = 7200): AlarmKpi {
  const W = 600
  const n = Math.max(1, Math.round(windowS / W))
  const from = now - n * W
  const buckets = new Array<number>(n).fill(0)
  const byKey = new Map<string, { title: string; t: number[] }>()
  let standing = 0
  for (const a of alarms) {
    if (a.state === 'ACTIVE' && now - a.raised_at >= ALARM_BENCH.standingS) standing++
    if (a.raised_at < from || a.raised_at > now) continue
    buckets[Math.min(n - 1, Math.floor((a.raised_at - from) / W))]++
    const k = byKey.get(a.key) ?? { title: a.title, t: [] }
    k.t.push(a.raised_at)
    byKey.set(a.key, k)
  }
  const chattering: string[] = []
  for (const [key, v] of byKey) {
    v.t.sort((x, y) => x - y)
    // sliding window: any ALARM_BENCH.chatter raises within 10 min
    for (let i = ALARM_BENCH.chatter - 1; i < v.t.length; i++) {
      if (v.t[i] - v.t[i - ALARM_BENCH.chatter + 1] <= W) {
        chattering.push(key)
        break
      }
    }
  }
  const total = buckets.reduce((s, x) => s + x, 0)
  return {
    buckets,
    bucketStart: buckets.map((_, i) => from + i * W),
    avgPer10: total / n,
    peakPer10: Math.max(0, ...buckets),
    floodPct: (buckets.filter((b) => b >= ALARM_BENCH.flood).length / n) * 100,
    standing,
    chattering,
    badActors: [...byKey.entries()]
      .map(([key, v]) => ({ key, title: v.title, n: v.t.length }))
      .sort((x, y) => y.n - x.n)
      .slice(0, 5),
  }
}

/** EEMUA 191 verdict for an average 10-min alarm rate. */
export function rateVerdict(avgPer10: number): { label: string; tone: 'good' | 'warn' | 'bad' } {
  if (avgPer10 <= ALARM_BENCH.acceptable) return { label: 'acceptable', tone: 'good' }
  if (avgPer10 <= ALARM_BENCH.manageable) return { label: 'manageable', tone: 'warn' }
  return { label: 'overloaded', tone: 'bad' }
}
