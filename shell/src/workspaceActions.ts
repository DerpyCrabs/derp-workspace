import type { Accessor } from 'solid-js'
import type { Setter } from 'solid-js'
import type { TabMergeTarget } from './tabGroupOps'
import { nextActiveWindowAfterRemoval } from './tabGroupOps'
import type { DerpWindow } from './app/appWindowState'
import type { WorkspaceState } from './workspaceState'
import {
  cycleWorkspaceTab,
  groupIdForWindow,
  moveWorkspaceWindowToGroup,
  setWorkspaceActiveTab,
  splitWorkspaceWindowToOwnGroup,
  workspaceStatesEqual,
} from './workspaceState'
import type { WorkspaceGroupModel } from './workspaceSelectors'

type WorkspaceActionsOptions = {
  workspaceState: Accessor<WorkspaceState>
  setWorkspaceState: Setter<WorkspaceState>
  allWindowsMap: Accessor<ReadonlyMap<number, DerpWindow>>
  workspaceGroups: Accessor<WorkspaceGroupModel[]>
  workspaceGroupsById: Accessor<ReadonlyMap<string, WorkspaceGroupModel>>
  activeWorkspaceGroupId: Accessor<string | null>
  focusedWindowId: Accessor<number | null>
  focusedTaskbarWindowId: Accessor<number | null>
  groupIdForWindow: (windowId: number | null | undefined) => string | null
  groupForWindow: (windowId: number | null | undefined) => WorkspaceGroupModel | null
  syncWindowGeometry: (windowId: number, fromWindow: DerpWindow) => void
  focusShellUiWindow: (windowId: number) => void
  activateTaskbarWindowViaShell: (windowId: number) => void
  moveWindowUnderPointer: (windowId: number, clientX: number, clientY: number) => void
  shellWireSend: (op: 'minimize' | 'close', arg?: number | string) => boolean
  pendingGroupCloseActivations: Map<
    number,
    { groupId: string; nextVisibleId: number; closingWindow: DerpWindow }
  >
}

