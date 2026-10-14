import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { BUS_BY_ID, LINE_BY_ID, LINES } from '@/data/topology'
import { loadingColor, project, STATE_TOP } from '@/lib/geo'
import { buildLUT, lutPoint } from '@/lib/vec'
import { useUI as useUIStore } from '@/store/useUI'

/** conductor attachment height above ground by voltage (scene units; exaggerated ~40× like all heights on the map) */
const TOWER_H: Record<number, number> = { 765: 0.12, 400: 0.095, 220: 0.065 }
const SPAN = 0.24 // scene units between towers (~150 km at map scale; real spans are ~400 m, so this is symbolic)

function endpoints(id: string) {
  const l = LINE_BY_ID[id]
  const a = BUS_BY_ID[l.from]
  const b = BUS_BY_ID[l.to]
  const [ax, az] = project(a.lon, a.lat)
  const [bx, bz] = project(b.lon, b.lat)
  return [new THREE.Vector3(ax, a.external ? 0 : STATE_TOP, az), new THREE.Vector3(bx, b.external ? 0 : STATE_TOP, bz)] as const
}

/**
 * Overhead route: towers every SPAN along the straight right-of-way, conductors strung between tower tops with a
 * parabolic sag in each span (a catenary at these sag/span ratios is indistinguishable from a parabola).
 */
function route(a: THREE.Vector3, b: THREE.Vector3, h: number) {
  const len = a.distanceTo(b)
  const spans = Math.max(1, Math.round(len / SPAN))
  const towers: THREE.Vector3[] = []
  const pts: THREE.Vector3[] = []
  const sag = Math.min(0.018, (len / spans) * 0.06)
  const per = 6
  for (let s = 0; s <= spans; s++) {
    const p = a.clone().lerp(b, s / spans)
    towers.push(p)
    if (s === spans) break
    for (let k = 0; k < per; k++) {
      const t = k / per
      const q = a.clone().lerp(b, (s + t) / spans)
      q.y += h - sag * 4 * t * (1 - t)
      pts.push(q)
    }
  }
  pts.push(b.clone().setY(b.y + h))
  // the end towers stand inside substations, which draw their own gantries
  return { pts, towers: towers.slice(1, -1) }
}

/** One lattice tower, 1 unit tall: tapered four-leg body, two cross-arms and a peak (base at y = 0). */
function towerGeometry() {
  const body = new THREE.CylinderGeometry(0.05, 0.26, 1, 4, 1, true)
  body.translate(0, 0.5, 0)
  body.rotateY(Math.PI / 4)
  const arm = new THREE.BoxGeometry(0.95, 0.05, 0.07)
  arm.translate(0, 0.86, 0)
  const arm2 = new THREE.BoxGeometry(0.66, 0.045, 0.06)
  arm2.translate(0, 0.66, 0)
  const peak = new THREE.ConeGeometry(0.07, 0.18, 4)
  peak.translate(0, 1.06, 0)
  const g = mergeGeometries([body.toNonIndexed(), arm.toNonIndexed(), arm2.toNonIndexed(), peak.toNonIndexed()])!
  g.computeVertexNormals()
  return g
}

/** All transmission towers in one instanced draw call, oriented across their line and casting shadows. */
function Towers({ items }: { items: { p: THREE.Vector3; h: number; yaw: number }[] }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const geometry = useMemo(towerGeometry, [])
  useLayoutEffect(() => {
    const m = ref.current
    if (!m) return
    const o = new THREE.Object3D()
    items.forEach((t, i) => {
      o.position.copy(t.p)
      o.rotation.set(0, t.yaw, 0)
      o.scale.set(t.h, t.h, t.h)
      o.updateMatrix()
      m.setMatrixAt(i, o.matrix)
    })
    m.instanceMatrix.needsUpdate = true
    m.computeBoundingSphere()
  }, [items])
  return (
    <instancedMesh ref={ref} args={[geometry, undefined, items.length]} castShadow>
      <meshStandardMaterial color="#8f93a8" metalness={0.55} roughness={0.45} />
    </instancedMesh>
  )
}

