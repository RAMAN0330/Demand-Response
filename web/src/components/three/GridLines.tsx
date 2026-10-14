import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import { BUS_BY_ID, LINE_BY_ID, LINES } from '@/data/topology'
import { loadingColor, project, STATE_TOP } from '@/lib/geo'
import { buildLUT, lutPoint } from '@/lib/vec'
import { useUI as useUIStore } from '@/store/useUI'

const LINE_Y = STATE_TOP + 0.05

function endpoints(id: string) {
  const l = LINE_BY_ID[id]
  const a = BUS_BY_ID[l.from]
  const b = BUS_BY_ID[l.to]
  const [ax, az] = project(a.lon, a.lat)
  const [bx, bz] = project(b.lon, b.lat)
  const ya = a.external ? 0.06 : LINE_Y
  const yb = b.external ? 0.06 : LINE_Y
  return [new THREE.Vector3(ax, ya, az), new THREE.Vector3(bx, yb, bz)] as const
}

// gentle arc so lines read as overhead conductors
function arc(a: THREE.Vector3, b: THREE.Vector3, lift: number, n = 16) {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const p = a.clone().lerp(b, t)
    p.y += Math.sin(Math.PI * t) * lift
    pts.push(p)
  }
  return pts
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
        return { line: l, pts: arc(a, b, 0.04 + len * 0.03), a, b, len }
      }),
    [],
  )

  return (
    <group>
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
        col.set(g.line.hvdc ? '#5c4c9b' : v >= 1 ? '#982e2d' : v >= 0.9 ? '#a9501f' : '#2a5894')
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
