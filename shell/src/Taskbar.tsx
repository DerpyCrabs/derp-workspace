import { For } from 'solid-js'

export type TaskbarWindowRow = {
  window_id: number
  title: string
  app_id: string
  minimized: boolean
}

export type TaskbarProps = {
  programsMenuOpen: boolean
  onProgramsMenuClick: (e: MouseEvent & { currentTarget: HTMLButtonElement }) => void
  windows: TaskbarWindowRow[]
  focusedWindowId: number | null
  onTaskbarActivate: (windowId: number) => void
}

export function Taskbar(props: TaskbarProps) {
  return (
    <div class="shell-taskbar">
      <button
        type="button"
        class="shell-taskbar__programs"
        data-shell-programs-toggle
        aria-expanded={props.programsMenuOpen}
        aria-haspopup="menu"
        onClick={(e) => props.onProgramsMenuClick(e)}
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
    </div>
  )
}
