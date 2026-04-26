import { batch, createMemo, createSignal, type Accessor, type Setter } from 'solid-js'
import {
  applyDetail,
  applyDetailMutable,
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
import type { ExternalCommandPaletteState } from '@/features/command-palette/commandPalette'

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
    | 'command_palette_state'
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

type SnapshotAuthoritativeState = {
  focusedWindowId?: number | null
  windows?: { revision: number; rows: unknown[] }
  windowOrder?: { revision: number; rows: unknown[] }
  workspaceSnapshot?: { revision: number; state: WorkspaceSnapshot }
  shellHostedAppByWindow?: { revision: number; byWindowId: Record<number, unknown> }
  commandPalette?: { revision: number; state: ExternalCommandPaletteState }
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

function sameWindowArray(left: readonly DerpWindow[], right: readonly DerpWindow[]): boolean {
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
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.title === right.title &&
    left.app_id === right.app_id &&
    left.output_id === right.output_id &&
    left.output_name === right.output_name &&
    left.kind === right.kind &&
    left.x11_class === right.x11_class &&
    left.x11_instance === right.x11_instance &&
    left.minimized === right.minimized &&
    left.maximized === right.maximized &&
    left.fullscreen === right.fullscreen &&
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

function buildWorkspaceWindowsMapForTouched(
  source: ReadonlyMap<number, DerpWindow>,
  prev: ReadonlyMap<number, DerpWindow>,
  touchedWindowIds: ReadonlySet<number>,
): Map<number, DerpWindow> {
  let next: Map<number, DerpWindow> | null = null
  for (const windowId of touchedWindowIds) {
    const window = source.get(windowId)
    const previousWindow = prev.get(windowId)
    if (!window) {
      if (!previousWindow) continue
      if (!next) next = new Map(prev)
      next.delete(windowId)
      continue
    }
    const stableWindow = previousWindow && workspaceWindowFieldsEqual(previousWindow, window) ? previousWindow : window
    if (previousWindow === stableWindow) continue
    if (!next) next = new Map(prev)
    next.set(windowId, stableWindow)
  }
  return next ?? (prev as Map<number, DerpWindow>)
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

function applyWindowSnapshotDetailsFromSnapshot(
  map: Map<number, DerpWindow>,
  details: readonly DerpShellDetail[],
): Map<number, DerpWindow> {
  let next = map
  let mutated = false
  for (const detail of details) {
    if (!isWindowSnapshotDetail(detail)) continue
    if (!mutated) {
      next = new Map(next)
      mutated = true
    }
    applyDetailMutable(next, detail)
  }
  return mutated ? next : map
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
    if (detail.type === 'command_palette_state') {
      next.commandPalette = {
        revision: coerceRevision(detail.revision),
        state: detail.state,
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
  const [commandPaletteState, setCommandPaletteState] = createSignal<ExternalCommandPaletteState>({
    revision: 0,
    categories: [],
    actions: [],
  })
  const [commandPaletteRevision, setCommandPaletteRevision] = createSignal(-1)
  let pendingFocusedWindowId: number | null = null
  const pendingWindowDetails = new Map<number, Map<DerpShellDetail['type'], DerpShellDetail>>()

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
      if (signal) {
        signal.set(() => undefined)
        windowSignals.delete(windowId)
      }
    }
  }

  const syncTouchedWindowSignals = (
    prev: ReadonlyMap<number, DerpWindow>,
    next: ReadonlyMap<number, DerpWindow>,
    touchedWindowIds: ReadonlySet<number>,
  ) => {
    for (const windowId of touchedWindowIds) {
      const window = next.get(windowId)
      if (prev.get(windowId) === window) continue
      const signal = windowSignals.get(windowId)
      if (window) {
        ensureWindowSignal(windowId).set(() => window)
      } else if (signal) {
        signal.set(() => undefined)
        windowSignals.delete(windowId)
      }
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
  const publishWindows = (
    prev: ReadonlyMap<number, DerpWindow>,
    next: Map<number, DerpWindow>,
    touchedWindowIds?: ReadonlySet<number>,
  ) => {
    if (next === prev) return
    if (touchedWindowIds) {
      syncTouchedWindowSignals(prev, next, touchedWindowIds)
    } else {
      syncWindowSignals(prev, next)
    }
    setWindows(next)
    setWorkspaceWindows((stablePrev) =>
      touchedWindowIds
        ? buildWorkspaceWindowsMapForTouched(next, stablePrev, touchedWindowIds)
        : buildWorkspaceWindowsMap(next, stablePrev),
    )
  }

  const allWindowsMap = createMemo(() => windows())
  const windowById = (windowId: number) => ensureWindowSignal(windowId).get
  const workspaceWindowsMap = createMemo(() => workspaceWindows())
  const windowsListIds = createMemo(() => windowOrderIds())
  const windowsList = createMemo((prev: DerpWindow[] = []) => {
    const out: DerpWindow[] = []
    for (const id of windowsListIds()) {
      const window = allWindowsMap().get(id)
      if (window) out.push(window)
    }
    return sameWindowArray(prev, out) ? prev : out
  })
  const workspaceWindowsList = createMemo((prev: DerpWindow[] = []) => {
    const out: DerpWindow[] = []
    for (const id of windowsListIds()) {
      const window = workspaceWindowsMap().get(id)
      if (window) out.push(window)
    }
    return sameWindowArray(prev, out) ? prev : out
  })
  const liveFocusedWindowId = createMemo(() => {
    const windowId = focusedWindowId()
    return windowId !== null && windows().has(windowId) ? windowId : null
  })

  const applyCompositorDetails = (
    details: readonly DerpShellDetail[],
    _applyOptions: ApplyCompositorDetailOptions,
  ): CompositorApplyResult[] => batch(() => {
    const results: CompositorApplyResult[] = []
    const baseWindows = windows()
    let nextWindows = baseWindows
    let windowsMutated = false
    const touchedWindowIds = new Set<number>()
    let canPublishTouchedOnly = true
    const currentWindows = () => nextWindows
    const queuePendingWindowDetail = (windowId: number, detail: DerpShellDetail) => {
      let pending = pendingWindowDetails.get(windowId)
      if (!pending) {
        pending = new Map()
        pendingWindowDetails.set(windowId, pending)
      }
      pending.set(detail.type, detail)
    }
    const applyPendingWindowDetails = (windowId: number) => {
      const pending = pendingWindowDetails.get(windowId)
      if (!pending || pending.size === 0) return
      pendingWindowDetails.delete(windowId)
      for (const type of ['window_geometry', 'window_metadata', 'window_state'] as const) {
        const detail = pending.get(type)
        if (!detail) continue
        if (applyDetailMutable(ensureMutableWindows(), detail) && windowId !== null) touchedWindowIds.add(windowId)
        if (detail.type === 'window_state' && detail.minimized) {
          setFocusedWindowId((prev) => (prev === windowId ? null : prev))
        }
      }
    }
    const ensureMutableWindows = () => {
      if (!windowsMutated) {
        nextWindows = new Map(nextWindows)
        windowsMutated = true
      }
      return nextWindows
    }

    for (const detail of details) {
      if (detail.type === 'focus_changed') {
        const windowId = coerceShellWindowId(detail.window_id)
        if (windowId !== null) {
          if (!currentWindows().has(windowId)) {
            pendingFocusedWindowId = windowId
            results.push({
              kind: 'ignored',
              detailType: detail.type,
              windowId,
            })
            continue
          }
          pendingFocusedWindowId = null
          setFocusedWindowId((prev) => (prev === windowId ? prev : windowId))
        } else {
          pendingFocusedWindowId = null
          setFocusedWindowId(null)
        }
        results.push({
          kind: 'focus_changed',
          detailType: detail.type,
          windowId,
          followup: { syncExclusion: true, flushWindows: true },
        })
        continue
      }

      if (detail.type === 'window_list') {
        const revision = coerceRevision(detail.revision)
        if (revision !== windowsRevision()) {
          nextWindows = buildWindowsMapFromList(detail.windows, currentWindows())
          windowsMutated = nextWindows !== baseWindows
          canPublishTouchedOnly = false
          const nextOrderIds = collectWindowOrderIds(detail.windows)
          setWindowOrderIds((prev) => (sameNumberArray(prev, nextOrderIds) ? prev : nextOrderIds))
          setWindowsRevision(revision)
        }
        pendingWindowDetails.clear()
        if (pendingFocusedWindowId !== null && nextWindows.get(pendingFocusedWindowId)) {
          setFocusedWindowId((prev) => (prev === pendingFocusedWindowId ? prev : pendingFocusedWindowId))
          pendingFocusedWindowId = null
        }
        results.push({
          kind: 'window_list',
          detailType: detail.type,
          followup: { syncExclusion: true, flushWindows: true },
        })
        continue
      }

      if (detail.type === 'window_order') {
        const revision = coerceRevision(detail.revision)
        if (revision !== windowOrderRevision()) {
          const mutableWindows = ensureMutableWindows()
          if (applyDetailMutable(mutableWindows, detail)) {
            for (const windowId of collectWindowOrderIds(detail.windows)) touchedWindowIds.add(windowId)
          }
          const nextOrderIds = collectWindowOrderIds(detail.windows)
          setWindowOrderIds((prev) => (sameNumberArray(prev, nextOrderIds) ? prev : nextOrderIds))
          setWindowOrderRevision(revision)
        }
        results.push({
          kind: 'window_order',
          detailType: detail.type,
          followup: { syncExclusion: true, flushWindows: true },
        })
        continue
      }

      if (detail.type === 'workspace_state') {
        const revision = coerceRevision(detail.revision)
        if (revision !== workspaceRevision()) {
          const nextState = normalizeWorkspaceSnapshot(detail.state)
          setWorkspaceSnapshot((prev) => (workspaceSnapshotsEqual(prev, nextState) ? prev : nextState))
          setWorkspaceRevision(revision)
        }
        results.push({
          kind: 'workspace_state',
          detailType: detail.type,
        })
        continue
      }

      if (detail.type === 'shell_hosted_app_state') {
        const revision = coerceRevision(detail.revision)
        if (revision !== shellHostedAppRevision()) {
          setShellHostedAppByWindow(shellHostedAppByWindowFromState(detail.state))
          setShellHostedAppRevision(revision)
        }
        results.push({
          kind: 'shell_hosted_app_state',
          detailType: detail.type,
        })
        continue
      }

      if (detail.type === 'command_palette_state') {
        const revision = coerceRevision(detail.revision)
        if (revision !== commandPaletteRevision()) {
          setCommandPaletteState(detail.state)
          setCommandPaletteRevision(revision)
        }
        results.push({
          kind: 'command_palette_state',
          detailType: detail.type,
        })
        continue
      }

      if (detail.type === 'window_state') {
        const windowId = coerceShellWindowId(detail.window_id)
        const previousWindow = windowId !== null ? currentWindows().get(windowId) ?? null : null
        if (windowId !== null && !previousWindow) {
          queuePendingWindowDetail(windowId, detail)
          results.push({
            kind: 'ignored',
            detailType: detail.type,
            windowId,
          })
          continue
        }
        if (detail.minimized && windowId !== null) {
          setFocusedWindowId((prev) => (prev === windowId ? null : prev))
        }
        if (applyDetailMutable(ensureMutableWindows(), detail) && windowId !== null) touchedWindowIds.add(windowId)
        results.push({
          kind: 'window_state',
          detailType: detail.type,
          windowId,
          previousWindow,
          followup: { flushWindows: true },
        })
        continue
      }

      if (detail.type === 'window_unmapped') {
        const windowId = coerceShellWindowId(detail.window_id)
        const previousWindow = windowId !== null ? currentWindows().get(windowId) ?? null : null
        if (windowId !== null) {
          pendingWindowDetails.delete(windowId)
          if (pendingFocusedWindowId === windowId) pendingFocusedWindowId = null
          setFocusedWindowId((prev) => (prev === windowId ? null : prev))
        }
        if (applyDetailMutable(ensureMutableWindows(), detail) && windowId !== null) touchedWindowIds.add(windowId)
        results.push({
          kind: 'window_unmapped',
          detailType: detail.type,
          windowId,
          previousWindow,
          followup: { flushWindows: true },
        })
        continue
      }

      if (detail.type === 'window_geometry') {
        const windowId = coerceShellWindowId(detail.window_id)
        const previousWindow = windowId !== null ? currentWindows().get(windowId) ?? null : null
        if (windowId !== null && !previousWindow) {
          queuePendingWindowDetail(windowId, detail)
          results.push({
            kind: 'ignored',
            detailType: detail.type,
            windowId,
          })
          continue
        }
        if (applyDetailMutable(ensureMutableWindows(), detail) && windowId !== null) touchedWindowIds.add(windowId)
        results.push({
          kind: 'window_geometry',
          detailType: detail.type,
          windowId,
          previousWindow,
        })
        continue
      }

      if (detail.type === 'window_mapped') {
        if (applyDetailMutable(ensureMutableWindows(), detail)) touchedWindowIds.add(detail.window_id)
        applyPendingWindowDetails(detail.window_id)
        const focusMappedWindow = pendingFocusedWindowId === detail.window_id
        if (focusMappedWindow) {
          pendingFocusedWindowId = null
          setFocusedWindowId((prev) => (prev === detail.window_id ? prev : detail.window_id))
        }
        results.push({
          kind: 'window_mapped',
          detailType: detail.type,
          windowId: detail.window_id,
          followup: focusMappedWindow ? { syncExclusion: true, flushWindows: true } : undefined,
        })
        continue
      }

      if (detail.type === 'window_metadata') {
        const windowId = coerceShellWindowId(detail.window_id)
        if (windowId !== null && !currentWindows().has(windowId)) {
          queuePendingWindowDetail(windowId, detail)
          results.push({
            kind: 'ignored',
            detailType: detail.type,
            windowId,
          })
          continue
        }
        if (applyDetailMutable(ensureMutableWindows(), detail) && windowId !== null) touchedWindowIds.add(windowId)
        results.push({
          kind: 'window_metadata',
          detailType: detail.type,
          windowId,
        })
        continue
      }

      results.push({
        kind: 'ignored',
        detailType: detail.type,
      })
    }

    if (windowsMutated) {
      publishWindows(
        baseWindows,
        nextWindows,
        canPublishTouchedOnly && touchedWindowIds.size > 0 ? touchedWindowIds : undefined,
      )
    }
    return results
  })

  const applyCompositorSnapshot = (details: readonly DerpShellDetail[]) => {
    batch(() => {
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
    if (authoritative.commandPalette !== undefined) {
      if (authoritative.commandPalette.revision !== commandPaletteRevision()) {
        setCommandPaletteState(authoritative.commandPalette.state)
        setCommandPaletteRevision(authoritative.commandPalette.revision)
      }
    }
    const nextFocusedWindowId = authoritative.focusedWindowId
    if (nextFocusedWindowId !== undefined) {
      setFocusedWindowId((prev) => (prev === nextFocusedWindowId ? prev : nextFocusedWindowId))
    }
    let hasWindowDetails = false
    const unmappedWindowIds: number[] = []
    for (const detail of details) {
      if (isWindowSnapshotDetail(detail)) {
        hasWindowDetails = true
        if (detail.type === 'window_unmapped') {
          const windowId = coerceShellWindowId(detail.window_id)
          if (windowId !== null) unmappedWindowIds.push(windowId)
        }
      }
    }
    if (hasWindowDetails) {
      commitWindows((map) => applyWindowSnapshotDetailsFromSnapshot(map, details))
      for (const windowId of unmappedWindowIds) {
        setFocusedWindowId((prev) => (prev === windowId ? null : prev))
      }
    }
    })
  }

  const applyCompositorDetail = (
    detail: DerpShellDetail,
    applyOptions: ApplyCompositorDetailOptions,
  ): CompositorApplyResult => applyCompositorDetails([detail], applyOptions)[0]!

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
    commandPaletteState,
    applyCompositorSnapshot,
    applyCompositorDetails,
    applyCompositorDetail,
  }
}
