import { describe, expect, it } from 'vitest'
import { normalizeHexColor, solidRgbaToHex } from './appearanceBackground'
import { sanitizeCursorSettings } from './appearanceCursor'

describe('SettingsAppearancePage color helpers', () => {
  it('normalizes valid solid colors', () => {
    expect(normalizeHexColor('#ABCDEF')).toBe('#abcdef')
    expect(normalizeHexColor('334455')).toBe('#334455')
    expect(normalizeHexColor('  "#1a2b3c"  ')).toBe('#1a2b3c')
  })

  it('rejects invalid solid colors', () => {
    expect(normalizeHexColor('#abc')).toBeNull()
    expect(normalizeHexColor('zzzzzz')).toBeNull()
    expect(normalizeHexColor('')).toBeNull()
  })

  it('converts rgba floats into hex colors', () => {
    expect(solidRgbaToHex([0.1, 0.1, 0.1, 1])).toBe('#1a1a1a')
    expect(solidRgbaToHex([1, 0.5, 0, 1])).toBe('#ff8000')
    expect(solidRgbaToHex([2, -1, Number.NaN, 1])).toBe('#ff0000')
  })

  it('sanitizes cursor settings', () => {
    expect(sanitizeCursorSettings({ theme: ' Adwaita ', size: 4 })).toEqual({ theme: 'Adwaita', size: 8 })
    expect(sanitizeCursorSettings({ theme: '', size: 999 })).toEqual({ theme: 'default', size: 128 })
    expect(sanitizeCursorSettings(null)).toEqual({ theme: 'default', size: 24 })
  })
})
