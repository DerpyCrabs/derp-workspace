import { createMemo, createSignal } from 'solid-js'
import {
  applyDetail,
  buildWindowsMapFromList,
  coerceShellWindowId,
  type DerpShellDetail,
  type DerpWindow,
} from '@/host/appWindowState'
import {
  createEmptyWorkspaceSnapshot,
  workspaceSnapshotsEqual,
  type WorkspaceSnapshot,
} from '@/features/workspace/workspaceSnapshot'

export type CompositorFollowup = {
  flushWindows?: boolean
  syncExclusion?: boolean
  resetScroll?: boolean
}

export type CompositorApplyResult = {
  kind:
    | 'focus_changed'
    | 'window_list'
    | 'window_order'
    | 'workspace_state'
    | 'window_state'
    | 'window_unmapped'
    | 'window_geometry'
    | 'window_mapped'
    | 'window_metadata'
    | 'shell_hosted_app_state'
    | 'ignored'
    | 'recovery_requested'
  detailType: DerpShellDetail['type']
  windowId?: number | null
  previousWindow?: DerpWindow | null
  followup?: CompositorFollowup
}

type CreateCompositorModelOptions = {
  initialWorkspaceState?: WorkspaceSnapshot
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
  windows?: { revision: number; rows: unknown[] }
  windowOrder?: { revision: number; rows: unknown[] }
  workspaceSnapshot?: { revision: number; state: WorkspaceSnapshot }
  shellHostedAppByWindow?: { revision: number; byWindowId: Record<number, unknown> }
}

function coerceRevision(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  const revision = Math.trunc(n)
  return Number.isFinite(revision) && revision >= 0 ? revision : 0
}

function collectWindowOrderIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const ids: number[] = []
  for (const row of raw) {
    if (!row || typeof row !== "object") continue
    const id = coerceShellWindowId((row as Record<string, unknown>).window_id)
    if (id !== null) ids.push(id)
  }
  return ids
}

