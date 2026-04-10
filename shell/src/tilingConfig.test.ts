import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveTilingConfig, setMonitorLayout } from './tilingConfig'

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
})
