import {
  CHROME_BORDER_PX,
  CHROME_BORDER_TOP_PX,
  SHELL_LAYOUT_FLOATING,
  SHELL_RESIZE_BOTTOM,
  SHELL_RESIZE_LEFT,
  SHELL_RESIZE_RIGHT,
  SHELL_RESIZE_TOP,
} from '@/lib/chromeConstants'
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
  assistGridSpansEqual,
  assistShapeFromSpan,
  assistSpanFromWorkAreaPoint,
  snapZoneAndPreviewFromAssistSpan,
  type AssistGridShape,
  type AssistGridSpan,
} from '@/features/tiling/assistGrid'
import {
  customSnapZoneId,
  parseCustomSnapZoneId,
  resolveCustomLayoutZoneBounds,
  resolveCustomLayoutZoneAtPoint,
  type CustomLayout,
} from '@/features/tiling/customLayouts'
import { SnapAssistPicker, type SnapPickerSelection } from '@/features/tiling/SnapAssistPicker'
import { assistSpanFromMasterGridPoint } from '@/features/tiling/SnapAssistMasterGrid'
import {
  hitTestSnapZoneGlobal,
  monitorTileFrameAreaGlobal,
  tiledFrameRectToClientRect,
  TILE_SNAP_EDGE_PX,
} from '@/features/tiling/tileSnap'
import {
  computeTiledResizeRects,
  findEdgeNeighborsInMap,
  TILE_RESIZE_EDGE_ALIGN_PX,
  TILED_RESIZE_MIN_H,
  TILED_RESIZE_MIN_W,
} from '@/features/tiling/tileState'
import { snapZoneToBoundsWithOccupied, type Rect as TileRect, type SnapZone } from '@/features/tiling/tileZones'
import {
  assistMonitorSnapLayout,
  customMonitorSnapLayout,
  getMonitorLayout,
  setMonitorSnapLayout,
  type MonitorSnapLayout,
} from '@/features/tiling/tilingConfig'
import { screensListForLayout } from '@/host/appLayout'
import type { DerpWindow } from '@/host/appWindowState'
import type { ShellSharedStateSyncRequest } from '@/features/bridge/shellSharedStateSync'
import { SHELL_UI_PORTAL_PICKER_WINDOW_ID, SHELL_WINDOW_FLAG_SHELL_HOSTED } from '@/features/shell-ui/shellUiWindows'
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
  snapLayout: MonitorSnapLayout
  assistShape: AssistGridShape | null
  customLayout: CustomLayout | null
  customLayouts: CustomLayout[]
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
      outputId: string | null
    }

type WindowRect = { x: number; y: number; w: number; h: number }

type ShellDragMeasureCache = {
  main: HTMLElement
  output: { w: number; h: number }
  origin: { x: number; y: number } | null
  mainRect: DOMRect
  screens: LayoutScreen[]
  stripRect: DOMRect | null
  pickerEl: HTMLElement | null
  pickerRect: DOMRect | null
  contexts: Map<string, SnapAssistContext | null>
}

type ShellWindowDragSession = {
  windowId: number
  lastX: number
  lastY: number
  startX: number
  superHeld: boolean
  stripArmed: boolean
  edgeSnapArmed: boolean
  startedTiled: boolean
  startedMaximized: boolean
  measure: ShellDragMeasureCache | null
}

type ShellWindowGestureRuntimeOptions = {
  getMainRef: () => HTMLElement | undefined
  outputGeom: Accessor<{ w: number; h: number } | null>
  layoutCanvasOrigin: Accessor<{ x: number; y: number } | null>
  screenDraftRows: Accessor<LayoutScreen[]>
  windowById: (windowId: number) => Accessor<DerpWindow | undefined>
  reserveTaskbarForMon: (mon: LayoutScreen) => boolean
  occupiedSnapZonesOnMonitor: (mon: LayoutScreen, excludeWindowId: number) => { zone: SnapZone; bounds: TileRect }[]
  sendSetMonitorTile: (windowId: number, outputName: string, zone: SnapZone, bounds: TileRect, outputId?: string | null) => boolean
  sendSetPreTileGeometry: (windowId: number, bounds: WindowRect) => boolean
  sendRemoveMonitorTile: (windowId: number) => boolean
  sendClearPreTileGeometry: (windowId: number) => boolean
  workspacePreTileSnapshot: (windowId: number) => WindowRect | null
  workspaceTiledRectMap: (outputName: string, outputId?: string | null) => Map<number, TileRect>
  workspaceTiledZone: (windowId: number) => SnapZone | null
  isWorkspaceWindowTiled: (windowId: number) => boolean
  workspaceFindMonitorForTiledWindow: (windowId: number) => { outputName: string; outputId: string | null } | null
  requestSharedStateSync: (request: ShellSharedStateSyncRequest, timing?: 'now' | 'microtask') => void
  requestCompositorSync: () => void
  bumpSnapChrome: () => void
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
  clearNativeDragPreview: () => void
}

