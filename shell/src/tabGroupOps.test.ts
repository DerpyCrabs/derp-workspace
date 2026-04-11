import { describe, expect, it } from 'vitest'
import { groupTaskbarLabel, nextActiveWindowAfterRemoval, resolveGroupVisibleWindowId, tabsInGroup } from './tabGroupOps'
import { createEmptyWorkspaceState, mergeWorkspaceGroups, reconcileWorkspaceState, setWorkspaceActiveTab } from './workspaceState'

function makeWindow(window_id: number, title = `Window ${window_id}`, minimized = false) {
  return {
    window_id,
    title,
    app_id: `app.${window_id}`,
    minimized,
  }
}

describe('tabGroupOps', () => {
  it('returns tabs in the persisted group order', () => {
    const state = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2]), 1, 2)
    const groupId = state.groups.find((group) => group.windowIds.includes(2))!.id
    expect(tabsInGroup([makeWindow(1), makeWindow(2)], state, groupId).map((window) => window.window_id)).toEqual([2, 1])
  })

  it('resolves the active group tab when it is present', () => {
    const merged = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2]), 1, 2)
    const groupId = merged.groups.find((group) => group.windowIds.includes(2))!.id
    const state = setWorkspaceActiveTab(merged, groupId, 1)
    expect(resolveGroupVisibleWindowId(state, groupId, [makeWindow(1), makeWindow(2)])).toBe(1)
  })

  it('falls back to the first non-minimized member when the active tab is unavailable', () => {
    const state = {
      groups: [{ id: 'group-1', windowIds: [1, 2, 3] }],
      activeTabByGroupId: { 'group-1': 9 },
      nextGroupSeq: 2,
    }
    expect(
      resolveGroupVisibleWindowId(state, 'group-1', [
        makeWindow(1, 'One', true),
        makeWindow(2, 'Two', false),
        makeWindow(3, 'Three', true),
      ]),
    ).toBe(2)
  })

  it('picks the next sensible tab after removal', () => {
    const state = {
      groups: [{ id: 'group-1', windowIds: [10, 11, 12] }],
      activeTabByGroupId: { 'group-1': 11 },
      nextGroupSeq: 2,
    }
    expect(nextActiveWindowAfterRemoval(state, 'group-1', 11)).toBe(12)
    expect(nextActiveWindowAfterRemoval(state, 'group-1', 12)).toBe(11)
  })

  it('builds taskbar labels with the hidden-tab count', () => {
    const merged = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2]), 1, 2)
    const groupId = merged.groups.find((group) => group.windowIds.includes(2))!.id
    expect(groupTaskbarLabel(merged, groupId, [makeWindow(1, 'Alpha'), makeWindow(2, 'Beta')])).toBe('Beta (+1)')
  })
})
