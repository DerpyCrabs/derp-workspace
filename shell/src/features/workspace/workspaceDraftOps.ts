import {
  WORKSPACE_SPLIT_PANE_FRACTION_DEFAULT,
  clampWorkspaceInsertIndex,
  clampWorkspaceSplitPaneFraction,
  cloneWorkspaceSnapshot,
  groupIdForWindow,
  insertWindowIntoWorkspaceGroup,
  isWorkspaceWindowPinned,
  leadingPinnedWorkspaceWindowCount,
  normalizedWorkspaceActiveWindowId,
  withRefreshedDerivedWorkspaceIndexes,
  workspaceSnapshotsEqual,
  workspaceWithoutGroupSplit,
  ensureValidWorkspaceSplitState,
  type WorkspaceSnapshot,
} from './workspaceSnapshot'
export function setWorkspaceActiveTab(
  state: WorkspaceSnapshot,
  groupId: string,
  windowId: number,
): WorkspaceSnapshot {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group || !group.windowIds.includes(windowId)) return state
  const nextWindowId = normalizedWorkspaceActiveWindowId(state, group, windowId)
  if (state.activeTabByGroupId[groupId] === nextWindowId) return state
  const next = cloneWorkspaceSnapshot(state)
  next.activeTabByGroupId[groupId] = nextWindowId
  return withRefreshedDerivedWorkspaceIndexes(next)
}

export function reorderWorkspaceWindowInGroup(
  state: WorkspaceSnapshot,
  groupId: string,
  windowId: number,
  insertIndex: number,
): WorkspaceSnapshot {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group || !group.windowIds.includes(windowId)) return state
  const next = cloneWorkspaceSnapshot(state)
  const nextGroup = next.groups.find((entry) => entry.id === groupId)
  if (!nextGroup) return state
  const before = nextGroup.windowIds.join(',')
  insertWindowIntoWorkspaceGroup(next, nextGroup, windowId, insertIndex)
  return nextGroup.windowIds.join(',') === before ? state : withRefreshedDerivedWorkspaceIndexes(next)
}

export function moveWorkspaceWindowToGroup(
  state: WorkspaceSnapshot,
  sourceWindowId: number,
  targetGroupId: string,
  insertIndex: number,
): WorkspaceSnapshot {
  const sourceGroupId = groupIdForWindow(state, sourceWindowId)
  if (!sourceGroupId) return state
  if (sourceGroupId === targetGroupId) {
    return reorderWorkspaceWindowInGroup(state, targetGroupId, sourceWindowId, insertIndex)
  }
  const next = cloneWorkspaceSnapshot(state)
  const sourceGroup = next.groups.find((group) => group.id === sourceGroupId)
  const targetGroup = next.groups.find((group) => group.id === targetGroupId)
  if (!sourceGroup || !targetGroup || !sourceGroup.windowIds.includes(sourceWindowId)) return state
  sourceGroup.windowIds = sourceGroup.windowIds.filter((windowId) => windowId !== sourceWindowId)
  insertWindowIntoWorkspaceGroup(next, targetGroup, sourceWindowId, insertIndex)
  if (sourceGroup.windowIds.length === 0) {
    next.groups = next.groups.filter((group) => group.id !== sourceGroupId)
    delete next.activeTabByGroupId[sourceGroupId]
    next.splitByGroupId = workspaceWithoutGroupSplit(next.splitByGroupId, sourceGroupId)
  } else {
    const sourceActive = next.activeTabByGroupId[sourceGroupId]
    next.activeTabByGroupId[sourceGroupId] = sourceGroup.windowIds.includes(sourceActive)
      ? sourceActive
      : sourceGroup.windowIds[0]
  }
  next.splitByGroupId = workspaceWithoutGroupSplit(next.splitByGroupId, targetGroupId)
  next.activeTabByGroupId[targetGroupId] = sourceWindowId
  ensureValidWorkspaceSplitState(next)
  return withRefreshedDerivedWorkspaceIndexes(next)
}

