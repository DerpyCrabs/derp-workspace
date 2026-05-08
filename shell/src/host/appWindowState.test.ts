import { describe, expect, it } from 'vitest'
import { buildWindowsMapFromList, type DerpWindow } from './appWindowState'

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
    icon_name: '',
    icon_buffers: [],
    output_id: 'make:model:serial',
    output_name: 'HDMI-A-1',
    kind: 'native',
    x11_class: '',
    x11_instance: '',
    minimized: false,
    maximized: false,
    fullscreen: false,
    client_side_decoration: false,
    shell_flags: 0,
    capture_identifier: `capture-${window_id}`,
    workspace_visible: true,
    ...patch,
  }
}

function row(window: DerpWindow) {
  return {
    window_id: window.window_id,
    surface_id: window.surface_id,
    stack_z: window.stack_z,
    x: window.x,
    y: window.y,
    width: window.width,
    height: window.height,
    title: window.title,
    app_id: window.app_id,
    icon_name: window.icon_name,
    icon_buffers: window.icon_buffers,
    output_id: window.output_id,
    output_name: window.output_name,
    kind: window.kind,
    x11_class: window.x11_class,
    x11_instance: window.x11_instance,
    minimized: window.minimized,
    maximized: window.maximized,
    fullscreen: window.fullscreen,
    client_side_decoration: window.client_side_decoration,
    shell_flags: window.shell_flags,
    capture_identifier: window.capture_identifier,
    workspace_visible: window.workspace_visible,
  }
}

describe('appWindowState', () => {
  it('reuses unchanged entries during full window-list sync', () => {
    const left = makeWindow(1)
    const right = makeWindow(2)
    const previous = new Map<number, DerpWindow>([
      [left.window_id, left],
      [right.window_id, right],
    ])

    const next = buildWindowsMapFromList(
      [
        row(left),
        {
          ...row(right),
          title: 'window-2 updated',
        },
      ],
      previous,
    )

    expect(next).not.toBe(previous)
    expect(next.get(1)).toBe(left)
    expect(next.get(2)).not.toBe(right)
    expect(next.get(2)?.title).toBe('window-2 updated')
  })

  it('reuses the previous map when every authoritative row is unchanged', () => {
    const left = makeWindow(1)
    const right = makeWindow(2)
    const previous = new Map<number, DerpWindow>([
      [left.window_id, left],
      [right.window_id, right],
    ])

    const next = buildWindowsMapFromList([row(left), row(right)], previous)

    expect(next).toBe(previous)
  })

  it('removes rows omitted from the authoritative window list', () => {
    const left = makeWindow(1)
    const right = makeWindow(2)
    const previous = new Map<number, DerpWindow>([
      [left.window_id, left],
      [right.window_id, right],
    ])

    const next = buildWindowsMapFromList([row(left)], previous)

    expect(next).not.toBe(previous)
    expect(next.get(1)).toBe(left)
    expect(next.has(2)).toBe(false)
  })

  it('does not fill missing authoritative row fields from the previous window', () => {
    const previousWindow = makeWindow(1, {
      output_id: 'old-output-id',
      output_name: 'OLD-1',
      kind: 'old-kind',
      capture_identifier: 'old-capture',
      client_x: 10,
    })
    const previous = new Map<number, DerpWindow>([[previousWindow.window_id, previousWindow]])

    const next = buildWindowsMapFromList(
      [
        {
          window_id: 1,
          surface_id: 1,
          x: 2,
          y: 3,
          width: 4,
          height: 5,
        },
      ],
      previous,
    )

    expect(next.get(1)).toMatchObject({
      output_id: '',
      output_name: '',
      kind: '',
      capture_identifier: '',
    })
    expect(next.get(1)?.client_x).toBeUndefined()
  })
})
