import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { ASSET_TYPE_META, BUSES, GENERATORS, SLDC, BUS_BY_ID } from '@/data/topology'
import type { Asset as FlexAsset, Generator } from '@/data/types'
import { loadingColor, project, STATE_TOP } from '@/lib/geo'
import { useUI as useUIStore, type Selection } from '@/store/useUI'

import { STATUS_COLOR, type Focus, type FocusStatus } from './focus'

const Y = STATE_TOP

function useInteract(sel: NonNullable<Selection>) {
  const select = useUIStore((s) => s.select)
  const hover = useUIStore((s) => s.hover)
  return {
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation()
      select(sel)
    },
    onPointerOver: (e: { stopPropagation: () => void }) => {
      e.stopPropagation()
      hover(sel)
      document.body.style.cursor = 'pointer'
    },
    onPointerOut: () => {
      hover(null)
      document.body.style.cursor = 'auto'
    },
  }
}

export function Substations({ stress }: { stress: Record<string, number> }) {
  return (
    <group>
      {BUSES.filter((b) => !b.external).map((b) => (
        <Substation key={b.id} id={b.id} stress={stress[b.id] ?? 0} />
      ))}
    </group>
  )
}

function Substation({ id, stress }: { id: string; stress: number }) {
  const b = BUS_BY_ID[id]
  const [x, z] = project(b.lon, b.lat)
  const r = b.kv === 400 ? 0.065 : 0.045
  const handlers = useInteract({ kind: 'bus', id })
  const selected = useUIStore((s) => s.selection?.kind === 'bus' && s.selection.id === id)
  const col = loadingColor(stress)
  return (
    <group position={[x, Y, z]}>
      <mesh castShadow position={[0, 0.06, 0]} {...handlers}>
        <cylinderGeometry args={[r, r * 1.15, 0.12, 6]} />
        <meshStandardMaterial color="#f6f7f9" emissive={col} emissiveIntensity={0.35} metalness={0.1} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.125, 0]}>
        <cylinderGeometry args={[r * 0.45, r * 0.45, 0.01, 12]} />
        <meshBasicMaterial color={col} toneMapped={false} />
      </mesh>
      {selected && <PulseRing color="#8d76ee" radius={0.16} />}
    </group>
  )
}

export function PulseRing({ color, radius = 0.2, speed = 1.6 }: { color: string; radius?: number; speed?: number }) {
  const ref = useRef<THREE.Mesh>(null)
  const mat = useRef<THREE.MeshBasicMaterial>(null)
  useFrame(({ clock }) => {
    const t = (clock.elapsedTime * speed) % 1
    if (ref.current) ref.current.scale.setScalar(0.6 + t * 0.9)
    if (mat.current) mat.current.opacity = 0.9 * (1 - t)
  })
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
      <ringGeometry args={[radius * 0.82, radius, 40]} />
      <meshBasicMaterial ref={mat} color={color} transparent toneMapped={false} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  )
}

export function Generators({ output, focus }: { output: Record<string, number>; focus: Focus }) {
  return (
    <group>
      {GENERATORS.map((g) => (
        <GeneratorNode
          key={g.id}
          g={g}
          mw={output[g.id] ?? 0}
          focused={Object.keys(focus).some((k) => (k === 'A_YTPS' && g.id === 'G_YTPS') || (k === 'A_SHV' && g.id === 'G_SHV'))}
        />
      ))}
    </group>
  )
}

