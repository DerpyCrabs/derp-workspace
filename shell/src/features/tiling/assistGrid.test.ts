import { describe, expect, it } from 'vitest'
import { snapZoneAndPreviewFromAssistSpan, snapZoneFromEdgePointer } from './assistGrid'

describe('snapZoneAndPreviewFromAssistSpan', () => {
  const work = { x: 0, y: 28, w: 900, h: 900 }

  it('maps a 3x2 left two-column full-height span to left two-thirds', () => {
    const result = snapZoneAndPreviewFromAssistSpan(
      {
        gridCols: 3,
        gridRows: 2,
        gc0: 0,
        gc1: 1,
        gr0: 0,
        gr1: 1,
      },
      '3x2',
      work,
    )

    expect(result.zone).toBe('left-two-thirds')
  })

  it('maps a 3x2 right two-column full-height span to right two-thirds', () => {
    const result = snapZoneAndPreviewFromAssistSpan(
      {
        gridCols: 3,
        gridRows: 2,
        gc0: 1,
        gc1: 2,
        gr0: 0,
        gr1: 1,
      },
      '3x2',
      work,
    )

    expect(result.zone).toBe('right-two-thirds')
  })

  it('maps a 3x3 top two-thirds column span to the dedicated zone', () => {
    const result = snapZoneAndPreviewFromAssistSpan(
      {
        gridCols: 3,
        gridRows: 3,
        gc0: 0,
        gc1: 0,
        gr0: 0,
        gr1: 1,
      },
      '3x3',
      work,
    )

    expect(result.zone).toBe('top-left-two-thirds')
  })

  it('keeps a full 3x3 column span mapped to the full-height third zone', () => {
    const result = snapZoneAndPreviewFromAssistSpan(
      {
        gridCols: 3,
        gridRows: 3,
        gc0: 0,
        gc1: 0,
        gr0: 0,
        gr1: 2,
      },
      '3x3',
      work,
    )

    expect(result.zone).toBe('left-third')
  })

  it('maps 2x2 top edge pointer to half-width edge zones', () => {
    const result = snapZoneFromEdgePointer(700, 32, '2x2', work, false, false, true, false)

    expect(result).toBe('top-right')
  })

  it('maps 3x2 left edge pointer to full-height third zone', () => {
    const result = snapZoneFromEdgePointer(4, 420, '3x2', work, true, false, false, false)

    expect(result).toBe('left-third')
  })

  it('maps 3x2 top edge pointer to top-center third zone', () => {
    const result = snapZoneFromEdgePointer(450, 32, '3x2', work, false, false, true, false)

    expect(result).toBe('top-center-third')
  })

  it('maps 2x3 corner pointer to nearest corner zone', () => {
    const result = snapZoneFromEdgePointer(4, 32, '2x3', work, true, false, true, false)

    expect(result).toBe('top-left')
  })
})
