// Live-bound topology registry, filled once from GET /api/v1/topology.
// ES-module `let` exports are live bindings, so 3D components read the loaded model directly.
import type { Asset, Bus, Generator, GenStation, Line, LoadChannel, RosterGroupDef, Topology } from './types'

export let BUSES: Bus[] = []
export let LINES: Line[] = []
export let GENERATORS: Generator[] = []
export let ASSETS: Asset[] = []
export let LOAD_CHANNELS: LoadChannel[] = []
export let GEN_STATIONS: GenStation[] = []
export let KARNATAKA_BOUNDARY: [number, number][] = []
export let SLDC = { name: 'KPTCL SLDC', lon: 77.585, lat: 12.975 }
export let BUS_BY_ID: Record<string, Bus> = {}
export let ASSET_BY_ID: Record<string, Asset> = {}
export let LINE_BY_ID: Record<string, Line> = {}
export let GEN_BY_ID: Record<string, Generator> = {}
export let CHANNEL_BY_ID: Record<string, LoadChannel> = {}
export let STATION_BY_ID: Record<string, GenStation> = {}
export let ROSTER: RosterGroupDef[] = []
/** 220 kV station → its load-shedding roster group */
export let GROUP_OF_CHANNEL: Record<string, RosterGroupDef> = {}

export function setTopology(t: Topology) {
  BUSES = t.buses
  LINES = t.lines
  GENERATORS = t.generators
  ASSETS = t.assets
  LOAD_CHANNELS = t.channels.load_channels
  GEN_STATIONS = t.channels.gen_stations
  KARNATAKA_BOUNDARY = t.boundary
  SLDC = t.sldc
  BUS_BY_ID = Object.fromEntries(t.buses.map((b) => [b.id, b]))
  ASSET_BY_ID = Object.fromEntries(t.assets.map((a) => [a.id, a]))
  LINE_BY_ID = Object.fromEntries(t.lines.map((l) => [l.id, l]))
  GEN_BY_ID = Object.fromEntries(t.generators.map((g) => [g.id, g]))
  CHANNEL_BY_ID = Object.fromEntries(t.channels.load_channels.map((c) => [c.id, c]))
  STATION_BY_ID = Object.fromEntries(t.channels.gen_stations.map((g) => [g.id, g]))
  ROSTER = t.roster ?? []
  GROUP_OF_CHANNEL = Object.fromEntries(ROSTER.flatMap((g) => g.channels.map((c) => [c, g])))
}

export function lineLabel(id: string) {
  const l = LINE_BY_ID[id]
  if (!l) return id
  if (l.name) return l.name
  return `${BUS_BY_ID[l.from]?.name.split(' ')[0]}–${BUS_BY_ID[l.to]?.name.split(' ')[0]} ${l.kv} kV`
}

export const DISCOM_COLORS: Record<string, string> = {
  BESCOM: '#5c8cc6',
  MESCOM: '#2a9387',
  HESCOM: '#8b7ccd',
  GESCOM: '#c07e18',
  CESC: '#b8577e',
  KPCL: '#96a1ae',
  IPP: '#96a1ae',
}

export const ASSET_TYPE_META: Record<string, { label: string; color: string; letter: string }> = {
  interruptible: { label: 'Interruptible', color: '#2a9387', letter: 'A' },
  shiftable: { label: 'Shiftable', color: '#6f9a3a', letter: 'B' },
  bess: { label: 'BESS', color: '#2a6f8f', letter: 'C' },
  industrial: { label: 'Industrial', color: '#c07e18', letter: 'D' },
  der: { label: 'DER / EV', color: '#7160b8', letter: 'E' },
  generation: { label: 'Generation', color: '#6a7686', letter: 'G' },
  rtm: { label: 'Market', color: '#4a5aa8', letter: 'M' },
}
