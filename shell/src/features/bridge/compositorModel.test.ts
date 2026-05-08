import { createRoot } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { createCompositorModel } from './compositorModel'
import type { DerpShellDetail } from '@/host/appWindowState'

function nativeWindow(windowId: number, title: string) {
  return {
    window_id: windowId,
    surface_id: windowId * 10,
    stack_z: windowId,
    x: 10,
    y: 20,
    width: 300,
    height: 200,
    minimized: false,
    maximized: false,
    fullscreen: false,
    client_side_decoration: true,
    workspace_visible: true,
    shell_flags: 0,
    title,
    app_id: `${title.toLowerCase()}.app`,
    output_id: 'output-a',
    output_name: 'DP-1',
    capture_identifier: `cap-${windowId}`,
    kind: 'native',
    x11_class: '',
    x11_instance: '',
  }
}

function emptyWorkspace() {
  return {
    groups: [],
    activeTabByGroupId: {},
    pinnedWindowIds: [],
    splitByGroupId: {},
    monitorTiles: [],
    monitorLayouts: [],
    preTileGeometry: [],
    taskbarPins: [],
    nextGroupSeq: 1,
  }
}

describe('createCompositorModel', () => {
  it('publishes authoritative snapshot window list, focus, workspace, shell app, and command palette state', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      const workspace = {
        ...emptyWorkspace(),
        groups: [{ id: 'group-1', windowIds: [7] }],
        activeTabByGroupId: { 'group-1': 7 },
        nextGroupSeq: 2,
      }
      const commandPalette = {
        revision: 3,
        categories: [{ owner: 'compositor', id: 'apps', label: 'Apps', order: 1 }],
        actions: [],
      }

      model.applyAuthoritativeSnapshotDetails([
        { type: 'window_list', revision: 1, windows: [nativeWindow(7, 'Foot')] },
        { type: 'focus_changed', surface_id: 70, window_id: 7 },
        { type: 'workspace_state', revision: 2, state: workspace },
        {
          type: 'shell_hosted_app_state',
          revision: 4,
          state: { byWindowId: { '7': { route: 'settings' } } },
        },
        { type: 'command_palette_state', revision: 5, state: commandPalette },
      ])

      expect(model.windows().get(7)).toMatchObject({ title: 'Foot', output_name: 'DP-1' })
      expect(model.windowsListIds()).toEqual([7])
      expect(model.focusedWindowId()).toBe(7)
      expect(model.workspaceSnapshot().groups).toEqual([{ id: 'group-1', windowIds: [7] }])
      expect(model.shellHostedAppByWindow()[7]).toEqual({ route: 'settings' })
      expect(model.commandPaletteState()).toBe(commandPalette)
      dispose()
    })
  })

  it('ignores partial snapshot window details when no authoritative window list is present', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      model.applyAuthoritativeSnapshotDetails([{ type: 'window_list', revision: 1, windows: [nativeWindow(7, 'Old')] }])

      model.applyAuthoritativeSnapshotDetails([
        {
          type: 'window_geometry',
          window_id: 7,
          surface_id: 70,
          x: 40,
          y: 50,
          width: 640,
          height: 480,
          output_id: 'output-b',
          output_name: 'DP-2',
          maximized: true,
          fullscreen: false,
        },
        {
          type: 'window_metadata',
          window_id: 7,
          surface_id: 70,
          title: 'New',
          app_id: 'new.app',
        },
        { type: 'window_state', window_id: 7, minimized: true },
        { type: 'window_unmapped', window_id: 7 },
      ])

      expect(model.windows().get(7)).toMatchObject({
        title: 'Old',
        x: 10,
        y: 20,
        width: 300,
        height: 200,
        minimized: false,
      })
      dispose()
    })
  })

  it('does not let snapshot window order override the authoritative window list', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()

      model.applyAuthoritativeSnapshotDetails([
        {
          type: 'window_list',
          revision: 1,
          windows: [
            { ...nativeWindow(50, 'Launcher'), stack_z: 2 },
            { ...nativeWindow(51, 'Target'), stack_z: 1 },
          ],
        },
        {
          type: 'window_order',
          revision: 3,
          windows: [
            { window_id: 50, stack_z: 2 },
            { window_id: 51, stack_z: 9 },
          ],
        },
      ])

      expect(model.windows().get(51)?.stack_z).toBe(1)
      expect(model.windowsListIds()).toEqual([50, 51])
      dispose()
    })
  })

  it('does not mutate model state from incremental compositor details', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      model.applyAuthoritativeSnapshotDetails([
        { type: 'window_list', revision: 1, windows: [nativeWindow(7, 'Stable')] },
        { type: 'focus_changed', surface_id: 70, window_id: 7 },
        { type: 'workspace_state', revision: 1, state: emptyWorkspace() },
      ])
      const beforeWindow = model.windows().get(7)
      const beforeWorkspace = model.workspaceSnapshot()

      const details: DerpShellDetail[] = [
        { type: 'focus_changed', surface_id: 80, window_id: 8 },
        { type: 'window_mapped', ...nativeWindow(8, 'Mapped') },
        {
          type: 'window_geometry',
          window_id: 7,
          surface_id: 70,
          x: 80,
          y: 90,
          width: 900,
          height: 700,
          output_name: 'DP-2',
          maximized: true,
          fullscreen: false,
        },
        { type: 'window_metadata', window_id: 7, surface_id: 70, title: 'Renamed', app_id: 'renamed.app' },
        { type: 'window_state', window_id: 7, minimized: true },
        { type: 'window_unmapped', window_id: 7 },
        { type: 'window_order', revision: 2, windows: [{ window_id: 7, stack_z: 99 }] },
        {
          type: 'workspace_state',
          revision: 2,
          state: { ...emptyWorkspace(), pinnedWindowIds: [7] },
        },
      ]
      const results = model.applyIncrementalWakeupDetails(details)

      expect(results).toHaveLength(details.length)
      expect(results.every((result) => result.kind === 'ignored')).toBe(true)
      expect(model.windows().get(7)).toBe(beforeWindow)
      expect(model.windows().has(8)).toBe(false)
      expect(model.focusedWindowId()).toBe(7)
      expect(model.workspaceSnapshot()).toBe(beforeWorkspace)
      expect(model.windowsListIds()).toEqual([7])
      dispose()
    })
  })

  it('keeps per-window accessors live and stable across snapshot replacement', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      model.applyAuthoritativeSnapshotDetails([{ type: 'window_list', revision: 1, windows: [nativeWindow(7, 'Old')] }])
      const accessor = model.windowById(7)

      model.applyAuthoritativeSnapshotDetails([{ type: 'window_list', revision: 2, windows: [nativeWindow(7, 'New')] }])

      expect(model.windowById(7)).toBe(accessor)
      expect(accessor()?.title).toBe('New')
      dispose()
    })
  })
})
