import { describe, expect, it } from 'vitest'
import {
  createEmptyWorkspaceState,
  cycleWorkspaceTab,
  groupIdForWindow,
  loadWorkspaceState,
  mergeWorkspaceGroups,
  persistWorkspaceState,
  reconcileWorkspaceState,
  setWorkspaceActiveTab,
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
      nextGroupSeq: 3,
    }
    const next = reconcileWorkspaceState(state, [3])
    expect(next.groups).toEqual([{ id: 'group-1', windowIds: [3] }])
    expect(next.activeTabByGroupId).toEqual({ 'group-1': 3 })
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
    const state = setWorkspaceActiveTab(reconcileWorkspaceState(createEmptyWorkspaceState(), [10, 11]), 'group-2', 11)
    persistWorkspaceState(state, adapter)
    expect(loadWorkspaceState(adapter)).toEqual(state)
  })
})
