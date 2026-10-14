// Allocation-free curve sampling for the 3D map's animated particles.
//
// three.js `curve.getPointAt(u)` re-walks the cached arc-length table with a binary search and allocates a
// Vector3 on every call; with hundreds of particles per frame that is the hottest path on the map. A
// PolylineLUT samples the curve once into a Float32Array spaced uniformly by arc length, so a particle's
// position is one array index plus a linear interpolation, written into a caller-owned vector. Uniform
// arc-length spacing also keeps particle speed constant along a curve (getPoint(t) would bunch them up
// where the parameterisation is uneven).

export interface Vec3Like {
  x: number
  y: number
  z: number
  set(x: number, y: number, z: number): unknown
}

export interface CurveLike {
  getPoint(t: number): { x: number; y: number; z: number }
}

export interface PolylineLUT {
  /** xyz triples, `n + 1` points, uniformly spaced by arc length */
  pts: Float32Array
  n: number
  /** total arc length in scene units */
  length: number
}

/**
 * Sample `curve` densely (`oversample` × n), then resample to `n` segments of equal arc length.
 * Error against the true arc-length parameterisation is O(1/(n·oversample)²) for smooth curves.
 */
export function buildLUT(curve: CurveLike, n = 48, oversample = 4): PolylineLUT {
  const m = n * oversample
  const raw = new Float64Array((m + 1) * 3)
  const cum = new Float64Array(m + 1)
  for (let i = 0; i <= m; i++) {
    const p = curve.getPoint(i / m)
    raw[i * 3] = p.x
    raw[i * 3 + 1] = p.y
    raw[i * 3 + 2] = p.z
    if (i > 0) {
      const dx = raw[i * 3] - raw[i * 3 - 3]
      const dy = raw[i * 3 + 1] - raw[i * 3 - 2]
      const dz = raw[i * 3 + 2] - raw[i * 3 - 1]
      cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
  }
  const length = cum[m]
  const pts = new Float32Array((n + 1) * 3)
  let j = 0
  for (let i = 0; i <= n; i++) {
    const target = (i / n) * length
    while (j < m - 1 && cum[j + 1] < target) j++
    const seg = cum[j + 1] - cum[j]
    const f = seg > 0 ? (target - cum[j]) / seg : 0
    for (let k = 0; k < 3; k++) pts[i * 3 + k] = raw[j * 3 + k] + (raw[(j + 1) * 3 + k] - raw[j * 3 + k]) * f
  }
  return { pts, n, length }
}

/** Position at arc-length fraction u ∈ [0, 1] (wrapped), written into `out`. No allocation. */
export function lutPoint<T extends Vec3Like>(lut: PolylineLUT, u: number, out: T): T {
  const w = u - Math.floor(u)
  const x = w * lut.n
  const i = Math.min(lut.n - 1, x | 0)
  const f = x - i
  const a = i * 3
  const p = lut.pts
  out.set(p[a] + (p[a + 3] - p[a]) * f, p[a + 1] + (p[a + 4] - p[a + 1]) * f, p[a + 2] + (p[a + 5] - p[a + 2]) * f)
  return out
}

/** Great-circle distance in km (haversine; IUGG mean Earth radius), as the backend uses for line reactance. */
export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371.0088
  const r = Math.PI / 180
  const dp = (lat2 - lat1) * r
  const dl = (lon2 - lon1) * r
  const h = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}
