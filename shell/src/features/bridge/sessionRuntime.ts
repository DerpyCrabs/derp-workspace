import { backedShellWindowKind } from '@/features/shell-ui/backedShellWindows'
import { shellHostedKindUsesCompositorSessionCapture } from '@/features/shell-ui/shellHostedAppsRegistry'
import { captureShellWindowState, primeShellWindowState } from '@/features/shell-ui/shellWindowState'
import { monitorWorkAreaGlobal, tiledFrameRectToClientRect } from '@/features/tiling/tileSnap'
import { loadTilingConfig } from '@/features/tiling/tilingConfig'
import type { WorkspaceSnapshot } from '@/features/workspace/workspaceSnapshot'
import type { WorkspaceMutation } from '@/features/workspace/workspaceProtocol'
import type { DerpWindow } from '@/host/appWindowState'
import { windowIsShellHosted } from '@/host/appWindowState'
import type { LayoutScreen } from '@/host/types'
import { SHELL_LAYOUT_FLOATING } from '@/lib/chromeConstants'
import { rectCanvasLocalToGlobal, rectGlobalToCanvasLocal } from '@/lib/shellCoords'
import { matchNativeSessionWindow } from './nativeSessionMatch'
import {
  nativeWindowRef,
  shellWindowRef,
  type NativeLaunchMetadata,
  type SavedMonitorTileState,
  type SavedNativeWindow,
  type SavedRect,
  type SavedShellWindow,
  type SessionSnapshot,
  type SessionWindowRef,
} from './sessionSnapshot'

type NativeLaunchQueueEntry = {
  windowRef: SessionWindowRef
  launch: NativeLaunchMetadata
}

type SessionRuntimeOptions = {
  getAllWindowsMap: () => ReadonlyMap<number, DerpWindow>
  getWindowsList: () => readonly DerpWindow[]
  getWorkspaceState: () => WorkspaceSnapshot
  getTaskbarScreens: () => LayoutScreen[]
  getLayoutCanvasOrigin: () => { x: number; y: number } | null
  getNativeWindowRefs: () => ReadonlyMap<number, SessionWindowRef>
  getNextNativeWindowSeq: () => number
  getSessionRestoreSnapshot: () => SessionSnapshot | null
  getTilingCfgRev: () => number
  setNativeWindowRef: (windowId: number, windowRef: SessionWindowRef) => void
  setNextNativeWindowSeq: (value: number | ((prev: number) => number)) => void
  reserveTaskbarForMon: (screen: LayoutScreen) => boolean
  rectFromWindow: (window: Pick<DerpWindow, 'x' | 'y' | 'width' | 'height'>) => SavedRect
  sendWorkspaceMutation: (mutation: WorkspaceMutation) => boolean
  shellWireSend: (
    op: 'backed_window_open' | 'minimize' | 'set_fullscreen' | 'set_geometry' | 'set_maximized',
    arg?: number | string,
    arg2?: number | string,
    arg3?: number,
    arg4?: number,
    arg5?: number,
    arg6?: number,
  ) => boolean
  bumpSnapChrome: () => void
  scheduleExclusionZonesSync: () => void
  nativeLaunchMetadataByRef: Map<SessionWindowRef, NativeLaunchMetadata>
  pendingNativeLaunches: NativeLaunchQueueEntry[]
  getShellHostedAppStateForWindow?: (windowId: number) => unknown | undefined
}

