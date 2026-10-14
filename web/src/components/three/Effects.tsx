import { useEffect, useMemo, useRef, type RefObject } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { Line, OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { KARNATAKA_BOUNDARY, SLDC } from '@/data/topology'
import { project, STATE_TOP } from '@/lib/geo'
export type DispatchPhase = 'idle' | 'sending' | 'acking' | 'ramping' | 'done'
import { useUI as useUIStore, type CameraPreset } from '@/store/useUI'

export interface WaveTarget {
  id: string
  lon: number
  lat: number
  ok: boolean
}

/** SLDC → assets command wave (outbound amber), acknowledgements return green. */
export function CommandWave({ targets, phase }: { targets: WaveTarget[]; phase: DispatchPhase }) {
  const [sx, sz] = project(SLDC.lon, SLDC.lat)
  const start = useMemo(() => new THREE.Vector3(sx, STATE_TOP + 0.9, sz), [sx, sz])
  const curves = useMemo(
    () =>
      targets.map((t) => {
        const [x, z] = project(t.lon, t.lat)
        const end = new THREE.Vector3(x, STATE_TOP + 0.15, z)
        const mid = start.clone().lerp(end, 0.5)
        mid.y += 0.6 + start.distanceTo(end) * 0.15
        return { t, curve: new THREE.QuadraticBezierCurve3(start, mid, end) }
      }),
    [targets, start],
  )
  const dots = useRef<(THREE.Mesh | null)[]>([])
  const ring = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    const time = clock.elapsedTime
    curves.forEach(({ t, curve }, i) => {
      const m = dots.current[i]
      if (!m) return
      let u: number
      let color = '#c07e18'
      if (phase === 'sending') u = Math.min(1, ((time * 0.9 + i * 0.07) % 1.4) / 1)
      else if (phase === 'acking') {
        u = 1 - ((time * 0.9 + i * 0.05) % 1.2) / 1.2
        color = t.ok ? '#47a37b' : '#b83b3a'
        if (!t.ok) u = 1
      } else {
        u = (time * 0.35 + i * 0.13) % 1
        color = t.ok ? '#47a37b' : '#b83b3a'
      }
      m.position.copy(curve.getPoint(u))
      ;(m.material as THREE.MeshBasicMaterial).color.set(color)
    })
    if (ring.current) {
      const k = (time * 0.8) % 1
      ring.current.scale.setScalar(0.3 + k * 6)
      ;(ring.current.material as THREE.MeshBasicMaterial).opacity = phase === 'sending' ? 0.6 * (1 - k) : 0
    }
  })
  if (phase === 'idle' || !targets.length) return null
  return (
    <group>
      {curves.map(({ t, curve }, i) => (
        <group key={t.id}>
          <Line
            points={curve.getPoints(30)}
            color={phase === 'sending' ? '#c07e18' : t.ok ? '#47a37b' : '#b83b3a'}
            lineWidth={1.8}
            transparent
            opacity={phase === 'done' ? 0.35 : 0.85}
            dashed
            dashSize={0.05}
            gapSize={0.04}
          />
          <mesh ref={(el) => (dots.current[i] = el)}>
            <sphereGeometry args={[0.035, 10, 10]} />
            <meshBasicMaterial toneMapped={false} />
          </mesh>
        </group>
      ))}
      <mesh ref={ring} position={[sx, STATE_TOP + 0.02, sz]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.18, 0.2, 64]} />
        <meshBasicMaterial color="#c07e18" transparent opacity={0} toneMapped={false} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  )
}

const PRESETS: Record<CameraPreset, { pos: [number, number, number]; target: [number, number, number] }> = (() => {
  const t = (lon: number, lat: number): [number, number, number] => {
    const [x, z] = project(lon, lat)
    return [x, 0, z]
  }
  const blr = t(77.5, 12.95)
  const north = t(76.6, 16.4)
  const coast = t(74.9, 14.0)
  return {
    STATE: { pos: [0.4, 11.2, 8.8], target: [0, 0, 0.4] },
    BENGALURU: { pos: [blr[0] + 1.3, 3.6, blr[2] + 3.4], target: blr },
    NORTH: { pos: [north[0] + 0.5, 4.6, north[2] + 4.2], target: north },
    COAST: { pos: [coast[0] - 3, 3.4, coast[2] + 2.6], target: coast },
    TILT: { pos: [5.2, 6.4, 9.4], target: [0, 0, 0.6] },
  }
})()

/**
 * Fit a whole-state view to the viewport: keep the preset's viewing direction, tilt further towards the horizon in
 * wide, short panels (the state is taller than it is wide, so a steeper look-down leaves the sides empty), then find
 * the closest distance at which every boundary point projects inside the frame. Bisection on distance, ~20 steps.
 */
function fitStateView(preset: 'STATE' | 'TILT', aspect: number, fov: number): { pos: THREE.Vector3; target: THREE.Vector3 } {
  const p = PRESETS[preset]
  const target = new THREE.Vector3(...p.target)
  const dir = new THREE.Vector3(...p.pos).sub(target).normalize()
  if (aspect > 1.5) {
    // lower the elevation: blend the direction towards the horizontal component
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize()
    const k = Math.min(0.45, (aspect - 1.5) * 0.35)
    dir.lerp(flat, k).normalize()
  }
  const pts = (
    KARNATAKA_BOUNDARY.length
      ? KARNATAKA_BOUNDARY
      : [
          [74, 11.5],
          [78.6, 18.5],
        ]
  ).map(([lon, lat]) => {
    const [x, z] = project(lon, lat)
    return new THREE.Vector3(x, STATE_TOP, z)
  })
  // centre the target on the outline's bounding box so the fit is symmetric
  const box = new THREE.Box3().setFromPoints(pts)
  box.getCenter(target).setY(0)
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.05, 200)
  const v = new THREE.Vector3()
  const fits = (d: number) => {
    cam.position.copy(target).addScaledVector(dir, d)
    cam.lookAt(target)
    cam.updateMatrixWorld()
    for (const q of pts) {
      v.copy(q).project(cam)
      if (Math.abs(v.x) > 0.94 || Math.abs(v.y) > 0.9 || v.z > 1) return false
    }
    return true
  }
  let lo = 2
  let hi = 30
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) hi = mid
    else lo = mid
  }
  return { pos: target.clone().addScaledVector(dir, hi), target }
}

