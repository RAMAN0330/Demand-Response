// Forecast & Analysis — what will happen (P10–P90), predicted violations, recent behaviour, forecast accuracy.
import { Area, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { Activity, Cable, Clock3, Crosshair, IndianRupee, ShieldCheck, Sun, Target, TriangleAlert } from 'lucide-react'
import { Panel, Stat, StatStrip } from '@/components/page'
import { useApi } from '@/hooks'
import { fmtMW, fmtRs } from '@/lib/geo'
import { bandStats, IEGC } from '@/lib/standards'
import { chartTooltip, signed } from '@/lib/ui'
import { cn } from '@/lib/utils'
import { useLive } from '@/store/useLive'
import type { ForecastT } from './CommandCenter'

export function AnalysisPage() {
  const { data: fc } = useApi<ForecastT>('/forecast', { intervalMs: 15000 })
  const trend = useLive((s) => s.trend)
  const f = useLive((s) => s.frame)!
  const rows =
    fc?.blocks.map((b) => ({
      label: b.label,
      ace: b.ace.p50,
      aceBand: [b.ace.p10, b.ace.p90],
      demand: b.demand.p50,
      demandBand: [b.demand.p10, b.demand.p90],
      re: b.re.p50,
      reBand: [b.re.p10, b.re.p90],
      maxLine: b.max_line ? b.max_line.loading * 100 : null,
    })) ?? []
  const t = trend.slice(-360)
  const b1 = fc?.blocks[0]
  const blocks = fc?.blocks ?? []
  const peak = blocks.reduce<{ loading: number; label: string; when: string } | null>(
    (m, b) => (b.max_line && (!m || b.max_line.loading > m.loading) ? { loading: b.max_line.loading, label: b.max_line.label, when: b.label } : m),
    null,
  )
  const firstLead = fc?.violations.length ? Math.min(...fc.violations.map((v) => v.lead_min)) : null
  const mape = fc?.accuracy.mape_1block_pct ?? null
  const mw = (v: number) => `${(v / 1000).toFixed(1)}k`
  const legend = { iconSize: 8, wrapperStyle: { fontSize: 10, paddingTop: 2 } } as const
  return (
    <div className="flex h-full flex-col gap-3">
      <StatStrip>
        <Stat
          icon={<Crosshair />}
          label="ACE next block"
          value={b1 ? `${signed(b1.ace.p50)} MW` : '—'}
          delta={{ text: `now ${signed(f.ace)}` }}
          spark={blocks.map((b) => b.ace.p50)}
          sub={b1 ? `P10 ${fmtMW(b1.ace.p10)} · P90 ${fmtMW(b1.ace.p90)}` : undefined}
          tone={b1 && Math.abs(b1.ace.p50) > 100 ? 'warn' : 'good'}
        />
        <Stat
          icon={<Activity />}
          label="Demand next block"
          value={b1 ? fmtMW(b1.demand.p50) : '—'}
          delta={b1 ? { text: `${b1.demand.p50 >= f.demand ? '▲' : '▼'} ${fmtMW(Math.abs(b1.demand.p50 - f.demand))}`, tone: 'info' } : undefined}
          spark={blocks.map((b) => b.demand.p50)}
          tone="info"
          sub={b1 ? `now ${fmtMW(f.demand)} · band ±${fmtMW((b1.demand.p90 - b1.demand.p10) / 2)}` : `now ${fmtMW(f.demand)}`}
        />
        <Stat
          icon={<Sun />}
          label="RE next block"
          value={b1 ? fmtMW(b1.re.p50) : '—'}
          delta={b1 ? { text: `${b1.re.p50 >= f.re ? '▲' : '▼'} ${fmtMW(Math.abs(b1.re.p50 - f.re))}`, tone: b1.re.p50 < f.re - 50 ? 'warn' : 'good' } : undefined}
          spark={blocks.map((b) => b.re.p50)}
          tone="good"
          sub={`now ${fmtMW(f.re)}`}
        />
        <Stat
          icon={<Cable />}
          label="Peak line loading (2 h)"
          value={peak ? `${(peak.loading * 100).toFixed(0)}%` : '—'}
          meter={peak?.loading}
          sub={peak ? `${peak.label} · ${peak.when}` : 'no line forecast'}
          tone={!peak ? undefined : peak.loading > 1 ? 'bad' : peak.loading > 0.9 ? 'warn' : 'good'}
        />
        <Stat
          icon={<TriangleAlert />}
          label="Violations (2 h)"
          value={String(fc?.violations.length ?? 0)}
          delta={firstLead != null ? { text: `in ${firstLead.toFixed(0)} min`, tone: 'warn' } : undefined}
          sub={fc?.violations.length ? fc.violations[0].label : 'none expected'}
          tone={fc?.violations.length ? 'warn' : 'good'}
        />
        <Stat
          icon={<Target />}
          label="Forecast MAPE"
          value={mape != null ? `${mape}%` : '—'}
          meter={mape != null ? Math.max(0, 1 - mape / 10) : undefined}
          sub={`${fc?.accuracy.samples ?? 0} samples · ${fc?.model ?? 'model'}`}
          tone={mape == null ? undefined : mape <= 3 ? 'good' : mape <= 6 ? 'info' : 'warn'}
        />
        <Stat
          icon={<IndianRupee />}
          label="DSM exposure"
          value={`${fmtRs(f.dsm_per_block_rs)}/blk`}
          delta={{ text: `NR ₹${f.nr}` }}
          spark={t.slice(-120).map((p) => p.deviation)}
          sub="per block · drawal deviation trend"
          tone={f.dsm_per_block_rs > 0 ? 'warn' : 'good'}
        />
      </StatStrip>
      <div className="grid min-h-0 flex-1 grid-cols-3 grid-rows-2 gap-3">
        <Panel title="ACE forecast — next 8 blocks (P50, P10–P90)" className="col-span-2">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows}>
              <CartesianGrid stroke="#e6eaef" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#96a1ae' }} />
              <YAxis tick={{ fontSize: 10, fill: '#96a1ae' }} width={44} />
              <ReferenceLine y={0} stroke="#c4ccd5" />
              <ReferenceLine y={100} stroke="#e6b45a" strokeDasharray="4 4" />
              <ReferenceLine y={-100} stroke="#e6b45a" strokeDasharray="4 4" />
              <RTooltip {...chartTooltip} />
              <Legend {...legend} />
              <Area dataKey="aceBand" stroke="none" fill="#cbc5ec66" isAnimationActive={false} name="P10–P90 band" />
              <Line dataKey="ace" stroke="#5c4c9b" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} name="ACE P50" />
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title="Predicted violations — next 2 h" icon={<TriangleAlert />} bodyClass="flex flex-col gap-3">
          <div className="min-h-0 flex-1 space-y-1.5 overflow-hidden">
            {(fc?.violations ?? []).length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50/80 px-2.5 py-2 text-xs text-emerald-800">
                <ShieldCheck className="size-4 shrink-0" /> No predicted constraint or balance violations within 2 hours.
              </div>
            ) : (
              fc!.violations.slice(0, 6).map((v, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px]">
                  <Clock3 className="size-3.5 shrink-0 text-amber-600" />
                  <span className="num w-14 shrink-0 whitespace-nowrap text-amber-700">+{v.lead_min} min</span>
                  <span className="flex-1 truncate">{v.label}</span>
                  {v.loading && <span className="num text-rose-600">{(v.loading * 100).toFixed(0)}%</span>}
                </div>
              ))
            )}
          </div>
          <FrequencyCompliance samples={t.map((p) => p.frequency)} />
        </Panel>
        <Panel title="Demand & renewables forecast (MW)">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows}>
              <CartesianGrid stroke="#e6eaef" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#96a1ae' }} />
              <YAxis
                yAxisId="d"
                tick={{ fontSize: 10, fill: '#96a1ae' }}
                width={44}
                domain={[(m: number) => Math.floor((m - 300) / 500) * 500, (m: number) => Math.ceil((m + 300) / 500) * 500]}
                tickFormatter={mw}
              />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: '#96a1ae' }} width={40} />
              <RTooltip {...chartTooltip} />
              <Legend {...legend} />
              <Area yAxisId="d" dataKey="demandBand" stroke="none" fill="#d2cafb88" isAnimationActive={false} legendType="none" />
              <Line yAxisId="d" dataKey="demand" name="Demand P50 (left)" stroke="#5735cf" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Area yAxisId="r" dataKey="reBand" stroke="none" fill="#c2d99a88" isAnimationActive={false} legendType="none" />
              <Line yAxisId="r" dataKey="re" name="Renewables P50 (right)" stroke="#5f8a2e" strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title={`Recent behaviour — frequency & ACE (live, ${t.length} samples)`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={t}>
              <CartesianGrid stroke="#e6eaef" vertical={false} />
              <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#96a1ae' }} minTickGap={40} />
              <YAxis yAxisId="f" domain={[49.75, 50.15]} tick={{ fontSize: 10, fill: '#96a1ae' }} width={40} />
              <YAxis yAxisId="a" orientation="right" tick={{ fontSize: 10, fill: '#96a1ae' }} width={40} />
              <ReferenceLine yAxisId="f" y={IEGC.fLow} stroke="#e6b45a" strokeDasharray="3 3" />
              <ReferenceLine yAxisId="f" y={IEGC.fHigh} stroke="#e6b45a" strokeDasharray="3 3" />
              <RTooltip {...chartTooltip} />
              <Legend {...legend} />
              <Line yAxisId="f" dataKey="frequency" name="Frequency Hz (left)" stroke="#6d4fe3" dot={false} isAnimationActive={false} />
              <Line yAxisId="a" dataKey="ace" name="ACE MW (right)" stroke="#7160b8" dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title="Drawal vs schedule & data confidence">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={t}>
              <CartesianGrid stroke="#e6eaef" vertical={false} />
              <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#96a1ae' }} minTickGap={40} />
              <YAxis
                yAxisId="d"
                tick={{ fontSize: 10, fill: '#96a1ae' }}
                width={44}
                domain={['dataMin - 200', 'dataMax + 200']}
                tickFormatter={(v: number) => `${(v / 1000).toFixed(1)}k`}
              />
              <YAxis yAxisId="c" orientation="right" domain={[0.6, 1]} tick={{ fontSize: 10, fill: '#96a1ae' }} width={34} />
              <RTooltip {...chartTooltip} formatter={(v, n) => (n === 'confidence' ? `${(Number(v) * 100).toFixed(0)}%` : fmtMW(Number(v)))} />
              <Legend {...legend} />
              <Line yAxisId="d" dataKey="drawal" name="Drawal" stroke="#c8622a" dot={false} isAnimationActive={false} />
              <Line yAxisId="d" dataKey="schedule" name="Schedule" stroke="#96a1ae" strokeDasharray="5 4" dot={false} isAnimationActive={false} />
              <Line yAxisId="c" dataKey="confidence" name="Data confidence (right)" stroke="#2a8761" dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Panel>
      </div>
    </div>
  )
}

