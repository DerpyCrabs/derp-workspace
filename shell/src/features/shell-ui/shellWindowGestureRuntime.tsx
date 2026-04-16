import {
  CHROME_BORDER_PX,
  SHELL_LAYOUT_FLOATING,
  SHELL_LAYOUT_MAXIMIZED,
  SHELL_RESIZE_BOTTOM,
  SHELL_RESIZE_LEFT,
  SHELL_RESIZE_RIGHT,
  SHELL_RESIZE_TOP,
} from '@/lib/chromeConstants'
import { shellOuterFrameFromClient } from '@/lib/exclusionRects'
import {
  clientPointToCanvasLocal,
  clientPointToGlobalLogical,
  clientPointerDeltaToCanvasLogical,
  pickScreenForPointerSnap,
  pickScreenForWindow,
  rectGlobalToCanvasLocal,
} from '@/lib/shellCoords'
import {
  assistGridGutterPx,
  assistShapeFromSpan,
  assistSpanFromWorkAreaPoint,
  DEFAULT_ASSIST_GRID_SHAPE,
  snapZoneAndPreviewFromAssistSpan,
  type AssistGridShape,
  type AssistGridSpan,
} from '@/features/tiling/assistGrid'
import { SnapAssistPicker } from '@/features/tiling/SnapAssistPicker'
import { hitTestSnapZoneGlobal, monitorWorkAreaGlobal, TILE_SNAP_EDGE_PX } from '@/features/tiling/tileSnap'
import {
  computeTiledResizeRects,
  findEdgeNeighborsInMap,
  TILE_RESIZE_EDGE_ALIGN_PX,
  TILED_RESIZE_MIN_H,
  TILED_RESIZE_MIN_W,
} from '@/features/tiling/tileState'
import { snapZoneToBoundsWithOccupied, type Rect as TileRect, type SnapZone } from '@/features/tiling/tileZones'
import { getMonitorLayout } from '@/features/tiling/tilingConfig'
import { screensListForLayout, shellMaximizedWorkAreaGlobalRect } from '@/host/appLayout'
import type { DerpWindow } from '@/host/appWindowState'
import {
  SHELL_WINDOW_FLAG_SHELL_HOSTED,
  type ShellUiMeasureEnv,
} from '@/features/shell-ui/shellUiWindows'
import type {
  AssistOverlayState,
  LayoutScreen,
  SnapAssistPickerAnchorRect,
  SnapAssistPickerSource,
  SnapAssistPickerState,
  SnapAssistStripState,
} from '@/host/types'
import { createEffect, createMemo, createSignal, Show, type Accessor } from 'solid-js'

type SnapAssistContext = {
  windowId: number
  screen: LayoutScreen
  workGlobal: { x: number; y: number; w: number; h: number }
  workCanvas: { x: number; y: number; w: number; h: number }
  shape: AssistGridShape
}

type ShellResizeSession =
  | { kind: 'compositor'; windowId: number; lastX: number; lastY: number }
  | {
      kind: 'tiled'
      windowId: number
      lastX: number
      lastY: number
      edges: number
      accumDx: number
      accumDy: number
      initialRects: Map<number, TileRect>
      outputName: string
    }

type WindowRect = { x: number; y: number; w: number; h: number }

