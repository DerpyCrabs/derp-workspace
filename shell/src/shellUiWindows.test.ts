import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('shellUiWindows', () => {
  it('skips redundant shell-ui window payloads', async () => {
    const send = vi.fn()
    vi.stubGlobal('window', { __derpShellWireSend: send })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const mod = await import('./shellUiWindows')
    const unregister = mod.registerShellUiWindow(7, () => ({
      id: 7,
      z: 2,
      gx: 10,
      gy: 20,
      gw: 300,
      gh: 200,
    }))

    mod.flushShellUiWindowsSyncNow()
    mod.flushShellUiWindowsSyncNow()
    expect(send).toHaveBeenCalledTimes(1)

    unregister()
    mod.flushShellUiWindowsSyncNow()
    expect(send).toHaveBeenCalledTimes(2)
  })
})
