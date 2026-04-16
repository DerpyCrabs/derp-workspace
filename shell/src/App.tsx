import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  For,
  Show,
} from 'solid-js'
import { createStore } from 'solid-js/store'
import {
  CHROME_BORDER_PX,
  CHROME_TITLEBAR_PX,
  SHELL_LAYOUT_FLOATING,
  SHELL_LAYOUT_MAXIMIZED,
  SHELL_RESIZE_BOTTOM,
  SHELL_RESIZE_LEFT,
  SHELL_RESIZE_RIGHT,
  SHELL_RESIZE_TOP,
} from './chromeConstants'
import { ShellWindowFrame, type ShellWindowModel } from './ShellWindowFrame'
import {
  canvasRectToClientCss,
  clientPointToCanvasLocal,
  clientPointerDeltaToCanvasLogical,
  clientPointToGlobalLogical,
  findAdjacentMonitor,
  pickScreenForPointerSnap,
  pickScreenForWindow,
  rectCanvasLocalToGlobal,
  rectGlobalToCanvasLocal,
} from './shellCoords'
import { SettingsPanel } from './SettingsPanel'
import { defaultAudioDevice, useShellAudioState } from './settings/useShellAudioState'
import {
  type BackedWindowOpenPayload,
  backedShellWindowKind,
  buildBackedWindowOpenPayload,
  buildFileBrowserWindowOpenPayload,
  buildShellTestWindowOpenPayload,
  fileBrowserWindowId,
  fileBrowserWindowTitle,
  isFileBrowserWindowId,
  isShellTestWindowId,
  shellTestWindowId,
  shellTestWindowTitle,
  SHELL_UI_FILE_BROWSER_APP_ID,
  SHELL_UI_TEST_APP_ID,
} from './backedShellWindows'
import {
  flushShellUiWindowsSyncNow,
  invalidateAllShellUiWindows,
  registerShellUiWindow,
  SHELL_WINDOW_FLAG_SHELL_HOSTED,
  SHELL_UI_DEBUG_WINDOW_ID,
  SHELL_UI_SCREENSHOT_WINDOW_ID,
  SHELL_UI_SETTINGS_WINDOW_ID,
  type ShellUiMeasureEnv,
  shellUiWindowMeasureFromEnv,
} from './shellUiWindows'
import {
  type AssistGridShape,
  type AssistGridSpan,
  assistGridGutterPx,
  assistShapeFromSpan,
  assistSpanFromWorkAreaPoint,
  DEFAULT_ASSIST_GRID_SHAPE,
  snapZoneAndPreviewFromAssistSpan,
} from './assistGrid'
import { SnapAssistPicker } from './SnapAssistPicker'
import { hitTestSnapZoneGlobal, monitorWorkAreaGlobal, TILE_SNAP_EDGE_PX } from './tileSnap'
import {
  computeTiledResizeRects,
  findEdgeNeighborsInMap,
  TILE_RESIZE_EDGE_ALIGN_PX,
  TILED_RESIZE_MIN_H,
  TILED_RESIZE_MIN_W,
} from './tileState'
import {
  type SnapZone,
  snapZoneToBoundsWithOccupied,
  type Rect as TileRect,
} from './tileZones'
import { ShellFloatingProvider, type ShellFloatingRegistry } from './ShellFloatingContext'
import { createFloatingLayerStore } from './floatingLayers'
import { shellFloatingLayersWire } from './shellFloatingWire'
import { hideFloatingPlacementWire, pushShellFloatingWireFromDom } from './shellFloatingPlacement'
import { getMonitorLayout, loadTilingConfig, saveTilingConfig } from './tilingConfig'
import {
  fetchPortalScreencastRequestState,
  postShellJson,
  respondPortalScreencastRequest,
  spawnViaShellHttp,
} from './shellBridge'
import { shellHttpBase } from './shellHttp'
import { startThemeDomSync } from './themeDom'
import { refreshThemeSettingsFromRemote } from './themeStore'
import { ShellContextMenusProvider } from './app/ShellContextMenusContext'
import { createShellContextMenus, type TraySniMenuEntry } from './app/createShellContextMenus'
import { ShellContextMenuLayer } from './app/ShellContextMenuLayer'
import { ShellDebugHudContent } from './app/ShellDebugHudContent'
import { ShellSurfaceLayers } from './app/ShellSurfaceLayers'
import {
  formatMonitorPixels,
  layoutScreenCssRect,
  monitorRefreshLabel,
  physicalPixelsForScreen,
  screensListForLayout,
  shellBuildLabelText,
  shellMaximizedWorkAreaGlobalRect,
  unionBBoxFromScreens,
} from './app/appLayout'
import {
  coerceShellWindowId,
  type DerpShellDetail,
  type DerpWindow,
  windowIsShellHosted,
  windowOnMonitor,
  workspaceGroupWindowIds,
} from './app/appWindowState'
import { useDesktopApplicationsState } from './desktopApplicationsState'
import type { TaskbarSniItem } from './Taskbar'
import { FileBrowserWindow } from './FileBrowserWindow'
import { primeFileBrowserWindowPath } from './fileBrowserState'
import { matchNativeSessionWindow } from './nativeSessionMatch'
import {
  loadSessionSnapshot,
  nativeWindowRef,
  saveSessionSnapshot,
  sanitizeSessionSnapshot,
  shellWindowRef,
  type NativeLaunchMetadata,
  type SavedMonitorTileState,
  type SavedNativeWindow,
  type SavedRect,
  type SavedShellWindow,
  type SessionSnapshot,
  type SessionWindowRef,
} from './sessionSnapshot'
import {
  loadSessionPersistenceSettings,
  setSessionAutoSaveEnabled as persistSessionAutoSaveEnabled,
} from './sessionPersistenceSettings'
import {
  captureShellWindowState,
  primeShellWindowState,
  subscribeShellWindowState,
} from './shellWindowState'
import { ShellTestWindowContent } from './ShellTestWindowContent'
import { WorkspaceTabStrip } from './WorkspaceTabStrip'
import type {
  AssistOverlayState,
  ExclusionHudZone,
  LayoutScreen,
  SnapAssistPickerAnchorRect,
  SnapAssistPickerState,
  SnapAssistPickerSource,
  SnapAssistStripState,
} from './app/types'
import { Portal } from 'solid-js/web'
import { dispatchAudioStateChanged } from './audioEvents'
import {
  DERP_SHELL_EVENT,
  DERP_SHELL_SNAPSHOT_EVENT,
  installCompositorBatchHandler,
} from './compositorEvents'
import { compositorSnapshotAbi, decodeCompositorSnapshot } from './compositorSnapshot'
import { createCompositorModel } from './compositorModel'
import { createShellExclusionSync } from './shellExclusionSync'
import { createWorkspaceActions } from './workspaceActions'
import {
  findMergeTarget,
  splitLeftWindowId,
  windowLabel as groupedWindowLabel,
  type TabMergeTarget,
} from './tabGroupOps'
import { buildTaskbarGroupRows } from './taskbarGroups'
import {
  clampWorkspaceSplitPaneFraction,
  enterWorkspaceSplitView,
  exitWorkspaceSplitView,
  getWorkspaceGroupSplit,
  groupIdForWindow as workspaceStateGroupIdForWindow,
  isWorkspaceWindowPinned,
  moveWorkspaceWindowToGroup,
  reconcileWorkspaceState,
  setWorkspaceSplitFraction,
  setWorkspaceActiveTab,
  setWorkspaceWindowPinned,
  splitWorkspaceWindowToOwnGroup,
  workspaceFindMonitorForTiledWindow,
  workspaceGetPreTileGeometry,
  workspaceGetTiledZone,
  workspaceIsWindowTiled,
  workspaceMonitorTileEntries,
} from './workspaceState'
import { createWorkspaceSelectors, type WorkspaceGroupModel } from './workspaceSelectors'
import { buildE2eShellHtml, buildE2eShellSnapshot } from './e2eSnapshot'

declare global {
  interface Window {
    /** Injected by `cef_host` after load (`http://127.0.0.1:…/spawn`). */
    __DERP_SPAWN_URL?: string
    __DERP_SHELL_HTTP?: string
    __DERP_COMPOSITOR_SNAPSHOT_PATH?: string | null
    __DERP_COMPOSITOR_SNAPSHOT_ABI?: number
    __DERP_SHELL_EXCLUSION_STATE_PATH?: string | null
    __DERP_SHELL_UI_WINDOWS_STATE_PATH?: string | null
    __DERP_SHELL_FLOATING_LAYERS_STATE_PATH?: string | null
    __DERP_SHELL_SHARED_STATE_ABI?: number
    /** Registered by CEF render process: shell→compositor control (`move_delta` uses third arg as `dy`). */
    __derpShellWireSend?: (
      op:
        | 'close'
        | 'quit'
        | 'request_compositor_sync'
        | 'shell_ipc_pong'
        | 'spawn'
        | 'move_begin'
        | 'move_delta'
        | 'move_end'
        | 'resize_begin'
        | 'resize_delta'
        | 'resize_end'
        | 'resize_shell_grab_begin'
        | 'resize_shell_grab_end'
        | 'taskbar_activate'
        | 'activate_window'
        | 'shell_focus_ui_window'
        | 'shell_blur_ui_window'
        | 'shell_ui_grab_begin'
        | 'shell_ui_grab_end'
        | 'minimize'
        | 'set_geometry'
        | 'set_fullscreen'
        | 'set_maximized'
        | 'presentation_fullscreen'
        | 'set_output_layout'
        | 'set_shell_primary'
        | 'set_ui_scale'
        | 'set_tile_preview'
        | 'set_chrome_metrics'
        | 'set_desktop_background'
        | 'workspace_mutation'
        | 'context_menu'
        | 'backed_window_open'
        | 'e2e_snapshot_response'
        | 'e2e_html_response'
        | 'sni_tray_activate'
        | 'sni_tray_open_menu'
        | 'sni_tray_menu_event',
      arg?: number | string,
      arg2?: number | string,
      arg3?: number | string,
      arg4?: number | string,
      arg5?: number | string,
      arg6?: number | string,
    ) => void
    __derpShellSharedStateWrite?: (
      path: string,
      payload: ArrayBuffer,
      kind: number,
      abi?: number,
    ) => boolean
    __derpCompositorSnapshotVersion?: (path: string, abi?: number) => number | null
    __derpCompositorSnapshotRead?: (path: string, abi?: number) => ArrayBuffer | null
    __DERP_E2E_REQUEST_SNAPSHOT?: (requestId: number) => void
    __DERP_E2E_REQUEST_HTML?: (requestId: number, selector?: string | null) => void
    __DERP_E2E_OPEN_TEST_WINDOW?: () => boolean
  }
}

type ScreenshotSelectionState = {
  start: { x: number; y: number }
  current: { x: number; y: number }
  pointerId: number | null
}

const PORTAL_PICKER_PREVIEW_W = 520
const PORTAL_PICKER_PREVIEW_H = 260
const PORTAL_PICKER_PREVIEW_PAD = 16
const WORKSPACE_SPLIT_DIVIDER_PX = 4
const WORKSPACE_SPLIT_MIN_PANE_PX = 160
const WORKSPACE_SPLIT_MIN_HEIGHT_PX = 140

type TabDragState = {
  pointerId: number
  windowId: number
  sourceGroupId: string
  startClientX: number
  startClientY: number
  currentClientX: number
  currentClientY: number
  dragging: boolean
  detached: boolean
  target: TabMergeTarget | null
}

type SplitGroupRect = {
  x: number
  y: number
  width: number
  height: number
}

type SplitLayoutRects = {
  group: SplitGroupRect
  left: SplitGroupRect
  right: SplitGroupRect
  leftWindowId: number
  rightWindowIds: number[]
}

type SplitGroupGestureState = {
  pointerId: number
  groupId: string
  kind: 'divider' | 'move' | 'resize'
  edges: number
  startGlobalX: number
  startGlobalY: number
  originGroupRect: SplitGroupRect
}

function rectFromWindow(window: Pick<DerpWindow, 'x' | 'y' | 'width' | 'height'>): SavedRect {
  return {
    x: window.x,
    y: window.y,
    width: Math.max(1, window.width),
    height: Math.max(1, window.height),
  }
}

const floatBeforeMaximize = new Map<number, { x: number; y: number; w: number; h: number }>()
const dragPreTileSnapshot = new Map<number, { x: number; y: number; w: number; h: number }>()
let activeSnapPreviewCanvas: { x: number; y: number; w: number; h: number } | null = null
let activeSnapZone: SnapZone | null = null
let activeSnapScreen: LayoutScreen | null = null
let activeSnapWindowId: number | null = null
let tilePreviewRaf = 0
let lastTilePreviewKey = ''

type SnapAssistContext = {
  windowId: number
  screen: LayoutScreen
  workGlobal: { x: number; y: number; w: number; h: number }
  workCanvas: { x: number; y: number; w: number; h: number }
  shape: AssistGridShape
}

const TASKBAR_HEIGHT = 44
const SHELL_WIRE_DEGRADED_WITH_HTTP =
  'Shell wire is unavailable. Window controls stay limited until cef_host reconnects.'
const SHELL_WIRE_DEGRADED_NO_HTTP =
  'Shell bridge is unavailable. Window controls and session actions stay limited until cef_host reconnects.'

