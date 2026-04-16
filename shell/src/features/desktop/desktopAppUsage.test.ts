import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetDesktopAppUsageForTests,
  desktopAppUsageKey,
  getDesktopAppUsageCounts,
  parseDesktopAppUsageResponse,
  refreshDesktopAppUsageFromRemote,
  recordDesktopAppLaunch,
} from './desktopAppUsage'
import type { DesktopAppEntry } from '@/features/bridge/shellBridge'

const firefox: DesktopAppEntry = {
  name: 'Firefox Web Browser',
  exec: 'firefox %u',
  executable: 'firefox',
  generic_name: 'Web Browser',
  keywords: ['browser', 'web', 'internet'],
  terminal: false,
  desktop_id: 'firefox.desktop',
}

afterEach(() => {
  __resetDesktopAppUsageForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('desktopAppUsage', () => {
  it('loads persisted usage from shell http', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({ 'firefox.desktop': 3, broken: -1 })),
    })

    vi.stubGlobal('window', {
      __DERP_SHELL_HTTP: 'http://127.0.0.1:7777',
    })
    vi.stubGlobal('fetch', fetchMock)

    await refreshDesktopAppUsageFromRemote()

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:7777/desktop_app_usage')
    expect(getDesktopAppUsageCounts()).toEqual({ 'firefox.desktop': 3 })
  })

  it('increments local usage and posts launches to shell http', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('{"ok":true}'),
    })

    vi.stubGlobal('window', {
      __DERP_SHELL_HTTP: 'http://127.0.0.1:7777',
    })
    vi.stubGlobal('fetch', fetchMock)

    const next = recordDesktopAppLaunch(firefox)

    expect(next).toEqual({ [desktopAppUsageKey(firefox)]: 1 })
    await Promise.resolve()
    expect(fetchMock).toHaveBeenLastCalledWith('http://127.0.0.1:7777/desktop_app_usage_launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'firefox.desktop' }),
    })
  })

  it('parses malformed payloads as defaults', () => {
    expect(parseDesktopAppUsageResponse('not json')).toEqual({})
    expect(parseDesktopAppUsageResponse('{"ok":2,"bad":-1,"weird":"x"}')).toEqual({ ok: 2 })
  })

  it('waits for shell http injection before flushing queued launches', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({})),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('{"ok":true}'),
      })

    const fakeWindow = {} as Window & typeof globalThis

    vi.stubGlobal('window', fakeWindow)
    vi.stubGlobal('fetch', fetchMock)

    expect(recordDesktopAppLaunch(firefox)).toEqual({ [desktopAppUsageKey(firefox)]: 1 })

    const refreshPromise = refreshDesktopAppUsageFromRemote()
    setTimeout(() => {
      ;(fakeWindow as typeof fakeWindow & { __DERP_SHELL_HTTP?: string }).__DERP_SHELL_HTTP =
        'http://127.0.0.1:7777'
    }, 75)

    await vi.advanceTimersByTimeAsync(150)
    await refreshPromise
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:7777/desktop_app_usage')
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:7777/desktop_app_usage_launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'firefox.desktop' }),
    })
  })
})