export function GridLines({
  flows,
  loading,
  outaged,
  showFlows,
  highlight,
}: {
  flows: Record<string, number>
  loading: Record<string, number>
  outaged: string[]
  showFlows: boolean
  highlight?: string[]
}) {
  const select = useUIStore((s) => s.select)
  const hover = useUIStore((s) => s.hover)
  const selection = useUIStore((s) => s.selection)

  const geo = useMemo(
    () =>
      LINES.map((l) => {
        const [a, b] = endpoints(l.id)
        const len = a.distanceTo(b)
        const h = TOWER_H[l.kv] ?? 0.06
        const r = route(a, b, h)
        // towers stand perpendicular to the line: cross-arms carry the phases side by side
        const yaw = -Math.atan2(b.z - a.z, b.x - a.x) + Math.PI / 2
        return { line: l, pts: r.pts, towers: r.towers.map((p) => ({ p, h, yaw })), a, b, len }
      }),
    [],
  )
  const towers = useMemo(() => geo.flatMap((g) => g.towers), [geo])

  return (
    <group>
      <Towers items={towers} />
      {geo.map(({ line, pts }) => {
        const out = outaged.includes(line.id)
        const v = loading[line.id] ?? 0
        const width = line.kv === 765 ? 3.2 : line.kv === 400 ? 2.2 : 1.3
        const color = out ? '#96a1ae' : line.hvdc ? '#8b7ccd' : loadingColor(v)
        const isSel = selection?.kind === 'line' && selection.id === line.id
        const hl = highlight?.includes(line.id)
        return (
          <group key={line.id}>
            <Line
              points={pts}
              color={color}
              lineWidth={isSel || hl ? width + 2.5 : width}
              dashed={out}
              dashSize={0.08}
              gapSize={0.06}
              transparent
              opacity={out ? 0.6 : 0.95}
              onClick={(e) => {
                e.stopPropagation()
                select({ kind: 'line', id: line.id })
              }}
              onPointerOver={(e) => {
                e.stopPropagation()
                hover({ kind: 'line', id: line.id })
              }}
              onPointerOut={() => hover(null)}
            />
            {(v >= 1 || hl) && !out && <Line points={pts} color={v >= 1 ? '#b83b3a' : '#c8622a'} lineWidth={width + 7} transparent opacity={0.18} />}
          </group>
        )
      })}
      {showFlows && <FlowParticles geo={geo} flows={flows} loading={loading} outaged={outaged} />}
    </group>
  )
}

const PER_LINE = 6

function FlowParticles({
  geo,
  flows,
  loading,
  outaged,
}: {
  geo: { line: (typeof LINES)[number]; pts: THREE.Vector3[]; len: number }[]
  flows: Record<string, number>
  loading: Record<string, number>
  outaged: string[]
}) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const phase = useRef(new Float32Array(geo.length * PER_LINE).map((_, i) => (i % PER_LINE) / PER_LINE))
  const data = useRef({ flows, loading, out: new Set(outaged) })
  useEffect(() => {
    data.current = { flows, loading, out: new Set(outaged) }
  }, [flows, loading, outaged])
  // arc-length lookup tables, built once: per-frame sampling is an index + lerp with no allocation
  const luts = useMemo(() => geo.map((g) => buildLUT(new THREE.CatmullRomCurve3(g.pts), 64)), [geo])
  const tmp = useMemo(() => new THREE.Object3D(), [])
  const col = useMemo(() => new THREE.Color(), [])

  useFrame((_, dt) => {
    const m = ref.current
    if (!m) return
    const { flows: f, loading: ld, out } = data.current
    geo.forEach((g, li) => {
      const flow = f[g.line.id] ?? 0
      const v = ld[g.line.id] ?? 0
      const active = Math.abs(flow) > 15 && !out.has(g.line.id)
      const n = active ? Math.max(2, Math.min(PER_LINE, Math.round(2 + v * 4))) : 0
      const speed = (0.08 + Math.min(1.4, Math.abs(flow) / 1500) * 0.35) / Math.max(0.6, g.len)
      for (let k = 0; k < PER_LINE; k++) {
        const idx = li * PER_LINE + k
        if (k >= n) {
          tmp.scale.setScalar(0)
          tmp.updateMatrix()
          m.setMatrixAt(idx, tmp.matrix)
          continue
        }
        phase.current[idx] = (phase.current[idx] + dt * speed) % 1
        const t = flow >= 0 ? phase.current[idx] : 1 - phase.current[idx]
        lutPoint(luts[li], t, tmp.position)
        tmp.scale.setScalar(g.line.kv === 220 ? 0.65 : 1)
        tmp.updateMatrix()
        m.setMatrixAt(idx, tmp.matrix)
        col.set(g.line.hvdc ? '#5c4c9b' : v >= 1 ? '#982e2d' : v >= 0.9 ? '#a9501f' : '#5735cf')
        m.setColorAt(idx, col)
      }
    })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
  })

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, geo.length * PER_LINE]} frustumCulled={false}>
      <sphereGeometry args={[0.022, 8, 8]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}
