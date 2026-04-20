import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  For,
  Show,
  type JSX,
} from 'solid-js'
import { createStore } from 'solid-js/store'
import {
  CHROME_BORDER_PX,
  CHROME_TITLEBAR_PX,
  SHELL_LAYOUT_FLOATING,
} from '@/lib/chromeConstants'
import {
  canvasRectToClientCss,
  clientPointToGlobalLogical,
  rectGlobalToCanvasLocal,
} from '@/lib/shellCoords'
import { defaultAudioDevice, useShellAudioState } from '@/apps/settings/useShellAudioState'
import {
  flushShellUiWindowsSyncNow,
  invalidateAllShellUiWindows,
  SHELL_UI_DEBUG_WINDOW_ID,
  SHELL_UI_SETTINGS_WINDOW_ID,
} from '@/features/shell-ui/shellUiWindows'
import { createBackedShellWindowActions } from '@/features/shell-ui/backedShellWindowActions'
import { renderShellHostedWindowContent } from '@/features/shell-ui/shellHostedWindowContent'
import type { ShellCompositorWireOp, ShellCompositorWireSend } from '@/features/shell-ui/shellWireSendType'
import { createShellSurfaceRuntime } from '@/features/shell-ui/shellSurfaceRuntime'
import { createShellWindowGestureRuntime } from '@/features/shell-ui/shellWindowGestureRuntime'
import { ShellFloatingProvider, type ShellFloatingRegistry } from '@/features/floating/ShellFloatingContext'
import { createFloatingLayerStore } from '@/features/floating/floatingLayers'
import {
  spawnViaShellHttp,
} from '@/features/bridge/shellBridge'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import { startThemeDomSync } from '@/features/theme/themeDom'
import { refreshThemeSettingsFromRemote } from '@/features/theme/themeStore'
import { ShellContextMenusProvider } from '@/host/ShellContextMenusContext'
import { createShellContextMenus } from '@/host/createShellContextMenus'
import { ShellContextMenuLayer } from '@/host/ShellContextMenuLayer'
import { createDebugHudRuntime } from '@/apps/debug/debugHudRuntime'
import {
  layoutScreenCssRect,
  monitorRefreshLabel,
  screensListForLayout,
  shellBuildLabelText,
  unionBBoxFromScreens,
} from '@/host/appLayout'
import {
  type DerpWindow,
  windowIsShellHosted,
} from '@/host/appWindowState'
import { useDesktopApplicationsState } from '@/features/desktop/desktopApplicationsState'
import type { TaskbarSniItem } from '@/features/taskbar/Taskbar'
import {
  nativeWindowRef,
  type NativeLaunchMetadata,
  type SavedRect,
  type SessionSnapshot,
  type SessionWindowRef,
} from '@/features/bridge/sessionSnapshot'
import {
  subscribeShellWindowState,
} from '@/features/shell-ui/shellWindowState'
import type {
  LayoutScreen,
} from '@/host/types'
import { createCompositorModel } from '@/features/bridge/compositorModel'
import { registerAppRuntimeBootstrap } from '@/features/bridge/appRuntimeBootstrap'
import { createScreenshotPortalBridge } from '@/features/bridge/screenshotPortalBridge'
import { createShellExclusionSync } from '@/features/bridge/shellExclusionSync'
import { createSessionPersistenceRuntime } from '@/features/bridge/sessionPersistenceRuntime'
import { createSessionRuntime } from '@/features/bridge/sessionRuntime'
import { createShellTransportBridge } from '@/features/bridge/shellTransportBridge'
import { createWorkspaceActions } from '@/features/workspace/workspaceActions'
import {
  getWorkspaceGroupSplit,
  isWorkspaceWindowPinned,
  workspaceFindMonitorForTiledWindow,
  workspaceGetTiledZone,
  workspaceIsWindowTiled,
} from '@/features/workspace/workspaceState'
import { createWorkspaceSelectors } from '@/features/workspace/workspaceSelectors'
import { createWorkspaceChrome } from '@/features/workspace/workspaceChrome'
import { createWorkspaceLayoutBridge } from '@/features/workspace/workspaceLayoutBridge'

