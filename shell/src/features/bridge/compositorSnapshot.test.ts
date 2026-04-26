import { describe, expect, it } from 'vitest'
import { decodeCompositorSnapshot } from './compositorSnapshot'

const encoder = new TextEncoder()
const DOMAIN_COUNT = 13

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

function domainRevisions(values: number[] = []): number[] {
  const out: number[] = []
  for (let index = 0; index < DOMAIN_COUNT; index += 1) {
    out.push(...u64(BigInt(values[index] ?? 1)))
  }
  return out
}

function expectedDomainRevisions(values: number[] = []): number[] {
  return Array.from({ length: DOMAIN_COUNT }, (_, index) => values[index] ?? 1)
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
    const outputId = bytesForString('make:model:serial')
    const outputName = bytesForString('HDMI-A-1')
    const captureIdentifier = bytesForString('cap-1')
    const kind = bytesForString('native')
    const x11Class = bytesForString('Foot')
    const x11Instance = bytesForString('foot')
    const windowList = frame([
      ...u32(11),
      ...u64(17n),
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
      ...u32(1),
      ...u32(0),
      ...u32(title.length),
      ...u32(appId.length),
      ...title,
      ...appId,
      ...u32(outputId.length),
      ...outputId,
      ...u32(outputName.length),
      ...outputName,
      ...u32(captureIdentifier.length),
      ...captureIdentifier,
      ...u32(kind.length),
      ...kind,
      ...u32(x11Class.length),
      ...x11Class,
      ...u32(x11Instance.length),
      ...x11Instance,
    ])

    const focusChanged = frame([...u32(10), ...u32(10), ...u32(9)])

    const payload = [...domainRevisions([1, 1, 1]), ...outputGeometry, ...windowList, ...focusChanged]
    const bytes = new Uint8Array([
      ...u32(0x44525053),
      ...u32(0),
      ...u32(payload.length),
      ...u32((1 << 0) | (1 << 1) | (1 << 2)),
      ...u64(2n),
      ...u64(0n),
      ...payload,
    ])

    const decoded = decodeCompositorSnapshot(bytes.buffer)

    expect(decoded).toEqual({
      sequence: 2,
      domainFlags: 7,
      domainRevisions: expectedDomainRevisions(),
      details: [
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
              workspace_visible: true,
              shell_flags: 0,
              title: 'Terminal',
              app_id: 'foot',
              output_id: 'make:model:serial',
              output_name: 'HDMI-A-1',
              capture_identifier: 'cap-1',
              kind: 'native',
              x11_class: 'Foot',
              x11_instance: 'foot',
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

  it('decodes output layout identity', () => {
    const name = bytesForString('DP-1')
    const identity = bytesForString('Framework:Display:123:340x190')
    const outputLayout = frame([
      ...u32(44),
      ...u64(23n),
      ...u32(3840),
      ...u32(2160),
      ...u32(3840),
      ...u32(2160),
      ...u32(1),
      ...u32(name.length),
      ...name,
      ...u32(identity.length),
      ...identity,
      ...i32(-1920),
      ...i32(0),
      ...u32(1920),
      ...u32(1080),
      ...u32(0),
      ...u32(60000),
      ...u32(1),
      ...u32(0),
      ...u32(name.length),
      ...name,
    ])
    const payload = [...domainRevisions([1]), ...outputLayout]
    const bytes = new Uint8Array([
      ...u32(0x44525053),
      ...u32(0),
      ...u32(payload.length),
      ...u32(0),
      ...u64(2n),
      ...u64(0n),
      ...payload,
    ])

    expect(decodeCompositorSnapshot(bytes.buffer)).toEqual({
      sequence: 2,
      domainFlags: 0,
      domainRevisions: expectedDomainRevisions(),
      details: [
        {
          type: 'output_layout',
          revision: 23,
          canvas_logical_width: 3840,
          canvas_logical_height: 2160,
          canvas_logical_origin_x: -1920,
          canvas_logical_origin_y: 0,
          canvas_physical_width: 3840,
          canvas_physical_height: 2160,
          screens: [
            {
              name: 'DP-1',
              identity: 'Framework:Display:123:340x190',
              x: -1920,
              y: 0,
              width: 1920,
              height: 1080,
              transform: 0,
              refresh_milli_hz: 60000,
              vrr_supported: true,
              vrr_enabled: false,
            },
          ],
          shell_chrome_primary: 'DP-1',
        },
      ],
    })
  })

  it('decodes window order snapshots', () => {
    const windowOrder = frame([
      ...u32(63),
      ...u64(19n),
      ...u32(2),
      ...u32(7),
      ...u32(12),
      ...u32(9),
      ...u32(13),
    ])
    const payload = [...domainRevisions([0, 0, 0, 0, 0, 0, 0, 0, 0, 2]), ...windowOrder]
    const bytes = new Uint8Array([
      ...u32(0x44525053),
      ...u32(0),
      ...u32(payload.length),
      ...u32(1 << 9),
      ...u64(2n),
      ...u64(0n),
      ...payload,
    ])

    expect(decodeCompositorSnapshot(bytes.buffer)).toEqual({
      sequence: 2,
      domainFlags: 1 << 9,
      domainRevisions: expectedDomainRevisions([0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
      details: [
        {
          type: 'window_order',
          revision: 19,
          windows: [
            { window_id: 7, stack_z: 12 },
            { window_id: 9, stack_z: 13 },
          ],
        },
      ],
    })
  })

  it('decodes hot window geometry snapshots separately from the window list', () => {
    const outputName = bytesForString('DP-1')
    const geometry = frame([
      ...u32(8),
      ...u32(7),
      ...u32(70),
      ...i32(11),
      ...i32(12),
      ...i32(640),
      ...i32(480),
      ...u32(1),
      ...u32(0),
      ...u32(1),
      ...u32(outputName.length),
      ...outputName,
    ])
    const payload = [
      ...domainRevisions([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]),
      ...geometry,
    ]
    const bytes = new Uint8Array([
      ...u32(0x44525053),
      ...u32(0),
      ...u32(payload.length),
      ...u32(1 << 10),
      ...u64(2n),
      ...u64(0n),
      ...payload,
    ])

    expect(decodeCompositorSnapshot(bytes.buffer)).toEqual({
      sequence: 2,
      domainFlags: 1 << 10,
      domainRevisions: expectedDomainRevisions([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]),
      details: [
        {
          type: 'window_geometry',
          window_id: 7,
          surface_id: 70,
          x: 11,
          y: 12,
          width: 640,
          height: 480,
          output_id: '',
          output_name: 'DP-1',
          maximized: true,
          fullscreen: false,
        },
      ],
    })
  })

  it('decodes binary workspace state without derived wire fields', () => {
    const groupId = bytesForString('group-1')
    const outputName = bytesForString('DP-1')
    const zone = bytesForString('left')
    const workspace = frame([
      ...u32(62),
      ...u64(41n),
      ...u32(1),
      ...u32(groupId.length),
      ...groupId,
      ...u32(1),
      ...u32(7),
      ...u32(1),
      ...u32(groupId.length),
      ...groupId,
      ...u32(7),
      ...u32(0),
      ...u32(0),
      ...u32(1),
      ...u32(0),
      ...u32(outputName.length),
      ...outputName,
      ...u32(1),
      ...u32(7),
      ...u32(zone.length),
      ...zone,
      ...i32(0),
      ...i32(0),
      ...i32(100),
      ...i32(200),
      ...u32(0),
      ...u32(0),
      ...u32(0),
      ...u32(2),
    ])
    const payload = [...domainRevisions([0, 0, 0, 0, 5]), ...workspace]
    const bytes = new Uint8Array([
      ...u32(0x44525053),
      ...u32(0),
      ...u32(payload.length),
      ...u32(1 << 4),
      ...u64(2n),
      ...u64(0n),
      ...payload,
    ])

    expect(decodeCompositorSnapshot(bytes.buffer)).toEqual({
      sequence: 2,
      domainFlags: 1 << 4,
      domainRevisions: expectedDomainRevisions([0, 0, 0, 0, 5]),
      details: [
        {
          type: 'workspace_state',
          revision: 41,
          state: {
            groups: [{ id: 'group-1', windowIds: [7] }],
            activeTabByGroupId: { 'group-1': 7 },
            pinnedWindowIds: [],
            splitByGroupId: {},
            monitorTiles: [
              {
                outputName: 'DP-1',
                entries: [{ windowId: 7, zone: 'left', bounds: { x: 0, y: 0, width: 100, height: 200 } }],
              },
            ],
            monitorLayouts: [],
            preTileGeometry: [],
            taskbarPins: [],
            nextGroupSeq: 2,
          },
        },
      ],
    })
  })

  it('decodes compositor interaction state', () => {
    const interactionState = frame([
      ...u32(60),
      ...u64(31n),
      ...i32(140),
      ...i32(220),
      ...u32(9),
      ...u32(0),
      ...u32(9),
      ...u32(9),
      ...i32(320),
      ...i32(480),
      ...i32(900),
      ...i32(640),
      ...u32(1),
      ...i32(0),
      ...i32(0),
      ...i32(0),
      ...i32(0),
      ...u32(0),
      ...u32(0),
    ])
    const payload = [...domainRevisions([0, 0, 0, 0, 0, 0, 1]), ...interactionState]
    const bytes = new Uint8Array([
      ...u32(0x44525053),
      ...u32(0),
      ...u32(payload.length),
      ...u32(0),
      ...u64(2n),
      ...u64(0n),
      ...payload,
    ])

    expect(decodeCompositorSnapshot(bytes.buffer)).toEqual({
      sequence: 2,
      domainFlags: 0,
      domainRevisions: expectedDomainRevisions([0, 0, 0, 0, 0, 0, 1]),
      details: [
        {
          type: 'interaction_state',
          revision: 31,
          pointer_x: 140,
          pointer_y: 220,
          move_window_id: 9,
          window_switcher_selected_window_id: null,
          resize_window_id: null,
          move_proxy_window_id: 9,
          move_capture_window_id: 9,
          move_rect: {
            x: 320,
            y: 480,
            width: 900,
            height: 640,
            maximized: true,
            fullscreen: false,
          },
          resize_rect: null,
        },
      ],
    })
  })

  it('decodes native drag preview state', () => {
    const path = bytesForString('/tmp/derp-native-drag-preview-1-9-2.png')
    const preview = frame([
      ...u32(61),
      ...u32(9),
      ...u32(2),
      ...u32(path.length),
      ...path,
    ])
    const payload = [...domainRevisions([0, 0, 0, 0, 0, 0, 0, 1]), ...preview]
    const bytes = new Uint8Array([
      ...u32(0x44525053),
      ...u32(0),
      ...u32(payload.length),
      ...u32(0),
      ...u64(2n),
      ...u64(0n),
      ...payload,
    ])

    expect(decodeCompositorSnapshot(bytes.buffer)).toEqual({
      sequence: 2,
      domainFlags: 0,
      domainRevisions: expectedDomainRevisions([0, 0, 0, 0, 0, 0, 0, 1]),
      details: [
        {
          type: 'native_drag_preview',
          window_id: 9,
          generation: 2,
          image_path: '/tmp/derp-native-drag-preview-1-9-2.png',
        },
      ],
    })
  })

  it('decodes native drag preview clear state', () => {
    const preview = frame([
      ...u32(61),
      ...u32(9),
      ...u32(3),
      ...u32(0),
    ])
    const payload = [...domainRevisions([0, 0, 0, 0, 0, 0, 0, 1]), ...preview]
    const bytes = new Uint8Array([
      ...u32(0x44525053),
      ...u32(0),
      ...u32(payload.length),
      ...u32(0),
      ...u64(2n),
      ...u64(0n),
      ...payload,
    ])

    expect(decodeCompositorSnapshot(bytes.buffer)).toEqual({
      sequence: 2,
      domainFlags: 0,
      domainRevisions: expectedDomainRevisions([0, 0, 0, 0, 0, 0, 0, 1]),
      details: [
        {
          type: 'native_drag_preview',
          window_id: 9,
          generation: 3,
          image_path: '',
        },
      ],
    })
  })
})
