import { createEffect, onCleanup, type Accessor } from 'solid-js'
import type { DerpWindow } from '@/host/appWindowState'
import type { ExclusionHudZone, LayoutScreen } from '@/host/types'
import { mergeExclusionRects } from '@/lib/exclusionRects'
import { clientRectToGlobalLogical } from '@/lib/shellCoords'
import { sharedShellStateStampKey, writeShellExclusionState } from './sharedShellState'
import {
  createShellMeasureFrame,
  currentShellMeasureFrame,
  type ShellMeasureFrame,
} from './shellMeasureFrame'
import { noteShellDomMeasure } from './shellPerfCounters'

type ShellExclusionSyncOptions = {
  mainEl: Accessor<HTMLElement | undefined>
  outputGeom: Accessor<{ w: number; h: number } | null>
  layoutCanvasOrigin: Accessor<{ x: number; y: number } | null>
  taskbarScreens: Accessor<readonly LayoutScreen[]>
  taskbarHeight: number
  windows: Accessor<readonly DerpWindow[]>
  isWindowVisible?: (window: DerpWindow) => boolean
  onHudChange: (zones: ExclusionHudZone[]) => void
  exclusionReactiveDeps: Accessor<unknown>
}

type ShellExclusionKind = 'base' | 'floating' | 'tray-strip'

type ShellExclusionRect = {
  x: number
  y: number
  w: number
  h: number
  window_id?: number
}

type ShellExclusionEntry = {
  kind: ShellExclusionKind
  label: string
  measure: (frame: ShellMeasureFrame) => ShellExclusionRect | null
  cached: ShellExclusionRect | null
}

type ShellExclusionRegistration = {
  invalidate: () => void
  unregister: () => void
}

const exclusionRegistry = new Map<number, ShellExclusionEntry>()
const dirtyExclusionTokens = new Set<number>()
let nextExclusionToken = 1
let exclusionStructureDirty = false
let exclusionScheduler: (() => void) | null = null

function scheduleExclusionRegistrySync() {
  exclusionScheduler?.()
}

function markShellExclusionTokenDirty(token: number) {
  if (!exclusionRegistry.has(token)) return
  dirtyExclusionTokens.add(token)
  scheduleExclusionRegistrySync()
}

export function invalidateAllShellExclusionRects() {
  for (const token of exclusionRegistry.keys()) dirtyExclusionTokens.add(token)
  scheduleExclusionRegistrySync()
}

export function registerShellExclusionRect(
  kind: ShellExclusionKind,
  label: string,
  measure: (frame: ShellMeasureFrame) => ShellExclusionRect | null,
): ShellExclusionRegistration {
  const token = nextExclusionToken++
  exclusionRegistry.set(token, { kind, label, measure, cached: null })
  exclusionStructureDirty = true
  dirtyExclusionTokens.add(token)
  scheduleExclusionRegistrySync()
  return {
    invalidate: () => markShellExclusionTokenDirty(token),
    unregister: () => {
      exclusionRegistry.delete(token)
      dirtyExclusionTokens.delete(token)
      exclusionStructureDirty = true
      scheduleExclusionRegistrySync()
    },
  }
}

function readShellExclusionRegistry(frame: ShellMeasureFrame) {
  for (const token of dirtyExclusionTokens) {
    const entry = exclusionRegistry.get(token)
    if (!entry) continue
    entry.cached = entry.measure(frame)
  }
  dirtyExclusionTokens.clear()
  exclusionStructureDirty = false
  const base: Array<ShellExclusionRect & { label: string }> = []
  const floating: Array<ShellExclusionRect & { label: string }> = []
  let tray_strip: ShellExclusionRect | null = null
  for (const entry of exclusionRegistry.values()) {
    if (!entry.cached) continue
    if (entry.kind === 'tray-strip') {
      tray_strip = entry.cached
    } else if (entry.kind === 'floating') {
      floating.push({ label: entry.label, ...entry.cached })
    } else {
      base.push({ label: entry.label, ...entry.cached })
    }
  }
  return { base, floating, tray_strip }
}

function measureElement(frame: ShellMeasureFrame, el: Element): ShellExclusionRect | null {
  if (!el.isConnected) return null
  noteShellDomMeasure()
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return null
  const z = clientRectToGlobalLogical(frame.mainRect, r, frame.outputGeom.w, frame.outputGeom.h, frame.origin)
  return { x: z.x, y: z.y, w: z.w, h: z.h }
}

function sameExclusionRect(left: ShellExclusionRect, right: ShellExclusionRect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.w === right.w &&
    left.h === right.h &&
    (left.window_id ?? 0) === (right.window_id ?? 0)
  )
}

function sameExclusionRectArray(
  left: readonly ShellExclusionRect[],
  right: readonly ShellExclusionRect[],
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (!sameExclusionRect(left[index]!, right[index]!)) return false
  }
  return true
}

function sameTrayStrip(left: ShellExclusionRect | null, right: ShellExclusionRect | null): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return sameExclusionRect(left, right)
}

function cloneExclusionRectArray(rects: readonly ShellExclusionRect[]): ShellExclusionRect[] {
  return rects.map((rect) => ({ ...rect }))
}

export function registerShellExclusionElement(
  kind: ShellExclusionKind,
  label: string,
  el: Element,
): ShellExclusionRegistration {
  const registration = registerShellExclusionRect(kind, label, (frame) => measureElement(frame, el))
  const resizeObserver =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => registration.invalidate()) : null
  resizeObserver?.observe(el)
  return {
    invalidate: registration.invalidate,
    unregister: () => {
      resizeObserver?.disconnect()
      registration.unregister()
    },
  }
}

