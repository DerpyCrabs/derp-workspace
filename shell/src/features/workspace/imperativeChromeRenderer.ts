import { createEffect } from 'solid-js'
import type { DerpShellDetail, DerpWindow } from '@/host/appWindowState'
import { windowIsShellHosted } from '@/host/appWindowState'
import { shellWindowFrameLayout } from '@/host/shellWindowFrameLayout'
import { canvasRectToClientCss } from '@/lib/shellCoords'
import { assistShapeToDims } from '@/features/tiling/assistGrid'
import { listCustomLayoutZones } from '@/features/tiling/customLayouts'
import { registerShellExclusionElement } from '@/features/bridge/shellExclusionSync'
import type { AssistOverlayState, LayoutScreen, SnapAssistStripState } from '@/host/types'
import {
  SHELL_RESIZE_BOTTOM,
  SHELL_RESIZE_LEFT,
  SHELL_RESIZE_RIGHT,
  SHELL_LAYOUT_FLOATING,
} from '@/lib/chromeConstants'
import { shellOuterFrameFromClient } from '@/lib/exclusionRects'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import {
  clampWorkspaceSplitPaneFraction,
  createEmptyWorkspaceSnapshot,
  isWorkspaceWindowPinned,
  normalizeWorkspaceSnapshot,
  workspaceIsWindowTiled,
} from './workspaceSnapshot'
import { buildWorkspaceGroups, resolveWindowDesktopIcon, type WorkspaceGroupModel } from './workspaceSelectors'
import type { WorkspaceTabStripLayout, WorkspaceTabStripRect } from './WorkspaceTabStrip'
import type { DesktopAppMatchCandidate } from '@/features/desktop/desktopApplicationsState'
import { noteShellImperativeChromeApply } from '@/features/bridge/shellPerfCounters'

type InteractionVisual = {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
  fullscreen: boolean
}

type InteractionState = {
  move_window_id: number | null
  resize_window_id: number | null
  move_proxy_window_id: number | null
  move_capture_window_id: number | null
  move_rect: InteractionVisual | null
  resize_rect: InteractionVisual | null
}

type RendererWindow = DerpWindow & { snap_tiled?: boolean }

type ChromeNode = {
  frame: HTMLDivElement
  left: HTMLDivElement
  right: HTMLDivElement
  bottom: HTMLDivElement
  content: HTMLDivElement
  previewCanvas: HTMLCanvasElement
  titlebar: HTMLDivElement
  title: HTMLDivElement
  tabStrip: HTMLDivElement
  tabStripInner: HTMLDivElement
  controls: HTMLDivElement
  minimize: HTMLButtonElement
  maximize: HTMLButtonElement
  close: HTMLButtonElement
  resizeLeft: HTMLDivElement
  resizeRight: HTMLDivElement
  resizeBottom: HTMLDivElement
  resizeBottomLeft: HTMLDivElement
  resizeBottomRight: HTMLDivElement
  splitLeftPane: HTMLDivElement
  splitRightPane: HTMLDivElement
  splitDivider: HTMLDivElement
  tabs: Map<number, HTMLDivElement>
  dropSlots: Map<string, HTMLDivElement>
  last: Record<string, string | number | boolean | null>
}

type SurfaceNodes = {
  overlay: HTMLDivElement
  overlayInner: HTMLDivElement
  overlayLines: Map<string, HTMLDivElement>
  stripLayer: HTMLDivElement
  stripButton: HTMLButtonElement
  dragOverlay: HTMLDivElement
  dragHighlight: HTMLDivElement
  dragLine: HTMLDivElement
  externalGhost: HTMLDivElement
  splitOverlay: HTMLDivElement
  last: Record<string, string | number | boolean | null>
  stripExclusionUnregister: (() => void) | null
}

type CsdDropStripNode = {
  node: HTMLDivElement
  last: Record<string, string | number | boolean | null>
}

type ExternalTabDropDrag = {
  target: { groupId: string; insertIndex: number } | null
  clientX: number
  clientY: number
  label: string
  canDrop: boolean
}

type ImperativeChromeRendererOptions = {
  getRoot: () => HTMLElement | undefined
  getMainRef: () => HTMLElement | undefined
  desktopApps: () => readonly DesktopAppMatchCandidate[]
  layoutCanvasOrigin: () => unknown
  outputGeom: () => { w: number; h: number } | null
  assistOverlay: () => AssistOverlayState | null
  screenCssRect: (screen: LayoutScreen) => LayoutScreen
  snapStrip: () => SnapAssistStripState | null
  snapStripScreen: () => LayoutScreen | null
  snapStripExclusionActive: () => boolean
  focusWindowViaShell: (windowId: number) => void
  beginShellWindowMove: (windowId: number, clientX: number, clientY: number, options?: { snapAssist?: boolean }) => void
  beginShellWindowResize: (windowId: number, edges: number, clientX: number, clientY: number) => void
  toggleShellMaximizeForWindow: (windowId: number) => void
  activeDragWindowId: () => number | null
  activeDropTarget: () => { groupId: string; insertIndex: number } | null
  tabDragState: () => { windowId: number; dragging: boolean } | null
  activeWindowDragWindowId: () => number | null
  activeWindowDragTarget: () => { groupId: string; insertIndex: number } | null
  externalTabDropDrag: () => ExternalTabDropDrag | null
  splitGroupGesture: () => { kind: 'divider' | 'move' | 'resize' } | null
  startTabPointerGesture: (windowId: number, pointerId: number, clientX: number, clientY: number, button: number) => void
  setTabStripLayout: (groupId: string, layout: WorkspaceTabStripLayout | null) => void
  selectGroupWindow: (windowId: number) => boolean
  setSplitGroupFraction: (groupId: string, fraction: number) => void
  openSnapAssistPicker: (windowId: number, anchorRect: DOMRect) => void
  shellPointerGlobalLogical: (clientX: number, clientY: number) => { x: number; y: number } | null
  closeGroupWindow: (windowId: number) => void
  closeWindow: (windowId: number) => void
  shellContextOpenTabMenu: (windowId: number, clientX: number, clientY: number) => void
  nativeDragPreview: () => {
    window_id: number
    generation: number
    image_path: string
    src: string
    loaded: boolean
    image: HTMLImageElement | null
  } | null
  shellWireSend: (
    op: 'set_geometry' | 'taskbar_activate' | 'minimize' | 'shell_ui_grab_begin' | 'shell_ui_grab_end',
    arg?: number | string,
    arg2?: number | string,
    arg3?: number,
    arg4?: number,
    arg5?: number,
    arg6?: number,
  ) => boolean
}

type SplitGroupRect = {
  x: number
  y: number
  width: number
  height: number
}

type SplitLayoutRects = {
  group: SplitGroupRect
  left: SplitGroupRect
  right: SplitGroupRect
  leftWindowId: number
  rightWindowIds: number[]
}

type SplitGestureState = {
  pointerId: number
  groupId: string
  kind: 'move' | 'resize' | 'divider'
  edges: number
  startGlobalX: number
  startGlobalY: number
  originGroupRect: SplitGroupRect
}

const WORKSPACE_SPLIT_DIVIDER_PX = 4
const WORKSPACE_SPLIT_MIN_PANE_PX = 160
const WORKSPACE_SPLIT_MIN_HEIGHT_PX = 140
const CSD_GROUP_DROP_STRIP_PX = 34
function coerceWindowId(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  const id = Math.trunc(n)
  return id > 0 ? id : null
}

function windowFromRow(row: Partial<DerpWindow> & { window_id: number; surface_id: number }, previous?: DerpWindow): DerpWindow {
  return {
    window_id: row.window_id,
    surface_id: row.surface_id,
    stack_z: row.stack_z ?? previous?.stack_z ?? 0,
    x: row.x ?? previous?.x ?? 0,
    y: row.y ?? previous?.y ?? 0,
    width: row.width ?? previous?.width ?? 1,
    height: row.height ?? previous?.height ?? 1,
    client_x: row.client_x ?? previous?.client_x ?? row.x ?? previous?.x ?? 0,
    client_y: row.client_y ?? previous?.client_y ?? row.y ?? previous?.y ?? 0,
    client_width: row.client_width ?? previous?.client_width ?? row.width ?? previous?.width ?? 1,
    client_height: row.client_height ?? previous?.client_height ?? row.height ?? previous?.height ?? 1,
    frame_x: row.frame_x ?? previous?.frame_x ?? row.x ?? previous?.x ?? 0,
    frame_y: row.frame_y ?? previous?.frame_y ?? row.y ?? previous?.y ?? 0,
    frame_width: row.frame_width ?? previous?.frame_width ?? row.width ?? previous?.width ?? 1,
    frame_height: row.frame_height ?? previous?.frame_height ?? row.height ?? previous?.height ?? 1,
    restore_x: row.restore_x ?? previous?.restore_x ?? 0,
    restore_y: row.restore_y ?? previous?.restore_y ?? 0,
    restore_width: row.restore_width ?? previous?.restore_width ?? 1,
    restore_height: row.restore_height ?? previous?.restore_height ?? 1,
    minimized: row.minimized ?? previous?.minimized ?? false,
    maximized: row.maximized ?? previous?.maximized ?? false,
    fullscreen: row.fullscreen ?? previous?.fullscreen ?? false,
    client_side_decoration: row.client_side_decoration ?? previous?.client_side_decoration ?? false,
    workspace_visible: row.workspace_visible ?? previous?.workspace_visible ?? true,
    shell_flags: row.shell_flags ?? previous?.shell_flags ?? 0,
    title: row.title ?? previous?.title ?? '',
    app_id: row.app_id ?? previous?.app_id ?? '',
    output_id: row.output_id ?? previous?.output_id ?? '',
    output_name: row.output_name ?? previous?.output_name ?? '',
    capture_identifier: row.capture_identifier ?? previous?.capture_identifier ?? '',
    kind: row.kind ?? previous?.kind ?? '',
    x11_class: row.x11_class ?? previous?.x11_class ?? '',
    x11_instance: row.x11_instance ?? previous?.x11_instance ?? '',
    icon_name: row.icon_name ?? previous?.icon_name ?? '',
    icon_buffers: row.icon_buffers ?? previous?.icon_buffers ?? [],
  }
}

function windowModelWithClientRect(
  window: DerpWindow,
  rect: { x: number; y: number; width: number; height: number; maximized?: boolean; fullscreen?: boolean },
  forceShellChrome?: boolean,
): RendererWindow {
  const maximized = rect.maximized ?? window.maximized
  const fullscreen = rect.fullscreen ?? window.fullscreen
  const noShellChrome =
    forceShellChrome !== true &&
    !windowIsShellHosted(window) &&
    Number.isFinite(window.client_x) &&
    Number.isFinite(window.client_y) &&
    Number.isFinite(window.client_width) &&
    Number.isFinite(window.client_height) &&
    Number.isFinite(window.frame_x) &&
    Number.isFinite(window.frame_y) &&
    Number.isFinite(window.frame_width) &&
    Number.isFinite(window.frame_height) &&
    window.client_x === window.frame_x &&
    window.client_y === window.frame_y &&
    window.client_width === window.frame_width &&
    window.client_height === window.frame_height
  const frame = noShellChrome
    ? {
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
      }
    : shellOuterFrameFromClient({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        maximized,
        fullscreen,
        minimized: false,
        snap_tiled: false,
      })
  return {
    ...window,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    client_x: rect.x,
    client_y: rect.y,
    client_width: rect.width,
    client_height: rect.height,
    frame_x: frame.x,
    frame_y: frame.y,
    frame_width: frame.w,
    frame_height: frame.h,
    maximized,
    fullscreen,
  }
}

