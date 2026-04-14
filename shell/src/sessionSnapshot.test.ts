import { describe, expect, it } from 'vitest'
import {
  nativeWindowRef,
  sanitizeSessionSnapshot,
  shellWindowRef,
} from './sessionSnapshot'

describe('sessionSnapshot', () => {
  it('sanitizes malformed snapshots to defaults', () => {
    expect(
      sanitizeSessionSnapshot({
        version: 99,
        nextNativeWindowSeq: '3',
        workspace: {
          groups: [{ id: 'group-1', windowRefs: ['bad', shellWindowRef(9002)], activeWindowRef: 'bad' }],
          pinnedWindowRefs: ['bad', nativeWindowRef(2)],
          nextGroupSeq: '4',
        },
        shellWindows: [
          {
            windowId: 9002,
            windowRef: shellWindowRef(9002),
            kind: 'settings',
            title: 'Settings',
            appId: 'derp.settings',
            outputName: 'DP-1',
            bounds: { x: 1, y: 2, width: 300, height: 200 },
            minimized: false,
            maximized: true,
            fullscreen: false,
            stackZ: 9,
            state: { ok: true },
          },
        ],
        nativeWindows: [
          {
            windowRef: nativeWindowRef(2),
            title: 'Foot',
            appId: 'foot',
            outputName: 'DP-1',
            bounds: { x: 5, y: 6, width: 700, height: 500 },
            launch: { command: 'foot', desktopId: 'foot.desktop' },
          },
        ],
      }),
    ).toEqual({
      version: 1,
      nextNativeWindowSeq: 3,
      workspace: {
        groups: [{ id: 'group-1', windowRefs: [shellWindowRef(9002)], activeWindowRef: shellWindowRef(9002) }],
        pinnedWindowRefs: [nativeWindowRef(2)],
        nextGroupSeq: 4,
      },
      tilingConfig: { monitors: {} },
      monitorTiles: [],
      preTileGeometry: [],
      shellWindows: [
        {
          windowId: 9002,
          windowRef: shellWindowRef(9002),
          kind: 'settings',
          title: 'Settings',
          appId: 'derp.settings',
          outputName: 'DP-1',
          bounds: { x: 1, y: 2, width: 300, height: 200 },
          minimized: false,
          maximized: true,
          fullscreen: false,
          stackZ: 9,
          state: { ok: true },
        },
      ],
      nativeWindows: [
        {
          windowRef: nativeWindowRef(2),
          title: 'Foot',
          appId: 'foot',
          outputName: 'DP-1',
          bounds: { x: 5, y: 6, width: 700, height: 500 },
          minimized: false,
          maximized: false,
          fullscreen: false,
          launch: { command: 'foot', desktopId: 'foot.desktop', appName: null },
        },
      ],
    })
  })
})
