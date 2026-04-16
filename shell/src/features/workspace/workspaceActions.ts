import type { Accessor } from 'solid-js'
import type { TabMergeTarget } from '@/features/workspace/tabGroupOps'
import type { DerpWindow } from '@/host/appWindowState'
import type { WorkspaceState } from './workspaceState'
import {
  cycleWorkspaceTab,
  groupIdForWindow,
  getWorkspaceGroupSplit,
  workspaceStatesEqual,
} from './workspaceState'
import type { WorkspaceGroupModel } from './workspaceSelectors'

type WorkspaceActionsOptions = {
  workspaceState: Accessor<WorkspaceState>
  allWindowsMap: Accessor<ReadonlyMap<number, DerpWindow>>
  workspaceGroups: Accessor<WorkspaceGroupModel[]>
  workspaceGroupsById: Accessor<ReadonlyMap<string, WorkspaceGroupModel>>
  activeWorkspaceGroupId: Accessor<string | null>
  focusedWindowId: Accessor<number | null>
  focusedTaskbarWindowId: Accessor<number | null>
  groupIdForWindow: (windowId: number | null | undefined) => string | null
  groupForWindow: (windowId: number | null | undefined) => WorkspaceGroupModel | null
  focusShellUiWindow: (windowId: number) => void
  activateWindowViaShell: (windowId: number) => void
  activateTaskbarWindowViaShell: (windowId: number) => void
  moveWindowUnderPointer: (windowId: number, clientX: number, clientY: number) => void
  shellWireSend: (op: 'minimize' | 'close' | 'workspace_mutation', arg?: number | string) => boolean
}

export function createWorkspaceActions(options: WorkspaceActionsOptions) {
  const sendWorkspaceMutation = (mutation: Record<string, unknown>) =>
    options.shellWireSend('workspace_mutation', JSON.stringify(mutation))

  const focusWindowViaShell = (windowId: number) => {
    const window = options.allWindowsMap().get(windowId)
    if (!window) return false
    if ((window.shell_flags & 1) !== 0) {
      if (window.minimized) {
        options.activateWindowViaShell(windowId)
      } else {
        options.focusShellUiWindow(windowId)
      }
      return true
    }
    options.activateWindowViaShell(windowId)
    return true
  }

  const applyTabDrop = (sourceWindowId: number, target: TabMergeTarget) => {
    const prevState = options.workspaceState()
    const sourceGroupId = groupIdForWindow(prevState, sourceWindowId)
    const targetGroup = options.workspaceGroupsById().get(target.groupId) ?? null
    if (!sourceGroupId || !targetGroup) return false
    return sendWorkspaceMutation({
      type: 'move_window_to_group',
      windowId: sourceWindowId,
      targetGroupId: target.groupId,
      insertIndex: target.insertIndex,
    })
  }

  const detachGroupWindow = (windowId: number, clientX: number, clientY: number) => {
    const prevState = options.workspaceState()
    const sourceGroupId = groupIdForWindow(prevState, windowId)
    const sourceGroup = options.groupForWindow(windowId)
    if (!sourceGroupId || !sourceGroup || sourceGroup.members.length < 2) return false
    if (getWorkspaceGroupSplit(prevState, sourceGroupId)?.leftWindowId === windowId) return false
    if (
      !sendWorkspaceMutation({
        type: 'split_window_to_own_group',
        windowId: windowId,
      })
    ) {
      return false
    }
    options.moveWindowUnderPointer(windowId, clientX, clientY)
    queueMicrotask(() => {
      options.activateWindowViaShell(windowId)
    })
    return true
  }

  const selectGroupWindow = (windowId: number) => {
    const groupId = options.groupIdForWindow(windowId)
    if (!groupId) return false
    const group = options.groupForWindow(windowId)
    if (!group) return false
    if (group.splitLeftWindowId === windowId) {
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
        return focusWindowViaShell(windowId)
      }
      return focusWindowViaShell(windowId)
    }
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
        return focusWindowViaShell(windowId)
      }
      return focusWindowViaShell(windowId)
    }
    return sendWorkspaceMutation({
      type: 'select_tab',
      groupId,
      windowId: windowId,
    })
  }

  const closeGroupWindow = (windowId: number) => {
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
      if (group.members.length > 1) {
        options.activateWindowViaShell(visibleWindow.window_id)
        return
      }
      options.shellWireSend('minimize', visibleWindow.window_id)
      return
    }
    options.activateTaskbarWindowViaShell(visibleWindow.window_id)
  }

  const enterSplitGroupWindow = (windowId: number) => {
    const groupId = options.groupIdForWindow(windowId)
    if (!groupId) return false
    return sendWorkspaceMutation({
      type: 'enter_split',
      groupId,
      leftWindowId: windowId,
      leftPaneFraction: 0.5,
    })
  }

  const exitSplitGroupWindow = (windowId: number) => {
    const groupId = options.groupIdForWindow(windowId)
    if (!groupId) return false
    return sendWorkspaceMutation({
      type: 'exit_split',
      groupId,
    })
  }

  const setSplitGroupFraction = (groupId: string, fraction: number) => {
    return sendWorkspaceMutation({
      type: 'set_split_fraction',
      groupId,
      leftPaneFraction: fraction,
    })
  }

  return {
    focusWindowViaShell,
    applyTabDrop,
    detachGroupWindow,
    selectGroupWindow,
    closeGroupWindow,
    cycleFocusedWorkspaceGroup,
    activateTaskbarGroup,
    enterSplitGroupWindow,
    exitSplitGroupWindow,
    setSplitGroupFraction,
  }
}
