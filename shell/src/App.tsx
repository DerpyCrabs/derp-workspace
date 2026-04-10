import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  For,
  Show,
} from 'solid-js'
import { createStore } from 'solid-js/store'
import {
  CHROME_BORDER_PX,
  CHROME_TASKBAR_RESERVE_PX,
  CHROME_TITLEBAR_PX,
  SHELL_LAYOUT_FLOATING,
  SHELL_LAYOUT_MAXIMIZED,
  SHELL_RESIZE_BOTTOM,
  SHELL_RESIZE_LEFT,
  SHELL_RESIZE_RIGHT,
  SHELL_RESIZE_TOP,
} from './chromeConstants'
import {
  mergeExclusionRects,
  ssdDecorationExclusionRects,
} from './exclusionRects'
import { ShellWindowFrame, type ShellWindowModel } from './ShellWindowFrame'
import {
  canvasOriginXY,
  type CanvasOrigin,
  canvasRectToClientCss,
  clientPointToCanvasLocal,
  clientPointerDeltaToCanvasLogical,
  clientPointToGlobalLogical,
  clientRectToGlobalLogical,
  findAdjacentMonitor,
  pickScreenForPointerSnap,
  pickScreenForWindow,
  rectCanvasLocalToGlobal,
  rectGlobalToCanvasLocal,
} from './shellCoords'
import { SettingsPanel } from './SettingsPanel'
import { buildBackedWindowOpenPayload } from './backedShellWindows'
import {
  flushShellUiWindowsSyncNow,
  registerShellUiWindow,
  SHELL_WINDOW_FLAG_SHELL_HOSTED,
  SHELL_UI_DEBUG_WINDOW_ID,
  SHELL_UI_SCREENSHOT_WINDOW_ID,
  SHELL_UI_SETTINGS_WINDOW_ID,
  type ShellUiMeasureEnv,
  shellUiWindowMeasureFromEnv,
} from './shellUiWindows'
import {
  assistGridGutterPx,
  assistSpanFromWorkAreaPoint,
  DEFAULT_ASSIST_GRID_SHAPE,
  snapZoneAndPreviewFromAssistSpan,
  type AssistGridShape,
  type AssistGridSpan,
} from './assistGrid'
import { SnapAssistMasterGrid } from './SnapAssistMasterGrid'
import { hitTestSnapZoneGlobal, monitorWorkAreaGlobal, TILE_SNAP_EDGE_PX } from './tileSnap'
import {
  computeTiledResizeRects,
  PerMonitorTileStates,
  TILE_RESIZE_EDGE_ALIGN_PX,
  TILED_RESIZE_MIN_H,
  TILED_RESIZE_MIN_W,
} from './tileState'
import {
  type SnapZone,
  snapZoneToBoundsWithOccupied,
  type Rect as TileRect,
} from './tileZones'
import { Taskbar } from './Taskbar'
import { atlasTopFromLayout, type ShellContextMenuItem } from './contextMenu'
import { ShellFloatingProvider, type ShellFloatingRegistry } from './ShellFloatingContext'
import { pushShellFloatingWireFromDom } from './shellFloatingPlacement'
import { hideShellFloatingWire } from './shellFloatingWire'
import fuzzysort from 'fuzzysort'
import { getMonitorLayout } from './tilingConfig'
import {
  parseDesktopApplicationsResponse,
  postShellJson,
  spawnViaShellHttp,
  type DesktopAppEntry,
} from './shellBridge'
import { shellHttpBase } from './shellHttp'
import { startThemeDomSync } from './themeDom'
import { refreshThemeSettingsFromRemote } from './themeStore'

declare global {
  interface Window {
    /** Injected by `cef_host` after load (`http://127.0.0.1:…/spawn`). */
    __DERP_SPAWN_URL?: string
    __DERP_SHELL_HTTP?: string
    /** Registered by CEF render process: shell→compositor control (`move_delta` uses third arg as `dy`). */
    __derpShellWireSend?: (
      op:
        | 'close'
        | 'quit'
        | 'request_compositor_sync'
        | 'shell_ipc_pong'
        | 'spawn'
        | 'move_begin'
        | 'move_delta'
        | 'move_end'
        | 'resize_begin'
        | 'resize_delta'
        | 'resize_end'
        | 'resize_shell_grab_begin'
        | 'resize_shell_grab_end'
        | 'taskbar_activate'
        | 'shell_focus_ui_window'
        | 'shell_blur_ui_window'
        | 'shell_ui_grab_begin'
        | 'shell_ui_grab_end'
        | 'minimize'
        | 'set_geometry'
        | 'set_fullscreen'
        | 'set_maximized'
        | 'presentation_fullscreen'
        | 'set_output_layout'
        | 'set_exclusion_zones'
        | 'set_shell_ui_windows'
        | 'set_shell_primary'
        | 'set_ui_scale'
        | 'set_tile_preview'
        | 'set_chrome_metrics'
        | 'set_desktop_background'
        | 'context_menu'
        | 'backed_window_open',
      arg?: number | string,
      arg2?: number,
      arg3?: number,
      arg4?: number,
      arg5?: number,
      arg6?: number,
    ) => void
  }
}

type LayoutScreen = {
  name: string
  x: number
  y: number
  width: number
  height: number
  transform: number
  refresh_milli_hz: number
}

type ExclusionHudZone = {
  label: string
  x: number
  y: number
  w: number
  h: number
}

type AssistOverlayState = {
  shape: AssistGridShape
  gutterPx: number
  hoverSpan: AssistGridSpan | null
  workCanvas: { x: number; y: number; w: number; h: number }
}

type ScreenshotSelectionState = {
  start: { x: number; y: number }
  current: { x: number; y: number }
  pointerId: number | null
}

function shellMaximizedWorkAreaGlobalRect(mon: LayoutScreen, reserveTaskbar: boolean) {
  const th = CHROME_TITLEBAR_PX
  const tb = reserveTaskbar ? CHROME_TASKBAR_RESERVE_PX : 0
  return {
    x: mon.x,
    y: mon.y + th,
    w: Math.max(1, mon.width),
    h: Math.max(1, mon.height - th - tb),
  }
}

function screensListForLayout(
  rows: LayoutScreen[],
  canvas: { w: number; h: number } | null,
  origin: { x: number; y: number } | null,
): LayoutScreen[] {
  if (rows.length > 0) return rows
  if (canvas && canvas.w > 0 && canvas.h > 0) {
    const { ox, oy } = canvasOriginXY(origin)
    return [
      {
        name: '',
        x: ox,
        y: oy,
        refresh_milli_hz: 0,
        width: canvas.w,
        height: canvas.h,
        transform: 0,
      },
    ]
  }
  return []
}

function layoutScreenCssRect(s: LayoutScreen, origin: CanvasOrigin): LayoutScreen {
  const loc = rectGlobalToCanvasLocal(s.x, s.y, s.width, s.height, origin)
  return {
    name: s.name,
    x: loc.x,
    y: loc.y,
    width: loc.w,
    height: loc.h,
    transform: s.transform,
    refresh_milli_hz: s.refresh_milli_hz,
  }
}

function monitorRefreshLabel(milli: number): string {
  if (!milli || milli <= 0) return '—'
  const hz = milli / 1000
  const t = hz.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return `${t} Hz`
}

function shellBuildLabelText(): string {
  const m = import.meta as ImportMeta & { env?: Record<string, string | undefined> }
  const mode = m.env?.MODE
  const ver = m.env?.VITE_APP_VERSION
  const parts = [mode, ver].filter((x): x is string => typeof x === 'string' && x.length > 0)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

function unionBBoxFromScreens(rows: LayoutScreen[]): { x: number; y: number; w: number; h: number } | null {
  if (rows.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxR = -Infinity
  let maxB = -Infinity
  for (const r of rows) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxR = Math.max(maxR, r.x + r.width)
    maxB = Math.max(maxB, r.y + r.height)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  return {
    x: minX,
    y: minY,
    w: Math.max(1, Math.round(maxR - minX)),
    h: Math.max(1, Math.round(maxB - minY)),
  }
}

type DerpShellDetail =
  | { type: 'output_geometry'; logical_width: number; logical_height: number }
  | {
      type: 'output_layout'
      canvas_logical_width: number
      canvas_logical_height: number
      canvas_logical_origin_x?: number
      canvas_logical_origin_y?: number
      canvas_physical_width: number
      canvas_physical_height: number
      screens: Array<{
        name: string
        x: number
        y: number
        width: number
        height: number
        transform: number
        refresh_milli_hz?: number
      }>
      shell_chrome_primary?: string | null
      context_menu_atlas_buffer_h?: number
    }
  | {
      type: 'window_mapped'
      window_id: number
      surface_id: number
      x: number
      y: number
      width: number
      height: number
      title: string
      app_id: string
      output_name?: string
    }
  | { type: 'window_unmapped'; window_id: number }
  | {
      type: 'window_geometry'
      window_id: number
      surface_id: number
      x: number
      y: number
      width: number
      height: number
      output_name?: string
      maximized?: boolean
      fullscreen?: boolean
    }
  | {
      type: 'window_metadata'
      window_id: number
      surface_id: number
      title: string
      app_id: string
    }
  | { type: 'focus_changed'; surface_id: number | null; window_id: number | null }
  | { type: 'window_state'; window_id: number; minimized: boolean }
  | { type: 'window_list'; windows: unknown[] }
  | { type: 'context_menu_dismiss' }
  | { type: 'programs_menu_toggle' }
  | { type: 'compositor_ping' }
  | { type: 'keybind'; action: string; target_window_id?: number }
  | { type: 'keyboard_layout'; label: string }
  | {
      type: 'volume_overlay'
      volume_linear_percent_x100: number
      muted: boolean
      state_known: boolean
    }
type DerpWindow = {
  window_id: number
  surface_id: number
  stack_z: number
  x: number
  y: number
  width: number
  height: number
  title: string
  app_id: string
  output_name: string
  minimized: boolean
  maximized: boolean
  fullscreen: boolean
  shell_flags: number
}

function windowOnMonitor(w: DerpWindow, mon: LayoutScreen, list: LayoutScreen[], co: CanvasOrigin): boolean {
  if (w.output_name && w.output_name === mon.name) return true
  const p = pickScreenForWindow(w, list, co)
  return p !== null && p.name === mon.name
}

/** IPC JSON can surface ids as number or string; Map keys must stay numeric for a single row per window. */
function coerceShellWindowId(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return null
  const t = Math.trunc(n)
  // Wire/protocol uses 0 as “none” (e.g. focus_cleared); compositor window_id starts at 1.
  return t > 0 ? t : null
}

function buildWindowsMapFromList(
  raw: unknown,
  prev?: Map<number, DerpWindow>,
): Map<number, DerpWindow> {
  const next = new Map<number, DerpWindow>()
  if (!Array.isArray(raw)) return next
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const wid = coerceShellWindowId(r.window_id)
    const sid = coerceShellWindowId(r.surface_id)
    if (wid === null || sid === null) continue
    const outputName =
      typeof r.output_name === 'string' ? r.output_name : ''
    const sfRaw = r.shell_flags
    const shell_flags =
      typeof sfRaw === 'number' && Number.isFinite(sfRaw)
        ? Math.trunc(sfRaw)
        : (prev?.get(wid)?.shell_flags ?? 0)
    const szRaw = r.stack_z
    const stack_z =
      typeof szRaw === 'number' && Number.isFinite(szRaw)
        ? Math.trunc(szRaw)
        : (prev?.get(wid)?.stack_z ?? wid)
    next.set(wid, {
      window_id: wid,
      surface_id: sid,
      stack_z,
      x: Number(r.x) || 0,
      y: Number(r.y) || 0,
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
      title: typeof r.title === 'string' ? r.title : '',
      app_id: typeof r.app_id === 'string' ? r.app_id : '',
      output_name: outputName,
      minimized: !!r.minimized,
      maximized: !!r.maximized,
      fullscreen: !!r.fullscreen,
      shell_flags,
    })
  }
  return next
}

function applyDetail(map: Map<number, DerpWindow>, detail: DerpShellDetail): Map<number, DerpWindow> {
  const next = new Map(map)
  switch (detail.type) {
    case 'window_mapped': {
      const wid = coerceShellWindowId(detail.window_id)
      const sid = coerceShellWindowId(detail.surface_id)
      if (wid === null || sid === null) break
      next.set(wid, {
        window_id: wid,
        surface_id: sid,
        stack_z: next.get(wid)?.stack_z ?? wid,
        x: detail.x,
        y: detail.y,
        width: detail.width,
        height: detail.height,
        title: detail.title,
        app_id: detail.app_id,
        output_name:
          typeof detail.output_name === 'string' ? detail.output_name : '',
        minimized: false,
        maximized: false,
        fullscreen: false,
        shell_flags: next.get(wid)?.shell_flags ?? 0,
      })
      break
    }
    case 'window_unmapped': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid !== null) next.delete(wid)
      break
    }
    case 'window_geometry': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null) break
      const w = next.get(wid)
      if (w) {
        next.set(wid, {
          ...w,
          x: detail.x,
          y: detail.y,
          width: detail.width,
          height: detail.height,
          output_name:
            detail.output_name !== undefined
              ? typeof detail.output_name === 'string'
                ? detail.output_name
                : ''
              : w.output_name,
          maximized: detail.maximized ?? w.maximized,
          fullscreen: detail.fullscreen ?? w.fullscreen,
        })
      }
      break
    }
    case 'window_state': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null) break
      const w = next.get(wid)
      if (w) {
        next.set(wid, { ...w, minimized: detail.minimized })
      }
      break
    }
    case 'window_metadata': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null) break
      const w = next.get(wid)
      if (w) {
        next.set(wid, { ...w, title: detail.title, app_id: detail.app_id })
      }
      break
    }
    default:
      break
  }
  return next
}

const floatBeforeMaximize = new Map<number, { x: number; y: number; w: number; h: number }>()
const perMonitorTiles = new PerMonitorTileStates()
const dragPreTileSnapshot = new Map<number, { x: number; y: number; w: number; h: number }>()
let activeSnapDropCanvas: { x: number; y: number; w: number; h: number } | null = null
let activeSnapPreviewCanvas: { x: number; y: number; w: number; h: number } | null = null
let activeSnapZone: SnapZone | null = null
let activeSnapScreen: LayoutScreen | null = null
let tilePreviewRaf = 0
let lastTilePreviewKey = ''

const TASKBAR_HEIGHT = 44
const SHELL_WIRE_DEGRADED_WITH_HTTP =
  'Shell wire is unavailable. Window controls stay limited until cef_host reconnects.'
const SHELL_WIRE_DEGRADED_NO_HTTP =
  'Shell bridge is unavailable. Window controls and session actions stay limited until cef_host reconnects.'

