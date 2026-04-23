import { describe, expect, it, vi } from 'vitest'
import { SHELL_WINDOW_FLAG_SHELL_HOSTED } from '@/features/shell-ui/shellUiWindows'
import type { ShellCompositorWireSend } from '@/features/shell-ui/shellWireSendType'
import type { DerpWindow } from '@/host/appWindowState'
import { createWorkspaceActions } from '@/features/workspace/workspaceActions'
import { createEmptyWorkspaceState, type WorkspaceState } from '@/features/workspace/workspaceState'
import type { WorkspaceGroupModel } from '@/features/workspace/workspaceSelectors'

function baseWindow(id: number, shellHosted: boolean): DerpWindow {
  return {
    window_id: id,
    surface_id: id,
    stack_z: 1,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    title: 't',
    app_id: 'app.test',
    output_name: 'o',
    kind: 'native',
    x11_class: '',
    x11_instance: '',
    minimized: false,
    maximized: false,
    fullscreen: false,
    shell_flags: shellHosted ? SHELL_WINDOW_FLAG_SHELL_HOSTED : 0,
    capture_identifier: '',
  }
}

function singleGroup(w: DerpWindow): WorkspaceGroupModel {
  return {
    id: 'g1',
    members: [w],
    visibleWindowId: w.window_id,
    visibleWindow: w,
    splitLeftWindowId: null,
    splitLeftWindow: null,
    splitPaneFraction: null,
    visibleWindowIds: [w.window_id],
    hiddenWindowIds: [],
  }
}

function actionsFor(
  group: WorkspaceGroupModel | null,
  activeWorkspaceGroupId: string | null,
  focusedWindowId: number | null,
  shellWireSend: ReturnType<typeof vi.fn>,
  activateTaskbarWindowViaShell: ReturnType<typeof vi.fn>,
  activateWindowViaShell: ReturnType<typeof vi.fn>,
  workspaceStateValue: WorkspaceState = createEmptyWorkspaceState(),
  sendWindowIntent?: ReturnType<typeof vi.fn>,
) {
  const workspaceGroups = group ? [group] : []
  const workspaceGroupsById = new Map(workspaceGroups.map((entry) => [entry.id, entry]))
  return createWorkspaceActions({
    workspaceState: () => workspaceStateValue,
    allWindowsMap: () => new Map<number, DerpWindow>(),
    workspaceGroups: () => workspaceGroups,
    workspaceGroupsById: () => workspaceGroupsById,
    activeWorkspaceGroupId: () => activeWorkspaceGroupId,
    focusedWindowId: () => focusedWindowId,
    focusedTaskbarWindowId: () => focusedWindowId,
    groupIdForWindow: (wid) =>
      group && wid != null && group.members.some((m) => m.window_id === wid) ? group.id : null,
    groupForWindow: (wid) =>
      group && wid != null && group.members.some((m) => m.window_id === wid) ? group : null,
    focusShellUiWindow: vi.fn() as (windowId: number) => void,
    activateWindowViaShell: activateWindowViaShell as (windowId: number) => void,
    activateTaskbarWindowViaShell: activateTaskbarWindowViaShell as (windowId: number) => void,
    sendWindowIntent: sendWindowIntent as ((action: string, windowId: number) => boolean) | undefined,
    shellWireSend: shellWireSend as ShellCompositorWireSend,
  })
}

