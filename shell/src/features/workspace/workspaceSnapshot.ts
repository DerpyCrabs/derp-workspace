import type { Rect, SnapZone } from '@/features/tiling/tileZones'
import {
  WORKSPACE_MONITOR_LAYOUT_TYPES,
  type WorkspaceCustomAutoSlot,
  type WorkspaceGroupSplitState,
  type WorkspaceGroupState,
  type WorkspaceMonitorLayoutParams,
  type WorkspaceMonitorLayoutState,
  type WorkspaceMonitorLayoutType,
  type WorkspaceMonitorTileEntry,
  type WorkspaceMonitorTileState,
  type WorkspacePreTileGeometry,
  type WorkspaceSnapshot,
} from './workspaceProtocol'

export type {
  WorkspaceGroupSplitState,
  WorkspaceGroupState,
  WorkspaceMonitorLayoutParams,
  WorkspaceMonitorLayoutState,
  WorkspaceMonitorLayoutType,
  WorkspaceMonitorTileEntry,
  WorkspaceMonitorTileState,
  WorkspacePreTileGeometry,
  WorkspaceSnapshot,
} from './workspaceProtocol'

export const WORKSPACE_SPLIT_PANE_FRACTION_MIN = 0.3
export const WORKSPACE_SPLIT_PANE_FRACTION_MAX = 0.7
export const WORKSPACE_SPLIT_PANE_FRACTION_DEFAULT = 0.5

export function clampWorkspaceSplitPaneFraction(value: number): number {
  if (!Number.isFinite(value)) return WORKSPACE_SPLIT_PANE_FRACTION_DEFAULT
  return Math.min(
    WORKSPACE_SPLIT_PANE_FRACTION_MAX,
    Math.max(WORKSPACE_SPLIT_PANE_FRACTION_MIN, value),
  )
}

export function cloneWorkspaceSnapshot(state: WorkspaceSnapshot): WorkspaceSnapshot {
  return {
    groups: state.groups.map((group) => ({ id: group.id, windowIds: [...group.windowIds] })),
    activeTabByGroupId: { ...state.activeTabByGroupId },
    pinnedWindowIds: [...(state.pinnedWindowIds ?? [])],
    splitByGroupId: { ...(state.splitByGroupId ?? {}) },
    monitorTiles: state.monitorTiles.map((monitor) => ({
      outputId: monitor.outputId,
      outputName: monitor.outputName,
      entries: monitor.entries.map((entry) => ({
        windowId: entry.windowId,
        zone: entry.zone,
        bounds: { ...entry.bounds },
      })),
    })),
    monitorLayouts: state.monitorLayouts.map((entry) => ({
      outputId: entry.outputId,
      outputName: entry.outputName,
      layout: entry.layout,
      params: { ...entry.params },
    })),
    preTileGeometry: state.preTileGeometry.map((entry) => ({
      windowId: entry.windowId,
      bounds: { ...entry.bounds },
    })),
    nextGroupSeq: state.nextGroupSeq,
  }
}

export function createEmptyWorkspaceSnapshot(): WorkspaceSnapshot {
  return {
    groups: [],
    activeTabByGroupId: {},
    pinnedWindowIds: [],
    splitByGroupId: {},
    monitorTiles: [],
    monitorLayouts: [],
    preTileGeometry: [],
    nextGroupSeq: 1,
  }
}

