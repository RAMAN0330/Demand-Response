// Top bar: brand, page tabs grouped by workflow (Operate · Plan · Settlement; Administration behind the gear),
// and a compact status cluster that only spells out numbers when something needs attention.
import { useState } from 'react'
import {
  Activity,
  Bot,
  ChevronDown,
  Eye,
  LogOut,
  PauseCircle,
  PlayCircle,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  UserCog,
  Wifi,
  WifiOff,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { NotificationBell } from './Notifications'
import { AdrmsBrand } from '@/components/brand/AdrmsMark'
import { AccountDialog } from '@/components/auth/AccountDialog'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/useAuth'
import { useLive } from '@/store/useLive'
import { useUI, type Page } from '@/store/useUI'
import { canSee, NAV, readOnly } from '@/lib/nav'

const LEVELS = ['Monitor', 'Advisory', 'Supervised', 'Autonomous']
const fmtAge = (s: number | null | undefined) => (s == null ? 'never' : s < 60 ? `${s.toFixed(0)} s` : s < 3600 ? `${(s / 60).toFixed(0)} min` : `${(s / 3600).toFixed(1)} h`)

type Count = { n: number; tone: string } | null
const TAB = 'relative flex h-full items-center gap-1.5 px-3 text-[13px] font-medium whitespace-nowrap text-slate-500 transition hover:text-slate-900'
const TAB_ON = 'text-sky-800 after:absolute after:inset-x-3 after:bottom-0 after:h-[3px] after:rounded-t-full after:bg-sky-600'

function Tab({ id, label, on, count, onClick }: { id: Page; label: string; on: boolean; count?: Count; onClick: () => void }) {
  return (
    <button key={id} onClick={onClick} aria-current={on ? 'page' : undefined} className={cn(TAB, on && TAB_ON)}>
      {label}
      {count && <span className={cn('rounded-full px-1.5 text-[10px] font-bold tabular-nums', count.tone)}>{count.n}</span>}
    </button>
  )
}

export function TopNav() {
  const page = useUI((s) => s.page)
  const go = useUI((s) => s.go)
  const f = useLive((s) => s.frame)
  const conn = useLive((s) => s.conn)
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)
  const can = useAuth((s) => s.can)
  const [suspendOpen, setSuspendOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const counts: Partial<Record<Page, Count>> = {
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

  const age = f?.data_age
  const vetoes = f?.autonomy.vetoes ?? []
  // worst age among the inputs that gate control (a green pill must never imply fresh data)
  const oldest = age ? Math.max(...[age.frequency, age.schedule, age.breakers, age.sldc].filter((x): x is number => x != null), 0) : null
  const stale = oldest != null && oldest > 10
  const sevDot = { NORMAL: 'bg-emerald-500', ALERT: 'bg-amber-500', EMERGENCY: 'animate-pulse bg-rose-500' } as const
  return (
    <header className="surface-panel relative z-30 mx-3 mt-2.5 flex h-13 shrink-0 items-stretch gap-3 px-3 text-slate-800">
      {/* hairline highlight along the bottom edge */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-sky-400/50 to-transparent" />
      <button onClick={() => go('command')} className="flex items-center pr-3" aria-label="ADRMS — home">
        <AdrmsBrand />
      </button>
      <div className="my-3 w-px bg-slate-200" />

      {/* pages grouped by workflow: Operate as tabs, Plan in one menu, Settlement as a tab; Administration is the gear on the right */}
      <nav className="flex min-w-0 items-stretch" aria-label="Main navigation">
        {NAV.filter((g) => g.group !== 'System').map(({ group, items }) => {
          const shown = items.filter((i) => canSee(i.id, can))
          if (!shown.length) return null
          if (group !== 'Plan') return shown.map((i) => <Tab key={i.id} id={i.id} label={i.label} on={page === i.id} count={counts[i.id]} onClick={() => go(i.id)} />)
          const cur = shown.find((i) => i.id === page)
          return (
            <DropdownMenu key={group}>
              <DropdownMenuTrigger asChild>
                <button className={cn(TAB, 'gap-1', cur && TAB_ON)}>
                  {cur?.label ?? group} <ChevronDown className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                {shown.map(({ id, label, icon: Icon }) => (
                  <DropdownMenuItem key={id} onClick={() => go(id)}>
                    <Icon /> {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        })}
      </nav>

      {/* live event + system status — qualifies everything on screen */}
      <div className="ml-auto flex items-center gap-2">
        {f && (
          <>

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
                    <div className="px-2 py-1.5 text-[11px] text-muted-foreground">Suspend/resume requires the Shift In-charge.</div>
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
                    <ShieldAlert className="size-3" />
                    {/* healthy data is just the green shield; numbers appear only when something is off */}
                    {(vetoes.length > 0 || f.confidence < 0.97 || stale) && <>{(f.confidence * 100).toFixed(0)}%</>}
                    {stale && <span className="font-mono text-[10px] opacity-80">· {fmtAge(oldest)}</span>}
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
                <span className="font-mono text-[13px] font-semibold whitespace-nowrap tabular-nums">{f.clock}</span>
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
        {readOnly(user?.permissions) && (
          <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 ring-1 ring-slate-200">
            <Eye className="size-3" /> Read-only
          </span>
        )}
        {canSee('admin', can) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => go('admin')}
                aria-label="Administration"
                className={cn('grid size-8 place-items-center rounded-full text-slate-500 transition hover:bg-sky-50 hover:text-sky-800', page === 'admin' && 'bg-sky-100 text-sky-800')}
              >
                <Settings2 className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Administration</TooltipContent>
          </Tooltip>
        )}
        <NotificationBell />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center rounded-full p-0.5 ring-1 ring-slate-200 transition hover:bg-slate-50">
              <span className="relative grid size-7 place-items-center rounded-full bg-gradient-to-br from-sky-500 to-sky-700 text-[11px] font-bold text-white uppercase">
                {user?.username.slice(0, 2)}
                {user && !user.mfa_enabled && (
                  <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-amber-400 ring-2 ring-white" title="Two-factor sign-in is off" />
                )}
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="leading-tight">
              <span className="block">{user?.display}</span>
              <span className="block text-[11px] font-normal text-muted-foreground">
                {user?.username} · {user?.role_label}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setAccountOpen(true)}>
              <UserCog /> Account &amp; security
              {user && !user.mfa_enabled && <span className="ml-auto rounded bg-amber-100 px-1.5 text-[10px] font-medium text-amber-800">2FA off</span>}
              {user?.mfa_enabled && <ShieldCheck className="ml-auto text-emerald-600" />}
            </DropdownMenuItem>
            {can('users') && (
              <DropdownMenuItem onClick={() => go('admin')}>
                <Users /> Manage users
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => logout()}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AccountDialog open={accountOpen} onOpenChange={setAccountOpen} />
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