function windowLabel(window: Pick<DerpWindow, 'title' | 'app_id' | 'window_id'>): string {
  return window.title || window.app_id || `window ${window.window_id}`
}

function iconAccent(meta: Pick<DerpWindow, 'title' | 'app_id' | 'icon_name'>, desktopIcon: string | null): string {
  const key = (desktopIcon || meta.icon_name || meta.app_id || meta.title || 'app').trim().toLowerCase()
  let hash = 0
  for (let index = 0; index < key.length; index += 1) hash = (hash * 33 + key.charCodeAt(index)) >>> 0
  return `hsl(${hash % 360} 55% 32%)`
}

function iconMonogram(window: Pick<DerpWindow, 'title' | 'app_id'>): string {
  const source = (window.title || window.app_id || '?').trim()
  const letters = source
    .replace(/\.desktop$/i, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
  return letters || source[0]?.toUpperCase() || '?'
}

function setAttr(el: HTMLElement, key: string, value: string, last: Record<string, string | number | boolean | null>) {
  const mapKey = `attr:${key}`
  if (last[mapKey] === value && el.getAttribute(key) === value) return
  last[mapKey] = value
  el.setAttribute(key, value)
}

function setStyle(el: HTMLElement, key: string, value: string, last: Record<string, string | number | boolean | null>) {
  const mapKey = `style:${key}:${el.dataset.shellImperativeChromePart ?? ''}`
  if (last[mapKey] === value && el.style.getPropertyValue(key) === value) return
  last[mapKey] = value
  el.style.setProperty(key, value)
}

function setText(el: HTMLElement, value: string, last: Record<string, string | number | boolean | null>) {
  const mapKey = `text:${el.dataset.shellImperativeChromePart ?? el.getAttribute('data-workspace-tab') ?? el.getAttribute('data-workspace-tab-close') ?? ''}`
  if (last[mapKey] === value) return
  last[mapKey] = value
  el.textContent = value
}

function removeAttr(el: HTMLElement, key: string, last: Record<string, string | number | boolean | null>) {
  const mapKey = `attr:${key}`
  if (last[mapKey] === null && !el.hasAttribute(key)) return
  last[mapKey] = null
  el.removeAttribute(key)
}

function setClass(el: HTMLElement, className: string, enabled: boolean, last: Record<string, string | number | boolean | null>) {
  const mapKey = `class:${className}:${el.dataset.shellImperativeChromePart ?? ''}`
  if (last[mapKey] === enabled) return
  last[mapKey] = enabled
  el.classList.toggle(className, enabled)
}

function setHidden(el: HTMLElement, hidden: boolean, last: Record<string, string | number | boolean | null>) {
  const mapKey = `hidden:${el.dataset.shellImperativeChromePart ?? ''}`
  if (last[mapKey] === hidden && el.hidden === hidden) return
  last[mapKey] = hidden
  el.hidden = hidden
}

function button(className: string, title: string) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = className
  el.title = title
  return el
}

function outlineLinesFromRects(rects: Array<{
  x: number
  y: number
  width: number
  height: number
}>): Array<{ key: string; x: number; y: number; width: number; height: number }> {
  const vertical = mergeOutlineSegments(
    rects.flatMap((rect) => [
      { coord: rect.x, start: rect.y, end: rect.y + rect.height },
      { coord: rect.x + rect.width, start: rect.y, end: rect.y + rect.height },
    ]),
  )
  const horizontal = mergeOutlineSegments(
    rects.flatMap((rect) => [
      { coord: rect.y, start: rect.x, end: rect.x + rect.width },
      { coord: rect.y + rect.height, start: rect.x, end: rect.x + rect.width },
    ]),
  )
  return [
    ...vertical.map((line) => ({
      key: `v:${line.coord}:${line.start}:${line.end}`,
      x: line.coord - 0.5,
      y: line.start,
      width: 1,
      height: Math.max(1, line.end - line.start),
    })),
    ...horizontal.map((line) => ({
      key: `h:${line.coord}:${line.start}:${line.end}`,
      x: line.start,
      y: line.coord - 0.5,
      width: Math.max(1, line.end - line.start),
      height: 1,
    })),
  ]
}

function mergeOutlineSegments(
  segments: Array<{ coord: number; start: number; end: number }>,
): Array<{ coord: number; start: number; end: number }> {
  const groups = new Map<string, Array<{ coord: number; start: number; end: number }>>()
  for (const segment of segments) {
    const coord = Math.round(segment.coord * 1000) / 1000
    const start = Math.round(Math.min(segment.start, segment.end) * 1000) / 1000
    const end = Math.round(Math.max(segment.start, segment.end) * 1000) / 1000
    const key = coord.toFixed(3)
    const list = groups.get(key)
    if (list) {
      list.push({ coord, start, end })
    } else {
      groups.set(key, [{ coord, start, end }])
    }
  }
  const merged: Array<{ coord: number; start: number; end: number }> = []
  for (const list of groups.values()) {
    list.sort((a, b) => a.start - b.start || a.end - b.end)
    let current = list[0]
    for (let index = 1; index < list.length; index += 1) {
      const next = list[index]
      if (next.start <= current.end + 0.5) {
        current = { coord: current.coord, start: current.start, end: Math.max(current.end, next.end) }
      } else {
        merged.push(current)
        current = next
      }
    }
    merged.push(current)
  }
  return merged
}

function overlayLines(overlay: AssistOverlayState) {
  if (overlay.kind === 'assist') {
    const { cols, rows } = assistShapeToDims(overlay.shape)
    const cellW = overlay.workCanvas.w / cols
    const cellH = overlay.workCanvas.h / rows
    return outlineLinesFromRects(Array.from({ length: cols * rows }, (_, index) => {
      const col = index % cols
      const row = Math.floor(index / cols)
      return {
        x: col * cellW,
        y: row * cellH,
        width: cellW,
        height: cellH,
      }
    }))
  }
  return outlineLinesFromRects(
    listCustomLayoutZones(overlay.layout).map((zone) => ({
      x: zone.x * overlay.workCanvas.w,
      y: zone.y * overlay.workCanvas.h,
      width: zone.width * overlay.workCanvas.w,
      height: zone.height * overlay.workCanvas.h,
    })),
  )
}

function createChromeNode(windowId: number): ChromeNode {
  const frame = document.createElement('div')
  const left = document.createElement('div')
  const right = document.createElement('div')
  const bottom = document.createElement('div')
  const content = document.createElement('div')
  const previewCanvas = document.createElement('canvas')
  const titlebar = document.createElement('div')
  const title = document.createElement('div')
  const tabStrip = document.createElement('div')
  const tabStripInner = document.createElement('div')
  const controls = document.createElement('div')
  const minimize = button('m-0 flex h-full min-h-[22px] w-7 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent p-0 text-base leading-none font-bold text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-bg) hover:text-(--shell-text)', 'Minimize window')
  const maximize = button('m-0 flex h-full min-h-[22px] w-7 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent p-0 text-sm leading-none text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-bg) hover:text-(--shell-text)', 'Maximize')
  const close = button('m-0 flex h-full min-h-[22px] w-7 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent p-0 text-lg leading-none text-(--shell-control-muted-text) hover:bg-[color-mix(in_srgb,var(--shell-warning-bg)_70%,var(--shell-accent)_30%)] hover:text-(--shell-text)', 'Close window')
  const resizeLeft = document.createElement('div')
  const resizeRight = document.createElement('div')
  const resizeBottom = document.createElement('div')
  const resizeBottomLeft = document.createElement('div')
  const resizeBottomRight = document.createElement('div')
  const splitLeftPane = document.createElement('div')
  const splitRightPane = document.createElement('div')
  const splitDivider = document.createElement('div')
  const last: ChromeNode['last'] = {}
  frame.dataset.shellImperativeChromePart = 'frame'
  left.dataset.shellImperativeChromePart = 'left'
  right.dataset.shellImperativeChromePart = 'right'
  bottom.dataset.shellImperativeChromePart = 'bottom'
  content.dataset.shellImperativeChromePart = 'content'
  previewCanvas.dataset.shellImperativeChromePart = 'previewCanvas'
  titlebar.dataset.shellImperativeChromePart = 'titlebar'
  title.dataset.shellImperativeChromePart = 'title'
  tabStrip.dataset.shellImperativeChromePart = 'tabStrip'
  tabStripInner.dataset.shellImperativeChromePart = 'tabStripInner'
  resizeLeft.dataset.shellImperativeChromePart = 'resizeLeft'
  resizeRight.dataset.shellImperativeChromePart = 'resizeRight'
  resizeBottom.dataset.shellImperativeChromePart = 'resizeBottom'
  resizeBottomLeft.dataset.shellImperativeChromePart = 'resizeBottomLeft'
  resizeBottomRight.dataset.shellImperativeChromePart = 'resizeBottomRight'
  splitLeftPane.dataset.shellImperativeChromePart = 'splitLeftPane'
  splitRightPane.dataset.shellImperativeChromePart = 'splitRightPane'
  splitDivider.dataset.shellImperativeChromePart = 'splitDivider'
  frame.className = 'pointer-events-none absolute box-border'
  left.className = 'absolute z-2 box-border bg-(--shell-chrome-bg)'
  right.className = 'absolute z-2 box-border bg-(--shell-chrome-bg)'
  bottom.className = 'absolute z-2 box-border bg-(--shell-chrome-bg)'
  content.className = 'pointer-events-auto absolute z-5 box-border min-h-0 min-w-0 overflow-hidden bg-transparent text-(--shell-text)'
  previewCanvas.className = 'pointer-events-none block h-full w-full select-none'
  titlebar.className = 'absolute right-0 left-0 top-0 box-border flex flex-col overflow-hidden py-0 select-none touch-none'
  title.className = 'flex min-h-0 min-w-0 flex-1 overflow-hidden'
  tabStrip.className = 'flex min-w-0 flex-1 select-none items-stretch overflow-hidden'
  tabStripInner.className = 'flex min-w-0 flex-1 items-stretch overflow-hidden'
  tabStrip.style.setProperty('-webkit-user-drag', 'none')
  controls.className = 'flex shrink-0 items-center gap-1 self-stretch py-0'
  resizeLeft.className = 'pointer-events-auto touch-none z-3 box-border'
  resizeRight.className = 'pointer-events-auto touch-none z-3 box-border'
  resizeBottom.className = 'pointer-events-auto touch-none z-3 box-border'
  resizeBottomLeft.className = 'pointer-events-auto touch-none z-3 box-border'
  resizeBottomRight.className = 'pointer-events-auto touch-none z-3 box-border'
  splitLeftPane.className = 'pointer-events-none absolute box-border'
  splitRightPane.className = 'pointer-events-none absolute box-border'
  splitDivider.className = 'absolute z-6 cursor-col-resize bg-[color-mix(in_srgb,var(--shell-border)_88%,var(--shell-accent)_12%)]'
  setAttr(frame, 'data-shell-window-frame', String(windowId), last)
  setAttr(titlebar, 'data-shell-titlebar', String(windowId), last)
  setAttr(controls, 'data-shell-titlebar-controls', 'true', last)
  setAttr(minimize, 'data-shell-minimize-trigger', String(windowId), last)
  setAttr(maximize, 'data-shell-maximize-trigger', String(windowId), last)
  setAttr(maximize, 'data-shell-snap-picker-trigger', String(windowId), last)
  setAttr(close, 'data-shell-close-trigger', String(windowId), last)
  setAttr(resizeLeft, 'data-shell-resize-left', String(windowId), last)
  setAttr(resizeRight, 'data-shell-resize-right', String(windowId), last)
  setAttr(resizeBottom, 'data-shell-resize-bottom', String(windowId), last)
  setAttr(resizeBottomLeft, 'data-shell-resize-bottom-left', String(windowId), last)
  setAttr(resizeBottomRight, 'data-shell-resize-bottom-right', String(windowId), last)
  minimize.textContent = '−'
  close.textContent = '×'
  controls.append(minimize, maximize, close)
  const row = document.createElement('div')
  row.className = 'flex min-h-0 min-w-0 flex-1 flex-row items-stretch gap-1.5 overflow-hidden py-0 pr-1.5 pl-2.5'
  content.append(previewCanvas)
  tabStrip.append(tabStripInner)
  title.append(tabStrip)
  row.append(title, controls)
  titlebar.append(row)
  frame.append(left, right, bottom, content, titlebar, resizeLeft, resizeRight, resizeBottom, resizeBottomLeft, resizeBottomRight)
  return { frame, left, right, bottom, content, previewCanvas, titlebar, title, tabStrip, tabStripInner, controls, minimize, maximize, close, resizeLeft, resizeRight, resizeBottom, resizeBottomLeft, resizeBottomRight, splitLeftPane, splitRightPane, splitDivider, tabs: new Map(), dropSlots: new Map(), last }
}

