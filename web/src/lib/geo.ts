// Local planar projection for the 3D state model (equirectangular, scaled by cos(lat0)).
export const LON0 = 76.3
export const LAT0 = 15.0
export const K = 1.6 // scene units per degree
const COS = Math.cos((LAT0 * Math.PI) / 180)
export const STATE_TOP = 0.12 // extrusion depth = ground level for objects

/** world [x, z] for a lon/lat */
export function project(lon: number, lat: number): [number, number] {
  return [(lon - LON0) * K * COS, -(lat - LAT0) * K]
}

/** lon/lat for a world [x, z] (inverse of `project`) */
export function unproject(x: number, z: number): [number, number] {
  return [x / (K * COS) + LON0, LAT0 - z / K]
}

/** 2D shape coords (pre-rotation) for the extruded state outline */
export function shapeXY(lon: number, lat: number): [number, number] {
  return [(lon - LON0) * K * COS, (lat - LAT0) * K]
}

export function loadingColor(v: number) {
  if (v >= 1) return '#cf5958'
  if (v >= 0.9) return '#d9824f'
  if (v >= 0.75) return '#db982f'
  return '#47a37b'
}

export function fmtMW(v: number, digits = 0) {
  return `${v.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits })} MW`
}

export function fmtRs(v: number) {
  const a = Math.abs(v)
  const sign = v < 0 ? '−' : ''
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} L`
  return `${sign}₹${a.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}
