import type { AssistGridSpan } from '@/features/tiling/assistGrid'
import { buildTaskbarGroupRows } from '@/features/taskbar/taskbarGroups'
import type { DerpWindow } from '@/host/appWindowState'
import type { CanvasOrigin } from '@/lib/shellCoords'
import type { WorkspaceGroupModel } from '@/features/workspace/workspaceSelectors'
import { buildE2eShellHtml, buildE2eShellSnapshot, type E2eRectSnapshot } from './e2eSnapshot'
import type { SessionSnapshot } from './sessionSnapshot'

type CanvasSize = {
  w: number
  h: number
}

type FloatingLayerLike = {
  id: string
  placement?: {
    gx: number
    gy: number
    gw: number
    gh: number
  } | null
}

type SnapAssistPickerLike = {
  windowId: number
  source: string
  monitorName: string | null
}

type SnapPreviewCanvasLike = {
  x: number
  y: number
  w: number
  h: number
}

type TabDragTargetLike = {
  windowId: number
  groupId: string
  insertIndex: number
}

type RegisterShellE2eBridgeOptions = {
  getMainRef: () => HTMLElement | null
  getViewport: () => unknown
  getOrigin: () => CanvasOrigin
  getCanvas: () => CanvasSize | null
  getWindows: () => DerpWindow[]
  getWorkspaceGroups: () => WorkspaceGroupModel[]
  getFocusedWindowId: () => number | null
  getKeyboardLayoutLabel: () => string | null
  getScreenshotMode: () => unknown
  getCrosshairCursor: () => boolean
  getProgramsMenuOpen: () => boolean
  getPowerMenuOpen: () => boolean
  getVolumeMenuOpen: () => boolean
  getDebugWindowVisible: () => boolean
  getSettingsWindowVisible: () => boolean
  getSnapAssistPicker: () => SnapAssistPickerLike | null
  getActiveSnapPreviewCanvas: () => SnapPreviewCanvasLike | null
  getAssistOverlayHoverSpan: () => AssistGridSpan | null
  getProgramsMenuQuery: () => string
  buildSessionSnapshot: () => SessionSnapshot
  getSessionRestoreActive: () => boolean
  getFloatingLayers: () => FloatingLayerLike[]
  getTabDragTarget: () => TabDragTargetLike | null
  projectCurrentMenuElementRect: (el: Element | null) => E2eRectSnapshot | null
  isWorkspaceWindowPinned: (windowId: number) => boolean
  openShellTestWindow: () => boolean
}

export function registerShellE2eBridge(options: RegisterShellE2eBridgeOptions) {
  function publishE2eShellSnapshot(requestId: number) {
    const send = window.__derpShellWireSend
    if (!send) return
    const workspaceGroups = options.getWorkspaceGroups()
    let sessionSnapshot: SessionSnapshot | null = null
    let sessionSnapshotError: string | null = null
    try {
      sessionSnapshot = options.buildSessionSnapshot()
    } catch (error) {
      sessionSnapshotError = error instanceof Error ? error.stack || error.message : String(error)
    }
    send(
      'e2e_snapshot_response',
      requestId,
      JSON.stringify(
        buildE2eShellSnapshot({
          document,
          viewport: options.getViewport(),
          main: options.getMainRef(),
          origin: options.getOrigin(),
          canvas: options.getCanvas(),
          windows: options.getWindows(),
          taskbarGroupRows: buildTaskbarGroupRows(workspaceGroups),
          workspaceGroups,
          focusedWindowId: options.getFocusedWindowId(),
          keyboardLayoutLabel: options.getKeyboardLayoutLabel(),
          screenshotMode: options.getScreenshotMode(),
          crosshairCursor: options.getCrosshairCursor(),
          programsMenuOpen: options.getProgramsMenuOpen(),
          powerMenuOpen: options.getPowerMenuOpen(),
          volumeMenuOpen: options.getVolumeMenuOpen(),
          debugWindowVisible: options.getDebugWindowVisible(),
          settingsWindowVisible: options.getSettingsWindowVisible(),
          snapAssistPicker: options.getSnapAssistPicker(),
          activeSnapPreviewCanvas: options.getActiveSnapPreviewCanvas(),
          assistOverlayHoverSpan: options.getAssistOverlayHoverSpan(),
          programsMenuQuery: options.getProgramsMenuQuery(),
          sessionSnapshot,
          sessionSnapshotError,
          sessionRestoreActive: options.getSessionRestoreActive(),
          floatingLayers: options.getFloatingLayers(),
          tabDragTarget: options.getTabDragTarget(),
          projectCurrentMenuElementRect: options.projectCurrentMenuElementRect,
          isWorkspaceWindowPinned: options.isWorkspaceWindowPinned,
        }),
      ),
    )
  }

  function publishE2eShellHtml(requestId: number, selector?: string | null) {
    const send = window.__derpShellWireSend
    if (!send) return
    send('e2e_html_response', requestId, buildE2eShellHtml(document, selector))
  }

  window.__DERP_E2E_REQUEST_SNAPSHOT = (requestId: number) => {
    publishE2eShellSnapshot(requestId)
  }
  window.__DERP_E2E_REQUEST_HTML = (requestId: number, selector?: string | null) => {
    publishE2eShellHtml(requestId, selector)
  }
  window.__DERP_E2E_OPEN_TEST_WINDOW = () => options.openShellTestWindow()

  return () => {
    delete window.__DERP_E2E_REQUEST_SNAPSHOT
    delete window.__DERP_E2E_REQUEST_HTML
    delete window.__DERP_E2E_OPEN_TEST_WINDOW
  }
}
