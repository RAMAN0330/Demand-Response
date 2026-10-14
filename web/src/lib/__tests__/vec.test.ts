import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { buildLUT, greatCircleKm, lutPoint } from '../vec'

describe('arc-length lookup table', () => {
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 2, 0), new THREE.Vector3(4, 0, 1))
  const lut = buildLUT(curve, 64)
  const v = new THREE.Vector3()

  it('measures the curve length like three.js', () => {
    expect(lut.length).toBeCloseTo(curve.getLength(), 2)
  })
  it('matches getPointAt (arc-length parameterisation) to within a millimetre of scene units', () => {
    let worst = 0
    for (let i = 0; i < 200; i++) {
      const u = i / 200
      lutPoint(lut, u, v)
      worst = Math.max(worst, v.distanceTo(curve.getPointAt(u)))
    }
    expect(worst).toBeLessThan(2e-3)
  })
  it('hits the end points exactly and wraps u', () => {
    expect(lutPoint(lut, 0, v).distanceTo(new THREE.Vector3(0, 0, 0))).toBeLessThan(1e-6)
    expect(lutPoint(lut, 0.999999, v).distanceTo(new THREE.Vector3(4, 0, 1))).toBeLessThan(1e-3)
    const a = lutPoint(lut, 0.25, new THREE.Vector3()).clone()
    expect(lutPoint(lut, 1.25, v).distanceTo(a)).toBeLessThan(1e-9)
  })
})

describe('great-circle distance', () => {
  it('Bengaluru → Mysuru ≈ 128 km', () => {
    const d = greatCircleKm(12.9716, 77.5946, 12.2958, 76.6394)
    expect(d).toBeGreaterThan(126)
    expect(d).toBeLessThan(130)
  })
})
