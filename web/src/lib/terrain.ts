// Procedural relief for the 3D state model. No DEM is bundled, so elevation is modelled from the two features that
// dominate Karnataka's physiography: the low coastal strip, the Western Ghats escarpment just inland of it, and the
// Deccan plateau to the east, plus low-amplitude detail so slopes catch the light.
// shortcut: synthetic relief, not survey data; swap for SRTM tiles if terrain ever drives a calculation.

/** Crest of the Western Ghats (degrees east) at a latitude: ~74.4°E near Goa, ~75.6°E near Kodagu. */
export const ghatsCrestLon = (lat: number) => 74.35 + (15.8 - lat) * 0.32

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Normalised elevation 0 (sea level) … 1 (highest Ghats peaks). */
export function elevation(lon: number, lat: number): number {
  const crest = ghatsCrestLon(lat)
  const d = lon - crest
  const ridge = Math.exp(-((d / 0.22) ** 2)) * (0.55 + 0.25 * Math.sin(lat * 7.1) ** 2) * smooth(16.3, 15.6, lat)
  // coast below the escarpment, plateau rising east of it then easing towards the north-east
  const plateau = smooth(-0.35, 0.05, d) * (0.42 - 0.12 * smooth(14, 17.5, lat))
  const detail = 0.05 * Math.sin(lon * 23.0 + Math.sin(lat * 11.0)) * Math.sin(lat * 19.0 + lon * 3.0) + 0.03 * Math.sin(lon * 57.0 + lat * 41.0)
  return Math.min(1, Math.max(0, Math.max(ridge, plateau) + detail * smooth(-0.5, 0, d)))
}
