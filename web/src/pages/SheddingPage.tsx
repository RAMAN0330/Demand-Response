// Load Shedding — emergency load management by feeder rostering. Last resort for over-drawal once paid flexibility is
// exhausted; every order needs shift-in-charge approval. Roster board (who is out, who is next, fairness), the 220 kV
// feeders on the map, and the order lifecycle (propose → approve → rotate → staged restore).
import { useState } from 'react'
import { Ban, Check, Crosshair, Gauge, Loader2, Power, RotateCcw, Scale, ShieldCheck, Timer, TrendingUp, Waves, Zap } from 'lucide-react'
import { FitPager } from '@/components/common'
import { Empty, Panel, Stat, StatStrip } from '@/components/page'
import { TerritoryMap } from '@/components/three/TerritoryMap'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DISCOM_COLORS, LOAD_CHANNELS } from '@/data/topology'
import { useApi } from '@/hooks'
import { api } from '@/lib/api'
import { fmtMW } from '@/lib/geo'
import { framePoints } from '@/lib/spatial'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/useAuth'
import { clockS, useLive } from '@/store/useLive'
import { useUI } from '@/store/useUI'

interface Group {
  id: string
  discom: string
  letter: string
  name: string
  channels: string[]
  protected: Record<string, number>
  state: 'AVAILABLE' | 'SHED'
  since: number | null
  until: number | null
  minutes_today: number
  spells_today: number
  last_restored: number | null
  mw_now: number
  load_mw: number
  fairness?: { F: number; H_h: number; N: number; D_min: number }
}
interface Order {
  id: string
  created: number
  mw: number
  reason: string
  source: string
  state: string
  approvals: { user: string; role: string; ts: number }[]
  needs_dual: boolean
  activated: number | null
  closed: number | null
  closed_reason: string
  shed_minutes_mw: number
  peak_mw: number
  rotations: number
  log: { t: number; kind: string; msg: string }[]
  planned_mw?: number
  measured_mw?: number
  escalated?: boolean
  selection?: { group: string; name: string; action: 'picked' | 'excluded' | 'next'; reason: string; F: number; mw?: number }[]
}
interface Policy {
  max_spell_min: number
  max_daily_min: number
  trigger_freq: number
  emergency_freq: number
  min_residual_mw: number
  od_limit_mw: number | null
  dual_auth_mw: number
  sheddable_frac: number
  protected: string[]
}
interface Shedding {
  policy: Policy
  summary: { active_mw: number; groups_out: number; residual_mw: number; od_limit_mw: number; next_rotation: number | null; roster_source?: string }
  groups: Group[]
  orders: Order[]
}

const STATE_STYLE: Record<string, string> = {
  PROPOSED: 'bg-amber-100 text-amber-800',
  ACTIVE: 'bg-rose-100 text-rose-700',
  RESTORING: 'bg-violet-100 text-violet-700',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-slate-200 text-slate-700',
  CANCELLED: 'bg-slate-200 text-slate-700',
}

