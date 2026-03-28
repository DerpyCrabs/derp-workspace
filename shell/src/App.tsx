import { createMemo, createSignal, onCleanup, onMount, For } from 'solid-js'
import './App.css'

declare global {
  interface Window {
    /** Injected by `cef_host` after load (`http://127.0.0.1:…/spawn`). */
    __DERP_SPAWN_URL?: string
  }
}

/** Top / left ruler insets — must match `.shell-ruler--top` / `.shell-ruler--left` in `App.css`. */
const RULER_GUTTER_X = 28
const RULER_GUTTER_Y = 22

function App() {
  const [hue, setHue] = createSignal(210)
  const [spawnStatus, setSpawnStatus] = createSignal<string | null>(null)
  const [spawnBusy, setSpawnBusy] = createSignal(false)
  const [rootPointerDowns, setRootPointerDowns] = createSignal(0)
  const [btnPointerDowns, setBtnPointerDowns] = createSignal(0)
  const [spawnClicks, setSpawnClicks] = createSignal(0)
  const [spawnUrlLine, setSpawnUrlLine] = createSignal('')
  /// Command passed to compositor `sh -c` (no `window.prompt` — windowless CEF cannot show dialogs).
  const [spawnCommand, setSpawnCommand] = createSignal('foot')

  /** Last position the engine delivered (`clientX` / `clientY`) — compare to the OS cursor. */
  const [pointerClient, setPointerClient] = createSignal<{ x: number; y: number } | null>(null)
  /** Same pointer, relative to `<main class="shell-root">` (content box). */
  const [pointerInMain, setPointerInMain] = createSignal<{ x: number; y: number } | null>(null)
  const [viewportCss, setViewportCss] = createSignal({ w: 0, h: 0 })

  const rulerStepPx = 100

  /** Viewport X values drawn on the top ruler (that strip starts at clientX = RULER_GUTTER_X). */
  const horizontalRulerTicks = createMemo(() => {
    const w = viewportCss().w
    if (w <= 0) return [] as number[]
    const out: number[] = []
    for (let x = 0; x <= w; x += rulerStepPx) {
      if (x >= RULER_GUTTER_X) out.push(x)
    }
    return out
  })

  /** Viewport Y values drawn on the left ruler (that strip starts at clientY = RULER_GUTTER_Y). */
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

  return (
    <main
      class="shell-root"
      ref={(el) => {
        mainRef = el
      }}
      style={{ '--shell-hue': `${hue()}` }}
      onPointerDown={() => setRootPointerDowns((n) => n + 1)}
    >
      <div class="shell-panel">
        <h1 class="shell-title">derp shell</h1>
        <p class="shell-sub">SolidJS → CEF OSR → compositor</p>
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