type ShellWindowGestureRuntimeOptions = {
  getMainRef: () => HTMLElement | undefined
  outputGeom: Accessor<{ w: number; h: number } | null>
  layoutCanvasOrigin: Accessor<{ x: number; y: number } | null>
  screenDraftRows: Accessor<LayoutScreen[]>
  allWindowsMap: Accessor<ReadonlyMap<number, DerpWindow>>
  reserveTaskbarForMon: (mon: LayoutScreen) => boolean
  occupiedSnapZonesOnMonitor: (mon: LayoutScreen, excludeWindowId: number) => { zone: SnapZone; bounds: TileRect }[]
  sendSetMonitorTile: (windowId: number, outputName: string, zone: SnapZone, bounds: TileRect) => boolean
  sendSetPreTileGeometry: (windowId: number, bounds: WindowRect) => boolean
  sendRemoveMonitorTile: (windowId: number) => boolean
  sendClearPreTileGeometry: (windowId: number) => boolean
  workspacePreTileSnapshot: (windowId: number) => WindowRect | null
  workspaceTiledRectMap: (outputName: string) => Map<number, TileRect>
  workspaceTiledZone: (windowId: number) => SnapZone | null
  isWorkspaceWindowTiled: (windowId: number) => boolean
  workspaceFindMonitorForTiledWindow: (windowId: number) => string | null
  scheduleExclusionZonesSync: () => void
  syncExclusionZonesNow: () => void
  flushShellUiWindowsSyncNow: () => void
  bumpSnapChrome: () => void
  floatBeforeMaximize: Map<number, WindowRect>
  shellWireSend: (
    op:
      | 'move_begin'
      | 'move_delta'
      | 'move_end'
      | 'resize_begin'
      | 'resize_delta'
      | 'resize_end'
      | 'resize_shell_grab_begin'
      | 'resize_shell_grab_end'
      | 'set_geometry'
      | 'set_maximized'
      | 'set_tile_preview',
    arg?: number | string,
    arg2?: number | string,
    arg3?: number,
    arg4?: number,
    arg5?: number,
    arg6?: number,
  ) => boolean
  shellMoveLog: (msg: string, detail?: Record<string, unknown>) => void
}