export function createWorkspaceActions(options: WorkspaceActionsOptions) {
  const focusWindowViaShell = (windowId: number) => {
    const window = options.allWindowsMap().get(windowId)
    if (!window) return false
    if ((window.shell_flags & 1) !== 0) {
      options.focusShellUiWindow(windowId)
      return true
    }
    options.activateTaskbarWindowViaShell(windowId)
    return true
  }

  const syncHiddenGroupWindowGeometry = (visibleWindowId: number) => {
    const group = options.groupForWindow(visibleWindowId)
    const visibleWindow = options.allWindowsMap().get(visibleWindowId)
    if (!group || group.visibleWindowId !== visibleWindowId || !visibleWindow) return
    for (const hiddenWindowId of group.hiddenWindowIds) {
      const hiddenWindow = options.allWindowsMap().get(hiddenWindowId)
      if (
        hiddenWindow &&
        hiddenWindow.x === visibleWindow.x &&
        hiddenWindow.y === visibleWindow.y &&
        hiddenWindow.width === visibleWindow.width &&
        hiddenWindow.height === visibleWindow.height &&
        hiddenWindow.output_name === visibleWindow.output_name &&
        hiddenWindow.maximized === visibleWindow.maximized
      ) {
        continue
      }
      options.syncWindowGeometry(hiddenWindowId, visibleWindow)
    }
  }

  const applyTabDrop = (sourceWindowId: number, target: TabMergeTarget) => {
    const prevState = options.workspaceState()
    const sourceGroupId = groupIdForWindow(prevState, sourceWindowId)
    const targetGroup = options.workspaceGroupsById().get(target.groupId) ?? null
    const sourceWindow = options.allWindowsMap().get(sourceWindowId)
    if (!sourceGroupId || !targetGroup || !sourceWindow) return false
    const sameGroup = sourceGroupId === target.groupId
    const nextState = moveWorkspaceWindowToGroup(prevState, sourceWindowId, target.groupId, target.insertIndex)
    if (workspaceStatesEqual(nextState, prevState)) return false
    options.setWorkspaceState(nextState)
    if (!sameGroup) {
      options.syncWindowGeometry(sourceWindowId, targetGroup.visibleWindow)
      queueMicrotask(() => {
        if (!sourceWindow.minimized) options.shellWireSend('minimize', sourceWindowId)
      })
    }
    return true
  }

  const detachGroupWindow = (windowId: number, clientX: number, clientY: number) => {
    const prevState = options.workspaceState()
    const sourceGroupId = groupIdForWindow(prevState, windowId)
    const sourceGroup = options.groupForWindow(windowId)
    const sourceWindow = options.allWindowsMap().get(windowId)
    if (!sourceGroupId || !sourceGroup || !sourceWindow || sourceGroup.members.length < 2) return false
    const nextState = splitWorkspaceWindowToOwnGroup(prevState, windowId)
    if (workspaceStatesEqual(nextState, prevState)) return false
    const nextVisibleId =
      sourceGroup.visibleWindowId === windowId
        ? nextActiveWindowAfterRemoval(prevState, sourceGroupId, windowId)
        : null
    options.setWorkspaceState(nextState)
    if (nextVisibleId !== null) {
      options.syncWindowGeometry(nextVisibleId, sourceGroup.visibleWindow)
      queueMicrotask(() => {
        options.activateTaskbarWindowViaShell(nextVisibleId)
      })
    }
    options.moveWindowUnderPointer(windowId, clientX, clientY)
    queueMicrotask(() => {
      options.activateTaskbarWindowViaShell(windowId)
    })
    return true
  }

  const selectGroupWindow = (windowId: number) => {
    const groupId = options.groupIdForWindow(windowId)
    if (!groupId) return false
    const group = options.groupForWindow(windowId)
    if (!group) return false
    if (group.visibleWindowId === windowId) {
      const window = options.allWindowsMap().get(windowId)
      if (
        window &&
        !window.minimized &&
        options.activeWorkspaceGroupId() === groupId &&
        options.focusedWindowId() === windowId
      ) {
        return true
      }
      if (window && (window.shell_flags & 1) !== 0) {
        options.focusShellUiWindow(windowId)
        return true
      }
      return focusWindowViaShell(windowId)
    }
    const targetWindow = options.allWindowsMap().get(windowId)
    if (targetWindow) options.syncWindowGeometry(windowId, group.visibleWindow)
    options.setWorkspaceState((prev) => setWorkspaceActiveTab(prev, groupId, windowId))
    queueMicrotask(() => {
      options.activateTaskbarWindowViaShell(windowId)
      if (!group.visibleWindow.minimized) options.shellWireSend('minimize', group.visibleWindow.window_id)
    })
    return true
  }

  const closeGroupWindow = (windowId: number) => {
    const groupId = options.groupIdForWindow(windowId)
    const group = options.groupForWindow(windowId)
    const closingWindow = options.allWindowsMap().get(windowId)
    if (groupId && group && closingWindow) {
      const nextVisibleId = nextActiveWindowAfterRemoval(options.workspaceState(), groupId, windowId)
      if (nextVisibleId !== null && group.visibleWindowId === windowId) {
        options.pendingGroupCloseActivations.set(windowId, {
          groupId,
          nextVisibleId,
          closingWindow: { ...closingWindow },
        })
      } else {
        options.pendingGroupCloseActivations.delete(windowId)
      }
    } else {
      options.pendingGroupCloseActivations.delete(windowId)
    }
    options.shellWireSend('close', windowId)
  }

  const cycleFocusedWorkspaceGroup = (delta: 1 | -1) => {
    const fallbackWindowId = options.focusedTaskbarWindowId() ?? options.workspaceGroups()[0]?.visibleWindowId ?? null
    const groupId = options.activeWorkspaceGroupId() ?? options.groupIdForWindow(fallbackWindowId)
    if (!groupId) return false
    const next = cycleWorkspaceTab(options.workspaceState(), groupId, delta)
    if (workspaceStatesEqual(next, options.workspaceState())) return false
    const nextWindowId = next.activeTabByGroupId[groupId]
    return selectGroupWindow(nextWindowId)
  }

  const activateTaskbarGroup = (windowId: number) => {
    const group = options.groupForWindow(windowId)
    if (!group) {
      options.activateTaskbarWindowViaShell(windowId)
      return
    }
    const visibleWindow = group.visibleWindow
    if (visibleWindow.minimized) {
      options.activateTaskbarWindowViaShell(visibleWindow.window_id)
      return
    }
    if (options.activeWorkspaceGroupId() === group.id) {
      options.shellWireSend('minimize', visibleWindow.window_id)
      return
    }
    options.activateTaskbarWindowViaShell(visibleWindow.window_id)
  }

  return {
    syncHiddenGroupWindowGeometry,
    focusWindowViaShell,
    applyTabDrop,
    detachGroupWindow,
    selectGroupWindow,
    closeGroupWindow,
    cycleFocusedWorkspaceGroup,
    activateTaskbarGroup,
  }
}
