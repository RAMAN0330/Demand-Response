// Grid simulator — operator training drills on the 3D network model.
// Inject single disturbances or scripted scenarios, watch the system respond (frequency, ACE, drawal, line loading) and
// check N-1 security live. Drills act on the simulated SCADA/EMS stand-in only; live KPTCL channels are never touched.
import { useMemo, useState, type ReactNode } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { Activity, BookOpen, Clock3, Gauge, Play, Radio, ShieldAlert, ShieldCheck, Siren, Square, Timer, TrendingUp, Unplug, WifiOff, Zap } from 'lucide-react'
import { SectionTabs } from '@/components/common'
import { Empty, Panel, Stat, StatStrip } from '@/components/page'
import { TerritoryMap, type MapMarker, type MapOverlay } from '@/components/three/TerritoryMap'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ASSET_BY_ID, ASSETS, BUS_BY_ID, BUSES, GEN_BY_ID, GENERATORS, LINE_BY_ID, LINES, SLDC, lineLabel } from '@/data/topology'
import { useApi } from '@/hooks'
import { api } from '@/lib/api'
import { fmtMW } from '@/lib/geo'
import type { Sel } from '@/lib/spatial'
import { blockLabel, fmtHz, IEGC } from '@/lib/standards'
import { chartTooltip, signed } from '@/lib/ui'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/useAuth'
import { clockS, useLive } from '@/store/useLive'
import { useUI } from '@/store/useUI'

// ── API shapes ─────────────────────────────────────────────────────────────────────────────────────────

interface Drill {
  id: string
  kind: Kind
  label: string
  params: Record<string, unknown>
  start: number
  end: number
  active: boolean
  pending?: boolean
  intensity: number
  source: string
}

interface ScenarioT {
  id: string
  title: string
  summary: string
  exercises: string
  span_min: number
  steps: { at_min: number; kind: Kind; label: string; duration_min: number }[]
}

interface Contingency {
  line: string
  label: string
  worst_line: string | null
  worst_label: string | null
  worst_loading: number
  overloads: number
  islanding: boolean
  islanded: string[]
  tie_only: boolean
}

interface ContingencyT {
  method: string
  solve_ms: number
  secure: boolean
  insecure: number
  contingencies: Contingency[]
  worst_by_line: Record<string, number>
}

interface ClockT {
  time_scale: number
  adjustable: boolean
  now: number
}

type Kind = 'demand_surge' | 're_drop' | 'line_trip' | 'unit_trip' | 'freq_event' | 'comms_loss' | 'telemetry_loss' | 'price_spike'

const KINDS: { id: Kind; label: string; icon: typeof Zap; hint: string }[] = [
  { id: 'demand_surge', label: 'Demand surge', icon: TrendingUp, hint: 'Load rises across a region' },
  { id: 're_drop', label: 'Renewable shortfall', icon: Activity, hint: 'Solar / wind falls below forecast' },
  { id: 'line_trip', label: 'Line trip', icon: Unplug, hint: 'A transmission element opens' },
  { id: 'unit_trip', label: 'Generating unit trip', icon: Zap, hint: 'A unit is lost (forced outage)' },
  { id: 'freq_event', label: 'Frequency excursion', icon: Radio, hint: 'All-India frequency moves' },
  { id: 'comms_loss', label: 'Gateway comms loss', icon: WifiOff, hint: 'DR assets stop acknowledging' },
  { id: 'telemetry_loss', label: 'RTU telemetry loss', icon: Siren, hint: 'Substation measurements go stale' },
  { id: 'price_spike', label: 'RTM price spike', icon: Gauge, hint: 'Real-time market clears high' },
]
const KIND_BY_ID = Object.fromEntries(KINDS.map((k) => [k.id, k])) as Record<Kind, (typeof KINDS)[number]>
const REGIONS = ['STATEWIDE', 'BENGALURU', 'SOUTH', 'CENTRAL', 'NORTH', 'COASTAL']
const TRIPPABLE = () => GENERATORS.filter((g) => g.type === 'coal' || g.type === 'hydro' || g.type === 'nuclear')
const SPEEDS = [1, 10, 20, 60, 120]

