import type { Accessor } from 'solid-js'
import type { ShellBatteryState } from '@/apps/settings/batteryState'
import { ShellSurfaceLayers } from '@/host/ShellSurfaceLayers'
import { SHELL_UI_DEBUG_WINDOW_ID, SHELL_UI_SETTINGS_WINDOW_ID } from '@/features/shell-ui/shellUiWindows'
import type { TaskbarPin, TaskbarSniItem, TaskbarWindowRow } from '@/features/taskbar/Taskbar'
import type { DerpWindow } from '@/host/appWindowState'
import type { AssistOverlayState, LayoutScreen, SnapAssistStripState } from '@/host/types'

type ShellSurfaceRuntimeOptions = {
  assistOverlay: Accessor<AssistOverlayState | null>
  getMainRef: () => HTMLElement | undefined
  outputGeom: Accessor<{ w: number; h: number } | null>
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
  trayVolumeState: Accessor<{
    muted: boolean
    volumePercent: number | null
  }>
  taskbarPinsForScreen: (screen: LayoutScreen) => TaskbarPin[]
  taskbarRowsForScreen: (screen: LayoutScreen) => TaskbarWindowRow[]
  focusedTaskbarWindowId: Accessor<number | null>
  keyboardLayoutLabel: Accessor<string | null>
  settingsHudFrameVisible: Accessor<boolean>
  trayReservedPx: Accessor<number>
  sniTrayItems: Accessor<TaskbarSniItem[]>
  trayIconSlotPx: Accessor<number>
  snapStrip: Accessor<SnapAssistStripState | null>
  snapStripScreen: Accessor<LayoutScreen | null>
  windows: Accessor<ReadonlyMap<number, DerpWindow>>
  closeGroupWindow: (windowId: number) => void
  activateTaskbarGroup: (windowId: number) => void
  activateTaskbarPin: (pin: TaskbarPin, monitorName: string) => void
  unpinTaskbarPin: (pin: TaskbarPin, monitorName: string) => void
  openSettingsShellWindow: () => void
  openDebugShellWindow: () => void
  openTraySniMenu: (notifierId: string, requestSerial: number, clientX: number, clientY: number) => void
  shellWireSend: (
    op: 'minimize' | 'sni_tray_activate' | 'sni_tray_open_menu',
    arg?: number | string,
    arg2?: number | string,
    arg3?: number,
    arg4?: number,
    arg5?: number,
    arg6?: number,
  ) => boolean
}

export function createShellSurfaceRuntime(options: ShellSurfaceRuntimeOptions) {
  let traySniMenuNextSerial = 0

  function minimizeDebugShellWindow() {
    options.shellWireSend('minimize', SHELL_UI_DEBUG_WINDOW_ID)
  }

  function minimizeSettingsShellWindow() {
    options.shellWireSend('minimize', SHELL_UI_SETTINGS_WINDOW_ID)
  }

  function toggleSettingsShellWindow() {
    const window = options.windows().get(SHELL_UI_SETTINGS_WINDOW_ID)
    if (!window || window.minimized) options.openSettingsShellWindow()
    else minimizeSettingsShellWindow()
  }

  function toggleDebugShellWindow() {
    const window = options.windows().get(SHELL_UI_DEBUG_WINDOW_ID)
    if (!window || window.minimized) options.openDebugShellWindow()
    else minimizeDebugShellWindow()
  }

  function openSniTrayContextMenu(id: string, clientX: number, clientY: number) {
    traySniMenuNextSerial = (traySniMenuNextSerial + 1) >>> 0
    const serial = traySniMenuNextSerial
    options.openTraySniMenu(id, serial, clientX, clientY)
    options.shellWireSend('sni_tray_open_menu', id, serial)
  }

  function ShellSurfaceLayer() {
    return (
      <ShellSurfaceLayers
        assistOverlay={options.assistOverlay}
        mainEl={options.getMainRef}
        outputGeom={options.outputGeom}
        workspaceSecondary={options.workspaceSecondary}
        screenCssRect={options.screenCssRect}
        debugHudFrameVisible={options.debugHudFrameVisible}
        taskbarScreens={options.taskbarScreens}
        taskbarHeight={options.taskbarHeight}
        taskbarAutoHide={options.taskbarAutoHide}
        taskbarPortalMenusOpen={options.taskbarPortalMenusOpen}
        pointerInMain={options.pointerInMain}
        screenTaskbarHiddenForFullscreen={options.screenTaskbarHiddenForFullscreen}
        isPrimaryTaskbarScreen={options.isPrimaryTaskbarScreen}
        batteryState={options.batteryState}
        volumeMuted={() => options.trayVolumeState().muted}
        volumePercent={() => options.trayVolumeState().volumePercent}
        taskbarPinsForScreen={options.taskbarPinsForScreen}
        taskbarRowsForScreen={options.taskbarRowsForScreen}
        focusedWindowId={options.focusedTaskbarWindowId}
        keyboardLayoutLabel={options.keyboardLayoutLabel}
        settingsHudFrameVisible={options.settingsHudFrameVisible}
        onSettingsPanelToggle={toggleSettingsShellWindow}
        onDebugPanelToggle={toggleDebugShellWindow}
        onTaskbarActivate={options.activateTaskbarGroup}
        onTaskbarClose={options.closeGroupWindow}
        onTaskbarPinActivate={options.activateTaskbarPin}
        onTaskbarPinUnpin={options.unpinTaskbarPin}
        trayReservedPx={options.trayReservedPx}
        sniTrayItems={options.sniTrayItems}
        trayIconSlotPx={options.trayIconSlotPx}
        onSniTrayActivate={(id) => {
          options.shellWireSend('sni_tray_activate', id)
        }}
        onSniTrayContextMenu={openSniTrayContextMenu}
        snapStrip={options.snapStrip}
        snapStripScreen={options.snapStripScreen}
      />
    )
  }

  return {
    ShellSurfaceLayer,
  }
}