function createSurfaceNodes(): SurfaceNodes {
  const overlay = document.createElement('div')
  const overlayInner = document.createElement('div')
  const stripLayer = document.createElement('div')
  const stripButton = button('pointer-events-auto border border-(--shell-border) bg-(--shell-surface-panel) text-(--shell-text) absolute top-2 left-1/2 flex h-8 min-w-[132px] -translate-x-1/2 items-center justify-center rounded-full px-4 text-[12px] font-semibold shadow-lg transition-colors', 'Snap layouts')
  const dragOverlay = document.createElement('div')
  const dragHighlight = document.createElement('div')
  const dragLine = document.createElement('div')
  const externalGhost = document.createElement('div')
  const externalGhostLabel = document.createElement('span')
  const splitOverlay = document.createElement('div')
  const last: SurfaceNodes['last'] = {}
  overlay.dataset.shellImperativeChromePart = 'snapOverlay'
  overlayInner.dataset.shellImperativeChromePart = 'snapOverlayInner'
  stripLayer.dataset.shellImperativeChromePart = 'snapStripLayer'
  stripButton.dataset.shellImperativeChromePart = 'snapStripButton'
  dragOverlay.dataset.shellImperativeChromePart = 'dragOverlay'
  dragHighlight.dataset.shellImperativeChromePart = 'dragHighlight'
  dragLine.dataset.shellImperativeChromePart = 'dragLine'
  externalGhost.dataset.shellImperativeChromePart = 'externalGhost'
  splitOverlay.dataset.shellImperativeChromePart = 'splitGestureOverlay'
  overlay.className = 'pointer-events-none fixed z-450000'
  overlayInner.className = 'absolute inset-0'
  stripLayer.className = 'pointer-events-none fixed z-401200'
  dragOverlay.className = 'fixed inset-0 z-[2000001]'
  dragHighlight.className = 'pointer-events-none fixed rounded-sm bg-[color-mix(in_srgb,var(--shell-accent-soft)_80%,transparent)] ring-1 ring-[color-mix(in_srgb,var(--shell-accent)_58%,transparent)]'
  dragLine.className = 'pointer-events-none fixed rounded-full bg-(--shell-accent) shadow-[0_0_0_1px_var(--shell-accent),0_0_18px_color-mix(in_srgb,var(--shell-accent)_55%,transparent)]'
  externalGhost.className = 'pointer-events-none fixed max-w-[260px] rounded-md border bg-(--shell-surface-panel)/95 px-2.5 py-1.5 text-xs font-medium text-(--shell-text) shadow-lg ring-1'
  externalGhostLabel.className = 'block truncate'
  splitOverlay.className = 'fixed inset-0 z-470110 touch-none'
  stripButton.type = 'button'
  stripButton.textContent = 'Snap layouts'
  externalGhost.append(externalGhostLabel)
  setAttr(stripButton, 'data-shell-snap-strip-trigger', 'true', last)
  setAttr(externalGhost, 'data-file-tab-drag-preview', '', last)
  setStyle(dragOverlay, 'display', 'none', last)
  setStyle(splitOverlay, 'display', 'none', last)
  overlay.append(overlayInner)
  stripLayer.append(stripButton)
  dragOverlay.append(dragHighlight, dragLine, externalGhost)
  return {
    overlay,
    overlayInner,
    overlayLines: new Map(),
    stripLayer,
    stripButton,
    dragOverlay,
    dragHighlight,
    dragLine,
    externalGhost,
    splitOverlay,
    last,
    stripExclusionUnregister: null,
  }
}

function rightTabIds(group: WorkspaceGroupModel): number[] {
  if (group.splitLeftWindowId === null) return group.members.map((window) => window.window_id)
  return group.members.filter((window) => window.window_id !== group.splitLeftWindowId).map((window) => window.window_id)
}

function rightStripIndexToInsertIndex(group: WorkspaceGroupModel, index: number): number {
  if (group.splitLeftWindowId === null) return index
  const ids = rightTabIds(group)
  if (index >= ids.length) {
    let lastRightIndex = -1
    for (let memberIndex = 0; memberIndex < group.members.length; memberIndex += 1) {
      if (group.members[memberIndex]!.window_id !== group.splitLeftWindowId) lastRightIndex = memberIndex
    }
    return lastRightIndex + 1
  }
  const targetWindowId = ids[index]
  const targetIndex = group.members.findIndex((window) => window.window_id === targetWindowId)
  return targetIndex < 0 ? group.members.length : targetIndex
}

function setBox(node: HTMLElement, rect: SplitGroupRect, z: number, last: ChromeNode['last']) {
  setStyle(node, 'left', '0', last)
  setStyle(node, 'top', '0', last)
  setStyle(node, 'width', `${rect.width}px`, last)
  setStyle(node, 'height', `${rect.height}px`, last)
  setStyle(node, 'transform', `translate3d(${rect.x}px, ${rect.y}px, 0)`, last)
  setStyle(node, 'will-change', 'transform', last)
  setStyle(node, 'z-index', String(z), last)
  setStyle(node, 'contain', 'layout paint', last)
}

function tabStripRect(rect: DOMRect): WorkspaceTabStripRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  }
}

