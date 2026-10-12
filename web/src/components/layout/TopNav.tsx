// Primary navigation (operator destinations), live event chip, and the system-status cluster.
import { useState } from 'react'
import {
  Activity,
  Bell,
  Bot,
  ChevronDown,
  FlaskConical,
  LayoutDashboard,
  LineChart,
  LogOut,
  Network,
  PauseCircle,
  PlayCircle,
  Power,
  Receipt,
  Settings2,
  ShieldAlert,
  Wifi,
  WifiOff,
  Users,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { NotificationBell } from './Notifications'
import { AdrmsBrand } from '@/components/brand/AdrmsMark'
import { fmtMW } from '@/lib/geo'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/useAuth'
import { useLive } from '@/store/useLive'
import { useUI, type Page } from '@/store/useUI'

const LEVELS = ['Monitor', 'Advisory', 'Supervised', 'Autonomous']
const fmtAge = (s: number | null | undefined) => (s == null ? 'never' : s < 60 ? `${s.toFixed(0)} s` : s < 3600 ? `${(s / 60).toFixed(0)} min` : `${(s / 3600).toFixed(1)} h`)

// DR operator workflow: overview → events (act) → programs (capacity) → grid & forecast (context) → alarms
const PRIMARY: { id: Page; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'command', label: 'Overview', icon: LayoutDashboard },
  { id: 'decisions', label: 'DR Events', icon: Zap },
  { id: 'resources', label: 'Programs', icon: Users },
  { id: 'operations', label: 'Grid', icon: Network },
  { id: 'shedding', label: 'Load Rotation', icon: Power },
  { id: 'analysis', label: 'Forecast', icon: LineChart },
  { id: 'alarms', label: 'Alarms', icon: Bell },
]

const MORE: { id: Page; label: string; hint: string; icon: typeof LayoutDashboard; perm?: string }[] = [
  { id: 'whatif', label: 'What-if sandbox', hint: 'Test a DR event before it happens — no dispatch', icon: FlaskConical, perm: 'whatif' },
  { id: 'reports', label: 'Settlement & Audit', hint: 'Baseline, delivery, payments, audit trail', icon: Receipt },
  { id: 'admin', label: 'Administration', hint: 'Autonomy policy, data sources, simulator, users', icon: Settings2 },
]

