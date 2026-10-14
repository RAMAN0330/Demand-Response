import { useMemo } from 'react'
import * as THREE from 'three'
import { Line } from '@react-three/drei'
import { BUSES, KARNATAKA_BOUNDARY } from '@/data/topology'
import { project, shapeXY, STATE_TOP, unproject } from '@/lib/geo'
import { elevation } from '@/lib/terrain'

/** Extruded Karnataka landmass with a glowing border and a terrain-like gradient. */
export function StateShape() {
  const geometry = useMemo(() => {
    const shape = new THREE.Shape()
    KARNATAKA_BOUNDARY.forEach(([lon, lat], i) => {
      const [x, y] = shapeXY(lon, lat)
      if (i === 0) shape.moveTo(x, y)
      else shape.lineTo(x, y)
    })
    const g = new THREE.ExtrudeGeometry(shape, { depth: STATE_TOP, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.02, bevelSegments: 2 })
    g.rotateX(-Math.PI / 2)
    // vertex colours: Western Ghats (west) darker green-teal, Deccan plateau (east) slate blue
    const pos = g.attributes.position
    const colors = new Float32Array(pos.count * 3)
    const c = new THREE.Color()
    const west = new THREE.Color('#d5ede0')
    const east = new THREE.Color('#e7e3fd')
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const t = THREE.MathUtils.clamp((x + 3.2) / 6.5, 0, 1)
      c.copy(west).lerp(east, t)
      if (pos.getY(i) < STATE_TOP - 0.01) c.multiplyScalar(0.86)
      colors.set([c.r, c.g, c.b], i * 3)
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    return g
  }, [])

  const outline = useMemo(
    () =>
      KARNATAKA_BOUNDARY.map(([lon, lat]) => {
        const [x, z] = project(lon, lat)
        return new THREE.Vector3(x, STATE_TOP + 0.022, z)
      }),
    [],
  )

  return (
    <group>
      <mesh geometry={geometry} receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.95} metalness={0} emissive="#f3f1fe" emissiveIntensity={0.28} />
      </mesh>
      <Terrain />
      <Line points={outline} color="#7c5ae8" lineWidth={2} transparent opacity={0.9} />
      <Line points={outline.map((p) => new THREE.Vector3(p.x, 0.005, p.z))} color="#d2cafb" lineWidth={1} transparent opacity={0.5} />
    </group>
  )
}

// hypsometric tints, kept pastel so line-loading and alarm colours stay the loudest thing on the map
const LOW = new THREE.Color('#e9f3e3') // coastal plain
const MID = new THREE.Color('#f5efdf') // Deccan plateau
const HIGH = new THREE.Color('#b3d6a6') // forested Ghats
const RELIEF = 0.022 // scene units at elevation 1 (vertical exaggeration stays small so objects sit on the ground)

/**
 * Relief surface over the state: a grid displaced by `elevation`, vertex-coloured by height with a baked hillshade
 * (light from the north-west, as on survey maps), clipped to the state outline with an alpha mask.
 */
function Terrain() {
  const { geometry, mask } = useMemo(() => {
    const xz = KARNATAKA_BOUNDARY.map(([lon, lat]) => project(lon, lat))
    const minX = Math.min(...xz.map((p) => p[0]))
    const maxX = Math.max(...xz.map((p) => p[0]))
    const minZ = Math.min(...xz.map((p) => p[1]))
    const maxZ = Math.max(...xz.map((p) => p[1]))
    const w = maxX - minX
    const d = maxZ - minZ
    const seg = 220
    const g = new THREE.PlaneGeometry(w, d, seg, Math.round((seg * d) / w))
    g.rotateX(-Math.PI / 2)
    g.translate(minX + w / 2, 0, minZ + d / 2)
    const pos = g.attributes.position
    const colors = new Float32Array(pos.count * 3)
    const c = new THREE.Color()
    const h = 0.03 // sampling step for the hillshade gradient (scene units)
    const elev = (x: number, z: number) => elevation(...unproject(x, z))
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const e = elev(x, z)
      pos.setY(i, STATE_TOP + 0.017 + e * RELIEF) // above the extrusion bevel (0.015)
      // hillshade: slope towards a north-west light brightens, away darkens (exaggerated so 1:1000 relief still reads)
      const dx = (elev(x + h, z) - elev(x - h, z)) / (2 * h)
      const dz = (elev(x, z + h) - elev(x, z - h)) / (2 * h)
      const shade = THREE.MathUtils.clamp(1 + (dx + dz) * -0.09, 0.84, 1.08)
      if (e < 0.3) c.copy(LOW).lerp(MID, e / 0.3)
      else c.copy(MID).lerp(HIGH, Math.min(1, (e - 0.3) / 0.4))
      c.multiplyScalar(shade)
      colors.set([c.r, c.g, c.b], i * 3)
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.computeVertexNormals()
    // alpha mask of the outline in the plane's UV space (canvas top row = v 1 = north = min z)
    const cv = document.createElement('canvas')
    cv.width = 1024
    cv.height = Math.round((1024 * d) / w)
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, cv.width, cv.height)
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    xz.forEach(([x, z], i) => {
      const px = ((x - minX) / w) * cv.width
      const py = ((z - minZ) / d) * cv.height
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    })
    ctx.fill()
    return { geometry: g, mask: new THREE.CanvasTexture(cv) }
  }, [])
  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial vertexColors alphaMap={mask} alphaTest={0.5} roughness={0.92} metalness={0} emissive="#fbf9ff" emissiveIntensity={0.3} />
    </mesh>
  )
}

/** Soft "load heat" pools under each substation — size ∝ load, colour ∝ stress. */
export function HeatLayer({ busLoad, stress }: { busLoad: Record<string, number>; stress: Record<string, number> }) {
  const texture = useMemo(() => {
    const cv = document.createElement('canvas')
    cv.width = cv.height = 128
    const ctx = cv.getContext('2d')!
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
    g.addColorStop(0, 'rgba(255,255,255,0.9)')
    g.addColorStop(0.4, 'rgba(255,255,255,0.35)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 128, 128)
    return new THREE.CanvasTexture(cv)
  }, [])
  return (
    <group>
      {BUSES.filter((b) => !b.external && (busLoad[b.id] ?? 0) > 50).map((b) => {
        const [x, z] = project(b.lon, b.lat)
        const r = 0.25 + Math.sqrt(busLoad[b.id] ?? 0) / 55
        const s = stress[b.id] ?? 0
        const col = s >= 1 ? '#cf5958' : s >= 0.9 ? '#d9824f' : s >= 0.75 ? '#db982f' : '#b1a3f6'
        return (
          <mesh key={b.id} position={[x, STATE_TOP + 0.03, z]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[r * 2, r * 2]} />
            <meshBasicMaterial map={texture} color={col} transparent opacity={s >= 0.75 ? 0.45 : 0.16} depthWrite={false} />
          </mesh>
        )
      })}
    </group>
  )
}
