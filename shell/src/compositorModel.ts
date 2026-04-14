import { createEffect, createMemo, createSignal } from 'solid-js'
import { SHELL_WINDOW_FLAG_SHELL_HOSTED } from './shellUiWindows'
import {
  applyDetail,
  buildWindowsMapFromList,
  coerceShellWindowId,
  type DerpShellDetail,
  type DerpWindow,
} from './app/appWindowState'
import {
  loadWorkspaceState,
  persistWorkspaceState,
  reconcileWorkspaceState,
  workspaceStatesEqual,
  type WorkspaceState,
} from './workspaceState'

export type CompositorFollowup = {
  flushWindows?: boolean
  syncExclusion?: boolean
  relayoutAll?: boolean
  relayoutMonitor?: string | null
  resetScroll?: boolean
}

export type CompositorApplyResult = {
  kind:
    | 'focus_changed'
    | 'window_list'
    | 'window_state'
    | 'window_unmapped'
    | 'window_geometry'
    | 'window_mapped'
    | 'window_metadata'
    | 'ignored'
    | 'recovery_requested'
  detailType: DerpShellDetail['type']
  windowId?: number | null
  previousWindow?: DerpWindow | null
  followup?: CompositorFollowup
}

type CreateCompositorModelOptions = {
  initialWorkspaceState?: WorkspaceState
}

type ApplyCompositorDetailOptions = {
  fallbackMonitorKey: () => string
  requestWindowSyncRecovery: () => void
}

export function createCompositorModel(options: CreateCompositorModelOptions = {}) {
  const [windows, setWindows] = createSignal<Map<number, DerpWindow>>(new Map())
  const [workspaceState, setWorkspaceState] = createSignal<WorkspaceState>(
    options.initialWorkspaceState ?? loadWorkspaceState(),
  )
  const [focusedWindowId, setFocusedWindowId] = createSignal<number | null>(null)

  const allWindowsMap = createMemo(() => windows())
  const windowsListIds = createMemo(() => Array.from(allWindowsMap().keys()).sort((a, b) => a - b))
  const windowsList = createMemo(() => {
    const out: DerpWindow[] = []
    for (const id of windowsListIds()) {
      const window = allWindowsMap().get(id)
      if (window) out.push(window)
    }
    return out
  })

  createEffect(() => {
    const liveWindowIds = windowsListIds()
    setWorkspaceState((prev) => {
      const next = reconcileWorkspaceState(prev, liveWindowIds)
      return workspaceStatesEqual(prev, next) ? prev : next
    })
  })

  createEffect(() => {
    persistWorkspaceState(workspaceState())
  })

  const applyCompositorDetail = (
    detail: DerpShellDetail,
    applyOptions: ApplyCompositorDetailOptions,
  ): CompositorApplyResult => {
    if (detail.type === 'focus_changed') {
      const windowId = coerceShellWindowId(detail.window_id)
      if (windowId !== null) {
        if (!windows().has(windowId)) {
          return {
            kind: 'ignored',
            detailType: detail.type,
            windowId,
          }
        }
        setFocusedWindowId((prev) => (prev === windowId ? prev : windowId))
        setWindows((map) => applyDetail(map, detail))
      } else {
        setFocusedWindowId((prev) => {
          if (prev == null) return null
          const previousWindow = windows().get(prev)
          if (previousWindow && (previousWindow.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) !== 0) {
            return prev
          }
          return null
        })
      }
      return {
        kind: 'focus_changed',
        detailType: detail.type,
        windowId,
        followup: { syncExclusion: true, flushWindows: true },
      }
    }

    if (detail.type === 'window_list') {
      setWindows((prev) => buildWindowsMapFromList(detail.windows, prev))
      return {
        kind: 'window_list',
        detailType: detail.type,
        followup: { syncExclusion: true, flushWindows: true },
      }
    }

    if (detail.type === 'window_state') {
      const windowId = coerceShellWindowId(detail.window_id)
      const previousWindow = windowId !== null ? windows().get(windowId) ?? null : null
      let relayoutMonitor: string | null = null
      if (windowId !== null) {
        if (!previousWindow) {
          return {
            kind: 'ignored',
            detailType: detail.type,
            windowId,
          }
        }
        relayoutMonitor = previousWindow.output_name || applyOptions.fallbackMonitorKey()
      }
      if (detail.minimized && windowId !== null) {
        setFocusedWindowId((prev) => (prev === windowId ? null : prev))
      }
      setWindows((map) => applyDetail(map, detail))
      return {
        kind: 'window_state',
        detailType: detail.type,
        windowId,
        previousWindow,
        followup: { flushWindows: true, relayoutMonitor },
      }
    }

    if (detail.type === 'window_unmapped') {
      const windowId = coerceShellWindowId(detail.window_id)
      const previousWindow = windowId !== null ? windows().get(windowId) ?? null : null
      let relayoutMonitor: string | null = null
      if (windowId !== null) {
        setFocusedWindowId((prev) => (prev === windowId ? null : prev))
        if (previousWindow) relayoutMonitor = previousWindow.output_name || applyOptions.fallbackMonitorKey()
      }
      setWindows((map) => applyDetail(map, detail))
      return {
        kind: 'window_unmapped',
        detailType: detail.type,
        windowId,
        previousWindow,
        followup: { flushWindows: true, relayoutMonitor },
      }
    }

    if (detail.type === 'window_geometry') {
      const windowId = coerceShellWindowId(detail.window_id)
      const previousWindow = windowId !== null ? windows().get(windowId) ?? null : null
      if (windowId !== null && !previousWindow) {
        return {
          kind: 'ignored',
          detailType: detail.type,
          windowId,
        }
      }
      setWindows((map) => applyDetail(map, detail))
      return {
        kind: 'window_geometry',
        detailType: detail.type,
        windowId,
        previousWindow,
      }
    }

    if (detail.type === 'window_mapped') {
      setWindows((map) => applyDetail(map, detail))
      const monitorName =
        typeof detail.output_name === 'string' && detail.output_name.length > 0
          ? detail.output_name
          : applyOptions.fallbackMonitorKey()
      return {
        kind: 'window_mapped',
        detailType: detail.type,
        windowId: detail.window_id,
        followup: { relayoutMonitor: monitorName },
      }
    }

    if (detail.type === 'window_metadata') {
      const windowId = coerceShellWindowId(detail.window_id)
      if (windowId !== null && !windows().has(windowId)) {
        return {
          kind: 'ignored',
          detailType: detail.type,
          windowId,
        }
      }
      setWindows((map) => applyDetail(map, detail))
      return {
        kind: 'window_metadata',
        detailType: detail.type,
        windowId,
      }
    }

    return {
      kind: 'ignored',
      detailType: detail.type,
    }
  }

  return {
    windows,
    setWindows,
    allWindowsMap,
    windowsListIds,
    windowsList,
    workspaceState,
    setWorkspaceState,
    focusedWindowId,
    setFocusedWindowId,
    applyCompositorDetail,
  }
}
