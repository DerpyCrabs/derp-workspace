import { describe, expect, it } from 'vitest'
import { defaultBackedClientAreaGlobal } from './backedShellWindows'

describe('backedShellWindows', () => {
  it('staggered backed windows offset from the centered default', () => {
    const work = { x: 0, y: 0, w: 1280, h: 810 }
    const centered = defaultBackedClientAreaGlobal(work, 'test')
    const staggered = defaultBackedClientAreaGlobal(work, 'test', 1)

    expect(staggered.x).toBeGreaterThan(centered.x)
    expect(staggered.y).toBeGreaterThan(centered.y)
    expect(staggered.w).toBe(centered.w)
    expect(staggered.h).toBe(centered.h)
  })

  it('wraps stagger offsets without leaving the work area', () => {
    const work = { x: 10, y: 20, w: 900, h: 600 }
    const base = defaultBackedClientAreaGlobal(work, 'settings')
    const wrapped = defaultBackedClientAreaGlobal(work, 'settings', 6)

    expect(wrapped).toEqual(base)
  })
})
