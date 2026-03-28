import { createMemo, createSignal, onCleanup, onMount, For, Show } from 'solid-js'
import './App.css'

/** Keep in sync with compositor `SHELL_TITLEBAR_HEIGHT` / `SHELL_BORDER_THICKNESS`. */
export const CHROME_TITLEBAR_PX = 28
export const CHROME_BORDER_PX = 4

declare global {
  interface Window {
    /** Injected by `cef_host` after load (`http://127.0.0.1:…/spawn`). */
    __DERP_SPAWN_URL?: string
    __DERP_SHELL_HTTP?: string
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

type DerpWindow = {
  window_id: number
  surface_id: number
  x: number
  y: number
  width: number
  height: number
  title: string
  app_id: string
}

function applyDetail(map: Map<number, DerpWindow>, detail: DerpShellDetail): Map<number, DerpWindow> {
  const next = new Map(map)
  switch (detail.type) {
    case 'window_mapped': {
      next.set(detail.window_id, {
        window_id: detail.window_id,
        surface_id: detail.surface_id,
        x: detail.x,
        y: detail.y,
        width: detail.width,
        height: detail.height,
        title: detail.title,
        app_id: detail.app_id,
      })
      break
    }
    case 'window_unmapped':
      next.delete(detail.window_id)
      break
    case 'window_geometry': {
      const w = next.get(detail.window_id)
      if (w) {
        next.set(detail.window_id, {
          ...w,
          x: detail.x,
          y: detail.y,
          width: detail.width,
          height: detail.height,
        })
      }
      break
    }
    case 'window_metadata': {
      const w = next.get(detail.window_id)
      if (w) {
        next.set(detail.window_id, { ...w, title: detail.title, app_id: detail.app_id })
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

function App() {
  const [hue, setHue] = createSignal(210)
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

  const windowsList = createMemo(() => Array.from(windows().values()))

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

  let timer: ReturnType<typeof setInterval> | undefined
  let spawnPoll: ReturnType<typeof setInterval> | undefined
  let mainRef: HTMLElement | undefined

  let moveDrag: { windowId: number; lastX: number; lastY: number } | null = null

  const endWindowMove = (windowId: number) => {
    moveDrag = null
    void postShell('/window_move_end', { window_id: windowId })
  }

  const onTitlebarPointerDown = (e: PointerEvent, windowId: number) => {
    e.stopPropagation()
    const base = shellHttpBase()
    if (!base) return
    moveDrag = { windowId, lastX: e.clientX, lastY: e.clientY }
    void postShell('/window_move_begin', { window_id: windowId })
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onTitlebarPointerMove = (e: PointerEvent) => {
    const st = moveDrag
    if (!st) return
    const dx = e.clientX - st.lastX
    const dy = e.clientY - st.lastY
    st.lastX = e.clientX
    st.lastY = e.clientY
    if (dx !== 0 || dy !== 0) {
      void postShell('/window_move_delta', { dx, dy })
    }
  }

  const onTitlebarPointerUp = (e: PointerEvent, windowId: number) => {
    if (moveDrag?.windowId === windowId) {
      try {
        ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      endWindowMove(windowId)
    }
  }

  onMount(() => {
    timer = setInterval(() => {
      setHue((h) => (h + 1) % 360)
    }, 48)
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
        setFocusedWindowId(d.window_id ?? null)
        return
      }
      if (d.type === 'output_geometry') {
        setOutputGeom({ w: d.logical_width, h: d.logical_height })
        return
      }
      setWindows((m) => applyDetail(m, d))
    }
    window.addEventListener('derp-shell', onDerpShell as EventListener)

    const syncViewport = () =>
      setViewportCss({ w: window.innerWidth, h: window.innerHeight })
    syncViewport()

    const onPointerMove = (e: PointerEvent) => {
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

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('resize', syncViewport, { passive: true })

    onCleanup(() => {
      window.removeEventListener('derp-shell', onDerpShell as EventListener)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('resize', syncViewport)
    })
  })
  onCleanup(() => {
    if (timer !== undefined) clearInterval(timer)
    if (spawnPoll !== undefined) clearInterval(spawnPoll)
  })

  async function runNativeInCompositor() {
    setSpawnClicks((c) => c + 1)
    const url = window.__DERP_SPAWN_URL
    if (!url) {
      setSpawnStatus('Not running under cef_host (no spawn URL).')
      return
    }
    const cmd = spawnCommand().trim()
    if (!cmd) {
      setSpawnStatus('Enter a command above (e.g. foot).')
      return
    }
    setSpawnBusy(true)
    setSpawnStatus(null)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      })
      const text = await res.text()
      if (!res.ok) {
        setSpawnStatus(`Spawn failed (${res.status}): ${text}`)
        return
      }
      setSpawnStatus(`Started: ${cmd}`)
    } catch (e) {
      setSpawnStatus(`Network error: ${e}`)
    } finally {
      setSpawnBusy(false)
    }
  }

  const th = CHROME_TITLEBAR_PX
  const bd = CHROME_BORDER_PX

  return (
    <main
      class="shell-root"
      ref={(el) => {
        mainRef = el
      }}
      style={{ '--shell-hue': `${hue()}` }}
      onPointerDown={() => setRootPointerDowns((n) => n + 1)}
    >
      <For each={windowsList()}>
        {(win) => {
          const focused = () => focusedWindowId() === win.window_id
          const x = win.x
          const y = win.y
          const w = win.width
          const h = win.height
          return (
            <div
              class="shell-window-chrome"
              classList={{ 'shell-window-chrome--focused': focused() }}
              style={{
                position: 'fixed',
                left: `${x - bd}px`,
                top: `${y - th - bd}px`,
                width: `${w + bd * 2}px`,
                height: `${h + th + bd * 2}px`,
                'box-sizing': 'border-box',
                'pointer-events': 'none',
              }}
            >
              <div
                class="shell-titlebar"
                style={{
                  position: 'absolute',
                  left: `${bd}px`,
                  top: `${bd}px`,
                  width: `${w}px`,
                  height: `${th}px`,
                  'pointer-events': 'auto',
                }}
                onPointerDown={(e) => onTitlebarPointerDown(e, win.window_id)}
                onPointerMove={onTitlebarPointerMove}
                onPointerUp={(e) => onTitlebarPointerUp(e, win.window_id)}
                onPointerCancel={(e) => onTitlebarPointerUp(e, win.window_id)}
              >
                <span class="shell-titlebar__text">{win.title || win.app_id || `window ${win.window_id}`}</span>
              </div>
              <div
                class="shell-border shell-border--left"
                style={{
                  position: 'absolute',
                  left: '0',
                  top: `${bd + th}px`,
                  width: `${bd}px`,
                  height: `${h}px`,
                }}
              />
              <div
                class="shell-border shell-border--right"
                style={{
                  position: 'absolute',
                  left: `${bd + w}px`,
                  top: `${bd + th}px`,
                  width: `${bd}px`,
                  height: `${h}px`,
                }}
              />
              <div
                class="shell-border shell-border--bottom"
                style={{
                  position: 'absolute',
                  left: '0',
                  top: `${bd + th + h}px`,
                  width: `${w + bd * 2}px`,
                  height: `${bd}px`,
                }}
              />
            </div>
          )
        }}
      </For>

      <div class="shell-panel">
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
          disabled={!shellHttpBase()}
          title={shellHttpBase() ? 'Tell compositor to exit (ends session)' : 'Needs cef_host control server'}
          onClick={() => void postShell('/session_quit', {})}
        >
          Exit session
        </button>
        {spawnStatus() ? <p class="shell-spawn-status">{spawnStatus()}</p> : null}
      </div>

      <div class="shell-debug-overlay" aria-hidden="true">
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
    </main>
  )
}

export default App