export function workspaceSnapshotsEqual(a: WorkspaceSnapshot, b: WorkspaceSnapshot): boolean {
  if (a === b) return true
  if (a.nextGroupSeq !== b.nextGroupSeq) return false
  const aActive = Object.keys(a.activeTabByGroupId)
  const bActive = Object.keys(b.activeTabByGroupId)
  if (aActive.length !== bActive.length) return false
  for (const key of aActive) {
    if (a.activeTabByGroupId[key] !== b.activeTabByGroupId[key]) return false
  }
  const aPinned = a.pinnedWindowIds ?? []
  const bPinned = b.pinnedWindowIds ?? []
  if (aPinned.length !== bPinned.length) return false
  for (let index = 0; index < aPinned.length; index += 1) {
    if (aPinned[index] !== bPinned[index]) return false
  }
  const aSplits = Object.keys(a.splitByGroupId ?? {})
  const bSplits = Object.keys(b.splitByGroupId ?? {})
  if (aSplits.length !== bSplits.length) return false
  for (const key of aSplits) {
    const splitA = a.splitByGroupId[key]
    const splitB = b.splitByGroupId[key]
    if (!splitA || !splitB) return false
    if (splitA.leftWindowId !== splitB.leftWindowId) return false
    if (splitA.leftPaneFraction !== splitB.leftPaneFraction) return false
  }
  if (a.monitorTiles.length !== b.monitorTiles.length) return false
  for (let monitorIndex = 0; monitorIndex < a.monitorTiles.length; monitorIndex += 1) {
      const monitorA = a.monitorTiles[monitorIndex]
      const monitorB = b.monitorTiles[monitorIndex]
      if ((monitorA.outputId ?? '') !== (monitorB.outputId ?? '')) return false
      if (monitorA.outputName !== monitorB.outputName) return false
    if (monitorA.entries.length !== monitorB.entries.length) return false
    for (let entryIndex = 0; entryIndex < monitorA.entries.length; entryIndex += 1) {
      const entryA = monitorA.entries[entryIndex]
      const entryB = monitorB.entries[entryIndex]
      if (entryA.windowId !== entryB.windowId) return false
      if (entryA.zone !== entryB.zone) return false
      if (entryA.bounds.x !== entryB.bounds.x) return false
      if (entryA.bounds.y !== entryB.bounds.y) return false
      if (entryA.bounds.width !== entryB.bounds.width) return false
      if (entryA.bounds.height !== entryB.bounds.height) return false
    }
  }
  if (a.monitorLayouts.length !== b.monitorLayouts.length) return false
  for (let layoutIndex = 0; layoutIndex < a.monitorLayouts.length; layoutIndex += 1) {
    const layoutA = a.monitorLayouts[layoutIndex]
    const layoutB = b.monitorLayouts[layoutIndex]
    if ((layoutA.outputId ?? '') !== (layoutB.outputId ?? '')) return false
    if (layoutA.outputName !== layoutB.outputName) return false
    if (layoutA.layout !== layoutB.layout) return false
    if (layoutA.params.masterRatio !== layoutB.params.masterRatio) return false
    if (layoutA.params.maxColumns !== layoutB.params.maxColumns) return false
    if (layoutA.params.customLayoutId !== layoutB.params.customLayoutId) return false
    const slotsA = layoutA.params.customSlots ?? []
    const slotsB = layoutB.params.customSlots ?? []
    if (slotsA.length !== slotsB.length) return false
    for (let slotIndex = 0; slotIndex < slotsA.length; slotIndex += 1) {
      const slotA = slotsA[slotIndex]
      const slotB = slotsB[slotIndex]
      if (slotA.slotId !== slotB.slotId) return false
      if (slotA.x !== slotB.x || slotA.y !== slotB.y || slotA.width !== slotB.width || slotA.height !== slotB.height) return false
    }
  }
  if (a.preTileGeometry.length !== b.preTileGeometry.length) return false
  for (let entryIndex = 0; entryIndex < a.preTileGeometry.length; entryIndex += 1) {
    const entryA = a.preTileGeometry[entryIndex]
    const entryB = b.preTileGeometry[entryIndex]
    if (entryA.windowId !== entryB.windowId) return false
    if (entryA.bounds.x !== entryB.bounds.x) return false
    if (entryA.bounds.y !== entryB.bounds.y) return false
    if (entryA.bounds.width !== entryB.bounds.width) return false
    if (entryA.bounds.height !== entryB.bounds.height) return false
  }
  if (a.groups.length !== b.groups.length) return false
  for (let index = 0; index < a.groups.length; index += 1) {
    const groupA = a.groups[index]
    const groupB = b.groups[index]
    if (groupA.id !== groupB.id) return false
    if (groupA.windowIds.length !== groupB.windowIds.length) return false
    for (let windowIndex = 0; windowIndex < groupA.windowIds.length; windowIndex += 1) {
      if (groupA.windowIds[windowIndex] !== groupB.windowIds[windowIndex]) return false
    }
  }
  return true
}

function normalizeWindowIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const out: number[] = []
  const seen = new Set<number>()
  for (const value of raw) {
    const num = typeof value === 'number' ? value : Number(value)
    const id = Math.trunc(num)
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function clampWorkspaceInsertIndex(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.trunc(value)))
}

