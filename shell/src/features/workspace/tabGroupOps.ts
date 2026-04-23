import { getWorkspaceGroupSplit, type WorkspaceState } from '@/features/workspace/workspaceState'

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

const TAB_INSERT_BEFORE_FRACTION = 0.4

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

export function splitLeftWindowId(state: WorkspaceState, groupId: string): number | null {
  return getWorkspaceGroupSplit(state, groupId)?.leftWindowId ?? null
}

export function isSplitLeftWindow(state: WorkspaceState, groupId: string, windowId: number): boolean {
  return splitLeftWindowId(state, groupId) === windowId
}

export function rightTabsInGroup<T extends { window_id: number }>(
  windows: readonly T[],
  state: WorkspaceState,
  groupId: string,
): T[] {
  const leftWindowId = splitLeftWindowId(state, groupId)
  return leftWindowId === null
    ? tabsInGroup(windows, state, groupId)
    : tabsInGroup(windows, state, groupId).filter((window) => window.window_id !== leftWindowId)
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

function mergeTargetFromDropSlotAtPoint(
  draggedWindowId: number,
  clientX: number,
  clientY: number,
  ignoreDraggedWindowFrame: boolean,
): TabMergeTarget | null {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null
  const slots = document.querySelectorAll('[data-tab-drop-slot]')
  for (const slot of slots) {
    if (!(slot instanceof Element)) continue
    if (
      ignoreDraggedWindowFrame &&
      slot.closest(`[data-shell-window-frame="${draggedWindowId}"]`)
    ) {
      continue
    }
    const rect = slot.getBoundingClientRect()
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      continue
    }
    const target = parseDropSlotValue(slot.getAttribute('data-tab-drop-slot'))
    if (target) return target
  }
  return null
}

function rightStripSlotAtPoint(strip: Element, clientX: number): number {
  if (typeof strip.querySelectorAll !== 'function') return 0
  const rightTabs = Array.from(strip.querySelectorAll('[data-workspace-tab]')).filter(
    (tab) => tab.getAttribute('data-workspace-split-left-tab') === null,
  )
  for (let index = 0; index < rightTabs.length; index += 1) {
    const rect = rightTabs[index].getBoundingClientRect()
    if (clientX <= rect.left + rect.width * TAB_INSERT_BEFORE_FRACTION) return index
    if (clientX <= rect.right) return index + 1
  }
  return rightTabs.length
}

function mergeTargetFromTabStripAtPoint(
  state: WorkspaceState,
  draggedWindowId: number,
  clientX: number,
  clientY: number,
  ignoreDraggedWindowFrame: boolean,
): TabMergeTarget | null {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null
  const strips = document.querySelectorAll('[data-workspace-tab-strip]')
  for (const strip of strips) {
    if (!(strip instanceof Element)) continue
    if (
      ignoreDraggedWindowFrame &&
      strip.closest(`[data-shell-window-frame="${draggedWindowId}"]`)
    ) {
      continue
    }
    const rect = strip.getBoundingClientRect()
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      continue
    }
    const groupId = strip.getAttribute('data-workspace-tab-strip')
    if (!groupId) continue
    const sourceGroupId = state.groups.find((entry) => entry.windowIds.includes(draggedWindowId))?.id
    const rightStripIndex = rightStripSlotAtPoint(strip, clientX)
    return {
      groupId,
      insertIndex: clampTabInsertIndex(
        state,
        groupId,
        rightStripIndexToGroupInsertIndex(state, groupId, rightStripIndex),
        isTabPinned(state, draggedWindowId),
        sourceGroupId === groupId ? draggedWindowId : undefined,
      ),
    }
  }
  return null
}

function mergeTargetFromTabAtPoint(
  state: WorkspaceState,
  draggedWindowId: number,
  clientX: number,
  clientY: number,
  ignoreDraggedWindowFrame: boolean,
): TabMergeTarget | null {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null
  const tabs = document.querySelectorAll('[data-workspace-tab]')
  for (const tab of tabs) {
    if (!(tab instanceof Element)) continue
    if (
      ignoreDraggedWindowFrame &&
      tab.closest(`[data-shell-window-frame="${draggedWindowId}"]`)
    ) {
      continue
    }
    const rect = tab.getBoundingClientRect()
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      continue
    }
    const target = mergeTargetFromElement(tab, state, draggedWindowId, clientX)
    if (target) return target
  }
  return null
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
  const insertIndex =
    pointerClientX <= rect.left + rect.width * TAB_INSERT_BEFORE_FRACTION
      ? targetIndex
      : targetIndex + 1
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
  const slotTarget = mergeTargetFromDropSlotAtPoint(
    draggedWindowId,
    clientX,
    clientY,
    ignoreDraggedWindowFrame,
  )
  if (slotTarget) return slotTarget
  const stripTarget = mergeTargetFromTabStripAtPoint(
    state,
    draggedWindowId,
    clientX,
    clientY,
    ignoreDraggedWindowFrame,
  )
  if (stripTarget) return stripTarget
  return mergeTargetFromTabAtPoint(
    state,
    draggedWindowId,
    clientX,
    clientY,
    ignoreDraggedWindowFrame,
  )
}

