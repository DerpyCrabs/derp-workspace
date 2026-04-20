import { registerCompositorBridgeRuntime } from '@/features/bridge/compositorBridgeRuntime'
import { registerShellE2eBridge } from '@/features/bridge/shellE2eBridge'

type AppRuntimeBootstrapOptions = {
  startThemeDomSync: () => () => void
  subscribeShellWindowState: (listener: () => void) => () => void
  onShellWindowStateChanged: () => void
  refreshThemeSettingsFromRemote: () => Promise<unknown>
  warmDesktopApps: () => Promise<unknown>
  warmDefaultApps: () => Promise<unknown>
  warmProgramsMenuItems: () => Promise<unknown>
  bootstrapSessionState: () => Promise<unknown>
  disposeBackedShellWindowActions: () => void
  startShellTransportBridge: () => void
  registerShellE2eBridge: Parameters<typeof registerShellE2eBridge>[0]
  registerCompositorBridgeRuntime: Parameters<typeof registerCompositorBridgeRuntime>[0]
  setViewportCss: (value: { w: number; h: number }) => void
  applyShellWindowMove: (clientX: number, clientY: number) => void
  applyShellWindowResize: (clientX: number, clientY: number) => void
  endShellWindowMove: (reason: string) => void
  endShellWindowResize: (reason: string) => void
  getShellWindowDragId: () => number | null
  getShellWindowResizeId: () => number | null
  setPointerClient: (value: { x: number; y: number }) => void
  setPointerInMain: (value: { x: number; y: number } | null) => void
  getMainRef: () => HTMLElement | undefined
  onWindowBlur: (state: { dragWindowId: number | null; resizeWindowId: number | null }) => void
  invalidateAllShellUiWindows: () => void
  scheduleExclusionZonesSync: () => void
  shellWireSend: (
    op: 'presentation_fullscreen',
    arg?: number | string,
    arg2?: number | string,
    arg3?: number,
    arg4?: number,
    arg5?: number,
    arg6?: number,
  ) => boolean
}

function updatePointerInMain(
  mainRef: HTMLElement | undefined,
  clientX: number,
  clientY: number,
  setPointerInMain: (value: { x: number; y: number } | null) => void,
) {
  const el = mainRef
  if (!el) return
  const rect = el.getBoundingClientRect()
  setPointerInMain({
    x: Math.round(clientX - rect.left),
    y: Math.round(clientY - rect.top),
  })
}

export function registerAppRuntimeBootstrap(options: AppRuntimeBootstrapOptions) {
  const stopThemeDomSync = options.startThemeDomSync()
  const stopShellWindowStateSync = options.subscribeShellWindowState(() => {
    options.onShellWindowStateChanged()
  })
  void options.refreshThemeSettingsFromRemote()
  void options.warmDesktopApps()
  void options.warmDefaultApps()
  void options.warmProgramsMenuItems()
  void options.bootstrapSessionState()
  console.log(
    '[derp-shell-move] shell App onMount (expect cef_js_console in compositor.log when CEF forwards this prefix)',
  )
  options.startShellTransportBridge()

  const unregisterShellE2eBridge = registerShellE2eBridge(options.registerShellE2eBridge)
  const unregisterCompositorBridgeRuntime = registerCompositorBridgeRuntime(
    options.registerCompositorBridgeRuntime,
  )

  const syncViewport = () => options.setViewportCss({ w: window.innerWidth, h: window.innerHeight })
  syncViewport()

  const onPointerMove = (event: PointerEvent) => {
    options.applyShellWindowMove(event.clientX, event.clientY)
    options.applyShellWindowResize(event.clientX, event.clientY)
    options.setPointerClient({ x: event.clientX, y: event.clientY })
    updatePointerInMain(options.getMainRef(), event.clientX, event.clientY, options.setPointerInMain)
  }

  const onMouseMove = (event: MouseEvent) => {
    options.setPointerClient({ x: event.clientX, y: event.clientY })
    updatePointerInMain(options.getMainRef(), event.clientX, event.clientY, options.setPointerInMain)
  }

  const onWindowPointerUp = (event: PointerEvent) => {
    if (!event.isPrimary) return
    options.endShellWindowResize('window-pointerup')
    options.endShellWindowMove('window-pointerup')
  }

  const onWindowMouseUp = (event: MouseEvent) => {
    if (event.button !== 0) return
    options.endShellWindowResize('window-mouseup')
    options.endShellWindowMove('window-mouseup')
  }

  const onWindowPointerCancel = (event: PointerEvent) => {
    if (!event.isPrimary) return
    options.endShellWindowResize('window-pointercancel')
    options.endShellWindowMove('window-pointercancel')
  }

  const onWindowBlur = () => {
    options.onWindowBlur({
      dragWindowId: options.getShellWindowDragId(),
      resizeWindowId: options.getShellWindowResizeId(),
    })
  }

  const onWindowTouchEnd = () => {
    options.endShellWindowResize('window-touchend')
    options.endShellWindowMove('window-touchend')
  }

  const onWindowTouchMove = (event: TouchEvent) => {
    const touch = event.changedTouches[0]
    if (!touch) return
    if (options.getShellWindowDragId() !== null) {
      options.applyShellWindowMove(touch.clientX, touch.clientY)
      event.preventDefault()
    }
    if (options.getShellWindowResizeId() !== null) {
      options.applyShellWindowResize(touch.clientX, touch.clientY)
      event.preventDefault()
    }
    options.setPointerClient({ x: touch.clientX, y: touch.clientY })
    updatePointerInMain(options.getMainRef(), touch.clientX, touch.clientY, options.setPointerInMain)
  }

  const onWindowResize = () => {
    syncViewport()
    options.invalidateAllShellUiWindows()
    options.scheduleExclusionZonesSync()
  }

  const onFullscreenChange = () => {
    options.shellWireSend('presentation_fullscreen', document.fullscreenElement ? 1 : 0)
  }

  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('mousemove', onMouseMove, { passive: true })
  window.addEventListener('pointerup', onWindowPointerUp, { passive: true })
  window.addEventListener('mouseup', onWindowMouseUp, { passive: true })
  window.addEventListener('pointercancel', onWindowPointerCancel, { passive: true })
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('touchend', onWindowTouchEnd, { passive: true })
  window.addEventListener('touchcancel', onWindowTouchEnd, { passive: true })
  window.addEventListener('touchmove', onWindowTouchMove, { passive: false })
  window.addEventListener('resize', onWindowResize, { passive: true })
  document.addEventListener('fullscreenchange', onFullscreenChange)

  return () => {
    unregisterCompositorBridgeRuntime()
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('pointerup', onWindowPointerUp)
    window.removeEventListener('mouseup', onWindowMouseUp)
    window.removeEventListener('pointercancel', onWindowPointerCancel)
    window.removeEventListener('blur', onWindowBlur)
    window.removeEventListener('touchend', onWindowTouchEnd)
    window.removeEventListener('touchcancel', onWindowTouchEnd)
    window.removeEventListener('touchmove', onWindowTouchMove)
    window.removeEventListener('resize', onWindowResize)
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    unregisterShellE2eBridge()
    stopThemeDomSync()
    stopShellWindowStateSync()
    options.disposeBackedShellWindowActions()
  }
}
