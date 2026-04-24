import { describe, expect, it } from 'vitest'
import { applyDetail, buildWindowsMapFromList, switchVisibleWindowLocally, type DerpWindow } from './appWindowState'

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
    output_id: 'make:model:serial',
    output_name: 'HDMI-A-1',
    kind: 'native',
    x11_class: '',
    x11_instance: '',
    minimized: false,
    maximized: false,
    fullscreen: false,
    shell_flags: 0,
    capture_identifier: `capture-${window_id}`,
    workspace_visible: true,
    ...patch,
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
        {
          window_id: 1,
          surface_id: 1,
          stack_z: 1,
          x: 10,
          y: 20,
          width: 400,
          height: 300,
          title: 'window-1',
          app_id: 'app.1',
          output_id: 'make:model:serial',
          output_name: 'HDMI-A-1',
          kind: 'native',
          x11_class: '',
          x11_instance: '',
          minimized: false,
          maximized: false,
          fullscreen: false,
          shell_flags: 0,
          capture_identifier: 'capture-1',
        },
        {
          window_id: 2,
          surface_id: 2,
          stack_z: 2,
          x: 20,
          y: 40,
          width: 400,
          height: 300,
          title: 'window-2 updated',
          app_id: 'app.2',
          output_id: 'make:model:serial',
          output_name: 'HDMI-A-1',
          kind: 'native',
          x11_class: '',
          x11_instance: '',
          minimized: false,
          maximized: false,
          fullscreen: false,
          shell_flags: 0,
          capture_identifier: 'capture-2',
        },
      ],
      previous,
    )

    expect(next).not.toBe(previous)
    expect(next.get(1)).toBe(left)
    expect(next.get(2)).not.toBe(right)
    expect(next.get(2)?.title).toBe('window-2 updated')
  })

  it('adds mapped windows without churning unrelated entries', () => {
    const left = makeWindow(1)
    const right = makeWindow(2)
    const previous = new Map<number, DerpWindow>([
      [left.window_id, left],
      [right.window_id, right],
    ])

    const next = applyDetail(previous, {
      type: 'window_mapped',
      window_id: 3,
      surface_id: 30,
      x: 90,
      y: 120,
      width: 500,
      height: 320,
      title: 'window-3',
      app_id: 'app.3',
      output_name: 'HDMI-A-1',
    })

    expect(next.get(1)).toBe(left)
    expect(next.get(2)).toBe(right)
    expect(next.get(3)).toMatchObject({
      window_id: 3,
      surface_id: 30,
      width: 500,
      height: 320,
    })
  })

  it('removes unmapped windows without replacing survivors', () => {
    const left = makeWindow(1)
    const right = makeWindow(2)
    const previous = new Map<number, DerpWindow>([
      [left.window_id, left],
      [right.window_id, right],
    ])

    const next = applyDetail(previous, { type: 'window_unmapped', window_id: 2 })

    expect(next.has(2)).toBe(false)
    expect(next.get(1)).toBe(left)
  })

  it('updates geometry only for the targeted window', () => {
    const left = makeWindow(1)
    const right = makeWindow(2)
    const previous = new Map<number, DerpWindow>([
      [left.window_id, left],
      [right.window_id, right],
    ])

    const next = applyDetail(previous, {
      type: 'window_geometry',
      window_id: 2,
      surface_id: 2,
      x: 140,
      y: 160,
      width: 640,
      height: 360,
      output_name: 'DP-1',
      maximized: true,
      fullscreen: false,
    })

    expect(next.get(1)).toBe(left)
    expect(next.get(2)).not.toBe(right)
    expect(next.get(2)).toMatchObject({
      x: 140,
      y: 160,
      width: 640,
      height: 360,
      output_name: 'DP-1',
      maximized: true,
    })
  })

  it('updates metadata and minimized state incrementally', () => {
    const left = makeWindow(1)
    const right = makeWindow(2)
    const previous = new Map<number, DerpWindow>([
      [left.window_id, left],
      [right.window_id, right],
    ])

    const metadataNext = applyDetail(previous, {
      type: 'window_metadata',
      window_id: 2,
      surface_id: 2,
      title: 'renamed',
      app_id: 'app.2.renamed',
    })
    const stateNext = applyDetail(metadataNext, {
      type: 'window_state',
      window_id: 2,
      minimized: true,
    })

    expect(metadataNext.get(1)).toBe(left)
    expect(metadataNext.get(2)?.title).toBe('renamed')
    expect(stateNext.get(1)).toBe(left)
    expect(stateNext.get(2)?.minimized).toBe(true)
  })

  it('switches grouped visibility locally without churning unrelated windows', () => {
    const left = makeWindow(1)
    const hidden = makeWindow(2, { minimized: true })
    const other = makeWindow(3)
    const previous = new Map<number, DerpWindow>([
      [left.window_id, left],
      [hidden.window_id, hidden],
      [other.window_id, other],
    ])

    const next = switchVisibleWindowLocally(previous, 2, 1)

    expect(next.get(1)?.minimized).toBe(true)
    expect(next.get(2)?.minimized).toBe(false)
    expect(next.get(3)).toBe(other)
  })
})