function shellWireIssueMessage(): string {
  return shellHttpBase() !== null ? SHELL_WIRE_DEGRADED_WITH_HTTP : SHELL_WIRE_DEGRADED_NO_HTTP
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Tee’d into `compositor.log` when `cef_host` stderr is captured (session). Filter: `derp-shell-move`. */
function shellMoveLog(msg: string, detail?: Record<string, unknown>) {
  const extra = detail !== undefined ? ` ${JSON.stringify(detail)}` : ''
  console.log(`[derp-shell-move] ${msg}${extra}`)
}

function shellWireSend(
  op:
    | 'close'
    | 'quit'
    | 'request_compositor_sync'
    | 'shell_ipc_pong'
    | 'spawn'
    | 'move_begin'
    | 'move_delta'
    | 'move_end'
    | 'resize_begin'
    | 'resize_delta'
    | 'resize_end'
    | 'resize_shell_grab_begin'
    | 'resize_shell_grab_end'
    | 'taskbar_activate'
    | 'shell_focus_ui_window'
    | 'shell_blur_ui_window'
    | 'shell_ui_grab_begin'
    | 'shell_ui_grab_end'
    | 'minimize'
    | 'set_geometry'
    | 'set_fullscreen'
    | 'set_maximized'
    | 'presentation_fullscreen'
    | 'set_output_layout'
    | 'set_exclusion_zones'
    | 'set_shell_ui_windows'
    | 'set_shell_primary'
    | 'set_ui_scale'
    | 'set_tile_preview'
    | 'set_chrome_metrics'
    | 'set_desktop_background'
    | 'backed_window_open',
  arg?: number | string,
  arg2?: number,
  arg3?: number,
  arg4?: number,
  arg5?: number,
  arg6?: number,
): boolean {
  const fn = window.__derpShellWireSend
  const hasWire = typeof fn === 'function'
  if (!hasWire) {
    if (
      op === 'move_begin' ||
      op === 'move_delta' ||
      op === 'move_end' ||
      op === 'resize_begin' ||
      op === 'resize_delta' ||
      op === 'resize_end' ||
      op === 'resize_shell_grab_begin' ||
      op === 'resize_shell_grab_end'
    ) {
      shellMoveLog('wire_missing', { op, arg, arg2 })
    }
    return false
  }
  if ((op === 'move_delta' || op === 'resize_delta') && arg2 !== undefined) {
    fn(op, arg as number, arg2)
  } else if (op === 'resize_begin' && arg2 !== undefined) {
    fn(op, arg as number, arg2)
  } else if (
    op === 'set_geometry' &&
    typeof arg === 'number' &&
    arg2 !== undefined &&
    arg3 !== undefined &&
    arg4 !== undefined &&
    arg5 !== undefined &&
    arg6 !== undefined
  ) {
    fn(op, arg, arg2, arg3, arg4, arg5, arg6)
  } else if (
    (op === 'set_fullscreen' || op === 'set_maximized') &&
    arg !== undefined &&
    arg2 !== undefined
  ) {
    fn(op, arg as number, arg2)
  } else if (
    op === 'quit' ||
    op === 'request_compositor_sync' ||
    op === 'shell_ipc_pong' ||
    op === 'resize_shell_grab_end'
  ) {
    fn(op)
  } else if (op === 'backed_window_open' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'set_output_layout' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'set_desktop_background' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'set_exclusion_zones' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'set_shell_ui_windows' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'set_shell_primary' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'set_ui_scale' && typeof arg === 'number') {
    fn(op, arg)
  } else if (
    op === 'set_tile_preview' &&
    typeof arg === 'number' &&
    arg2 !== undefined &&
    arg3 !== undefined &&
    arg4 !== undefined &&
    arg5 !== undefined
  ) {
    fn(op, arg, arg2, arg3, arg4, arg5)
  } else if (op === 'set_chrome_metrics' && typeof arg === 'number' && arg2 !== undefined) {
    fn(op, arg, arg2)
  } else if (op === 'shell_blur_ui_window' || op === 'shell_ui_grab_end') {
    fn(op)
  } else {
    fn(op, arg)
  }
  return true
}

function canSessionControl(): boolean {
  return typeof window.__derpShellWireSend === 'function' || shellHttpBase() !== null
}

function App() {
  const [rootPointerDowns, setRootPointerDowns] = createSignal(0)

  const [pointerClient, setPointerClient] = createSignal<{ x: number; y: number } | null>(null)
  const [pointerInMain, setPointerInMain] = createSignal<{ x: number; y: number } | null>(null)
  const [viewportCss, setViewportCss] = createSignal({
    w: typeof window !== 'undefined' ? window.innerWidth : 800,
    h: typeof window !== 'undefined' ? window.innerHeight : 600,
  })
  const [windows, setWindows] = createSignal<Map<number, DerpWindow>>(new Map())
  const [focusedWindowId, setFocusedWindowId] = createSignal<number | null>(null)
  const [keyboardLayoutLabel, setKeyboardLayoutLabel] = createSignal<string | null>(null)
  const [volumeOverlay, setVolumeOverlay] = createSignal<{
    linear: number
    muted: boolean
    stateKnown: boolean
  } | null>(null)
  const volumeOverlayHud = createMemo(() => {
    const v = volumeOverlay()
    if (!v) return null
    const pct = Math.min(200, Math.round(v.linear / 100))
    const barPct = Math.min(100, pct)
    const main = mainRef
    const og = outputGeom()
    const co = layoutCanvasOrigin()
    const primary = workspacePartition().primary
    let pos: Record<string, string> = {
      left: '50%',
      bottom: 'max(5.5rem, 12vh)',
      transform: 'translateX(-50%)',
    }
    if (main && og && primary) {
      const loc = layoutScreenCssRect(primary, co)
      const gap = 12
      const cx = loc.x + loc.width / 2
      const cy = loc.y + loc.height - TASKBAR_HEIGHT - gap
      const pt = canvasRectToClientCss(cx, cy, 0, 0, main.getBoundingClientRect(), og.w, og.h)
      pos = {
        left: `${pt.left}px`,
        top: `${pt.top}px`,
        transform: 'translate(-50%, -100%)',
      }
    }
    const label = !v.stateKnown ? '—' : v.muted ? 'Muted' : `${pct}%`
    const fillPct = !v.stateKnown || v.muted ? 0 : barPct
    return (
      <div
        class="shell-panel pointer-events-none fixed z-[470000] box-border w-[min(360px,90vw)] min-w-[240px] rounded-xl px-5 py-3.5"
        style={pos}
        role="status"
        aria-live="polite"
      >
        <div class="flex flex-col gap-2">
          <p class="m-0 flex h-[1.75rem] items-center justify-center text-center text-[1.05rem] font-semibold tabular-nums text-[var(--shell-text)]">
            {!v.stateKnown ? (
              <span class="text-[0.95rem] font-medium text-[var(--shell-text-muted)]">
                Volume unavailable
              </span>
            ) : (
              label
            )}
          </p>
          <div class="h-2 w-full shrink-0 overflow-hidden rounded-full bg-[var(--shell-overlay-muted)]">
            <div
              class="h-full rounded-full bg-[var(--shell-accent)] transition-[width] duration-100 ease-out"
              style={{ width: `${fillPct}%` }}
            />
          </div>
        </div>
      </div>
    )
  })
  const [outputGeom, setOutputGeom] = createSignal<{ w: number; h: number } | null>(null)
  const [layoutCanvasOrigin, setLayoutCanvasOrigin] = createSignal<{ x: number; y: number } | null>(
    null,
  )
  const [screenDraft, setScreenDraft] = createStore<{ rows: LayoutScreen[] }>({ rows: [] })
  const [tilingCfgRev, setTilingCfgRev] = createSignal(0)
  const [orientationPickerOpen, setOrientationPickerOpen] = createSignal<number | null>(null)
  const [hudFps, setHudFps] = createSignal(0)
  const [crosshairCursor, setCrosshairCursor] = createSignal(false)
  const [screenshotMode, setScreenshotMode] = createSignal(false)
  const [screenshotSelection, setScreenshotSelection] = createSignal<ScreenshotSelectionState | null>(
    null,
  )
  const [exclusionZonesHud, setExclusionZonesHud] = createSignal<ExclusionHudZone[]>([])
  const [uiScalePercent, setUiScalePercent] = createSignal<100 | 150 | 200>(150)
  const [shellChromePrimaryName, setShellChromePrimaryName] = createSignal<string | null>(null)
  const [outputPhysical, setOutputPhysical] = createSignal<{ w: number; h: number } | null>(null)
  const [contextMenuAtlasBufferH, setContextMenuAtlasBufferH] = createSignal(1536)
  const [ctxMenuOpen, setCtxMenuOpen] = createSignal(false)
  const [ctxMenuKind, setCtxMenuKind] = createSignal<'programs' | 'power' | null>(null)
  const [ctxMenuAnchor, setCtxMenuAnchor] = createSignal<{
    x: number
    y: number
    alignAboveY?: number
  }>({ x: 0, y: 0 })
  const [snapChromeRev, setSnapChromeRev] = createSignal(0)
  const [assistOverlay, setAssistOverlay] = createSignal<AssistOverlayState | null>(null)
  const programsMenuOpen = createMemo(() => ctxMenuOpen() && ctxMenuKind() === 'programs')
  const powerMenuOpen = createMemo(() => ctxMenuOpen() && ctxMenuKind() === 'power')
  const [programsCatalog, setProgramsCatalog] = createStore<{ items: DesktopAppEntry[] }>({
    items: [],
  })
  const [programsMenuBusy, setProgramsMenuBusy] = createSignal(false)
  const [programsMenuErr, setProgramsMenuErr] = createSignal<string | null>(null)
  const [shellWireIssue, setShellWireIssue] = createSignal<string | null>(null)
  const [shellActionIssue, setShellActionIssue] = createSignal<string | null>(null)
  const [programsMenuQuery, setProgramsMenuQuery] = createSignal('')
  const [programsMenuHighlightIdx, setProgramsMenuHighlightIdx] = createSignal(0)
  const [powerMenuHighlightIdx, setPowerMenuHighlightIdx] = createSignal(0)
  const atlasSelectClosers = new Set<() => boolean>()
  const [atlasOverlayPointerUsers, setAtlasOverlayPointerUsers] = createSignal(0)
  const shellBridgeIssue = createMemo(() => shellActionIssue() ?? shellWireIssue())

  createEffect(() => {
    if (!ctxMenuOpen()) {
      setCtxMenuKind(null)
      setProgramsMenuQuery('')
      setProgramsMenuHighlightIdx(0)
      setPowerMenuHighlightIdx(0)
    }
  })

  function hideContextMenu() {
    setCtxMenuOpen(false)
    setCtxMenuKind(null)
    setProgramsMenuQuery('')
    setProgramsMenuHighlightIdx(0)
    setPowerMenuHighlightIdx(0)
    hideShellFloatingWire()
  }
  function closeAllAtlasSelects(): boolean {
    let any = false
    for (const f of atlasSelectClosers) {
      if (f()) any = true
    }
    return any
  }
  function acquireAtlasOverlayPointer() {
    setAtlasOverlayPointerUsers((n) => n + 1)
  }
  function releaseAtlasOverlayPointer() {
    setAtlasOverlayPointerUsers((n) => Math.max(0, n - 1))
  }

  function reportShellWireIssue(message: string) {
    console.warn(`[derp-shell-bridge] ${message}`)
    setShellWireIssue((current) => (current === message ? current : message))
  }

  function clearShellWireIssue() {
    setShellWireIssue(null)
  }

  function reportShellActionIssue(message: string) {
    console.warn(`[derp-shell-bridge] ${message}`)
    setShellActionIssue((current) => (current === message ? current : message))
  }

  function clearShellActionIssue() {
    setShellActionIssue(null)
  }

  async function postShell(path: string, body: object): Promise<void> {
    await postShellJson(path, body, shellHttpBase())
  }

  async function postSessionPower(action: string): Promise<void> {
    try {
      await postShell('/session_power', { action })
      clearShellActionIssue()
    } catch (error) {
      reportShellActionIssue(`Power action failed: ${describeError(error)}`)
      throw error
    }
  }

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
    const main = mainRef
    const og = outputGeom()
    const co = layoutCanvasOrigin()
    if (!main || !og || !co) return null
    return {
      main,
      outputGeom: { w: og.w, h: og.h },
      origin: co,
    }
  }

  function screenshotPointFromClient(clientX: number, clientY: number) {
    const main = mainRef
    const og = outputGeom()
    if (!main || !og) return null
    return clientPointToGlobalLogical(
      clientX,
      clientY,
      main.getBoundingClientRect(),
      og.w,
      og.h,
      layoutCanvasOrigin(),
    )
  }

  function stopScreenshotMode() {
    setScreenshotSelection(null)
    setScreenshotMode(false)
    setCrosshairCursor(false)
    shellWireSend('shell_ui_grab_end')
    shellWireSend('shell_blur_ui_window')
  }

  function waitForAnimationFrame() {
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
  }

  function beginScreenshotMode() {
    hideContextMenu()
    closeAllAtlasSelects()
    clearShellActionIssue()
    setScreenshotSelection(null)
    setScreenshotMode(true)
    setCrosshairCursor(true)
    queueMicrotask(() => {
      flushShellUiWindowsSyncNow()
      shellWireSend('shell_focus_ui_window', SHELL_UI_SCREENSHOT_WINDOW_ID)
    })
  }

  async function submitScreenshotRegion(bounds: { x: number; y: number; width: number; height: number }) {
    try {
      stopScreenshotMode()
      await waitForAnimationFrame()
      flushShellUiWindowsSyncNow()
      await waitForAnimationFrame()
      await waitForAnimationFrame()
      await postShell('/screenshot_region', bounds)
      clearShellActionIssue()
    } catch (error) {
      reportShellActionIssue(`Screenshot failed: ${describeError(error)}`)
    }
  }

  const canvasCss = createMemo(() => {
    const g = outputGeom()
    const v = viewportCss()
    const w = Math.max(1, g?.w ?? v.w ?? 1)
    const h = Math.max(1, g?.h ?? v.h ?? 1)
    return { w, h }
  })

  const shellMenuAtlasTop = createMemo(() => {
    const g = outputGeom()
    const p = outputPhysical()
    const ah = contextMenuAtlasBufferH()
    const v = canvasCss()
    const clh = Math.max(1, g?.h ?? v.h)
    const cph = Math.max(1, p?.h ?? Math.round(clh * 1.5))
    return atlasTopFromLayout(clh, cph, ah)
  })

  const workspacePartition = createMemo(() => {
    const rows = screenDraft.rows
    const g = outputGeom()
    const v = viewportCss()
    const cw = Math.max(1, g?.w ?? v.w ?? 1)
    const ch = Math.max(1, g?.h ?? v.h ?? 1)
    if (rows.length === 0) {
      const single: LayoutScreen = {
        name: '',
        x: 0,
        y: 0,
        width: cw,
        height: ch,
        transform: 0,
        refresh_milli_hz: 0,
      }
      return { primary: single, secondary: [] as LayoutScreen[] }
    }
    const explicit = shellChromePrimaryName()
    if (explicit) {
      const ei = rows.findIndex((r) => r.name === explicit)
      if (ei >= 0) {
        const primary = rows[ei]
        const secondary = rows.filter((_, i) => i !== ei)
        return { primary, secondary }
      }
    }
    let pi = 0
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i]
      const b = rows[pi]
      if (a.x < b.x || (a.x === b.x && a.y < b.y)) pi = i
    }
    const primary = rows[pi]
    const secondary = rows.filter((_, i) => i !== pi)
    return { primary, secondary }
  })

  const layoutUnionBbox = createMemo(() => unionBBoxFromScreens(screenDraft.rows))

  const autoShellChromeMonitorName = createMemo(() => {
    const rows = screenDraft.rows
    if (rows.length === 0) return null
    let pi = 0
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i]
      const b = rows[pi]
      if (a.x < b.x || (a.x === b.x && a.y < b.y)) pi = i
    }
    return rows[pi]?.name ?? null
  })

  const panelHostForHud = createMemo(() => {
    if (screenDraft.rows.length === 0) return null
    return workspacePartition().primary
  })

  const allWindowsMap = createMemo(() => windows())

  const debugHudFrameVisible = createMemo(() => {
    const w = windows().get(SHELL_UI_DEBUG_WINDOW_ID)
    return !!w && !w.minimized
  })

  const settingsHudFrameVisible = createMemo(() => {
    const w = windows().get(SHELL_UI_SETTINGS_WINDOW_ID)
    return !!w && !w.minimized
  })

  createEffect(() => {
    if (!debugHudFrameVisible()) {
      setHudFps(0)
      return
    }
    let hudFpsFrames = 0
    let hudFpsLast = performance.now()
    let hudFpsRaf = 0
    const hudFpsStep = (now: number) => {
      hudFpsFrames += 1
      const dt = now - hudFpsLast
      if (dt >= 500) {
        setHudFps(Math.round((hudFpsFrames * 1000) / dt))
        hudFpsFrames = 0
        hudFpsLast = now
      }
      hudFpsRaf = requestAnimationFrame(hudFpsStep)
    }
    hudFpsRaf = requestAnimationFrame(hudFpsStep)
    onCleanup(() => cancelAnimationFrame(hudFpsRaf))
  })

  const windowsListIds = createMemo(() => Array.from(allWindowsMap().keys()).sort((a, b) => a - b))

  const windowsList = createMemo(() => {
    const out: DerpWindow[] = []
    for (const id of windowsListIds()) {
      const w = allWindowsMap().get(id)
      if (w) out.push(w)
    }
    return out
  })

  const stackedWindowsList = createMemo(() => {
    return [...windowsList()].sort((a, b) => {
      return b.stack_z - a.stack_z || b.window_id - a.window_id
    })
  })

  function ShellDeskWindowRow(props: { windowId: number }) {
    const winModel = createMemo((): ShellWindowModel | undefined => {
      const r = allWindowsMap().get(props.windowId)
      if (!r || r.minimized) return undefined
      return { ...r, snap_tiled: perMonitorTiles.isTiled(props.windowId) }
    })
    const stackZ = createMemo(() => allWindowsMap().get(props.windowId)?.stack_z ?? 0)
    const rowFocused = createMemo(() => focusedWindowId() === props.windowId)
    const windowId = props.windowId
    const deskShellUiReg = createMemo(() => {
      stackZ()
      outputGeom()
      layoutCanvasOrigin()
      return {
        id: props.windowId,
        z: stackZ(),
        getEnv: (): ShellUiMeasureEnv | null => {
          const main = mainRef
          const og = outputGeom()
          const co = layoutCanvasOrigin()
          if (!main || !og || !co) return null
          return {
            main,
            outputGeom: { w: og.w, h: og.h },
            origin: co,
          }
        },
      }
    })
    return (
      <Show when={winModel} fallback={null}>
        <ShellWindowFrame
          win={winModel}
          repaintKey={snapChromeRev}
          stackZ={stackZ}
          focused={rowFocused}
          shellUiRegister={deskShellUiReg()}
          onFocusRequest={() => {
            shellWireSend('shell_focus_ui_window', windowId)
          }}
          onTitlebarPointerDown={(cx, cy) => beginShellWindowMove(windowId, cx, cy)}
          onResizeEdgeDown={(edges, cx, cy) => beginShellWindowResize(windowId, edges, cx, cy)}
          onMinimize={() => {
            shellWireSend('minimize', windowId)
          }}
          onMaximize={() => {
            toggleShellMaximizeForWindow(windowId)
          }}
          onClose={() => {
            shellWireSend('close', windowId)
          }}
        >
          <Show when={windowId === SHELL_UI_DEBUG_WINDOW_ID}>
            <DebugHudContent />
          </Show>
          <Show when={windowId === SHELL_UI_SETTINGS_WINDOW_ID}>
            <SettingsPanel
              screenDraft={screenDraft}
              setScreenDraft={setScreenDraft}
              shellChromePrimaryName={shellChromePrimaryName}
              autoShellChromeMonitorName={autoShellChromeMonitorName}
              canSessionControl={canSessionControl}
              uiScalePercent={uiScalePercent}
              orientationPickerOpen={orientationPickerOpen}
              setOrientationPickerOpen={setOrientationPickerOpen}
              tilingCfgRev={tilingCfgRev}
              setTilingCfgRev={setTilingCfgRev}
              perMonitorTiles={perMonitorTiles}
              bumpSnapChrome={() => bumpSnapChrome()}
              scheduleExclusionZonesSync={() => scheduleExclusionZonesSync()}
              applyAutoLayout={(name) => applyAutoLayout(name)}
              setShellPrimary={(name) => shellWireSend('set_shell_primary', name)}
              setUiScale={(pct) => shellWireSend('set_ui_scale', pct)}
              applyCompositorLayoutFromDraft={() => {
                const screens = screenDraft.rows.map((r) => ({
                  name: r.name,
                  x: r.x,
                  y: r.y,
                  transform: r.transform,
                }))
                shellWireSend('set_output_layout', JSON.stringify({ screens }))
              }}
              monitorRefreshLabel={monitorRefreshLabel}
              keyboardLayoutLabel={keyboardLayoutLabel}
              setDesktopBackgroundJson={(json) => shellWireSend('set_desktop_background', json)}
            />
          </Show>
        </ShellWindowFrame>
      </Show>
    )
  }

  function ScreenshotOverlay() {
    let root: HTMLDivElement | undefined

    onMount(() => {
      const unreg = registerShellUiWindow(SHELL_UI_SCREENSHOT_WINDOW_ID, () =>
        shellUiWindowMeasureFromEnv(
          SHELL_UI_SCREENSHOT_WINDOW_ID,
          460500,
          root,
          screenshotShellUiEnv,
        ),
      )
      onCleanup(unreg)
    })

    const selectionCss = createMemo(() => {
      const rect = screenshotSelectionRect()
      const main = mainRef
      const og = outputGeom()
      if (!rect || !main || !og) return null
      const local = rectGlobalToCanvasLocal(
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        layoutCanvasOrigin(),
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
        ref={(el) => {
          root = el
        }}
        class="fixed inset-0 z-[460500] touch-none bg-[rgba(0,0,0,0.35)]"
        onContextMenu={(e) => {
          e.preventDefault()
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          const point = screenshotPointFromClient(e.clientX, e.clientY)
          if (!point) return
          root?.setPointerCapture?.(e.pointerId)
          shellWireSend('shell_focus_ui_window', SHELL_UI_SCREENSHOT_WINDOW_ID)
          shellWireSend('shell_ui_grab_begin', SHELL_UI_SCREENSHOT_WINDOW_ID)
          setScreenshotSelection({
            start: point,
            current: point,
            pointerId: e.pointerId,
          })
          e.preventDefault()
          e.stopPropagation()
        }}
        onPointerMove={(e) => {
          const sel = screenshotSelection()
          if (!sel || sel.pointerId !== e.pointerId) return
          const point = screenshotPointFromClient(e.clientX, e.clientY)
          if (!point) return
          setScreenshotSelection({
            ...sel,
            current: point,
          })
          e.preventDefault()
          e.stopPropagation()
        }}
        onPointerUp={(e) => {
          const sel = screenshotSelection()
          if (!sel || sel.pointerId !== e.pointerId) return
          root?.releasePointerCapture?.(e.pointerId)
          const point = screenshotPointFromClient(e.clientX, e.clientY)
          const next = point ? { ...sel, current: point } : sel
          setScreenshotSelection(next)
          const rect = screenshotSelectionRect()
          e.preventDefault()
          e.stopPropagation()
          if (!rect || rect.width < 2 || rect.height < 2) {
            stopScreenshotMode()
            return
          }
          void submitScreenshotRegion(rect)
        }}
        onPointerCancel={(e) => {
          root?.releasePointerCapture?.(e.pointerId)
          e.preventDefault()
          e.stopPropagation()
          stopScreenshotMode()
        }}
      >
        <Show when={selectionCss()} keyed>
          {(css) => (
            <div
              class="pointer-events-none fixed box-border border-2 border-white shadow-[0_0_0_99999px_rgba(0,0,0,0.45)]"
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

  const windowsByMonitor = createMemo(() => {
    const list = windowsList()
    const part = workspacePartition()
    const fallback =
      part.primary.name || screenDraft.rows.find((r) => r.name)?.name || ''
    const map = new Map<string, DerpWindow[]>()
    for (const w of list) {
      const key = w.output_name || fallback
      const bucket = map.get(key)
      if (bucket) bucket.push(w)
      else map.set(key, [w])
    }
    return map
  })

  const taskbarScreens = createMemo(() =>
    screensListForLayout(screenDraft.rows, outputGeom(), layoutCanvasOrigin()),
  )

  function taskbarRowsForScreen(s: LayoutScreen) {
    const list = windowsByMonitor().get(s.name) ?? []
    return list.map((w) => ({
      window_id: w.window_id,
      title: w.title,
      app_id: w.app_id,
      minimized: w.minimized,
      output_name: w.output_name,
    }))
  }

  function isPrimaryTaskbarScreen(s: LayoutScreen, primary: LayoutScreen) {
    return (
      s.name === primary.name &&
      s.x === primary.x &&
      s.y === primary.y &&
      s.width === primary.width &&
      s.height === primary.height
    )
  }

  function occupiedSnapZonesOnMonitor(
    mon: LayoutScreen,
    excludeWindowId: number,
  ): { zone: SnapZone; bounds: TileRect }[] {
    const co = layoutCanvasOrigin()
    const list = taskbarScreens()
    const out: { zone: SnapZone; bounds: TileRect }[] = []
    const st = perMonitorTiles.stateFor(mon.name)
    for (const [wid, e] of st.tiledWindows) {
      if (wid === excludeWindowId) continue
      const win = allWindowsMap().get(wid)
      if (!win || win.minimized) continue
      if (!windowOnMonitor(win, mon, list, co)) continue
      const g = rectCanvasLocalToGlobal(win.x, win.y, win.width, win.height, co)
      out.push({ zone: e.zone, bounds: { x: g.x, y: g.y, width: g.w, height: g.h } })
    }
    return out
  }

  function screenTaskbarHiddenForFullscreen(s: LayoutScreen) {
    const list = windowsByMonitor().get(s.name) ?? []
    return list.some((w) => w.fullscreen && !w.minimized)
  }

  function reserveTaskbarForMon(mon: LayoutScreen) {
    return !screenTaskbarHiddenForFullscreen(mon)
  }

  function fallbackMonitorKey(): string {
    const part = workspacePartition()
    return part.primary.name || screenDraft.rows.find((r) => r.name)?.name || ''
  }

  function applyAutoLayout(monitorName: string) {
    const { layout, params } = getMonitorLayout(monitorName)
    if (layout.type === 'manual-snap') {
      return
    }
    const mon = taskbarScreens().find((s) => s.name === monitorName) ?? null
    if (!mon) return
    const fb = fallbackMonitorKey()
    const co = layoutCanvasOrigin()
    const reserveTb = reserveTaskbarForMon(mon)
    const work = monitorWorkAreaGlobal(mon, reserveTb)
    const workRect: TileRect = { x: work.x, y: work.y, width: work.w, height: work.h }
    const candidates = windowsList().filter((w) => {
      if (w.window_id === SHELL_UI_DEBUG_WINDOW_ID || w.window_id === SHELL_UI_SETTINGS_WINDOW_ID)
        return false
      if (w.minimized) return false
      if ((w.output_name || fb) !== monitorName) return false
      if (w.fullscreen || w.maximized) return false
      return true
    })
    const windowIds = candidates.map((w) => w.window_id).sort((a, b) => a - b)
    const rectMap = layout.computeLayout(windowIds, workRect, params)
    perMonitorTiles.stateFor(monitorName).replaceFromAutoLayoutRects(rectMap)
    const snap = windows()
    for (const [wid, gr] of rectMap) {
      const pt = snap.get(wid)
      if (pt) perMonitorTiles.preTileGeometry.set(wid, { x: pt.x, y: pt.y, w: pt.width, h: pt.height })
      const loc = rectGlobalToCanvasLocal(gr.x, gr.y, gr.width, gr.height, co)
      shellWireSend('set_geometry', wid, loc.x, loc.y, loc.w, loc.h, SHELL_LAYOUT_FLOATING)
    }
    setWindows((m) => {
      let next: Map<number, DerpWindow> | null = null
      for (const [wid, gr] of rectMap) {
        const cur = m.get(wid)
        if (!cur) continue
        const loc = rectGlobalToCanvasLocal(gr.x, gr.y, gr.width, gr.height, co)
        if (!next) next = new Map(m)
        next.set(wid, { ...cur, x: loc.x, y: loc.y, width: loc.w, height: loc.h, maximized: false })
      }
      return next ?? m
    })
    scheduleExclusionZonesSync()
    bumpSnapChrome()
  }

  function relayoutAllAutoMonitors() {
    for (const s of screensListForLayout(screenDraft.rows, outputGeom(), layoutCanvasOrigin())) {
      if (getMonitorLayout(s.name).layout.type !== 'manual-snap') {
        applyAutoLayout(s.name)
      }
    }
  }

  const fullscreenTaskbarExclusionSig = createMemo(() => {
    const byMon = windowsByMonitor()
    return taskbarScreens()
      .map((scr) => {
        const list = byMon.get(scr.name) ?? []
        const hide = list.some((w) => w.fullscreen && !w.minimized)
        return `${scr.name}:${hide ? 1 : 0}`
      })
      .join('|')
  })

  /** Memo so pointer/viewport updates re-run (nested `Show` + FC did not track `pointerClient`). */
  const crosshairDebugOverlay = createMemo(() => {
    if (!crosshairCursor()) return null
    const p = pointerClient()
    if (!p) return null
    const vpw = viewportCss().w
    const vph = viewportCss().h
    return (
      <>
        <div
          class="pointer-events-none fixed top-0 bottom-0 z-53 w-px -translate-x-[0.5px] bg-shell-crosshair shadow-[0_0_4px_rgba(0,0,0,0.4)]"
          style={{ left: `${p.x}px` }}
        />
        <div
          class="pointer-events-none fixed left-0 right-0 z-53 h-px -translate-y-[0.5px] bg-shell-crosshair shadow-[0_0_4px_rgba(0,0,0,0.4)]"
          style={{ top: `${p.y}px` }}
        />
        <div
          class="pointer-events-none fixed z-54 rounded border border-[var(--shell-border)] bg-shell-cursor-readout px-1.5 py-0.5 text-[11px] whitespace-nowrap text-[var(--shell-accent-foreground)] tabular-nums"
          style={{
            left: `${Math.min(p.x + 14, Math.max(0, vpw - 128))}px`,
            top: `${Math.min(p.y + 14, Math.max(0, vph - 40))}px`,
          }}
        >
          {p.x},{p.y}
        </div>
      </>
    )
  })

  let wireWatchPoll: ReturnType<typeof setInterval> | undefined
  let mainRef: HTMLElement | undefined
  let menuAtlasHostRef: HTMLElement | undefined
  let menuPanelRef: HTMLElement | undefined
  let programsMenuSearchRef: HTMLInputElement | undefined
  let exclusionZonesRaf = 0

  function syncExclusionZonesNow() {
    const main = mainRef
    if (!main) {
      setExclusionZonesHud([])
      return
    }
    const og = outputGeom()
    if (!og) {
      setExclusionZonesHud([])
      return
    }
    const co = layoutCanvasOrigin()
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
    for (const el of main.querySelectorAll('[data-shell-taskbar]')) {
      const mon = el.getAttribute('data-shell-taskbar-monitor') ?? ''
      addEl(el, mon.length > 0 ? `taskbar:${mon}` : 'taskbar')
    }
    const stripLabels = ['t', 'l', 'r', 'b'] as const
    for (const decoWin of stackedWindowsList()) {
      if (decoWin.minimized) continue
      const deco = ssdDecorationExclusionRects({
        ...decoWin,
        snap_tiled: perMonitorTiles.isTiled(decoWin.window_id),
      })
      for (let i = 0; i < deco.length; i++) {
        const r = deco[i]
        const tag = stripLabels[i] ?? `${i}`
        const z = rectCanvasLocalToGlobal(r.x, r.y, r.w, r.h, co)
        hud.push({ label: `w${decoWin.window_id}-deco-${tag}`, x: z.x, y: z.y, w: z.w, h: z.h })
        rects.push({ x: z.x, y: z.y, w: z.w, h: z.h, window_id: decoWin.window_id })
      }
    }
    setExclusionZonesHud(hud)
    const sentRects = mergeExclusionRects(rects)
    if (typeof window.__derpShellWireSend === 'function') {
      window.__derpShellWireSend('set_exclusion_zones', JSON.stringify({ rects: sentRects }))
    }
  }

  function scheduleExclusionZonesSync() {
    if (exclusionZonesRaf) cancelAnimationFrame(exclusionZonesRaf)
    exclusionZonesRaf = requestAnimationFrame(() => {
      exclusionZonesRaf = 0
      syncExclusionZonesNow()
    })
  }

  createEffect(() => {
    fullscreenTaskbarExclusionSig()
    queueMicrotask(() => scheduleExclusionZonesSync())
  })

  function bumpSnapChrome() {
    setSnapChromeRev((n) => n + 1)
  }

  function applyGeometryToWindowMaps(
    wid: number,
    loc: { x: number; y: number; w: number; h: number },
    patch: Partial<DerpWindow> = {},
  ) {
    setWindows((m) => {
      const cur = m.get(wid)
      if (!cur) return m
      const n = new Map(m)
      n.set(wid, {
        ...cur,
        ...patch,
        x: loc.x,
        y: loc.y,
        width: loc.w,
        height: loc.h,
      })
      return n
    })
  }

  function minimizeDebugShellWindow() {
    shellWireSend('minimize', SHELL_UI_DEBUG_WINDOW_ID)
  }

  function minimizeSettingsShellWindow() {
    shellWireSend('minimize', SHELL_UI_SETTINGS_WINDOW_ID)
  }

  function toggleSettingsShellWindow() {
    const w = windows().get(SHELL_UI_SETTINGS_WINDOW_ID)
    if (!w || w.minimized) openSettingsShellWindow()
    else minimizeSettingsShellWindow()
  }

  function openBackedShellWindow(kind: 'debug' | 'settings') {
    const list = screensListForLayout(screenDraft.rows, outputGeom(), layoutCanvasOrigin())
    const co = layoutCanvasOrigin()
    const part = workspacePartition()
    const mon = list.find((s) => s.name === part.primary.name) ?? list[0] ?? null
    if (!mon) return
    const reserveTb = reserveTaskbarForMon(mon)
    const work = monitorWorkAreaGlobal(mon, reserveTb)
    const payload = buildBackedWindowOpenPayload(mon.name, work, kind, co)
    shellWireSend('backed_window_open', JSON.stringify(payload))
  }

  function openDebugShellWindow() {
    openBackedShellWindow('debug')
  }

  function openSettingsShellWindow() {
    openBackedShellWindow('settings')
  }

  function toggleShellMaximizeForWindow(wid: number) {
    const w = allWindowsMap().get(wid)
    if (!w) return
    if (w.maximized) {
      shellWireSend('set_maximized', wid, 0)
      return
    }
    perMonitorTiles.untileWindowEverywhere(wid)
    perMonitorTiles.preTileGeometry.delete(wid)
    bumpSnapChrome()
    scheduleExclusionZonesSync()
    floatBeforeMaximize.set(wid, { x: w.x, y: w.y, w: w.width, h: w.height })
    const list = screensListForLayout(screenDraft.rows, outputGeom(), layoutCanvasOrigin())
    const mon2 = pickScreenForWindow(w, list, layoutCanvasOrigin()) ?? list[0] ?? null
    if (!mon2) return
    const reserveTb = reserveTaskbarForMon(mon2)
    const r = shellMaximizedWorkAreaGlobalRect(mon2, reserveTb)
    shellWireSend('set_geometry', wid, r.x, r.y, r.w, r.h, SHELL_LAYOUT_MAXIMIZED)
  }

  /** Shell → compositor window move (same wire as `cef_host` `shell_uplink`). */
  let shellWindowDrag: { windowId: number; lastX: number; lastY: number } | null = null
  let shellMoveDeltaLogSeq = 0

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

  let shellWindowResize: ShellResizeSession | null = null
  let shellResizeDeltaLogSeq = 0

  function flushTilePreviewWire() {
    tilePreviewRaf = 0
    const snap = activeSnapPreviewCanvas
    if (!snap) {
      if (lastTilePreviewKey !== '0') {
        lastTilePreviewKey = '0'
        shellWireSend('set_tile_preview', 0, 0, 0, 0, 0)
      }
      return
    }
    const k = `${snap.x},${snap.y},${snap.w},${snap.h}`
    if (k !== lastTilePreviewKey) {
      lastTilePreviewKey = k
      shellWireSend('set_tile_preview', 1, snap.x, snap.y, snap.w, snap.h)
    }
  }

  function scheduleTilePreviewSync() {
    if (tilePreviewRaf) return
    tilePreviewRaf = requestAnimationFrame(() => flushTilePreviewWire())
  }

  function beginShellWindowMove(windowId: number, clientX: number, clientY: number) {
    if (shellWindowResize !== null) return
    shellMoveLog('titlebar_begin_request', { windowId, clientX, clientY })
    shellMoveDeltaLogSeq = 0
    activeSnapDropCanvas = null
    activeSnapPreviewCanvas = null
    activeSnapZone = null
    activeSnapScreen = null
    lastTilePreviewKey = ''
    if (tilePreviewRaf) {
      cancelAnimationFrame(tilePreviewRaf)
      tilePreviewRaf = 0
    }
    shellWireSend('set_tile_preview', 0, 0, 0, 0, 0)
    setAssistOverlay(null)
    const main = mainRef
    const og = outputGeom()
    const w = allWindowsMap().get(windowId)
    if (main && og && w) {
      const mainRect = main.getBoundingClientRect()
      const ptrCl = clientPointToCanvasLocal(clientX, clientY, mainRect, og.w, og.h)
      const co = layoutCanvasOrigin()
      if (w.maximized) {
        const rest = floatBeforeMaximize.get(windowId) ?? {
          x: w.x,
          y: w.y,
          w: Math.max(360, Math.floor(w.width * 0.55)),
          h: Math.max(280, Math.floor(w.height * 0.55)),
        }
        const list = screensListForLayout(screenDraft.rows, outputGeom(), co)
        const globPtr = clientPointToGlobalLogical(clientX, clientY, mainRect, og.w, og.h, co)
        const mon = pickScreenForPointerSnap(globPtr.x, globPtr.y, list)
        let maxCanvasX = w.x
        let maxCanvasY = w.y
        if (mon) {
          const reserveTb = reserveTaskbarForMon(mon)
          const mg = shellMaximizedWorkAreaGlobalRect(mon, reserveTb)
          const loc = rectGlobalToCanvasLocal(mg.x, mg.y, mg.w, mg.h, co)
          maxCanvasX = loc.x
          maxCanvasY = loc.y
        }
        const grabDx = ptrCl.x - maxCanvasX
        const grabDy = ptrCl.y - maxCanvasY
        const nx = ptrCl.x - grabDx + CHROME_BORDER_PX
        const ny = ptrCl.y - grabDy + CHROME_BORDER_PX
        shellWireSend('set_geometry', windowId, nx, ny, rest.w, rest.h, SHELL_LAYOUT_FLOATING)
        floatBeforeMaximize.delete(windowId)
        applyGeometryToWindowMaps(windowId, { x: nx, y: ny, w: rest.w, h: rest.h }, { maximized: false })
        dragPreTileSnapshot.set(windowId, { x: nx, y: ny, w: rest.w, h: rest.h })
        scheduleExclusionZonesSync()
        bumpSnapChrome()
      } else if (perMonitorTiles.isTiled(windowId)) {
        const tr = perMonitorTiles.preTileGeometry.get(windowId)
        if (tr) {
          const grabDx = ptrCl.x - w.x
          const grabDy = ptrCl.y - w.y
          const nx = ptrCl.x - grabDx + CHROME_BORDER_PX
          const ny = ptrCl.y - grabDy + CHROME_BORDER_PX
          shellWireSend('set_geometry', windowId, nx, ny, tr.w, tr.h, SHELL_LAYOUT_FLOATING)
          applyGeometryToWindowMaps(windowId, { x: nx, y: ny, w: tr.w, h: tr.h }, { maximized: false })
        }
        perMonitorTiles.untileWindowEverywhere(windowId)
        perMonitorTiles.preTileGeometry.delete(windowId)
        dragPreTileSnapshot.set(windowId, tr ?? { x: w.x, y: w.y, w: w.width, h: w.height })
        scheduleExclusionZonesSync()
        bumpSnapChrome()
      } else {
        dragPreTileSnapshot.set(windowId, { x: w.x, y: w.y, w: w.width, h: w.height })
      }
    }
    if (!shellWireSend('move_begin', windowId)) {
      shellMoveLog('titlebar_begin_aborted', { windowId, reason: 'no __derpShellWireSend' })
      return
    }
    shellWindowDrag = { windowId, lastX: Math.round(clientX), lastY: Math.round(clientY) }
    shellMoveLog('titlebar_begin_armed', { windowId, clientX, clientY })
  }

  /** Optimistic HUD position in output-local integers; matches compositor `move_delta` after layout unification. */
  function bumpShellWindowPosition(windowId: number, dx: number, dy: number) {
    setWindows((m) => {
      const w = m.get(windowId)
      if (!w) return m
      const next = new Map(m)
      next.set(windowId, { ...w, x: w.x + dx, y: w.y + dy })
      return next
    })
  }

  function applyShellWindowMove(clientX: number, clientY: number) {
    if (!shellWindowDrag) return
    const cx = Math.round(clientX)
    const cy = Math.round(clientY)
    const dClientX = cx - shellWindowDrag.lastX
    const dClientY = cy - shellWindowDrag.lastY
    const wid = shellWindowDrag.windowId
    if (dClientX !== 0 || dClientY !== 0) {
      const main = mainRef
      const og = outputGeom()
      const { dx, dy } =
        main && og
          ? clientPointerDeltaToCanvasLogical(dClientX, dClientY, main.getBoundingClientRect(), og.w, og.h)
          : { dx: dClientX, dy: dClientY }
      if (dx !== 0 || dy !== 0) {
        shellMoveDeltaLogSeq += 1
        if (shellMoveDeltaLogSeq <= 12 || shellMoveDeltaLogSeq % 30 === 0) {
          shellMoveLog('titlebar_delta', { seq: shellMoveDeltaLogSeq, dx, dy, clientX, clientY })
        }
        batch(() => {
          bumpShellWindowPosition(wid, dx, dy)
          shellWireSend('move_delta', dx, dy)
        })
      }
      shellWindowDrag.lastX = cx
      shellWindowDrag.lastY = cy
    }
    const main = mainRef
    const og = outputGeom()
    const co = layoutCanvasOrigin()
    if (!main || !og) return
    const mainRect = main.getBoundingClientRect()
    const glob = clientPointToGlobalLogical(cx, cy, mainRect, og.w, og.h, co)
    const list = screensListForLayout(screenDraft.rows, outputGeom(), co)
    if (list.length === 0) {
      activeSnapDropCanvas = null
      activeSnapPreviewCanvas = null
      activeSnapZone = null
      activeSnapScreen = null
      setAssistOverlay(null)
      scheduleTilePreviewSync()
      return
    }
    const mon = pickScreenForPointerSnap(glob.x, glob.y, list)
    if (!mon) {
      activeSnapDropCanvas = null
      activeSnapPreviewCanvas = null
      activeSnapZone = null
      activeSnapScreen = null
      setAssistOverlay(null)
      scheduleTilePreviewSync()
      return
    }
    if (getMonitorLayout(mon.name).layout.type !== 'manual-snap') {
      activeSnapDropCanvas = null
      activeSnapPreviewCanvas = null
      activeSnapZone = null
      activeSnapScreen = null
      setAssistOverlay(null)
      scheduleTilePreviewSync()
      return
    }
    const reserveTb = reserveTaskbarForMon(mon)
    const work = monitorWorkAreaGlobal(mon, reserveTb)
    const inAssistTopStrip =
      glob.x >= work.x &&
      glob.x <= work.x + work.w &&
      ((glob.y >= work.y && glob.y <= work.y + TILE_SNAP_EDGE_PX) ||
        (glob.y < work.y && work.y - glob.y <= TILE_SNAP_EDGE_PX))

    const gridShape = DEFAULT_ASSIST_GRID_SHAPE

    if (inAssistTopStrip) {
      const wl = rectGlobalToCanvasLocal(work.x, work.y, work.w, work.h, co)
      const gutterPx = assistGridGutterPx(work, gridShape)
      const pxForAssist = Math.max(work.x, Math.min(glob.x, work.x + work.w))
      const pyForAssist = Math.max(work.y, Math.min(glob.y, work.y + work.h))
      const span = assistSpanFromWorkAreaPoint(pxForAssist, pyForAssist, gridShape, work)
      if (span) {
        const { zone, previewRect: pr } = snapZoneAndPreviewFromAssistSpan(span, gridShape, work)
        const workRect: TileRect = { x: work.x, y: work.y, width: work.w, height: work.h }
        const occupied = occupiedSnapZonesOnMonitor(mon, wid)
        const snapBounds = snapZoneToBoundsWithOccupied(zone, workRect, occupied)
        const snapG = {
          x: snapBounds.x,
          y: snapBounds.y,
          w: snapBounds.width,
          h: snapBounds.height,
        }
        activeSnapDropCanvas = rectGlobalToCanvasLocal(snapG.x, snapG.y, snapG.w, snapG.h, co)
        activeSnapZone = zone
        activeSnapScreen = mon
        const th = CHROME_TITLEBAR_PX
        const previewG = { x: pr.x, y: pr.y - th, w: pr.width, h: pr.height + th }
        activeSnapPreviewCanvas = rectGlobalToCanvasLocal(previewG.x, previewG.y, previewG.w, previewG.h, co)
      } else {
        activeSnapDropCanvas = null
        activeSnapPreviewCanvas = null
        activeSnapZone = null
        activeSnapScreen = null
      }
      setAssistOverlay({
        shape: gridShape,
        gutterPx,
        hoverSpan: span,
        workCanvas: { x: wl.x, y: wl.y, w: wl.w, h: wl.h },
      })
      scheduleTilePreviewSync()
      return
    }

    setAssistOverlay(null)
    const zone = hitTestSnapZoneGlobal(glob.x, glob.y, work)
    if (!zone) {
      activeSnapDropCanvas = null
      activeSnapPreviewCanvas = null
      activeSnapZone = null
      activeSnapScreen = null
      scheduleTilePreviewSync()
      return
    }
    const workRect: TileRect = { x: work.x, y: work.y, width: work.w, height: work.h }
    const occupied = occupiedSnapZonesOnMonitor(mon, wid)
    const snapBounds = snapZoneToBoundsWithOccupied(zone, workRect, occupied)
    const snapG = {
      x: snapBounds.x,
      y: snapBounds.y,
      w: snapBounds.width,
      h: snapBounds.height,
    }
    activeSnapDropCanvas = rectGlobalToCanvasLocal(snapG.x, snapG.y, snapG.w, snapG.h, co)
    activeSnapZone = zone
    activeSnapScreen = mon
    const th = CHROME_TITLEBAR_PX
    const previewG = { x: snapG.x, y: snapG.y - th, w: snapG.w, h: snapG.h + th }
    activeSnapPreviewCanvas = rectGlobalToCanvasLocal(previewG.x, previewG.y, previewG.w, previewG.h, co)
    scheduleTilePreviewSync()
  }

  function endShellWindowMove(reason: string) {
    if (!shellWindowDrag) return
    const id = shellWindowDrag.windowId
    shellMoveLog('titlebar_end', { windowId: id, reason })
    shellWindowDrag = null
    const snap = activeSnapDropCanvas
    const droppedZone = activeSnapZone
    activeSnapDropCanvas = null
    activeSnapPreviewCanvas = null
    activeSnapZone = null
    setAssistOverlay(null)
    const snapMon = activeSnapScreen
    activeSnapScreen = null
    if (tilePreviewRaf) {
      cancelAnimationFrame(tilePreviewRaf)
      tilePreviewRaf = 0
    }
    lastTilePreviewKey = ''
    shellWireSend('set_tile_preview', 0, 0, 0, 0, 0)
    if (snap && droppedZone !== null && snapMon) {
      const pre = dragPreTileSnapshot.get(id)
      if (pre) perMonitorTiles.preTileGeometry.set(id, pre)
      const co = layoutCanvasOrigin()
      const reserveTb = reserveTaskbarForMon(snapMon)
      const work = monitorWorkAreaGlobal(snapMon, reserveTb)
      const workRect: TileRect = { x: work.x, y: work.y, width: work.w, height: work.h }
      const occ = occupiedSnapZonesOnMonitor(snapMon, id)
      const prevMon = perMonitorTiles.findMonitorForTiledWindow(id)
      if (prevMon !== null && prevMon !== snapMon.name) {
        perMonitorTiles.stateFor(prevMon).untileWindow(id)
      }
      const gb = perMonitorTiles.stateFor(snapMon.name).tileWindow(id, droppedZone, workRect, occ)
      const loc = rectGlobalToCanvasLocal(gb.x, gb.y, gb.width, gb.height, co)
      shellWireSend('set_geometry', id, loc.x, loc.y, loc.w, loc.h, SHELL_LAYOUT_FLOATING)
      applyGeometryToWindowMaps(id, loc, { maximized: false })
      scheduleExclusionZonesSync()
      bumpSnapChrome()
    }
    dragPreTileSnapshot.delete(id)
    shellWireSend('move_end', id)
  }

  function beginShellWindowResize(windowId: number, edges: number, clientX: number, clientY: number) {
    if (shellWindowResize !== null || shellWindowDrag !== null) return
    shellResizeDeltaLogSeq = 0
    const mon = perMonitorTiles.findMonitorForTiledWindow(windowId)
    const tol = TILE_RESIZE_EDGE_ALIGN_PX
    let useTiledPropagate = false
    const initialRects = new Map<number, TileRect>()
    if (mon !== null) {
      const st = perMonitorTiles.stateFor(mon)
      const dirs: Array<'left' | 'right' | 'top' | 'bottom'> = []
      if (edges & SHELL_RESIZE_LEFT) dirs.push('left')
      if (edges & SHELL_RESIZE_RIGHT) dirs.push('right')
      if (edges & SHELL_RESIZE_TOP) dirs.push('top')
      if (edges & SHELL_RESIZE_BOTTOM) dirs.push('bottom')
      const seen = new Set<number>([windowId])
      for (const dir of dirs) {
        for (const nid of st.findEdgeNeighbors(windowId, dir, tol)) {
          seen.add(nid)
        }
      }
      if (seen.size > 1) {
        useTiledPropagate = true
        for (const sid of seen) {
          const e = st.tiledWindows.get(sid)
          if (e) initialRects.set(sid, { ...e.bounds })
        }
      }
    }
    if (useTiledPropagate && mon !== null) {
      if (!shellWireSend('resize_shell_grab_begin', windowId)) return
      shellWindowResize = {
        kind: 'tiled',
        windowId,
        lastX: Math.round(clientX),
        lastY: Math.round(clientY),
        edges,
        accumDx: 0,
        accumDy: 0,
        initialRects,
        outputName: mon,
      }
      shellMoveLog('resize_begin_tiled', { windowId, edges, clientX, clientY })
      return
    }
    if (!shellWireSend('resize_begin', windowId, edges)) return
    shellWindowResize = {
      kind: 'compositor',
      windowId,
      lastX: Math.round(clientX),
      lastY: Math.round(clientY),
    }
    shellMoveLog('resize_begin', { windowId, edges, clientX, clientY })
  }

  function applyShellWindowResize(clientX: number, clientY: number) {
    if (!shellWindowResize) return
    const cx = Math.round(clientX)
    const cy = Math.round(clientY)
    const dClientX = cx - shellWindowResize.lastX
    const dClientY = cy - shellWindowResize.lastY
    if (dClientX === 0 && dClientY === 0) return
    const main = mainRef
    const og = outputGeom()
    const { dx, dy } =
      main && og
        ? clientPointerDeltaToCanvasLogical(dClientX, dClientY, main.getBoundingClientRect(), og.w, og.h)
        : { dx: dClientX, dy: dClientY }
    if (dx === 0 && dy === 0) {
      shellWindowResize.lastX = cx
      shellWindowResize.lastY = cy
      return
    }
    if (shellWindowResize.kind === 'compositor') {
      shellResizeDeltaLogSeq += 1
      if (shellResizeDeltaLogSeq <= 12 || shellResizeDeltaLogSeq % 30 === 0) {
        shellMoveLog('resize_delta', { seq: shellResizeDeltaLogSeq, dx, dy, clientX, clientY })
      }
      shellWireSend('resize_delta', dx, dy)
      shellWindowResize.lastX = cx
      shellWindowResize.lastY = cy
      return
    }
    shellWindowResize.accumDx += dx
    shellWindowResize.accumDy += dy
    shellWindowResize.lastX = cx
    shellWindowResize.lastY = cy
    const co = layoutCanvasOrigin()
    const rects = computeTiledResizeRects(
      shellWindowResize.windowId,
      shellWindowResize.edges,
      shellWindowResize.accumDx,
      shellWindowResize.accumDy,
      shellWindowResize.initialRects,
      TILED_RESIZE_MIN_W,
      TILED_RESIZE_MIN_H,
    )
    for (const [wid, gr] of rects) {
      const loc = rectGlobalToCanvasLocal(gr.x, gr.y, gr.width, gr.height, co)
      shellWireSend('set_geometry', wid, loc.x, loc.y, loc.w, loc.h, SHELL_LAYOUT_FLOATING)
    }
    setWindows((m) => {
      let next = m
      let changed = false
      for (const [wid, gr] of rects) {
        const cur = next.get(wid)
        if (!cur) continue
        if (!changed) {
          next = new Map(next)
          changed = true
        }
        const loc = rectGlobalToCanvasLocal(gr.x, gr.y, gr.width, gr.height, co)
        next.set(wid, { ...cur, x: loc.x, y: loc.y, width: loc.w, height: loc.h, maximized: false })
      }
      return changed ? next : m
    })
    scheduleExclusionZonesSync()
    bumpSnapChrome()
  }

  function endShellWindowResize(reason: string) {
    if (!shellWindowResize) return
    const id = shellWindowResize.windowId
    if (shellWindowResize.kind === 'compositor') {
      shellMoveLog('resize_end', { windowId: id, reason })
      shellWindowResize = null
      shellWireSend('resize_end', id)
      return
    }
    const s = shellWindowResize
    shellWindowResize = null
    shellMoveLog('resize_end_tiled', { windowId: id, reason })
    const rects = computeTiledResizeRects(
      s.windowId,
      s.edges,
      s.accumDx,
      s.accumDy,
      s.initialRects,
      TILED_RESIZE_MIN_W,
      TILED_RESIZE_MIN_H,
    )
    const st = perMonitorTiles.stateFor(s.outputName)
    for (const [wid, gr] of rects) {
      st.setTiledBounds(wid, gr)
    }
    bumpSnapChrome()
    shellWireSend('resize_shell_grab_end')
  }

  async function spawnInCompositor(cmd: string) {
    const trimmed = cmd.trim()
    if (!trimmed) return
    try {
      if (shellWireSend('spawn', trimmed)) {
        clearShellActionIssue()
        return
      }
      await spawnViaShellHttp(trimmed, window.__DERP_SPAWN_URL)
      clearShellActionIssue()
    } catch (error) {
      reportShellActionIssue(`Launch failed: ${describeError(error)}`)
    }
  }

  async function refreshProgramsMenuItems() {
    const base = shellHttpBase()
    if (!base) {
      if (!ctxMenuOpen() || ctxMenuKind() !== 'programs') return
      setProgramsCatalog('items', [])
      setProgramsMenuErr('Programs list needs cef_host (no shell HTTP).')
      setProgramsMenuBusy(false)
      return
    }
    setProgramsMenuBusy(true)
    setProgramsMenuErr(null)
    try {
      const res = await fetch(`${base}/desktop_applications`)
      const text = await res.text()
      if (!ctxMenuOpen() || ctxMenuKind() !== 'programs') return
      if (!res.ok) {
        setProgramsCatalog('items', [])
        setProgramsMenuErr(
          `Failed to load (${res.status}): ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`,
        )
        return
      }
      const list = parseDesktopApplicationsResponse(text)
      if (!ctxMenuOpen() || ctxMenuKind() !== 'programs') return
      setProgramsCatalog('items', list)
      if (list.length === 0) {
        setProgramsMenuErr(null)
      }
    } catch (e) {
      if (!ctxMenuOpen() || ctxMenuKind() !== 'programs') return
      setProgramsCatalog('items', [])
      setProgramsMenuErr(`Network error: ${e}`)
    } finally {
      setProgramsMenuBusy(false)
    }
  }

  function anchorProgramsMenuFromToggle() {
    const el = document.querySelector('[data-shell-programs-toggle]')
    if (el instanceof HTMLElement) {
      const r = el.getBoundingClientRect()
      setCtxMenuAnchor({ x: r.left, y: r.bottom, alignAboveY: r.top })
    } else {
      const v = viewportCss()
      setCtxMenuAnchor({
        x: 8,
        y: Math.max(0, v.h - 48),
        alignAboveY: Math.max(0, v.h - 56),
      })
    }
  }

  function openProgramsMenu() {
    closeAllAtlasSelects()
    anchorProgramsMenuFromToggle()
    setCtxMenuKind('programs')
    setProgramsMenuBusy(true)
    setProgramsMenuErr(null)
    setProgramsCatalog('items', [])
    setCtxMenuOpen(true)
    setProgramsMenuQuery('')
    setProgramsMenuHighlightIdx(0)
    queueMicrotask(() => programsMenuSearchRef?.focus())
    void refreshProgramsMenuItems()
  }

  function toggleProgramsMenuMeta() {
    if (ctxMenuOpen() && ctxMenuKind() === 'programs') {
      setCtxMenuOpen(false)
      return
    }
    if (ctxMenuOpen() && ctxMenuKind() === 'power') {
      setCtxMenuOpen(false)
    }
    openProgramsMenu()
  }

  function onProgramsMenuClick(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    e.preventDefault()
    if (ctxMenuOpen() && ctxMenuKind() === 'programs') {
      setCtxMenuOpen(false)
      return
    }
    closeAllAtlasSelects()
    const r = e.currentTarget.getBoundingClientRect()
    setCtxMenuAnchor({ x: r.left, y: r.bottom, alignAboveY: r.top })
    setCtxMenuKind('programs')
    setProgramsMenuBusy(true)
    setProgramsMenuErr(null)
    setProgramsCatalog('items', [])
    setCtxMenuOpen(true)
    setProgramsMenuQuery('')
    setProgramsMenuHighlightIdx(0)
    queueMicrotask(() => programsMenuSearchRef?.focus())
    void refreshProgramsMenuItems()
  }

  function onPowerMenuClick(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    e.preventDefault()
    if (ctxMenuOpen() && ctxMenuKind() === 'power') {
      setCtxMenuOpen(false)
      return
    }
    closeAllAtlasSelects()
    const r = e.currentTarget.getBoundingClientRect()
    setCtxMenuAnchor({ x: r.left, y: r.bottom, alignAboveY: r.top })
    setCtxMenuKind('power')
    setPowerMenuHighlightIdx(0)
    setCtxMenuOpen(true)
  }

  const powerMenuListItems = createMemo((): ShellContextMenuItem[] => {
    if (!powerMenuOpen()) return []
    const http = shellHttpBase() !== null
    const sysTitle = http ? undefined : 'Needs shell HTTP (cef_host control server) for system power'
    return [
      {
        label: 'Suspend',
        disabled: !http,
        title: sysTitle,
        action: () => void postSessionPower('suspend'),
      },
      {
        label: 'Restart',
        disabled: !http,
        title: sysTitle,
        action: () => void postSessionPower('reboot'),
      },
      {
        label: 'Shut down',
        disabled: !http,
        title: sysTitle,
        action: () => void postSessionPower('poweroff'),
      },
      {
        label: 'Exit session',
        disabled: !canSessionControl(),
        title: canSessionControl()
          ? 'Tell compositor to exit (ends session)'
          : 'Needs cef_host control server or wire',
        action: () => {
          if (shellWireSend('quit')) {
            clearShellActionIssue()
            return
          }
          void postShell('/session_quit', {}).then(clearShellActionIssue).catch((error) => {
            reportShellActionIssue(`Exit session failed: ${describeError(error)}`)
          })
        },
      },
    ]
  })

  const programsMenuListItems = createMemo((): ShellContextMenuItem[] => {
    if (!programsMenuOpen()) return []
    if (programsMenuBusy()) return [{ label: 'Loading…', action: () => {} }]
    const err = programsMenuErr()
    if (err) return [{ label: err, action: () => {} }]
    const q = programsMenuQuery().trim()
    const raw = programsCatalog.items
    if (raw.length === 0) return [{ label: 'No applications found.', action: () => {} }]
    const rows =
      q === ''
        ? raw
        : fuzzysort.go(q, raw, { key: 'name', threshold: -10000 }).map((x) => x.obj)
    return rows.map((app) => ({
      label: app.name,
      badge: app.terminal ? 'tty' : undefined,
      action: () => {
        void spawnInCompositor(app.exec)
      },
    }))
  })

  const menuListItems = createMemo((): ShellContextMenuItem[] => {
    if (ctxMenuKind() === 'programs') return programsMenuListItems()
    if (ctxMenuKind() === 'power') return powerMenuListItems()
    return []
  })

  function programsMenuEnterShortcut(e: KeyboardEvent) {
    return !e.repeat && !e.isComposing && e.key === 'Enter'
  }

  function activateProgramsMenuSelection() {
    if (!programsMenuOpen()) return
    const items = programsMenuListItems()
    const n = items.length
    const item = items[programsMenuHighlightIdx()]
    if (!item || n === 0) return
    item.action()
    setCtxMenuOpen(false)
    hideShellFloatingWire()
  }

  function movePowerMenuHighlight(delta: number) {
    const items = powerMenuListItems()
    const n = items.length
    if (n === 0) return
    let idx = powerMenuHighlightIdx()
    for (let step = 0; step < n; step++) {
      idx = (idx + delta + n) % n
      if (!items[idx]?.disabled) {
        setPowerMenuHighlightIdx(idx)
        return
      }
    }
  }

  function activatePowerMenuSelection() {
    if (!powerMenuOpen()) return
    const items = powerMenuListItems()
    const item = items[powerMenuHighlightIdx()]
    if (!item || item.disabled) return
    item.action()
    setCtxMenuOpen(false)
    hideShellFloatingWire()
  }

  createEffect(() => {
    if (!programsMenuOpen()) return
    const list = programsMenuListItems()
    const n = list.length
    const h = programsMenuHighlightIdx()
    if (n === 0) {
      if (h !== 0) setProgramsMenuHighlightIdx(0)
      return
    }
    if (h >= n) setProgramsMenuHighlightIdx(n - 1)
    if (h < 0) setProgramsMenuHighlightIdx(0)
  })

  createEffect(() => {
    if (!programsMenuOpen()) return
    const idx = programsMenuHighlightIdx()
    void programsMenuListItems().length
    queueMicrotask(() => {
      const panel = menuPanelRef
      if (!panel) return
      const el = panel.querySelector(`[data-programs-menu-idx="${idx}"]`)
      if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' })
    })
  })

  createEffect(() => {
    if (!powerMenuOpen()) return
    const list = powerMenuListItems()
    const n = list.length
    const h = powerMenuHighlightIdx()
    if (n === 0) {
      if (h !== 0) setPowerMenuHighlightIdx(0)
      return
    }
    if (h >= n) setPowerMenuHighlightIdx(n - 1)
    if (h < 0) setPowerMenuHighlightIdx(0)
    if (list[h]?.disabled) movePowerMenuHighlight(1)
  })

  createEffect(() => {
    if (!powerMenuOpen()) return
    const idx = powerMenuHighlightIdx()
    void powerMenuListItems().length
    queueMicrotask(() => {
      const panel = menuPanelRef
      if (!panel) return
      const el = panel.querySelector(`[data-power-menu-idx="${idx}"]`)
      if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' })
    })
  })

  onMount(() => {
    const stopThemeDomSync = startThemeDomSync()
    onCleanup(stopThemeDomSync)
    void refreshThemeSettingsFromRemote()
    console.log(
      '[derp-shell-move] shell App onMount (expect cef_js_console in compositor.log when CEF forwards this prefix)',
    )
    let volumeOverlayHideTimer: ReturnType<typeof setTimeout> | undefined
    let compositorSyncAttempts = 0
    let nativeWireHadBeenReady = false
    const tryRequestCompositorSync = () => {
      if (shellWireSend('request_compositor_sync')) {
        if (typeof window.__derpShellWireSend === 'function') {
          nativeWireHadBeenReady = true
          clearShellWireIssue()
          shellWireSend('set_chrome_metrics', CHROME_TITLEBAR_PX, CHROME_BORDER_PX)
        }
        return
      }
      compositorSyncAttempts += 1
      if (compositorSyncAttempts < 80) {
        setTimeout(tryRequestCompositorSync, 100)
      } else {
        reportShellWireIssue(shellWireIssueMessage())
      }
    }
    queueMicrotask(tryRequestCompositorSync)
    queueMicrotask(() => {
      shellWireSend('set_chrome_metrics', CHROME_TITLEBAR_PX, CHROME_BORDER_PX)
    })

    wireWatchPoll = setInterval(() => {
      if (!nativeWireHadBeenReady) return
      if (typeof window.__derpShellWireSend === 'function') {
        clearShellWireIssue()
        return
      }
      reportShellWireIssue(shellWireIssueMessage())
      compositorSyncAttempts = 0
      tryRequestCompositorSync()
    }, 750)

    const onDerpShell = (ev: Event) => {
      const ce = ev as CustomEvent<DerpShellDetail>
      const d = ce.detail
      if (!d || typeof d !== 'object' || !('type' in d)) return
      if (d.type === 'context_menu_dismiss') {
        closeAllAtlasSelects()
        hideContextMenu()
        return
      }
      if (d.type === 'programs_menu_toggle') {
        toggleProgramsMenuMeta()
        return
      }
      if (d.type === 'compositor_ping') {
        shellWireSend('shell_ipc_pong')
        return
      }
      if (d.type === 'keyboard_layout') {
        const label = typeof d.label === 'string' ? d.label.trim() : ''
        setKeyboardLayoutLabel(label.length > 0 ? label : null)
        return
      }
      if (d.type === 'volume_overlay') {
        if (volumeOverlayHideTimer !== undefined) clearTimeout(volumeOverlayHideTimer)
        const linRaw = d.volume_linear_percent_x100
        const lin = typeof linRaw === 'number' && Number.isFinite(linRaw) ? Math.max(0, linRaw) : 0
        setVolumeOverlay({
          linear: lin,
          muted: !!d.muted,
          stateKnown: d.state_known !== false,
        })
        volumeOverlayHideTimer = setTimeout(() => {
          setVolumeOverlay(null)
          volumeOverlayHideTimer = undefined
        }, 2200)
        return
      }
      if (d.type === 'keybind') {
        const action = typeof d.action === 'string' ? d.action : ''
        const fid = focusedWindowId()
        const wmap = allWindowsMap()
        if (action === 'launch_terminal') {
          void spawnInCompositor('foot')
          return
        }
        if (action === 'close_focused') {
          if (fid !== null) shellWireSend('close', fid)
          return
        }
        if (action === 'toggle_programs_menu') {
          toggleProgramsMenuMeta()
          return
        }
        if (action === 'open_settings') {
          toggleSettingsShellWindow()
          return
        }
        if (action === 'screenshot_region') {
          beginScreenshotMode()
          return
        }
        if (action === 'toggle_fullscreen') {
          if (fid === null) return
          const w = wmap.get(fid)
          if (!w) return
          shellWireSend('set_fullscreen', fid, w.fullscreen ? 0 : 1)
          return
        }
        if (action === 'toggle_maximize') {
          const fromEv = coerceShellWindowId(d.target_window_id)
          const tid = fromEv ?? fid
          if (tid === null) return
          toggleShellMaximizeForWindow(tid)
          return
        }
        if (action === 'move_monitor_left' || action === 'move_monitor_right') {
          if (fid === null) return
          const w = wmap.get(fid)
          if (!w || w.minimized || w.fullscreen) return
          const co = layoutCanvasOrigin()
          const list = screensListForLayout(screenDraft.rows, outputGeom(), co)
          const curMon = pickScreenForWindow(w, list, co) ?? list[0] ?? null
          if (!curMon) return
          const tgtMon = findAdjacentMonitor(
            curMon,
            list,
            action === 'move_monitor_left' ? 'left' : 'right',
          )
          if (!tgtMon) return
          const reserveCur = reserveTaskbarForMon(curMon)
          const reserveTgt = reserveTaskbarForMon(tgtMon)
          const glob = rectCanvasLocalToGlobal(w.x, w.y, w.width, w.height, co)
          let gRect: { x: number; y: number; w: number; h: number }
          let layoutFlag: typeof SHELL_LAYOUT_FLOATING | typeof SHELL_LAYOUT_MAXIMIZED
          if (w.maximized) {
            gRect = shellMaximizedWorkAreaGlobalRect(tgtMon, reserveTgt)
            layoutFlag = SHELL_LAYOUT_MAXIMIZED
          } else if (perMonitorTiles.isTiled(fid)) {
            const zone = perMonitorTiles.getTiledZone(fid)!
            const tw = monitorWorkAreaGlobal(tgtMon, reserveTgt)
            const workRect: TileRect = { x: tw.x, y: tw.y, width: tw.w, height: tw.h }
            const occ = occupiedSnapZonesOnMonitor(tgtMon, fid)
            const gb = perMonitorTiles.moveTiledWindowToMonitor(
              fid,
              curMon.name,
              tgtMon.name,
              zone,
              workRect,
              occ,
            )
            gRect = { x: gb.x, y: gb.y, w: gb.width, h: gb.height }
            layoutFlag = SHELL_LAYOUT_FLOATING
          } else {
            const srcWork = monitorWorkAreaGlobal(curMon, reserveCur)
            const tgtWork = monitorWorkAreaGlobal(tgtMon, reserveTgt)
            const relY = glob.y - srcWork.y
            let newGlobX = tgtWork.x + Math.floor((tgtWork.w - glob.w) / 2)
            let newGlobY = tgtWork.y + relY
            const maxX = tgtWork.x + tgtWork.w - glob.w
            const maxY = tgtWork.y + tgtWork.h - glob.h
            newGlobX = Math.max(tgtWork.x, Math.min(newGlobX, maxX))
            newGlobY = Math.max(tgtWork.y, Math.min(newGlobY, maxY))
            gRect = { x: newGlobX, y: newGlobY, w: glob.w, h: glob.h }
            layoutFlag = SHELL_LAYOUT_FLOATING
          }
          const loc = rectGlobalToCanvasLocal(gRect.x, gRect.y, gRect.w, gRect.h, co)
          shellWireSend('set_geometry', fid, loc.x, loc.y, loc.w, loc.h, layoutFlag)
          setWindows((m) => {
            const cur = m.get(fid)
            if (!cur) return m
            const next = new Map(m)
            next.set(fid, {
              ...cur,
              x: loc.x,
              y: loc.y,
              width: loc.w,
              height: loc.h,
              maximized: layoutFlag === SHELL_LAYOUT_MAXIMIZED,
            })
            return next
          })
          scheduleExclusionZonesSync()
          bumpSnapChrome()
          queueMicrotask(() => {
            applyAutoLayout(curMon.name)
            applyAutoLayout(tgtMon.name)
          })
          return
        }
        if (action === 'tile_left' || action === 'tile_right') {
          if (fid === null) return
          const w = wmap.get(fid)
          if (!w || w.minimized) return
          const co = layoutCanvasOrigin()
          const list = screensListForLayout(screenDraft.rows, outputGeom(), co)
          const mon = pickScreenForWindow(w, list, co) ?? list[0] ?? null
          if (!mon) return
          const zone: SnapZone = action === 'tile_left' ? 'left-half' : 'right-half'
          const reserveTb = reserveTaskbarForMon(mon)
          const wr = monitorWorkAreaGlobal(mon, reserveTb)
          const workRect: TileRect = { x: wr.x, y: wr.y, width: wr.w, height: wr.h }
          const occ = occupiedSnapZonesOnMonitor(mon, fid)
          const prevMonKb = perMonitorTiles.findMonitorForTiledWindow(fid)
          if (prevMonKb !== null && prevMonKb !== mon.name) {
            perMonitorTiles.stateFor(prevMonKb).untileWindow(fid)
          }
          const gb = perMonitorTiles.stateFor(mon.name).tileWindow(fid, zone, workRect, occ)
          const gRect = { x: gb.x, y: gb.y, w: gb.width, h: gb.height }
          const loc = rectGlobalToCanvasLocal(gRect.x, gRect.y, gRect.w, gRect.h, co)
          const preTile = w.maximized
            ? (floatBeforeMaximize.get(fid) ?? {
                x: w.x,
                y: w.y,
                w: w.width,
                h: w.height,
              })
            : { x: w.x, y: w.y, w: w.width, h: w.height }
          perMonitorTiles.preTileGeometry.set(fid, preTile)
          if (w.maximized) floatBeforeMaximize.delete(fid)
          shellWireSend('set_geometry', fid, loc.x, loc.y, loc.w, loc.h, SHELL_LAYOUT_FLOATING)
          setWindows((m) => {
            const cur = m.get(fid)
            if (!cur) return m
            const next = new Map(m)
            next.set(fid, {
              ...cur,
              x: loc.x,
              y: loc.y,
              width: loc.w,
              height: loc.h,
              maximized: false,
            })
            return next
          })
          scheduleExclusionZonesSync()
          bumpSnapChrome()
          return
        }
        if (action === 'tile_up') {
          if (fid === null) return
          toggleShellMaximizeForWindow(fid)
          return
        }
        if (action === 'tile_down') {
          if (fid === null) return
          const w = wmap.get(fid)
          if (!w || w.minimized) return
          if (w.maximized) {
            const rest = floatBeforeMaximize.get(fid) ?? {
              x: w.x,
              y: w.y,
              w: w.width,
              h: w.height,
            }
            floatBeforeMaximize.delete(fid)
            shellWireSend('set_geometry', fid, rest.x, rest.y, rest.w, rest.h, SHELL_LAYOUT_FLOATING)
            setWindows((m) => {
              const cur = m.get(fid)
              if (!cur) return m
              const next = new Map(m)
              next.set(fid, {
                ...cur,
                x: rest.x,
                y: rest.y,
                width: rest.w,
                height: rest.h,
                maximized: false,
              })
              return next
            })
            scheduleExclusionZonesSync()
            bumpSnapChrome()
            return
          }
          if (perMonitorTiles.isTiled(fid)) {
            const tr = perMonitorTiles.preTileGeometry.get(fid)
            if (tr) {
              shellWireSend('set_geometry', fid, tr.x, tr.y, tr.w, tr.h, SHELL_LAYOUT_FLOATING)
              setWindows((m) => {
                const cur = m.get(fid)
                if (!cur) return m
                const next = new Map(m)
                next.set(fid, {
                  ...cur,
                  x: tr.x,
                  y: tr.y,
                  width: tr.w,
                  height: tr.h,
                  maximized: false,
                })
                return next
              })
            }
            perMonitorTiles.untileWindowEverywhere(fid)
            perMonitorTiles.preTileGeometry.delete(fid)
            scheduleExclusionZonesSync()
            bumpSnapChrome()
            return
          }
          return
        }
        return
      }
      if (d.type === 'focus_changed') {
        const fw = coerceShellWindowId(d.window_id)
        if (fw != null) {
          setFocusedWindowId((prev) => (prev === fw ? prev : fw))
        } else {
          setFocusedWindowId((prev) => {
            if (prev == null) return null
            const prow = windows().get(prev)
            if (prow && (prow.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) !== 0) {
              return prev
            }
            return null
          })
        }
        queueMicrotask(() => {
          scheduleExclusionZonesSync()
          flushShellUiWindowsSyncNow()
        })
        return
      }
      if (d.type === 'output_geometry') {
        setOutputGeom({ w: d.logical_width, h: d.logical_height })
        queueMicrotask(() => {
          scheduleExclusionZonesSync()
          flushShellUiWindowsSyncNow()
        })
        return
      }
      if (d.type === 'output_layout') {
        console.warn(
          '[derp_hotplug_shell] output_layout',
          JSON.stringify({
            screens: d.screens?.length,
            lw: d.canvas_logical_width,
            lh: d.canvas_logical_height,
            primary: d.shell_chrome_primary,
          }),
        )
        batch(() => {
          setOutputGeom({ w: d.canvas_logical_width, h: d.canvas_logical_height })
          setOutputPhysical({
            w: d.canvas_physical_width,
            h: d.canvas_physical_height,
          })
          if (
            typeof d.context_menu_atlas_buffer_h === 'number' &&
            d.context_menu_atlas_buffer_h > 0
          ) {
            setContextMenuAtlasBufferH(d.context_menu_atlas_buffer_h)
          }
          if (typeof d.canvas_logical_origin_x === 'number' && typeof d.canvas_logical_origin_y === 'number') {
            setLayoutCanvasOrigin({ x: d.canvas_logical_origin_x, y: d.canvas_logical_origin_y })
          } else {
            setLayoutCanvasOrigin(null)
          }
          {
            const lw = Math.max(1, d.canvas_logical_width)
            const pw = Math.max(1, d.canvas_physical_width)
            const s = (pw / lw) * 100
            const candidates = [100, 150, 200] as const
            let best: (typeof candidates)[number] = 150
            let bestD = Number.POSITIVE_INFINITY
            for (const c of candidates) {
              const dist = Math.abs(s - c)
              if (dist < bestD) {
                bestD = dist
                best = c
              }
            }
            setUiScalePercent(best)
          }
          setScreenDraft(
            'rows',
            d.screens.map((s) => ({
              name: s.name,
              x: s.x,
              y: s.y,
              width: s.width,
              height: s.height,
              transform: s.transform,
              refresh_milli_hz: typeof s.refresh_milli_hz === 'number' ? s.refresh_milli_hz : 0,
            })),
          )
          setTilingCfgRev((n) => n + 1)
          const pr =
            typeof d.shell_chrome_primary === 'string' && d.shell_chrome_primary.length > 0
              ? d.shell_chrome_primary
              : null
          setShellChromePrimaryName(pr)
        })
        queueMicrotask(() => {
          try {
            scheduleExclusionZonesSync()
            flushShellUiWindowsSyncNow()
            relayoutAllAutoMonitors()
            window.scrollTo(0, 0)
            document.documentElement.scrollTop = 0
            document.documentElement.scrollLeft = 0
            document.body.scrollTop = 0
            document.body.scrollLeft = 0
          } catch (e) {
            console.error('[derp-shell] output_layout follow-up', e)
          }
        })
        return
      }
      if (d.type === 'window_list') {
        setWindows((prev) => buildWindowsMapFromList(d.windows, prev))
        queueMicrotask(() => {
          scheduleExclusionZonesSync()
          flushShellUiWindowsSyncNow()
        })
        return
      }
      if (d.type === 'window_state') {
        const wid = coerceShellWindowId(d.window_id)
        let relayoutMon: string | null = null
        if (wid !== null) {
          const w = windows().get(wid)
          if (w) relayoutMon = w.output_name || fallbackMonitorKey()
        }
        if (d.minimized) {
          if (wid !== null) {
            setFocusedWindowId((prev) => (prev === wid ? null : prev))
          }
        }
        setWindows((m) => applyDetail(m, d))
        queueMicrotask(() => flushShellUiWindowsSyncNow())
        if (relayoutMon !== null) queueMicrotask(() => applyAutoLayout(relayoutMon!))
        return
      }
      if (d.type === 'window_unmapped') {
        const wid = coerceShellWindowId(d.window_id)
        let relayoutMon: string | null = null
        if (wid !== null) {
          setFocusedWindowId((prev) => (prev === wid ? null : prev))
          const w = windows().get(wid)
          if (w) relayoutMon = w.output_name || fallbackMonitorKey()
          perMonitorTiles.untileWindowEverywhere(wid)
          perMonitorTiles.preTileGeometry.delete(wid)
        }
        setWindows((m) => applyDetail(m, d))
        queueMicrotask(() => flushShellUiWindowsSyncNow())
        if (relayoutMon !== null) queueMicrotask(() => applyAutoLayout(relayoutMon!))
        return
      }
      if (d.type === 'window_geometry') {
        const wid = coerceShellWindowId(d.window_id)
        let prevMon: string | null = null
        if (wid !== null) {
          const w = windows().get(wid)
          if (w) prevMon = w.output_name || fallbackMonitorKey()
        }
        setWindows((m) => applyDetail(m, d))
        if (wid !== null) {
          queueMicrotask(() => {
            const w2 = windows().get(wid!)
            const fb = fallbackMonitorKey()
            const newMon = w2 ? w2.output_name || fb : null
            if (prevMon !== null && newMon !== null && prevMon !== newMon) {
              applyAutoLayout(prevMon)
              applyAutoLayout(newMon)
            }
          })
        }
        return
      }
      if (d.type === 'window_mapped') {
        setWindows((m) => applyDetail(m, d))
        const fb = fallbackMonitorKey()
        const mon =
          typeof d.output_name === 'string' && d.output_name.length > 0 ? d.output_name : fb
        queueMicrotask(() => applyAutoLayout(mon))
        return
      }
      if (d.type === 'window_metadata') {
        setWindows((m) => applyDetail(m, d))
        return
      }
    }
    window.addEventListener('derp-shell', onDerpShell as EventListener)

    const syncViewport = () =>
      setViewportCss({ w: window.innerWidth, h: window.innerHeight })
    syncViewport()

    let exclusionResizeObserver: ResizeObserver | null = null
    queueMicrotask(() => {
      const main = mainRef
      if (!main) return
      exclusionResizeObserver = new ResizeObserver(() => scheduleExclusionZonesSync())
      exclusionResizeObserver.observe(main, { box: 'border-box' })
      scheduleExclusionZonesSync()
    })

    const onPointerMove = (e: PointerEvent) => {
      applyShellWindowMove(e.clientX, e.clientY)
      applyShellWindowResize(e.clientX, e.clientY)
      setPointerClient({ x: e.clientX, y: e.clientY })
      const el = mainRef
      if (el) {
        const r = el.getBoundingClientRect()
        setPointerInMain({
          x: Math.round(e.clientX - r.left),
          y: Math.round(e.clientY - r.top),
        })
      }
    }

    const onMouseMove = (e: MouseEvent) => {
      // Do not call applyShellWindowMove here: CEF/OSR fires both pointermove and mousemove for the same
      // motion → doubled dx/dy, doubled move_delta IPC, shell state and compositor desync (looks like
      // "everything drags wrong" with multiple windows).
      setPointerClient({ x: e.clientX, y: e.clientY })
      const el = mainRef
      if (el) {
        const r = el.getBoundingClientRect()
        setPointerInMain({
          x: Math.round(e.clientX - r.left),
          y: Math.round(e.clientY - r.top),
        })
      }
    }

    const onWindowPointerUp = (e: PointerEvent) => {
      if (!e.isPrimary) return
      endShellWindowResize('window-pointerup')
      endShellWindowMove('window-pointerup')
    }

    const onWindowMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return
      endShellWindowResize('window-mouseup')
      endShellWindowMove('window-mouseup')
    }

    const onWindowPointerCancel = (e: PointerEvent) => {
      if (!e.isPrimary) return
      endShellWindowResize('window-pointercancel')
      endShellWindowMove('window-pointercancel')
    }

    const onWindowBlur = () => {
      if (shellWindowDrag) {
        shellMoveLog('window_blur_while_shell_drag', {
          windowId: shellWindowDrag.windowId,
        })
      }
      if (shellWindowResize) {
        shellMoveLog('window_blur_while_shell_resize', {
          windowId: shellWindowResize.windowId,
        })
      }
      if (screenshotMode()) stopScreenshotMode()
    }

    const onWindowTouchEnd = () => {
      endShellWindowResize('window-touchend')
      endShellWindowMove('window-touchend')
    }

    const onWindowTouchMove = (e: TouchEvent) => {
      const t = e.changedTouches[0]
      if (!t) return
      if (shellWindowDrag) {
        applyShellWindowMove(t.clientX, t.clientY)
        e.preventDefault()
      }
      if (shellWindowResize) {
        applyShellWindowResize(t.clientX, t.clientY)
        e.preventDefault()
      }
      setPointerClient({ x: t.clientX, y: t.clientY })
      const el = mainRef
      if (el) {
        const r = el.getBoundingClientRect()
        setPointerInMain({
          x: Math.round(t.clientX - r.left),
          y: Math.round(t.clientY - r.top),
        })
      }
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
    const onWindowResize = () => {
      syncViewport()
      scheduleExclusionZonesSync()
    }
    window.addEventListener('resize', onWindowResize, { passive: true })

    const onFullscreenChange = () => {
      shellWireSend('presentation_fullscreen', document.fullscreenElement ? 1 : 0)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)

    const onCtxKeyDown = (e: KeyboardEvent) => {
      if (screenshotMode() && e.key === 'Escape') {
        e.preventDefault()
        stopScreenshotMode()
        return
      }
      if (e.key === 'Escape') {
        if (closeAllAtlasSelects()) {
          e.preventDefault()
          return
        }
        hideContextMenu()
        return
      }
      if (
        !e.repeat &&
        (e.key === 'Meta' || e.code === 'MetaLeft' || e.code === 'MetaRight')
      ) {
        e.preventDefault()
        toggleProgramsMenuMeta()
        return
      }
      if (programsMenuOpen()) {
        const items = programsMenuListItems()
        const n = items.length
        if (e.key === 'ArrowDown') {
          if (n > 0) {
            e.preventDefault()
            setProgramsMenuHighlightIdx((i) => (i + 1) % n)
          }
          return
        }
        if (e.key === 'ArrowUp') {
          if (n > 0) {
            e.preventDefault()
            setProgramsMenuHighlightIdx((i) => (i - 1 + n) % n)
          }
          return
        }
        if (programsMenuEnterShortcut(e)) {
          e.preventDefault()
          e.stopPropagation()
          activateProgramsMenuSelection()
          return
        }
        if (e.key === 'Home' && n > 0) {
          e.preventDefault()
          setProgramsMenuHighlightIdx(0)
          return
        }
        if (e.key === 'End' && n > 0) {
          e.preventDefault()
          setProgramsMenuHighlightIdx(n - 1)
          return
        }
      }
      if (powerMenuOpen()) {
        const items = powerMenuListItems()
        const n = items.filter((x) => !x.disabled).length
        if (e.key === 'ArrowDown') {
          if (n > 0) {
            e.preventDefault()
            movePowerMenuHighlight(1)
          }
          return
        }
        if (e.key === 'ArrowUp') {
          if (n > 0) {
            e.preventDefault()
            movePowerMenuHighlight(-1)
          }
          return
        }
        if (!e.repeat && !e.isComposing && e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          activatePowerMenuSelection()
          return
        }
        if (e.key === 'Home' && n > 0) {
          e.preventDefault()
          const first = items.findIndex((x) => !x.disabled)
          if (first >= 0) setPowerMenuHighlightIdx(first)
          return
        }
        if (e.key === 'End' && n > 0) {
          e.preventDefault()
          let last = -1
          for (let i = items.length - 1; i >= 0; i--) {
            if (!items[i]?.disabled) {
              last = i
              break
            }
          }
          if (last >= 0) setPowerMenuHighlightIdx(last)
          return
        }
      }
    }
    const onCtxPointerDown = (e: PointerEvent) => {
      if (!ctxMenuOpen()) return
      const t = e.target
      if (t instanceof Element && t.closest('[data-shell-programs-toggle]')) return
      if (t instanceof Element && t.closest('[data-shell-settings-toggle]')) return
      if (t instanceof Element && t.closest('[data-shell-power-toggle]')) return
      const p = menuPanelRef
      if (p && t instanceof Node && p.contains(t)) return
      hideContextMenu()
    }
    document.addEventListener('keydown', onCtxKeyDown, true)
    document.addEventListener('pointerdown', onCtxPointerDown, true)

    onCleanup(() => {
      if (volumeOverlayHideTimer !== undefined) clearTimeout(volumeOverlayHideTimer)
      document.removeEventListener('keydown', onCtxKeyDown, true)
      document.removeEventListener('pointerdown', onCtxPointerDown, true)
      window.removeEventListener('derp-shell', onDerpShell as EventListener)
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
      exclusionResizeObserver?.disconnect()
      document.removeEventListener('fullscreenchange', onFullscreenChange)
    })
  })
  onCleanup(() => {
    if (wireWatchPoll !== undefined) clearInterval(wireWatchPoll)
  })

  createEffect(() => {
    windowsList()
    workspacePartition()
    windowsByMonitor()
    scheduleExclusionZonesSync()
  })

  createEffect(() => {
    if (!ctxMenuOpen()) {
      hideShellFloatingWire()
      return
    }
    void menuListItems().length
    void screenDraft.rows.length
    const anch = ctxMenuAnchor()
    const rid = requestAnimationFrame(() => {
      const main = mainRef
      const atlas = menuAtlasHostRef
      const panel = menuPanelRef
      const og = outputGeom()
      const ph = outputPhysical()
      if (!main || !atlas || !panel || !og || !ph) return
      pushShellFloatingWireFromDom({
        main,
        atlasHost: atlas,
        panel,
        anchor: { x: anch.x, y: anch.y, alignAboveY: anch.alignAboveY },
        canvasW: og.w,
        canvasH: og.h,
        physicalW: ph.w,
        physicalH: ph.h,
        contextMenuAtlasBufferH: contextMenuAtlasBufferH(),
        screens: screenDraft.rows,
        layoutOrigin: layoutCanvasOrigin(),
      })
    })
    onCleanup(() => cancelAnimationFrame(rid))
  })

  function copyDebugHudSnapshot() {
    const g = outputGeom()
    const payload = {
      t: Date.now(),
      shellBuild: shellBuildLabelText(),
      uiFps: hudFps(),
      screens: screenDraft.rows.map((r) => ({ ...r })),
      outputGeom: g ? { w: g.w, h: g.h } : null,
      windowCount: windowsList().length,
      layoutUnion: layoutUnionBbox(),
    }
    const text = JSON.stringify(payload)
    const clip = navigator.clipboard
    if (clip && typeof clip.writeText === 'function') {
      void clip.writeText(text)
    }
  }

  function DebugHudContent() {
    return (
      <div class="px-4 py-3 text-left text-xs leading-snug [&_strong]:text-shell-hud-strong">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span class="text-[0.8rem] font-semibold tracking-wide text-[var(--shell-text)]">Debug</span>
          <button
            type="button"
            class="shell-btn-muted cursor-pointer rounded px-2 py-0.5 text-[0.7rem]"
            onClick={() => location.reload()}
          >
            Reload shell
          </button>
          <button
            type="button"
            class="shell-btn-muted cursor-pointer rounded px-2 py-0.5 text-[0.7rem]"
            onClick={() => copyDebugHudSnapshot()}
          >
            Copy snapshot
          </button>
        </div>
        <p class="mb-2 tabular-nums opacity-90">
          Build <strong>{shellBuildLabelText()}</strong>
          {' · '}
          UI FPS ~<strong>{hudFps()}</strong>
        </p>
        <label class="mb-2 flex cursor-pointer items-center gap-2 select-none opacity-92">
          <input
            type="checkbox"
            class="h-3.5 w-3.5 accent-shell-accent-ring"
            checked={crosshairCursor()}
            onChange={(e) => setCrosshairCursor(e.currentTarget.checked)}
          />
          <span>Crosshair</span>
        </label>
        <Show when={outputGeom()} keyed>
          {(og) => (
            <p class="mb-2 opacity-90">
              Canvas{' '}
              <strong>
                {og.w}×{og.h}
              </strong>
            </p>
          )}
        </Show>
        <details class="shell-subpanel mb-2 rounded px-2 py-1.5" open>
          <summary class="cursor-pointer select-none text-[0.68rem] font-medium uppercase tracking-wide opacity-80">
            Layout / input
          </summary>
          <div class="mt-1.5 space-y-1 tabular-nums opacity-90">
            <div>
              Union from <code>screens[]</code>
              {': '}
              <strong>
                {layoutUnionBbox()
                  ? `@ ${layoutUnionBbox()!.x},${layoutUnionBbox()!.y} (${layoutUnionBbox()!.w}×${layoutUnionBbox()!.h})`
                  : '—'}
              </strong>
            </div>
            <div>
              Compositor union min:{' '}
              <strong>
                {layoutCanvasOrigin()
                  ? `@ ${layoutCanvasOrigin()!.x},${layoutCanvasOrigin()!.y}`
                  : '—'}
              </strong>
            </div>
            <div>
              Panel host:{' '}
              <strong>
                {panelHostForHud()
                  ? `${shellChromePrimaryName() ? `${shellChromePrimaryName()} (explicit) · ` : ''}${panelHostForHud()!.name || '—'} @ ${panelHostForHud()!.x},${panelHostForHud()!.y} (${panelHostForHud()!.width}×${panelHostForHud()!.height})`
                  : '—'}
              </strong>
            </div>
            <div>
              Viewport (CSS){' '}
              <strong>
                {viewportCss().w}×{viewportCss().h}
              </strong>
              {' · dpr '}
              <strong>{typeof window !== 'undefined' ? window.devicePixelRatio : 1}</strong>
            </div>
            <div>
              Windows: <strong>{windowsList().length}</strong>
            </div>
            <Show when={crosshairCursor()}>
              <div>
                Pointer (client){' '}
                <strong>
                  {pointerClient() ? `${pointerClient()!.x}, ${pointerClient()!.y}` : '—'}
                </strong>
              </div>
              <div>
                Pointer (main){' '}
                <strong>
                  {pointerInMain() ? `${pointerInMain()!.x}, ${pointerInMain()!.y}` : '—'}
                </strong>
              </div>
            </Show>
            <div>
              Pointer downs: <strong>{rootPointerDowns()}</strong>
            </div>
          </div>
        </details>
        <details class="shell-subpanel rounded px-2 py-1.5">
          <summary class="cursor-pointer select-none text-[0.68rem] font-medium uppercase tracking-wide opacity-80">
            Exclusion zones
          </summary>
          <div class="mt-1.5">
            <Show
              when={exclusionZonesHud().length > 0}
              fallback={<span class="block opacity-[0.65]">—</span>}
            >
              <ul class="max-h-[10rem] list-disc space-y-0.5 overflow-auto pl-4 text-[0.72rem]">
                <For each={exclusionZonesHud()}>
                  {(z) => (
                    <li class="my-0.5 list-disc">
                      <span class="mr-[0.35rem] inline-block min-w-[7rem] opacity-90">{z.label}</span>
                      <code class="font-mono text-[0.65rem] text-shell-hud-mono">
                        {z.x},{z.y} · {z.w}×{z.h}
                      </code>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </details>
      </div>
    )
  }

  const shellFloatingRegistry: ShellFloatingRegistry = {
    registerAtlasSelectCloser(fn) {
      atlasSelectClosers.add(fn)
    },
    unregisterAtlasSelectCloser(fn) {
      atlasSelectClosers.delete(fn)
    },
    closeAllAtlasSelects,
    dismissContextMenus: hideContextMenu,
    acquireAtlasOverlayPointer,
    releaseAtlasOverlayPointer,
    mainEl: () => mainRef,
    atlasHostEl: () => menuAtlasHostRef,
    atlasBufferH: contextMenuAtlasBufferH,
    menuAtlasTopPx: shellMenuAtlasTop,
    outputGeom,
    outputPhysical,
    layoutCanvasOrigin,
    screenDraftRows: () => screenDraft.rows,
  }

  return (
    <ShellFloatingProvider value={shellFloatingRegistry}>
    <main
      data-shell-main
      classList={{
        'shell-desk m-0 block min-h-screen box-border pb-0 text-[var(--shell-text)]': true,
        'cursor-crosshair': crosshairCursor(),
      }}
      style={{
        width: `${canvasCss().w}px`,
        'min-height': `${canvasCss().h}px`,
      }}
      ref={(el) => {
        mainRef = el
        queueMicrotask(() => scheduleExclusionZonesSync())
      }}
      onPointerDown={() => setRootPointerDowns((n) => n + 1)}
      onContextMenu={(e) => {
        e.preventDefault()
      }}
    >
      <Show when={shellBridgeIssue()} keyed>
        {(msg) => (
          <div class="shell-warning-banner pointer-events-none fixed top-3 left-1/2 z-[470100] -translate-x-1/2 rounded-lg px-4 py-2 text-sm font-medium">
            {msg}
          </div>
        )}
      </Show>

      <For each={windowsListIds()}>{(wid) => <ShellDeskWindowRow windowId={wid as number} />}</For>

      {volumeOverlayHud()}

      <Show when={screenshotMode()}>
        <ScreenshotOverlay />
      </Show>

      <Show when={assistOverlay} keyed>
        {(st) => {
          const s = st()
          if (!s) return <></>
          const main = mainRef
          const og = outputGeom()
          if (!main || !og) return <></>
          const css = canvasRectToClientCss(s.workCanvas.x, s.workCanvas.y, s.workCanvas.w, s.workCanvas.h, main.getBoundingClientRect(), og.w, og.h)
          return (
            <div
              class="shell-preview-frame pointer-events-none fixed z-[450000] box-border flex min-h-0 min-w-0 flex-col rounded-sm p-1.5 outline outline-2 -outline-offset-1"
              style={{
                left: `${css.left}px`,
                top: `${css.top}px`,
                width: `${css.width}px`,
                height: `${css.height}px`,
              }}
            >
              <SnapAssistMasterGrid
                shape={s.shape}
                gutterPx={s.gutterPx}
                getHoverSpan={() => assistOverlay()?.hoverSpan ?? null}
              />
            </div>
          )
        }}
      </Show>

      <For each={workspacePartition().secondary}>
        {(s) => {
          const loc = layoutScreenCssRect(s, layoutCanvasOrigin())
          return (
            <div
              class="pointer-events-none absolute z-[1] box-border border border-dashed border-[var(--shell-border)] bg-[var(--shell-overlay-muted)]"
              style={{
                left: `${loc.x}px`,
                top: `${loc.y}px`,
                width: `${loc.width}px`,
                height: `${loc.height}px`,
              }}
            >
              <Show when={debugHudFrameVisible()}>
                <span class="shell-pill absolute top-2 left-2 rounded px-2 py-1 text-[11px] font-semibold tracking-wider uppercase">
                  {s.name || 'Display'}
                </span>
              </Show>
            </div>
          )
        }}
      </For>

      <For each={taskbarScreens()}>
        {(s) => {
          const primary = workspacePartition().primary
          const isPrim = isPrimaryTaskbarScreen(s, primary)
          const loc = layoutScreenCssRect(s, layoutCanvasOrigin())
          return (
            <Show when={!screenTaskbarHiddenForFullscreen(s)}>
              <div
                class="pointer-events-none absolute z-[401000]"
                style={{
                  left: `${loc.x}px`,
                  top: `${loc.y + loc.height - TASKBAR_HEIGHT}px`,
                  width: `${loc.width}px`,
                  height: `${TASKBAR_HEIGHT}px`,
                }}
              >
                <Taskbar
                  monitorName={s.name}
                  isPrimary={isPrim}
                  programsMenuOpen={programsMenuOpen()}
                  onProgramsMenuClick={onProgramsMenuClick}
                  powerMenuOpen={powerMenuOpen()}
                  onPowerMenuClick={onPowerMenuClick}
                  windows={taskbarRowsForScreen(s)}
                  focusedWindowId={focusedWindowId()}
                  keyboardLayoutLabel={isPrim ? keyboardLayoutLabel() : null}
                  settingsPanelOpen={settingsHudFrameVisible()}
                  onSettingsPanelToggle={() => {
                    toggleSettingsShellWindow()
                  }}
                  debugPanelOpen={debugHudFrameVisible()}
                  onDebugPanelToggle={() => {
                    const w = windows().get(SHELL_UI_DEBUG_WINDOW_ID)
                    if (!w || w.minimized) openDebugShellWindow()
                    else minimizeDebugShellWindow()
                  }}
                  onTaskbarActivate={(id) => {
                    shellWireSend('taskbar_activate', id)
                  }}
                  onTaskbarClose={(id) => {
                    shellWireSend('close', id)
                  }}
                />
              </div>
            </Show>
          )
        }}
      </For>

      <div
        class="relative z-[90000] contain-layout contain-paint overflow-hidden"
        classList={{
          'pointer-events-auto': ctxMenuOpen() || atlasOverlayPointerUsers() > 0,
          'pointer-events-none': !ctxMenuOpen() && atlasOverlayPointerUsers() === 0,
        }}
        ref={(el) => {
          menuAtlasHostRef = el
        }}
        style={{
          position: 'absolute',
          left: '0',
          right: '0',
          top: `${shellMenuAtlasTop()}px`,
          bottom: '0',
        }}
      >
        <Show when={ctxMenuOpen()}>
          <div
            class="shell-menu absolute top-2 left-2 z-[90000] flex max-h-[min(420px,55vh,calc(100%-16px))] min-w-[12rem] flex-col overflow-hidden rounded-[0.35rem]"
            role={ctxMenuKind() === 'programs' ? 'group' : 'menu'}
            aria-label={
              ctxMenuKind() === 'programs'
                ? 'Applications'
                : ctxMenuKind() === 'power'
                  ? 'Power'
                  : 'Menu'
            }
            ref={(el) => {
              menuPanelRef = el
            }}
          >
            <Show when={ctxMenuKind() === 'programs'}>
              <div class="shrink-0 border-b border-[var(--shell-border)] px-2 py-2">
                <input
                  type="text"
                  inputMode="search"
                  autocomplete="off"
                  class="shell-input box-border w-full rounded-[0.3rem] px-2.5 py-1.5 text-[0.9rem] font-inherit text-inherit"
                  placeholder="Search applications"
                  aria-label="Search applications"
                  value={programsMenuQuery()}
                  ref={(el) => {
                    programsMenuSearchRef = el
                  }}
                  onInput={(ev) => {
                    setProgramsMenuQuery(ev.currentTarget.value)
                    setProgramsMenuHighlightIdx(0)
                  }}
                  onKeyDown={(e) => {
                    if (programsMenuEnterShortcut(e)) {
                      e.preventDefault()
                      e.stopPropagation()
                      activateProgramsMenuSelection()
                    }
                  }}
                />
              </div>
            </Show>
            <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1">
              <For each={menuListItems()}>
                {(item, idx) => (
                  <button
                    type="button"
                    class="shell-menu-item flex w-full cursor-pointer items-center justify-between gap-2 border-0 bg-transparent px-3 py-[0.45rem] text-left font-inherit text-inherit"
                    classList={{
                      'shell-menu-item-active':
                        (ctxMenuKind() === 'programs' && programsMenuHighlightIdx() === idx()) ||
                        (ctxMenuKind() === 'power' && powerMenuHighlightIdx() === idx()),
                      'cursor-not-allowed opacity-40': !!item.disabled,
                    }}
                    role={ctxMenuKind() === 'programs' ? undefined : 'menuitem'}
                    tabIndex={ctxMenuKind() === 'programs' ? -1 : undefined}
                    title={item.title}
                    data-programs-menu-idx={ctxMenuKind() === 'programs' ? idx() : undefined}
                    data-power-menu-idx={ctxMenuKind() === 'power' ? idx() : undefined}
                    onMouseDown={(e) => {
                      if (ctxMenuKind() === 'programs') e.preventDefault()
                    }}
                    onFocus={(e) => {
                      if (ctxMenuKind() !== 'programs') return
                      if (e.target !== programsMenuSearchRef) {
                        queueMicrotask(() => programsMenuSearchRef?.focus())
                      }
                    }}
                    onClick={() => {
                      if (item.disabled) return
                      item.action()
                      setCtxMenuOpen(false)
                    }}
                  >
                    <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                      {item.label}
                    </span>
                    <Show when={item.badge} keyed>
                      {(b) => (
                        <span class="shell-badge-accent shrink-0 rounded px-[0.35rem] py-[0.15rem] text-[0.65rem] tracking-wide uppercase opacity-85">
                          {b}
                        </span>
                      )}
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>

      <div class="pointer-events-none fixed inset-0 z-50" aria-hidden="true">
        {crosshairDebugOverlay()}
      </div>
    </main>
    </ShellFloatingProvider>
  )
}

export default App
