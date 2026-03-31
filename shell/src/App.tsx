import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  For,
  Index,
  Show,
} from 'solid-js'
import { createStore } from 'solid-js/store'
import './App.css'
import {
  CHROME_TASKBAR_RESERVE_PX,
  CHROME_TITLEBAR_PX,
  SHELL_LAYOUT_MAXIMIZED,
} from './chromeConstants'
import { ShellWindowFrame } from './ShellWindowFrame'
import { Taskbar } from './Taskbar'
import { TransformPicker } from './TransformPicker'
import {
  atlasTopFromLayout,
  logicalWorkspaceBoundsFromScreens,
  menuPlacementForCompositor,
  type ShellContextMenuItem,
} from './contextMenu'

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
        | 'spawn'
        | 'move_begin'
        | 'move_delta'
        | 'move_end'
        | 'resize_begin'
        | 'resize_delta'
        | 'resize_end'
        | 'taskbar_activate'
        | 'minimize'
        | 'set_geometry'
        | 'set_fullscreen'
        | 'set_maximized'
        | 'presentation_fullscreen'
        | 'set_output_layout'
        | 'set_exclusion_zones'
        | 'set_shell_primary'
        | 'set_ui_scale'
        | 'context_menu',
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

function screensListForLayout(rows: LayoutScreen[], canvas: { w: number; h: number } | null): LayoutScreen[] {
  if (rows.length > 0) return rows
  if (canvas && canvas.w > 0 && canvas.h > 0) {
    return [
      {
        name: '',
        x: 0,
        y: 0,
        refresh_milli_hz: 0,
        width: canvas.w,
        height: canvas.h,
        transform: 0,
      },
    ]
  }
  return []
}

