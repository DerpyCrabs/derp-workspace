import AppWindow from 'lucide-solid/icons/app-window'
import Bug from 'lucide-solid/icons/bug'
import LayoutGrid from 'lucide-solid/icons/layout-grid'
import Power from 'lucide-solid/icons/power'
import Volume1 from 'lucide-solid/icons/volume-1'
import Volume2 from 'lucide-solid/icons/volume-2'
import VolumeX from 'lucide-solid/icons/volume-x'
import X from 'lucide-solid/icons/x'
import Settings from 'lucide-solid/icons/settings'
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { PowerContextMenu } from './app/PowerContextMenu'
import { ProgramsContextMenu } from './app/ProgramsContextMenu'
import {
  PowerTaskbarMenu,
  ProgramsTaskbarMenu,
  TaskbarContextMenuContent,
  TaskbarContextMenuTrigger,
  VolumeTaskbarMenu,
} from './app/TaskbarContextMenu'
import { VolumeContextMenu } from './app/VolumeContextMenu'
import { TaskbarWindowIcon } from './taskbarIcons'

export type TaskbarWindowRow = {
  group_id: string
  window_id: number
  title: string
  app_id: string
  desktop_id?: string | null
  desktop_icon?: string | null
  minimized: boolean
  output_name: string
  tab_count: number
}

export type TaskbarSniItem = {
  id: string
  title: string
  icon_base64: string
}

export type TaskbarProps = {
  monitorName: string
  isPrimary: boolean
  trayReservedPx: number
  sniTrayItems: TaskbarSniItem[]
  trayIconSlotPx: number
  onSniTrayActivate: (id: string) => void
  onSniTrayContextMenu: (id: string, clientX: number, clientY: number) => void
  volumeMuted: boolean
  volumePercent: number | null
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
  const label = w.title || w.app_id || `Window ${w.window_id}`
  return w.tab_count > 1 ? `${label} (+${w.tab_count - 1})` : label
}

function keyboardIndicator(label: string) {
  const compact = label.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return compact.slice(0, 3) || label.trim().toUpperCase().slice(0, 3)
}

function TaskbarWindowRows(props: {
  windows: TaskbarWindowRow[]
  focusedWindowId: number | null
  compactMode: 'normal' | 'compact' | 'tight'
  onTaskbarActivate: (windowId: number) => void
  onTaskbarClose: (windowId: number) => void
}) {
  return (
    <For each={props.windows}>
      {(w) => {
        const active = () => props.focusedWindowId === w.window_id && !w.minimized
        return (
          <div
            role="listitem"
            class="relative flex h-full items-center gap-1 border-r border-(--shell-border) bg-(--shell-control-muted-bg) px-1.5 text-(--shell-text-muted) after:absolute after:right-0 after:bottom-0 after:left-0 after:h-0.5 after:bg-transparent hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text)"
            classList={{
              'bg-(--shell-control-muted-hover) text-(--shell-text) after:bg-(--shell-taskbar-focus-indicator)':
                active(),
              'text-(--shell-text-dim)': w.minimized && !active(),
              'min-w-[132px] flex-[0_1_220px] px-2': props.compactMode === 'normal',
              'min-w-[92px] flex-[1_1_112px]': props.compactMode === 'compact',
              'min-w-[52px] flex-[1_1_64px] justify-center px-1': props.compactMode === 'tight',
            }}
            title={[windowLabel(w), w.minimized ? '(minimized)' : ''].filter(Boolean).join(' ')}
          >
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center overflow-hidden text-left text-xs touch-manipulation"
              classList={{
                'gap-1.5': props.compactMode !== 'tight',
                'justify-center gap-0': props.compactMode === 'tight',
              }}
              data-shell-taskbar-group={w.group_id}
              data-shell-taskbar-window-activate={w.window_id}
              aria-current={active() ? 'true' : undefined}
              onClick={() => props.onTaskbarActivate(w.window_id)}
            >
              <TaskbarWindowIcon
                meta={{
                  title: w.title,
                  appId: w.app_id,
                  desktopId: w.desktop_id ?? null,
                  desktopIcon: w.desktop_icon ?? null,
                }}
                active={active()}
                compact={props.compactMode !== 'normal'}
              />
              <Show when={props.compactMode !== 'tight'}>
                <span class="min-w-0 truncate">{windowLabel(w)}</span>
              </Show>
            </button>
            <Show when={props.compactMode !== 'tight'}>
              <button
                type="button"
                class="flex h-full w-8 shrink-0 cursor-pointer items-center justify-center text-(--shell-text-dim) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text)"
                data-shell-taskbar-window-close={w.window_id}
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
            </Show>
          </div>
        )
      }}
    </For>
  )
}