export function moveWorkspaceGroupToGroup(
  state: WorkspaceSnapshot,
  sourceGroupId: string,
  targetGroupId: string,
  insertIndex: number,
): WorkspaceSnapshot {
  if (sourceGroupId === targetGroupId) return state
  const sourceGroup = state.groups.find((group) => group.id === sourceGroupId)
  const targetGroup = state.groups.find((group) => group.id === targetGroupId)
  if (!sourceGroup || !targetGroup || sourceGroup.windowIds.length === 0) return state
  const movingWindowIds = [...sourceGroup.windowIds]
  const sourceVisibleWindowId =
    state.activeTabByGroupId[sourceGroupId] && sourceGroup.windowIds.includes(state.activeTabByGroupId[sourceGroupId])
      ? state.activeTabByGroupId[sourceGroupId]
      : sourceGroup.windowIds[0]
  const next = cloneWorkspaceSnapshot(state)
  const nextSourceGroup = next.groups.find((group) => group.id === sourceGroupId)
  const nextTargetGroup = next.groups.find((group) => group.id === targetGroupId)
  if (!nextSourceGroup || !nextTargetGroup) return state
  nextSourceGroup.windowIds = []
  const targetInsertIndex = clampWorkspaceInsertIndex(insertIndex, nextTargetGroup.windowIds.length)
  const movingPinnedWindowIds = movingWindowIds.filter((windowId) => next.pinnedWindowIds.includes(windowId))
  const movingUnpinnedWindowIds = movingWindowIds.filter((windowId) => !next.pinnedWindowIds.includes(windowId))
  let pinnedInsertIndex = Math.min(targetInsertIndex, leadingPinnedWorkspaceWindowCount(next, nextTargetGroup))
  for (const windowId of movingPinnedWindowIds) {
    insertWindowIntoWorkspaceGroup(next, nextTargetGroup, windowId, pinnedInsertIndex)
    pinnedInsertIndex += 1
  }
  let unpinnedInsertIndex = Math.max(
    targetInsertIndex + movingPinnedWindowIds.length,
    leadingPinnedWorkspaceWindowCount(next, nextTargetGroup),
  )
  for (const windowId of movingUnpinnedWindowIds) {
    insertWindowIntoWorkspaceGroup(next, nextTargetGroup, windowId, unpinnedInsertIndex)
    unpinnedInsertIndex += 1
  }
  next.groups = next.groups.filter((group) => group.id !== sourceGroupId)
  delete next.activeTabByGroupId[sourceGroupId]
  next.splitByGroupId = workspaceWithoutGroupSplit(next.splitByGroupId, sourceGroupId)
  next.splitByGroupId = workspaceWithoutGroupSplit(next.splitByGroupId, targetGroupId)
  next.activeTabByGroupId[targetGroupId] = sourceVisibleWindowId
  ensureValidWorkspaceSplitState(next)
  return withRefreshedDerivedWorkspaceIndexes(next)
}

export function splitWorkspaceWindowToOwnGroup(
  state: WorkspaceSnapshot,
  windowId: number,
): WorkspaceSnapshot {
  const sourceGroupId = groupIdForWindow(state, windowId)
  if (!sourceGroupId) return state
  const sourceGroup = state.groups.find((group) => group.id === sourceGroupId)
  if (!sourceGroup || sourceGroup.windowIds.length < 2 || !sourceGroup.windowIds.includes(windowId)) return state
  const next = cloneWorkspaceSnapshot(state)
  const sourceIndex = next.groups.findIndex((group) => group.id === sourceGroupId)
  const nextSourceGroup = sourceIndex >= 0 ? next.groups[sourceIndex] : null
  if (!nextSourceGroup) return state
  nextSourceGroup.windowIds = nextSourceGroup.windowIds.filter((entry) => entry !== windowId)
  if (nextSourceGroup.windowIds.length === 0) {
    next.groups = next.groups.filter((group) => group.id !== sourceGroupId)
    delete next.activeTabByGroupId[sourceGroupId]
    next.splitByGroupId = workspaceWithoutGroupSplit(next.splitByGroupId, sourceGroupId)
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
      outputId: monitor.outputId,
      outputName: monitor.outputName,
      entries: monitor.entries.filter((entry) => entry.windowId !== windowId),
    }))
    .filter((monitor) => monitor.entries.length > 0)
  next.preTileGeometry = next.preTileGeometry.filter((entry) => entry.windowId !== windowId)
  ensureValidWorkspaceSplitState(next)
  return withRefreshedDerivedWorkspaceIndexes(next)
}