function sameNumberArray(left: readonly number[], right: readonly number[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function shellHostedAppByWindowFromState(state: { byWindowId?: Record<string, unknown> } | null | undefined) {
  const raw = state?.byWindowId
  if (!raw || typeof raw !== 'object') return {}
  const byWindowId: Record<number, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const id = coerceShellWindowId(key)
    if (id !== null) byWindowId[id] = value
  }
  return byWindowId
}

function collectSnapshotAuthoritativeState(details: readonly DerpShellDetail[]): SnapshotAuthoritativeState {
  const next: SnapshotAuthoritativeState = {}
  for (const detail of details) {
    if (detail.type === 'window_list') {
      next.windows = {
        revision: coerceRevision(detail.revision),
        rows: detail.windows,
      }
      continue
    }
    if (detail.type === 'window_order') {
      next.windowOrder = {
        revision: coerceRevision(detail.revision),
        rows: detail.windows,
      }
      continue
    }
    if (detail.type === 'workspace_state') {
      next.workspaceSnapshot = {
        revision: coerceRevision(detail.revision),
        state: detail.state,
      }
      continue
    }
    if (detail.type === 'shell_hosted_app_state') {
      next.shellHostedAppByWindow = {
        revision: coerceRevision(detail.revision),
        byWindowId: shellHostedAppByWindowFromState(detail.state),
      }
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
  const [windowOrderIds, setWindowOrderIds] = createSignal<number[]>([])
  const [windowOrderRevision, setWindowOrderRevision] = createSignal(-1)
  const [windowsRevision, setWindowsRevision] = createSignal(-1)
  const [workspaceSnapshot, setWorkspaceSnapshot] = createSignal<WorkspaceSnapshot>(
    options.initialWorkspaceState ?? createEmptyWorkspaceSnapshot(),
  )
  const [workspaceRevision, setWorkspaceRevision] = createSignal(-1)
  const [focusedWindowId, setFocusedWindowId] = createSignal<number | null>(null)
  const [shellHostedAppByWindow, setShellHostedAppByWindow] = createSignal<Readonly<Record<number, unknown>>>({})
  const [shellHostedAppRevision, setShellHostedAppRevision] = createSignal(-1)

  const allWindowsMap = createMemo(() => windows())
  const windowsListIds = createMemo(() => windowOrderIds())
  const windowsList = createMemo(() => {
    const out: DerpWindow[] = []
    for (const id of windowsListIds()) {
      const window = allWindowsMap().get(id)
      if (window) out.push(window)
    }
    return out
  })
  const liveFocusedWindowId = createMemo(() => {
    const windowId = focusedWindowId()
    return windowId !== null && windows().has(windowId) ? windowId : null
  })

  const applyCompositorSnapshot = (details: readonly DerpShellDetail[]) => {
    const authoritative = collectSnapshotAuthoritativeState(details)
    let nextWindowsMap: Map<number, DerpWindow> | null = null
    if (authoritative.windows !== undefined) {
      if (authoritative.windows.revision !== windowsRevision()) {
        const nextWindows = buildWindowsMapFromList(authoritative.windows.rows, windows())
        setWindows((prev) => (prev === nextWindows ? prev : nextWindows))
        const nextOrderIds = collectWindowOrderIds(authoritative.windows.rows)
        setWindowOrderIds((prev) => (sameNumberArray(prev, nextOrderIds) ? prev : nextOrderIds))
        setWindowsRevision(authoritative.windows.revision)
        nextWindowsMap = nextWindows
      }
      if (authoritative.focusedWindowId === undefined) {
        const map = nextWindowsMap ?? windows()
        setFocusedWindowId((prev) => (prev != null && map.has(prev) ? prev : null))
      }
    }
    if (authoritative.windowOrder !== undefined) {
      const windowOrder = authoritative.windowOrder
      if (windowOrder.revision !== windowOrderRevision()) {
        setWindows((map) => applyDetail(map, { type: 'window_order', windows: windowOrder.rows }))
        const nextOrderIds = collectWindowOrderIds(windowOrder.rows)
        setWindowOrderIds((prev) => (sameNumberArray(prev, nextOrderIds) ? prev : nextOrderIds))
        setWindowOrderRevision(windowOrder.revision)
      }
    }
    if (authoritative.workspaceSnapshot !== undefined) {
      if (authoritative.workspaceSnapshot.revision !== workspaceRevision()) {
        const nextState = authoritative.workspaceSnapshot.state
        setWorkspaceSnapshot((prev) => (workspaceSnapshotsEqual(prev, nextState) ? prev : nextState))
        setWorkspaceRevision(authoritative.workspaceSnapshot.revision)
      }
    }
    if (authoritative.shellHostedAppByWindow !== undefined) {
      if (authoritative.shellHostedAppByWindow.revision !== shellHostedAppRevision()) {
        setShellHostedAppByWindow(authoritative.shellHostedAppByWindow.byWindowId)
        setShellHostedAppRevision(authoritative.shellHostedAppByWindow.revision)
      }
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
      const revision = coerceRevision(detail.revision)
      if (revision !== windowsRevision()) {
        setWindows((prev) => buildWindowsMapFromList(detail.windows, prev))
        const nextOrderIds = collectWindowOrderIds(detail.windows)
        setWindowOrderIds((prev) => (sameNumberArray(prev, nextOrderIds) ? prev : nextOrderIds))
        setWindowsRevision(revision)
      }
      return {
        kind: 'window_list',
        detailType: detail.type,
        followup: { syncExclusion: true, flushWindows: true },
      }
    }

    if (detail.type === 'window_order') {
      const revision = coerceRevision(detail.revision)
      if (revision !== windowOrderRevision()) {
        setWindows((map) => applyDetail(map, detail))
        const nextOrderIds = collectWindowOrderIds(detail.windows)
        setWindowOrderIds((prev) => (sameNumberArray(prev, nextOrderIds) ? prev : nextOrderIds))
        setWindowOrderRevision(revision)
      }
      return {
        kind: 'window_order',
        detailType: detail.type,
        followup: { syncExclusion: true, flushWindows: true },
      }
    }

    if (detail.type === 'workspace_state') {
      const revision = coerceRevision(detail.revision)
      if (revision !== workspaceRevision()) {
        const nextState = detail.state
        setWorkspaceSnapshot((prev) => (workspaceSnapshotsEqual(prev, nextState) ? prev : nextState))
        setWorkspaceRevision(revision)
      }
      return {
        kind: 'workspace_state',
        detailType: detail.type,
      }
    }

    if (detail.type === 'shell_hosted_app_state') {
      const revision = coerceRevision(detail.revision)
      if (revision !== shellHostedAppRevision()) {
        setShellHostedAppByWindow(shellHostedAppByWindowFromState(detail.state))
        setShellHostedAppRevision(revision)
      }
      return {
        kind: 'shell_hosted_app_state',
        detailType: detail.type,
      }
    }

    if (detail.type === 'window_state') {
      const windowId = coerceShellWindowId(detail.window_id)
      const previousWindow = windowId !== null ? windows().get(windowId) ?? null : null
      if (windowId !== null) {
        if (!previousWindow) {
          return requestRecovery(detail, applyOptions, windowId)
        }
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
        followup: { flushWindows: true },
      }
    }

    if (detail.type === 'window_unmapped') {
      const windowId = coerceShellWindowId(detail.window_id)
      const previousWindow = windowId !== null ? windows().get(windowId) ?? null : null
      if (windowId !== null) {
        setFocusedWindowId((prev) => (prev === windowId ? null : prev))
      }
      setWindows((map) => applyDetail(map, detail))
      return {
        kind: 'window_unmapped',
        detailType: detail.type,
        windowId,
        previousWindow,
        followup: { flushWindows: true },
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
      return {
        kind: 'window_mapped',
        detailType: detail.type,
        windowId: detail.window_id,
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
    workspaceSnapshot,
    setWorkspaceSnapshot,
    focusedWindowId: liveFocusedWindowId,
    setFocusedWindowId,
    shellHostedAppByWindow,
    applyCompositorSnapshot,
    applyCompositorDetail,
  }
}
