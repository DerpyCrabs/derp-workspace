import type { Rect, SnapZone } from '@/features/tiling/tileZones'

export type WorkspaceGroupState = {
  id: string
  windowIds: number[]
}

export type WorkspaceGroupSplitState = {
  leftWindowId: number
  leftPaneFraction: number
}

export type WorkspaceMonitorTileEntry = {
  windowId: number
  zone: SnapZone
  bounds: Rect
}

export type WorkspaceMonitorTileState = {
  outputName: string
  entries: WorkspaceMonitorTileEntry[]
}

export type WorkspacePreTileGeometry = {
  windowId: number
  bounds: Rect
}

export type WorkspaceMonitorLayoutType = 'manual-snap' | 'master-stack' | 'columns' | 'grid'

export type WorkspaceMonitorLayoutParams = {
  masterRatio?: number
  maxColumns?: number
}

export type WorkspaceMonitorLayoutState = {
  outputName: string
  layout: WorkspaceMonitorLayoutType
  params: WorkspaceMonitorLayoutParams
}

export type WorkspaceState = {
  groups: WorkspaceGroupState[]
  activeTabByGroupId: Record<string, number>
  pinnedWindowIds: number[]
  splitByGroupId: Record<string, WorkspaceGroupSplitState>
  monitorTiles: WorkspaceMonitorTileState[]
  monitorLayouts: WorkspaceMonitorLayoutState[]
  preTileGeometry: WorkspacePreTileGeometry[]
  nextGroupSeq: number
}

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

