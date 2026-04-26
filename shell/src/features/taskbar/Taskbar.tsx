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
import { Portal } from 'solid-js/web'
import { PowerContextMenu } from '@/host/PowerContextMenu'
import { ProgramsContextMenu } from '@/host/ProgramsContextMenu'
import {
  PowerTaskbarMenu,
  ProgramsTaskbarMenu,
  TaskbarContextMenuContent,
  TaskbarContextMenuTrigger,
  VolumeTaskbarMenu,
} from '@/host/TaskbarContextMenu'
import { VolumeContextMenu } from '@/host/VolumeContextMenu'
import { taskbarRowTooltip, taskbarWindowLabel } from '@/features/taskbar/taskbarRowTooltip'
import { registerShellExclusionElement } from '@/features/bridge/shellExclusionSync'
import type { ShellBatteryState } from '@/apps/settings/batteryState'
import { TaskbarWindowIcon } from './taskbarIcons'

export type TaskbarWindowRow = {
  group_id: string
  window_id: number
  title: string
  app_id: string
  desktop_id?: string | null
  desktop_icon?: string | null
  app_display_name?: string | null
  shell_file_path?: string | null
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
  batteryState: ShellBatteryState | null
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

type TaskbarRowHoverTip = { groupId: string; windowId: number; text: string; left: number; top: number }
type TaskbarControlHoverTip = { id: string; text: string; left: number; top: number }

function keyboardIndicator(label: string) {
  const compact = label.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return compact.slice(0, 3) || label.trim().toUpperCase().slice(0, 3)
}

function batteryStateLabel(state: string) {
  switch (state) {
    case 'charging':
      return 'Charging'
    case 'discharging':
      return 'On battery'
    case 'fully-charged':
      return 'Fully charged'
    case 'empty':
      return 'Battery empty'
    case 'pending-charge':
      return 'Waiting to charge'
    case 'pending-discharge':
      return 'Waiting to discharge'
    default:
      return 'Battery'
  }
}

function formatBatteryDuration(totalSeconds: number) {
  const totalMinutes = Math.max(0, Math.round(totalSeconds / 60))
  if (totalMinutes <= 0) return ''
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h`
  return `${minutes}m`
}

function batteryTooltipText(battery: ShellBatteryState) {
  const percent = `${Math.round(battery.percentage)}%`
  const state = batteryStateLabel(battery.state)
  const chargeTime = formatBatteryDuration(battery.time_to_full_seconds)
  const drainTime = formatBatteryDuration(battery.time_to_empty_seconds)
  if (battery.state === 'charging' && chargeTime) return `${state} ${percent}, ${chargeTime} until full`
  if (battery.state === 'discharging' && drainTime) return `${state} ${percent}, ${drainTime} remaining`
  return `${state} ${percent}`
}

function TaskbarWindowRows(props: {
  windows: TaskbarWindowRow[]
  focusedWindowId: number | null
  compactMode: 'normal' | 'compact' | 'tight'
  onTaskbarActivate: (windowId: number) => void
  onTaskbarClose: (windowId: number) => void
  reportRowHoverTip: (
    payload: { window: TaskbarWindowRow; rowEl: HTMLElement } | null,
    timing?: 'now' | 'frame',
  ) => void
}) {
  return (
    <For each={props.windows}>
      {(row) => {
        let suppressClickAfterPointer = false
        const active = () => {
          return props.focusedWindowId === row.window_id && !row.minimized
        }
        const label = () => taskbarWindowLabel(row)
        return (
          <div
            role="listitem"
            class="group relative flex h-full min-w-0 items-stretch gap-1 border-r border-(--shell-border) bg-(--shell-control-muted-bg) text-(--shell-text-muted) after:absolute after:right-0 after:bottom-0 after:left-0 after:h-0.5 after:bg-transparent hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text)"
            classList={{
              'bg-(--shell-control-muted-hover) text-(--shell-text) after:bg-(--shell-taskbar-focus-indicator)':
                active(),
              'text-(--shell-text-dim)': row.minimized && !active(),
              'min-w-[132px] flex-[0_1_220px] px-2': props.compactMode === 'normal',
              'min-w-[92px] flex-[1_1_112px]': props.compactMode === 'compact',
              'min-w-[52px] flex-[1_1_64px] px-1': props.compactMode === 'tight',
            }}
            onPointerEnter={(e) => {
              props.reportRowHoverTip({ window: row, rowEl: e.currentTarget }, 'now')
            }}
            onPointerLeave={() => props.reportRowHoverTip(null)}
          >
            <div class="flex min-h-0 min-w-0 flex-1 items-stretch">
              <button
                type="button"
                class="flex min-h-0 min-w-0 flex-1 items-center overflow-hidden text-left text-xs touch-manipulation"
                classList={{
                  'gap-1.5 px-0.5': props.compactMode !== 'tight',
                  'justify-center gap-0': props.compactMode === 'tight',
                }}
                data-shell-taskbar-group={row.group_id}
                data-shell-taskbar-window-activate={row.window_id}
                aria-current={active() ? 'true' : undefined}
                onPointerUp={(e) => {
                  if (e.button !== 0) return
                  suppressClickAfterPointer = true
                  window.setTimeout(() => {
                    suppressClickAfterPointer = false
                  }, 0)
                  props.onTaskbarActivate(row.window_id)
                }}
                onClick={() => {
                  if (suppressClickAfterPointer) return
                  props.onTaskbarActivate(row.window_id)
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  props.onTaskbarActivate(row.window_id)
                }}
              >
                <TaskbarWindowIcon
                  meta={{
                    title: row.title,
                    appId: row.app_id,
                    desktopId: row.desktop_id ?? null,
                    desktopIcon: row.desktop_icon ?? null,
                    shellFilePath: row.shell_file_path ?? null,
                  }}
                  active={active()}
                  compact={props.compactMode !== 'normal'}
                />
                <Show when={props.compactMode !== 'tight'}>
                  <span class="min-w-0 truncate">{label()}</span>
                </Show>
              </button>
            </div>
            <button
              type="button"
              class="sticky right-0 z-1 flex h-full shrink-0 cursor-pointer items-center justify-center bg-(--shell-control-muted-bg) text-(--shell-text-dim) touch-manipulation hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) group-hover:bg-(--shell-control-muted-hover)"
              classList={{
                'w-8': props.compactMode !== 'tight',
                'w-6': props.compactMode === 'tight',
                'bg-(--shell-control-muted-hover)': active(),
              }}
              data-shell-taskbar-window-close={row.window_id}
              aria-label={`Close ${label()}`}
              title={`Close ${label()}`}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => {
                if (e.button !== 0) return
                e.preventDefault()
                e.stopPropagation()
                props.onTaskbarClose(row.window_id)
              }}
            >
              <X class="h-4 w-4" stroke-width={2} />
            </button>
          </div>
        )
      }}
    </For>
  )
}

export function Taskbar(props: TaskbarProps) {
  const [now, setNow] = createSignal(new Date())
  const [windowRailWidth, setWindowRailWidth] = createSignal(0)
  const [rowHoverTip, setRowHoverTip] = createSignal<TaskbarRowHoverTip | null>(null)
  const [controlHoverTip, setControlHoverTip] = createSignal<TaskbarControlHoverTip | null>(null)
  let windowRailRef: HTMLDivElement | undefined
  let rowHoverTipRaf = 0
  let pendingRowHoverTip: { window: TaskbarWindowRow; rowEl: HTMLElement } | null = null
  let suppressSettingsClick = false
  let suppressDebugClick = false
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
  const battery = createMemo(() => {
    const current = props.batteryState
    return current?.is_present ? current : null
  })
  const batteryFillWidth = createMemo(() => {
    const pct = Math.max(0, Math.min(100, Math.round(battery()?.percentage ?? 0)))
    if (pct <= 0) return 0
    return Math.max(2, Math.round((pct / 100) * 14))
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

  createEffect(() => {
    const tip = rowHoverTip()
    if (!tip) return
    const exists = props.windows.some(
      (window) => window.group_id === tip.groupId && window.window_id === tip.windowId,
    )
    if (!exists) setRowHoverTip(null)
  })

  function applyRowHoverTip(payload: { window: TaskbarWindowRow; rowEl: HTMLElement }) {
    const r = payload.rowEl.getBoundingClientRect()
    setRowHoverTip((prev) => {
      const next = {
        groupId: payload.window.group_id,
        windowId: payload.window.window_id,
        text: taskbarRowTooltip(payload.window),
        left: r.left + r.width / 2,
        top: r.top - 8,
      }
      return prev &&
        prev.groupId === next.groupId &&
        prev.windowId === next.windowId &&
        prev.text === next.text &&
        prev.left === next.left &&
        prev.top === next.top
        ? prev
        : next
    })
  }

  function flushRowHoverTip() {
    rowHoverTipRaf = 0
    const payload = pendingRowHoverTip
    pendingRowHoverTip = null
    if (payload) applyRowHoverTip(payload)
  }

  function reportRowHoverTip(payload: { window: TaskbarWindowRow; rowEl: HTMLElement } | null, timing: 'now' | 'frame' = 'frame') {
    if (!payload) {
      pendingRowHoverTip = null
      if (rowHoverTipRaf) {
        cancelAnimationFrame(rowHoverTipRaf)
        rowHoverTipRaf = 0
      }
      setRowHoverTip(null)
      return
    }
    if (timing === 'now') {
      pendingRowHoverTip = null
      applyRowHoverTip(payload)
      return
    }
    pendingRowHoverTip = payload
    if (rowHoverTipRaf) return
    rowHoverTipRaf = requestAnimationFrame(flushRowHoverTip)
  }

  function reportControlHoverTip(payload: { id: string; text: string; el: HTMLElement } | null) {
    if (!payload) {
      setControlHoverTip(null)
      return
    }
    const r = payload.el.getBoundingClientRect()
    setControlHoverTip((prev) => {
      const next = {
        id: payload.id,
        text: payload.text,
        left: r.left + r.width / 2,
        top: r.top - 8,
      }
      return prev &&
        prev.id === next.id &&
        prev.text === next.text &&
        prev.left === next.left &&
        prev.top === next.top
        ? prev
        : next
    })
  }

  function registerTrayStrip(el: HTMLElement) {
    const registration = registerShellExclusionElement('tray-strip', 'tray-strip', el)
    onCleanup(registration.unregister)
  }

  function registerFloatingExclusion(el: HTMLElement) {
    const registration = registerShellExclusionElement('floating', 'floating', el)
    onCleanup(registration.unregister)
  }

  onCleanup(() => {
    if (rowHoverTipRaf) cancelAnimationFrame(rowHoverTipRaf)
    setRowHoverTip(null)
    setControlHoverTip(null)
  })

  return (
    <>
    <div
      data-shell-taskbar-exclude
      data-shell-taskbar-monitor={props.monitorName}
      class="pointer-events-auto absolute bottom-0 left-0 right-0 z-50000 box-border flex h-11 items-stretch overflow-hidden border-t border-(--shell-border) bg-(--shell-taskbar-bg-solid) px-1 text-(--shell-text)"
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
            ref={(el) => {
              windowRailRef = el
            }}
          >
            <TaskbarWindowRows
              windows={props.windows}
              focusedWindowId={props.focusedWindowId}
              compactMode={compactMode()}
              onTaskbarActivate={props.onTaskbarActivate}
              onTaskbarClose={props.onTaskbarClose}
              reportRowHoverTip={reportRowHoverTip}
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
                  onPointerDown={menu.onPointerDown}
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
          ref={(el) => {
            windowRailRef = el
          }}
        >
          <TaskbarWindowRows
            windows={props.windows}
            focusedWindowId={props.focusedWindowId}
            compactMode={compactMode()}
            onTaskbarActivate={props.onTaskbarActivate}
            onTaskbarClose={props.onTaskbarClose}
            reportRowHoverTip={reportRowHoverTip}
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
            ref={registerTrayStrip}
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
            onPointerDown={(e) => {
              e.preventDefault()
              suppressSettingsClick = true
              props.onSettingsPanelToggle()
            }}
            onClick={() => {
              if (suppressSettingsClick) {
                suppressSettingsClick = false
                return
              }
              props.onSettingsPanelToggle()
            }}
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
            onPointerDown={(e) => {
              e.preventDefault()
              suppressDebugClick = true
              props.onDebugPanelToggle()
            }}
            onClick={() => {
              if (suppressDebugClick) {
                suppressDebugClick = false
                return
              }
              props.onDebugPanelToggle()
            }}
          >
            <Bug class="h-4 w-4" stroke-width={2} />
          </button>
          <Show when={battery()}>
            {(currentBattery) => (
              <span
                data-shell-battery-indicator
                class="flex h-full w-10 shrink-0 items-center justify-center bg-transparent text-(--shell-text-muted)"
                classList={{
                  'text-(--shell-warning-text)':
                    currentBattery().state === 'discharging' && currentBattery().percentage <= 15,
                }}
                aria-label={batteryTooltipText(currentBattery())}
                onPointerEnter={(e) =>
                  reportControlHoverTip({
                    id: 'battery',
                    text: batteryTooltipText(currentBattery()),
                    el: e.currentTarget,
                  })}
                onPointerLeave={() => reportControlHoverTip(null)}
              >
                <span class="relative box-border h-3.5 w-5 shrink-0 rounded-[3px] border border-current">
                  <span
                    class="absolute top-[2px] bottom-[2px] left-[2px] rounded-[1px] bg-current opacity-85"
                    style={{ width: `${batteryFillWidth()}px` }}
                  />
                  <span class="absolute top-[3px] -right-[3px] h-1.5 w-0.5 rounded-r-sm bg-current" />
                </span>
              </span>
            )}
          </Show>
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
                  onPointerDown={menu.onPointerDown}
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
    <Show when={rowHoverTip() !== null && typeof document !== 'undefined'}>
      <Portal mount={document.body}>
        <div
          data-shell-taskbar-row-tooltip
          data-shell-exclusion-floating
          class="pointer-events-none fixed z-430000 max-w-[min(28rem,calc(100vw-1rem))] rounded-md border border-(--shell-border) bg-(--shell-taskbar-bg-solid) px-2.5 py-1.5 text-left text-xs leading-snug text-(--shell-text) shadow-lg"
          ref={registerFloatingExclusion}
          style={{
            left: `${rowHoverTip()!.left}px`,
            top: `${rowHoverTip()!.top}px`,
            transform: 'translate(-50%, -100%)',
          }}
          role="tooltip"
        >
          {rowHoverTip()!.text}
        </div>
      </Portal>
    </Show>
    <Show when={controlHoverTip() !== null && typeof document !== 'undefined'}>
      <Portal mount={document.body}>
        <div
          data-shell-taskbar-control-tooltip
          data-shell-exclusion-floating
          class="pointer-events-none fixed z-430000 max-w-[min(28rem,calc(100vw-1rem))] rounded-md border border-(--shell-border) bg-(--shell-taskbar-bg-solid) px-2.5 py-1.5 text-left text-xs leading-snug text-(--shell-text) shadow-lg"
          ref={registerFloatingExclusion}
          style={{
            left: `${controlHoverTip()!.left}px`,
            top: `${controlHoverTip()!.top}px`,
            transform: 'translate(-50%, -100%)',
          }}
          role="tooltip"
        >
          {controlHoverTip()!.text}
        </div>
      </Portal>
    </Show>
    </>
  )
}
