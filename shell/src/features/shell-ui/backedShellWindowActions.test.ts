import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveBackedWindowClientAreaGlobal } from './backedShellWindowActions'
import type { DerpWindow } from '@/host/appWindowState'
import type { LayoutScreen } from '@/host/types'

const STORAGE_KEY = 'derp-tiling-config'

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
    clear: vi.fn(() => {
      store.clear()
    }),
  }
  vi.stubGlobal('localStorage', localStorage)
  return localStorage
}

function shellWindow(windowId: number, outputName = 'DP-1'): DerpWindow {
  return {
    window_id: windowId,
    surface_id: windowId,
    stack_z: windowId,
    x: 20,
    y: 46,
    width: 400,
    height: 300,
    title: `window-${windowId}`,
    app_id: 'derp.test-shell',
    output_id: 'make:model:serial',
    output_name: outputName,
    kind: 'test-shell',
    x11_class: '',
    x11_instance: '',
    minimized: false,
    maximized: false,
    fullscreen: false,
    shell_flags: 0,
    capture_identifier: `capture-${windowId}`,
  }
}

const monitor: LayoutScreen = {
  name: 'DP-1',
  x: 0,
  y: 0,
  width: 1200,
  height: 900,
  transform: 0,
  refresh_milli_hz: 60000,
}

describe('backedShellWindowActions', () => {
  beforeEach(() => {
    stubLocalStorage()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps centered floating defaults on manual-snap monitors', () => {
    const rect = resolveBackedWindowClientAreaGlobal({
      windowId: 9100,
      kind: 'test',
      monitor,
      reserveTaskbar: true,
      work: { x: 0, y: 26, w: 1200, h: 830 },
      staggerIndex: 0,
      windows: [],
      pendingOpens: [],
      fallbackMonitorName: 'DP-1',
    })

    expect(rect).toEqual({ x: 360, y: 319, w: 480, h: 266 })
  })

  it('keeps shell-hosted open payloads staggered even on auto-layout monitors', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        monitors: {
          'DP-1': {
            layout: 'grid',
          },
        },
      }),
    )

    const rect = resolveBackedWindowClientAreaGlobal({
      windowId: 9101,
      kind: 'test',
      monitor,
      reserveTaskbar: true,
      work: { x: 0, y: 26, w: 1200, h: 830 },
      staggerIndex: 1,
      windows: [shellWindow(9100)],
      pendingOpens: [],
      fallbackMonitorName: 'DP-1',
    })

    expect(rect).toEqual({ x: 388, y: 343, w: 480, h: 266 })
  })
})
