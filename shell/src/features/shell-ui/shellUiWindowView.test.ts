import { describe, expect, it } from 'vitest'
import type { DerpWindow } from '@/host/appWindowState'
import { shellUiWindowView } from '@/features/shell-ui/shellUiWindowView'

const iconBuffers: DerpWindow['icon_buffers'] = []

function windowRow(overrides: Partial<DerpWindow> = {}): DerpWindow {
  return {
    window_id: 42,
    surface_id: 7,
    stack_z: 3,
    x: 100,
    y: 200,
    width: 640,
    height: 480,
    client_x: 104,
    client_y: 232,
    client_width: 632,
    client_height: 444,
    frame_x: 96,
    frame_y: 196,
    frame_width: 648,
    frame_height: 488,
    restore_x: 90,
    restore_y: 180,
    restore_width: 600,
    restore_height: 420,
    minimized: false,
    maximized: false,
    fullscreen: false,
    client_side_decoration: false,
    workspace_visible: true,
    shell_flags: 0,
    title: 'Native',
    app_id: 'native.app',
    output_id: 'out-1',
    output_name: 'HDMI-A-1',
    capture_identifier: 'cap',
    kind: 'xdg_toplevel',
    x11_class: '',
    x11_instance: '',
    icon_name: 'app',
    icon_buffers: iconBuffers,
    ...overrides,
  }
}

describe('shellUiWindowView', () => {
  it('keeps compositor geometry out of non-shell-hosted Solid-facing windows', () => {
    const view = shellUiWindowView(windowRow())
    expect('x' in view).toBe(false)
    expect('y' in view).toBe(false)
    expect('width' in view).toBe(false)
    expect('height' in view).toBe(false)
    expect('client_x' in view).toBe(false)
    expect('client_y' in view).toBe(false)
    expect('client_width' in view).toBe(false)
    expect('client_height' in view).toBe(false)
    expect('frame_x' in view).toBe(false)
    expect('frame_y' in view).toBe(false)
    expect('frame_width' in view).toBe(false)
    expect('frame_height' in view).toBe(false)
    expect('restore_x' in view).toBe(false)
    expect('restore_y' in view).toBe(false)
    expect('restore_width' in view).toBe(false)
    expect('restore_height' in view).toBe(false)
    expect(view.output_name).toBe('HDMI-A-1')
    expect(view.title).toBe('Native')
  })

  it('keeps compositor geometry out of shell-hosted Solid-facing windows too', () => {
    const view = shellUiWindowView(windowRow({ shell_flags: 1, title: 'Shell App' }))
    expect('x' in view).toBe(false)
    expect('y' in view).toBe(false)
    expect('width' in view).toBe(false)
    expect('height' in view).toBe(false)
    expect('frame_width' in view).toBe(false)
    expect(view.title).toBe('Shell App')
    expect(view.output_name).toBe('HDMI-A-1')
  })

  it('reuses a previous native view when only compositor geometry changes', () => {
    const previous = shellUiWindowView(windowRow())
    const next = shellUiWindowView(
      windowRow({
        x: 700,
        y: 800,
        width: 900,
        height: 500,
        frame_x: 696,
        frame_y: 796,
        frame_width: 908,
        frame_height: 508,
      }),
      previous,
    )
    expect(next).toBe(previous)
  })

  it('replaces a previous native view when safe metadata changes', () => {
    const previous = shellUiWindowView(windowRow())
    const next = shellUiWindowView(windowRow({ title: 'Renamed' }), previous)
    expect(next).not.toBe(previous)
    expect(next.title).toBe('Renamed')
  })
})