export function SheddingPage() {
  const { data, reload } = useApi<Shedding>('/shedding', { intervalMs: 3000 })
  const f = useLive((s) => s.frame)!
  const now = f.ts
  const focus = useUI((s) => s.focus)
  const setCamera = useUI((s) => s.setCamera)
  const trend = useLive((s) => s.trend)
  if (!data) return <Empty icon={<Loader2 className="size-5 animate-spin text-slate-400" />}>Loading roster…</Empty>
  const { summary: sm, policy: p, groups, orders } = data
  const open = orders.find((o) => ['PROPOSED', 'ACTIVE', 'RESTORING'].includes(o.state)) ?? null
  const mins = groups.map((g) => g.minutes_today)
  const spread = mins.length ? Math.max(...mins) - Math.min(...mins) : 0
  const maxMin = mins.length ? Math.max(...mins) : 0
  const rosterMw = groups.reduce((a, g) => a + g.load_mw, 0)
  const residualTone = sm.residual_mw > sm.od_limit_mw ? 'bad' : sm.residual_mw > p.min_residual_mw ? 'warn' : 'good'
  const freqTone = f.frequency < p.emergency_freq ? 'bad' : f.frequency < p.trigger_freq ? 'warn' : 'good'
  const nextIn = sm.next_rotation ? Math.max(0, (sm.next_rotation - now) / 60) : null
  const discoms = [...new Set(groups.map((g) => g.discom))]
  const letters = [...new Set(groups.map((g) => g.letter))].sort()
  const cols = { gridTemplateColumns: `76px repeat(${letters.length}, minmax(0, 1fr))` }

  return (
    <div className="flex h-full flex-col gap-3">
      <StatStrip>
        <Stat
          icon={<TrendingUp />}
          label="Uncovered OD"
          value={fmtMW(sm.residual_mw)}
          delta={{ text: `limit ${fmtMW(sm.od_limit_mw)}`, tone: residualTone }}
          meter={sm.residual_mw / Math.max(1, sm.od_limit_mw)}
          sub="after flexibility · trigger beyond DSM band"
          tone={residualTone}
        />
        <Stat
          icon={<Waves />}
          label="Frequency"
          value={`${f.frequency.toFixed(3)} Hz`}
          delta={{ text: `< ${p.trigger_freq.toFixed(2)}`, tone: freqTone }}
          spark={trend.slice(-120).map((x) => x.frequency)}
          sub={`immediate below ${p.emergency_freq.toFixed(2)} Hz`}
          tone={freqTone}
        />
        <Stat
          icon={<Power />}
          label="Rotated out now"
          value={fmtMW(sm.active_mw)}
          delta={{ text: `${sm.groups_out}/${groups.length} groups`, tone: sm.groups_out ? 'bad' : 'good' }}
          meter={sm.active_mw / Math.max(1, rosterMw)}
          sub={`of ${fmtMW(rosterMw)} on roster`}
          tone={sm.active_mw > 0 ? 'bad' : 'good'}
        />
        <Stat
          icon={<ShieldCheck />}
          label="Order"
          value={open ? open.state.replace('_', ' ') : 'none'}
          delta={
            open ? { text: `${open.approvals.length}/${open.needs_dual ? 2 : 1} approvals`, tone: open.approvals.length >= (open.needs_dual ? 2 : 1) ? 'good' : 'warn' } : undefined
          }
          sub={open ? `${open.id} · ${fmtMW(open.mw)}${open.needs_dual ? ' · dual' : ''}` : 'flexibility first, load rotation last'}
          tone={open ? (open.state === 'PROPOSED' ? 'warn' : 'bad') : 'good'}
        />
        <Stat
          icon={<Timer />}
          label="Next rotation"
          value={nextIn == null ? '—' : `${nextIn.toFixed(0)} min`}
          meter={nextIn == null ? undefined : 1 - nextIn / Math.max(1, p.max_spell_min)}
          sub={`spells ≤ ${p.max_spell_min} min · ≤ ${p.max_daily_min} min/day`}
          tone={nextIn == null ? undefined : 'info'}
        />
        <Stat
          icon={<Gauge />}
          label="Energy not served"
          value={open ? `${(open.shed_minutes_mw / 60).toFixed(1)} MWh` : '—'}
          sub={open ? `${open.rotations} rotation(s) · peak ${fmtMW(open.peak_mw)}` : 'no active order'}
          tone={open && open.shed_minutes_mw > 0 ? 'warn' : undefined}
        />
        <Stat
          icon={<Scale />}
          label="Fairness today"
          value={`${spread.toFixed(0)} min`}
          delta={{ text: `max ${maxMin.toFixed(0)}/${p.max_daily_min}`, tone: maxMin > p.max_daily_min * 0.8 ? 'warn' : undefined }}
          meter={maxMin / Math.max(1, p.max_daily_min)}
          sub="spread, most vs least rotated group"
          tone={spread > p.max_spell_min * 1.5 ? 'warn' : 'good'}
        />
      </StatStrip>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] gap-3">
        <Panel
          title={
            <span className="flex items-center gap-2">
              Roster board
              {sm.roster_source === 'DEMO' && (
                <span
                  className="rounded bg-amber-100 px-1.5 py-px text-[9.5px] font-bold tracking-wide text-amber-800"
                  title="Groups, the 30 % rotatable share and protected-feeder counts are generated demonstration data. Replace with the DISCOM's approved feeder-level roster (measured loads, protected classifications, switching authority) before any operational use."
                >
                  DEMO ROSTER
                </span>
              )}
            </span>
          }
          aside={
            <span className="flex min-w-0 items-center gap-3 text-[11px] text-slate-500">
              <span className="flex min-w-0 items-center gap-1 truncate">
                <ShieldCheck className="size-3.5 shrink-0 text-emerald-600" /> never rotated: {p.protected.join(' · ')}
              </span>
              <span
                className="shrink-0 rounded border border-slate-200 px-1.5 py-px text-[10px] whitespace-nowrap text-slate-500"
                title="Under-frequency (UFR) and df/dt relays act under the approved protection scheme. This platform proposes load rotation for approval only; it never delays, disables or overrides that protection."
              >
                UFR / df/dt protection independent
              </span>
            </span>
          }
          bodyClass="flex flex-col gap-2"
        >
          <div className="grid shrink-0 gap-1.5 text-[10px] font-semibold tracking-wide text-slate-400 uppercase" style={cols}>
            <span />
            {letters.map((l) => (
              <span key={l} className="text-center">
                {l}
              </span>
            ))}
          </div>
          <div className="grid min-h-0 flex-1 auto-rows-fr gap-1.5">
            {discoms.map((d) => (
              <div key={d} className="grid min-h-0 gap-1.5" style={cols}>
                <div className="flex flex-col justify-center">
                  <span className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700">
                    <span className="size-2.5 rounded-sm" style={{ background: DISCOM_COLORS[d] }} />
                    {d}
                  </span>
                  <span className="text-[10px] text-slate-500">{fmtMW(groups.filter((g) => g.discom === d).reduce((a, g) => a + g.load_mw, 0))} load</span>
                </div>
                {letters.map((l) => {
                  const g = groups.find((x) => x.discom === d && x.letter === l)
                  if (!g) return <div key={l} />
                  return (
                    <GroupCard
                      key={l}
                      g={g}
                      p={p}
                      now={now}
                      onLocate={() => focus({ kind: 'channel', id: g.channels[0] }, framePoints(LOAD_CHANNELS.filter((c) => g.channels.includes(c.id))))}
                    />
                  )
                })}
              </div>
            ))}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3 text-[10px] text-slate-500">
            <Legend cls="bg-white ring-slate-200" label="available" />
            <Legend cls="bg-rose-50 ring-rose-300" label="rotated out (feeders open)" />
            <Legend cls="bg-slate-50 ring-slate-200" label="resting after a spell" />
            <Legend cls="bg-slate-100 ring-slate-300" label="daily limit reached" />
            <span>bar = minutes rotated out today of {p.max_daily_min} min · × = spells</span>
          </div>
        </Panel>

        <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1.05fr)_minmax(0,1fr)] gap-3">
          <Panel title="220 kV feeders — red = rotated out" bodyClass="p-0">
            <TerritoryMap
              compact
              className="rounded-t-none border-0"
              chrome={{
                hideLegend: true,
                cardActions: () => (
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => setCamera('STATE')}>
                    <Crosshair className="size-3.5" /> Reset view
                  </Button>
                ),
              }}
            />
          </Panel>
          <OrderPanel open={open} orders={orders} policy={p} reload={reload} />
        </div>
      </div>
    </div>
  )
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn('size-2.5 rounded-sm ring-1', cls)} />
      {label}
    </span>
  )
}