export function createShellWindowGestureRuntime(options: ShellWindowGestureRuntimeOptions) {
  const [assistOverlay, setAssistOverlay] = createSignal<AssistOverlayState | null>(null)
  const [snapAssistPicker, setSnapAssistPicker] = createSignal<SnapAssistPickerState | null>(null)
  const [snapPickerHoverSelection, setSnapPickerHoverSelection] = createSignal<SnapPickerSelection | null>(null)
  const [dragWindowId, setDragWindowId] = createSignal<number | null>(null)
  const [dragWindowMoved, setDragWindowMoved] = createSignal(false)
  const dragPreTileSnapshot = new Map<number, WindowRect>()
  let activeSnapPreviewCanvas: WindowRect | null = null
  let activeSnapPreviewGlobal: TileRect | null = null
  let activeSnapZone: SnapZone | null = null
  let activeSnapScreen: LayoutScreen | null = null
  let activeSnapWindowId: number | null = null
  let activeSnapLayout: MonitorSnapLayout | null = null
  let recentSnapCandidate:
    | {
        windowId: number
        zone: SnapZone
        screen: LayoutScreen
        layout: MonitorSnapLayout
        previewGlobal: TileRect
        pointerX: number
        pointerY: number
        atMs: number
      }
    | null = null
  let tilePreviewRaf = 0
  let lastTilePreviewKey = ''
  let shellWindowDrag: ShellWindowDragSession | null = null
  let shellMoveDeltaLogSeq = 0
  let shellWindowResize: ShellResizeSession | null = null
  let shellResizeDeltaLogSeq = 0
  const readWindow = (windowId: number) => options.windowById(windowId)()

  function workCanvasEqual(
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ) {
    return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
  }

  function assistOverlayEqual(a: AssistOverlayState | null, b: AssistOverlayState | null) {
    if (a === b) return true
    if (a === null || b === null) return a === b
    if (a.kind !== b.kind) return false
    if (!workCanvasEqual(a.workCanvas, b.workCanvas)) return false
    if (a.kind === 'assist' && b.kind === 'assist') {
      const hoverEqual =
        a.hoverSpan === null
          ? b.hoverSpan === null
          : b.hoverSpan !== null && assistGridSpansEqual(a.hoverSpan, b.hoverSpan)
      return a.shape === b.shape && a.gutterPx === b.gutterPx && hoverEqual
    }
    if (a.kind === 'custom' && b.kind === 'custom') {
      return a.layout.id === b.layout.id && a.selectedZoneId === b.selectedZoneId
    }
    return false
  }

  function setAssistOverlayState(next: AssistOverlayState | null) {
    setAssistOverlay((current) => (assistOverlayEqual(current, next) ? current : next))
  }

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
    activeSnapPreviewGlobal = null
    activeSnapZone = null
    activeSnapScreen = null
    activeSnapWindowId = null
    activeSnapLayout = null
    setSnapPickerHoverSelection(null)
  }

  function rememberRecentSnapCandidate(
    windowId: number,
    zone: SnapZone,
    screen: LayoutScreen,
    snapLayout: MonitorSnapLayout,
    previewRect: TileRect,
  ) {
    recentSnapCandidate = {
      windowId,
      zone,
      screen,
      layout: snapLayout,
      previewGlobal: { ...previewRect },
      pointerX: shellWindowDrag?.lastX ?? 0,
      pointerY: shellWindowDrag?.lastY ?? 0,
      atMs: Date.now(),
    }
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
    setAssistOverlayState(null)
    scheduleTilePreviewSync()
  }

  function closeSnapAssistPicker() {
    setSnapAssistPicker(null)
    if (shellWindowDrag) shellWindowDrag.measure = null
    clearSnapAssistSelection()
  }

  function resolveSnapAssistContextFromScreens(
    windowId: number,
    screens: LayoutScreen[],
    origin: { x: number; y: number } | null,
    preferredMonitorName?: string | null,
  ): SnapAssistContext | null {
    const window = readWindow(windowId)
    if (!window || window.minimized) return null
    if (screens.length === 0) return null
    const screen =
      (preferredMonitorName ? screens.find((entry) => entry.name === preferredMonitorName) : undefined) ??
      pickScreenForWindow(window, screens, origin) ??
      screens[0]
    const monitorLayout = screen ? getMonitorLayout(screen.name) : null
    if (!screen || !monitorLayout || monitorLayout.layout.type !== 'manual-snap') return null
    const reserveTaskbar = options.reserveTaskbarForMon(screen)
    const workGlobal = monitorTileFrameAreaGlobal(screen, reserveTaskbar)
    const snapLayout = monitorLayout.snapLayout
    return {
      windowId,
      screen,
      workGlobal,
      workCanvas: rectGlobalToCanvasLocal(workGlobal.x, workGlobal.y, workGlobal.w, workGlobal.h, origin),
      snapLayout,
      assistShape: snapLayout.kind === 'assist' ? snapLayout.shape : null,
      customLayout:
        snapLayout.kind === 'custom'
          ? monitorLayout.customLayouts.find((layout) => layout.id === snapLayout.layoutId) ?? null
          : null,
      customLayouts: monitorLayout.customLayouts,
    }
  }

  function resolveSnapAssistContext(
    windowId: number,
    preferredMonitorName?: string | null,
  ): SnapAssistContext | null {
    const canvas = options.outputGeom()
    const origin = options.layoutCanvasOrigin()
    const screens = screensListForLayout(options.screenDraftRows(), canvas, origin)
    return resolveSnapAssistContextFromScreens(windowId, screens, origin, preferredMonitorName)
  }

  function readDragMeasure(windowId: number): ShellDragMeasureCache | null {
    const drag = shellWindowDrag?.windowId === windowId ? shellWindowDrag : null
    const main = options.getMainRef()
    const output = options.outputGeom()
    if (!main || !output) return null
    const origin = options.layoutCanvasOrigin()
    const stripEl = main.querySelector('[data-shell-snap-strip-trigger]') as HTMLElement | null
    const pickerEl = main.querySelector('[data-shell-snap-picker]') as HTMLElement | null
    if (drag?.measure) {
      drag.measure.main = main
      drag.measure.output = output
      drag.measure.origin = origin
      drag.measure.mainRect = main.getBoundingClientRect()
      drag.measure.screens = screensListForLayout(options.screenDraftRows(), output, origin)
      drag.measure.stripRect = stripEl?.getBoundingClientRect() ?? null
      drag.measure.pickerEl = pickerEl
      drag.measure.pickerRect = pickerEl?.getBoundingClientRect() ?? null
      drag.measure.contexts.clear()
      return drag.measure
    }
    const measure: ShellDragMeasureCache = {
      main,
      output,
      origin,
      mainRect: main.getBoundingClientRect(),
      screens: screensListForLayout(options.screenDraftRows(), output, origin),
      stripRect: stripEl?.getBoundingClientRect() ?? null,
      pickerEl,
      pickerRect: pickerEl?.getBoundingClientRect() ?? null,
      contexts: new Map(),
    }
    if (drag) drag.measure = measure
    return measure
  }

  function dragContextForMonitor(
    windowId: number,
    measure: ShellDragMeasureCache,
    monitorName: string,
  ): SnapAssistContext | null {
    if (measure.contexts.has(monitorName)) return measure.contexts.get(monitorName) ?? null
    const context = resolveSnapAssistContextFromScreens(windowId, measure.screens, measure.origin, monitorName)
    measure.contexts.set(monitorName, context)
    return context
  }

  function applySnapAssistZonePreview(
    context: SnapAssistContext,
    zone: SnapZone,
    previewRect: TileRect,
    snapLayout: MonitorSnapLayout,
  ) {
    const origin = options.layoutCanvasOrigin()
    activeSnapZone = zone
    activeSnapScreen = context.screen
    activeSnapWindowId = context.windowId
    activeSnapLayout = snapLayout
    activeSnapPreviewGlobal = { ...previewRect }
    rememberRecentSnapCandidate(context.windowId, zone, context.screen, snapLayout, previewRect)
    activeSnapPreviewCanvas = rectGlobalToCanvasLocal(
      previewRect.x,
      previewRect.y,
      previewRect.width,
      previewRect.height,
      origin,
    )
  }

  function applySnapPickerSelection(context: SnapAssistContext, selection: SnapPickerSelection | null) {
    if (!selection) {
      clearSnapAssistSelection()
      return
    }
    setSnapPickerHoverSelection(selection)
    activeSnapZone = selection.zone
    activeSnapScreen = context.screen
    activeSnapWindowId = context.windowId
    activeSnapLayout = selection.snapLayout
    activeSnapPreviewGlobal = { ...selection.previewRect }
    rememberRecentSnapCandidate(context.windowId, selection.zone, context.screen, selection.snapLayout, selection.previewRect)
    const origin = options.layoutCanvasOrigin()
    activeSnapPreviewCanvas = rectGlobalToCanvasLocal(
      selection.previewRect.x,
      selection.previewRect.y,
      selection.previewRect.width,
      selection.previewRect.height,
      origin,
    )
    if (selection.hoverSpan && selection.shape) {
      setAssistOverlayState({
        kind: 'assist',
        shape: selection.shape,
        gutterPx: assistGridGutterPx(context.workGlobal, selection.shape),
        hoverSpan: selection.hoverSpan,
        workCanvas: context.workCanvas,
      })
    } else if (selection.snapLayout.kind === 'custom') {
      const snapLayout = selection.snapLayout
      const parsed = parseCustomSnapZoneId(selection.zone)
      const layout = context.customLayouts.find((entry) => entry.id === snapLayout.layoutId) ?? null
      if (parsed && layout) {
        setAssistOverlayState({
          kind: 'custom',
          layout,
          selectedZoneId: parsed.zoneId,
          workCanvas: context.workCanvas,
        })
      } else {
        setAssistOverlayState(null)
      }
    } else {
      setAssistOverlayState(null)
    }
    scheduleTilePreviewSync()
  }

  function updateSnapAssistFromSpan(
    context: SnapAssistContext,
    span: AssistGridSpan | null,
    showOverlay = true,
  ) {
    const shape = span ? assistShapeFromSpan(span) : context.assistShape
    if (!span || !shape) {
      clearSnapAssistSelection()
      return
    }
    const { zone, previewRect } = snapZoneAndPreviewFromAssistSpan(span, shape, context.workGlobal)
    setSnapPickerHoverSelection({
      zone,
      previewRect,
      snapLayout: assistMonitorSnapLayout(shape),
      shape,
      hoverSpan: span,
    })
    applySnapAssistZonePreview(context, zone, previewRect, assistMonitorSnapLayout(shape))
    if (showOverlay) {
      setAssistOverlayState({
        kind: 'assist',
        shape,
        gutterPx: assistGridGutterPx(context.workGlobal, shape),
        hoverSpan: span,
        workCanvas: context.workCanvas,
      })
    } else {
      setAssistOverlayState(null)
    }
    scheduleTilePreviewSync()
  }

  function updateSnapAssistFromEdgeZone(context: SnapAssistContext, zone: SnapZone | null) {
    if (!zone || !context.assistShape) {
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
    applySnapAssistZonePreview(context, zone, previewRect, context.snapLayout)
    setSnapPickerHoverSelection(null)
    setAssistOverlayState(null)
    scheduleTilePreviewSync()
  }

  function updateSnapAssistFromCustomZone(
    context: SnapAssistContext,
    zoneId: string | null,
    showOverlay = true,
  ) {
    if (!zoneId || !context.customLayout) {
      clearSnapAssistSelection()
      return
    }
    const zone = customSnapZoneId(context.customLayout.id, zoneId)
    const previewRect = resolveCustomLayoutZoneBounds(context.customLayouts, zone, {
      x: context.workGlobal.x,
      y: context.workGlobal.y,
      width: context.workGlobal.w,
      height: context.workGlobal.h,
    })
    if (!previewRect) {
      clearSnapAssistSelection()
      return
    }
    applySnapAssistZonePreview(context, zone, previewRect, context.snapLayout)
    if (showOverlay) {
      setAssistOverlayState({
        kind: 'custom',
        layout: context.customLayout,
        selectedZoneId: zoneId,
        workCanvas: context.workCanvas,
      })
    } else {
      setAssistOverlayState(null)
    }
    scheduleTilePreviewSync()
  }

  function commitSnapAssistSelection(windowId: number, closePicker = false) {
    const drag = shellWindowDrag
    const fallbackCandidate =
      activeSnapZone === null &&
      activeSnapScreen === null &&
      activeSnapLayout === null &&
      activeSnapPreviewGlobal === null &&
      drag &&
      recentSnapCandidate &&
      recentSnapCandidate.windowId === windowId &&
      Date.now() - recentSnapCandidate.atMs <= 400 &&
      Math.abs(drag.lastX - recentSnapCandidate.pointerX) <= 24 &&
      Math.abs(drag.lastY - recentSnapCandidate.pointerY) <= 24
        ? recentSnapCandidate
        : null
    const snapWindowId = activeSnapWindowId ?? fallbackCandidate?.windowId ?? windowId
    const droppedZone = activeSnapZone ?? fallbackCandidate?.zone ?? null
    const snapScreen = activeSnapScreen ?? fallbackCandidate?.screen ?? null
    const droppedLayout = activeSnapLayout ?? fallbackCandidate?.layout ?? null
    const droppedPreviewGlobal =
      activeSnapPreviewGlobal ? { ...activeSnapPreviewGlobal } : fallbackCandidate ? { ...fallbackCandidate.previewGlobal } : null
    resetSnapAssistState()
    setAssistOverlayState(null)
    if (closePicker) setSnapAssistPicker(null)
    clearTilePreviewWire()
    if (droppedZone === null || !snapScreen) {
      dragPreTileSnapshot.delete(snapWindowId)
      recentSnapCandidate = null
      return
    }
    const currentWindow = readWindow(snapWindowId)
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
    const work = monitorTileFrameAreaGlobal(snapScreen, reserveTaskbar)
    const workRect: TileRect = { x: work.x, y: work.y, width: work.w, height: work.h }
    const occupied = options.occupiedSnapZonesOnMonitor(snapScreen, snapWindowId)
    const globalBounds =
      droppedPreviewGlobal ??
      snapZoneToBoundsWithOccupied(droppedZone, workRect, occupied)
    if (droppedLayout) {
      setMonitorSnapLayout(snapScreen.name, droppedLayout)
    }
    if (
      preTile
        ? !options.sendSetPreTileGeometry(snapWindowId, preTile)
        : !options.sendClearPreTileGeometry(snapWindowId)
    ) {
      return
    }
    if (!options.sendSetMonitorTile(snapWindowId, snapScreen.name, droppedZone, globalBounds, snapScreen.identity)) return
    const clientBounds = tiledFrameRectToClientRect(globalBounds)
    const localBounds = rectGlobalToCanvasLocal(
      clientBounds.x,
      clientBounds.y,
      clientBounds.width,
      clientBounds.height,
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
    recentSnapCandidate = null
    options.requestSharedStateSync({ exclusion: 'schedule' })
    options.bumpSnapChrome()
  }

  function assistSpanFromPickerTarget(target: EventTarget | null, pickerEl: HTMLElement): AssistGridSpan | null {
    if (!(target instanceof HTMLElement)) return null
    const spanEl = target.closest('[data-assist-grid-span]')
    if (!(spanEl instanceof HTMLElement) || !pickerEl.contains(spanEl)) return null
    const gridCols = Number(spanEl.getAttribute('data-grid-cols'))
    const gridRows = Number(spanEl.getAttribute('data-grid-rows'))
    const gc0 = Number(spanEl.getAttribute('data-gc0'))
    const gc1 = Number(spanEl.getAttribute('data-gc1'))
    const gr0 = Number(spanEl.getAttribute('data-gr0'))
    const gr1 = Number(spanEl.getAttribute('data-gr1'))
    if (![gridCols, gridRows, gc0, gc1, gr0, gr1].every(Number.isFinite)) return null
    return {
      gridCols: Math.trunc(gridCols),
      gridRows: Math.trunc(gridRows),
      gc0: Math.trunc(gc0),
      gc1: Math.trunc(gc1),
      gr0: Math.trunc(gr0),
      gr1: Math.trunc(gr1),
    }
  }

  function assistGridShapeFromValue(value: string | null): AssistGridShape | null {
    switch (value) {
      case '3x2':
      case '3x3':
      case '2x2':
      case '2x3':
        return value
      default:
        return null
    }
  }

  function assistSpanFromPickerPoint(
    target: EventTarget | null,
    pickerEl: HTMLElement,
    clientX: number,
    clientY: number,
  ): AssistGridSpan | null {
    if (!(target instanceof HTMLElement)) return null
    const gridEl = target.closest('[data-assist-master-grid]')
    if (!(gridEl instanceof HTMLElement) || !pickerEl.contains(gridEl)) return null
    const shape = assistGridShapeFromValue(gridEl.getAttribute('data-assist-master-grid'))
    if (!shape) return null
    const gutterPx = Number(gridEl.getAttribute('data-assist-master-grid-gutter-px'))
    return assistSpanFromMasterGridPoint(gridEl, clientX, clientY, shape, Number.isFinite(gutterPx) ? gutterPx : 0)
  }

  function customSelectionFromPickerTarget(
    target: EventTarget | null,
    context: SnapAssistContext,
    pickerEl: HTMLElement,
  ): SnapPickerSelection | null {
    if (!(target instanceof HTMLElement)) return null
    const zoneEl = target.closest('[data-snap-picker-custom-zone]')
    if (!(zoneEl instanceof HTMLElement) || !pickerEl.contains(zoneEl)) return null
    const zoneId = zoneEl.getAttribute('data-snap-picker-custom-zone')
    const layoutId = zoneEl.getAttribute('data-snap-picker-custom-layout')
    if (!zoneId || !layoutId) return null
    const zone = customSnapZoneId(layoutId, zoneId)
    const previewRect = resolveCustomLayoutZoneBounds(context.customLayouts, zone, {
      x: context.workGlobal.x,
      y: context.workGlobal.y,
      width: context.workGlobal.w,
      height: context.workGlobal.h,
    })
    if (!previewRect) return null
    return {
      zone,
      previewRect,
      snapLayout: customMonitorSnapLayout(layoutId),
      shape: null,
      hoverSpan: null,
    }
  }

  function updateSnapAssistFromPickerPointer(
    context: SnapAssistContext,
    pickerEl: HTMLElement,
    clientX: number,
    clientY: number,
  ) {
    const targets = document.elementsFromPoint(clientX, clientY)
    for (const target of targets) {
      const pointSpan = assistSpanFromPickerPoint(target, pickerEl, clientX, clientY)
      if (pointSpan) {
        updateSnapAssistFromSpan(context, pointSpan)
        return true
      }
      const span = assistSpanFromPickerTarget(target, pickerEl)
      if (span) {
        updateSnapAssistFromSpan(context, span)
        return true
      }
      const selection = customSelectionFromPickerTarget(target, context, pickerEl)
      if (selection) {
        applySnapPickerSelection(context, selection)
        return true
      }
    }
    return targets.some((target) => pickerEl.contains(target))
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
    if (shellWindowDrag?.windowId === windowId) shellWindowDrag.measure = null
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
    const window = readWindow(windowId)
    if (!window) return
    if (window.maximized) {
      options.shellWireSend('set_maximized', windowId, 0)
      return
    }
    if (!options.sendRemoveMonitorTile(windowId)) return
    if (!options.sendClearPreTileGeometry(windowId)) return
    options.bumpSnapChrome()
    options.requestSharedStateSync({ exclusion: 'schedule' })
    options.shellWireSend('set_maximized', windowId, 1)
  }

  function beginShellWindowMove(windowId: number, clientX: number, clientY: number) {
    if (shellWindowResize !== null) return
    options.shellMoveLog('titlebar_begin_request', { windowId, clientX, clientY })
    shellMoveDeltaLogSeq = 0
    closeSnapAssistPicker()
    clearTilePreviewWire()
    recentSnapCandidate = null
    const main = options.getMainRef()
    const output = options.outputGeom()
    const window = readWindow(windowId)
    if (main && output && window) {
      const mainRect = main.getBoundingClientRect()
      const pointerCanvas = clientPointToCanvasLocal(clientX, clientY, mainRect, output.w, output.h)
      if (!window.maximized && options.isWorkspaceWindowTiled(windowId)) {
        const preTile = options.workspacePreTileSnapshot(windowId)
        if (preTile) {
          const grabDx = pointerCanvas.x - window.x
          const grabDy = pointerCanvas.y - window.y
          const nextX = pointerCanvas.x - grabDx + CHROME_BORDER_PX
          const nextY = pointerCanvas.y - grabDy + CHROME_BORDER_TOP_PX
          options.shellWireSend('set_geometry', windowId, nextX, nextY, preTile.w, preTile.h, SHELL_LAYOUT_FLOATING)
        }
        if (!options.sendRemoveMonitorTile(windowId)) return
        if (!options.sendClearPreTileGeometry(windowId)) return
        dragPreTileSnapshot.set(windowId, preTile ?? { x: window.x, y: window.y, w: window.width, h: window.height })
        options.requestSharedStateSync({ exclusion: 'schedule' })
        options.bumpSnapChrome()
      } else if (!window.maximized) {
        dragPreTileSnapshot.set(windowId, { x: window.x, y: window.y, w: window.width, h: window.height })
      }
    }
    if (window && (window.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) === 0) {
      options.clearNativeDragPreview()
    }
    if (!options.shellWireSend('move_begin', windowId)) {
      options.shellMoveLog('titlebar_begin_aborted', { windowId, reason: 'no __derpShellWireSend' })
      return
    }
    const startedTiled =
      !!window &&
      !window.maximized &&
      options.isWorkspaceWindowTiled(windowId) &&
      options.workspacePreTileSnapshot(windowId) !== null
    const stripEl = main?.querySelector('[data-shell-snap-strip-trigger]') as HTMLElement | null
    const stripRect = stripEl?.getBoundingClientRect() ?? null
    const stripArmed =
      !stripRect ||
      clientX < stripRect.left ||
      clientX > stripRect.right ||
      clientY < stripRect.top ||
      clientY > stripRect.bottom
    shellWindowDrag = {
      windowId,
      lastX: Math.round(clientX),
      lastY: Math.round(clientY),
      startX: Math.round(clientX),
      superHeld: false,
      stripArmed,
      edgeSnapArmed: !window?.maximized && !startedTiled,
      startedTiled,
      startedMaximized: !!window?.maximized,
      measure: null,
    }
    setDragWindowId(windowId)
    setDragWindowMoved(false)
    options.shellMoveLog('titlebar_begin_armed', { windowId, clientX, clientY })
  }

  function adoptShellWindowMove(windowId: number, clientX: number, clientY: number, moved = true) {
    if (shellWindowResize !== null) return false
    const cx = Math.round(clientX)
    const cy = Math.round(clientY)
    if (shellWindowDrag?.windowId === windowId) {
      shellWindowDrag.lastX = cx
      shellWindowDrag.lastY = cy
      if (moved) setDragWindowMoved(true)
      return true
    }
    closeSnapAssistPicker()
    clearTilePreviewWire()
    const window = readWindow(windowId)
    shellWindowDrag = {
      windowId,
      lastX: cx,
      lastY: cy,
      startX: cx,
      superHeld: false,
      stripArmed: true,
      edgeSnapArmed:
        !window?.maximized &&
        !(options.isWorkspaceWindowTiled(windowId) && options.workspacePreTileSnapshot(windowId) !== null),
      startedTiled: !!window && !window.maximized && options.isWorkspaceWindowTiled(windowId),
      startedMaximized: !!window?.maximized,
      measure: null,
    }
    setDragWindowId(windowId)
    setDragWindowMoved(moved)
    options.shellMoveLog('titlebar_begin_adopted', { windowId, clientX, clientY, moved })
    return true
  }

  function updateDragSnapAssist(windowId: number, clientX: number, clientY: number, superHeld: boolean) {
    const measure = readDragMeasure(windowId)
    if (!measure) return
    const global = clientPointToGlobalLogical(
      clientX,
      clientY,
      measure.mainRect,
      measure.output.w,
      measure.output.h,
      measure.origin,
    )
    const monitor = pickScreenForPointerSnap(global.x, global.y, measure.screens)
    const context = monitor ? dragContextForMonitor(windowId, measure, monitor.name) : null
    const pickerOpen = snapAssistPicker()?.source === 'strip' && snapAssistPicker()?.windowId === windowId
    if (measure.pickerEl && measure.pickerRect) {
      const pickerRect = measure.pickerRect
      if (
        pickerOpen &&
        clientX >= pickerRect.left &&
        clientX <= pickerRect.right &&
        clientY >= pickerRect.top &&
        clientY <= pickerRect.bottom
      ) {
        if (pickerOpen && context) {
          updateSnapAssistFromPickerPointer(context, measure.pickerEl, clientX, clientY)
        }
        return
      }
    }
    if (
      shellWindowDrag?.startedMaximized &&
      Math.abs(clientX - shellWindowDrag.startX) < TILE_SNAP_EDGE_PX * 2
    ) {
      if (pickerOpen) {
        closeSnapAssistPicker()
      } else {
        clearSnapAssistSelection()
      }
      return
    }
    if (measure.stripRect) {
      const stripRect = measure.stripRect
      if (
        clientX >= stripRect.left &&
        clientX <= stripRect.right &&
        clientY >= stripRect.top &&
        clientY <= stripRect.bottom
      ) {
        if (shellWindowDrag?.stripArmed) {
          if (!pickerOpen) {
            openSnapAssistPicker(windowId, 'strip', stripRect, false, monitor?.name)
          }
          return
        }
        clearSnapAssistSelection()
        return
      }
      if (shellWindowDrag) shellWindowDrag.stripArmed = true
    }
    if (pickerOpen) {
      closeSnapAssistPicker()
    }
    if (!monitor) {
      clearSnapAssistSelection()
      return
    }
    if (!context) {
      clearSnapAssistSelection()
      return
    }
    if (shellWindowDrag && !shellWindowDrag.edgeSnapArmed) {
      if (Math.abs(clientX - shellWindowDrag.startX) < TILE_SNAP_EDGE_PX * 2) {
        clearSnapAssistSelection()
        return
      }
      shellWindowDrag.edgeSnapArmed = true
    }
    const work = context.workGlobal
    const pxForAssist = Math.max(work.x, Math.min(global.x, work.x + work.w))
    const pyForAssist = Math.max(work.y, Math.min(global.y, work.y + work.h))
    if (superHeld) {
      if (context.assistShape) {
        const span = assistSpanFromWorkAreaPoint(pxForAssist, pyForAssist, context.assistShape, work)
        updateSnapAssistFromSpan(context, span)
        return
      }
      if (context.customLayout) {
        const hovered = resolveCustomLayoutZoneAtPoint(
          context.customLayout,
          { x: work.x, y: work.y, width: work.w, height: work.h },
          pxForAssist,
          pyForAssist,
        )
        updateSnapAssistFromCustomZone(context, hovered?.zoneId ?? null)
        return
      }
      clearSnapAssistSelection()
      return
    }
    const inAssistTopStrip =
      global.x >= work.x &&
      global.x <= work.x + work.w &&
      ((global.y >= work.y && global.y <= work.y + TILE_SNAP_EDGE_PX) ||
        (global.y < work.y && work.y - global.y <= TILE_SNAP_EDGE_PX))
    if (inAssistTopStrip && context.assistShape) {
      const span = assistSpanFromWorkAreaPoint(pxForAssist, pyForAssist, context.assistShape, work)
      updateSnapAssistFromSpan(context, span, false)
      return
    }
    if (context.customLayout) {
      const nearEdge =
        pxForAssist - work.x <= TILE_SNAP_EDGE_PX ||
        work.x + work.w - pxForAssist <= TILE_SNAP_EDGE_PX ||
        pyForAssist - work.y <= TILE_SNAP_EDGE_PX ||
        work.y + work.h - pyForAssist <= TILE_SNAP_EDGE_PX
      if (nearEdge) {
        const hovered = resolveCustomLayoutZoneAtPoint(
          context.customLayout,
          { x: work.x, y: work.y, width: work.w, height: work.h },
          pxForAssist,
          pyForAssist,
        )
        updateSnapAssistFromCustomZone(context, hovered?.zoneId ?? null, false)
        return
      }
      clearSnapAssistSelection()
      return
    }
    const zone = context.assistShape ? hitTestSnapZoneGlobal(global.x, global.y, work, context.assistShape) : null
    updateSnapAssistFromEdgeZone(context, zone)
  }

  function updateShellWindowMovePointer(clientX: number, clientY: number, superHeld: boolean) {
    if (!shellWindowDrag) return
    const cx = Math.round(clientX)
    const cy = Math.round(clientY)
    const dClientX = cx - shellWindowDrag.lastX
    const dClientY = cy - shellWindowDrag.lastY
    const windowId = shellWindowDrag.windowId
    if (dClientX !== 0 || dClientY !== 0) {
      const measure = readDragMeasure(windowId)
      const { dx, dy } =
        measure
          ? clientPointerDeltaToCanvasLogical(
              dClientX,
              dClientY,
              measure.mainRect,
              measure.output.w,
              measure.output.h,
            )
          : { dx: dClientX, dy: dClientY }
      if (dx !== 0 || dy !== 0) {
        shellMoveDeltaLogSeq += 1
        if (shellMoveDeltaLogSeq <= 12 || shellMoveDeltaLogSeq % 30 === 0) {
          options.shellMoveLog('titlebar_delta', { seq: shellMoveDeltaLogSeq, dx, dy, clientX, clientY })
        }
        setDragWindowMoved(true)
      }
      shellWindowDrag.lastX = cx
      shellWindowDrag.lastY = cy
    }
    shellWindowDrag.superHeld = superHeld
    updateDragSnapAssist(windowId, cx, cy, superHeld)
  }

  function applyShellWindowMove(clientX: number, clientY: number, superHeld = false, _buttons?: number) {
    if (!shellWindowDrag) return
    const beforeX = shellWindowDrag.lastX
    const beforeY = shellWindowDrag.lastY
    updateShellWindowMovePointer(clientX, clientY, superHeld)
    const afterDrag = shellWindowDrag
    if (!afterDrag || afterDrag.windowId !== dragWindowId()) return
    const dClientX = afterDrag.lastX - beforeX
    const dClientY = afterDrag.lastY - beforeY
    if (dClientX === 0 && dClientY === 0) return
    const measure = afterDrag.measure ?? readDragMeasure(afterDrag.windowId)
    const { dx, dy } =
      measure
        ? clientPointerDeltaToCanvasLogical(
            dClientX,
            dClientY,
            measure.mainRect,
            measure.output.w,
            measure.output.h,
          )
        : { dx: dClientX, dy: dClientY }
    if (dx === 0 && dy === 0) return
    options.shellWireSend('move_delta', dx, dy)
  }

  function syncShellWindowMovePointer(clientX: number, clientY: number) {
    if (!shellWindowDrag) return
    updateShellWindowMovePointer(clientX, clientY, shellWindowDrag.superHeld)
  }

  function endShellWindowMove(reason: string, commitSnap = true, sendMoveEnd = true) {
    if (!shellWindowDrag) return
    const drag = shellWindowDrag
    const windowId = drag.windowId
    const moved = dragWindowMoved()
    options.shellMoveLog('titlebar_end', { windowId, reason })
    if (commitSnap) {
      commitSnapAssistSelection(
        windowId,
        snapAssistPicker()?.source === 'strip' && snapAssistPicker()?.windowId === windowId,
      )
    } else {
      dragPreTileSnapshot.delete(windowId)
      resetSnapAssistState()
      setAssistOverlayState(null)
      recentSnapCandidate = null
      if (snapAssistPicker()?.source === 'strip' && snapAssistPicker()?.windowId === windowId) {
        setSnapAssistPicker(null)
      }
      clearTilePreviewWire()
    }
    shellWindowDrag = null
    setDragWindowId(null)
    setDragWindowMoved(false)
    if (sendMoveEnd) {
      options.shellWireSend('move_end', windowId)
      if (moved && (drag.startedTiled || drag.startedMaximized)) {
        options.requestCompositorSync()
      }
    }
  }

  function beginShellWindowResize(windowId: number, edges: number, clientX: number, clientY: number) {
    if (shellWindowResize !== null || shellWindowDrag !== null) return
    shellResizeDeltaLogSeq = 0
    const monitor = options.workspaceFindMonitorForTiledWindow(windowId)
    const tolerance = TILE_RESIZE_EDGE_ALIGN_PX
    let useTiledPropagate = false
    const initialRects = new Map<number, TileRect>()
    if (monitor !== null) {
      const rects = options.workspaceTiledRectMap(monitor.outputName, monitor.outputId)
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
    if (useTiledPropagate && monitor !== null) {
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
        outputName: monitor.outputName,
        outputId: monitor.outputId,
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

  function updateShellWindowResizePointer(clientX: number, clientY: number, sendDelta: boolean) {
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
      if (sendDelta && (shellResizeDeltaLogSeq <= 12 || shellResizeDeltaLogSeq % 30 === 0)) {
        options.shellMoveLog('resize_delta', { seq: shellResizeDeltaLogSeq, dx, dy, clientX, clientY })
      }
      shellWindowResize.lastX = cx
      shellWindowResize.lastY = cy
      if (sendDelta) {
        options.shellWireSend('resize_delta', dx, dy)
      }
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
      const clientRect = tiledFrameRectToClientRect(globalRect)
      const local = rectGlobalToCanvasLocal(
        clientRect.x,
        clientRect.y,
        clientRect.width,
        clientRect.height,
        origin,
      )
      options.shellWireSend('set_geometry', windowId, local.x, local.y, local.w, local.h, SHELL_LAYOUT_FLOATING)
    }
    options.requestSharedStateSync({ exclusion: 'schedule' })
    options.bumpSnapChrome()
  }

  function applyShellWindowResize(clientX: number, clientY: number, _buttons?: number) {
    updateShellWindowResizePointer(clientX, clientY, true)
  }

  function syncShellWindowResizePointer(clientX: number, clientY: number) {
    updateShellWindowResizePointer(clientX, clientY, false)
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
          resizeSession.outputId,
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
      options.requestSharedStateSync({ shellUi: 'flush', exclusion: 'sync' }, 'now')
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
    const getShellUiMeasureEnv = () => {
      const output = options.outputGeom()
      if (!output) return null
      return {
        main,
        outputGeom: output,
        origin: options.layoutCanvasOrigin(),
      }
    }
    return (
      <Show when={snapAssistPicker()} keyed>
        {(picker) => {
          const context = resolveSnapAssistContext(picker.windowId, picker.monitorName)
          return (
            <SnapAssistPicker
              anchorRect={picker.anchorRect}
              container={main}
              workArea={context ? context.workGlobal : { x: 0, y: 0, w: 1, h: 1 }}
              currentSnapLayout={context?.snapLayout ?? assistMonitorSnapLayout('3x2')}
              customLayouts={context?.customLayouts ?? []}
              hoverSelection={snapPickerHoverSelection()}
              autoHover={picker.autoHover}
              shellUiWindowId={SHELL_UI_PORTAL_PICKER_WINDOW_ID}
              shellUiWindowZ={1100000}
              getShellUiMeasureEnv={getShellUiMeasureEnv}
              onHoverSelectionChange={(selection) => {
                const nextContext = resolveSnapAssistContext(picker.windowId, picker.monitorName)
                if (!nextContext) {
                  closeSnapAssistPicker()
                  return
                }
                applySnapPickerSelection(nextContext, selection)
              }}
              onSelectSelection={(selection) => {
                const nextContext = resolveSnapAssistContext(picker.windowId, picker.monitorName)
                if (!nextContext) {
                  closeSnapAssistPicker()
                  return
                }
                applySnapPickerSelection(nextContext, selection)
                commitSnapAssistSelection(picker.windowId, true)
              }}
              onClose={closeSnapAssistPicker}
            />
          )
        }}
      </Show>
    )
  }

  return {
    assistOverlay,
    snapAssistPicker,
    dragWindowId,
    dragWindowMoved,
    dragSnapAssistContext,
    snapStripState,
    getShellWindowDragId: () => shellWindowDrag?.windowId ?? null,
    getShellWindowResizeId: () => shellWindowResize?.windowId ?? null,
    getActiveSnapPreviewCanvas: () => activeSnapPreviewCanvas,
    getActiveSnapZone: () => activeSnapZone,
    getDragSuperHeld: () => shellWindowDrag?.superHeld ?? false,
    openSnapAssistPicker,
    closeSnapAssistPicker,
    toggleShellMaximizeForWindow,
    beginShellWindowMove,
    adoptShellWindowMove,
    applyShellWindowMove,
    syncShellWindowMovePointer,
    endShellWindowMove,
    beginShellWindowResize,
    applyShellWindowResize,
    syncShellWindowResizePointer,
    endShellWindowResize,
    SnapAssistPickerLayer,
  }
}
