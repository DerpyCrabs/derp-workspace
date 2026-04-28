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
        taskbarScreens: () => [],
        taskbarHeight: 44,
        taskbarAutoHide: () => false,
        windows: () => [],
        onHudChange,
        exclusionReactiveDeps: () => 0,
      })
      return dispose
    })

    runtime!.syncExclusionZonesNow()
    runtime!.syncExclusionZonesNow()
    expect(measure).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(onHudChange).toHaveBeenLastCalledWith([{ label: 'taskbar:one', x: 10, y: 20, w: 80, h: 40 }])

    width = 96
    registration.invalidate()
    runtime!.syncExclusionZonesNow()
    expect(measure).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(2)
    expect(main.getBoundingClientRect).toHaveBeenCalledTimes(2)

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
    const measure = vi.fn(() => ({ x: 1, y: 2, w: 3, h: 4 }))
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
        taskbarScreens: () => [],
        taskbarHeight: 44,
        taskbarAutoHide: () => false,
        windows: () => [],
        onHudChange: vi.fn(),
        exclusionReactiveDeps: () => 0,
      })
      return dispose
    })

    runtime!.syncExclusionZonesNow()
    runtime!.syncExclusionZonesNow()
    expect(send).toHaveBeenCalledTimes(2)
    expect(measure).toHaveBeenCalledTimes(1)

    registration.unregister()
    dispose()
  })

  it('emits taskbar exclusions for configured sides and auto-hide trigger strips', async () => {
    const send = vi.fn().mockReturnValue(true)
    vi.stubGlobal('window', {
      __DERP_SHELL_EXCLUSION_STATE_PATH: '/tmp/exclusion.bin',
      __derpShellSharedStateWrite: send,
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const mod = await import('./shellExclusionSync')
    const onHudChange = vi.fn()
    const main = {
      getBoundingClientRect: vi.fn(() => rect(0, 0, 1920, 1080)),
    } as unknown as HTMLElement
    const screens = [
      {
        name: 'DP-1',
        x: 0,
        y: 0,
        width: 1200,
        height: 900,
        transform: 0,
        refresh_milli_hz: 60000,
        vrr_supported: false,
        vrr_enabled: false,
        taskbar_side: 'left' as const,
      },
      {
        name: 'HDMI-A-1',
        x: 1200,
        y: 0,
        width: 720,
        height: 900,
        transform: 0,
        refresh_milli_hz: 60000,
        vrr_supported: false,
        vrr_enabled: false,
        taskbar_side: 'right' as const,
      },
    ]
    let autoHide = false

    let runtime: ReturnType<typeof mod.createShellExclusionSync> | null = null
    const dispose = createRoot((dispose) => {
      runtime = mod.createShellExclusionSync({
        mainEl: () => main,
        outputGeom: () => ({ w: 1920, h: 1080 }),
        layoutCanvasOrigin: () => null,
        taskbarScreens: () => screens,
        taskbarHeight: 44,
        taskbarAutoHide: () => autoHide,
        windows: () => [],
        onHudChange,
        exclusionReactiveDeps: () => autoHide,
      })
      return dispose
    })

    runtime!.syncExclusionZonesNow()
    expect(onHudChange).toHaveBeenLastCalledWith([
      { label: 'taskbar:DP-1', x: 0, y: 0, w: 44, h: 900 },
      { label: 'taskbar:HDMI-A-1', x: 1876, y: 0, w: 44, h: 900 },
    ])

    autoHide = true
    mod.invalidateAllShellExclusionRects()
    runtime!.syncExclusionZonesNow()
    expect(onHudChange).toHaveBeenLastCalledWith([
      { label: 'taskbar:DP-1', x: 0, y: 0, w: 2, h: 900 },
      { label: 'taskbar:HDMI-A-1', x: 1918, y: 0, w: 2, h: 900 },
    ])

    dispose()
  })

  it('omits pinned fullscreen taskbars but keeps auto-hide triggers', async () => {
    const send = vi.fn().mockReturnValue(true)
    vi.stubGlobal('window', {
      __DERP_SHELL_EXCLUSION_STATE_PATH: '/tmp/exclusion.bin',
      __derpShellSharedStateWrite: send,
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const mod = await import('./shellExclusionSync')
    const onHudChange = vi.fn()
    const main = {
      getBoundingClientRect: vi.fn(() => rect(0, 0, 1920, 1080)),
    } as unknown as HTMLElement
    const screen = {
      name: 'DP-1',
      identity: 'make:model:serial',
      x: 0,
      y: 0,
      width: 1200,
      height: 900,
      transform: 0,
      refresh_milli_hz: 60000,
      vrr_supported: false,
      vrr_enabled: false,
      taskbar_side: 'top' as const,
    }
    const fullscreenWindow = {
      window_id: 7,
      surface_id: 7,
      stack_z: 1,
      x: 0,
      y: 0,
      width: 1200,
      height: 900,
      title: 'fullscreen',
      app_id: 'test',
      output_id: 'make:model:serial',
      output_name: 'DP-1',
      kind: 'native',
      x11_class: '',
      x11_instance: '',
      minimized: false,
      maximized: false,
      fullscreen: true,
      shell_flags: 0,
      capture_identifier: '',
      workspace_visible: true,
    }
    let autoHide = false

    let runtime: ReturnType<typeof mod.createShellExclusionSync> | null = null
    const dispose = createRoot((dispose) => {
      runtime = mod.createShellExclusionSync({
        mainEl: () => main,
        outputGeom: () => ({ w: 1920, h: 1080 }),
        layoutCanvasOrigin: () => null,
        taskbarScreens: () => [screen],
        taskbarHeight: 44,
        taskbarAutoHide: () => autoHide,
        windows: () => [fullscreenWindow],
        onHudChange,
        exclusionReactiveDeps: () => autoHide,
      })
      return dispose
    })

    runtime!.syncExclusionZonesNow()
    expect(onHudChange).toHaveBeenLastCalledWith([])

    autoHide = true
    mod.invalidateAllShellExclusionRects()
    runtime!.syncExclusionZonesNow()
    expect(onHudChange).toHaveBeenLastCalledWith([
      { label: 'taskbar:DP-1', x: 0, y: 0, w: 1200, h: 2 },
    ])

    dispose()
  })

})