function shellWireIssueMessage(): string {
  return shellHttpBase() !== null ? SHELL_WIRE_DEGRADED_WITH_HTTP : SHELL_WIRE_DEGRADED_NO_HTTP
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Tee’d into `compositor.log` when `cef_host` stderr is captured (session). Filter: `derp-shell-move`. */
function shellMoveLog(msg: string, detail?: Record<string, unknown>) {
  const extra = detail !== undefined ? ` ${JSON.stringify(detail)}` : ''
  console.log(`[derp-shell-move] ${msg}${extra}`)
}

function shellWireSend(
  op:
    | 'close'
    | 'quit'
    | 'request_compositor_sync'
    | 'shell_ipc_pong'
    | 'spawn'
    | 'move_begin'
    | 'move_delta'
    | 'move_end'
    | 'resize_begin'
    | 'resize_delta'
    | 'resize_end'
    | 'resize_shell_grab_begin'
    | 'resize_shell_grab_end'
    | 'taskbar_activate'
    | 'activate_window'
    | 'shell_focus_ui_window'
    | 'shell_blur_ui_window'
    | 'shell_ui_grab_begin'
    | 'shell_ui_grab_end'
    | 'minimize'
    | 'set_geometry'
    | 'set_fullscreen'
    | 'set_maximized'
    | 'presentation_fullscreen'
    | 'set_output_layout'
    | 'set_shell_primary'
    | 'set_ui_scale'
    | 'set_tile_preview'
    | 'set_chrome_metrics'
    | 'set_desktop_background'
    | 'workspace_mutation'
    | 'backed_window_open'
    | 'sni_tray_activate'
    | 'sni_tray_open_menu'
    | 'sni_tray_menu_event',
  arg?: number | string,
  arg2?: number | string,
  arg3?: number,
  arg4?: number,
  arg5?: number,
  arg6?: number,
): boolean {
  const fn = window.__derpShellWireSend
  const hasWire = typeof fn === 'function'
  if (!hasWire) {
    if (
      op === 'move_begin' ||
      op === 'move_delta' ||
      op === 'move_end' ||
      op === 'resize_begin' ||
      op === 'resize_delta' ||
      op === 'resize_end' ||
      op === 'resize_shell_grab_begin' ||
      op === 'resize_shell_grab_end'
    ) {
      shellMoveLog('wire_missing', { op, arg, arg2 })
    }
    return false
  }
  if ((op === 'move_delta' || op === 'resize_delta') && arg2 !== undefined) {
    fn(op, arg as number, arg2)
  } else if (op === 'resize_begin' && arg2 !== undefined) {
    fn(op, arg as number, arg2)
  } else if (
    op === 'set_geometry' &&
    typeof arg === 'number' &&
    arg2 !== undefined &&
    arg3 !== undefined &&
    arg4 !== undefined &&
    arg5 !== undefined &&
    arg6 !== undefined
  ) {
    fn(op, arg, arg2, arg3, arg4, arg5, arg6)
  } else if (
    (op === 'set_fullscreen' || op === 'set_maximized') &&
    arg !== undefined &&
    arg2 !== undefined
  ) {
    fn(op, arg as number, arg2)
  } else if (
    op === 'quit' ||
    op === 'request_compositor_sync' ||
    op === 'shell_ipc_pong' ||
    op === 'resize_shell_grab_end'
  ) {
    fn(op)
  } else if (op === 'backed_window_open' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'set_output_layout' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'set_desktop_background' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'workspace_mutation' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'set_shell_primary' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'set_ui_scale' && typeof arg === 'number') {
    fn(op, arg)
  } else if (
    op === 'set_tile_preview' &&
    typeof arg === 'number' &&
    arg2 !== undefined &&
    arg3 !== undefined &&
    arg4 !== undefined &&
    arg5 !== undefined
  ) {
    fn(op, arg, arg2, arg3, arg4, arg5)
  } else if (op === 'set_chrome_metrics' && typeof arg === 'number' && arg2 !== undefined) {
    fn(op, arg, arg2)
  } else if (op === 'sni_tray_activate' && typeof arg === 'string') {
    fn(op, arg)
  } else if (op === 'sni_tray_open_menu' && typeof arg === 'string' && typeof arg2 === 'number') {
    fn(op, arg, arg2)
  } else if (
    op === 'sni_tray_menu_event' &&
    typeof arg === 'string' &&
    typeof arg2 === 'string' &&
    arg3 !== undefined
  ) {
    fn(op, arg, arg2, arg3)
  } else if (op === 'shell_blur_ui_window' || op === 'shell_ui_grab_end') {
    fn(op)
  } else {
    fn(op, arg)
  }
  return true
}

function canSessionControl(): boolean {
  return typeof window.__derpShellWireSend === 'function' || shellHttpBase() !== null
}

function App() {
  const shellBuildLabel = shellBuildLabelText()
  let traySniMenuNextSerial = 0
  const desktopApps = useDesktopApplicationsState()
  const {
    windows: compositorWindows,
    allWindowsMap: compositorWindowsMap,
    workspaceState,
    focusedWindowId,
    applyCompositorSnapshot: applyModelCompositorSnapshot,
    applyCompositorDetail: applyModelCompositorDetail,
  } = createCompositorModel()
  type WindowDraftPatch = Partial<
    Pick<DerpWindow, 'x' | 'y' | 'width' | 'height' | 'maximized' | 'output_name'>
  >
  const [windowDrafts, setWindowDrafts] = createSignal<Map<number, WindowDraftPatch>>(new Map())
  const allWindowsMap = createMemo(() => {
    const authoritative = compositorWindowsMap()
    const drafts = windowDrafts()
    if (drafts.size === 0) return authoritative
    let next: Map<number, DerpWindow> | null = null
    for (const [windowId, draft] of drafts) {
      const current = authoritative.get(windowId)
      if (!current) continue
      const merged = { ...current, ...draft }
      if (
        merged.x === current.x &&
        merged.y === current.y &&
        merged.width === current.width &&
        merged.height === current.height &&
        merged.maximized === current.maximized &&
        merged.output_name === current.output_name
      ) {
        continue
      }
      if (!next) next = new Map(authoritative)
      next.set(windowId, merged)
    }
    return next ?? authoritative
  })
  const windows = allWindowsMap
  const windowsListIds = createMemo(() => Array.from(allWindowsMap().keys()).sort((a, b) => a - b))
  const windowsList = createMemo(() => {
    const out: DerpWindow[] = []
    for (const windowId of windowsListIds()) {
      const window = allWindowsMap().get(windowId)
      if (window) out.push(window)
    }
    return out
  })
  createEffect(() => {
    const authoritative = compositorWindows()
    setWindowDrafts((prev) => {
      let next: Map<number, WindowDraftPatch> | null = null
      for (const [windowId, draft] of prev) {
        const current = authoritative.get(windowId)
        if (
          current &&
          draft.x === current.x &&
          draft.y === current.y &&
          draft.width === current.width &&
          draft.height === current.height &&
          draft.maximized === current.maximized &&
          draft.output_name === current.output_name
        ) {
          if (!next) next = new Map(prev)
          next.delete(windowId)
          continue
        }
        if (!current) {
          if (!next) next = new Map(prev)
          next.delete(windowId)
        }
      }
      return next ?? prev
    })
  })
  const patchWindowDrafts = (
    windowIds: readonly number[],
    buildPatch: (windowId: number, current: DerpWindow) => WindowDraftPatch,
  ) => {
    setWindowDrafts((prev) => {
      let next: Map<number, WindowDraftPatch> | null = null
      for (const windowId of windowIds) {
        const current = allWindowsMap().get(windowId)
        if (!current) continue
        const patch = buildPatch(windowId, current)
        const merged = {
          x: patch.x ?? current.x,
          y: patch.y ?? current.y,
          width: patch.width ?? current.width,
          height: patch.height ?? current.height,
          maximized: patch.maximized ?? current.maximized,
          output_name: patch.output_name ?? current.output_name,
        }
        if (
          merged.x === current.x &&
          merged.y === current.y &&
          merged.width === current.width &&
          merged.height === current.height &&
          merged.maximized === current.maximized &&
          merged.output_name === current.output_name
        ) {
          if (prev.has(windowId)) {
            if (!next) next = new Map(prev)
            next.delete(windowId)
          }
          continue
        }
        if (!next) next = new Map(prev)
        next.set(windowId, merged)
      }
      return next ?? prev
    })
  }
  const [rootPointerDowns, setRootPointerDowns] = createSignal(0)

  const [pointerClient, setPointerClient] = createSignal<{ x: number; y: number } | null>(null)
  const [pointerInMain, setPointerInMain] = createSignal<{ x: number; y: number } | null>(null)
  const [viewportCss, setViewportCss] = createSignal({
    w: typeof window !== 'undefined' ? window.innerWidth : 800,
    h: typeof window !== 'undefined' ? window.innerHeight : 600,
  })
  const [keyboardLayoutLabel, setKeyboardLayoutLabel] = createSignal<string | null>(null)
  const [volumeOverlay, setVolumeOverlay] = createSignal<{
    linear: number
    muted: boolean
    stateKnown: boolean
  } | null>(null)
  const [trayVolumeState, setTrayVolumeState] = createSignal<{
    muted: boolean
    volumePercent: number | null
  }>({
    muted: false,
    volumePercent: null,
  })
  const shellAudio = useShellAudioState()
  createEffect(() => {
    const sink = defaultAudioDevice(shellAudio.state()?.sinks ?? [])
    if (!sink) return
    setTrayVolumeState({
      muted: sink.muted,
      volumePercent: sink.volume_known ? sink.volume_percent : null,
    })
  })
  const volumeOverlayHud = createMemo(() => {
    const v = volumeOverlay()
    if (!v) return null
    const pct = Math.min(100, Math.round(v.linear / 100))
    const barPct = Math.min(100, pct)
    const main = mainRef
    const og = outputGeom()
    const co = layoutCanvasOrigin()
    const primary = workspacePartition().primary
    let pos: Record<string, string> = {
      left: '50%',
      bottom: 'max(5.5rem, 12vh)',
      transform: 'translateX(-50%)',
    }
    if (main && og && primary) {
      const loc = layoutScreenCssRect(primary, co)
      const gap = 12
      const cx = loc.x + loc.width / 2
      const cy = loc.y + loc.height - TASKBAR_HEIGHT - gap
      const pt = canvasRectToClientCss(cx, cy, 0, 0, main.getBoundingClientRect(), og.w, og.h)
      pos = {
        left: `${pt.left}px`,
        top: `${pt.top}px`,
        transform: 'translate(-50%, -100%)',
      }
    }
    const label = !v.stateKnown ? '—' : v.muted ? 'Muted' : `${pct}%`
    const fillPct = !v.stateKnown || v.muted ? 0 : barPct
    return (
      <div
        class="border border-(--shell-border) bg-(--shell-surface-panel) text-(--shell-text) pointer-events-none fixed z-470000 box-border w-[min(360px,90vw)] min-w-[240px] rounded-xl px-5 py-3.5"
        style={pos}
        role="status"
        aria-live="polite"
      >
        <div class="flex flex-col gap-2">
          <p class="m-0 flex h-7 items-center justify-center text-center text-[1.05rem] font-semibold tabular-nums text-(--shell-text)">
            {!v.stateKnown ? (
              <span class="text-[0.95rem] font-medium text-(--shell-text-muted)">
                Volume unavailable
              </span>
            ) : (
              label
            )}
          </p>
          <div class="h-2 w-full shrink-0 overflow-hidden rounded-full bg-(--shell-overlay-muted)">
            <div
              class="h-full rounded-full bg-(--shell-accent) transition-[width] duration-100 ease-out"
              style={{ width: `${fillPct}%` }}
            />
          </div>
        </div>
      </div>
    )
  })
  const [outputGeom, setOutputGeom] = createSignal<{ w: number; h: number } | null>(null)
  const [layoutCanvasOrigin, setLayoutCanvasOrigin] = createSignal<{ x: number; y: number } | null>(
    null,
  )
  const [screenDraft, setScreenDraft] = createStore<{ rows: LayoutScreen[] }>({ rows: [] })
  const [tilingCfgRev, setTilingCfgRev] = createSignal(0)
  const [orientationPickerOpen, setOrientationPickerOpen] = createSignal<number | null>(null)
  const [hudFps, setHudFps] = createSignal(0)
  const [crosshairCursor, setCrosshairCursor] = createSignal(false)
  const [screenshotMode, setScreenshotMode] = createSignal(false)
  const [screenshotSelection, setScreenshotSelection] = createSignal<ScreenshotSelectionState | null>(
    null,
  )
  const [portalPickerRequestId, setPortalPickerRequestId] = createSignal<number | null>(null)
  const [portalPickerTypes, setPortalPickerTypes] = createSignal<number | null>(null)
  const [portalPickerBusy, setPortalPickerBusy] = createSignal(false)
  const [exclusionZonesHud, setExclusionZonesHud] = createSignal<ExclusionHudZone[]>([])
  const [uiScalePercent, setUiScalePercent] = createSignal<100 | 150 | 200>(150)
  const [shellChromePrimaryName, setShellChromePrimaryName] = createSignal<string | null>(null)
  const [outputPhysical, setOutputPhysical] = createSignal<{ w: number; h: number } | null>(null)
  const [contextMenuAtlasBufferH, setContextMenuAtlasBufferH] = createSignal(1536)
  const [trayReservedPx, setTrayReservedPx] = createSignal(0)
  const [sniTrayItems, setSniTrayItems] = createSignal<TaskbarSniItem[]>([])
  const [trayIconSlotPx, setTrayIconSlotPx] = createSignal(40)
  const [snapChromeRev, setSnapChromeRev] = createSignal(0)
  const [assistOverlay, setAssistOverlay] = createSignal<AssistOverlayState | null>(null)
  const [snapAssistPicker, setSnapAssistPicker] = createSignal<SnapAssistPickerState | null>(null)
  const [dragWindowId, setDragWindowId] = createSignal<number | null>(null)
  const [tabDragState, setTabDragState] = createSignal<TabDragState | null>(null)
  const [splitGroupGesture, setSplitGroupGesture] = createSignal<SplitGroupGestureState | null>(null)
  const [suppressTabClickWindowId, setSuppressTabClickWindowId] = createSignal<number | null>(null)
  const [shellWireIssue, setShellWireIssue] = createSignal<string | null>(null)
  const [shellActionIssue, setShellActionIssue] = createSignal<string | null>(null)
  const [shellWireReadyRev, setShellWireReadyRev] = createSignal(0)
  const [shellWindowStateRev, setShellWindowStateRev] = createSignal(0)
  const [sessionAutoSaveEnabled, setSessionAutoSaveEnabled] = createSignal(loadSessionPersistenceSettings().autoSave)
  const [savedSessionAvailable, setSavedSessionAvailable] = createSignal(false)
  const [sessionPersistenceReady, setSessionPersistenceReady] = createSignal(false)
  const [sessionRestoreSnapshot, setSessionRestoreSnapshot] = createSignal<SessionSnapshot | null>(null)
  const [hasSeenCompositorWindowSync, setHasSeenCompositorWindowSync] = createSignal(false)
  const appliedSplitGroupLayoutKeys = new Map<string, string>()
  let windowSyncRecoveryPending = false
  let windowSyncRecoveryRequestedAt = 0
  const [nativeWindowRefs, setNativeWindowRefs] = createSignal<Map<number, SessionWindowRef>>(new Map())
  const [nextNativeWindowSeq, setNextNativeWindowSeq] = createSignal(1)
  const floatingLayers = createFloatingLayerStore()
  const [atlasOverlayPointerUsers, setAtlasOverlayPointerUsers] = createSignal(0)
  const nativeLaunchMetadataByRef = new Map<SessionWindowRef, NativeLaunchMetadata>()
  const pendingNativeLaunches: { windowRef: SessionWindowRef; launch: NativeLaunchMetadata }[] = []
  const pendingBackedWindowOpens = new Map<number, BackedWindowOpenPayload>()
  let backedWindowOpenRaf = 0
  const shellBridgeIssue = createMemo(() => shellActionIssue() ?? shellWireIssue())
  const portalPickerVisible = createMemo(() => portalPickerRequestId() !== null)
  let wireWatchPoll: ReturnType<typeof setInterval> | undefined
  let mainRef: HTMLElement | undefined
  let compositorFollowupQueued = false
  let compositorFollowupFlushWindows = false
  let compositorFollowupSyncExclusion = false
  let compositorFollowupRelayoutAll = false
  let compositorFollowupResetScroll = false
  const compositorFollowupRelayoutMonitors = new Set<string>()
  let sessionPersistTimer: ReturnType<typeof setTimeout> | undefined
  let sessionRestoreStopTimer: ReturnType<typeof setTimeout> | undefined
  let sessionPersistPoll: ReturnType<typeof setInterval> | undefined
  let sessionPersistGeneration = 0
  let lastPersistedSessionJson = ''
  let lastAppliedRestoreSignature = ''
  function setNativeWindowRef(windowId: number, windowRef: SessionWindowRef) {
    setNativeWindowRefs((prev) => {
      if (prev.get(windowId) === windowRef) return prev
      const next = new Map(prev)
      next.set(windowId, windowRef)
      return next
    })
  }
  function nativeWindowRefForId(windowId: number): SessionWindowRef | null {
    return nativeWindowRefs().get(windowId) ?? null
  }
  function assignNativeWindowRef(windowId: number): SessionWindowRef {
    const existing = nativeWindowRefForId(windowId)
    if (existing) return existing
    const nextRef = nativeWindowRef(nextNativeWindowSeq())
    setNextNativeWindowSeq((seq) => seq + 1)
    setNativeWindowRef(windowId, nextRef)
    return nextRef
  }
  function liveWindowIdForRef(windowRef: SessionWindowRef): number | null {
    if (windowRef.startsWith('shell:')) {
      const windowId = Number(windowRef.slice('shell:'.length))
      return allWindowsMap().has(windowId) ? windowId : null
    }
    for (const [windowId, ref] of nativeWindowRefs()) {
      if (ref === windowRef && allWindowsMap().has(windowId)) return windowId
    }
    return null
  }
  function savedWindowBoundsToLocalRect(bounds: SavedRect, outputName: string): SavedRect {
    const screens = taskbarScreens()
    const target = screens.find((screen) => screen.name === outputName) ?? screens[0] ?? null
    if (!target) return bounds
    const reserveTb = reserveTaskbarForMon(target)
    const work = monitorWorkAreaGlobal(target, reserveTb)
    const globalRect = rectCanvasLocalToGlobal(
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      layoutCanvasOrigin(),
    )
    const fitsOutput =
      outputName === target.name &&
      globalRect.x >= target.x &&
      globalRect.y >= target.y &&
      globalRect.x + globalRect.w <= target.x + target.width &&
      globalRect.y + globalRect.h <= target.y + target.height
    if (fitsOutput) return bounds
    const width = Math.max(1, Math.min(bounds.width, work.w))
    const height = Math.max(1, Math.min(bounds.height, work.h))
    const x = work.x + Math.max(0, Math.floor((work.w - width) / 2))
    const y = work.y + Math.max(0, Math.floor((work.h - height) / 2))
    const local = rectGlobalToCanvasLocal(x, y, width, height, layoutCanvasOrigin())
    return { x: local.x, y: local.y, width: local.w, height: local.h }
  }
  function restoreBackedShellWindow(record: SavedShellWindow) {
    const current = allWindowsMap().get(record.windowId)
    if (current) {
      if (record.state !== null) primeShellWindowState(record.windowId, record.state)
      return
    }
    const kind = backedShellWindowKind(record.windowId, record.appId)
    if (!kind) return
    if (record.state !== null) primeShellWindowState(record.windowId, record.state)
    const bounds = savedWindowBoundsToLocalRect(record.bounds, record.outputName)
    shellWireSend(
      'backed_window_open',
      JSON.stringify({
        window_id: record.windowId,
        title: record.title,
        app_id: record.appId,
        output_name: record.outputName,
        x: bounds.x,
        y: bounds.y,
        w: bounds.width,
        h: bounds.height,
      }),
    )
  }
  function assignPendingNativeLaunch(windowId: number): SessionWindowRef | null {
    const nextLaunch = pendingNativeLaunches.shift() ?? null
    if (!nextLaunch) return null
    nativeLaunchMetadataByRef.set(nextLaunch.windowRef, nextLaunch.launch)
    setNativeWindowRef(windowId, nextLaunch.windowRef)
    return nextLaunch.windowRef
  }
  function tryAssignRestoredNativeWindow(windowId: number) {
    const window = allWindowsMap().get(windowId)
    if (!window || windowIsShellHosted(window)) return
    if (nativeWindowRefForId(windowId)) return
    const assignedRefs = new Set(Array.from(nativeWindowRefs().values()))
    const snapshot = sessionRestoreSnapshot()
    if (snapshot) {
      const match = matchNativeSessionWindow(
        {
          title: window.title,
          appId: window.app_id,
          outputName: window.output_name,
          maximized: window.maximized,
          fullscreen: window.fullscreen,
        },
        snapshot.nativeWindows,
        assignedRefs,
      )
      if (match) {
        if (match.launch) nativeLaunchMetadataByRef.set(match.windowRef, match.launch)
        setNativeWindowRef(windowId, match.windowRef)
        return
      }
    }
    if (assignPendingNativeLaunch(windowId)) return
    assignNativeWindowRef(windowId)
  }
  function restoreWindowModes(snapshot: SessionSnapshot) {
    const windowsById = allWindowsMap()
    for (const record of snapshot.shellWindows) {
      const live = windowsById.get(record.windowId)
      if (!live) continue
      if (record.minimized && !live.minimized) shellWireSend('minimize', live.window_id)
      if (!record.minimized && record.maximized !== live.maximized) {
        shellWireSend('set_maximized', live.window_id, record.maximized ? 1 : 0)
      }
      if (!record.minimized && record.fullscreen !== live.fullscreen) {
        shellWireSend('set_fullscreen', live.window_id, record.fullscreen ? 1 : 0)
      }
    }
    for (const record of snapshot.nativeWindows) {
      const liveWindowId = liveWindowIdForRef(record.windowRef)
      if (liveWindowId === null) continue
      const live = windowsById.get(liveWindowId)
      if (!live) continue
      if (record.minimized && !live.minimized) shellWireSend('minimize', liveWindowId)
      if (!record.minimized && record.maximized !== live.maximized) {
        shellWireSend('set_maximized', liveWindowId, record.maximized ? 1 : 0)
      }
      if (!record.minimized && record.fullscreen !== live.fullscreen) {
        shellWireSend('set_fullscreen', liveWindowId, record.fullscreen ? 1 : 0)
      }
    }
  }
  function applyRestoredWorkspace(snapshot: SessionSnapshot) {
    const groups = snapshot.workspace.groups
      .map((group) => {
        const windowIds = group.windowRefs
          .map((windowRef) => liveWindowIdForRef(windowRef))
          .filter((windowId): windowId is number => windowId !== null)
        if (windowIds.length === 0) return null
        const activeWindowId =
          (group.activeWindowRef ? liveWindowIdForRef(group.activeWindowRef) : null) ?? windowIds[0]
        const splitLeftWindowId =
          group.splitLeftWindowRef !== null ? liveWindowIdForRef(group.splitLeftWindowRef) : null
        return {
          id: group.id,
          windowIds,
          activeWindowId,
          splitLeftWindowId:
            splitLeftWindowId !== null && windowIds.includes(splitLeftWindowId) ? splitLeftWindowId : null,
          leftPaneFraction: group.leftPaneFraction,
        }
      })
      .filter(
        (
          group,
        ): group is {
          id: string
          windowIds: number[]
          activeWindowId: number
          splitLeftWindowId: number | null
          leftPaneFraction: number | null
        } => group !== null,
      )
    const pinnedWindowIds = snapshot.workspace.pinnedWindowRefs
      .map((windowRef) => liveWindowIdForRef(windowRef))
      .filter((windowId): windowId is number => windowId !== null)
    let planned = reconcileWorkspaceState(workspaceState(), windowsListIds())
    const restoredWindowIds = new Set(groups.flatMap((group) => group.windowIds))
    const desiredGroupByWindowId = new Map<number, string>()
    for (const group of groups) {
      for (const windowId of group.windowIds) desiredGroupByWindowId.set(windowId, group.id)
    }
    for (const windowId of [...planned.pinnedWindowIds]) {
      if (!restoredWindowIds.has(windowId)) continue
      planned = setWorkspaceWindowPinned(planned, windowId, false)
    }

    for (const group of groups) {
      const anchorWindowId = group.windowIds[0]
      const sourceGroupId = workspaceStateGroupIdForWindow(planned, anchorWindowId)
      const currentGroupId = sourceGroupId ?? null
      const currentGroup = currentGroupId
        ? planned.groups.find((entry) => entry.id === currentGroupId) ?? null
        : null
      const needsOwnGroup =
        !currentGroup ||
        currentGroup.windowIds.length !== 1 ||
        currentGroup.windowIds[0] !== anchorWindowId ||
        currentGroup.windowIds.some((windowId) => desiredGroupByWindowId.get(windowId) !== group.id)
      if (needsOwnGroup) {
        planned = splitWorkspaceWindowToOwnGroup(planned, anchorWindowId)
      }
      let targetGroupId = planned.groups.find((entry) => entry.windowIds[0] === anchorWindowId)?.id ?? null
      if (!targetGroupId) continue
      for (let index = 1; index < group.windowIds.length; index += 1) {
        const windowId = group.windowIds[index]
        const targetGroup = planned.groups.find((entry) => entry.id === targetGroupId) ?? null
        const sameGroup = workspaceStateGroupIdForWindow(planned, windowId) === targetGroupId
        const sameIndex = targetGroup?.windowIds[index] === windowId
        if (!sameGroup || !sameIndex) {
          planned = moveWorkspaceWindowToGroup(planned, windowId, targetGroupId, index)
          targetGroupId = planned.groups.find((entry) => entry.windowIds.includes(anchorWindowId))?.id ?? targetGroupId
        }
      }
      const split = getWorkspaceGroupSplit(planned, targetGroupId)
      if (group.splitLeftWindowId !== null) {
        if (!split || split.leftWindowId !== group.splitLeftWindowId) {
          const leftPaneFraction = group.leftPaneFraction ?? 0.5
          planned = enterWorkspaceSplitView(planned, targetGroupId, group.splitLeftWindowId, leftPaneFraction)
        } else if (split.leftPaneFraction !== (group.leftPaneFraction ?? 0.5)) {
          const leftPaneFraction = group.leftPaneFraction ?? 0.5
          planned = setWorkspaceSplitFraction(planned, targetGroupId, leftPaneFraction)
        }
      } else if (split) {
        planned = exitWorkspaceSplitView(planned, targetGroupId)
      }
      const normalizedActiveWindowId =
        planned.groups.find((entry) => entry.id === targetGroupId)?.windowIds.includes(group.activeWindowId)
          ? setWorkspaceActiveTab(planned, targetGroupId, group.activeWindowId).activeTabByGroupId[targetGroupId]
          : planned.activeTabByGroupId[targetGroupId]
      if (normalizedActiveWindowId !== planned.activeTabByGroupId[targetGroupId]) {
        planned = setWorkspaceActiveTab(planned, targetGroupId, group.activeWindowId)
      }
    }

    const desiredPinned = new Set(pinnedWindowIds)
    for (const windowId of restoredWindowIds) {
      const pinned = desiredPinned.has(windowId)
      if (isWorkspaceWindowPinned(planned, windowId) === pinned) continue
      planned = setWorkspaceWindowPinned(planned, windowId, pinned)
    }
    planned = {
      ...planned,
      monitorTiles: [],
      preTileGeometry: [],
    }
    if (!sendWorkspaceMutation({ type: 'replace_state', state: planned })) return

    const screens = taskbarScreens()
    const co = layoutCanvasOrigin()
    for (const entry of snapshot.preTileGeometry) {
      const windowId = liveWindowIdForRef(entry.windowRef)
      if (windowId === null) continue
      if (
        !sendSetPreTileGeometry(windowId, {
          x: entry.bounds.x,
          y: entry.bounds.y,
          w: entry.bounds.width,
          h: entry.bounds.height,
        })
      ) {
        return
      }
    }
    if (screens.length > 0 && co) {
      for (const monitorState of snapshot.monitorTiles) {
        const targetMonitor =
          screens.find((screen) => screen.name === monitorState.outputName) ?? screens[0] ?? null
        if (!targetMonitor) continue
        const resolvedEntries = monitorState.entries
          .map((entry) => {
            const windowId = liveWindowIdForRef(entry.windowRef)
            if (windowId === null) return null
            return { windowId, zone: entry.zone, bounds: entry.bounds }
          })
          .filter((entry): entry is { windowId: number; zone: SnapZone; bounds: SavedRect } => entry !== null)
        if (resolvedEntries.length === 0) continue
        const { layout, params } = getMonitorLayout(targetMonitor.name)
        let boundsByWindowId = new Map<number, SavedRect>()
        if (layout.type === 'manual-snap') {
          boundsByWindowId = new Map(resolvedEntries.map((entry) => [entry.windowId, entry.bounds]))
        } else {
          const reserveTb = reserveTaskbarForMon(targetMonitor)
          const work = monitorWorkAreaGlobal(targetMonitor, reserveTb)
          const rects = layout.computeLayout(
            resolvedEntries.map((entry) => entry.windowId),
            { x: work.x, y: work.y, width: work.w, height: work.h },
            params,
          )
          boundsByWindowId = new Map(
            Array.from(rects.entries()).map(([windowId, rect]) => [
              windowId,
              { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            ]),
          )
        }
        for (const entry of resolvedEntries) {
          const bounds = boundsByWindowId.get(entry.windowId) ?? entry.bounds
          if (
            !sendSetMonitorTile(entry.windowId, targetMonitor.name, entry.zone, {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
            })
          ) {
            return
          }
          const local = rectGlobalToCanvasLocal(
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            co,
          )
          shellWireSend(
            'set_geometry',
            entry.windowId,
            local.x,
            local.y,
            local.w,
            local.h,
            SHELL_LAYOUT_FLOATING,
          )
        }
      }
    }
    bumpSnapChrome()
    scheduleExclusionZonesSync()
  }
  function sessionSnapshotHasData(snapshot: SessionSnapshot): boolean {
    return (
      snapshot.shellWindows.length > 0 ||
      snapshot.nativeWindows.length > 0 ||
      snapshot.workspace.groups.length > 0 ||
      snapshot.monitorTiles.length > 0 ||
      snapshot.preTileGeometry.length > 0
    )
  }
  function sessionAutoSaveReady() {
    return sessionAutoSaveEnabled() && sessionPersistenceReady() && !sessionRestoreSnapshot()
  }
  async function persistLiveSessionSnapshotSoon(mode: 'auto' | 'manual' = 'auto', generation = sessionPersistGeneration) {
    if (mode === 'auto' && (!sessionAutoSaveReady() || generation !== sessionPersistGeneration)) return
    let snapshot: SessionSnapshot
    let json: string
    try {
      snapshot = sanitizeSessionSnapshot(buildSessionSnapshot())
      if (!sessionSnapshotHasData(snapshot) && savedSessionAvailable() && !hasSeenCompositorWindowSync()) {
        return
      }
      json = JSON.stringify(snapshot)
    } catch (error) {
      console.warn('[derp-shell-session] build failed', error)
      return
    }
    if (mode === 'auto' && (!sessionAutoSaveReady() || generation !== sessionPersistGeneration)) return
    if (json === lastPersistedSessionJson) return
    try {
      if (mode === 'auto' && (!sessionAutoSaveReady() || generation !== sessionPersistGeneration)) return
      await saveSessionSnapshot(snapshot)
      lastPersistedSessionJson = json
      setSavedSessionAvailable(sessionSnapshotHasData(snapshot))
    } catch (error) {
      console.warn('[derp-shell-session] persist failed', error)
    }
  }
  function closeAllAtlasSelects(): boolean {
    return floatingLayers.closeByKind('select')
  }
  function acquireAtlasOverlayPointer() {
    setAtlasOverlayPointerUsers((n) => n + 1)
  }
  function releaseAtlasOverlayPointer() {
    setAtlasOverlayPointerUsers((n) => Math.max(0, n - 1))
  }

  function reportShellWireIssue(message: string) {
    console.warn(`[derp-shell-bridge] ${message}`)
    setShellWireIssue((current) => (current === message ? current : message))
  }

  function clearShellWireIssue() {
    setShellWireIssue(null)
  }

  function reportShellActionIssue(message: string) {
    console.warn(`[derp-shell-bridge] ${message}`)
    setShellActionIssue((current) => (current === message ? current : message))
  }

  function clearShellActionIssue() {
    setShellActionIssue(null)
  }

  async function postShell(path: string, body: object): Promise<void> {
    await postShellJson(path, body, shellHttpBase())
  }

  async function postSessionPower(action: string): Promise<void> {
    try {
      await postShell('/session_power', { action })
      clearShellActionIssue()
    } catch (error) {
      reportShellActionIssue(`Power action failed: ${describeError(error)}`)
      throw error
    }
  }

  function updateSessionAutoSavePreference(enabled: boolean) {
    persistSessionAutoSaveEnabled(enabled)
    setSessionAutoSaveEnabled(enabled)
  }

  async function saveCurrentSessionSnapshot() {
    try {
      const snapshot = sanitizeSessionSnapshot(buildSessionSnapshot())
      await saveSessionSnapshot(snapshot)
      lastPersistedSessionJson = JSON.stringify(snapshot)
      setSavedSessionAvailable(sessionSnapshotHasData(snapshot))
      clearShellActionIssue()
    } catch (error) {
      reportShellActionIssue(`Save workspace failed: ${describeError(error)}`)
    }
  }

  async function restoreSavedSessionSnapshot() {
    try {
      const snapshot = await loadSessionSnapshot()
      if (!sessionSnapshotHasData(snapshot)) {
        reportShellActionIssue('Restore workspace failed: no saved workspace snapshot is available.')
        return
      }
      setSavedSessionAvailable(true)
      await startSessionRestore(snapshot)
      clearShellActionIssue()
    } catch (error) {
      reportShellActionIssue(`Restore workspace failed: ${describeError(error)}`)
    }
  }

  const screenshotSelectionRect = createMemo(() => {
    if (!screenshotMode()) return null
    const sel = screenshotSelection()
    if (!sel) return null
    const x1 = Math.min(sel.start.x, sel.current.x)
    const y1 = Math.min(sel.start.y, sel.current.y)
    const x2 = Math.max(sel.start.x, sel.current.x)
    const y2 = Math.max(sel.start.y, sel.current.y)
    return {
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
    }
  })

  function screenshotShellUiEnv(): ShellUiMeasureEnv | null {
    const main = mainRef
    const og = outputGeom()
    const co = layoutCanvasOrigin()
    if (!main || !og || !co) return null
    return {
      main,
      outputGeom: { w: og.w, h: og.h },
      origin: co,
    }
  }

  function screenshotPointFromClient(clientX: number, clientY: number) {
    const main = mainRef
    const og = outputGeom()
    if (!main || !og) return null
    return clientPointToGlobalLogical(
      clientX,
      clientY,
      main.getBoundingClientRect(),
      og.w,
      og.h,
      layoutCanvasOrigin(),
    )
  }

  function shellPointerGlobalLogical(clientX: number, clientY: number) {
    const main = mainRef
    const og = outputGeom()
    if (!main || !og) return null
    const mainRect = main.getBoundingClientRect()
    if (
      clientX < mainRect.left ||
      clientX > mainRect.right ||
      clientY < mainRect.top ||
      clientY > mainRect.bottom
    ) {
      return { x: Math.round(clientX), y: Math.round(clientY) }
    }
    return clientPointToGlobalLogical(
      clientX,
      clientY,
      mainRect,
      og.w,
      og.h,
      layoutCanvasOrigin(),
    )
  }

  function stopScreenshotMode() {
    setScreenshotSelection(null)
    setScreenshotMode(false)
    setCrosshairCursor(false)
    shellWireSend('shell_ui_grab_end')
    shellWireSend('shell_blur_ui_window')
  }

  function closePortalPickerUi() {
    if (!portalPickerVisible()) return
    setPortalPickerBusy(false)
    setPortalPickerRequestId(null)
    setPortalPickerTypes(null)
    hideFloatingPlacementWire()
  }

  function beginPortalPicker(requestId: number, types: number | null) {
    if (portalPickerRequestId() === requestId) return
    if (screenshotMode()) stopScreenshotMode()
    shellContextMenus.hideContextMenu()
    closeAllAtlasSelects()
    clearShellActionIssue()
    setPortalPickerBusy(false)
    setPortalPickerRequestId(requestId)
    setPortalPickerTypes(types)
  }

  async function resolvePortalPicker(selection: string | null) {
    const requestId = portalPickerRequestId()
    if (requestId === null || portalPickerBusy()) return
    setPortalPickerBusy(true)
    try {
      await respondPortalScreencastRequest(requestId, selection, shellHttpBase())
      closePortalPickerUi()
      clearShellActionIssue()
    } catch (error) {
      setPortalPickerBusy(false)
      reportShellActionIssue(`Screen share picker failed: ${describeError(error)}`)
    }
  }

  function waitForAnimationFrame() {
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
  }

  function beginScreenshotMode() {
    shellContextMenus.hideContextMenu()
    closeAllAtlasSelects()
    clearShellActionIssue()
    setScreenshotSelection(null)
    setScreenshotMode(true)
    setCrosshairCursor(true)
    queueMicrotask(() => {
      flushShellUiWindowsSyncNow()
      focusShellUiWindow(SHELL_UI_SCREENSHOT_WINDOW_ID)
    })
  }

  async function submitScreenshotRegion(bounds: { x: number; y: number; width: number; height: number }) {
    try {
      stopScreenshotMode()
      await waitForAnimationFrame()
      flushShellUiWindowsSyncNow()
      await waitForAnimationFrame()
      await waitForAnimationFrame()
      await postShell('/screenshot_region', bounds)
      clearShellActionIssue()
    } catch (error) {
      reportShellActionIssue(`Screenshot failed: ${describeError(error)}`)
    }
  }

  const canvasCss = createMemo(() => {
    const g = outputGeom()
    const v = viewportCss()
    const w = Math.max(1, g?.w ?? v.w ?? 1)
    const h = Math.max(1, g?.h ?? v.h ?? 1)
    return { w, h }
  })

  const shellContextMenus = createShellContextMenus({
    floatingLayers,
    mainEl: () => mainRef,
    outputGeom,
    outputPhysical,
    layoutCanvasOrigin,
    screenDraftRows: () => screenDraft.rows,
    shellChromePrimaryName,
    viewportCss,
    canvasCss,
    contextMenuAtlasBufferH,
    screenshotMode,
    stopScreenshotMode,
    closeAllAtlasSelects,
    openFileBrowser: (path) => openFileBrowserWindow(path),
    spawnInCompositor,
    saveSessionSnapshot: () => void saveCurrentSessionSnapshot(),
    restoreSessionSnapshot: () => void restoreSavedSessionSnapshot(),
    canSaveSessionSnapshot: () => shellHttpBase() !== null && !sessionRestoreSnapshot(),
    canRestoreSessionSnapshot: () =>
      shellHttpBase() !== null && savedSessionAvailable() && !sessionRestoreSnapshot(),
    postSessionPower,
    canSessionControl,
    exitSession: () => {
      if (shellWireSend('quit')) {
        clearShellActionIssue()
        return
      }
      void postShell('/session_quit', {}).then(clearShellActionIssue).catch((error) => {
        reportShellActionIssue(`Exit session failed: ${describeError(error)}`)
      })
    },
    tabMenuItems: (windowId: number) => {
      const groupId = workspaceGroupIdForWindow(windowId)
      const split = groupId ? getWorkspaceGroupSplit(workspaceState(), groupId) : undefined
      const pinned = isWorkspaceWindowPinned(workspaceState(), windowId)
      const items = [
        {
          actionId: pinned ? 'unpin' : 'pin',
          label: pinned ? 'Unpin tab' : 'Pin tab',
          action: () => {
            setSuppressTabClickWindowId(null)
            shellWireSend(
              'workspace_mutation',
              JSON.stringify({
                type: 'set_window_pinned',
                windowId,
                pinned: !pinned,
              }),
            )
          },
        },
      ]
      if (groupId && !split && (workspaceGroupsById().get(groupId)?.members.length ?? 0) >= 2) {
        items.push({
          actionId: 'use-split-left',
          label: 'Use as split left tab',
          action: () => {
            setSuppressTabClickWindowId(null)
            if (!enterSplitGroupWindow(windowId)) return
            queueMicrotask(() => {
              applySplitGroupGeometry(groupId)
            })
          },
        })
      }
      if (groupId && split?.leftWindowId === windowId) {
        items.push({
          actionId: 'exit-split',
          label: 'Exit split view',
          action: () => {
            setSuppressTabClickWindowId(null)
            exitSplitGroupWindow(windowId)
          },
        })
      }
      return items
    },
    tabMenuWindowAvailable: (windowId: number) => {
      return allWindowsMap().has(windowId) && workspaceGroupIdForWindow(windowId) !== null
    },
    onTraySniMenuPick: (notifierId, menuPath, dbusmenuId) => {
      shellWireSend('sni_tray_menu_event', notifierId, menuPath, dbusmenuId)
    },
  })

  createEffect(() => {
    void shellWireReadyRev()
    const allLayers = floatingLayers.layers()
    const layers = allLayers
      .filter((layer) => layer.placement)
      .map((layer) => ({
        id: layer.order >>> 0,
        z: layer.order,
        ...layer.placement!,
      }))
    if (layers.length === 0) {
      if (allLayers.length > 0) return
      if (!portalPickerVisible()) hideFloatingPlacementWire()
      return
    }
    shellFloatingLayersWire(layers)
  })

  createEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failureCount = 0
    const nextDelay = (pending: boolean) => {
      if (pending) return 150
      if (failureCount <= 0) return 500
      return Math.min(3000, 500 * 2 ** Math.min(3, failureCount - 1))
    }
    const poll = async () => {
      const base = shellHttpBase()
      if (!base) {
        failureCount = Math.min(4, failureCount + 1)
        if (!cancelled) timer = setTimeout(() => void poll(), nextDelay(false))
        return
      }
      try {
        const state = await fetchPortalScreencastRequestState(base)
        if (cancelled) return
        failureCount = 0
        if (state.pending) beginPortalPicker(state.request_id, state.types)
        else closePortalPickerUi()
      } catch (error) {
        failureCount = Math.min(4, failureCount + 1)
        if (!cancelled && portalPickerVisible()) {
          closePortalPickerUi()
          reportShellActionIssue(`Screen share picker failed: ${describeError(error)}`)
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), nextDelay(portalPickerVisible()))
      }
    }
    void poll()
    onCleanup(() => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    })
  })

  const workspacePartition = createMemo(() => {
    const rows = screenDraft.rows
    const g = outputGeom()
    const v = viewportCss()
    const cw = Math.max(1, g?.w ?? v.w ?? 1)
    const ch = Math.max(1, g?.h ?? v.h ?? 1)
    if (rows.length === 0) {
      const single: LayoutScreen = {
        name: '',
        x: 0,
        y: 0,
        width: cw,
        height: ch,
        transform: 0,
        refresh_milli_hz: 0,
      }
      return { primary: single, secondary: [] as LayoutScreen[] }
    }
    const explicit = shellChromePrimaryName()
    if (explicit) {
      const ei = rows.findIndex((r) => r.name === explicit)
      if (ei >= 0) {
        const primary = rows[ei]
        const secondary = rows.filter((_, i) => i !== ei)
        return { primary, secondary }
      }
    }
    let pi = 0
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i]
      const b = rows[pi]
      if (a.x < b.x || (a.x === b.x && a.y < b.y)) pi = i
    }
    const primary = rows[pi]
    const secondary = rows.filter((_, i) => i !== pi)
    return { primary, secondary }
  })

  const layoutUnionBbox = createMemo(() => unionBBoxFromScreens(screenDraft.rows))

  const autoShellChromeMonitorName = createMemo(() => {
    const rows = screenDraft.rows
    if (rows.length === 0) return null
    let pi = 0
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i]
      const b = rows[pi]
      if (a.x < b.x || (a.x === b.x && a.y < b.y)) pi = i
    }
    return rows[pi]?.name ?? null
  })

  const panelHostForHud = createMemo(() => {
    if (screenDraft.rows.length === 0) return null
    return workspacePartition().primary
  })

  const debugHudFrameVisible = createMemo(() => {
    const w = windows().get(SHELL_UI_DEBUG_WINDOW_ID)
    return !!w && !w.minimized
  })

  const settingsHudFrameVisible = createMemo(() => {
    const w = windows().get(SHELL_UI_SETTINGS_WINDOW_ID)
    return !!w && !w.minimized
  })

  createEffect(() => {
    if (!debugHudFrameVisible()) {
      setHudFps(0)
      return
    }
    let hudFpsFrames = 0
    let hudFpsLast = performance.now()
    let hudFpsRaf = 0
    const hudFpsStep = (now: number) => {
      hudFpsFrames += 1
      const dt = now - hudFpsLast
      if (dt >= 500) {
        setHudFps(Math.round((hudFpsFrames * 1000) / dt))
        hudFpsFrames = 0
        hudFpsLast = now
      }
      hudFpsRaf = requestAnimationFrame(hudFpsStep)
    }
    hudFpsRaf = requestAnimationFrame(hudFpsStep)
    onCleanup(() => cancelAnimationFrame(hudFpsRaf))
  })

  const fallbackMonitorName = createMemo(() => {
    const part = workspacePartition()
    return part.primary.name || screenDraft.rows.find((row) => row.name)?.name || ''
  })

  createEffect(() => {
    const list = windowsList()
    const liveIds = new Set(list.map((window) => window.window_id))
    for (const window of list) {
      if (windowIsShellHosted(window)) continue
      if (!nativeWindowRefForId(window.window_id)) {
        tryAssignRestoredNativeWindow(window.window_id)
      }
    }
    setNativeWindowRefs((prev) => {
      let next: Map<number, SessionWindowRef> | null = null
      for (const [windowId] of prev) {
        if (liveIds.has(windowId)) continue
        if (!next) next = new Map(prev)
        next.delete(windowId)
      }
      return next ?? prev
    })
  })

  createEffect(() => {
    const snapshot = sessionRestoreSnapshot()
    windows()
    nativeWindowRefs()
    taskbarScreens()
    layoutCanvasOrigin()
    tilingCfgRev()
    if (!snapshot) return
    const signature = JSON.stringify({
      shellWindowIds: snapshot.shellWindows.map((window) => window.windowId).filter((windowId) => allWindowsMap().has(windowId)),
      nativeWindowRefs: snapshot.nativeWindows.map((window) => ({
        windowRef: window.windowRef,
        liveWindowId: liveWindowIdForRef(window.windowRef),
      })),
      outputs: taskbarScreens().map((screen) => screen.name),
      tilingCfgRev: tilingCfgRev(),
    })
    if (signature === lastAppliedRestoreSignature) return
    lastAppliedRestoreSignature = signature
    restoreWindowModes(snapshot)
    applyRestoredWorkspace(snapshot)
  })

  createEffect(() => {
    const snapshot = sessionRestoreSnapshot()
    windows()
    nativeWindowRefs()
    if (!snapshot) return
    if (!sessionRestoreIsComplete(snapshot)) return
    stopSessionRestore()
  })

  createEffect(() => {
    sessionAutoSaveEnabled()
    sessionPersistenceReady()
    sessionRestoreSnapshot()
    windows()
    workspaceState()
    nativeWindowRefs()
    tilingCfgRev()
    shellWindowStateRev()
    if (!sessionAutoSaveReady()) {
      if (sessionPersistTimer !== undefined) {
        clearTimeout(sessionPersistTimer)
        sessionPersistTimer = undefined
      }
      sessionPersistGeneration += 1
      return
    }
    if (sessionPersistTimer !== undefined) clearTimeout(sessionPersistTimer)
    const generation = sessionPersistGeneration
    sessionPersistTimer = setTimeout(() => {
      void persistLiveSessionSnapshotSoon('auto', generation)
    }, 150)
  })
  const {
    workspaceGroups,
    workspaceGroupsById,
    groupIdForWindow: workspaceGroupIdForWindow,
    groupForWindow: workspaceGroupForWindow,
    activeWorkspaceGroupId,
    focusedTaskbarWindowId,
    windowsByMonitor,
    taskbarRowsByMonitor,
  } = createWorkspaceSelectors({
    workspaceState,
    windowsById: allWindowsMap,
    windowsList,
    focusedWindowId,
    fallbackMonitorKey: fallbackMonitorName,
    desktopApps: desktopApps.items,
  })

  const dragSnapAssistContext = createMemo(() => {
    const windowId = dragWindowId()
    if (windowId == null) return null
    return resolveSnapAssistContext(windowId)
  })

  const snapStripState = createMemo<SnapAssistStripState | null>(() => {
    const context = dragSnapAssistContext()
    if (!context) return null
    return {
      monitorName: context.screen.name,
      open: snapAssistPicker()?.source === 'strip' && snapAssistPicker()?.windowId === context.windowId,
    }
  })

  createEffect(() => {
    const picker = snapAssistPicker()
    if (!picker) return
    const context = resolveSnapAssistContext(picker.windowId, picker.monitorName)
    if (!context) {
      closeSnapAssistPicker()
    }
  })

  function publishE2eShellSnapshot(requestId: number) {
    const send = window.__derpShellWireSend
    if (!send) return
    const origin = layoutCanvasOrigin()
    const logicalCanvas = layoutUnionBbox()
    const canvas = logicalCanvas ? { w: logicalCanvas.w, h: logicalCanvas.h } : outputGeom()
    const currentWindows = windowsList()
    const currentWorkspaceGroups = workspaceGroups()
    let sessionSnapshot: SessionSnapshot | null = null
    let sessionSnapshotError: string | null = null
    try {
      sessionSnapshot = buildSessionSnapshot()
    } catch (error) {
      sessionSnapshotError = error instanceof Error ? error.stack || error.message : String(error)
    }
    send(
      'e2e_snapshot_response',
      requestId,
      JSON.stringify(
        buildE2eShellSnapshot({
          document,
          viewport: viewportCss(),
          main: mainRef ?? null,
          origin,
          canvas,
          windows: currentWindows,
          taskbarGroupRows: buildTaskbarGroupRows(currentWorkspaceGroups),
          workspaceGroups: currentWorkspaceGroups,
          focusedWindowId: focusedWindowId(),
          keyboardLayoutLabel: keyboardLayoutLabel(),
          screenshotMode: screenshotMode(),
          crosshairCursor: crosshairCursor(),
          programsMenuOpen: shellContextMenus.programsMenuOpen(),
          powerMenuOpen: shellContextMenus.powerMenuOpen(),
          volumeMenuOpen: shellContextMenus.volumeMenuOpen(),
          debugWindowVisible: debugHudFrameVisible(),
          settingsWindowVisible: settingsHudFrameVisible(),
          snapAssistPicker: snapAssistPicker(),
          activeSnapPreviewCanvas,
          assistOverlayHoverSpan: assistOverlay()?.hoverSpan ?? null,
          programsMenuQuery: shellContextMenus.programsMenuProps.query(),
          sessionSnapshot,
          sessionSnapshotError,
          sessionRestoreActive: sessionRestoreSnapshot() !== null,
          floatingLayers: floatingLayers.layers(),
          tabDragTarget: tabDragState()?.target
            ? {
                windowId: tabDragState()!.windowId,
                groupId: tabDragState()!.target!.groupId,
                insertIndex: tabDragState()!.target!.insertIndex,
              }
            : null,
          projectCurrentMenuElementRect: shellContextMenus.projectCurrentMenuElementRect,
          isWorkspaceWindowPinned: (windowId: number) => isWorkspaceWindowPinned(workspaceState(), windowId),
        }),
      ),
    )
  }

  function publishE2eShellHtml(requestId: number, selector?: string | null) {
    const send = window.__derpShellWireSend
    if (!send) return
    send('e2e_html_response', requestId, buildE2eShellHtml(document, selector))
  }

  function splitLayoutForGroup(
    group: WorkspaceGroupModel,
    overrideGroupRect?: SplitGroupRect,
  ): SplitLayoutRects | null {
    if (!group.splitLeftWindow || group.splitPaneFraction === null) return null
    const stateGroup = workspaceState().groups.find((entry) => entry.id === group.id)
    if (!stateGroup) return null
    const rightWindowIds = stateGroup.windowIds.filter((windowId) => windowId !== group.splitLeftWindowId)
    if (rightWindowIds.length === 0) return null
    const leftWindow = group.splitLeftWindow
    const rightWindow = group.visibleWindow
    const overlapping =
      leftWindow.x === rightWindow.x &&
      leftWindow.y === rightWindow.y &&
      leftWindow.width === rightWindow.width &&
      leftWindow.height === rightWindow.height
    const groupRect =
      overrideGroupRect ??
      (overlapping
        ? rectFromWindow(rightWindow)
        : {
            x: Math.min(leftWindow.x, rightWindow.x),
            y: Math.min(leftWindow.y, rightWindow.y),
            width: Math.max(leftWindow.x + leftWindow.width, rightWindow.x + rightWindow.width) - Math.min(leftWindow.x, rightWindow.x),
            height: Math.max(leftWindow.y + leftWindow.height, rightWindow.y + rightWindow.height) - Math.min(leftWindow.y, rightWindow.y),
          })
    const contentWidth = Math.max(2 * WORKSPACE_SPLIT_MIN_PANE_PX, groupRect.width)
    const leftWidth = Math.max(
      WORKSPACE_SPLIT_MIN_PANE_PX,
      Math.min(
        contentWidth - WORKSPACE_SPLIT_MIN_PANE_PX,
        Math.round(contentWidth * clampWorkspaceSplitPaneFraction(group.splitPaneFraction)),
      ),
    )
    const rightWidth = Math.max(WORKSPACE_SPLIT_MIN_PANE_PX, contentWidth - leftWidth)
    return {
      group: {
        x: groupRect.x,
        y: groupRect.y,
        width: leftWidth + rightWidth,
        height: Math.max(WORKSPACE_SPLIT_MIN_HEIGHT_PX, groupRect.height),
      },
      left: {
        x: groupRect.x,
        y: groupRect.y,
        width: leftWidth,
        height: Math.max(WORKSPACE_SPLIT_MIN_HEIGHT_PX, groupRect.height),
      },
      right: {
        x: groupRect.x + leftWidth,
        y: groupRect.y,
        width: rightWidth,
        height: Math.max(WORKSPACE_SPLIT_MIN_HEIGHT_PX, groupRect.height),
      },
      leftWindowId: group.splitLeftWindowId!,
      rightWindowIds,
    }
  }

  function applySplitGroupGeometry(groupId: string, overrideGroupRect?: SplitGroupRect) {
    const group = workspaceGroupsById().get(groupId)
    if (!group) return null
    const layout = splitLayoutForGroup(group, overrideGroupRect)
    if (!layout) return null
    for (const windowId of [layout.leftWindowId, ...layout.rightWindowIds]) {
      const rect = windowId === layout.leftWindowId ? layout.left : layout.right
      shellWireSend(
        'set_geometry',
        windowId,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        SHELL_LAYOUT_FLOATING,
      )
    }
    const leftWindow = allWindowsMap().get(layout.leftWindowId)
    const rightWindow = allWindowsMap().get(group.visibleWindowId)
    if (leftWindow?.minimized) shellWireSend('taskbar_activate', layout.leftWindowId)
    if (rightWindow?.minimized) queueMicrotask(() => activateTaskbarWindowViaShell(group.visibleWindowId))
    return layout
  }

  function requestWindowSyncRecovery() {
    const now = Date.now()
    if (windowSyncRecoveryPending && now - windowSyncRecoveryRequestedAt < 1000) return
    if (!shellWireSend('request_compositor_sync')) return
    windowSyncRecoveryPending = true
    windowSyncRecoveryRequestedAt = now
  }

  function focusShellUiWindow(windowId: number) {
    shellWireSend('shell_focus_ui_window', windowId)
  }

  function activateTaskbarWindowViaShell(windowId: number) {
    shellWireSend('taskbar_activate', windowId)
  }

  function activateWindowViaShell(windowId: number) {
    shellWireSend('activate_window', windowId)
  }

  function moveWindowUnderPointer(windowId: number, clientX: number, clientY: number) {
    const window = allWindowsMap().get(windowId)
    const global = shellPointerGlobalLogical(clientX, clientY)
    if (!window || !global) return false
    const nextX = Math.round(global.x - window.width / 2)
    const nextY = Math.round(global.y + CHROME_TITLEBAR_PX / 2)
    shellWireSend(
      'set_geometry',
      windowId,
      nextX,
      nextY,
      window.width,
      window.height,
      SHELL_LAYOUT_FLOATING,
    )
    patchWindowDrafts(workspaceGroupWindowIds(workspaceState(), windowId), () => ({
      x: nextX,
      y: nextY,
      maximized: false,
    }))
    return true
  }

  function findTabMergeTargetFromPointer(
    windowId: number,
    clientX: number,
    clientY: number,
    ignoreDraggedWindowFrame: boolean,
  ) {
    const state = workspaceState()
    const direct = findMergeTarget(state, windowId, clientX, clientY, ignoreDraggedWindowFrame)
    if (direct) return direct
    const main = mainRef
    const og = outputGeom()
    if (!main || !og) return null
    const { x: globalX, y: globalY } = shellPointerGlobalLogical(clientX, clientY) ?? {
      x: Math.round(clientX),
      y: Math.round(clientY),
    }
    const origin = layoutCanvasOrigin()
    const client = canvasRectToClientCss(
      globalX - (origin?.x ?? 0),
      globalY - (origin?.y ?? 0),
      0,
      0,
      main.getBoundingClientRect(),
      og.w,
      og.h,
    )
    return findMergeTarget(state, windowId, client.left, client.top, ignoreDraggedWindowFrame)
  }

  function refreshTabDragTarget(pointerId: number) {
    setTabDragState((current) => {
      if (!current || current.pointerId !== pointerId || !current.dragging || current.detached) return current
      const ignoreDraggedWindowFrame =
        current.detached || (workspaceGroupsById().get(current.sourceGroupId)?.members.length ?? 0) <= 1
      const nextTarget = findTabMergeTargetFromPointer(
        current.windowId,
        current.currentClientX,
        current.currentClientY,
        ignoreDraggedWindowFrame,
      )
      if (
        current.target?.groupId === nextTarget?.groupId &&
        current.target?.insertIndex === nextTarget?.insertIndex
      ) {
        return current
      }
      return {
        ...current,
        target: nextTarget,
      }
    })
  }

  const {
    focusWindowViaShell,
    applyTabDrop,
    detachGroupWindow,
    selectGroupWindow,
    closeGroupWindow,
    cycleFocusedWorkspaceGroup,
    activateTaskbarGroup,
    enterSplitGroupWindow,
    exitSplitGroupWindow,
    setSplitGroupFraction,
  } = createWorkspaceActions({
    workspaceState,
    allWindowsMap,
    workspaceGroups,
    workspaceGroupsById,
    activeWorkspaceGroupId,
    focusedWindowId,
    focusedTaskbarWindowId,
    groupIdForWindow: workspaceGroupIdForWindow,
    groupForWindow: workspaceGroupForWindow,
    focusShellUiWindow,
    activateWindowViaShell,
    activateTaskbarWindowViaShell,
    moveWindowUnderPointer,
    shellWireSend,
  })

  function startTabPointerGesture(
    windowId: number,
    pointerId: number,
    clientX: number,
    clientY: number,
    button: number,
  ) {
    if (button !== 0) return
    const sourceGroupId = workspaceGroupIdForWindow(windowId)
    if (!sourceGroupId) return
    if (splitLeftWindowId(workspaceState(), sourceGroupId) === windowId) return
    shellContextMenus.hideContextMenu()
    setSuppressTabClickWindowId(null)
    setTabDragState({
      pointerId,
      windowId,
      sourceGroupId,
      startClientX: clientX,
      startClientY: clientY,
      currentClientX: clientX,
      currentClientY: clientY,
      dragging: false,
      detached: false,
      target: null,
    })
  }

  function finishTabPointerGesture(pointerId: number, clientX: number, clientY: number) {
    const drag = tabDragState()
    if (!drag || drag.pointerId !== pointerId) return
    const dragDistance = Math.hypot(clientX - drag.startClientX, clientY - drag.startClientY)
    const dragging = drag.dragging || dragDistance >= 40
    const ignoreDraggedWindowFrame =
      drag.detached || (workspaceGroupsById().get(drag.sourceGroupId)?.members.length ?? 0) <= 1
    const nextTarget = dragging
      ? findTabMergeTargetFromPointer(drag.windowId, clientX, clientY, ignoreDraggedWindowFrame) ?? drag.target
      : drag.target
    const merged = dragging && nextTarget ? applyTabDrop(drag.windowId, nextTarget) : false
    const clickTarget = !dragging
      ? (document
          .elementsFromPoint(clientX, clientY)
          .find(
            (element) =>
              element instanceof HTMLElement &&
              element.closest(`[data-workspace-tab="${drag.windowId}"]`),
          ) ?? null)
      : null
    const changed = merged || drag.detached
    if (changed) {
      setTabDragState(null)
      setSuppressTabClickWindowId(drag.windowId)
      return
    }
    if (clickTarget) {
      setTabDragState(null)
      setSuppressTabClickWindowId(drag.windowId)
      selectGroupWindow(drag.windowId)
      return
    }
    queueMicrotask(() => {
      setTabDragState((current) => (current?.pointerId === pointerId ? null : current))
    })
  }

  function renderShellWindowContent(windowId: number) {
    if (windowId === SHELL_UI_DEBUG_WINDOW_ID) {
      return (
        <ShellDebugHudContent
          onReload={() => location.reload()}
          onCopySnapshot={copyDebugHudSnapshot}
          shellBuildLabel={shellBuildLabel}
          hudFps={hudFps}
          crosshairCursor={crosshairCursor}
          setCrosshairCursor={setCrosshairCursor}
          outputGeom={outputGeom}
          layoutUnionBbox={layoutUnionBbox}
          layoutCanvasOrigin={layoutCanvasOrigin}
          panelHostForHud={panelHostForHud}
          shellChromePrimaryName={shellChromePrimaryName}
          viewportCss={viewportCss}
          windowsCount={() => windowsList().length}
          pointerClient={pointerClient}
          pointerInMain={pointerInMain}
          rootPointerDowns={rootPointerDowns}
          exclusionZonesHud={exclusionZonesHud}
        />
      )
    }
    if (windowId === SHELL_UI_SETTINGS_WINDOW_ID) {
      return (
        <SettingsPanel
          screenDraft={screenDraft}
          setScreenDraft={setScreenDraft}
          shellChromePrimaryName={shellChromePrimaryName}
          autoShellChromeMonitorName={autoShellChromeMonitorName}
          canSessionControl={canSessionControl}
          uiScalePercent={uiScalePercent}
          orientationPickerOpen={orientationPickerOpen}
          setOrientationPickerOpen={setOrientationPickerOpen}
          tilingCfgRev={tilingCfgRev}
          setTilingCfgRev={setTilingCfgRev}
          clearMonitorTiles={clearMonitorTiles}
          bumpSnapChrome={() => bumpSnapChrome()}
          scheduleExclusionZonesSync={() => scheduleExclusionZonesSync()}
          applyAutoLayout={(name) => applyAutoLayout(name)}
          setShellPrimary={(name) => shellWireSend('set_shell_primary', name)}
          setUiScale={(pct) => shellWireSend('set_ui_scale', pct)}
          applyCompositorLayoutFromDraft={() => {
            const screens = screenDraft.rows.map((r) => ({
              name: r.name,
              x: r.x,
              y: r.y,
              transform: r.transform,
            }))
            shellWireSend('set_output_layout', JSON.stringify({ screens }))
          }}
          monitorRefreshLabel={monitorRefreshLabel}
          keyboardLayoutLabel={keyboardLayoutLabel}
          setDesktopBackgroundJson={(json) => shellWireSend('set_desktop_background', json)}
          sessionAutoSaveEnabled={sessionAutoSaveEnabled}
          setSessionAutoSaveEnabled={updateSessionAutoSavePreference}
        />
      )
    }
    if (isShellTestWindowId(windowId)) {
      const window = allWindowsMap().get(windowId)
      return <ShellTestWindowContent windowId={windowId} title={window?.title || groupedWindowLabel({ window_id: windowId, title: '', app_id: SHELL_UI_TEST_APP_ID })} />
    }
    if (isFileBrowserWindowId(windowId)) {
      return (
        <FileBrowserWindow
          windowId={windowId}
          onOpenFile={(path) => {
            reportShellActionIssue(`File viewers land in a later phase: ${path}`)
          }}
        />
      )
    }
    return undefined
  }

  createEffect(() => {
    const activeSplitGesture = splitGroupGesture()
    const nextKeys = new Map<string, string>()
    for (const group of workspaceGroups()) {
      if (group.splitLeftWindowId === null || group.splitPaneFraction === null) continue
      if (activeSplitGesture?.groupId === group.id) continue
      const key = `${group.splitLeftWindowId}:${group.visibleWindowId}:${group.splitPaneFraction}`
      nextKeys.set(group.id, key)
      if (appliedSplitGroupLayoutKeys.get(group.id) === key) continue
      queueMicrotask(() => {
        applySplitGroupGeometry(group.id)
      })
    }
    appliedSplitGroupLayoutKeys.clear()
    for (const [groupId, key] of nextKeys) appliedSplitGroupLayoutKeys.set(groupId, key)
  })

  function beginSplitGroupGesture(
    groupId: string,
    pointerId: number,
    kind: SplitGroupGestureState['kind'],
    edges: number,
    clientX: number,
    clientY: number,
  ) {
    if (splitGroupGesture()) return false
    const group = workspaceGroupsById().get(groupId)
    if (!group) return false
    const layout = splitLayoutForGroup(group)
    const global = shellPointerGlobalLogical(clientX, clientY)
    if (!layout || !global) return false
    setSplitGroupGesture({
      pointerId,
      groupId,
      kind,
      edges,
      startGlobalX: global.x,
      startGlobalY: global.y,
      originGroupRect: layout.group,
    })
    shellWireSend('shell_ui_grab_begin', SHELL_UI_SETTINGS_WINDOW_ID)
    return true
  }

  function updateSplitGroupGesture(pointerId: number, clientX: number, clientY: number) {
    const gesture = splitGroupGesture()
    if (!gesture || gesture.pointerId !== pointerId) return
    const global = shellPointerGlobalLogical(clientX, clientY)
    if (!global) return
    if (gesture.kind === 'divider') {
      const group = workspaceGroupsById().get(gesture.groupId)
      if (!group) return
      const relativeX = Math.max(
        0,
        Math.min(gesture.originGroupRect.width, global.x - gesture.originGroupRect.x),
      )
      const fraction = clampWorkspaceSplitPaneFraction(relativeX / Math.max(1, gesture.originGroupRect.width))
      setSplitGroupFraction(gesture.groupId, fraction)
      applySplitGroupGeometry(gesture.groupId, gesture.originGroupRect)
      return
    }
    const dx = global.x - gesture.startGlobalX
    const dy = global.y - gesture.startGlobalY
    let nextRect = { ...gesture.originGroupRect }
    if (gesture.kind === 'move') {
      nextRect = {
        ...nextRect,
        x: gesture.originGroupRect.x + dx,
        y: gesture.originGroupRect.y + dy,
      }
    } else {
      if ((gesture.edges & SHELL_RESIZE_LEFT) !== 0) {
        const maxLeft = gesture.originGroupRect.x + gesture.originGroupRect.width - 2 * WORKSPACE_SPLIT_MIN_PANE_PX
        const nextX = Math.min(gesture.originGroupRect.x + dx, maxLeft)
        nextRect.x = nextX
        nextRect.width = gesture.originGroupRect.width + (gesture.originGroupRect.x - nextX)
      }
      if ((gesture.edges & SHELL_RESIZE_RIGHT) !== 0) {
        nextRect.width = Math.max(
          2 * WORKSPACE_SPLIT_MIN_PANE_PX,
          gesture.originGroupRect.width + dx,
        )
      }
      if ((gesture.edges & SHELL_RESIZE_BOTTOM) !== 0) {
        nextRect.height = Math.max(WORKSPACE_SPLIT_MIN_HEIGHT_PX, gesture.originGroupRect.height + dy)
      }
    }
    applySplitGroupGeometry(gesture.groupId, nextRect)
  }

  function endSplitGroupGesture(pointerId: number) {
    const gesture = splitGroupGesture()
    if (!gesture || gesture.pointerId !== pointerId) return
    setSplitGroupGesture(null)
    shellWireSend('shell_ui_grab_end')
  }

  const onTabDragPointerMove = (event: PointerEvent) => {
    const prev = tabDragState()
    if (!prev || prev.pointerId !== event.pointerId) return
    const dx = event.clientX - prev.startClientX
    const dy = event.clientY - prev.startClientY
    const dragging = prev.dragging || Math.hypot(dx, dy) >= 40
    const ignoreDraggedWindowFrame =
      prev.detached || (workspaceGroupsById().get(prev.sourceGroupId)?.members.length ?? 0) <= 1
    const target = dragging
      ? findTabMergeTargetFromPointer(prev.windowId, event.clientX, event.clientY, ignoreDraggedWindowFrame)
      : null
    let detached = prev.detached
    if (dragging && !detached && target === null && Math.abs(dy) >= 64) {
      detached = detachGroupWindow(prev.windowId, event.clientX, event.clientY)
    } else if (dragging && detached) {
      moveWindowUnderPointer(prev.windowId, event.clientX, event.clientY)
    }
    setTabDragState({
      ...prev,
      currentClientX: event.clientX,
      currentClientY: event.clientY,
      dragging,
      detached,
      target,
    })
  }
  const onTabDragPointerUp = (event: PointerEvent) => {
    finishTabPointerGesture(event.pointerId, event.clientX, event.clientY)
  }
  const onTabDragPointerCancel = (event: PointerEvent) => {
    const prev = tabDragState()
    if (!prev || prev.pointerId !== event.pointerId) return
    setTabDragState(null)
  }
  const onSplitGroupPointerMove = (event: PointerEvent) => {
    updateSplitGroupGesture(event.pointerId, event.clientX, event.clientY)
  }
  const onSplitGroupPointerUp = (event: PointerEvent) => {
    endSplitGroupGesture(event.pointerId)
  }
  const onSplitGroupPointerCancel = (event: PointerEvent) => {
    endSplitGroupGesture(event.pointerId)
  }
  createEffect(() => {
    const drag = tabDragState()
    if (!drag?.dragging || drag.detached) return
    let frame = 0
    const update = () => {
      refreshTabDragTarget(drag.pointerId)
      const current = tabDragState()
      if (!current || current.pointerId !== drag.pointerId || !current.dragging || current.detached) return
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    onCleanup(() => cancelAnimationFrame(frame))
  })
  document.addEventListener('pointermove', onTabDragPointerMove, true)
  document.addEventListener('pointerup', onTabDragPointerUp, true)
  document.addEventListener('pointercancel', onTabDragPointerCancel, true)
  document.addEventListener('pointermove', onSplitGroupPointerMove, true)
  document.addEventListener('pointerup', onSplitGroupPointerUp, true)
  document.addEventListener('pointercancel', onSplitGroupPointerCancel, true)
  onCleanup(() => {
    document.removeEventListener('pointermove', onTabDragPointerMove, true)
    document.removeEventListener('pointerup', onTabDragPointerUp, true)
    document.removeEventListener('pointercancel', onTabDragPointerCancel, true)
    document.removeEventListener('pointermove', onSplitGroupPointerMove, true)
    document.removeEventListener('pointerup', onSplitGroupPointerUp, true)
    document.removeEventListener('pointercancel', onSplitGroupPointerCancel, true)
  })

  function WorkspaceGroupFrame(props: { groupId: string }) {
    const group = createMemo(() => workspaceGroupsById().get(props.groupId) ?? null)
    const visibleWindowId = createMemo(() => group()?.visibleWindowId ?? null)
    const splitLayout = createMemo(() => {
      const currentGroup = group()
      return currentGroup ? splitLayoutForGroup(currentGroup) : null
    })
    const frameModel = createMemo((): ShellWindowModel | undefined => {
      const currentVisibleWindowId = visibleWindowId()
      if (currentVisibleWindowId == null) return undefined
      const r = allWindowsMap().get(currentVisibleWindowId)
      if (!r || r.minimized) return undefined
      const split = splitLayout()
      if (!split) return { ...r, snap_tiled: workspaceIsWindowTiled(workspaceState(), r.window_id) }
      return {
        ...r,
        x: split.group.x,
        y: split.group.y,
        width: split.group.width,
        height: split.group.height,
        maximized: false,
        fullscreen: false,
        snap_tiled: false,
      }
    })
    const stackZ = createMemo(() => {
      const currentVisibleWindowId = visibleWindowId()
      return currentVisibleWindowId == null ? 0 : (allWindowsMap().get(currentVisibleWindowId)?.stack_z ?? 0)
    })
    const rowFocused = createMemo(() => activeWorkspaceGroupId() === props.groupId)
    const deskShellUiReg = createMemo(() => {
      stackZ()
      outputGeom()
      layoutCanvasOrigin()
      return {
        id: visibleWindowId() ?? 0,
        z: stackZ(),
        getEnv: (): ShellUiMeasureEnv | null => {
          const main = mainRef
          const og = outputGeom()
          const co = layoutCanvasOrigin()
          if (!main || !og || !co) return null
          return {
            main,
            outputGeom: { w: og.w, h: og.h },
            origin: co,
          }
        },
      }
    })
    const selectTab = (windowId: number) => {
      const changed = selectGroupWindow(windowId)
      if (!changed) return
      if ((group()?.splitLeftWindowId ?? null) === windowId) return
      if (splitLayout()) {
        queueMicrotask(() => {
          applySplitGroupGeometry(props.groupId)
        })
      }
    }
    const renderSplitPane = (
      windowId: number,
      rect: SplitGroupRect,
      testId: string,
      extraAttrs: Record<string, string>,
    ) => {
      const window = allWindowsMap().get(windowId)
      const shellHosted = !!window && (window.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) !== 0
      return (
        <div
          data-testid={testId}
          {...extraAttrs}
          class="pointer-events-none fixed box-border"
          style={{
            left: `${rect.x}px`,
            top: `${rect.y}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            'z-index': 1005 + stackZ(),
          }}
        >
          <Show when={shellHosted}>
            <div
              class="pointer-events-auto h-full min-h-0 min-w-0 overflow-auto bg-(--shell-surface-inset) text-(--shell-text)"
              onPointerDown={() => {
                selectGroupWindow(windowId)
              }}
            >
              {renderShellWindowContent(windowId)}
            </div>
          </Show>
        </div>
      )
    }
    return (
      <Show when={frameModel()} fallback={null}>
        <ShellWindowFrame
          win={frameModel}
          repaintKey={snapChromeRev}
          stackZ={stackZ}
          focused={rowFocused}
          shellUiRegister={splitLayout() ? undefined : deskShellUiReg()}
          tabStrip={
            group() ? (
              <WorkspaceTabStrip
                groupId={props.groupId}
                tabs={group()!.members.map((member) => ({
                  window_id: member.window_id,
                  title: member.title,
                  app_id: member.app_id,
                  active: member.window_id === group()!.visibleWindowId,
                  pinned: isWorkspaceWindowPinned(workspaceState(), member.window_id),
                }))}
                splitLeftWindowId={group()!.splitLeftWindowId}
                dragWindowId={tabDragState()?.windowId ?? null}
                dropTarget={tabDragState()?.target ?? null}
                suppressClickWindowId={suppressTabClickWindowId()}
                onSelectTab={selectTab}
                onConsumeSuppressedClick={(windowId) => {
                  if (suppressTabClickWindowId() === windowId) setSuppressTabClickWindowId(null)
                }}
                onCloseTab={closeGroupWindow}
                onTabPointerDown={startTabPointerGesture}
                onTabContextMenu={(windowId, clientX, clientY) => {
                  shellContextMenus.openTabMenu(windowId, clientX, clientY)
                }}
              />
            ) : undefined
          }
          onFocusRequest={() => {
            const currentVisibleWindowId =
              group()?.members.some((member) => member.window_id === focusedWindowId())
                ? focusedWindowId()
                : visibleWindowId()
            if (currentVisibleWindowId == null) return
            const window = allWindowsMap().get(currentVisibleWindowId)
            if (!window) return
            if ((window.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) !== 0) {
              focusShellUiWindow(currentVisibleWindowId)
              return
            }
            if (!rowFocused()) {
              activateTaskbarWindowViaShell(currentVisibleWindowId)
            }
          }}
          onTitlebarPointerDown={(pointerId, cx, cy) => {
            if (splitLayout() && beginSplitGroupGesture(props.groupId, pointerId, 'move', 0, cx, cy)) return
            const currentVisibleWindowId = visibleWindowId()
            if (currentVisibleWindowId != null) beginShellWindowMove(currentVisibleWindowId, cx, cy)
          }}
          onSnapAssistOpen={(anchorRect) => {
            const currentVisibleWindowId = visibleWindowId()
            if (currentVisibleWindowId == null) return
            focusWindowViaShell(currentVisibleWindowId)
            openSnapAssistPicker(currentVisibleWindowId, 'button', anchorRect)
          }}
          onResizeEdgeDown={(edges, pointerId, cx, cy) => {
            if (
              splitLayout() &&
              beginSplitGroupGesture(props.groupId, pointerId, 'resize', edges, cx, cy)
            ) {
              return
            }
            const currentVisibleWindowId = visibleWindowId()
            if (currentVisibleWindowId != null) beginShellWindowResize(currentVisibleWindowId, edges, cx, cy)
          }}
          onMinimize={() => {
            if (splitLayout()) {
              const leftWindowId = group()?.splitLeftWindowId
              const rightWindowId = visibleWindowId()
              if (leftWindowId != null) shellWireSend('minimize', leftWindowId)
              if (rightWindowId != null) shellWireSend('minimize', rightWindowId)
              return
            }
            const currentVisibleWindowId = visibleWindowId()
            if (currentVisibleWindowId != null) shellWireSend('minimize', currentVisibleWindowId)
          }}
          onMaximize={() => {
            const currentVisibleWindowId = visibleWindowId()
            if (currentVisibleWindowId != null) toggleShellMaximizeForWindow(currentVisibleWindowId)
          }}
          onClose={() => {
            const focusedGroupWindowId =
              group()?.members.some((member) => member.window_id === focusedWindowId())
                ? focusedWindowId()
                : visibleWindowId()
            if (focusedGroupWindowId != null) closeGroupWindow(focusedGroupWindowId)
          }}
        >
          <Show when={!splitLayout() && visibleWindowId() !== null}>
            {renderShellWindowContent(visibleWindowId()!)}
          </Show>
        </ShellWindowFrame>
        <Show when={splitLayout()} keyed>
          {(layout) => (
            <>
              {renderSplitPane(
                layout.leftWindowId,
                layout.left,
                'workspace-split-left-pane',
                {
                  'data-workspace-split-left-pane': String(layout.leftWindowId),
                },
              )}
              {renderSplitPane(
                group()!.visibleWindowId,
                layout.right,
                'workspace-split-right-pane',
                {
                  'data-workspace-split-right-pane': String(group()!.visibleWindowId),
                },
              )}
              <div
                data-testid="workspace-split-divider"
                data-workspace-split-divider={props.groupId}
                class="fixed z-6 cursor-col-resize bg-[color-mix(in_srgb,var(--shell-border)_88%,var(--shell-accent)_12%)]"
                style={{
                  left: `${layout.left.x + layout.left.width - Math.floor(WORKSPACE_SPLIT_DIVIDER_PX / 2)}px`,
                  top: `${layout.left.y + 6}px`,
                  width: `${WORKSPACE_SPLIT_DIVIDER_PX}px`,
                  height: `${Math.max(24, layout.left.height - 12)}px`,
                  'z-index': 1006 + stackZ(),
                }}
                onPointerDown={(event) => {
                  if (!event.isPrimary || event.button !== 0) return
                  event.preventDefault()
                  event.stopPropagation()
                  beginSplitGroupGesture(props.groupId, event.pointerId, 'divider', 0, event.clientX, event.clientY)
                }}
              />
            </>
          )}
        </Show>
      </Show>
    )
  }

  function TabDragOverlay() {
    const drag = createMemo(() => tabDragState())
    const dropIndicator = createMemo(() => {
      const target = drag()?.target
      if (!target) return null
      const slot = document.querySelector(
        `[data-tab-drop-slot="${target.groupId}:${target.insertIndex}"]`,
      ) as HTMLElement | null
      const strip = document.querySelector(
        `[data-workspace-tab-strip="${target.groupId}"]`,
      ) as HTMLElement | null
      if (!slot) return null
      const slotRect = slot.getBoundingClientRect()
      const stripRect = strip?.getBoundingClientRect() ?? slotRect
      return {
        line: {
          left: `${Math.round(slotRect.left - 2)}px`,
          top: `${Math.round(stripRect.top + 2)}px`,
          width: '4px',
          height: `${Math.max(10, Math.round(stripRect.height - 4))}px`,
        },
        highlight: {
          left: `${Math.round(stripRect.left)}px`,
          top: `${Math.round(stripRect.top)}px`,
          width: `${Math.round(stripRect.width)}px`,
          height: `${Math.round(stripRect.height)}px`,
        },
        key: `${target.groupId}:${target.insertIndex}`,
      }
    })
    return (
      <Show when={drag()?.dragging}>
        <div
          data-tab-drag-capture={drag()!.windowId}
          class="fixed inset-0 z-470120 cursor-grabbing"
          onContextMenu={(event) => event.preventDefault()}
          onPointerMove={onTabDragPointerMove}
          onPointerUp={onTabDragPointerUp}
          onPointerCancel={onTabDragPointerCancel}
        >
          <Show when={dropIndicator()} keyed>
            {(indicator) => (
              <>
                <div
                  data-tab-drop-indicator={indicator.key}
                  class="pointer-events-none fixed rounded-sm bg-[color-mix(in_srgb,var(--shell-accent-soft)_80%,transparent)] ring-1 ring-[color-mix(in_srgb,var(--shell-accent)_58%,transparent)]"
                  style={indicator.highlight}
                />
                <div
                  data-tab-drop-indicator-line={indicator.key}
                  class="pointer-events-none fixed rounded-full bg-(--shell-accent) shadow-[0_0_0_1px_var(--shell-accent),0_0_18px_color-mix(in_srgb,var(--shell-accent)_55%,transparent)]"
                  style={indicator.line}
                />
              </>
            )}
          </Show>
        </div>
      </Show>
    )
  }

  function ScreenshotOverlay() {
    let root: HTMLDivElement | undefined

    onMount(() => {
      const unreg = registerShellUiWindow(SHELL_UI_SCREENSHOT_WINDOW_ID, () =>
        shellUiWindowMeasureFromEnv(
          SHELL_UI_SCREENSHOT_WINDOW_ID,
          460500,
          root,
          screenshotShellUiEnv,
        ),
      )
      onCleanup(unreg)
    })

    const selectionCss = createMemo(() => {
      const rect = screenshotSelectionRect()
      const main = mainRef
      const og = outputGeom()
      if (!rect || !main || !og) return null
      const local = rectGlobalToCanvasLocal(
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        layoutCanvasOrigin(),
      )
      return canvasRectToClientCss(
        local.x,
        local.y,
        local.w,
        local.h,
        main.getBoundingClientRect(),
        og.w,
        og.h,
      )
    })

    return (
      <div
        ref={(el) => {
          root = el
        }}
        class="fixed inset-0 z-460500 touch-none bg-black"
        onContextMenu={(e) => {
          e.preventDefault()
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          const point = screenshotPointFromClient(e.clientX, e.clientY)
          if (!point) return
          root?.setPointerCapture?.(e.pointerId)
          focusShellUiWindow(SHELL_UI_SCREENSHOT_WINDOW_ID)
          shellWireSend('shell_ui_grab_begin', SHELL_UI_SCREENSHOT_WINDOW_ID)
          setScreenshotSelection({
            start: point,
            current: point,
            pointerId: e.pointerId,
          })
          e.preventDefault()
          e.stopPropagation()
        }}
        onPointerMove={(e) => {
          const sel = screenshotSelection()
          if (!sel || sel.pointerId !== e.pointerId) return
          const point = screenshotPointFromClient(e.clientX, e.clientY)
          if (!point) return
          setScreenshotSelection({
            ...sel,
            current: point,
          })
          e.preventDefault()
          e.stopPropagation()
        }}
        onPointerUp={(e) => {
          const sel = screenshotSelection()
          if (!sel || sel.pointerId !== e.pointerId) return
          root?.releasePointerCapture?.(e.pointerId)
          const point = screenshotPointFromClient(e.clientX, e.clientY)
          const next = point ? { ...sel, current: point } : sel
          setScreenshotSelection(next)
          const rect = screenshotSelectionRect()
          e.preventDefault()
          e.stopPropagation()
          if (!rect || rect.width < 2 || rect.height < 2) {
            stopScreenshotMode()
            return
          }
          void submitScreenshotRegion(rect)
        }}
        onPointerCancel={(e) => {
          root?.releasePointerCapture?.(e.pointerId)
          e.preventDefault()
          e.stopPropagation()
          stopScreenshotMode()
        }}
      >
        <Show when={selectionCss()} keyed>
          {(css) => (
            <div
              class="pointer-events-none fixed box-border border-2 border-white"
              style={{
                left: `${css.left}px`,
                top: `${css.top}px`,
                width: `${css.width}px`,
                height: `${css.height}px`,
              }}
            />
          )}
        </Show>
      </div>
    )
  }

  function SplitGestureOverlay() {
    const cursorClass = createMemo(() => {
      const gesture = splitGroupGesture()
      if (!gesture) return 'cursor-default'
      return gesture.kind === 'divider' ? 'cursor-col-resize' : 'cursor-grabbing'
    })

    return (
      <div
        data-workspace-split-gesture-overlay
        class={`fixed inset-0 z-470110 touch-none ${cursorClass()}`}
        onContextMenu={(event) => {
          event.preventDefault()
        }}
        onPointerMove={onSplitGroupPointerMove}
        onPointerUp={onSplitGroupPointerUp}
        onPointerCancel={onSplitGroupPointerCancel}
      />
    )
  }

  const portalPickerWindows = createMemo(() => {
    return [...windowsList()]
      .filter((w) => !w.minimized)
      .filter((w) => (w.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) === 0)
      .filter((w) => w.capture_identifier.trim().length > 0)
      .sort((a, b) => {
        const aFocused = focusedWindowId() === a.window_id ? 1 : 0
        const bFocused = focusedWindowId() === b.window_id ? 1 : 0
        if (aFocused !== bFocused) return bFocused - aFocused
        if (a.stack_z !== b.stack_z) return b.stack_z - a.stack_z
        const aTitle = (a.title || a.app_id).trim()
        const bTitle = (b.title || b.app_id).trim()
        return aTitle.localeCompare(bTitle)
      })
  })

  const portalPickerOutputs = createMemo(() => {
    return [...screenDraft.rows].sort((a, b) => {
      if (a.x !== b.x) return a.x - b.x
      if (a.y !== b.y) return a.y - b.y
      return a.name.localeCompare(b.name)
    })
  })

  const portalPickerPreviewMetrics = createMemo(() => {
    const rows = portalPickerOutputs()
    const union = unionBBoxFromScreens(rows)
    if (!union) return null
    const scale = Math.max(
      0.001,
      Math.min(
        (PORTAL_PICKER_PREVIEW_W - PORTAL_PICKER_PREVIEW_PAD * 2) / union.w,
        (PORTAL_PICKER_PREVIEW_H - PORTAL_PICKER_PREVIEW_PAD * 2) / union.h,
      ),
    )
    const contentW = union.w * scale
    const contentH = union.h * scale
    const offsetX = (PORTAL_PICKER_PREVIEW_W - contentW) / 2 - union.x * scale
    const offsetY = (PORTAL_PICKER_PREVIEW_H - contentH) / 2 - union.y * scale
    return rows.map((row, index) => ({
      index,
      row,
      left: offsetX + row.x * scale,
      top: offsetY + row.y * scale,
      width: Math.max(1, row.width * scale),
      height: Math.max(1, row.height * scale),
    }))
  })

  const portalPickerCanSelectMonitor = createMemo(() => {
    const types = portalPickerTypes()
    return types === null || (types & 1) !== 0
  })

  const portalPickerCanSelectWindow = createMemo(() => {
    const types = portalPickerTypes()
    return types === null || (types & 2) !== 0
  })

  const portalPickerLayout = createMemo(() => {
    const main = mainRef
    const og = outputGeom()
    const target = workspacePartition().primary
    if (!main || !og || !target) return null
    const targetCss = layoutScreenCssRect(target, layoutCanvasOrigin())
    const screenCss = canvasRectToClientCss(
      targetCss.x,
      targetCss.y,
      targetCss.width,
      targetCss.height,
      main.getBoundingClientRect(),
      og.w,
      og.h,
    )
    const width = Math.max(320, Math.min(960, screenCss.width - 48))
    const maxHeight = Math.max(280, screenCss.height - 48)
    const stripHeight = Math.max(1, canvasCss().h - shellContextMenus.shellMenuAtlasTop())
    const anchorX = Math.round(screenCss.left + (screenCss.width - width) / 2)
    const anchorY = Math.round(screenCss.top + Math.max(24, (screenCss.height - maxHeight) / 2))
    return {
      placement: {
        left: '50%',
        top: `${Math.max(8, Math.round((stripHeight - maxHeight) / 2))}px`,
        width: `${Math.round(width)}px`,
        'max-height': `${Math.round(maxHeight)}px`,
        transform: 'translateX(-50%)',
      } as const,
      anchor: {
        x: anchorX,
        y: anchorY,
        alignAboveY: anchorY,
      },
    }
  })

  function PortalPickerOverlay() {
    let panel: HTMLDivElement | undefined

    onMount(() => {
      acquireAtlasOverlayPointer()
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          void resolvePortalPicker(null)
        }
      }
      document.addEventListener('keydown', onKeyDown, true)
      onCleanup(() => {
        document.removeEventListener('keydown', onKeyDown, true)
        releaseAtlasOverlayPointer()
        hideFloatingPlacementWire()
      })
    })

    createEffect(() => {
      void shellWireReadyRev()
      if (!portalPickerVisible()) {
        hideFloatingPlacementWire()
        return
      }
      const layout = portalPickerLayout()
      const og = outputGeom()
      const ph = outputPhysical()
      const rid = requestAnimationFrame(() => {
        const main = mainRef
        const atlas = shellContextMenus.atlasHostEl()
        if (!main || !atlas || !panel || !layout || !og || !ph) return
        pushShellFloatingWireFromDom({
          main,
          atlasHost: atlas,
          panel,
          anchor: layout.anchor,
          canvasW: og.w,
          canvasH: og.h,
          physicalW: ph.w,
          physicalH: ph.h,
          contextMenuAtlasBufferH: contextMenuAtlasBufferH(),
          screens: screenDraft.rows,
          layoutOrigin: layoutCanvasOrigin(),
        })
      })
      onCleanup(() => cancelAnimationFrame(rid))
    })

    return (
      <Show when={shellContextMenus.atlasHostEl()} keyed>
        {(host) => (
          <Portal mount={host}>
            <div
              class="absolute inset-0 z-90000"
              onContextMenu={(e) => {
                e.preventDefault()
              }}
              onPointerDown={(e) => {
                if (!(e.target instanceof Node)) return
                if (panel?.contains(e.target)) return
                e.preventDefault()
                e.stopPropagation()
                void resolvePortalPicker(null)
              }}
            >
              <div
                ref={(el) => {
                  panel = el
                }}
                class="absolute border border-white/12 bg-(--shell-overlay) p-5 text-(--shell-text) shadow-2xl"
                style={
                  portalPickerLayout()?.placement ?? {
                    left: '50%',
                    top: '8px',
                    width: 'min(960px, calc(100vw - 48px))',
                    'max-height': 'min(760px, calc(100% - 16px))',
                    transform: 'translateX(-50%)',
                  }
                }
              >
                <div class="mb-4 flex items-start justify-between gap-4">
                  <div>
                    <div class="text-lg font-semibold">
                      {portalPickerCanSelectMonitor() && !portalPickerCanSelectWindow()
                        ? 'Share a display'
                        : portalPickerCanSelectWindow() && !portalPickerCanSelectMonitor()
                          ? 'Share a window'
                          : 'Share a window or display'}
                    </div>
                    <div class="text-(--shell-text-muted) text-sm">
                      {portalPickerCanSelectMonitor() && !portalPickerCanSelectWindow()
                        ? 'Pick a display for `xdg-desktop-portal-wlr`.'
                        : portalPickerCanSelectWindow() && !portalPickerCanSelectMonitor()
                          ? 'Pick a native window for `xdg-desktop-portal-wlr`.'
                          : 'Pick a native window or display for `xdg-desktop-portal-wlr`.'}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={portalPickerBusy()}
                    class="rounded-lg border border-(--shell-border) px-3 py-1.5 text-sm text-(--shell-text-muted) transition-colors hover:bg-(--shell-hover)"
                    onClick={() => {
                      void resolvePortalPicker(null)
                    }}
                  >
                    {portalPickerBusy() ? 'Working…' : 'Cancel'}
                  </button>
                </div>
                <Show when={portalPickerCanSelectWindow()}>
                  <div class="border border-(--shell-border) bg-(--shell-surface) mb-3 rounded-lg p-2.5">
                    <div class="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                      <span class="text-[0.78rem] font-medium text-(--shell-text)">Native windows</span>
                      <span class="text-[0.72rem] text-(--shell-text-dim)">
                        Shell-backed windows are hidden from sharing
                      </span>
                    </div>
                    <Show
                      when={portalPickerWindows().length > 0}
                      fallback={
                        <div class="text-(--shell-text-muted) rounded-md border border-dashed border-(--shell-border) px-3 py-6 text-center text-sm">
                          No native windows are ready to share.
                        </div>
                      }
                    >
                      <div class="grid max-h-[min(24rem,40vh)] grid-cols-1 gap-2 overflow-auto pr-1 md:grid-cols-2">
                        <For each={portalPickerWindows()}>
                          {(win) => {
                            const monitorName = win.output_name || 'Current display'
                            const title = (win.title || win.app_id || 'Untitled window').trim()
                            const appId = win.app_id.trim()
                            return (
                              <button
                                type="button"
                                disabled={portalPickerBusy()}
                                class="border border-(--shell-border) bg-(--shell-surface-elevated) hover:border-(--shell-accent-border) hover:bg-(--shell-surface-hover) flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--shell-accent)"
                                onClick={() => {
                                  void resolvePortalPicker(`Window: ${win.capture_identifier}`)
                                }}
                              >
                                <div class="flex items-start justify-between gap-2">
                                  <div class="min-w-0">
                                    <div class="truncate text-[0.82rem] font-semibold text-(--shell-text)">
                                      {title}
                                    </div>
                                    <div class="truncate text-[0.72rem] text-(--shell-text-dim)">
                                      {appId || 'Unknown app'}
                                    </div>
                                  </div>
                                  <Show when={focusedWindowId() === win.window_id}>
                                    <span class="rounded-full border border-(--shell-accent) px-1.5 py-[0.08rem] text-[0.56rem] font-semibold uppercase tracking-wide text-(--shell-accent)">
                                      Focused
                                    </span>
                                  </Show>
                                </div>
                                <div class="flex flex-wrap gap-x-3 gap-y-1 text-[0.68rem] text-(--shell-text-muted)">
                                  <span>{monitorName}</span>
                                  <span>{formatMonitorPixels(win.width, win.height)}</span>
                                  <Show when={win.fullscreen}>
                                    <span>Fullscreen</span>
                                  </Show>
                                  <Show when={!win.fullscreen && win.maximized}>
                                    <span>Maximized</span>
                                  </Show>
                                </div>
                              </button>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
                <Show when={portalPickerCanSelectMonitor()}>
                  <div class="border border-(--shell-border) bg-(--shell-surface) mb-3 rounded-lg p-2.5">
                    <div class="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                      <span class="text-[0.78rem] font-medium text-(--shell-text)">Displays</span>
                      <span class="text-[0.72rem] text-(--shell-text-dim)">
                        Selection follows your saved display arrangement
                      </span>
                    </div>
                    <Show
                      when={portalPickerOutputs().length > 0}
                      fallback={
                        <div class="text-(--shell-text-muted) rounded-md border border-dashed border-(--shell-border) px-3 py-6 text-center text-sm">
                          Waiting for display layout from the compositor.
                        </div>
                      }
                    >
                      <div class="bg-(--shell-display-preview-bg) relative aspect-2/1 w-full overflow-hidden rounded-md border border-(--shell-border)">
                        <div class="bg-(--shell-display-preview-glow) pointer-events-none absolute inset-0" />
                        <For each={portalPickerPreviewMetrics() ?? []}>
                          {(rect) => (
                            (() => {
                              const physical = physicalPixelsForScreen(rect.row, outputGeom(), outputPhysical())
                              return (
                                <button
                                  type="button"
                                  disabled={portalPickerBusy() || !rect.row.name}
                                  class="border border-(--shell-display-card-border) bg-(--shell-display-card-bg) text-(--shell-text) absolute flex flex-col items-start justify-between overflow-hidden rounded-md px-2 py-1.5 text-left transition-shadow hover:shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--shell-accent)"
                                  classList={{
                                    'border-(--shell-display-card-primary-border) bg-(--shell-display-card-primary-bg)':
                                      shellChromePrimaryName() === rect.row.name,
                                  }}
                                  style={{
                                    left: `${(rect.left / PORTAL_PICKER_PREVIEW_W) * 100}%`,
                                    top: `${(rect.top / PORTAL_PICKER_PREVIEW_H) * 100}%`,
                                    width: `${(rect.width / PORTAL_PICKER_PREVIEW_W) * 100}%`,
                                    height: `${(rect.height / PORTAL_PICKER_PREVIEW_H) * 100}%`,
                                  }}
                                  onClick={() => {
                                    void resolvePortalPicker(`Monitor: ${rect.row.name}`)
                                  }}
                                >
                                  <div class="min-w-0">
                                    <div class="truncate text-[0.74rem] font-semibold">
                                      {rect.row.name || '—'}
                                    </div>
                                    <div class="text-[0.66rem] text-(--shell-text-muted)">
                                      {formatMonitorPixels(physical.width, physical.height)}
                                    </div>
                                  </div>
                                  <Show when={shellChromePrimaryName() === rect.row.name}>
                                    <span class="rounded-full border border-(--shell-accent) px-1.5 py-[0.08rem] text-[0.56rem] font-semibold uppercase tracking-wide text-(--shell-accent)">
                                      Primary
                                    </span>
                                  </Show>
                                </button>
                              )
                            })()
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
          </Portal>
        )}
      </Show>
    )
  }

  const taskbarScreens = createMemo(() =>
    screensListForLayout(screenDraft.rows, outputGeom(), layoutCanvasOrigin()),
  )

  function sendWorkspaceMutation(mutation: Record<string, unknown>): boolean {
    return shellWireSend('workspace_mutation', JSON.stringify(mutation))
  }

  function sendSetMonitorTile(windowId: number, outputName: string, zone: SnapZone, bounds: TileRect): boolean {
    return sendWorkspaceMutation({
      type: 'set_monitor_tile',
      windowId,
      outputName,
      zone,
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
    })
  }

  function sendRemoveMonitorTile(windowId: number): boolean {
    return sendWorkspaceMutation({ type: 'remove_monitor_tile', windowId })
  }

  function sendClearMonitorTiles(outputName: string): boolean {
    return sendWorkspaceMutation({ type: 'clear_monitor_tiles', outputName })
  }

  function sendSetPreTileGeometry(windowId: number, bounds: { x: number; y: number; w: number; h: number }): boolean {
    return sendWorkspaceMutation({
      type: 'set_pre_tile_geometry',
      windowId,
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.w,
        height: bounds.h,
      },
    })
  }

  function sendClearPreTileGeometry(windowId: number): boolean {
    return sendWorkspaceMutation({ type: 'clear_pre_tile_geometry', windowId })
  }

  function workspacePreTileSnapshot(windowId: number): { x: number; y: number; w: number; h: number } | null {
    const bounds = workspaceGetPreTileGeometry(workspaceState(), windowId)
    return bounds ? { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height } : null
  }

  function workspaceTiledRectMap(outputName: string): Map<number, TileRect> {
    return new Map(
      workspaceMonitorTileEntries(workspaceState(), outputName).map((entry) => [entry.windowId, { ...entry.bounds }]),
    )
  }

  function clearMonitorTiles(outputName: string) {
    sendClearMonitorTiles(outputName)
  }

  const { scheduleExclusionZonesSync, syncExclusionZonesNow } = createShellExclusionSync({
    mainEl: () => mainRef,
    outputGeom,
    layoutCanvasOrigin,
    taskbarScreens,
    windows: windowsList,
    isWindowTiled: (windowId) => workspaceIsWindowTiled(workspaceState(), windowId),
    onHudChange: setExclusionZonesHud,
  })

  createEffect(() => {
    void shellWireReadyRev()
    queueMicrotask(() => {
      flushShellUiWindowsSyncNow()
      syncExclusionZonesNow()
    })
  })

  function taskbarRowsForScreen(s: LayoutScreen) {
    return taskbarRowsByMonitor().get(s.name) ?? []
  }

  function isPrimaryTaskbarScreen(s: LayoutScreen, primary: LayoutScreen) {
    return (
      s.name === primary.name &&
      s.x === primary.x &&
      s.y === primary.y &&
      s.width === primary.width &&
      s.height === primary.height
    )
  }

  function occupiedSnapZonesOnMonitor(
    mon: LayoutScreen,
    excludeWindowId: number,
  ): { zone: SnapZone; bounds: TileRect }[] {
    const co = layoutCanvasOrigin()
    const list = taskbarScreens()
    const out: { zone: SnapZone; bounds: TileRect }[] = []
    for (const entry of workspaceMonitorTileEntries(workspaceState(), mon.name)) {
      const wid = entry.windowId
      if (wid === excludeWindowId) continue
      const win = allWindowsMap().get(wid)
      if (!win || win.minimized) continue
      if (!windowOnMonitor(win, mon, list, co)) continue
      const g = rectCanvasLocalToGlobal(win.x, win.y, win.width, win.height, co)
      out.push({ zone: entry.zone, bounds: { x: g.x, y: g.y, width: g.w, height: g.h } })
    }
    return out
  }

  function screenTaskbarHiddenForFullscreen(s: LayoutScreen) {
    const list = windowsByMonitor().get(s.name) ?? []
    return list.some((w) => w.fullscreen && !w.minimized)
  }

  function reserveTaskbarForMon(mon: LayoutScreen) {
    return !screenTaskbarHiddenForFullscreen(mon)
  }

  function fallbackMonitorKey(): string {
    return fallbackMonitorName()
  }

  function applyAutoLayout(monitorName: string) {
    const { layout, params } = getMonitorLayout(monitorName)
    if (layout.type === 'manual-snap') {
      return
    }
    const mon = taskbarScreens().find((s) => s.name === monitorName) ?? null
    if (!mon) return
    const fb = fallbackMonitorKey()
    const co = layoutCanvasOrigin()
    const reserveTb = reserveTaskbarForMon(mon)
    const work = monitorWorkAreaGlobal(mon, reserveTb)
    const workRect: TileRect = { x: work.x, y: work.y, width: work.w, height: work.h }
    const candidates = windowsList().filter((w) => {
      if (w.window_id === SHELL_UI_DEBUG_WINDOW_ID || w.window_id === SHELL_UI_SETTINGS_WINDOW_ID)
        return false
      if (w.minimized) return false
      if ((w.output_name || fb) !== monitorName) return false
      if (w.fullscreen || w.maximized) return false
      return true
    })
    const windowIds = candidates.map((w) => w.window_id).sort((a, b) => a - b)
    const rectMap = layout.computeLayout(windowIds, workRect, params)
    const snap = windows()
    if (!sendClearMonitorTiles(monitorName)) return
    for (const [wid] of rectMap) {
      const pt = snap.get(wid)
      if (pt) {
        if (!sendSetPreTileGeometry(wid, { x: pt.x, y: pt.y, w: pt.width, h: pt.height })) return
      }
    }
    for (const [wid, gr] of rectMap) {
      if (!sendSetMonitorTile(wid, monitorName, 'auto-fill', gr)) return
      const loc = rectGlobalToCanvasLocal(gr.x, gr.y, gr.width, gr.height, co)
      shellWireSend('set_geometry', wid, loc.x, loc.y, loc.w, loc.h, SHELL_LAYOUT_FLOATING)
    }
    patchWindowDrafts(
      Array.from(rectMap.keys()),
      (wid) => {
        const gr = rectMap.get(wid)!
        const loc = rectGlobalToCanvasLocal(gr.x, gr.y, gr.width, gr.height, co)
        return { x: loc.x, y: loc.y, width: loc.w, height: loc.h, maximized: false }
      },
    )
    scheduleExclusionZonesSync()
    bumpSnapChrome()
  }

  function relayoutAllAutoMonitors() {
    for (const s of screensListForLayout(screenDraft.rows, outputGeom(), layoutCanvasOrigin())) {
      if (getMonitorLayout(s.name).layout.type !== 'manual-snap') {
        applyAutoLayout(s.name)
      }
    }
  }

  function scheduleCompositorFollowup(options?: {
    flushWindows?: boolean
    syncExclusion?: boolean
    relayoutAll?: boolean
    relayoutMonitor?: string | null
    resetScroll?: boolean
  }) {
    if (options?.flushWindows) compositorFollowupFlushWindows = true
    if (options?.syncExclusion) compositorFollowupSyncExclusion = true
    if (options?.relayoutAll) compositorFollowupRelayoutAll = true
    if (options?.resetScroll) compositorFollowupResetScroll = true
    if (typeof options?.relayoutMonitor === 'string' && options.relayoutMonitor.length > 0) {
      compositorFollowupRelayoutMonitors.add(options.relayoutMonitor)
    }
    if (compositorFollowupQueued) return
    compositorFollowupQueued = true
    queueMicrotask(() => {
      compositorFollowupQueued = false
      const flushWindows = compositorFollowupFlushWindows
      const syncExclusion = compositorFollowupSyncExclusion
      const relayoutAll = compositorFollowupRelayoutAll
      const resetScroll = compositorFollowupResetScroll
      const relayoutMonitors = relayoutAll ? [] : Array.from(compositorFollowupRelayoutMonitors)
      compositorFollowupFlushWindows = false
      compositorFollowupSyncExclusion = false
      compositorFollowupRelayoutAll = false
      compositorFollowupResetScroll = false
      compositorFollowupRelayoutMonitors.clear()
      try {
        if (relayoutAll) {
          relayoutAllAutoMonitors()
        } else {
          for (const monitorName of relayoutMonitors) {
            applyAutoLayout(monitorName)
          }
        }
        if (flushWindows) flushShellUiWindowsSyncNow()
        if (syncExclusion) {
          if (flushWindows) {
            syncExclusionZonesNow()
          } else {
            scheduleExclusionZonesSync()
          }
        }
        if (resetScroll) {
          window.scrollTo(0, 0)
          document.documentElement.scrollTop = 0
          document.documentElement.scrollLeft = 0
          document.body.scrollTop = 0
          document.body.scrollLeft = 0
        }
      } catch (e) {
        console.error('[derp-shell] compositor follow-up', e)
      }
    })
  }

  /** Memo so pointer/viewport updates re-run (nested `Show` + FC did not track `pointerClient`). */
  const crosshairDebugOverlay = createMemo(() => {
    if (!crosshairCursor()) return null
    const p = pointerClient()
    if (!p) return null
    const vpw = viewportCss().w
    const vph = viewportCss().h
    return (
      <>
        <div
          class="pointer-events-none fixed top-0 bottom-0 z-53 w-px -translate-x-[0.5px] bg-shell-crosshair"
          style={{ left: `${p.x}px` }}
        />
        <div
          class="pointer-events-none fixed left-0 right-0 z-53 h-px -translate-y-[0.5px] bg-shell-crosshair"
          style={{ top: `${p.y}px` }}
        />
        <div
          class="pointer-events-none fixed z-54 rounded border border-(--shell-border) bg-shell-cursor-readout px-1.5 py-0.5 text-[11px] whitespace-nowrap text-(--shell-accent-foreground) tabular-nums"
          style={{
            left: `${Math.min(p.x + 14, Math.max(0, vpw - 128))}px`,
            top: `${Math.min(p.y + 14, Math.max(0, vph - 40))}px`,
          }}
        >
          {p.x},{p.y}
        </div>
      </>
    )
  })

  createEffect(() => {
    snapAssistPicker()
    queueMicrotask(() => {
      scheduleTilePreviewSync()
      flushShellUiWindowsSyncNow()
      syncExclusionZonesNow()
    })
  })

  createEffect(() => {
    outputGeom()
    layoutCanvasOrigin()
    queueMicrotask(() => invalidateAllShellUiWindows())
  })

  function bumpSnapChrome() {
    setSnapChromeRev((n) => n + 1)
  }

  function applyGeometryToWindowMaps(
    wid: number,
    loc: { x: number; y: number; w: number; h: number },
    patch: Partial<DerpWindow> = {},
  ) {
    patchWindowDrafts(workspaceGroupWindowIds(workspaceState(), wid), () => ({
      ...patch,
      x: loc.x,
      y: loc.y,
      width: loc.w,
      height: loc.h,
    }))
  }

  function minimizeDebugShellWindow() {
    shellWireSend('minimize', SHELL_UI_DEBUG_WINDOW_ID)
  }

  function minimizeSettingsShellWindow() {
    shellWireSend('minimize', SHELL_UI_SETTINGS_WINDOW_ID)
  }

  function toggleSettingsShellWindow() {
    const w = windows().get(SHELL_UI_SETTINGS_WINDOW_ID)
    if (!w || w.minimized) openSettingsShellWindow()
    else minimizeSettingsShellWindow()
  }

  function openBackedShellWindow(kind: 'debug' | 'settings') {
    const list = screensListForLayout(screenDraft.rows, outputGeom(), layoutCanvasOrigin())
    const co = layoutCanvasOrigin()
    const part = workspacePartition()
    const mon = list.find((s) => s.name === part.primary.name) ?? list[0] ?? null
    if (!mon) return
    const reserveTb = reserveTaskbarForMon(mon)
    const work = monitorWorkAreaGlobal(mon, reserveTb)
    const staggerIndex = windowsList().filter(
      (window) =>
        window.output_name === mon.name &&
        !window.minimized &&
        (window.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) !== 0,
    ).length
    const payload = buildBackedWindowOpenPayload(mon.name, work, kind, co, staggerIndex)
    sendBackedWindowOpen(payload)
  }

  function openDebugShellWindow() {
    openBackedShellWindow('debug')
  }

  function openSettingsShellWindow() {
    openBackedShellWindow('settings')
  }

  function nextShellTestWindowOpenId() {
    const used = new Set(
      windowsList()
        .filter((window) => isShellTestWindowId(window.window_id) || window.app_id === SHELL_UI_TEST_APP_ID)
        .map((window) => window.window_id),
    )
    for (let instance = 0; instance <= 99; instance += 1) {
      const windowId = shellTestWindowId(instance)
      if (!used.has(windowId)) return windowId
    }
    return null
  }

  function openShellTestWindow() {
    const list = screensListForLayout(screenDraft.rows, outputGeom(), layoutCanvasOrigin())
    const co = layoutCanvasOrigin()
    const part = workspacePartition()
    const mon = list.find((screen) => screen.name === part.primary.name) ?? list[0] ?? null
    const windowId = nextShellTestWindowOpenId()
    if (!mon || windowId === null) return false
    const reserveTb = reserveTaskbarForMon(mon)
    const work = monitorWorkAreaGlobal(mon, reserveTb)
    const title = shellTestWindowTitle(windowId - shellTestWindowId(0))
    const staggerIndex = windowsList().filter(
      (window) =>
        window.output_name === mon.name &&
        !window.minimized &&
        (window.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) !== 0,
    ).length
    const payload = buildShellTestWindowOpenPayload(mon.name, work, windowId, title, co, staggerIndex)
    sendBackedWindowOpen(payload)
    return true
  }

  function nextFileBrowserWindowOpenId() {
    const used = new Set(
      windowsList()
        .filter((window) => isFileBrowserWindowId(window.window_id) || window.app_id === SHELL_UI_FILE_BROWSER_APP_ID)
        .map((window) => window.window_id),
    )
    for (let instance = 0; instance <= 99; instance += 1) {
      const windowId = fileBrowserWindowId(instance)
      if (!used.has(windowId)) return windowId
    }
    return null
  }

  function openFileBrowserWindow(path?: string | null) {
    const list = screensListForLayout(screenDraft.rows, outputGeom(), layoutCanvasOrigin())
    const co = layoutCanvasOrigin()
    const part = workspacePartition()
    const mon = list.find((screen) => screen.name === part.primary.name) ?? list[0] ?? null
    const windowId = nextFileBrowserWindowOpenId()
    if (!mon || windowId === null) return false
    const reserveTb = reserveTaskbarForMon(mon)
    const work = monitorWorkAreaGlobal(mon, reserveTb)
    const title = fileBrowserWindowTitle(windowId - fileBrowserWindowId(0))
    const staggerIndex = windowsList().filter(
      (window) =>
        window.output_name === mon.name &&
        !window.minimized &&
        (window.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) !== 0,
    ).length
    primeFileBrowserWindowPath(windowId, path)
    const payload = buildFileBrowserWindowOpenPayload(mon.name, work, windowId, title, co, staggerIndex)
    sendBackedWindowOpen(payload)
    return true
  }

  function flushPendingBackedWindowOpens() {
    if (backedWindowOpenRaf !== 0) return
    const trySend = () => {
      backedWindowOpenRaf = 0
      for (const [windowId, payload] of pendingBackedWindowOpens) {
        if (shellWireSend('backed_window_open', JSON.stringify(payload))) {
          pendingBackedWindowOpens.delete(windowId)
        }
      }
      if (pendingBackedWindowOpens.size > 0) {
        backedWindowOpenRaf = requestAnimationFrame(trySend)
      }
    }
    trySend()
  }

  function sendBackedWindowOpen(payload: BackedWindowOpenPayload) {
    pendingBackedWindowOpens.set(payload.window_id, payload)
    flushPendingBackedWindowOpens()
  }

  function buildSessionSnapshot(): SessionSnapshot {
    const shellWindows: SavedShellWindow[] = []
    const nativeWindows: SavedNativeWindow[] = []
    for (const window of [...windowsList()].sort((a, b) => a.stack_z - b.stack_z || a.window_id - b.window_id)) {
      if (windowIsShellHosted(window)) {
        const kind = backedShellWindowKind(window.window_id, window.app_id)
        if (!kind) continue
        shellWindows.push({
          windowId: window.window_id,
          windowRef: shellWindowRef(window.window_id),
          kind,
          title: window.title,
          appId: window.app_id,
          outputName: window.output_name,
          bounds: rectFromWindow(window),
          minimized: window.minimized,
          maximized: window.maximized,
          fullscreen: window.fullscreen,
          stackZ: window.stack_z,
          state: captureShellWindowState(window.window_id) ?? null,
        })
        continue
      }
      const windowRef = nativeWindowRefForId(window.window_id)
      if (!windowRef) continue
      nativeWindows.push({
        windowRef,
        title: window.title,
        appId: window.app_id,
        outputName: window.output_name,
        bounds: rectFromWindow(window),
        minimized: window.minimized,
        maximized: window.maximized,
        fullscreen: window.fullscreen,
        launch: nativeLaunchMetadataByRef.get(windowRef) ?? null,
      })
    }
    return {
      version: 1,
      nextNativeWindowSeq: nextNativeWindowSeq(),
      workspace: {
        groups: workspaceState().groups.flatMap((group) => {
            const windowRefs = group.windowIds
              .map((windowId) => {
                const window = allWindowsMap().get(windowId)
                return window
                  ? windowIsShellHosted(window)
                    ? shellWindowRef(window.window_id)
                    : nativeWindowRefForId(window.window_id)
                  : null
              })
              .filter((windowRef): windowRef is SessionWindowRef => windowRef !== null)
            if (windowRefs.length === 0) return []
            const activeWindowRef = windowRefs.find(
              (windowRef) => liveWindowIdForRef(windowRef) === workspaceState().activeTabByGroupId[group.id],
            )
            return [
              {
                id: group.id,
                windowRefs,
                activeWindowRef: activeWindowRef ?? windowRefs[0],
                splitLeftWindowRef:
                  workspaceState().splitByGroupId[group.id] &&
                  workspaceState().splitByGroupId[group.id]!.leftWindowId > 0
                    ? windowRefs.find(
                        (windowRef) =>
                          liveWindowIdForRef(windowRef) === workspaceState().splitByGroupId[group.id]!.leftWindowId,
                      ) ?? null
                    : null,
                leftPaneFraction: workspaceState().splitByGroupId[group.id]?.leftPaneFraction ?? null,
              },
            ]
          }),
        pinnedWindowRefs: workspaceState().pinnedWindowIds
          .map((windowId) => {
            const window = allWindowsMap().get(windowId)
            return window
              ? windowIsShellHosted(window)
                ? shellWindowRef(window.window_id)
                : nativeWindowRefForId(window.window_id)
              : null
          })
          .filter((windowRef): windowRef is SessionWindowRef => windowRef !== null),
        nextGroupSeq: workspaceState().nextGroupSeq,
      },
      tilingConfig: loadTilingConfig(),
      monitorTiles: workspaceState().monitorTiles.map((monitor) => ({
        outputName: monitor.outputName,
        entries: monitor.entries
          .map((entry) => {
            const window = allWindowsMap().get(entry.windowId)
            if (!window) return null
            const windowRef = windowIsShellHosted(window)
              ? shellWindowRef(window.window_id)
              : nativeWindowRefForId(window.window_id)
            if (!windowRef) return null
            return {
              windowRef,
              zone: entry.zone,
              bounds: {
                x: entry.bounds.x,
                y: entry.bounds.y,
                width: entry.bounds.width,
                height: entry.bounds.height,
              },
            }
          })
          .filter((entry): entry is SavedMonitorTileState['entries'][number] => entry !== null),
      })),
      preTileGeometry: workspaceState()
        .preTileGeometry
        .map(({ windowId, bounds }) => {
          const window = allWindowsMap().get(windowId)
          if (!window) return null
          const windowRef = windowIsShellHosted(window)
            ? shellWindowRef(window.window_id)
            : nativeWindowRefForId(window.window_id)
          if (!windowRef) return null
          return {
            windowRef,
            bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          }
        })
        .filter((entry): entry is SessionSnapshot['preTileGeometry'][number] => entry !== null),
      shellWindows,
      nativeWindows,
    }
  }

  function stopSessionRestore() {
    if (sessionRestoreStopTimer !== undefined) {
      clearTimeout(sessionRestoreStopTimer)
      sessionRestoreStopTimer = undefined
    }
    lastAppliedRestoreSignature = ''
    setSessionRestoreSnapshot(null)
    setSessionPersistenceReady(true)
  }

  function sessionRestoreIsComplete(snapshot: SessionSnapshot): boolean {
    const windowsById = allWindowsMap()
    for (const shellWindow of snapshot.shellWindows) {
      const live = windowsById.get(shellWindow.windowId)
      if (!live) return false
      if (live.minimized !== shellWindow.minimized) return false
    }
    for (const nativeWindow of snapshot.nativeWindows) {
      const liveWindowId = liveWindowIdForRef(nativeWindow.windowRef)
      if (liveWindowId === null) return false
      const live = windowsById.get(liveWindowId)
      if (!live) return false
      if (live.minimized !== nativeWindow.minimized) return false
    }
    return true
  }

  async function startSessionRestore(snapshot: SessionSnapshot) {
    if (sessionRestoreStopTimer !== undefined) {
      clearTimeout(sessionRestoreStopTimer)
    }
    setSessionPersistenceReady(false)
    setSessionRestoreSnapshot(snapshot)
    setHasSeenCompositorWindowSync(false)
    lastPersistedSessionJson = JSON.stringify(snapshot)
    lastAppliedRestoreSignature = ''
    setNextNativeWindowSeq(Math.max(1, snapshot.nextNativeWindowSeq))
    saveTilingConfig(snapshot.tilingConfig)
    setTilingCfgRev((n) => n + 1)
    for (const nativeWindow of snapshot.nativeWindows) {
      if (nativeWindow.launch) nativeLaunchMetadataByRef.set(nativeWindow.windowRef, nativeWindow.launch)
    }
    for (const shellWindow of [...snapshot.shellWindows].sort((a, b) => a.stackZ - b.stackZ)) {
      restoreBackedShellWindow(shellWindow)
    }
    for (const nativeWindow of snapshot.nativeWindows) {
      if (!nativeWindow.launch?.command) continue
      void spawnInCompositor(nativeWindow.launch.command, nativeWindow.launch, true, nativeWindow.windowRef)
    }
    sessionRestoreStopTimer = setTimeout(() => {
      stopSessionRestore()
    }, 15000)
  }

  function toggleShellMaximizeForWindow(wid: number) {
    const w = allWindowsMap().get(wid)
    if (!w) return
    if (w.maximized) {
      shellWireSend('set_maximized', wid, 0)
      return
    }
    if (!sendRemoveMonitorTile(wid)) return
    if (!sendClearPreTileGeometry(wid)) return
    bumpSnapChrome()
    scheduleExclusionZonesSync()
    floatBeforeMaximize.set(wid, { x: w.x, y: w.y, w: w.width, h: w.height })
    const list = screensListForLayout(screenDraft.rows, outputGeom(), layoutCanvasOrigin())
    const mon2 = pickScreenForWindow(w, list, layoutCanvasOrigin()) ?? list[0] ?? null
    if (!mon2) return
    const reserveTb = reserveTaskbarForMon(mon2)
    const r = shellMaximizedWorkAreaGlobalRect(mon2, reserveTb)
    shellWireSend('set_geometry', wid, r.x, r.y, r.w, r.h, SHELL_LAYOUT_MAXIMIZED)
  }

  function snapAssistAnchorRect(rect: DOMRect): SnapAssistPickerAnchorRect {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    }
  }

  function resetSnapAssistState() {
    activeSnapPreviewCanvas = null
    activeSnapZone = null
    activeSnapScreen = null
    activeSnapWindowId = null
  }

  function clearTilePreviewWire() {
    if (tilePreviewRaf) {
      cancelAnimationFrame(tilePreviewRaf)
      tilePreviewRaf = 0
    }
    lastTilePreviewKey = ''
    shellWireSend('set_tile_preview', 0, 0, 0, 0, 0)
  }

  function clearSnapAssistSelection() {
    resetSnapAssistState()
    setAssistOverlay(null)
    scheduleTilePreviewSync()
  }

  function closeSnapAssistPicker() {
    setSnapAssistPicker(null)
    clearSnapAssistSelection()
  }

  function resolveSnapAssistContext(
    windowId: number,
    preferredMonitorName?: string | null,
    shape: AssistGridShape = DEFAULT_ASSIST_GRID_SHAPE,
  ): SnapAssistContext | null {
    const window = allWindowsMap().get(windowId)
    if (!window || window.minimized) return null
    const canvas = outputGeom()
    const origin = layoutCanvasOrigin()
    const screens = screensListForLayout(screenDraft.rows, canvas, origin)
    if (screens.length === 0) return null
    const screen =
      (preferredMonitorName ? screens.find((entry) => entry.name === preferredMonitorName) : undefined) ??
      pickScreenForWindow(window, screens, origin) ??
      screens[0]
    if (!screen || getMonitorLayout(screen.name).layout.type !== 'manual-snap') return null
    const reserveTaskbar = reserveTaskbarForMon(screen)
    const workGlobal = monitorWorkAreaGlobal(screen, reserveTaskbar)
    return {
      windowId,
      screen,
      workGlobal,
      workCanvas: rectGlobalToCanvasLocal(workGlobal.x, workGlobal.y, workGlobal.w, workGlobal.h, origin),
      shape,
    }
  }

  function applySnapAssistZonePreview(
    context: SnapAssistContext,
    zone: SnapZone,
    previewRect: TileRect,
  ) {
    const origin = layoutCanvasOrigin()
    activeSnapZone = zone
    activeSnapScreen = context.screen
    activeSnapWindowId = context.windowId
    const previewGlobal = {
      x: previewRect.x,
      y: previewRect.y - CHROME_TITLEBAR_PX,
      w: previewRect.width,
      h: previewRect.height + CHROME_TITLEBAR_PX,
    }
    activeSnapPreviewCanvas = rectGlobalToCanvasLocal(
      previewGlobal.x,
      previewGlobal.y,
      previewGlobal.w,
      previewGlobal.h,
      origin,
    )
  }

  function updateSnapAssistFromSpan(context: SnapAssistContext, span: AssistGridSpan | null) {
    const shape = span ? assistShapeFromSpan(span) : context.shape
    if (!span || !shape) {
      clearSnapAssistSelection()
      return
    }
    const { zone, previewRect } = snapZoneAndPreviewFromAssistSpan(span, shape, context.workGlobal)
    applySnapAssistZonePreview(context, zone, previewRect)
    setAssistOverlay({
      shape,
      gutterPx: assistGridGutterPx(context.workGlobal, shape),
      hoverSpan: span,
      workCanvas: context.workCanvas,
    })
    scheduleTilePreviewSync()
  }

  function updateSnapAssistFromEdgeZone(context: SnapAssistContext, zone: SnapZone | null) {
    if (!zone) {
      clearSnapAssistSelection()
      return
    }
    const workRect: TileRect = {
      x: context.workGlobal.x,
      y: context.workGlobal.y,
      width: context.workGlobal.w,
      height: context.workGlobal.h,
    }
    const previewRect = snapZoneToBoundsWithOccupied(
      zone,
      workRect,
      occupiedSnapZonesOnMonitor(context.screen, context.windowId),
    )
    applySnapAssistZonePreview(context, zone, previewRect)
    setAssistOverlay(null)
    scheduleTilePreviewSync()
  }

  function commitSnapAssistSelection(windowId: number, closePicker = false) {
    const snapWindowId = activeSnapWindowId ?? windowId
    const droppedZone = activeSnapZone
    const snapScreen = activeSnapScreen
    resetSnapAssistState()
    setAssistOverlay(null)
    if (closePicker) setSnapAssistPicker(null)
    clearTilePreviewWire()
    if (droppedZone === null || !snapScreen) {
      dragPreTileSnapshot.delete(snapWindowId)
      return
    }
    const currentWindow = allWindowsMap().get(snapWindowId)
    const preTile =
      dragPreTileSnapshot.get(snapWindowId) ??
      workspacePreTileSnapshot(snapWindowId) ??
      (currentWindow
        ? {
            x: currentWindow.x,
            y: currentWindow.y,
            w: currentWindow.width,
            h: currentWindow.height,
          }
        : null)
    const origin = layoutCanvasOrigin()
    const reserveTaskbar = reserveTaskbarForMon(snapScreen)
    const work = monitorWorkAreaGlobal(snapScreen, reserveTaskbar)
    const workRect: TileRect = { x: work.x, y: work.y, width: work.w, height: work.h }
    const occupied = occupiedSnapZonesOnMonitor(snapScreen, snapWindowId)
    const globalBounds = snapZoneToBoundsWithOccupied(droppedZone, workRect, occupied)
    if (preTile ? !sendSetPreTileGeometry(snapWindowId, preTile) : !sendClearPreTileGeometry(snapWindowId)) return
    if (!sendSetMonitorTile(snapWindowId, snapScreen.name, droppedZone, globalBounds)) return
    const localBounds = rectGlobalToCanvasLocal(
      globalBounds.x,
      globalBounds.y,
      globalBounds.width,
      globalBounds.height,
      origin,
    )
    shellWireSend(
      'set_geometry',
      snapWindowId,
      localBounds.x,
      localBounds.y,
      localBounds.w,
      localBounds.h,
      SHELL_LAYOUT_FLOATING,
    )
    applyGeometryToWindowMaps(snapWindowId, localBounds, { maximized: false })
    dragPreTileSnapshot.delete(snapWindowId)
    scheduleExclusionZonesSync()
    bumpSnapChrome()
  }

  function openSnapAssistPicker(
    windowId: number,
    source: SnapAssistPickerSource,
    anchorRect: DOMRect,
    autoHover = true,
    preferredMonitorName?: string | null,
  ) {
    const context = resolveSnapAssistContext(windowId, preferredMonitorName)
    if (!context) return
    clearSnapAssistSelection()
    setSnapAssistPicker({
      windowId,
      monitorName: context.screen.name,
      source,
      anchorRect: snapAssistAnchorRect(anchorRect),
      autoHover,
    })
  }

  /** Shell → compositor window move (same wire as `cef_host` `shell_uplink`). */
  let shellWindowDrag: { windowId: number; lastX: number; lastY: number } | null = null
  let shellMoveDeltaLogSeq = 0

  type ShellResizeSession =
    | { kind: 'compositor'; windowId: number; lastX: number; lastY: number }
    | {
        kind: 'tiled'
        windowId: number
        lastX: number
        lastY: number
        edges: number
        accumDx: number
        accumDy: number
        initialRects: Map<number, TileRect>
        outputName: string
      }

  let shellWindowResize: ShellResizeSession | null = null
  let shellResizeDeltaLogSeq = 0

  function flushTilePreviewWire() {
    tilePreviewRaf = 0
    if (snapAssistPicker()) {
      if (lastTilePreviewKey !== '0') {
        lastTilePreviewKey = '0'
        shellWireSend('set_tile_preview', 0, 0, 0, 0, 0)
      }
      return
    }
    const snap = activeSnapPreviewCanvas
    if (!snap) {
      if (lastTilePreviewKey !== '0') {
        lastTilePreviewKey = '0'
        shellWireSend('set_tile_preview', 0, 0, 0, 0, 0)
      }
      return
    }
    const k = `${snap.x},${snap.y},${snap.w},${snap.h}`
    if (k !== lastTilePreviewKey) {
      lastTilePreviewKey = k
      shellWireSend('set_tile_preview', 1, snap.x, snap.y, snap.w, snap.h)
    }
  }

  function scheduleTilePreviewSync() {
    if (tilePreviewRaf) return
    tilePreviewRaf = requestAnimationFrame(() => flushTilePreviewWire())
  }

  function beginShellWindowMove(windowId: number, clientX: number, clientY: number) {
    if (shellWindowResize !== null) return
    shellMoveLog('titlebar_begin_request', { windowId, clientX, clientY })
    shellMoveDeltaLogSeq = 0
    closeSnapAssistPicker()
    clearTilePreviewWire()
    const main = mainRef
    const og = outputGeom()
    const w = allWindowsMap().get(windowId)
    if (main && og && w) {
      const mainRect = main.getBoundingClientRect()
      const ptrCl = clientPointToCanvasLocal(clientX, clientY, mainRect, og.w, og.h)
      const co = layoutCanvasOrigin()
      if (w.maximized) {
        const rest = floatBeforeMaximize.get(windowId) ?? {
          x: w.x,
          y: w.y,
          w: Math.max(360, Math.floor(w.width * 0.55)),
          h: Math.max(280, Math.floor(w.height * 0.55)),
        }
        const list = screensListForLayout(screenDraft.rows, outputGeom(), co)
        const globPtr = clientPointToGlobalLogical(clientX, clientY, mainRect, og.w, og.h, co)
        const mon = pickScreenForPointerSnap(globPtr.x, globPtr.y, list)
        let maxCanvasX = w.x
        let maxCanvasY = w.y
        if (mon) {
          const reserveTb = reserveTaskbarForMon(mon)
          const mg = shellMaximizedWorkAreaGlobalRect(mon, reserveTb)
          const loc = rectGlobalToCanvasLocal(mg.x, mg.y, mg.w, mg.h, co)
          maxCanvasX = loc.x
          maxCanvasY = loc.y
        }
        const grabDx = ptrCl.x - maxCanvasX
        const grabDy = ptrCl.y - maxCanvasY
        const nx = ptrCl.x - grabDx + CHROME_BORDER_PX
        const ny = ptrCl.y - grabDy + CHROME_BORDER_PX
        shellWireSend('set_geometry', windowId, nx, ny, rest.w, rest.h, SHELL_LAYOUT_FLOATING)
        floatBeforeMaximize.delete(windowId)
        applyGeometryToWindowMaps(windowId, { x: nx, y: ny, w: rest.w, h: rest.h }, { maximized: false })
        dragPreTileSnapshot.set(windowId, { x: nx, y: ny, w: rest.w, h: rest.h })
        scheduleExclusionZonesSync()
        bumpSnapChrome()
      } else if (workspaceIsWindowTiled(workspaceState(), windowId)) {
        const tr = workspacePreTileSnapshot(windowId)
        if (tr) {
          const grabDx = ptrCl.x - w.x
          const grabDy = ptrCl.y - w.y
          const nx = ptrCl.x - grabDx + CHROME_BORDER_PX
          const ny = ptrCl.y - grabDy + CHROME_BORDER_PX
          shellWireSend('set_geometry', windowId, nx, ny, tr.w, tr.h, SHELL_LAYOUT_FLOATING)
          applyGeometryToWindowMaps(windowId, { x: nx, y: ny, w: tr.w, h: tr.h }, { maximized: false })
        }
        if (!sendRemoveMonitorTile(windowId)) return
        if (!sendClearPreTileGeometry(windowId)) return
        dragPreTileSnapshot.set(windowId, tr ?? { x: w.x, y: w.y, w: w.width, h: w.height })
        scheduleExclusionZonesSync()
        bumpSnapChrome()
      } else {
        dragPreTileSnapshot.set(windowId, { x: w.x, y: w.y, w: w.width, h: w.height })
      }
    }
    if (!shellWireSend('move_begin', windowId)) {
      shellMoveLog('titlebar_begin_aborted', { windowId, reason: 'no __derpShellWireSend' })
      return
    }
    shellWindowDrag = { windowId, lastX: Math.round(clientX), lastY: Math.round(clientY) }
    setDragWindowId(windowId)
    shellMoveLog('titlebar_begin_armed', { windowId, clientX, clientY })
  }

  /** Optimistic HUD position in output-local integers; matches compositor `move_delta` after layout unification. */
  function bumpShellWindowPosition(windowId: number, dx: number, dy: number) {
    patchWindowDrafts(workspaceGroupWindowIds(workspaceState(), windowId), (_windowId, current) => ({
      x: current.x + dx,
      y: current.y + dy,
    }))
  }

  function isShellHostedWindow(windowId: number): boolean {
    const flags = windows().get(windowId)?.shell_flags ?? 0
    return (flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) !== 0
  }

  function applyShellWindowMove(clientX: number, clientY: number) {
    if (!shellWindowDrag) return
    const cx = Math.round(clientX)
    const cy = Math.round(clientY)
    const dClientX = cx - shellWindowDrag.lastX
    const dClientY = cy - shellWindowDrag.lastY
    const wid = shellWindowDrag.windowId
    if (dClientX !== 0 || dClientY !== 0) {
      const main = mainRef
      const og = outputGeom()
      const { dx, dy } =
        main && og
          ? clientPointerDeltaToCanvasLogical(dClientX, dClientY, main.getBoundingClientRect(), og.w, og.h)
          : { dx: dClientX, dy: dClientY }
      if (dx !== 0 || dy !== 0) {
        shellMoveDeltaLogSeq += 1
        if (shellMoveDeltaLogSeq <= 12 || shellMoveDeltaLogSeq % 30 === 0) {
          shellMoveLog('titlebar_delta', { seq: shellMoveDeltaLogSeq, dx, dy, clientX, clientY })
        }
        const shellHosted = isShellHostedWindow(wid)
        batch(() => {
          bumpShellWindowPosition(wid, dx, dy)
          if (!shellHosted) {
            shellWireSend('move_delta', dx, dy)
          }
        })
      }
      shellWindowDrag.lastX = cx
      shellWindowDrag.lastY = cy
    }
    const main = mainRef
    const og = outputGeom()
    const co = layoutCanvasOrigin()
    if (!main || !og) return
    const mainRect = main.getBoundingClientRect()
    const glob = clientPointToGlobalLogical(cx, cy, mainRect, og.w, og.h, co)
    const list = screensListForLayout(screenDraft.rows, outputGeom(), co)
    const mon = pickScreenForPointerSnap(glob.x, glob.y, list)
    const pickerEl = main.querySelector('[data-shell-snap-picker]') as HTMLElement | null
    const pickerOpen = snapAssistPicker()?.source === 'strip' && snapAssistPicker()?.windowId === wid
    if (pickerEl) {
      const pickerRect = pickerEl.getBoundingClientRect()
      if (
        pickerOpen &&
        cx >= pickerRect.left &&
        cx <= pickerRect.right &&
        cy >= pickerRect.top &&
        cy <= pickerRect.bottom
      ) {
        return
      }
    }
    const stripEl = main.querySelector('[data-shell-snap-strip-trigger]') as HTMLElement | null
    if (stripEl) {
      const stripRect = stripEl.getBoundingClientRect()
      if (cx >= stripRect.left && cx <= stripRect.right && cy >= stripRect.top && cy <= stripRect.bottom) {
        if (!pickerOpen) {
          openSnapAssistPicker(wid, 'strip', stripRect, false, mon?.name)
        }
        return
      }
    }
    if (pickerOpen) {
      closeSnapAssistPicker()
    }
    if (!mon) {
      clearSnapAssistSelection()
      return
    }
    const context = resolveSnapAssistContext(wid, mon.name)
    if (!context) {
      clearSnapAssistSelection()
      return
    }
    const work = context.workGlobal
    const inAssistTopStrip =
      glob.x >= work.x &&
      glob.x <= work.x + work.w &&
      ((glob.y >= work.y && glob.y <= work.y + TILE_SNAP_EDGE_PX) ||
        (glob.y < work.y && work.y - glob.y <= TILE_SNAP_EDGE_PX))

    if (inAssistTopStrip) {
      const pxForAssist = Math.max(work.x, Math.min(glob.x, work.x + work.w))
      const pyForAssist = Math.max(work.y, Math.min(glob.y, work.y + work.h))
      const span = assistSpanFromWorkAreaPoint(pxForAssist, pyForAssist, context.shape, work)
      updateSnapAssistFromSpan(context, span)
      return
    }

    const zone = hitTestSnapZoneGlobal(glob.x, glob.y, work)
    updateSnapAssistFromEdgeZone(context, zone)
  }

  function endShellWindowMove(reason: string) {
    if (!shellWindowDrag) return
    const id = shellWindowDrag.windowId
    shellMoveLog('titlebar_end', { windowId: id, reason })
    shellWindowDrag = null
    setDragWindowId(null)
    commitSnapAssistSelection(id, snapAssistPicker()?.source === 'strip' && snapAssistPicker()?.windowId === id)
    shellWireSend('move_end', id)
  }

  function beginShellWindowResize(windowId: number, edges: number, clientX: number, clientY: number) {
    if (shellWindowResize !== null || shellWindowDrag !== null) return
    shellResizeDeltaLogSeq = 0
    const mon = workspaceFindMonitorForTiledWindow(workspaceState(), windowId)
    const tol = TILE_RESIZE_EDGE_ALIGN_PX
    let useTiledPropagate = false
    const initialRects = new Map<number, TileRect>()
    if (mon !== null) {
      const rects = workspaceTiledRectMap(mon)
      const dirs: Array<'left' | 'right' | 'top' | 'bottom'> = []
      if (edges & SHELL_RESIZE_LEFT) dirs.push('left')
      if (edges & SHELL_RESIZE_RIGHT) dirs.push('right')
      if (edges & SHELL_RESIZE_TOP) dirs.push('top')
      if (edges & SHELL_RESIZE_BOTTOM) dirs.push('bottom')
      const seen = new Set<number>([windowId])
      for (const dir of dirs) {
        for (const nid of findEdgeNeighborsInMap(rects, windowId, dir, tol)) {
          seen.add(nid)
        }
      }
      if (seen.size > 1) {
        useTiledPropagate = true
        for (const sid of seen) {
          const rect = rects.get(sid)
          if (rect) initialRects.set(sid, { ...rect })
        }
      }
    }
    if (useTiledPropagate && mon !== null) {
      if (!shellWireSend('resize_shell_grab_begin', windowId)) return
      shellWindowResize = {
        kind: 'tiled',
        windowId,
        lastX: Math.round(clientX),
        lastY: Math.round(clientY),
        edges,
        accumDx: 0,
        accumDy: 0,
        initialRects,
        outputName: mon,
      }
      shellMoveLog('resize_begin_tiled', { windowId, edges, clientX, clientY })
      return
    }
    if (!shellWireSend('resize_begin', windowId, edges)) return
    shellWindowResize = {
      kind: 'compositor',
      windowId,
      lastX: Math.round(clientX),
      lastY: Math.round(clientY),
    }
    shellMoveLog('resize_begin', { windowId, edges, clientX, clientY })
  }

  function applyShellWindowResize(clientX: number, clientY: number) {
    if (!shellWindowResize) return
    const cx = Math.round(clientX)
    const cy = Math.round(clientY)
    const dClientX = cx - shellWindowResize.lastX
    const dClientY = cy - shellWindowResize.lastY
    if (dClientX === 0 && dClientY === 0) return
    const main = mainRef
    const og = outputGeom()
    const { dx, dy } =
      main && og
        ? clientPointerDeltaToCanvasLogical(dClientX, dClientY, main.getBoundingClientRect(), og.w, og.h)
        : { dx: dClientX, dy: dClientY }
    if (dx === 0 && dy === 0) {
      shellWindowResize.lastX = cx
      shellWindowResize.lastY = cy
      return
    }
    if (shellWindowResize.kind === 'compositor') {
      shellResizeDeltaLogSeq += 1
      if (shellResizeDeltaLogSeq <= 12 || shellResizeDeltaLogSeq % 30 === 0) {
        shellMoveLog('resize_delta', { seq: shellResizeDeltaLogSeq, dx, dy, clientX, clientY })
      }
      if (!isShellHostedWindow(shellWindowResize.windowId)) {
        shellWireSend('resize_delta', dx, dy)
      }
      shellWindowResize.lastX = cx
      shellWindowResize.lastY = cy
      return
    }
    shellWindowResize.accumDx += dx
    shellWindowResize.accumDy += dy
    shellWindowResize.lastX = cx
    shellWindowResize.lastY = cy
    const co = layoutCanvasOrigin()
    const rects = computeTiledResizeRects(
      shellWindowResize.windowId,
      shellWindowResize.edges,
      shellWindowResize.accumDx,
      shellWindowResize.accumDy,
      shellWindowResize.initialRects,
      TILED_RESIZE_MIN_W,
      TILED_RESIZE_MIN_H,
    )
    for (const [wid, gr] of rects) {
      const loc = rectGlobalToCanvasLocal(gr.x, gr.y, gr.width, gr.height, co)
      shellWireSend('set_geometry', wid, loc.x, loc.y, loc.w, loc.h, SHELL_LAYOUT_FLOATING)
    }
    patchWindowDrafts(
      Array.from(rects.keys()),
      (wid) => {
        const gr = rects.get(wid)!
        const loc = rectGlobalToCanvasLocal(gr.x, gr.y, gr.width, gr.height, co)
        return { x: loc.x, y: loc.y, width: loc.w, height: loc.h, maximized: false }
      },
    )
    scheduleExclusionZonesSync()
    bumpSnapChrome()
  }

  function endShellWindowResize(reason: string) {
    if (!shellWindowResize) return
    const id = shellWindowResize.windowId
    if (shellWindowResize.kind === 'compositor') {
      shellMoveLog('resize_end', { windowId: id, reason })
      shellWindowResize = null
      shellWireSend('resize_end', id)
      return
    }
    const s = shellWindowResize
    shellWindowResize = null
    shellMoveLog('resize_end_tiled', { windowId: id, reason })
    const rects = computeTiledResizeRects(
      s.windowId,
      s.edges,
      s.accumDx,
      s.accumDy,
      s.initialRects,
      TILED_RESIZE_MIN_W,
      TILED_RESIZE_MIN_H,
    )
    for (const [windowId, bounds] of rects) {
      if (!sendSetMonitorTile(windowId, s.outputName, workspaceGetTiledZone(workspaceState(), windowId) ?? 'auto-fill', bounds)) {
        return
      }
    }
    bumpSnapChrome()
    shellWireSend('resize_shell_grab_end')
  }

  async function spawnInCompositor(
    cmd: string,
    launch?: NativeLaunchMetadata | null,
    sessionRestore = false,
    forcedWindowRef?: SessionWindowRef | null,
  ) {
    const trimmed = cmd.trim()
    if (!trimmed) return
    const effectiveLaunch =
      launch && launch.command.trim().length > 0
        ? {
            command: launch.command.trim(),
            desktopId: launch.desktopId?.trim() || null,
            appName: launch.appName?.trim() || null,
          }
        : {
            command: trimmed,
            desktopId: null,
            appName: null,
          }
    const pendingWindowRef = forcedWindowRef ?? nativeWindowRef(nextNativeWindowSeq())
    if (!forcedWindowRef) {
      setNextNativeWindowSeq((seq) => seq + 1)
    }
    pendingNativeLaunches.push({ windowRef: pendingWindowRef, launch: effectiveLaunch })
    nativeLaunchMetadataByRef.set(pendingWindowRef, effectiveLaunch)
    try {
      if (shellWireSend('spawn', trimmed)) {
        clearShellActionIssue()
        return
      }
      await spawnViaShellHttp(trimmed, window.__DERP_SPAWN_URL, {
        desktop_id: effectiveLaunch.desktopId ?? undefined,
        app_name: effectiveLaunch.appName ?? undefined,
        session_restore: sessionRestore,
      })
      clearShellActionIssue()
    } catch (error) {
      const index = pendingNativeLaunches.findIndex((entry) => entry.windowRef === pendingWindowRef)
      if (index >= 0) pendingNativeLaunches.splice(index, 1)
      nativeLaunchMetadataByRef.delete(pendingWindowRef)
      reportShellActionIssue(`Launch failed: ${describeError(error)}`)
    }
  }

  onMount(() => {
    const stopThemeDomSync = startThemeDomSync()
    onCleanup(stopThemeDomSync)
    const stopShellWindowStateSync = subscribeShellWindowState(() => {
      setShellWindowStateRev((n) => n + 1)
    })
    onCleanup(stopShellWindowStateSync)
    void refreshThemeSettingsFromRemote()
    void desktopApps.warm()
    void shellContextMenus.warmProgramsMenuItems()
    void loadSessionSnapshot()
      .then((snapshot) => {
        const hasSnapshotData = sessionSnapshotHasData(snapshot)
        setSavedSessionAvailable(hasSnapshotData)
        if (!hasSnapshotData) {
          lastPersistedSessionJson = JSON.stringify(snapshot)
          setNextNativeWindowSeq(snapshot.nextNativeWindowSeq)
          setSessionPersistenceReady(true)
          return
        }
        void startSessionRestore(snapshot)
      })
      .catch((error) => {
        console.warn('[derp-shell-session] load failed', error)
        setSessionPersistenceReady(true)
      })
    console.log(
      '[derp-shell-move] shell App onMount (expect cef_js_console in compositor.log when CEF forwards this prefix)',
    )
    let volumeOverlayHideTimer: ReturnType<typeof setTimeout> | undefined
    let compositorSyncAttempts = 0
    let compositorSyncRaf = 0
    let nativeWireHadBeenReady = false
    onCleanup(() => {
      if (backedWindowOpenRaf !== 0) cancelAnimationFrame(backedWindowOpenRaf)
      if (sessionPersistTimer !== undefined) clearTimeout(sessionPersistTimer)
      if (sessionRestoreStopTimer !== undefined) clearTimeout(sessionRestoreStopTimer)
      if (sessionPersistPoll !== undefined) clearInterval(sessionPersistPoll)
      if (compositorSyncRaf !== 0) cancelAnimationFrame(compositorSyncRaf)
    })
    sessionPersistPoll = setInterval(() => {
      if (!sessionAutoSaveReady()) return
      void persistLiveSessionSnapshotSoon('auto', sessionPersistGeneration)
    }, 1000)
    const requestCompositorSync = () => {
      if (shellWireSend('request_compositor_sync')) {
        compositorSyncAttempts = 0
        if (!nativeWireHadBeenReady) setShellWireReadyRev((value) => value + 1)
        nativeWireHadBeenReady = true
        clearShellWireIssue()
        shellWireSend('set_chrome_metrics', CHROME_TITLEBAR_PX, CHROME_BORDER_PX)
        return
      }
      compositorSyncAttempts += 1
      reportShellWireIssue(shellWireIssueMessage())
      if (compositorSyncAttempts >= 120) return
      compositorSyncRaf = requestAnimationFrame(() => {
        compositorSyncRaf = 0
        requestCompositorSync()
      })
    }
    queueMicrotask(requestCompositorSync)
    queueMicrotask(() => {
      shellWireSend('set_chrome_metrics', CHROME_TITLEBAR_PX, CHROME_BORDER_PX)
    })
    window.__DERP_E2E_REQUEST_SNAPSHOT = (requestId: number) => {
      publishE2eShellSnapshot(requestId)
    }
    window.__DERP_E2E_REQUEST_HTML = (requestId: number, selector?: string | null) => {
      publishE2eShellHtml(requestId, selector)
    }
    window.__DERP_E2E_OPEN_TEST_WINDOW = () => openShellTestWindow()

    wireWatchPoll = setInterval(() => {
      if (!nativeWireHadBeenReady) return
      if (typeof window.__derpShellWireSend === 'function') {
        clearShellWireIssue()
        return
      }
      reportShellWireIssue(shellWireIssueMessage())
      nativeWireHadBeenReady = false
      compositorSyncAttempts = 0
      requestCompositorSync()
    }, 750)

    const applyKeyboardLayoutDetail = (d: Extract<DerpShellDetail, { type: 'keyboard_layout' }>) => {
      const label = typeof d.label === 'string' ? d.label.trim() : ''
      setKeyboardLayoutLabel(label.length > 0 ? label : null)
    }

    const applyVolumeOverlayDetail = (d: Extract<DerpShellDetail, { type: 'volume_overlay' }>) => {
      if (volumeOverlayHideTimer !== undefined) clearTimeout(volumeOverlayHideTimer)
      const linRaw = d.volume_linear_percent_x100
      const lin = typeof linRaw === 'number' && Number.isFinite(linRaw) ? Math.max(0, linRaw) : 0
      setVolumeOverlay({
        linear: lin,
        muted: !!d.muted,
        stateKnown: d.state_known !== false,
      })
      setTrayVolumeState({
        muted: !!d.muted,
        volumePercent: d.state_known === false ? null : Math.min(100, Math.round(lin / 100)),
      })
      volumeOverlayHideTimer = setTimeout(() => {
        setVolumeOverlay(null)
        volumeOverlayHideTimer = undefined
      }, 2200)
      dispatchAudioStateChanged({ reason: 'volume_overlay' })
    }

    const applyTrayHintsDetail = (d: Extract<DerpShellDetail, { type: 'tray_hints' }>) => {
      const rw = typeof d.reserved_w === 'number' && Number.isFinite(d.reserved_w) ? Math.max(0, d.reserved_w) : 0
      setTrayReservedPx(rw)
      const sw =
        typeof d.slot_w === 'number' && Number.isFinite(d.slot_w)
          ? Math.max(24, Math.min(64, Math.round(d.slot_w)))
          : 40
      setTrayIconSlotPx(sw)
      queueMicrotask(() => scheduleExclusionZonesSync())
    }

    const applyTraySniDetail = (d: Extract<DerpShellDetail, { type: 'tray_sni' }>) => {
      const raw = (d as { items?: unknown }).items
      const next: TaskbarSniItem[] = []
      if (Array.isArray(raw)) {
        for (const row of raw) {
          if (row && typeof row === 'object') {
            const o = row as Record<string, unknown>
            const id = typeof o.id === 'string' ? o.id : ''
            const title = typeof o.title === 'string' ? o.title : ''
            const icon_base64 = typeof o.icon_base64 === 'string' ? o.icon_base64 : ''
            if (id) next.push({ id, title, icon_base64 })
          }
        }
      }
      setSniTrayItems(next)
      queueMicrotask(() => scheduleExclusionZonesSync())
    }

    const applyOutputGeometryDetail = (d: Extract<DerpShellDetail, { type: 'output_geometry' }>) => {
      setOutputGeom({ w: d.logical_width, h: d.logical_height })
      scheduleCompositorFollowup({ syncExclusion: true, flushWindows: true })
    }

    const applyOutputLayoutDetail = (d: Extract<DerpShellDetail, { type: 'output_layout' }>) => {
      batch(() => {
        setOutputGeom({ w: d.canvas_logical_width, h: d.canvas_logical_height })
        setOutputPhysical({
          w: d.canvas_physical_width,
          h: d.canvas_physical_height,
        })
        if (
          typeof d.context_menu_atlas_buffer_h === 'number' &&
          d.context_menu_atlas_buffer_h > 0
        ) {
          setContextMenuAtlasBufferH(d.context_menu_atlas_buffer_h)
        }
        if (typeof d.canvas_logical_origin_x === 'number' && typeof d.canvas_logical_origin_y === 'number') {
          setLayoutCanvasOrigin({ x: d.canvas_logical_origin_x, y: d.canvas_logical_origin_y })
        } else {
          setLayoutCanvasOrigin(null)
        }
        {
          const lw = Math.max(1, d.canvas_logical_width)
          const pw = Math.max(1, d.canvas_physical_width)
          const s = (pw / lw) * 100
          const candidates = [100, 150, 200] as const
          let best: (typeof candidates)[number] = 150
          let bestD = Number.POSITIVE_INFINITY
          for (const c of candidates) {
            const dist = Math.abs(s - c)
            if (dist < bestD) {
              bestD = dist
              best = c
            }
          }
          setUiScalePercent(best)
        }
        setScreenDraft(
          'rows',
          d.screens.map((s) => ({
            name: s.name,
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
            transform: s.transform,
            refresh_milli_hz: typeof s.refresh_milli_hz === 'number' ? s.refresh_milli_hz : 0,
          })),
        )
        setTilingCfgRev((n) => n + 1)
        const pr =
          typeof d.shell_chrome_primary === 'string' && d.shell_chrome_primary.length > 0
            ? d.shell_chrome_primary
            : null
        setShellChromePrimaryName(pr)
      })
      scheduleCompositorFollowup({
        syncExclusion: true,
        flushWindows: true,
        relayoutAll: true,
        resetScroll: true,
      })
    }

    const applySnapshotVisualDetail = (
      d: DerpShellDetail,
      skipOutputGeometry: boolean,
    ) => {
      if (d.type === 'keyboard_layout') {
        applyKeyboardLayoutDetail(d)
        return true
      }
      if (d.type === 'volume_overlay') {
        applyVolumeOverlayDetail(d)
        return true
      }
      if (d.type === 'tray_hints') {
        applyTrayHintsDetail(d)
        return true
      }
      if (d.type === 'tray_sni') {
        applyTraySniDetail(d)
        return true
      }
      if (d.type === 'output_geometry') {
        if (!skipOutputGeometry) applyOutputGeometryDetail(d)
        return true
      }
      if (d.type === 'output_layout') {
        applyOutputLayoutDetail(d)
        return true
      }
      return false
    }

    const applyCompositorSnapshot = (details: readonly DerpShellDetail[]) => {
      if (details.length === 0) return
      const skipOutputGeometry = details.some((detail) => detail.type === 'output_layout')
      let sawWindowList = false
      batch(() => {
        applyModelCompositorSnapshot(details)
        for (const detail of details) {
          if (detail.type === 'window_list') {
            sawWindowList = true
            continue
          }
          applySnapshotVisualDetail(detail, skipOutputGeometry)
        }
        if (sawWindowList) setHasSeenCompositorWindowSync(true)
      })
      if (sawWindowList) windowSyncRecoveryPending = false
    }

    const applyCompositorDetail = (d: DerpShellDetail) => {
      if (d.type === 'context_menu_dismiss') {
        closeAllAtlasSelects()
        shellContextMenus.hideContextMenu()
        return
      }
      if (d.type === 'programs_menu_toggle') {
        shellContextMenus.toggleProgramsMenuMeta(typeof d.output_name === 'string' ? d.output_name : null)
        return
      }
      if (d.type === 'compositor_ping') {
        shellWireSend('shell_ipc_pong')
        return
      }
      if (d.type === 'keyboard_layout') {
        applyKeyboardLayoutDetail(d)
        return
      }
      if (d.type === 'volume_overlay') {
        applyVolumeOverlayDetail(d)
        return
      }
      if (d.type === 'tray_hints') {
        applyTrayHintsDetail(d)
        return
      }
      if (d.type === 'tray_sni') {
        applyTraySniDetail(d)
        return
      }
      if (d.type === 'tray_sni_menu') {
        const raw = d as Record<string, unknown>
        const rs = raw.request_serial
        const request_serial =
          typeof rs === 'number' && Number.isFinite(rs)
            ? rs >>> 0
            : typeof rs === 'string'
              ? Number.parseInt(rs, 10) >>> 0
              : 0
        const notifier_id = typeof raw.notifier_id === 'string' ? raw.notifier_id : ''
        const menu_path = typeof raw.menu_path === 'string' ? raw.menu_path : ''
        const entries: TraySniMenuEntry[] = []
        const entRaw = raw.entries
        if (Array.isArray(entRaw)) {
          for (const row of entRaw) {
            if (!row || typeof row !== 'object') continue
            const o = row as Record<string, unknown>
            const idRaw = o.dbusmenu_id
            const dbusmenu_id =
              typeof idRaw === 'number' && Number.isFinite(idRaw)
                ? Math.trunc(idRaw)
                : typeof idRaw === 'string'
                  ? Math.trunc(Number(idRaw))
                  : 0
            const label = typeof o.label === 'string' ? o.label : ''
            const separator = !!o.separator
            const enabled = o.enabled !== false
            entries.push({ dbusmenu_id, label, separator, enabled })
          }
        }
        shellContextMenus.applyTraySniMenuDetail({
          request_serial,
          notifier_id,
          menu_path,
          entries,
        })
        return
      }
      if (d.type === 'keybind') {
        const action = typeof d.action === 'string' ? d.action : ''
        const fid = focusedWindowId()
        const wmap = allWindowsMap()
        if (action === 'launch_terminal') {
          void spawnInCompositor('foot')
          return
        }
        if (action === 'close_focused') {
          if (fid !== null) shellWireSend('close', fid)
          return
        }
        if (action === 'toggle_programs_menu') {
          shellContextMenus.toggleProgramsMenuMeta(
            typeof d.output_name === 'string' ? d.output_name : null,
          )
          return
        }
        if (action === 'open_settings') {
          toggleSettingsShellWindow()
          return
        }
        if (action === 'tab_next') {
          cycleFocusedWorkspaceGroup(1)
          return
        }
        if (action === 'tab_previous') {
          cycleFocusedWorkspaceGroup(-1)
          return
        }
        if (action === 'screenshot_region') {
          beginScreenshotMode()
          return
        }
        if (action === 'toggle_fullscreen') {
          if (fid === null) return
          const w = wmap.get(fid)
          if (!w) return
          shellWireSend('set_fullscreen', fid, w.fullscreen ? 0 : 1)
          return
        }
        if (action === 'toggle_maximize') {
          const fromEv = coerceShellWindowId(d.target_window_id)
          const tid = fromEv ?? fid
          if (tid === null) return
          toggleShellMaximizeForWindow(tid)
          return
        }
        if (action === 'move_monitor_left' || action === 'move_monitor_right') {
          if (fid === null) return
          const w = wmap.get(fid)
          if (!w || w.minimized || w.fullscreen) return
          const co = layoutCanvasOrigin()
          const list = screensListForLayout(screenDraft.rows, outputGeom(), co)
          const curMon = pickScreenForWindow(w, list, co) ?? list[0] ?? null
          if (!curMon) return
          const tgtMon = findAdjacentMonitor(
            curMon,
            list,
            action === 'move_monitor_left' ? 'left' : 'right',
          )
          if (!tgtMon) return
          const reserveCur = reserveTaskbarForMon(curMon)
          const reserveTgt = reserveTaskbarForMon(tgtMon)
          const glob = rectCanvasLocalToGlobal(w.x, w.y, w.width, w.height, co)
          let gRect: { x: number; y: number; w: number; h: number }
          let layoutFlag: typeof SHELL_LAYOUT_FLOATING | typeof SHELL_LAYOUT_MAXIMIZED
          if (w.maximized) {
            gRect = shellMaximizedWorkAreaGlobalRect(tgtMon, reserveTgt)
            layoutFlag = SHELL_LAYOUT_MAXIMIZED
          } else if (workspaceIsWindowTiled(workspaceState(), fid)) {
            const zone = workspaceGetTiledZone(workspaceState(), fid)!
            const tw = monitorWorkAreaGlobal(tgtMon, reserveTgt)
            const workRect: TileRect = { x: tw.x, y: tw.y, width: tw.w, height: tw.h }
            const occ = occupiedSnapZonesOnMonitor(tgtMon, fid)
            const gb = snapZoneToBoundsWithOccupied(zone, workRect, occ)
            if (!sendSetMonitorTile(fid, tgtMon.name, zone, gb)) return
            gRect = { x: gb.x, y: gb.y, w: gb.width, h: gb.height }
            layoutFlag = SHELL_LAYOUT_FLOATING
          } else {
            const srcWork = monitorWorkAreaGlobal(curMon, reserveCur)
            const tgtWork = monitorWorkAreaGlobal(tgtMon, reserveTgt)
            const relY = glob.y - srcWork.y
            let newGlobX = tgtWork.x + Math.floor((tgtWork.w - glob.w) / 2)
            let newGlobY = tgtWork.y + relY
            const maxX = tgtWork.x + tgtWork.w - glob.w
            const maxY = tgtWork.y + tgtWork.h - glob.h
            newGlobX = Math.max(tgtWork.x, Math.min(newGlobX, maxX))
            newGlobY = Math.max(tgtWork.y, Math.min(newGlobY, maxY))
            gRect = { x: newGlobX, y: newGlobY, w: glob.w, h: glob.h }
            layoutFlag = SHELL_LAYOUT_FLOATING
          }
          const loc = rectGlobalToCanvasLocal(gRect.x, gRect.y, gRect.w, gRect.h, co)
          shellWireSend('set_geometry', fid, loc.x, loc.y, loc.w, loc.h, layoutFlag)
          patchWindowDrafts([fid], () => ({
            output_name: tgtMon.name,
            x: loc.x,
            y: loc.y,
            width: loc.w,
            height: loc.h,
            maximized: layoutFlag === SHELL_LAYOUT_MAXIMIZED,
          }))
          scheduleExclusionZonesSync()
          bumpSnapChrome()
          queueMicrotask(() => {
            applyAutoLayout(curMon.name)
            applyAutoLayout(tgtMon.name)
          })
          return
        }
        if (action === 'tile_left' || action === 'tile_right') {
          if (fid === null) return
          const w = wmap.get(fid)
          if (!w || w.minimized) return
          const co = layoutCanvasOrigin()
          const list = screensListForLayout(screenDraft.rows, outputGeom(), co)
          const mon = pickScreenForWindow(w, list, co) ?? list[0] ?? null
          if (!mon) return
          const zone: SnapZone = action === 'tile_left' ? 'left-half' : 'right-half'
          const reserveTb = reserveTaskbarForMon(mon)
          const wr = monitorWorkAreaGlobal(mon, reserveTb)
          const workRect: TileRect = { x: wr.x, y: wr.y, width: wr.w, height: wr.h }
          const occ = occupiedSnapZonesOnMonitor(mon, fid)
          const gb = snapZoneToBoundsWithOccupied(zone, workRect, occ)
          const gRect = { x: gb.x, y: gb.y, w: gb.width, h: gb.height }
          const loc = rectGlobalToCanvasLocal(gRect.x, gRect.y, gRect.w, gRect.h, co)
          const preTile = w.maximized
            ? (floatBeforeMaximize.get(fid) ?? {
                x: w.x,
                y: w.y,
                w: w.width,
                h: w.height,
              })
            : { x: w.x, y: w.y, w: w.width, h: w.height }
          if (!sendSetPreTileGeometry(fid, preTile)) return
          if (!sendSetMonitorTile(fid, mon.name, zone, gb)) return
          if (w.maximized) floatBeforeMaximize.delete(fid)
          shellWireSend('set_geometry', fid, loc.x, loc.y, loc.w, loc.h, SHELL_LAYOUT_FLOATING)
          patchWindowDrafts([fid], () => ({
            x: loc.x,
            y: loc.y,
            width: loc.w,
            height: loc.h,
            maximized: false,
          }))
          scheduleExclusionZonesSync()
          bumpSnapChrome()
          return
        }
        if (action === 'tile_up') {
          if (fid === null) return
          toggleShellMaximizeForWindow(fid)
          return
        }
        if (action === 'tile_down') {
          if (fid === null) return
          const w = wmap.get(fid)
          if (!w || w.minimized) return
          if (w.maximized) {
            const rest = floatBeforeMaximize.get(fid) ?? {
              x: w.x,
              y: w.y,
              w: w.width,
              h: w.height,
            }
            floatBeforeMaximize.delete(fid)
            shellWireSend('set_geometry', fid, rest.x, rest.y, rest.w, rest.h, SHELL_LAYOUT_FLOATING)
            patchWindowDrafts([fid], () => ({
              x: rest.x,
              y: rest.y,
              width: rest.w,
              height: rest.h,
              maximized: false,
            }))
            scheduleExclusionZonesSync()
            bumpSnapChrome()
            return
          }
          if (workspaceIsWindowTiled(workspaceState(), fid)) {
            const tr = workspacePreTileSnapshot(fid)
            if (tr) {
              shellWireSend('set_geometry', fid, tr.x, tr.y, tr.w, tr.h, SHELL_LAYOUT_FLOATING)
              patchWindowDrafts([fid], () => ({
                x: tr.x,
                y: tr.y,
                width: tr.w,
                height: tr.h,
                maximized: false,
              }))
            }
            if (!sendRemoveMonitorTile(fid)) return
            if (!sendClearPreTileGeometry(fid)) return
            scheduleExclusionZonesSync()
            bumpSnapChrome()
            return
          }
          return
        }
        return
      }
      if (d.type === 'focus_changed') {
        const result = applyModelCompositorDetail(d, {
          fallbackMonitorKey,
          requestWindowSyncRecovery,
        })
        if (result.followup) scheduleCompositorFollowup(result.followup)
        return
      }
      if (d.type === 'output_geometry') {
        applyOutputGeometryDetail(d)
        return
      }
      if (d.type === 'output_layout') {
        applyOutputLayoutDetail(d)
        return
      }
      if (d.type === 'window_list') {
        setHasSeenCompositorWindowSync(true)
        windowSyncRecoveryPending = false
        const result = applyModelCompositorDetail(d, {
          fallbackMonitorKey,
          requestWindowSyncRecovery,
        })
        if (result.followup) scheduleCompositorFollowup(result.followup)
        return
      }
      if (d.type === 'workspace_state') {
        applyModelCompositorDetail(d, {
          fallbackMonitorKey,
          requestWindowSyncRecovery,
        })
        return
      }
      if (d.type === 'window_state') {
        setHasSeenCompositorWindowSync(true)
        const result = applyModelCompositorDetail(d, {
          fallbackMonitorKey,
          requestWindowSyncRecovery,
        })
        if (result.followup) scheduleCompositorFollowup(result.followup)
        return
      }
      if (d.type === 'window_unmapped') {
        setHasSeenCompositorWindowSync(true)
        const result = applyModelCompositorDetail(d, {
          fallbackMonitorKey,
          requestWindowSyncRecovery,
        })
        if (result.followup) scheduleCompositorFollowup(result.followup)
        return
      }
      if (d.type === 'window_geometry') {
        setHasSeenCompositorWindowSync(true)
        const result = applyModelCompositorDetail(d, {
          fallbackMonitorKey,
          requestWindowSyncRecovery,
        })
        if (result.kind === 'recovery_requested') return
        const wid = result.windowId ?? null
        if (wid !== null) {
          queueMicrotask(() => {
            const w2 = windows().get(wid)
            const fb = fallbackMonitorKey()
            const newMon = w2 ? w2.output_name || fb : null
            const prevMon = result.previousWindow?.output_name || fb
            if (newMon !== null && prevMon !== newMon) {
              applyAutoLayout(prevMon)
              applyAutoLayout(newMon)
            }
          })
        }
        return
      }
      if (d.type === 'window_mapped') {
        setHasSeenCompositorWindowSync(true)
        const result = applyModelCompositorDetail(d, {
          fallbackMonitorKey,
          requestWindowSyncRecovery,
        })
        if (result.followup) scheduleCompositorFollowup(result.followup)
        return
      }
      if (d.type === 'window_metadata') {
        setHasSeenCompositorWindowSync(true)
        applyModelCompositorDetail(d, {
          fallbackMonitorKey,
          requestWindowSyncRecovery,
        })
        return
      }
    }

    const applyCompositorBatch = (details: readonly DerpShellDetail[]) => {
      if (details.length === 0) return
      batch(() => {
        for (const detail of details) {
          applyCompositorDetail(detail)
        }
      })
    }

    let lastSnapshotSequence = 0
    const syncCompositorSnapshot = (force = false) => {
      const path = window.__DERP_COMPOSITOR_SNAPSHOT_PATH
      if (typeof path !== 'string' || path.length === 0) return false
      const readSnapshot = window.__derpCompositorSnapshotRead
      if (typeof readSnapshot !== 'function') return false
      const abi = window.__DERP_COMPOSITOR_SNAPSHOT_ABI ?? compositorSnapshotAbi()
      if (!force) {
        const snapshotVersion = window.__derpCompositorSnapshotVersion
        if (typeof snapshotVersion === 'function') {
          const version = snapshotVersion(path, abi)
          if (typeof version === 'number' && Number.isFinite(version) && version === lastSnapshotSequence) {
            return false
          }
        }
      }
      const raw = readSnapshot(path, abi)
      if (!(raw instanceof ArrayBuffer)) return false
      const decoded = decodeCompositorSnapshot(raw)
      if (!decoded || decoded.details.length === 0) return false
      lastSnapshotSequence = decoded.sequence
      applyCompositorSnapshot(decoded.details)
      return true
    }

    const onDerpShell = (ev: Event) => {
      const ce = ev as CustomEvent<DerpShellDetail>
      const d = ce.detail
      if (!d || typeof d !== 'object' || !('type' in d)) return
      applyCompositorBatch([d])
    }

    const onCompositorSnapshot = () => {
      syncCompositorSnapshot()
    }

    const removeCompositorBatchHandler = installCompositorBatchHandler((details) => {
      applyCompositorBatch(details)
    })

    window.addEventListener(DERP_SHELL_EVENT, onDerpShell as EventListener)
    window.addEventListener(DERP_SHELL_SNAPSHOT_EVENT, onCompositorSnapshot as EventListener)
    let bootstrapSnapshotRetry = 0
    let bootstrapSnapshotTimer: number | undefined
    const retryBootstrapSnapshot = () => {
      if (syncCompositorSnapshot(true)) {
        bootstrapSnapshotTimer = undefined
        return
      }
      bootstrapSnapshotRetry += 1
      if (bootstrapSnapshotRetry >= 40) {
        bootstrapSnapshotTimer = undefined
        return
      }
      bootstrapSnapshotTimer = window.setTimeout(retryBootstrapSnapshot, 100)
    }
    retryBootstrapSnapshot()
    queueMicrotask(() => {
      requestCompositorSync()
      syncCompositorSnapshot(true)
    })

    const syncViewport = () =>
      setViewportCss({ w: window.innerWidth, h: window.innerHeight })
    syncViewport()

    const onPointerMove = (e: PointerEvent) => {
      applyShellWindowMove(e.clientX, e.clientY)
      applyShellWindowResize(e.clientX, e.clientY)
      setPointerClient({ x: e.clientX, y: e.clientY })
      const el = mainRef
      if (el) {
        const r = el.getBoundingClientRect()
        setPointerInMain({
          x: Math.round(e.clientX - r.left),
          y: Math.round(e.clientY - r.top),
        })
      }
    }

    const onMouseMove = (e: MouseEvent) => {
      // Do not call applyShellWindowMove here: CEF/OSR fires both pointermove and mousemove for the same
      // motion → doubled dx/dy, doubled move_delta IPC, shell state and compositor desync (looks like
      // "everything drags wrong" with multiple windows).
      setPointerClient({ x: e.clientX, y: e.clientY })
      const el = mainRef
      if (el) {
        const r = el.getBoundingClientRect()
        setPointerInMain({
          x: Math.round(e.clientX - r.left),
          y: Math.round(e.clientY - r.top),
        })
      }
    }

    const onWindowPointerUp = (e: PointerEvent) => {
      if (!e.isPrimary) return
      endShellWindowResize('window-pointerup')
      endShellWindowMove('window-pointerup')
    }

    const onWindowMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return
      endShellWindowResize('window-mouseup')
      endShellWindowMove('window-mouseup')
    }

    const onWindowPointerCancel = (e: PointerEvent) => {
      if (!e.isPrimary) return
      endShellWindowResize('window-pointercancel')
      endShellWindowMove('window-pointercancel')
    }

    const onWindowBlur = () => {
      if (shellWindowDrag) {
        shellMoveLog('window_blur_while_shell_drag', {
          windowId: shellWindowDrag.windowId,
        })
      }
      if (shellWindowResize) {
        shellMoveLog('window_blur_while_shell_resize', {
          windowId: shellWindowResize.windowId,
        })
      }
      if (splitGroupGesture()) {
        setSplitGroupGesture(null)
        shellWireSend('shell_ui_grab_end')
      }
      if (screenshotMode()) stopScreenshotMode()
      if (portalPickerVisible()) closePortalPickerUi()
    }

    const onWindowTouchEnd = () => {
      endShellWindowResize('window-touchend')
      endShellWindowMove('window-touchend')
    }

    const onWindowTouchMove = (e: TouchEvent) => {
      const t = e.changedTouches[0]
      if (!t) return
      if (shellWindowDrag) {
        applyShellWindowMove(t.clientX, t.clientY)
        e.preventDefault()
      }
      if (shellWindowResize) {
        applyShellWindowResize(t.clientX, t.clientY)
        e.preventDefault()
      }
      setPointerClient({ x: t.clientX, y: t.clientY })
      const el = mainRef
      if (el) {
        const r = el.getBoundingClientRect()
        setPointerInMain({
          x: Math.round(t.clientX - r.left),
          y: Math.round(t.clientY - r.top),
        })
      }
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('mousemove', onMouseMove, { passive: true })
    window.addEventListener('pointerup', onWindowPointerUp, { passive: true })
    window.addEventListener('mouseup', onWindowMouseUp, { passive: true })
    window.addEventListener('pointercancel', onWindowPointerCancel, { passive: true })
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('touchend', onWindowTouchEnd, { passive: true })
    window.addEventListener('touchcancel', onWindowTouchEnd, { passive: true })
    window.addEventListener('touchmove', onWindowTouchMove, { passive: false })
    const onWindowResize = () => {
      syncViewport()
      invalidateAllShellUiWindows()
      scheduleExclusionZonesSync()
    }
    window.addEventListener('resize', onWindowResize, { passive: true })

    const onFullscreenChange = () => {
      shellWireSend('presentation_fullscreen', document.fullscreenElement ? 1 : 0)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)

    onCleanup(() => {
      if (volumeOverlayHideTimer !== undefined) clearTimeout(volumeOverlayHideTimer)
      if (bootstrapSnapshotTimer !== undefined) clearTimeout(bootstrapSnapshotTimer)
      removeCompositorBatchHandler()
      window.removeEventListener(DERP_SHELL_EVENT, onDerpShell as EventListener)
      window.removeEventListener(DERP_SHELL_SNAPSHOT_EVENT, onCompositorSnapshot as EventListener)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('pointerup', onWindowPointerUp)
      window.removeEventListener('mouseup', onWindowMouseUp)
      window.removeEventListener('pointercancel', onWindowPointerCancel)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('touchend', onWindowTouchEnd)
      window.removeEventListener('touchcancel', onWindowTouchEnd)
      window.removeEventListener('touchmove', onWindowTouchMove)
      window.removeEventListener('resize', onWindowResize)
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      delete window.__DERP_E2E_REQUEST_SNAPSHOT
      delete window.__DERP_E2E_REQUEST_HTML
      delete window.__DERP_E2E_OPEN_TEST_WINDOW
    })
  })
  onCleanup(() => {
    if (wireWatchPoll !== undefined) clearInterval(wireWatchPoll)
  })

  function copyDebugHudSnapshot() {
    const g = outputGeom()
    const payload = {
      t: Date.now(),
      shellBuild: shellBuildLabel,
      uiFps: hudFps(),
      screens: screenDraft.rows.map((r) => ({ ...r })),
      outputGeom: g ? { w: g.w, h: g.h } : null,
      windowCount: windowsList().length,
      layoutUnion: layoutUnionBbox(),
    }
    const text = JSON.stringify(payload)
    const clip = navigator.clipboard
    if (clip && typeof clip.writeText === 'function') {
      void clip.writeText(text)
    }
  }

  const shellFloatingRegistry: ShellFloatingRegistry = {
    openLayer: floatingLayers.openLayer,
    closeBranch: floatingLayers.closeBranch,
    closeAll: floatingLayers.closeAll,
    closeByKind: floatingLayers.closeByKind,
    closeTopmostEscapable: floatingLayers.closeTopmostEscapable,
    registerLayerSurface: floatingLayers.registerSurface,
    unregisterLayerSurface: floatingLayers.unregisterSurface,
    dismissPointerDown: floatingLayers.dismissPointerDown,
    setLayerPlacement: floatingLayers.setLayerPlacement,
    clearLayerPlacement: floatingLayers.clearLayerPlacement,
    hasLayer: floatingLayers.hasLayer,
    hasOpenKind: floatingLayers.hasOpenKind,
    anyOpen: floatingLayers.anyOpen,
    topmostLayerKind: floatingLayers.topmostLayerKind,
    layers: floatingLayers.layers,
    closeAllAtlasSelects,
    dismissContextMenus: shellContextMenus.hideContextMenu,
    acquireAtlasOverlayPointer,
    releaseAtlasOverlayPointer,
    mainEl: () => mainRef,
    atlasHostEl: shellContextMenus.atlasHostEl,
    atlasBufferH: contextMenuAtlasBufferH,
    menuAtlasTopPx: shellContextMenus.shellMenuAtlasTop,
    outputGeom,
    outputPhysical,
    layoutCanvasOrigin,
    screenDraftRows: () => screenDraft.rows,
  }

  return (
    <ShellFloatingProvider value={shellFloatingRegistry}>
    <ShellContextMenusProvider value={shellContextMenus}>
    <main
      data-shell-main
      classList={{
        'relative block box-border overflow-hidden bg-transparent font-sans text-(--shell-text) m-0 min-h-screen pb-0':
          true,
        'cursor-crosshair': crosshairCursor(),
      }}
      style={{
        width: `${canvasCss().w}px`,
        'min-height': `${canvasCss().h}px`,
      }}
      ref={(el) => {
        mainRef = el
        queueMicrotask(() => scheduleExclusionZonesSync())
      }}
      onPointerDown={() => setRootPointerDowns((n) => n + 1)}
      onContextMenu={(e) => {
        e.preventDefault()
      }}
    >
      <Show when={shellBridgeIssue()} keyed>
        {(msg) => (
          <div class="border border-(--shell-warning-border) bg-(--shell-warning-bg) text-(--shell-warning-text) pointer-events-none fixed top-3 left-1/2 z-470100 -translate-x-1/2 rounded-lg px-4 py-2 text-sm font-medium">
            {msg}
          </div>
        )}
      </Show>

      <For each={workspaceGroups().map((group) => group.id)}>
        {(groupId) => <WorkspaceGroupFrame groupId={groupId} />}
      </For>

      <TabDragOverlay />

      <Show when={splitGroupGesture()}>
        <SplitGestureOverlay />
      </Show>

      {volumeOverlayHud()}

      <Show when={screenshotMode()}>
        <ScreenshotOverlay />
      </Show>

      <Show when={portalPickerVisible()}>
        <PortalPickerOverlay />
      </Show>

      <Show when={mainRef}>
        <Show when={snapAssistPicker()} keyed>
          {(picker) => (
            <SnapAssistPicker
              anchorRect={picker.anchorRect}
              container={mainRef!}
              hoverSpan={assistOverlay()?.hoverSpan ?? null}
              autoHover={picker.autoHover}
              shellUiWindowId={
                (allWindowsMap().get(picker.windowId)?.shell_flags ?? 0) &
                  SHELL_WINDOW_FLAG_SHELL_HOSTED
                  ? picker.windowId
                  : undefined
              }
              shellUiWindowZ={(allWindowsMap().get(picker.windowId)?.stack_z ?? 0) + 1}
              getShellUiMeasureEnv={() => {
                const main = mainRef
                const og = outputGeom()
                const co = layoutCanvasOrigin()
                if (!main || !og || !co) return null
                return {
                  main,
                  outputGeom: { w: og.w, h: og.h },
                  origin: co,
                }
              }}
              onHoverSpanChange={(span) => {
                const context = resolveSnapAssistContext(picker.windowId, picker.monitorName)
                if (!context) {
                  closeSnapAssistPicker()
                  return
                }
                updateSnapAssistFromSpan(context, span)
              }}
              onSelectSpan={(span) => {
                const context = resolveSnapAssistContext(picker.windowId, picker.monitorName)
                if (!context) {
                  closeSnapAssistPicker()
                  return
                }
                updateSnapAssistFromSpan(context, span)
                commitSnapAssistSelection(picker.windowId, true)
              }}
              onClose={closeSnapAssistPicker}
            />
          )}
        </Show>
      </Show>

      <ShellSurfaceLayers
        assistOverlay={assistOverlay}
        mainEl={() => mainRef}
        outputGeom={outputGeom}
        workspaceSecondary={() => workspacePartition().secondary}
        screenCssRect={(screen) => layoutScreenCssRect(screen, layoutCanvasOrigin())}
        debugHudFrameVisible={debugHudFrameVisible}
        taskbarScreens={taskbarScreens}
        taskbarHeight={TASKBAR_HEIGHT}
        screenTaskbarHiddenForFullscreen={screenTaskbarHiddenForFullscreen}
        isPrimaryTaskbarScreen={(screen) => isPrimaryTaskbarScreen(screen, workspacePartition().primary)}
        volumeMuted={() => trayVolumeState().muted}
        volumePercent={() => trayVolumeState().volumePercent}
        taskbarRowsForScreen={taskbarRowsForScreen}
        focusedWindowId={focusedTaskbarWindowId}
        keyboardLayoutLabel={keyboardLayoutLabel}
        settingsHudFrameVisible={settingsHudFrameVisible}
        onSettingsPanelToggle={toggleSettingsShellWindow}
        onDebugPanelToggle={() => {
          const w = windows().get(SHELL_UI_DEBUG_WINDOW_ID)
          if (!w || w.minimized) openDebugShellWindow()
          else minimizeDebugShellWindow()
        }}
        onTaskbarActivate={activateTaskbarGroup}
        onTaskbarClose={(id) => {
          closeGroupWindow(id)
        }}
        trayReservedPx={trayReservedPx}
        sniTrayItems={sniTrayItems}
        trayIconSlotPx={trayIconSlotPx}
        onSniTrayActivate={(id) => {
          shellWireSend('sni_tray_activate', id)
        }}
        onSniTrayContextMenu={(id, cx, cy) => {
          traySniMenuNextSerial = (traySniMenuNextSerial + 1) >>> 0
          const serial = traySniMenuNextSerial
          shellContextMenus.openTraySniMenu(id, serial, cx, cy)
          shellWireSend('sni_tray_open_menu', id, serial)
        }}
        snapStrip={snapStripState}
        snapStripScreen={() => dragSnapAssistContext()?.screen ?? null}
      />

      <ShellContextMenuLayer
        ctxMenuOpen={shellContextMenus.ctxMenuOpen}
        atlasOverlayPointerUsers={atlasOverlayPointerUsers}
        setMenuAtlasHostRef={shellContextMenus.setMenuAtlasHostRef}
        shellMenuAtlasTop={shellContextMenus.shellMenuAtlasTop}
        volumeMenuOpen={shellContextMenus.volumeMenuOpen}
        tabMenuOpen={shellContextMenus.tabMenuOpen}
        traySniMenuOpen={shellContextMenus.traySniMenuOpen}
        tabMenuProps={shellContextMenus.tabMenuProps}
        traySniMenuProps={shellContextMenus.traySniMenuProps}
      />

      <div class="pointer-events-none fixed inset-0 z-50" aria-hidden="true">
        {crosshairDebugOverlay()}
      </div>
    </main>
    </ShellContextMenusProvider>
    </ShellFloatingProvider>
  )
}

export default App
