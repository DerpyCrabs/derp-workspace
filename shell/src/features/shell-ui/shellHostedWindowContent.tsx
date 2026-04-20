import { Show, type Accessor, type JSX, type Setter } from 'solid-js'
import type { SetStoreFunction } from 'solid-js/store'
import { FileBrowserWindow } from '@/apps/file-browser/FileBrowserWindow'
import { ImageViewerWindow } from '@/apps/image-viewer/ImageViewerWindow'
import { TextEditorWindow } from '@/apps/text-editor/TextEditorWindow'
import { VideoViewerWindow } from '@/apps/video-viewer/VideoViewerWindow'
import { ShellDebugHudContent } from '@/apps/debug/ShellDebugHudContent'
import { ShellTestWindowContent } from '@/apps/debug/ShellTestWindowContent'
import { SettingsPanel } from '@/apps/settings/SettingsPanel'
import {
  isFileBrowserWindowId,
  isImageViewerWindowId,
  isShellTestWindowId,
  isTextEditorWindowId,
  isVideoViewerWindowId,
  SHELL_UI_TEST_APP_ID,
} from '@/features/shell-ui/backedShellWindows'
import { isImageFilePath } from '@/apps/image-viewer/imageViewerCore'
import { isTextEditorFilePath } from '@/apps/text-editor/textEditorCore'
import { isVideoFilePath } from '@/apps/video-viewer/videoViewerCore'
import type { ShellCompositorWireSend } from '@/features/shell-ui/shellWireSendType'
import { SHELL_UI_DEBUG_WINDOW_ID, SHELL_UI_SETTINGS_WINDOW_ID } from '@/features/shell-ui/shellUiWindows'
import { windowLabel as groupedWindowLabel } from '@/features/workspace/tabGroupOps'
import type { DerpWindow } from '@/host/appWindowState'
import type { ExclusionHudZone, LayoutScreen } from '@/host/types'

export type ShellHostedWindowContentEnv = {
  allWindowsMap: () => Map<number, DerpWindow>
  shellHostedAppByWindow: () => Record<number, unknown>
  shellWireSend: ShellCompositorWireSend
  onOpenFileBrowserInNewWindow: (path: string) => void
  onOpenImageFile: (detail: { path: string; directory: string; showHidden: boolean }) => void
  onOpenVideoFile: (detail: { path: string; directory: string; showHidden: boolean }) => void
  onOpenTextFile: (detail: { path: string; directory: string; showHidden: boolean }) => void
  reportShellActionIssue: (message: string) => void
  copyDebugHudSnapshot: () => void
  shellBuildLabel: string
  hudFps: Accessor<number>
  crosshairCursor: Accessor<boolean>
  setCrosshairCursor: Setter<boolean>
  outputGeom: Accessor<{ w: number; h: number } | null>
  layoutUnionBbox: Accessor<{ x: number; y: number; w: number; h: number } | null>
  layoutCanvasOrigin: Accessor<{ x: number; y: number } | null>
  panelHostForHud: Accessor<LayoutScreen | null>
  shellChromePrimaryName: Accessor<string | null>
  viewportCss: Accessor<{ w: number; h: number }>
  windowsList: () => readonly DerpWindow[]
  pointerClient: Accessor<{ x: number; y: number } | null>
  pointerInMain: Accessor<{ x: number; y: number } | null>
  rootPointerDowns: Accessor<number>
  exclusionZonesHud: Accessor<ExclusionHudZone[]>
  screenDraft: { rows: LayoutScreen[] }
  setScreenDraft: SetStoreFunction<{ rows: LayoutScreen[] }>
  autoShellChromeMonitorName: Accessor<string | null>
  canSessionControl: Accessor<boolean>
  uiScalePercent: Accessor<100 | 150 | 200>
  tilingCfgRev: Accessor<number>
  setTilingCfgRev: Setter<number>
  clearMonitorTiles: (outputName: string) => void
  bumpSnapChrome: () => void
  scheduleExclusionZonesSync: () => void
  applyAutoLayout: (name: string) => void
  setShellPrimary: (name: string) => void
  setUiScale: (pct: 100 | 150 | 200) => void
  applyCompositorLayoutFromDraft: () => void
  monitorRefreshLabel: (milli: number) => string
  keyboardLayoutLabel: Accessor<string | null>
  setDesktopBackgroundJson: (json: string) => void
  sessionAutoSaveEnabled: Accessor<boolean>
  setSessionAutoSaveEnabled: (enabled: boolean) => void
}

