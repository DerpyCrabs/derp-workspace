import { SHELL_LAYOUT_FLOATING } from '@/lib/chromeConstants'
import { rectCanvasLocalToGlobal, rectGlobalToCanvasLocal } from '@/lib/shellCoords'
import { monitorWorkAreaGlobal } from '@/features/tiling/tileSnap'
import { getMonitorLayout } from '@/features/tiling/tilingConfig'
import type { Rect as TileRect, SnapZone } from '@/features/tiling/tileZones'
import type { TaskbarWindowRow } from '@/features/taskbar/Taskbar'
import type { DerpWindow } from '@/host/appWindowState'
import { windowOnMonitor } from '@/host/appWindowState'
import type { LayoutScreen } from '@/host/types'
import {
  workspaceGetPreTileGeometry,
  workspaceMonitorTileEntries,
  type WorkspaceState,
} from './workspaceState'

type FollowupOptions = {
  flushWindows?: boolean
  syncExclusion?: boolean
  relayoutAll?: boolean
  relayoutMonitor?: string | null
  resetScroll?: boolean
}

type WorkspaceLayoutBridgeOptions = {
  getWorkspaceState: () => WorkspaceState
  getAllWindowsMap: () => ReadonlyMap<number, DerpWindow>
  getWindowsList: () => readonly DerpWindow[]
  getWindows: () => ReadonlyMap<number, DerpWindow>
  getWindowsByMonitor: () => ReadonlyMap<string, readonly DerpWindow[]>
  getTaskbarRowsByMonitor: () => ReadonlyMap<string, TaskbarWindowRow[]>
  getTaskbarScreens: () => LayoutScreen[]
  getLayoutCanvasOrigin: () => { x: number; y: number } | null
  getScreenDraftRows: () => LayoutScreen[]
  getOutputGeom: () => { w: number; h: number } | null
  getFallbackMonitorName: () => string
  scheduleExclusionZonesSync: () => void
  syncExclusionZonesNow: () => void
  flushShellUiWindowsSyncNow: () => void
  bumpSnapChrome: () => void
  shellWireSend: (
    op: 'workspace_mutation' | 'set_geometry',
    arg?: number | string,
    arg2?: number | string,
    arg3?: number,
    arg4?: number,
    arg5?: number,
    arg6?: number,
  ) => boolean
  debugWindowId: number
  settingsWindowId: number
}

