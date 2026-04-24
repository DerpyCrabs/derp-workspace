import { createMemo, createSignal, type Accessor, type Setter } from 'solid-js'
import {
  applyDetail,
  buildWindowsMapFromList,
  coerceShellWindowId,
  type DerpShellDetail,
  type DerpWindow,
} from '@/host/appWindowState'
import {
  createEmptyWorkspaceSnapshot,
  normalizeWorkspaceSnapshot,
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

function workspaceWindowFieldsEqual(left: DerpWindow, right: DerpWindow): boolean {
  return (
    left.window_id === right.window_id &&
    left.surface_id === right.surface_id &&
    left.stack_z === right.stack_z &&
    left.title === right.title &&
    left.app_id === right.app_id &&
    left.output_id === right.output_id &&
    left.output_name === right.output_name &&
    left.kind === right.kind &&
    left.x11_class === right.x11_class &&
    left.x11_instance === right.x11_instance &&
    left.minimized === right.minimized &&
    left.shell_flags === right.shell_flags &&
    left.capture_identifier === right.capture_identifier &&
    left.workspace_visible === right.workspace_visible
  )
}

function buildWorkspaceWindowsMap(
  source: ReadonlyMap<number, DerpWindow>,
  prev: ReadonlyMap<number, DerpWindow>,
): Map<number, DerpWindow> {
  let identical = source.size === prev.size
  const next = new Map<number, DerpWindow>()
  for (const [windowId, window] of source) {
    const previousWindow = prev.get(windowId)
    const stableWindow = previousWindow && workspaceWindowFieldsEqual(previousWindow, window) ? previousWindow : window
    next.set(windowId, stableWindow)
    if (identical && prev.get(windowId) !== stableWindow) identical = false
  }
  return identical ? (prev as Map<number, DerpWindow>) : next
}

function isWindowSnapshotDetail(detail: DerpShellDetail) {
  return (
    detail.type === 'window_geometry' ||
    detail.type === 'window_metadata' ||
    detail.type === 'window_state' ||
    detail.type === 'window_mapped' ||
    detail.type === 'window_unmapped'
  )
}

function applyWindowSnapshotDetails(
  map: Map<number, DerpWindow>,
  details: readonly DerpShellDetail[],
): Map<number, DerpWindow> {
  let next = map
  for (const detail of details) {
    next = applyDetail(next, detail)
  }
  return next
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
  const [workspaceWindows, setWorkspaceWindows] = createSignal<Map<number, DerpWindow>>(new Map())
  const windowSignals = new Map<
    number,
    { get: Accessor<DerpWindow | undefined>; set: Setter<DerpWindow | undefined> }
  >()
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

  const ensureWindowSignal = (windowId: number) => {
    let signal = windowSignals.get(windowId)
    if (!signal) {
      const [get, set] = createSignal<DerpWindow | undefined>(windows().get(windowId), { equals: Object.is })
      signal = { get, set }
      windowSignals.set(windowId, signal)
    }
    return signal
  }

  const syncWindowSignals = (prev: ReadonlyMap<number, DerpWindow>, next: ReadonlyMap<number, DerpWindow>) => {
    for (const [windowId, window] of next) {
      if (prev.get(windowId) === window) continue
      ensureWindowSignal(windowId).set(() => window)
    }
    for (const windowId of prev.keys()) {
      if (next.has(windowId)) continue
      const signal = windowSignals.get(windowId)
      if (signal) signal.set(() => undefined)
    }
  }

  const commitWindows = (updater: (prev: Map<number, DerpWindow>) => Map<number, DerpWindow>) => {
    setWindows((prev) => {
      const next = updater(prev)
      if (next !== prev) {
        syncWindowSignals(prev, next)
        setWorkspaceWindows((stablePrev) => buildWorkspaceWindowsMap(next, stablePrev))
      }
      return next
    })
  }

  const allWindowsMap = createMemo(() => windows())
  const windowById = (windowId: number) => ensureWindowSignal(windowId).get
  const workspaceWindowsMap = createMemo(() => workspaceWindows())
  const windowsListIds = createMemo(() => windowOrderIds())
  const windowsList = createMemo(() => {
    const out: DerpWindow[] = []
    for (const id of windowsListIds()) {
      const window = allWindowsMap().get(id)
      if (window) out.push(window)
    }
    return out
  })
  const workspaceWindowsList = createMemo(() => {
    const out: DerpWindow[] = []
    for (const id of windowsListIds()) {
      const window = workspaceWindowsMap().get(id)
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
        commitWindows((prev) => (prev === nextWindows ? prev : nextWindows))
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
        commitWindows((map) => applyDetail(map, { type: 'window_order', windows: windowOrder.rows }))
        const nextOrderIds = collectWindowOrderIds(windowOrder.rows)
        setWindowOrderIds((prev) => (sameNumberArray(prev, nextOrderIds) ? prev : nextOrderIds))
        setWindowOrderRevision(windowOrder.revision)
      }
    }
    if (authoritative.workspaceSnapshot !== undefined) {
      if (authoritative.workspaceSnapshot.revision !== workspaceRevision()) {
        const nextState = normalizeWorkspaceSnapshot(authoritative.workspaceSnapshot.state)
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
    const windowDetails = details.filter(isWindowSnapshotDetail)
    if (windowDetails.length > 0) {
      commitWindows((map) => applyWindowSnapshotDetails(map, windowDetails))
      for (const detail of windowDetails) {
        if (detail.type !== 'window_unmapped') continue
        const windowId = coerceShellWindowId(detail.window_id)
        if (windowId !== null) setFocusedWindowId((prev) => (prev === windowId ? null : prev))
      }
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
        commitWindows((map) => applyDetail(map, detail))
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
        commitWindows((prev) => buildWindowsMapFromList(detail.windows, prev))
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
        commitWindows((map) => applyDetail(map, detail))
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
        const nextState = normalizeWorkspaceSnapshot(detail.state)
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
      commitWindows((map) => applyDetail(map, detail))
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
      commitWindows((map) => applyDetail(map, detail))
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
      commitWindows((map) => applyDetail(map, detail))
      return {
        kind: 'window_geometry',
        detailType: detail.type,
        windowId,
        previousWindow,
      }
    }

    if (detail.type === 'window_mapped') {
      commitWindows((map) => applyDetail(map, detail))
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
      commitWindows((map) => applyDetail(map, detail))
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
    setWindows: commitWindows,
    allWindowsMap,
    windowById,
    workspaceWindowsMap,
    windowsListIds,
    windowsList,
    workspaceWindowsList,
    workspaceSnapshot,
    setWorkspaceSnapshot,
    focusedWindowId: liveFocusedWindowId,
    setFocusedWindowId,
    shellHostedAppByWindow,
    applyCompositorSnapshot,
    applyCompositorDetail,
  }
}
