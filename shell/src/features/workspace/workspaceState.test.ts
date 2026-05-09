import { describe, expect, it } from 'vitest'
import {
  createEmptyWorkspaceState,
  normalizeWorkspaceState,
  reconcileWorkspaceState,
  workspaceFindMonitorIdentityForTiledWindow,
  workspaceMonitorTileEntries,
  type WorkspaceState,
} from './workspaceState'

describe('workspaceState', () => {
  it('normalizes authoritative snapshots without seeding or repairing compositor-owned groups', () => {
    const state = normalizeWorkspaceState({
      groups: [
        { id: 'group-1', windowIds: [3, 4] },
        { id: 'group-2', windowIds: [9] },
      ],
      activeTabByGroupId: {
        'group-1': 99,
      },
      pinnedWindowIds: [4, 9, 42],
      nextGroupSeq: 3,
    })

    expect(state.groups).toEqual([
      { id: 'group-1', windowIds: [3, 4] },
      { id: 'group-2', windowIds: [9] },
    ])
    expect(state.activeTabByGroupId).toEqual({})
    expect(state.pinnedWindowIds).toEqual([4, 9, 42])
  })

  it('keeps reconciliation as read-only projection from compositor snapshots', () => {
    const state: WorkspaceState = {
      ...createEmptyWorkspaceState(),
      groups: [
        { id: 'group-1', windowIds: [3, 4] },
        { id: 'group-2', windowIds: [9] },
      ],
      activeTabByGroupId: {
        'group-1': 4,
        'group-2': 9,
      },
      pinnedWindowIds: [4, 9],
      nextGroupSeq: 3,
    }

    expect(reconcileWorkspaceState(state, [3])).toEqual({
      ...createEmptyWorkspaceState(),
      groups: [{ id: 'group-1', windowIds: [3] }],
      activeTabByGroupId: { 'group-1': 3 },
      nextGroupSeq: 3,
    })
    expect(state.groups).toEqual([
      { id: 'group-1', windowIds: [3, 4] },
      { id: 'group-2', windowIds: [9] },
    ])
    expect(state.activeTabByGroupId).toEqual({
      'group-1': 4,
      'group-2': 9,
    })
    expect(state.pinnedWindowIds).toEqual([4, 9])
  })

  it('prefers output identity when reading monitor tile entries', () => {
    const state: WorkspaceState = {
      ...createEmptyWorkspaceState(),
      monitorTiles: [
        {
          outputId: 'make:model:serial-a',
          outputName: 'DP-1',
          entries: [
            {
              windowId: 1,
              zone: 'left-half',
              bounds: { x: 0, y: 0, width: 960, height: 1040 },
            },
          ],
        },
        {
          outputId: 'make:model:serial-b',
          outputName: 'DP-1',
          entries: [
            {
              windowId: 2,
              zone: 'right-half',
              bounds: { x: 960, y: 0, width: 960, height: 1040 },
            },
          ],
        },
      ],
    }
    expect(workspaceMonitorTileEntries(state, 'DP-1', 'make:model:serial-b').map((entry) => entry.windowId)).toEqual([2])
    expect(workspaceFindMonitorIdentityForTiledWindow(state, 2)).toBe('make:model:serial-b')
  })

  it('keeps monitor layouts distinct when output names collide but identities differ', () => {
    const state = normalizeWorkspaceState({
      monitorLayouts: [
        {
          outputId: 'make:model:serial-a',
          outputName: 'DP-1',
          layout: 'grid',
          params: { maxColumns: 2 },
        },
        {
          outputId: 'make:model:serial-b',
          outputName: 'DP-1',
          layout: 'columns',
          params: { maxColumns: 3 },
        },
      ],
    })

    expect(state.monitorLayouts).toEqual([
      {
        outputId: 'make:model:serial-a',
        outputName: 'DP-1',
        layout: 'grid',
        params: { maxColumns: 2 },
      },
      {
        outputId: 'make:model:serial-b',
        outputName: 'DP-1',
        layout: 'columns',
        params: { maxColumns: 3 },
      },
    ])
  })

  it('normalizes per-monitor taskbar pins without matching windows', () => {
    const state = normalizeWorkspaceState({
      groups: [{ id: 'group-1', windowIds: [1] }],
      activeTabByGroupId: { 'group-1': 1 },
      taskbarPins: [
        {
          outputId: 'make:model:serial-a',
          outputName: 'DP-1',
          pins: [
            {
              kind: 'app',
              id: 'app:org.gnome.Console.desktop',
              label: 'Console',
              command: 'kgx',
              desktopId: 'org.gnome.Console.desktop',
              appName: 'Console',
              desktopIcon: 'utilities-terminal',
            },
            {
              kind: 'app',
              id: 'app:org.gnome.Console.desktop',
              label: 'Console Duplicate',
              command: 'kgx',
            },
          ],
        },
        {
          outputId: 'make:model:serial-b',
          outputName: 'DP-1',
          pins: [
            {
              kind: 'folder',
              id: 'folder:/home/crab/Projects',
              label: 'Projects',
              path: '/home/crab/Projects',
            },
          ],
        },
      ],
    })

    expect(state.taskbarPins).toEqual([
      {
        outputId: 'make:model:serial-a',
        outputName: 'DP-1',
        pins: [
          {
            kind: 'app',
            id: 'app:org.gnome.Console.desktop',
            label: 'Console',
            command: 'kgx',
            desktopId: 'org.gnome.Console.desktop',
            appName: 'Console',
            desktopIcon: 'utilities-terminal',
          },
        ],
      },
      {
        outputId: 'make:model:serial-b',
        outputName: 'DP-1',
        pins: [
          {
            kind: 'folder',
            id: 'folder:/home/crab/Projects',
            label: 'Projects',
            path: '/home/crab/Projects',
          },
        ],
      },
    ])
  })
})