// ── Where a drill sits on the map ──────────────────────────────────────────────────────────────────────

function centroid(pts: { lon: number; lat: number }[]) {
  if (!pts.length) return { lon: SLDC.lon, lat: SLDC.lat }
  return { lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length, lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length }
}

function drillMarkers(d: Drill): MapMarker[] {
  const tone: MapMarker['tone'] = d.pending ? 'info' : d.kind === 'line_trip' || d.kind === 'unit_trip' ? 'bad' : 'warn'
  const label = d.pending ? `Scheduled · ${KIND_BY_ID[d.kind]?.label ?? d.kind}` : (KIND_BY_ID[d.kind]?.label ?? d.kind)
  const one = (p: { lon: number; lat: number }, suffix = ''): MapMarker => ({ id: d.id + suffix, ...p, label, tone })
  const p = d.params
  switch (d.kind) {
    case 'line_trip': {
      const l = LINE_BY_ID[String(p.line)]
      const a = l && BUS_BY_ID[l.from]
      const b = l && BUS_BY_ID[l.to]
      return a && b ? [one(centroid([a, b]))] : []
    }
    case 'unit_trip': {
      const g = GEN_BY_ID[String(p.gen)]
      return g ? [one(g)] : []
    }
    case 'demand_surge': {
      const r = String(p.region ?? 'STATEWIDE')
      return [one(centroid(BUSES.filter((b) => !b.external && (r === 'STATEWIDE' || b.region === r))))]
    }
    case 're_drop':
      return [one(centroid(GENERATORS.filter((g) => g.type === 'solar' || g.type === 'wind')))]
    case 'comms_loss':
      return ((p.assets as string[]) ?? []).flatMap((id, i) => (ASSET_BY_ID[id] ? [one(ASSET_BY_ID[id], `-${i}`)] : []))
    case 'telemetry_loss':
      return ((p.buses as string[]) ?? []).flatMap((id, i) => (BUS_BY_ID[id] ? [one(BUS_BY_ID[id], `-${i}`)] : []))
    default:
      return [one(SLDC)]
  }
}

function describeParams(d: { kind: Kind; params: Record<string, unknown> }) {
  const p = d.params
  switch (d.kind) {
    case 'demand_surge':
      return `+${p.mw} MW · ${String(p.region ?? 'STATEWIDE').toLowerCase()}`
    case 're_drop':
      return `−${p.mw} MW RE`
    case 'line_trip':
      return lineLabel(String(p.line))
    case 'unit_trip':
      return `${GEN_BY_ID[String(p.gen)]?.name ?? p.gen} −${p.mw} MW`
    case 'freq_event':
      return `${Number(p.delta_hz) > 0 ? '+' : ''}${Number(p.delta_hz).toFixed(2)} Hz`
    case 'comms_loss':
      return ((p.assets as string[]) ?? []).map((a) => ASSET_BY_ID[a]?.short ?? a).join(', ')
    case 'telemetry_loss':
      return ((p.buses as string[]) ?? []).map((b) => BUS_BY_ID[b]?.name.split(' ')[0] ?? b).join(', ')
    case 'price_spike':
      return `₹${Number(p.rtm).toFixed(2)}/kWh`
  }
}

async function inject(kind: Kind, params: Record<string, unknown>, durationMin: number, label?: string) {
  const sudden = kind === 'line_trip' || kind === 'unit_trip' || kind === 'comms_loss' || kind === 'telemetry_loss'
  return api('/admin/simulator/disturbances', {
    method: 'POST',
    body: {
      kind,
      params,
      duration_min: durationMin,
      ramp_min: sudden ? 0 : kind === 'freq_event' ? 1 : 5,
      label: label ?? `${KIND_BY_ID[kind].label}: ${describeParams({ kind, params })}`,
    },
  })
}

// ── Page ───────────────────────────────────────────────────────────────────────────────────────────────

