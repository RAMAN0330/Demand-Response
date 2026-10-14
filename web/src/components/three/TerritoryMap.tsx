import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { Canvas } from '@react-three/fiber'
import { Grid, PerformanceMonitor } from '@react-three/drei'
import { Battery, Cable, Diamond, Factory, Layers, Map as MapIcon, Mountain, RadioTower, Tag, Waves, X, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ASSET_TYPE_META,
  ASSETS,
  BUS_BY_ID,
  BUSES,
  DISCOM_COLORS,
  GROUP_OF_CHANNEL,
  LINES,
  LOAD_CHANNELS,
  SLDC,
  lineLabel,
  ASSET_BY_ID,
  LINE_BY_ID,
  GEN_BY_ID,
  CHANNEL_BY_ID,
  STATION_BY_ID,
} from '@/data/topology'
import type { Asset, Frame } from '@/data/types'
import { fmtMW, loadingColor, project, STATE_TOP } from '@/lib/geo'
import { affected, worldOf, type Sel } from '@/lib/spatial'
import { cn } from '@/lib/utils'
import { useLive } from '@/store/useLive'
import { useUI, type CameraPreset, type MapLayers, type Selection } from '@/store/useUI'
import { GenStations, LoadChannels } from './Channels'
import { AnchorProjector, Beacons, CameraRig, CommandWave, type DispatchPhase, type WaveTarget } from './Effects'
import { STATUS_COLOR, type Focus } from './focus'
import { GridLines } from './GridLines'
import { LabelLayer, LabelProjector, type MapLabel } from './Labels'
import { FlexAssets, Generators, SldcBeacon, Substations, TieArrows } from './Nodes'
import { HeatLayer, StateShape } from './StateShape'

export interface MapOverlay {
  focus?: Focus
  loading?: Record<string, number>
  highlightLines?: string[]
  wave?: { targets: WaveTarget[]; phase: DispatchPhase }
  caption?: string
  /** participants to light up regardless of selection (e.g. a programme's members) */
  lit?: string[]
  /** labelled beacons at arbitrary places (e.g. simulator drills); tone picks the ISA-101 state colour */
  markers?: MapMarker[]
}

export interface MapMarker {
  id: string
  lon: number
  lat: number
  label: string
  tone: 'info' | 'warn' | 'bad'
}

const MARKER_COLOR: Record<MapMarker['tone'], string> = { info: '#6d4fe3', warn: '#c07e18', bad: '#b83b3a' }

export interface MapChrome {
  /** full-bleed workspace: no frame, chrome positioned by the page */
  bare?: boolean
  toolbarClass?: string
  legendClass?: string
  hideLegend?: boolean
  /** actions rendered in the anchored detail card */
  cardActions?: (sel: Sel) => ReactNode
  /** override the card's rows (e.g. replayed values); return null to use the live description */
  cardRows?: (sel: Sel) => [string, string][] | null
}

export function TerritoryMap({ overlay, className, compact, chrome }: { overlay?: MapOverlay; className?: string; compact?: boolean; chrome?: MapChrome }) {
  const frame = useLive((s) => s.frame)
  const layers = useUI((s) => s.layers)
  if (!frame) return <div className={cn('grid h-full place-items-center rounded-xl border bg-[#f3f0fb] text-sm text-muted-foreground', className)}>Waiting for live state…</div>
  return <MapInner frame={frame} overlay={overlay} className={className} compact={compact} layers={layers} chrome={chrome ?? {}} />
}