function GroupCard({ g, p, now, onLocate }: { g: Group; p: Policy; now: number; onLocate: () => void }) {
  const out = g.state === 'SHED'
  const capped = p.max_daily_min - g.minutes_today < 10
  const restLeft = g.last_restored != null ? p.max_spell_min * 60 - (now - g.last_restored) : 0
  const resting = !out && restLeft > 0
  const left = out && g.until ? Math.max(0, (g.until - now) / 60) : null
  const pct = Math.min(100, (g.minutes_today / p.max_daily_min) * 100)
  return (
    <button
      onClick={onLocate}
      title={`${g.name} — ${g.channels.length} stations. Never rotated: ${Object.entries(g.protected)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ${n}`)
        .join(
          ', ',
        )}${g.fairness ? `\nFairness F ${g.fairness.F.toFixed(2)} — ${g.fairness.H_h.toFixed(1)} h, ${g.fairness.N} interruption(s) in 7 days, latest ${g.fairness.D_min.toFixed(0)} min (lower F goes next)` : ''}`}
      className={cn(
        'flex min-h-0 min-w-0 flex-col justify-between gap-0.5 rounded-xl px-2 py-1.5 text-left ring-1 transition hover:-translate-y-px hover:ring-sky-300',
        out ? 'bg-rose-50 ring-rose-300' : capped ? 'bg-slate-100 ring-slate-300' : resting ? 'bg-slate-50 ring-slate-200' : 'bg-white/80 ring-slate-200',
      )}
    >
      <div className="flex min-w-0 items-baseline gap-1 whitespace-nowrap">
        <span className={cn('num text-[13px] font-semibold', out ? 'text-rose-700' : 'text-slate-800')}>{Math.round(g.mw_now).toLocaleString('en-IN')}</span>
        <span className="text-[9px] font-medium text-slate-400">MW</span>
        {out && <Power className="ml-auto size-3 shrink-0 self-center text-rose-600" />}
      </div>
      <div className={cn('truncate text-[9.5px] font-medium', out ? 'text-rose-700' : capped ? 'text-slate-600' : resting ? 'text-slate-500' : 'text-slate-400')}>
        {out ? `${left?.toFixed(0)} min left` : capped ? 'daily limit' : resting ? `resting ${Math.ceil(restLeft / 60)} min` : `${g.channels.length} stations`}
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-slate-200/70">
        <div className={cn('h-full rounded-full', out ? 'bg-rose-500' : pct > 80 ? 'bg-amber-400' : 'bg-sky-400')} style={{ width: `${pct}%` }} />
      </div>
      <div className="num truncate text-[9.5px] text-slate-500">
        {g.minutes_today.toFixed(0)} min · {g.spells_today}×
      </div>
    </button>
  )
}

function OrderPanel({ open, orders, policy, reload }: { open: Order | null; orders: Order[]; policy: Policy; reload: () => void }) {
  const can = useAuth((s) => s.can)
  const user = useAuth((s) => s.user)
  const [mw, setMw] = useState(200)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  async function act(path: string, body?: unknown) {
    setBusy(true)
    setErr(null)
    try {
      await api(path, { method: 'POST', body })
      setReason('')
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const mine = open?.approvals.some((a) => a.user === user?.username)
  const history = orders.filter((o) => o !== open)
  return (
    <Panel
      title={open ? `Order ${open.id}` : 'Load-rotation orders'}
      aside={open && <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold', STATE_STYLE[open.state])}>{open.state}</span>}
      bodyClass="flex flex-col gap-2"
    >
      {open ? (
        <>
          <div className="shrink-0 text-[12px] text-slate-700">
            <b className="font-mono">{fmtMW(open.mw)}</b> · {open.reason}
            <div className="text-[10px] text-slate-500">
              {open.source === 'auto' ? 'Raised by the platform' : `Raised by ${open.source.split(':')[1]}`} at {clockS(open.created)}
              {open.approvals.length > 0 && ` · approved by ${open.approvals.map((a) => a.user).join(', ')}`}
              {open.needs_dual && ` · dual authorisation above ${policy.dual_auth_mw} MW`}
            </div>
          </div>
          {open.state === 'PROPOSED' && (
            <div className="flex shrink-0 flex-col gap-1.5 rounded-lg bg-amber-50/90 p-2">
              <div className="text-[11px] text-amber-900">
                Approving disconnects non-essential 11 kV feeders in the fairest roster groups, {policy.max_spell_min} min at a time. Hospitals, water works, railway traction and
                defence stay on.
              </div>
              <Textarea placeholder="Reason (required to reject)" value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-0 bg-white/80 text-xs" rows={1} />
              <div className="flex gap-2">
                {can('shed') && !mine && (
                  <Button size="sm" variant="destructive" className="h-7" disabled={busy} onClick={() => act(`/shedding/orders/${open.id}/approve`)}>
                    <Check className="size-3.5" /> {open.approvals.length ? 'Second approval' : 'Approve rotation'}
                  </Button>
                )}
                {can('shed') && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 bg-white/70"
                    disabled={busy || reason.trim().length < 3}
                    onClick={() => act(`/shedding/orders/${open.id}/reject`, { reason })}
                  >
                    <Ban className="size-3.5" /> Reject
                  </Button>
                )}
                {!can('shed') && <span className="text-[11px] text-amber-800">Approval needs a shift-in-charge.</span>}
              </div>
            </div>
          )}
          {(open.state === 'ACTIVE' || open.state === 'RESTORING') && can('shed') && open.state === 'ACTIVE' && (
            <div className="flex shrink-0 items-center gap-2">
              <Input placeholder="Reason to restore all" value={reason} onChange={(e) => setReason(e.target.value)} className="h-7 bg-white/80 text-xs" />
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 bg-white/70"
                disabled={busy || reason.trim().length < 3}
                onClick={() => act('/shedding/restore', { reason })}
              >
                <RotateCcw className="size-3.5" /> Restore all (staged)
              </Button>
            </div>
          )}
          {(open.state === 'ACTIVE' || open.state === 'RESTORING') && open.planned_mw != null && open.planned_mw > 0.5 && (
            <div className={cn('shrink-0 rounded-lg px-2.5 py-1.5 text-[11.5px]', open.escalated ? 'bg-amber-50 text-amber-900' : 'bg-slate-50 text-slate-700')}>
              Relief <b className="font-mono">{fmtMW(open.measured_mw ?? 0)}</b> metered of <span className="font-mono">{fmtMW(open.planned_mw)}</span> planned (
              {(((open.measured_mw ?? 0) / open.planned_mw) * 100).toFixed(0)}%) — the residual is re-estimated from metering
              {open.escalated && ', escalated'}.
            </div>
          )}
          {open.selection && open.selection.some((s) => s.action === 'picked') && (
            <div className="shrink-0 space-y-0.5 text-[11px]">
              {open.selection
                .filter((s) => s.action === 'picked')
                .slice(0, 3)
                .map((s) => (
                  <div key={s.group} className="truncate" title={s.reason}>
                    <span className="mr-1 rounded bg-rose-100 px-1 text-[9px] font-bold text-rose-700 uppercase">picked</span>
                    <b className="font-medium">{s.name}</b> <span className="text-slate-500">— {s.reason}</span>
                  </div>
                ))}
              {open.selection.some((s) => s.action === 'excluded') && (
                <div
                  className="truncate text-slate-500"
                  title={open.selection
                    .filter((s) => s.action === 'excluded')
                    .map((s) => `${s.name}: ${s.reason}`)
                    .join('\n')}
                >
                  <span className="mr-1 rounded bg-slate-200 px-1 text-[9px] font-bold text-slate-600 uppercase">excluded</span>
                  {open.selection.filter((s) => s.action === 'excluded').length} group(s) — daily limit or resting (hover for each reason)
                </div>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1">
            <FitPager
              items={[...open.log].reverse()}
              rowHeight={22}
              reserve={30}
              render={(slice) => (
                <ol className="space-y-0.5">
                  {slice.map((e, i) => (
                    <li key={i} className="flex gap-2 text-[11px]" title={e.msg}>
                      <span className="w-14 shrink-0 font-mono text-slate-400">{e.t ? clockS(e.t) : ''}</span>
                      <span
                        className={cn(
                          'w-16 shrink-0 font-semibold capitalize',
                          e.kind === 'rotated' ? 'text-violet-700' : e.kind === 'restored' ? 'text-emerald-700' : e.kind === 'exhausted' ? 'text-rose-700' : 'text-slate-600',
                        )}
                      >
                        {e.kind}
                      </span>
                      <span className="truncate text-slate-700">{e.msg}</span>
                    </li>
                  ))}
                </ol>
              )}
            />
          </div>
        </>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2 rounded-lg bg-emerald-50/80 px-2.5 py-2 text-[12px] text-emerald-800">
            <ShieldCheck className="size-4 shrink-0" /> No load rotation. The platform proposes an order only when paid flexibility cannot cover the over-drawal.
          </div>
          {can('shed_propose') && (
            <div className="flex shrink-0 items-center gap-2">
              <Input type="number" value={mw} onChange={(e) => setMw(Number(e.target.value))} className="h-7 w-24 bg-white/80 text-xs" aria-label="MW to rotate" />
              <span className="text-[11px] text-slate-500">MW</span>
              <Input placeholder="Reason (e.g. RLDC instruction)" value={reason} onChange={(e) => setReason(e.target.value)} className="h-7 bg-white/80 text-xs" />
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 bg-white/70"
                disabled={busy || mw <= 0 || reason.trim().length < 3}
                onClick={() => act('/shedding/orders', { mw, reason })}
              >
                <Zap className="size-3.5" /> Propose
              </Button>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {history.length === 0 ? (
              <Empty>No load-rotation orders yet.</Empty>
            ) : (
              <FitPager
                items={history}
                rowHeight={40}
                reserve={30}
                render={(slice) => (
                  <div className="space-y-1">
                    {slice.map((o) => (
                      <div key={o.id} className="rounded-md bg-white/60 px-2 py-1 text-[11px] ring-1 ring-slate-900/[0.06]">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-slate-500">{o.id}</span>
                          <Badge className={cn('h-4 px-1.5 text-[9px]', STATE_STYLE[o.state])}>{o.state}</Badge>
                          <span className="ml-auto font-mono">{fmtMW(o.mw)}</span>
                        </div>
                        <div className="truncate text-slate-500">
                          {o.closed_reason || o.reason} · {(o.shed_minutes_mw / 60).toFixed(1)} MWh not served · {o.rotations} rotation(s)
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              />
            )}
          </div>
        </>
      )}
      {err && <div className="shrink-0 text-[11px] text-rose-600">{err}</div>}
    </Panel>
  )
}