export function SimulatorPage() {
  const frame = useLive((s) => s.frame)
  const trend = useLive((s) => s.trend)
  const can = useAuth((s) => s.can)
  const allowed = can('simulator')
  const selection = useUI((s) => s.selection)
  const select = useUI((s) => s.select)
  const { data: drills, reload } = useApi<Drill[]>('/admin/simulator/disturbances', { intervalMs: 3000 })
  const { data: scenarios } = useApi<ScenarioT[]>('/admin/simulator/scenarios', { live: false })
  const { data: n1 } = useApi<ContingencyT>('/network/contingency', { intervalMs: 5000 })
  const { data: clk, reload: reloadClock } = useApi<ClockT>('/admin/simulator/clock', { live: false })
  const [mode, setMode] = useState<'live' | 'n1'>('live')
  const [pick, setPick] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const live = useMemo(() => (drills ?? []).filter((d) => d.active || d.pending), [drills])
  const ranked = useMemo(() => {
    const cs = n1?.contingencies ?? []
    const score = (c: Contingency) => (c.tie_only ? -1 : c.islanding ? 10 : c.worst_loading)
    return [...cs].sort((a, b) => score(b) - score(a))
  }, [n1])
  const picked = ranked.find((c) => c.line === pick) ?? null

  const run = async (p: Promise<unknown>, ok: string) => {
    setMsg(null)
    try {
      await p
      setMsg({ tone: 'ok', text: ok })
      reload()
    } catch (e) {
      setMsg({ tone: 'err', text: (e as Error).message })
    }
  }

  const overlay: MapOverlay = useMemo(() => {
    const markers = live.flatMap(drillMarkers)
    if (mode === 'n1' && n1) {
      return {
        loading: n1.worst_by_line,
        markers,
        highlightLines: picked ? [picked.line, ...(picked.worst_line ? [picked.worst_line] : [])] : undefined,
        caption: picked
          ? picked.islanding
            ? `Outage of ${picked.label} islands ${picked.islanded.join(', ')}`
            : `Outage of ${picked.label} → ${picked.worst_label} at ${(picked.worst_loading * 100).toFixed(0)}%`
          : 'N-1 view: each line coloured by its worst post-contingency loading',
      }
    }
    return { markers }
  }, [live, mode, n1, picked])

  const cardActions = (sel: Sel) => {
    if (!allowed) return null
    const btn = (label: string, fn: () => Promise<unknown>) => (
      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => run(fn(), `${label} injected`)}>
        <Zap className="size-3" /> {label}
      </Button>
    )
    if (sel.kind === 'line') return btn('Trip this line', () => inject('line_trip', { line: sel.id }, 30))
    if (sel.kind === 'gen') {
      const g = GEN_BY_ID[sel.id]
      if (!g) return null
      const mw = Math.round(Math.min(500, g.capacityMW * 0.3) / 10) * 10
      return btn(`Unit trip −${mw} MW`, () => inject('unit_trip', { gen: g.id, mw }, 45))
    }
    if (sel.kind === 'bus') {
      const b = BUS_BY_ID[sel.id]
      if (!b || b.external) return null
      return (
        <>
          {btn(`Demand +300 MW (${(b.region ?? 'state').toLowerCase()})`, () => inject('demand_surge', { mw: 300, region: b.region ?? 'STATEWIDE' }, 40))}
          {btn('RTU telemetry loss', () => inject('telemetry_loss', { buses: [b.id] }, 25))}
        </>
      )
    }
    if (sel.kind === 'asset') return btn('Gateway comms loss', () => inject('comms_loss', { assets: [sel.id] }, 30))
    return null
  }

  // in the N-1 view a line's card shows both its loading now and its worst post-contingency loading
  const cardRows = (sel: Sel): [string, string][] | null => {
    if (mode !== 'n1' || sel.kind !== 'line' || !n1 || !frame) return null
    const worstFor = ranked.filter((c) => c.worst_line === sel.id).sort((a, b) => b.worst_loading - a.worst_loading)[0]
    return [
      ['Status', frame.outaged.includes(sel.id) ? 'OUTAGE' : 'In service'],
      ['Flow now', fmtMW(Math.abs(frame.flows[sel.id] ?? 0))],
      ['Loading now', `${((frame.loading[sel.id] ?? 0) * 100).toFixed(0)}%`],
      ['Worst after N-1', `${((n1.worst_by_line[sel.id] ?? 0) * 100).toFixed(0)}%`],
      ['Worst outage for it', worstFor ? worstFor.label : '—'],
    ]
  }

  if (!frame) return <Empty>Waiting for live state…</Empty>

  const fTone = frame.frequency < IEGC.fEmergency ? 'bad' : frame.frequency < IEGC.fLow || frame.frequency > IEGC.fHigh ? 'warn' : 'good'
  const dev = frame.drawal - frame.schedule
  const contCount = ranked.filter((c) => !c.tie_only).length
  const secureCount = ranked.filter((c) => !c.tie_only && !c.islanding && c.worst_loading <= 1).length

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <StatStrip>
        <Stat
          label="Frequency"
          icon={<Activity />}
          value={fmtHz(frame.frequency)}
          tone={fTone}
          spark={trend.slice(-40).map((p) => p.frequency)}
          sub={`IEGC band ${IEGC.fLow.toFixed(2)}–${IEGC.fHigh.toFixed(2)} Hz`}
        />
        <Stat
          label="Area control error"
          icon={<Gauge />}
          value={`${signed(frame.ace)} MW`}
          tone={Math.abs(frame.ace) > 250 ? 'warn' : 'good'}
          spark={trend.slice(-40).map((p) => p.ace)}
          sub="ACE, frequency-bias corrected"
        />
        <Stat
          label="Deviation from schedule"
          icon={<TrendingUp />}
          value={`${signed(dev)} MW`}
          tone={Math.abs(dev) > 250 ? 'warn' : 'good'}
          sub={`Drawal ${fmtMW(frame.drawal)} · schedule ${fmtMW(frame.schedule)}`}
        />
        <Stat label="Demand met" icon={<Zap />} value={fmtMW(frame.demand)} sub={`RE ${fmtMW(frame.re)} · state gen ${fmtMW(frame.state_gen)}`} />
        <Stat
          label="N-1 security"
          icon={n1?.secure ? <ShieldCheck /> : <ShieldAlert />}
          value={n1 ? `${secureCount}/${contCount} secure` : '—'}
          tone={!n1 ? undefined : n1.secure ? 'good' : 'bad'}
          meter={contCount ? secureCount / contCount : undefined}
          sub={n1 ? `DC LODF screen · ${n1.solve_ms.toFixed(1)} ms` : 'screening…'}
          onClick={() => setMode('n1')}
        />
        <Stat
          label="Drills in progress"
          icon={<Siren />}
          value={`${live.filter((d) => d.active).length} active`}
          tone={live.some((d) => d.active) ? 'warn' : undefined}
          sub={`${live.filter((d) => d.pending).length} scheduled · ${frame.outaged.length} element(s) out`}
        />
        <Stat label="Grid clock" icon={<Clock3 />} value={frame.clock} sub={`${blockLabel(frame.block)} · ${frame.time_scale}× speed`} />
      </StatStrip>

      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)_340px] gap-3">
        {/* left: drill console + drills in progress */}
        <div className="grid min-h-0 grid-rows-[minmax(0,1.7fr)_minmax(0,1fr)] gap-3">
          <Panel title="Drill console" icon={<Play />} bodyClass="flex flex-col">
            <SectionTabs
              sections={[
                { id: 'inject', label: 'Disturbance', content: <InjectForm allowed={allowed} selection={selection} onRun={run} /> },
                { id: 'scenarios', label: 'Scenarios', content: <ScenarioList scenarios={scenarios ?? []} allowed={allowed} onRun={run} /> },
              ]}
            />
            {msg && <div className={cn('mt-2 shrink-0 truncate text-[11px]', msg.tone === 'ok' ? 'text-emerald-700' : 'text-rose-600')}>{msg.text}</div>}
          </Panel>
          <Panel
            title="Drills in progress"
            icon={<Siren />}
            aside={
              allowed &&
              live.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => run(api('/admin/simulator/disturbances', { method: 'DELETE' }), 'All clear: drills ended')}
                >
                  <Square className="size-3" /> All clear
                </Button>
              )
            }
            bodyClass="overflow-y-auto p-2"
          >
            {!live.length ? (
              <Empty icon={<ShieldCheck />}>No drills running. The grid follows its normal daily profile.</Empty>
            ) : (
              <ul className="space-y-1.5">
                {live.map((d) => {
                  const K = KIND_BY_ID[d.kind]?.icon ?? Zap
                  const total = d.end - d.start
                  const done = Math.min(1, Math.max(0, (frame.ts - d.start) / Math.max(1, total)))
                  return (
                    <li key={d.id} className="rounded-xl bg-white/70 p-2 ring-1 ring-slate-900/[0.06]">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'grid size-6 shrink-0 place-items-center rounded-md ring-1',
                            d.pending ? 'bg-sky-50 text-sky-600 ring-sky-100' : 'bg-amber-50 text-amber-600 ring-amber-100',
                          )}
                        >
                          <K className="size-3.5" />
                        </span>
                        <div className="min-w-0 flex-1 leading-tight">
                          <div className="truncate text-xs font-medium text-slate-800">{KIND_BY_ID[d.kind]?.label ?? d.label}</div>
                          <div className="truncate text-[10px] text-slate-500">{describeParams(d)}</div>
                        </div>
                        {allowed && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-6"
                            aria-label="End drill"
                            onClick={() => run(api(`/admin/simulator/disturbances/${d.id}`, { method: 'DELETE' }), 'Drill ended')}
                          >
                            <Square className="size-3" />
                          </Button>
                        )}
                      </div>
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-100">
                        <div className={cn('h-full rounded-full', d.pending ? 'bg-sky-400' : 'bg-amber-500')} style={{ width: `${d.pending ? 0 : done * 100}%` }} />
                      </div>
                      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500 tabular-nums">
                        <span>{d.pending ? `starts ${clockS(d.start)}` : `intensity ${(d.intensity * 100).toFixed(0)}%`}</span>
                        <span>until {clockS(d.end)}</span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>
        </div>

        {/* centre: the network */}
        <Panel
          title={mode === 'n1' ? 'Network: N-1 security' : 'Network: live loading'}
          icon={<Radio />}
          aside={
            <>
              <Segmented
                value={mode}
                onChange={(v) => setMode(v as 'live' | 'n1')}
                options={[
                  { v: 'live', label: 'Live loading' },
                  { v: 'n1', label: 'N-1 security' },
                ]}
              />
              <SpeedControl
                clk={clk}
                allowed={allowed}
                onChange={(s) => run(api('/admin/simulator/clock', { method: 'PUT', body: { time_scale: s } }).then(reloadClock), `Simulation speed ${s}×`)}
              />
            </>
          }
          className="overflow-hidden"
          bodyClass="p-0"
        >
          <TerritoryMap overlay={overlay} chrome={{ bare: true, cardActions, cardRows }} />
        </Panel>

        {/* right: system response + contingency ranking */}
        <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,1.15fr)] gap-3">
          <Panel title="System response" icon={<Activity />} aside={<span className="text-[10px] text-slate-400">{trend.length} samples</span>} bodyClass="p-2">
            <ResponseChart />
          </Panel>
          <Panel
            title="N-1 contingency ranking"
            icon={<ShieldAlert />}
            aside={n1 && <Badge variant={n1.secure ? 'success' : 'destructive'}>{n1.secure ? 'secure' : `${n1.insecure} insecure`}</Badge>}
            bodyClass="overflow-y-auto p-2"
          >
            {!n1 ? (
              <Empty>Screening single-line outages…</Empty>
            ) : (
              <ul className="space-y-1">
                {ranked.map((c) => {
                  const on = pick === c.line
                  const bad = c.islanding && !c.tie_only ? true : c.worst_loading > 1
                  const warn = !bad && c.worst_loading > 0.9
                  return (
                    <li key={c.line}>
                      <button
                        onClick={() => {
                          setMode('n1')
                          setPick(on ? null : c.line)
                          if (!on) select({ kind: 'line', id: c.line })
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-slate-900/[0.04]',
                          on && 'bg-sky-50 ring-1 ring-sky-200',
                          c.tie_only && 'opacity-60',
                        )}
                      >
                        <span className={cn('size-2 shrink-0 rounded-full', bad ? 'bg-rose-500' : warn ? 'bg-amber-500' : 'bg-emerald-500')} />
                        <div className="min-w-0 flex-1 leading-tight">
                          <div className="truncate text-xs font-medium text-slate-700">{c.label}</div>
                          <div className="truncate text-[10px] text-slate-500">
                            {c.tie_only
                              ? 'Radial tie: only the external node separates'
                              : c.islanding
                                ? `Islands ${c.islanded.map((b) => BUS_BY_ID[b]?.name.split(' ')[0] ?? b).join(', ')}`
                                : c.worst_label
                                  ? `→ ${c.worst_label}${c.overloads > 1 ? ` · ${c.overloads} overloads` : ''}`
                                  : 'No other line affected'}
                          </div>
                        </div>
                        {!c.tie_only && !c.islanding && (
                          <span className={cn('num shrink-0 text-xs font-semibold', bad ? 'text-rose-600' : warn ? 'text-amber-700' : 'text-slate-600')}>
                            {(c.worst_loading * 100).toFixed(0)}%
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}

// ── Parts ──────────────────────────────────────────────────────────────────────────────────────────────

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { v: string; label: string }[] }) {
  return (
    <div className="flex rounded-lg bg-slate-100 p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={cn(
            'rounded-md px-2 py-0.5 text-[11px] font-medium text-slate-500 transition',
            value === o.v && 'bg-white text-sky-700 shadow-sm ring-1 ring-slate-900/[0.06]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function SpeedControl({ clk, allowed, onChange }: { clk: ClockT | null; allowed: boolean; onChange: (s: number) => void }) {
  if (!clk) return null
  if (!clk.adjustable)
    return (
      <Badge variant="secondary" title="Live KPTCL channels in use">
        <Timer /> real time
      </Badge>
    )
  return (
    <div className="flex items-center gap-1" title="Simulation speed (simulated seconds per real second)">
      <Timer className="size-3.5 text-slate-400" />
      <div className="flex rounded-lg bg-slate-100 p-0.5">
        {SPEEDS.map((s) => (
          <button
            key={s}
            disabled={!allowed}
            onClick={() => onChange(s)}
            className={cn(
              'num rounded-md px-1.5 py-0.5 text-[10px] font-medium text-slate-500 transition disabled:cursor-not-allowed',
              clk.time_scale === s && 'bg-white text-sky-700 shadow-sm ring-1 ring-slate-900/[0.06]',
            )}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  )
}

function ResponseChart() {
  const trend = useLive((s) => s.trend)
  const legend = { iconSize: 8, wrapperStyle: { fontSize: 10, paddingTop: 2 } } as const
  if (trend.length < 2) return <Empty>Collecting samples…</Empty>
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={trend} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="#e6eaef" vertical={false} />
        <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#96a1ae' }} minTickGap={40} />
        <YAxis
          yAxisId="f"
          domain={[(lo: number) => Math.min(lo - 0.02, 49.85), (hi: number) => Math.max(hi + 0.02, 50.1)]}
          tick={{ fontSize: 10, fill: '#96a1ae' }}
          width={40}
          tickFormatter={(v: number) => v.toFixed(2)}
        />
        <YAxis yAxisId="a" orientation="right" tick={{ fontSize: 10, fill: '#96a1ae' }} width={38} />
        <ReferenceArea yAxisId="f" y1={IEGC.fLow} y2={IEGC.fHigh} fill="#47a37b" fillOpacity={0.07} />
        <ReferenceLine yAxisId="f" y={IEGC.fLow} stroke="#e6b45a" strokeDasharray="3 3" />
        <ReferenceLine yAxisId="f" y={IEGC.fHigh} stroke="#e6b45a" strokeDasharray="3 3" />
        <RTooltip {...chartTooltip} />
        <Legend {...legend} />
        <Line yAxisId="f" dataKey="frequency" name="Frequency Hz" stroke="#6d4fe3" dot={false} isAnimationActive={false} />
        <Line yAxisId="a" dataKey="ace" name="ACE MW (right)" stroke="#7160b8" dot={false} isAnimationActive={false} />
        <Line yAxisId="a" dataKey="deviation" name="Deviation MW (right)" stroke="#c8622a" strokeDasharray="4 3" dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

function InjectForm({ allowed, selection, onRun }: { allowed: boolean; selection: Sel | null; onRun: (p: Promise<unknown>, ok: string) => void }) {
  const [kind, setKind] = useState<Kind>('demand_surge')
  const [mw, setMw] = useState(500)
  const [region, setRegion] = useState('BENGALURU')
  const [line, setLine] = useState(LINES[0]?.id ?? '')
  const [gen, setGen] = useState(TRIPPABLE()[0]?.id ?? '')
  const [dhz, setDhz] = useState(-0.12)
  const [rtm, setRtm] = useState(11)
  const [assets, setAssets] = useState<string[]>([])
  const [buses, setBuses] = useState<string[]>([])
  const [dur, setDur] = useState(30)

  // a map selection pre-fills the matching disturbance
  const [seen, setSeen] = useState<Sel | null>(null)
  if (selection !== seen) {
    setSeen(selection)
    if (selection?.kind === 'line') {
      setKind('line_trip')
      setLine(selection.id)
    } else if (selection?.kind === 'gen' && TRIPPABLE().some((g) => g.id === selection.id)) {
      setKind('unit_trip')
      setGen(selection.id)
    } else if (selection?.kind === 'asset') {
      setKind('comms_loss')
      setAssets([selection.id])
    } else if (selection?.kind === 'bus' && BUS_BY_ID[selection.id]?.region) {
      setKind('demand_surge')
      setRegion(BUS_BY_ID[selection.id].region as string)
    }
  }

  const params = (): Record<string, unknown> => {
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
        return { assets: assets.length ? assets : ['A_PBESS'] }
      case 'telemetry_loss':
        return { buses: buses.length ? buses : ['GUL'] }
      case 'price_spike':
        return { rtm }
    }
  }
  const field = (label: string, node: ReactNode, wide = false) => (
    <div className={cn('min-w-0 space-y-1', wide && 'col-span-2')}>
      <Label className="text-[11px] text-slate-500">{label}</Label>
      {node}
    </div>
  )
  const pickList = (value: string, onChange: (v: string) => void, items: { id: string; label: string }[]) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {items.map((i) => (
          <SelectItem key={i.id} value={i.id}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <div className="flex h-full flex-col gap-2.5">
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-0.5">
        <div className="grid grid-cols-4 gap-1">
          {KINDS.map((k) => (
            <button
              key={k.id}
              title={`${k.label}: ${k.hint}`}
              onClick={() => setKind(k.id)}
              className={cn(
                'flex flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[9.5px] leading-tight text-slate-500 ring-1 ring-slate-900/[0.06] transition hover:bg-slate-900/[0.03]',
                kind === k.id && 'bg-sky-50 text-sky-700 ring-sky-300',
              )}
            >
              <k.icon className="size-3.5" />
              <span className="line-clamp-2 text-center">{k.label}</span>
            </button>
          ))}
        </div>
        <div className="text-[11px] leading-snug text-slate-500">{KIND_BY_ID[kind].hint}. Select a line, generator, substation or asset on the map to target it.</div>
        <div className="grid grid-cols-2 gap-2">
          {(kind === 'demand_surge' || kind === 're_drop' || kind === 'unit_trip') &&
            field('Magnitude (MW)', <Input type="number" value={mw} onChange={(e) => setMw(Number(e.target.value))} className="h-8" />)}
          {field('Duration (sim. min)', <Input type="number" min={1} max={600} value={dur} onChange={(e) => setDur(Number(e.target.value))} className="h-8" />)}
          {kind === 'demand_surge' &&
            field(
              'Region',
              pickList(
                region,
                setRegion,
                REGIONS.map((r) => ({ id: r, label: r.charAt(0) + r.slice(1).toLowerCase() })),
              ),
              true,
            )}
          {kind === 'line_trip' &&
            field(
              'Line',
              pickList(
                line,
                setLine,
                LINES.map((l) => ({ id: l.id, label: lineLabel(l.id) })),
              ),
              true,
            )}
          {kind === 'unit_trip' &&
            field(
              'Generating station',
              pickList(
                gen,
                setGen,
                TRIPPABLE().map((g) => ({ id: g.id, label: `${g.name} (${g.capacityMW} MW)` })),
              ),
              true,
            )}
          {kind === 'freq_event' &&
            field('Frequency offset (Hz)', <Input type="number" step={0.01} value={dhz} onChange={(e) => setDhz(Number(e.target.value))} className="h-8" />)}
          {kind === 'price_spike' &&
            field('RTM clearing price (₹/kWh)', <Input type="number" step={0.5} value={rtm} onChange={(e) => setRtm(Number(e.target.value))} className="h-8" />)}
          {kind === 'comms_loss' &&
            field(
              'DR assets',
              pickList(
                assets[0] ?? 'A_PBESS',
                (v) => setAssets([v]),
                ASSETS.filter((a) => a.type !== 'generation').map((a) => ({ id: a.id, label: a.name })),
              ),
              true,
            )}
          {kind === 'telemetry_loss' &&
            field(
              'Substation',
              pickList(
                buses[0] ?? 'GUL',
                (v) => setBuses([v]),
                BUSES.filter((b) => !b.external).map((b) => ({ id: b.id, label: b.name })),
              ),
              true,
            )}
        </div>
      </div>
      <Button size="sm" className="w-full shrink-0" disabled={!allowed} onClick={() => onRun(inject(kind, params(), dur), `${KIND_BY_ID[kind].label} injected`)}>
        <Zap className="size-4" /> Inject disturbance
      </Button>
      {!allowed && <div className="text-[11px] text-slate-500">Injecting drills needs the engineer or administrator role.</div>}
    </div>
  )
}

function ScenarioList({ scenarios, allowed, onRun }: { scenarios: ScenarioT[]; allowed: boolean; onRun: (p: Promise<unknown>, ok: string) => void }) {
  if (!scenarios.length) return <Empty icon={<BookOpen />}>No scenarios available.</Empty>
  return (
    <ul className="h-full space-y-2 overflow-y-auto pr-0.5">
      {scenarios.map((s) => (
        <li key={s.id} className="rounded-xl bg-white/70 p-2.5 ring-1 ring-slate-900/[0.06]">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-slate-800">{s.title}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{s.summary}</div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2 text-[11px]"
              disabled={!allowed}
              onClick={() => onRun(api(`/admin/simulator/scenarios/${s.id}`, { method: 'POST' }), `Scenario launched: ${s.title}`)}
            >
              <Play className="size-3" /> Run
            </Button>
          </div>
          <ol className="mt-1.5 space-y-0.5 border-l border-slate-200 pl-2">
            {s.steps.map((st, i) => (
              <li key={i} className="flex gap-1.5 text-[10px] text-slate-600">
                <span className="num w-9 shrink-0 text-slate-400">+{st.at_min} min</span>
                <span className="truncate">{st.label}</span>
              </li>
            ))}
          </ol>
          <div className="mt-1.5 text-[10px] text-sky-700">Exercises: {s.exercises}</div>
        </li>
      ))}
    </ul>
  )
}
