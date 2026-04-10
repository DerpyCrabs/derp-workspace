import { describe, expect, it } from 'vitest'
import { mergeExclusionRects } from './exclusionRects'

describe('mergeExclusionRects', () => {
  it('merges touching rects with the same horizontal span', () => {
    expect(
      mergeExclusionRects([
        { x: 0, y: 0, w: 100, h: 10 },
        { x: 0, y: 10, w: 100, h: 8 },
      ]),
    ).toEqual([{ x: 0, y: 0, w: 100, h: 18 }])
  })

  it('merges touching rects with the same vertical span', () => {
    expect(
      mergeExclusionRects([
        { x: 0, y: 0, w: 20, h: 40, window_id: 7 },
        { x: 20, y: 0, w: 15, h: 40, window_id: 7 },
      ]),
    ).toEqual([{ x: 0, y: 0, w: 35, h: 40, window_id: 7 }])
  })

  it('does not merge across window buckets or L shapes', () => {
    expect(
      mergeExclusionRects([
        { x: 0, y: 0, w: 100, h: 10, window_id: 5 },
        { x: 0, y: 10, w: 2, h: 90, window_id: 5 },
        { x: 0, y: 0, w: 100, h: 10, window_id: 6 },
      ]),
    ).toEqual([
      { x: 0, y: 0, w: 100, h: 10, window_id: 5 },
      { x: 0, y: 10, w: 2, h: 90, window_id: 5 },
      { x: 0, y: 0, w: 100, h: 10, window_id: 6 },
    ])
  })
})