function normalizePinnedWindowIds(raw: unknown): number[] {
  return normalizeWindowIds(raw)
}

function isSnapZone(value: unknown): value is SnapZone {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeRect(raw: unknown): Rect | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const x = Math.trunc(typeof record.x === 'number' ? record.x : Number(record.x))
  const y = Math.trunc(typeof record.y === 'number' ? record.y : Number(record.y))
  const width = Math.trunc(typeof record.width === 'number' ? record.width : Number(record.width))
  const height = Math.trunc(typeof record.height === 'number' ? record.height : Number(record.height))
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null
  }
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

function normalizeSplitByGroupId(
  raw: unknown,
  groups: readonly WorkspaceGroupState[],
): Record<string, WorkspaceGroupSplitState> {
  if (!raw || typeof raw !== 'object') return {}
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  const out: Record<string, WorkspaceGroupSplitState> = {}
  for (const [groupId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const group = groupsById.get(groupId)
    if (!group) continue
    const record = value as Record<string, unknown>
    const rawLeft =
      typeof record.leftWindowId === 'number' ? record.leftWindowId : Number(record.leftWindowId)
    const leftWindowId = Math.trunc(rawLeft)
    if (!Number.isFinite(leftWindowId) || !group.windowIds.includes(leftWindowId)) continue
    if (group.windowIds.filter((windowId) => windowId !== leftWindowId).length === 0) continue
    const rawFraction =
      typeof record.leftPaneFraction === 'number'
        ? record.leftPaneFraction
        : Number(record.leftPaneFraction)
    out[groupId] = {
      leftWindowId,
      leftPaneFraction: clampWorkspaceSplitPaneFraction(rawFraction),
    }
  }
  return out
}

function normalizeMonitorTiles(raw: unknown): WorkspaceMonitorTileState[] {
  if (!Array.isArray(raw)) return []
  const out: WorkspaceMonitorTileState[] = []
  const usedWindows = new Set<number>()
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const record = value as Record<string, unknown>
    const outputName =
      typeof record.outputName === 'string' && record.outputName.trim().length > 0
        ? record.outputName.trim()
        : ''
    const outputId =
      typeof record.outputId === 'string' && record.outputId.trim().length > 0
        ? record.outputId.trim()
        : undefined
    if (!outputName) continue
    const entriesRaw = Array.isArray(record.entries) ? record.entries : []
    const entries: WorkspaceMonitorTileEntry[] = []
    for (const entryValue of entriesRaw) {
      if (!entryValue || typeof entryValue !== 'object') continue
      const entryRecord = entryValue as Record<string, unknown>
      const windowId = Math.trunc(
        typeof entryRecord.windowId === 'number' ? entryRecord.windowId : Number(entryRecord.windowId),
      )
      if (!Number.isFinite(windowId) || windowId <= 0 || usedWindows.has(windowId)) continue
      const zone = isSnapZone(entryRecord.zone) ? entryRecord.zone : null
      const bounds = normalizeRect(entryRecord.bounds)
      if (!zone || !bounds) continue
      usedWindows.add(windowId)
      entries.push({ windowId, zone, bounds })
    }
    if (entries.length > 0) out.push({ outputId, outputName, entries })
  }
  return out
}

function normalizePreTileGeometry(raw: unknown): WorkspacePreTileGeometry[] {
  if (!Array.isArray(raw)) return []
  const out: WorkspacePreTileGeometry[] = []
  const seen = new Set<number>()
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const record = value as Record<string, unknown>
    const windowId = Math.trunc(typeof record.windowId === 'number' ? record.windowId : Number(record.windowId))
    if (!Number.isFinite(windowId) || windowId <= 0 || seen.has(windowId)) continue
    const bounds = normalizeRect(record.bounds)
    if (!bounds) continue
    seen.add(windowId)
    out.push({ windowId, bounds })
  }
  return out
}

function isWorkspaceMonitorLayoutType(value: unknown): value is WorkspaceMonitorLayoutType {
  return typeof value === 'string' && WORKSPACE_MONITOR_LAYOUT_TYPES.includes(value as WorkspaceMonitorLayoutType)
}

function workspaceOutputKey(outputName: string, outputId?: string): string {
  return outputId ? `id:${outputId}` : `name:${outputName}`
}

