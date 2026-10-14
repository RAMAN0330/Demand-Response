import { describe, expect, it } from 'vitest'
import { bandStats, blockLabel, fmtEnergy, IEGC, timeBlock } from '../standards'
import { alarmKpi, rateVerdict } from '../alarmKpi'
import type { Alarm } from '@/data/types'

describe('time blocks', () => {
  it('numbers the 96 fifteen-minute blocks from 1', () => {
    expect(timeBlock(0)).toBe(1)
    expect(timeBlock(15 * 60 - 1)).toBe(1)
    expect(timeBlock(15 * 60)).toBe(2)
    expect(timeBlock(86399)).toBe(96)
    expect(timeBlock(86400)).toBe(1)
  })
  it('labels a block with its clock window', () => {
    expect(blockLabel(61)).toBe('Block 61 (15:00–15:15)')
    expect(blockLabel(96)).toBe('Block 96 (23:45–00:00)')
  })
})

describe('IEGC band statistics', () => {
  it('splits samples into below / in / above the band', () => {
    const b = bandStats([49.85, 49.95, 50.0, 50.1])
    expect(b.belowPct).toBe(25)
    expect(b.inPct).toBe(50)
    expect(b.abovePct).toBe(25)
    expect(b.min).toBe(49.85)
    expect(b.max).toBe(50.1)
  })
  it('matches the two-pass mean and standard deviation', () => {
    const xs = Array.from({ length: 500 }, (_, i) => 50 + 0.03 * Math.sin(i / 7))
    const mean = xs.reduce((a, x) => a + x, 0) / xs.length
    const std = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length)
    const b = bandStats(xs)
    expect(b.mean).toBeCloseTo(mean, 12)
    expect(b.std).toBeCloseTo(std, 12)
  })
  it('treats an empty window as nominal', () => {
    expect(bandStats([]).mean).toBe(IEGC.fNominal)
    expect(bandStats([]).inPct).toBe(100)
  })
})

describe('energy units', () => {
  it('switches from MWh to MU at 1 000 MWh', () => {
    expect(fmtEnergy(5.5)).toBe('5.50 MWh')
    expect(fmtEnergy(152.14)).toBe('152.1 MWh')
    expect(fmtEnergy(2500)).toBe('2.50 MU')
  })
})

describe('alarm KPIs (ISA-18.2 / EEMUA 191)', () => {
  const al = (key: string, t: number): Alarm => ({
    id: `${key}-${t}`,
    key,
    rule: 'r',
    category: 'NETWORK',
    priority: 3,
    title: key,
    detail: '',
    value: null,
    raised_at: t,
    last_seen: t,
    state: 'CLEARED',
    acked: false,
    acked_by: null,
    shelved_until: null,
    cleared_at: t + 10,
    incident_id: null,
  })
  it('buckets by 10 minutes and finds chattering sources', () => {
    const now = 7200
    const xs = [al('A', 100), al('A', 200), al('A', 300), al('B', 7000)]
    const k = alarmKpi(xs, now)
    expect(k.buckets).toHaveLength(12)
    expect(k.buckets[0]).toBe(3)
    expect(k.buckets[11]).toBe(1)
    expect(k.peakPer10).toBe(3)
    expect(k.chattering).toEqual(['A'])
    expect(k.badActors[0]).toMatchObject({ key: 'A', n: 3 })
  })
  it('grades the average rate against the benchmark', () => {
    expect(rateVerdict(0.5).tone).toBe('good')
    expect(rateVerdict(1.5).tone).toBe('warn')
    expect(rateVerdict(4).tone).toBe('bad')
  })
})
