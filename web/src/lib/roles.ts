// SLDC / DR roles as the API defines them (backend ksfp/security/auth.py ROLES). Labels and one-line duties for the
// sign-in role picker and user administration; the permissions themselves are always read from the server.
import { BadgeIndianRupee, Briefcase, Eye, Headset, ShieldCheck, UserCog, type LucideIcon } from 'lucide-react'

export interface RoleInfo {
  role: string
  label: string
  desc: string
  icon: LucideIcon
}

export const ROLE_INFO: RoleInfo[] = [
  { role: 'operator', label: 'SLDC Operator', desc: 'Watch the grid, acknowledge alarms, approve, reject or abort DR events, propose load rotation', icon: Headset },
  { role: 'shift_in_charge', label: 'Shift In-charge', desc: 'Operator + dual authorisation, load rotation approval, autonomy and kill switch, drills', icon: ShieldCheck },
  { role: 'dr_manager', label: 'DR Programme Manager', desc: 'Programmes, participants and C&I offers, what-if, simulator, reports', icon: Briefcase },
  { role: 'settlement_officer', label: 'Settlement Officer', desc: 'Baseline M&V, payments and dispute resolution', icon: BadgeIndianRupee },
  { role: 'auditor', label: 'Auditor', desc: 'Read-only: every page, reports and audit-chain verification', icon: Eye },
  { role: 'admin', label: 'Administrator', desc: 'All permissions, including users, configuration and safety envelope', icon: UserCog },
]

export const ROLE_BY_ID = Object.fromEntries(ROLE_INFO.map((r) => [r.role, r])) as Record<string, RoleInfo>
