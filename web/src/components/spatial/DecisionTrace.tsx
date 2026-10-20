// Decision trace: what the system decided for the live DR event and how each participant is responding right now.
// Lifecycle stepper (detect → … → settle), the "why" in one line each, and per-participant setpoint vs metered MW,
// grouped by dispatch tier (BESS → C&I Demand Response → others). Clicking a participant flies the 3D map to it.
import { CircleDot, Factory, Lightbulb, Rocket, Telescope } from 'lucide-react'
import { Empty } from '@/components/page'
import { STATUS_COLOR, type FocusStatus } from '@/components/three/focus'
import { ASSET_BY_ID } from '@/data/topology'
import { fmtMW } from '@/lib/geo'
import { PHASE_SHORT, PHASES, PROGRAMS } from '@/lib/dr'
import { cn } from '@/lib/utils'
import { useLive } from '@/store/useLive'
import { useUI } from '@/store/useUI'
import type { Playback } from './useEventPlayback'

const TIER: Record<string, number> = { bess: 1, industrial: 2 }
const STATUS_LABEL: Record<FocusStatus, string> = {
  planned: 'planned',
  sent: 'command sent',
  acked: 'acknowledged',
  delivering: 'delivering',
  failed: 'no response',
  excluded: 'excluded',
}

export function DecisionTrace({ pb }: { pb: Playback }) {
  const frame = useLive((s) => s.frame)
  const select = useUI((s) => s.select)
  const selected = useUI((s) => s.selection)
  const ad = frame?.active_decision
  if (!frame || !ad)
    return (
      <Empty icon={<Telescope className="size-6 text-sky-400" />}>
        No DR event yet. Inject a drill (for example a 500 MW demand surge) and watch the system detect the need, plan the cheapest mix and dispatch it
        here and on the map.
      </Empty>
    )

  const phase = ad.phase ?? 'DETECTED'
  const at = PHASES.indexOf(phase)
  const n = pb.detail?.narrative as Record<string, string> | undefined
  const rows = Object.entries(pb.overlay.focus ?? {})
    .map(([id, f]) => ({ id, ...f, a: ASSET_BY_ID[id], live: frame.assets[id]?.mw ?? 0 }))
    .filter((r) => r.a)
    .sort((x, y) => (TIER[x.a.type] ?? 3) - (TIER[y.a.type] ?? 3) || y.mw - x.mw)
  const groups = PROGRAMS.map((p) => ({ ...p, rows: rows.filter((r) => r.a.type === p.type) }))
    .filter((g) => g.rows.length)
    .sort((x, y) => (TIER[x.type] ?? 3) - (TIER[y.type] ?? 3))
  const covered = ad.requirement_mw > 0 ? Math.min(1, ad.delivered_mw / ad.requirement_mw) : 0

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5">
      {/* event and lifecycle */}
      <div className="shrink-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[12px] font-semibold text-slate-800">
            {ad.id} · {ad.direction === 'UP' ? 'reduce load' : 'add load'} {fmtMW(ad.requirement_mw)}
          </span>
          <span className={cn('shrink-0 rounded px-1.5 text-[10px] font-semibold', ad.closed_at ? 'bg-slate-100 text-slate-600' : 'bg-amber-50 text-amber-800')}>
            {ad.closed_at ? 'closed' : ad.state.replace('_', ' ').toLowerCase()}
          </span>
        </div>
        <ol className="mt-2 grid grid-cols-8 gap-0.5" aria-label="Event lifecycle">
          {PHASES.map((p, i) => (
            <li key={p} className="min-w-0 text-center" aria-current={i === at ? 'step' : undefined}>
              <div className={cn('h-1.5 rounded-full', i < at ? 'bg-sky-600' : i === at ? 'animate-pulse bg-amber-500' : 'bg-slate-200')} />
              <div className={cn('mt-1 truncate text-[9px]', i === at ? 'font-semibold text-slate-800' : 'text-slate-400')}>{PHASE_SHORT[p]}</div>
            </li>
          ))}
        </ol>
        {at < 0 && <div className="mt-1 text-[11px] font-semibold text-rose-600">{phase.toLowerCase()}</div>}
      </div>

      {/* need vs planned vs delivered */}
      <div className="grid shrink-0 grid-cols-3 gap-1.5 text-center">
        {[
          ['Need', ad.requirement_mw, 'text-slate-800'],
          ['Planned', ad.planned_mw, 'text-sky-800'],
          ['Delivering', ad.delivered_mw, 'text-emerald-700'],
        ].map(([k, v, c]) => (
          <div key={k as string} className="surface-tile px-1 py-1.5">
            <div className="eyebrow">{k}</div>
            <div className={cn('num text-[15px] font-semibold', c as string)}>{fmtMW(v as number)}</div>
          </div>
        ))}
      </div>
      <div className="h-1.5 shrink-0 overflow-hidden rounded-full bg-slate-100" title={`${(covered * 100).toFixed(0)}% of the need delivered`}>
        <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-700" style={{ width: `${covered * 100}%` }} />
      </div>

      {/* why, in one line each */}
      {n && (
        <ul className="shrink-0 space-y-1 text-[11px] leading-snug text-slate-600">
          {(
            [
              [Lightbulb, 'Decided', n.recommendation],
              [Rocket, 'Action', n.action],
              [CircleDot, 'Outcome', n.outcome],
            ] as const
          ).map(
            ([Icon, k, v]) =>
              v && (
                <li key={k} className="flex gap-1.5" title={v}>
                  <Icon className="mt-0.5 size-3 shrink-0 text-slate-400" />
                  <span className="line-clamp-2">
                    <b className="font-semibold text-slate-700">{k}:</b> {v}
                  </span>
                </li>
              ),
          )}
        </ul>
      )}

      {/* who is doing what */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!groups.length && <div className="py-3 text-center text-[11px] text-slate-500">No participant has a setpoint at the moment.</div>}
        {groups.map((g) => (
          <section key={g.type} className="mb-2">
            <div className="eyebrow mb-1 flex items-center gap-1">
              {g.type === 'industrial' && <Factory className="size-3" />}
              {g.name} · {fmtMW(g.rows.reduce((s, r) => s + r.mw, 0))}
            </div>
            <ul className="space-y-1">
              {g.rows.map((r) => {
                const frac = r.mw > 0 ? Math.min(1, Math.abs(r.live) / r.mw) : 0
                const on = selected?.kind === 'asset' && selected.id === r.id
                return (
                  <li key={r.id}>
                    <button
                      onClick={() => select({ kind: 'asset', id: r.id })}
                      className={cn('w-full rounded-lg px-2 py-1 text-left transition hover:bg-slate-900/[0.04]', on && 'bg-sky-50 ring-1 ring-sky-200')}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="size-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[r.status] }} />
                        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-slate-700">{r.a.name}</span>
                        <span className="num shrink-0 text-[11px] text-slate-600">
                          {Math.abs(r.live).toFixed(0)} / {r.mw.toFixed(0)} MW
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${frac * 100}%`, background: STATUS_COLOR[r.status] }} />
                        </div>
                        <span className="w-20 shrink-0 text-right text-[9.5px] text-slate-500">{STATUS_LABEL[r.status]}</span>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
