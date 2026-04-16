import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor } from 'solid-js'
import { Portal } from 'solid-js/web'
import {
  fetchPortalScreencastRequestState,
  respondPortalScreencastRequest,
} from '@/features/bridge/shellBridge'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import { hideFloatingPlacementWire, pushShellFloatingWireFromDom } from '@/features/floating/shellFloatingPlacement'
import type { DerpWindow } from '@/host/appWindowState'
import {
  formatMonitorPixels,
  layoutScreenCssRect,
  physicalPixelsForScreen,
  unionBBoxFromScreens,
} from '@/host/appLayout'
import type { LayoutScreen } from '@/host/types'
import {
  flushShellUiWindowsSyncNow,
  registerShellUiWindow,
  SHELL_WINDOW_FLAG_SHELL_HOSTED,
  SHELL_UI_SCREENSHOT_WINDOW_ID,
  type ShellUiMeasureEnv,
  shellUiWindowMeasureFromEnv,
} from '@/features/shell-ui/shellUiWindows'
import { canvasRectToClientCss, clientPointToGlobalLogical, rectGlobalToCanvasLocal } from '@/lib/shellCoords'

type ScreenshotSelectionState = {
  start: { x: number; y: number }
  current: { x: number; y: number }
  pointerId: number | null
}

const PORTAL_PICKER_PREVIEW_W = 520
const PORTAL_PICKER_PREVIEW_H = 260
const PORTAL_PICKER_PREVIEW_PAD = 16

type ScreenshotPortalBridgeOptions = {
  getMainRef: () => HTMLElement | undefined
  outputGeom: Accessor<{ w: number; h: number } | null>
  outputPhysical: Accessor<{ w: number; h: number } | null>
  layoutCanvasOrigin: Accessor<{ x: number; y: number } | null>
  canvasCss: Accessor<{ w: number; h: number }>
  screenDraftRows: Accessor<LayoutScreen[]>
  shellChromePrimaryName: Accessor<string | null>
  getWorkspacePrimary: () => LayoutScreen | null
  getWindows: () => readonly DerpWindow[]
  focusedWindowId: Accessor<number | null>
  shellWireReadyRev: Accessor<number>
  getAtlasHostEl: () => HTMLElement | undefined
  getShellMenuAtlasTop: () => number
  contextMenuAtlasBufferH: Accessor<number>
  setCrosshairCursor: (value: boolean) => void
  hideContextMenu: () => void
  closeAllAtlasSelects: () => boolean
  focusShellUiWindow: (windowId: number) => void
  clearShellActionIssue: () => void
  reportShellActionIssue: (message: string) => void
  describeError: (error: unknown) => string
  postShell: (path: string, body: object) => Promise<void>
  shellWireSend: (
    op: 'shell_ui_grab_begin' | 'shell_ui_grab_end' | 'shell_blur_ui_window',
    arg?: number | string,
  ) => boolean
  acquireAtlasOverlayPointer: () => void
  releaseAtlasOverlayPointer: () => void
}

