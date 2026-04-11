import type { WorkspaceState } from './workspaceState'

export type GroupWindowLike = {
  window_id: number
  title: string
  app_id: string
  minimized: boolean
}

export function tabsInGroup<T extends { window_id: number }>(
  windows: readonly T[],
  state: WorkspaceState,
  groupId: string,
): T[] {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group) return []
  const windowsById = new Map(windows.map((window) => [window.window_id, window]))
  return group.windowIds.map((windowId) => windowsById.get(windowId)).filter((window): window is T => !!window)
}

export function resolveGroupVisibleWindowId(
  state: WorkspaceState,
  groupId: string,
  windows: readonly GroupWindowLike[],
): number | null {
  const members = tabsInGroup(windows, state, groupId)
  if (members.length === 0) return null
  const active = state.activeTabByGroupId[groupId]
  if (members.some((window) => window.window_id === active)) return active
  const firstVisible = members.find((window) => !window.minimized)
  return firstVisible?.window_id ?? members[0].window_id
}

export function nextActiveWindowAfterRemoval(
  state: WorkspaceState,
  groupId: string,
  removedWindowId: number,
): number | null {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group) return null
  const remaining = group.windowIds.filter((windowId) => windowId !== removedWindowId)
  if (remaining.length === 0) return null
  const removedIndex = group.windowIds.indexOf(removedWindowId)
  const nextIndex = removedIndex < 0 ? 0 : Math.min(removedIndex, remaining.length - 1)
  return remaining[nextIndex] ?? remaining[remaining.length - 1] ?? null
}

export function windowLabel(window: Pick<GroupWindowLike, 'window_id' | 'title' | 'app_id'>): string {
  return window.title || window.app_id || `Window ${window.window_id}`
}

export function groupTaskbarLabel(
  state: WorkspaceState,
  groupId: string,
  windows: readonly GroupWindowLike[],
): string {
  const members = tabsInGroup(windows, state, groupId)
  if (members.length === 0) return ''
  const visibleId = resolveGroupVisibleWindowId(state, groupId, windows)
  const leader =
    members.find((window) => window.window_id === visibleId) ??
    members.find((window) => !window.minimized) ??
    members[0]
  const label = windowLabel(leader)
  return members.length > 1 ? `${label} (+${members.length - 1})` : label
}
