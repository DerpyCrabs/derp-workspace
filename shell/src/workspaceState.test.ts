import { describe, expect, it } from 'vitest'
import {
  createEmptyWorkspaceState,
  cycleWorkspaceTab,
  enterWorkspaceSplitView,
  exitWorkspaceSplitView,
  groupIdForWindow,
  loadWorkspaceState,
  mergeWorkspaceGroups,
  moveWorkspaceWindowToGroup,
  persistWorkspaceState,
  reconcileWorkspaceState,
  reorderWorkspaceWindowInGroup,
  splitWorkspaceWindowToOwnGroup,
  setWorkspaceActiveTab,
  setWorkspaceWindowPinned,
  type WorkspaceState,
} from './workspaceState'

describe('workspaceState', () => {
  it('seeds missing windows into singleton groups', () => {
    const next = reconcileWorkspaceState(createEmptyWorkspaceState(), [7, 3])
    expect(next.groups).toEqual([
      { id: 'group-1', windowIds: [3] },
      { id: 'group-2', windowIds: [7] },
    ])
    expect(next.activeTabByGroupId).toEqual({
      'group-1': 3,
      'group-2': 7,
    })
    expect(next.pinnedWindowIds).toEqual([])
  })

  it('prunes unmapped windows and repairs invalid active tabs', () => {
    const state: WorkspaceState = {
      groups: [
        { id: 'group-1', windowIds: [3, 4] },
        { id: 'group-2', windowIds: [9] },
      ],
      activeTabByGroupId: {
        'group-1': 4,
        'group-2': 9,
      },
      pinnedWindowIds: [],
      splitByGroupId: {},
      nextGroupSeq: 3,
    }
    const next = reconcileWorkspaceState(state, [3])
    expect(next.groups).toEqual([{ id: 'group-1', windowIds: [3] }])
    expect(next.activeTabByGroupId).toEqual({ 'group-1': 3 })
    expect(next.pinnedWindowIds).toEqual([])
  })

  it('drops pinned ids for windows removed during reconciliation', () => {
    const state: WorkspaceState = {
      groups: [{ id: 'group-1', windowIds: [3, 4] }],
      activeTabByGroupId: { 'group-1': 4 },
      pinnedWindowIds: [4, 9],
      splitByGroupId: {},
      nextGroupSeq: 2,
    }
    const next = reconcileWorkspaceState(state, [3])
    expect(next.groups).toEqual([{ id: 'group-1', windowIds: [3] }])
    expect(next.pinnedWindowIds).toEqual([])
  })

  it('merges one window into the target group after the target member', () => {
    const state = reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2, 3])
    const next = mergeWorkspaceGroups(state, 1, 2)
    const targetGroupId = groupIdForWindow(next, 2)
    expect(targetGroupId).toBeTruthy()
    expect(next.groups).toHaveLength(2)
    expect(next.groups.find((group) => group.id === targetGroupId)?.windowIds).toEqual([2, 1])
  })

  it('cycles tabs within a group', () => {
    const state = setWorkspaceActiveTab(
      mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2]), 1, 2),
      groupIdForWindow(mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2]), 1, 2), 2)!,
      2,
    )
    const groupId = groupIdForWindow(state, 2)!
    const next = cycleWorkspaceTab(state, groupId, 1)
    expect(next.activeTabByGroupId[groupId]).toBe(1)
    const prev = cycleWorkspaceTab(next, groupId, -1)
    expect(prev.activeTabByGroupId[groupId]).toBe(2)
  })

  it('keeps pinned tabs at the front when reordering an unpinned tab', () => {
    let state = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2, 3]), 1, 2)
    const groupId = groupIdForWindow(state, 2)!
    state = moveWorkspaceWindowToGroup(state, 3, groupId, 2)
    state = setWorkspaceWindowPinned(state, 2, true)
    const next = reorderWorkspaceWindowInGroup(state, groupId, 3, 0)
    expect(next.groups.find((group) => group.id === groupId)?.windowIds).toEqual([2, 3, 1])
  })

  it('moves a pinned tab into the pinned block when pinning', () => {
    let state = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2, 3]), 1, 2)
    const groupId = groupIdForWindow(state, 2)!
    state = moveWorkspaceWindowToGroup(state, 3, groupId, 2)
    const next = setWorkspaceWindowPinned(state, 3, true)
    expect(next.pinnedWindowIds).toEqual([3])
    expect(next.groups.find((group) => group.id === groupId)?.windowIds).toEqual([3, 2, 1])
  })

  it('moves an unpinned tab behind the pinned block when merging', () => {
    let state = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2, 3]), 1, 2)
    const groupId = groupIdForWindow(state, 2)!
    state = setWorkspaceWindowPinned(state, 2, true)
    const next = moveWorkspaceWindowToGroup(state, 3, groupId, 0)
    expect(next.groups.find((group) => group.id === groupId)?.windowIds).toEqual([2, 3, 1])
  })

  it('splits a grouped window into its own group', () => {
    let merged = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2, 3]), 1, 2)
    merged = enterWorkspaceSplitView(merged, groupIdForWindow(merged, 2)!, 2)
    const next = splitWorkspaceWindowToOwnGroup(merged, 1)
    expect(next.groups).toEqual([
      { id: 'group-2', windowIds: [2] },
      { id: 'group-4', windowIds: [1] },
      { id: 'group-3', windowIds: [3] },
    ])
    expect(next.activeTabByGroupId).toEqual({
      'group-2': 2,
      'group-3': 3,
      'group-4': 1,
    })
    expect(next.splitByGroupId).toEqual({})
  })

  it('enters split view and keeps the active tab on the right', () => {
    let state = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2]), 1, 2)
    const groupId = groupIdForWindow(state, 2)!
    state = setWorkspaceActiveTab(state, groupId, 1)
    const next = enterWorkspaceSplitView(state, groupId, 2)
    expect(next.splitByGroupId[groupId]).toEqual({ leftWindowId: 2, leftPaneFraction: 0.5 })
    expect(next.activeTabByGroupId[groupId]).toBe(1)
  })

  it('enters split view and moves active away from the split-left tab', () => {
    const state = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2]), 1, 2)
    const groupId = groupIdForWindow(state, 2)!
    const next = enterWorkspaceSplitView(state, groupId, 2)
    expect(next.activeTabByGroupId[groupId]).toBe(1)
  })

  it('exits split view for a group', () => {
    const base = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2]), 1, 2)
    const groupId = groupIdForWindow(base, 2)!
    const state = enterWorkspaceSplitView(base, groupId, 2)
    const next = exitWorkspaceSplitView(state, groupId)
    expect(next.splitByGroupId).toEqual({})
  })

  it('clears destination split metadata when merging into a split group', () => {
    let state = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2, 3]), 1, 2)
    const groupId = groupIdForWindow(state, 2)!
    state = enterWorkspaceSplitView(state, groupId, 2)
    const next = mergeWorkspaceGroups(state, 3, 2)
    expect(next.splitByGroupId[groupId]).toBeUndefined()
  })

  it('persists and reloads workspace state', () => {
    const storage = new Map<string, string>()
    const adapter = {
      getItem(key: string) {
        return storage.get(key) ?? null
      },
      setItem(key: string, value: string) {
        storage.set(key, value)
      },
    }
    let state = setWorkspaceActiveTab(reconcileWorkspaceState(createEmptyWorkspaceState(), [10, 11]), 'group-2', 11)
    state = setWorkspaceWindowPinned(state, 11, true)
    state = enterWorkspaceSplitView(state, 'group-2', 10)
    persistWorkspaceState(state, adapter)
    expect(loadWorkspaceState(adapter)).toEqual(state)
  })
})