export function TopNav() {
  const page = useUI((s) => s.page)
  const go = useUI((s) => s.go)
  const f = useLive((s) => s.frame)
  const conn = useLive((s) => s.conn)
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)
  const can = useAuth((s) => s.can)
  const [suspendOpen, setSuspendOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const counts: Partial<Record<Page, { n: number; tone: string } | null>> = {
    decisions: f?.counts.awaiting
      ? { n: f.counts.awaiting, tone: 'bg-amber-500 text-white' }
      : f?.counts.decisions_open
        ? { n: f.counts.decisions_open, tone: 'bg-sky-500 text-white' }
        : null,
    shedding: f?.shedding?.order
      ? { n: f.shedding.groups_out || 1, tone: f.shedding.order.state === 'PROPOSED' ? 'bg-amber-500 text-white' : 'animate-pulse bg-rose-500 text-white' }
      : null,
    alarms: f?.counts.unacked ? { n: f.counts.unacked, tone: f.counts.p1 ? 'bg-rose-500 text-white' : 'bg-amber-500 text-white' } : null,
  }
  const eff = f?.autonomy.effective ?? 0
  const degraded = f && f.autonomy.effective < f.autonomy.level

  async function suspend() {
    setBusy(true)
    try {
      await api('/autonomy/suspend', { method: 'POST', body: { reason } })
      setSuspendOpen(false)
      setReason('')
    } finally {
      setBusy(false)
    }
  }

  const ev = f?.active_decision && !f.active_decision.closed_at ? f.active_decision : null
  const age = f?.data_age
  const vetoes = f?.autonomy.vetoes ?? []
  // worst age among the inputs that gate control (a green pill must never imply fresh data)
  const oldest = age ? Math.max(...[age.frequency, age.schedule, age.breakers, age.sldc].filter((x): x is number => x != null), 0) : null
  const stale = oldest != null && oldest > 10
  const sevDot = { NORMAL: 'bg-emerald-500', ALERT: 'bg-amber-500', EMERGENCY: 'animate-pulse bg-rose-500' } as const
  const tab = 'relative flex h-full items-center gap-1.5 px-2 text-[13px] 2xl:px-2.5 font-medium whitespace-nowrap text-slate-500 transition hover:text-slate-900'
  const on = 'text-sky-700 after:absolute after:inset-x-2 after:bottom-0 after:h-[3px] after:rounded-t-full after:bg-sky-600'

  return (
    <header className="relative flex h-13 shrink-0 items-stretch gap-3 border-b border-slate-200/80 bg-white/90 px-3 text-slate-800 shadow-[0_6px_20px_-14px_rgba(23,47,78,0.35)] backdrop-blur">
      {/* hairline highlight along the bottom edge */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-sky-400/50 to-transparent" />
      <button onClick={() => go('command')} className="flex items-center pr-3" aria-label="ADRMS — home">
        <AdrmsBrand />
      </button>
      <div className="my-3 w-px bg-slate-200" />

      <nav className="flex items-stretch">
        {PRIMARY.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => go(id)} className={cn(tab, page === id && on)}>
            <Icon className="size-4 max-[1799px]:hidden" />
            {label}
            {counts[id] && <span className={cn('ml-0.5 rounded-full px-1.5 text-[10px] font-bold tabular-nums', counts[id]!.tone)}>{counts[id]!.n}</span>}
          </button>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className={cn(tab, 'gap-1', MORE.some((m) => m.id === page) && on)}>
              {MORE.find((m) => m.id === page)?.label ?? 'More'} <ChevronDown className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {MORE.filter((m) => !m.perm || can(m.perm)).map(({ id, label, hint, icon: Icon }) => (
              <DropdownMenuItem key={id} onClick={() => go(id)} className="items-start">
                <Icon className="mt-0.5" />
                <span>
                  <span className="block font-medium">{label}</span>
                  <span className="block text-[11px] text-muted-foreground">{hint}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>

      {/* live event + system status — qualifies everything on screen */}
      <div className="ml-auto flex items-center gap-2">
        {f && (
          <>
            {ev && (
              <button
                onClick={() => go('decisions')}
                className="flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap text-amber-800 ring-1 ring-amber-300 transition hover:bg-amber-100"
              >
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-70" />
                  <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
                </span>
                <span className="hidden min-[2100px]:inline">{ev.id} · </span>
                {ev.direction === 'UP' ? '↓' : '↑'}
                <span className="hidden 2xl:inline">load</span> {fmtMW(ev.requirement_mw)}
                {ev.awaiting_mw > 0 && <span className="rounded bg-amber-500 px-1 text-[9px] text-white">APPROVE</span>}
              </button>
            )}

            <div className="flex items-center rounded-full bg-slate-50 p-0.5 ring-1 ring-slate-200">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1.5 px-2 text-[11px] font-bold tracking-wide">
                    <span className={cn('size-2 rounded-full', sevDot[f.severity])} />
                    {f.severity}
                  </span>
                </TooltipTrigger>
                <TooltipContent>Grid severity from frequency, ACE and line loading</TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className={cn(
                      'flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap transition',
                      f.autonomy.suspended
                        ? 'bg-rose-500 text-white'
                        : degraded
                          ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-300'
                          : 'bg-white text-sky-700 shadow-sm ring-1 ring-sky-200 hover:bg-sky-50',
                    )}
                  >
                    <Bot className="size-3.5" />
                    {f.autonomy.suspended ? (
                      <>
                        <span className="hidden 2xl:inline">Autonomy</span> suspended
                      </>
                    ) : (
                      <>
                        L{eff}
                        <span className="hidden 2xl:inline">{LEVELS[eff]}</span>
                      </>
                    )}
                    {degraded && !f.autonomy.suspended && <span className="text-[9px] font-bold opacity-80">↓ from L{f.autonomy.level}</span>}
                    <ChevronDown className="size-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-80">
                  <DropdownMenuLabel>
                    Configured L{f.autonomy.level} {LEVELS[f.autonomy.level]} · effective L{eff}
                  </DropdownMenuLabel>
                  {f.autonomy.reasons.map((r) => (
                    <div key={r} className="px-2 pb-1 text-[11px] text-amber-700">
                      {r}
                    </div>
                  ))}
                  <DropdownMenuSeparator />
                  {can('autonomy') ? (
                    f.autonomy.suspended ? (
                      <DropdownMenuItem onClick={() => api('/autonomy/resume', { method: 'POST' })}>
                        <PlayCircle /> Resume autonomy
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => setSuspendOpen(true)} className="text-rose-700">
                        <PauseCircle /> Suspend autonomy (kill switch)…
                      </DropdownMenuItem>
                    )
                  ) : (
                    <div className="px-2 py-1.5 text-[11px] text-muted-foreground">Suspend/resume requires Shift-in-Charge.</div>
                  )}
                  <DropdownMenuItem onClick={() => go('admin')}>
                    <Settings2 /> Autonomy policy…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      'flex items-center gap-1 px-2 text-[11px] font-medium whitespace-nowrap',
                      vetoes.length || f.confidence < 0.85 ? 'text-rose-600' : f.confidence < 0.97 || stale ? 'text-amber-700' : 'text-emerald-700',
                    )}
                  >
                    <ShieldAlert className="size-3" /> {(f.confidence * 100).toFixed(0)}%
                    {oldest != null && oldest > 10 && <span className="font-mono text-[10px] opacity-80">· {fmtAge(oldest)}</span>}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm">
                  <div className="font-semibold">Data confidence & freshness</div>
                  <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-[11px]">
                    <span>Frequency</span>
                    <span>{fmtAge(age?.frequency)}</span>
                    <span>Schedule</span>
                    <span>{fmtAge(age?.schedule)}</span>
                    <span>Breakers</span>
                    <span>{fmtAge(age?.breakers)}</span>
                    {age?.sldc != null && (
                      <>
                        <span>SLDC web</span>
                        <span>{fmtAge(age.sldc)}</span>
                      </>
                    )}
                  </div>
                  <div className="mt-1">Ages are from the source timestamp. Confidence below 85% or any veto keeps autonomy advisory.</div>
                  {vetoes.map((v) => (
                    <div key={v} className="mt-1 text-rose-200">
                      ⛔ {v}
                    </div>
                  ))}
                </TooltipContent>
              </Tooltip>
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <div className="w-[78px] leading-tight whitespace-nowrap">
                  <div>
                    <span className="font-mono text-[13px] font-semibold tabular-nums">{f.clock}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-200">
                      <div className="h-full rounded-full bg-sky-500" style={{ width: `${(f.block / 96) * 100}%` }} />
                    </div>
                    <span className="font-mono text-[9px] text-slate-400 tabular-nums">B{f.block}</span>
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                Time block {f.block} of 96 (15-min DSM blocks){f.time_scale !== 1 && ` · simulated clock ×${f.time_scale}`}
              </TooltipContent>
            </Tooltip>
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'grid size-7 place-items-center rounded-full',
                conn === 'live' && 'max-2xl:hidden', // only worth the space on narrow screens when the stream is not live
                conn === 'live' ? 'text-emerald-600' : conn === 'offline' ? 'text-rose-600' : 'animate-pulse text-amber-600',
              )}
            >
              {conn === 'live' ? <Wifi className="size-4" /> : conn === 'offline' ? <WifiOff className="size-4" /> : <Activity className="size-4" />}
            </span>
          </TooltipTrigger>
          <TooltipContent>Real-time stream: {conn}</TooltipContent>
        </Tooltip>
        <NotificationBell />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 rounded-full py-0.5 pr-2 pl-0.5 ring-1 ring-slate-200 transition hover:bg-slate-50">
              <span className="grid size-7 place-items-center rounded-full bg-gradient-to-br from-sky-500 to-sky-700 text-[11px] font-bold text-white uppercase">
                {user?.username.slice(0, 2)}
              </span>
              <span className="hidden text-left leading-tight 2xl:block">
                <span className="block text-[12px] font-medium">{user?.username}</span>
                <span className="block text-[10px] text-muted-foreground">{user?.role_label}</span>
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{user?.display}</DropdownMenuLabel>
            <div className="px-2 pb-1.5 text-[11px] text-muted-foreground">{user?.permissions.join(' · ')}</div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => logout()}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={suspendOpen} onOpenChange={setSuspendOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Suspend autonomy</DialogTitle>
            <DialogDescription>
              New automatic actions stop immediately; every decision will require approval. Commands already executing continue unless you abort their decision. This is audited.
            </DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSuspendOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={reason.trim().length < 3 || busy} onClick={suspend}>
              <PauseCircle className="size-4" /> Suspend
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  )
}
