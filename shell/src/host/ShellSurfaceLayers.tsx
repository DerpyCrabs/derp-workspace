import { createEffect, createSignal, For, Index, onCleanup, Show, type Accessor } from 'solid-js'
import type { ShellBatteryState } from '@/apps/settings/batteryState'
import { Taskbar, type TaskbarPin, type TaskbarSniItem, type TaskbarWindowRow } from '@/features/taskbar/Taskbar'
import { registerShellExclusionRect } from '@/features/bridge/shellExclusionSync'
import type { LayoutScreen } from './types'

type ShellSurfaceLayersProps = {
  workspaceSecondary: Accessor<LayoutScreen[]>
  screenCssRect: (screen: LayoutScreen) => LayoutScreen
  debugHudFrameVisible: Accessor<boolean>
  taskbarScreens: Accessor<LayoutScreen[]>
  taskbarHeight: number
  taskbarAutoHide: Accessor<boolean>
  taskbarPortalMenusOpen: Accessor<boolean>
  pointerInMain: Accessor<{ x: number; y: number } | null>
  screenTaskbarHiddenForFullscreen: (screen: LayoutScreen) => boolean
  isPrimaryTaskbarScreen: (screen: LayoutScreen) => boolean
  batteryState: Accessor<ShellBatteryState | null>
  volumeMuted: Accessor<boolean>
  volumePercent: Accessor<number | null>
  taskbarPinsForScreen: (screen: LayoutScreen) => TaskbarPin[]
  taskbarRowsForScreen: (screen: LayoutScreen) => TaskbarWindowRow[]
  focusedWindowId: Accessor<number | null>
  keyboardLayoutLabel: Accessor<string | null>
  oskEnabled: Accessor<boolean>
  onOskToggle: () => void
  settingsHudFrameVisible: Accessor<boolean>
  onSettingsPanelToggle: () => void
  onDebugPanelToggle: () => void
  onTaskbarActivate: (windowId: number) => void
  onTaskbarClose: (windowId: number) => void
  onTaskbarPinActivate: (pin: TaskbarPin, monitorName: string) => void
  onTaskbarPinUnpin: (pin: TaskbarPin, monitorName: string) => void
  trayReservedPx: Accessor<number>
  sniTrayItems: Accessor<TaskbarSniItem[]>
  trayIconSlotPx: Accessor<number>
  onSniTrayActivate: (id: string) => void
  onSniTrayContextMenu: (id: string, clientX: number, clientY: number) => void
}

