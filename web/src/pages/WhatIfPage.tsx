// What-if sandbox — perturb a copy of the live state and see what the system would decide. Nothing is dispatched.
import { useState } from 'react'
import { Activity, AlertTriangle, Cable, FlaskConical, Gauge, IndianRupee, Network, Play, ShieldCheck, SlidersHorizontal, Waves } from 'lucide-react'
import { SectionTabs } from '@/components/common'
import { ShortageScenario } from '@/components/gridflex/GridFlex'
import { EmptyGuide, Panel, Stat, StatStrip } from '@/components/page'
import { TerritoryMap, type MapOverlay } from '@/components/three/TerritoryMap'
import { useLive } from '@/store/useLive'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ASSET_TYPE_META, LINES, lineLabel } from '@/data/topology'
import { api } from '@/lib/api'
import { fmtMW, fmtRs } from '@/lib/geo'
import { fmtHz, IEGC } from '@/lib/standards'
import { cn } from '@/lib/utils'
import type { Severity } from '@/data/types'

interface WhatIfResult {
  assessment: {
    severity: Severity
    direction: string
    ace: number
    deviation: number
    requirement: number
    frequency: number
    dsm_per_block_rs: number
    nr: number
    margin: number
  }
  network: { max_line: string; max_loading: number; islanded: string[]; loading: Record<string, number> }
  strategies: {
    id: string
    label: string
    description: string
    total_rs: number
    resource_rs: number
    residual_dsm_rs: number
    coverage_pct: number
    time_to_effect_min: number | null
    max_line_loading: number
    resources: number
  }[]
  plan: {
    allocations: { asset_id: string; name: string; type: string; mw_by_block: number[]; expected_by_block: number[]; cost_rs: number; caps: string[] }[]
    costs: Record<string, number>
    coverage_pct: number
    bindings: { line: string; label: string; block: number; detail: string }[]
    solver: { engine: string; solve_ms: number }
  }
  twin: { ok: boolean; checks: { id: string; label: string; status: string; detail: string }[] }
  note: string
}

const INIT = {
  demand_shock_mw: 400,
  region: 'STATEWIDE',
  re_drop_mw: 0,
  freq_offset_hz: 0,
  outaged_lines: [] as string[],
  bess_availability: 1,
  industrial_compliance: 1,
  horizon_blocks: 4,
}

function Knob({
  label,
  value,
  fmt,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  fmt: (v: number) => string
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs">
        <Label className="text-xs">{label}</Label>
        <span className="font-mono text-slate-600">{fmt(value)}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} />
    </div>
  )
}

export function WhatIfPage() {
  return (
    <div className="flex h-full flex-col">
      <SectionTabs
        sections={[
          { id: 'grid', label: 'Grid event', content: <GridEventSandbox /> },
          {
            id: 'shortage',
            label: 'Shortage & rotation',
            content: (
              <Panel className="h-full" bodyClass="flex min-h-0 flex-col">
                <ShortageScenario />
              </Panel>
            ),
          },
        ]}
      />
    </div>
  )
}