export function createShellWindowGestureRuntime(options: ShellWindowGestureRuntimeOptions) {
  const [assistOverlay, setAssistOverlay] = createSignal<AssistOverlayState | null>(null)
  const [snapAssistPicker, setSnapAssistPicker] = createSignal<SnapAssistPickerState | null>(null)
  const [dragWindowId, setDragWindowId] = createSignal<number | null>(null)
  const dragPreTileSnapshot = new Map<number, WindowRect>()
  let activeSnapPreviewCanvas: WindowRect | null = null
  let activeSnapZone: SnapZone | null = null
  let activeSnapScreen: LayoutScreen | null = null
  let activeSnapWindowId: number | null = null
  let tilePreviewRaf = 0
  let lastTilePreviewKey = ''
  let shellWindowDrag: { windowId: number; lastX: number; lastY: number } | null = null
  let shellMoveDeltaLogSeq = 0
  let shellWindowResize: ShellResizeSession | null = null
  let shellResizeDeltaLogSeq = 0

  function snapAssistAnchorRect(rect: DOMRect): SnapAssistPickerAnchorRect {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    }
  }

  function resetSnapAssistState() {
    activeSnapPreviewCanvas = null
    activeSnapZone = null
    activeSnapScreen = null
    activeSnapWindowId = null
  }

  function clearTilePreviewWire() {
    if (tilePreviewRaf) {
      cancelAnimationFrame(tilePreviewRaf)
      tilePreviewRaf = 0
    }
    lastTilePreviewKey = ''
    options.shellWireSend('set_tile_preview', 0, 0, 0, 0, 0)
  }

  function clearSnapAssistSelection() {
    resetSnapAssistState()
    setAssistOverlay(null)
    scheduleTilePreviewSync()
  }

  function closeSnapAssistPicker() {
    setSnapAssistPicker(null)
    clearSnapAssistSelection()
  }

  function resolveSnapAssistContext(
    windowId: number,
    preferredMonitorName?: string | null,
    shape: AssistGridShape = DEFAULT_ASSIST_GRID_SHAPE,
  ): SnapAssistContext | null {
    const window = options.allWindowsMap().get(windowId)
    if (!window || window.minimized) return null
    const canvas = options.outputGeom()
    const origin = options.layoutCanvasOrigin()
    const screens = screensListForLayout(options.screenDraftRows(), canvas, origin)
    if (screens.length === 0) return null
    const screen =
      (preferredMonitorName ? screens.find((entry) => entry.name === preferredMonitorName) : undefined) ??
      pickScreenForWindow(window, screens, origin) ??
      screens[0]
    if (!screen || getMonitorLayout(screen.name).layout.type !== 'manual-snap') return null
    const reserveTaskbar = options.reserveTaskbarForMon(screen)
    const workGlobal = monitorWorkAreaGlobal(screen, reserveTaskbar)
    return {
      windowId,
      screen,
      workGlobal,
      workCanvas: rectGlobalToCanvasLocal(workGlobal.x, workGlobal.y, workGlobal.w, workGlobal.h, origin),
      shape,
    }
  }

  function applySnapAssistZonePreview(
    context: SnapAssistContext,
    zone: SnapZone,
    previewRect: TileRect,
  ) {
    const origin = options.layoutCanvasOrigin()
    activeSnapZone = zone
    activeSnapScreen = context.screen
    activeSnapWindowId = context.windowId
    const o = shellOuterFrameFromClient({
      x: previewRect.x,
      y: previewRect.y,
      width: previewRect.width,
      height: previewRect.height,
      maximized: false,
      fullscreen: false,
      minimized: false,
      snap_tiled: true,
    })
    activeSnapPreviewCanvas = rectGlobalToCanvasLocal(o.x, o.y, o.w, o.h, origin)
  }

  function updateSnapAssistFromSpan(context: SnapAssistContext, span: AssistGridSpan | null) {
    const shape = span ? assistShapeFromSpan(span) : context.shape
    if (!span || !shape) {
      clearSnapAssistSelection()
      return
    }
    const { zone, previewRect } = snapZoneAndPreviewFromAssistSpan(span, shape, context.workGlobal)
    applySnapAssistZonePreview(context, zone, previewRect)
    setAssistOverlay({
      shape,
      gutterPx: assistGridGutterPx(context.workGlobal, shape),
      hoverSpan: span,
      workCanvas: context.workCanvas,
    })
    scheduleTilePreviewSync()
  }

  function updateSnapAssistFromEdgeZone(context: SnapAssistContext, zone: SnapZone | null) {
    if (!zone) {
      clearSnapAssistSelection()
      return
    }
    const workRect: TileRect = {
      x: context.workGlobal.x,
      y: context.workGlobal.y,
      width: context.workGlobal.w,
      height: context.workGlobal.h,
    }
    const previewRect = snapZoneToBoundsWithOccupied(
      zone,
      workRect,
      options.occupiedSnapZonesOnMonitor(context.screen, context.windowId),
    )
    applySnapAssistZonePreview(context, zone, previewRect)
    setAssistOverlay(null)
    scheduleTilePreviewSync()
  }

  function commitSnapAssistSelection(windowId: number, closePicker = false) {
    const snapWindowId = activeSnapWindowId ?? windowId
    const droppedZone = activeSnapZone
    const snapScreen = activeSnapScreen
    resetSnapAssistState()
    setAssistOverlay(null)
    if (closePicker) setSnapAssistPicker(null)
    clearTilePreviewWire()
    if (droppedZone === null || !snapScreen) {
      dragPreTileSnapshot.delete(snapWindowId)
      return
    }
    const currentWindow = options.allWindowsMap().get(snapWindowId)
    const preTile =
      dragPreTileSnapshot.get(snapWindowId) ??
      options.workspacePreTileSnapshot(snapWindowId) ??
      (currentWindow
        ? {
            x: currentWindow.x,
            y: currentWindow.y,
            w: currentWindow.width,
            h: currentWindow.height,
          }
        : null)
    const origin = options.layoutCanvasOrigin()
    const reserveTaskbar = options.reserveTaskbarForMon(snapScreen)
    const work = monitorWorkAreaGlobal(snapScreen, reserveTaskbar)
    const workRect: TileRect = { x: work.x, y: work.y, width: work.w, height: work.h }
    const occupied = options.occupiedSnapZonesOnMonitor(snapScreen, snapWindowId)
    const globalBounds = snapZoneToBoundsWithOccupied(droppedZone, workRect, occupied)
    if (
      preTile
        ? !options.sendSetPreTileGeometry(snapWindowId, preTile)
        : !options.sendClearPreTileGeometry(snapWindowId)
    ) {
      return
    }
    if (!options.sendSetMonitorTile(snapWindowId, snapScreen.name, droppedZone, globalBounds)) return
    const localBounds = rectGlobalToCanvasLocal(
      globalBounds.x,
      globalBounds.y,
      globalBounds.width,
      globalBounds.height,
      origin,
    )
    options.shellWireSend(
      'set_geometry',
      snapWindowId,
      localBounds.x,
      localBounds.y,
      localBounds.w,
      localBounds.h,
      SHELL_LAYOUT_FLOATING,
    )
    dragPreTileSnapshot.delete(snapWindowId)
    options.scheduleExclusionZonesSync()
    options.bumpSnapChrome()
  }

  function openSnapAssistPicker(
    windowId: number,
    source: SnapAssistPickerSource,
    anchorRect: DOMRect,
    autoHover = true,
    preferredMonitorName?: string | null,
  ) {
    const context = resolveSnapAssistContext(windowId, preferredMonitorName)
    if (!context) return
    clearSnapAssistSelection()
    setSnapAssistPicker({
      windowId,
      monitorName: context.screen.name,
      source,
      anchorRect: snapAssistAnchorRect(anchorRect),
      autoHover,
    })
  }

  function flushTilePreviewWire() {
    tilePreviewRaf = 0
    if (snapAssistPicker()) {
      if (lastTilePreviewKey !== '0') {
        lastTilePreviewKey = '0'
        options.shellWireSend('set_tile_preview', 0, 0, 0, 0, 0)
      }
      return
    }
    const snap = activeSnapPreviewCanvas
    if (!snap) {
      if (lastTilePreviewKey !== '0') {
        lastTilePreviewKey = '0'
        options.shellWireSend('set_tile_preview', 0, 0, 0, 0, 0)
      }
      return
    }
    const key = `${snap.x},${snap.y},${snap.w},${snap.h}`
    if (key !== lastTilePreviewKey) {
      lastTilePreviewKey = key
      options.shellWireSend('set_tile_preview', 1, snap.x, snap.y, snap.w, snap.h)
    }
  }

  function scheduleTilePreviewSync() {
    if (tilePreviewRaf) return
    tilePreviewRaf = requestAnimationFrame(() => flushTilePreviewWire())
  }

  function toggleShellMaximizeForWindow(windowId: number) {
    const window = options.allWindowsMap().get(windowId)
    if (!window) return
    if (window.maximized) {
      options.shellWireSend('set_maximized', windowId, 0)
      return
    }
    if (!options.sendRemoveMonitorTile(windowId)) return
    if (!options.sendClearPreTileGeometry(windowId)) return
    options.bumpSnapChrome()
    options.scheduleExclusionZonesSync()
    options.floatBeforeMaximize.set(windowId, {
      x: window.x,
      y: window.y,
      w: window.width,
      h: window.height,
    })
    const list = screensListForLayout(
      options.screenDraftRows(),
      options.outputGeom(),
      options.layoutCanvasOrigin(),
    )
    const monitor = pickScreenForWindow(window, list, options.layoutCanvasOrigin()) ?? list[0] ?? null
    if (!monitor) return
    const reserveTaskbar = options.reserveTaskbarForMon(monitor)
    const rect = shellMaximizedWorkAreaGlobalRect(monitor, reserveTaskbar)
    options.shellWireSend('set_geometry', windowId, rect.x, rect.y, rect.w, rect.h, SHELL_LAYOUT_MAXIMIZED)
  }

  function beginShellWindowMove(windowId: number, clientX: number, clientY: number) {
    if (shellWindowResize !== null) return
    options.shellMoveLog('titlebar_begin_request', { windowId, clientX, clientY })
    shellMoveDeltaLogSeq = 0
    closeSnapAssistPicker()
    clearTilePreviewWire()
    const main = options.getMainRef()
    const output = options.outputGeom()
    const window = options.allWindowsMap().get(windowId)
    if (main && output && window) {
      const mainRect = main.getBoundingClientRect()
      const pointerCanvas = clientPointToCanvasLocal(clientX, clientY, mainRect, output.w, output.h)
      const origin = options.layoutCanvasOrigin()
      if (window.maximized) {
        const restore = options.floatBeforeMaximize.get(windowId) ?? {
          x: window.x,
          y: window.y,
          w: Math.max(360, Math.floor(window.width * 0.55)),
          h: Math.max(280, Math.floor(window.height * 0.55)),
        }
        const list = screensListForLayout(options.screenDraftRows(), options.outputGeom(), origin)
        const globalPointer = clientPointToGlobalLogical(clientX, clientY, mainRect, output.w, output.h, origin)
        const monitor = pickScreenForPointerSnap(globalPointer.x, globalPointer.y, list)
        let maxCanvasX = window.x
        let maxCanvasY = window.y
        if (monitor) {
          const reserveTaskbar = options.reserveTaskbarForMon(monitor)
          const rect = shellMaximizedWorkAreaGlobalRect(monitor, reserveTaskbar)
          const local = rectGlobalToCanvasLocal(rect.x, rect.y, rect.w, rect.h, origin)
          maxCanvasX = local.x
          maxCanvasY = local.y
        }
        const grabDx = pointerCanvas.x - maxCanvasX
        const grabDy = pointerCanvas.y - maxCanvasY
        const nextX = pointerCanvas.x - grabDx + CHROME_BORDER_PX
        const nextY = pointerCanvas.y - grabDy + CHROME_BORDER_PX
        options.shellWireSend('set_geometry', windowId, nextX, nextY, restore.w, restore.h, SHELL_LAYOUT_FLOATING)
        options.floatBeforeMaximize.delete(windowId)
        dragPreTileSnapshot.set(windowId, { x: nextX, y: nextY, w: restore.w, h: restore.h })
        options.scheduleExclusionZonesSync()
        options.bumpSnapChrome()
      } else if (options.isWorkspaceWindowTiled(windowId)) {
        const preTile = options.workspacePreTileSnapshot(windowId)
        if (preTile) {
          const grabDx = pointerCanvas.x - window.x
          const grabDy = pointerCanvas.y - window.y
          const nextX = pointerCanvas.x - grabDx + CHROME_BORDER_PX
          const nextY = pointerCanvas.y - grabDy + CHROME_BORDER_PX
          options.shellWireSend('set_geometry', windowId, nextX, nextY, preTile.w, preTile.h, SHELL_LAYOUT_FLOATING)
        }
        if (!options.sendRemoveMonitorTile(windowId)) return
        if (!options.sendClearPreTileGeometry(windowId)) return
        dragPreTileSnapshot.set(windowId, preTile ?? { x: window.x, y: window.y, w: window.width, h: window.height })
        options.scheduleExclusionZonesSync()
        options.bumpSnapChrome()
      } else {
        dragPreTileSnapshot.set(windowId, { x: window.x, y: window.y, w: window.width, h: window.height })
      }
    }
    if (!options.shellWireSend('move_begin', windowId)) {
      options.shellMoveLog('titlebar_begin_aborted', { windowId, reason: 'no __derpShellWireSend' })
      return
    }
    shellWindowDrag = { windowId, lastX: Math.round(clientX), lastY: Math.round(clientY) }
    setDragWindowId(windowId)
    options.shellMoveLog('titlebar_begin_armed', { windowId, clientX, clientY })
  }

  function applyShellWindowMove(clientX: number, clientY: number) {
    if (!shellWindowDrag) return
    const cx = Math.round(clientX)
    const cy = Math.round(clientY)
    const dClientX = cx - shellWindowDrag.lastX
    const dClientY = cy - shellWindowDrag.lastY
    const windowId = shellWindowDrag.windowId
    if (dClientX !== 0 || dClientY !== 0) {
      const main = options.getMainRef()
      const output = options.outputGeom()
      const { dx, dy } =
        main && output
          ? clientPointerDeltaToCanvasLogical(dClientX, dClientY, main.getBoundingClientRect(), output.w, output.h)
          : { dx: dClientX, dy: dClientY }
      if (dx !== 0 || dy !== 0) {
        shellMoveDeltaLogSeq += 1
        if (shellMoveDeltaLogSeq <= 12 || shellMoveDeltaLogSeq % 30 === 0) {
          options.shellMoveLog('titlebar_delta', { seq: shellMoveDeltaLogSeq, dx, dy, clientX, clientY })
        }
        options.shellWireSend('move_delta', dx, dy)
      }
      shellWindowDrag.lastX = cx
      shellWindowDrag.lastY = cy
    }
    const main = options.getMainRef()
    const output = options.outputGeom()
    const origin = options.layoutCanvasOrigin()
    if (!main || !output) return
    const mainRect = main.getBoundingClientRect()
    const global = clientPointToGlobalLogical(cx, cy, mainRect, output.w, output.h, origin)
    const list = screensListForLayout(options.screenDraftRows(), options.outputGeom(), origin)
    const monitor = pickScreenForPointerSnap(global.x, global.y, list)
    const pickerEl = main.querySelector('[data-shell-snap-picker]') as HTMLElement | null
    const pickerOpen = snapAssistPicker()?.source === 'strip' && snapAssistPicker()?.windowId === windowId
    if (pickerEl) {
      const pickerRect = pickerEl.getBoundingClientRect()
      if (
        pickerOpen &&
        cx >= pickerRect.left &&
        cx <= pickerRect.right &&
        cy >= pickerRect.top &&
        cy <= pickerRect.bottom
      ) {
        return
      }
    }
    const stripEl = main.querySelector('[data-shell-snap-strip-trigger]') as HTMLElement | null
    if (stripEl) {
      const stripRect = stripEl.getBoundingClientRect()
      if (cx >= stripRect.left && cx <= stripRect.right && cy >= stripRect.top && cy <= stripRect.bottom) {
        if (!pickerOpen) {
          openSnapAssistPicker(windowId, 'strip', stripRect, false, monitor?.name)
        }
        return
      }
    }
    if (pickerOpen) {
      closeSnapAssistPicker()
    }
    if (!monitor) {
      clearSnapAssistSelection()
      return
    }
    const context = resolveSnapAssistContext(windowId, monitor.name)
    if (!context) {
      clearSnapAssistSelection()
      return
    }
    const work = context.workGlobal
    const inAssistTopStrip =
      global.x >= work.x &&
      global.x <= work.x + work.w &&
      ((global.y >= work.y && global.y <= work.y + TILE_SNAP_EDGE_PX) ||
        (global.y < work.y && work.y - global.y <= TILE_SNAP_EDGE_PX))

    if (inAssistTopStrip) {
      const pxForAssist = Math.max(work.x, Math.min(global.x, work.x + work.w))
      const pyForAssist = Math.max(work.y, Math.min(global.y, work.y + work.h))
      const span = assistSpanFromWorkAreaPoint(pxForAssist, pyForAssist, context.shape, work)
      updateSnapAssistFromSpan(context, span)
      return
    }

    const zone = hitTestSnapZoneGlobal(global.x, global.y, work)
    updateSnapAssistFromEdgeZone(context, zone)
  }

  function endShellWindowMove(reason: string) {
    if (!shellWindowDrag) return
    const windowId = shellWindowDrag.windowId
    options.shellMoveLog('titlebar_end', { windowId, reason })
    shellWindowDrag = null
    setDragWindowId(null)
    commitSnapAssistSelection(
      windowId,
      snapAssistPicker()?.source === 'strip' && snapAssistPicker()?.windowId === windowId,
    )
    options.shellWireSend('move_end', windowId)
  }

  function beginShellWindowResize(windowId: number, edges: number, clientX: number, clientY: number) {
    if (shellWindowResize !== null || shellWindowDrag !== null) return
    shellResizeDeltaLogSeq = 0
    const monitorName = options.workspaceFindMonitorForTiledWindow(windowId)
    const tolerance = TILE_RESIZE_EDGE_ALIGN_PX
    let useTiledPropagate = false
    const initialRects = new Map<number, TileRect>()
    if (monitorName !== null) {
      const rects = options.workspaceTiledRectMap(monitorName)
      const dirs: Array<'left' | 'right' | 'top' | 'bottom'> = []
      if (edges & SHELL_RESIZE_LEFT) dirs.push('left')
      if (edges & SHELL_RESIZE_RIGHT) dirs.push('right')
      if (edges & SHELL_RESIZE_TOP) dirs.push('top')
      if (edges & SHELL_RESIZE_BOTTOM) dirs.push('bottom')
      const seen = new Set<number>([windowId])
      for (const dir of dirs) {
        for (const neighborId of findEdgeNeighborsInMap(rects, windowId, dir, tolerance)) {
          seen.add(neighborId)
        }
      }
      if (seen.size > 1) {
        useTiledPropagate = true
        for (const seenId of seen) {
          const rect = rects.get(seenId)
          if (rect) initialRects.set(seenId, { ...rect })
        }
      }
    }
    if (useTiledPropagate && monitorName !== null) {
      if (!options.shellWireSend('resize_shell_grab_begin', windowId)) return
      shellWindowResize = {
        kind: 'tiled',
        windowId,
        lastX: Math.round(clientX),
        lastY: Math.round(clientY),
        edges,
        accumDx: 0,
        accumDy: 0,
        initialRects,
        outputName: monitorName,
      }
      options.shellMoveLog('resize_begin_tiled', { windowId, edges, clientX, clientY })
      return
    }
    if (!options.shellWireSend('resize_begin', windowId, edges)) return
    shellWindowResize = {
      kind: 'compositor',
      windowId,
      lastX: Math.round(clientX),
      lastY: Math.round(clientY),
    }
    options.shellMoveLog('resize_begin', { windowId, edges, clientX, clientY })
  }

  function applyShellWindowResize(clientX: number, clientY: number) {
    if (!shellWindowResize) return
    const cx = Math.round(clientX)
    const cy = Math.round(clientY)
    const dClientX = cx - shellWindowResize.lastX
    const dClientY = cy - shellWindowResize.lastY
    if (dClientX === 0 && dClientY === 0) return
    const main = options.getMainRef()
    const output = options.outputGeom()
    const { dx, dy } =
      main && output
        ? clientPointerDeltaToCanvasLogical(dClientX, dClientY, main.getBoundingClientRect(), output.w, output.h)
        : { dx: dClientX, dy: dClientY }
    if (dx === 0 && dy === 0) {
      shellWindowResize.lastX = cx
      shellWindowResize.lastY = cy
      return
    }
    if (shellWindowResize.kind === 'compositor') {
      shellResizeDeltaLogSeq += 1
      if (shellResizeDeltaLogSeq <= 12 || shellResizeDeltaLogSeq % 30 === 0) {
        options.shellMoveLog('resize_delta', { seq: shellResizeDeltaLogSeq, dx, dy, clientX, clientY })
      }
      options.shellWireSend('resize_delta', dx, dy)
      shellWindowResize.lastX = cx
      shellWindowResize.lastY = cy
      return
    }
    shellWindowResize.accumDx += dx
    shellWindowResize.accumDy += dy
    shellWindowResize.lastX = cx
    shellWindowResize.lastY = cy
    const origin = options.layoutCanvasOrigin()
    const rects = computeTiledResizeRects(
      shellWindowResize.windowId,
      shellWindowResize.edges,
      shellWindowResize.accumDx,
      shellWindowResize.accumDy,
      shellWindowResize.initialRects,
      TILED_RESIZE_MIN_W,
      TILED_RESIZE_MIN_H,
    )
    for (const [windowId, globalRect] of rects) {
      const local = rectGlobalToCanvasLocal(globalRect.x, globalRect.y, globalRect.width, globalRect.height, origin)
      options.shellWireSend('set_geometry', windowId, local.x, local.y, local.w, local.h, SHELL_LAYOUT_FLOATING)
    }
    options.scheduleExclusionZonesSync()
    options.bumpSnapChrome()
  }

  function endShellWindowResize(reason: string) {
    if (!shellWindowResize) return
    const windowId = shellWindowResize.windowId
    if (shellWindowResize.kind === 'compositor') {
      options.shellMoveLog('resize_end', { windowId, reason })
      shellWindowResize = null
      options.shellWireSend('resize_end', windowId)
      return
    }
    const resizeSession = shellWindowResize
    shellWindowResize = null
    options.shellMoveLog('resize_end_tiled', { windowId, reason })
    const rects = computeTiledResizeRects(
      resizeSession.windowId,
      resizeSession.edges,
      resizeSession.accumDx,
      resizeSession.accumDy,
      resizeSession.initialRects,
      TILED_RESIZE_MIN_W,
      TILED_RESIZE_MIN_H,
    )
    for (const [nextWindowId, bounds] of rects) {
      if (
        !options.sendSetMonitorTile(
          nextWindowId,
          resizeSession.outputName,
          options.workspaceTiledZone(nextWindowId) ?? 'auto-fill',
          bounds,
        )
      ) {
        return
      }
    }
    options.bumpSnapChrome()
    options.shellWireSend('resize_shell_grab_end')
  }

  const dragSnapAssistContext = createMemo(() => {
    const windowId = dragWindowId()
    if (windowId == null) return null
    return resolveSnapAssistContext(windowId)
  })

  const snapStripState = createMemo<SnapAssistStripState | null>(() => {
    const context = dragSnapAssistContext()
    if (!context) return null
    return {
      monitorName: context.screen.name,
      open: snapAssistPicker()?.source === 'strip' && snapAssistPicker()?.windowId === context.windowId,
    }
  })

  createEffect(() => {
    snapAssistPicker()
    queueMicrotask(() => {
      scheduleTilePreviewSync()
      options.flushShellUiWindowsSyncNow()
      options.syncExclusionZonesNow()
    })
  })

  createEffect(() => {
    const picker = snapAssistPicker()
    if (!picker) return
    const context = resolveSnapAssistContext(picker.windowId, picker.monitorName)
    if (!context) {
      closeSnapAssistPicker()
    }
  })

  function SnapAssistPickerLayer() {
    const main = options.getMainRef()
    if (!main) return null
    return (
      <Show when={snapAssistPicker()} keyed>
        {(picker) => (
          <SnapAssistPicker
            anchorRect={picker.anchorRect}
            container={main}
            hoverSpan={assistOverlay()?.hoverSpan ?? null}
            autoHover={picker.autoHover}
            shellUiWindowId={
              (options.allWindowsMap().get(picker.windowId)?.shell_flags ?? 0) & SHELL_WINDOW_FLAG_SHELL_HOSTED
                ? picker.windowId
                : undefined
            }
            shellUiWindowZ={(options.allWindowsMap().get(picker.windowId)?.stack_z ?? 0) + 1}
            getShellUiMeasureEnv={() => {
              const nextMain = options.getMainRef()
              const output = options.outputGeom()
              const origin = options.layoutCanvasOrigin()
              if (!nextMain || !output || !origin) return null
              return {
                main: nextMain,
                outputGeom: { w: output.w, h: output.h },
                origin,
              } satisfies ShellUiMeasureEnv
            }}
            onHoverSpanChange={(span) => {
              const context = resolveSnapAssistContext(picker.windowId, picker.monitorName)
              if (!context) {
                closeSnapAssistPicker()
                return
              }
              updateSnapAssistFromSpan(context, span)
            }}
            onSelectSpan={(span) => {
              const context = resolveSnapAssistContext(picker.windowId, picker.monitorName)
              if (!context) {
                closeSnapAssistPicker()
                return
              }
              updateSnapAssistFromSpan(context, span)
              commitSnapAssistSelection(picker.windowId, true)
            }}
            onClose={closeSnapAssistPicker}
          />
        )}
      </Show>
    )
  }

  return {
    assistOverlay,
    snapAssistPicker,
    dragWindowId,
    dragSnapAssistContext,
    snapStripState,
    getShellWindowDragId: () => shellWindowDrag?.windowId ?? null,
    getShellWindowResizeId: () => shellWindowResize?.windowId ?? null,
    getActiveSnapPreviewCanvas: () => activeSnapPreviewCanvas,
    openSnapAssistPicker,
    closeSnapAssistPicker,
    toggleShellMaximizeForWindow,
    beginShellWindowMove,
    applyShellWindowMove,
    endShellWindowMove,
    beginShellWindowResize,
    applyShellWindowResize,
    endShellWindowResize,
    SnapAssistPickerLayer,
  }
}
