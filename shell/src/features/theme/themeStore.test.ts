import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetThemeStoreForTests,
  getThemeSettings,
  parseThemeSettingsResponse,
  refreshThemeSettingsFromRemote,
  resolveThemeMode,
  setTheme,
  subscribeThemeStore,
} from './themeStore'

afterEach(() => {
  __resetThemeStoreForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('themeStore', () => {
  it('loads persisted settings from shell http and notifies listeners on update', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ palette: 'caffeine', mode: 'light' })),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('{"ok":true}'),
      })

    vi.stubGlobal('window', {
      __DERP_SHELL_HTTP: 'http://127.0.0.1:7777',
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(getThemeSettings()).toEqual({ palette: 'default', mode: 'system' })
    await refreshThemeSettingsFromRemote()
    expect(getThemeSettings()).toEqual({ palette: 'caffeine', mode: 'light' })

    const listener = vi.fn()
    const unsubscribe = subscribeThemeStore(listener)
    setTheme('cosmic-night', 'dark')

    expect(listener).toHaveBeenCalledWith({ palette: 'cosmic-night', mode: 'dark' })
    await Promise.resolve()
    expect(fetchMock).toHaveBeenLastCalledWith('http://127.0.0.1:7777/settings_theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palette: 'cosmic-night', mode: 'dark' }),
    })

    unsubscribe()
  })

  it('parses malformed payloads as defaults', () => {
    expect(parseThemeSettingsResponse('not json')).toEqual({ palette: 'default', mode: 'system' })
    expect(parseThemeSettingsResponse('{"palette":"bad","mode":"oops"}')).toEqual({
      palette: 'default',
      mode: 'system',
    })
  })

  it('waits for shell http injection before loading persisted settings', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({ palette: 'caffeine', mode: 'dark' })),
    })

    const fakeWindow = {
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
    } as unknown as Window & typeof globalThis

    vi.stubGlobal('window', fakeWindow)
    vi.stubGlobal('fetch', fetchMock)

    const refreshPromise = refreshThemeSettingsFromRemote()
    expect(getThemeSettings()).toEqual({ palette: 'default', mode: 'system' })

    setTimeout(() => {
      ;(fakeWindow as typeof fakeWindow & { __DERP_SHELL_HTTP?: string }).__DERP_SHELL_HTTP = 'http://127.0.0.1:7777'
    }, 75)

    await vi.advanceTimersByTimeAsync(100)
    await refreshPromise

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:7777/settings_theme')
    expect(getThemeSettings()).toEqual({ palette: 'caffeine', mode: 'dark' })
  })

  it('resolves system mode from the platform preference', () => {
    expect(resolveThemeMode('system', true)).toBe('dark')
    expect(resolveThemeMode('system', false)).toBe('light')
    expect(resolveThemeMode('dark', false)).toBe('dark')
  })
})
