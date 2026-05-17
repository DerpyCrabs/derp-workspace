import { createRoot } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    width,
    height,
  } as DOMRect
}

describe('createShellExclusionSync', () => {
  it('uses registered exclusions without scanning the dom and only remeasures dirty entries', async () => {
    const send = vi.fn().mockReturnValue(true)
    vi.stubGlobal('window', {
      __DERP_SHELL_EXCLUSION_STATE_PATH: '/tmp/exclusion.bin',
      __derpShellSharedStateWrite: send,
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const mod = await import('./shellExclusionSync')
    let width = 80
    const measure = vi.fn(() => ({ x: 10, y: 20, w: width, h: 40 }))
    const registration = mod.registerShellExclusionRect('base', 'taskbar:one', measure)
    const onHudChange = vi.fn()
    const main = {
      getBoundingClientRect: vi.fn(() => rect(0, 0, 1920, 1080)),
      querySelector: vi.fn(() => {
        throw new Error('querySelector should not be used')
      }),
      querySelectorAll: vi.fn(() => {
        throw new Error('querySelectorAll should not be used')
      }),
    } as unknown as HTMLElement

    let runtime: ReturnType<typeof mod.createShellExclusionSync> | null = null
    const dispose = createRoot((dispose) => {
      runtime = mod.createShellExclusionSync({
        mainEl: () => main,
        outputGeom: () => ({ w: 1920, h: 1080 }),
        layoutCanvasOrigin: () => null,
        onHudChange,
        exclusionReactiveDeps: () => 0,
      })
      return dispose
    })

    const setupMeasureCalls = measure.mock.calls.length
    const setupSendCalls = send.mock.calls.length
    runtime!.syncExclusionZonesNow()
    runtime!.syncExclusionZonesNow()
    expect(measure).toHaveBeenCalledTimes(setupMeasureCalls)
    expect(send).toHaveBeenCalledTimes(setupSendCalls)
    expect(onHudChange).toHaveBeenLastCalledWith([{ label: 'taskbar:one', x: 10, y: 20, w: 80, h: 40 }])

    width = 96
    registration.invalidate()
    expect(measure).toHaveBeenCalledTimes(setupMeasureCalls + 1)
    expect(send).toHaveBeenCalledTimes(setupSendCalls + 1)

    registration.unregister()
    dispose()
  })

  it('retries a failed exclusion write without remeasuring unchanged entries', async () => {
    const send = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    vi.stubGlobal('window', {
      __DERP_SHELL_EXCLUSION_STATE_PATH: '/tmp/exclusion.bin',
      __derpShellSharedStateWrite: send,
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const mod = await import('./shellExclusionSync')
    let width = 3
    const measure = vi.fn(() => ({ x: 1, y: 2, w: width, h: 4 }))
    const registration = mod.registerShellExclusionRect('base', 'taskbar:retry', measure)
    const main = {
      getBoundingClientRect: vi.fn(() => rect(0, 0, 1920, 1080)),
    } as unknown as HTMLElement

    let runtime: ReturnType<typeof mod.createShellExclusionSync> | null = null
    const dispose = createRoot((dispose) => {
      runtime = mod.createShellExclusionSync({
        mainEl: () => main,
        outputGeom: () => ({ w: 1920, h: 1080 }),
        layoutCanvasOrigin: () => null,
        onHudChange: vi.fn(),
        exclusionReactiveDeps: () => 0,
      })
      return dispose
    })

    send.mockReset()
    send.mockReturnValueOnce(false).mockReturnValue(true)
    width = 5
    registration.invalidate()
    const setupMeasureCalls = measure.mock.calls.length
    const setupSendCalls = send.mock.calls.length
    runtime!.syncExclusionZonesNow()
    expect(send).toHaveBeenCalledTimes(setupSendCalls + 1)
    expect(measure).toHaveBeenCalledTimes(setupMeasureCalls)

    registration.unregister()
    dispose()
  })

  it('remeasures but does not rewrite unchanged exclusions when the compositor snapshot epoch changes', async () => {
    const send = vi.fn().mockReturnValue(true)
    vi.stubGlobal('window', {
      __DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE: 2,
      __DERP_LAST_COMPOSITOR_STATE_EPOCH: 2,
      __DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION: 3,
      __DERP_SHELL_EXCLUSION_STATE_PATH: '/tmp/exclusion.bin',
      __derpShellSharedStateWrite: send,
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const mod = await import('./shellExclusionSync')
    const measure = vi.fn(() => ({ x: 1, y: 2, w: 3, h: 4 }))
    const registration = mod.registerShellExclusionRect('base', 'epoch', measure)
    const main = {
      getBoundingClientRect: vi.fn(() => rect(0, 0, 1920, 1080)),
    } as unknown as HTMLElement

    let runtime: ReturnType<typeof mod.createShellExclusionSync> | null = null
    const dispose = createRoot((dispose) => {
      runtime = mod.createShellExclusionSync({
        mainEl: () => main,
        outputGeom: () => ({ w: 1920, h: 1080 }),
        layoutCanvasOrigin: () => null,
        onHudChange: vi.fn(),
        exclusionReactiveDeps: () => 0,
      })
      return dispose
    })

    const setupMeasureCalls = measure.mock.calls.length
    const setupSendCalls = send.mock.calls.length
    ;(window as Window & { __DERP_LAST_COMPOSITOR_STATE_EPOCH?: number }).__DERP_LAST_COMPOSITOR_STATE_EPOCH = 4
    runtime!.syncExclusionZonesNow()

    expect(send).toHaveBeenCalledTimes(setupSendCalls)
    expect(measure).toHaveBeenCalledTimes(setupMeasureCalls + 1)

    registration.unregister()
    dispose()
  })

  it('flushes removed exclusions immediately', async () => {
    const send = vi.fn().mockReturnValue(true)
    vi.stubGlobal('window', {
      __DERP_SHELL_EXCLUSION_STATE_PATH: '/tmp/exclusion.bin',
      __derpShellSharedStateWrite: send,
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const mod = await import('./shellExclusionSync')
    const main = {
      getBoundingClientRect: vi.fn(() => rect(0, 0, 1920, 1080)),
    } as unknown as HTMLElement

    let runtime: ReturnType<typeof mod.createShellExclusionSync> | null = null
    const dispose = createRoot((dispose) => {
      runtime = mod.createShellExclusionSync({
        mainEl: () => main,
        outputGeom: () => ({ w: 1920, h: 1080 }),
        layoutCanvasOrigin: () => null,
        onHudChange: vi.fn(),
        exclusionReactiveDeps: () => 0,
      })
      return dispose
    })

    const registration = mod.registerShellExclusionRect('floating', 'menu', () => ({ x: 1, y: 2, w: 3, h: 4 }))
    runtime!.syncExclusionZonesNow()
    send.mockClear()

    registration.unregister()
    expect(send).toHaveBeenCalledTimes(1)

    dispose()
  })

})