export function createScreenshotPortalBridge(options: ScreenshotPortalBridgeOptions) {
  const [screenshotMode, setScreenshotMode] = createSignal(false)
  const [screenshotSelection, setScreenshotSelection] = createSignal<ScreenshotSelectionState | null>(null)
  const [portalPickerRequestId, setPortalPickerRequestId] = createSignal<number | null>(null)
  const [portalPickerTypes, setPortalPickerTypes] = createSignal<number | null>(null)
  const [portalPickerBusy, setPortalPickerBusy] = createSignal(false)

  const portalPickerVisible = createMemo(() => portalPickerRequestId() !== null)

  const screenshotSelectionRect = createMemo(() => {
    if (!screenshotMode()) return null
    const sel = screenshotSelection()
    if (!sel) return null
    const x1 = Math.min(sel.start.x, sel.current.x)
    const y1 = Math.min(sel.start.y, sel.current.y)
    const x2 = Math.max(sel.start.x, sel.current.x)
    const y2 = Math.max(sel.start.y, sel.current.y)
    return {
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
    }
  })

  function screenshotShellUiEnv(): ShellUiMeasureEnv | null {
    const main = options.getMainRef()
    const og = options.outputGeom()
    const origin = options.layoutCanvasOrigin()
    if (!main || !og || !origin) return null
    return {
      main,
      outputGeom: { w: og.w, h: og.h },
      origin,
    }
  }

  function screenshotPointFromClient(clientX: number, clientY: number) {
    const main = options.getMainRef()
    const og = options.outputGeom()
    if (!main || !og) return null
    return clientPointToGlobalLogical(
      clientX,
      clientY,
      main.getBoundingClientRect(),
      og.w,
      og.h,
      options.layoutCanvasOrigin(),
    )
  }

  function stopScreenshotMode() {
    setScreenshotSelection(null)
    setScreenshotMode(false)
    options.setCrosshairCursor(false)
    options.shellWireSend('shell_ui_grab_end')
    options.shellWireSend('shell_blur_ui_window')
  }

  function closePortalPickerUi() {
    if (!portalPickerVisible()) return
    setPortalPickerBusy(false)
    setPortalPickerRequestId(null)
    setPortalPickerTypes(null)
    hideFloatingPlacementWire()
  }

  function beginPortalPicker(requestId: number, types: number | null) {
    if (portalPickerRequestId() === requestId) return
    if (screenshotMode()) stopScreenshotMode()
    options.hideContextMenu()
    options.closeAllAtlasSelects()
    options.clearShellActionIssue()
    setPortalPickerBusy(false)
    setPortalPickerRequestId(requestId)
    setPortalPickerTypes(types)
  }

  async function resolvePortalPicker(selection: string | null) {
    const requestId = portalPickerRequestId()
    if (requestId === null || portalPickerBusy()) return
    setPortalPickerBusy(true)
    try {
      await respondPortalScreencastRequest(requestId, selection, shellHttpBase())
      closePortalPickerUi()
      options.clearShellActionIssue()
    } catch (error) {
      setPortalPickerBusy(false)
      options.reportShellActionIssue(`Screen share picker failed: ${options.describeError(error)}`)
    }
  }

  function waitForAnimationFrame() {
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
  }

  function beginScreenshotMode() {
    options.hideContextMenu()
    options.closeAllAtlasSelects()
    options.clearShellActionIssue()
    setScreenshotSelection(null)
    setScreenshotMode(true)
    options.setCrosshairCursor(true)
    queueMicrotask(() => {
      flushShellUiWindowsSyncNow()
      options.focusShellUiWindow(SHELL_UI_SCREENSHOT_WINDOW_ID)
    })
  }

  async function submitScreenshotRegion(bounds: { x: number; y: number; width: number; height: number }) {
    try {
      stopScreenshotMode()
      await waitForAnimationFrame()
      flushShellUiWindowsSyncNow()
      await waitForAnimationFrame()
      await waitForAnimationFrame()
      await options.postShell('/screenshot_region', bounds)
      options.clearShellActionIssue()
    } catch (error) {
      options.reportShellActionIssue(`Screenshot failed: ${options.describeError(error)}`)
    }
  }

  createEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failureCount = 0
    const nextDelay = (pending: boolean) => {
      if (pending) return 150
      if (failureCount <= 0) return 500
      return Math.min(3000, 500 * 2 ** Math.min(3, failureCount - 1))
    }
    const poll = async () => {
      const base = shellHttpBase()
      if (!base) {
        failureCount = Math.min(4, failureCount + 1)
        if (!cancelled) timer = setTimeout(() => void poll(), nextDelay(false))
        return
      }
      try {
        const state = await fetchPortalScreencastRequestState(base)
        if (cancelled) return
        failureCount = 0
        if (state.pending) beginPortalPicker(state.request_id, state.types)
        else closePortalPickerUi()
      } catch (error) {
        failureCount = Math.min(4, failureCount + 1)
        if (!cancelled && portalPickerVisible()) {
          closePortalPickerUi()
          options.reportShellActionIssue(`Screen share picker failed: ${options.describeError(error)}`)
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), nextDelay(portalPickerVisible()))
      }
    }
    void poll()
    onCleanup(() => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    })
  })

  const portalPickerWindows = createMemo(() => {
    return [...options.getWindows()]
      .filter((window) => !window.minimized)
      .filter((window) => (window.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) === 0)
      .filter((window) => window.capture_identifier.trim().length > 0)
      .sort((a, b) => {
        const aFocused = options.focusedWindowId() === a.window_id ? 1 : 0
        const bFocused = options.focusedWindowId() === b.window_id ? 1 : 0
        if (aFocused !== bFocused) return bFocused - aFocused
        if (a.stack_z !== b.stack_z) return b.stack_z - a.stack_z
        const aTitle = (a.title || a.app_id).trim()
        const bTitle = (b.title || b.app_id).trim()
        return aTitle.localeCompare(bTitle)
      })
  })

  const portalPickerOutputs = createMemo(() => {
    return [...options.screenDraftRows()].sort((a, b) => {
      if (a.x !== b.x) return a.x - b.x
      if (a.y !== b.y) return a.y - b.y
      return a.name.localeCompare(b.name)
    })
  })

  const portalPickerPreviewMetrics = createMemo(() => {
    const rows = portalPickerOutputs()
    const union = unionBBoxFromScreens(rows)
    if (!union) return null
    const scale = Math.max(
      0.001,
      Math.min(
        (PORTAL_PICKER_PREVIEW_W - PORTAL_PICKER_PREVIEW_PAD * 2) / union.w,
        (PORTAL_PICKER_PREVIEW_H - PORTAL_PICKER_PREVIEW_PAD * 2) / union.h,
      ),
    )
    const contentW = union.w * scale
    const contentH = union.h * scale
    const offsetX = (PORTAL_PICKER_PREVIEW_W - contentW) / 2 - union.x * scale
    const offsetY = (PORTAL_PICKER_PREVIEW_H - contentH) / 2 - union.y * scale
    return rows.map((row, index) => ({
      index,
      row,
      left: offsetX + row.x * scale,
      top: offsetY + row.y * scale,
      width: Math.max(1, row.width * scale),
      height: Math.max(1, row.height * scale),
    }))
  })

  const portalPickerCanSelectMonitor = createMemo(() => {
    const types = portalPickerTypes()
    return types === null || (types & 1) !== 0
  })

  const portalPickerCanSelectWindow = createMemo(() => {
    const types = portalPickerTypes()
    return types === null || (types & 2) !== 0
  })

  const portalPickerLayout = createMemo(() => {
    const main = options.getMainRef()
    const og = options.outputGeom()
    const target = options.getWorkspacePrimary()
    if (!main || !og || !target) return null
    const targetCss = layoutScreenCssRect(target, options.layoutCanvasOrigin())
    const screenCss = canvasRectToClientCss(
      targetCss.x,
      targetCss.y,
      targetCss.width,
      targetCss.height,
      main.getBoundingClientRect(),
      og.w,
      og.h,
    )
    const width = Math.max(320, Math.min(960, screenCss.width - 48))
    const maxHeight = Math.max(280, screenCss.height - 48)
    const stripHeight = Math.max(1, options.canvasCss().h - options.getShellMenuAtlasTop())
    const anchorX = Math.round(screenCss.left + (screenCss.width - width) / 2)
    const anchorY = Math.round(screenCss.top + Math.max(24, (screenCss.height - maxHeight) / 2))
    return {
      placement: {
        left: '50%',
        top: `${Math.max(8, Math.round((stripHeight - maxHeight) / 2))}px`,
        width: `${Math.round(width)}px`,
        'max-height': `${Math.round(maxHeight)}px`,
        transform: 'translateX(-50%)',
      } as const,
      anchor: {
        x: anchorX,
        y: anchorY,
        alignAboveY: anchorY,
      },
    }
  })

  function ScreenshotOverlay() {
    let root: HTMLDivElement | undefined

    onMount(() => {
      const unregister = registerShellUiWindow(SHELL_UI_SCREENSHOT_WINDOW_ID, () =>
        shellUiWindowMeasureFromEnv(
          SHELL_UI_SCREENSHOT_WINDOW_ID,
          460500,
          root,
          screenshotShellUiEnv,
        ),
      )
      onCleanup(unregister)
    })

    const selectionCss = createMemo(() => {
      const rect = screenshotSelectionRect()
      const main = options.getMainRef()
      const og = options.outputGeom()
      if (!rect || !main || !og) return null
      const local = rectGlobalToCanvasLocal(
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        options.layoutCanvasOrigin(),
      )
      return canvasRectToClientCss(
        local.x,
        local.y,
        local.w,
        local.h,
        main.getBoundingClientRect(),
        og.w,
        og.h,
      )
    })

    return (
      <div
        ref={(element) => {
          root = element
        }}
        class="fixed inset-0 z-460500 touch-none bg-black"
        onContextMenu={(event) => {
          event.preventDefault()
        }}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return
          const point = screenshotPointFromClient(event.clientX, event.clientY)
          if (!point) return
          root?.setPointerCapture?.(event.pointerId)
          options.focusShellUiWindow(SHELL_UI_SCREENSHOT_WINDOW_ID)
          options.shellWireSend('shell_ui_grab_begin', SHELL_UI_SCREENSHOT_WINDOW_ID)
          setScreenshotSelection({
            start: point,
            current: point,
            pointerId: event.pointerId,
          })
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerMove={(event) => {
          const selection = screenshotSelection()
          if (!selection || selection.pointerId !== event.pointerId) return
          const point = screenshotPointFromClient(event.clientX, event.clientY)
          if (!point) return
          setScreenshotSelection({
            ...selection,
            current: point,
          })
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerUp={(event) => {
          const selection = screenshotSelection()
          if (!selection || selection.pointerId !== event.pointerId) return
          root?.releasePointerCapture?.(event.pointerId)
          const point = screenshotPointFromClient(event.clientX, event.clientY)
          const next = point ? { ...selection, current: point } : selection
          setScreenshotSelection(next)
          const rect = screenshotSelectionRect()
          event.preventDefault()
          event.stopPropagation()
          if (!rect || rect.width < 2 || rect.height < 2) {
            stopScreenshotMode()
            return
          }
          void submitScreenshotRegion(rect)
        }}
        onPointerCancel={(event) => {
          root?.releasePointerCapture?.(event.pointerId)
          event.preventDefault()
          event.stopPropagation()
          stopScreenshotMode()
        }}
      >
        <Show when={selectionCss()} keyed>
          {(css) => (
            <div
              class="pointer-events-none fixed box-border border-2 border-white"
              style={{
                left: `${css.left}px`,
                top: `${css.top}px`,
                width: `${css.width}px`,
                height: `${css.height}px`,
              }}
            />
          )}
        </Show>
      </div>
    )
  }

  function PortalPickerOverlay() {
    let panel: HTMLDivElement | undefined

    onMount(() => {
      options.acquireAtlasOverlayPointer()
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          void resolvePortalPicker(null)
        }
      }
      document.addEventListener('keydown', onKeyDown, true)
      onCleanup(() => {
        document.removeEventListener('keydown', onKeyDown, true)
        options.releaseAtlasOverlayPointer()
        hideFloatingPlacementWire()
      })
    })

    createEffect(() => {
      void options.shellWireReadyRev()
      if (!portalPickerVisible()) {
        hideFloatingPlacementWire()
        return
      }
      const layout = portalPickerLayout()
      const og = options.outputGeom()
      const physical = options.outputPhysical()
      const frame = requestAnimationFrame(() => {
        const main = options.getMainRef()
        const atlasHost = options.getAtlasHostEl()
        if (!main || !atlasHost || !panel || !layout || !og || !physical) return
        pushShellFloatingWireFromDom({
          main,
          atlasHost,
          panel,
          anchor: layout.anchor,
          canvasW: og.w,
          canvasH: og.h,
          physicalW: physical.w,
          physicalH: physical.h,
          contextMenuAtlasBufferH: options.contextMenuAtlasBufferH(),
          screens: options.screenDraftRows(),
          layoutOrigin: options.layoutCanvasOrigin(),
        })
      })
      onCleanup(() => cancelAnimationFrame(frame))
    })

    return (
      <Show when={options.getAtlasHostEl()} keyed>
        {(host) => (
          <Portal mount={host}>
            <div
              class="absolute inset-0 z-90000"
              onContextMenu={(event) => {
                event.preventDefault()
              }}
              onPointerDown={(event) => {
                if (!(event.target instanceof Node)) return
                if (panel?.contains(event.target)) return
                event.preventDefault()
                event.stopPropagation()
                void resolvePortalPicker(null)
              }}
            >
              <div
                ref={(element) => {
                  panel = element
                }}
                class="absolute border border-white/12 bg-(--shell-overlay) p-5 text-(--shell-text) shadow-2xl"
                style={
                  portalPickerLayout()?.placement ?? {
                    left: '50%',
                    top: '8px',
                    width: 'min(960px, calc(100vw - 48px))',
                    'max-height': 'min(760px, calc(100% - 16px))',
                    transform: 'translateX(-50%)',
                  }
                }
              >
                <div class="mb-4 flex items-start justify-between gap-4">
                  <div>
                    <div class="text-lg font-semibold">
                      {portalPickerCanSelectMonitor() && !portalPickerCanSelectWindow()
                        ? 'Share a display'
                        : portalPickerCanSelectWindow() && !portalPickerCanSelectMonitor()
                          ? 'Share a window'
                          : 'Share a window or display'}
                    </div>
                    <div class="text-(--shell-text-muted) text-sm">
                      {portalPickerCanSelectMonitor() && !portalPickerCanSelectWindow()
                        ? 'Pick a display for `xdg-desktop-portal-wlr`.'
                        : portalPickerCanSelectWindow() && !portalPickerCanSelectMonitor()
                          ? 'Pick a native window for `xdg-desktop-portal-wlr`.'
                          : 'Pick a native window or display for `xdg-desktop-portal-wlr`.'}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={portalPickerBusy()}
                    class="rounded-lg border border-(--shell-border) px-3 py-1.5 text-sm text-(--shell-text-muted) transition-colors hover:bg-(--shell-hover)"
                    onClick={() => {
                      void resolvePortalPicker(null)
                    }}
                  >
                    {portalPickerBusy() ? 'Working...' : 'Cancel'}
                  </button>
                </div>
                <Show when={portalPickerCanSelectWindow()}>
                  <div class="border border-(--shell-border) bg-(--shell-surface) mb-3 rounded-lg p-2.5">
                    <div class="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                      <span class="text-[0.78rem] font-medium text-(--shell-text)">Native windows</span>
                      <span class="text-[0.72rem] text-(--shell-text-dim)">
                        Shell-backed windows are hidden from sharing
                      </span>
                    </div>
                    <Show
                      when={portalPickerWindows().length > 0}
                      fallback={
                        <div class="text-(--shell-text-muted) rounded-md border border-dashed border-(--shell-border) px-3 py-6 text-center text-sm">
                          No native windows are ready to share.
                        </div>
                      }
                    >
                      <div class="grid max-h-[min(24rem,40vh)] grid-cols-1 gap-2 overflow-auto pr-1 md:grid-cols-2">
                        <For each={portalPickerWindows()}>
                          {(window) => {
                            const monitorName = window.output_name || 'Current display'
                            const title = (window.title || window.app_id || 'Untitled window').trim()
                            const appId = window.app_id.trim()
                            return (
                              <button
                                type="button"
                                disabled={portalPickerBusy()}
                                class="border border-(--shell-border) bg-(--shell-surface-elevated) hover:border-(--shell-accent-border) hover:bg-(--shell-surface-hover) flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--shell-accent)"
                                onClick={() => {
                                  void resolvePortalPicker(`Window: ${window.capture_identifier}`)
                                }}
                              >
                                <div class="flex items-start justify-between gap-2">
                                  <div class="min-w-0">
                                    <div class="truncate text-[0.82rem] font-semibold text-(--shell-text)">
                                      {title}
                                    </div>
                                    <div class="truncate text-[0.72rem] text-(--shell-text-dim)">
                                      {appId || 'Unknown app'}
                                    </div>
                                  </div>
                                  <Show when={options.focusedWindowId() === window.window_id}>
                                    <span class="rounded-full border border-(--shell-accent) px-1.5 py-[0.08rem] text-[0.56rem] font-semibold uppercase tracking-wide text-(--shell-accent)">
                                      Focused
                                    </span>
                                  </Show>
                                </div>
                                <div class="flex flex-wrap gap-x-3 gap-y-1 text-[0.68rem] text-(--shell-text-muted)">
                                  <span>{monitorName}</span>
                                  <span>{formatMonitorPixels(window.width, window.height)}</span>
                                  <Show when={window.fullscreen}>
                                    <span>Fullscreen</span>
                                  </Show>
                                  <Show when={!window.fullscreen && window.maximized}>
                                    <span>Maximized</span>
                                  </Show>
                                </div>
                              </button>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
                <Show when={portalPickerCanSelectMonitor()}>
                  <div class="border border-(--shell-border) bg-(--shell-surface) mb-3 rounded-lg p-2.5">
                    <div class="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                      <span class="text-[0.78rem] font-medium text-(--shell-text)">Displays</span>
                      <span class="text-[0.72rem] text-(--shell-text-dim)">
                        Selection follows your saved display arrangement
                      </span>
                    </div>
                    <Show
                      when={portalPickerOutputs().length > 0}
                      fallback={
                        <div class="text-(--shell-text-muted) rounded-md border border-dashed border-(--shell-border) px-3 py-6 text-center text-sm">
                          Waiting for display layout from the compositor.
                        </div>
                      }
                    >
                      <div class="bg-(--shell-display-preview-bg) relative aspect-2/1 w-full overflow-hidden rounded-md border border-(--shell-border)">
                        <div class="bg-(--shell-display-preview-glow) pointer-events-none absolute inset-0" />
                        <For each={portalPickerPreviewMetrics() ?? []}>
                          {(rect) =>
                            (() => {
                              const physical = physicalPixelsForScreen(
                                rect.row,
                                options.outputGeom(),
                                options.outputPhysical(),
                              )
                              return (
                                <button
                                  type="button"
                                  disabled={portalPickerBusy() || !rect.row.name}
                                  class="border border-(--shell-display-card-border) bg-(--shell-display-card-bg) text-(--shell-text) absolute flex flex-col items-start justify-between overflow-hidden rounded-md px-2 py-1.5 text-left transition-shadow hover:shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--shell-accent)"
                                  classList={{
                                    'border-(--shell-display-card-primary-border) bg-(--shell-display-card-primary-bg)':
                                      options.shellChromePrimaryName() === rect.row.name,
                                  }}
                                  style={{
                                    left: `${(rect.left / PORTAL_PICKER_PREVIEW_W) * 100}%`,
                                    top: `${(rect.top / PORTAL_PICKER_PREVIEW_H) * 100}%`,
                                    width: `${(rect.width / PORTAL_PICKER_PREVIEW_W) * 100}%`,
                                    height: `${(rect.height / PORTAL_PICKER_PREVIEW_H) * 100}%`,
                                  }}
                                  onClick={() => {
                                    void resolvePortalPicker(`Monitor: ${rect.row.name}`)
                                  }}
                                >
                                  <div class="min-w-0">
                                    <div class="truncate text-[0.74rem] font-semibold">
                                      {rect.row.name || '-'}
                                    </div>
                                    <div class="text-[0.66rem] text-(--shell-text-muted)">
                                      {formatMonitorPixels(physical.width, physical.height)}
                                    </div>
                                  </div>
                                  <Show when={options.shellChromePrimaryName() === rect.row.name}>
                                    <span class="rounded-full border border-(--shell-accent) px-1.5 py-[0.08rem] text-[0.56rem] font-semibold uppercase tracking-wide text-(--shell-accent)">
                                      Primary
                                    </span>
                                  </Show>
                                </button>
                              )
                            })()
                          }
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
          </Portal>
        )}
      </Show>
    )
  }

  return {
    ScreenshotOverlay,
    PortalPickerOverlay,
    beginScreenshotMode,
    closePortalPickerUi,
    portalPickerVisible,
    screenshotMode,
    stopScreenshotMode,
  }
}
