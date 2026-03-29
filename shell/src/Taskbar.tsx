import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'

type DesktopAppRow = {
  name: string
  exec: string
  icon?: string | null
  terminal: boolean
  desktop_id: string
}

function shellHttpBase(): string | null {
  const u = window.__DERP_SHELL_HTTP
  if (u && u.startsWith('http://127.0.0.1:')) return u.replace(/\/$/, '')
  return null
}

export type TaskbarWindowRow = {
  window_id: number
  title: string
  app_id: string
  minimized: boolean
}

export type TaskbarProps = {
  /** Launch a command in the compositor (same semantics as the spawn panel). */
  onLaunch: (exec: string) => void | Promise<void>
  windows: TaskbarWindowRow[]
  focusedWindowId: number | null
  onTaskbarActivate: (windowId: number) => void
}

export function Taskbar(props: TaskbarProps) {
  const [open, setOpen] = createSignal(false)
  const [apps, setApps] = createSignal<DesktopAppRow[]>([])
  const [loading, setLoading] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  let rootRef: HTMLDivElement | undefined

  async function loadAppsIfNeeded() {
    if (apps().length > 0 || loading()) return
    const base = shellHttpBase()
    if (!base) {
      setLoadError('Programs list needs cef_host (no shell HTTP).')
      return
    }
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`${base}/desktop_applications`)
      const text = await res.text()
      if (!res.ok) {
        setLoadError(`Failed to load (${res.status}): ${text}`)
        return
      }
      const data = JSON.parse(text) as { apps?: DesktopAppRow[] }
      const list = Array.isArray(data.apps) ? data.apps : []
      setApps(list)
    } catch (e) {
      setLoadError(`Network error: ${e}`)
    } finally {
      setLoading(false)
    }
  }

  function toggleMenu() {
    const next = !open()
    setOpen(next)
    if (next) void loadAppsIfNeeded()
  }

  onMount(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      if (!open()) return
      const t = e.target as Node | null
      if (!t) return
      if (rootRef && !rootRef.contains(t)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDocPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      document.removeEventListener('pointerdown', onDocPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    })
  })

  return (
    <div
      class="shell-taskbar"
      ref={(el) => {
        rootRef = el
      }}
    >
      <button
        type="button"
        class="shell-taskbar__programs"
        aria-expanded={open()}
        aria-haspopup="menu"
        onClick={() => toggleMenu()}
      >
        Programs
      </button>

      <div class="shell-taskbar__windows" role="list" aria-label="Windows">
        <For each={props.windows}>
          {(w) => (
            <button
              type="button"
              role="listitem"
              class="shell-taskbar__win"
              classList={{
                'shell-taskbar__win--focused':
                  props.focusedWindowId === w.window_id && !w.minimized,
                'shell-taskbar__win--minimized': w.minimized,
              }}
              title={[w.title || w.app_id || `window ${w.window_id}`, w.minimized ? '(minimized)' : '']
                .filter(Boolean)
                .join(' ')}
              onClick={() => props.onTaskbarActivate(w.window_id)}
            >
              <span class="shell-taskbar__win-label">
                {w.title || w.app_id || `Window ${w.window_id}`}
              </span>
            </button>
          )}
        </For>
      </div>

      <Show when={open()}>
        <div class="shell-programs-menu" role="menu" aria-label="Applications">
          <Show when={loadError()}>
            {(msg) => <p class="shell-programs-menu__error">{msg()}</p>}
          </Show>
          <Show when={loading() && !loadError()}>
            <p class="shell-programs-menu__loading">Loading…</p>
          </Show>
          <Show when={!loading() && !loadError() && apps().length === 0 && shellHttpBase()}>
            <p class="shell-programs-menu__empty">No applications found.</p>
          </Show>
          <Show when={!loadError()}>
            <ul class="shell-programs-menu__list">
              <For each={apps()}>
                {(app) => (
                  <li class="shell-programs-menu__item" role="none">
                    <button
                      type="button"
                      class="shell-programs-menu__entry"
                      role="menuitem"
                      title={[app.desktop_id, app.terminal ? '(terminal)' : ''].filter(Boolean).join(' ')}
                      onClick={() => {
                        setOpen(false)
                        void props.onLaunch(app.exec)
                      }}
                    >
                      <span class="shell-programs-menu__name">{app.name}</span>
                      <Show when={app.terminal}>
                        <span class="shell-programs-menu__badge">tty</span>
                      </Show>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </div>
  )
}
