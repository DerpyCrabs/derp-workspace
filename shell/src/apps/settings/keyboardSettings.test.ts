import { describe, expect, it } from 'vitest'
import {
  keyboardLayoutEntriesToCsv,
  keyboardVariantEntriesToCsv,
  mergeKeyboardLayoutAndVariantCsv,
  sanitizeShellKeyboardSettings,
  sanitizeShellOskSettings,
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

  it('sanitizes osk settings', () => {
    expect(sanitizeShellOskSettings({ enabled: false, provider: 'other' })).toEqual({
      enabled: false,
      provider: 'squeekboard',
    })
    expect(sanitizeShellOskSettings(null)).toEqual({
      enabled: true,
      provider: 'squeekboard',
    })
  })
})
