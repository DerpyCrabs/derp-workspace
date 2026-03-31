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
    <div
      class="pointer-events-auto absolute bottom-0 left-0 right-0 z-[50000] box-border flex h-11 items-center border-t border-white/18 bg-[hsla(210,28%,14%,0.94)] px-2.5 shadow-[0_-4px_20px_rgba(0,0,0,0.35)]"
      data-shell-taskbar
    >
      <button
        type="button"
        class="cursor-pointer rounded-md border border-white/35 bg-shell-btn-primary py-1.5 px-[0.9rem] text-sm font-semibold tracking-wide text-neutral-900 hover:brightness-[1.06]"
        data-shell-programs-toggle
        aria-expanded={props.programsMenuOpen}
        aria-haspopup="menu"
        onClick={(e) => props.onProgramsMenuClick(e)}
      >
        Programs
      </button>

      <div class="ml-2.5 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden" role="list" aria-label="Windows">
        <For each={props.windows}>
          {(w) => (
            <button
              type="button"
              role="listitem"
              class="max-w-[11rem] flex-[0_1_auto] cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap rounded-[0.35rem] border border-white/12 bg-[hsla(210,18%,22%,0.95)] px-[0.65rem] py-[0.35rem] text-[0.82rem] font-medium text-neutral-200 hover:brightness-[1.12]"
              classList={{
                'border-white/35 bg-shell-taskbar-focused text-neutral-900':
                  props.focusedWindowId === w.window_id && !w.minimized,
                'opacity-55':
                  w.minimized && !(props.focusedWindowId === w.window_id && !w.minimized),
              }}
              title={[w.title || w.app_id || `window ${w.window_id}`, w.minimized ? '(minimized)' : '']
                .filter(Boolean)
                .join(' ')}
              onClick={() => props.onTaskbarActivate(w.window_id)}
            >
              <span class="block overflow-hidden text-ellipsis">
                {w.title || w.app_id || `Window ${w.window_id}`}
              </span>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
