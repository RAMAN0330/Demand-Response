// DR Events — every event the platform opened: need, dispatch, delivery vs baseline, value. Approve / reject / abort with full evidence.
import { useState } from 'react'
import { Area, Bar as RBar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import {
  Activity,
  AlertTriangle,
  Ban,
  Brain,
  Check,
  CheckCircle2,
  Crosshair,
  Gauge,
  IndianRupee,
  ListChecks,
  Loader2,
  MapPin,
  OctagonX,
  Receipt,
  Send,
  Target,
  Timer,
  UserCheck,
  XCircle,
  Zap,
} from 'lucide-react'
import { Calc, FitPager, SectionTabs } from '@/components/common'
import { Empty, Panel, Stat, StoryChain } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { CoordinationView, type GfLedger } from '@/components/gridflex/GridFlex'
import { ASSET_TYPE_META } from '@/data/topology'
import type { Command, DecisionSummary } from '@/data/types'
import { useApi } from '@/hooks'
import { api } from '@/lib/api'
import { fmtMW, fmtRs } from '@/lib/geo'
import { chartTooltip } from '@/lib/ui'
import { fmtEnergy } from '@/lib/standards'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/useAuth'
import { clock, clockS } from '@/store/useLive'
import { useUI } from '@/store/useUI'

const OPEN = ['AWAITING_APPROVAL', 'EXECUTING', 'RELEASING']

const STATE_STYLE: Record<string, string> = {
  AWAITING_APPROVAL: 'bg-amber-100 text-amber-800',
  EXECUTING: 'bg-sky-100 text-sky-800',
  RELEASING: 'bg-violet-100 text-violet-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-slate-200 text-slate-700',
  ABORTED: 'bg-rose-100 text-rose-800',
}

interface Alloc {
  id: string
  name: string
  short: string
  type: string
  mw: number
  mw_by_block: number[]
  expected_mw: number
  reliability: number
  effective_cost: number
  cost_rs: number
  rank: number
  caps: string[]
  protocol: string
}
interface Full extends DecisionSummary {
  phases?: { phase: string; ts: number }[]
  narrative: Record<string, unknown>
  awaiting: string[]
  current: {
    reason: string
    requirement_mw: number
    assessment: {
      frequency: number
      ace: number
      ace_terms: { Ia: number; Is: number; bf: number; freq_term: number }
      deviation_mw: number
      drawal_mw: number
      schedule_mw: number
      severity: string
      margin_mw: number
      confidence: number
      dsm: {
        nr: number
        nr_terms: { A: number; B: number; C: number; binding: string }
        per_block_rs: number
        energy_mwh: number
        band_mw: number
        freq_band: string
        mult: number[]
        marginal_rate: number
      }
    }
    flexibility: {
      id: string
      short: string
      type: string
      available_mw: number
      expected_mw: number
      reliability: number
      effective_cost: number
      eligible: boolean
      exclusions: string[]
      notes: string[]
      locked_mw: number
    }[]
    strategies: {
      id: string
      label: string
      description: string
      total_rs: number
      resource_rs: number
      residual_dsm_rs: number
      applicable?: boolean
      coverage_pct: number
      time_to_effect_min: number | null
      max_line_loading: number
      resources: number
    }[]
    allocations: Alloc[]
    plan: {
      peak_mw: number
      coverage_pct: number
      supplied: number[]
      residual: number[]
      requirement: number[]
      costs: Record<string, number>
      bindings: { label: string; detail: string; shadow_price_rs_per_mw: number }[]
      skipped: { asset_id: string; name: string; reason: string }[]
      max_loading_after: { label: string; loading: number }
      solver: { engine: string; solve_ms: number; variables: number; constraints: number; message: string }
    }
    twin: { ok: boolean; checks: { id: string; label: string; status: string; detail: string }[] }
    twin_passes: { pass: number; ok: boolean; note: string }[]
    policy: { level_name: string; auto: string[]; approval: string[]; reasons: string[] }
  }
  revisions: {
    rev: number
    ts: number
    reason: string
    requirement_mw: number
    planned_mw: number
    resources: number
    auto_mw: number
    awaiting_mw: number
    twin_ok: boolean
    solve_ms: number
  }[]
  outcome: Record<string, number>
  timeline?: { t: number; target: number; dispatched: number; expected: number; delivered: number; ace: number }[]
  settlement: null | {
    rows: {
      asset_id: string
      name: string
      expected_mwh: number
      delivered_mwh: number
      performance: number
      perf_factor: number
      payment_rs: number
      reliability_before: number
      reliability_after: number
    }[]
    payments_rs: number
    avoided_dsm_rs: number
    net_benefit_rs: number
    rebound_cost_rs?: number
    rtm_cost_rs?: number
    ledger?: { key: string; label: string; rs: number; subtotal?: boolean }[]
    delivered_mwh: number
    expected_mwh: number
    duration_min: number
  }
  approval_history: { user: string; role: string; ts: number; mw: number; revision: number }[]
  commands: Command[]
}

export function DecisionsPage() {
  const decisionId = useUI((s) => s.decisionId)
  const go = useUI((s) => s.go)
  const { data } = useApi<{ items: DecisionSummary[] }>('/decisions?limit=60', { intervalMs: 5000 })
  const items = data?.items ?? []
  const selected = decisionId ?? items.find((d) => ['AWAITING_APPROVAL', 'EXECUTING', 'RELEASING'].includes(d.state))?.id ?? items[0]?.id ?? null
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] gap-3">
        <div className="flex min-h-0 flex-col gap-3">
          <TodaySummary items={items} />
          <Panel
            className="min-h-0"
            style={{ flex: `0 1 ${Math.max(1, Math.min(items.length, 5)) * 80 + 56}px` }}
            title="DR events"
            aside={
              <span className="text-[11px] text-slate-500">
                {items.filter((d) => OPEN.includes(d.state)).length} open · {items.length} total
              </span>
            }
            bodyClass="p-1.5"
          >
            {items.length === 0 ? (
              <Empty>No DR events yet. The platform opens one automatically when the grid need stays above 100 MW for a minute.</Empty>
            ) : (
              <FitPager
                items={items}
                rowHeight={76}
                reserve={36}
                render={(slice) => (
                  <div className="space-y-1">
                    {slice.map((d) => {
                      const pct = d.planned_mw > 0.5 ? Math.min(1, d.delivered_mw / d.planned_mw) : 0
                      return (
                        <button
                          key={d.id}
                          onClick={() => go('decisions', d.id)}
                          className={cn(
                            'w-full rounded-xl border bg-white/60 px-2.5 py-1.5 text-left transition hover:bg-slate-50',
                            selected === d.id && 'border-sky-300 bg-sky-50/70 ring-1 ring-sky-200',
                          )}
                        >
                          <div className="flex items-center gap-1.5">
                            <span className={cn('rounded px-1.5 text-[9px] font-bold', STATE_STYLE[d.state] ?? 'bg-slate-100')}>{d.state.replace('_', ' ')}</span>
                            <span className="font-mono text-[10px] text-slate-500">{d.id}</span>
                            <span className="ml-auto text-[10px] text-slate-400">{clock(d.opened_at)}</span>
                          </div>
                          <div className="mt-0.5 flex items-baseline gap-1.5">
                            <span className="font-mono text-[13px] font-semibold text-slate-800">{fmtMW(d.requirement_mw)}</span>
                            <span className="text-[10px] text-slate-500">
                              {d.direction === 'UP' ? 'load reduction' : 'load increase'} · {d.severity}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                              <div className={cn('h-full rounded-full', pct >= 0.85 ? 'bg-emerald-400' : 'bg-sky-400')} style={{ width: `${pct * 100}%` }} />
                            </div>
                            <span className="shrink-0 text-[10px] text-slate-500">
                              {d.net_benefit_rs != null ? (
                                <span className="text-emerald-700">net {fmtRs(d.net_benefit_rs)}</span>
                              ) : OPEN.includes(d.state) ? (
                                `${fmtMW(d.delivered_mw)} delivering`
                              ) : d.closed_reason ? (
                                'closed'
                              ) : (
                                ''
                              )}
                            </span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              />
            )}
          </Panel>
          <ActivityLog id={selected} />
        </div>
        {selected ? <DecisionDetail id={selected} /> : <Panel>{<Empty>Select a DR event.</Empty>}</Panel>}
      </div>
    </div>
  )
}

function DecisionDetail({ id }: { id: string }) {
  const { data: d, reload } = useApi<Full>(`/decisions/${id}`, { intervalMs: 4000 })
  const showEvent = useUI((s) => s.showEvent)
  const can = useAuth((s) => s.can)
  const user = useAuth((s) => s.user)
  const [dlg, setDlg] = useState<null | 'reject' | 'abort'>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  if (!d) return <Panel>{<Empty icon={<Loader2 className="size-5 animate-spin text-slate-400" />}>Loading decision…</Empty>}</Panel>
  const cur = d.current
  const open = ['AWAITING_APPROVAL', 'EXECUTING', 'RELEASING'].includes(d.state)
  const alreadyApproved = d.approvals.some((a) => a.user === user?.username)

  async function act(kind: 'approve' | 'reject' | 'abort') {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api<DecisionSummary>(`/decisions/${id}/${kind}`, { method: 'POST', body: kind === 'approve' ? undefined : { reason } })
      setMsg(
        kind === 'approve'
          ? r.state === 'EXECUTING'
            ? 'Approved — commands released for dispatch.'
            : 'First approval recorded — awaiting dual authorisation.'
          : `Decision ${r.state.toLowerCase()}.`,
      )
      setDlg(null)
      setReason('')
      reload()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex min-h-0 flex-col gap-3">
      {/* header + actions */}
      <div className="flex shrink-0 items-center gap-3 rounded-xl border bg-white px-3 py-2.5 shadow-xs">
        <span className={cn('rounded-full px-2.5 py-0.5 text-[11px] font-bold', STATE_STYLE[d.state])}>{d.state.replace('_', ' ')}</span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[14px] font-semibold text-slate-800">{d.headline || d.closed_reason}</div>
          <div className="text-[11px] text-slate-500">
            {d.id} · opened {clockS(d.opened_at)} · revision {d.revision} ({cur?.reason}) · {d.severity} · {d.direction}
            {d.approval_history.length > 0 && ` · approvals: ${d.approval_history.map((a) => `${a.user} (r${a.revision})`).join(', ')}`}
          </div>
        </div>
        {msg && <span className="max-w-[260px] truncate text-[11px] text-slate-600">{msg}</span>}
        {d.state === 'AWAITING_APPROVAL' && can('approve') && !alreadyApproved && (
          <Button size="sm" disabled={busy || (d.approvals.length > 0 && !can('approve_dual'))} onClick={() => act('approve')}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {d.approvals.length ? 'Second approval' : `Approve ${d.awaiting_mw.toFixed(0)} MW`}
          </Button>
        )}
        <Button size="sm" variant="outline" className="bg-white/70" onClick={() => showEvent(d.id, cur?.allocations.map((a) => a.id) ?? [], open ? null : d.opened_at)}>
          <MapPin className="size-4" /> {open ? 'Show on map' : 'Replay on map'}
        </Button>
        {d.state === 'AWAITING_APPROVAL' && can('reject') && (
          <Button size="sm" variant="outline" onClick={() => setDlg('reject')}>
            <Ban className="size-4" /> Reject
          </Button>
        )}
        {open && d.state !== 'AWAITING_APPROVAL' && can('abort') && (
          <Button size="sm" variant="outline" className="text-rose-700" onClick={() => setDlg('abort')}>
            <OctagonX className="size-4" /> Abort & release
          </Button>
        )}
      </div>

      <EventKpis d={d} />

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-3">
        <div className="grid min-h-0 grid-rows-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-3">
          <Panel title="Event performance — target vs dispatched vs delivered (MW)" bodyClass="p-2">
            <PerformanceChart d={d} />
          </Panel>
          <Panel title="Why — situation to outcome" bodyClass="overflow-hidden">
            <StoryChain narrative={d.narrative} compact />
          </Panel>
        </div>
        <Panel bodyClass="flex flex-col">
          {cur ? (
            <SectionTabs
              sections={[
                { id: 'plan', label: `Participants (${cur.allocations.length})`, content: <PlanTab d={d} /> },
                { id: 'evidence', label: 'Grid need', content: <EvidenceTab d={d} /> },
                { id: 'coord', label: 'Coordination', content: <CoordTab d={d} /> },
                { id: 'alts', label: 'Options', content: <AltTab d={d} /> },
                { id: 'twin', label: `Safety ${cur.twin.ok ? '✓' : '✕'}`, content: <TwinTab d={d} /> },
                { id: 'cmds', label: `Dispatch (${d.commands?.length ?? 0})`, content: <CommandsTab d={d} /> },
                { id: 'revs', label: `Revisions (${d.revisions.length})`, content: <RevisionsTab d={d} /> },
                ...(d.settlement ? [{ id: 'settle', label: 'Settlement', content: <SettleTab d={d} /> }] : []),
              ]}
            />
          ) : (
            <Empty>No evidence recorded.</Empty>
          )}
        </Panel>
      </div>

      <Dialog open={!!dlg} onOpenChange={(o) => !o && setDlg(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dlg === 'reject' ? 'Reject DR event' : 'Abort DR event and release participants'}</DialogTitle>
            <DialogDescription>
              {dlg === 'reject'
                ? 'Pending commands are cancelled; anything already executing is released. The platform will not re-propose for 30 minutes unless the situation escalates.'
                : 'All resources in this decision receive a release command (setpoint 0). This override is audited.'}
            </DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Reason (required, audited)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDlg(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={reason.trim().length < 3 || busy} onClick={() => act(dlg!)}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function PlanTab({ d }: { d: Full }) {
  const cur = d.current
  const auto = new Set(cur.policy.auto)
  const chart = cur.plan.requirement.map((r, b) => {
    const row: Record<string, number | string> = { block: `B${b + 1}`, requirement: r }
    for (const a of cur.allocations) row[a.short] = +(a.mw_by_block[b] * a.reliability).toFixed(1)
    return row
  })
  const colors = ['#8bb0da', '#86efac', '#e6b45a', '#cbc5ec', '#e2b3c7', '#5eead4', '#f0d193', '#ecb2b2', '#c2d99a', '#b7cfe9', '#cbc5ec', '#6ee7b7']
  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,0.8fr)_minmax(0,1.2fr)] gap-2">
      <div className="grid grid-cols-4 gap-2 text-[11px]">
        <Stat label="Planned (block 1)" value={fmtMW(cur.plan.peak_mw)} />
        <Stat label="Coverage" value={`${cur.plan.coverage_pct.toFixed(0)}%`} />
        <Stat label="Saving vs do-nothing" value={fmtRs(cur.plan.costs.savings_rs)} tone={cur.plan.costs.savings_rs > 0 ? 'good' : 'warn'} />
        <Stat label={`${cur.plan.solver.engine}`} value={`${cur.plan.solver.solve_ms.toFixed(0)} ms · ${cur.plan.solver.variables} vars`} />
      </div>
      <div className="min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chart}>
            <CartesianGrid stroke="#e6eaef" vertical={false} />
            <XAxis dataKey="block" tick={{ fontSize: 10, fill: '#96a1ae' }} />
            <YAxis tick={{ fontSize: 10, fill: '#96a1ae' }} width={40} />
            <RTooltip {...chartTooltip} formatter={(v) => `${Number(v).toFixed(0)} MW`} />
            {cur.allocations.map((a, i) => (
              <RBar key={a.id} dataKey={a.short} stackId="s" fill={colors[i % colors.length]} isAnimationActive={false} />
            ))}
            <Line dataKey="requirement" stroke="#4d5867" strokeDasharray="5 4" dot={false} strokeWidth={2} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <FitPager
        items={cur.allocations}
        rowHeight={33}
        reserve={70}
        render={(slice) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Resource</TableHead>
                <TableHead className="text-right">MW by block</TableHead>
                <TableHead className="text-right">₹/kWh eff.</TableHead>
                <TableHead>Execution</TableHead>
                <TableHead>Limits</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {slice.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono text-[11px]">{a.rank}</TableCell>
                  <TableCell className="text-xs">
                    <span className="mr-1.5 inline-block size-2 rounded-sm" style={{ background: ASSET_TYPE_META[a.type]?.color }} />
                    {a.short}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[11px]">{a.mw_by_block.map((x) => x.toFixed(0)).join(' · ')}</TableCell>
                  <TableCell className="text-right font-mono text-[11px]">{a.effective_cost.toFixed(2)}</TableCell>
                  <TableCell>
                    {auto.has(a.id) ? (
                      <Badge variant="info">auto</Badge>
                    ) : d.awaiting.includes(a.id) ? (
                      <Badge variant="warning">needs approval</Badge>
                    ) : (
                      <Badge variant="success">approved</Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[160px] truncate text-[10px] text-slate-500">{a.caps.join(' · ') || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      />
    </div>
  )
}

function EvidenceTab({ d }: { d: Full }) {
  const a = d.current.assessment
  const t = a.ace_terms
  return (
    <div className="grid h-full grid-cols-2 content-start gap-2 overflow-hidden">
      <Calc
        title="Area Control Error (IEGC)"
        formula="ACE = (Ia − Is) − 10·Bf·(Fa − Fs)"
        steps={[`(${t.Ia.toFixed(0)} − (${t.Is.toFixed(0)})) − 10·(${t.bf})·(${a.frequency.toFixed(3)} − 50)`]}
        result={`${a.ace.toFixed(0)} MW → requirement ${d.current.requirement_mw.toFixed(0)} MW ${d.direction}`}
      />
      <Calc
        title="Deviation (CERC DSM basis)"
        formula="D = Actual drawal − Scheduled drawal"
        steps={[`${a.drawal_mw.toFixed(0)} − ${a.schedule_mw.toFixed(0)}`]}
        result={`${a.deviation_mw.toFixed(0)} MW`}
      />
      <Calc
        title="Normal Rate (DSM Regs 2024)"
        formula="NR = max(A DAM, B RTM, C ⅓·DAM+⅓·RTM+⅓·ASC)"
        steps={[`A ₹${a.dsm.nr_terms.A.toFixed(2)} · B ₹${a.dsm.nr_terms.B.toFixed(2)} · C ₹${a.dsm.nr_terms.C.toFixed(2)}`]}
        result={`NR ₹${a.dsm.nr.toFixed(2)}/kWh (binding ${a.dsm.nr_terms.binding})`}
      />
      <Calc
        title="DSM exposure per 15-min block"
        formula={`E × m·NR, band ${a.dsm.band_mw.toFixed(0)} MW, ${a.dsm.freq_band} frequency`}
        steps={[`${a.dsm.energy_mwh.toFixed(1)} MWh · multipliers ${a.dsm.mult.join(' / ')}`]}
        result={`${fmtRs(a.dsm.per_block_rs)} per block (marginal ₹${a.dsm.marginal_rate.toFixed(2)}/kWh)`}
      />
      <Calc
        title="Reserve & data"
        formula="P90 margin = 1.28·√(σ_demand² + σ_RE²)"
        result={`${a.margin_mw.toFixed(0)} MW held free · data confidence ${(a.confidence * 100).toFixed(0)}%`}
      />
      <div className="rounded-lg border bg-white p-3 text-[11px]">
        <div className="mb-1 font-semibold text-slate-600">Network constraints (LP duals)</div>
        {d.current.plan.bindings.length === 0 ? (
          <div className="text-slate-500">
            No binding line limits. Max loading after dispatch: {d.current.plan.max_loading_after.label} {(d.current.plan.max_loading_after.loading * 100).toFixed(0)}%.
          </div>
        ) : (
          d.current.plan.bindings.slice(0, 4).map((b) => (
            <div key={b.label} className="flex gap-1.5 text-rose-700">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {b.detail}
              {b.shadow_price_rs_per_mw > 0 && <span className="text-slate-500"> · shadow ₹{b.shadow_price_rs_per_mw}/MWh</span>}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// Options compared like-for-like: what each costs (paid to resources + DSM still owed), how much of the need it covers,
// how fast it acts and what it does to the network — judged against doing nothing — and why the chosen one wins.
function AltTab({ d }: { d: Full }) {
  const s = d.current.strategies
  const base = s.find((x) => x.id === 'NONE')
  const byCost = [...s].sort((a, b) => a.total_rs - b.total_rs)
  const chosen = byCost.find((x) => x.id === 'OPTIMAL') ?? byCost[0]
  // chosen option pinned first, the rest by total cost; the number shown is the cost rank
  const rows = [chosen, ...byCost.filter((x) => x.id !== chosen.id)]
  const costRank = (x: (typeof s)[number]) =>
    x.id === chosen.id ? 1 + byCost.filter((y) => y.total_rs < chosen.total_rs - Math.max(1000, Math.abs(chosen.total_rs) * 0.005)).length : byCost.indexOf(x) + 1
  type Opt = (typeof s)[number]
  const saving = (x: Opt) => (base ? base.total_rs - x.total_rs : 0)
  // total = paid to resources (incl. rebound and market) + DSM still owed; DSM can be a credit when an option over-covers
  const paid = (x: Opt) => x.total_rs - x.residual_dsm_rs
  const scale = Math.max(...s.map((x) => Math.max(paid(x), 0) + Math.max(x.residual_dsm_rs, 0)), 1)
  const baseLine = base?.max_line_loading ?? 0
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`
  const network = (x: Opt): { t: string; tone: 'good' | 'warn' | 'bad' } | null => {
    if (x.id === 'NONE') return x.max_line_loading > 1 ? { t: `overload ${pct(x.max_line_loading)} today`, tone: 'warn' } : null
    if (x.max_line_loading > baseLine + 0.005) return { t: `worsens a line to ${pct(x.max_line_loading)}`, tone: 'bad' }
    if (x.max_line_loading > 1 && x.max_line_loading < baseLine - 0.01) return { t: `relieves overload ${pct(baseLine)} → ${pct(x.max_line_loading)}`, tone: 'good' }
    if (x.max_line_loading > 1) return { t: `overload remains ${pct(x.max_line_loading)}`, tone: 'warn' }
    return null
  }
  const flags = (x: Opt) => {
    const out: { t: string; tone: 'good' | 'warn' | 'bad' }[] = []
    if (x.applicable === false) return [{ t: 'purchase only — n/a for a surplus', tone: 'warn' as const }]
    const n = network(x)
    if (n) out.push(n)
    if (x.id !== 'NONE' && x.coverage_pct < 90) out.push({ t: x.coverage_pct < 1 ? 'no coverage' : `covers only ${x.coverage_pct.toFixed(0)}%`, tone: 'warn' })
    if (x.time_to_effect_min != null && x.time_to_effect_min > 15) out.push({ t: `slow (${x.time_to_effect_min.toFixed(0)} min)`, tone: 'warn' })
    if (x.residual_dsm_rs < -1) out.push({ t: `DSM credit ${fmtRs(-x.residual_dsm_rs)}`, tone: 'good' })
    return out
  }
  const save = saving(chosen)
  const lineWhy =
    chosen.max_line_loading <= 1
      ? 'keeps every line within limits'
      : chosen.max_line_loading < baseLine - 0.01
        ? `cuts the worst line from ${pct(baseLine)} to ${pct(chosen.max_line_loading)}`
        : `leaves the worst line at ${pct(chosen.max_line_loading)}`
  // when a cheaper option exists, say what it gives up rather than claiming lowest cost
  const tol = Math.max(1000, Math.abs(chosen.total_rs) * 0.005) // near-ties are equal
  const cheaper = byCost.filter((x) => x.total_rs < chosen.total_rs - tol && x.id !== 'NONE')
  const tradeoff = (x: Opt) => {
    if (x.coverage_pct < chosen.coverage_pct - 5) return `covers only ${x.coverage_pct.toFixed(0)}%`
    if (x.max_line_loading > chosen.max_line_loading + 0.005) return `loads a line to ${pct(x.max_line_loading)}`
    if (x.time_to_effect_min != null && chosen.time_to_effect_min != null && x.time_to_effect_min > chosen.time_to_effect_min + 1)
      return `takes ${x.time_to_effect_min.toFixed(0)} min to act`
    return null
  }
  const why = cheaper.length
    ? (() => {
        const c = cheaper[0]
        const t = tradeoff(c)
        return t
          ? `${c.label} is ${fmtRs(chosen.total_rs - c.total_rs)} cheaper but ${t}`
          : `${c.label} prices ${fmtRs(chosen.total_rs - c.total_rs)} lower, but the dispatch priority is BESS → industrial flexibility → other resources`
      })()
    : 'Lowest total cost'
  const chip = { good: 'bg-emerald-100 text-emerald-700', warn: 'bg-amber-100 text-amber-800', bad: 'bg-rose-100 text-rose-700' }
  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5">
      <div className="flex shrink-0 items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-slate-800">
            {chosen.label} chosen — {fmtRs(chosen.total_rs)}
            {base && save > 0 && (
              <span className="text-emerald-700">
                {' '}
                · saves {fmtRs(save)} ({((save / Math.max(base.total_rs, 1)) * 100).toFixed(0)}%) vs doing nothing
              </span>
            )}
          </div>
          <div className="text-[11px] leading-snug text-slate-600">
            {why}. Chosen plan covers {chosen.coverage_pct.toFixed(0)}% of the need
            {chosen.time_to_effect_min != null && ` in ${chosen.time_to_effect_min < 1 ? 'under a minute' : `${chosen.time_to_effect_min.toFixed(0)} min`}`}, {lineWhy}, using{' '}
            {chosen.resources} resource{chosen.resources === 1 ? '' : 's'}.
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-hidden">
        {rows.map((x) => {
          const isChosen = x.id === chosen.id
          const isBase = x.id === 'NONE'
          const sv = saving(x)
          return (
            <div key={x.id} className={cn('rounded-xl border px-3 py-2', isChosen ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200/80 bg-white/70')}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-slate-400" title="Rank by total cost">
                  #{costRank(x)}
                </span>
                <span className="text-[12.5px] font-semibold text-slate-800">{x.label}</span>
                {isChosen && (
                  <Badge variant="success" className="h-4 px-1.5 text-[9px]">
                    chosen
                  </Badge>
                )}
                {isBase && (
                  <Badge variant="outline" className="h-4 px-1.5 text-[9px]">
                    baseline
                  </Badge>
                )}
                <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                  {flags(x).map((f) => (
                    <span key={f.t} className={cn('rounded px-1.5 py-px text-[9.5px] font-semibold', chip[f.tone])}>
                      {f.t}
                    </span>
                  ))}
                </div>
                <span className={cn('shrink-0 font-mono text-[13px] font-semibold tabular-nums', isChosen ? 'text-emerald-700' : 'text-slate-800')}>{fmtRs(x.total_rs)}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-3">
                <div className="flex h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full bg-sky-600" style={{ width: `${(Math.max(0, paid(x)) / scale) * 100}%` }} title={`Paid to resources ${fmtRs(paid(x))}`} />
                  <div
                    className="h-full bg-amber-400"
                    style={{ width: `${(Math.max(0, x.residual_dsm_rs) / scale) * 100}%` }}
                    title={`DSM still owed ${fmtRs(x.residual_dsm_rs)}`}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-3 text-[10.5px] text-slate-500 tabular-nums">
                  <span>
                    {isBase ? (
                      'baseline'
                    ) : Math.abs(sv) < 1 ? (
                      'no saving'
                    ) : (
                      <>
                        {sv > 0 ? 'saves ' : 'costs '}
                        <b className={cn('font-mono', sv > 0 ? 'text-emerald-700' : 'text-rose-600')}>{sv > 0 ? fmtRs(sv) : `+${fmtRs(-sv)}`}</b>
                      </>
                    )}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-1.5 w-10 overflow-hidden rounded-full bg-slate-100">
                      <span
                        className={cn('block h-full rounded-full', x.coverage_pct >= 90 ? 'bg-emerald-500' : x.coverage_pct >= 50 ? 'bg-amber-400' : 'bg-rose-400')}
                        style={{ width: `${Math.min(100, x.coverage_pct)}%` }}
                      />
                    </span>
                    <b className="font-mono text-slate-700">{x.coverage_pct.toFixed(0)}%</b>
                  </span>
                  <span>
                    acts in{' '}
                    <b className="font-mono text-slate-700">
                      {x.time_to_effect_min == null ? '—' : x.time_to_effect_min < 1 ? '<1 min' : `${x.time_to_effect_min.toFixed(0)} min`}
                    </b>
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-0.5 text-[10px] text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm bg-sky-600" /> paid to resources
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm bg-amber-400" /> DSM still owed
        </span>
        <span>· savings and network effect measured against doing nothing · {d.current.plan.requirement.length}-block horizon</span>
      </div>
    </div>
  )
}

function TwinTab({ d }: { d: Full }) {
  const t = d.current.twin
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex shrink-0 flex-wrap gap-1.5">
        {d.current.twin_passes.map((p) => (
          <span key={p.pass} className={cn('rounded-lg px-2 py-1 text-[10px]', p.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800')}>
            Pass {p.pass}: {p.note}
          </span>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-3 gap-1.5 overflow-hidden">
        {t.checks.map((c) => (
          <div
            key={c.id}
            className={cn(
              'flex gap-1.5 rounded-lg border px-2 py-1.5',
              c.status === 'fail' ? 'border-rose-200 bg-rose-50' : c.status === 'warn' ? 'border-amber-200 bg-amber-50/60' : 'bg-white',
            )}
          >
            {c.status === 'pass' ? (
              <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
            ) : c.status === 'warn' ? (
              <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
            ) : (
              <XCircle className="size-3.5 shrink-0 text-rose-500" />
            )}
            <div className="min-w-0">
              <div className="text-[11px] font-medium">{c.label}</div>
              <div className="line-clamp-2 text-[10px] text-slate-500">{c.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const CMD_STYLE: Record<string, 'info' | 'warning' | 'success' | 'destructive' | 'secondary' | 'outline'> = {
  AWAITING_APPROVAL: 'warning',
  READY: 'info',
  SENT: 'info',
  ACKED: 'info',
  EXECUTING: 'success',
  COMPLETED: 'secondary',
  SUPERSEDED: 'outline',
  CANCELLED: 'outline',
  FAILED: 'destructive',
}

// seconds from send to a later milestone; "—" until it happens (acknowledged is not the same as delivering)
const since = (from: number | null | undefined, to: number | null | undefined) => (from == null || to == null ? '—' : `${Math.max(0, to - from).toFixed(0)}s`)

// GridFlex coordination for this event: live shortage ledger while it is the active event, its lifecycle afterwards
function CoordTab({ d }: { d: Full }) {
  const { data } = useApi<{ ledger: GfLedger }>('/gridflex/overview', { intervalMs: 3000 })
  if (data?.ledger.event_id === d.id) return <CoordinationView L={data.ledger} />
  const phases = d.phases ?? []
  return (
    <div className="space-y-2 text-[12px]">
      <div className="text-[11px] font-semibold text-slate-600">Lifecycle</div>
      {phases.length ? (
        <div className="flex flex-wrap gap-2">
          {phases.map((p, i) => (
            <span key={i} className="rounded-lg bg-slate-50 px-2 py-1 font-mono text-[11px] ring-1 ring-slate-200">
              {clockS(p.ts)} · <b>{p.phase}</b>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-slate-500">No lifecycle recorded.</div>
      )}
      <div className="text-[11px] text-slate-500">The live shortage ledger is shown while this is the active event; settled figures are in Settlement.</div>
    </div>
  )
}

function CommandsTab({ d }: { d: Full }) {
  const cmds = [...(d.commands ?? [])].reverse()
  return (
    <FitPager
      items={cmds}
      rowHeight={33}
      render={(slice) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Resource</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead className="text-right">Setpoint</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Delivered</TableHead>
              <TableHead className="text-right" title="Seconds after send: gateway acknowledgement → first metered response (10 %) → full output (90 %)">
                Ack · first · full
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {slice.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono text-[11px]">{clockS(c.created)}</TableCell>
                <TableCell className="max-w-[160px] truncate text-xs">{c.asset_name}</TableCell>
                <TableCell className="text-[10px] text-slate-500">{c.protocol}</TableCell>
                <TableCell className="text-right font-mono text-[11px]">{c.kind === 'RELEASE' ? 'release' : `${c.setpoint.toFixed(0)} MW`}</TableCell>
                <TableCell>
                  <Badge variant={CMD_STYLE[c.state] ?? 'outline'}>{c.state.replace('_', ' ')}</Badge>
                  {c.under_delivering && (
                    <Badge variant="destructive" className="ml-1">
                      under
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono text-[11px]">{c.state === 'EXECUTING' ? `${c.delivered_mw.toFixed(0)} MW` : '—'}</TableCell>
                <TableCell
                  className="text-right font-mono text-[10px] whitespace-nowrap text-slate-500"
                  title={c.auth ? `${c.auth.alg} · key ${c.auth.key_id} · ${c.auth.mac.slice(0, 16)}…` : 'not sent yet'}
                >
                  {since(c.sent_at, c.acked_at)} · {since(c.sent_at, c.first_response_at)} · {since(c.sent_at, c.full_output_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    />
  )
}

function RevisionsTab({ d }: { d: Full }) {
  const revs = [...d.revisions].reverse()
  return (
    <FitPager
      items={revs}
      rowHeight={33}
      render={(slice) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rev</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead className="text-right">Requirement</TableHead>
              <TableHead className="text-right">Planned</TableHead>
              <TableHead className="text-right">Auto / approval</TableHead>
              <TableHead>Twin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {slice.map((r) => (
              <TableRow key={r.rev}>
                <TableCell className="font-mono text-[11px]">{r.rev}</TableCell>
                <TableCell className="font-mono text-[11px]">{clockS(r.ts)}</TableCell>
                <TableCell className="text-[11px]">{r.reason}</TableCell>
                <TableCell className="text-right font-mono text-[11px]">{r.requirement_mw.toFixed(0)}</TableCell>
                <TableCell className="text-right font-mono text-[11px]">
                  {r.planned_mw.toFixed(0)} ({r.resources})
                </TableCell>
                <TableCell className="text-right font-mono text-[11px]">
                  {r.auto_mw.toFixed(0)} / {r.awaiting_mw.toFixed(0)}
                </TableCell>
                <TableCell>{r.twin_ok ? <CheckCircle2 className="size-4 text-emerald-500" /> : <XCircle className="size-4 text-rose-500" />}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    />
  )
}

function SettleTab({ d }: { d: Full }) {
  const s = d.settlement!
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="grid shrink-0 grid-cols-5 gap-2">
        <Stat label="DSM avoided" value={fmtRs(s.avoided_dsm_rs)} tone="good" />
        <Stat label="Payments (incl. RTM)" value={fmtRs(s.payments_rs)} />
        <Stat label="Rebound energy" value={fmtRs(s.rebound_cost_rs ?? 0)} />
        <Stat label="Net savings" value={fmtRs(s.net_benefit_rs)} tone={s.net_benefit_rs >= 0 ? 'good' : 'warn'} />
        <Stat label="Delivered / expected" value={`${s.delivered_mwh.toFixed(1)} / ${s.expected_mwh.toFixed(1)} MWh`} />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,15rem)_minmax(0,1fr)] gap-3">
        {s.ledger && (
          <div className="rounded-xl border border-slate-200/80 bg-white/70 p-2.5">
            <div className="mb-1.5 text-[11px] font-semibold text-slate-600">Counterfactual ledger</div>
            {s.ledger.map((l) => (
              <div
                key={l.key}
                className={cn(
                  'flex items-baseline justify-between gap-2 py-0.5 text-[11.5px]',
                  l.subtotal ? 'mt-0.5 border-t border-slate-200 pt-1 font-semibold text-slate-800' : 'text-slate-600',
                )}
              >
                <span className="truncate">{l.label}</span>
                <span className={cn('font-mono tabular-nums', l.subtotal ? (l.rs >= 0 ? 'text-emerald-700' : 'text-rose-600') : l.rs < 0 ? 'text-slate-700' : 'text-slate-700')}>
                  {l.rs < 0 ? '−' : ''}
                  {fmtRs(Math.abs(l.rs))}
                </span>
              </div>
            ))}
            <div className="mt-1.5 text-[10px] leading-snug text-slate-400">Every savings figure for this event comes from these lines; they reconcile exactly.</div>
          </div>
        )}
        <div className="min-h-0">
          <FitPager
            items={s.rows}
            rowHeight={33}
            render={(slice) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Resource</TableHead>
                    <TableHead className="text-right">Delivered MWh</TableHead>
                    <TableHead className="text-right">Perf.</TableHead>
                    <TableHead className="text-right">PF</TableHead>
                    <TableHead className="text-right">Payment</TableHead>
                    <TableHead className="text-right">Reliability</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {slice.map((r) => (
                    <TableRow key={r.asset_id}>
                      <TableCell className="max-w-[180px] truncate text-xs">{r.name}</TableCell>
                      <TableCell className="text-right font-mono text-[11px]">{r.delivered_mwh.toFixed(1)}</TableCell>
                      <TableCell className={cn('text-right font-mono text-[11px]', r.performance < 0.9 && 'text-amber-700')}>{(r.performance * 100).toFixed(0)}%</TableCell>
                      <TableCell className="text-right font-mono text-[11px]">{r.perf_factor.toFixed(2)}</TableCell>
                      <TableCell className="text-right font-mono text-[11px]">{fmtRs(r.payment_rs)}</TableCell>
                      <TableCell className="text-right font-mono text-[11px]">
                        {(r.reliability_before * 100).toFixed(0)}→{(r.reliability_after * 100).toFixed(0)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          />
        </div>
      </div>
    </div>
  )
}

function EventKpis({ d }: { d: Full }) {
  const o = d.outcome ?? {}
  const st = d.settlement
  const delivering = o.delivered_mw ?? d.delivered_mw
  const expected = o.expected_mw ?? 0
  // a ratio over a few MW is noise: only report performance once there is a meaningful expectation
  const perf = st ? (st.expected_mwh >= 0.5 ? st.delivered_mwh / st.expected_mwh : null) : expected >= 5 ? delivering / expected : null
  const mins = st ? st.duration_min : (o.minutes ?? 0)
  return (
    <div className="grid shrink-0 grid-cols-6 gap-2">
      <Stat icon={<Crosshair />} label="Target (grid need)" value={fmtMW(d.requirement_mw)} sub={d.direction === 'UP' ? 'load reduction' : 'load increase'} />
      <Stat
        icon={<Send />}
        label="Dispatched"
        value={fmtMW(d.planned_mw)}
        sub={`${d.auto_mw.toFixed(0)} MW auto · ${d.awaiting_mw.toFixed(0)} MW awaiting`}
        tone={d.awaiting_mw > 0.5 ? 'warn' : undefined}
      />
      <Stat
        icon={<Activity />}
        label={st ? 'Energy delivered' : 'Delivering now'}
        value={st ? fmtEnergy(st.delivered_mwh) : fmtMW(delivering)}
        sub={st ? `of ${fmtEnergy(st.expected_mwh)} expected` : `of ${fmtMW(expected)} expected`}
      />
      <Stat
        icon={<Target />}
        label="Performance vs baseline"
        value={perf == null ? '—' : `${(perf * 100).toFixed(0)}%`}
        tone={perf == null ? undefined : perf >= 0.85 ? 'good' : 'warn'}
        sub="metered delivery / expected"
      />
      <Stat icon={<Timer />} label="Duration" value={`${mins.toFixed(0)} min`} sub={d.closed_at ? `closed ${clockS(d.closed_at)}` : `since ${clockS(d.opened_at)}`} />
      <Stat
        icon={<IndianRupee />}
        label={st ? 'Net benefit' : 'DSM charges avoided so far'}
        value={fmtRs(st ? st.net_benefit_rs : (o.avoided_dsm_rs ?? 0))}
        sub={st ? `${fmtRs(st.avoided_dsm_rs)} avoided − ${fmtRs(st.payments_rs + (st.rebound_cost_rs ?? 0))} paid & rebound` : 'vs doing nothing'}
        tone="good"
      />
    </div>
  )
}

function PerformanceChart({ d }: { d: Full }) {
  const rows = (d.timeline ?? []).map((p) => ({ ...p, label: clock(p.t) }))
  if (rows.length < 2) return <Empty icon={<Loader2 className="size-5 text-slate-300" />}>Performance curve builds up as the event runs.</Empty>
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#e6eaef" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#96a1ae' }} minTickGap={36} />
        <YAxis tick={{ fontSize: 9, fill: '#96a1ae' }} width={38} />
        <RTooltip {...chartTooltip} formatter={(v) => `${Number(v).toFixed(0)} MW`} />
        <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
        <Area dataKey="delivered" name="Delivered" stroke="#2a8761" fill="#abdbc3" fillOpacity={0.6} isAnimationActive={false} />
        <Line dataKey="dispatched" name="Dispatched" stroke="#6d4fe3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        <Line dataKey="target" name="Target" stroke="#c07e18" strokeDasharray="5 4" strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function TodaySummary({ items }: { items: DecisionSummary[] }) {
  const { data: rep } = useApi<{ decisions: number; delivered_mwh: number; expected_mwh: number; net_benefit_rs: number }>('/reports/summary', { intervalMs: 15000 })
  const open = items.filter((d) => OPEN.includes(d.state))
  const waiting = items.filter((d) => d.state === 'AWAITING_APPROVAL').length
  const perf = rep && rep.expected_mwh > 0 ? rep.delivered_mwh / rep.expected_mwh : null
  return (
    <div className="grid shrink-0 grid-cols-2 gap-2">
      <Stat
        icon={<Zap />}
        label="Open events"
        value={String(open.length)}
        sub={waiting ? `${waiting} awaiting approval` : open.length ? 'running' : 'none active'}
        tone={waiting ? 'warn' : open.length ? 'info' : undefined}
      />
      <Stat icon={<ListChecks />} label="Settled" value={String(rep?.decisions ?? 0)} sub={`${items.length} events in log`} />
      <Stat
        icon={<Gauge />}
        label="Energy delivered"
        value={fmtEnergy(rep?.delivered_mwh ?? 0)}
        sub={perf == null ? 'vs baseline' : `${(perf * 100).toFixed(0)}% of expected`}
        tone={perf == null ? undefined : perf >= 0.85 ? 'good' : 'warn'}
      />
      <Stat
        icon={<IndianRupee />}
        label="Net benefit"
        value={fmtRs(rep?.net_benefit_rs ?? 0)}
        sub="after participant payments"
        tone={(rep?.net_benefit_rs ?? 0) >= 0 ? 'good' : 'bad'}
      />
    </div>
  )
}

interface AuditEntry {
  seq: number
  ts: number
  kind: string
  actor: string
  message: string
}

const ACT: Record<string, { icon: typeof Check; cls: string; label: string }> = {
  EVENT: { icon: Zap, cls: 'bg-sky-100 text-sky-700', label: 'Event' },
  ANALYSIS: { icon: Brain, cls: 'bg-violet-100 text-violet-700', label: 'Re-plan' },
  APPROVAL: { icon: UserCheck, cls: 'bg-amber-100 text-amber-700', label: 'Approval' },
  COMMAND: { icon: Send, cls: 'bg-sky-100 text-sky-700', label: 'Dispatch' },
  ACK: { icon: CheckCircle2, cls: 'bg-emerald-100 text-emerald-700', label: 'Ack' },
  SETTLEMENT: { icon: Receipt, cls: 'bg-emerald-100 text-emerald-700', label: 'Settled' },
  OVERRIDE: { icon: OctagonX, cls: 'bg-rose-100 text-rose-700', label: 'Override' },
}

function ActivityLog({ id }: { id: string | null }) {
  const [filter, setFilter] = useState<'all' | 'decisions' | 'dispatch'>('all')
  const { data } = useApi<{ items: AuditEntry[]; total: number }>(id ? `/audit?ref=${id}&limit=300` : null, { intervalMs: 4000 })
  const all = data?.items ?? []
  const rows = all.filter((e) => filter === 'all' || (filter === 'dispatch' ? ['COMMAND', 'ACK'].includes(e.kind) : !['COMMAND', 'ACK'].includes(e.kind)))
  return (
    <Panel
      className="min-h-0 flex-1"
      title="Event activity"
      aside={
        <div className="flex rounded-md bg-slate-100 p-0.5 text-[10px]">
          {(['all', 'decisions', 'dispatch'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={cn('rounded px-1.5 py-0.5 capitalize', filter === f ? 'bg-white font-semibold shadow-xs' : 'text-slate-500')}>
              {f}
            </button>
          ))}
        </div>
      }
      bodyClass="p-1.5"
    >
      {!id ? (
        <Empty>Select an event to follow its activity.</Empty>
      ) : rows.length === 0 ? (
        <Empty icon={<Loader2 className="size-5 text-slate-300" />}>No activity recorded yet.</Empty>
      ) : (
        <FitPager
          items={rows}
          rowHeight={46}
          reserve={34}
          render={(slice) => (
            <ol className="relative space-y-0.5">
              {slice.map((e) => {
                const m = ACT[e.kind] ?? { icon: CheckCircle2, cls: 'bg-slate-100 text-slate-600', label: e.kind }
                const Icon = m.icon
                return (
                  <li key={e.seq} className="flex gap-2 rounded-md px-1 py-1 hover:bg-slate-50" title={e.message}>
                    <span className={cn('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full', m.cls)}>
                      <Icon className="size-3" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                        <span className="font-semibold text-slate-600">{m.label}</span>
                        <span>{e.actor}</span>
                        <span className="ml-auto font-mono">{clockS(e.ts)}</span>
                      </div>
                      <div className="line-clamp-1 text-[11px] text-slate-700">{e.message}</div>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        />
      )}
    </Panel>
  )
}
