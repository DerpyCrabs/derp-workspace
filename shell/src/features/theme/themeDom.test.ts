import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, resolveTheme } from './themeDom'

function expectNeutralThemeTokens(tokens: Record<string, string>) {
  for (const [key, value] of Object.entries(tokens)) {
    for (const match of value.matchAll(/hsl\(\s*[-\d.]+\s+([\d.]+)%/g)) {
      expect(Number(match[1]), `${key} should be grayscale: ${value}`).toBe(0)
    }
    for (const match of value.matchAll(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/g)) {
      expect(match[1], `${key} should use neutral rgb: ${value}`).toBe(match[2])
      expect(match[2], `${key} should use neutral rgb: ${value}`).toBe(match[3])
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('themeDom', () => {
  it('resolves and applies the gray palette', () => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn().mockReturnValue({ matches: true }),
    })
    const theme = resolveTheme({ palette: 'gray', mode: 'dark' })

    expect(theme.mode).toBe('dark')
    expect(theme.tokens['shell-accent']).toBe('hsl(0 0% 68%)')
    expect(theme.tokens['shell-taskbar-bg-solid']).toBe('hsl(0 0% 11%)')
    expect(theme.tokens['shell-border']).toBe('hsl(0 0% 24% / 0.78)')
    expect(theme.tokens['shell-surface-panel']).toBe('hsl(0 0% 12% / 0.95)')
    expect(theme.tokens['shell-window-chrome-focused']).toBe('hsl(0 0% 22%)')
    expect(theme.tokens['shell-warning-bg']).toBe('hsl(0 0% 18% / 0.94)')
    expectNeutralThemeTokens(theme.tokens)
    expectNeutralThemeTokens(resolveTheme({ palette: 'gray', mode: 'light' }).tokens)

    const values = new Map<string, string>()
    const documentElement = {
      dataset: {} as Record<string, string>,
      style: {
        setProperty: (key: string, value: string) => values.set(key, value),
      },
    }
    vi.stubGlobal('document', { documentElement })

    applyTheme(theme)

    expect(documentElement.dataset.shellThemePalette).toBe('gray')
    expect(values.get('--shell-accent')).toBe('hsl(0 0% 68%)')
  })
})