export function resolveGroupVisibleWindowId(
  state: WorkspaceState,
  groupId: string,
  windows: readonly GroupWindowLike[],
): number | null {
  const members = tabsInGroup(windows, state, groupId)
  if (members.length === 0) return null
  const derivedVisible = state.visibleWindowIdByGroupId?.[groupId]
  if (
    typeof derivedVisible === 'number' &&
    derivedVisible > 0 &&
    derivedVisible !== splitLeftWindowId(state, groupId) &&
    members.some((window) => window.window_id === derivedVisible && !window.minimized)
  ) {
    return derivedVisible
  }
  const active = state.activeTabByGroupId[groupId]
  const leftWindowId = splitLeftWindowId(state, groupId)
  if (members.some((window) => window.window_id === active) && active !== leftWindowId) {
    const activeWin = members.find((window) => window.window_id === active)
    if (activeWin && !activeWin.minimized) return active
  }
  if (leftWindowId !== null) {
    const firstRight = members.find((window) => window.window_id !== leftWindowId)
    if (firstRight) return firstRight.window_id
  }
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
  const leftWindowId = splitLeftWindowId(state, groupId)
  if (leftWindowId !== null) {
    const rightTabs = remaining.filter((windowId) => windowId !== leftWindowId)
    if (removedWindowId === leftWindowId) return rightTabs[0] ?? remaining[0] ?? null
    if (rightTabs.length > 0) {
      const rightIndex = rightTabs.indexOf(removedWindowId)
      const nextIndex = rightIndex < 0 ? 0 : Math.min(rightIndex, rightTabs.length - 1)
      return rightTabs[nextIndex] ?? rightTabs[rightTabs.length - 1] ?? null
    }
  }
  const removedIndex = group.windowIds.indexOf(removedWindowId)
  const nextIndex = removedIndex < 0 ? 0 : Math.min(removedIndex, remaining.length - 1)
  return remaining[nextIndex] ?? remaining[remaining.length - 1] ?? null
}

export function insertIndexAfterAllRightTabs(state: WorkspaceState, groupId: string): number {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group) return 0
  const leftWindowId = splitLeftWindowId(state, groupId)
  if (leftWindowId === null) return group.windowIds.length
  let lastRightIndex = -1
  for (let index = 0; index < group.windowIds.length; index += 1) {
    if (group.windowIds[index] !== leftWindowId) lastRightIndex = index
  }
  return lastRightIndex + 1
}

export function rightStripIndexToGroupInsertIndex(
  state: WorkspaceState,
  groupId: string,
  rightStripIndex: number,
): number {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group) return 0
  const leftWindowId = splitLeftWindowId(state, groupId)
  if (leftWindowId === null) return rightStripIndex
  const rightWindowIds = group.windowIds.filter((windowId) => windowId !== leftWindowId)
  if (rightStripIndex >= rightWindowIds.length) return insertIndexAfterAllRightTabs(state, groupId)
  const targetWindowId = rightWindowIds[rightStripIndex]
  const targetIndex = group.windowIds.indexOf(targetWindowId)
  return targetIndex < 0 ? group.windowIds.length : targetIndex
}

export function mergeInsertIndexToRightStripSlot(
  state: WorkspaceState,
  groupId: string,
  fullGroupInsertIndex: number,
): number {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group) return 0
  const leftWindowId = splitLeftWindowId(state, groupId)
  if (leftWindowId === null) return fullGroupInsertIndex
  let rightSlot = 0
  for (let index = 0; index < fullGroupInsertIndex && index < group.windowIds.length; index += 1) {
    if (group.windowIds[index] !== leftWindowId) rightSlot += 1
  }
  return rightSlot
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