export function createShellExclusionSync(options: ShellExclusionSyncOptions) {
  let exclusionZonesRaf = 0
  let lastExclusionStamp: string | null = null
  let lastExclusionBase: ShellExclusionRect[] | null = null
  let lastExclusionTrayStrip: ShellExclusionRect | null = null
  let lastExclusionOverlayOpen = false
  let lastExclusionFloating: ShellExclusionRect[] | null = null
  let pendingExclusionStateWrite = false
  const isWindowVisible = (window: DerpWindow) => options.isWindowVisible?.(window) ?? true

  const fullscreenTaskbarExclusionSig = () => {
    for (const window of options.windows()) {
      if (!isWindowVisible(window) || window.minimized || !window.fullscreen) continue
    }
    return options
      .taskbarScreens()
      .map((screen) => `${screen.name}:${screenTaskbarHiddenForFullscreen(screen) ? 1 : 0}`)
      .join('|')
  }

  function screenTaskbarHiddenForFullscreen(screen: LayoutScreen) {
    return options.windows().some((window) =>
      isWindowVisible(window) &&
      !window.minimized &&
      window.fullscreen &&
      (window.output_name === screen.name || (!!screen.identity && window.output_id === screen.identity)),
    )
  }

  function syncExclusionZonesNow() {
    void options.exclusionReactiveDeps()
    if (
      !pendingExclusionStateWrite &&
      !exclusionStructureDirty &&
      dirtyExclusionTokens.size === 0 &&
      lastExclusionBase !== null
    )
      return
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
    const frame = currentShellMeasureFrame() ?? createShellMeasureFrame({ main, outputGeom: og, origin: co })
    if (!frame) return
    const snapshot = readShellExclusionRegistry(frame)
    const taskbarBase = options
      .taskbarScreens()
      .filter((screen) => !screenTaskbarHiddenForFullscreen(screen))
      .map((screen) => ({
        label: `taskbar:${screen.name}`,
        x: screen.x,
        y: screen.y + screen.height - options.taskbarHeight,
        w: screen.width,
        h: options.taskbarHeight,
      }))
    const rects = [
      ...taskbarBase.map(({ label: _label, ...rect }) => rect),
      ...snapshot.base.map(({ label: _label, ...rect }) => rect),
    ]
    const floatingRaw = snapshot.floating.map(({ label: _label, ...rect }) => rect)
    const hud: ExclusionHudZone[] = [
      ...taskbarBase.map(({ label, ...rect }) => ({ label, ...rect })),
      ...snapshot.base.map(({ label, ...rect }) => ({ label, ...rect })),
      ...snapshot.floating.map(({ label, ...rect }) => ({ label, ...rect })),
    ]
    const overlayOpen = floatingRaw.length > 0
    const mergedBase = mergeExclusionRects([...rects, ...floatingRaw])
    options.onHudChange(hud)
    const floatingForPayload = mergeExclusionRects(floatingRaw)
    const stamp = sharedShellStateStampKey()
    if (
      !pendingExclusionStateWrite &&
      lastExclusionBase !== null &&
      lastExclusionFloating !== null &&
      stamp === lastExclusionStamp &&
      overlayOpen === lastExclusionOverlayOpen &&
      sameTrayStrip(snapshot.tray_strip, lastExclusionTrayStrip) &&
      sameExclusionRectArray(mergedBase, lastExclusionBase) &&
      sameExclusionRectArray(floatingForPayload, lastExclusionFloating)
    ) {
      pendingExclusionStateWrite = false
      return
    }
    if (!writeShellExclusionState(mergedBase, snapshot.tray_strip, overlayOpen, floatingForPayload)) {
      pendingExclusionStateWrite = true
      return
    }
    pendingExclusionStateWrite = false
    lastExclusionStamp = stamp
    lastExclusionBase = cloneExclusionRectArray(mergedBase)
    lastExclusionTrayStrip = snapshot.tray_strip ? { ...snapshot.tray_strip } : null
    lastExclusionOverlayOpen = overlayOpen
    lastExclusionFloating = cloneExclusionRectArray(floatingForPayload)
  }

  function scheduleExclusionZonesSync() {
    if (exclusionZonesRaf) return
    exclusionZonesRaf = requestAnimationFrame(() => {
      exclusionZonesRaf = 0
      syncExclusionZonesNow()
    })
  }

  createEffect(() => {
    fullscreenTaskbarExclusionSig()
    invalidateAllShellExclusionRects()
    queueMicrotask(() => scheduleExclusionZonesSync())
  })

  createEffect(() => {
    options.outputGeom()
    options.layoutCanvasOrigin()
    invalidateAllShellExclusionRects()
    queueMicrotask(() => scheduleExclusionZonesSync())
  })

  createEffect(() => {
    options.exclusionReactiveDeps()
    invalidateAllShellExclusionRects()
    queueMicrotask(() => scheduleExclusionZonesSync())
  })

  createEffect(() => {
    const main = options.mainEl()
    if (!main) {
      options.onHudChange([])
      return
    }
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => scheduleExclusionZonesSync()) : null
    resizeObserver?.observe(main, { box: 'border-box' })
    queueMicrotask(() => scheduleExclusionZonesSync())
    onCleanup(() => resizeObserver?.disconnect())
  })

  onCleanup(() => {
    if (exclusionScheduler === scheduleExclusionZonesSync) exclusionScheduler = null
    if (exclusionZonesRaf) cancelAnimationFrame(exclusionZonesRaf)
  })

  exclusionScheduler = scheduleExclusionZonesSync

  return {
    scheduleExclusionZonesSync,
    syncExclusionZonesNow,
  }
}