function GeneratorNode({ g, mw, focused }: { g: Generator; mw: number; focused: boolean }) {
  const [x, z] = project(g.lon, g.lat)
  const handlers = useInteract({ kind: 'gen', id: g.id })
  const util = mw / g.capacityMW
  const rotor = useRef<THREE.Group>(null)
  useFrame((_, dt) => {
    if (rotor.current) rotor.current.rotation.z += dt * (0.5 + util * 6)
  })
  const h = 0.1 + (mw / 2000) * 0.55
  return (
    <group position={[x, Y, z]} {...handlers}>
      {g.type === 'coal' && (
        <group>
          <mesh castShadow position={[0, 0.05, 0]}>
            <boxGeometry args={[0.18, 0.1, 0.12]} />
            <meshStandardMaterial color="#4d5867" roughness={0.8} />
          </mesh>
          {[-0.05, 0.05].map((dx) => (
            <mesh castShadow key={dx} position={[dx, h / 2 + 0.05, -0.02]}>
              <cylinderGeometry args={[0.022, 0.032, h, 10]} />
              <meshStandardMaterial color="#96a1ae" emissive="#c8622a" emissiveIntensity={0.25 * util} />
            </mesh>
          ))}
        </group>
      )}
      {g.type === 'hydro' && (
        <group>
          <mesh castShadow position={[0, 0.06, 0]}>
            <boxGeometry args={[0.22, 0.12, 0.05]} />
            <meshStandardMaterial color="#6a7686" />
          </mesh>
          <mesh position={[0, 0.03, 0.09]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.26, 0.14]} />
            <meshStandardMaterial color="#3a6fb0" emissive="#2a5894" emissiveIntensity={0.6 * util + 0.2} transparent opacity={0.85} />
          </mesh>
        </group>
      )}
      {g.type === 'nuclear' && (
        <group>
          <mesh castShadow position={[0, 0.06, 0]}>
            <cylinderGeometry args={[0.08, 0.08, 0.12, 20]} />
            <meshStandardMaterial color="#dde2e8" />
          </mesh>
          <mesh castShadow position={[0, 0.12, 0]}>
            <sphereGeometry args={[0.08, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <meshStandardMaterial color="#eceff3" emissive="#8b7ccd" emissiveIntensity={0.3} />
          </mesh>
        </group>
      )}
      {g.type === 'solar' && (
        <group>
          {Array.from({ length: 9 }, (_, i) => (
            <mesh key={i} position={[((i % 3) - 1) * 0.11, 0.03, (Math.floor(i / 3) - 1) * 0.08]} rotation={[-Math.PI / 3, 0, 0]}>
              <boxGeometry args={[0.1, 0.006, 0.06]} />
              <meshStandardMaterial color="#3b5bdb" emissive="#d9b23a" emissiveIntensity={0.15 + util * 0.9} metalness={0.6} roughness={0.3} />
            </mesh>
          ))}
        </group>
      )}
      {g.type === 'wind' && (
        <group>
          {[-0.08, 0.08].map((dx, i) => (
            <group key={dx} position={[dx, 0, i * 0.06]}>
              <mesh castShadow position={[0, 0.17, 0]}>
                <cylinderGeometry args={[0.006, 0.01, 0.34, 6]} />
                <meshStandardMaterial color="#dde2e8" />
              </mesh>
              <group ref={i === 0 ? rotor : undefined} position={[0, 0.34, 0.012]}>
                {[0, 1, 2].map((k) => (
                  <mesh key={k} rotation={[0, 0, (k * 2 * Math.PI) / 3]} position={[0, 0, 0]}>
                    <boxGeometry args={[0.012, 0.16, 0.004]} />
                    <meshStandardMaterial color="#f6f7f9" emissive="#9bbf5a" emissiveIntensity={util * 0.6} />
                  </mesh>
                ))}
              </group>
            </group>
          ))}
        </group>
      )}
      {focused && <PulseRing color="#9bbf5a" radius={0.22} />}
    </group>
  )
}

export function FlexAssets({ assets, focus, layers }: { assets: FlexAsset[]; focus: Focus; layers: { dr: boolean; bess: boolean } }) {
  return (
    <group>
      {assets
        .filter((a) => a.type !== 'generation')
        .filter((a) => (a.type === 'bess' ? layers.bess : layers.dr))
        .map((a) => (a.type === 'bess' ? <BessNode key={a.id} a={a} focus={focus[a.id]} /> : <LoadNode key={a.id} a={a} focus={focus[a.id]} />))}
    </group>
  )
}

function LoadNode({ a, focus }: { a: FlexAsset; focus?: { mw: number; status: FocusStatus } }) {
  const [x, z] = project(a.lon, a.lat)
  const handlers = useInteract({ kind: 'asset', id: a.id })
  const meta = ASSET_TYPE_META[a.type]
  const delivering = focus && (focus.status === 'delivering' || focus.status === 'acked')
  const load = a.baselineMW - (delivering ? focus.mw : 0)
  const h = 0.06 + (load / 650) * 0.6
  const haloR = 0.07 + Math.sqrt(a.reserve.state) / 70
  const tower = a.type === 'industrial'
  return (
    <group position={[x, Y, z]} {...handlers}>
      {tower ? (
        <mesh castShadow position={[0, h / 2, 0]}>
          <boxGeometry args={[0.07, h, 0.07]} />
          <meshStandardMaterial color={meta.color} emissive={meta.color} emissiveIntensity={0.15} />
        </mesh>
      ) : (
        <group>
          {[
            [-0.035, 0],
            [0.035, 0.02],
            [0, -0.04],
          ].map(([dx, dz], i) => (
            <mesh castShadow key={i} position={[dx, (h * (0.6 + i * 0.2)) / 2, dz]}>
              <boxGeometry args={[0.04, h * (0.6 + i * 0.2), 0.04]} />
              <meshStandardMaterial color={meta.color} emissive={meta.color} emissiveIntensity={0.15} />
            </mesh>
          ))}
        </group>
      )}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]}>
        <ringGeometry args={[haloR * 0.8, haloR, 32]} />
        <meshBasicMaterial color={focus ? STATUS_COLOR[focus.status] : meta.color} transparent opacity={focus ? 0.95 : 0.4} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      {focus && <PulseRing color={STATUS_COLOR[focus.status]} radius={haloR + 0.08} />}
    </group>
  )
}

