// GridFlex — coordinated industrial flexibility and load rotation inside ADRMS. These views live on existing pages:
// the coordination ledger on DR Events, the industrial programme on Programs, and the shortage scenario on What-if.
import { useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, Check, CircleDot, FlaskConical, Loader2, X } from 'lucide-react'
import { FitPager } from '@/components/common'
import { Empty } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useApi } from '@/hooks'
import { api } from '@/lib/api'
import { fmtMW, fmtRs } from '@/lib/geo'
import { chartTooltip } from '@/lib/ui'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/useAuth'
import { clockS } from '@/store/useLive'
import { useUI } from '@/store/useUI'

export interface GfLedger {
  phase: string
  phases: { phase: string; ts: number }[]
  event_id: string | null
  direction: 'UP' | 'DOWN'
  shortage_mw: number
  bess: { commanded_mw: number; metered_mw: number }
  industrial: { offered_mw: number; activated_mw: number; metered_mw: number; verified_mw: number }
  other_flex: { commanded_mw: number; metered_mw: number }
  rotation: {
    planned_mw: number
    measured_mw: number
    groups_out: number
    order: { id: string; state: string; mw: number; planned_mw: number; measured_mw: number; escalated: boolean } | null
  }
  residual_mw: number
  rotation_residual: { planned_mw: number; measured_shortfall_mw: number; residual_mw: number }
  emergency: boolean
  escalations: string[]
}
export interface GfKpis {
  flex_cost_rs_per_mwh: number | null
  delivered_mwh: number
  events_settled: number
  event_success_rate: number | null
  forecast_mape_pct: number | null
  rebound_mw: number
  disputes: number
  interruption_by_group: { group: string; name: string; discom: string; minutes_today: number; hours_7d: number; interruptions_7d: number; F: number }[]
}
interface Offer {
  id: string
  participant: string
  mw: number
  window: [string, string]
  response_min: number
  min_activation_min: number
  max_duration_min: number
  recovery_min: number
  price_rs_mwh: number
  availability_rs_mw_h: number
  reliability: number
  restrictions: string
  kind: string
  status: string
  decided_by: string | null
  note: string
  in_window?: boolean
}
interface Participant {
  id: string
  name: string
  short: string
  discom: string
  connection: string
  contracted_demand_mw: number
  declared_level_mw: number
  min_stable_mw: number
  meter: string
  control: string
  processes: { id: string; name: string; mw: number; response_min: number; max_duration_min: number; recovery_min: number; restriction: string }[]
  reliability: number
  metered_mw: number | null
  baseline_now_mw: number
  activated_mw: number
  offer: Offer | null
  events: number
  verified_mwh: number
  paid_rs: number
  disputes: number
}
interface MV {
  decision_id: string
  participant: string
  baseline_mw: number
  baseline_method: string
  price_rs_mwh: number
  blocks: { block: number; label: string; hours: number; B: number; M: number; R: number; A: number; V: number }[]
  status: string
  energy_mwh: number
  accepted_mwh: number
  payment_rs: number
  availability_rs: number
  adjustment_rs: number
  dispute: string | null
}
interface Industrial {
  participants: Participant[]
  offers: Offer[]
  mv: MV[]
  baseline: { method: string; description: string }
  offered_mw: number
}

const PHASES = ['DETECTED', 'ASSESSED', 'PROPOSED', 'APPROVED', 'ACTIVATING', 'VERIFYING', 'RECOVERY', 'SETTLED']
const SHORT: Record<string, string> = {
  DETECTED: 'Detect',
  ASSESSED: 'Assess',
  PROPOSED: 'Propose',
  APPROVED: 'Approve',
  ACTIVATING: 'Activate',
  VERIFYING: 'Verify',
  RECOVERY: 'Recover',
  SETTLED: 'Settle',
}
const EXC: Record<string, string> = {
  REJECTED: 'bg-slate-200 text-slate-700',
  CANCELLED: 'bg-slate-200 text-slate-700',
  FAILED: 'bg-rose-100 text-rose-700',
  DISPUTED: 'bg-amber-100 text-amber-800',
}
const OFFER_STYLE: Record<string, 'success' | 'warning' | 'outline' | 'destructive'> = { ACCEPTED: 'success', SUBMITTED: 'warning', REJECTED: 'destructive', WITHDRAWN: 'outline' }