function monitorRefreshLabel(milli: number): string {
  if (!milli || milli <= 0) return '—'
  const hz = milli / 1000
  const t = hz.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return `${t} Hz`
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

type DerpWindow = {
  window_id: number
  surface_id: number
  x: number
  y: number
  width: number
  height: number
  title: string
  app_id: string
  minimized: boolean
  maximized: boolean
  fullscreen: boolean
}

function pickScreenForWindowGlobal(win: DerpWindow, list: LayoutScreen[]): LayoutScreen | null {
  if (list.length === 0) return null
  const cx = win.x + Math.floor(win.width / 2)
  const cy = win.y + Math.floor(win.height / 2)
  for (const s of list) {
    if (
      cx >= s.x &&
      cy >= s.y &&
      cx < s.x + s.width &&
      cy < s.y + s.height
    ) {
      return s
    }
  }
  return list[0]
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

function buildWindowsMapFromList(raw: unknown): Map<number, DerpWindow> {
  const next = new Map<number, DerpWindow>()
  if (!Array.isArray(raw)) return next
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const wid = coerceShellWindowId(r.window_id)
    const sid = coerceShellWindowId(r.surface_id)
    if (wid === null || sid === null) continue
    next.set(wid, {
      window_id: wid,
      surface_id: sid,
      x: Number(r.x) || 0,
      y: Number(r.y) || 0,
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
      title: typeof r.title === 'string' ? r.title : '',
      app_id: typeof r.app_id === 'string' ? r.app_id : '',
      minimized: !!r.minimized,
      maximized: !!r.maximized,
      fullscreen: !!r.fullscreen,
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
        x: detail.x,
        y: detail.y,
        width: detail.width,
        height: detail.height,
        title: detail.title,
        app_id: detail.app_id,
        minimized: false,
        maximized: false,
        fullscreen: false,
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

/** Ruler insets — must match `.shell-ruler--top` / `.shell-ruler--left` in `App.css`. */
const RULER_GUTTER_X = 28
const RULER_GUTTER_Y = 22

function shellHttpBase(): string | null {
  const u = window.__DERP_SHELL_HTTP
  if (u && u.startsWith('http://127.0.0.1:')) return u.replace(/\/$/, '')
  return null
}

async function postShell(path: string, body: object): Promise<void> {
  const base = shellHttpBase()
  if (!base) return
  await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Tee’d into `compositor.log` when `cef_host` stderr is captured (session). Filter: `derp-shell-move`. */
function shellMoveLog(msg: string, detail?: Record<string, unknown>) {
  const extra = detail !== undefined ? ` ${JSON.stringify(detail)}` : ''
  console.log(`[derp-shell-move] ${msg}${extra}`)
}

function clientRectToGlobalLogical(
  mainRect: DOMRect,
  elRect: DOMRect,
  canvasW: number,
  canvasH: number,
  origin: { x: number; y: number } | null,
) {
  const ox = origin?.x ?? 0
  const oy = origin?.y ?? 0
  const cw = Math.max(1, canvasW)
  const ch = Math.max(1, canvasH)
  const mw = Math.max(1, mainRect.width)
  const mh = Math.max(1, mainRect.height)
  const sx = cw / mw
  const sy = ch / mh
  const lx = (elRect.left - mainRect.left) * sx
  const ly = (elRect.top - mainRect.top) * sy
  const lw = elRect.width * sx
  const lh = elRect.height * sy
  return {
    x: Math.round(lx + ox),
    y: Math.round(ly + oy),
    w: Math.max(1, Math.round(lw)),
    h: Math.max(1, Math.round(lh)),
  }
}

function shellWireSend(
  op:
    | 'close'
    | 'quit'
    | 'spawn'
    | 'move_begin'
    | 'move_delta'
    | 'move_end'
    | 'resize_begin'
    | 'resize_delta'
    | 'resize_end'
    | 'taskbar_activate'
    | 'minimize'
    | 'set_geometry'
    | 'set_fullscreen'
    | 'set_maximized'
    | 'presentation_fullscreen'
    | 'set_output_layout'
    | 'set_exclusion_zones'
    | 'set_shell_primary'
    | 'set_ui_scale',
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
      op === 'resize_end'
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
  } else if (op === 'quit') {
    fn(op)
  } else if (op === 'set_output_layout' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'set_exclusion_zones' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'set_shell_primary' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'set_ui_scale' && typeof arg === 'number') {
    fn(op, arg)
  } else {
    fn(op, arg)
  }
  return true
}

function shellContextMenuWire(
  visible: boolean,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  gx: number,
  gy: number,
  gw: number,
  gh: number,
): boolean {
  const fn = window.__derpShellWireSend as
    | ((
        op: 'context_menu',
        vis: number,
        bx: number,
        by: number,
        bw: number,
        bh: number,
        gx: number,
        gy: number,
        gw: number,
        gh: number,
      ) => void)
    | undefined
  if (typeof fn !== 'function') return false
  fn('context_menu', visible ? 1 : 0, bx, by, bw, bh, gx, gy, gw, gh)
  return true
}

function canSessionControl(): boolean {
  return typeof window.__derpShellWireSend === 'function' || shellHttpBase() !== null
}

function App() {
  const panelHue = 210
  const [spawnStatus, setSpawnStatus] = createSignal<string | null>(null)
  const [spawnBusy, setSpawnBusy] = createSignal(false)
  const [rootPointerDowns, setRootPointerDowns] = createSignal(0)
  const [btnPointerDowns, setBtnPointerDowns] = createSignal(0)
  const [spawnClicks, setSpawnClicks] = createSignal(0)
  const [spawnUrlLine, setSpawnUrlLine] = createSignal('')
  const [spawnCommand, setSpawnCommand] = createSignal('foot')

  const [pointerClient, setPointerClient] = createSignal<{ x: number; y: number } | null>(null)
  const [pointerInMain, setPointerInMain] = createSignal<{ x: number; y: number } | null>(null)
  const [viewportCss, setViewportCss] = createSignal({
    w: typeof window !== 'undefined' ? window.innerWidth : 800,
    h: typeof window !== 'undefined' ? window.innerHeight : 600,
  })
  const [windows, setWindows] = createSignal<Map<number, DerpWindow>>(new Map())
  const [focusedWindowId, setFocusedWindowId] = createSignal<number | null>(null)
  const [outputGeom, setOutputGeom] = createSignal<{ w: number; h: number } | null>(null)
  const [layoutCanvasOrigin, setLayoutCanvasOrigin] = createSignal<{ x: number; y: number } | null>(
    null,
  )
  const [screenDraft, setScreenDraft] = createStore<{ rows: LayoutScreen[] }>({ rows: [] })
  const [orientationPickerOpen, setOrientationPickerOpen] = createSignal<number | null>(null)
  const [crosshairCursor, setCrosshairCursor] = createSignal(false)
  const [exclusionZonesHud, setExclusionZonesHud] = createSignal<ExclusionHudZone[]>([])
  const [uiScalePercent, setUiScalePercent] = createSignal<100 | 150>(150)
  const [shellChromePrimaryName, setShellChromePrimaryName] = createSignal<string | null>(null)
  const [outputPhysical, setOutputPhysical] = createSignal<{ w: number; h: number } | null>(null)
  const [contextMenuAtlasBufferH, setContextMenuAtlasBufferH] = createSignal(1536)
  const [ctxMenuOpen, setCtxMenuOpen] = createSignal(false)
  const [ctxMenuKind, setCtxMenuKind] = createSignal<'demo' | 'programs' | null>(null)
  const [ctxMenuItems, setCtxMenuItems] = createSignal<ShellContextMenuItem[]>([])
  const [ctxMenuAnchor, setCtxMenuAnchor] = createSignal<{
    x: number
    y: number
    alignAboveY?: number
  }>({ x: 0, y: 0 })
  let skipNextContextMenuHideWire = false
  const programsMenuOpen = createMemo(() => ctxMenuOpen() && ctxMenuKind() === 'programs')

  const rulerStepPx = 100

  createEffect(() => {
    if (!ctxMenuOpen()) setCtxMenuKind(null)
  })

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

  /** Stable by `window_id` only — never sort by focus here. Focus-based sort reordered `<Index>` rows on every
   * `focus_changed`, churning titlebars and scrambling which row owned which window (visible flicker / wrong drag target). */
  const windowsList = createMemo(() =>
    Array.from(windows().values()).sort((a, b) => a.window_id - b.window_id),
  )

  const taskbarWindows = createMemo(() =>
    windowsList().map((w) => ({
      window_id: w.window_id,
      title: w.title,
      app_id: w.app_id,
      minimized: w.minimized,
    })),
  )

  const horizontalRulerTicks = createMemo(() => {
    const w = viewportCss().w
    if (w <= 0) return [] as number[]
    const out: number[] = []
    for (let x = 0; x <= w; x += rulerStepPx) {
      if (x >= RULER_GUTTER_X) out.push(x)
    }
    return out
  })

  const verticalRulerTicks = createMemo(() => {
    const h = viewportCss().h
    if (h <= 0) return [] as number[]
    const out: number[] = []
    for (let y = 0; y <= h; y += rulerStepPx) {
      if (y >= RULER_GUTTER_Y) out.push(y)
    }
    return out
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
        <div class="shell-crosshair shell-crosshair--v" style={{ left: `${p.x}px` }} />
        <div class="shell-crosshair shell-crosshair--h" style={{ top: `${p.y}px` }} />
        <div
          class="shell-cursor-readout"
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

  let spawnPoll: ReturnType<typeof setInterval> | undefined
  let mainRef: HTMLElement | undefined
  let menuAtlasHostRef: HTMLElement | undefined
  let menuPanelRef: HTMLElement | undefined
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
    const rects: Array<{ x: number; y: number; w: number; h: number }> = []
    const hud: ExclusionHudZone[] = []
    const addEl = (el: Element | null | undefined, label: string) => {
      if (!el) return
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      const z = clientRectToGlobalLogical(mainRect, r, og.w, og.h, co)
      rects.push({ x: z.x, y: z.y, w: z.w, h: z.h })
      hud.push({ label, ...z })
    }
    addEl(main.querySelector('.shell-panel'), 'panel')
    addEl(main.querySelector('.shell-taskbar'), 'taskbar')
    setExclusionZonesHud(hud)
    if (typeof window.__derpShellWireSend === 'function') {
      window.__derpShellWireSend('set_exclusion_zones', JSON.stringify({ rects }))
    }
  }

  function scheduleExclusionZonesSync() {
    if (exclusionZonesRaf) cancelAnimationFrame(exclusionZonesRaf)
    exclusionZonesRaf = requestAnimationFrame(() => {
      exclusionZonesRaf = 0
      syncExclusionZonesNow()
    })
  }

  /** Local-only draggable box. CEF OSR often delivers mouse events to `window` more reliably than `PointerEvent` + capture on a node. */
  const [dragDemoPos, setDragDemoPos] = createSignal({ x: 48, y: 96 })
  let dragDemoGrab: { offsetX: number; offsetY: number } | null = null
  let dragDemoMoveLogSeq = 0

  /** Shell → compositor window move (same wire as `cef_host` `shell_uplink`). */
  let shellWindowDrag: { windowId: number; lastX: number; lastY: number } | null = null
  let shellMoveDeltaLogSeq = 0

  let shellWindowResize: { windowId: number; lastX: number; lastY: number } | null = null
  let shellResizeDeltaLogSeq = 0

  function beginShellWindowMove(windowId: number, clientX: number, clientY: number) {
    if (shellWindowResize !== null) return
    shellMoveLog('titlebar_begin_request', { windowId, clientX, clientY })
    shellMoveDeltaLogSeq = 0
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
    const dx = cx - shellWindowDrag.lastX
    const dy = cy - shellWindowDrag.lastY
    if (dx === 0 && dy === 0) return
    shellMoveDeltaLogSeq += 1
    if (shellMoveDeltaLogSeq <= 12 || shellMoveDeltaLogSeq % 30 === 0) {
      shellMoveLog('titlebar_delta', { seq: shellMoveDeltaLogSeq, dx, dy, clientX, clientY })
    }
    const wid = shellWindowDrag.windowId
    batch(() => {
      bumpShellWindowPosition(wid, dx, dy)
      shellWireSend('move_delta', dx, dy)
    })
    shellWindowDrag.lastX = cx
    shellWindowDrag.lastY = cy
  }

  function endShellWindowMove(reason: string) {
    if (!shellWindowDrag) return
    const id = shellWindowDrag.windowId
    shellMoveLog('titlebar_end', { windowId: id, reason })
    shellWindowDrag = null
    shellWireSend('move_end', id)
  }

  function beginShellWindowResize(windowId: number, edges: number, clientX: number, clientY: number) {
    if (shellWindowResize !== null || shellWindowDrag !== null) return
    shellResizeDeltaLogSeq = 0
    if (!shellWireSend('resize_begin', windowId, edges)) return
    shellWindowResize = { windowId, lastX: Math.round(clientX), lastY: Math.round(clientY) }
    shellMoveLog('resize_begin', { windowId, edges, clientX, clientY })
  }

  function applyShellWindowResize(clientX: number, clientY: number) {
    if (!shellWindowResize) return
    const cx = Math.round(clientX)
    const cy = Math.round(clientY)
    const dx = cx - shellWindowResize.lastX
    const dy = cy - shellWindowResize.lastY
    if (dx === 0 && dy === 0) return
    shellResizeDeltaLogSeq += 1
    if (shellResizeDeltaLogSeq <= 12 || shellResizeDeltaLogSeq % 30 === 0) {
      shellMoveLog('resize_delta', { seq: shellResizeDeltaLogSeq, dx, dy, clientX, clientY })
    }
    shellWireSend('resize_delta', dx, dy)
    shellWindowResize.lastX = cx
    shellWindowResize.lastY = cy
  }

  function endShellWindowResize(reason: string) {
    if (!shellWindowResize) return
    const id = shellWindowResize.windowId
    shellMoveLog('resize_end', { windowId: id, reason })
    shellWindowResize = null
    shellWireSend('resize_end', id)
  }

  /** Readable in `~/.local/state/derp/compositor.log` when `cef_host` runs under `derp-session` (stderr tee). */
  function dragLog(msg: string, detail?: Record<string, unknown>) {
    const extra = detail !== undefined ? ` ${JSON.stringify(detail)}` : ''
    console.log(`[derp-drag] ${msg}${extra}`)
  }

  function armDragDemo(clientX: number, clientY: number) {
    const p = dragDemoPos()
    dragDemoGrab = { offsetX: clientX - p.x, offsetY: clientY - p.y }
    dragDemoMoveLogSeq = 0
    dragLog('arm', {
      clientX,
      clientY,
      box: p,
      grab: dragDemoGrab,
    })
  }

  function applyDragDemoMove(clientX: number, clientY: number) {
    if (!dragDemoGrab) return
    dragDemoMoveLogSeq += 1
    if (dragDemoMoveLogSeq === 1 || dragDemoMoveLogSeq % 20 === 0) {
      dragLog('move', { seq: dragDemoMoveLogSeq, clientX, clientY })
    }
    setDragDemoPos({
      x: clientX - dragDemoGrab.offsetX,
      y: clientY - dragDemoGrab.offsetY,
    })
  }

  function disarmDragDemo(reason: string) {
    if (dragDemoGrab) {
      dragLog('disarm', { reason })
    }
    dragDemoGrab = null
  }

  const panelHueStyle = () => ({ '--shell-hue': `${panelHue}` } as const)

  onMount(() => {
    console.log(
      '[derp-shell-move] shell App onMount (expect cef_js_console in compositor.log when CEF forwards this prefix)',
    )
    const refreshSpawnUrl = () => {
      const u = window.__DERP_SPAWN_URL
      setSpawnUrlLine(
        u
          ? `Spawn endpoint: ${u}`
          : 'Spawn endpoint: not set yet — waiting for cef_host inject, or not in CEF',
      )
    }
    refreshSpawnUrl()
    spawnPoll = setInterval(refreshSpawnUrl, 400)

    const onDerpShell = (ev: Event) => {
      const ce = ev as CustomEvent<DerpShellDetail>
      const d = ce.detail
      if (!d || typeof d !== 'object' || !('type' in d)) return
      if (d.type === 'context_menu_dismiss') {
        skipNextContextMenuHideWire = true
        setCtxMenuOpen(false)
        return
      }
      if (d.type === 'focus_changed') {
        const fw = coerceShellWindowId(d.window_id)
        setFocusedWindowId((prev) => (prev === fw ? prev : fw))
        return
      }
      if (d.type === 'output_geometry') {
        setOutputGeom({ w: d.logical_width, h: d.logical_height })
        queueMicrotask(() => scheduleExclusionZonesSync())
        return
      }
      if (d.type === 'output_layout') {
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
            let pct = Math.round((pw / lw) * 100)
            if (pct !== 100 && pct !== 150) {
              pct = pct > 120 ? 150 : 100
            }
            setUiScalePercent(pct as 100 | 150)
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
          const pr =
            typeof d.shell_chrome_primary === 'string' && d.shell_chrome_primary.length > 0
              ? d.shell_chrome_primary
              : null
          setShellChromePrimaryName(pr)
        })
        queueMicrotask(() => scheduleExclusionZonesSync())
        return
      }
      if (d.type === 'window_list') {
        setWindows(buildWindowsMapFromList(d.windows))
        return
      }
      if (d.type === 'window_state') {
        if (d.minimized) {
          const wid = coerceShellWindowId(d.window_id)
          if (wid !== null) {
            setFocusedWindowId((prev) => (prev === wid ? null : prev))
          }
        }
        setWindows((m) => applyDetail(m, d))
        return
      }
      setWindows((m) => applyDetail(m, d))
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
      if (dragDemoGrab && dragDemoMoveLogSeq < 3 && e.buttons === 0) {
        dragLog('pointermove_with_grab_but_buttons_0', {
          pointerType: e.pointerType,
          button: e.button,
        })
      }
      applyDragDemoMove(e.clientX, e.clientY)
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
      if (dragDemoGrab && dragDemoMoveLogSeq < 3 && e.buttons === 0) {
        dragLog('mousemove_with_grab_but_buttons_0', { type: 'mouse' })
      }
      applyDragDemoMove(e.clientX, e.clientY)
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
      disarmDragDemo('window-pointerup')
      endShellWindowResize('window-pointerup')
      endShellWindowMove('window-pointerup')
    }

    const onWindowMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return
      disarmDragDemo('window-mouseup')
      endShellWindowResize('window-mouseup')
      endShellWindowMove('window-mouseup')
    }

    const onWindowPointerCancel = (e: PointerEvent) => {
      if (!e.isPrimary) return
      disarmDragDemo('window-pointercancel')
      endShellWindowResize('window-pointercancel')
      endShellWindowMove('window-pointercancel')
    }

    const onWindowBlur = () => {
      disarmDragDemo('window-blur')
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
    }

    const onWindowTouchEnd = () => {
      disarmDragDemo('window-touchend')
      endShellWindowResize('window-touchend')
      endShellWindowMove('window-touchend')
    }

    const onWindowTouchMove = (e: TouchEvent) => {
      const t = e.changedTouches[0]
      if (!t) return
      if (dragDemoGrab) {
        applyDragDemoMove(t.clientX, t.clientY)
        e.preventDefault()
      }
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

    const hideContextMenu = () => {
      setCtxMenuOpen(false)
      shellContextMenuWire(false, 0, 0, 0, 0, 0, 0, 0, 0)
    }
    const onCtxKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideContextMenu()
    }
    const onCtxPointerDown = (e: PointerEvent) => {
      if (!ctxMenuOpen()) return
      const t = e.target
      if (t instanceof Element && t.closest('[data-shell-programs-toggle]')) return
      const p = menuPanelRef
      if (p && t instanceof Node && p.contains(t)) return
      hideContextMenu()
    }
    document.addEventListener('keydown', onCtxKeyDown)
    document.addEventListener('pointerdown', onCtxPointerDown, true)

    onCleanup(() => {
      document.removeEventListener('keydown', onCtxKeyDown)
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
    if (spawnPoll !== undefined) clearInterval(spawnPoll)
  })

  async function spawnInCompositor(cmd: string, emptyMessage = 'Empty command.') {
    const trimmed = cmd.trim()
    if (!trimmed) {
      setSpawnStatus(emptyMessage)
      return
    }
    if (shellWireSend('spawn', trimmed)) {
      setSpawnStatus(`Started: ${trimmed}`)
      return
    }
    const url = window.__DERP_SPAWN_URL
    if (!url) {
      setSpawnStatus('Not running under cef_host (no spawn URL / wire).')
      return
    }
    setSpawnBusy(true)
    setSpawnStatus(null)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: trimmed }),
      })
      const text = await res.text()
      if (!res.ok) {
        setSpawnStatus(`Spawn failed (${res.status}): ${text}`)
        return
      }
      setSpawnStatus(`Started: ${trimmed}`)
    } catch (e) {
      setSpawnStatus(`Network error: ${e}`)
    } finally {
      setSpawnBusy(false)
    }
  }

  async function runNativeInCompositor() {
    setSpawnClicks((c) => c + 1)
    await spawnInCompositor(spawnCommand(), 'Enter a command above (e.g. foot).')
  }

  async function refreshProgramsMenuItems() {
    const base = shellHttpBase()
    if (!base) {
      if (!ctxMenuOpen() || ctxMenuKind() !== 'programs') return
      setCtxMenuItems([{ label: 'Programs list needs cef_host (no shell HTTP).', action: () => {} }])
      return
    }
    try {
      const res = await fetch(`${base}/desktop_applications`)
      const text = await res.text()
      if (!ctxMenuOpen() || ctxMenuKind() !== 'programs') return
      if (!res.ok) {
        setCtxMenuItems([
          {
            label: `Failed to load (${res.status}): ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`,
            action: () => {},
          },
        ])
        return
      }
      const data = JSON.parse(text) as {
        apps?: Array<{ name: string; exec: string; terminal: boolean; desktop_id: string }>
      }
      const list = Array.isArray(data.apps) ? data.apps : []
      if (!ctxMenuOpen() || ctxMenuKind() !== 'programs') return
      if (list.length === 0) {
        setCtxMenuItems([{ label: 'No applications found.', action: () => {} }])
        return
      }
      setCtxMenuItems(
        list.map((app) => ({
          label: app.name,
          badge: app.terminal ? 'tty' : undefined,
          action: () => {
            void spawnInCompositor(app.exec)
          },
        })),
      )
    } catch (e) {
      if (!ctxMenuOpen() || ctxMenuKind() !== 'programs') return
      setCtxMenuItems([{ label: `Network error: ${e}`, action: () => {} }])
    }
  }

  function onProgramsMenuClick(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    e.preventDefault()
    if (ctxMenuOpen() && ctxMenuKind() === 'programs') {
      setCtxMenuOpen(false)
      return
    }
    const r = e.currentTarget.getBoundingClientRect()
    setCtxMenuAnchor({ x: r.left, y: r.bottom, alignAboveY: r.top })
    setCtxMenuKind('programs')
    setCtxMenuItems([{ label: 'Loading…', action: () => {} }])
    setCtxMenuOpen(true)
    void refreshProgramsMenuItems()
  }

  createEffect(() => {
    windowsList()
    workspacePartition()
    scheduleExclusionZonesSync()
  })

  createEffect(() => {
    if (!ctxMenuOpen()) {
      if (skipNextContextMenuHideWire) {
        skipNextContextMenuHideWire = false
        return
      }
      shellContextMenuWire(false, 0, 0, 0, 0, 0, 0, 0, 0)
      return
    }
    void ctxMenuItems().length
    void screenDraft.rows.length
    const anch = ctxMenuAnchor()
    const ax = anch.x
    const ay = anch.y
    const alignAboveY = anch.alignAboveY ?? null
    const rid = requestAnimationFrame(() => {
      const main = mainRef
      const atlas = menuAtlasHostRef
      const panel = menuPanelRef
      const og = outputGeom()
      const ph = outputPhysical()
      if (!main || !atlas || !panel || !og || !ph) return
      const mainRect = main.getBoundingClientRect()
      const wsBounds = logicalWorkspaceBoundsFromScreens(
        screenDraft.rows,
        layoutCanvasOrigin(),
        og.w,
        og.h,
        ph.h,
        contextMenuAtlasBufferH(),
      )
      const args = menuPlacementForCompositor(
        mainRect,
        atlas.getBoundingClientRect(),
        panel.getBoundingClientRect(),
        og.w,
        og.h,
        ph.w,
        ph.h,
        contextMenuAtlasBufferH(),
        ax,
        ay,
        alignAboveY,
        layoutCanvasOrigin(),
        wsBounds,
      )
      shellContextMenuWire(true, args.bx, args.by, args.bw, args.bh, args.gx, args.gy, args.gw, args.gh)
    })
    onCleanup(() => cancelAnimationFrame(rid))
  })

  return (
    <main
      classList={{
        'shell-root': true,
        'shell-root--crosshair': crosshairCursor(),
      }}
      style={{
        ...panelHueStyle(),
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
        setCtxMenuKind('demo')
        setCtxMenuItems([
          {
            label: 'Demo: log to console',
            action: () => {
              console.log('[derp-shell] context menu demo item')
            },
          },
        ])
        setCtxMenuAnchor({ x: e.clientX, y: e.clientY })
        setCtxMenuOpen(true)
      }}
    >
      <Index each={windowsList()}>
        {(win) => (
          <Show when={!win().minimized}>
            <ShellWindowFrame
              win={win()}
              stackZ={
                20 +
                win().window_id +
                (focusedWindowId() === win().window_id ? 10_000 : 0)
              }
              focused={focusedWindowId() === win().window_id}
              onTitlebarPointerDown={(cx, cy) => beginShellWindowMove(win().window_id, cx, cy)}
              onResizeEdgeDown={(edges, cx, cy) =>
                beginShellWindowResize(win().window_id, edges, cx, cy)
              }
              onMinimize={() => {
                shellWireSend('minimize', win().window_id)
              }}
              onMaximize={() => {
                const w = win()
                if (w.maximized) {
                  shellWireSend('set_maximized', w.window_id, 0)
                  return
                }
                const list = screensListForLayout(screenDraft.rows, outputGeom())
                const mon = pickScreenForWindowGlobal(w, list) ?? list[0] ?? null
                if (!mon) return
                const prim = workspacePartition().primary
                const reserveTb =
                  !!prim &&
                  mon.x === prim.x &&
                  mon.y === prim.y &&
                  mon.width === prim.width &&
                  mon.height === prim.height
                const r = shellMaximizedWorkAreaGlobalRect(mon, reserveTb)
                shellWireSend(
                  'set_geometry',
                  w.window_id,
                  r.x,
                  r.y,
                  r.w,
                  r.h,
                  SHELL_LAYOUT_MAXIMIZED,
                )
              }}
              onClose={() => {
                shellWireSend('close', win().window_id)
              }}
            />
          </Show>
        )}
      </Index>

      <For each={workspacePartition().secondary}>
        {(s) => (
          <div
            class="shell-monitor-alt"
            style={{
              left: `${s.x}px`,
              top: `${s.y}px`,
              width: `${s.width}px`,
              height: `${s.height}px`,
            }}
          >
            <span class="shell-monitor-alt__label">
              {s.name || 'Display'}
            </span>
          </div>
        )}
      </For>

      <Show when={workspacePartition().primary}>
        {(prim) => (
          <div
            class="shell-primary-chrome"
            style={{
              left: `${prim().x}px`,
              top: `${prim().y}px`,
              width: `${prim().width}px`,
              height: `${prim().height}px`,
            }}
          >
            <div class="shell-primary-chrome__fill">
              <div class="shell-panel" style={panelHueStyle()}>
                <h1 class="shell-title">derp shell</h1>
                <p class="shell-sub">SolidJS → CEF OSR → compositor</p>
                <label class="shell-crosshair-toggle">
                  <input
                    type="checkbox"
                    checked={crosshairCursor()}
                    onChange={(e) => setCrosshairCursor(e.currentTarget.checked)}
                  />
                  <span>Crosshair cursor</span>
                </label>
                <Show when={outputGeom()}>
                  {(g) => (
                    <p class="shell-output-geom">
                      {`OSR / compositor canvas (logical): `}
                      <strong>
                        {g().w}×{g().h}
                      </strong>
                    </p>
                  )}
                </Show>
                <div class="shell-input-hud" aria-live="polite">
                  <span class="shell-input-hud__label">input debug</span>
                  <span class="shell-input-hud__row">
                    <span>
                      Union from <code>screens[]</code>
                      {': '}
                    </span>
                    <strong>
                      {layoutUnionBbox()
                        ? `@ ${layoutUnionBbox()!.x},${layoutUnionBbox()!.y} (${layoutUnionBbox()!.w}×${layoutUnionBbox()!.h})`
                        : '—'}
                    </strong>
                  </span>
                  <span class="shell-input-hud__row">
                    <span>Compositor union min corner: </span>
                    <strong>
                      {layoutCanvasOrigin()
                        ? `@ ${layoutCanvasOrigin()!.x},${layoutCanvasOrigin()!.y}`
                        : '—'}
                    </strong>
                  </span>
                  <span class="shell-input-hud__row">
                    <span>Panel + taskbar host: </span>
                    <strong>
                      {panelHostForHud()
                        ? `${shellChromePrimaryName() ? `${shellChromePrimaryName()} (explicit) · ` : ''}${panelHostForHud()!.name || '—'} @ ${panelHostForHud()!.x},${panelHostForHud()!.y} (${panelHostForHud()!.width}×${panelHostForHud()!.height})`
                        : '—'}
                    </strong>
                  </span>
                  <span class="shell-input-hud__row">
                    {`Viewport (CSS): `}
                    <strong>
                      {viewportCss().w}×{viewportCss().h}
                    </strong>
                    {` · devicePixelRatio `}
                    <strong>{typeof window !== 'undefined' ? window.devicePixelRatio : 1}</strong>
                  </span>
                  <span class="shell-input-hud__row">
                    Windows (native): <strong>{windowsList().length}</strong>
                  </span>
                  <div class="shell-exclusion-zones-hud">
                    <span class="shell-input-hud__label">Exclusion zones (global logical)</span>
                    <Show
                      when={exclusionZonesHud().length > 0}
                      fallback={<span class="shell-input-hud__row shell-exclusion-zones-hud__empty">—</span>}
                    >
                      <ul class="shell-exclusion-zones-list">
                        <For each={exclusionZonesHud()}>
                          {(z) => (
                            <li class="shell-exclusion-zones-list__item">
                              <span class="shell-exclusion-zones-list__label">{z.label}</span>
                              <code class="shell-exclusion-zones-list__coords">
                                {z.x},{z.y} · {z.w}×{z.h}
                              </code>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </div>
                  <Show when={crosshairCursor()}>
                    <span class="shell-input-hud__row">
                      {`Pointer (clientX/Y): `}
                      <strong>
                        {pointerClient() ? `${pointerClient()!.x}, ${pointerClient()!.y}` : '—'}
                      </strong>
                    </span>
                    <span class="shell-input-hud__row">
                      {`Pointer (in <main>): `}
                      <strong>
                        {pointerInMain() ? `${pointerInMain()!.x}, ${pointerInMain()!.y}` : '—'}
                      </strong>
                    </span>
                  </Show>
                  <span class="shell-input-hud__row">
                    Pointer downs (anywhere): <strong>{rootPointerDowns()}</strong>
                  </span>
                  <span class="shell-input-hud__row">
                    Pointer downs (button): <strong>{btnPointerDowns()}</strong>
                  </span>
                  <span class="shell-input-hud__row">
                    Spawn clicks handled: <strong>{spawnClicks()}</strong>
                  </span>
                  <div class="shell-screens-panel">
                    <h2 class="shell-screens-title">Monitors</h2>
                    <div class="shell-chrome-host-row">
                      <span class="shell-chrome-host-label">Shell panel + taskbar</span>
                      <button
                        type="button"
                        class="shell-chrome-host-btn"
                        classList={{
                          'shell-chrome-host-btn--active': !shellChromePrimaryName(),
                        }}
                        disabled={!canSessionControl() || !shellChromePrimaryName()}
                        title={!canSessionControl() ? 'Needs cef_host wire' : 'Use top-left output (min x, then y)'}
                        onClick={() => shellWireSend('set_shell_primary', '')}
                      >
                        Auto
                      </button>
                    </div>
                    <div class="shell-ui-scale-row">
                      <span class="shell-ui-scale-label">UI scale (all heads)</span>
                      <button
                        type="button"
                        class="shell-ui-scale-btn"
                        classList={{ 'shell-ui-scale-btn--active': uiScalePercent() === 100 }}
                        disabled={!canSessionControl() || uiScalePercent() === 100}
                        title={!canSessionControl() ? 'Needs cef_host wire' : undefined}
                        onClick={() => {
                          shellWireSend('set_ui_scale', 100)
                        }}
                      >
                        100%
                      </button>
                      <button
                        type="button"
                        class="shell-ui-scale-btn"
                        classList={{ 'shell-ui-scale-btn--active': uiScalePercent() === 150 }}
                        disabled={!canSessionControl() || uiScalePercent() === 150}
                        title={!canSessionControl() ? 'Needs cef_host wire' : undefined}
                        onClick={() => {
                          shellWireSend('set_ui_scale', 150)
                        }}
                      >
                        150%
                      </button>
                    </div>
                    <ul class="shell-monitor-list">
                      <For
                        each={screenDraft.rows}
                        fallback={
                          <li class="shell-monitor-list__empty">
                            No outputs listed — compositor should send <code>output_layout</code> with one entry per
                            head.
                          </li>
                        }
                      >
                        {(row) => (
                          <li class="shell-monitor-list__item">
                            <div class="shell-monitor-list__row">
                              <div class="shell-monitor-list__text">
                                <span class="shell-monitor-list__name">{row.name || '—'}</span>
                                <span class="shell-monitor-list__meta">
                                  @ {row.x},{row.y} · {row.width}×{row.height} ·{' '}
                                  {monitorRefreshLabel(row.refresh_milli_hz)} · orientation {row.transform}
                                  {!shellChromePrimaryName() &&
                                  row.name &&
                                  row.name === autoShellChromeMonitorName() ? (
                                    <span class="shell-monitor-list__auto-badge"> · auto</span>
                                  ) : null}
                                </span>
                              </div>
                              <button
                                type="button"
                                class="shell-monitor-list__chrome-btn"
                                classList={{
                                  'shell-monitor-list__chrome-btn--active':
                                    !!shellChromePrimaryName() && shellChromePrimaryName() === row.name,
                                }}
                                disabled={!canSessionControl()}
                                title={!canSessionControl() ? 'Needs cef_host wire' : 'Show panel and taskbar on this head'}
                                onClick={() => shellWireSend('set_shell_primary', row.name)}
                              >
                                Shell chrome
                              </button>
                            </div>
                          </li>
                        )}
                      </For>
                    </ul>
                    <Show
                      when={screenDraft.rows.length > 0}
                      fallback={
                        <p class="shell-screens-hint shell-screens-hint--muted">
                          Position/orientation editor unlocks once screens are known.
                        </p>
                      }
                    >
                      <For each={screenDraft.rows}>
                        {(row, i) => (
                          <div class="shell-screen-row">
                            <span class="shell-screen-name">{row.name}</span>
                            <label class="shell-screen-field">
                              x
                              <input
                                type="number"
                                class="shell-screen-input"
                                value={row.x}
                                onInput={(e) =>
                                  setScreenDraft(
                                    'rows',
                                    i(),
                                    'x',
                                    Number(e.currentTarget.value) || 0,
                                  )
                                }
                              />
                            </label>
                            <label class="shell-screen-field">
                              y
                              <input
                                type="number"
                                class="shell-screen-input"
                                value={row.y}
                                onInput={(e) =>
                                  setScreenDraft(
                                    'rows',
                                    i(),
                                    'y',
                                    Number(e.currentTarget.value) || 0,
                                  )
                                }
                              />
                            </label>
                            <label class="shell-screen-field shell-screen-field--picker">
                              orientation
                              <TransformPicker
                                value={row.transform}
                                rowIndex={i()}
                                openIndex={orientationPickerOpen}
                                setOpenIndex={setOrientationPickerOpen}
                                onChange={(v) => setScreenDraft('rows', i(), 'transform', v)}
                              />
                            </label>
                            <span class="shell-screen-hint">
                              {row.width}×{row.height} · {monitorRefreshLabel(row.refresh_milli_hz)}
                            </span>
                          </div>
                        )}
                      </For>
                      <button
                        type="button"
                        class="shell-layout-apply-btn"
                        onClick={() => {
                          const screens = screenDraft.rows.map((r) => ({
                            name: r.name,
                            x: r.x,
                            y: r.y,
                            transform: r.transform,
                          }))
                          shellWireSend('set_output_layout', JSON.stringify({ screens }))
                        }}
                      >
                        Apply layout to compositor
                      </button>
                    </Show>
                  </div>
                </div>
                <p class="shell-spawn-url">{spawnUrlLine()}</p>
                <label class="shell-cmd-label">
                  <span class="shell-cmd-label__text">Command (`sh -c`, nested Wayland display)</span>
                  <input
                    class="shell-cmd-input"
                    type="text"
                    value={spawnCommand()}
                    onInput={(e) => setSpawnCommand(e.currentTarget.value)}
                    autocomplete="off"
                    spellcheck={false}
                  />
                </label>
                <button
                  type="button"
                  class="shell-spawn-btn"
                  disabled={spawnBusy()}
                  onPointerDown={() => setBtnPointerDowns((n) => n + 1)}
                  onClick={() => void runNativeInCompositor()}
                >
                  {spawnBusy() ? 'Spawning…' : 'Run native app in compositor'}
                </button>
                <button
                  type="button"
                  class="shell-exit-session-btn"
                  disabled={!canSessionControl()}
                  title={
                    canSessionControl()
                      ? 'Tell compositor to exit (ends session)'
                      : 'Needs cef_host control server'
                  }
                  onClick={() => {
                    if (!shellWireSend('quit')) void postShell('/session_quit', {})
                  }}
                >
                  Exit session
                </button>
                {spawnStatus() ? <p class="shell-spawn-status">{spawnStatus()}</p> : null}
              </div>
            </div>

            <Taskbar
              programsMenuOpen={programsMenuOpen()}
              onProgramsMenuClick={onProgramsMenuClick}
              windows={taskbarWindows()}
              focusedWindowId={focusedWindowId()}
              onTaskbarActivate={(id) => {
                shellWireSend('taskbar_activate', id)
              }}
            />

            <div
              class="shell-drag-demo"
              style={{
                left: `${dragDemoPos().x}px`,
                top: `${dragDemoPos().y}px`,
              }}
              onPointerDown={(e) => {
                if (!e.isPrimary) return
                if (e.button !== 0) return
                e.preventDefault()
                e.stopPropagation()
                armDragDemo(e.clientX, e.clientY)
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return
                e.preventDefault()
                e.stopPropagation()
                armDragDemo(e.clientX, e.clientY)
              }}
              onTouchStart={(e) => {
                const t = e.changedTouches[0]
                if (!t) return
                e.preventDefault()
                e.stopPropagation()
                armDragDemo(t.clientX, t.clientY)
              }}
              onPointerUp={(e) => {
                if (!e.isPrimary) return
                disarmDragDemo('demo-pointerup')
              }}
              onMouseUp={(e) => {
                if (e.button !== 0) return
                disarmDragDemo('demo-mouseup')
              }}
            >
              Drag me (DOM only)
            </div>
          </div>
        )}
      </Show>

      <div
        class="shell-menu-atlas"
        ref={(el) => {
          menuAtlasHostRef = el
        }}
        style={{
          position: 'absolute',
          left: '0',
          right: '0',
          top: `${shellMenuAtlasTop()}px`,
          bottom: '0',
          overflow: 'hidden',
          'pointer-events': ctxMenuOpen() ? 'auto' : 'none',
          'z-index': '90000',
        }}
      >
        <Show when={ctxMenuOpen()}>
          <div
            class="shell-context-menu-panel"
            role="menu"
            aria-label={ctxMenuKind() === 'programs' ? 'Applications' : 'Menu'}
            ref={(el) => {
              menuPanelRef = el
            }}
          >
            <For each={ctxMenuItems()}>
              {(item) => (
                <button
                  type="button"
                  class="shell-context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    item.action()
                    setCtxMenuOpen(false)
                  }}
                >
                  <span class="shell-context-menu-item__label">{item.label}</span>
                  <Show when={item.badge}>
                    {(b) => <span class="shell-context-menu-item__badge">{b()}</span>}
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="shell-debug-overlay" style={panelHueStyle()} aria-hidden="true">
        <Show when={crosshairCursor()}>
          <div class="shell-ruler-corner" />
          <div
            class="shell-ruler shell-ruler--top"
            style={{ width: `${Math.max(0, viewportCss().w - RULER_GUTTER_X)}px` }}
          >
            <div class="shell-ruler__ticks shell-ruler__ticks--h" />
            <For each={horizontalRulerTicks()}>
              {(x) => (
                <span
                  class="shell-ruler__label shell-ruler__label--h"
                  style={{ left: `${x - RULER_GUTTER_X}px` }}
                >
                  {x}
                </span>
              )}
            </For>
          </div>
          <div
            class="shell-ruler shell-ruler--left"
            style={{ height: `${Math.max(0, viewportCss().h - RULER_GUTTER_Y)}px` }}
          >
            <div class="shell-ruler__ticks shell-ruler__ticks--v" />
            <For each={verticalRulerTicks()}>
              {(y) => (
                <span
                  class="shell-ruler__label shell-ruler__label--v"
                  style={{ top: `${y - RULER_GUTTER_Y}px` }}
                >
                  {y}
                </span>
              )}
            </For>
          </div>
        </Show>
        {crosshairDebugOverlay()}
      </div>
    </main>
  )
}

export default App
