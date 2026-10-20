// Primary navigation: pages grouped by the SLDC workflow (operate → plan → settle → system), filtered by the signed-in
// role's permissions. Collapses to an icon rail so the 3D workspace can take the width.
import { useState } from 'react'
import { ChevronsLeft, ChevronsRight, Eye, Users } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { canSee, NAV, readOnly } from '@/lib/nav'
import { ROLE_BY_ID } from '@/lib/roles'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/useAuth'
import { useLive } from '@/store/useLive'
import { useUI, type Page } from '@/store/useUI'

const KEY = 'adrms-nav-collapsed'

export function SideNav() {
  const page = useUI((s) => s.page)
  const go = useUI((s) => s.go)
  const f = useLive((s) => s.frame)
  const can = useAuth((s) => s.can)
  const user = useAuth((s) => s.user)
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const v = localStorage.getItem(KEY)
      if (v) return v === '1'
    } catch {
      /* fall through to the width default */
    }
    // dense pages need the width on laptop screens; wide control-room displays keep the labels
    return window.innerWidth < 1680
  })
  const toggle = () => {
    setCollapsed(!collapsed)
    try {
      localStorage.setItem(KEY, collapsed ? '0' : '1')
    } catch {
      /* per-viewer convenience only */
    }
  }

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
  const role = user ? ROLE_BY_ID[user.role] : undefined
  const RoleIcon = role?.icon ?? Users
  const ro = readOnly(user?.permissions)

  return (
    <aside
      aria-label="Main navigation"
      className={cn('surface-panel flex shrink-0 flex-col py-2 transition-[width] duration-200', collapsed ? 'w-[60px]' : 'w-[212px]')}
    >
      <nav className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2">
        {NAV.map(({ group, items }) => {
          const shown = items.filter((i) => canSee(i.id, can))
          if (!shown.length) return null
          return (
            <div key={group}>
              {collapsed ? <div className="mx-auto mb-1 h-px w-6 bg-slate-200 first:hidden" /> : <div className="eyebrow mb-1 px-2.5">{group}</div>}
              <ul className="space-y-0.5">
                {shown.map(({ id, label, icon: Icon }) => {
                  const on = page === id
                  const c = counts[id]
                  const btn = (
                    <button
                      onClick={() => go(id)}
                      aria-label={collapsed ? label : undefined}
                      aria-current={on ? 'page' : undefined}
                      className={cn(
                        'relative flex h-9 w-full items-center gap-2.5 rounded-xl text-[13px] font-medium transition',
                        collapsed ? 'justify-center px-0' : 'px-2.5',
                        on ? 'bg-sky-800 text-white shadow-sm shadow-sky-900/20' : 'text-slate-600 hover:bg-sky-50 hover:text-sky-800',
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
                      {c && (
                        <span
                          className={cn(
                            'rounded-full px-1.5 text-[10px] font-bold tabular-nums',
                            c.tone,
                            collapsed && 'absolute -top-0.5 -right-0.5 min-w-4 px-1 text-[9px] leading-4',
                          )}
                        >
                          {c.n}
                        </span>
                      )}
                    </button>
                  )
                  return (
                    <li key={id}>
                      {collapsed ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{btn}</TooltipTrigger>
                          <TooltipContent side="right">{label}</TooltipContent>
                        </Tooltip>
                      ) : (
                        btn
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </nav>

      {/* who is signed in and what that role may do */}
      <div className={cn('mt-2 shrink-0 border-t border-slate-900/[0.06] px-2 pt-2', collapsed && 'w-full')}>
        {!collapsed && (
          <div className="mb-1.5 flex items-center gap-2 rounded-xl bg-sky-50/80 px-2.5 py-2 ring-1 ring-sky-100">
            <RoleIcon className="size-4 shrink-0 text-sky-700" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[12px] font-semibold text-sky-900">{user?.role_label}</div>
              <div className="truncate text-[10px] text-slate-500">{ro ? 'Read-only access' : `${user?.permissions.length ?? 0} permissions`}</div>
            </div>
            {ro && <Eye className="ml-auto size-3.5 shrink-0 text-slate-400" />}
          </div>
        )}
        <button
          onClick={toggle}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-[11px] text-slate-500 transition hover:bg-slate-900/[0.04] hover:text-slate-800"
        >
          {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
          {!collapsed && 'Collapse'}
        </button>
      </div>
    </aside>
  )
}