function normalizeMonitorLayouts(raw: unknown): WorkspaceMonitorLayoutState[] {
  if (!Array.isArray(raw)) return []
  const out: WorkspaceMonitorLayoutState[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const record = value as Record<string, unknown>
    const outputName =
      typeof record.outputName === 'string' && record.outputName.trim().length > 0
        ? record.outputName.trim()
        : ''
    const outputId =
      typeof record.outputId === 'string' && record.outputId.trim().length > 0
        ? record.outputId.trim()
        : undefined
    const layout = isWorkspaceMonitorLayoutType(record.layout) ? record.layout : null
    const outputKey = workspaceOutputKey(outputName, outputId)
    if (!outputName || !layout || seen.has(outputKey)) continue
    seen.add(outputKey)
    const paramsRaw = record.params
    const params: WorkspaceMonitorLayoutParams = {}
    if (paramsRaw && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw)) {
      const paramsRecord = paramsRaw as Record<string, unknown>
      const masterRatio =
        typeof paramsRecord.masterRatio === 'number'
          ? paramsRecord.masterRatio
          : Number(paramsRecord.masterRatio)
      if (Number.isFinite(masterRatio)) params.masterRatio = masterRatio
      const maxColumns =
        typeof paramsRecord.maxColumns === 'number'
          ? paramsRecord.maxColumns
          : Number(paramsRecord.maxColumns)
      if (Number.isFinite(maxColumns) && Math.trunc(maxColumns) >= 1) {
        params.maxColumns = Math.trunc(maxColumns)
      }
      if (typeof paramsRecord.customLayoutId === 'string' && paramsRecord.customLayoutId.trim()) {
        params.customLayoutId = paramsRecord.customLayoutId.trim()
      }
      if (Array.isArray(paramsRecord.customSlots)) {
        const customSlots: WorkspaceCustomAutoSlot[] = []
        for (const slot of paramsRecord.customSlots) {
          if (!slot || typeof slot !== 'object' || Array.isArray(slot)) continue
          const slotRecord = slot as Record<string, unknown>
          const slotId = typeof slotRecord.slotId === 'string' ? slotRecord.slotId.trim() : ''
          const x = typeof slotRecord.x === 'number' ? slotRecord.x : Number(slotRecord.x)
          const y = typeof slotRecord.y === 'number' ? slotRecord.y : Number(slotRecord.y)
          const width = typeof slotRecord.width === 'number' ? slotRecord.width : Number(slotRecord.width)
          const height = typeof slotRecord.height === 'number' ? slotRecord.height : Number(slotRecord.height)
          if (!slotId || ![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue
          customSlots.push({ slotId, x, y, width, height })
        }
        if (customSlots.length > 0) params.customSlots = customSlots
      }
    }
    out.push({ outputId, outputName, layout, params })
  }
  return out
}

export function firstWorkspaceSplitRightWindowId(group: WorkspaceGroupState, leftWindowId: number): number | null {
  return group.windowIds.find((windowId) => windowId !== leftWindowId) ?? null
}

export function ensureValidWorkspaceSplitState(state: WorkspaceSnapshot): void {
  state.splitByGroupId = normalizeSplitByGroupId(state.splitByGroupId, state.groups)
  for (const group of state.groups) {
    const split = state.splitByGroupId[group.id]
    if (!split) continue
    const rightWindowId = firstWorkspaceSplitRightWindowId(group, split.leftWindowId)
    if (rightWindowId === null) {
      delete state.splitByGroupId[group.id]
      continue
    }
    const activeWindowId = state.activeTabByGroupId[group.id]
    if (activeWindowId === split.leftWindowId || !group.windowIds.includes(activeWindowId)) {
      state.activeTabByGroupId[group.id] = rightWindowId
    }
  }
}

export function workspaceWithoutGroupSplit(
  splitByGroupId: Record<string, WorkspaceGroupSplitState>,
  groupId: string,
): Record<string, WorkspaceGroupSplitState> {
  if (!splitByGroupId[groupId]) return splitByGroupId
  const next = { ...splitByGroupId }
  delete next[groupId]
  return next
}

export function normalizedWorkspaceActiveWindowId(
  state: WorkspaceSnapshot,
  group: WorkspaceGroupState,
  windowId: number,
): number {
  const split = state.splitByGroupId[group.id]
  if (!split || split.leftWindowId !== windowId) return windowId
  return firstWorkspaceSplitRightWindowId(group, split.leftWindowId) ?? windowId
}

export function leadingPinnedWorkspaceWindowCount(
  state: WorkspaceSnapshot,
  group: WorkspaceGroupState,
  excludeWindowId?: number,
): number {
  const pinned = new Set(state.pinnedWindowIds)
  let count = 0
  for (const windowId of group.windowIds) {
    if (windowId === excludeWindowId) continue
    if (!pinned.has(windowId)) break
    count += 1
  }
  return count
}

function ensurePinnedWindowIds(state: WorkspaceSnapshot): void {
  const live = new Set(allWorkspaceWindowIds(state))
  state.pinnedWindowIds = state.pinnedWindowIds.filter((windowId) => live.has(windowId))
}

export function insertWindowIntoWorkspaceGroup(
  state: WorkspaceSnapshot,
  group: WorkspaceGroupState,
  windowId: number,
  insertIndex: number,
): void {
  group.windowIds = group.windowIds.filter((entry) => entry !== windowId)
  const pinned = state.pinnedWindowIds.includes(windowId)
  const pinnedCount = leadingPinnedWorkspaceWindowCount(state, group)
  const clamped =
    pinned
      ? clampWorkspaceInsertIndex(insertIndex, pinnedCount)
      : Math.max(pinnedCount, clampWorkspaceInsertIndex(insertIndex, group.windowIds.length))
  group.windowIds.splice(clamped, 0, windowId)
}

export function normalizeWorkspaceSnapshot(raw: unknown): WorkspaceSnapshot {
  const state = createEmptyWorkspaceSnapshot()
  if (!raw || typeof raw !== 'object') return state
  const source = raw as Record<string, unknown>
  const groupsRaw = Array.isArray(source.groups) ? source.groups : []
  const usedGroupIds = new Set<string>()
  for (const entry of groupsRaw) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' && record.id.trim().length > 0 ? record.id.trim() : ''
    if (!id || usedGroupIds.has(id)) continue
    const windowIds = normalizeWindowIds(record.windowIds)
    if (windowIds.length === 0) continue
    usedGroupIds.add(id)
    state.groups.push({ id, windowIds })
  }
  const activeRaw =
    source.activeTabByGroupId && typeof source.activeTabByGroupId === 'object'
      ? (source.activeTabByGroupId as Record<string, unknown>)
      : {}
  for (const group of state.groups) {
    const rawActive = activeRaw[group.id]
    const num = typeof rawActive === 'number' ? rawActive : Number(rawActive)
    const active = Math.trunc(num)
    if (Number.isFinite(active) && group.windowIds.includes(active)) {
      state.activeTabByGroupId[group.id] = active
    }
  }
  state.pinnedWindowIds = normalizePinnedWindowIds(source.pinnedWindowIds)
  state.splitByGroupId = normalizeSplitByGroupId(source.splitByGroupId, state.groups)
  state.monitorTiles = normalizeMonitorTiles(source.monitorTiles)
  state.monitorLayouts = normalizeMonitorLayouts(source.monitorLayouts)
  state.preTileGeometry = normalizePreTileGeometry(source.preTileGeometry)
  const nextRaw = typeof source.nextGroupSeq === 'number' ? source.nextGroupSeq : Number(source.nextGroupSeq)
  const nextSeq = Math.trunc(nextRaw)
  state.nextGroupSeq =
    Number.isFinite(nextSeq) && nextSeq > 0 ? nextSeq : inferNextGroupSeq(state)
  return reconcileWorkspaceSnapshot(state, allWorkspaceWindowIds(state))
}