/* ------------------------------------------------------------------ coordination */
export function CoordinationView({ L }: { L: GfLedger }) {
  const go = useUI((s) => s.go)
  const exc = EXC[L.phase]
  const idx = PHASES.indexOf(L.phase)
  const steps = [
    { label: 'Shortage', planned: L.shortage_mw, measured: L.shortage_mw, cls: 'bg-amber-500', sign: '' },
    { label: '1 · BESS', planned: L.bess.commanded_mw, measured: L.bess.metered_mw, cls: 'bg-violet-500', sign: '−', note: 'metered' },
    {
      label: '2 · Industrial flexibility',
      planned: L.industrial.activated_mw,
      measured: L.industrial.verified_mw,
      cls: 'bg-emerald-500',
      sign: '−',
      note: 'verified = min(max(0, B − M), A)',
    },
    { label: '3 · Other flexibility (generation, DR, RTM)', planned: L.other_flex.commanded_mw, measured: L.other_flex.metered_mw, cls: 'bg-sky-500', sign: '−', note: 'metered' },
    { label: '4 · Load rotation', planned: L.rotation.planned_mw, measured: L.rotation.measured_mw, cls: 'bg-rose-500', sign: '−', note: 'metered relief' },
    { label: 'Residual', planned: L.rotation_residual.residual_mw, measured: L.residual_mw, cls: L.residual_mw > 1 ? 'bg-rose-600' : 'bg-slate-300', sign: '=' },
  ]
  const scale = Math.max(L.shortage_mw, ...steps.map((s) => s.planned), 1)
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-3">
      <div className="flex min-h-0 flex-col gap-3">
        <div className="rounded-xl border border-slate-200/80 bg-white/70 p-3">
          <div className="mb-2 flex items-center justify-between text-[11px] font-semibold text-slate-600">
            <span>Event lifecycle {L.event_id && <span className="font-mono text-slate-400">· {L.event_id}</span>}</span>
            {L.event_id && (
              <button className="text-sky-700 hover:underline" onClick={() => go('decisions', L.event_id ?? undefined)}>
                Open event →
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            {PHASES.map((p, i) => (
              <div key={p} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                <div className={cn('h-1.5 w-full rounded-full', exc ? 'bg-slate-200' : i < idx ? 'bg-sky-500' : i === idx ? 'animate-pulse bg-sky-600' : 'bg-slate-200')} />
                <span title={p} className={cn('truncate text-[9.5px] font-semibold', i === idx && !exc ? 'text-sky-700' : 'text-slate-400')}>
                  {SHORT[p]}
                </span>
              </div>
            ))}
          </div>
          {exc && <div className={cn('mt-2 inline-block rounded px-2 py-0.5 text-[11px] font-bold', exc)}>{L.phase}</div>}
          {L.phase === 'MONITORING' && <div className="mt-2 text-[11px] text-slate-500">No shortage event — monitoring.</div>}
          {L.phases.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-slate-500">
              {L.phases.map((p, i) => (
                <span key={i}>
                  {clockS(p.ts)} {p.phase}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 rounded-xl border border-slate-200/80 bg-white/70 p-3">
          <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-slate-600">
            <span>
              Shortage ledger — planned / commanded vs measured
              {L.direction === 'DOWN' && <span className="ml-1.5 font-normal text-sky-700">(surplus event: load increase; rotation never applies)</span>}
            </span>
            <span className="font-normal text-slate-400">an instruction is not a reduction</span>
          </div>
          <div className="space-y-2.5">
            {steps.map((s) => (
              <div key={s.label}>
                <div className="flex items-baseline justify-between text-[12px]">
                  <span className="text-slate-700">
                    <b className="mr-1 font-mono text-slate-400">{s.sign}</b>
                    {s.label}
                    {s.note && <span className="ml-1.5 text-[10px] text-slate-400">({s.note})</span>}
                  </span>
                  <span className="font-mono text-[12px] tabular-nums">
                    <span className="text-slate-400">{fmtMW(s.planned)}</span>
                    <span className="mx-1 text-slate-300">→</span>
                    <b className="text-slate-800">{fmtMW(s.measured)}</b>
                  </span>
                </div>
                <div className="relative mt-1 h-2 rounded-full bg-slate-100">
                  <div className="absolute inset-y-0 left-0 rounded-full bg-slate-300/70" style={{ width: `${(Math.min(s.planned, scale) / scale) * 100}%` }} />
                  <div className={cn('absolute inset-y-0 left-0 rounded-full', s.cls)} style={{ width: `${(Math.min(s.measured, scale) / scale) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[10.5px] leading-snug text-slate-500">
            Grey = planned or commanded, colour = measured. Residual for rotation uses the planned shortfall that persists after ramp-in ({fmtMW(L.rotation_residual.planned_mw)})
            plus measured under-delivery once response windows pass ({fmtMW(L.rotation_residual.measured_shortfall_mw)}).
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-col gap-3">
        <div className={cn('rounded-xl border p-3 text-[12px]', L.emergency ? 'border-rose-200 bg-rose-50/70' : 'border-slate-200/80 bg-white/70')}>
          <div className="mb-1 font-semibold text-slate-700">Dispatch priority</div>
          <ol className="list-decimal space-y-0.5 pl-4 text-slate-600">
            <li>
              <b>BESS</b> — first, up to power, state of charge and network limits
            </li>
            <li>
              <b>Industrial flexibility</b> — inside accepted offers, on their terms
            </li>
            <li>Other paid flexibility — generation re-dispatch, interruptible, shiftable, DER, then RTM</li>
            <li>
              <b>Load rotation</b> — only for what remains after measured response, with shift-in-charge approval
            </li>
          </ol>
          <div className="mt-1 text-[11px] text-slate-500">Each tier is used fully before the next; within a tier, the cheapest goes first.</div>
          <div className={cn('mt-2 text-[11px]', L.emergency ? 'font-semibold text-rose-700' : 'text-slate-500')}>
            Emergencies are not a rigid sequence: authorised control-room procedure and independent UFR / df/dt protection always take precedence.
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-200/80 bg-white/70 p-3">
          <div className="mb-1.5 text-[11px] font-semibold text-slate-600">Escalations</div>
          {L.escalations.length ? (
            <ul className="space-y-1.5 text-[12px]">
              {L.escalations.map((e) => (
                <li key={e} className="flex gap-2 rounded-lg bg-amber-50 px-2 py-1.5 text-amber-900">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {e}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing to escalate — measured response matches the plan.</Empty>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ industrial */
export function IndustrialProgramme() {
  const { data, reload } = useApi<Industrial>('/gridflex/industrial', { intervalMs: 5000 })
  const [sel, setSel] = useState<string | null>(null)
  if (!data) return <Empty icon={<Loader2 className="size-5 animate-spin text-slate-400" />}>Loading participants…</Empty>
  const p = data.participants.find((x) => x.id === sel) ?? data.participants[0]
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] gap-3">
      <div className="flex min-h-0 flex-col gap-2">
        <div className="text-[11px] text-slate-500">
          Baseline <b className="font-mono text-slate-700">{data.baseline.method}</b>: {data.baseline.description}. Dispatch only inside an accepted offer, on its terms.
        </div>
        <div className="min-h-0 flex-1">
          <FitPager
            items={data.participants}
            rowHeight={37}
            render={(slice) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Industry</TableHead>
                    <TableHead>Offer</TableHead>
                    <TableHead className="text-right">MW · ₹/MWh</TableHead>
                    <TableHead className="text-right">Activated</TableHead>
                    <TableHead className="text-right">Reliability</TableHead>
                    <TableHead className="text-right">Verified</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {slice.map((x) => (
                    <TableRow key={x.id} onClick={() => setSel(x.id)} className={cn('cursor-pointer', p?.id === x.id && 'bg-sky-50/70')}>
                      <TableCell className="max-w-[170px]">
                        <div className="truncate text-xs font-medium">{x.name}</div>
                        <div className="text-[10px] text-slate-400">
                          {x.discom} · {x.connection}
                        </div>
                      </TableCell>
                      <TableCell>
                        {x.offer ? (
                          <span className="flex items-center gap-1.5">
                            <Badge variant={OFFER_STYLE[x.offer.status] ?? 'outline'} className="h-4 px-1.5 text-[9px]">
                              {x.offer.status}
                            </Badge>
                            <span className={cn('font-mono text-[10px]', x.offer.in_window ? 'text-slate-500' : 'text-slate-400')}>
                              {x.offer.window[0]}–{x.offer.window[1]}
                              {x.offer.status === 'ACCEPTED' && !x.offer.in_window && ' · not open yet'}
                            </span>
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-400">no live offer</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px]">
                        {x.offer ? `${x.offer.mw.toFixed(0)} · ${x.offer.price_rs_mwh.toLocaleString('en-IN')}` : '—'}
                      </TableCell>
                      <TableCell className={cn('text-right font-mono text-[11px]', x.activated_mw > 0.5 && 'font-semibold text-emerald-700')}>
                        {x.activated_mw > 0.5 ? fmtMW(x.activated_mw) : '—'}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px]">{(x.reliability * 100).toFixed(0)}%</TableCell>
                      <TableCell className="text-right font-mono text-[11px]">{x.verified_mwh ? `${x.verified_mwh.toFixed(1)} MWh` : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          />
        </div>
        <OfferQueue offers={data.offers.filter((o) => o.status === 'SUBMITTED')} names={Object.fromEntries(data.participants.map((x) => [x.id, x.short]))} onDone={reload} />
      </div>
      {p && <ParticipantDetail p={p} mv={data.mv.filter((m) => m.participant === p.id)} onDone={reload} />}
    </div>
  )
}

function OfferQueue({ offers, names, onDone }: { offers: Offer[]; names: Record<string, string>; onDone: () => void }) {
  const can = useAuth((s) => s.can)
  const [busy, setBusy] = useState(false)
  if (!offers.length) return null
  async function act(id: string, action: string) {
    setBusy(true)
    try {
      await api(`/gridflex/offers/${id}/${action}`, { method: 'POST', body: { note: action === 'reject' ? 'Not required for this window' : '' } })
      onDone()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="shrink-0 rounded-xl border border-amber-200 bg-amber-50/70 p-2">
      <div className="mb-1 text-[11px] font-semibold text-amber-900">Offers awaiting acceptance</div>
      {offers.map((o) => (
        <div key={o.id} className="flex items-center gap-2 py-0.5 text-[11.5px]">
          <span className="font-mono text-[10px] text-slate-500">{o.id}</span>
          <span className="min-w-0 flex-1 truncate">
            {names[o.participant]} · {o.mw.toFixed(0)} MW {o.window[0]}–{o.window[1]} · ₹{o.price_rs_mwh.toLocaleString('en-IN')}/MWh · {o.response_min} min response · {o.kind}
          </span>
          {can('resources') && (
            <>
              <Button size="sm" className="h-6 px-2 text-[11px]" disabled={busy} onClick={() => act(o.id, 'accept')}>
                <Check className="size-3" /> Accept
              </Button>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={busy} onClick={() => act(o.id, 'reject')}>
                <X className="size-3" /> Reject
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function ParticipantDetail({ p, mv, onDone }: { p: Participant; mv: MV[]; onDone: () => void }) {
  const { data: m } = useApi<{ baseline_mw: number; points: { ts: number; mw: number }[] }>(`/gridflex/industrial/${p.id}/meter`, { intervalMs: 5000 })
  const can = useAuth((s) => s.can)
  const rows = (m?.points ?? []).map((x) => ({ t: clockS(x.ts).slice(0, 5), mw: x.mw }))
  const last = mv[0]
  async function dispute() {
    if (!last) return
    await api(`/gridflex/mv/${last.decision_id}/${p.id}/dispute`, {
      method: 'POST',
      body: { reason: 'Participant contests baseline: production schedule changed before the event' },
    })
    onDone()
  }
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="rounded-xl border border-slate-200/80 bg-white/70 p-2.5">
        <div className="flex items-baseline justify-between">
          <div className="text-[13px] font-semibold text-slate-800">{p.name}</div>
          <div className="font-mono text-[10px] text-slate-400">
            {p.meter} · {p.control}
          </div>
        </div>
        <div className="text-[11px] text-slate-500">
          Contracted {fmtMW(p.contracted_demand_mw)} · declared level {fmtMW(p.declared_level_mw)} · min stable {fmtMW(p.min_stable_mw)}
        </div>
        <div className="mt-1.5 grid grid-cols-3 gap-1.5">
          {p.processes.map((x) => (
            <div key={x.id} className="rounded-lg bg-slate-50 px-2 py-1 ring-1 ring-slate-200" title={x.restriction}>
              <div className="truncate text-[10.5px] font-medium text-slate-700">{x.name}</div>
              <div className="font-mono text-[10px] text-slate-500">
                {fmtMW(x.mw)} · {x.response_min}m · ≤{x.max_duration_min}m
              </div>
            </div>
          ))}
        </div>
        {p.offer && (
          <div className="mt-1.5 text-[10.5px] text-slate-500">
            Offer {p.offer.id}: {p.offer.mw.toFixed(0)} MW, {p.offer.window[0]}–{p.offer.window[1]}, min {p.offer.min_activation_min} / max {p.offer.max_duration_min} min, recovery{' '}
            {p.offer.recovery_min} min{p.offer.availability_rs_mw_h ? `, availability ₹${p.offer.availability_rs_mw_h}/MW·h` : ''} — {p.offer.restrictions}
          </div>
        )}
      </div>
      <div className="h-36 shrink-0 rounded-xl border border-slate-200/80 bg-white/70 p-2">
        <div className="text-[10.5px] font-semibold text-slate-600">Metered demand vs baseline (MW)</div>
        <ResponsiveContainer width="100%" height="88%">
          <ComposedChart data={rows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="t" tick={{ fontSize: 9 }} minTickGap={40} />
            <YAxis tick={{ fontSize: 9 }} domain={['auto', 'auto']} />
            <RTooltip {...chartTooltip} />
            <Area type="monotone" dataKey="mw" stroke="#5735cf" fill="#5735cf" fillOpacity={0.08} strokeWidth={1.5} dot={false} name="Metered" isAnimationActive={false} />
            {m && (
              <ReferenceLine
                y={m.baseline_mw}
                stroke="#c07e18"
                strokeDasharray="4 3"
                label={{ value: `B ${m.baseline_mw}`, fontSize: 9, fill: '#c07e18', position: 'insideTopRight' }}
              />
            )}
            <Line dataKey="mw" stroke="transparent" dot={false} legendType="none" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-200/80 bg-white/70 p-2">
        <div className="mb-1 flex items-center justify-between text-[10.5px] font-semibold text-slate-600">
          <span>M&V — latest event {last ? <span className="font-mono text-slate-400">{last.decision_id}</span> : ''}</span>
          {last && (
            <span className="flex items-center gap-2">
              <Badge variant={last.status === 'SETTLED' ? 'success' : last.status === 'DISPUTED' ? 'warning' : 'outline'} className="h-4 px-1.5 text-[9px]">
                {last.status}
              </Badge>
              {can('resources') && last.status === 'SETTLED' && (
                <button className="text-[10.5px] text-amber-700 hover:underline" onClick={dispute}>
                  Raise dispute
                </button>
              )}
            </span>
          )}
        </div>
        {last ? (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  {['Block', 'B', 'M', 'R = B−M', 'A', 'V = min(R,A)'].map((h) => (
                    <TableHead key={h} className="h-6 text-right text-[10px] first:text-left">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {last.blocks.slice(-5).map((b) => (
                  <TableRow key={b.block}>
                    <TableCell className="py-1 font-mono text-[10.5px]">{b.label}</TableCell>
                    {[b.B, b.M, b.R, b.A, b.V].map((v, i) => (
                      <TableCell key={i} className={cn('py-1 text-right font-mono text-[10.5px]', i === 4 && 'font-semibold text-emerald-700')}>
                        {v.toFixed(1)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="mt-1 text-[10.5px] text-slate-600">
              E = {last.energy_mwh.toFixed(2)} MWh of {last.accepted_mwh.toFixed(2)} accepted · pay = E × ₹{last.price_rs_mwh.toLocaleString('en-IN')}
              {last.availability_rs ? ` + ${fmtRs(last.availability_rs)} availability` : ''}
              {last.adjustment_rs ? ` ${fmtRs(last.adjustment_rs)} adjustment` : ''} = <b>{fmtRs(last.payment_rs)}</b>
              {last.dispute && <div className="text-amber-800">Dispute: {last.dispute}</div>}
            </div>
          </>
        ) : (
          <Empty>Not activated yet.</Empty>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ scenario */
interface Scenario {
  band_mw: number
  industrial_offered_mw: number
  cases: {
    id: string
    label: string
    utility_cost_rs: number
    residual_mw: number
    industrial_mw: number
    other_flex_mw: number
    rotation_mw: number
    interruption_mwh: number
    interruption_impact_rs: number
    groups: number
    stations: number
    beyond_band: boolean
    group_names?: string[]
    rebound_mw?: number
  }[]
  note: string
}

export function ShortageScenario() {
  const can = useAuth((s) => s.can)
  const [shortage, setShortage] = useState(600)
  const [blocks, setBlocks] = useState(4)
  const [part, setPart] = useState(70)
  const [voll, setVoll] = useState(40)
  const [res, setRes] = useState<Scenario | null>(null)
  const [busy, setBusy] = useState(false)
  async function run() {
    setBusy(true)
    try {
      setRes(
        await api<Scenario>('/gridflex/scenario', {
          method: 'POST',
          body: { shortage_mw: shortage, duration_blocks: blocks, participation_pct: part, interruption_cost_rs_kwh: voll },
        }),
      )
    } finally {
      setBusy(false)
    }
  }
  const tone: Record<string, string> = { none: 'border-slate-200', flex: 'border-emerald-200 bg-emerald-50/40', rotation: 'border-rose-200 bg-rose-50/30' }
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-end gap-3 rounded-xl border border-slate-200/80 bg-white/70 p-2.5 text-[11px]">
        <label className="flex flex-col gap-1">
          Shortage (MW)
          <Input type="number" value={shortage} onChange={(e) => setShortage(Number(e.target.value))} className="h-7 w-24 text-xs" />
        </label>
        <label className="flex flex-col gap-1">
          Duration (15-min blocks)
          <Input type="number" min={1} max={8} value={blocks} onChange={(e) => setBlocks(Number(e.target.value))} className="h-7 w-20 text-xs" />
        </label>
        <div className="flex flex-col gap-1">
          Industrial participation
          <div className="flex gap-1">
            {[50, 70, 90].map((v) => (
              <Button key={v} size="sm" variant={part === v ? 'default' : 'outline'} className="h-7 px-2.5 text-[11px]" onClick={() => setPart(v)}>
                {v}%
              </Button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1">
          Interruption cost (₹/kWh, illustrative)
          <Input type="number" value={voll} onChange={(e) => setVoll(Number(e.target.value))} className="h-7 w-24 text-xs" />
        </label>
        <Button size="sm" className="h-7" disabled={busy || !can('whatif')} onClick={run}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />} Run scenario
        </Button>
        <span className="ml-auto self-center text-slate-400">Copy of the live state — nothing is dispatched.</span>
      </div>
      {res ? (
        <div className="grid min-h-0 flex-1 grid-cols-3 gap-3">
          {res.cases.map((c) => (
            <div key={c.id} className={cn('flex min-h-0 flex-col gap-2 rounded-xl border p-3', tone[c.id])}>
              <div className="text-[13px] font-semibold text-slate-800">{c.label}</div>
              <div className="font-mono text-xl font-semibold text-slate-800">{fmtRs(c.utility_cost_rs)}</div>
              <div className="text-[10.5px] text-slate-500">utility cost over {blocks} block(s): payments, rebound and DSM still owed</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px]">
                {(
                  [
                    ['Industrial', fmtMW(c.industrial_mw)],
                    ['Other flexibility', fmtMW(c.other_flex_mw)],
                    ['Load rotation', fmtMW(c.rotation_mw)],
                    ['Residual', fmtMW(c.residual_mw)],
                    ['Unserved energy', `${c.interruption_mwh.toFixed(1)} MWh`],
                    ['Interruption impact', fmtRs(c.interruption_impact_rs)],
                    ['Groups · stations', `${c.groups} · ${c.stations}`],
                  ] as const
                ).map(([k2, v]) => (
                  <div key={k2} className="flex justify-between gap-2 border-b border-slate-100 py-0.5">
                    <span className="text-slate-500">{k2}</span>
                    <span className="font-mono text-slate-800">{v}</span>
                  </div>
                ))}
              </div>
              {c.beyond_band && (
                <div className="flex items-center gap-1.5 text-[11px] text-amber-800">
                  <CircleDot className="size-3" /> residual beyond the {fmtMW(res.band_mw)} DSM band
                </div>
              )}
              {c.group_names && c.group_names.length > 0 && <div className="truncate text-[10.5px] text-slate-500">Groups: {c.group_names.join(' · ')}</div>}
            </div>
          ))}
        </div>
      ) : (
        <Empty icon={<FlaskConical className="size-6 text-slate-300" />}>Set a shortage and participation, then run: no action vs flexibility first vs rotation-assisted.</Empty>
      )}
      {res && <div className="shrink-0 text-[10.5px] text-slate-400">{res.note}</div>}
    </div>
  )
}
