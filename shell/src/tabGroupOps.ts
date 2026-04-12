import type { WorkspaceState } from './workspaceState'

export type GroupWindowLike = {
  window_id: number
  title: string
  app_id: string
  minimized: boolean
}

export type TabMergeTarget = {
  groupId: string
  insertIndex: number
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

export function isTabPinned(state: WorkspaceState, windowId: number): boolean {
  return state.pinnedWindowIds.includes(windowId)
}

export function leadingPinnedTabCount(
  state: WorkspaceState,
  groupId: string,
  excludeWindowId?: number,
): number {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group) return 0
  let count = 0
  for (const windowId of group.windowIds) {
    if (windowId === excludeWindowId) continue
    if (!isTabPinned(state, windowId)) break
    count += 1
  }
  return count
}

export function clampTabInsertIndex(
  state: WorkspaceState,
  groupId: string,
  insertIndex: number,
  pinned: boolean,
  excludeWindowId?: number,
): number {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group) return 0
  const members = group.windowIds.filter((windowId) => windowId !== excludeWindowId)
  const clamped = Math.max(0, Math.min(Math.trunc(insertIndex), members.length))
  const pinnedCount = leadingPinnedTabCount(state, groupId, excludeWindowId)
  return pinned ? Math.min(clamped, pinnedCount) : Math.max(clamped, pinnedCount)
}

function parseDropSlotValue(value: string | null): TabMergeTarget | null {
  if (!value) return null
  const split = value.lastIndexOf(':')
  if (split <= 0 || split >= value.length - 1) return null
  const groupId = value.slice(0, split)
  const insertIndex = Number(value.slice(split + 1))
  return Number.isFinite(insertIndex) ? { groupId, insertIndex: Math.max(0, Math.trunc(insertIndex)) } : null
}

export function mergeTargetFromElement(
  element: Element | null,
  state: WorkspaceState,
  draggedWindowId: number,
  pointerClientX: number,
): TabMergeTarget | null {
  if (!(element instanceof Element)) return null
  const slotTarget = parseDropSlotValue(element.closest('[data-tab-drop-slot]')?.getAttribute('data-tab-drop-slot') ?? null)
  if (slotTarget) return slotTarget
  const tabEl = element.closest('[data-workspace-tab]')
  if (!(tabEl instanceof Element)) return null
  const groupId = tabEl.getAttribute('data-workspace-tab-group')
  const targetWindowId = Number(tabEl.getAttribute('data-workspace-tab'))
  if (!groupId || !Number.isFinite(targetWindowId)) return null
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group) return null
  const targetIndex = group.windowIds.indexOf(Math.trunc(targetWindowId))
  if (targetIndex < 0) return null
  const rect = tabEl.getBoundingClientRect()
  const insertIndex = pointerClientX < rect.left + rect.width / 2 ? targetIndex : targetIndex + 1
  const sourceGroupId = state.groups.find((entry) => entry.windowIds.includes(draggedWindowId))?.id
  return {
    groupId,
    insertIndex: clampTabInsertIndex(
      state,
      groupId,
      insertIndex,
      isTabPinned(state, draggedWindowId),
      sourceGroupId === groupId ? draggedWindowId : undefined,
    ),
  }
}

export function findMergeTarget(
  state: WorkspaceState,
  draggedWindowId: number,
  clientX: number,
  clientY: number,
  ignoreDraggedWindowFrame = false,
): TabMergeTarget | null {
  if (typeof document === 'undefined' || typeof document.elementsFromPoint !== 'function') return null
  const elements = document.elementsFromPoint(clientX, clientY)
  for (const element of elements) {
    if (
      ignoreDraggedWindowFrame &&
      element instanceof Element &&
      element.closest(`[data-shell-window-frame="${draggedWindowId}"]`)
    ) {
      continue
    }
    if (element instanceof Element && element.closest('[data-tab-drag-capture]')) {
      continue
    }
    const target = mergeTargetFromElement(element, state, draggedWindowId, clientX)
    if (target) return target
  }
  return null
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