export function createImperativeChromeRenderer(options: ImperativeChromeRendererOptions) {
  const windows = new Map<number, DerpWindow>()
  const nodes = new Map<number, ChromeNode>()
  const csdDropStrips = new Map<string, CsdDropStripNode>()
  const renderedGroupsByFrameWindowId = new Map<number, WorkspaceGroupModel>()
  let surfaceNodes: SurfaceNodes | null = null
  let workspace = createEmptyWorkspaceSnapshot()
  let previousGroups: WorkspaceGroupModel[] = []
  let interaction: InteractionState | null = null
  let focusedWindowId: number | null = null
  let raf = 0
  let splitGesture: SplitGestureState | null = null
  let pendingTitlebarDrag: {
    pointerId: number
    windowId: number
    clientX: number
    clientY: number
    timer: number
    moveOptions?: { snapAssist?: boolean }
  } | null = null
  const titlebarLastClickByWindow = new Map<number, { t: number; x: number; y: number }>()

  const schedule = () => {
    if (raf !== 0) return
    raf = requestAnimationFrame(() => {
      raf = 0
      apply()
    })
  }

  createEffect(() => {
    options.desktopApps()
    options.layoutCanvasOrigin()
    options.outputGeom()
    options.assistOverlay()
    options.snapStrip()
    options.snapStripScreen()
    options.snapStripExclusionActive()
    options.activeDragWindowId()
    options.activeDropTarget()
    options.tabDragState()
    options.activeWindowDragWindowId()
    options.activeWindowDragTarget()
    options.externalTabDropDrag()
    options.splitGroupGesture()
    options.nativeDragPreview()
    schedule()
  })

  const buildGroups = () => {
    previousGroups = buildWorkspaceGroups(workspace, windows, previousGroups)
    return previousGroups
  }

  const shouldRender = (window: DerpWindow) => {
    if (windowIsShellHosted(window)) return false
    if (window.client_side_decoration) return false
    if (!window.workspace_visible || window.minimized) return false
    return true
  }

  const splitLayoutForGroup = (group: WorkspaceGroupModel, overrideGroupRect?: SplitGroupRect): SplitLayoutRects | null => {
    if (!group.splitLeftWindow || group.splitPaneFraction === null) return null
    const stateGroup = workspace.groups.find((entry) => entry.id === group.id)
    if (!stateGroup) return null
    const rightWindowIds = stateGroup.windowIds.filter((windowId) => windowId !== group.splitLeftWindowId)
    if (rightWindowIds.length === 0) return null
    const leftWindow = group.splitLeftWindow
    const rightWindow = windows.get(group.visibleWindowId) ?? group.visibleWindow
    const overlapping =
      leftWindow.x === rightWindow.x &&
      leftWindow.y === rightWindow.y &&
      leftWindow.width === rightWindow.width &&
      leftWindow.height === rightWindow.height
    const groupRect =
      overrideGroupRect ??
      (overlapping
        ? { x: rightWindow.x, y: rightWindow.y, width: rightWindow.width, height: rightWindow.height }
        : {
            x: Math.min(leftWindow.x, rightWindow.x),
            y: Math.min(leftWindow.y, rightWindow.y),
            width: Math.max(leftWindow.x + leftWindow.width, rightWindow.x + rightWindow.width) - Math.min(leftWindow.x, rightWindow.x),
            height: Math.max(leftWindow.y + leftWindow.height, rightWindow.y + rightWindow.height) - Math.min(leftWindow.y, rightWindow.y),
          })
    const contentWidth = Math.max(2 * WORKSPACE_SPLIT_MIN_PANE_PX, groupRect.width)
    const leftWidth = Math.max(
      WORKSPACE_SPLIT_MIN_PANE_PX,
      Math.min(
        contentWidth - WORKSPACE_SPLIT_MIN_PANE_PX,
        Math.round(contentWidth * clampWorkspaceSplitPaneFraction(group.splitPaneFraction)),
      ),
    )
    const rightWidth = Math.max(WORKSPACE_SPLIT_MIN_PANE_PX, contentWidth - leftWidth)
    return {
      group: {
        x: groupRect.x,
        y: groupRect.y,
        width: leftWidth + rightWidth,
        height: Math.max(WORKSPACE_SPLIT_MIN_HEIGHT_PX, groupRect.height),
      },
      left: {
        x: groupRect.x,
        y: groupRect.y,
        width: leftWidth,
        height: Math.max(WORKSPACE_SPLIT_MIN_HEIGHT_PX, groupRect.height),
      },
      right: {
        x: groupRect.x + leftWidth,
        y: groupRect.y,
        width: rightWidth,
        height: Math.max(WORKSPACE_SPLIT_MIN_HEIGHT_PX, groupRect.height),
      },
      leftWindowId: group.splitLeftWindowId!,
      rightWindowIds,
    }
  }

  const applySplitGroupGeometry = (group: WorkspaceGroupModel, layout: SplitLayoutRects) => {
    for (const windowId of [layout.leftWindowId, ...layout.rightWindowIds]) {
      const rect = windowId === layout.leftWindowId ? layout.left : layout.right
      options.shellWireSend('set_geometry', windowId, rect.x, rect.y, rect.width, rect.height, SHELL_LAYOUT_FLOATING)
    }
    const rightWindow = windows.get(group.visibleWindowId)
    if (rightWindow?.minimized) queueMicrotask(() => options.shellWireSend('taskbar_activate', group.visibleWindowId))
  }

  const endSplitGesture = () => {
    if (!splitGesture) return
    splitGesture = null
    options.shellWireSend('shell_ui_grab_end')
    window.removeEventListener('pointermove', onSplitGesturePointerMove, true)
    window.removeEventListener('pointerup', onSplitGesturePointerDone, true)
    window.removeEventListener('pointercancel', onSplitGesturePointerDone, true)
  }

  const beginSplitGesture = (group: WorkspaceGroupModel, pointerId: number, kind: SplitGestureState['kind'], edges: number, clientX: number, clientY: number) => {
    const layout = splitLayoutForGroup(group)
    const global = options.shellPointerGlobalLogical(clientX, clientY)
    if (!layout || !global) return false
    endSplitGesture()
    splitGesture = {
      pointerId,
      groupId: group.id,
      kind,
      edges,
      startGlobalX: global.x,
      startGlobalY: global.y,
      originGroupRect: layout.group,
    }
    const grabWindowId = group.visibleWindowId ?? group.splitLeftWindowId ?? group.members[0]?.window_id ?? 0
    if (grabWindowId > 0) options.shellWireSend('shell_ui_grab_begin', grabWindowId)
    window.addEventListener('pointermove', onSplitGesturePointerMove, true)
    window.addEventListener('pointerup', onSplitGesturePointerDone, true)
    window.addEventListener('pointercancel', onSplitGesturePointerDone, true)
    return true
  }

  const updateSplitGesture = (pointerId: number, clientX: number, clientY: number) => {
    const gesture = splitGesture
    if (!gesture || gesture.pointerId !== pointerId) return
    const global = options.shellPointerGlobalLogical(clientX, clientY)
    if (!global) return
    const group = previousGroups.find((entry) => entry.id === gesture.groupId) ?? null
    if (!group) return
    if (gesture.kind === 'divider') {
      const relativeX = Math.max(0, Math.min(gesture.originGroupRect.width, global.x - gesture.originGroupRect.x))
      options.setSplitGroupFraction(gesture.groupId, clampWorkspaceSplitPaneFraction(relativeX / Math.max(1, gesture.originGroupRect.width)))
      const layout = splitLayoutForGroup(group, gesture.originGroupRect)
      if (layout) applySplitGroupGeometry(group, layout)
      return
    }
    const dx = global.x - gesture.startGlobalX
    const dy = global.y - gesture.startGlobalY
    const nextRect = { ...gesture.originGroupRect }
    if (gesture.kind === 'move') {
      nextRect.x = gesture.originGroupRect.x + dx
      nextRect.y = gesture.originGroupRect.y + dy
    } else {
      if ((gesture.edges & SHELL_RESIZE_LEFT) !== 0) {
        const maxLeft = gesture.originGroupRect.x + gesture.originGroupRect.width - 2 * WORKSPACE_SPLIT_MIN_PANE_PX
        const nextX = Math.min(gesture.originGroupRect.x + dx, maxLeft)
        nextRect.x = nextX
        nextRect.width = gesture.originGroupRect.width + (gesture.originGroupRect.x - nextX)
      }
      if ((gesture.edges & SHELL_RESIZE_RIGHT) !== 0) {
        nextRect.width = Math.max(2 * WORKSPACE_SPLIT_MIN_PANE_PX, gesture.originGroupRect.width + dx)
      }
      if ((gesture.edges & SHELL_RESIZE_BOTTOM) !== 0) {
        nextRect.height = Math.max(WORKSPACE_SPLIT_MIN_HEIGHT_PX, gesture.originGroupRect.height + dy)
      }
    }
    const layout = splitLayoutForGroup(group, nextRect)
    if (layout) applySplitGroupGeometry(group, layout)
  }

  function onSplitGesturePointerMove(event: PointerEvent) {
    updateSplitGesture(event.pointerId, event.clientX, event.clientY)
  }

  function onSplitGesturePointerDone(event: PointerEvent) {
    if (splitGesture?.pointerId === event.pointerId) endSplitGesture()
  }

  const publishTabStripLayout = (node: ChromeNode, group: WorkspaceGroupModel) => {
    const slots: WorkspaceTabStripLayout['slots'] = []
    for (const slot of node.tabStrip.querySelectorAll('[data-tab-drop-slot]')) {
      if (!(slot instanceof HTMLElement)) continue
      const value = slot.getAttribute('data-tab-drop-slot')
      const split = value?.lastIndexOf(':') ?? -1
      if (!value || split < 0) continue
      const insertIndex = Number(value.slice(split + 1))
      if (!Number.isFinite(insertIndex)) continue
      slots.push({ insertIndex: Math.trunc(insertIndex), rect: tabStripRect(slot.getBoundingClientRect()) })
    }
    const tabs: WorkspaceTabStripLayout['tabs'] = []
    for (const tab of node.tabStrip.querySelectorAll('[data-workspace-tab]')) {
      if (!(tab instanceof HTMLElement)) continue
      const windowId = Number(tab.getAttribute('data-workspace-tab'))
      if (!Number.isFinite(windowId)) continue
      tabs.push({
        windowId: Math.trunc(windowId),
        splitLeft: tab.getAttribute('data-workspace-split-left-tab') !== null,
        rect: tabStripRect(tab.getBoundingClientRect()),
      })
    }
    options.setTabStripLayout(group.id, {
      groupId: group.id,
      strip: tabStripRect(node.tabStrip.getBoundingClientRect()),
      slots,
      tabs,
    })
  }

  const renderTabs = (node: ChromeNode, group: WorkspaceGroupModel, activeDragWindowId: number | null, dropTarget: { groupId: string; insertIndex: number } | null) => {
    setAttr(node.tabStrip, 'data-workspace-tab-strip', group.id, node.last)
    const liveTabs = new Set<number>()
    const liveSlots = new Set<string>()
    const leftId = group.splitLeftWindowId
    const orderedIds = leftId === null ? rightTabIds(group) : [leftId, ...rightTabIds(group)]
    for (let displayIndex = 0; displayIndex < orderedIds.length; displayIndex += 1) {
      const windowId = orderedIds[displayIndex]!
      const member = group.members.find((window) => window.window_id === windowId)
      if (!member) continue
      const splitLeft = leftId === windowId
      if (!splitLeft) {
        const slotKey = `${group.id}:${rightStripIndexToInsertIndex(group, displayIndex - (leftId === null ? 0 : 1))}`
        liveSlots.add(slotKey)
        let slot = node.dropSlots.get(slotKey)
        if (!slot) {
          slot = document.createElement('div')
          slot.className = 'h-full w-1.5 shrink-0 bg-transparent transition-all'
          node.dropSlots.set(slotKey, slot)
        }
        setAttr(slot, 'data-tab-drop-slot', slotKey, node.last)
        const active = dropTarget?.groupId === group.id && dropTarget.insertIndex === rightStripIndexToInsertIndex(group, displayIndex - (leftId === null ? 0 : 1))
        setAttr(slot, 'data-tab-drop-active', active ? 'true' : 'false', node.last)
        setClass(slot, 'bg-(--shell-accent)', active, node.last)
        node.tabStripInner.append(slot)
      }
      liveTabs.add(windowId)
      let tab = node.tabs.get(windowId)
      if (!tab) {
        tab = document.createElement('div')
        const buttonEl = document.createElement('button')
        const icon = document.createElement('span')
        const labelWrap = document.createElement('span')
        const pin = document.createElement('span')
        const label = document.createElement('span')
        const close = button('mr-1 flex h-4.5 w-4.5 shrink-0 cursor-pointer items-center justify-center self-center rounded-sm text-(--shell-text-dim) opacity-70 transition-opacity hover:text-(--shell-text) hover:opacity-100', '')
        buttonEl.type = 'button'
        close.type = 'button'
        buttonEl.dataset.shellImperativeChromePart = `tabButton:${windowId}`
        icon.dataset.shellImperativeChromePart = `tabIcon:${windowId}`
        labelWrap.dataset.shellImperativeChromePart = `tabLabelWrap:${windowId}`
        pin.dataset.shellImperativeChromePart = `tabPin:${windowId}`
        label.dataset.shellImperativeChromePart = `tabLabel:${windowId}`
        close.dataset.shellImperativeChromePart = `tabClose:${windowId}`
        close.innerHTML = '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>'
        tab.className = 'group flex min-h-0 min-w-0 flex-[0_1_auto] items-stretch overflow-hidden border-r border-(--shell-border) transition-colors'
        buttonEl.className = 'flex h-full min-h-0 min-w-0 flex-1 cursor-grab select-none items-center gap-1.5 truncate px-2.5 py-1 text-left text-[11px] font-medium active:cursor-grabbing'
        icon.className = 'flex h-3.5 w-3.5 shrink-0 items-center justify-center text-(--shell-text-dim) transition-colors'
        labelWrap.className = 'flex min-w-0 items-center gap-1'
        pin.className = 'h-1.5 w-1.5 shrink-0 rounded-full bg-(--shell-accent)'
        label.className = 'min-w-0 truncate'
        tab.draggable = false
        buttonEl.draggable = false
        icon.draggable = false
        label.draggable = false
        buttonEl.style.setProperty('-webkit-user-drag', 'none')
        icon.setAttribute('aria-hidden', 'true')
        buttonEl.addEventListener('pointerdown', (event) => {
          if (!event.isPrimary || event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          const id = coerceWindowId(buttonEl.getAttribute('data-workspace-tab'))
          if (id === null) return
          if (buttonEl.hasAttribute('data-workspace-split-left-tab')) return
          options.startTabPointerGesture(id, event.pointerId, event.clientX, event.clientY, event.button)
        })
        buttonEl.addEventListener('click', (event) => {
          event.stopPropagation()
          const id = coerceWindowId(buttonEl.getAttribute('data-workspace-tab'))
          if (id !== null) options.selectGroupWindow(id)
        })
        buttonEl.addEventListener('contextmenu', (event) => {
          event.preventDefault()
          event.stopPropagation()
          const id = coerceWindowId(buttonEl.getAttribute('data-workspace-tab'))
          if (id !== null) options.shellContextOpenTabMenu(id, event.clientX, event.clientY)
        })
        labelWrap.append(pin, label)
        buttonEl.append(icon, labelWrap)
        tab.append(buttonEl, close)
        node.tabs.set(windowId, tab)
      }
      const buttonEl = tab.querySelector(`[data-shell-imperative-chrome-part="tabButton:${windowId}"]`) as HTMLButtonElement
      const icon = tab.querySelector(`[data-shell-imperative-chrome-part="tabIcon:${windowId}"]`) as HTMLSpanElement
      const label = tab.querySelector(`[data-shell-imperative-chrome-part="tabLabel:${windowId}"]`) as HTMLSpanElement
      const pin = tab.querySelector(`[data-shell-imperative-chrome-part="tabPin:${windowId}"]`) as HTMLSpanElement
      const close = tab.querySelector(`[data-shell-imperative-chrome-part="tabClose:${windowId}"]`) as HTMLButtonElement
      const active = member.window_id === group.visibleWindowId
      const pinned = isWorkspaceWindowPinned(workspace, member.window_id)
      tab.className = [
        'group flex min-h-0 min-w-0 flex-[0_1_auto] items-stretch overflow-hidden border-r border-(--shell-border) transition-colors',
        active ? 'bg-(--shell-control-muted-bg) text-(--shell-text)' : 'bg-transparent text-(--shell-text-muted) hover:bg-[color-mix(in_srgb,var(--shell-control-muted-bg)_42%,transparent)] hover:text-(--shell-text)',
        activeDragWindowId === member.window_id ? 'bg-[color-mix(in_srgb,var(--shell-control-muted-bg)_88%,transparent)] text-(--shell-text) opacity-72' : '',
        splitLeft ? 'rounded-l-md border-l border-(--shell-border) bg-[color-mix(in_srgb,var(--shell-control-muted-bg)_55%,transparent)]' : '',
        leftId === null ? 'max-w-[240px]' : 'max-w-[104px]',
      ].filter(Boolean).join(' ')
      buttonEl.className = [
        'flex h-full min-h-0 min-w-0 flex-1 select-none items-center gap-1.5 truncate px-2.5 py-1 text-left text-[11px] font-medium',
        splitLeft ? 'cursor-pointer active:cursor-pointer' : 'cursor-grab active:cursor-grabbing',
        pinned ? 'pr-2' : '',
      ].filter(Boolean).join(' ')
      icon.className = [
        'flex h-3.5 w-3.5 shrink-0 items-center justify-center text-(--shell-text-dim) transition-colors',
        active || activeDragWindowId === member.window_id || splitLeft ? 'text-(--shell-text)' : 'text-(--shell-text-muted)',
      ].filter(Boolean).join(' ')
      const desktopIcon = resolveWindowDesktopIcon(options.desktopApps(), member)
      const base = shellHttpBase()
      const iconSrc = desktopIcon && base ? `${base}/desktop_icon?name=${encodeURIComponent(desktopIcon)}` : ''
      const iconKey = `${iconSrc}:${desktopIcon}:${member.title}:${member.app_id}:${active ? 1 : 0}`
      if (node.last[`icon:${member.window_id}`] !== iconKey) {
        node.last[`icon:${member.window_id}`] = iconKey
        icon.innerHTML = iconSrc
          ? `<span class="flex shrink-0 items-center justify-center rounded-md text-white shadow-sm" style="width:18px;height:18px;background-color:transparent;opacity:${active ? '1' : '0.92'}"><img src="${iconSrc}" class="h-full w-full object-contain" draggable="false"></span>`
          : `<span class="flex shrink-0 items-center justify-center rounded-md text-white shadow-sm" style="width:18px;height:18px;background-color:${iconAccent(member, desktopIcon)};opacity:${active ? '1' : '0.92'}"><span class="text-[10px] font-semibold leading-none">${iconMonogram(member)}</span></span>`
      }
      setAttr(buttonEl, 'data-workspace-tab', String(member.window_id), node.last)
      setAttr(buttonEl, 'data-workspace-tab-id', String(member.window_id), node.last)
      setAttr(buttonEl, 'data-workspace-tab-group', group.id, node.last)
      setAttr(buttonEl, 'data-workspace-tab-pinned', pinned ? 'true' : 'false', node.last)
      if (splitLeft) setAttr(buttonEl, 'data-workspace-split-left-tab', '', node.last)
      else removeAttr(buttonEl, 'data-workspace-split-left-tab', node.last)
      setAttr(icon, 'data-workspace-tab-handle', String(member.window_id), node.last)
      setAttr(close, 'data-workspace-tab-close', String(member.window_id), node.last)
      setText(label, windowLabel(member), node.last)
      setHidden(pin, !pinned, node.last)
      setHidden(close, group.members.length <= 1, node.last)
      if (splitLeft) node.tabStrip.insertBefore(tab, node.tabStripInner)
      else node.tabStripInner.append(tab)
    }
    const finalSlotKey = `${group.id}:${rightStripIndexToInsertIndex(group, rightTabIds(group).length)}`
    liveSlots.add(finalSlotKey)
    let finalSlot = node.dropSlots.get(finalSlotKey)
    if (!finalSlot) {
      finalSlot = document.createElement('div')
      finalSlot.className = 'h-full w-1.5 shrink-0 bg-transparent transition-all'
      node.dropSlots.set(finalSlotKey, finalSlot)
    }
    setAttr(finalSlot, 'data-tab-drop-slot', finalSlotKey, node.last)
    const finalActive = dropTarget?.groupId === group.id && dropTarget.insertIndex === rightStripIndexToInsertIndex(group, rightTabIds(group).length)
    setAttr(finalSlot, 'data-tab-drop-active', finalActive ? 'true' : 'false', node.last)
    setClass(finalSlot, 'bg-(--shell-accent)', finalActive, node.last)
    node.tabStripInner.append(finalSlot)
    for (const [id, tab] of node.tabs) {
      if (liveTabs.has(id)) continue
      tab.remove()
      node.tabs.delete(id)
    }
    for (const [key, slot] of node.dropSlots) {
      if (liveSlots.has(key)) continue
      slot.remove()
      node.dropSlots.delete(key)
    }
    publishTabStripLayout(node, group)
  }

  const renderWindow = (node: ChromeNode, window: RendererWindow, focused: boolean, dragging: boolean, hidden: boolean, group: WorkspaceGroupModel | null, splitLayout: SplitLayoutRects | null) => {
    const layout = shellWindowFrameLayout(window)
    const chromeBg = focused ? 'var(--shell-window-chrome-focused)' : 'var(--shell-window-chrome-unfocused)'
    setAttr(node.frame, 'data-shell-window-hidden', hidden ? 'true' : 'false', node.last)
    setAttr(node.frame, 'data-shell-window-dragging', dragging ? 'true' : 'false', node.last)
    setStyle(node.frame, 'z-index', String(1000 + window.stack_z + (dragging ? 1_000_000 : 0)), node.last)
    setStyle(node.frame, 'left', '0', node.last)
    setStyle(node.frame, 'top', '0', node.last)
    setStyle(node.frame, 'width', `${layout.ow}px`, node.last)
    setStyle(node.frame, 'height', `${layout.oh}px`, node.last)
    setStyle(node.frame, 'transform', `translate3d(${layout.ox}px, ${layout.oy}px, 0)`, node.last)
    setStyle(node.frame, 'will-change', 'transform', node.last)
    setStyle(node.frame, 'box-sizing', 'border-box', node.last)
    setStyle(node.frame, 'pointer-events', 'none', node.last)
    setStyle(node.frame, 'contain', 'layout paint', node.last)
    setStyle(node.frame, 'background', 'transparent', node.last)
    setStyle(node.frame, '--shell-chrome-bg', chromeBg, node.last)
    setStyle(node.frame, 'visibility', hidden ? 'hidden' : 'visible', node.last)
    setStyle(node.frame, 'opacity', hidden ? '0' : dragging ? '0.76' : '1', node.last)
    setStyle(node.left, 'left', '0', node.last)
    setStyle(node.left, 'top', `${layout.insetTop + layout.th}px`, node.last)
    setStyle(node.left, 'width', `${layout.inset}px`, node.last)
    setStyle(node.left, 'bottom', '0', node.last)
    setStyle(node.right, 'right', '0', node.last)
    setStyle(node.right, 'top', `${layout.insetTop + layout.th}px`, node.last)
    setStyle(node.right, 'width', `${layout.inset}px`, node.last)
    setStyle(node.right, 'bottom', '0', node.last)
    setStyle(node.bottom, 'left', `${layout.inset}px`, node.last)
    setStyle(node.bottom, 'right', `${layout.inset}px`, node.last)
    setStyle(node.bottom, 'bottom', '0', node.last)
    setStyle(node.bottom, 'height', `${layout.inset}px`, node.last)
    setHidden(node.left, !layout.showBorderChrome, node.last)
    setHidden(node.right, !layout.showBorderChrome, node.last)
    setHidden(node.bottom, !layout.showBorderChrome, node.last)
    setHidden(node.titlebar, layout.th <= 0, node.last)
    setStyle(node.titlebar, 'height', `${layout.insetTop + layout.th}px`, node.last)
    setStyle(node.titlebar, 'box-sizing', 'border-box', node.last)
    setStyle(node.titlebar, 'z-index', '6', node.last)
    setStyle(node.titlebar, 'background', 'var(--shell-chrome-bg)', node.last)
    setStyle(node.titlebar, 'pointer-events', dragging ? 'none' : 'auto', node.last)
    setClass(node.title, 'text-(--shell-text-muted)', !focused, node.last)
    setClass(node.title, 'text-(--shell-text)', focused, node.last)
    if (group) renderTabs(node, group, options.activeDragWindowId() ?? interaction?.move_window_id ?? null, options.activeDropTarget())
    const maxTitle = window.maximized ? 'Restore' : 'Maximize'
    if (node.last.maximizeTitle !== maxTitle) {
      node.last.maximizeTitle = maxTitle
      node.maximize.title = maxTitle
    }
    if (node.last.maximizeIcon !== window.maximized) {
      node.last.maximizeIcon = window.maximized
      node.maximize.innerHTML = window.maximized
        ? '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="miter" d="M1.5 3.5h7v7h-7z M3.5 1.5h7v7h-7z"></path></svg>'
        : '<svg class="block shrink-0" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.35"></rect></svg>'
    }
    setStyle(node.content, 'left', `${layout.contentLeft}px`, node.last)
    setStyle(node.content, 'top', `${layout.contentTop}px`, node.last)
    setStyle(node.content, 'width', `${layout.contentW}px`, node.last)
    setStyle(node.content, 'height', `${layout.contentH}px`, node.last)
    setStyle(node.content, 'background', 'transparent', node.last)
    setStyle(node.content, 'pointer-events', 'none', node.last)
    const preview = options.nativeDragPreview()
    const previewVisible =
      preview?.loaded === true &&
      preview.window_id === window.window_id &&
      (interaction?.move_window_id === window.window_id ||
        interaction?.move_proxy_window_id === window.window_id ||
        interaction?.move_capture_window_id === window.window_id)
    setHidden(node.content, !previewVisible, node.last)
    if (previewVisible && preview?.image && preview.image.complete) {
      const sourceWidth = preview.image.naturalWidth
      const sourceHeight = preview.image.naturalHeight
      if (sourceWidth > 0 && sourceHeight > 0) {
        if (node.previewCanvas.width !== sourceWidth) node.previewCanvas.width = sourceWidth
        if (node.previewCanvas.height !== sourceHeight) node.previewCanvas.height = sourceHeight
        setAttr(node.content, 'data-shell-native-drag-preview-src-width', String(sourceWidth), node.last)
        setAttr(node.content, 'data-shell-native-drag-preview-src-height', String(sourceHeight), node.last)
        setAttr(node.content, 'data-shell-native-drag-preview-backing-width', String(node.previewCanvas.width), node.last)
        setAttr(node.content, 'data-shell-native-drag-preview-backing-height', String(node.previewCanvas.height), node.last)
        const ctx = node.previewCanvas.getContext('2d')
        if (ctx) {
          ctx.clearRect(0, 0, sourceWidth, sourceHeight)
          ctx.imageSmoothingEnabled = false
          ctx.drawImage(preview.image, 0, 0, sourceWidth, sourceHeight)
        }
      }
      setAttr(node.content, 'data-shell-native-drag-preview', String(preview.window_id), node.last)
      setAttr(node.content, 'data-shell-native-drag-preview-generation', String(preview.generation), node.last)
      setAttr(node.content, 'data-shell-native-drag-preview-loaded', 'true', node.last)
      setAttr(node.content, 'data-shell-native-drag-preview-src', preview.src, node.last)
    } else {
      removeAttr(node.content, 'data-shell-native-drag-preview', node.last)
      removeAttr(node.content, 'data-shell-native-drag-preview-generation', node.last)
      removeAttr(node.content, 'data-shell-native-drag-preview-loaded', node.last)
      removeAttr(node.content, 'data-shell-native-drag-preview-src', node.last)
      removeAttr(node.content, 'data-shell-native-drag-preview-src-width', node.last)
      removeAttr(node.content, 'data-shell-native-drag-preview-src-height', node.last)
      removeAttr(node.content, 'data-shell-native-drag-preview-backing-width', node.last)
      removeAttr(node.content, 'data-shell-native-drag-preview-backing-height', node.last)
    }
    for (const el of [node.resizeLeft, node.resizeRight, node.resizeBottom, node.resizeBottomLeft, node.resizeBottomRight]) {
      setHidden(el, !layout.showBorderChrome, node.last)
      setStyle(el, 'position', 'absolute', node.last)
      setStyle(el, 'pointer-events', dragging ? 'none' : 'auto', node.last)
    }
    setStyle(node.resizeLeft, 'left', '0', node.last)
    setStyle(node.resizeLeft, 'top', `${layout.insetTop + layout.th}px`, node.last)
    setStyle(node.resizeLeft, 'width', `${layout.rh}px`, node.last)
    setStyle(node.resizeLeft, 'bottom', `${layout.rh}px`, node.last)
    setStyle(node.resizeLeft, 'cursor', 'ew-resize', node.last)
    setStyle(node.resizeRight, 'right', '0', node.last)
    setStyle(node.resizeRight, 'top', `${layout.insetTop + layout.th}px`, node.last)
    setStyle(node.resizeRight, 'width', `${layout.rh}px`, node.last)
    setStyle(node.resizeRight, 'bottom', `${layout.rh}px`, node.last)
    setStyle(node.resizeRight, 'cursor', 'ew-resize', node.last)
    setStyle(node.resizeBottom, 'left', `${layout.rh}px`, node.last)
    setStyle(node.resizeBottom, 'bottom', '0', node.last)
    setStyle(node.resizeBottom, 'width', `${Math.max(0, layout.outerW - 2 * layout.rh)}px`, node.last)
    setStyle(node.resizeBottom, 'height', `${layout.rh}px`, node.last)
    setStyle(node.resizeBottom, 'cursor', 'ns-resize', node.last)
    setStyle(node.resizeBottomLeft, 'left', '0', node.last)
    setStyle(node.resizeBottomLeft, 'bottom', '0', node.last)
    setStyle(node.resizeBottomLeft, 'width', `${layout.rh}px`, node.last)
    setStyle(node.resizeBottomLeft, 'height', `${layout.rh}px`, node.last)
    setStyle(node.resizeBottomLeft, 'cursor', 'nesw-resize', node.last)
    setStyle(node.resizeBottomRight, 'right', '0', node.last)
    setStyle(node.resizeBottomRight, 'bottom', '0', node.last)
    setStyle(node.resizeBottomRight, 'width', `${layout.rh}px`, node.last)
    setStyle(node.resizeBottomRight, 'height', `${layout.rh}px`, node.last)
    setStyle(node.resizeBottomRight, 'cursor', 'nwse-resize', node.last)
    if (splitLayout && group) {
      if (!node.splitLeftPane.isConnected) node.frame.after(node.splitLeftPane, node.splitRightPane, node.splitDivider)
      setAttr(node.splitLeftPane, 'data-workspace-split-left-pane', String(splitLayout.leftWindowId), node.last)
      setAttr(node.splitRightPane, 'data-workspace-split-right-pane', String(group.visibleWindowId), node.last)
      setAttr(node.splitDivider, 'data-workspace-split-divider', group.id, node.last)
      setAttr(node.splitDivider, 'data-testid', 'workspace-split-divider', node.last)
      setBox(node.splitLeftPane, splitLayout.left, 1005 + window.stack_z, node.last)
      setBox(node.splitRightPane, splitLayout.right, 1005 + window.stack_z, node.last)
      setStyle(node.splitDivider, 'left', '0', node.last)
      setStyle(node.splitDivider, 'top', '0', node.last)
      setStyle(node.splitDivider, 'width', `${WORKSPACE_SPLIT_DIVIDER_PX}px`, node.last)
      setStyle(node.splitDivider, 'height', `${Math.max(24, splitLayout.left.height - 12)}px`, node.last)
      setStyle(node.splitDivider, 'transform', `translate3d(${splitLayout.left.x + splitLayout.left.width - Math.floor(WORKSPACE_SPLIT_DIVIDER_PX / 2)}px, ${splitLayout.left.y + 6}px, 0)`, node.last)
      setStyle(node.splitDivider, 'will-change', 'transform', node.last)
      setStyle(node.splitDivider, 'z-index', `${1006 + window.stack_z}`, node.last)
    } else {
      node.splitLeftPane.remove()
      node.splitRightPane.remove()
      node.splitDivider.remove()
    }
  }

  const ensureSurfaceNodes = (root: HTMLElement) => {
    if (surfaceNodes) return surfaceNodes
    surfaceNodes = createSurfaceNodes()
    root.append(surfaceNodes.overlay, surfaceNodes.stripLayer, surfaceNodes.dragOverlay, surfaceNodes.splitOverlay)
    return surfaceNodes
  }

  const clearSurfaceNodes = () => {
    if (!surfaceNodes) return
    surfaceNodes.stripExclusionUnregister?.()
    surfaceNodes.stripExclusionUnregister = null
    surfaceNodes.overlay.remove()
    surfaceNodes.stripLayer.remove()
    surfaceNodes.dragOverlay.remove()
    surfaceNodes.splitOverlay.remove()
    surfaceNodes = null
  }

  const renderOverlay = (surface: SurfaceNodes) => {
    const overlay = options.assistOverlay()
    const main = options.getMainRef()
    const output = options.outputGeom()
    if (!overlay || !main || !output) {
      setStyle(surface.overlay, 'display', 'none', surface.last)
      removeAttr(surface.overlay, 'data-shell-snap-overlay', surface.last)
      for (const node of surface.overlayLines.values()) node.remove()
      surface.overlayLines.clear()
      return
    }
    const css = canvasRectToClientCss(
      overlay.workCanvas.x,
      overlay.workCanvas.y,
      overlay.workCanvas.w,
      overlay.workCanvas.h,
      main.getBoundingClientRect(),
      output.w,
      output.h,
    )
    setAttr(surface.overlay, 'data-shell-snap-overlay', overlay.kind, surface.last)
    setStyle(surface.overlay, 'display', 'flex', surface.last)
    setStyle(surface.overlay, 'left', `${css.left}px`, surface.last)
    setStyle(surface.overlay, 'top', `${css.top}px`, surface.last)
    setStyle(surface.overlay, 'width', `${css.width}px`, surface.last)
    setStyle(surface.overlay, 'height', `${css.height}px`, surface.last)
    const live = new Set<string>()
    for (const line of overlayLines(overlay)) {
      live.add(line.key)
      let node = surface.overlayLines.get(line.key)
      if (!node) {
        node = document.createElement('div')
        node.dataset.shellImperativeChromePart = `snapOverlayLine:${line.key}`
        node.className = 'absolute bg-(--shell-preview-outline)'
        surface.overlayLines.set(line.key, node)
        surface.overlayInner.append(node)
      }
      setAttr(node, 'data-shell-snap-overlay-zone', overlay.kind, surface.last)
      setStyle(node, 'left', `${line.x}px`, surface.last)
      setStyle(node, 'top', `${line.y}px`, surface.last)
      setStyle(node, 'width', `${line.width}px`, surface.last)
      setStyle(node, 'height', `${line.height}px`, surface.last)
      setStyle(node, 'opacity', '0.65', surface.last)
    }
    for (const [key, node] of surface.overlayLines) {
      if (live.has(key)) continue
      node.remove()
      surface.overlayLines.delete(key)
    }
  }

  const renderSnapStrip = (surface: SurfaceNodes) => {
    const strip = options.snapStrip()
    const screen = options.snapStripScreen()
    if (!strip || !screen) {
      setStyle(surface.stripLayer, 'display', 'none', surface.last)
      surface.stripExclusionUnregister?.()
      surface.stripExclusionUnregister = null
      return
    }
    const screenRect = options.screenCssRect(screen)
    setStyle(surface.stripLayer, 'display', 'block', surface.last)
    setStyle(surface.stripLayer, 'left', `${screenRect.x}px`, surface.last)
    setStyle(surface.stripLayer, 'top', `${screenRect.y}px`, surface.last)
    setStyle(surface.stripLayer, 'width', `${screenRect.width}px`, surface.last)
    setStyle(surface.stripLayer, 'height', '0px', surface.last)
    setAttr(surface.stripButton, 'data-shell-snap-strip-monitor', strip.monitorName, surface.last)
    setClass(surface.stripButton, 'bg-(--shell-accent-soft)', strip.open, surface.last)
    if (options.snapStripExclusionActive()) {
      if (!surface.stripExclusionUnregister) {
        const registration = registerShellExclusionElement('base', 'snap-strip', surface.stripButton)
        surface.stripExclusionUnregister = registration.unregister
      }
    } else {
      surface.stripExclusionUnregister?.()
      surface.stripExclusionUnregister = null
    }
  }

  const dropIndicatorForTarget = (target: { groupId: string; insertIndex: number } | null) => {
    if (!target) return null
    const slot = document.querySelector(`[data-tab-drop-slot="${target.groupId}:${target.insertIndex}"]`) as HTMLElement | null
    const strip = document.querySelector(`[data-workspace-tab-strip="${target.groupId}"]`) as HTMLElement | null
    if (slot) {
      const slotRect = slot.getBoundingClientRect()
      const stripRect = strip?.getBoundingClientRect() ?? slotRect
      return {
        key: `${target.groupId}:${target.insertIndex}`,
        highlight: {
          left: `${Math.round(stripRect.left)}px`,
          top: `${Math.round(stripRect.top)}px`,
          width: `${Math.round(stripRect.width)}px`,
          height: `${Math.round(stripRect.height)}px`,
        },
        line: {
          left: `${Math.round(slotRect.left - 2)}px`,
          top: `${Math.round(stripRect.top + 2)}px`,
          width: '4px',
          height: `${Math.max(10, Math.round(stripRect.height - 4))}px`,
        },
      }
    }
    const groupStrip = document.querySelector(`[data-workspace-group-drop-strip="${target.groupId}"]`) as HTMLElement | null
    if (!groupStrip) return null
    const stripRect = groupStrip.getBoundingClientRect()
    return {
      key: `${target.groupId}:strip`,
      highlight: {
        left: `${Math.round(stripRect.left)}px`,
        top: `${Math.round(stripRect.top)}px`,
        width: `${Math.round(stripRect.width)}px`,
        height: `${Math.round(stripRect.height)}px`,
      },
      line: {
        left: `${Math.round(stripRect.left + 4)}px`,
        top: `${Math.round(stripRect.bottom - 4)}px`,
        width: `${Math.max(8, Math.round(stripRect.width - 8))}px`,
        height: '4px',
      },
    }
  }

  const renderDragOverlays = (surface: SurfaceNodes) => {
    const tabDrag = options.tabDragState()
    const externalDrag = options.externalTabDropDrag()
    const windowDragWindowId = options.activeWindowDragWindowId()
    const split = options.splitGroupGesture()
    const draggingTab = !!tabDrag?.dragging
    const draggingWindow = windowDragWindowId !== null
    const draggingExternal = externalDrag !== null
    const target = draggingExternal
      ? externalDrag.target
      : draggingWindow
        ? options.activeWindowDragTarget()
        : options.activeDropTarget()
    const indicator = dropIndicatorForTarget(target)
    const showOverlay = draggingTab || draggingWindow || draggingExternal
    setStyle(surface.dragOverlay, 'display', showOverlay ? 'block' : 'none', surface.last)
    setStyle(surface.dragOverlay, 'pointer-events', draggingTab ? 'auto' : 'none', surface.last)
    setAttr(surface.dragOverlay, 'data-tab-drag-capture', draggingTab && tabDrag ? String(tabDrag.windowId) : '', surface.last)
    setAttr(surface.dragOverlay, 'data-window-tab-drop-capture', draggingWindow && windowDragWindowId !== null ? String(windowDragWindowId) : '', surface.last)
    setStyle(surface.dragOverlay, 'cursor', draggingTab ? 'grabbing' : 'default', surface.last)
    if (indicator) {
      setStyle(surface.dragHighlight, 'display', 'block', surface.last)
      setStyle(surface.dragLine, 'display', 'block', surface.last)
      setAttr(surface.dragHighlight, 'data-tab-drop-indicator', indicator.key, surface.last)
      setAttr(surface.dragLine, 'data-tab-drop-indicator-line', indicator.key, surface.last)
      for (const [key, value] of Object.entries(indicator.highlight)) setStyle(surface.dragHighlight, key, value, surface.last)
      for (const [key, value] of Object.entries(indicator.line)) setStyle(surface.dragLine, key, value, surface.last)
    } else {
      setStyle(surface.dragHighlight, 'display', 'none', surface.last)
      setStyle(surface.dragLine, 'display', 'none', surface.last)
      removeAttr(surface.dragHighlight, 'data-tab-drop-indicator', surface.last)
      removeAttr(surface.dragLine, 'data-tab-drop-indicator-line', surface.last)
    }
    if (externalDrag) {
      const width = 260
      const height = 44
      const maxLeft = Math.max(8, window.innerWidth - width - 8)
      const maxTop = Math.max(8, window.innerHeight - height - 8)
      setStyle(surface.externalGhost, 'display', 'block', surface.last)
      setStyle(surface.externalGhost, 'left', `${Math.min(Math.max(8, externalDrag.clientX + 14), maxLeft)}px`, surface.last)
      setStyle(surface.externalGhost, 'top', `${Math.min(Math.max(8, externalDrag.clientY + 14), maxTop)}px`, surface.last)
      setClass(surface.externalGhost, 'border-(--shell-accent)', externalDrag.canDrop, surface.last)
      setClass(surface.externalGhost, 'ring-[color-mix(in_srgb,var(--shell-accent)_48%,transparent)]', externalDrag.canDrop, surface.last)
      setClass(surface.externalGhost, 'border-(--shell-border)', !externalDrag.canDrop, surface.last)
      setClass(surface.externalGhost, 'opacity-85', !externalDrag.canDrop, surface.last)
      setClass(surface.externalGhost, 'ring-[color-mix(in_srgb,var(--shell-border)_60%,transparent)]', !externalDrag.canDrop, surface.last)
      setText(surface.externalGhost.firstElementChild as HTMLElement, externalDrag.label, surface.last)
    } else {
      setStyle(surface.externalGhost, 'display', 'none', surface.last)
    }
    setStyle(surface.splitOverlay, 'display', split ? 'block' : 'none', surface.last)
    setStyle(surface.splitOverlay, 'cursor', split?.kind === 'divider' ? 'col-resize' : split ? 'grabbing' : 'default', surface.last)
  }

  const renderCsdDropStrips = (root: HTMLElement, groups: readonly WorkspaceGroupModel[]) => {
    const live = new Set<string>()
    for (const group of groups) {
      const window = group.visibleWindow
      if (
        group.members.length > 1 ||
        !window?.client_side_decoration ||
        group.splitLeftWindowId !== null ||
        window.minimized ||
        !window.workspace_visible
      ) {
        continue
      }
      live.add(group.id)
      let entry = csdDropStrips.get(group.id)
      if (!entry) {
        entry = { node: document.createElement('div'), last: {} }
        entry.node.className = 'pointer-events-none absolute box-border bg-transparent'
        csdDropStrips.set(group.id, entry)
        root.append(entry.node)
      }
      setAttr(entry.node, 'data-workspace-group-drop-strip', group.id, entry.last)
      setAttr(entry.node, 'data-workspace-group-drop-target-window', String(window.window_id), entry.last)
      setStyle(entry.node, 'left', '0', entry.last)
      setStyle(entry.node, 'top', '0', entry.last)
      setStyle(entry.node, 'width', `${Math.max(1, window.width)}px`, entry.last)
      setStyle(entry.node, 'height', `${Math.min(CSD_GROUP_DROP_STRIP_PX, Math.max(1, window.height))}px`, entry.last)
      setStyle(entry.node, 'transform', `translate3d(${window.x}px, ${window.y}px, 0)`, entry.last)
      setStyle(entry.node, 'z-index', String(1008 + window.stack_z), entry.last)
      setStyle(entry.node, 'contain', 'layout paint', entry.last)
    }
    for (const [groupId, entry] of csdDropStrips) {
      if (live.has(groupId)) continue
      entry.node.remove()
      csdDropStrips.delete(groupId)
      options.setTabStripLayout(groupId, null)
    }
  }

  const apply = () => {
    const start = performance.now()
    const root = options.getRoot()
    if (!root) {
      for (const node of nodes.values()) node.frame.remove()
      nodes.clear()
      for (const entry of csdDropStrips.values()) entry.node.remove()
      csdDropStrips.clear()
      renderedGroupsByFrameWindowId.clear()
      clearSurfaceNodes()
      return
    }
    const surface = ensureSurfaceNodes(root)
    renderOverlay(surface)
    renderSnapStrip(surface)
    renderDragOverlays(surface)
    const live = new Set<number>()
    renderedGroupsByFrameWindowId.clear()
    const groups = buildGroups()
    renderCsdDropStrips(root, groups)
    const renderBase = (base: DerpWindow, group: WorkspaceGroupModel | null, splitLayout: SplitLayoutRects | null) => {
      if (!shouldRender(base)) return
      const liveVisual =
        interaction?.resize_window_id === base.window_id ? interaction.resize_rect :
          interaction?.move_window_id === base.window_id || interaction?.move_proxy_window_id === base.window_id ? interaction.move_rect :
            null
      const window = liveVisual
        ? windowFromRow({
            ...base,
            x: liveVisual.x,
            y: liveVisual.y,
            width: liveVisual.width,
            height: liveVisual.height,
            maximized: liveVisual.maximized,
            fullscreen: liveVisual.fullscreen,
          }, base)
        : base
      const id = window.window_id
      live.add(id)
      if (group) renderedGroupsByFrameWindowId.set(id, group)
      let node = nodes.get(id)
      const newlyCreated = !node
      if (!node) {
        node = createChromeNode(id)
        nodes.set(id, node)
      }
      renderWindow(
        node,
        { ...window, snap_tiled: workspaceIsWindowTiled(workspace, id) },
        focusedWindowId === id,
        interaction?.move_window_id === id || interaction?.resize_window_id === id || interaction?.move_proxy_window_id === id,
        false,
        group,
        splitLayout,
      )
      if (newlyCreated) root.append(node.frame)
      if (newlyCreated && group) publishTabStripLayout(node, group)
    }
    for (const group of groups) {
      const splitLayout = splitLayoutForGroup(group)
      const visible = group.visibleWindow
      renderBase(
        splitLayout
          ? windowModelWithClientRect(visible, {
              x: splitLayout.group.x,
              y: splitLayout.group.y,
              width: splitLayout.group.width,
              height: splitLayout.group.height,
              maximized: false,
              fullscreen: false,
            }, true)
          : visible,
        group,
        splitLayout,
      )
    }
    for (const base of windows.values()) {
      if (workspace.groups.some((group) => group.windowIds.includes(base.window_id))) continue
      renderBase(base, null, null)
    }
    for (const [id, node] of nodes) {
      if (live.has(id)) continue
      node.frame.remove()
      nodes.delete(id)
    }
    noteShellImperativeChromeApply(performance.now() - start, nodes.size + csdDropStrips.size + 7 + (surfaceNodes?.overlayLines.size ?? 0))
  }

  const applyDetails = (details: readonly DerpShellDetail[]) => {
    let changed = false
    for (const detail of details) {
      if (detail.type === 'window_list') {
        const next = new Map<number, DerpWindow>()
        for (const row of detail.windows) {
          const id = coerceWindowId(row.window_id)
          const surfaceId = coerceWindowId(row.surface_id)
          if (id === null || surfaceId === null) continue
          next.set(id, windowFromRow({ ...row, window_id: id, surface_id: surfaceId }, windows.get(id)))
        }
        windows.clear()
        for (const [id, window] of next) windows.set(id, window)
        changed = true
      } else if (detail.type === 'window_mapped') {
        const id = coerceWindowId(detail.window_id)
        const surfaceId = coerceWindowId(detail.surface_id)
        if (id !== null && surfaceId !== null) {
          windows.set(id, windowFromRow({ ...detail, window_id: id, surface_id: surfaceId }, windows.get(id)))
          changed = true
        }
      } else if (detail.type === 'window_unmapped') {
        const id = coerceWindowId(detail.window_id)
        if (id !== null) {
          windows.delete(id)
          changed = true
        }
      } else if (detail.type === 'window_geometry') {
        const id = coerceWindowId(detail.window_id)
        const previous = id === null ? undefined : windows.get(id)
        if (id !== null && previous) {
          windows.set(id, windowFromRow({ ...previous, ...detail, window_id: id, surface_id: detail.surface_id }, previous))
          changed = true
        }
      } else if (detail.type === 'window_metadata') {
        const id = coerceWindowId(detail.window_id)
        const previous = id === null ? undefined : windows.get(id)
        if (id !== null && previous) {
          windows.set(id, windowFromRow({ ...previous, ...detail, window_id: id, surface_id: detail.surface_id }, previous))
          changed = true
        }
      } else if (detail.type === 'window_state') {
        const id = coerceWindowId(detail.window_id)
        const previous = id === null ? undefined : windows.get(id)
        if (id !== null && previous) {
          windows.set(id, { ...previous, minimized: detail.minimized })
          changed = true
        }
      } else if (detail.type === 'window_order') {
        for (const entry of detail.windows) {
          const id = coerceWindowId(entry.window_id)
          const previous = id === null ? undefined : windows.get(id)
          if (id !== null && previous && previous.stack_z !== entry.stack_z) {
            windows.set(id, { ...previous, stack_z: entry.stack_z })
            changed = true
          }
        }
      } else if (detail.type === 'workspace_state') {
        workspace = normalizeWorkspaceSnapshot(detail.state)
        changed = true
      } else if (detail.type === 'interaction_state') {
        interaction = {
          move_window_id: coerceWindowId(detail.move_window_id),
          resize_window_id: coerceWindowId(detail.resize_window_id),
          move_proxy_window_id: coerceWindowId(detail.move_proxy_window_id),
          move_capture_window_id: coerceWindowId(detail.move_capture_window_id),
          move_rect: detail.move_rect,
          resize_rect: detail.resize_rect,
        }
        changed = true
      } else if (detail.type === 'focus_changed') {
        focusedWindowId = coerceWindowId(detail.window_id)
        changed = true
      }
    }
    if (changed) schedule()
  }

  const pointerWindowId = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return null
    const el = target.closest<HTMLElement>('[data-shell-window-frame]')
    return coerceWindowId(el?.getAttribute('data-shell-window-frame') ?? null)
  }

  const clearPendingTitlebarDrag = () => {
    const pending = pendingTitlebarDrag
    if (!pending) return
    window.clearTimeout(pending.timer)
    window.removeEventListener('pointermove', onPendingTitlebarPointerMove, true)
    window.removeEventListener('pointerup', onPendingTitlebarPointerDone, true)
    window.removeEventListener('pointercancel', onPendingTitlebarPointerDone, true)
    pendingTitlebarDrag = null
  }

  const startPendingTitlebarDrag = (pending: NonNullable<typeof pendingTitlebarDrag>, clientX: number, clientY: number) => {
    if (pendingTitlebarDrag !== pending) return
    titlebarLastClickByWindow.delete(pending.windowId)
    clearPendingTitlebarDrag()
    options.beginShellWindowMove(pending.windowId, clientX, clientY, pending.moveOptions)
  }

  function onPendingTitlebarPointerMove(event: PointerEvent) {
    const pending = pendingTitlebarDrag
    if (!pending || pending.pointerId !== event.pointerId) return
    if (Math.abs(event.clientX - pending.clientX) < 1 && Math.abs(event.clientY - pending.clientY) < 1) return
    startPendingTitlebarDrag(pending, event.clientX, event.clientY)
  }

  function onPendingTitlebarPointerDone(event: PointerEvent) {
    if (pendingTitlebarDrag?.pointerId === event.pointerId) clearPendingTitlebarDrag()
  }

  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return
    const target = event.target
    const targetEl = target instanceof Element ? target : null
    const splitDivider = targetEl?.closest<HTMLElement>('[data-workspace-split-divider]') ?? null
    if (splitDivider) {
      const groupId = splitDivider.getAttribute('data-workspace-split-divider')
      const group = groupId ? previousGroups.find((entry) => entry.id === groupId) ?? null : null
      if (!group) return
      event.preventDefault()
      event.stopPropagation()
      beginSplitGesture(group, event.pointerId, 'divider', 0, event.clientX, event.clientY)
      return
    }
    const windowId = pointerWindowId(target)
    if (windowId === null) return
    const tabClose = targetEl?.closest<HTMLElement>('[data-workspace-tab-close]') ?? null
    if (tabClose) {
      const id = coerceWindowId(tabClose.getAttribute('data-workspace-tab-close'))
      if (id === null) return
      event.preventDefault()
      event.stopPropagation()
      options.closeWindow(id)
      return
    }
    if (targetEl?.closest('[data-shell-minimize-trigger]')) {
      event.preventDefault()
      event.stopPropagation()
      options.focusWindowViaShell(windowId)
      options.shellWireSend('minimize', windowId)
      return
    }
    if (targetEl?.closest('[data-shell-maximize-trigger]')) {
      event.preventDefault()
      event.stopPropagation()
      options.focusWindowViaShell(windowId)
      options.toggleShellMaximizeForWindow(windowId)
      return
    }
    if (targetEl?.closest('[data-shell-close-trigger]')) {
      event.preventDefault()
      event.stopPropagation()
      options.focusWindowViaShell(windowId)
      options.closeGroupWindow(windowId)
      return
    }
    const resize = targetEl?.closest<HTMLElement>('[data-shell-resize-left], [data-shell-resize-right], [data-shell-resize-bottom-left], [data-shell-resize-bottom-right]') ?? null
    if (resize) {
      event.preventDefault()
      event.stopPropagation()
      const edges =
        resize.hasAttribute('data-shell-resize-bottom-left') ? SHELL_RESIZE_BOTTOM | SHELL_RESIZE_LEFT :
          resize.hasAttribute('data-shell-resize-bottom-right') ? SHELL_RESIZE_BOTTOM | SHELL_RESIZE_RIGHT :
            resize.hasAttribute('data-shell-resize-left') ? SHELL_RESIZE_LEFT :
              SHELL_RESIZE_RIGHT
      options.focusWindowViaShell(windowId)
      const group = renderedGroupsByFrameWindowId.get(windowId)
      if (group && group.splitLeftWindowId !== null && group.splitPaneFraction !== null && beginSplitGesture(group, event.pointerId, 'resize', edges, event.clientX, event.clientY)) return
      options.beginShellWindowResize(windowId, edges, event.clientX, event.clientY)
      return
    }
    if (targetEl?.closest('[data-shell-titlebar]')) {
      const tab = targetEl.closest('[data-workspace-tab]')
      if (tab) {
        options.focusWindowViaShell(windowId)
        return
      }
      event.preventDefault()
      event.stopPropagation()
      options.focusWindowViaShell(windowId)
      clearPendingTitlebarDrag()
      const group = renderedGroupsByFrameWindowId.get(windowId)
      if (group && group.splitLeftWindowId !== null && group.splitPaneFraction !== null && beginSplitGesture(group, event.pointerId, 'move', 0, event.clientX, event.clientY)) return
      const now = performance.now()
      const lastClick = titlebarLastClickByWindow.get(windowId) ?? null
      if (
        lastClick &&
        now - lastClick.t <= 500 &&
        Math.abs(event.clientX - lastClick.x) <= 8 &&
        Math.abs(event.clientY - lastClick.y) <= 8
      ) {
        titlebarLastClickByWindow.delete(windowId)
        options.toggleShellMaximizeForWindow(windowId)
        return
      }
      titlebarLastClickByWindow.set(windowId, {
        t: now,
        x: event.clientX,
        y: event.clientY,
      })
      const pending = {
        pointerId: event.pointerId,
        windowId,
        clientX: event.clientX,
        clientY: event.clientY,
        timer: 0,
        moveOptions: undefined,
      }
      pending.timer = window.setTimeout(() => {
        startPendingTitlebarDrag(pending, pending.clientX, pending.clientY)
      }, 80)
      pendingTitlebarDrag = pending
      window.addEventListener('pointermove', onPendingTitlebarPointerMove, true)
      window.addEventListener('pointerup', onPendingTitlebarPointerDone, true)
      window.addEventListener('pointercancel', onPendingTitlebarPointerDone, true)
    }
  }

  const onDblClick = (event: MouseEvent) => {
    if (event.button !== 0) return
    const target = event.target
    if (!(target instanceof Element) || !target.closest('[data-shell-titlebar]')) return
    if (target.closest('[data-shell-titlebar-controls]')) return
    const windowId = pointerWindowId(target)
    if (windowId === null) return
    event.preventDefault()
    event.stopPropagation()
    options.focusWindowViaShell(windowId)
    options.toggleShellMaximizeForWindow(windowId)
  }

  const onContextMenu = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const tab = target.closest<HTMLElement>('[data-workspace-tab]')
    if (!tab) return
    const windowId = coerceWindowId(tab.getAttribute('data-workspace-tab'))
    if (windowId === null) return
    event.preventDefault()
    event.stopPropagation()
    options.shellContextOpenTabMenu(windowId, event.clientX, event.clientY)
  }

  const attach = () => {
    const root = options.getRoot()
    if (!root) return
    root.addEventListener('pointerdown', onPointerDown, true)
    root.addEventListener('dblclick', onDblClick, true)
    root.addEventListener('contextmenu', onContextMenu, true)
  }

  const dispose = () => {
    if (raf !== 0) cancelAnimationFrame(raf)
    clearPendingTitlebarDrag()
    endSplitGesture()
    const root = options.getRoot()
    if (root) {
      root.removeEventListener('pointerdown', onPointerDown, true)
      root.removeEventListener('dblclick', onDblClick, true)
      root.removeEventListener('contextmenu', onContextMenu, true)
    }
    for (const node of nodes.values()) node.frame.remove()
    nodes.clear()
    for (const entry of csdDropStrips.values()) entry.node.remove()
    csdDropStrips.clear()
    clearSurfaceNodes()
  }

  return { applyDetails, attach, dispose, schedule }
}