export function setWorkspaceWindowPinned(
  state: WorkspaceSnapshot,
  windowId: number,
  pinned: boolean,
): WorkspaceSnapshot {
  const groupId = groupIdForWindow(state, windowId)
  if (!groupId) return state
  const currentPinned = isWorkspaceWindowPinned(state, windowId)
  if (currentPinned === pinned) return state
  const next = cloneWorkspaceSnapshot(state)
  if (pinned) {
    if (!next.pinnedWindowIds.includes(windowId)) next.pinnedWindowIds.push(windowId)
  } else {
    next.pinnedWindowIds = next.pinnedWindowIds.filter((entry) => entry !== windowId)
  }
  const group = next.groups.find((entry) => entry.id === groupId)
  if (!group) return state
  const remaining = group.windowIds.filter((entry) => entry !== windowId)
  const pinnedCount = leadingPinnedWorkspaceWindowCount(next, { ...group, windowIds: remaining })
  const insertIndex = pinned ? pinnedCount : Math.min(pinnedCount, remaining.length)
  group.windowIds = remaining
  group.windowIds.splice(insertIndex, 0, windowId)
  return withRefreshedDerivedWorkspaceIndexes(next)
}

export function enterWorkspaceSplitView(
  state: WorkspaceSnapshot,
  groupId: string,
  leftWindowId: number,
  leftPaneFraction: number = WORKSPACE_SPLIT_PANE_FRACTION_DEFAULT,
): WorkspaceSnapshot {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group || !group.windowIds.includes(leftWindowId)) return state
  if (group.windowIds.filter((windowId) => windowId !== leftWindowId).length === 0) return state
  const next = cloneWorkspaceSnapshot(state)
  next.splitByGroupId[groupId] = {
    leftWindowId,
    leftPaneFraction: clampWorkspaceSplitPaneFraction(leftPaneFraction),
  }
  ensureValidWorkspaceSplitState(next)
  return workspaceSnapshotsEqual(state, next) ? state : withRefreshedDerivedWorkspaceIndexes(next)
}

export function exitWorkspaceSplitView(state: WorkspaceSnapshot, groupId: string): WorkspaceSnapshot {
  if (!state.splitByGroupId[groupId]) return state
  const next = cloneWorkspaceSnapshot(state)
  next.splitByGroupId = workspaceWithoutGroupSplit(next.splitByGroupId, groupId)
  return withRefreshedDerivedWorkspaceIndexes(next)
}

export function setWorkspaceSplitFraction(
  state: WorkspaceSnapshot,
  groupId: string,
  leftPaneFraction: number,
): WorkspaceSnapshot {
  const split = state.splitByGroupId[groupId]
  if (!split) return state
  const nextFraction = clampWorkspaceSplitPaneFraction(leftPaneFraction)
  if (split.leftPaneFraction === nextFraction) return state
  const next = cloneWorkspaceSnapshot(state)
  next.splitByGroupId[groupId] = {
    ...split,
    leftPaneFraction: nextFraction,
  }
  return withRefreshedDerivedWorkspaceIndexes(next)
}

export function mergeWorkspaceGroups(
  state: WorkspaceSnapshot,
  sourceWindowId: number,
  targetWindowId: number,
): WorkspaceSnapshot {
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
  state: WorkspaceSnapshot,
  groupId: string,
  delta: 1 | -1,
): WorkspaceSnapshot {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group || group.windowIds.length < 2) return state
  const split = state.splitByGroupId[groupId]
  const cycleWindowIds =
    split ? group.windowIds.filter((windowId) => windowId !== split.leftWindowId) : group.windowIds
  if (cycleWindowIds.length < 2) return state
  const current = normalizedWorkspaceActiveWindowId(state, group, state.activeTabByGroupId[groupId])
  const currentIndex = Math.max(0, cycleWindowIds.indexOf(current))
  const nextIndex = (currentIndex + delta + cycleWindowIds.length) % cycleWindowIds.length
  return setWorkspaceActiveTab(state, groupId, cycleWindowIds[nextIndex])
}
