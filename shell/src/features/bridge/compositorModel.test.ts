import { createRoot } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { createCompositorModel } from './compositorModel'

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
})