function MapInner({
  frame,
  overlay,
  className,
  compact,
  layers,
  chrome,
}: {
  frame: Frame
  overlay?: MapOverlay
  className?: string
  compact?: boolean
  layers: MapLayers
  chrome: MapChrome
}) {
  const loading = overlay?.loading ?? frame.loading
  // live BESS SoC from telemetry drives the 3D battery fill
  const assets: Asset[] = useMemo(
    () => ASSETS.map((a) => (a.bess && frame.assets[a.id]?.soc != null ? { ...a, bess: { ...a.bess, soc: frame.assets[a.id].soc as number } } : a)),
    [frame.assets],
  )
  // focus = commands currently in force (live setpoints) unless the page supplies its own
  const focus: Focus = useMemo(() => {
    if (overlay?.focus) return overlay.focus
    const f: Focus = {}
    for (const [id, sp] of Object.entries(frame.live_setpoints)) {
      if (sp > 0.5 && id !== 'RTM') f[id] = { mw: frame.assets[id]?.mw ?? 0, status: 'delivering' }
    }
    return f
  }, [overlay?.focus, frame.live_setpoints, frame.assets])

  // selection context: what the selected thing touches lights up
  const selection = useUI((s) => s.selection)
  const aff = useMemo(
    () => (selection ? affected(selection, Object.keys(overlay?.focus ?? {}), overlay?.highlightLines ?? []) : { lines: [], assets: [] }),
    [selection, overlay?.focus, overlay?.highlightLines],
  )
  const highlight = useMemo(() => [...new Set([...(overlay?.highlightLines ?? []), ...aff.lines])], [overlay?.highlightLines, aff.lines])
  const beacons = useMemo(() => {
    const ids = new Set([...aff.assets, ...(overlay?.lit ?? [])])
    return ASSETS.filter((a) => ids.has(a.id) && a.type !== 'generation')
  }, [aff.assets, overlay?.lit])

  const labelLayer = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const hoverRef = useRef<HTMLDivElement>(null)
  const hovered = useUI((s) => s.hovered)
  const hoverSel = hovered && !(selection && selection.kind === hovered.kind && selection.id === hovered.id) ? hovered : null
  const labels = useMapLabels(layers, frame.injections, focus, overlay?.markers)
  const markerGroups = useMemo(() => {
    const g: Partial<Record<MapMarker['tone'], MapMarker[]>> = {}
    for (const m of overlay?.markers ?? []) (g[m.tone] ??= []).push(m)
    return Object.entries(g) as [MapMarker['tone'], MapMarker[]][]
  }, [overlay?.markers])
  // adaptive resolution: drop to 1× device pixels when the frame rate sags, climb back when it recovers
  const [dpr, setDpr] = useState(() => Math.min(2, window.devicePixelRatio || 1))
  useMapKeys()
  const stress = useMemo(() => {
    const out: Record<string, number> = {}
    for (const l of LINES) {
      const v = loading[l.id] ?? 0
      out[l.from] = Math.max(out[l.from] ?? 0, v)
      out[l.to] = Math.max(out[l.to] ?? 0, v)
    }
    return out
  }, [loading])

  return (
    <div className={cn('relative h-full min-h-[280px] w-full overflow-hidden bg-[#f3f0fb]', !chrome.bare && 'rounded-xl border', className)}>
      <Canvas flat shadows="soft" camera={{ position: [0.4, 11.2, 8.8], fov: 42, near: 0.05, far: 200 }} dpr={dpr} gl={{ antialias: true }}>
        <PerformanceMonitor onDecline={() => setDpr(1)} onIncline={() => setDpr(Math.min(2, window.devicePixelRatio || 1))} flipflops={3} onFallback={() => setDpr(1)} />
        <color attach="background" args={['#f3f0fb']} />
        <fog attach="fog" args={['#f3f0fb', 16, 34]} />
        <Daylight clock={frame.clock} />
        <Suspense fallback={null}>
          <Grid
            position={[0, -0.001, 0]}
            args={[40, 40]}
            cellSize={0.4}
            cellThickness={0.4}
            cellColor="#e6e1f4"
            sectionSize={2}
            sectionThickness={0.8}
            sectionColor="#d8d0ee"
            fadeDistance={26}
            infiniteGrid
          />
          <StateShape />
          {layers.heat && <HeatLayer busLoad={frame.bus_load} stress={stress} />}
          {layers.grid && <GridLines flows={frame.flows} loading={loading} outaged={frame.outaged} showFlows={layers.flows} highlight={highlight} />}
          {layers.grid && <Substations stress={stress} />}
          {layers.ch220 && <LoadChannels channels={frame.channels} shed={frame.shedding?.shed_channels} />}
          {layers.genStations && <GenStations channels={frame.channels} />}
          {layers.generation && <Generators output={frame.gen_output} focus={focus} />}
          <FlexAssets assets={assets} focus={focus} layers={layers} />
          {layers.ties && <TieArrows />}
          <SldcBeacon />
          {overlay?.wave && <CommandWave targets={overlay.wave.targets} phase={overlay.wave.phase} />}
          {beacons.length > 0 && <Beacons points={beacons} />}
          {markerGroups.map(([tone, pts]) => (
            <Beacons key={tone} points={pts} color={MARKER_COLOR[tone]} />
          ))}
          <CameraRig />
          <LabelProjector labels={labels} layer={labelLayer} />
          <AnchorProjector point={anchorPoint(selection, Object.keys(overlay?.focus ?? {}))} el={cardRef} />
          <AnchorProjector point={anchorPoint(hoverSel, [])} el={hoverRef} />
        </Suspense>
      </Canvas>
      <LabelLayer labels={labels} layer={labelLayer} />
      <MapToolbar compact={compact} className={chrome.toolbarClass} />
      <AnchoredCard ref={hoverRef} sel={hoverSel} frame={frame} loading={loading} hover />
      <AnchoredCard ref={cardRef} sel={selection} frame={frame} loading={loading} actions={chrome.cardActions} rowsFor={chrome.cardRows} affectedCount={aff.assets.length} />
      {!compact && !chrome.hideLegend && <Legend frame={frame} className={chrome.legendClass} />}
      {overlay?.caption && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-white/90 px-3 py-1 text-xs text-slate-700 shadow-sm ring-1 ring-slate-900/10">
          {overlay.caption}
        </div>
      )}
    </div>
  )
}

