// Administration — autonomy policy, data sources (incl. KPTCL SLDC pages), field simulator, DSM rules, users.
import { useState, Fragment } from 'react'
import { Bot, Database, FlaskConical, Gauge, RefreshCw, ScrollText, ShieldCheck, Trash2, UserCheck, Zap } from 'lucide-react'
import { FitPager, SectionTabs } from '@/components/common'
import { Empty, Panel, Stat, StatStrip } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { BUSES, GENERATORS, LINES, lineLabel } from '@/data/topology'
import { useApi } from '@/hooks'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { UsersAdmin } from '@/components/auth/UsersAdmin'
import { useAuth } from '@/store/useAuth'
import { useUI } from '@/store/useUI'
import { clockS, useLive } from '@/store/useLive'

export function AdminPage() {
  return (
    <div className="flex h-full flex-col gap-3">
      <AdminStats />
      <Panel className="min-h-0 flex-1" bodyClass="flex flex-col">
        <SectionTabs
          sections={[
            { id: 'autonomy', label: 'Autonomy policy', content: <AutonomyTab /> },
            { id: 'sources', label: 'Data sources', content: <SourcesTab /> },
            { id: 'sim', label: 'Simulator & drills', content: <SimulatorTab /> },
            { id: 'dsm', label: 'DSM rules', content: <DsmTab /> },
            { id: 'users', label: 'Users & roles', content: <UsersAdmin /> },
          ]}
        />
      </Panel>
    </div>
  )
}

/** Configuration at a glance: what the platform is allowed to do right now, and on what data. */
function AdminStats() {
  const f = useLive((s) => s.frame)
  const { data: pol } = useApi<Policy>('/autonomy', { intervalMs: 5000 })
  const { data: src } = useApi<Source[]>('/admin/sources', { intervalMs: 10000 })
  const { data: dist } = useApi<Dist[]>('/admin/simulator/disturbances', { intervalMs: 5000 })
  const { data: dsm } = useApi<Record<string, unknown>>('/admin/config/dsm', { intervalMs: 30000 })
  const k = src?.find((x) => x.kind === 'kptcl')
  const active = dist?.filter((d) => d.active) ?? []
  const illustrative = String(dsm?.source ?? '')
    .toLowerCase()
    .includes('illustrative')
  const degraded = pol && pol.effective < pol.level
  return (
    <StatStrip>
      <Stat
        icon={<Bot />}
        label="Autonomy in force"
        value={pol ? (pol.suspended ? 'SUSPENDED' : `L${pol.effective} ${LEVELS[pol.effective].name.split(' ')[1]}`) : '—'}
        delta={degraded ? { text: `↓ from L${pol!.level}`, tone: 'warn' } : undefined}
        sub={pol?.suspended ? `by ${pol.suspended_by}` : pol?.reasons.length ? pol.reasons[0] : 'configured level, no degradation'}
        tone={pol?.suspended ? 'bad' : degraded ? 'warn' : 'info'}
      />
      <Stat icon={<UserCheck />} label="Dual authorisation" value={pol ? `> ${pol.dual_auth_mw.toFixed(0)} MW` : '—'} sub="second approver: shift-in-charge" tone="info" />
      <Stat
        icon={<ShieldCheck />}
        label="L2 auto envelope"
        value={pol ? `≤ ${pol.envelope.max_auto_mw.toFixed(0)} MW` : '—'}
        sub={pol ? pol.envelope.auto_types.join(' · ') || 'no types' : undefined}
      />
      <Stat
        icon={<Gauge />}
        label="Data confidence"
        value={f ? `${(f.confidence * 100).toFixed(0)}%` : '—'}
        meter={f?.confidence}
        sub={pol ? `autonomy needs ≥ ${(pol.envelope.min_confidence * 100).toFixed(0)}%` : undefined}
        tone={f && pol && f.confidence < pol.envelope.min_confidence ? 'warn' : 'good'}
      />
      <Stat
        icon={<Database />}
        label="Data sources"
        value={k ? `${k.pages_ok}/${k.pages_total} pages` : 'Simulated field'}
        sub={k ? `${k.channels_live} live 220 kV channels` : 'SCADA/EMS stand-in · advisory only'}
        tone={k ? (k.pages_ok === k.pages_total ? 'good' : 'warn') : undefined}
      />
      <Stat
        icon={<FlaskConical />}
        label="Active drills"
        value={String(active.length)}
        sub={active.length ? active.map((d) => d.label).join(' · ') : `clock ×${f?.time_scale ?? 1}`}
        tone={active.length ? 'warn' : undefined}
      />
      <Stat
        icon={<ScrollText />}
        label="DSM rule table"
        value={!dsm ? '—' : illustrative ? 'Illustrative' : `v ${String(dsm.version ?? '—')}`}
        sub={illustrative ? 'structure only · load the notified table' : `effective ${String(dsm?.effective_from ?? '—')}`}
        tone={illustrative ? 'warn' : 'good'}
      />
    </StatStrip>
  )
}

