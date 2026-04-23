import { describe, expect, it } from 'vitest'
import { buildTaskbarRowsByMonitor, buildWorkspaceGroups } from './workspaceSelectors'
import type { DerpWindow } from '@/host/appWindowState'
import { createEmptyWorkspaceState, type WorkspaceState } from './workspaceState'

function makeWindow(window_id: number, patch: Partial<DerpWindow> = {}): DerpWindow {
  return {
    window_id,
    surface_id: window_id,
    stack_z: window_id,
    x: window_id * 10,
    y: window_id * 20,
    width: 400,
    height: 300,
    title: `window-${window_id}`,
    app_id: `app.${window_id}`,
    ...patch,
    output_id: patch.output_id ?? 'make:model:serial',
    output_name: patch.output_name ?? 'HDMI-A-1',
    kind: patch.kind ?? 'native',
    x11_class: patch.x11_class ?? '',
    x11_instance: patch.x11_instance ?? '',
    minimized: patch.minimized ?? false,
    maximized: patch.maximized ?? false,
    fullscreen: patch.fullscreen ?? false,
    shell_flags: patch.shell_flags ?? 0,
    capture_identifier: patch.capture_identifier ?? `capture-${window_id}`,
  }
}

const workspaceState: WorkspaceState = {
  ...createEmptyWorkspaceState(),
  groups: [
    { id: 'group-a', windowIds: [1] },
    { id: 'group-b', windowIds: [2] },
  ],
  activeTabByGroupId: {
    'group-a': 1,
    'group-b': 2,
  },
  nextGroupSeq: 3,
}

describe('workspaceSelectors', () => {
  it('reuses unaffected workspace groups when one window changes', () => {
    const left = makeWindow(1)
    const right = makeWindow(2)
    const first = buildWorkspaceGroups(
      workspaceState,
      new Map([
        [1, left],
        [2, right],
      ]),
    )
    const updatedRight = { ...right, width: 640 }
    const second = buildWorkspaceGroups(
      workspaceState,
      new Map([
        [1, left],
        [2, updatedRight],
      ]),
      first,
    )

    expect(second.find((group) => group.id === 'group-a')).toBe(first.find((group) => group.id === 'group-a'))
    expect(second.find((group) => group.id === 'group-b')).not.toBe(first.find((group) => group.id === 'group-b'))
  })

  it('reuses unchanged taskbar rows by monitor', () => {
    const left = makeWindow(1, { title: 'Firefox', app_id: 'firefox', output_name: 'HDMI-A-1' })
    const right = makeWindow(2, { title: 'Console', app_id: 'kgx', output_name: 'DP-1' })
    const groups = buildWorkspaceGroups(
      {
        ...workspaceState,
        groups: [
          { id: 'group-a', windowIds: [1] },
          { id: 'group-b', windowIds: [2] },
        ],
        activeTabByGroupId: { 'group-a': 1, 'group-b': 2 },
      },
      new Map([
        [1, left],
        [2, right],
      ]),
    )
    const apps = [
      { name: 'Firefox', exec: 'firefox', executable: 'firefox', desktop_id: 'firefox.desktop', icon: 'firefox' },
      { name: 'Console', exec: 'kgx', executable: 'kgx', desktop_id: 'org.gnome.Console.desktop', icon: 'console' },
    ]

    const first = buildTaskbarRowsByMonitor(
      {
        ...workspaceState,
        groups: [
          { id: 'group-a', windowIds: [1] },
          { id: 'group-b', windowIds: [2] },
        ],
        activeTabByGroupId: { 'group-a': 1, 'group-b': 2 },
      },
      groups,
      apps,
      'HDMI-A-1',
    )
    const updatedGroups = buildWorkspaceGroups(
      {
        ...workspaceState,
        groups: [
          { id: 'group-a', windowIds: [1] },
          { id: 'group-b', windowIds: [2] },
        ],
        activeTabByGroupId: { 'group-a': 1, 'group-b': 2 },
      },
      new Map([
        [1, left],
        [2, { ...right, width: 640 }],
      ]),
      groups,
    )
    const second = buildTaskbarRowsByMonitor(
      {
        ...workspaceState,
        groups: [
          { id: 'group-a', windowIds: [1] },
          { id: 'group-b', windowIds: [2] },
        ],
        activeTabByGroupId: { 'group-a': 1, 'group-b': 2 },
      },
      updatedGroups,
      apps,
      'HDMI-A-1',
      first,
    )

    expect(second.get('HDMI-A-1')).toBe(first.get('HDMI-A-1'))
    expect(second.get('DP-1')).toBe(first.get('DP-1'))
  })

  it('keeps taskbar row order stable when focus changes restack windows', () => {
    const state = {
      ...workspaceState,
      groups: [
        { id: 'group-a', windowIds: [1] },
        { id: 'group-b', windowIds: [2] },
      ],
      activeTabByGroupId: { 'group-a': 1, 'group-b': 2 },
    }
    const focusedShellGroups = buildWorkspaceGroups(
      state,
      new Map([
        [1, makeWindow(1, { title: 'Native', stack_z: 1 })],
        [2, makeWindow(2, { title: 'Settings', stack_z: 2 })],
      ]),
    )
    const focusedNativeGroups = buildWorkspaceGroups(
      state,
      new Map([
        [1, makeWindow(1, { title: 'Native', stack_z: 3 })],
        [2, makeWindow(2, { title: 'Settings', stack_z: 1 })],
      ]),
    )

    expect(focusedShellGroups.map((group) => group.id)).toEqual(['group-b', 'group-a'])
    expect(focusedNativeGroups.map((group) => group.id)).toEqual(['group-a', 'group-b'])
    expect(
      buildTaskbarRowsByMonitor(state, focusedShellGroups, [], 'HDMI-A-1')
        .get('HDMI-A-1')
        ?.map((row) => row.group_id),
    ).toEqual(['group-a', 'group-b'])
    expect(
      buildTaskbarRowsByMonitor(state, focusedNativeGroups, [], 'HDMI-A-1')
        .get('HDMI-A-1')
        ?.map((row) => row.group_id),
    ).toEqual(['group-a', 'group-b'])
  })

  it('exposes split metadata on workspace groups', () => {
    const groups = buildWorkspaceGroups(
      {
        ...workspaceState,
        groups: [{ id: 'group-a', windowIds: [1, 2] }],
        activeTabByGroupId: { 'group-a': 2 },
        splitByGroupId: { 'group-a': { leftWindowId: 1, leftPaneFraction: 0.5 } },
      },
      new Map([
        [1, makeWindow(1)],
        [2, makeWindow(2, { x: 420 })],
      ]),
    )
    expect(groups[0]?.splitLeftWindowId).toBe(1)
    expect(groups[0]?.visibleWindowIds).toEqual([1, 2])
    expect(groups[0]?.hiddenWindowIds).toEqual([])
  })
})
