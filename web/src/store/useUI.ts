import { create } from 'zustand'
import { worldOf } from '@/lib/spatial'

export type Page = 'command' | 'operations' | 'decisions' | 'shedding' | 'alarms' | 'analysis' | 'whatif' | 'simulator' | 'resources' | 'reports' | 'admin'

export type CameraPreset = 'STATE' | 'BENGALURU' | 'NORTH' | 'COAST' | 'TILT'

export interface MapLayers {
  grid: boolean
  flows: boolean
  generation: boolean
  dr: boolean
  bess: boolean
  labels: boolean
  ties: boolean
  heat: boolean
  ch220: boolean
  genStations: boolean
}

export type Selection = { kind: 'bus' | 'asset' | 'gen' | 'line' | 'channel' | 'station' | 'event'; id: string } | null

/** Camera fly-to request in world space (x, z on the ground plane; dist = how far back the camera sits). */
export interface FlyTo {
  x: number
  z: number
  dist: number
}

interface UIState {
  page: Page
  decisionId: string | null
  layers: MapLayers
  camera: CameraPreset
  cameraNonce: number
  selection: Selection
  hovered: Selection
  fly: FlyTo | null
  /** event playback position (unix seconds); null = follow live */
  playhead: number | null
  go: (p: Page, decisionId?: string | null) => void
  toggleLayer: (k: keyof MapLayers) => void
  setCamera: (c: CameraPreset) => void
  select: (s: Selection) => void
  hover: (s: Selection) => void
  /** select and fly the camera to it */
  focus: (s: Selection, to: FlyTo | null) => void
  setPlayhead: (t: number | null) => void
  /** open the map workspace on a DR event, optionally rewound to a moment for replay */
  showEvent: (id: string, participants: string[], from?: number | null) => void
}

export const useUI = create<UIState>((set) => ({
  page: 'command',
  decisionId: null,
  layers: { grid: true, flows: true, generation: true, dr: true, bess: true, labels: true, ties: true, heat: true, ch220: true, genStations: true },
  camera: 'STATE',
  cameraNonce: 0,
  selection: null,
  hovered: null,
  fly: null,
  playhead: null,
  // each page opens on the state-wide view; a fly-to left over from another page would frame the wrong place
  go: (page, decisionId) => set((s) => ({ page, decisionId: decisionId === undefined ? s.decisionId : decisionId, selection: null, playhead: null, fly: null, camera: 'STATE' })),
  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
  setCamera: (camera) => set((s) => ({ camera, fly: null, cameraNonce: s.cameraNonce + 1 })),
  // selecting a place on the map always flies to it; clearing keeps the camera where it is
  select: (selection) =>
    set((s) => {
      const to = selection && selection.kind !== 'event' ? worldOf(selection) : null
      return to ? { selection, fly: to, cameraNonce: s.cameraNonce + 1 } : { selection }
    }),
  hover: (hovered) => set({ hovered }),
  focus: (selection, fly) => set((s) => ({ selection, fly, cameraNonce: s.cameraNonce + 1, playhead: selection?.kind === 'event' ? s.playhead : null })),
  setPlayhead: (playhead) => set({ playhead }),
  showEvent: (id, participants, from = null) =>
    set((s) => ({
      page: 'command',
      decisionId: id,
      selection: { kind: 'event', id },
      fly: worldOf({ kind: 'event', id }, participants),
      cameraNonce: s.cameraNonce + 1,
      playhead: from,
    })),
}))
