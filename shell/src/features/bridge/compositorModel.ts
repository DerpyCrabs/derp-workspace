import { createMemo, createSignal } from 'solid-js'
import {
  applyDetail,
  buildWindowsMapFromList,
  coerceShellWindowId,
  type DerpShellDetail,
  type DerpWindow,
} from '@/host/appWindowState'
import {
  normalizeWorkspaceState,
  createEmptyWorkspaceState,
  workspaceStatesEqual,
  type WorkspaceState,
} from '@/features/workspace/workspaceState'

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
    | 'workspace_state'
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

function requestRecovery(
  detail: DerpShellDetail,
  applyOptions: ApplyCompositorDetailOptions,
  windowId?: number | null,
): CompositorApplyResult {
  applyOptions.requestWindowSyncRecovery()
  return {
    kind: 'recovery_requested',
    detailType: detail.type,
    windowId,
  }
}

type SnapshotAuthoritativeState = {
  focusedWindowId?: number | null
  windows?: unknown[]
  workspaceState?: WorkspaceState
}

function collectSnapshotAuthoritativeState(details: readonly DerpShellDetail[]): SnapshotAuthoritativeState {
  const next: SnapshotAuthoritativeState = {}
  for (const detail of details) {
    if (detail.type === 'window_list') {
      next.windows = detail.windows
      continue
    }
    if (detail.type === 'workspace_state') {
      next.workspaceState = normalizeWorkspaceState(detail.state)
      continue
    }
    if (detail.type === 'focus_changed') {
      next.focusedWindowId = coerceShellWindowId(detail.window_id)
    }
  }
  return next
}

export function createCompositorModel(options: CreateCompositorModelOptions = {}) {
  const [windows, setWindows] = createSignal<Map<number, DerpWindow>>(new Map())
  const [workspaceState, setWorkspaceState] = createSignal<WorkspaceState>(
    options.initialWorkspaceState ?? createEmptyWorkspaceState(),
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

  const applyCompositorSnapshot = (details: readonly DerpShellDetail[]) => {
    const authoritative = collectSnapshotAuthoritativeState(details)
    if (authoritative.windows !== undefined) {
      const nextWindows = buildWindowsMapFromList(authoritative.windows, windows())
      setWindows((prev) => (prev === nextWindows ? prev : nextWindows))
      if (authoritative.focusedWindowId === undefined) {
        setFocusedWindowId((prev) => (prev != null && nextWindows.has(prev) ? prev : null))
      }
    }
    if (authoritative.workspaceState !== undefined) {
      setWorkspaceState((prev) =>
        workspaceStatesEqual(prev, authoritative.workspaceState!) ? prev : authoritative.workspaceState!,
      )
    }
    const nextFocusedWindowId = authoritative.focusedWindowId
    if (nextFocusedWindowId !== undefined) {
      setFocusedWindowId((prev) => (prev === nextFocusedWindowId ? prev : nextFocusedWindowId))
    }
  }

  const applyCompositorDetail = (
    detail: DerpShellDetail,
    applyOptions: ApplyCompositorDetailOptions,
  ): CompositorApplyResult => {
    if (detail.type === 'focus_changed') {
      const windowId = coerceShellWindowId(detail.window_id)
      if (windowId !== null) {
        if (!windows().has(windowId)) {
          return requestRecovery(detail, applyOptions, windowId)
        }
        setFocusedWindowId((prev) => (prev === windowId ? prev : windowId))
        setWindows((map) => applyDetail(map, detail))
      } else {
        setFocusedWindowId(null)
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

    if (detail.type === 'workspace_state') {
      const nextState = normalizeWorkspaceState(detail.state)
      setWorkspaceState((prev) => (workspaceStatesEqual(prev, nextState) ? prev : nextState))
      return {
        kind: 'workspace_state',
        detailType: detail.type,
      }
    }

    if (detail.type === 'window_state') {
      const windowId = coerceShellWindowId(detail.window_id)
      const previousWindow = windowId !== null ? windows().get(windowId) ?? null : null
      let relayoutMonitor: string | null = null
      if (windowId !== null) {
        if (!previousWindow) {
          return requestRecovery(detail, applyOptions, windowId)
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
        return requestRecovery(detail, applyOptions, windowId)
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
        return requestRecovery(detail, applyOptions, windowId)
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
    applyCompositorSnapshot,
    applyCompositorDetail,
  }
}
