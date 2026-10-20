// Pages grouped by the SLDC workflow (operate → plan → settle → system) and the permissions that show each one.
import { Bell, FlaskConical, LayoutDashboard, LineChart, Network, Power, Receipt, Settings2, Siren, Users, Zap, type LucideIcon } from 'lucide-react'
import type { Page } from '@/store/useUI'

export interface NavItem {
  id: Page
  label: string
  icon: LucideIcon
  /** any one of these permissions shows the page; none = everyone who can sign in */
  perms?: string[]
}

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Operate',
    items: [
      { id: 'command', label: 'Overview', icon: LayoutDashboard },
      { id: 'decisions', label: 'DR Events', icon: Zap },
      { id: 'operations', label: 'Grid', icon: Network },
      { id: 'shedding', label: 'Load Rotation', icon: Power },
      { id: 'alarms', label: 'Alarms', icon: Bell },
    ],
  },
  {
    group: 'Plan',
    items: [
      { id: 'resources', label: 'Programmes', icon: Users },
      { id: 'analysis', label: 'Forecast', icon: LineChart },
      { id: 'whatif', label: 'What-if sandbox', icon: FlaskConical, perms: ['whatif'] },
      { id: 'simulator', label: 'Grid simulator', icon: Siren },
    ],
  },
  { group: 'Settle', items: [{ id: 'reports', label: 'Settlement & Audit', icon: Receipt, perms: ['reports'] }] },
  { group: 'System', items: [{ id: 'admin', label: 'Administration', icon: Settings2, perms: ['users', 'config', 'autonomy'] }] },
]

export const NAV_ITEM = Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.id, { ...i, group: g.group }]))) as Record<Page, NavItem & { group: string }>

export const canSee = (page: Page, can: (p: string) => boolean) => !NAV_ITEM[page]?.perms || NAV_ITEM[page].perms!.some(can)

/** A role that can look at everything and change nothing. */
export const readOnly = (perms: string[] | undefined) => !!perms && perms.every((p) => ['view', 'reports', 'audit'].includes(p))

