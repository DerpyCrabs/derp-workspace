import { createRoot } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { createCompositorModel } from './compositorModel'

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

describe('createCompositorModel', () => {
  it('applies snapshot window detail chunks as one authoritative window update', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      model.applyCompositorSnapshot([
        {
          type: 'window_list',
          revision: 1,
          windows: [
            {
              window_id: 7,
              surface_id: 70,
              stack_z: 1,
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
              title: 'Old',
              app_id: 'old.app',
              output_id: 'output-a',
              output_name: 'DP-1',
              capture_identifier: 'cap',
              kind: 'native',
              x11_class: '',
              x11_instance: '',
            },
          ],
        },
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
        {
          type: 'window_state',
          window_id: 7,
          minimized: true,
        },
      ])

      expect(model.windows().get(7)).toMatchObject({
        x: 40,
        y: 50,
        width: 640,
        height: 480,
        output_id: 'output-b',
        output_name: 'DP-2',
        maximized: true,
        title: 'New',
        app_id: 'new.app',
        minimized: true,
      })
      dispose()
    })
  })

  it('keeps workspace window projection stable for geometry-only updates', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      model.applyCompositorDetail(
        {
          type: 'window_mapped',
          window_id: 7,
          surface_id: 70,
          stack_z: 1,
          x: 10,
          y: 20,
          width: 300,
          height: 200,
          minimized: false,
          maximized: false,
          fullscreen: false,
          title: 'Stable',
          app_id: 'stable.app',
          output_id: 'output-a',
          output_name: 'DP-1',
          workspace_visible: true,
        },
        { fallbackMonitorKey: () => 'DP-1', requestWindowSyncRecovery: () => {} },
      )
      const before = model.workspaceWindowsMap().get(7)
      model.applyCompositorDetail(
        {
          type: 'window_geometry',
          window_id: 7,
          surface_id: 70,
          x: 40,
          y: 50,
          width: 640,
          height: 480,
          output_id: 'output-a',
          output_name: 'DP-1',
          maximized: false,
          fullscreen: false,
        },
        { fallbackMonitorKey: () => 'DP-1', requestWindowSyncRecovery: () => {} },
      )

      expect(model.windows().get(7)).toMatchObject({ x: 40, y: 50, width: 640, height: 480 })
      expect(model.workspaceWindowsMap().get(7)).toBe(before)
      dispose()
    })
  })

  it('keeps unrelated per-window accessors stable during geometry updates', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      model.applyCompositorSnapshot([
        {
          type: 'window_list',
          revision: 1,
          windows: [
            {
              window_id: 7,
              surface_id: 70,
              stack_z: 1,
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
              title: 'Moved',
              app_id: 'moved.app',
              output_id: 'output-a',
              output_name: 'DP-1',
              capture_identifier: 'cap-a',
              kind: 'native',
              x11_class: '',
              x11_instance: '',
            },
            {
              window_id: 8,
              surface_id: 80,
              stack_z: 2,
              x: 400,
              y: 20,
              width: 300,
              height: 200,
              minimized: false,
              maximized: false,
              fullscreen: false,
              client_side_decoration: true,
              workspace_visible: true,
              shell_flags: 0,
              title: 'Stable',
              app_id: 'stable.app',
              output_id: 'output-a',
              output_name: 'DP-1',
              capture_identifier: 'cap-b',
              kind: 'native',
              x11_class: '',
              x11_instance: '',
            },
          ],
        },
      ])
      const moved = model.windowById(7)
      const stable = model.windowById(8)
      const stableBefore = stable()
      model.applyCompositorDetail(
        {
          type: 'window_geometry',
          window_id: 7,
          surface_id: 70,
          x: 40,
          y: 50,
          width: 640,
          height: 480,
          output_id: 'output-a',
          output_name: 'DP-1',
          maximized: false,
          fullscreen: false,
        },
        { fallbackMonitorKey: () => 'DP-1', requestWindowSyncRecovery: () => {} },
      )

      expect(moved()).toMatchObject({ x: 40, y: 50, width: 640, height: 480 })
      expect(stable()).toBe(stableBefore)
      dispose()
    })
  })

  it('applies incremental detail batches against one evolving window map', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      model.applyCompositorDetails(
        [
          {
            type: 'window_mapped',
            window_id: 7,
            surface_id: 70,
            stack_z: 1,
            x: 10,
            y: 20,
            width: 300,
            height: 200,
            minimized: false,
            maximized: false,
            fullscreen: false,
            title: 'Batch',
            app_id: 'batch.app',
            output_id: 'output-a',
            output_name: 'DP-1',
            workspace_visible: true,
          },
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
            title: 'Batch Updated',
            app_id: 'batch.updated',
          },
          {
            type: 'focus_changed',
            surface_id: 70,
            window_id: 7,
          },
        ],
        { fallbackMonitorKey: () => 'DP-1', requestWindowSyncRecovery: () => {} },
      )

      expect(model.windows().get(7)).toMatchObject({
        x: 40,
        y: 50,
        width: 640,
        height: 480,
        output_id: 'output-b',
        output_name: 'DP-2',
        maximized: true,
        title: 'Batch Updated',
        app_id: 'batch.updated',
      })
      expect(model.focusedWindowId()).toBe(7)
      dispose()
    })
  })

  it('evicts unmapped per-window accessors instead of reusing stale signals', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      let previousAccessor: ReturnType<typeof model.windowById> | null = null
      const oldAccessors: ReturnType<typeof model.windowById>[] = []

      for (let revision = 1; revision <= 5; revision += 1) {
        model.applyCompositorSnapshot([
          {
            type: 'window_list',
            revision,
            windows: [nativeWindow(7, `Window ${revision}`)],
          },
        ])
        const accessor = model.windowById(7)
        if (previousAccessor) expect(accessor).not.toBe(previousAccessor)
        expect(accessor()?.title).toBe(`Window ${revision}`)
        model.applyCompositorDetail(
          {
            type: 'window_unmapped',
            window_id: 7,
          },
          { fallbackMonitorKey: () => 'DP-1', requestWindowSyncRecovery: () => {} },
        )
        expect(accessor()).toBeUndefined()
        oldAccessors.push(accessor)
        previousAccessor = accessor
      }

      model.applyCompositorSnapshot([
        {
          type: 'window_list',
          revision: 6,
          windows: [nativeWindow(7, 'Window 6')],
        },
      ])
      const latest = model.windowById(7)
      expect(latest()?.title).toBe('Window 6')
      for (const accessor of oldAccessors) {
        expect(accessor()).toBeUndefined()
        expect(accessor).not.toBe(latest)
      }
      dispose()
    })
  })
})