/** Time inside the IEGC 2023 operating frequency band over the recent window, plus mean and spread. */
function FrequencyCompliance({ samples }: { samples: number[] }) {
  const b = bandStats(samples)
  const seg = [
    { v: b.belowPct, cls: 'bg-rose-400', label: `below ${IEGC.fLow.toFixed(2)} Hz` },
    { v: b.inPct, cls: 'bg-emerald-500', label: 'in band' },
    { v: b.abovePct, cls: 'bg-amber-400', label: `above ${IEGC.fHigh.toFixed(2)} Hz` },
  ]
  return (
    <div className="shrink-0 rounded-xl bg-slate-50/80 p-2.5 ring-1 ring-slate-900/[0.05]">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">Frequency band compliance</span>
        <span className="text-[10px] text-slate-400">
          IEGC 2023 band {IEGC.fLow.toFixed(2)}–{IEGC.fHigh.toFixed(2)} Hz · {samples.length} samples
        </span>
      </div>
      <div className="mt-1.5 flex items-end gap-4">
        <div>
          <div className={cn('num text-xl leading-none font-semibold', b.inPct >= 95 ? 'text-emerald-700' : b.inPct >= 80 ? 'text-amber-700' : 'text-rose-600')}>
            {b.inPct.toFixed(1)}%
          </div>
          <div className="text-[10px] text-slate-500">of time in band</div>
        </div>
        <div className="grid flex-1 grid-cols-3 gap-2 text-[10.5px]">
          <div>
            <div className="text-slate-500">Mean</div>
            <div className="num font-semibold text-slate-700">{b.mean.toFixed(3)} Hz</div>
          </div>
          <div>
            <div className="text-slate-500">Std deviation</div>
            <div className="num font-semibold text-slate-700">{(b.std * 1000).toFixed(1)} mHz</div>
          </div>
          <div>
            <div className="text-slate-500">Min · max</div>
            <div className="num font-semibold text-slate-700">
              {b.min.toFixed(2)} · {b.max.toFixed(2)}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-2 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-slate-200">
        {seg
          .filter((x) => x.v > 0)
          .map((x) => (
            <div key={x.label} title={`${x.label}: ${x.v.toFixed(1)}%`} className={cn('h-full', x.cls)} style={{ width: `${x.v}%` }} />
          ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-500">
        <span>below {b.belowPct.toFixed(1)}%</span>
        <span>above {b.abovePct.toFixed(1)}%</span>
      </div>
    </div>
  )
}
