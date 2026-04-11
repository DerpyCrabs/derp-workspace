export type WorkspaceGroupState = {
  id: string
  windowIds: number[]
}

export type WorkspaceState = {
  groups: WorkspaceGroupState[]
  activeTabByGroupId: Record<string, number>
  nextGroupSeq: number
}

export const WORKSPACE_STATE_STORAGE_KEY = 'derp-shell-workspace-state-v1'

function cloneState(state: WorkspaceState): WorkspaceState {
  return {
    groups: state.groups.map((group) => ({ id: group.id, windowIds: [...group.windowIds] })),
    activeTabByGroupId: { ...state.activeTabByGroupId },
    nextGroupSeq: state.nextGroupSeq,
  }
}

export function createEmptyWorkspaceState(): WorkspaceState {
  return {
    groups: [],
    activeTabByGroupId: {},
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

function storageForRead(storage?: Pick<Storage, 'getItem'> | null) {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  return window.localStorage
}

function storageForWrite(storage?: Pick<Storage, 'setItem'> | null) {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  return window.localStorage
}

export function loadWorkspaceState(storage?: Pick<Storage, 'getItem'> | null): WorkspaceState {
  const target = storageForRead(storage)
  if (!target) return createEmptyWorkspaceState()
  try {
    const raw = target.getItem(WORKSPACE_STATE_STORAGE_KEY)
    if (!raw) return createEmptyWorkspaceState()
    return normalizeWorkspaceState(JSON.parse(raw) as unknown)
  } catch {
    return createEmptyWorkspaceState()
  }
}

export function persistWorkspaceState(
  state: WorkspaceState,
  storage?: Pick<Storage, 'setItem'> | null,
): void {
  const target = storageForWrite(storage)
  if (!target) return
  try {
    target.setItem(WORKSPACE_STATE_STORAGE_KEY, JSON.stringify(state))
  } catch {}
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
  return next
}

export function setWorkspaceActiveTab(
  state: WorkspaceState,
  groupId: string,
  windowId: number,
): WorkspaceState {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group || !group.windowIds.includes(windowId)) return state
  if (state.activeTabByGroupId[groupId] === windowId) return state
  return {
    groups: state.groups.map((entry) => ({
      id: entry.id,
      windowIds: [...entry.windowIds],
    })),
    activeTabByGroupId: {
      ...state.activeTabByGroupId,
      [groupId]: windowId,
    },
    nextGroupSeq: state.nextGroupSeq,
  }
}

export function mergeWorkspaceGroups(
  state: WorkspaceState,
  sourceWindowId: number,
  targetWindowId: number,
): WorkspaceState {
  if (sourceWindowId === targetWindowId) return state
  const sourceGroupId = groupIdForWindow(state, sourceWindowId)
  const targetGroupId = groupIdForWindow(state, targetWindowId)
  if (!sourceGroupId || !targetGroupId || sourceGroupId === targetGroupId) return state
  const next = cloneState(state)
  const sourceGroup = next.groups.find((group) => group.id === sourceGroupId)
  const targetGroup = next.groups.find((group) => group.id === targetGroupId)
  if (!sourceGroup || !targetGroup) return state
  sourceGroup.windowIds = sourceGroup.windowIds.filter((windowId) => windowId !== sourceWindowId)
  const targetInsert = targetGroup.windowIds.indexOf(targetWindowId)
  if (!targetGroup.windowIds.includes(sourceWindowId)) {
    targetGroup.windowIds.splice(targetInsert >= 0 ? targetInsert + 1 : targetGroup.windowIds.length, 0, sourceWindowId)
  }
  if (sourceGroup.windowIds.length === 0) {
    next.groups = next.groups.filter((group) => group.id !== sourceGroupId)
    delete next.activeTabByGroupId[sourceGroupId]
  } else {
    const sourceActive = next.activeTabByGroupId[sourceGroupId]
    next.activeTabByGroupId[sourceGroupId] = sourceGroup.windowIds.includes(sourceActive)
      ? sourceActive
      : sourceGroup.windowIds[0]
  }
  next.activeTabByGroupId[targetGroupId] =
    next.activeTabByGroupId[targetGroupId] && targetGroup.windowIds.includes(next.activeTabByGroupId[targetGroupId])
      ? next.activeTabByGroupId[targetGroupId]
      : targetGroup.windowIds[0]
  return next
}

export function cycleWorkspaceTab(
  state: WorkspaceState,
  groupId: string,
  delta: 1 | -1,
): WorkspaceState {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group || group.windowIds.length < 2) return state
  const current = state.activeTabByGroupId[groupId]
  const currentIndex = Math.max(0, group.windowIds.indexOf(current))
  const nextIndex = (currentIndex + delta + group.windowIds.length) % group.windowIds.length
  return setWorkspaceActiveTab(state, groupId, group.windowIds[nextIndex])
}