function GridEventSandbox() {
  const [p, setP] = useState(INIT)
  const [res, setRes] = useState<WhatIfResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = <K extends keyof typeof INIT>(k: K, v: (typeof INIT)[K]) => setP((s) => ({ ...s, [k]: v }))

  async function run() {
    setBusy(true)
    setErr(null)
    try {
      setRes(await api<WhatIfResult>('/whatif', { method: 'POST', body: p }))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const a = res?.assessment
  const best = res?.strategies.reduce((m, s) => (s.total_rs < m.total_rs ? s : m), res.strategies[0])
  const overlay: MapOverlay | undefined = res
    ? {
        loading: res.network.loading,
        highlightLines: [
          ...new Set([
            ...p.outaged_lines,
            ...Object.entries(res.network.loading)
              .filter(([, v]) => v >= 0.9)
              .map(([k]) => k),
          ]),
        ],
        lit: res.plan.allocations.map((x) => x.asset_id),
        caption: `Scenario · ${p.outaged_lines.length ? `${lineLabel(p.outaged_lines[0])} out · ` : ''}max loading ${(res.network.max_loading * 100).toFixed(0)}% on ${res.network.max_line}`,
      }
    : p.outaged_lines.length
      ? { highlightLines: p.outaged_lines, caption: `${lineLabel(p.outaged_lines[0])} selected for outage — press Evaluate` }
      : undefined
  return (
    <div className="flex h-full flex-col gap-3">
      <ScenarioStats res={res} />
      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)_minmax(0,0.62fr)] gap-3">
        <Panel title="Scenario" icon={<SlidersHorizontal />} aside={<Badge variant="outline">Sandbox · nothing dispatched</Badge>} bodyClass="flex flex-col gap-3.5">
          <div className="space-y-1.5">
            <Label className="text-xs">Region of demand shock</Label>
            <Select value={p.region} onValueChange={(v) => set('region', v)}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['STATEWIDE', 'BENGALURU', 'SOUTH', 'CENTRAL', 'NORTH', 'COASTAL'].map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Knob
            label="Demand shock"
            value={p.demand_shock_mw}
            min={-800}
            max={1500}
            step={50}
            fmt={(v) => `${v > 0 ? '+' : ''}${v} MW`}
            onChange={(v) => set('demand_shock_mw', v)}
          />
          <Knob label="Renewable drop" value={p.re_drop_mw} min={0} max={1500} step={50} fmt={(v) => `${v} MW`} onChange={(v) => set('re_drop_mw', v)} />
          <Knob label="Frequency offset" value={p.freq_offset_hz} min={-0.2} max={0.1} step={0.01} fmt={(v) => `${v.toFixed(2)} Hz`} onChange={(v) => set('freq_offset_hz', v)} />
          <Knob
            label="BESS availability"
            value={p.bess_availability}
            min={0}
            max={1}
            step={0.05}
            fmt={(v) => `${(v * 100).toFixed(0)}%`}
            onChange={(v) => set('bess_availability', v)}
          />
          <Knob
            label="C&I compliance"
            value={p.industrial_compliance}
            min={0.3}
            max={1}
            step={0.05}
            fmt={(v) => `${(v * 100).toFixed(0)}%`}
            onChange={(v) => set('industrial_compliance', v)}
          />
          <Knob label="Horizon" value={p.horizon_blocks} min={1} max={8} step={1} fmt={(v) => `${v} blocks (${v * 15} min)`} onChange={(v) => set('horizon_blocks', v)} />
          <div className="space-y-1.5">
            <Label className="text-xs">Line outage (N-1)</Label>
            <Select value={p.outaged_lines[0] ?? 'none'} onValueChange={(v) => set('outaged_lines', v === 'none' ? [] : [v])}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="none">None</SelectItem>
                {LINES.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {lineLabel(l.id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="mt-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setP(INIT)}>
              Reset
            </Button>
            <Button size="sm" className="flex-1" onClick={run} disabled={busy}>
              <Play className="size-4" /> {busy ? 'Evaluating…' : 'Evaluate scenario'}
            </Button>
          </div>
          {err && <div className="text-xs text-rose-600">{err}</div>}
        </Panel>

        <div className="flex min-h-0 min-w-0 flex-col">
          {!res || !a ? (
            <Panel className="flex-1">
              <EmptyGuide
                icon={<FlaskConical />}
                title="Evaluate a scenario against a copy of the live grid"
                text="Set a demand shock, renewable drop, frequency offset or an N-1 outage on the left. The real decision engine runs on the copy; nothing is dispatched."
                steps={[
                  { k: '1', title: 'Perturb', text: 'Shock applied by load share in the chosen region; RE drop split 70 % solar / 30 % wind.' },
                  { k: '2', title: 'Assess', text: 'DC power flow (PTDF) gives line loading; ACE, frequency band and DSM exposure per block.' },
                  { k: '3', title: 'Optimise', text: 'Least-cost mix of BESS, C&I demand response and other flexibility under network limits (LP).' },
                  { k: '4', title: 'Verify', text: 'Digital-twin safety gate: ramp, state of charge, loading and N-1 checks.' },
                ]}
              />
            </Panel>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <Panel bodyClass="flex flex-col" className="min-h-0 flex-1">
                <Tabs defaultValue="strategies" className="flex min-h-0 flex-1 flex-col">
                  <TabsList className="shrink-0">
                    <TabsTrigger value="strategies" className="text-xs">
                      Strategies
                    </TabsTrigger>
                    <TabsTrigger value="plan" className="text-xs">
                      Optimal plan ({res.plan.allocations.length})
                    </TabsTrigger>
                    <TabsTrigger value="twin" className="text-xs">
                      Safety gate {res.twin.ok ? '✓' : '✗'}
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="strategies" className="mt-2 min-h-0 overflow-hidden">
                    <Table className="table-fixed">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[34%]">Strategy</TableHead>
                          <TableHead className="text-right">Coverage</TableHead>
                          <TableHead className="text-right">Resource cost</TableHead>
                          <TableHead className="text-right">Residual DSM</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                          <TableHead className="text-right">Effect in</TableHead>
                          <TableHead className="text-right">Max line</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {res.strategies.map((s) => (
                          <TableRow key={s.id} className={cn(s.id === best?.id && 'bg-emerald-50/60')}>
                            <TableCell>
                              <div className="text-xs font-medium">
                                {s.label} {s.id === best?.id && <Badge variant="success">lowest cost</Badge>}
                              </div>
                              <div className="truncate text-[10px] text-slate-500" title={s.description}>
                                {s.description}
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-mono text-[11px]">{s.coverage_pct.toFixed(0)}%</TableCell>
                            <TableCell className="text-right font-mono text-[11px]">{fmtRs(s.resource_rs)}</TableCell>
                            <TableCell className="text-right font-mono text-[11px]">{fmtRs(s.residual_dsm_rs)}</TableCell>
                            <TableCell className="text-right font-mono text-[11px] font-semibold">{fmtRs(s.total_rs)}</TableCell>
                            <TableCell className="text-right font-mono text-[11px]">{s.time_to_effect_min == null ? '—' : `${s.time_to_effect_min} min`}</TableCell>
                            <TableCell className="text-right font-mono text-[11px]">{(s.max_line_loading * 100).toFixed(0)}%</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TabsContent>
                  <TabsContent value="plan" className="mt-2 min-h-0 overflow-hidden">
                    <div className="mb-1.5 text-[11px] text-slate-500">
                      {res.plan.solver.engine} ({res.plan.solver.solve_ms} ms) · coverage {res.plan.coverage_pct.toFixed(0)}% · total {fmtRs(res.plan.costs.total_rs ?? 0)} vs
                      do-nothing {fmtRs(res.plan.costs.do_nothing_rs ?? 0)}
                      {res.plan.bindings.length > 0 && ` · binding: ${[...new Set(res.plan.bindings.map((b) => b.label))].slice(0, 3).join(', ')}`}
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Resource</TableHead>
                          <TableHead>Type</TableHead>
                          {Array.from({ length: p.horizon_blocks }, (_, i) => (
                            <TableHead key={i} className="text-right">
                              B+{i}
                            </TableHead>
                          ))}
                          <TableHead className="text-right">Cost</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {res.plan.allocations.slice(0, 12).map((al) => (
                          <TableRow key={al.asset_id}>
                            <TableCell className="max-w-[220px] truncate text-xs">{al.name}</TableCell>
                            <TableCell className="text-[11px]" style={{ color: ASSET_TYPE_META[al.type]?.color }}>
                              {ASSET_TYPE_META[al.type]?.label ?? al.type}
                            </TableCell>
                            {al.mw_by_block.map((v, i) => (
                              <TableCell key={i} className="text-right font-mono text-[11px]">
                                {v.toFixed(0)}
                              </TableCell>
                            ))}
                            <TableCell className="text-right font-mono text-[11px]">{fmtRs(al.cost_rs)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TabsContent>
                  <TabsContent value="twin" className="mt-2 min-h-0 overflow-hidden">
                    <div className="grid grid-cols-2 gap-1.5">
                      {res.twin.checks.map((c) => (
                        <div key={c.id} className="flex items-start gap-2 rounded-lg border px-2.5 py-1.5">
                          <ShieldCheck
                            className={cn('mt-0.5 size-4 shrink-0', c.status === 'pass' ? 'text-emerald-500' : c.status === 'warn' ? 'text-amber-500' : 'text-rose-500')}
                          />
                          <div className="min-w-0">
                            <div className="text-xs font-medium">{c.label}</div>
                            <div className="line-clamp-2 text-[10px] text-slate-500">{c.detail}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </TabsContent>
                </Tabs>
                <div className="shrink-0 pt-1 text-[10px] text-slate-400">{res.note}</div>
              </Panel>
            </div>
          )}
        </div>
        <Panel title="Network under the scenario" icon={<Network />} aside={<span className="text-[10.5px] text-slate-400">colour = post-scenario loading</span>} bodyClass="p-0">
          <TerritoryMap compact overlay={overlay} className="rounded-t-none border-0" chrome={{ hideLegend: true }} />
        </Panel>
      </div>
    </div>
  )
}

/** Live operating point before a run; the scenario's outcome (with the change from live) after one. */
function ScenarioStats({ res }: { res: WhatIfResult | null }) {
  const f = useLive((s) => s.frame)!
  const a = res?.assessment
  const liveMax = Math.max(0, ...Object.values(f.loading))
  const d = (x: number, y: number, unit: string, digits = 0) => {
    const v = x - y
    return { text: `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)} ${unit}`, tone: 'info' as const }
  }
  return (
    <StatStrip>
      <Stat
        icon={<AlertTriangle />}
        label={a ? 'Scenario severity' : 'Live severity'}
        value={a ? a.severity : f.severity}
        sub={a ? `${a.direction === 'UP' ? 'load reduction' : 'load increase'} needed` : 'evaluate to compare'}
        tone={(a?.severity ?? f.severity) === 'NORMAL' ? 'good' : (a?.severity ?? f.severity) === 'ALERT' ? 'warn' : 'bad'}
      />
      <Stat
        icon={<Activity />}
        label="ACE"
        value={fmtMW(a ? a.ace : f.ace)}
        delta={a ? d(a.ace, f.ace, 'MW') : undefined}
        sub={a ? `live ${fmtMW(f.ace)}` : 'area control error, now'}
        tone={Math.abs(a ? a.ace : f.ace) > 100 ? 'bad' : 'good'}
      />
      <Stat
        icon={<Gauge />}
        label="Requirement"
        value={a ? fmtMW(a.requirement) : '—'}
        sub={a ? `margin ${fmtMW(a.margin)}` : 'flexibility the engine would seek'}
        tone={a && a.requirement > 0 ? 'warn' : undefined}
      />
      <Stat
        icon={<Waves />}
        label="Frequency"
        value={fmtHz(a ? a.frequency : f.frequency)}
        delta={a ? d(a.frequency * 1000, f.frequency * 1000, 'mHz') : undefined}
        sub={`IEGC band ${IEGC.fLow.toFixed(2)}–${IEGC.fHigh.toFixed(2)} Hz`}
        tone={(a ? a.frequency : f.frequency) < IEGC.fLow ? 'warn' : 'good'}
      />
      <Stat
        icon={<IndianRupee />}
        label="DSM exposure / block"
        value={a ? fmtRs(a.dsm_per_block_rs) : '—'}
        sub={a ? `NR ₹${a.nr.toFixed(2)}/kWh` : 'per 15-min time block'}
        tone={a ? (a.dsm_per_block_rs > 0 ? 'warn' : 'good') : undefined}
      />
      <Stat
        icon={<Cable />}
        label="Most loaded line"
        value={`${((res ? res.network.max_loading : liveMax) * 100).toFixed(0)}%`}
        delta={res ? d(res.network.max_loading * 100, liveMax * 100, 'pp') : undefined}
        meter={res ? res.network.max_loading : liveMax}
        sub={res ? res.network.max_line : 'live, before the scenario'}
        tone={(res ? res.network.max_loading : liveMax) > 1 ? 'bad' : (res ? res.network.max_loading : liveMax) > 0.9 ? 'warn' : 'good'}
      />
      <Stat
        icon={<ShieldCheck />}
        label="Safety gate"
        value={res ? (res.twin.ok ? 'Pass' : 'Fail') : '—'}
        sub={res ? `${res.twin.checks.filter((c) => c.status !== 'pass').length} warning(s) · ${res.plan.allocations.length} resources` : 'digital-twin checks'}
        tone={res ? (res.twin.ok ? 'good' : 'bad') : undefined}
      />
    </StatStrip>
  )
}