function inferNextGroupSeq(state: WorkspaceSnapshot): number {
  let next = 1
  for (const group of state.groups) {
    const match = /^group-(\d+)$/.exec(group.id)
    if (!match) continue
    const seq = Number(match[1])
    if (Number.isFinite(seq) && seq >= next) next = seq + 1
  }
  return next
}

export function withRefreshedDerivedWorkspaceIndexes(state: WorkspaceSnapshot): WorkspaceSnapshot {
  return state
}

export function allWorkspaceWindowIds(state: WorkspaceSnapshot): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const group of state.groups) {
    for (const windowId of group.windowIds) {
      if (seen.has(windowId)) continue
      seen.add(windowId)
      out.push(windowId)
    }
  }
  return out
}

export function groupIdForWindow(state: WorkspaceSnapshot, windowId: number): string | null {
  for (const group of state.groups) {
    if (group.windowIds.includes(windowId)) return group.id
  }
  return null
}

export function getWorkspaceGroupSplit(
  state: WorkspaceSnapshot,
  groupId: string,
): WorkspaceGroupSplitState | undefined {
  return state.splitByGroupId[groupId]
}

export function isWorkspaceWindowPinned(state: WorkspaceSnapshot, windowId: number): boolean {
  return state.pinnedWindowIds.includes(windowId)
}

