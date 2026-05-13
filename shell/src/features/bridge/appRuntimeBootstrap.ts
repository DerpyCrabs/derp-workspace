import { registerCompositorBridgeRuntime } from '@/features/bridge/compositorBridgeRuntime'
import { registerShellE2eBridge } from '@/features/bridge/shellE2eBridge'
import type { ShellSharedStateSyncRequest } from './shellSharedStateSync'

declare global {
  interface Window {
    __DERP_LAST_SHELL_TOUCH?: { x: number; y: number; at: number }
    __DERP_SHELL_TOUCH_DOWN?: (x: number, y: number) => void
  }
}

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
  applyShellWindowMove: (clientX: number, clientY: number, superHeld?: boolean, buttons?: number) => void
  applyShellWindowResize: (clientX: number, clientY: number, buttons?: number) => void
  endShellWindowMove: (reason: string) => void
  endShellWindowResize: (reason: string) => void
  getShellWindowDragId: () => number | null
  getShellWindowResizeId: () => number | null
  setPointerClient: (value: { x: number; y: number }) => void
  setPointerInMain: (value: { x: number; y: number } | null) => void
  getMainRef: () => HTMLElement | undefined
  onWindowBlur: (state: { dragWindowId: number | null; resizeWindowId: number | null }) => void
  requestSharedStateSync: (request: ShellSharedStateSyncRequest, timing?: 'now' | 'microtask') => void
  shellWireSend: (
    op: 'presentation_fullscreen' | 'shell_editable_focus',
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
  let pointerGestureBlurPendingRelease = false
  let lastEditableIntent: { touch: boolean; x: number; y: number; at: number } | null = null
  let shellEditableFocusActive = false
  let activeEditableElement: HTMLElement | null = null
  let editableVisibilityCheckRaf = 0
  const stopThemeDomSync = options.startThemeDomSync()
  const stopShellWindowStateSync = options.subscribeShellWindowState(() => {
    options.onShellWindowStateChanged()
  })
  void options.refreshThemeSettingsFromRemote()
  void options.warmDesktopApps()
  void options.warmDefaultApps()
  void options.warmProgramsMenuItems()
  void options.bootstrapSessionState()
  options.startShellTransportBridge()

  const unregisterShellE2eBridge = registerShellE2eBridge(options.registerShellE2eBridge)
  const unregisterCompositorBridgeRuntime = registerCompositorBridgeRuntime(
    options.registerCompositorBridgeRuntime,
  )

  const syncViewport = () => options.setViewportCss({ w: window.innerWidth, h: window.innerHeight })
  syncViewport()

  const syncPointerPosition = (clientX: number, clientY: number) => {
    options.setPointerClient({ x: clientX, y: clientY })
    updatePointerInMain(options.getMainRef(), clientX, clientY, options.setPointerInMain)
  }

  const releaseIfPrimaryButtonsCleared = (
    clientX: number,
    clientY: number,
    buttons: number,
    reason: string,
  ) => {
    if ((buttons & 1) !== 0) return false
    syncPointerPosition(clientX, clientY)
    options.endShellWindowMove(reason)
    options.endShellWindowResize(reason)
    pointerGestureBlurPendingRelease = false
    return true
  }

  const onPointerMove = (event: PointerEvent) => {
    options.applyShellWindowMove(event.clientX, event.clientY, event.metaKey, event.buttons)
    options.applyShellWindowResize(event.clientX, event.clientY, event.buttons)
    syncPointerPosition(event.clientX, event.clientY)
    if (pointerGestureBlurPendingRelease) {
      releaseIfPrimaryButtonsCleared(
        event.clientX,
        event.clientY,
        event.buttons,
        'window-pointermove-buttons-cleared',
      )
      if (options.getShellWindowDragId() === null && options.getShellWindowResizeId() === null) {
        pointerGestureBlurPendingRelease = false
      }
    }
  }

  const onMouseMove = (event: MouseEvent) => {
    options.applyShellWindowMove(event.clientX, event.clientY, event.metaKey)
    options.applyShellWindowResize(event.clientX, event.clientY)
    syncPointerPosition(event.clientX, event.clientY)
  }

  const onWindowPointerUp = (event: PointerEvent) => {
    if (!event.isPrimary) return
    options.applyShellWindowResize(event.clientX, event.clientY, event.buttons)
    syncPointerPosition(event.clientX, event.clientY)
    options.endShellWindowMove('window-pointerup')
    options.endShellWindowResize('window-pointerup')
    pointerGestureBlurPendingRelease = false
  }

  const onWindowMouseUp = (event: MouseEvent) => {
    if (event.button !== 0) return
    options.applyShellWindowResize(event.clientX, event.clientY, event.buttons)
    syncPointerPosition(event.clientX, event.clientY)
    options.endShellWindowMove('window-mouseup')
    options.endShellWindowResize('window-mouseup')
    pointerGestureBlurPendingRelease = false
  }

  const onWindowPointerCancel = (event: PointerEvent) => {
    if (!event.isPrimary) return
    options.applyShellWindowResize(event.clientX, event.clientY, event.buttons)
    syncPointerPosition(event.clientX, event.clientY)
    options.endShellWindowMove('window-pointercancel')
    options.endShellWindowResize('window-pointercancel')
    pointerGestureBlurPendingRelease = false
  }

  const editableElement = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof HTMLElement)) return null
    const element = target.closest('input, textarea, [contenteditable]')
    if (!(element instanceof HTMLElement)) return null
    const contentEditable = element.getAttribute('contenteditable')
    if (contentEditable !== null && contentEditable.toLowerCase() === 'false') return null
    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase()
      if (['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)) return null
      if (element.disabled || element.readOnly) return null
    }
    if (element instanceof HTMLTextAreaElement && (element.disabled || element.readOnly)) return null
    return element
  }

  const editableCenter = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect()
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    }
  }

  const sendEditableFocus = (active: boolean, touch: boolean, point: { x: number; y: number }) => {
    shellEditableFocusActive = active
    if (!active) activeEditableElement = null
    options.shellWireSend('shell_editable_focus', active ? 1 : 0, touch ? 1 : 0, point.x, point.y)
  }

  const editableIsVisible = (element: HTMLElement) => {
    if (!element.isConnected) return false
    if (editableElement(element) !== element) return false
    const rects = Array.from(element.getClientRects())
    return rects.some((rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight,
    )
  }

  const checkActiveEditableVisibility = () => {
    editableVisibilityCheckRaf = 0
    if (!shellEditableFocusActive) return
    const editable = activeEditableElement
    if (!editable || document.activeElement !== editable || !editableIsVisible(editable)) {
      sendEditableFocus(false, false, { x: 0, y: 0 })
    }
  }

  const scheduleActiveEditableVisibilityCheck = () => {
    if (editableVisibilityCheckRaf !== 0) return
    editableVisibilityCheckRaf = window.requestAnimationFrame(checkActiveEditableVisibility)
  }

  const recentShellTouch = () => {
    const touch = window.__DERP_LAST_SHELL_TOUCH
    return touch && performance.now() - touch.at < 1200 ? touch : null
  }

  const recordShellTouchDown = (x: number, y: number) => {
    const point = {
      touch: true,
      x: Math.round(x),
      y: Math.round(y),
      at: performance.now(),
    }
    window.__DERP_LAST_SHELL_TOUCH = point
    lastEditableIntent = point
    const hit = document.elementFromPoint(point.x, point.y)
    const editable = editableElement(hit)
    if (!editable) return
    editable.focus({ preventScroll: true })
    activeEditableElement = editable
    sendEditableFocus(true, true, editableCenter(editable))
  }

  window.__DERP_SHELL_TOUCH_DOWN = recordShellTouchDown

  const onDocumentPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch') {
      recordShellTouchDown(event.clientX, event.clientY)
      return
    }
    window.__DERP_LAST_SHELL_TOUCH = undefined
    const editable = editableElement(event.target)
    if (!editable) {
      if (shellEditableFocusActive) sendEditableFocus(false, false, { x: 0, y: 0 })
      return
    }
    lastEditableIntent = {
      touch: false,
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      at: performance.now(),
    }
  }

  const onDocumentTouchStart = (event: TouchEvent) => {
    const touch = event.changedTouches[0]
    if (!touch) return
    recordShellTouchDown(touch.clientX, touch.clientY)
  }

  const onDocumentMouseDown = (event: MouseEvent) => {
    window.__DERP_LAST_SHELL_TOUCH = undefined
    const editable = editableElement(event.target)
    if (!editable) {
      if (shellEditableFocusActive) sendEditableFocus(false, false, { x: 0, y: 0 })
      return
    }
    lastEditableIntent = {
      touch: false,
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      at: performance.now(),
    }
  }

  const onDocumentFocusIn = (event: FocusEvent) => {
    const editable = editableElement(event.target)
    if (!editable) return
    activeEditableElement = editable
    const now = performance.now()
    const center = editableCenter(editable)
    const intent = lastEditableIntent && now - lastEditableIntent.at < 1200 ? lastEditableIntent : null
    const shellTouch = recentShellTouch()
    sendEditableFocus(true, shellTouch !== null || intent?.touch === true, intent ? { x: intent.x, y: intent.y } : center)
  }

  const onDocumentFocusOut = () => {
    queueMicrotask(() => {
      if (!shellEditableFocusActive) return
      const editable = editableElement(document.activeElement)
      if (!editable) sendEditableFocus(false, false, { x: 0, y: 0 })
    })
  }

  const onWindowBlur = () => {
    const state = {
      dragWindowId: options.getShellWindowDragId(),
      resizeWindowId: options.getShellWindowResizeId(),
    }
    if (state.dragWindowId !== null || state.resizeWindowId !== null) {
      pointerGestureBlurPendingRelease = true
    }
    options.onWindowBlur(state)
  }

  const onWindowTouchEnd = () => {
    options.endShellWindowMove('window-touchend')
    options.endShellWindowResize('window-touchend')
    pointerGestureBlurPendingRelease = false
  }

  const onWindowTouchMove = (event: TouchEvent) => {
    const touch = event.changedTouches[0]
    if (!touch) return
    if (options.getShellWindowDragId() !== null) {
      options.applyShellWindowMove(touch.clientX, touch.clientY, false, 1)
      event.preventDefault()
    }
    if (options.getShellWindowResizeId() !== null) {
      options.applyShellWindowResize(touch.clientX, touch.clientY, 1)
      event.preventDefault()
    }
    syncPointerPosition(touch.clientX, touch.clientY)
  }

  const onWindowResize = () => {
    syncViewport()
    scheduleActiveEditableVisibilityCheck()
    options.requestSharedStateSync({ shellUi: 'invalidate-all', exclusion: 'schedule' })
  }

  const onFullscreenChange = () => {
    options.shellWireSend('presentation_fullscreen', document.fullscreenElement ? 1 : 0)
  }

  const pointerEventsSupported = typeof window.PointerEvent !== 'undefined'
  if (pointerEventsSupported) {
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    window.addEventListener('pointerup', onWindowPointerUp, { passive: true })
    window.addEventListener('pointercancel', onWindowPointerCancel, { passive: true })
  } else {
    document.addEventListener('mousedown', onDocumentMouseDown, true)
    window.addEventListener('mousemove', onMouseMove, { passive: true })
    window.addEventListener('mouseup', onWindowMouseUp, { passive: true })
  }
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('touchend', onWindowTouchEnd, { passive: true })
  window.addEventListener('touchcancel', onWindowTouchEnd, { passive: true })
  document.addEventListener('touchstart', onDocumentTouchStart, { capture: true, passive: true })
  document.addEventListener('focusin', onDocumentFocusIn, true)
  document.addEventListener('focusout', onDocumentFocusOut, true)
  document.addEventListener('scroll', scheduleActiveEditableVisibilityCheck, true)
  window.addEventListener('touchmove', onWindowTouchMove, { passive: false })
  window.addEventListener('resize', onWindowResize, { passive: true })
  document.addEventListener('fullscreenchange', onFullscreenChange)
  const editableMutationObserver = typeof MutationObserver !== 'undefined'
    ? new MutationObserver(scheduleActiveEditableVisibilityCheck)
    : null
  editableMutationObserver?.observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ['class', 'hidden', 'style', 'disabled', 'readonly', 'contenteditable', 'aria-hidden'],
  })

  return () => {
    unregisterCompositorBridgeRuntime()
    if (pointerEventsSupported) {
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerdown', onDocumentPointerDown, true)
      window.removeEventListener('pointerup', onWindowPointerUp)
      window.removeEventListener('pointercancel', onWindowPointerCancel)
    } else {
      document.removeEventListener('mousedown', onDocumentMouseDown, true)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onWindowMouseUp)
    }
    window.removeEventListener('blur', onWindowBlur)
    window.removeEventListener('touchend', onWindowTouchEnd)
    window.removeEventListener('touchcancel', onWindowTouchEnd)
    document.removeEventListener('touchstart', onDocumentTouchStart, true)
    document.removeEventListener('focusin', onDocumentFocusIn, true)
    document.removeEventListener('focusout', onDocumentFocusOut, true)
    document.removeEventListener('scroll', scheduleActiveEditableVisibilityCheck, true)
    window.removeEventListener('touchmove', onWindowTouchMove)
    window.removeEventListener('resize', onWindowResize)
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    editableMutationObserver?.disconnect()
    if (editableVisibilityCheckRaf !== 0) window.cancelAnimationFrame(editableVisibilityCheckRaf)
    if (window.__DERP_SHELL_TOUCH_DOWN === recordShellTouchDown) delete window.__DERP_SHELL_TOUCH_DOWN
    unregisterShellE2eBridge()
    stopThemeDomSync()
    stopShellWindowStateSync()
    options.disposeBackedShellWindowActions()
  }
}
