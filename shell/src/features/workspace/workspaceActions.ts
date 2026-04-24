import type { Accessor } from 'solid-js'
import type { TabMergeTarget } from '@/features/workspace/tabGroupOps'
import type { DerpWindow } from '@/host/appWindowState'
import { SHELL_LAYOUT_FLOATING } from '@/lib/chromeConstants'
import type { ShellCompositorWireSend } from '@/features/shell-ui/shellWireSendType'
import type { WorkspaceState } from './workspaceState'
import { groupIdForWindow, getWorkspaceGroupSplit } from './workspaceState'
import type { WorkspaceMutation } from './workspaceProtocol'
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
  sendWorkspaceMutation?: (mutation: WorkspaceMutation) => boolean
  sendWindowIntent?: (action: string, windowId: number) => boolean
  shellWireSend: ShellCompositorWireSend
}

export function createWorkspaceActions(options: WorkspaceActionsOptions) {
  const sendWorkspaceMutation = (mutation: WorkspaceMutation) =>
    options.sendWorkspaceMutation?.(mutation) ??
    options.shellWireSend('workspace_mutation', JSON.stringify(mutation))

  const sendWindowIntent = (action: string, windowId: number) =>
    options.sendWindowIntent?.(action, windowId) ??
    options.shellWireSend('window_intent', JSON.stringify({ action, windowId }))

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
    if (sourceWindowId === target.targetWindowId) return false
    return sendWorkspaceMutation({
      type: 'move_window_to_window',
      windowId: sourceWindowId,
      targetWindowId: target.targetWindowId,
      insertIndex: target.insertIndex,
    })
  }

  const applyWindowDrop = (sourceWindowId: number, target: TabMergeTarget) => {
    if (sourceWindowId === target.targetWindowId) return false
    return sendWorkspaceMutation({
      type: 'move_group_to_window',
      insertIndex: target.insertIndex,
      sourceWindowId,
      targetWindowId: target.targetWindowId,
    })
  }

  const detachGroupWindow = (windowId: number, _clientX: number, _clientY: number) => {
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
      type: 'select_window_tab',
      windowId: windowId,
    })
  }

  const closeWindow = (windowId: number) => {
    if (typeof window !== 'undefined' && typeof window.__derpShellWireSend !== 'function') {
      console.warn('[derp-shell] closeWindow missing __derpShellWireSend', windowId)
    }
    const ok = options.shellWireSend('close', windowId)
    if (!ok) {
      console.warn('[derp-shell] closeWindow shellWireSend false', windowId)
    }
  }

  const closeGroupWindow = (windowId: number) => {
    const ok = sendWindowIntent('close_group', windowId)
    if (!ok) {
      console.warn('[derp-shell] closeGroupWindow sendWindowIntent false', windowId)
    }
  }

  const cycleFocusedWorkspaceGroup = (delta: 1 | -1) => {
    const fallbackWindowId = options.focusedTaskbarWindowId() ?? options.workspaceGroups()[0]?.visibleWindowId ?? null
    const groupId = options.activeWorkspaceGroupId() ?? options.groupIdForWindow(fallbackWindowId)
    if (!groupId) return false
    const group = options.workspaceGroupsById().get(groupId)
    if (!group || group.members.length < 2) return false
    const currentIndex = Math.max(
      0,
      group.members.findIndex((member) => member.window_id === group.visibleWindowId),
    )
    const nextIndex = (currentIndex + delta + group.members.length) % group.members.length
    const nextWindowId = group.members[nextIndex]?.window_id
    if (!nextWindowId || nextWindowId === group.visibleWindowId) return false
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
    if (options.activeWorkspaceGroupId() === group.id && group.members.length > 1) {
      options.activateWindowViaShell(visibleWindow.window_id)
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
    const group = options.groupForWindow(windowId)
    const split = getWorkspaceGroupSplit(options.workspaceState(), groupId)
    const leftWindow = group?.splitLeftWindow ?? null
    const rightWindow = group?.visibleWindow ?? null
    const restoreRect =
      split?.leftWindowId === windowId && leftWindow && rightWindow
        ? {
            x: Math.min(leftWindow.x, rightWindow.x),
            y: Math.min(leftWindow.y, rightWindow.y),
            width:
              Math.max(leftWindow.x + leftWindow.width, rightWindow.x + rightWindow.width) -
              Math.min(leftWindow.x, rightWindow.x),
            height:
              Math.max(leftWindow.y + leftWindow.height, rightWindow.y + rightWindow.height) -
              Math.min(leftWindow.y, rightWindow.y),
          }
        : null
    const ok = sendWorkspaceMutation({
      type: 'exit_split',
      groupId,
    })
    if (!ok || !restoreRect) return ok
    sendWorkspaceMutation({
      type: 'select_tab',
      groupId,
      windowId,
    })
    options.shellWireSend(
      'set_geometry',
      windowId,
      restoreRect.x,
      restoreRect.y,
      Math.max(1, restoreRect.width),
      Math.max(1, restoreRect.height),
      SHELL_LAYOUT_FLOATING,
    )
    options.activateWindowViaShell(windowId)
    return ok
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
    applyWindowDrop,
    detachGroupWindow,
    selectGroupWindow,
    closeWindow,
    closeGroupWindow,
    cycleFocusedWorkspaceGroup,
    activateTaskbarGroup,
    enterSplitGroupWindow,
    exitSplitGroupWindow,
    setSplitGroupFraction,
  }
}
