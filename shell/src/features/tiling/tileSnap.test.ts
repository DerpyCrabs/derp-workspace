import { describe, expect, it } from 'vitest'
import { shellOuterFrameFromClient } from '@/lib/exclusionRects'
import { snapZoneToBounds } from './tileZones'
import {
  monitorTileFrameAreaGlobal,
  monitorWorkAreaGlobal,
  tiledClientRectToFrameRect,
  tiledFrameRectToClientRect,
} from './tileSnap'

describe('tileSnap', () => {
  it('roundtrips tiled frame and client rects', () => {
    const frame = { x: 120, y: 40, width: 700, height: 510 }
    const client = tiledFrameRectToClientRect(frame)
    expect(tiledClientRectToFrameRect(client)).toEqual(frame)
  })

  it('keeps vertically stacked tiled outer frames touching without overlap', () => {
    const work = monitorTileFrameAreaGlobal(
      { x: 0, y: 0, width: 1920, height: 1080 },
      true,
    )
    const workRect = { x: work.x, y: work.y, width: work.w, height: work.h }
    const topFrame = snapZoneToBounds('top-left', workRect)
    const bottomFrame = snapZoneToBounds('bottom-left', workRect)
    const topOuter = shellOuterFrameFromClient({
      ...tiledFrameRectToClientRect(topFrame),
      maximized: false,
      fullscreen: false,
      minimized: false,
      snap_tiled: true,
    })
    const bottomOuter = shellOuterFrameFromClient({
      ...tiledFrameRectToClientRect(bottomFrame),
      maximized: false,
      fullscreen: false,
      minimized: false,
      snap_tiled: true,
    })
    expect(topOuter.y + topOuter.h).toBe(bottomOuter.y)
  })

  it.each([
    ['bottom', { x: 100, y: 200, w: 800, h: 556 }],
    ['top', { x: 100, y: 244, w: 800, h: 556 }],
    ['left', { x: 144, y: 200, w: 756, h: 600 }],
    ['right', { x: 100, y: 200, w: 756, h: 600 }],
  ] as const)('reserves taskbar space on the %s edge', (side, expected) => {
    expect(
      monitorTileFrameAreaGlobal(
        { x: 100, y: 200, width: 800, height: 600 },
        true,
        side,
        44,
      ),
    ).toEqual(expected)
  })

  it('uses the full monitor area when the taskbar is not reserved', () => {
    expect(
      monitorWorkAreaGlobal(
        { x: 100, y: 200, width: 800, height: 600 },
        false,
        26,
        44,
        'left',
      ),
    ).toEqual({ x: 100, y: 226, w: 800, h: 574 })
  })
})