interface Policy {
  level: number
  level_name: string
  suspended: boolean
  suspended_by: string | null
  suspended_reason: string | null
  dual_auth_mw: number
  version?: number
  envelope: { auto_types: string[]; max_auto_mw: number; min_confidence: number; allowed_severity: string[] }
  effective: number
  reasons: string[]
}

const LEVELS = [
  { n: 0, name: 'L0 Monitor', desc: 'Detect, assess and forecast only. No plans proposed.' },
  { n: 1, name: 'L1 Advisory', desc: 'Plans proposed; every action needs operator approval.' },
  { n: 2, name: 'L2 Supervised', desc: 'Actions inside the envelope execute automatically; the rest need approval.' },
  { n: 3, name: 'L3 Autonomous', desc: 'All actions execute automatically; humans supervise and can abort.' },
]
const TYPES = ['generation', 'bess', 'rtm', 'interruptible', 'shiftable', 'industrial', 'der']

function AutonomyTab() {
  const { data, reload } = useApi<Policy>('/autonomy', { intervalMs: 5000 })
  const can = useAuth((s) => s.can)
  const [edited, setDraft] = useState<Policy | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const draft = edited ?? data
  if (!draft) return <Empty>Loading…</Empty>
  const editable = can('autonomy')
  const envEditable = can('config')
  async function save() {
    try {
      const body: Record<string, unknown> = { level: draft!.level, dual_auth_mw: draft!.dual_auth_mw }
      if (envEditable) body.envelope = draft!.envelope
      await api('/autonomy', { method: 'PUT', body })
      setMsg('Policy saved and audited.')
      setDraft(null)
      reload()
    } catch (e) {
      setMsg((e as Error).message)
    }
  }
  const env = draft.envelope
  const setEnv = (patch: Partial<Policy['envelope']>) => setDraft({ ...draft, envelope: { ...env, ...patch } })
  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
      <div className="flex min-h-0 flex-col gap-3">
        <div className="text-xs text-slate-500">
          Configured <b>L{data?.level}</b> · effective <b>L{data?.effective}</b>
          {data?.reasons.length ? <span className="text-amber-700"> — {data.reasons.join('; ')}</span> : ' — no degradations'}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {LEVELS.map((l) => (
            <button
              key={l.n}
              disabled={!editable}
              onClick={() => setDraft({ ...draft, level: l.n })}
              className={cn(
                'rounded-xl border px-3 py-2 text-left transition hover:bg-slate-50 disabled:cursor-not-allowed',
                draft.level === l.n && 'border-sky-300 bg-sky-50 ring-1 ring-sky-200',
              )}
            >
              <div className="text-sm font-semibold">{l.name}</div>
              <div className="text-[11px] text-slate-500">{l.desc}</div>
            </button>
          ))}
        </div>
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <Label className="text-xs">Dual authorisation above</Label>
            <span className="font-mono">{draft.dual_auth_mw.toFixed(0)} MW</span>
          </div>
          <Slider disabled={!editable} value={[draft.dual_auth_mw]} min={50} max={1000} step={10} onValueChange={([v]) => setDraft({ ...draft, dual_auth_mw: v })} />
          <div className="text-[10px] text-slate-500">Plans whose peak exceeds this need approvals from two different users (one with shift-in-charge authority).</div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!editable} onClick={save}>
            Save policy
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            Revert
          </Button>
          {msg && <span className="text-xs text-slate-500">{msg}</span>}
        </div>
        <PolicyInForce p={draft} />
      </div>
      <div className="flex min-h-0 flex-col gap-3">
        <div className="space-y-4 rounded-2xl border bg-slate-50/50 p-4">
          <div className="text-[13px] font-semibold">
            L2 safety envelope {!envEditable && <span className="text-[11px] font-normal text-slate-500">(requires Administrator)</span>}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Resource types allowed to act without approval</Label>
            <div className="flex flex-wrap gap-1">
              {TYPES.map((t) => {
                const on = env.auto_types.includes(t)
                return (
                  <button
                    key={t}
                    disabled={!envEditable}
                    onClick={() => setEnv({ auto_types: on ? env.auto_types.filter((x) => x !== t) : [...env.auto_types, t] })}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-[11px] disabled:cursor-not-allowed',
                      on ? 'border-sky-300 bg-sky-100 text-sky-800' : 'bg-white text-slate-500',
                    )}
                  >
                    {t}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <Label className="text-xs">Max automatic MW</Label>
              <span className="font-mono">{env.max_auto_mw.toFixed(0)} MW</span>
            </div>
            <Slider disabled={!envEditable} value={[env.max_auto_mw]} min={0} max={1000} step={10} onValueChange={([v]) => setEnv({ max_auto_mw: v })} />
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <Label className="text-xs">Minimum data confidence for autonomy</Label>
              <span className="font-mono">{(env.min_confidence * 100).toFixed(0)}%</span>
            </div>
            <Slider disabled={!envEditable} value={[env.min_confidence]} min={0.5} max={0.99} step={0.01} onValueChange={([v]) => setEnv({ min_confidence: v })} />
            <div className="text-[10px] text-slate-500">Below this, the system automatically degrades to L1 Advisory until data quality recovers.</div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Severities where automatic action is allowed</Label>
            <div className="flex gap-1">
              {['NORMAL', 'ALERT', 'EMERGENCY'].map((s) => {
                const on = env.allowed_severity.includes(s)
                return (
                  <button
                    key={s}
                    disabled={!envEditable}
                    onClick={() => setEnv({ allowed_severity: on ? env.allowed_severity.filter((x) => x !== s) : [...env.allowed_severity, s] })}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-[11px] disabled:cursor-not-allowed',
                      on ? 'border-sky-300 bg-sky-100 text-sky-800' : 'bg-white text-slate-500',
                    )}
                  >
                    {s}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        <AuthorityMatrix />
      </div>
    </div>
  )
}

/** The policy as it will behave, in one paragraph an auditor can read. */
function PolicyInForce({ p }: { p: Policy }) {
  const env = p.envelope
  const lvl = LEVELS[p.level]
  const lines =
    p.level === 0
      ? ['The platform detects, assesses and forecasts only. No DR plans are proposed or dispatched.']
      : p.level === 1
        ? ['Every plan is proposed to the operator; nothing is dispatched without approval.']
        : p.level === 2
          ? [
              `${env.auto_types.length ? env.auto_types.join(', ') : 'No resource types'} may be dispatched automatically up to ${env.max_auto_mw.toFixed(0)} MW, during ${env.allowed_severity.join(' / ').toLowerCase() || 'no'} grid conditions.`,
              'Everything outside that envelope waits for operator approval.',
            ]
          : ['All plans execute automatically; operators supervise and may abort any decision.']
  return (
    <div className="flex-1 rounded-2xl border bg-white/60 p-3 text-[12px] leading-relaxed text-slate-600">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[13px] font-semibold text-slate-800">Policy in force — {lvl.name}</span>
        <span className="text-[10px] text-slate-400">draft shown until saved</span>
      </div>
      <ul className="list-disc space-y-1 pl-4">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
        <li>Plans whose peak exceeds {p.dual_auth_mw.toFixed(0)} MW need two approvers, one with shift-in-charge authority.</li>
        <li>If data confidence falls below {(env.min_confidence * 100).toFixed(0)}% or any hard safety veto is active, autonomy drops to L1 Advisory until data recovers.</li>
        <li>Load rotation is never autonomous: every order needs shift-in-charge approval. UFR and df/dt protection act independently.</li>
      </ul>
    </div>
  )
}

const AUTHORITY: { action: string; perm: string }[] = [
  { action: 'Acknowledge alarms', perm: 'ack_alarm' },
  { action: 'Shelve alarms', perm: 'shelve_alarm' },
  { action: 'Approve DR dispatch', perm: 'approve' },
  { action: 'Second (dual) approval', perm: 'approve_dual' },
  { action: 'Propose load rotation', perm: 'shed_propose' },
  { action: 'Approve load rotation', perm: 'shed' },
  { action: 'Suspend / resume autonomy', perm: 'autonomy' },
  { action: 'Change envelope, DSM table', perm: 'config' },
  { action: 'Manage programmes and C&I offers', perm: 'resources' },
  { action: 'Inject simulator drills', perm: 'simulator' },
  { action: 'Resolve settlement disputes', perm: 'settle' },
  { action: 'Verify the audit chain', perm: 'audit' },
  { action: 'Manage users', perm: 'users' },
]

/** Who may do what: the role permissions the API enforces, read from the server (never hard-coded here). */
function AuthorityMatrix() {
  const can = useAuth((s) => s.can)
  const { data } = useApi<{ role: string; label: string; permissions: string[] }[]>(can('users') ? '/admin/roles' : null)
  return (
    <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border bg-white/60 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[13px] font-semibold">Delegation of authority</span>
        <span className="text-[10px] text-slate-400">enforced by the API on every request</span>
      </div>
      {!data ? (
        <div className="text-[11px] text-slate-500">Visible to administrators.</div>
      ) : (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-slate-500">
              <th className="pb-1 text-left font-medium">Action</th>
              {data.map((r) => (
                <th key={r.role} className="pb-1 text-center font-medium">
                  {r.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AUTHORITY.map((a) => (
              <tr key={a.perm} className="border-t border-slate-900/[0.05]">
                <td className="py-[3px] text-slate-700">{a.action}</td>
                {data.map((r) => (
                  <td key={r.role} className="text-center">
                    {r.permissions.includes(a.perm) ? <span className="text-emerald-600">●</span> : <span className="text-slate-300">·</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

interface PageStatus {
  url: string
  kind: string
  discom: string | null
  ok: boolean
  http_status: number | null
  error: string | null
  fetched_at: number | null
  rows: number
  matched: number
}
interface Source {
  kind: string
  name: string
  role?: string
  status?: string
  points?: number
  quality?: Record<string, number>
  time_scale?: number
  poll_s?: number
  last_cycle?: number | null
  cycles?: number
  pages_ok?: number
  pages_total?: number
  channels_live?: number
  system?: Record<string, number>
  unmapped?: { label: string; mw: number; discom: string | null; kind: string }[]
  pages?: PageStatus[]
}

function SourcesTab() {
  const { data, reload } = useApi<Source[]>('/admin/sources', { intervalMs: 5000 })
  const can = useAuth((s) => s.can)
  const [busy, setBusy] = useState(false)
  const sim = data?.find((s) => s.kind === 'simulated')
  const k = data?.find((s) => s.kind === 'kptcl')
  return (
    <div className="grid h-full grid-cols-[300px_minmax(0,1fr)] gap-4">
      <div className="space-y-3">
        {sim && (
          <div className="rounded-xl border p-3">
            <div className="text-[13px] font-semibold">{sim.name}</div>
            <div className="text-[11px] text-slate-500">{sim.role}</div>
            <div className="mt-2 flex flex-wrap gap-1">
              <Badge variant="success">{sim.status}</Badge>
              <Badge variant="outline">{sim.points} points</Badge>
              <Badge variant="outline">time ×{sim.time_scale}</Badge>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1 text-[11px]">
              {Object.entries(sim.quality ?? {}).map(([q, n]) => (
                <div key={q} className="flex justify-between rounded bg-slate-50 px-2 py-0.5">
                  <span className="text-slate-500">{q}</span>
                  <span className="font-mono">{n}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="rounded-xl border p-3">
          <div className="text-[13px] font-semibold">KPTCL SLDC website</div>
          {k ? (
            <>
              <div className="text-[11px] text-slate-500">
                220 kV load channels (all DISCOM pages) and state generation (StateGen.aspx), polled every {k.poll_s}s. Live channels override the simulated field and calibrate the
                model.
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <Badge variant={k.pages_ok ? 'success' : 'destructive'}>
                  {k.pages_ok}/{k.pages_total} pages OK
                </Badge>
                <Badge variant="outline">{k.channels_live} live channels</Badge>
                <Badge variant="outline">{k.cycles} cycles</Badge>
              </div>
              {k.system && Object.keys(k.system).length > 0 && (
                <div className="mt-1 text-[11px] text-slate-500">
                  {Object.entries(k.system)
                    .map(([a, b]) => `${a}: ${b}`)
                    .join(' · ')}
                </div>
              )}
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={!can('config') || busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await api('/admin/sources/kptcl/poll', { method: 'POST' })
                  } finally {
                    setBusy(false)
                    reload()
                  }
                }}
              >
                <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} /> Poll now
              </Button>
            </>
          ) : (
            <div className="text-[11px] text-slate-500">
              Not enabled. Start the backend with <code className="rounded bg-slate-100 px-1">KSFP_SOURCE=hybrid</code> to poll kptclsldc.in (the host must be reachable from the
              server).
            </div>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-col gap-2">
        {k?.pages ? (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Page</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Matched</TableHead>
                  <TableHead>Fetched</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {k.pages.map((p) => (
                  <TableRow key={p.url}>
                    <TableCell className="font-mono text-[11px]">{p.url.replace(/^https?:\/\//, '')}</TableCell>
                    <TableCell className="text-[11px]">{p.kind === 'gen' ? 'generation' : `load · ${p.discom}`}</TableCell>
                    <TableCell>
                      {p.ok ? (
                        <Badge variant="success">OK</Badge>
                      ) : (
                        <Badge variant="destructive" title={p.error ?? ''}>
                          {p.http_status ?? 'ERR'}
                        </Badge>
                      )}
                      {p.error && <div className="max-w-[260px] truncate text-[10px] text-rose-600">{p.error}</div>}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px]">{p.rows}</TableCell>
                    <TableCell className="text-right font-mono text-[11px]">{p.matched}</TableCell>
                    <TableCell className="font-mono text-[11px]">{p.fetched_at ? clockS(p.fetched_at) : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="text-[12px] font-semibold">Unmapped rows ({k.unmapped?.length ?? 0}) — page labels not yet in the channel registry</div>
            <div className="min-h-0 flex-1">
              <FitPager
                items={k.unmapped ?? []}
                rowHeight={22}
                reserve={30}
                render={(slice) => (
                  <div className="grid grid-cols-2 gap-x-4">
                    {slice.map((u, i) => (
                      <div key={i} className="flex justify-between border-b py-0.5 text-[11px]">
                        <span className="truncate">
                          {u.label} <span className="text-slate-400">({u.discom ?? u.kind})</span>
                        </span>
                        <span className="font-mono">{u.mw}</span>
                      </div>
                    ))}
                  </div>
                )}
              />
            </div>
          </>
        ) : (
          <Empty icon={<Zap className="size-6 text-slate-300" />}>Page-level health appears here once the KPTCL source is enabled.</Empty>
        )}
      </div>
    </div>
  )
}

interface Dist {
  id: string
  kind: string
  label: string
  params: Record<string, unknown>
  start: number
  end: number
  active: boolean
  intensity: number
  source: string
}

const DIST_KINDS: { id: string; label: string }[] = [
  { id: 'demand_surge', label: 'Demand surge' },
  { id: 're_drop', label: 'Renewable drop' },
  { id: 'line_trip', label: 'Line trip' },
  { id: 'unit_trip', label: 'Generator unit trip' },
  { id: 'freq_event', label: 'Grid frequency event' },
  { id: 'comms_loss', label: 'Asset comms loss' },
  { id: 'telemetry_loss', label: 'Bus telemetry loss' },
  { id: 'price_spike', label: 'RTM price spike' },
]

function SimulatorTab() {
  const { data, reload } = useApi<Dist[]>('/admin/simulator/disturbances', { intervalMs: 3000 })
  const can = useAuth((s) => s.can)
  const [kind, setKind] = useState('demand_surge')
  const [mw, setMw] = useState(500)
  const [region, setRegion] = useState('BENGALURU')
  const [line, setLine] = useState(LINES[0]?.id ?? '')
  const [gen, setGen] = useState(GENERATORS.find((g) => g.type === 'coal')?.id ?? '')
  const [dhz, setDhz] = useState(-0.12)
  const [dur, setDur] = useState(45)
  const [err, setErr] = useState<string | null>(null)
  const allowed = can('simulator')
  function params(): Record<string, unknown> {
    switch (kind) {
      case 'demand_surge':
        return { mw, region }
      case 're_drop':
        return { mw }
      case 'line_trip':
        return { line }
      case 'unit_trip':
        return { gen, mw }
      case 'freq_event':
        return { delta_hz: dhz }
      case 'comms_loss':
        return { assets: ['A_PBESS', 'A_HBESS'] }
      case 'telemetry_loss':
        return {
          buses: BUSES.filter((b) => b.region === 'NORTH')
            .map((b) => b.id)
            .slice(0, 3),
        }
      case 'price_spike':
        return { rtm: 11 }
      default:
        return {}
    }
  }
  async function inject() {
    setErr(null)
    try {
      await api('/admin/simulator/disturbances', {
        method: 'POST',
        body: { kind, params: params(), duration_min: dur, ramp_min: kind === 'line_trip' || kind === 'unit_trip' ? 0 : 5, label: DIST_KINDS.find((d) => d.id === kind)?.label },
      })
      reload()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  const showMw = kind === 'demand_surge' || kind === 're_drop' || kind === 'unit_trip'
  return (
    <div className="grid h-full grid-cols-[300px_minmax(0,1fr)] gap-4">
      <div className="space-y-3">
        <div className="text-[11px] text-slate-500">
          Inject field disturbances into the simulated SCADA/EMS stand-in to drill operators and verify the autonomous loop end-to-end. Not available against live KPTCL channels.
          <button className="mt-1 block font-medium text-sky-700 hover:underline" onClick={() => useUI.getState().go('simulator')}>
            Open the Grid simulator for scenarios, N-1 security and the 3D view →
          </button>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Disturbance</Label>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIST_KINDS.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {showMw && (
          <div className="space-y-1">
            <Label className="text-xs">Magnitude (MW)</Label>
            <Input type="number" value={mw} onChange={(e) => setMw(Number(e.target.value))} className="h-8" />
          </div>
        )}
        {kind === 'demand_surge' && (
          <div className="space-y-1">
            <Label className="text-xs">Region</Label>
            <Select value={region} onValueChange={setRegion}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['STATEWIDE', 'BENGALURU', 'SOUTH', 'CENTRAL', 'NORTH', 'COASTAL'].map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {kind === 'line_trip' && (
          <div className="space-y-1">
            <Label className="text-xs">Line</Label>
            <Select value={line} onValueChange={setLine}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {LINES.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {lineLabel(l.id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {kind === 'unit_trip' && (
          <div className="space-y-1">
            <Label className="text-xs">Generator</Label>
            <Select value={gen} onValueChange={setGen}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {GENERATORS.filter((g) => g.type === 'coal' || g.type === 'hydro' || g.type === 'nuclear').map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {kind === 'freq_event' && (
          <div className="space-y-1">
            <Label className="text-xs">Frequency offset (Hz)</Label>
            <Input type="number" step={0.01} value={dhz} onChange={(e) => setDhz(Number(e.target.value))} className="h-8" />
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-xs">Duration (minutes, simulated)</Label>
          <Input type="number" value={dur} onChange={(e) => setDur(Number(e.target.value))} className="h-8" />
        </div>
        <Button size="sm" className="w-full" disabled={!allowed} onClick={inject}>
          <Zap className="size-4" /> Inject disturbance
        </Button>
        {!allowed && <div className="text-[11px] text-slate-500">Requires the Shift In-charge, DR Programme Manager or Administrator role.</div>}
        {err && <div className="text-xs text-rose-600">{err}</div>}
      </div>
      <div className="min-h-0">
        {!data?.length ? (
          <Empty>No disturbances recorded.</Empty>
        ) : (
          <FitPager
            items={data}
            rowHeight={37}
            reserve={60}
            render={(slice) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Disturbance</TableHead>
                    <TableHead>Parameters</TableHead>
                    <TableHead>Window</TableHead>
                    <TableHead>Intensity</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {slice.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="text-xs">
                        {d.label} {d.active ? <Badge variant="warning">active</Badge> : <Badge variant="secondary">ended</Badge>}
                      </TableCell>
                      <TableCell className="max-w-[240px] truncate font-mono text-[10px] text-slate-500">{JSON.stringify(d.params)}</TableCell>
                      <TableCell className="font-mono text-[11px]">
                        {clockS(d.start)}–{clockS(d.end)}
                      </TableCell>
                      <TableCell className="font-mono text-[11px]">{(d.intensity * 100).toFixed(0)}%</TableCell>
                      <TableCell className="text-[11px]">{d.source}</TableCell>
                      <TableCell>
                        {d.active && allowed && (
                          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => api(`/admin/simulator/disturbances/${d.id}`, { method: 'DELETE' }).then(reload)}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          />
        )}
      </div>
    </div>
  )
}

interface Dsm {
  version: string
  regulation?: string
  amendments_applied?: string[]
  effective_from?: string | null
  source?: string
  approved_by?: string | null
  buyer_category: string
  freq_low: number
  freq_high: number
  bands: { label?: string; pct: number | null; cap_mw: number | null; combine?: 'min' | 'max' }[]
  overdrawal: Record<string, number[]>
  underdrawal: Record<string, number[]>
}

function DsmTab() {
  const { data } = useApi<Dsm>('/admin/config/dsm')
  if (!data) return <Empty>Loading…</Empty>
  const illustrative = !data.effective_from || /illustrative/i.test(`${data.source} ${data.version}`)
  const edge = (b: Dsm['bands'][number]) =>
    b.pct == null && b.cap_mw == null ? 'beyond' : `${b.combine === 'max' ? 'max' : 'min'}(${b.pct ?? '—'}% of schedule, ${b.cap_mw ?? '—'} MW)`
  const meta: [string, string][] = [
    ['Version', data.version],
    ['Regulation', data.regulation ?? '—'],
    ['Amendments applied', data.amendments_applied?.length ? data.amendments_applied.join(' · ') : 'none recorded'],
    ['Effective from', data.effective_from ?? 'not set'],
    ['Source', data.source ?? '—'],
    ['Approved by', data.approved_by ?? '—'],
    ['Buyer category', data.buyer_category],
  ]
  return (
    <div className="grid h-full grid-cols-2 gap-4">
      <div className="space-y-2 text-xs">
        <div className="text-[13px] font-semibold">Deviation Settlement Mechanism rule table</div>
        {illustrative && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            Illustrative table — structure only. Load the notified CERC DSM table for this buyer category, read with all amendments and orders, via{' '}
            <code className="rounded bg-white/70 px-1">PUT /api/v1/admin/config/dsm</code> (version, source, effective date required) before any settlement use.
          </div>
        )}
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg border px-3 py-2 text-[11px]">
          {meta.map(([k, v]) => (
            <Fragment key={k}>
              <span className="text-slate-500">{k}</span>
              <span className="truncate font-medium text-slate-700" title={v}>
                {v}
              </span>
            </Fragment>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border px-3 py-2">
            <div className="text-[10px] text-slate-500">Frequency band</div>
            <div className="font-mono">
              {data.freq_low} – {data.freq_high} Hz
            </div>
          </div>
          <div className="rounded-lg border px-3 py-2">
            <div className="text-[10px] text-slate-500">Volume bands (upper edge of |deviation|)</div>
            {data.bands.map((b, i) => (
              <div key={i} className="font-mono text-[11px]">
                {b.label ?? `Band ${i + 1}`}: {edge(b)}
              </div>
            ))}
          </div>
        </div>
        <div className="text-[11px] text-slate-500">
          Charge per block = Σ over bands (MW in band × 0.25 h × 1000 × multiplier × NR); NR = max(DAM ACP, RTM ACP, (DAM + RTM + ancillary)/3). Over-drawal is payable,
          under-drawal receivable.
        </div>
      </div>
      <div className="space-y-3">
        {(['overdrawal', 'underdrawal'] as const).map((k) => (
          <div key={k}>
            <div className="mb-1 text-[12px] font-semibold capitalize">
              {k} — multiplier of NR ({k === 'overdrawal' ? 'payable' : 'receivable'})
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Frequency</TableHead>
                  {data.bands.map((b, i) => (
                    <TableHead key={i} className="text-right">
                      {b.label ?? `Band ${i + 1}`}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(data[k]).map(([f, ms]) => (
                  <TableRow key={f}>
                    <TableCell className="text-xs">{f === 'LOW' ? `< ${data.freq_low} Hz` : f === 'HIGH' ? `≥ ${data.freq_high} Hz` : 'Normal band'}</TableCell>
                    {ms.map((m, i) => (
                      <TableCell key={i} className="text-right font-mono text-[11px]">
                        {m}×
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}
      </div>
    </div>
  )
}
