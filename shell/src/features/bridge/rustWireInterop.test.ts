import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeCompositorSnapshot } from './compositorSnapshot'
import { SHELL_WINDOW_FLAG_SHELL_HOSTED } from './wireSchema.generated'

type RustWireFixture = {
  snapshot: number[]
}

function rustFixture(): RustWireFixture {
  const out = execFileSync('cargo', ['run', '--quiet', '-p', 'shell_wire', '--example', 'ts_decode_fixture'], {
    cwd: path.resolve(process.cwd(), '..'),
    encoding: 'utf8',
  })
  return JSON.parse(out) as RustWireFixture
}

function bytes(values: readonly number[]): ArrayBufferLike {
  return Uint8Array.from(values).buffer
}

describe('Rust compositor shell wire output', () => {
  it('decodes compositor snapshot packets in TypeScript', () => {
    const decoded = decodeCompositorSnapshot(bytes(rustFixture().snapshot))

    expect(decoded).not.toBeNull()
    expect(decoded?.sequence).toBe(2)
    expect(decoded?.domainRevisions.slice(0, 6)).toEqual([100, 101, 102, 103, 104, 105])
    expect(decoded?.details).toEqual([
      {
        type: 'output_geometry',
        logical_width: 1920,
        logical_height: 1080,
      },
      {
        type: 'window_list',
        revision: 17,
        windows: [
          {
            window_id: 42,
            surface_id: 84,
            stack_z: 3,
            x: 10,
            y: 20,
            width: 640,
            height: 480,
            client_x: 12,
            client_y: 24,
            client_width: 620,
            client_height: 440,
            frame_x: 8,
            frame_y: 16,
            frame_width: 648,
            frame_height: 512,
            minimized: false,
            maximized: true,
            fullscreen: false,
            client_side_decoration: true,
            workspace_visible: true,
            shell_flags: SHELL_WINDOW_FLAG_SHELL_HOSTED,
            title: 'Rust Terminal',
            app_id: 'foot',
            output_id: 'dp-1-id',
            output_name: 'DP-1',
            capture_identifier: 'capture-42',
            kind: 'native',
            x11_class: 'Foot',
            x11_instance: 'foot',
            icon_name: 'utilities-terminal',
            icon_buffers: [{ width: 32, height: 32, scale: 1 }],
          },
        ],
      },
      {
        type: 'window_order',
        revision: 18,
        windows: [{ window_id: 42, stack_z: 3 }],
      },
      {
        type: 'focus_changed',
        surface_id: 84,
        window_id: 42,
      },
      {
        type: 'keyboard_layout',
        label: 'us',
      },
      {
        type: 'interaction_state',
        revision: 19,
        interaction_serial: 20,
        pointer_x: 101,
        pointer_y: 202,
        move_window_id: 42,
        resize_window_id: null,
        move_proxy_window_id: 43,
        move_capture_window_id: 44,
        move_rect: {
          x: 90,
          y: 100,
          width: 320,
          height: 240,
          maximized: true,
          fullscreen: false,
        },
        resize_rect: null,
        window_switcher_selected_window_id: 42,
      },
    ])
  })
})
