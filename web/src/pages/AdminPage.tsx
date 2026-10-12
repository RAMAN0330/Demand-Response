// Administration — autonomy policy, data sources (incl. KPTCL SLDC pages), field simulator, DSM rules, users.
import { useState, Fragment } from 'react'
import { RefreshCw, Trash2, Zap } from 'lucide-react'
import { FitPager, SectionTabs } from '@/components/common'
import { Empty, Panel } from '@/components/page'
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
import { clockS } from '@/store/useLive'

export function AdminPage() {
  return (
    <div className="flex h-full flex-col gap-3">
      <Panel className="flex-1" bodyClass="flex flex-col">
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
      <div className="space-y-3">
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
      </div>
      <div className="space-y-3 rounded-xl border bg-slate-50/50 p-3">
        <div className="text-[13px] font-semibold">
          L2 safety envelope {!envEditable && <span className="text-[11px] font-normal text-slate-500">(requires engineer/admin)</span>}
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
        {!allowed && <div className="text-[11px] text-slate-500">Requires the engineer or admin role.</div>}
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