export function createSessionRuntime(options: SessionRuntimeOptions) {
  function rectMatches(
    left: Pick<SavedRect, 'x' | 'y' | 'width' | 'height'>,
    right: Pick<SavedRect, 'x' | 'y' | 'width' | 'height'>,
    tolerance = 0,
  ): boolean {
    return (
      Math.abs(left.x - right.x) <= tolerance &&
      Math.abs(left.y - right.y) <= tolerance &&
      Math.abs(left.width - right.width) <= tolerance &&
      Math.abs(left.height - right.height) <= tolerance
    )
  }

  function screenBySavedOutput(outputId: string, outputName: string): LayoutScreen | null {
    const screens = options.getTaskbarScreens()
    return (
      screens.find((screen) => outputId.length > 0 && screen.identity === outputId) ??
      screens.find((screen) => screen.name === outputName) ??
      screens[0] ??
      null
    )
  }

  function nativeWindowRefForId(windowId: number): SessionWindowRef | null {
    return options.getNativeWindowRefs().get(windowId) ?? null
  }

  function assignNativeWindowRef(windowId: number): SessionWindowRef {
    const existing = nativeWindowRefForId(windowId)
    if (existing) return existing
    const nextRef = nativeWindowRef(options.getNextNativeWindowSeq())
    options.setNextNativeWindowSeq((seq) => seq + 1)
    options.setNativeWindowRef(windowId, nextRef)
    return nextRef
  }

  function liveWindowIdForRef(windowRef: SessionWindowRef): number | null {
    if (windowRef.startsWith('shell:')) {
      const windowId = Number(windowRef.slice('shell:'.length))
      return options.getAllWindowsMap().has(windowId) ? windowId : null
    }
    for (const [windowId, ref] of options.getNativeWindowRefs()) {
      if (ref === windowRef && options.getAllWindowsMap().has(windowId)) return windowId
    }
    return null
  }

  function sessionRestoreSignature(snapshot: SessionSnapshot): string {
    const shellWindowIds = snapshot.shellWindows
      .map((window) => window.windowId)
      .filter((windowId) => options.getAllWindowsMap().has(windowId))
      .join(',')
    const nativeWindowKeys = snapshot.nativeWindows
      .map((window) => `${window.windowRef}:${liveWindowIdForRef(window.windowRef) ?? ''}`)
      .join(',')
    const outputs = options
      .getTaskbarScreens()
      .map((screen) => `${screen.identity}:${screen.name}`)
      .join(',')
    return `${shellWindowIds}|${nativeWindowKeys}|${outputs}|${options.getTilingCfgRev()}`
  }

  function savedWindowBoundsToLocalRect(bounds: SavedRect, outputId: string, outputName: string): SavedRect {
    const target = screenBySavedOutput(outputId, outputName)
    if (!target) return bounds
    const reserveTb = options.reserveTaskbarForMon(target)
    const work = monitorWorkAreaGlobal(target, reserveTb, undefined, undefined, target.taskbar_side)
    const globalRect = rectCanvasLocalToGlobal(
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      options.getLayoutCanvasOrigin(),
    )
    const fitsOutput =
      (outputId.length > 0 ? target.identity === outputId : outputName === target.name) &&
      globalRect.x >= target.x &&
      globalRect.y >= target.y &&
      globalRect.x + globalRect.w <= target.x + target.width &&
      globalRect.y + globalRect.h <= target.y + target.height
    if (fitsOutput) return bounds
    const width = Math.max(1, Math.min(bounds.width, work.w))
    const height = Math.max(1, Math.min(bounds.height, work.h))
    const x = work.x + Math.max(0, Math.floor((work.w - width) / 2))
    const y = work.y + Math.max(0, Math.floor((work.h - height) / 2))
    const local = rectGlobalToCanvasLocal(x, y, width, height, options.getLayoutCanvasOrigin())
    return { x: local.x, y: local.y, width: local.w, height: local.h }
  }

  function restoreBackedShellWindow(record: SavedShellWindow) {
    const current = options.getAllWindowsMap().get(record.windowId)
    if (current) {
      if (record.state !== null) primeShellWindowState(record.windowId, record.state)
      return
    }
    const kind = backedShellWindowKind(record.windowId, record.appId)
    if (!kind) return
    if (record.state !== null) primeShellWindowState(record.windowId, record.state)
    const bounds = savedWindowBoundsToLocalRect(record.bounds, record.outputId, record.outputName)
    options.shellWireSend(
      'backed_window_open',
      JSON.stringify({
        window_id: record.windowId,
        title: record.title,
        app_id: record.appId,
        output_name: record.outputName,
        x: bounds.x,
        y: bounds.y,
        w: bounds.width,
        h: bounds.height,
      }),
    )
  }

  function assignPendingNativeLaunch(windowId: number): SessionWindowRef | null {
    const nextLaunch = options.pendingNativeLaunches.shift() ?? null
    if (!nextLaunch) return null
    options.nativeLaunchMetadataByRef.set(nextLaunch.windowRef, nextLaunch.launch)
    options.setNativeWindowRef(windowId, nextLaunch.windowRef)
    return nextLaunch.windowRef
  }

  function tryAssignRestoredNativeWindow(windowId: number) {
    const window = options.getAllWindowsMap().get(windowId)
    if (!window || windowIsShellHosted(window)) return
    if (nativeWindowRefForId(windowId)) return
    const assignedRefs = new Set(Array.from(options.getNativeWindowRefs().values()))
    const snapshot = options.getSessionRestoreSnapshot()
    if (snapshot) {
      const match = matchNativeSessionWindow(
        {
          title: window.title,
          appId: window.app_id,
          outputId: window.output_id,
          outputName: window.output_name,
          maximized: window.maximized,
          fullscreen: window.fullscreen,
        },
        snapshot.nativeWindows,
        assignedRefs,
      )
      if (match) {
        if (match.launch) options.nativeLaunchMetadataByRef.set(match.windowRef, match.launch)
        options.setNativeWindowRef(windowId, match.windowRef)
        return
      }
    }
    if (assignPendingNativeLaunch(windowId)) return
    assignNativeWindowRef(windowId)
  }

  function restoreWindowModes(snapshot: SessionSnapshot) {
    const windowsById = options.getAllWindowsMap()
    for (const record of snapshot.shellWindows) {
      const live = windowsById.get(record.windowId)
      if (!live) continue
      if (record.minimized && !live.minimized) options.shellWireSend('minimize', live.window_id)
      if (!record.minimized && record.maximized !== live.maximized) {
        options.shellWireSend('set_maximized', live.window_id, record.maximized ? 1 : 0)
      }
      if (!record.minimized && record.fullscreen !== live.fullscreen) {
        options.shellWireSend('set_fullscreen', live.window_id, record.fullscreen ? 1 : 0)
      }
    }
    for (const record of snapshot.nativeWindows) {
      const liveWindowId = liveWindowIdForRef(record.windowRef)
      if (liveWindowId === null) continue
      const live = windowsById.get(liveWindowId)
      if (!live) continue
      if (record.minimized && !live.minimized) options.shellWireSend('minimize', liveWindowId)
      if (!record.minimized && record.maximized !== live.maximized) {
        options.shellWireSend('set_maximized', liveWindowId, record.maximized ? 1 : 0)
      }
      if (!record.minimized && record.fullscreen !== live.fullscreen) {
        options.shellWireSend('set_fullscreen', liveWindowId, record.fullscreen ? 1 : 0)
      }
    }
  }

  function applyRestoredWorkspace(snapshot: SessionSnapshot) {
    const groups = snapshot.workspace.groups
      .map((group) => {
        const windowIds = group.windowRefs
          .map((windowRef) => liveWindowIdForRef(windowRef))
          .filter((windowId): windowId is number => windowId !== null)
        if (windowIds.length === 0) return null
        const activeWindowId =
          (group.activeWindowRef ? liveWindowIdForRef(group.activeWindowRef) : null) ?? windowIds[0]
        const splitLeftWindowId =
          group.splitLeftWindowRef !== null ? liveWindowIdForRef(group.splitLeftWindowRef) : null
        return {
          id: group.id,
          windowIds,
          activeWindowId,
          splitLeftWindowId: splitLeftWindowId !== null && windowIds.includes(splitLeftWindowId) ? splitLeftWindowId : null,
          leftPaneFraction: group.leftPaneFraction,
        }
      })
      .filter(
        (
          group,
        ): group is {
          id: string
          windowIds: number[]
          activeWindowId: number
          splitLeftWindowId: number | null
          leftPaneFraction: number | null
        } => group !== null,
      )
    const pinnedWindowIds = snapshot.workspace.pinnedWindowRefs
      .map((windowRef) => liveWindowIdForRef(windowRef))
      .filter((windowId): windowId is number => windowId !== null)
    const preTileGeometry = snapshot.preTileGeometry.flatMap((entry) => {
      const windowId = liveWindowIdForRef(entry.windowRef)
      return windowId === null
        ? []
        : [
            {
              windowId,
              bounds: {
                x: entry.bounds.x,
                y: entry.bounds.y,
                width: entry.bounds.width,
                height: entry.bounds.height,
              },
            },
          ]
    })
    const screens = options.getTaskbarScreens()
    const monitorTiles: Array<{
      outputId?: string
      outputName: string
      entries: Array<{
        windowId: number
        zone: string
        bounds: { x: number; y: number; width: number; height: number }
      }>
    }> = []
    const tiledGeometry: Array<{
      windowId: number
      x: number
      y: number
      w: number
      h: number
    }> = []
    if (screens.length > 0) {
      for (const monitorState of snapshot.monitorTiles) {
        const targetMonitor =
          screenBySavedOutput(monitorState.outputId ?? '', monitorState.outputName)
        if (!targetMonitor) continue
        const entries: Array<{
          windowId: number
          zone: string
          bounds: { x: number; y: number; width: number; height: number }
        }> = []
        for (const entry of monitorState.entries) {
          const windowId = liveWindowIdForRef(entry.windowRef)
          if (windowId === null) continue
          entries.push({ windowId, zone: entry.zone, bounds: entry.bounds })
          const clientBounds = tiledFrameRectToClientRect(entry.bounds)
          const localBounds = rectGlobalToCanvasLocal(
            clientBounds.x,
            clientBounds.y,
            clientBounds.width,
            clientBounds.height,
            options.getLayoutCanvasOrigin(),
          )
          tiledGeometry.push({
            windowId,
            x: localBounds.x,
            y: localBounds.y,
            w: localBounds.w,
            h: localBounds.h,
          })
        }
        if (entries.length > 0) {
          monitorTiles.push({
            outputId: targetMonitor.identity,
            outputName: targetMonitor.name,
            entries,
          })
        }
      }
    }
    if (
      !options.sendWorkspaceMutation({
        type: 'restore_session_workspace',
        groups,
        pinnedWindowIds,
        monitorTiles,
        preTileGeometry,
        nextGroupSeq: snapshot.workspace.nextGroupSeq,
      })
    ) {
      return
    }
    for (const geometry of tiledGeometry) {
      options.shellWireSend(
        'set_geometry',
        geometry.windowId,
        geometry.x,
        geometry.y,
        geometry.w,
        geometry.h,
        SHELL_LAYOUT_FLOATING,
      )
    }
    options.bumpSnapChrome()
    options.scheduleExclusionZonesSync()
  }

  function sessionSnapshotHasData(snapshot: SessionSnapshot): boolean {
    return (
      snapshot.shellWindows.length > 0 ||
      snapshot.nativeWindows.length > 0 ||
      snapshot.workspace.groups.length > 0 ||
      snapshot.monitorTiles.length > 0 ||
      snapshot.preTileGeometry.length > 0
    )
  }

  function buildSessionSnapshot(): SessionSnapshot {
    const shellWindows: SavedShellWindow[] = []
    const nativeWindows: SavedNativeWindow[] = []
    for (const window of [...options.getWindowsList()].sort((a, b) => a.stack_z - b.stack_z || a.window_id - b.window_id)) {
      if (windowIsShellHosted(window)) {
        const kind = backedShellWindowKind(window.window_id, window.app_id)
        if (!kind) continue
        let shellWindowState = captureShellWindowState(window.window_id) ?? null
        if (
          shellWindowState == null &&
          shellHostedKindUsesCompositorSessionCapture(kind) &&
          options.getShellHostedAppStateForWindow
        ) {
          const fromCompositor = options.getShellHostedAppStateForWindow(window.window_id)
          if (fromCompositor != null) shellWindowState = fromCompositor
        }
        shellWindows.push({
          windowId: window.window_id,
          windowRef: shellWindowRef(window.window_id),
          kind,
          title: window.title,
          appId: window.app_id,
          outputId: window.output_id,
          outputName: window.output_name,
          bounds: options.rectFromWindow(window),
          minimized: window.minimized,
          maximized: window.maximized,
          fullscreen: window.fullscreen,
          stackZ: window.stack_z,
          state: shellWindowState,
        })
        continue
      }
      const windowRef = nativeWindowRefForId(window.window_id)
      if (!windowRef) continue
      nativeWindows.push({
        windowRef,
        title: window.title,
        appId: window.app_id,
        outputId: window.output_id,
        outputName: window.output_name,
        bounds: options.rectFromWindow(window),
        minimized: window.minimized,
        maximized: window.maximized,
        fullscreen: window.fullscreen,
        launch: options.nativeLaunchMetadataByRef.get(windowRef) ?? null,
      })
    }

    const workspace = options.getWorkspaceState()
    const windowsById = options.getAllWindowsMap()
    return {
      version: 1,
      nextNativeWindowSeq: options.getNextNativeWindowSeq(),
      workspace: {
        groups: workspace.groups.flatMap((group) => {
          const windowRefs = group.windowIds
            .map((windowId) => {
              const window = windowsById.get(windowId)
              return window
                ? windowIsShellHosted(window)
                  ? shellWindowRef(window.window_id)
                  : nativeWindowRefForId(window.window_id)
                : null
            })
            .filter((windowRef): windowRef is SessionWindowRef => windowRef !== null)
          if (windowRefs.length === 0) return []
          const activeWindowRef = windowRefs.find(
            (windowRef) => liveWindowIdForRef(windowRef) === workspace.activeTabByGroupId[group.id],
          )
          return [
            {
              id: group.id,
              windowRefs,
              activeWindowRef: activeWindowRef ?? windowRefs[0],
              splitLeftWindowRef:
                workspace.splitByGroupId[group.id] && workspace.splitByGroupId[group.id]!.leftWindowId > 0
                  ? windowRefs.find(
                      (windowRef) =>
                        liveWindowIdForRef(windowRef) === workspace.splitByGroupId[group.id]!.leftWindowId,
                    ) ?? null
                  : null,
              leftPaneFraction: workspace.splitByGroupId[group.id]?.leftPaneFraction ?? null,
            },
          ]
        }),
        pinnedWindowRefs: workspace.pinnedWindowIds
          .map((windowId) => {
            const window = windowsById.get(windowId)
            return window
              ? windowIsShellHosted(window)
                ? shellWindowRef(window.window_id)
                : nativeWindowRefForId(window.window_id)
              : null
          })
          .filter((windowRef): windowRef is SessionWindowRef => windowRef !== null),
        nextGroupSeq: workspace.nextGroupSeq,
      },
      tilingConfig: loadTilingConfig(),
      monitorTiles: workspace.monitorTiles.map((monitor) => ({
        outputId: monitor.outputId,
        outputName: monitor.outputName,
        entries: monitor.entries
          .map((entry) => {
            const window = windowsById.get(entry.windowId)
            if (!window) return null
            const windowRef = windowIsShellHosted(window)
              ? shellWindowRef(window.window_id)
              : nativeWindowRefForId(window.window_id)
            if (!windowRef) return null
            return {
              windowRef,
              zone: entry.zone,
              bounds: {
                x: entry.bounds.x,
                y: entry.bounds.y,
                width: entry.bounds.width,
                height: entry.bounds.height,
              },
            }
          })
          .filter((entry): entry is SavedMonitorTileState['entries'][number] => entry !== null),
      })),
      preTileGeometry: workspace.preTileGeometry
        .map(({ windowId, bounds }) => {
          const window = windowsById.get(windowId)
          if (!window) return null
          const windowRef = windowIsShellHosted(window)
            ? shellWindowRef(window.window_id)
            : nativeWindowRefForId(window.window_id)
          if (!windowRef) return null
          return {
            windowRef,
            bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          }
        })
        .filter((entry): entry is SessionSnapshot['preTileGeometry'][number] => entry !== null),
      shellWindows,
      nativeWindows,
    }
  }

  function sessionRestoreIsComplete(snapshot: SessionSnapshot): boolean {
    const windowsById = options.getAllWindowsMap()
    for (const shellWindow of snapshot.shellWindows) {
      const live = windowsById.get(shellWindow.windowId)
      if (!live) return false
      if (live.minimized !== shellWindow.minimized) return false
      if (live.maximized !== shellWindow.maximized) return false
      if (live.fullscreen !== shellWindow.fullscreen) return false
    }
    for (const nativeWindow of snapshot.nativeWindows) {
      const liveWindowId = liveWindowIdForRef(nativeWindow.windowRef)
      if (liveWindowId === null) return false
      const live = windowsById.get(liveWindowId)
      if (!live) return false
      if (live.minimized !== nativeWindow.minimized) return false
      if (live.maximized !== nativeWindow.maximized) return false
      if (live.fullscreen !== nativeWindow.fullscreen) return false
    }
    for (const monitorState of snapshot.monitorTiles) {
      const targetMonitor = screenBySavedOutput(monitorState.outputId ?? '', monitorState.outputName)
      if (!targetMonitor) return false
      for (const entry of monitorState.entries) {
        const windowId = liveWindowIdForRef(entry.windowRef)
        if (windowId === null) return false
        const live = windowsById.get(windowId)
        if (!live) return false
        const clientBounds = tiledFrameRectToClientRect(entry.bounds)
        const expectedBounds = rectGlobalToCanvasLocal(
          clientBounds.x,
          clientBounds.y,
          clientBounds.width,
          clientBounds.height,
          options.getLayoutCanvasOrigin(),
        )
        if (
          !rectMatches(
            live,
            {
              x: expectedBounds.x,
              y: expectedBounds.y,
              width: expectedBounds.w,
              height: expectedBounds.h,
            },
            8,
          )
        ) {
          return false
        }
      }
    }
    return true
  }

  return {
    assignNativeWindowRef,
    applyRestoredWorkspace,
    buildSessionSnapshot,
    liveWindowIdForRef,
    nativeWindowRefForId,
    restoreBackedShellWindow,
    restoreWindowModes,
    sessionRestoreIsComplete,
    sessionRestoreSignature,
    sessionSnapshotHasData,
    tryAssignRestoredNativeWindow,
  }
}
