import { describe, expect, it } from 'vitest'
import {
  keyboardLayoutEntriesToCsv,
  keyboardVariantEntriesToCsv,
  mergeKeyboardLayoutAndVariantCsv,
  sanitizeShellKeyboardSettings,
} from './keyboardSettings'

describe('keyboardSettings', () => {
  it('sanitizes malformed payloads', () => {
    expect(
      sanitizeShellKeyboardSettings({
        layouts: [{ layout: 'us', variant: '' }, { layout: '' }, { layout: 'de', variant: 'nodeadkeys' }],
        repeat_rate: 999,
        repeat_delay_ms: 10,
      }),
    ).toEqual({
      layouts: [
        { layout: 'us', variant: '' },
        { layout: 'de', variant: 'nodeadkeys' },
      ],
      repeat_rate: 60,
      repeat_delay_ms: 100,
    })
  })

  it('round trips layout and variant csv helpers', () => {
    const layouts = mergeKeyboardLayoutAndVariantCsv('us, de', ', nodeadkeys')
    expect(layouts).toEqual([
      { layout: 'us', variant: '' },
      { layout: 'de', variant: 'nodeadkeys' },
    ])
    expect(keyboardLayoutEntriesToCsv(layouts)).toBe('us, de')
    expect(keyboardVariantEntriesToCsv(layouts)).toBe(', nodeadkeys')
  })
})
