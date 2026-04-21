import { backedShellWindowKind } from '@/features/shell-ui/backedShellWindows'
import { shellHostedKindUsesCompositorSessionCapture } from '@/features/shell-ui/shellHostedAppsRegistry'
import { captureShellWindowState, primeShellWindowState } from '@/features/shell-ui/shellWindowState'
import { monitorWorkAreaGlobal } from '@/features/tiling/tileSnap'
import type { SnapZone } from '@/features/tiling/tileZones'
import { getMonitorLayout, loadTilingConfig } from '@/features/tiling/tilingConfig'
import {
  enterWorkspaceSplitView,
  exitWorkspaceSplitView,
  getWorkspaceGroupSplit,
  groupIdForWindow as workspaceStateGroupIdForWindow,
  isWorkspaceWindowPinned,
  moveWorkspaceWindowToGroup,
  reconcileWorkspaceState,
  setWorkspaceActiveTab,
  setWorkspaceSplitFraction,
  setWorkspaceWindowPinned,
  splitWorkspaceWindowToOwnGroup,
  type WorkspaceState,
} from '@/features/workspace/workspaceState'
import type { DerpWindow } from '@/host/appWindowState'
import { windowIsShellHosted } from '@/host/appWindowState'
import type { LayoutScreen } from '@/host/types'
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
  getWindowsListIds: () => number[]
  getWorkspaceState: () => WorkspaceState
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
  sendWorkspaceMutation: (mutation: { type: 'replace_state'; state: WorkspaceState }) => boolean
  sendSetPreTileGeometry: (windowId: number, bounds: { x: number; y: number; w: number; h: number }) => boolean
  sendSetMonitorTile: (
    windowId: number,
    outputName: string,
    zone: SnapZone,
    bounds: { x: number; y: number; width: number; height: number },
  ) => boolean
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
      .map((screen) => screen.name)
      .join(',')
    return `${shellWindowIds}|${nativeWindowKeys}|${outputs}|${options.getTilingCfgRev()}`
  }

  function savedWindowBoundsToLocalRect(bounds: SavedRect, outputName: string): SavedRect {
    const screens = options.getTaskbarScreens()
    const target = screens.find((screen) => screen.name === outputName) ?? screens[0] ?? null
    if (!target) return bounds
    const reserveTb = options.reserveTaskbarForMon(target)
    const work = monitorWorkAreaGlobal(target, reserveTb)
    const globalRect = rectCanvasLocalToGlobal(
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      options.getLayoutCanvasOrigin(),
    )
    const fitsOutput =
      outputName === target.name &&
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
    const bounds = savedWindowBoundsToLocalRect(record.bounds, record.outputName)
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
          splitLeftWindowId:
            splitLeftWindowId !== null && windowIds.includes(splitLeftWindowId) ? splitLeftWindowId : null,
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
    let planned = reconcileWorkspaceState(options.getWorkspaceState(), options.getWindowsListIds())
    const restoredWindowIds = new Set(groups.flatMap((group) => group.windowIds))
    const desiredGroupByWindowId = new Map<number, string>()
    for (const group of groups) {
      for (const windowId of group.windowIds) desiredGroupByWindowId.set(windowId, group.id)
    }
    for (const windowId of [...planned.pinnedWindowIds]) {
      if (!restoredWindowIds.has(windowId)) continue
      planned = setWorkspaceWindowPinned(planned, windowId, false)
    }

    for (const group of groups) {
      const anchorWindowId = group.windowIds[0]
      const sourceGroupId = workspaceStateGroupIdForWindow(planned, anchorWindowId)
      const currentGroupId = sourceGroupId ?? null
      const currentGroup = currentGroupId
        ? planned.groups.find((entry) => entry.id === currentGroupId) ?? null
        : null
      const needsOwnGroup =
        !currentGroup ||
        currentGroup.windowIds.length !== 1 ||
        currentGroup.windowIds[0] !== anchorWindowId ||
        currentGroup.windowIds.some((windowId) => desiredGroupByWindowId.get(windowId) !== group.id)
      if (needsOwnGroup) {
        planned = splitWorkspaceWindowToOwnGroup(planned, anchorWindowId)
      }
      let targetGroupId = planned.groups.find((entry) => entry.windowIds[0] === anchorWindowId)?.id ?? null
      if (!targetGroupId) continue
      for (let index = 1; index < group.windowIds.length; index += 1) {
        const windowId = group.windowIds[index]
        const targetGroup = planned.groups.find((entry) => entry.id === targetGroupId) ?? null
        const sameGroup = workspaceStateGroupIdForWindow(planned, windowId) === targetGroupId
        const sameIndex = targetGroup?.windowIds[index] === windowId
        if (!sameGroup || !sameIndex) {
          planned = moveWorkspaceWindowToGroup(planned, windowId, targetGroupId, index)
          targetGroupId =
            planned.groups.find((entry) => entry.windowIds.includes(anchorWindowId))?.id ?? targetGroupId
        }
      }
      const split = getWorkspaceGroupSplit(planned, targetGroupId)
      if (group.splitLeftWindowId !== null) {
        if (!split || split.leftWindowId !== group.splitLeftWindowId) {
          const leftPaneFraction = group.leftPaneFraction ?? 0.5
          planned = enterWorkspaceSplitView(planned, targetGroupId, group.splitLeftWindowId, leftPaneFraction)
        } else if (split.leftPaneFraction !== (group.leftPaneFraction ?? 0.5)) {
          const leftPaneFraction = group.leftPaneFraction ?? 0.5
          planned = setWorkspaceSplitFraction(planned, targetGroupId, leftPaneFraction)
        }
      } else if (split) {
        planned = exitWorkspaceSplitView(planned, targetGroupId)
      }
      const normalizedActiveWindowId =
        planned.groups.find((entry) => entry.id === targetGroupId)?.windowIds.includes(group.activeWindowId)
          ? setWorkspaceActiveTab(planned, targetGroupId, group.activeWindowId).activeTabByGroupId[targetGroupId]
          : planned.activeTabByGroupId[targetGroupId]
      if (normalizedActiveWindowId !== planned.activeTabByGroupId[targetGroupId]) {
        planned = setWorkspaceActiveTab(planned, targetGroupId, group.activeWindowId)
      }
    }

    const desiredPinned = new Set(pinnedWindowIds)
    for (const windowId of restoredWindowIds) {
      const pinned = desiredPinned.has(windowId)
      if (isWorkspaceWindowPinned(planned, windowId) === pinned) continue
      planned = setWorkspaceWindowPinned(planned, windowId, pinned)
    }
    planned = {
      ...planned,
      monitorTiles: [],
      preTileGeometry: [],
    }
    if (!options.sendWorkspaceMutation({ type: 'replace_state', state: planned })) return

    for (const entry of snapshot.preTileGeometry) {
      const windowId = liveWindowIdForRef(entry.windowRef)
      if (windowId === null) continue
      if (
        !options.sendSetPreTileGeometry(windowId, {
          x: entry.bounds.x,
          y: entry.bounds.y,
          w: entry.bounds.width,
          h: entry.bounds.height,
        })
      ) {
        return
      }
    }
    const screens = options.getTaskbarScreens()
    if (screens.length > 0) {
      for (const monitorState of snapshot.monitorTiles) {
        const targetMonitor =
          screens.find((screen) => screen.name === monitorState.outputName) ?? screens[0] ?? null
        if (!targetMonitor || getMonitorLayout(targetMonitor.name).layout.type !== 'manual-snap') continue
        for (const entry of monitorState.entries) {
          const windowId = liveWindowIdForRef(entry.windowRef)
          if (windowId === null) continue
          if (!options.sendSetMonitorTile(windowId, targetMonitor.name, entry.zone, entry.bounds)) {
            return
          }
        }
      }
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
    }
    for (const nativeWindow of snapshot.nativeWindows) {
      const liveWindowId = liveWindowIdForRef(nativeWindow.windowRef)
      if (liveWindowId === null) return false
      const live = windowsById.get(liveWindowId)
      if (!live) return false
      if (live.minimized !== nativeWindow.minimized) return false
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