export function renderShellHostedWindowContent(
  windowId: number,
  env: ShellHostedWindowContentEnv,
): JSX.Element | undefined {
  if (windowId === SHELL_UI_DEBUG_WINDOW_ID) {
    return (
      <ShellDebugHudContent
        onReload={() => location.reload()}
        onCopySnapshot={env.copyDebugHudSnapshot}
        shellBuildLabel={env.shellBuildLabel}
        hudFps={env.hudFps}
        crosshairCursor={env.crosshairCursor}
        setCrosshairCursor={env.setCrosshairCursor}
        outputGeom={env.outputGeom}
        layoutUnionBbox={env.layoutUnionBbox}
        layoutCanvasOrigin={env.layoutCanvasOrigin}
        panelHostForHud={env.panelHostForHud}
        shellChromePrimaryName={env.shellChromePrimaryName}
        viewportCss={env.viewportCss}
        windowsCount={() => env.windowsList().length}
        pointerClient={env.pointerClient}
        pointerInMain={env.pointerInMain}
        rootPointerDowns={env.rootPointerDowns}
        exclusionZonesHud={env.exclusionZonesHud}
      />
    )
  }
  if (windowId === SHELL_UI_SETTINGS_WINDOW_ID) {
    return (
      <SettingsPanel
        screenDraft={env.screenDraft}
        setScreenDraft={env.setScreenDraft}
        shellChromePrimaryName={env.shellChromePrimaryName}
        autoShellChromeMonitorName={env.autoShellChromeMonitorName}
        canSessionControl={env.canSessionControl}
        uiScalePercent={env.uiScalePercent}
        tilingCfgRev={env.tilingCfgRev}
        setTilingCfgRev={env.setTilingCfgRev}
        clearMonitorTiles={env.clearMonitorTiles}
        bumpSnapChrome={() => env.bumpSnapChrome()}
        scheduleExclusionZonesSync={() => env.scheduleExclusionZonesSync()}
        applyAutoLayout={(name) => env.applyAutoLayout(name)}
        setShellPrimary={(name) => env.setShellPrimary(name)}
        setUiScale={(pct) => env.setUiScale(pct)}
        applyCompositorLayoutFromDraft={env.applyCompositorLayoutFromDraft}
        monitorRefreshLabel={env.monitorRefreshLabel}
        keyboardLayoutLabel={env.keyboardLayoutLabel}
        setDesktopBackgroundJson={(json) => env.setDesktopBackgroundJson(json)}
        sessionAutoSaveEnabled={env.sessionAutoSaveEnabled}
        setSessionAutoSaveEnabled={env.setSessionAutoSaveEnabled}
      />
    )
  }
  if (isShellTestWindowId(windowId)) {
    const window = env.allWindowsMap().get(windowId)
    return (
      <ShellTestWindowContent
        windowId={windowId}
        title={
          window?.title ||
          groupedWindowLabel({ window_id: windowId, title: '', app_id: SHELL_UI_TEST_APP_ID })
        }
      />
    )
  }
  if (isFileBrowserWindowId(windowId)) {
    return (
      <Show when={windowId} keyed>
        {(id) => (
          <FileBrowserWindow
            windowId={id}
            compositorAppState={() => env.shellHostedAppByWindow()[id] ?? null}
            shellWireSend={env.shellWireSend}
            onOpenFile={(path, context) => {
              if (isImageFilePath(path) && context.directory.length > 0) {
                env.onOpenImageFile({
                  path,
                  directory: context.directory,
                  showHidden: context.showHidden,
                })
                return
              }
              if (isVideoFilePath(path) && context.directory.length > 0) {
                env.onOpenVideoFile({
                  path,
                  directory: context.directory,
                  showHidden: context.showHidden,
                })
                return
              }
              if (isTextEditorFilePath(path) && context.directory.length > 0) {
                env.onOpenTextFile({
                  path,
                  directory: context.directory,
                  showHidden: context.showHidden,
                })
                return
              }
              env.reportShellActionIssue(`No viewer for this file type: ${path}`)
            }}
            onOpenInNewWindow={(path) => env.onOpenFileBrowserInNewWindow(path)}
          />
        )}
      </Show>
    )
  }
  if (isImageViewerWindowId(windowId)) {
    return (
      <Show when={windowId} keyed>
        {(id) => (
          <ImageViewerWindow
            windowId={id}
            compositorAppState={() => env.shellHostedAppByWindow()[id] ?? null}
            shellWireSend={env.shellWireSend}
            allWindowsMap={env.allWindowsMap}
          />
        )}
      </Show>
    )
  }
  if (isVideoViewerWindowId(windowId)) {
    return (
      <Show when={windowId} keyed>
        {(id) => (
          <VideoViewerWindow
            windowId={id}
            compositorAppState={() => env.shellHostedAppByWindow()[id] ?? null}
            shellWireSend={env.shellWireSend}
            allWindowsMap={env.allWindowsMap}
          />
        )}
      </Show>
    )
  }
  if (isTextEditorWindowId(windowId)) {
    return (
      <Show when={windowId} keyed>
        {(id) => (
          <TextEditorWindow
            windowId={id}
            compositorAppState={() => env.shellHostedAppByWindow()[id] ?? null}
            shellWireSend={env.shellWireSend}
            allWindowsMap={env.allWindowsMap}
          />
        )}
      </Show>
    )
  }
  return undefined
}