export function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null)
  const { camera, size } = useThree()
  const camPreset = useUIStore((s) => s.camera)
  const nonce = useUIStore((s) => s.cameraNonce)
  const fly = useUIStore((s) => s.fly)
  const anim = useRef<{ t: number; fromPos: THREE.Vector3; fromTarget: THREE.Vector3; toPos: THREE.Vector3; toTarget: THREE.Vector3 } | null>(null)
  // whole-state presets re-fit when the panel's shape changes (rounded so live resizing doesn't thrash)
  const aspect = Math.round((size.width / Math.max(1, size.height)) * 10) / 10

  // a fly-to (selection) wins over the preset; both animate from wherever the camera is now
  useEffect(() => {
    if (!controls.current) return
    let toPos: THREE.Vector3
    let toTarget: THREE.Vector3
    if (fly) {
      toTarget = new THREE.Vector3(fly.x, 0, fly.z)
      // keep a consistent oblique view from the south-east so labels stay readable
      toPos = new THREE.Vector3(fly.x + fly.dist * 0.18, fly.dist * 0.95, fly.z + fly.dist * 0.72)
    } else if (camPreset === 'STATE' || camPreset === 'TILT') {
      const f = fitStateView(camPreset, aspect, (camera as THREE.PerspectiveCamera).fov ?? 42)
      toPos = f.pos
      toTarget = f.target
    } else {
      const p = PRESETS[camPreset]
      toPos = new THREE.Vector3(...p.pos)
      toTarget = new THREE.Vector3(...p.target)
    }
    anim.current = { t: 0, fromPos: camera.position.clone(), fromTarget: controls.current.target.clone(), toPos, toTarget }
  }, [camPreset, nonce, fly, camera, aspect])

  useFrame((_, dt) => {
    const a = anim.current
    if (!a || !controls.current) return
    a.t = Math.min(1, a.t + dt / 1.1)
    const e = 1 - Math.pow(1 - a.t, 3)
    camera.position.lerpVectors(a.fromPos, a.toPos, e)
    controls.current.target.lerpVectors(a.fromTarget, a.toTarget, e)
    controls.current.update()
    if (a.t >= 1) anim.current = null
  })

  return <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.08} minDistance={1.2} maxDistance={30} maxPolarAngle={Math.PI / 2.15} target={[0, 0, 0.4]} />
}

/** Light beams over affected participants (selection context): a soft column plus a pulsing ground ring. */
export function Beacons({ points, color = '#3a6fb0' }: { points: { id: string; lon: number; lat: number }[]; color?: string }) {
  const rings = useRef<(THREE.Mesh | null)[]>([])
  useFrame(({ clock }) => {
    rings.current.forEach((m, i) => {
      if (!m) return
      const k = (clock.elapsedTime * 0.7 + i * 0.17) % 1
      m.scale.setScalar(0.6 + k * 1.6)
      ;(m.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - k)
    })
  })
  return (
    <group>
      {points.map((p, i) => {
        const [x, z] = project(p.lon, p.lat)
        return (
          <group key={p.id} position={[x, STATE_TOP, z]}>
            <mesh position={[0, 0.45, 0]}>
              <cylinderGeometry args={[0.012, 0.05, 0.9, 12, 1, true]} />
              <meshBasicMaterial color={color} transparent opacity={0.28} toneMapped={false} depthWrite={false} side={THREE.DoubleSide} />
            </mesh>
            <mesh ref={(el) => (rings.current[i] = el)} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
              <ringGeometry args={[0.1, 0.13, 40]} />
              <meshBasicMaterial color={color} transparent opacity={0.5} toneMapped={false} depthWrite={false} side={THREE.DoubleSide} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}

/** Positions a DOM card beside the screen projection of a world point, clamped inside the viewport. */
function placeCard(
  d: HTMLDivElement,
  point: [number, number, number] | null,
  camera: THREE.Camera,
  size: { width: number; height: number },
  v: THREE.Vector3,
  side: 'right' | 'left',
) {
  if (!point) {
    d.style.opacity = '0'
    return
  }
  v.set(...point).project(camera)
  const px = ((v.x + 1) / 2) * size.width
  const py = ((1 - v.y) / 2) * size.height
  const w = d.offsetWidth
  const h = d.offsetHeight
  const gap = 22
  let x = side === 'right' ? px + gap : px - gap - w
  if (x + w > size.width - 8) x = px - gap - w
  if (x < 8) x = Math.min(size.width - w - 8, px + gap)
  const y = Math.max(8, Math.min(size.height - h - 8, py - h / 2))
  d.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
  d.style.opacity = v.z > 1 ? '0' : '1'
}

/** Keeps a DOM card pinned beside a world-space point (updated imperatively every frame, like the label layer). */
export function AnchorProjector({ point, el, side = 'right' }: { point: [number, number, number] | null; el: RefObject<HTMLDivElement | null>; side?: 'right' | 'left' }) {
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ camera, size }) => {
    if (el.current) placeCard(el.current, point, camera, size, v, side)
  })
  return null
}
