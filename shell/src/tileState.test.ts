import { describe, expect, it } from 'vitest'
import {
  computeTiledResizeRects,
  findEdgeNeighborsInMap,
  TILED_RESIZE_MIN_H,
  TILED_RESIZE_MIN_W,
} from './tileState'

describe('findEdgeNeighborsInMap', () => {
  it('finds aligned neighbors on a shared edge', () => {
    const rects = new Map([
      [1, { x: 0, y: 0, width: 500, height: 400 }],
      [2, { x: 500, y: 0, width: 500, height: 400 }],
      [3, { x: 0, y: 410, width: 500, height: 390 }],
    ])

    expect(findEdgeNeighborsInMap(rects, 1, 'right', 12)).toEqual([2])
    expect(findEdgeNeighborsInMap(rects, 1, 'bottom', 12)).toEqual([3])
  })
})

describe('computeTiledResizeRects', () => {
  it('resizes both sides of a tiled split', () => {
    const rects = new Map([
      [1, { x: 0, y: 0, width: 500, height: 500 }],
      [2, { x: 500, y: 0, width: 500, height: 500 }],
    ])

    const next = computeTiledResizeRects(1, 8, 120, 0, rects, TILED_RESIZE_MIN_W, TILED_RESIZE_MIN_H)

    expect(next.get(1)).toEqual({ x: 0, y: 0, width: 620, height: 500 })
    expect(next.get(2)).toEqual({ x: 620, y: 0, width: 380, height: 500 })
  })

  it('respects the minimum width of neighbors', () => {
    const rects = new Map([
      [1, { x: 0, y: 0, width: 500, height: 500 }],
      [2, { x: 500, y: 0, width: 240, height: 500 }],
    ])

    const next = computeTiledResizeRects(1, 8, 200, 0, rects, 200, 150)

    expect(next.get(1)).toEqual({ x: 0, y: 0, width: 540, height: 500 })
    expect(next.get(2)).toEqual({ x: 540, y: 0, width: 200, height: 500 })
  })
})
