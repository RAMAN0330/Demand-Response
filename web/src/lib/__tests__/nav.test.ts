import { describe, expect, it } from 'vitest'
import { canSee, readOnly } from '../nav'

const as = (perms: string[]) => (p: string) => perms.includes(p)

describe('role-filtered navigation', () => {
  it('shows a gated page only to a role holding one of its permissions', () => {
    expect(canSee('command', as(['view']))).toBe(true)
    expect(canSee('whatif', as(['view', 'reports', 'audit']))).toBe(false)
    expect(canSee('reports', as(['view', 'reports', 'settle']))).toBe(true)
    expect(canSee('admin', as(['view', 'autonomy']))).toBe(true)
    expect(canSee('admin', as(['view', 'whatif']))).toBe(false)
  })
  it('marks a role read-only only when it can change nothing', () => {
    expect(readOnly(['view', 'reports', 'audit'])).toBe(true)
    expect(readOnly(['view', 'reports', 'settle'])).toBe(false)
  })
})
