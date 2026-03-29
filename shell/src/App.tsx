import {
  batch,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  For,
  Index,
  Show,
} from 'solid-js'
import './App.css'
import { ShellWindowFrame } from './ShellWindowFrame'
import { Taskbar } from './Taskbar'

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
        | 'minimize',
      arg?: number | string,
      arg2?: number,
    ) => void
  }
}

type DerpShellDetail =
  | { type: 'output_geometry'; logical_width: number; logical_height: number }
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
    | 'minimize',
  arg?: number | string,
  arg2?: number,
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
  } else if (op === 'quit') {
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
  const [viewportCss, setViewportCss] = createSignal({ w: 0, h: 0 })
  const [windows, setWindows] = createSignal<Map<number, DerpWindow>>(new Map())
  const [focusedWindowId, setFocusedWindowId] = createSignal<number | null>(null)
  const [outputGeom, setOutputGeom] = createSignal<{ w: number; h: number } | null>(null)

  const rulerStepPx = 100

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

  let spawnPoll: ReturnType<typeof setInterval> | undefined
  let mainRef: HTMLElement | undefined

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
    shellWindowDrag = { windowId, lastX: clientX, lastY: clientY }
    shellMoveLog('titlebar_begin_armed', { windowId, clientX, clientY })
  }

  /** Match titlebar to pointer in view space; `window_geometry` still overwrites when it lands (compositor truth). */
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
    const dx = Math.round(clientX - shellWindowDrag.lastX)
    const dy = Math.round(clientY - shellWindowDrag.lastY)
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
    shellWindowDrag.lastX = clientX
    shellWindowDrag.lastY = clientY
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
    shellWindowResize = { windowId, lastX: clientX, lastY: clientY }
    shellMoveLog('resize_begin', { windowId, edges, clientX, clientY })
  }

  function applyShellWindowResize(clientX: number, clientY: number) {
    if (!shellWindowResize) return
    const dx = Math.round(clientX - shellWindowResize.lastX)
    const dy = Math.round(clientY - shellWindowResize.lastY)
    if (dx === 0 && dy === 0) return
    shellResizeDeltaLogSeq += 1
    if (shellResizeDeltaLogSeq <= 12 || shellResizeDeltaLogSeq % 30 === 0) {
      shellMoveLog('resize_delta', { seq: shellResizeDeltaLogSeq, dx, dy, clientX, clientY })
    }
    shellWireSend('resize_delta', dx, dy)
    shellWindowResize.lastX = clientX
    shellWindowResize.lastY = clientY
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
      if (d.type === 'focus_changed') {
        const fw = coerceShellWindowId(d.window_id)
        setFocusedWindowId((prev) => (prev === fw ? prev : fw))
        return
      }
      if (d.type === 'output_geometry') {
        setOutputGeom({ w: d.logical_width, h: d.logical_height })
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
    window.addEventListener('resize', syncViewport, { passive: true })

    onCleanup(() => {
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
      window.removeEventListener('resize', syncViewport)
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

  return (
    <main
      class="shell-root"
      style={panelHueStyle()}
      ref={(el) => {
        mainRef = el
      }}
      onPointerDown={() => setRootPointerDowns((n) => n + 1)}
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
              onClose={() => {
                shellWireSend('close', win().window_id)
              }}
            />
          </Show>
        )}
      </Index>

      <div class="shell-panel" style={panelHueStyle()}>
        <h1 class="shell-title">derp shell</h1>
        <p class="shell-sub">SolidJS → CEF OSR → compositor</p>
        <Show when={outputGeom()}>
          {(g) => (
            <p class="shell-output-geom">
              Compositor output (logical):{' '}
              <strong>
                {g().w}×{g().h}
              </strong>
            </p>
          )}
        </Show>
        <p class="shell-input-hud" aria-live="polite">
          <span class="shell-input-hud__label">input debug</span>
          <span class="shell-input-hud__row">
            Viewport (CSS):{' '}
            <strong>
              {viewportCss().w}×{viewportCss().h}
            </strong>{' '}
            · devicePixelRatio <strong>{typeof window !== 'undefined' ? window.devicePixelRatio : 1}</strong>
          </span>
          <span class="shell-input-hud__row">
            Windows (native): <strong>{windowsList().length}</strong>
          </span>
          <span class="shell-input-hud__row">
            Pointer (clientX/Y):{' '}
            <strong>{pointerClient() ? `${pointerClient()!.x}, ${pointerClient()!.y}` : '—'}</strong>
          </span>
          <span class="shell-input-hud__row">
            Pointer (in &lt;main&gt;):{' '}
            <strong>
              {pointerInMain() ? `${pointerInMain()!.x}, ${pointerInMain()!.y}` : '—'}
            </strong>
          </span>
          <span class="shell-input-hud__row">
            Pointer downs (anywhere): <strong>{rootPointerDowns()}</strong>
          </span>
          <span class="shell-input-hud__row">
            Pointer downs (button): <strong>{btnPointerDowns()}</strong>
          </span>
          <span class="shell-input-hud__row">
            Spawn clicks handled: <strong>{spawnClicks()}</strong>
          </span>
        </p>
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

      <div class="shell-debug-overlay" style={panelHueStyle()} aria-hidden="true">
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
        {(() => {
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
        })()}
      </div>

      <Taskbar
        onLaunch={(exec) => void spawnInCompositor(exec)}
        windows={taskbarWindows()}
        focusedWindowId={focusedWindowId()}
        onTaskbarActivate={(id) => {
          shellWireSend('taskbar_activate', id)
        }}
      />
    </main>
  )
}

export default App
