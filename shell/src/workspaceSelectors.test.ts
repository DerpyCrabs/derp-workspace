import { describe, expect, it } from 'vitest'
import { buildTaskbarRowsByMonitor, buildWorkspaceGroups } from './workspaceSelectors'
import type { DerpWindow } from './app/appWindowState'
import type { WorkspaceState } from './workspaceState'

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
    output_name: 'HDMI-A-1',
    minimized: false,
    maximized: false,
    fullscreen: false,
    shell_flags: 0,
    capture_identifier: `capture-${window_id}`,
    ...patch,
  }
}

const workspaceState: WorkspaceState = {
  groups: [
    { id: 'group-a', windowIds: [1] },
    { id: 'group-b', windowIds: [2] },
  ],
  activeTabByGroupId: {
    'group-a': 1,
    'group-b': 2,
  },
  pinnedWindowIds: [],
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

    const first = buildTaskbarRowsByMonitor(groups, apps, 'HDMI-A-1')
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
    const second = buildTaskbarRowsByMonitor(updatedGroups, apps, 'HDMI-A-1', first)

    expect(second.get('HDMI-A-1')).toBe(first.get('HDMI-A-1'))
    expect(second.get('DP-1')).toBe(first.get('DP-1'))
  })
})
