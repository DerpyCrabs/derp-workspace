import { For, Show, type Accessor } from 'solid-js'
import { canvasRectToClientCss } from '../shellCoords'
import { SnapAssistMasterGrid } from '../SnapAssistMasterGrid'
import { Taskbar, type TaskbarWindowRow } from '../Taskbar'
import type { AssistOverlayState, LayoutScreen } from './types'

type ShellSurfaceLayersProps = {
  assistOverlay: Accessor<AssistOverlayState | null>
  mainEl: Accessor<HTMLElement | undefined>
  outputGeom: Accessor<{ w: number; h: number } | null>
  workspaceSecondary: Accessor<LayoutScreen[]>
  screenCssRect: (screen: LayoutScreen) => LayoutScreen
  debugHudFrameVisible: Accessor<boolean>
  taskbarScreens: Accessor<LayoutScreen[]>
  taskbarHeight: number
  screenTaskbarHiddenForFullscreen: (screen: LayoutScreen) => boolean
  isPrimaryTaskbarScreen: (screen: LayoutScreen) => boolean
  programsMenuOpen: Accessor<boolean>
  onProgramsMenuClick: (e: MouseEvent & { currentTarget: HTMLButtonElement }) => void
  powerMenuOpen: Accessor<boolean>
  onPowerMenuClick: (e: MouseEvent & { currentTarget: HTMLButtonElement }) => void
  taskbarRowsForScreen: (screen: LayoutScreen) => TaskbarWindowRow[]
  focusedWindowId: Accessor<number | null>
  keyboardLayoutLabel: Accessor<string | null>
  settingsHudFrameVisible: Accessor<boolean>
  onSettingsPanelToggle: () => void
  onDebugPanelToggle: () => void
  onTaskbarActivate: (windowId: number) => void
  onTaskbarClose: (windowId: number) => void
}

export function ShellSurfaceLayers(props: ShellSurfaceLayersProps) {
  return (
    <>
      <Show when={props.assistOverlay} keyed>
        {(st) => {
          const s = st()
          if (!s) return <></>
          const main = props.mainEl()
          const og = props.outputGeom()
          if (!main || !og) return <></>
          const css = canvasRectToClientCss(
            s.workCanvas.x,
            s.workCanvas.y,
            s.workCanvas.w,
            s.workCanvas.h,
            main.getBoundingClientRect(),
            og.w,
            og.h,
          )
          return (
            <div
              class="bg-(--shell-overlay-muted) outline-(--shell-preview-outline) shadow-[0_0_24px_var(--shell-preview-shadow)] pointer-events-none fixed z-450000 box-border flex min-h-0 min-w-0 flex-col rounded-sm p-1.5 outline-2 -outline-offset-1"
              style={{
                left: `${css.left}px`,
                top: `${css.top}px`,
                width: `${css.width}px`,
                height: `${css.height}px`,
              }}
            >
              <SnapAssistMasterGrid
                shape={s.shape}
                gutterPx={s.gutterPx}
                getHoverSpan={() => props.assistOverlay()?.hoverSpan ?? null}
              />
            </div>
          )
        }}
      </Show>

      <For each={props.workspaceSecondary()}>
        {(screen) => {
          const loc = props.screenCssRect(screen)
          return (
            <div
              class="pointer-events-none absolute z-1 box-border border border-dashed border-(--shell-border) bg-(--shell-overlay-muted)"
              style={{
                left: `${loc.x}px`,
                top: `${loc.y}px`,
                width: `${loc.width}px`,
                height: `${loc.height}px`,
              }}
            >
              <Show when={props.debugHudFrameVisible()}>
                <span class="border border-(--shell-border) bg-(--shell-surface-elevated) text-(--shell-text-muted) absolute top-2 left-2 rounded px-2 py-1 text-[11px] font-semibold tracking-wider uppercase">
                  {screen.name || 'Display'}
                </span>
              </Show>
            </div>
          )
        }}
      </For>

      <For each={props.taskbarScreens()}>
        {(screen) => {
          const loc = props.screenCssRect(screen)
          return (
            <Show when={!props.screenTaskbarHiddenForFullscreen(screen)}>
              <div
                class="pointer-events-none absolute z-401000"
                style={{
                  left: `${loc.x}px`,
                  top: `${loc.y + loc.height - props.taskbarHeight}px`,
                  width: `${loc.width}px`,
                  height: `${props.taskbarHeight}px`,
                }}
              >
                <Taskbar
                  monitorName={screen.name}
                  isPrimary={props.isPrimaryTaskbarScreen(screen)}
                  programsMenuOpen={props.programsMenuOpen()}
                  onProgramsMenuClick={props.onProgramsMenuClick}
                  powerMenuOpen={props.powerMenuOpen()}
                  onPowerMenuClick={props.onPowerMenuClick}
                  windows={props.taskbarRowsForScreen(screen)}
                  focusedWindowId={props.focusedWindowId()}
                  keyboardLayoutLabel={
                    props.isPrimaryTaskbarScreen(screen) ? props.keyboardLayoutLabel() : null
                  }
                  settingsPanelOpen={props.settingsHudFrameVisible()}
                  onSettingsPanelToggle={props.onSettingsPanelToggle}
                  debugPanelOpen={props.debugHudFrameVisible()}
                  onDebugPanelToggle={props.onDebugPanelToggle}
                  onTaskbarActivate={props.onTaskbarActivate}
                  onTaskbarClose={props.onTaskbarClose}
                />
              </div>
            </Show>
          )
        }}
      </For>
    </>
  )
}
