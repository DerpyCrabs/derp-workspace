import { describe, expect, it } from 'vitest'
import { fitContextMenuClientPosition } from './contextMenu'

describe('fitContextMenuClientPosition', () => {
  it('opens upward when the anchor is close to the bottom edge', () => {
    expect(
      fitContextMenuClientPosition(
        { x: 760, y: 780, alignAboveY: 760 },
        192,
        220,
        { x: 0, y: 0, w: 800, h: 800 },
      ),
    ).toEqual({
      left: 604,
      top: 540,
      maxHeight: 756,
      opensAbove: true,
    })
  })

  it('keeps the menu below when there is room on screen', () => {
    expect(
      fitContextMenuClientPosition(
        { x: 32, y: 40, alignAboveY: 20 },
        192,
        120,
        { x: 0, y: 0, w: 800, h: 800 },
      ),
    ).toEqual({
      left: 32,
      top: 40,
      maxHeight: 756,
      opensAbove: false,
    })
  })

  it('uses the containing monitor bounds instead of the full virtual desktop', () => {
    expect(
      fitContextMenuClientPosition(
        { x: 1500, y: 780, alignAboveY: 760 },
        260,
        180,
        { x: 800, y: 0, w: 800, h: 800 },
      ),
    ).toEqual({
      left: 1336,
      top: 580,
      maxHeight: 756,
      opensAbove: true,
    })
  })

  it('caps very tall menus to the space above the anchor', () => {
    expect(
      fitContextMenuClientPosition(
        { x: 760, y: 780, alignAboveY: 760 },
        192,
        900,
        { x: 0, y: 0, w: 800, h: 800 },
      ),
    ).toEqual({
      left: 604,
      top: 4,
      maxHeight: 756,
      opensAbove: true,
    })
  })
})