export function ShellSurfaceLayers(props: ShellSurfaceLayersProps) {
  return (
    <>
      <For each={props.workspaceSecondary()}>
        {(screen) => {
          const loc = props.screenCssRect(screen)
          return (
            <Show when={props.debugHudFrameVisible()}>
              <div
                data-shell-secondary-screen={screen.name || 'display'}
                class="pointer-events-none absolute z-1 box-border border border-dashed border-(--shell-border) bg-transparent"
                style={{
                  left: `${loc.x}px`,
                  top: `${loc.y}px`,
                  width: `${loc.width}px`,
                  height: `${loc.height}px`,
                }}
              >
                <span class="border border-(--shell-border) bg-(--shell-surface-elevated) text-(--shell-text-muted) absolute top-2 left-2 rounded px-2 py-1 text-[11px] font-semibold tracking-wider uppercase">
                  {screen.name || 'Display'}
                </span>
              </div>
            </Show>
          )
        }}
      </For>

      <Index each={props.taskbarScreens()}>
        {(screen) => {
          const currentScreen = () => screen()
          const loc = () => props.screenCssRect(currentScreen())
          const taskbar = () => taskbarRectForScreen(loc(), currentScreen().taskbar_side, props.taskbarHeight)
          const trigger = () => taskbarTriggerRectForScreen(loc(), currentScreen().taskbar_side)
          const menuBounds = () => {
            const bounds = loc()
            return { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height }
          }
          const [edgeRevealed, setEdgeRevealed] = createSignal(false)
          const hiddenByFullscreen = () => props.screenTaskbarHiddenForFullscreen(currentScreen())
          createEffect(() => {
            if (!props.taskbarAutoHide() || hiddenByFullscreen()) {
              setEdgeRevealed(false)
              return
            }
            if (props.taskbarPortalMenusOpen()) {
              setEdgeRevealed(true)
              return
            }
            const pointer = props.pointerInMain()
            if (!pointer) {
              setEdgeRevealed(false)
              return
            }
            const inTrigger = pointInRect(trigger(), pointer)
            const inTaskbar = pointInRect(taskbar(), pointer)
            setEdgeRevealed((wasRevealed) => inTrigger || (wasRevealed && inTaskbar))
          })
          const revealed = () => {
            if (!props.taskbarAutoHide()) return true
            if (props.taskbarPortalMenusOpen()) return true
            return edgeRevealed()
          }
          const visible = () => !hiddenByFullscreen() && revealed()
          const layerRect = () => (visible() ? taskbar() : trigger())
          const trailingTaskbarControlSize = () => {
            const side = currentScreen().taskbar_side
            const clock = side === 'left' || side === 'right' ? 36 : 72
            const battery = props.batteryState()?.is_present ? 36 : 0
            return 36 + 36 + 36 + battery + 36 + clock
          }
          const trayReservedForScreen = () => {
            if (!props.isPrimaryTaskbarScreen(currentScreen())) return 0
            const itemReserved = props.sniTrayItems().length * Math.max(24, Math.min(48, props.trayIconSlotPx()))
            return Math.max(0, props.trayReservedPx(), itemReserved)
          }
          const trayRect = () => {
            if (!props.isPrimaryTaskbarScreen(currentScreen()) || !visible()) return null
            const reserved = trayReservedForScreen()
            if (reserved <= 0) return null
            const rect = taskbar()
            const trailing = trailingTaskbarControlSize()
            const side = currentScreen().taskbar_side
            if (side === 'left' || side === 'right') {
              return {
                x: rect.x,
                y: Math.max(rect.y, rect.y + rect.height - trailing - reserved),
                w: rect.width,
                h: reserved,
              }
            }
            return {
              x: Math.max(rect.x, rect.x + rect.width - trailing - reserved),
              y: rect.y,
              w: reserved,
              h: rect.height,
            }
          }
          const trayRegistration = registerShellExclusionRect('tray-strip', `tray-strip:${currentScreen().name}`, () => trayRect())
          createEffect(() => {
            trayRect()
            trayRegistration.invalidate()
          })
          onCleanup(trayRegistration.unregister)
          return (
            <Show when={!hiddenByFullscreen() || props.taskbarAutoHide()}>
              <div
                class="pointer-events-auto absolute z-401000"
                style={{
                  left: `${layerRect().x}px`,
                  top: `${layerRect().y}px`,
                  width: `${layerRect().width}px`,
                  height: `${layerRect().height}px`,
                }}
              >
                <Show when={visible()}>
                  <Taskbar
                    monitorName={currentScreen().name}
                    orientation={currentScreen().taskbar_side === 'left' || currentScreen().taskbar_side === 'right' ? 'vertical' : 'horizontal'}
                    side={currentScreen().taskbar_side}
                    isPrimary={props.isPrimaryTaskbarScreen(currentScreen())}
                    batteryState={
                      props.isPrimaryTaskbarScreen(currentScreen()) ? props.batteryState() : null
                    }
                    menuBounds={menuBounds()}
                    trayReservedPx={
                      trayReservedForScreen()
                    }
                    sniTrayItems={
                      props.isPrimaryTaskbarScreen(currentScreen()) ? props.sniTrayItems() : []
                    }
                    trayIconSlotPx={
                      props.isPrimaryTaskbarScreen(currentScreen()) ? props.trayIconSlotPx() : 36
                    }
                    onSniTrayActivate={props.onSniTrayActivate}
                    onSniTrayContextMenu={props.onSniTrayContextMenu}
                    volumeMuted={props.volumeMuted()}
                    volumePercent={props.volumePercent()}
                    pins={props.taskbarPinsForScreen(currentScreen())}
                    windows={props.taskbarRowsForScreen(currentScreen())}
                    focusedWindowId={props.focusedWindowId()}
                    keyboardLayoutLabel={
                      props.isPrimaryTaskbarScreen(currentScreen()) ? props.keyboardLayoutLabel() : null
                    }
                    oskEnabled={props.isPrimaryTaskbarScreen(currentScreen()) && props.oskEnabled()}
                    onOskToggle={props.onOskToggle}
                    settingsPanelOpen={props.settingsHudFrameVisible()}
                    onSettingsPanelToggle={props.onSettingsPanelToggle}
                    debugPanelOpen={props.debugHudFrameVisible()}
                    onDebugPanelToggle={props.onDebugPanelToggle}
                    onTaskbarActivate={props.onTaskbarActivate}
                    onTaskbarClose={props.onTaskbarClose}
                    onTaskbarPinActivate={props.onTaskbarPinActivate}
                    onTaskbarPinUnpin={props.onTaskbarPinUnpin}
                  />
                </Show>
              </div>
            </Show>
          )
        }}
      </Index>
    </>
  )
}

function taskbarRectForScreen(screen: LayoutScreen, side: LayoutScreen['taskbar_side'], size: number) {
  const ux = screen.usable_x ?? screen.x
  const uy = screen.usable_y ?? screen.y
  const uw = screen.usable_width ?? screen.width
  const uh = screen.usable_height ?? screen.height
  if (side === 'top') return { x: ux, y: uy, width: uw, height: size }
  if (side === 'left') return { x: ux, y: uy, width: size, height: uh }
  if (side === 'right') return { x: ux + uw - size, y: uy, width: size, height: uh }
  return { x: ux, y: uy + uh - size, width: uw, height: size }
}

function taskbarTriggerRectForScreen(screen: LayoutScreen, side: LayoutScreen['taskbar_side']) {
  return taskbarRectForScreen(screen, side, 2)
}

function pointInRect(rect: { x: number; y: number; width: number; height: number }, point: { x: number; y: number }) {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}
