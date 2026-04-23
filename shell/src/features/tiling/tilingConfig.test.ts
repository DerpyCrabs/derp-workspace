import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  customMonitorSnapLayout,
  customAutoLayoutParamsForMonitor,
  getMonitorLayout,
  saveTilingConfig,
  setMonitorCustomLayouts,
  setMonitorLayout,
  setMonitorSnapLayout,
} from './tilingConfig'
import { createCustomLayout, setCustomLayoutSlotRules } from './customLayouts'

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

  it('preserves snap layout when changing monitor layout mode', () => {
    stubLocalStorage()

    setMonitorSnapLayout('DP-1', { kind: 'assist', shape: '2x2' })
    setMonitorLayout('DP-1', 'columns', { maxColumns: 2 })

    expect(getMonitorLayout('DP-1').snapLayout).toEqual({ kind: 'assist', shape: '2x2' })
  })

  it('defaults snap layout to 3x2 and persists explicit built-in override', () => {
    stubLocalStorage()

    expect(getMonitorLayout('DP-1').snapLayout).toEqual({ kind: 'assist', shape: '3x2' })
    setMonitorSnapLayout('DP-1', { kind: 'assist', shape: '3x3' })

    expect(getMonitorLayout('DP-1').snapLayout).toEqual({ kind: 'assist', shape: '3x3' })
  })

  it('persists custom snap layout selections while layout exists', () => {
    stubLocalStorage()

    const customLayout = createCustomLayout('Zones')
    setMonitorCustomLayouts('DP-1', [customLayout])
    setMonitorSnapLayout('DP-1', customMonitorSnapLayout(customLayout.id))

    expect(getMonitorLayout('DP-1').snapLayout).toEqual(customMonitorSnapLayout(customLayout.id))
  })

  it('builds custom auto params from selected layout zones and rules', () => {
    stubLocalStorage()

    const customLayout = setCustomLayoutSlotRules(createCustomLayout('Zones'), 'zone-missing', [])
    const layout = {
      ...customLayout,
      root: {
        kind: 'split' as const,
        axis: 'vertical' as const,
        ratio: 0.5,
        first: { kind: 'leaf' as const, zoneId: 'slot-1' },
        second: { kind: 'leaf' as const, zoneId: 'slot-2' },
      },
      slotRules: {
        'slot-2': [{ field: 'app_id' as const, op: 'equals' as const, value: 'org.desktop.telegram' }],
      },
    }
    setMonitorCustomLayouts('DP-1', [layout])
    setMonitorSnapLayout('DP-1', customMonitorSnapLayout(layout.id))

    expect(customAutoLayoutParamsForMonitor('DP-1')).toEqual({
      customLayoutId: layout.id,
      customSlots: [
        { slotId: 'slot-1', x: 0, y: 0, width: 0.5, height: 1 },
        {
          slotId: 'slot-2',
          x: 0.5,
          y: 0,
          width: 0.5,
          height: 1,
          rules: [{ field: 'app_id', op: 'equals', value: 'org.desktop.telegram' }],
        },
      ],
    })
  })

  it('falls back to default assist layout when selected custom layout disappears', () => {
    stubLocalStorage()

    const customLayout = createCustomLayout('Zones')
    setMonitorCustomLayouts('DP-1', [customLayout])
    setMonitorSnapLayout('DP-1', customMonitorSnapLayout(customLayout.id))
    setMonitorCustomLayouts('DP-1', [])

    expect(getMonitorLayout('DP-1').snapLayout).toEqual({ kind: 'assist', shape: '3x2' })
  })

  it('reads legacy edgeLayout storage as current snap layout', () => {
    const localStorage = stubLocalStorage()
    localStorage.setItem(
      'derp-tiling-config',
      JSON.stringify({
        monitors: {
          'DP-1': {
            layout: 'manual-snap',
            edgeLayout: '2x2',
          },
        },
      }),
    )

    expect(getMonitorLayout('DP-1').snapLayout).toEqual({ kind: 'assist', shape: '2x2' })
  })
})
