import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMonitorLayout, saveTilingConfig, setMonitorEdgeLayout, setMonitorLayout } from './tilingConfig'

function stubLocalStorage() {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key)
    }),
  }
  vi.stubGlobal('localStorage', localStorage)
  return localStorage
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('tilingConfig', () => {
  it('skips redundant localStorage writes for identical configs', () => {
    const localStorage = stubLocalStorage()
    const cfg = { monitors: { 'DP-1': { layout: 'grid' as const, params: { maxColumns: 3 } } } }

    saveTilingConfig(cfg)
    saveTilingConfig(cfg)

    expect(localStorage.setItem).toHaveBeenCalledTimes(1)
  })

  it('skips redundant writes when setting the same monitor layout twice', () => {
    const localStorage = stubLocalStorage()

    setMonitorLayout('DP-1', 'columns', { maxColumns: 2 })
    setMonitorLayout('DP-1', 'columns', { maxColumns: 2 })

    expect(localStorage.setItem).toHaveBeenCalledTimes(1)
  })

  it('preserves edge layout when changing monitor layout mode', () => {
    stubLocalStorage()

    setMonitorEdgeLayout('DP-1', '2x2')
    setMonitorLayout('DP-1', 'columns', { maxColumns: 2 })

    expect(getMonitorLayout('DP-1').edgeLayout).toBe('2x2')
  })

  it('defaults edge layout to 3x2 and persists explicit override', () => {
    stubLocalStorage()

    expect(getMonitorLayout('DP-1').edgeLayout).toBe('3x2')
    setMonitorEdgeLayout('DP-1', '3x3')

    expect(getMonitorLayout('DP-1').edgeLayout).toBe('3x3')
  })
})
