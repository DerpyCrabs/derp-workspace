import type { Rect as TileRect, SnapZone } from '@/features/tiling/tileZones'
import type { TaskbarWindowRow } from '@/features/taskbar/Taskbar'
import type { DerpWindow } from '@/host/appWindowState'
import type { LayoutScreen } from '@/host/types'
import {
  workspaceGetPreTileGeometry,
  workspaceMonitorTileEntries,
  type WorkspaceState,
} from './workspaceState'
import type { WorkspaceMutation } from './workspaceProtocol'

type FollowupOptions = {
  flushWindows?: boolean
  syncExclusion?: boolean
  resetScroll?: boolean
}

type WorkspaceLayoutBridgeOptions = {
  getWorkspaceState: () => WorkspaceState
  getAllWindowsMap: () => ReadonlyMap<number, DerpWindow>
  getWindowsByMonitor: () => ReadonlyMap<string, readonly DerpWindow[]>
  getTaskbarRowsByMonitor: () => ReadonlyMap<string, TaskbarWindowRow[]>
  getFallbackMonitorName: () => string
  scheduleExclusionZonesSync: () => void
  syncExclusionZonesNow: () => void
  flushShellUiWindowsSyncNow: () => void
  sendWorkspaceMutation?: (mutation: WorkspaceMutation) => boolean
  shellWireSend: (op: 'workspace_mutation', arg?: number | string) => boolean
}

export function createWorkspaceLayoutBridge(options: WorkspaceLayoutBridgeOptions) {
  let compositorFollowupQueued = false
  let compositorFollowupFlushWindows = false
  let compositorFollowupSyncExclusion = false
  let compositorFollowupResetScroll = false

  function sendWorkspaceMutation(mutation: WorkspaceMutation): boolean {
    return options.sendWorkspaceMutation?.(mutation) ?? options.shellWireSend('workspace_mutation', JSON.stringify(mutation))
  }

  function sendSetMonitorTile(windowId: number, outputName: string, zone: SnapZone, bounds: TileRect, outputId?: string | null): boolean {
    return sendWorkspaceMutation({
      type: 'set_monitor_tile',
      windowId,
      ...(outputId ? { outputId } : {}),
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

  function sendClearMonitorTiles(outputName: string, outputId?: string | null): boolean {
    return sendWorkspaceMutation({ type: 'clear_monitor_tiles', ...(outputId ? { outputId } : {}), outputName })
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

  function workspaceTiledRectMap(outputName: string, outputId?: string | null): Map<number, TileRect> {
    return new Map(
      workspaceMonitorTileEntries(options.getWorkspaceState(), outputName, outputId).map((entry) => [
        entry.windowId,
        { ...entry.bounds },
      ]),
    )
  }

  function clearMonitorTiles(outputName: string, outputId?: string | null) {
    sendClearMonitorTiles(outputName, outputId)
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
    const out: { zone: SnapZone; bounds: TileRect }[] = []
    for (const entry of workspaceMonitorTileEntries(options.getWorkspaceState(), screen.name, screen.identity)) {
      const windowId = entry.windowId
      if (windowId === excludeWindowId) continue
      const window = options.getAllWindowsMap().get(windowId)
      if (!window || window.minimized) continue
      out.push({ zone: entry.zone, bounds: { ...entry.bounds } })
    }
    return out
  }

  function fallbackMonitorKey(): string {
    return options.getFallbackMonitorName()
  }

  function scheduleCompositorFollowup(next?: FollowupOptions) {
    if (next?.flushWindows) compositorFollowupFlushWindows = true
    if (next?.syncExclusion) compositorFollowupSyncExclusion = true
    if (next?.resetScroll) compositorFollowupResetScroll = true
    if (compositorFollowupQueued) return
    compositorFollowupQueued = true
    queueMicrotask(() => {
      compositorFollowupQueued = false
      const flushWindows = compositorFollowupFlushWindows
      const syncExclusion = compositorFollowupSyncExclusion
      const resetScroll = compositorFollowupResetScroll
      compositorFollowupFlushWindows = false
      compositorFollowupSyncExclusion = false
      compositorFollowupResetScroll = false
      try {
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
    scheduleCompositorFollowup,
  }
}
