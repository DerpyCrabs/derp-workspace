import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetShellHttpReadyForTests,
  DERP_SHELL_HTTP_READY_EVENT,
  shellHttpBase,
  waitForShellHttpBase,
} from './shellHttp'

describe('shellHttpBase', () => {
  afterEach(() => {
    vi.useRealTimers()
    __resetShellHttpReadyForTests()
    vi.unstubAllGlobals()
  })

  it('prefers injected shell http base', () => {
    vi.stubGlobal('window', {
      __DERP_SHELL_HTTP: 'http://127.0.0.1:7777/',
      location: { origin: 'http://127.0.0.1:8888' },
    })
    expect(shellHttpBase()).toBe('http://127.0.0.1:7777')
  })

  it('falls back to the current localhost origin', () => {
    vi.stubGlobal('window', {
      location: { origin: 'http://127.0.0.1:5555/' },
    })
    expect(shellHttpBase()).toBe('http://127.0.0.1:5555')
  })

  it('falls back to the injected spawn url origin', () => {
    vi.stubGlobal('window', {
      __DERP_SPAWN_URL: 'http://127.0.0.1:6666/spawn',
      location: { origin: 'file://' },
    })
    expect(shellHttpBase()).toBe('http://127.0.0.1:6666')
  })

  it('rejects non-localhost origins', () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://example.com' },
    })
    expect(shellHttpBase()).toBeNull()
  })

  it('resolves readiness immediately when shell http base is already injected', async () => {
    vi.stubGlobal('window', {
      __DERP_SHELL_HTTP: 'http://127.0.0.1:7777/',
      location: { origin: 'file://' },
    })

    await expect(waitForShellHttpBase()).resolves.toBe('http://127.0.0.1:7777')
  })

  it('resolves readiness from the shell http ready event when injection is late', async () => {
    const listeners = new Map<string, EventListenerOrEventListenerObject>()
    const fakeWindow = {
      location: { origin: 'file://' },
      addEventListener: vi.fn((event: string, listener: EventListenerOrEventListenerObject) => {
        listeners.set(event, listener)
      }),
    } as unknown as Window & typeof globalThis
    vi.stubGlobal('window', fakeWindow)

    const promise = waitForShellHttpBase()
    ;(fakeWindow as typeof fakeWindow & { __DERP_SHELL_HTTP?: string }).__DERP_SHELL_HTTP =
      'http://127.0.0.1:7777/'
    const listener = listeners.get(DERP_SHELL_HTTP_READY_EVENT)
    expect(listener).toBeDefined()
    if (typeof listener === 'function') listener(new Event(DERP_SHELL_HTTP_READY_EVENT))
    else listener?.handleEvent(new Event(DERP_SHELL_HTTP_READY_EVENT))

    await expect(promise).resolves.toBe('http://127.0.0.1:7777')
  })
})
