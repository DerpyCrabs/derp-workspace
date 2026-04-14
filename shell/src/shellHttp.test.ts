import { afterEach, describe, expect, it, vi } from 'vitest'
import { shellHttpBase } from './shellHttp'

describe('shellHttpBase', () => {
  afterEach(() => {
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
})
