import { describe, expect, it, vi } from 'vitest'
import { SHELL_WINDOW_FLAG_SHELL_HOSTED } from '@/features/shell-ui/shellUiWindows'
import type { DerpWindow } from '@/host/appWindowState'
import { createWorkspaceActions } from '@/features/workspace/workspaceActions'
import { createEmptyWorkspaceState } from '@/features/workspace/workspaceState'
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
) {
  return createWorkspaceActions({
    workspaceState: () => createEmptyWorkspaceState(),
    allWindowsMap: () => new Map<number, DerpWindow>(),
    workspaceGroups: () => [],
    workspaceGroupsById: () => new Map(),
    activeWorkspaceGroupId: () => activeWorkspaceGroupId,
    focusedWindowId: () => focusedWindowId,
    focusedTaskbarWindowId: () => focusedWindowId,
    groupIdForWindow: () => null,
    groupForWindow: (wid) =>
      group && wid != null && group.members.some((m) => m.window_id === wid) ? group : null,
    focusShellUiWindow: vi.fn() as (windowId: number) => void,
    activateWindowViaShell: activateWindowViaShell as (windowId: number) => void,
    activateTaskbarWindowViaShell: activateTaskbarWindowViaShell as (windowId: number) => void,
    moveWindowUnderPointer: vi.fn() as (windowId: number, clientX: number, clientY: number) => void,
    shellWireSend: shellWireSend as (
      op: 'minimize' | 'close' | 'workspace_mutation',
      arg?: number | string,
    ) => boolean,
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
})
