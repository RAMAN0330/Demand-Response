// What-if sandbox — perturb a copy of the live state and see what the system would decide. Nothing is dispatched.
import { useState } from 'react'
import { FlaskConical, Play, ShieldCheck } from 'lucide-react'
import { SectionTabs } from '@/components/common'
import { ShortageScenario } from '@/components/gridflex/GridFlex'
import { Empty, Panel, Stat } from '@/components/page'
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
import { SEVERITY_STYLE } from '@/lib/ui'
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
  network: { max_line: string; max_loading: number; islanded: string[] }
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
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] gap-3">
        <Panel title="Scenario" aside={<Badge variant="outline">Sandbox · nothing dispatched</Badge>} bodyClass="flex flex-col gap-3.5">
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
            label="Industrial compliance"
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

        {!res || !a ? (
          <Panel>
            <Empty icon={<FlaskConical className="size-6 text-sky-400" />}>Set a scenario and press “Evaluate scenario”.</Empty>
          </Panel>
        ) : (
          <div className="flex min-h-0 flex-col gap-3">
            <div className="grid shrink-0 grid-cols-6 gap-2">
              <div className={cn('flex items-center justify-center rounded-lg border px-2 text-sm font-semibold', SEVERITY_STYLE[a.severity])}>{a.severity}</div>
              <Stat label="ACE" value={fmtMW(a.ace)} tone={Math.abs(a.ace) > 100 ? 'bad' : 'good'} />
              <Stat label="Requirement" value={`${fmtMW(a.requirement)} ${a.direction}`} />
              <Stat label="Frequency" value={`${a.frequency.toFixed(3)} Hz`} tone={a.frequency < 49.9 ? 'warn' : undefined} />
              <Stat label="DSM exposure / block" value={fmtRs(a.dsm_per_block_rs)} tone={a.dsm_per_block_rs > 0 ? 'warn' : 'good'} />
              <Stat
                label="Max line"
                value={`${(res.network.max_loading * 100).toFixed(0)}%`}
                tone={res.network.max_loading > 1 ? 'bad' : res.network.max_loading > 0.9 ? 'warn' : 'good'}
              />
            </div>
            <Panel bodyClass="flex flex-col" className="flex-1">
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
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Strategy</TableHead>
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
                            <div className="text-[10px] text-slate-500">{s.description}</div>
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
    </div>
  )
}