declare global {
  interface Window {
    /** Injected by `cef_host` after load (`http://127.0.0.1:…/spawn`). */
    __DERP_SPAWN_URL?: string
    __DERP_SHELL_HTTP?: string
    __DERP_COMPOSITOR_SNAPSHOT_PATH?: string | null
    __DERP_COMPOSITOR_SNAPSHOT_ABI?: number
    __DERP_SHELL_EXCLUSION_STATE_PATH?: string | null
    __DERP_SHELL_UI_WINDOWS_STATE_PATH?: string | null
    __DERP_SHELL_SHARED_STATE_ABI?: number
    /** Registered by CEF render process: shell→compositor control (`move_delta` uses third arg as `dy`). */
    __derpShellWireSend?: ShellCompositorWireSend
    __derpShellSharedStateWrite?: (
      path: string,
      payload: ArrayBuffer,
      kind: number,
      abi?: number,
    ) => boolean
    __derpCompositorSnapshotVersion?: (path: string, abi?: number) => number | null
    __derpCompositorSnapshotRead?: (path: string, abi?: number) => ArrayBuffer | null
    __derpCompositorSnapshotReadIfChanged?: (
      path: string,
      lastSequence: number,
      abi?: number,
    ) => ArrayBuffer | null
    __DERP_E2E_REQUEST_SNAPSHOT?: (requestId: number) => void
    __DERP_E2E_REQUEST_HTML?: (requestId: number, selector?: string | null) => void
    __DERP_E2E_OPEN_TEST_WINDOW_REQ?: (requestId: number) => void
  }
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

const TASKBAR_HEIGHT = 44

function shSingleQuotedForSpawn(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function shellMoveLog(msg: string, detail?: Record<string, unknown>) {
  void msg
  void detail
}

const shellWireSend: ShellCompositorWireSend = function shellWireSend(
  op: ShellCompositorWireOp,
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
  } else if (op === 'shell_hosted_window_state' && typeof arg === 'string') {
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

function App() {
  const shellBuildLabel = shellBuildLabelText()
  const desktopApps = useDesktopApplicationsState()
  const {
    allWindowsMap: compositorWindowsMap,
    windowsListIds: compositorWindowsListIds,
    windowsList: compositorWindowsList,
    workspaceState,
    focusedWindowId,
    shellHostedAppByWindow,
    applyCompositorSnapshot: applyModelCompositorSnapshot,
    applyCompositorDetail: applyModelCompositorDetail,
  } = createCompositorModel()
  const allWindowsMap = compositorWindowsMap
  const windows = compositorWindowsMap
  const windowsListIds = compositorWindowsListIds
  const windowsList = compositorWindowsList
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
  const [crosshairCursor, setCrosshairCursor] = createSignal(false)
  const [uiScalePercent, setUiScalePercent] = createSignal<100 | 150 | 200>(150)
  const [shellChromePrimaryName, setShellChromePrimaryName] = createSignal<string | null>(null)
  const [outputPhysical, setOutputPhysical] = createSignal<{ w: number; h: number } | null>(null)
  const [trayReservedPx, setTrayReservedPx] = createSignal(0)
  const [sniTrayItems, setSniTrayItems] = createSignal<TaskbarSniItem[]>([])
  const [trayIconSlotPx, setTrayIconSlotPx] = createSignal(40)
  const [snapChromeRev, setSnapChromeRev] = createSignal(0)
  const [sessionRestoreSnapshot, setSessionRestoreSnapshot] = createSignal<SessionSnapshot | null>(null)
  let windowSyncRecoveryPending = false
  let windowSyncRecoveryRequestedAt = 0
  const [nativeWindowRefs, setNativeWindowRefs] = createSignal<Map<number, SessionWindowRef>>(new Map())
  const [nextNativeWindowSeq, setNextNativeWindowSeq] = createSignal(1)
  const floatingLayers = createFloatingLayerStore()
  const [chromeOverlayPointerUsers, setChromeOverlayPointerUsers] = createSignal(0)
  const nativeLaunchMetadataByRef = new Map<SessionWindowRef, NativeLaunchMetadata>()
  const pendingNativeLaunches: { windowRef: SessionWindowRef; launch: NativeLaunchMetadata }[] = []
  let mainRef: HTMLElement | undefined
  let shellUiWindowsInvalidateQueued = false
  function setNativeWindowRef(windowId: number, windowRef: SessionWindowRef) {
    setNativeWindowRefs((prev) => {
      if (prev.get(windowId) === windowRef) return prev
      const next = new Map(prev)
      next.set(windowId, windowRef)
      return next
    })
  }
  const {
    applyRestoredWorkspace,
    buildSessionSnapshot,
    nativeWindowRefForId,
    restoreBackedShellWindow,
    restoreWindowModes,
    sessionRestoreIsComplete,
    sessionRestoreSignature,
    sessionSnapshotHasData,
    tryAssignRestoredNativeWindow,
  } = createSessionRuntime({
    getAllWindowsMap: allWindowsMap,
    getWindowsList: windowsList,
    getWindowsListIds: windowsListIds,
    getWorkspaceState: workspaceState,
    getTaskbarScreens: () => taskbarScreens(),
    getLayoutCanvasOrigin: layoutCanvasOrigin,
    getNativeWindowRefs: nativeWindowRefs,
    getNextNativeWindowSeq: nextNativeWindowSeq,
    getSessionRestoreSnapshot: sessionRestoreSnapshot,
    getTilingCfgRev: tilingCfgRev,
    setNativeWindowRef,
    setNextNativeWindowSeq,
    reserveTaskbarForMon: (screen) => workspaceLayoutBridge.reserveTaskbarForMon(screen),
    rectFromWindow,
    sendWorkspaceMutation: (mutation) => workspaceLayoutBridge.sendWorkspaceMutation(mutation),
    sendSetPreTileGeometry: (windowId, bounds) => workspaceLayoutBridge.sendSetPreTileGeometry(windowId, bounds),
    sendSetMonitorTile: (windowId, outputName, zone, bounds) =>
      workspaceLayoutBridge.sendSetMonitorTile(windowId, outputName, zone, bounds),
    shellWireSend,
    bumpSnapChrome,
    scheduleExclusionZonesSync: () => scheduleExclusionZonesSync(),
    nativeLaunchMetadataByRef,
    pendingNativeLaunches,
    getShellHostedAppStateForWindow: (windowId) => shellHostedAppByWindow()[windowId],
  })
  function closeAllAtlasSelects(): boolean {
    return floatingLayers.closeByKind('select')
  }
  function acquireOverlayPointer() {
    setChromeOverlayPointerUsers((n) => n + 1)
  }
  function releaseOverlayPointer() {
    setChromeOverlayPointerUsers((n) => Math.max(0, n - 1))
  }

  const shellTransportBridge = createShellTransportBridge({
    shellWireSend: (op, arg, arg2) => shellWireSend(op, arg, arg2),
    chromeTitlebarPx: CHROME_TITLEBAR_PX,
    chromeBorderPx: CHROME_BORDER_PX,
  })
  const {
    canSessionControl,
    clearShellActionIssue,
    describeError,
    postSessionPower,
    postShell,
    reportShellActionIssue,
    requestCompositorSync,
    shellBridgeIssue,
    shellWireReadyRev,
    start: startShellTransportBridge,
  } = shellTransportBridge
  const sessionPersistenceRuntime = createSessionPersistenceRuntime({
    sessionRestoreSnapshot,
    windows,
    workspaceState,
    nativeWindowRefs,
    tilingCfgRev,
    buildSessionSnapshot,
    sessionSnapshotHasData,
    sessionRestoreSignature,
    restoreWindowModes,
    applyRestoredWorkspace,
    sessionRestoreIsComplete,
    restoreBackedShellWindow,
    spawnInCompositor,
    nativeLaunchMetadataByRef,
    setSessionRestoreSnapshot,
    setNextNativeWindowSeq,
    bumpTilingCfgRev: () => setTilingCfgRev((n) => n + 1),
    reportShellActionIssue: shellTransportBridge.reportShellActionIssue,
    clearShellActionIssue: shellTransportBridge.clearShellActionIssue,
    describeError: shellTransportBridge.describeError,
  })

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

  const canvasCss = createMemo(() => {
    const g = outputGeom()
    const v = viewportCss()
    const w = Math.max(1, g?.w ?? v.w ?? 1)
    const h = Math.max(1, g?.h ?? v.h ?? 1)
    return { w, h }
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

  const backedShellWindowActions = createBackedShellWindowActions({
    getWindows: windowsList,
    getScreenDraftRows: () => screenDraft.rows,
    getOutputGeom: outputGeom,
    getLayoutCanvasOrigin: layoutCanvasOrigin,
    getPrimaryMonitorName: () => workspacePartition().primary.name,
    getHostedWindowSpawnMonitorName: () => {
      const id = focusedWindowId()
      const row = windowsList().find((w) => w.window_id === id)
      const name = row?.output_name?.trim()
      return name && name.length > 0 ? name : null
    },
    reserveTaskbarForMon: (screen) => workspaceLayoutBridge.reserveTaskbarForMon(screen),
    sendBackedWindowOpen: (payload) => shellWireSend('backed_window_open', JSON.stringify(payload)),
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
  const debugHudRuntime = createDebugHudRuntime({
    debugHudFrameVisible,
  })

  const fallbackMonitorName = createMemo(() => {
    const part = workspacePartition()
    return part.primary.name || screenDraft.rows.find((row) => row.name)?.name || ''
  })

  let shellContextMenus!: ReturnType<typeof createShellContextMenus>
  const screenshotPortalBridge = createScreenshotPortalBridge({
    getMainRef: () => mainRef,
    outputGeom,
    outputPhysical,
    layoutCanvasOrigin,
    canvasCss,
    screenDraftRows: () => screenDraft.rows,
    shellChromePrimaryName,
    getWorkspacePrimary: () => workspacePartition().primary,
    getWindows: windowsList,
    focusedWindowId,
    shellWireReadyRev,
    getMenuLayerHostEl: () => shellContextMenus.menuLayerHostEl(),
    scheduleExclusionZonesSync: () => scheduleExclusionZonesSync(),
    setCrosshairCursor,
    hideContextMenu: () => shellContextMenus.hideContextMenu(),
    closeAllAtlasSelects,
    focusShellUiWindow,
    clearShellActionIssue,
    reportShellActionIssue,
    describeError,
    postShell,
    shellWireSend: (op, arg) => shellWireSend(op, arg),
    acquireOverlayPointer,
    releaseOverlayPointer,
  })
  const {
    ScreenshotOverlay,
    PortalPickerOverlay,
    beginScreenshotMode,
    closePortalPickerUi,
    portalPickerVisible,
    screenshotMode,
    stopScreenshotMode,
  } = screenshotPortalBridge
  shellContextMenus = createShellContextMenus({
    floatingLayers,
    mainEl: () => mainRef,
    outputGeom,
    outputPhysical,
    layoutCanvasOrigin,
    screenDraftRows: () => screenDraft.rows,
    shellChromePrimaryName,
    viewportCss,
    canvasCss,
    screenshotMode,
    stopScreenshotMode,
    closeAllAtlasSelects,
    openShellHostedApp: (kind) => backedShellWindowActions.openShellHostedApp(kind),
    spawnInCompositor,
    saveSessionSnapshot: () => void sessionPersistenceRuntime.saveCurrentSessionSnapshot(),
    restoreSessionSnapshot: () => void sessionPersistenceRuntime.restoreSavedSessionSnapshot(),
    canSaveSessionSnapshot: () => shellHttpBase() !== null && !sessionRestoreSnapshot(),
    canRestoreSessionSnapshot: () =>
      shellHttpBase() !== null && sessionPersistenceRuntime.savedSessionAvailable() && !sessionRestoreSnapshot(),
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
            workspaceChrome.clearSuppressTabClickWindowId()
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
            workspaceChrome.clearSuppressTabClickWindowId()
            if (!enterSplitGroupWindow(windowId)) return
            queueMicrotask(() => {
              workspaceChrome.applySplitGroupGeometry(groupId)
            })
          },
        })
      }
      if (groupId && split?.leftWindowId === windowId) {
        items.push({
          actionId: 'exit-split',
          label: 'Exit split view',
          action: () => {
            workspaceChrome.clearSuppressTabClickWindowId()
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
    const list = compositorWindowsList()
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
    windowsById: compositorWindowsMap,
    windowsList: compositorWindowsList,
    focusedWindowId,
    fallbackMonitorKey: fallbackMonitorName,
    desktopApps: desktopApps.items,
  })
  const workspaceGroupIds = createMemo(() => workspaceGroups().map((group) => group.id))

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
    const ww = Math.max(1, window.width)
    const wh = Math.max(1, window.height)
    const gx = Math.round(global.x - ww / 2)
    const gy = Math.round(global.y + CHROME_TITLEBAR_PX / 2)
    const local = rectGlobalToCanvasLocal(gx, gy, ww, wh, layoutCanvasOrigin())
    shellWireSend(
      'set_geometry',
      windowId,
      local.x,
      local.y,
      local.w,
      local.h,
      SHELL_LAYOUT_FLOATING,
    )
    return true
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

  function renderShellWindowContent(windowId: number): JSX.Element | undefined {
    return renderShellHostedWindowContent(windowId, {
      allWindowsMap,
      shellHostedAppByWindow,
      shellWireSend,
      onOpenFileBrowserInNewWindow: (path) => backedShellWindowActions.openFileBrowserWindow(path),
      onOpenImageFile: (detail) => backedShellWindowActions.openImageViewerWindow(detail),
      onOpenVideoFile: (detail) => backedShellWindowActions.openVideoViewerWindow(detail),
      onOpenTextFile: (detail) => backedShellWindowActions.openTextEditorWindow(detail),
      onOpenPathExternally: (path) => {
        void spawnInCompositor(`xdg-open ${shSingleQuotedForSpawn(path)}`)
      },
      reportShellActionIssue,
      copyDebugHudSnapshot,
      shellBuildLabel,
      hudFps: debugHudRuntime.hudFps,
      crosshairCursor,
      setCrosshairCursor,
      outputGeom,
      layoutUnionBbox,
      layoutCanvasOrigin,
      panelHostForHud,
      shellChromePrimaryName,
      viewportCss,
      windowsList,
      pointerClient,
      pointerInMain,
      rootPointerDowns: debugHudRuntime.rootPointerDowns,
      exclusionZonesHud: debugHudRuntime.exclusionZonesHud,
      screenDraft,
      setScreenDraft,
      autoShellChromeMonitorName,
      canSessionControl,
      uiScalePercent,
      tilingCfgRev,
      setTilingCfgRev,
      clearMonitorTiles: workspaceLayoutBridge.clearMonitorTiles,
      bumpSnapChrome,
      scheduleExclusionZonesSync,
      applyAutoLayout: (name) => workspaceLayoutBridge.applyAutoLayout(name),
      setShellPrimary: (name) => shellWireSend('set_shell_primary', name),
      setUiScale: (pct) => shellWireSend('set_ui_scale', pct),
      applyCompositorLayoutFromDraft: () => {
        const screens = screenDraft.rows.map((r) => ({
          name: r.name,
          x: r.x,
          y: r.y,
          transform: r.transform,
        }))
        shellWireSend('set_output_layout', JSON.stringify({ screens }))
      },
      monitorRefreshLabel,
      keyboardLayoutLabel,
      setDesktopBackgroundJson: (json) => shellWireSend('set_desktop_background', json),
      sessionAutoSaveEnabled: sessionPersistenceRuntime.sessionAutoSaveEnabled,
      setSessionAutoSaveEnabled: sessionPersistenceRuntime.updateSessionAutoSavePreference,
    })
  }

  const taskbarScreens = createMemo(() =>
    screensListForLayout(screenDraft.rows, outputGeom(), layoutCanvasOrigin()),
  )

  const exclusionReactiveDeps = createMemo(() => {
    void shellContextMenus.ctxMenuOpen()
    void shellContextMenus.programsMenuOpen()
    void shellContextMenus.powerMenuOpen()
    void shellContextMenus.volumeMenuOpen()
    void shellContextMenus.tabMenuOpen()
    void shellContextMenus.traySniMenuOpen()
    void portalPickerVisible()
    void floatingLayers.layers().length
    void chromeOverlayPointerUsers()
    return 0
  })

  const { scheduleExclusionZonesSync, syncExclusionZonesNow } = createShellExclusionSync({
    mainEl: () => mainRef,
    outputGeom,
    layoutCanvasOrigin,
    taskbarScreens,
    windows: windowsList,
    isWindowTiled: (windowId) => workspaceIsWindowTiled(workspaceState(), windowId),
    onHudChange: debugHudRuntime.setExclusionZonesHud,
    exclusionReactiveDeps,
  })

  const workspaceLayoutBridge = createWorkspaceLayoutBridge({
    getWorkspaceState: workspaceState,
    getAllWindowsMap: allWindowsMap,
    getWindowsList: windowsList,
    getWindows: windows,
    getWindowsByMonitor: windowsByMonitor,
    getTaskbarRowsByMonitor: taskbarRowsByMonitor,
    getTaskbarScreens: taskbarScreens,
    getLayoutCanvasOrigin: layoutCanvasOrigin,
    getScreenDraftRows: () => screenDraft.rows,
    getOutputGeom: outputGeom,
    getFallbackMonitorName: fallbackMonitorName,
    scheduleExclusionZonesSync,
    syncExclusionZonesNow,
    flushShellUiWindowsSyncNow,
    bumpSnapChrome,
    shellWireSend,
    debugWindowId: SHELL_UI_DEBUG_WINDOW_ID,
    settingsWindowId: SHELL_UI_SETTINGS_WINDOW_ID,
  })

  createEffect(() => {
    void shellWireReadyRev()
    queueMicrotask(() => {
      flushShellUiWindowsSyncNow()
      syncExclusionZonesNow()
    })
  })

  function isPrimaryTaskbarScreen(s: LayoutScreen, primary: LayoutScreen) {
    return (
      s.name === primary.name &&
      s.x === primary.x &&
      s.y === primary.y &&
      s.width === primary.width &&
      s.height === primary.height
    )
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
    outputGeom()
    layoutCanvasOrigin()
    if (shellUiWindowsInvalidateQueued) return
    shellUiWindowsInvalidateQueued = true
    queueMicrotask(() => {
      shellUiWindowsInvalidateQueued = false
      invalidateAllShellUiWindows()
    })
  })

  function bumpSnapChrome() {
    setSnapChromeRev((n) => n + 1)
  }

  function openShellTestWindow() {
    return backedShellWindowActions.openShellTestWindow()
  }

  const shellWindowGestureRuntime = createShellWindowGestureRuntime({
    getMainRef: () => mainRef,
    outputGeom,
    layoutCanvasOrigin,
    screenDraftRows: () => screenDraft.rows,
    allWindowsMap,
    reserveTaskbarForMon: workspaceLayoutBridge.reserveTaskbarForMon,
    occupiedSnapZonesOnMonitor: workspaceLayoutBridge.occupiedSnapZonesOnMonitor,
    sendSetMonitorTile: workspaceLayoutBridge.sendSetMonitorTile,
    sendSetPreTileGeometry: workspaceLayoutBridge.sendSetPreTileGeometry,
    sendRemoveMonitorTile: workspaceLayoutBridge.sendRemoveMonitorTile,
    sendClearPreTileGeometry: workspaceLayoutBridge.sendClearPreTileGeometry,
    workspacePreTileSnapshot: workspaceLayoutBridge.workspacePreTileSnapshot,
    workspaceTiledRectMap: workspaceLayoutBridge.workspaceTiledRectMap,
    workspaceTiledZone: (windowId) => workspaceGetTiledZone(workspaceState(), windowId) ?? null,
    isWorkspaceWindowTiled: (windowId) => workspaceIsWindowTiled(workspaceState(), windowId),
    workspaceFindMonitorForTiledWindow: (windowId) => workspaceFindMonitorForTiledWindow(workspaceState(), windowId),
    scheduleExclusionZonesSync,
    syncExclusionZonesNow,
    flushShellUiWindowsSyncNow,
    bumpSnapChrome,
    floatBeforeMaximize,
    shellWireSend,
    shellMoveLog,
  })

  const workspaceChrome = createWorkspaceChrome({
    workspaceState,
    workspaceGroupsById,
    workspaceGroups,
    activeWorkspaceGroupId,
    focusedWindowId,
    allWindowsMap,
    outputGeom,
    layoutCanvasOrigin,
    getMainRef: () => mainRef,
    snapChromeRev,
    shellPointerGlobalLogical,
    rectFromWindow,
    renderShellWindowContent,
    focusShellUiWindow,
    activateTaskbarWindowViaShell,
    focusWindowViaShell,
    moveWindowUnderPointer,
    beginShellWindowMove: shellWindowGestureRuntime.beginShellWindowMove,
    beginShellWindowResize: shellWindowGestureRuntime.beginShellWindowResize,
    toggleShellMaximizeForWindow: shellWindowGestureRuntime.toggleShellMaximizeForWindow,
    closeGroupWindow,
    selectGroupWindow,
    setSplitGroupFraction,
    applyTabDrop,
    detachGroupWindow,
    workspaceGroupIdForWindow,
    isWorkspaceWindowTiled: (windowId) => workspaceIsWindowTiled(workspaceState(), windowId),
    isWorkspaceWindowPinned: (windowId) => isWorkspaceWindowPinned(workspaceState(), windowId),
    openSnapAssistPicker: shellWindowGestureRuntime.openSnapAssistPicker,
    shellContextOpenTabMenu: shellContextMenus.openTabMenu,
    shellContextHideMenu: shellContextMenus.hideContextMenu,
    shellWireSend,
  })

  const shellSurfaceRuntime = createShellSurfaceRuntime({
    assistOverlay: shellWindowGestureRuntime.assistOverlay,
    getMainRef: () => mainRef,
    outputGeom,
    workspaceSecondary: () => workspacePartition().secondary,
    screenCssRect: (screen) => layoutScreenCssRect(screen, layoutCanvasOrigin()),
    debugHudFrameVisible,
    taskbarScreens,
    taskbarHeight: TASKBAR_HEIGHT,
    screenTaskbarHiddenForFullscreen: workspaceLayoutBridge.screenTaskbarHiddenForFullscreen,
    isPrimaryTaskbarScreen: (screen) => isPrimaryTaskbarScreen(screen, workspacePartition().primary),
    trayVolumeState,
    taskbarRowsForScreen: workspaceLayoutBridge.taskbarRowsForScreen,
    focusedTaskbarWindowId,
    keyboardLayoutLabel,
    settingsHudFrameVisible,
    trayReservedPx,
    sniTrayItems,
    trayIconSlotPx,
    snapStrip: shellWindowGestureRuntime.snapStripState,
    snapStripScreen: () => shellWindowGestureRuntime.dragSnapAssistContext()?.screen ?? null,
    windows,
    closeGroupWindow,
    activateTaskbarGroup,
    openSettingsShellWindow: backedShellWindowActions.openSettingsShellWindow,
    openDebugShellWindow: backedShellWindowActions.openDebugShellWindow,
    openTraySniMenu: shellContextMenus.openTraySniMenu,
    shellWireSend,
  })

  const e2eTabDragTarget = createMemo(() => {
    const drag = workspaceChrome.tabDragState()
    if (!drag?.target) return null
    return {
      windowId: drag.windowId,
      groupId: drag.target.groupId,
      insertIndex: drag.target.insertIndex,
    }
  })

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
    const disposeAppRuntimeBootstrap = registerAppRuntimeBootstrap({
      startThemeDomSync,
      subscribeShellWindowState,
      onShellWindowStateChanged: sessionPersistenceRuntime.bumpShellWindowStateRev,
      refreshThemeSettingsFromRemote,
      warmDesktopApps: () => desktopApps.warm(),
      warmProgramsMenuItems: () => shellContextMenus.warmProgramsMenuItems(),
      bootstrapSessionState: () => sessionPersistenceRuntime.bootstrapSessionState(),
      disposeBackedShellWindowActions: () => backedShellWindowActions.dispose(),
      startShellTransportBridge,
      registerShellE2eBridge: {
        getMainRef: () => mainRef ?? null,
        getViewport: viewportCss,
        getOrigin: layoutCanvasOrigin,
        getCanvas: () => {
          const logicalCanvas = layoutUnionBbox()
          return logicalCanvas ? { w: logicalCanvas.w, h: logicalCanvas.h } : outputGeom()
        },
        getWindows: windowsList,
        getWorkspaceGroups: workspaceGroups,
        getFocusedWindowId: focusedWindowId,
        getKeyboardLayoutLabel: keyboardLayoutLabel,
        getScreenshotMode: screenshotMode,
        getCrosshairCursor: crosshairCursor,
        getProgramsMenuOpen: () =>
          shellContextMenus.programsMenuOpen() &&
          !!document.querySelector('[data-shell-programs-menu-panel]'),
        getPowerMenuOpen: shellContextMenus.powerMenuOpen,
        getVolumeMenuOpen: shellContextMenus.volumeMenuOpen,
        getDebugWindowVisible: debugHudFrameVisible,
        getSettingsWindowVisible: settingsHudFrameVisible,
        getSnapAssistPicker: shellWindowGestureRuntime.snapAssistPicker,
        getActiveSnapPreviewCanvas: shellWindowGestureRuntime.getActiveSnapPreviewCanvas,
        getAssistOverlayHoverSpan: () => shellWindowGestureRuntime.assistOverlay()?.hoverSpan ?? null,
        getProgramsMenuQuery: shellContextMenus.programsMenuProps.query,
        buildSessionSnapshot,
        getSessionRestoreActive: () => sessionRestoreSnapshot() !== null,
        getFloatingLayers: floatingLayers.layers,
        getTabDragTarget: e2eTabDragTarget,
        projectCurrentMenuElementRect: shellContextMenus.projectCurrentMenuElementRect,
        isWorkspaceWindowPinned: (windowId: number) => isWorkspaceWindowPinned(workspaceState(), windowId),
        openShellTestWindow,
        getMenuLayerHostEl: shellContextMenus.menuLayerHostEl,
      },
      registerCompositorBridgeRuntime: {
        setKeyboardLayoutLabel,
        setVolumeOverlay,
        setTrayVolumeState,
        setTrayReservedPx,
        setTrayIconSlotPx,
        setSniTrayItems,
        setOutputGeom,
        setOutputPhysical,
        setLayoutCanvasOrigin,
        setUiScalePercent,
        setScreenDraftRows: (rows) => setScreenDraft('rows', rows),
        bumpTilingCfgRev: () => setTilingCfgRev((n) => n + 1),
        setShellChromePrimaryName,
        markHasSeenCompositorWindowSync: sessionPersistenceRuntime.markHasSeenCompositorWindowSync,
        clearWindowSyncRecoveryPending: () => {
          windowSyncRecoveryPending = false
        },
        scheduleExclusionZonesSync,
        scheduleCompositorFollowup: workspaceLayoutBridge.scheduleCompositorFollowup,
        applyModelCompositorSnapshot,
        applyModelCompositorDetail,
        closeAllAtlasSelects,
        hideContextMenu: shellContextMenus.hideContextMenu,
        toggleProgramsMenuMeta: shellContextMenus.toggleProgramsMenuMeta,
        applyTraySniMenuDetail: shellContextMenus.applyTraySniMenuDetail,
        shellWireSend,
        requestCompositorSync,
        openSettingsShellWindow: backedShellWindowActions.openSettingsShellWindow,
        cycleFocusedWorkspaceGroup,
        beginScreenshotMode,
        toggleShellMaximizeForWindow: shellWindowGestureRuntime.toggleShellMaximizeForWindow,
        spawnInCompositor: (cmd) => spawnInCompositor(cmd),
        focusedWindowId,
        allWindowsMap,
        windows,
        layoutCanvasOrigin,
        screenDraftRows: () => screenDraft.rows,
        outputGeom,
        reserveTaskbarForMon: workspaceLayoutBridge.reserveTaskbarForMon,
        workspaceState,
        occupiedSnapZonesOnMonitor: workspaceLayoutBridge.occupiedSnapZonesOnMonitor,
        sendSetMonitorTile: workspaceLayoutBridge.sendSetMonitorTile,
        bumpSnapChrome,
        applyAutoLayout: workspaceLayoutBridge.applyAutoLayout,
        sendSetPreTileGeometry: workspaceLayoutBridge.sendSetPreTileGeometry,
        floatBeforeMaximize,
        workspacePreTileSnapshot: workspaceLayoutBridge.workspacePreTileSnapshot,
        sendRemoveMonitorTile: workspaceLayoutBridge.sendRemoveMonitorTile,
        sendClearPreTileGeometry: workspaceLayoutBridge.sendClearPreTileGeometry,
        fallbackMonitorKey: workspaceLayoutBridge.fallbackMonitorKey,
        requestWindowSyncRecovery,
      },
      setViewportCss,
      applyShellWindowMove: shellWindowGestureRuntime.applyShellWindowMove,
      applyShellWindowResize: shellWindowGestureRuntime.applyShellWindowResize,
      endShellWindowMove: shellWindowGestureRuntime.endShellWindowMove,
      endShellWindowResize: shellWindowGestureRuntime.endShellWindowResize,
      getShellWindowDragId: shellWindowGestureRuntime.getShellWindowDragId,
      getShellWindowResizeId: shellWindowGestureRuntime.getShellWindowResizeId,
      setPointerClient,
      setPointerInMain,
      getMainRef: () => mainRef,
      onWindowBlur: ({ dragWindowId, resizeWindowId }) => {
        if (dragWindowId !== null) {
          shellMoveLog('window_blur_while_shell_drag', {
            windowId: dragWindowId,
          })
        }
        if (resizeWindowId !== null) {
          shellMoveLog('window_blur_while_shell_resize', {
            windowId: resizeWindowId,
          })
        }
        workspaceChrome.cancelSplitGroupGesture()
        if (screenshotMode()) stopScreenshotMode()
        if (portalPickerVisible()) closePortalPickerUi()
      },
      invalidateAllShellUiWindows,
      scheduleExclusionZonesSync,
      shellWireSend,
    })
    onCleanup(disposeAppRuntimeBootstrap)
  })

  function copyDebugHudSnapshot() {
    const g = outputGeom()
    const payload = {
      t: Date.now(),
      shellBuild: shellBuildLabel,
      uiFps: debugHudRuntime.hudFps(),
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
    acquireOverlayPointer,
    releaseOverlayPointer,
    mainEl: () => mainRef,
    menuLayerHostEl: shellContextMenus.menuLayerHostEl,
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
      onPointerDown={() => debugHudRuntime.bumpRootPointerDowns()}
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

      <For each={workspaceGroupIds()}>
        {(groupId) => <workspaceChrome.WorkspaceGroupFrame groupId={groupId} />}
      </For>

      <workspaceChrome.TabDragOverlay />

      <Show when={workspaceChrome.splitGroupGesture()}>
        <workspaceChrome.SplitGestureOverlay />
      </Show>

      {volumeOverlayHud()}

      <Show when={screenshotMode()}>
        <ScreenshotOverlay />
      </Show>

      <Show when={portalPickerVisible()}>
        <PortalPickerOverlay />
      </Show>

      <shellWindowGestureRuntime.SnapAssistPickerLayer />

      <shellSurfaceRuntime.ShellSurfaceLayer />

      <ShellContextMenuLayer
        ctxMenuOpen={shellContextMenus.ctxMenuOpen}
        chromeOverlayPointerUsers={chromeOverlayPointerUsers}
        setMenuLayerHostRef={shellContextMenus.setMenuLayerHostRef}
        taskbarPortalMenusOpen={() =>
          shellContextMenus.programsMenuOpen() ||
          shellContextMenus.powerMenuOpen() ||
          shellContextMenus.volumeMenuOpen()
        }
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