/**
 * Sun follows the grid clock: azimuth sweeps east → west, elevation peaks at noon. Deliberately subtle so the
 * ISA-101 light background and state colours stay legible at night.
 */
function Daylight({ clock }: { clock: string }) {
  const [hh = 12, mm = 0] = clock.split(':').map(Number)
  const h = hh + mm / 60
  const a = (Math.PI * (h - 6)) / 12 // 0 at sunrise, π at sunset
  const elev = Math.sin(a)
  const day = Math.max(0, elev)
  const night = elev < 0
  return (
    <>
      <ambientLight intensity={0.78 + day * 0.2} color={night ? '#dfe6f3' : '#ffffff'} />
      {/* the sun casts real shadows (towers, plant) whose length and direction follow the time of day */}
      <directionalLight
        position={[Math.cos(a) * 9, 3 + day * 9, 4]}
        intensity={night ? 0.55 : 0.7 + day * 0.45}
        color={night ? '#b9c9e6' : day < 0.3 ? '#ffe2bd' : '#ffffff'}
        castShadow={!night}
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-8}
        shadow-camera-right={8}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
        shadow-camera-near={0.5}
        shadow-camera-far={40}
      />
      <directionalLight position={[-6, 4, -5]} intensity={0.35} color="#b1a3f6" />
    </>
  )
}

/** R resets the view to the whole state; Esc clears the selection. Ignored while typing in a field. */
function useMapKeys() {
  const setCamera = useUI((s) => s.setCamera)
  const select = useUI((s) => s.select)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return
      if (e.key === 'Escape') select(null)
      else if (e.key === 'r' || e.key === 'R') setCamera('STATE')
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [setCamera, select])
}

const CAMS: { id: CameraPreset; label: string }[] = [
  { id: 'STATE', label: 'State' },
  { id: 'BENGALURU', label: 'Bengaluru' },
  { id: 'NORTH', label: 'North' },
  { id: 'COAST', label: 'Coast' },
  { id: 'TILT', label: '3D' },
]

const LAYER_DEFS: { k: keyof MapLayers; label: string; icon: typeof Zap }[] = [
  { k: 'grid', label: '400/765 kV grid', icon: Zap },
  { k: 'flows', label: 'Animated power flow', icon: Waves },
  { k: 'ch220', label: '220 kV feeders — live flow & load rotation (all DISCOMs)', icon: Cable },
  { k: 'genStations', label: 'Generating stations', icon: Diamond },
  { k: 'generation', label: 'Generation complexes', icon: Mountain },
  { k: 'dr', label: 'DR fleets', icon: Factory },
  { k: 'bess', label: 'BESS', icon: Battery },
  { k: 'ties', label: 'ISTS tie points', icon: RadioTower },
  { k: 'heat', label: 'Load heat', icon: Layers },
  { k: 'labels', label: 'Labels', icon: Tag },
]