export function createWorkspaceLayoutBridge(options: WorkspaceLayoutBridgeOptions) {
  let compositorFollowupQueued = false
  let compositorFollowupFlushWindows = false
  let compositorFollowupSyncExclusion = false
  let compositorFollowupRelayoutAll = false
  let compositorFollowupResetScroll = false
  const compositorFollowupRelayoutMonitors = new Set<string>()

  function sendWorkspaceMutation(mutation: Record<string, unknown>): boolean {
    return options.shellWireSend('workspace_mutation', JSON.stringify(mutation))
  }

  function sendSetMonitorTile(windowId: number, outputName: string, zone: SnapZone, bounds: TileRect): boolean {
    return sendWorkspaceMutation({
      type: 'set_monitor_tile',
      windowId,
      outputName,
      zone,
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
    })
  }

  function sendRemoveMonitorTile(windowId: number): boolean {
    return sendWorkspaceMutation({ type: 'remove_monitor_tile', windowId })
  }

  function sendClearMonitorTiles(outputName: string): boolean {
    return sendWorkspaceMutation({ type: 'clear_monitor_tiles', outputName })
  }

  function sendSetPreTileGeometry(windowId: number, bounds: { x: number; y: number; w: number; h: number }): boolean {
    return sendWorkspaceMutation({
      type: 'set_pre_tile_geometry',
      windowId,
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.w,
        height: bounds.h,
      },
    })
  }

  function sendClearPreTileGeometry(windowId: number): boolean {
    return sendWorkspaceMutation({ type: 'clear_pre_tile_geometry', windowId })
  }

  function workspacePreTileSnapshot(windowId: number): { x: number; y: number; w: number; h: number } | null {
    const bounds = workspaceGetPreTileGeometry(options.getWorkspaceState(), windowId)
    return bounds ? { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height } : null
  }

  function workspaceTiledRectMap(outputName: string): Map<number, TileRect> {
    return new Map(
      workspaceMonitorTileEntries(options.getWorkspaceState(), outputName).map((entry) => [
        entry.windowId,
        { ...entry.bounds },
      ]),
    )
  }

  function clearMonitorTiles(outputName: string) {
    sendClearMonitorTiles(outputName)
  }

  function taskbarRowsForScreen(screen: LayoutScreen) {
    const rows = options.getTaskbarRowsByMonitor().get(screen.name)
    return rows ? [...rows] : []
  }

  function screenTaskbarHiddenForFullscreen(screen: LayoutScreen) {
    const rows = options.getWindowsByMonitor().get(screen.name) ?? []
    return rows.some((window) => window.fullscreen && !window.minimized)
  }

  function reserveTaskbarForMon(screen: LayoutScreen) {
    return !screenTaskbarHiddenForFullscreen(screen)
  }

  function occupiedSnapZonesOnMonitor(
    screen: LayoutScreen,
    excludeWindowId: number,
  ): { zone: SnapZone; bounds: TileRect }[] {
    const origin = options.getLayoutCanvasOrigin()
    const list = options.getTaskbarScreens()
    const out: { zone: SnapZone; bounds: TileRect }[] = []
    for (const entry of workspaceMonitorTileEntries(options.getWorkspaceState(), screen.name)) {
      const windowId = entry.windowId
      if (windowId === excludeWindowId) continue
      const window = options.getAllWindowsMap().get(windowId)
      if (!window || window.minimized) continue
      if (!windowOnMonitor(window, screen, list, origin)) continue
      const global = rectCanvasLocalToGlobal(window.x, window.y, window.width, window.height, origin)
      out.push({ zone: entry.zone, bounds: { x: global.x, y: global.y, width: global.w, height: global.h } })
    }
    return out
  }

  function fallbackMonitorKey(): string {
    return options.getFallbackMonitorName()
  }

  function applyAutoLayout(monitorName: string) {
    const { layout, params } = getMonitorLayout(monitorName)
    if (layout.type === 'manual-snap') return
    const monitor = options.getTaskbarScreens().find((screen) => screen.name === monitorName) ?? null
    if (!monitor) return
    const fallbackMonitor = fallbackMonitorKey()
    const origin = options.getLayoutCanvasOrigin()
    const reserveTaskbar = reserveTaskbarForMon(monitor)
    const work = monitorWorkAreaGlobal(monitor, reserveTaskbar)
    const workRect: TileRect = { x: work.x, y: work.y, width: work.w, height: work.h }
    const candidates = options.getWindowsList().filter((window) => {
      if (window.window_id === options.debugWindowId || window.window_id === options.settingsWindowId) return false
      if (window.minimized) return false
      if ((window.output_name || fallbackMonitor) !== monitorName) return false
      if (window.fullscreen || window.maximized) return false
      return true
    })
    const windowIds = candidates.map((window) => window.window_id).sort((a, b) => a - b)
    const rectMap = layout.computeLayout(windowIds, workRect, params)
    const windows = options.getWindows()
    if (!sendClearMonitorTiles(monitorName)) return
    for (const [windowId] of rectMap) {
      const preTile = windows.get(windowId)
      if (preTile && !sendSetPreTileGeometry(windowId, { x: preTile.x, y: preTile.y, w: preTile.width, h: preTile.height })) {
        return
      }
    }
    for (const [windowId, globalRect] of rectMap) {
      if (!sendSetMonitorTile(windowId, monitorName, 'auto-fill', globalRect)) return
      const local = rectGlobalToCanvasLocal(globalRect.x, globalRect.y, globalRect.width, globalRect.height, origin)
      options.shellWireSend('set_geometry', windowId, local.x, local.y, local.w, local.h, SHELL_LAYOUT_FLOATING)
    }
    options.scheduleExclusionZonesSync()
    options.bumpSnapChrome()
  }

  function relayoutAllAutoMonitors() {
    for (const screen of options.getTaskbarScreens()) {
      if (getMonitorLayout(screen.name).layout.type !== 'manual-snap') {
        applyAutoLayout(screen.name)
      }
    }
  }

  function scheduleCompositorFollowup(next?: FollowupOptions) {
    if (next?.flushWindows) compositorFollowupFlushWindows = true
    if (next?.syncExclusion) compositorFollowupSyncExclusion = true
    if (next?.relayoutAll) compositorFollowupRelayoutAll = true
    if (next?.resetScroll) compositorFollowupResetScroll = true
    if (typeof next?.relayoutMonitor === 'string' && next.relayoutMonitor.length > 0) {
      compositorFollowupRelayoutMonitors.add(next.relayoutMonitor)
    }
    if (compositorFollowupQueued) return
    compositorFollowupQueued = true
    queueMicrotask(() => {
      compositorFollowupQueued = false
      const flushWindows = compositorFollowupFlushWindows
      const syncExclusion = compositorFollowupSyncExclusion
      const relayoutAll = compositorFollowupRelayoutAll
      const resetScroll = compositorFollowupResetScroll
      const relayoutMonitors = relayoutAll ? [] : Array.from(compositorFollowupRelayoutMonitors)
      compositorFollowupFlushWindows = false
      compositorFollowupSyncExclusion = false
      compositorFollowupRelayoutAll = false
      compositorFollowupResetScroll = false
      compositorFollowupRelayoutMonitors.clear()
      try {
        if (relayoutAll) {
          relayoutAllAutoMonitors()
        } else {
          for (const monitorName of relayoutMonitors) {
            applyAutoLayout(monitorName)
          }
        }
        if (flushWindows) options.flushShellUiWindowsSyncNow()
        if (syncExclusion) {
          if (flushWindows) {
            options.syncExclusionZonesNow()
          } else {
            options.scheduleExclusionZonesSync()
          }
        }
        if (resetScroll) {
          window.scrollTo(0, 0)
          document.documentElement.scrollTop = 0
          document.documentElement.scrollLeft = 0
          document.body.scrollTop = 0
          document.body.scrollLeft = 0
        }
      } catch (error) {
        console.error('[derp-shell] compositor follow-up', error)
      }
    })
  }

  return {
    sendWorkspaceMutation,
    sendSetMonitorTile,
    sendRemoveMonitorTile,
    sendClearMonitorTiles,
    sendSetPreTileGeometry,
    sendClearPreTileGeometry,
    workspacePreTileSnapshot,
    workspaceTiledRectMap,
    clearMonitorTiles,
    taskbarRowsForScreen,
    screenTaskbarHiddenForFullscreen,
    reserveTaskbarForMon,
    occupiedSnapZonesOnMonitor,
    fallbackMonitorKey,
    applyAutoLayout,
    scheduleCompositorFollowup,
  }
}