describe('activateTaskbarGroup', () => {
  it('sends taskbar_activate for single native window compositor handles toggle', () => {
    const w = baseWindow(10, false)
    const group = singleGroup(w)
    const shellWireSend = vi.fn(() => true)
    const activateTaskbarWindowViaShell = vi.fn()
    const activateWindowViaShell = vi.fn()
    const { activateTaskbarGroup } = actionsFor(
      group,
      null,
      10,
      shellWireSend,
      activateTaskbarWindowViaShell,
      activateWindowViaShell,
    )
    activateTaskbarGroup(10)
    expect(activateTaskbarWindowViaShell).toHaveBeenCalledWith(10)
    expect(shellWireSend).not.toHaveBeenCalledWith('minimize', 10)
  })

  it('sends taskbar_activate for single shell-hosted when workspace group is active', () => {
    const w = baseWindow(20, true)
    const group = singleGroup(w)
    const shellWireSend = vi.fn(() => true)
    const activateTaskbarWindowViaShell = vi.fn()
    const activateWindowViaShell = vi.fn()
    const { activateTaskbarGroup } = actionsFor(
      group,
      'g1',
      20,
      shellWireSend,
      activateTaskbarWindowViaShell,
      activateWindowViaShell,
    )
    activateTaskbarGroup(20)
    expect(activateTaskbarWindowViaShell).toHaveBeenCalledWith(20)
    expect(shellWireSend).not.toHaveBeenCalledWith('minimize', 20)
  })

  it('activates window for multi-member group when workspace is active', () => {
    const a = baseWindow(1, false)
    const b = baseWindow(2, false)
    const group: WorkspaceGroupModel = {
      id: 'g2',
      members: [a, b],
      visibleWindowId: 1,
      visibleWindow: a,
      splitLeftWindowId: null,
      splitLeftWindow: null,
      splitPaneFraction: null,
      visibleWindowIds: [1],
      hiddenWindowIds: [2],
    }
    const shellWireSend = vi.fn(() => true)
    const activateTaskbarWindowViaShell = vi.fn()
    const activateWindowViaShell = vi.fn()
    const { activateTaskbarGroup } = actionsFor(
      group,
      'g2',
      1,
      shellWireSend,
      activateTaskbarWindowViaShell,
      activateWindowViaShell,
    )
    activateTaskbarGroup(1)
    expect(activateWindowViaShell).toHaveBeenCalledWith(1)
    expect(shellWireSend).not.toHaveBeenCalled()
  })

  it('restores minimized window via taskbar_activate', () => {
    const w = { ...baseWindow(30, false), minimized: true }
    const group = singleGroup(w)
    const shellWireSend = vi.fn(() => true)
    const activateTaskbarWindowViaShell = vi.fn()
    const activateWindowViaShell = vi.fn()
    const { activateTaskbarGroup } = actionsFor(
      group,
      'g1',
      30,
      shellWireSend,
      activateTaskbarWindowViaShell,
      activateWindowViaShell,
    )
    activateTaskbarGroup(30)
    expect(activateTaskbarWindowViaShell).toHaveBeenCalledWith(30)
    expect(shellWireSend).not.toHaveBeenCalledWith('minimize', 30)
  })

  it('sends close_group window intent for grouped window close', () => {
    const w = baseWindow(40, false)
    const group = singleGroup(w)
    const shellWireSend = vi.fn(() => true)
    const activateTaskbarWindowViaShell = vi.fn()
    const activateWindowViaShell = vi.fn()
    const sendWindowIntent = vi.fn(() => true)
    const { closeGroupWindow, closeWindow } = actionsFor(
      group,
      'g1',
      40,
      shellWireSend,
      activateTaskbarWindowViaShell,
      activateWindowViaShell,
      createEmptyWorkspaceState(),
      sendWindowIntent,
    )
    closeGroupWindow(40)
    closeWindow(40)
    expect(sendWindowIntent).toHaveBeenCalledWith('close_group', 40)
    expect(shellWireSend).toHaveBeenCalledWith('close', 40)
  })

  it('drops a multi-tab window as a whole group into another tab strip', () => {
    const a = baseWindow(1, false)
    const b = baseWindow(2, false)
    const target = baseWindow(3, false)
    const sourceGroup: WorkspaceGroupModel = {
      id: 'g-source',
      members: [a, b],
      visibleWindowId: 1,
      visibleWindow: a,
      splitLeftWindowId: null,
      splitLeftWindow: null,
      splitPaneFraction: null,
      visibleWindowIds: [1],
      hiddenWindowIds: [2],
    }
    const workspaceStateValue: WorkspaceState = {
      ...createEmptyWorkspaceState(),
      groups: [
        { id: 'g-source', windowIds: [1, 2] },
        { id: 'g-target', windowIds: [3] },
      ],
      activeTabByGroupId: {
        'g-source': 1,
        'g-target': 3,
      },
      nextGroupSeq: 3,
    }
    const shellWireSend = vi.fn(() => true)
    const activateTaskbarWindowViaShell = vi.fn()
    const activateWindowViaShell = vi.fn()
    const actions = createWorkspaceActions({
      workspaceState: () => workspaceStateValue,
      allWindowsMap: () => new Map<number, DerpWindow>([
        [1, a],
        [2, b],
        [3, target],
      ]),
      workspaceGroups: () => [
        sourceGroup,
        {
          id: 'g-target',
          members: [target],
          visibleWindowId: 3,
          visibleWindow: target,
          splitLeftWindowId: null,
          splitLeftWindow: null,
          splitPaneFraction: null,
          visibleWindowIds: [3],
          hiddenWindowIds: [],
        },
      ],
      workspaceGroupsById: () =>
        new Map<string, WorkspaceGroupModel>([
          ['g-source', sourceGroup],
          [
            'g-target',
            {
              id: 'g-target',
              members: [target],
              visibleWindowId: 3,
              visibleWindow: target,
              splitLeftWindowId: null,
              splitLeftWindow: null,
              splitPaneFraction: null,
              visibleWindowIds: [3],
              hiddenWindowIds: [],
            },
          ],
        ]),
      activeWorkspaceGroupId: () => null,
      focusedWindowId: () => null,
      focusedTaskbarWindowId: () => null,
      groupIdForWindow: (windowId) =>
        windowId === 1 || windowId === 2 ? 'g-source' : windowId === 3 ? 'g-target' : null,
      groupForWindow: (windowId) =>
        windowId === 1 || windowId === 2
          ? sourceGroup
          : windowId === 3
            ? {
                id: 'g-target',
                members: [target],
                visibleWindowId: 3,
                visibleWindow: target,
                splitLeftWindowId: null,
                splitLeftWindow: null,
                splitPaneFraction: null,
                visibleWindowIds: [3],
                hiddenWindowIds: [],
              }
            : null,
      focusShellUiWindow: vi.fn() as (windowId: number) => void,
      activateWindowViaShell: activateWindowViaShell as (windowId: number) => void,
      activateTaskbarWindowViaShell: activateTaskbarWindowViaShell as (windowId: number) => void,
      shellWireSend: shellWireSend as ShellCompositorWireSend,
    })
    actions.applyWindowDrop(1, { groupId: 'g-target', insertIndex: 1 })
    expect(shellWireSend).toHaveBeenCalledWith(
      'workspace_mutation',
      JSON.stringify({
        type: 'move_group_to_group',
        sourceGroupId: 'g-source',
        targetGroupId: 'g-target',
        insertIndex: 1,
      }),
    )
  })

  it('detaches a grouped tab by sending only the split mutation', () => {
    const a = baseWindow(1, false)
    const b = baseWindow(2, false)
    const group: WorkspaceGroupModel = {
      id: 'g-source',
      members: [a, b],
      visibleWindowId: 1,
      visibleWindow: a,
      splitLeftWindowId: null,
      splitLeftWindow: null,
      splitPaneFraction: null,
      visibleWindowIds: [1],
      hiddenWindowIds: [2],
    }
    const workspaceStateValue: WorkspaceState = {
      ...createEmptyWorkspaceState(),
      groups: [{ id: 'g-source', windowIds: [1, 2] }],
      activeTabByGroupId: { 'g-source': 1 },
      nextGroupSeq: 2,
    }
    const shellWireSend = vi.fn(() => true)
    const activateTaskbarWindowViaShell = vi.fn()
    const activateWindowViaShell = vi.fn()
    const actions = createWorkspaceActions({
      workspaceState: () => workspaceStateValue,
      allWindowsMap: () => new Map<number, DerpWindow>([
        [1, a],
        [2, b],
      ]),
      workspaceGroups: () => [group],
      workspaceGroupsById: () => new Map<string, WorkspaceGroupModel>([['g-source', group]]),
      activeWorkspaceGroupId: () => null,
      focusedWindowId: () => null,
      focusedTaskbarWindowId: () => null,
      groupIdForWindow: (windowId) =>
        windowId === 1 || windowId === 2 ? 'g-source' : null,
      groupForWindow: (windowId) =>
        windowId === 1 || windowId === 2 ? group : null,
      focusShellUiWindow: vi.fn() as (windowId: number) => void,
      activateWindowViaShell: activateWindowViaShell as (windowId: number) => void,
      activateTaskbarWindowViaShell: activateTaskbarWindowViaShell as (windowId: number) => void,
      shellWireSend: shellWireSend as ShellCompositorWireSend,
    })
    expect(actions.detachGroupWindow(2, 320, 180)).toBe(true)
    expect(shellWireSend).toHaveBeenCalledWith(
      'workspace_mutation',
      JSON.stringify({
        type: 'split_window_to_own_group',
        windowId: 2,
      }),
    )
    expect(activateWindowViaShell).not.toHaveBeenCalled()
  })
})