function MapToolbar({ compact, className }: { compact?: boolean; className?: string }) {
  const cam = useUI((s) => s.camera)
  const setCamera = useUI((s) => s.setCamera)
  const layers = useUI((s) => s.layers)
  const toggle = useUI((s) => s.toggleLayer)
  return (
    <div className={cn('absolute top-2.5 left-2.5 flex flex-col gap-1.5', className)}>
      <div className="flex flex-wrap gap-0.5 surface-chip p-1">
        <MapIcon className="mx-1 size-3.5 self-center text-sky-600" />
        {CAMS.map((c) => (
          <button
            key={c.id}
            onClick={() => setCamera(c.id)}
            className={cn(
              'rounded-md px-1.5 py-0.5 text-[11px] font-medium text-slate-600 transition hover:bg-slate-900/5',
              cam === c.id && 'bg-sky-100 text-sky-700 ring-1 ring-sky-300',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className={cn('flex gap-0.5 surface-chip p-1', compact && 'flex-wrap')}>
        {LAYER_DEFS.map(({ k, label, icon: Icon }) => (
          <Tooltip key={k}>
            <TooltipTrigger asChild>
              <button
                onClick={() => toggle(k)}
                className={cn('rounded-md p-1 text-slate-400 transition hover:bg-slate-900/5', layers[k] && 'bg-sky-100 text-sky-700')}
                aria-label={label}
              >
                <Icon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

function Legend({ frame, className }: { frame: Frame; className?: string }) {
  const live = Object.values(frame.channels).filter((c) => c.src === 'KPTCL').length
  return (
    <div className={cn('surface-chip pointer-events-none absolute bottom-2.5 left-2.5 p-2 text-[10px] text-slate-600', className)}>
      <div className="flex gap-2">
        {[
          ['<75%', 0.5],
          ['75–90%', 0.8],
          ['90–100%', 0.95],
          ['>100%', 1.1],
        ].map(([l, v]) => (
          <span key={l as string} className="flex items-center gap-1">
            <span className="h-1 w-3.5 rounded" style={{ background: loadingColor(v as number) }} />
            {l}
          </span>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-2">
        {Object.entries(DISCOM_COLORS)
          .filter(([k]) => !['KPCL', 'IPP'].includes(k))
          .map(([k, c]) => (
            <span key={k} className="flex items-center gap-1">
              <span className="size-2 rounded-sm" style={{ background: c }} />
              {k}
            </span>
          ))}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-emerald-500" /> live KPTCL ({live})
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-slate-300" /> simulated
        </span>
      </div>
    </div>
  )
}

function describe(sel: NonNullable<Selection>, frame: Frame, loading: Record<string, number>) {
  if (sel.kind === 'bus') {
    const b = BUS_BY_ID[sel.id]
    const conn = LINES.filter((l) => l.from === b.id || l.to === b.id)
    const worst = conn.reduce((m, l) => Math.max(m, loading[l.id] ?? 0), 0)
    const ch = LOAD_CHANNELS.filter((c) => c.parent_bus === b.id)
    return {
      title: b.name,
      sub: `${b.discom ?? 'ISTS'} · ${b.kv} kV · ${ch.length} × 220 kV channels`,
      rows: [
        ['Load', fmtMW(frame.bus_load[b.id] ?? 0)],
        ['Worst connected line', `${(worst * 100).toFixed(0)}%`],
        [
          '220 kV channels',
          ch
            .map((c) => c.name.split(' ')[0])
            .slice(0, 4)
            .join(', ') + (ch.length > 4 ? '…' : ''),
        ],
      ],
    }
  }
  if (sel.kind === 'line') {
    const l = LINE_BY_ID[sel.id]
    return {
      title: lineLabel(l.id),
      sub: `${l.kv} kV${l.hvdc ? ' HVDC' : ''} · limit ${fmtMW(l.limitMW)}`,
      rows: [
        ['Status', frame.outaged.includes(l.id) ? 'OUTAGE' : 'In service'],
        ['Flow', fmtMW(Math.abs(frame.flows[l.id] ?? 0))],
        ['Loading', `${((loading[l.id] ?? 0) * 100).toFixed(0)}%`],
      ],
    }
  }
  if (sel.kind === 'gen') {
    const g = GEN_BY_ID[sel.id]
    const mw = frame.gen_output[g.id] ?? 0
    return {
      title: g.name,
      sub: `${g.type} · ${g.owner}`,
      rows: [
        ['Output', fmtMW(mw)],
        ['Capacity', fmtMW(g.capacityMW)],
        ['Utilisation', `${((mw / g.capacityMW) * 100).toFixed(0)}%`],
      ],
    }
  }
  if (sel.kind === 'channel') {
    const c = CHANNEL_BY_ID[sel.id]
    const v = frame.channels[c.id]
    const g = GROUP_OF_CHANNEL[c.id]
    const off = !!frame.shedding?.shed_channels[c.id]
    const rotatable = (v?.mw ?? 0) * 0.3
    return {
      title: `${c.name} 220 kV`,
      sub: `${c.discom} · fed from ${BUS_BY_ID[c.parent_bus]?.name.split(' ')[0]} 400 kV`,
      rows: [
        ['Feeder status', off ? 'ROTATED OUT — non-essential feeders open' : 'In service'],
        ['Load', v ? fmtMW(v.mw, 1) : '—'],
        ['Roster group', g ? `${g.discom} ${g.letter} (${g.channels.length} stations)` : '—'],
        ['On roster (non-essential)', off ? 'disconnected' : `≈ ${fmtMW(rotatable)}`],
        [
          'Never rotated',
          g
            ? Object.entries(g.protected)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${k} ${n}`)
                .join(' · ')
            : '—',
        ],
        ['Source', v?.src === 'KPTCL' ? 'KPTCL SLDC (live)' : 'Simulated (KPTCL page not reachable)'],
      ],
    }
  }
  if (sel.kind === 'station') {
    const g = STATION_BY_ID[sel.id]
    const v = frame.channels[g.id]
    return {
      title: g.name,
      sub: `${g.type} · ${g.owner} · ${g.capacityMW} MW`,
      rows: [
        ['Generation', v ? fmtMW(v.mw, 1) : '—'],
        ['Source', v?.src === 'KPTCL' ? 'KPTCL StateGen (live)' : 'Simulated'],
      ],
    }
  }
  if (sel.kind === 'event') {
    const d = frame.active_decision?.id === sel.id ? frame.active_decision : null
    return {
      title: `DR event ${sel.id}`,
      sub: d ? `${d.severity} · ${d.direction === 'UP' ? 'load reduction' : 'load increase'} · rev ${d.revision}` : 'closed event',
      rows: d
        ? [
            ['State', d.state.replace('_', ' ')],
            ['Target', fmtMW(d.requirement_mw)],
            ['Dispatched', fmtMW(d.planned_mw)],
            ['Delivering', fmtMW(d.delivered_mw)],
          ]
        : [['Status', 'See DR Events for settlement']],
    }
  }
  const a = ASSET_BY_ID[sel.id]
  const st = frame.assets[a.id]
  const sp = frame.live_setpoints[a.id] ?? 0
  return {
    title: a.name,
    sub: `${ASSET_TYPE_META[a.type].label} · ${a.discom} · ${a.protocol}`,
    rows: [
      ['Delivering', fmtMW(st?.mw ?? 0)],
      ['Setpoint', sp > 0 ? fmtMW(sp) : 'none'],
      ...(st?.soc != null ? [['State of charge', `${(st.soc * 100).toFixed(0)}%`]] : []),
      ['State DR share', fmtMW(a.reserve.state)],
      ['Heartbeat', (st?.hb_age ?? 0) > 60 ? `LOST (${st?.hb_age}s)` : 'OK'],
    ],
  }
}

function anchorPoint(sel: Selection, eventAssets: string[]): [number, number, number] | null {
  if (!sel) return null
  const w = worldOf(sel, eventAssets)
  return w ? [w.x, STATE_TOP + 0.25, w.z] : null
}

const AnchoredCard = ({
  ref,
  sel,
  frame,
  loading,
  hover,
  actions,
  rowsFor,
  affectedCount = 0,
}: {
  rowsFor?: (sel: Sel) => [string, string][] | null
  ref: Ref<HTMLDivElement>
  sel: Selection
  frame: Frame
  loading: Record<string, number>
  hover?: boolean
  actions?: (sel: Sel) => ReactNode
  affectedCount?: number
}) => {
  const select = useUI((s) => s.select)
  const base = sel ? describe(sel, frame, loading) : null
  const over = sel && rowsFor ? rowsFor(sel) : null
  const d = base && over ? { ...base, rows: over } : base
  const bad = d?.rows.some(([, v]) => String(v).startsWith('LOST') || String(v).startsWith('ROTATED OUT') || v === 'OUTAGE')
  return (
    <div
      ref={ref}
      className={cn('absolute top-0 left-0 z-20 opacity-0 transition-opacity duration-150 will-change-transform', hover ? 'pointer-events-none w-56' : 'w-72', !d && 'invisible')}
    >
      {d && sel && (
        <div className={cn('surface-panel relative p-3 text-xs', !hover && '!border-sky-300/80')}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-slate-800">{d.title}</div>
              <div className="truncate text-[11px] text-slate-500">{d.sub}</div>
            </div>
            {!hover && (
              <Button size="icon" variant="ghost" className="size-6 shrink-0" onClick={() => select(null)} aria-label="Close">
                <X className="size-3.5" />
              </Button>
            )}
          </div>
          {bad && (
            <Badge variant="destructive" className="mt-2">
              Attention required
            </Badge>
          )}
          <div className="mt-2 divide-y divide-slate-200/70">
            {d.rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 py-1">
                <span className="text-slate-500">{k}</span>
                <span className="truncate font-medium tabular-nums">{v}</span>
              </div>
            ))}
          </div>
          {!hover && affectedCount > 0 && sel.kind !== 'asset' && <div className="mt-1.5 text-[10px] text-sky-700">{affectedCount} participant(s) highlighted on the map</div>}
          {!hover && actions && <div className="mt-2 flex flex-wrap gap-1.5">{actions(sel)}</div>}
        </div>
      )}
    </div>
  )
}

function useMapLabels(layers: MapLayers, injections: Record<string, number>, focus: Focus, markers?: MapMarker[]): MapLabel[] {
  return useMemo(() => {
    const out: MapLabel[] = []
    const at = (lon: number, lat: number, y: number): [number, number, number] => {
      const [x, z] = project(lon, lat)
      return [x, y, z]
    }
    if (layers.labels && layers.grid)
      for (const b of BUSES)
        if (!b.external && b.kv === 400 && b.loadShare >= 0.04)
          out.push({
            id: `bus-${b.id}`,
            pos: at(b.lon, b.lat, STATE_TOP + 0.2),
            node: (
              <div className="rounded-full bg-white/90 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-slate-700 shadow-sm ring-1 ring-slate-900/10">
                {b.name.split(' ')[0]}
              </div>
            ),
          })
    if (layers.ties)
      for (const b of BUSES)
        if (b.external) {
          const inj = injections[b.id] ?? 0
          out.push({
            id: `tie-${b.id}`,
            pos: at(b.lon, b.lat, 0.26),
            node: (
              <div className="rounded-full bg-violet-50/95 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-violet-700 shadow-sm ring-1 ring-violet-300/60">
                {b.name.split(' ').slice(0, 3).join(' ')} · {inj > 0 ? 'import' : 'export'} {Math.abs(inj).toFixed(0)} MW
              </div>
            ),
          })
        }
    out.push({
      id: 'sldc',
      pos: at(SLDC.lon, SLDC.lat, STATE_TOP + 1.08),
      node: <div className="rounded-full bg-sky-500 px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap text-white shadow">SLDC</div>,
      priority: 5,
    })
    for (const [id, f] of Object.entries(focus)) {
      const a = ASSET_BY_ID[id]
      if (!a || a.type === 'generation') continue
      const supply = a.type === 'bess'
      out.push({
        id: `tag-${id}`,
        pos: at(a.lon, a.lat, STATE_TOP + (a.type === 'bess' ? 0.36 : 0.12 + (a.baselineMW / 650) * 0.6 + 0.08)),
        priority: 10,
        node: (
          <div className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-slate-900 shadow-sm" style={{ background: STATUS_COLOR[f.status] }}>
            {f.status === 'excluded' ? '✕ removed' : f.status === 'failed' ? '✕ no ack' : `${supply ? '+' : '−'}${Math.abs(f.mw).toFixed(0)} MW`}
          </div>
        ),
      })
    }
    for (const m of markers ?? [])
      out.push({
        id: `mk-${m.id}`,
        pos: at(m.lon, m.lat, STATE_TOP + 1.0),
        priority: 20,
        node: (
          <div className="rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap text-white shadow" style={{ background: MARKER_COLOR[m.tone] }}>
            {m.label}
          </div>
        ),
      })
    return out
  }, [layers, injections, focus, markers])
}