function BessNode({ a, focus }: { a: FlexAsset; focus?: { mw: number; status: FocusStatus } }) {
  const [x, z] = project(a.lon, a.lat)
  const handlers = useInteract({ kind: 'asset', id: a.id })
  const w = 0.08 + a.maxLoadMW / 1200
  const H = 0.22
  const soc = a.bess?.soc ?? 0.5
  const fill = useRef<THREE.Mesh>(null)
  // one edges geometry per battery size (a new BoxGeometry in JSX args would rebuild and leak on every render)
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(w, H, w * 0.6)), [w])
  useEffect(() => () => edges.dispose(), [edges])
  useFrame(({ clock }) => {
    if (!fill.current) return
    const pulse = focus ? 0.4 + Math.sin(clock.elapsedTime * 5) * 0.3 : 0.6
    ;(fill.current.material as THREE.MeshStandardMaterial).emissiveIntensity = pulse
  })
  return (
    <group position={[x, Y, z]} {...handlers}>
      <mesh position={[0, H / 2, 0]}>
        <boxGeometry args={[w, H, w * 0.6]} />
        <meshStandardMaterial color="#ffffff" transparent opacity={0.55} />
      </mesh>
      <lineSegments position={[0, H / 2, 0]} geometry={edges}>
        <lineBasicMaterial color="#2a8761" />
      </lineSegments>
      <mesh ref={fill} position={[0, (H * soc) / 2, 0]}>
        <boxGeometry args={[w * 0.86, H * soc, w * 0.5]} />
        <meshStandardMaterial color="#2a8761" emissive="#34d399" emissiveIntensity={0.6} />
      </mesh>
      {focus && <PulseRing color={STATUS_COLOR[focus.status]} radius={w + 0.1} />}
    </group>
  )
}

export function TieArrows() {
  return (
    <group>
      {BUSES.filter((b) => b.external).map((b) => {
        const [x, z] = project(b.lon, b.lat)
        return (
          <group key={b.id} position={[x, 0.06, z]}>
            <mesh>
              <octahedronGeometry args={[0.07]} />
              <meshStandardMaterial color="#c084fc" emissive="#7160b8" emissiveIntensity={0.8} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}

export function SldcBeacon() {
  const [x, z] = project(SLDC.lon, SLDC.lat)
  const ref = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    if (ref.current) (ref.current.material as THREE.MeshBasicMaterial).opacity = 0.35 + Math.sin(clock.elapsedTime * 2) * 0.15
  })
  return (
    <group position={[x, Y, z]}>
      <mesh ref={ref} position={[0, 0.45, 0]}>
        <cylinderGeometry args={[0.012, 0.03, 0.9, 8]} />
        <meshBasicMaterial color="#8d76ee" transparent opacity={0.6} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.92, 0]}>
        <sphereGeometry args={[0.04, 16, 16]} />
        <meshBasicMaterial color="#b1a3f6" toneMapped={false} />
      </mesh>
    </group>
  )
}
