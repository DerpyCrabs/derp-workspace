import AppWindow from 'lucide-solid/icons/app-window'
import Bug from 'lucide-solid/icons/bug'
import FileText from 'lucide-solid/icons/file-text'
import FolderOpen from 'lucide-solid/icons/folder-open'
import Globe from 'lucide-solid/icons/globe'
import LayoutGrid from 'lucide-solid/icons/layout-grid'
import Monitor from 'lucide-solid/icons/monitor'
import Power from 'lucide-solid/icons/power'
import Settings from 'lucide-solid/icons/settings'
import SquareTerminal from 'lucide-solid/icons/square-terminal'
import X from 'lucide-solid/icons/x'
import { For, Show, createSignal, onCleanup, type Component } from 'solid-js'

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
  onTaskbarClose: (windowId: number) => void
}

const clockTimeFormatter = new Intl.DateTimeFormat([], {
  hour: 'numeric',
  minute: '2-digit',
})

const clockDateFormatter = new Intl.DateTimeFormat([], {
  month: 'short',
  day: 'numeric',
})

function windowLabel(w: TaskbarWindowRow) {
  return w.title || w.app_id || `Window ${w.window_id}`
}

function keyboardIndicator(label: string) {
  const compact = label.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return compact.slice(0, 3) || label.trim().toUpperCase().slice(0, 3)
}

function windowIconFor(w: TaskbarWindowRow): Component<{ class?: string; 'stroke-width'?: number }> {
  const key = `${w.app_id} ${w.title}`.toLowerCase()
  if (
    key.includes('firefox') ||
    key.includes('chrome') ||
    key.includes('chromium') ||
    key.includes('zen') ||
    key.includes('browser')
  ) {
    return Globe
  }
  if (
    key.includes('kitty') ||
    key.includes('wezterm') ||
    key.includes('alacritty') ||
    key.includes('gnome-terminal') ||
    key.includes('terminal')
  ) {
    return SquareTerminal
  }
  if (
    key.includes('thunar') ||
    key.includes('nautilus') ||
    key.includes('dolphin') ||
    key.includes('pcmanfm') ||
    key.includes('files')
  ) {
    return FolderOpen
  }
  if (key.includes('settings') || key.includes('control center')) {
    return Settings
  }
  if (key.includes('.md') || key.includes('.txt') || key.includes('notes')) {
    return FileText
  }
  if (key.includes('display') || key.includes('monitor')) {
    return Monitor
  }
  if (key.includes('window') || key.includes('app')) {
    return AppWindow
  }
  return AppWindow
}

export function Taskbar(props: TaskbarProps) {
  const [now, setNow] = createSignal(new Date())

  if (props.isPrimary) {
    const interval = window.setInterval(() => setNow(new Date()), 15000)
    onCleanup(() => window.clearInterval(interval))
  }

  return (
    <div
      class="pointer-events-auto absolute bottom-0 left-0 right-0 z-50000 box-border flex h-11 items-stretch overflow-hidden border-t border-(--shell-border) bg-(--shell-taskbar-bg-solid) px-1 text-(--shell-text)"
      data-shell-taskbar
      data-shell-taskbar-monitor={props.monitorName}
    >
      <Show when={props.isPrimary}>
        <button
          type="button"
          class="shell-taskbar-action mr-1 shrink-0 cursor-pointer"
          data-shell-programs-toggle
          aria-expanded={props.programsMenuOpen}
          aria-haspopup="menu"
          aria-label="Open programs"
          title="Programs"
          onClick={(e) => props.onProgramsMenuClick(e)}
        >
          <LayoutGrid class="h-4 w-4" stroke-width={2} />
        </button>
      </Show>

      <div
        class="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
        role="list"
        aria-label="Windows"
      >
        <For each={props.windows}>
          {(w) => {
            const active = () => props.focusedWindowId === w.window_id && !w.minimized
            const Icon = windowIconFor(w)
            return (
              <div
                role="listitem"
                class="shell-taskbar-row flex h-full min-w-[132px] flex-[0_1_220px] items-center gap-1 px-2"
                classList={{
                  'shell-taskbar-row-active': active(),
                  'opacity-60': w.minimized && !active(),
                }}
                title={[windowLabel(w), w.minimized ? '(minimized)' : ''].filter(Boolean).join(' ')}
              >
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left text-xs touch-manipulation"
                  aria-current={active() ? 'true' : undefined}
                  onClick={() => props.onTaskbarActivate(w.window_id)}
                >
                  <span class="inline-flex shrink-0 text-(--shell-text-dim)">
                    <Icon
                      class={active() ? 'h-4 w-4 text-(--shell-text)' : 'h-4 w-4'}
                      stroke-width={2}
                    />
                  </span>
                  <span class="min-w-0 truncate">{windowLabel(w)}</span>
                </button>
                <button
                  type="button"
                  class="shell-taskbar-row-close flex h-full w-8 shrink-0 cursor-pointer items-center justify-center"
                  aria-label={`Close ${windowLabel(w)}`}
                  title={`Close ${windowLabel(w)}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onTaskbarClose(w.window_id)
                  }}
                >
                  <X class="h-4 w-4" stroke-width={2} />
                </button>
              </div>
            )
          }}
        </For>
      </div>

      <Show when={props.isPrimary}>
        <div class="ml-auto flex shrink-0 items-stretch">
          <Show when={props.keyboardLayoutLabel}>
            <span
              class="shell-taskbar-kbd flex min-w-11 shrink-0 items-center justify-center px-2 text-center text-[0.72rem] font-normal tabular-nums uppercase tracking-[0.08em]"
              title="Keyboard layout"
            >
              {keyboardIndicator(props.keyboardLayoutLabel!)}
            </span>
          </Show>
          <button
            type="button"
            class="shell-taskbar-action cursor-pointer"
            classList={{
              'shell-taskbar-action-active': props.settingsPanelOpen,
            }}
            data-shell-settings-toggle
            aria-pressed={props.settingsPanelOpen}
            title={props.settingsPanelOpen ? 'Hide settings' : 'Settings'}
            onClick={() => props.onSettingsPanelToggle()}
          >
            <Settings class="h-4 w-4" stroke-width={2} />
          </button>
          <button
            type="button"
            class="shell-taskbar-action cursor-pointer"
            classList={{
              'shell-taskbar-action-active': props.debugPanelOpen,
            }}
            aria-pressed={props.debugPanelOpen}
            title={props.debugPanelOpen ? 'Hide debug panel' : 'Show debug panel'}
            onClick={() => props.onDebugPanelToggle()}
          >
            <Bug class="h-4 w-4" stroke-width={2} />
          </button>
          <button
            type="button"
            class="shell-taskbar-action cursor-pointer"
            classList={{
              'shell-taskbar-action-active': props.powerMenuOpen,
            }}
            data-shell-power-toggle
            aria-expanded={props.powerMenuOpen}
            aria-haspopup="menu"
            title="Power"
            onClick={(e) => props.onPowerMenuClick(e)}
          >
            <Power class="h-4 w-4" stroke-width={2} />
          </button>
          <div class="shell-taskbar-meta flex min-w-18 shrink-0 flex-col items-end justify-center px-2 text-[10px] leading-tight text-(--shell-text-dim)">
            <span class="text-[0.76rem] font-semibold text-(--shell-text)">
              {clockTimeFormatter.format(now())}
            </span>
            <span>{clockDateFormatter.format(now())}</span>
          </div>
        </div>
      </Show>
    </div>
  )
}