function cloneState(state: WorkspaceState): WorkspaceState {
  return {
    groups: state.groups.map((group) => ({ id: group.id, windowIds: [...group.windowIds] })),
    activeTabByGroupId: { ...state.activeTabByGroupId },
    pinnedWindowIds: [...(state.pinnedWindowIds ?? [])],
    splitByGroupId: { ...(state.splitByGroupId ?? {}) },
    monitorTiles: state.monitorTiles.map((monitor) => ({
      outputName: monitor.outputName,
      entries: monitor.entries.map((entry) => ({
        windowId: entry.windowId,
        zone: entry.zone,
        bounds: { ...entry.bounds },
      })),
    })),
    monitorLayouts: state.monitorLayouts.map((entry) => ({
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

export function createEmptyWorkspaceState(): WorkspaceState {
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

export function workspaceStatesEqual(a: WorkspaceState, b: WorkspaceState): boolean {
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
    if (layoutA.outputName !== layoutB.outputName) return false
    if (layoutA.layout !== layoutB.layout) return false
    if (layoutA.params.masterRatio !== layoutB.params.masterRatio) return false
    if (layoutA.params.maxColumns !== layoutB.params.maxColumns) return false
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

function clampIndex(value: number, max: number): number {
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
    if (entries.length > 0) out.push({ outputName, entries })
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
  return value === 'manual-snap' || value === 'master-stack' || value === 'columns' || value === 'grid'
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
    const layout = isWorkspaceMonitorLayoutType(record.layout) ? record.layout : null
    if (!outputName || !layout || seen.has(outputName)) continue
    seen.add(outputName)
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
    }
    out.push({ outputName, layout, params })
  }
  return out
}

function firstRightWindowId(group: WorkspaceGroupState, leftWindowId: number): number | null {
  return group.windowIds.find((windowId) => windowId !== leftWindowId) ?? null
}

function ensureValidSplitState(state: WorkspaceState): void {
  state.splitByGroupId = normalizeSplitByGroupId(state.splitByGroupId, state.groups)
  for (const group of state.groups) {
    const split = state.splitByGroupId[group.id]
    if (!split) continue
    const rightWindowId = firstRightWindowId(group, split.leftWindowId)
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

function withoutGroupSplit(
  splitByGroupId: Record<string, WorkspaceGroupSplitState>,
  groupId: string,
): Record<string, WorkspaceGroupSplitState> {
  if (!splitByGroupId[groupId]) return splitByGroupId
  const next = { ...splitByGroupId }
  delete next[groupId]
  return next
}

function normalizedRequestedActiveWindowId(
  state: WorkspaceState,
  group: WorkspaceGroupState,
  windowId: number,
): number {
  const split = state.splitByGroupId[group.id]
  if (!split || split.leftWindowId !== windowId) return windowId
  return firstRightWindowId(group, split.leftWindowId) ?? windowId
}

function leadingPinnedWindowCount(
  state: WorkspaceState,
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

function ensurePinnedWindowIds(state: WorkspaceState): void {
  const live = new Set(allWorkspaceWindowIds(state))
  state.pinnedWindowIds = state.pinnedWindowIds.filter((windowId) => live.has(windowId))
}

function insertIntoGroup(
  state: WorkspaceState,
  group: WorkspaceGroupState,
  windowId: number,
  insertIndex: number,
): void {
  group.windowIds = group.windowIds.filter((entry) => entry !== windowId)
  const pinned = state.pinnedWindowIds.includes(windowId)
  const pinnedCount = leadingPinnedWindowCount(state, group)
  const clamped =
    pinned
      ? clampIndex(insertIndex, pinnedCount)
      : Math.max(pinnedCount, clampIndex(insertIndex, group.windowIds.length))
  group.windowIds.splice(clamped, 0, windowId)
}

export function normalizeWorkspaceState(raw: unknown): WorkspaceState {
  const state = createEmptyWorkspaceState()
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
  return reconcileWorkspaceState(state, allWorkspaceWindowIds(state))
}

function inferNextGroupSeq(state: WorkspaceState): number {
  let next = 1
  for (const group of state.groups) {
    const match = /^group-(\d+)$/.exec(group.id)
    if (!match) continue
    const seq = Number(match[1])
    if (Number.isFinite(seq) && seq >= next) next = seq + 1
  }
  return next
}

export function allWorkspaceWindowIds(state: WorkspaceState): number[] {
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

export function groupIdForWindow(state: WorkspaceState, windowId: number): string | null {
  for (const group of state.groups) {
    if (group.windowIds.includes(windowId)) return group.id
  }
  return null
}

export function reconcileWorkspaceState(
  state: WorkspaceState,
  liveWindowIds: readonly number[],
): WorkspaceState {
  const next = cloneState(state)
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
      outputName: monitor.outputName,
      entries: monitor.entries.filter((entry) => live.has(entry.windowId)),
    }))
    .filter((monitor) => monitor.entries.length > 0)
  next.preTileGeometry = next.preTileGeometry.filter((entry) => live.has(entry.windowId))
  ensurePinnedWindowIds(next)
  ensureValidSplitState(next)
  return next
}

export function setWorkspaceActiveTab(
  state: WorkspaceState,
  groupId: string,
  windowId: number,
): WorkspaceState {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group || !group.windowIds.includes(windowId)) return state
  const nextWindowId = normalizedRequestedActiveWindowId(state, group, windowId)
  if (state.activeTabByGroupId[groupId] === nextWindowId) return state
  return {
    groups: state.groups.map((entry) => ({
      id: entry.id,
      windowIds: [...entry.windowIds],
    })),
    activeTabByGroupId: {
      ...state.activeTabByGroupId,
      [groupId]: nextWindowId,
    },
    pinnedWindowIds: [...(state.pinnedWindowIds ?? [])],
    splitByGroupId: { ...(state.splitByGroupId ?? {}) },
    monitorTiles: state.monitorTiles.map((monitor) => ({
      outputName: monitor.outputName,
      entries: monitor.entries.map((entry) => ({ ...entry, bounds: { ...entry.bounds } })),
    })),
    monitorLayouts: state.monitorLayouts.map((entry) => ({ ...entry, params: { ...entry.params } })),
    preTileGeometry: state.preTileGeometry.map((entry) => ({ ...entry, bounds: { ...entry.bounds } })),
    nextGroupSeq: state.nextGroupSeq,
  }
}

export function isWorkspaceWindowPinned(state: WorkspaceState, windowId: number): boolean {
  return state.pinnedWindowIds.includes(windowId)
}

export function reorderWorkspaceWindowInGroup(
  state: WorkspaceState,
  groupId: string,
  windowId: number,
  insertIndex: number,
): WorkspaceState {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group || !group.windowIds.includes(windowId)) return state
  const next = cloneState(state)
  const nextGroup = next.groups.find((entry) => entry.id === groupId)
  if (!nextGroup) return state
  const before = nextGroup.windowIds.join(',')
  insertIntoGroup(next, nextGroup, windowId, insertIndex)
  return nextGroup.windowIds.join(',') === before ? state : next
}

export function moveWorkspaceWindowToGroup(
  state: WorkspaceState,
  sourceWindowId: number,
  targetGroupId: string,
  insertIndex: number,
): WorkspaceState {
  const sourceGroupId = groupIdForWindow(state, sourceWindowId)
  if (!sourceGroupId) return state
  if (sourceGroupId === targetGroupId) {
    return reorderWorkspaceWindowInGroup(state, targetGroupId, sourceWindowId, insertIndex)
  }
  const next = cloneState(state)
  const sourceGroup = next.groups.find((group) => group.id === sourceGroupId)
  const targetGroup = next.groups.find((group) => group.id === targetGroupId)
  if (!sourceGroup || !targetGroup || !sourceGroup.windowIds.includes(sourceWindowId)) return state
  sourceGroup.windowIds = sourceGroup.windowIds.filter((windowId) => windowId !== sourceWindowId)
  insertIntoGroup(next, targetGroup, sourceWindowId, insertIndex)
  if (sourceGroup.windowIds.length === 0) {
    next.groups = next.groups.filter((group) => group.id !== sourceGroupId)
    delete next.activeTabByGroupId[sourceGroupId]
    next.splitByGroupId = withoutGroupSplit(next.splitByGroupId, sourceGroupId)
  } else {
    const sourceActive = next.activeTabByGroupId[sourceGroupId]
    next.activeTabByGroupId[sourceGroupId] = sourceGroup.windowIds.includes(sourceActive)
      ? sourceActive
      : sourceGroup.windowIds[0]
  }
  next.splitByGroupId = withoutGroupSplit(next.splitByGroupId, targetGroupId)
  next.activeTabByGroupId[targetGroupId] =
    next.activeTabByGroupId[targetGroupId] && targetGroup.windowIds.includes(next.activeTabByGroupId[targetGroupId])
      ? next.activeTabByGroupId[targetGroupId]
      : targetGroup.windowIds[0]
  ensureValidSplitState(next)
  return next
}

export function moveWorkspaceGroupToGroup(
  state: WorkspaceState,
  sourceGroupId: string,
  targetGroupId: string,
  insertIndex: number,
): WorkspaceState {
  if (sourceGroupId === targetGroupId) return state
  const sourceGroup = state.groups.find((group) => group.id === sourceGroupId)
  const targetGroup = state.groups.find((group) => group.id === targetGroupId)
  if (!sourceGroup || !targetGroup || sourceGroup.windowIds.length === 0) return state
  const movingWindowIds = [...sourceGroup.windowIds]
  const next = cloneState(state)
  const nextSourceGroup = next.groups.find((group) => group.id === sourceGroupId)
  const nextTargetGroup = next.groups.find((group) => group.id === targetGroupId)
  if (!nextSourceGroup || !nextTargetGroup) return state
  nextSourceGroup.windowIds = []
  const targetInsertIndex = clampIndex(insertIndex, nextTargetGroup.windowIds.length)
  const movingPinnedWindowIds = movingWindowIds.filter((windowId) => next.pinnedWindowIds.includes(windowId))
  const movingUnpinnedWindowIds = movingWindowIds.filter((windowId) => !next.pinnedWindowIds.includes(windowId))
  let pinnedInsertIndex = Math.min(targetInsertIndex, leadingPinnedWindowCount(next, nextTargetGroup))
  for (const windowId of movingPinnedWindowIds) {
    insertIntoGroup(next, nextTargetGroup, windowId, pinnedInsertIndex)
    pinnedInsertIndex += 1
  }
  let unpinnedInsertIndex = Math.max(
    targetInsertIndex + movingPinnedWindowIds.length,
    leadingPinnedWindowCount(next, nextTargetGroup),
  )
  for (const windowId of movingUnpinnedWindowIds) {
    insertIntoGroup(next, nextTargetGroup, windowId, unpinnedInsertIndex)
    unpinnedInsertIndex += 1
  }
  next.groups = next.groups.filter((group) => group.id !== sourceGroupId)
  delete next.activeTabByGroupId[sourceGroupId]
  next.splitByGroupId = withoutGroupSplit(next.splitByGroupId, sourceGroupId)
  next.splitByGroupId = withoutGroupSplit(next.splitByGroupId, targetGroupId)
  next.activeTabByGroupId[targetGroupId] =
    next.activeTabByGroupId[targetGroupId] && nextTargetGroup.windowIds.includes(next.activeTabByGroupId[targetGroupId])
      ? next.activeTabByGroupId[targetGroupId]
      : nextTargetGroup.windowIds[0]
  ensureValidSplitState(next)
  return next
}

export function splitWorkspaceWindowToOwnGroup(
  state: WorkspaceState,
  windowId: number,
): WorkspaceState {
  const sourceGroupId = groupIdForWindow(state, windowId)
  if (!sourceGroupId) return state
  const sourceGroup = state.groups.find((group) => group.id === sourceGroupId)
  if (!sourceGroup || sourceGroup.windowIds.length < 2 || !sourceGroup.windowIds.includes(windowId)) return state
  const next = cloneState(state)
  const sourceIndex = next.groups.findIndex((group) => group.id === sourceGroupId)
  const nextSourceGroup = sourceIndex >= 0 ? next.groups[sourceIndex] : null
  if (!nextSourceGroup) return state
  nextSourceGroup.windowIds = nextSourceGroup.windowIds.filter((entry) => entry !== windowId)
  if (nextSourceGroup.windowIds.length === 0) {
    next.groups = next.groups.filter((group) => group.id !== sourceGroupId)
    delete next.activeTabByGroupId[sourceGroupId]
    next.splitByGroupId = withoutGroupSplit(next.splitByGroupId, sourceGroupId)
  } else {
    const sourceActive = next.activeTabByGroupId[sourceGroupId]
    next.activeTabByGroupId[sourceGroupId] = nextSourceGroup.windowIds.includes(sourceActive)
      ? sourceActive
      : nextSourceGroup.windowIds[0]
  }
  const newGroupId = `group-${next.nextGroupSeq++}`
  next.groups.splice(sourceIndex + 1, 0, {
    id: newGroupId,
    windowIds: [windowId],
  })
  next.activeTabByGroupId[newGroupId] = windowId
  next.monitorTiles = next.monitorTiles
    .map((monitor) => ({
      outputName: monitor.outputName,
      entries: monitor.entries.filter((entry) => entry.windowId !== windowId),
    }))
    .filter((monitor) => monitor.entries.length > 0)
  next.preTileGeometry = next.preTileGeometry.filter((entry) => entry.windowId !== windowId)
  ensureValidSplitState(next)
  return next
}

export function setWorkspaceWindowPinned(
  state: WorkspaceState,
  windowId: number,
  pinned: boolean,
): WorkspaceState {
  const groupId = groupIdForWindow(state, windowId)
  if (!groupId) return state
  const currentPinned = isWorkspaceWindowPinned(state, windowId)
  if (currentPinned === pinned) return state
  const next = cloneState(state)
  if (pinned) {
    if (!next.pinnedWindowIds.includes(windowId)) next.pinnedWindowIds.push(windowId)
  } else {
    next.pinnedWindowIds = next.pinnedWindowIds.filter((entry) => entry !== windowId)
  }
  const group = next.groups.find((entry) => entry.id === groupId)
  if (!group) return state
  const remaining = group.windowIds.filter((entry) => entry !== windowId)
  const pinnedCount = leadingPinnedWindowCount(next, { ...group, windowIds: remaining })
  const insertIndex = pinned ? pinnedCount : Math.min(pinnedCount, remaining.length)
  group.windowIds = remaining
  group.windowIds.splice(insertIndex, 0, windowId)
  return next
}

export function getWorkspaceGroupSplit(
  state: WorkspaceState,
  groupId: string,
): WorkspaceGroupSplitState | undefined {
  return state.splitByGroupId[groupId]
}

export function workspaceIsWindowTiled(state: WorkspaceState, windowId: number): boolean {
  return state.monitorTiles.some((monitor) => monitor.entries.some((entry) => entry.windowId === windowId))
}

export function workspaceFindMonitorForTiledWindow(state: WorkspaceState, windowId: number): string | null {
  for (const monitor of state.monitorTiles) {
    if (monitor.entries.some((entry) => entry.windowId === windowId)) return monitor.outputName
  }
  return null
}

export function workspaceGetTiledZone(state: WorkspaceState, windowId: number): SnapZone | undefined {
  for (const monitor of state.monitorTiles) {
    const entry = monitor.entries.find((candidate) => candidate.windowId === windowId)
    if (entry) return entry.zone
  }
  return undefined
}

export function workspaceGetPreTileGeometry(state: WorkspaceState, windowId: number): Rect | undefined {
  return state.preTileGeometry.find((entry) => entry.windowId === windowId)?.bounds
}

export function workspaceMonitorTileEntries(
  state: WorkspaceState,
  outputName: string,
): WorkspaceMonitorTileEntry[] {
  return state.monitorTiles.find((monitor) => monitor.outputName === outputName)?.entries ?? []
}

export function enterWorkspaceSplitView(
  state: WorkspaceState,
  groupId: string,
  leftWindowId: number,
  leftPaneFraction: number = WORKSPACE_SPLIT_PANE_FRACTION_DEFAULT,
): WorkspaceState {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group || !group.windowIds.includes(leftWindowId)) return state
  if (group.windowIds.filter((windowId) => windowId !== leftWindowId).length === 0) return state
  const next = cloneState(state)
  next.splitByGroupId[groupId] = {
    leftWindowId,
    leftPaneFraction: clampWorkspaceSplitPaneFraction(leftPaneFraction),
  }
  ensureValidSplitState(next)
  return workspaceStatesEqual(state, next) ? state : next
}

export function exitWorkspaceSplitView(state: WorkspaceState, groupId: string): WorkspaceState {
  if (!state.splitByGroupId[groupId]) return state
  return {
    groups: state.groups.map((entry) => ({ id: entry.id, windowIds: [...entry.windowIds] })),
    activeTabByGroupId: { ...state.activeTabByGroupId },
    pinnedWindowIds: [...(state.pinnedWindowIds ?? [])],
    splitByGroupId: withoutGroupSplit(state.splitByGroupId, groupId),
    monitorTiles: state.monitorTiles.map((monitor) => ({
      outputName: monitor.outputName,
      entries: monitor.entries.map((entry) => ({ ...entry, bounds: { ...entry.bounds } })),
    })),
    monitorLayouts: state.monitorLayouts.map((entry) => ({ ...entry, params: { ...entry.params } })),
    preTileGeometry: state.preTileGeometry.map((entry) => ({ ...entry, bounds: { ...entry.bounds } })),
    nextGroupSeq: state.nextGroupSeq,
  }
}

export function setWorkspaceSplitFraction(
  state: WorkspaceState,
  groupId: string,
  leftPaneFraction: number,
): WorkspaceState {
  const split = state.splitByGroupId[groupId]
  if (!split) return state
  const nextFraction = clampWorkspaceSplitPaneFraction(leftPaneFraction)
  if (split.leftPaneFraction === nextFraction) return state
  return {
    groups: state.groups.map((entry) => ({ id: entry.id, windowIds: [...entry.windowIds] })),
    activeTabByGroupId: { ...state.activeTabByGroupId },
    pinnedWindowIds: [...(state.pinnedWindowIds ?? [])],
    splitByGroupId: {
      ...state.splitByGroupId,
      [groupId]: {
        ...split,
        leftPaneFraction: nextFraction,
      },
    },
    monitorTiles: state.monitorTiles.map((monitor) => ({
      outputName: monitor.outputName,
      entries: monitor.entries.map((entry) => ({ ...entry, bounds: { ...entry.bounds } })),
    })),
    monitorLayouts: state.monitorLayouts.map((entry) => ({ ...entry, params: { ...entry.params } })),
    preTileGeometry: state.preTileGeometry.map((entry) => ({ ...entry, bounds: { ...entry.bounds } })),
    nextGroupSeq: state.nextGroupSeq,
  }
}

export function mergeWorkspaceGroups(
  state: WorkspaceState,
  sourceWindowId: number,
  targetWindowId: number,
): WorkspaceState {
  if (sourceWindowId === targetWindowId) return state
  const targetGroupId = groupIdForWindow(state, targetWindowId)
  if (!targetGroupId) return state
  const targetGroup = state.groups.find((group) => group.id === targetGroupId)
  if (!targetGroup) return state
  const targetInsert = targetGroup.windowIds.indexOf(targetWindowId)
  return moveWorkspaceWindowToGroup(
    state,
    sourceWindowId,
    targetGroupId,
    targetInsert >= 0 ? targetInsert + 1 : targetGroup.windowIds.length,
  )
}

export function cycleWorkspaceTab(
  state: WorkspaceState,
  groupId: string,
  delta: 1 | -1,
): WorkspaceState {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group || group.windowIds.length < 2) return state
  const split = state.splitByGroupId[groupId]
  const cycleWindowIds =
    split ? group.windowIds.filter((windowId) => windowId !== split.leftWindowId) : group.windowIds
  if (cycleWindowIds.length < 2) return state
  const current = normalizedRequestedActiveWindowId(state, group, state.activeTabByGroupId[groupId])
  const currentIndex = Math.max(0, cycleWindowIds.indexOf(current))
  const nextIndex = (currentIndex + delta + cycleWindowIds.length) % cycleWindowIds.length
  return setWorkspaceActiveTab(state, groupId, cycleWindowIds[nextIndex])
}
