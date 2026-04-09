import { For, Show } from 'solid-js'

export type TaskbarWindowRow = {
  window_id: number
  title: string
  app_id: string
  minimized: boolean
  output_name: string
}

export type TaskbarProps = {
  monitorName: string
  isPrimary: boolean
  programsMenuOpen: boolean
  onProgramsMenuClick: (e: MouseEvent & { currentTarget: HTMLButtonElement }) => void
  powerMenuOpen: boolean
  onPowerMenuClick: (e: MouseEvent & { currentTarget: HTMLButtonElement }) => void
  windows: TaskbarWindowRow[]
  focusedWindowId: number | null
  keyboardLayoutLabel: string | null
  settingsPanelOpen: boolean
  onSettingsPanelToggle: () => void
  debugPanelOpen: boolean
  onDebugPanelToggle: () => void
  onTaskbarActivate: (windowId: number) => void
}

export function Taskbar(props: TaskbarProps) {
  return (
    <div
      class="pointer-events-auto absolute bottom-0 left-0 right-0 z-[50000] box-border flex h-11 items-center border-t border-slate-600 bg-slate-900 px-2.5 shadow-[0_-4px_20px_rgba(0,0,0,0.35)]"
      data-shell-taskbar
      data-shell-taskbar-monitor={props.monitorName}
    >
      <Show when={props.isPrimary}>
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
      </Show>

      <div
        class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden"
        classList={{ 'ml-2.5': props.isPrimary }}
        role="list"
        aria-label="Windows"
      >
        <For each={props.windows}>
          {(w) => (
            <button
              type="button"
              role="listitem"
              class="max-w-[11rem] flex-[0_1_auto] cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap rounded-[0.35rem] border border-slate-600 bg-slate-800 px-[0.65rem] py-[0.35rem] text-[0.82rem] font-medium text-neutral-200 hover:brightness-[1.12]"
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

      <Show when={props.isPrimary}>
        <div class="ml-auto flex shrink-0 items-center gap-2.5">
          <Show when={props.keyboardLayoutLabel}>
            <span
              class="min-w-[2rem] shrink-0 rounded-[0.35rem] border border-slate-600 bg-slate-800 px-[0.5rem] py-[0.35rem] text-center text-[0.75rem] font-semibold tabular-nums tracking-wide text-neutral-200"
              title="Keyboard layout"
            >
              {props.keyboardLayoutLabel!}
            </span>
          </Show>
          <button
            type="button"
            class="cursor-pointer rounded-[0.35rem] border border-slate-600 bg-slate-800 px-[0.65rem] py-[0.35rem] text-[0.82rem] font-medium text-neutral-200 hover:brightness-[1.12]"
            classList={{
              'border-white/35 bg-shell-taskbar-focused text-neutral-900': props.settingsPanelOpen,
            }}
            data-shell-settings-toggle
            aria-pressed={props.settingsPanelOpen}
            title={props.settingsPanelOpen ? 'Hide settings' : 'Settings'}
            onClick={() => props.onSettingsPanelToggle()}
          >
            Settings
          </button>
          <button
            type="button"
            class="cursor-pointer rounded-[0.35rem] border border-slate-600 bg-slate-800 px-[0.65rem] py-[0.35rem] text-[0.82rem] font-medium text-neutral-200 hover:brightness-[1.12]"
            classList={{
              'border-white/35 bg-shell-taskbar-focused text-neutral-900': props.debugPanelOpen,
            }}
            aria-pressed={props.debugPanelOpen}
            title={props.debugPanelOpen ? 'Hide debug panel' : 'Show debug panel'}
            onClick={() => props.onDebugPanelToggle()}
          >
            Debug
          </button>
          <button
            type="button"
            class="cursor-pointer rounded-[0.35rem] border border-slate-600 bg-slate-800 px-[0.65rem] py-[0.35rem] text-[0.82rem] font-medium text-neutral-200 hover:brightness-[1.12]"
            classList={{
              'border-white/35 bg-shell-taskbar-focused text-neutral-900': props.powerMenuOpen,
            }}
            data-shell-power-toggle
            aria-expanded={props.powerMenuOpen}
            aria-haspopup="menu"
            title="Power"
            onClick={(e) => props.onPowerMenuClick(e)}
          >
            Power
          </button>
        </div>
      </Show>
    </div>
  )
}
