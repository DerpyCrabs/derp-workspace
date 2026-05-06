import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DerpWindow } from '@/host/appWindowState'
import type { LayoutScreen } from '@/host/types'

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

const screen: LayoutScreen = {
  name: 'HDMI-A-1',
  identity: 'output-1',
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  physical_width: 600,
  physical_height: 340,
  transform: 0,
  refresh_milli_hz: 60000,
  vrr_supported: false,
  vrr_enabled: false,
  taskbar_side: 'bottom',
}

const windowRow: DerpWindow = {
  window_id: 1,
  surface_id: 10,
  stack_z: 1,
  x: 100,
  y: 100,
  width: 640,
  height: 480,
  title: 'Window',
  app_id: 'test',
  output_id: 'output-1',
  output_name: 'HDMI-A-1',
  kind: 'xdg',
  x11_class: '',
  x11_instance: '',
  minimized: false,
  maximized: false,
  fullscreen: false,
  shell_flags: 0,
  capture_identifier: '',
  workspace_visible: true,
}

async function createRuntimeFactory() {
  const documentStub = { addEventListener: vi.fn() }
  vi.stubGlobal('window', { document: documentStub })
  vi.stubGlobal('document', documentStub)
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const { createShellWindowGestureRuntime } = await import('./shellWindowGestureRuntime')
  return () => createShellWindowGestureRuntime({
    getMainRef: () => undefined,
    outputGeom: () => ({ w: 1920, h: 1080 }),
    layoutCanvasOrigin: () => ({ x: 0, y: 0 }),
    screenDraftRows: () => [screen],
    windowById: () => () => windowRow,
    reserveTaskbarForMon: () => false,
    occupiedSnapZonesOnMonitor: () => [],
    sendSetMonitorTile: () => true,
    sendSetPreTileGeometry: () => true,
    sendRemoveMonitorTile: () => true,
    sendClearPreTileGeometry: () => true,
    workspacePreTileSnapshot: () => null,
    workspaceTiledRectMap: () => new Map(),
    workspaceTiledZone: () => null,
    isWorkspaceWindowTiled: () => false,
    workspaceFindMonitorForTiledWindow: () => null,
    requestSharedStateSync: vi.fn(),
    requestCompositorSync: vi.fn(),
    bumpSnapChrome: vi.fn(),
    shellWireSend: vi.fn(() => true),
    shellMoveLog: vi.fn(),
    clearNativeDragPreview: vi.fn(),
  })
}

describe('createShellWindowGestureRuntime', () => {
  it('exposes snap-strip state only for a live shell window move', async () => {
    const createRuntime = await createRuntimeFactory()
    createRoot((dispose) => {
      const runtime = createRuntime()
      runtime.beginShellWindowMove(1, 120, 120)

      expect(runtime.dragWindowId()).toBe(1)
      expect(runtime.dragWindowMoved()).toBe(false)
      expect(runtime.snapStripState()).toMatchObject({ monitorName: 'HDMI-A-1', open: false })
      expect(runtime.dragSnapAssistContext()?.windowId).toBe(1)

      runtime.applyShellWindowMove(180, 120)

      expect(runtime.dragWindowMoved()).toBe(true)
      expect(runtime.snapStripState()).toMatchObject({ monitorName: 'HDMI-A-1', open: false })
      expect(runtime.dragSnapAssistContext()?.windowId).toBe(1)
      runtime.endShellWindowMove('test', false, false)
      expect(runtime.snapStripState()).toBeNull()
      expect(runtime.dragSnapAssistContext()).toBeNull()
      dispose()
    })
  })

  it('keeps snap-strip state out of tab-driven window drops', async () => {
    const createRuntime = await createRuntimeFactory()
    createRoot((dispose) => {
      const runtime = createRuntime()
      runtime.beginShellWindowMove(1, 120, 120, { snapAssist: false })

      expect(runtime.dragWindowId()).toBe(1)
      expect(runtime.snapStripState()).toBeNull()
      expect(runtime.dragSnapAssistContext()).toBeNull()

      runtime.applyShellWindowMove(180, 120)

      expect(runtime.dragWindowMoved()).toBe(true)
      expect(runtime.snapStripState()).toBeNull()
      expect(runtime.dragSnapAssistContext()).toBeNull()
      runtime.endShellWindowMove('test', false, false)
      dispose()
    })
  })
})
