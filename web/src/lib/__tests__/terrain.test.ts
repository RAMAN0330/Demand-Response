import { describe, expect, it } from 'vitest'
import { elevation, ghatsCrestLon } from '../terrain'

describe('terrain', () => {
  it('rises from the coast to the Ghats crest and stays high on the plateau', () => {
    const lat = 13.5
    const crest = ghatsCrestLon(lat)
    const coast = elevation(crest - 0.6, lat)
    const top = elevation(crest, lat)
    const plateau = elevation(crest + 1.2, lat)
    expect(coast).toBeLessThan(0.1)
    expect(top).toBeGreaterThan(plateau)
    expect(plateau).toBeGreaterThan(coast + 0.15)
  })
  it('stays within 0..1', () => {
    for (let lon = 74; lon <= 78.6; lon += 0.13)
      for (let lat = 11.5; lat <= 18.5; lat += 0.17) {
        const e = elevation(lon, lat)
        expect(e).toBeGreaterThanOrEqual(0)
        expect(e).toBeLessThanOrEqual(1)
      }
  })
})