export function Taskbar(props: TaskbarProps) {
  const [now, setNow] = createSignal(new Date())
  const [windowRailWidth, setWindowRailWidth] = createSignal(0)
  let windowRailRef: HTMLDivElement | undefined
  const volumeIcon = () => {
    const Icon = props.volumeMuted ? VolumeX : (props.volumePercent ?? 0) <= 33 ? Volume1 : Volume2
    return <Icon class="h-4 w-4" stroke-width={2} />
  }
  const compactMode = createMemo<'normal' | 'compact' | 'tight'>(() => {
    if (props.windows.length === 0) return 'normal'
    const width = windowRailWidth()
    if (width <= 0) return 'normal'
    const perWindow = width / props.windows.length
    if (perWindow < 82) return 'tight'
    if (perWindow < 132) return 'compact'
    return 'normal'
  })

  if (props.isPrimary) {
    const interval = window.setInterval(() => setNow(new Date()), 15000)
    onCleanup(() => window.clearInterval(interval))
  }

  createEffect(() => {
    const rail = windowRailRef
    if (!rail) return
    setWindowRailWidth(rail.clientWidth)
    const observer = new ResizeObserver(() => {
      setWindowRailWidth(rail.clientWidth)
    })
    observer.observe(rail)
    onCleanup(() => observer.disconnect())
  })

  return (
    <div
      class="pointer-events-auto absolute bottom-0 left-0 right-0 z-50000 box-border flex h-11 items-stretch overflow-hidden border-t border-(--shell-border) bg-(--shell-taskbar-bg-solid) px-1 text-(--shell-text)"
      data-shell-taskbar-monitor={props.monitorName}
    >
      <Show
        when={props.isPrimary}
        fallback={
          <div
            data-shell-taskbar-exclude
            data-shell-taskbar-monitor={props.monitorName}
            class="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
            role="list"
            aria-label="Windows"
            ref={windowRailRef}
          >
            <TaskbarWindowRows
              windows={props.windows}
              focusedWindowId={props.focusedWindowId}
              compactMode={compactMode()}
              onTaskbarActivate={props.onTaskbarActivate}
              onTaskbarClose={props.onTaskbarClose}
            />
          </div>
        }
      >
        <div
          data-shell-taskbar-exclude
          data-shell-taskbar-monitor={props.monitorName}
          class="mr-1 flex h-full shrink-0 items-stretch"
        >
          <ProgramsTaskbarMenu>
            <TaskbarContextMenuTrigger>
              {(menu) => (
                <button
                  type="button"
                  class="inline-flex h-full w-10 items-center justify-center border-0 bg-transparent text-(--shell-text-muted) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) shrink-0 cursor-pointer"
                  data-shell-programs-toggle
                  aria-expanded={menu.open()}
                  aria-haspopup="menu"
                  aria-label="Search apps"
                  title="Search apps"
                  onClick={menu.onClick}
                >
                  <LayoutGrid class="h-4 w-4" stroke-width={2} />
                </button>
              )}
            </TaskbarContextMenuTrigger>
            <TaskbarContextMenuContent>
              <ProgramsContextMenu />
            </TaskbarContextMenuContent>
          </ProgramsTaskbarMenu>
        </div>
        <div
          data-shell-taskbar-exclude
          data-shell-taskbar-monitor={props.monitorName}
          class="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
          role="list"
          aria-label="Windows"
          ref={windowRailRef}
        >
          <TaskbarWindowRows
            windows={props.windows}
            focusedWindowId={props.focusedWindowId}
            compactMode={compactMode()}
            onTaskbarActivate={props.onTaskbarActivate}
            onTaskbarClose={props.onTaskbarClose}
          />
        </div>
        <div
          data-shell-taskbar-exclude
          data-shell-taskbar-monitor={props.monitorName}
          class="ml-auto flex shrink-0 items-stretch"
        >
          <Show when={props.keyboardLayoutLabel}>
            <span
              class="flex h-full min-w-11 shrink-0 items-center justify-center border-l border-(--shell-border) bg-transparent px-2 text-center text-[0.72rem] font-normal tabular-nums uppercase tracking-[0.08em] text-(--shell-text-muted)"
              title="Keyboard layout"
            >
              {keyboardIndicator(props.keyboardLayoutLabel!)}
            </span>
          </Show>
          <div
            data-shell-tray-strip
            class="flex h-full shrink-0 items-stretch border-l border-(--shell-border) bg-transparent"
            style={{ width: `${Math.max(0, props.trayReservedPx)}px`, 'min-width': `${Math.max(0, props.trayReservedPx)}px` }}
            aria-label="Tray"
          >
            <For each={props.sniTrayItems}>
              {(it) => {
                const slot = () => Math.max(24, Math.min(56, props.trayIconSlotPx))
                const src = () =>
                  it.icon_base64.length > 0 ? `data:image/png;base64,${it.icon_base64}` : ''
                return (
                  <button
                    type="button"
                    class="box-border flex shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent px-0.5 text-(--shell-text-muted) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) touch-manipulation"
                    style={{ width: `${slot()}px`, 'min-width': `${slot()}px` }}
                    title={it.title}
                    onClick={() => props.onSniTrayActivate(it.id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      props.onSniTrayContextMenu(it.id, e.clientX, e.clientY)
                    }}
                  >
                    <Show when={src()} fallback={<AppWindow class="h-5 w-5 opacity-70" stroke-width={2} />}>
                      <img
                        alt=""
                        class="h-[22px] w-[22px] max-h-[22px] max-w-[22px] object-contain"
                        src={src()}
                        draggable={false}
                      />
                    </Show>
                  </button>
                )
              }}
            </For>
          </div>
          <VolumeTaskbarMenu>
            <TaskbarContextMenuTrigger>
              {(menu) => (
                <button
                  type="button"
                  class="inline-flex h-full w-10 items-center justify-center border-0 bg-transparent text-(--shell-text-muted) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) cursor-pointer"
                  classList={{
                    'bg-(--shell-control-muted-hover) text-(--shell-text)': menu.open(),
                  }}
                  data-shell-volume-toggle
                  aria-expanded={menu.open()}
                  aria-haspopup="dialog"
                  title={props.volumeMuted ? 'Volume muted' : props.volumePercent !== null ? `Volume ${props.volumePercent}%` : 'Volume'}
                  onPointerDown={menu.onPointerDown}
                  onClick={menu.onClick}
                >
                  {volumeIcon()}
                </button>
              )}
            </TaskbarContextMenuTrigger>
            <TaskbarContextMenuContent>
              <VolumeContextMenu />
            </TaskbarContextMenuContent>
          </VolumeTaskbarMenu>
          <button
            type="button"
            class="inline-flex h-full w-10 items-center justify-center border-0 bg-transparent text-(--shell-text-muted) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) cursor-pointer"
            classList={{
              'bg-(--shell-control-muted-hover) text-(--shell-text)': props.settingsPanelOpen,
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
            class="inline-flex h-full w-10 items-center justify-center border-0 bg-transparent text-(--shell-text-muted) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) cursor-pointer"
            classList={{
              'bg-(--shell-control-muted-hover) text-(--shell-text)': props.debugPanelOpen,
            }}
            data-shell-debug-toggle
            aria-pressed={props.debugPanelOpen}
            title={props.debugPanelOpen ? 'Hide debug panel' : 'Show debug panel'}
            onClick={() => props.onDebugPanelToggle()}
          >
            <Bug class="h-4 w-4" stroke-width={2} />
          </button>
          <PowerTaskbarMenu>
            <TaskbarContextMenuTrigger>
              {(menu) => (
                <button
                  type="button"
                  class="inline-flex h-full w-10 items-center justify-center border-0 bg-transparent text-(--shell-text-muted) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) cursor-pointer"
                  classList={{
                    'bg-(--shell-control-muted-hover) text-(--shell-text)': menu.open(),
                  }}
                  data-shell-power-toggle
                  aria-expanded={menu.open()}
                  aria-haspopup="menu"
                  title="Power"
                  onClick={menu.onClick}
                >
                  <Power class="h-4 w-4" stroke-width={2} />
                </button>
              )}
            </TaskbarContextMenuTrigger>
            <TaskbarContextMenuContent>
              <PowerContextMenu />
            </TaskbarContextMenuContent>
          </PowerTaskbarMenu>
          <div class="flex min-w-18 shrink-0 flex-col items-end justify-center border-l border-(--shell-border) px-2 text-[10px] leading-tight text-(--shell-text-dim)">
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
