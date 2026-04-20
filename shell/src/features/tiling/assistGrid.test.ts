import { describe, expect, it } from 'vitest'
import { snapZoneAndPreviewFromAssistSpan } from './assistGrid'

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
})
