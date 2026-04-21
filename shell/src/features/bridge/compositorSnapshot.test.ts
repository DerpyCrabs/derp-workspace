import { describe, expect, it } from 'vitest'
import { decodeCompositorSnapshot } from './compositorSnapshot'

const encoder = new TextEncoder()

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function i32(value: number): number[] {
  return u32(value >>> 0)
}

function u64(value: bigint): number[] {
  return [
    Number(value & 0xffn),
    Number((value >> 8n) & 0xffn),
    Number((value >> 16n) & 0xffn),
    Number((value >> 24n) & 0xffn),
    Number((value >> 32n) & 0xffn),
    Number((value >> 40n) & 0xffn),
    Number((value >> 48n) & 0xffn),
    Number((value >> 56n) & 0xffn),
  ]
}

function bytesForString(value: string): number[] {
  return Array.from(encoder.encode(value))
}

function frame(body: number[]): number[] {
  return [...u32(body.length), ...body]
}

describe('decodeCompositorSnapshot', () => {
  it('decodes a snapshot header and payload messages', () => {
    const outputGeometry = frame([
      ...u32(5),
      ...u32(1920),
      ...u32(1080),
      ...u32(1920),
      ...u32(1080),
    ])

    const title = bytesForString('Terminal')
    const appId = bytesForString('foot')
    const outputName = bytesForString('HDMI-A-1')
    const captureIdentifier = bytesForString('cap-1')
    const windowList = frame([
      ...u32(11),
      ...u32(1),
      ...u32(9),
      ...u32(10),
      ...u32(9),
      ...i32(20),
      ...i32(30),
      ...i32(800),
      ...i32(600),
      ...u32(0),
      ...u32(0),
      ...u32(0),
      ...u32(1),
      ...u32(0),
      ...u32(title.length),
      ...u32(appId.length),
      ...title,
      ...appId,
      ...u32(outputName.length),
      ...outputName,
      ...u32(captureIdentifier.length),
      ...captureIdentifier,
    ])

    const focusChanged = frame([...u32(10), ...u32(10), ...u32(9)])

    const payload = [...outputGeometry, ...windowList, ...focusChanged]
    const bytes = new Uint8Array([
      ...u32(0x44525053),
      ...u32(2),
      ...u32(payload.length),
      ...u32(0),
      ...u64(2n),
      ...u64(0n),
      ...payload,
    ])

    const decoded = decodeCompositorSnapshot(bytes.buffer)

    expect(decoded).toEqual({
      sequence: 2,
      details: [
        {
          type: 'output_geometry',
          logical_width: 1920,
          logical_height: 1080,
        },
        {
          type: 'window_list',
          windows: [
            {
              window_id: 9,
              surface_id: 10,
              stack_z: 9,
              x: 20,
              y: 30,
              width: 800,
              height: 600,
              minimized: false,
              maximized: false,
              fullscreen: false,
              client_side_decoration: true,
              shell_flags: 0,
              title: 'Terminal',
              app_id: 'foot',
              output_name: 'HDMI-A-1',
              capture_identifier: 'cap-1',
            },
          ],
        },
        {
          type: 'focus_changed',
          surface_id: 10,
          window_id: 9,
        },
      ],
    })
  })

  it('decodes compositor interaction state', () => {
    const interactionState = frame([
      ...u32(60),
      ...i32(140),
      ...i32(220),
      ...u32(9),
      ...u32(0),
    ])
    const payload = [...interactionState]
    const bytes = new Uint8Array([
      ...u32(0x44525053),
      ...u32(2),
      ...u32(payload.length),
      ...u32(0),
      ...u64(2n),
      ...u64(0n),
      ...payload,
    ])

    expect(decodeCompositorSnapshot(bytes.buffer)).toEqual({
      sequence: 2,
      details: [
        {
          type: 'interaction_state',
          pointer_x: 140,
          pointer_y: 220,
          move_window_id: 9,
          resize_window_id: null,
        },
      ],
    })
  })
})
