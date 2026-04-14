import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('shellUiWindows', () => {
  it('flushes shell-ui window payloads on the same turn', async () => {
    const send = vi.fn()
    vi.stubGlobal('window', { __derpShellWireSend: send })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const mod = await import('./shellUiWindows')
    mod.registerShellUiWindow(8, () => ({
      id: 8,
      z: 3,
      gx: 12,
      gy: 24,
      gw: 320,
      gh: 240,
    }))

    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)

    mod.flushShellUiWindowsSyncNow()
    expect(send).toHaveBeenCalledTimes(1)
  })

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

  it('flushes again when measured geometry changes', async () => {
    const send = vi.fn()
    vi.stubGlobal('window', { __derpShellWireSend: send })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const mod = await import('./shellUiWindows')
    let width = 300
    mod.registerShellUiWindow(5, () => ({
      id: 5,
      z: 1,
      gx: 10,
      gy: 20,
      gw: width,
      gh: 200,
    }))

    mod.flushShellUiWindowsSyncNow()
    width = 340
    mod.flushShellUiWindowsSyncNow()

    expect(send).toHaveBeenCalledTimes(2)
  })
})
