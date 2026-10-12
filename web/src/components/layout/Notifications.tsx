// Notification inbox (top bar bell) and toast stack (bottom-right) for DR moments that need the operator.
import { useState } from 'react'
import { AlertOctagon, Bell, CheckCircle2, Check, Loader2, Power, Send, X, XCircle, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/useAuth'
import { useNotify, type Notice } from '@/store/useNotify'
import { useUI } from '@/store/useUI'

const ICON = { event: Zap, approval: Bell, dispatch: Send, failure: XCircle, settled: CheckCircle2, closed: XCircle, alarm: AlertOctagon, shed: Power }
const TONE = {
  info: 'bg-sky-100 text-sky-700',
  warn: 'bg-amber-100 text-amber-700',
  bad: 'bg-rose-100 text-rose-700',
  good: 'bg-emerald-100 text-emerald-700',
}

function ago(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}

function NoticeRow({ x, onOpen }: { x: Notice; onOpen: () => void }) {
  const Icon = ICON[x.kind]
  return (
    <button onClick={onOpen} className={cn('flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-slate-50', !x.read && 'bg-sky-50/50')}>
      <span className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-full', TONE[x.tone])}>
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-semibold text-slate-800">{x.title}</span>
          {!x.read && <span className="size-1.5 shrink-0 rounded-full bg-sky-500" />}
          <span className="ml-auto shrink-0 text-[10px] text-slate-400">{ago(x.ts)}</span>
        </span>
        <span className="line-clamp-2 text-[11px] text-slate-500">{x.body}</span>
      </span>
    </button>
  )
}

export function NotificationBell() {
  const items = useNotify((s) => s.items)
  const markAllRead = useNotify((s) => s.markAllRead)
  const markRead = useNotify((s) => s.markRead)
  const go = useUI((s) => s.go)
  const unread = items.filter((x) => !x.read).length
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="relative grid size-8 place-items-center rounded-full text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-50" aria-label="Notifications">
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white tabular-nums">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-[13px] font-semibold">Notifications</span>
          {unread > 0 && (
            <button className="text-[11px] text-sky-700 hover:underline" onClick={markAllRead}>
              Mark all read
            </button>
          )}
        </div>
        <div className="max-h-[420px] overflow-y-auto p-1">
          {items.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-slate-500">No notifications yet. New DR events, approvals, dispatch failures and settlements appear here.</div>
          ) : (
            items.slice(0, 30).map((x) => (
              <NoticeRow
                key={x.id}
                x={x}
                onOpen={() => {
                  markRead(x.id)
                  if (x.shedId) go('shedding')
                  else go(x.decisionId ? 'decisions' : 'alarms', x.decisionId)
                }}
              />
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Toaster() {
  const toasts = useNotify((s) => s.toasts)
  // on the map workspace the bottom-right belongs to the Intent panel (with its own Approve), so toasts drop in at the top centre
  const overview = useUI((s) => s.page === 'command')
  return (
    <div className={cn('pointer-events-none fixed z-50 flex w-[380px] flex-col gap-2', overview ? 'top-[172px] left-1/2 -translate-x-1/2' : 'right-4 bottom-4')}>
      {toasts.map((t) => (
        <Toast key={t.id} t={t} />
      ))}
    </div>
  )
}

function Toast({ t }: { t: Notice }) {
  const dismiss = useNotify((s) => s.dismiss)
  const go = useUI((s) => s.go)
  const can = useAuth((s) => s.can)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const Icon = ICON[t.kind]
  async function approve() {
    setBusy(true)
    setErr(null)
    try {
      await api(`/decisions/${t.decisionId}/approve`, { method: 'POST' })
      dismiss(t.id)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex gap-3 rounded-xl border bg-white p-3 shadow-lg ring-1 ring-black/5 animate-in fade-in slide-in-from-bottom-2 duration-300',
        t.tone === 'warn' && 'border-l-4 border-l-amber-400',
        t.tone === 'bad' && 'border-l-4 border-l-rose-400',
        t.tone === 'good' && 'border-l-4 border-l-emerald-400',
      )}
    >
      <span className={cn('grid size-8 shrink-0 place-items-center rounded-full', TONE[t.tone])}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-slate-800">{t.title}</div>
        <div className="text-[12px] text-slate-600">{t.body}</div>
        {err && <div className="mt-1 text-[11px] text-rose-600">{err}</div>}
        {t.shedId && (
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant={t.tone === 'bad' ? 'destructive' : 'outline'}
              className="h-7"
              onClick={() => {
                go('shedding')
                dismiss(t.id)
              }}
            >
              <Power className="size-3.5" /> {t.title.startsWith('Load rotation proposed') ? 'Review & approve' : 'Open roster'}
            </Button>
          </div>
        )}
        {t.decisionId && (
          <div className="mt-2 flex gap-2">
            {t.kind === 'approval' && can('approve') && (
              <Button size="sm" className="h-7" disabled={busy} onClick={approve}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Approve
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => {
                go('decisions', t.decisionId)
                dismiss(t.id)
              }}
            >
              {t.kind === 'approval' ? 'Review' : 'Open event'}
            </Button>
          </div>
        )}
      </div>
      <button className="h-fit rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" onClick={() => dismiss(t.id)} aria-label="Dismiss">
        <X className="size-4" />
      </button>
    </div>
  )
}
