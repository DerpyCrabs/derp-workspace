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
  it('applies snapshot window detail chunks when the snapshot omits an authoritative window list', () => {
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
      ])
      model.applyCompositorSnapshot([
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

  it('keeps snapshot window list rows authoritative over duplicate geometry chunks', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      model.applyCompositorSnapshot([
        {
          type: 'window_list',
          revision: 1,
          windows: [
            {
              ...nativeWindow(7, 'Maximized'),
              x: 1280,
              y: 26,
              width: 1920,
              height: 1218,
              maximized: true,
            },
          ],
        },
        {
          type: 'window_geometry',
          window_id: 7,
          surface_id: 70,
          x: 1280,
          y: 26,
          width: 700,
          height: 491,
          output_id: 'output-a',
          output_name: 'DP-1',
          maximized: true,
          fullscreen: false,
        },
      ])

      expect(model.windows().get(7)).toMatchObject({
        x: 1280,
        y: 26,
        width: 1920,
        height: 1218,
        maximized: true,
      })
      dispose()
    })
  })

  it('keeps batch window list rows authoritative over duplicate geometry details', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      model.applyCompositorDetails(
        [
          {
            type: 'window_list',
            revision: 1,
            windows: [
              {
                ...nativeWindow(7, 'Maximized'),
                x: 1280,
                y: 26,
                width: 1920,
                height: 1218,
                maximized: true,
              },
            ],
          },
          {
            type: 'window_geometry',
            window_id: 7,
            surface_id: 70,
            x: 1280,
            y: 26,
            width: 700,
            height: 491,
            output_id: 'output-a',
            output_name: 'DP-1',
            maximized: true,
            fullscreen: false,
          },
        ],
        { fallbackMonitorKey: () => 'DP-1', requestWindowSyncRecovery: () => {} },
      )

      expect(model.windows().get(7)).toMatchObject({
        x: 1280,
        y: 26,
        width: 1920,
        height: 1218,
        maximized: true,
      })
      dispose()
    })
  })

  it('lets same-revision snapshot window list rows replace stale window rows', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      model.applyCompositorSnapshot([
        {
          type: 'window_list',
          revision: 12,
          windows: [
            {
              ...nativeWindow(7, 'Foot'),
              x: 1280,
              y: 26,
              width: 700,
              height: 491,
              maximized: true,
            },
          ],
        },
      ])

      model.applyCompositorSnapshot([
        {
          type: 'window_list',
          revision: 12,
          windows: [
            {
              ...nativeWindow(7, 'Foot'),
              x: 1280,
              y: 26,
              width: 1920,
              height: 1218,
              maximized: true,
            },
          ],
        },
        {
          type: 'window_geometry',
          window_id: 7,
          surface_id: 70,
          x: 1280,
          y: 26,
          width: 700,
          height: 491,
          output_id: 'output-a',
          output_name: 'DP-1',
          maximized: true,
          fullscreen: false,
        },
      ])

      expect(model.windows().get(7)).toMatchObject({
        width: 1920,
        height: 1218,
        maximized: true,
      })
      dispose()
    })
  })

  it('lets same-revision batch window list rows replace stale window rows', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      const options = { fallbackMonitorKey: () => 'DP-1', requestWindowSyncRecovery: () => {} }
      model.applyCompositorDetails(
        [
          {
            type: 'window_list',
            revision: 12,
            windows: [
              {
                ...nativeWindow(7, 'Foot'),
                x: 1280,
                y: 26,
                width: 700,
                height: 491,
                maximized: true,
              },
            ],
          },
        ],
        options,
      )

      model.applyCompositorDetails(
        [
          {
            type: 'window_list',
            revision: 12,
            windows: [
              {
                ...nativeWindow(7, 'Foot'),
                x: 1280,
                y: 26,
                width: 1920,
                height: 1218,
                maximized: true,
              },
            ],
          },
          {
            type: 'window_geometry',
            window_id: 7,
            surface_id: 70,
            x: 1280,
            y: 26,
            width: 700,
            height: 491,
            output_id: 'output-a',
            output_name: 'DP-1',
            maximized: true,
            fullscreen: false,
          },
        ],
        options,
      )

      expect(model.windows().get(7)).toMatchObject({
        width: 1920,
        height: 1218,
        maximized: true,
      })
      dispose()
    })
  })

  it('keeps snapshot window order authoritative when a window list refresh shares its revision', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      model.applyCompositorSnapshot([
        {
          type: 'window_list',
          revision: 1,
          windows: [
            { ...nativeWindow(50, 'Launcher'), stack_z: 2 },
            { ...nativeWindow(51, 'Target'), stack_z: 3 },
          ],
        },
        {
          type: 'window_order',
          revision: 3,
          windows: [
            { window_id: 50, stack_z: 2 },
            { window_id: 51, stack_z: 3 },
          ],
        },
      ])

      model.applyCompositorSnapshot([
        {
          type: 'window_list',
          revision: 2,
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
            { window_id: 51, stack_z: 3 },
          ],
        },
      ])

      expect(model.windows().get(51)?.stack_z).toBe(3)
      expect(model.windowsListIds()).toEqual([51, 50])
      dispose()
    })
  })

  it('updates focus without rewriting compositor-owned stack order', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      model.applyCompositorSnapshot([
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
            { window_id: 51, stack_z: 1 },
          ],
        },
        { type: 'focus_changed', surface_id: 510, window_id: 51 },
      ])

      expect(model.focusedWindowId()).toBe(51)
      expect(model.windows().get(51)?.stack_z).toBe(1)
      expect(model.windowsListIds()).toEqual([50, 51])
      dispose()
    })
  })

  it('lets same-revision compositor order rows correct stale window stack values', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      model.applyCompositorSnapshot([
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
          revision: 2,
          windows: [
            { window_id: 50, stack_z: 2 },
            { window_id: 51, stack_z: 1 },
          ],
        },
      ])

      model.applyCompositorDetails(
        [
          {
            type: 'window_order',
            revision: 2,
            windows: [
              { window_id: 50, stack_z: 2 },
              { window_id: 51, stack_z: 3 },
            ],
          },
        ],
        { fallbackMonitorKey: () => 'DP-1', requestWindowSyncRecovery: () => {} },
      )

      expect(model.windowById(51)()?.stack_z).toBe(3)
      expect(model.windowsListIds()).toEqual([51, 50])
      dispose()
    })
  })

  it('updates workspace window projection for geometry-only updates', () => {
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
      expect(model.workspaceWindowsMap().get(7)).not.toBe(before)
      expect(model.workspaceWindowsMap().get(7)).toMatchObject({ x: 40, y: 50, width: 640, height: 480 })
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

  it('keeps pending focus for out-of-order newly mapped windows without recovery', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      let recoveryCount = 0

      model.applyCompositorDetail(
        {
          type: 'focus_changed',
          surface_id: 70,
          window_id: 7,
        },
        {
          fallbackMonitorKey: () => 'DP-1',
          requestWindowSyncRecovery: () => {
            recoveryCount += 1
          },
        },
      )

      expect(model.focusedWindowId()).toBe(null)
      expect(recoveryCount).toBe(0)

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
          title: 'Pending Focus',
          app_id: 'pending.focus',
          output_id: 'output-a',
          output_name: 'DP-1',
          workspace_visible: true,
        },
        {
          fallbackMonitorKey: () => 'DP-1',
          requestWindowSyncRecovery: () => {
            recoveryCount += 1
          },
        },
      )

      expect(model.focusedWindowId()).toBe(7)
      expect(recoveryCount).toBe(0)
      dispose()
    })
  })

  it('keeps per-window accessors derived from the authoritative map across unmap and remap', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      let previousAccessor: ReturnType<typeof model.windowById> | null = null

      for (let revision = 1; revision <= 5; revision += 1) {
        model.applyCompositorSnapshot([
          {
            type: 'window_list',
            revision,
            windows: [nativeWindow(7, `Window ${revision}`)],
          },
        ])
        const accessor = model.windowById(7)
        if (previousAccessor) expect(accessor).toBe(previousAccessor)
        expect(accessor()?.title).toBe(`Window ${revision}`)
        model.applyCompositorDetail(
          {
            type: 'window_unmapped',
            window_id: 7,
          },
          { fallbackMonitorKey: () => 'DP-1', requestWindowSyncRecovery: () => {} },
        )
        expect(accessor()).toBeUndefined()
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
      expect(previousAccessor).toBe(latest)
      dispose()
    })
  })

  it('keeps windowById accessors live when first requested from a disposed owner', () => {
    createRoot((dispose) => {
      const model = createCompositorModel()
      model.applyCompositorSnapshot([
        {
          type: 'window_list',
          revision: 1,
          windows: [{ ...nativeWindow(7, 'Old'), stack_z: 1 }],
        },
      ])
      let accessor!: ReturnType<typeof model.windowById>
      createRoot((disposeNested) => {
        accessor = model.windowById(7)
        expect(accessor()).toMatchObject({ title: 'Old' })
        disposeNested()
      })

      model.applyCompositorDetails(
        [
          {
            type: 'window_metadata',
            window_id: 7,
            surface_id: 70,
            title: 'New',
            app_id: 'new.app',
          },
        ],
        { fallbackMonitorKey: () => 'DP-1', requestWindowSyncRecovery: () => {} },
      )

      expect(accessor()).toMatchObject({ title: 'New', app_id: 'new.app' })
      dispose()
    })
  })
})
