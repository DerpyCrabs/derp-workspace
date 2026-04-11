import { describe, expect, it } from 'vitest'
import { snapZoneAndPreviewFromAssistSpan } from './assistGrid'

describe('snapZoneAndPreviewFromAssistSpan', () => {
  const work = { x: 0, y: 28, w: 900, h: 900 }

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