export function workspaceIsWindowTiled(state: WorkspaceSnapshot, windowId: number): boolean {
  return state.monitorTiles.some((monitor) => monitor.entries.some((entry) => entry.windowId === windowId))
}

export function workspaceFindMonitorForTiledWindow(state: WorkspaceSnapshot, windowId: number): string | null {
  for (const monitor of state.monitorTiles) {
    if (monitor.entries.some((entry) => entry.windowId === windowId)) return monitor.outputName
  }
  return null
}

export function workspaceFindMonitorIdentityForTiledWindow(state: WorkspaceSnapshot, windowId: number): string | null {
  for (const monitor of state.monitorTiles) {
    if (monitor.entries.some((entry) => entry.windowId === windowId)) return monitor.outputId || null
  }
  return null
}

export function workspaceGetTiledZone(state: WorkspaceSnapshot, windowId: number): SnapZone | undefined {
  for (const monitor of state.monitorTiles) {
    const entry = monitor.entries.find((candidate) => candidate.windowId === windowId)
    if (entry) return entry.zone
  }
  return undefined
}

export function workspaceGetPreTileGeometry(state: WorkspaceSnapshot, windowId: number): Rect | undefined {
  return state.preTileGeometry.find((entry) => entry.windowId === windowId)?.bounds
}

export function workspaceMonitorTileEntries(
  state: WorkspaceSnapshot,
  outputName: string,
  outputId?: string | null,
): WorkspaceMonitorTileEntry[] {
  return state.monitorTiles.find((monitor) =>
    outputId && monitor.outputId ? monitor.outputId === outputId : monitor.outputName === outputName,
  )?.entries ?? []
}

export function reconcileWorkspaceSnapshot(
  state: WorkspaceSnapshot,
  liveWindowIds: readonly number[],
): WorkspaceSnapshot {
  const next = cloneWorkspaceSnapshot(state)
  const live = new Set(normalizeWindowIds([...liveWindowIds]))
  const filteredGroups: WorkspaceGroupState[] = []
  const activeTabByGroupId: Record<string, number> = {}
  const assigned = new Set<number>()
  for (const group of next.groups) {
    const windowIds = group.windowIds.filter((windowId) => live.has(windowId) && !assigned.has(windowId))
    if (windowIds.length === 0) continue
    for (const windowId of windowIds) assigned.add(windowId)
    filteredGroups.push({ id: group.id, windowIds })
    const active = next.activeTabByGroupId[group.id]
    activeTabByGroupId[group.id] = windowIds.includes(active) ? active : windowIds[0]
  }
  next.groups = filteredGroups
  next.activeTabByGroupId = activeTabByGroupId
  const missing = [...live].filter((windowId) => !assigned.has(windowId)).sort((a, b) => a - b)
  for (const windowId of missing) {
    const groupId = `group-${next.nextGroupSeq++}`
    next.groups.push({ id: groupId, windowIds: [windowId] })
    next.activeTabByGroupId[groupId] = windowId
  }
  next.monitorTiles = next.monitorTiles
    .map((monitor) => ({
      outputId: monitor.outputId,
      outputName: monitor.outputName,
      entries: monitor.entries.filter((entry) => live.has(entry.windowId)),
    }))
    .filter((monitor) => monitor.entries.length > 0)
  next.preTileGeometry = next.preTileGeometry.filter((entry) => live.has(entry.windowId))
  ensurePinnedWindowIds(next)
  ensureValidWorkspaceSplitState(next)
  return next
}
