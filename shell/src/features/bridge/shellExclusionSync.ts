import { createEffect, onCleanup, type Accessor } from 'solid-js'
import type { DerpWindow } from '@/host/appWindowState'
import type { ExclusionHudZone, LayoutScreen } from '@/host/types'
import { mergeExclusionRects, ssdDecorationExclusionRects } from '@/lib/exclusionRects'
import { clientRectToGlobalLogical, rectCanvasLocalToGlobal } from '@/lib/shellCoords'
import { writeShellExclusionState } from './sharedShellState'

type ShellExclusionSyncOptions = {
  mainEl: Accessor<HTMLElement | undefined>
  outputGeom: Accessor<{ w: number; h: number } | null>
  layoutCanvasOrigin: Accessor<{ x: number; y: number } | null>
  taskbarScreens: Accessor<readonly LayoutScreen[]>
  windows: Accessor<readonly DerpWindow[]>
  isWindowVisible?: (window: DerpWindow) => boolean
  isWindowTiled: (windowId: number) => boolean
  onHudChange: (zones: ExclusionHudZone[]) => void
  exclusionReactiveDeps: Accessor<unknown>
}

export function createShellExclusionSync(options: ShellExclusionSyncOptions) {
  let exclusionZonesRaf = 0
  let lastExclusionZonesJson: string | null = null
  const isWindowVisible = (window: DerpWindow) => options.isWindowVisible?.(window) ?? true

  const exclusionWindows = () => {
    const next = options.windows()
      .filter((window) => isWindowVisible(window))
      .map((window) => ({
        window_id: window.window_id,
        stack_z: window.stack_z,
        x: window.x,
        y: window.y,
        width: window.width,
        height: window.height,
        output_name: window.output_name,
        minimized: window.minimized,
        maximized: window.maximized,
        fullscreen: window.fullscreen,
        snap_tiled: options.isWindowTiled(window.window_id),
      }))
    next.sort((a, b) => b.stack_z - a.stack_z || b.window_id - a.window_id)
    return next
  }

  const exclusionWindowsSig = () =>
    exclusionWindows()
      .map((window) =>
        [
          window.window_id,
          window.stack_z,
          window.x,
          window.y,
          window.width,
          window.height,
          window.output_name,
          window.minimized ? 1 : 0,
          window.maximized ? 1 : 0,
          window.fullscreen ? 1 : 0,
          window.snap_tiled ? 1 : 0,
        ].join(':'),
      )
      .join('|')

  const fullscreenTaskbarExclusionSig = () => {
    const fullscreenOutputs = new Set<string>()
    for (const window of options.windows()) {
      if (!isWindowVisible(window) || window.minimized || !window.fullscreen) continue
      fullscreenOutputs.add(window.output_name)
    }
    return options
      .taskbarScreens()
      .map((screen) => `${screen.name}:${fullscreenOutputs.has(screen.name) ? 1 : 0}`)
      .join('|')
  }

  function syncExclusionZonesNow() {
    void options.exclusionReactiveDeps()
    const main = options.mainEl()
    if (!main) {
      options.onHudChange([])
      return
    }
    const og = options.outputGeom()
    if (!og) {
      options.onHudChange([])
      return
    }
    const co = options.layoutCanvasOrigin()
    const mainRect = main.getBoundingClientRect()
    const rects: Array<{
      x: number
      y: number
      w: number
      h: number
      window_id?: number
    }> = []
    const hud: ExclusionHudZone[] = []
    const addEl = (el: Element | null | undefined, label: string) => {
      if (!el) return
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      const z = clientRectToGlobalLogical(mainRect, r, og.w, og.h, co)
      rects.push({ x: z.x, y: z.y, w: z.w, h: z.h })
      hud.push({ label, ...z })
    }
    addEl(main.querySelector('[data-shell-panel]'), 'panel')
    for (const el of main.querySelectorAll('[data-shell-taskbar-exclude]')) {
      const mon = el.getAttribute('data-shell-taskbar-monitor') ?? ''
      addEl(el, mon.length > 0 ? `taskbar:${mon}` : 'taskbar')
    }
    addEl(main.querySelector('[data-shell-snap-picker]'), 'snap-picker')
    addEl(main.querySelector('[data-shell-snap-strip-trigger]'), 'snap-strip')
    const stripLabels = ['t', 'l', 'r', 'b'] as const
    for (const window of exclusionWindows()) {
      if (window.minimized) continue
      const deco = ssdDecorationExclusionRects(window)
      for (let index = 0; index < deco.length; index += 1) {
        const rect = deco[index]
        const tag = stripLabels[index] ?? `${index}`
        const z = rectCanvasLocalToGlobal(rect.x, rect.y, rect.w, rect.h, co)
        hud.push({ label: `w${window.window_id}-deco-${tag}`, x: z.x, y: z.y, w: z.w, h: z.h })
        rects.push({ x: z.x, y: z.y, w: z.w, h: z.h, window_id: window.window_id })
      }
    }
    const floatingRaw: typeof rects = []
    const floatingEls = new Set<Element>()
    for (const el of main.querySelectorAll('[data-shell-exclusion-floating]')) {
      floatingEls.add(el)
    }
    const floatingDoc = main.ownerDocument
    if (floatingDoc) {
      for (const el of floatingDoc.querySelectorAll('[data-shell-exclusion-floating]')) {
        floatingEls.add(el)
      }
    }
    for (const el of floatingEls) {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      const z = clientRectToGlobalLogical(mainRect, r, og.w, og.h, co)
      floatingRaw.push({ x: z.x, y: z.y, w: z.w, h: z.h })
      hud.push({ label: 'floating', ...z })
    }
    const overlayOpen = floatingRaw.length > 0
    const mergedBase = mergeExclusionRects([...rects, ...floatingRaw])
    options.onHudChange(hud)
    let tray_strip: { x: number; y: number; w: number; h: number } | null = null
    const trayStripEl = main.querySelector('[data-shell-tray-strip]')
    if (trayStripEl) {
      const r = trayStripEl.getBoundingClientRect()
      if (r.width >= 1 && r.height >= 1) {
        const z = clientRectToGlobalLogical(mainRect, r, og.w, og.h, co)
        tray_strip = { x: z.x, y: z.y, w: z.w, h: z.h }
      }
    }
    const floatingForPayload = mergeExclusionRects(floatingRaw)
    const payload = JSON.stringify({
      rects: mergedBase,
      tray_strip,
      overlayOpen,
      floating: floatingForPayload,
    })
    if (payload === lastExclusionZonesJson) return
    if (!writeShellExclusionState(mergedBase, tray_strip, overlayOpen, floatingForPayload)) return
    lastExclusionZonesJson = payload
  }

  function scheduleExclusionZonesSync() {
    if (exclusionZonesRaf) return
    exclusionZonesRaf = requestAnimationFrame(() => {
      exclusionZonesRaf = 0
      syncExclusionZonesNow()
    })
  }

  createEffect(() => {
    exclusionWindowsSig()
    queueMicrotask(() => scheduleExclusionZonesSync())
  })

  createEffect(() => {
    fullscreenTaskbarExclusionSig()
    queueMicrotask(() => scheduleExclusionZonesSync())
  })

  createEffect(() => {
    options.outputGeom()
    options.layoutCanvasOrigin()
    queueMicrotask(() => scheduleExclusionZonesSync())
  })

  createEffect(() => {
    options.exclusionReactiveDeps()
    queueMicrotask(() => scheduleExclusionZonesSync())
  })

  createEffect(() => {
    const main = options.mainEl()
    if (!main) {
      options.onHudChange([])
      return
    }
    const resizeObserver = new ResizeObserver(() => scheduleExclusionZonesSync())
    resizeObserver.observe(main, { box: 'border-box' })
    queueMicrotask(() => scheduleExclusionZonesSync())
    onCleanup(() => resizeObserver.disconnect())
  })

  onCleanup(() => {
    if (exclusionZonesRaf) cancelAnimationFrame(exclusionZonesRaf)
  })

  return {
    scheduleExclusionZonesSync,
    syncExclusionZonesNow,
  }
}
