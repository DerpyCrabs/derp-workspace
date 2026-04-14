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
    mod.invalidateShellUiWindow(5)
    mod.flushShellUiWindowsSyncNow()

    expect(send).toHaveBeenCalledTimes(2)
  })

  it('only remeasures invalidated shell-ui windows', async () => {
    const send = vi.fn()
    vi.stubGlobal('window', { __derpShellWireSend: send })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const mod = await import('./shellUiWindows')
    const measureA = vi.fn(() => ({
      id: 11,
      z: 1,
      gx: 10,
      gy: 20,
      gw: 100,
      gh: 80,
    }))
    const measureB = vi.fn(() => ({
      id: 12,
      z: 2,
      gx: 30,
      gy: 40,
      gw: 120,
      gh: 90,
    }))

    mod.registerShellUiWindow(11, measureA)
    mod.registerShellUiWindow(12, measureB)
    mod.flushShellUiWindowsSyncNow()

    expect(measureA).toHaveBeenCalledTimes(1)
    expect(measureB).toHaveBeenCalledTimes(1)

    mod.invalidateShellUiWindow(11)
    mod.flushShellUiWindowsSyncNow()

    expect(measureA).toHaveBeenCalledTimes(2)
    expect(measureB).toHaveBeenCalledTimes(1)
  })

  it('flushes removals even without remeasuring survivors', async () => {
    const send = vi.fn()
    vi.stubGlobal('window', { __derpShellWireSend: send })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const mod = await import('./shellUiWindows')
    const measure = vi.fn(() => ({
      id: 21,
      z: 1,
      gx: 0,
      gy: 0,
      gw: 10,
      gh: 10,
    }))
    const unregister = mod.registerShellUiWindow(21, measure)

    mod.flushShellUiWindowsSyncNow()
    unregister()
    mod.flushShellUiWindowsSyncNow()

    expect(send).toHaveBeenCalledTimes(2)
    expect(measure).toHaveBeenCalledTimes(1)
  })
})
