import { batch, createMemo, createSignal, getOwner, runWithOwner, type Accessor } from 'solid-js'
import {
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
import { shellUiWindowView, type ShellUiWindowView } from '@/features/shell-ui/shellUiWindowView'

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

export type CompositorAuthoritativeDomainClears = {
  windows?: boolean
  windowOrder?: boolean
  focus?: boolean
  workspace?: boolean
  shellHostedApps?: boolean
  commandPalette?: boolean
}

type CreateCompositorModelOptions = {
  initialWorkspaceState?: WorkspaceSnapshot
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
  const entries: { id: number; stack: number; index: number }[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const id = coerceShellWindowId(record.window_id)
    if (id === null) continue
    const rawStack = record.stack_z
    const stack = typeof rawStack === 'number' && Number.isFinite(rawStack) ? Math.trunc(rawStack) : 0
    entries.push({ id, stack, index: entries.length })
  }
  return entries
    .sort((left, right) => right.stack - left.stack || right.id - left.id || left.index - right.index)
    .map((entry) => entry.id)
}

function filterWindowOrderIds(ids: readonly number[], windows: ReadonlyMap<number, DerpWindow>): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const id of ids) {
    if (!windows.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function sameNumberArray(left: readonly number[], right: readonly number[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function sameWindowArray<T>(left: readonly T[], right: readonly T[]): boolean {
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
  const modelOwner = getOwner()
  const [windows, setWindows] = createSignal<Map<number, DerpWindow>>(new Map())
  const windowAccessors = new Map<number, Accessor<DerpWindow | undefined>>()
  const shellUiWindowAccessors = new Map<number, Accessor<ShellUiWindowView | undefined>>()
  const [windowOrderIds, setWindowOrderIds] = createSignal<number[]>([])
  const [windowsRevision, setWindowsRevision] = createSignal(-1)
  const [windowOrderRevision, setWindowOrderRevision] = createSignal(-1)
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
  const windowById = (windowId: number) => {
    let accessor = windowAccessors.get(windowId)
    if (!accessor) {
      const createAccessor = () => createMemo(() => windows().get(windowId), undefined, { equals: Object.is })
      accessor = modelOwner ? (runWithOwner(modelOwner, createAccessor) ?? createAccessor()) : createAccessor()
      windowAccessors.set(windowId, accessor)
    }
    return accessor
  }

  const commitWindows = (updater: (prev: Map<number, DerpWindow>) => Map<number, DerpWindow>) => {
    setWindows((prev) => {
      const next = updater(prev)
      return next
    })
  }

  const allWindowsMap = createMemo(() => windows())
  const workspaceWindowsMap = createMemo(() => windows())
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
  const shellUiWindowsMap = createMemo((previous: ReadonlyMap<number, ShellUiWindowView> = new Map()) => {
    const next = new Map<number, ShellUiWindowView>()
    let changed = previous.size !== allWindowsMap().size
    for (const [windowId, window] of allWindowsMap()) {
      const view = shellUiWindowView(window, previous.get(windowId))
      next.set(windowId, view)
      if (previous.get(windowId) !== view) changed = true
    }
    return changed ? next : previous
  })
  const shellUiWindowsList = createMemo((previous: ShellUiWindowView[] = []) => {
    const out: ShellUiWindowView[] = []
    const map = shellUiWindowsMap()
    for (const id of windowsListIds()) {
      const window = map.get(id)
      if (window) out.push(window)
    }
    return sameWindowArray(previous, out) ? previous : out
  })
  const shellUiWindowById = (windowId: number) => {
    let accessor = shellUiWindowAccessors.get(windowId)
    if (!accessor) {
      const createAccessor = () => createMemo(() => shellUiWindowsMap().get(windowId), undefined, { equals: Object.is })
      accessor = modelOwner ? (runWithOwner(modelOwner, createAccessor) ?? createAccessor()) : createAccessor()
      shellUiWindowAccessors.set(windowId, accessor)
    }
    return accessor
  }
  const liveFocusedWindowId = createMemo(() => {
    const windowId = focusedWindowId()
    return windowId !== null && windows().has(windowId) ? windowId : null
  })

  const followupForIncrementalDetail = (detail: DerpShellDetail): CompositorFollowup | undefined => {
    switch (detail.type) {
      case 'focus_changed':
      case 'window_list':
      case 'window_order':
      case 'window_geometry':
      case 'window_mapped':
      case 'window_state':
      case 'window_unmapped':
      case 'workspace_state':
        return { syncExclusion: true, flushWindows: true }
      case 'window_metadata':
      case 'shell_hosted_app_state':
      case 'command_palette_state':
        return { flushWindows: true }
      default:
        return undefined
    }
  }

  const ignoredCompositorResult = (detail: DerpShellDetail): CompositorApplyResult => ({
    kind: 'ignored',
    detailType: detail.type,
    windowId: 'window_id' in detail ? coerceShellWindowId(detail.window_id) : undefined,
    followup: followupForIncrementalDetail(detail),
  })

  const applyIncrementalWakeupDetails = (details: readonly DerpShellDetail[]): CompositorApplyResult[] =>
    details.map(ignoredCompositorResult)

  const applyAuthoritativeSnapshotDetails = (details: readonly DerpShellDetail[]) => {
    batch(() => {
      const authoritative = collectSnapshotAuthoritativeState(details)
      let nextWindowsForOrder = windows()
      let windowsChanged = false
      if (authoritative.windows !== undefined) {
        windowsChanged = authoritative.windows.revision !== windowsRevision()
        const nextWindows = windowsChanged ? buildWindowsMapFromList(authoritative.windows.rows, windows()) : windows()
        nextWindowsForOrder = nextWindows
        if (windowsChanged) {
          commitWindows((prev) => (prev === nextWindows ? prev : nextWindows))
          setWindowsRevision(authoritative.windows.revision)
        }
        if (authoritative.windowOrder === undefined && windowsChanged) {
          const nextOrderIds = collectWindowOrderIds(authoritative.windows.rows)
          setWindowOrderIds((prev) => (sameNumberArray(prev, nextOrderIds) ? prev : nextOrderIds))
        }
        if (authoritative.focusedWindowId === undefined) {
          setFocusedWindowId((prev) => (prev != null && nextWindows.has(prev) ? prev : null))
        }
      }
      if (authoritative.windowOrder !== undefined) {
        if (authoritative.windowOrder.revision !== windowOrderRevision() || windowsChanged) {
          const nextOrderIds = filterWindowOrderIds(
            collectWindowOrderIds(authoritative.windowOrder.rows),
            nextWindowsForOrder,
          )
          setWindowOrderIds((prev) => (sameNumberArray(prev, nextOrderIds) ? prev : nextOrderIds))
          setWindowOrderRevision(authoritative.windowOrder.revision)
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
    })
  }

  const clearAuthoritativeSnapshotDomains = (clears: CompositorAuthoritativeDomainClears) => {
    batch(() => {
      if (clears.windows) {
        setWindows((prev) => (prev.size === 0 ? prev : new Map()))
        setWindowsRevision(-1)
        setFocusedWindowId(null)
      }
      if (clears.windowOrder || clears.windows) {
        setWindowOrderIds((prev) => (prev.length === 0 ? prev : []))
        setWindowOrderRevision(-1)
      }
      if (clears.focus) {
        setFocusedWindowId(null)
      }
      if (clears.workspace) {
        const empty = createEmptyWorkspaceSnapshot()
        setWorkspaceSnapshot((prev) => (workspaceSnapshotsEqual(prev, empty) ? prev : empty))
        setWorkspaceRevision(-1)
      }
      if (clears.shellHostedApps) {
        setShellHostedAppByWindow((prev) => (Object.keys(prev).length === 0 ? prev : {}))
        setShellHostedAppRevision(-1)
      }
      if (clears.commandPalette) {
        setCommandPaletteState((prev) =>
          prev.categories.length === 0 && prev.actions.length === 0 && prev.revision === 0
            ? prev
            : { revision: 0, categories: [], actions: [] },
        )
        setCommandPaletteRevision(-1)
      }
    })
  }

  const applyIncrementalWakeupDetail = (detail: DerpShellDetail): CompositorApplyResult =>
    applyIncrementalWakeupDetails([detail])[0]!

  return {
    windows,
    allWindowsMap,
    windowById,
    workspaceWindowsMap,
    windowsListIds,
    windowsList,
    workspaceWindowsList,
    shellUiWindowsMap,
    shellUiWindowsList,
    shellUiWindowById,
    workspaceSnapshot,
    focusedWindowId: liveFocusedWindowId,
    shellHostedAppByWindow,
    commandPaletteState,
    applyAuthoritativeSnapshotDetails,
    clearAuthoritativeSnapshotDomains,
    applyIncrementalWakeupDetails,
    applyIncrementalWakeupDetail,
  }
}
