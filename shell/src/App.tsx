import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  For,
  Show,
  type JSX,
} from "solid-js";
import { createStore } from "solid-js/store";
import { CHROME_BORDER_PX, CHROME_TITLEBAR_PX } from "@/lib/chromeConstants";
import {
  canvasRectToClientCss,
  clientPointToGlobalLogical,
  globalPointToClientCss,
} from "@/lib/shellCoords";
import {
  defaultAudioDevice,
  useShellAudioState,
} from "@/apps/settings/useShellAudioState";
import { useShellBatteryState } from "@/apps/settings/useShellBatteryState";
import {
  settingsActivePage,
  setSettingsActivePage,
  type SettingsPageId,
} from "@/apps/settings/settingsNavigation";
import {
  flushShellUiWindowsSyncNow,
  invalidateAllShellUiWindows,
  SHELL_UI_DEBUG_WINDOW_ID,
  SHELL_UI_SETTINGS_WINDOW_ID,
} from "@/features/shell-ui/shellHostedSurfaceRegistry";
import { createBackedShellWindowActions } from "@/features/shell-ui/backedShellWindowActions";
import { renderShellHostedWindowContent } from "@/features/shell-ui/shellHostedWindowContent";
import type { ShellCompositorWireSend } from "@/features/shell-ui/shellWireSendType";
import { createShellSurfaceRuntime } from "@/features/shell-ui/shellSurfaceRuntime";
import { createShellWindowGestureRuntime } from "@/features/shell-ui/shellWindowGestureRuntime";
import { createShellUiWindowSyncRuntime } from "@/features/shell-ui/shellUiWindowSyncRuntime";
import {
  CustomLayoutOverlay,
  type CustomLayoutOverlayState,
} from "@/features/tiling/CustomLayoutOverlay";
import {
  configureWorkspaceTilingConfig,
  resetTilingConfig as resetPersistedTilingConfig,
  setMonitorCustomLayouts,
} from "@/features/tiling/tilingConfig";
import {
  ShellFloatingProvider,
  type ShellFloatingRegistry,
} from "@/features/floating/ShellFloatingContext";
import { createFloatingLayerStore } from "@/features/floating/floatingLayers";
import { createShellOverlayRegistry } from "@/features/floating/shellOverlay";
import { getShellJson, spawnViaShellHttp } from "@/features/bridge/shellBridge";
import { shellHttpBase } from "@/features/bridge/shellHttp";
import { loadShellOskSettings } from "@/apps/settings/keyboardSettings";
import {
  shellMoveLog,
  shellWireSend,
} from "@/features/bridge/shellWireBootstrap";
import { startThemeDomSync } from "@/features/theme/themeDom";
import { refreshThemeSettingsFromRemote } from "@/features/theme/themeStore";
import { ShellContextMenusProvider } from "@/host/ShellContextMenusContext";
import { createShellContextMenus } from "@/host/createShellContextMenus";
import { ShellContextMenuLayer } from "@/host/ShellContextMenuLayer";
import { WindowSwitcherContextMenu } from "@/host/WindowSwitcherContextMenu";
import { LockScreenOverlay } from "@/features/lock-screen/LockScreenOverlay";
import {
  DEFAULT_SHELL_LOCK_SCREEN_STATE,
  sanitizeShellLockScreenState,
} from "@/features/lock-screen/lockScreenState";
import { createDebugHudRuntime } from "@/apps/debug/debugHudRuntime";
import {
  layoutScreenCssRect,
  monitorRefreshLabel,
  screensListForLayout,
  shellBuildLabelText,
  unionBBoxFromScreens,
} from "@/host/appLayout";
import { type DerpWindow, windowIsShellHosted } from "@/host/appWindowState";
import { useDesktopApplicationsState } from "@/features/desktop/desktopApplicationsState";
import {
  DEFAULT_APPLICATIONS_FALLBACK,
  fileOpenCategoryForPath,
  optionById,
  useDefaultApplicationsState,
  type OpenWithOption,
} from "@/apps/default-applications/defaultApplications";
import type { TaskbarPin, TaskbarSniItem } from "@/features/taskbar/Taskbar";
import {
  nativeWindowRef,
  type NativeLaunchMetadata,
  type SavedRect,
  type SessionSnapshot,
  type SessionWindowRef,
} from "@/features/bridge/sessionSnapshot";
import { subscribeShellWindowState } from "@/features/shell-ui/shellWindowState";
import type { LayoutScreen } from "@/host/types";
import { createCompositorModel } from "@/features/bridge/compositorModel";
import { registerAppRuntimeBootstrap } from "@/features/bridge/appRuntimeBootstrap";
import { createScreenshotPortalBridge } from "@/features/bridge/screenshotPortalBridge";
import { createShellExclusionSync } from "@/features/bridge/shellExclusionSync";
import { createAppSessionPersistenceRuntime } from "@/features/bridge/appSessionPersistenceRuntime";
import { createSessionRuntime } from "@/features/bridge/sessionRuntime";
import { createShellTransportBridge } from "@/features/bridge/shellTransportBridge";
import type { CompositorOutputTopology } from "@/features/bridge/compositorBridgeRuntime";
import { createWorkspaceActions } from "@/features/workspace/workspaceActions";
import {
  getWorkspaceGroupSplit,
  isWorkspaceWindowPinned,
  workspaceFindMonitorForTiledWindow,
  workspaceFindMonitorIdentityForTiledWindow,
  workspaceGetTiledZone,
  workspaceIsWindowTiled,
} from "@/features/workspace/workspaceSnapshot";
import type { WorkspaceMutation } from "@/features/workspace/workspaceProtocol";
import {
  findMergeTarget,
  type TabMergeTarget,
} from "@/features/workspace/tabGroupOps";
import {
  buildWindowsByMonitor,
  createWorkspaceSelectors,
} from "@/features/workspace/workspaceSelectors";
import {
  createImperativeChromeRenderer,
  type WorkspaceExternalTabDropDrag,
} from "@/features/workspace/imperativeChromeRenderer";
import { createWorkspaceLayoutBridge } from "@/features/workspace/workspaceLayoutBridge";
import { isImageFilePath } from "@/apps/image-viewer/imageViewerCore";
import { isPdfFilePath } from "@/apps/pdf-viewer/pdfViewerCore";
import { isTextEditorFilePath } from "@/apps/text-editor/textEditorCore";
import { isVideoFilePath } from "@/apps/video-viewer/videoViewerCore";
import {
  DropdownMenu,
  DropdownMenuPortal,
} from "@/components/ui/dropdown-menu";
import { Portal } from "solid-js/web";
import { ShellNotificationLayer } from "@/features/notifications/ShellNotificationLayer";
import {
  emptyNotificationsState,
  type ShellNotificationsState,
} from "@/features/notifications/notificationsState";
import { installShellNotificationsApi } from "@/features/notifications/shellNotifications";

declare global {
  interface Window {
    /** Injected by `cef_host` after load (`http://127.0.0.1:…/spawn`). */
    __DERP_SPAWN_URL?: string;
    __DERP_SHELL_HTTP?: string;
    __DERP_COMPOSITOR_SNAPSHOT_PATH?: string | null;
    __DERP_SHELL_EXCLUSION_STATE_PATH?: string | null;
    __DERP_SHELL_UI_WINDOWS_STATE_PATH?: string | null;
    __DERP_SHELL_SHARED_STATE_ABI?: number;
    __DERP_PERF_METRICS?: boolean | number;
    /** Registered by CEF render process: shell→compositor control. */
    __derpShellWireSend?: ShellCompositorWireSend;
    __derpShellSharedStateWrite?: (
      path: string,
      payload: ArrayBuffer,
      kind: number,
      abi?: number,
    ) => boolean;
    __derpCompositorSnapshotVersion?: (
      path: string,
      abi?: number,
    ) => number | null;
    __derpCompositorSnapshotRead?: (
      path: string,
      abi?: number,
    ) => ArrayBuffer | null;
    __derpCompositorSnapshotReadIfChanged?: (
      path: string,
      lastSequence: number,
      abi?: number,
    ) => ArrayBuffer | null;
    __DERP_E2E_REQUEST_SNAPSHOT?: (requestId: number) => void;
    __DERP_E2E_REQUEST_HTML?: (
      requestId: number,
      selector?: string | null,
    ) => void;
    __DERP_E2E_REQUEST_PERF?: (requestId: number) => void;
    __DERP_E2E_OPEN_TEST_WINDOW_REQ?: (requestId: number) => void;
    __DERP_E2E_RESET_TILING_CONFIG_REQ?: (requestId: number) => void;
    __DERP_SHELL_PERF_SNAPSHOT?: () => Record<string, number>;
    __DERP_SHELL_PERF_RESET?: () => void;
    __DERP_SHELL_PERF_FRAME_SAMPLE_START?: () => void;
    __DERP_SHELL_PERF_FRAME_SAMPLE_STOP?: () => void;
    __DERP_BRIDGE_DEBUG?: Record<string, unknown>;
    __DERP_MOVE_DEBUG?: Record<string, unknown>;
  }
}

function sameNumberList(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function rectFromWindow(
  window: Pick<DerpWindow, "x" | "y" | "width" | "height">,
): SavedRect {
  return {
    x: window.x,
    y: window.y,
    width: Math.max(1, window.width),
    height: Math.max(1, window.height),
  };
}

const TASKBAR_HEIGHT = 36;

function shSingleQuotedForSpawn(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function App() {
  const shellBuildLabel = shellBuildLabelText();
  const desktopApps = useDesktopApplicationsState();
  const defaultApps = useDefaultApplicationsState();
  const {
    allWindowsMap: compositorWindowsMap,
    windowsList: compositorWindowsList,
    shellUiWindowsMap,
    shellUiWindowsList,
    shellUiWindowById,
    workspaceSnapshot,
    focusedWindowId,
    shellHostedAppByWindow,
    commandPaletteState,
    applyAuthoritativeSnapshotDetails: applyModelAuthoritativeSnapshotDetails,
    clearAuthoritativeSnapshotDomains: clearModelAuthoritativeSnapshotDomains,
  } = createCompositorModel();
  const compositorWindowsForGeometry = compositorWindowsList;
  const compositorWindowMapForGeometry = compositorWindowsMap;
  const readCompositorWindowForChrome = (windowId: number) =>
    compositorWindowMapForGeometry().get(windowId);
  const [compositorInteractionState, setCompositorInteractionState] =
    createSignal<{
      revision: number;
      interaction_serial: number;
      pointer_x: number;
      pointer_y: number;
      move_window_id: number | null;
      resize_window_id: number | null;
      move_proxy_window_id: number | null;
      move_capture_window_id: number | null;
      super_held: boolean;
      window_switcher_selected_window_id: number | null;
      move_rect: {
        x: number;
        y: number;
        width: number;
        height: number;
        maximized: boolean;
        fullscreen: boolean;
      } | null;
      resize_rect: {
        x: number;
        y: number;
        width: number;
        height: number;
        maximized: boolean;
        fullscreen: boolean;
      } | null;
    } | null>(null);
  type NativeDragPreviewState = {
    window_id: number;
    generation: number;
    image_path: string;
  } | null;
  let nativeDragPreview: NativeDragPreviewState = null;
  let applyNativeDragPreviewToChrome:
    | ((value: NativeDragPreviewState) => void)
    | null = null;
  function setNativeDragPreview(value: NativeDragPreviewState) {
    nativeDragPreview = value;
    applyNativeDragPreviewToChrome?.(value);
  }
  function getNativeDragPreview() {
    return nativeDragPreview;
  }
  const [notificationsState, setNotificationsState] =
    createSignal<ShellNotificationsState | null>(emptyNotificationsState());
  const [pointerClient, setPointerClient] = createSignal<{
    x: number;
    y: number;
  } | null>(null);
  const [pointerInMain, setPointerInMain] = createSignal<{
    x: number;
    y: number;
  } | null>(null);
  const [viewportCss, setViewportCss] = createSignal({
    w: typeof window !== "undefined" ? window.innerWidth : 800,
    h: typeof window !== "undefined" ? window.innerHeight : 600,
  });
  const [keyboardLayoutLabel, setKeyboardLayoutLabel] = createSignal<
    string | null
  >(null);
  const [lockScreenState, setLockScreenState] = createSignal(
    DEFAULT_SHELL_LOCK_SCREEN_STATE,
  );
  const [oskEnabled, setOskEnabled] = createSignal(false);
  const [volumeOverlay, setVolumeOverlay] = createSignal<{
    linear: number;
    muted: boolean;
    stateKnown: boolean;
  } | null>(null);
  const [trayVolumeState, setTrayVolumeState] = createSignal<{
    muted: boolean;
    volumePercent: number | null;
  }>({
    muted: false,
    volumePercent: null,
  });
  const [outputTopology, setOutputTopology] =
    createSignal<CompositorOutputTopology | null>(null);
  const outputGeom = createMemo(() => outputTopology()?.logical ?? null);
  const outputPhysical = createMemo(() => outputTopology()?.physical ?? null);
  const layoutCanvasOrigin = createMemo(() => outputTopology()?.origin ?? null);
  const uiScalePercent = createMemo(
    () => outputTopology()?.uiScalePercent ?? 150,
  );
  const shellChromePrimaryName = createMemo(
    () => outputTopology()?.shellChromePrimaryName ?? null,
  );
  const taskbarAutoHide = createMemo(
    () => outputTopology()?.taskbarAutoHide ?? false,
  );

  createEffect(() => {
    const base = shellHttpBase();
    if (!base) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await loadShellOskSettings(base);
        if (!cancelled) setOskEnabled(next.enabled);
      } catch (error) {
        void error;
      }
    };
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 2000);
    onCleanup(() => {
      cancelled = true;
      window.clearInterval(interval);
    });
  });
  const shellAudio = useShellAudioState();
  const shellBattery = useShellBatteryState();
  createEffect(() => {
    const sink = defaultAudioDevice(shellAudio.state()?.sinks ?? []);
    if (!sink) return;
    setTrayVolumeState({
      muted: sink.muted,
      volumePercent: sink.volume_known ? sink.volume_percent : null,
    });
  });
  const volumeOverlayHud = createMemo(() => {
    const v = volumeOverlay();
    if (!v) return null;
    const pct = Math.min(100, Math.round(v.linear / 100));
    const barPct = Math.min(100, pct);
    const main = mainRef;
    const og = outputGeom();
    const co = layoutCanvasOrigin();
    const primary = workspacePartition().primary;
    let pos: Record<string, string> = {
      left: "50%",
      bottom: "max(5.5rem, 12vh)",
      transform: "translateX(-50%)",
    };
    if (main && og && primary) {
      const loc = layoutScreenCssRect(primary, co);
      const gap = 12;
      const cx = loc.x + loc.width / 2;
      const cy = loc.y + loc.height - TASKBAR_HEIGHT - gap;
      const pt = canvasRectToClientCss(
        cx,
        cy,
        0,
        0,
        main.getBoundingClientRect(),
        og.w,
        og.h,
      );
      pos = {
        left: `${pt.left}px`,
        top: `${pt.top}px`,
        transform: "translate(-50%, -100%)",
      };
    }
    const label = !v.stateKnown ? "—" : v.muted ? "Muted" : `${pct}%`;
    const fillPct = !v.stateKnown || v.muted ? 0 : barPct;
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
    );
  });
  const [screenDraft, setScreenDraft] = createStore<{
    revision: number;
    dirty: boolean;
    rows: LayoutScreen[];
  }>({
    revision: -1,
    dirty: false,
    rows: [],
  });
  const [tilingCfgRev, setTilingCfgRev] = createSignal(0);
  const [crosshairCursor, setCrosshairCursor] = createSignal(false);
  const [trayReservedPx, setTrayReservedPx] = createSignal(0);
  const [sniTrayItems, setSniTrayItems] = createSignal<TaskbarSniItem[]>([]);
  const [trayIconSlotPx, setTrayIconSlotPx] = createSignal(36);
  const [snapChromeRev, setSnapChromeRev] = createSignal(0);
  const [customLayoutOverlay, setCustomLayoutOverlay] =
    createSignal<CustomLayoutOverlayState | null>(null);
  const [sessionRestoreSnapshot, setSessionRestoreSnapshot] =
    createSignal<SessionSnapshot | null>(null);
  const [compositorSnapshotSequence, setCompositorSnapshotSequence] =
    createSignal(0);
  let windowSyncRecoveryPending = false;
  let windowSyncRecoveryDeferred = false;
  let windowSyncRecoveryRequestedAt = 0;
  let nextClientMutationId = 1;
  const pendingClientMutationIds = new Map<
    number,
    { sentAt: number; snapshotEpoch: number | null }
  >();
  const [nativeWindowRefs, setNativeWindowRefs] = createSignal<
    Map<number, SessionWindowRef>
  >(new Map());
  const [nextNativeWindowSeq, setNextNativeWindowSeq] = createSignal(1);
  const floatingLayers = createFloatingLayerStore();
  const [chromeOverlayPointerUsers, setChromeOverlayPointerUsers] =
    createSignal(0);
  const nativeLaunchMetadataByRef = new Map<
    SessionWindowRef,
    NativeLaunchMetadata
  >();
  const pendingNativeLaunches: {
    windowRef: SessionWindowRef;
    launch: NativeLaunchMetadata;
  }[] = [];
  let mainRef: HTMLElement | undefined;
  let chromeRootRef: HTMLElement | undefined;
  let shellUiWindowsInvalidateQueued = false;

  createEffect(() => {
    const topology = outputTopology();
    const revision = topology?.revision ?? -1;
    if (screenDraft.dirty && screenDraft.revision === revision) return;
    setScreenDraft({
      revision,
      dirty: false,
      rows: topology?.screens ?? [],
    });
  });

  createEffect(() => {
    reconcilePendingClientMutations(compositorSnapshotSequence());
  });

  const liveScreenRows = createMemo(() => outputTopology()?.screens ?? []);

  function sendWorkspaceMutation(mutation: WorkspaceMutation): boolean {
    const clientMutationId = nextClientMutationId++;
    const ok = shellWireSend(
      "workspace_mutation",
      JSON.stringify({ clientMutationId, mutation }),
    );
    if (ok)
      pendingClientMutationIds.set(clientMutationId, {
        sentAt: Date.now(),
        snapshotEpoch: null,
      });
    return ok;
  }

  configureWorkspaceTilingConfig({
    readLayouts: () => workspaceSnapshot().monitorLayouts,
    sendMutation: sendWorkspaceMutation,
  });

  function sendWindowIntent(action: string, windowId: number): boolean {
    const clientMutationId = nextClientMutationId++;
    const ok = shellWireSend(
      "window_intent",
      JSON.stringify({ clientMutationId, action, windowId }),
    );
    if (ok)
      pendingClientMutationIds.set(clientMutationId, {
        sentAt: Date.now(),
        snapshotEpoch: null,
      });
    return ok;
  }

  function reconcilePendingClientMutations(
    snapshotSequence: number,
    flushDeferred = true,
  ) {
    const now = Date.now();
    for (const [clientMutationId, state] of pendingClientMutationIds) {
      if (
        state.snapshotEpoch !== null &&
        snapshotSequence >= state.snapshotEpoch
      ) {
        pendingClientMutationIds.delete(clientMutationId);
        continue;
      }
      if (now - state.sentAt <= 2000) continue;
      pendingClientMutationIds.delete(clientMutationId);
    }
    if (flushDeferred) flushDeferredWindowSyncRecovery();
  }

  function hasPendingClientMutation() {
    reconcilePendingClientMutations(compositorSnapshotSequence(), false);
    return pendingClientMutationIds.size > 0;
  }

  function flushDeferredWindowSyncRecovery() {
    if (!windowSyncRecoveryDeferred) return;
    if (pendingClientMutationIds.size > 0) return;
    windowSyncRecoveryDeferred = false;
    requestWindowSyncRecovery();
  }

  function handleMutationAck(detail: {
    client_mutation_id: number;
    status: string;
    snapshot_epoch?: number;
  }) {
    const pending = pendingClientMutationIds.get(detail.client_mutation_id);
    if (detail.status === "accepted") {
      const snapshotEpoch =
        typeof detail.snapshot_epoch === "number" &&
        Number.isFinite(detail.snapshot_epoch)
          ? Math.max(0, Math.trunc(detail.snapshot_epoch))
          : 0;
      if (pending && snapshotEpoch > compositorSnapshotSequence()) {
        pendingClientMutationIds.set(detail.client_mutation_id, {
          sentAt: pending.sentAt,
          snapshotEpoch,
        });
      } else {
        pendingClientMutationIds.delete(detail.client_mutation_id);
        flushDeferredWindowSyncRecovery();
      }
      return;
    }
    pendingClientMutationIds.delete(detail.client_mutation_id);
    flushDeferredWindowSyncRecovery();
    requestWindowSyncRecovery();
  }

  function setNativeWindowRef(windowId: number, windowRef: SessionWindowRef) {
    setNativeWindowRefs((prev) => {
      if (prev.get(windowId) === windowRef) return prev;
      const next = new Map(prev);
      next.set(windowId, windowRef);
      return next;
    });
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
    getAllWindowsMap: compositorWindowMapForGeometry,
    getWindowsList: compositorWindowsForGeometry,
    getWorkspaceState: workspaceSnapshot,
    getTaskbarScreens: () => taskbarScreens(),
    getWorkspacePrimary: () => workspacePartition().primary,
    getLayoutCanvasOrigin: layoutCanvasOrigin,
    getNativeWindowRefs: nativeWindowRefs,
    getNextNativeWindowSeq: nextNativeWindowSeq,
    getSessionRestoreSnapshot: sessionRestoreSnapshot,
    getTilingCfgRev: tilingCfgRev,
    setNativeWindowRef,
    setNextNativeWindowSeq,
    reserveTaskbarForMon: (screen) =>
      workspaceLayoutBridge.reserveTaskbarForMon(screen),
    rectFromWindow,
    sendWorkspaceMutation,
    shellWireSend,
    bumpSnapChrome,
    scheduleExclusionZonesSync: () => scheduleExclusionZonesSync(),
    nativeLaunchMetadataByRef,
    pendingNativeLaunches,
    getDesktopApps: () => desktopApps.items(),
    getShellHostedAppStateForWindow: (windowId) =>
      shellHostedAppByWindow()[windowId],
  });
  function closeAllAtlasSelects(): boolean {
    return floatingLayers.closeByKind("select");
  }
  function acquireOverlayPointer() {
    setChromeOverlayPointerUsers((n) => n + 1);
  }
  function releaseOverlayPointer() {
    setChromeOverlayPointerUsers((n) => Math.max(0, n - 1));
  }

  const shellTransportBridge = createShellTransportBridge({
    shellWireSend: (op, arg, arg2) => shellWireSend(op, arg, arg2),
    chromeTitlebarPx: CHROME_TITLEBAR_PX,
    chromeBorderPx: CHROME_BORDER_PX,
  });
  const {
    canSessionControl,
    clearShellActionIssue,
    describeError,
    postLockScreen,
    postSessionPower,
    postUnlock,
    postShell,
    reportShellActionIssue,
    requestCompositorSync,
    shellBridgeIssue,
    shellWireReadyRev,
    start: startShellTransportBridge,
  } = shellTransportBridge;
  const sessionPersistenceRuntime = createAppSessionPersistenceRuntime({
    sessionRestoreSnapshot,
    windows: compositorWindowMapForGeometry,
    workspaceSnapshot,
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
    reportShellActionIssue: shellTransportBridge.reportShellActionIssue,
    clearShellActionIssue: shellTransportBridge.clearShellActionIssue,
    describeError: shellTransportBridge.describeError,
  });

  function shellPointerGlobalLogical(clientX: number, clientY: number) {
    const main = mainRef;
    const og = outputGeom();
    if (!main || !og) return null;
    const mainRect = main.getBoundingClientRect();
    if (
      clientX < mainRect.left ||
      clientX > mainRect.right ||
      clientY < mainRect.top ||
      clientY > mainRect.bottom
    ) {
      return { x: Math.round(clientX), y: Math.round(clientY) };
    }
    return clientPointToGlobalLogical(
      clientX,
      clientY,
      mainRect,
      og.w,
      og.h,
      layoutCanvasOrigin(),
    );
  }

  function compositorInteractionPointerClient() {
    const state = compositorInteractionState();
    const main = mainRef;
    const og = outputGeom();
    if (!state || !main || !og) return null;
    const point = globalPointToClientCss(
      state.pointer_x,
      state.pointer_y,
      main.getBoundingClientRect(),
      og.w,
      og.h,
      layoutCanvasOrigin(),
    );
    return {
      x: Math.round(point.x),
      y: Math.round(point.y),
    };
  }

  function syncPointerSignalsFromClient(point: { x: number; y: number }) {
    setPointerClient(point);
    if (mainRef) {
      const rect = mainRef.getBoundingClientRect();
      setPointerInMain({
        x: Math.round(point.x - rect.left),
        y: Math.round(point.y - rect.top),
      });
    }
  }

  const canvasCss = createMemo(() => {
    const g = outputGeom();
    const v = viewportCss();
    const w = Math.max(1, g?.w ?? v.w ?? 1);
    const h = Math.max(1, g?.h ?? v.h ?? 1);
    return { w, h };
  });

  const workspacePartition = createMemo(() => {
    const rows = liveScreenRows();
    const g = outputGeom();
    const v = viewportCss();
    const cw = Math.max(1, g?.w ?? v.w ?? 1);
    const ch = Math.max(1, g?.h ?? v.h ?? 1);
    if (rows.length === 0) {
      const single: LayoutScreen = {
        name: "",
        x: 0,
        y: 0,
        width: cw,
        height: ch,
        physical_width: cw,
        physical_height: ch,
        transform: 0,
        refresh_milli_hz: 0,
        vrr_supported: false,
        vrr_enabled: false,
        taskbar_side: "bottom",
        taskbar_programs: true,
        taskbar_osk: true,
        taskbar_keyboard_layout: true,
        taskbar_clock: true,
      };
      return { primary: single, secondary: [] as LayoutScreen[] };
    }
    const explicit = shellChromePrimaryName();
    if (explicit) {
      const ei = rows.findIndex((r) => r.name === explicit);
      if (ei >= 0) {
        const primary = rows[ei];
        const secondary = rows.filter((_, i) => i !== ei);
        return { primary, secondary };
      }
    }
    let pi = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i];
      const b = rows[pi];
      if (a.x < b.x || (a.x === b.x && a.y < b.y)) pi = i;
    }
    const primary = rows[pi];
    const secondary = rows.filter((_, i) => i !== pi);
    return { primary, secondary };
  });

  const backedShellWindowActions = createBackedShellWindowActions({
    getWindows: shellUiWindowsList,
    getScreenDraftRows: liveScreenRows,
    getOutputGeom: outputGeom,
    getLayoutCanvasOrigin: layoutCanvasOrigin,
    getPrimaryMonitorName: () => workspacePartition().primary.name,
    getHostedWindowSpawnMonitorName: () => {
      const id = focusedWindowId();
      const row = shellUiWindowsList().find((w) => w.window_id === id);
      const name = row?.output_name?.trim();
      return name && name.length > 0 ? name : null;
    },
    reserveTaskbarForMon: (screen) =>
      workspaceLayoutBridge.reserveTaskbarForMon(screen),
    sendHostedWindowOpen: (payload) =>
      shellWireSend("hosted_window_open", JSON.stringify(payload)),
  });

  const layoutUnionBbox = createMemo(() =>
    unionBBoxFromScreens(liveScreenRows()),
  );

  const autoShellChromeMonitorName = createMemo(() => {
    const rows = liveScreenRows();
    if (rows.length === 0) return null;
    let pi = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i];
      const b = rows[pi];
      if (a.x < b.x || (a.x === b.x && a.y < b.y)) pi = i;
    }
    return rows[pi]?.name ?? null;
  });

  const panelHostForHud = createMemo(() => {
    if (liveScreenRows().length === 0) return null;
    return workspacePartition().primary;
  });

  const debugHudFrameVisible = createMemo(() => {
    const w = shellUiWindowsMap().get(SHELL_UI_DEBUG_WINDOW_ID);
    return !!w && !w.minimized;
  });

  const settingsHudFrameVisible = createMemo(() => {
    const w = shellUiWindowsMap().get(SHELL_UI_SETTINGS_WINDOW_ID);
    return !!w && !w.minimized;
  });
  function openSettingsPage(page: SettingsPageId) {
    setSettingsActivePage(page);
    backedShellWindowActions.openSettingsShellWindow();
  }
  const debugHudRuntime = createDebugHudRuntime({
    debugHudFrameVisible,
  });

  const fallbackMonitorName = createMemo(() => {
    const part = workspacePartition();
    return (
      part.primary.name || liveScreenRows().find((row) => row.name)?.name || ""
    );
  });

  let shellContextMenus!: ReturnType<typeof createShellContextMenus>;
  const screenshotPortalBridge = createScreenshotPortalBridge({
    getMainRef: () => mainRef,
    outputGeom,
    outputPhysical,
    layoutCanvasOrigin,
    canvasCss,
    screenDraftRows: liveScreenRows,
    shellChromePrimaryName,
    getWorkspacePrimary: () => workspacePartition().primary,
    getWindows: compositorWindowsForGeometry,
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
  });
  const {
    ScreenshotOverlay,
    PortalPickerOverlay,
    beginScreenshotMode,
    closePortalPickerUi,
    portalPickerVisible,
    screenshotMode,
    stopScreenshotMode,
  } = screenshotPortalBridge;
  shellContextMenus = createShellContextMenus({
    floatingLayers,
    mainEl: () => mainRef,
    outputGeom,
    outputPhysical,
    layoutCanvasOrigin,
    screenDraftRows: liveScreenRows,
    shellChromePrimaryName,
    viewportCss,
    canvasCss,
    screenshotMode,
    stopScreenshotMode,
    closeAllAtlasSelects,
    bumpShellRepaint: bumpSnapChrome,
    openShellHostedApp: (kind) =>
      backedShellWindowActions.openShellHostedApp(kind),
    openSettingsPage,
    spawnInCompositor,
    saveSessionSnapshot: () =>
      void sessionPersistenceRuntime.saveCurrentSessionSnapshot(),
    restoreSessionSnapshot: () =>
      void sessionPersistenceRuntime.restoreSavedSessionSnapshot(),
    canSaveSessionSnapshot: () =>
      shellHttpBase() !== null && !sessionRestoreSnapshot(),
    canRestoreSessionSnapshot: () =>
      shellHttpBase() !== null &&
      sessionPersistenceRuntime.savedSessionAvailable() &&
      !sessionRestoreSnapshot(),
    postSessionPower,
    postLockScreen,
    lockScreenEnabled: () => lockScreenState().enabled,
    canSessionControl,
    scheduleOverlayExclusionSync: () =>
      shellSharedStateSync.scheduleOverlayExclusionSync(),
    windows: shellUiWindowsList,
    taskbarPins: () => workspaceSnapshot().taskbarPins ?? [],
    windowSwitcherSelectedWindowId: () =>
      compositorInteractionState()?.window_switcher_selected_window_id ?? null,
    focusedWindowId,
    notificationsState,
    commandPaletteState,
    activateWindow: (windowId) => shellWireSend("activate_window", windowId),
    setShellPrimary: (name) => shellWireSend("set_shell_primary", name),
    setUiScale: (pct) => shellWireSend("set_ui_scale", pct),
    setOutputVrr: (name, enabled) =>
      shellWireSend("set_output_vrr", name, enabled ? 1 : 0),
    bumpTilingConfig: () => {
      setTilingCfgRev((n) => n + 1);
      bumpSnapChrome();
    },
    shellWireSend: (op, arg, arg2) => shellWireSend(op, arg, arg2),
    exitSession: () => {
      if (shellWireSend("quit")) {
        clearShellActionIssue();
        return;
      }
      void postShell("/session_quit", {})
        .then(clearShellActionIssue)
        .catch((error) => {
          reportShellActionIssue(
            `Exit session failed: ${describeError(error)}`,
          );
        });
    },
    tabMenuItems: (windowId: number) => {
      const groupId = workspaceGroupIdForWindow(windowId);
      const split = groupId
        ? getWorkspaceGroupSplit(workspaceSnapshot(), groupId)
        : undefined;
      const pinned = isWorkspaceWindowPinned(workspaceSnapshot(), windowId);
      const items = [
        {
          actionId: pinned ? "unpin" : "pin",
          label: pinned ? "Unpin tab" : "Pin tab",
          action: () => {
            imperativeChromeRenderer.clearSuppressTabClickWindowId();
            sendWorkspaceMutation({
              type: "set_window_pinned",
              windowId,
              pinned: !pinned,
            });
          },
        },
      ];
      if (
        groupId &&
        !split &&
        (workspaceGroupsById().get(groupId)?.members.length ?? 0) >= 2
      ) {
        items.push({
          actionId: "use-split-left",
          label: "Use as split left tab",
          action: () => {
            imperativeChromeRenderer.clearSuppressTabClickWindowId();
            if (!enterSplitGroupWindow(windowId)) return;
            queueMicrotask(() => {
              imperativeChromeRenderer.applySplitGroupGeometry(groupId);
            });
          },
        });
      }
      if (groupId && split?.leftWindowId === windowId) {
        items.push({
          actionId: "exit-split",
          label: "Exit split view",
          action: () => {
            imperativeChromeRenderer.clearSuppressTabClickWindowId();
            exitSplitGroupWindow(windowId);
          },
        });
      }
      return items;
    },
    tabMenuWindowAvailable: (windowId: number) => {
      return (
        shellUiWindowsMap().has(windowId) &&
        workspaceGroupIdForWindow(windowId) !== null
      );
    },
    onTraySniMenuPick: (notifierId, menuPath, dbusmenuId) => {
      shellWireSend("sni_tray_menu_event", notifierId, menuPath, dbusmenuId);
    },
  });

  createEffect(() => {
    const list = compositorWindowsList();
    const liveIds = new Set(list.map((window) => window.window_id));
    for (const window of list) {
      if (windowIsShellHosted(window)) continue;
      if (!nativeWindowRefForId(window.window_id)) {
        tryAssignRestoredNativeWindow(window.window_id);
      }
    }
    setNativeWindowRefs((prev) => {
      let next: Map<number, SessionWindowRef> | null = null;
      for (const [windowId] of prev) {
        if (liveIds.has(windowId)) continue;
        if (!next) next = new Map(prev);
        next.delete(windowId);
      }
      return next ?? prev;
    });
  });
  const {
    workspaceGroups,
    workspaceGroupsById,
    groupIdForWindow: workspaceGroupIdForWindow,
    groupForWindow: workspaceGroupForWindow,
    activeWorkspaceGroupId,
    focusedTaskbarWindowId,
    taskbarRowsByMonitor,
  } = createWorkspaceSelectors({
    workspaceSnapshot,
    windowsById: shellUiWindowsMap,
    windowsList: shellUiWindowsList,
    focusedWindowId,
    fallbackMonitorKey: fallbackMonitorName,
    desktopApps: desktopApps.items,
    shellHostedAppByWindow,
  });
  const compositorWindowsByMonitor = createMemo(() =>
    buildWindowsByMonitor(compositorWindowsForGeometry(), fallbackMonitorName()),
  );
  function requestWindowSyncRecovery() {
    if (hasPendingClientMutation()) {
      windowSyncRecoveryDeferred = true;
      return;
    }
    windowSyncRecoveryDeferred = false;
    const now = Date.now();
    if (windowSyncRecoveryPending && now - windowSyncRecoveryRequestedAt < 1000)
      return;
    if (!shellWireSend("request_compositor_sync")) return;
    windowSyncRecoveryPending = true;
    windowSyncRecoveryRequestedAt = now;
  }

  function focusShellUiWindow(windowId: number) {
    shellWireSend("shell_focus_ui_window", windowId);
  }

  function activateTaskbarWindowViaShell(windowId: number) {
    shellWireSend("taskbar_activate", windowId);
  }

  function activateWindowViaShell(windowId: number) {
    shellWireSend("activate_window", windowId);
  }

  const {
    focusWindowViaShell,
    applyTabDrop,
    applyWindowDrop,
    detachGroupWindow,
    selectGroupWindow,
    closeWindow,
    closeGroupWindow,
    cycleFocusedWorkspaceGroup,
    activateTaskbarGroup,
    enterSplitGroupWindow,
    exitSplitGroupWindow,
    setSplitGroupFraction,
  } = createWorkspaceActions({
    workspaceSnapshot,
    allWindowsMap: compositorWindowMapForGeometry,
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
    sendWorkspaceMutation,
    sendWindowIntent,
    shellWireSend,
  });

  const [fileTabDropDrag, setFileTabDropDrag] =
    createSignal<WorkspaceExternalTabDropDrag | null>(null);

  function openFileBrowserEntryBackedWindowId(
    path: string,
    context: { directory: string; showHidden: boolean; isDirectory: boolean },
  ): number | null {
    if (context.isDirectory)
      return backedShellWindowActions.openFileBrowserWindowWithId(path);
    const detail = {
      path,
      directory: context.directory,
      showHidden: context.showHidden,
    };
    if (isImageFilePath(path))
      return backedShellWindowActions.openImageViewerWindowWithId(detail);
    if (isVideoFilePath(path))
      return backedShellWindowActions.openVideoViewerWindowWithId(detail);
    if (isTextEditorFilePath(path))
      return backedShellWindowActions.openTextEditorWindowWithId(detail);
    if (isPdfFilePath(path))
      return backedShellWindowActions.openPdfViewerWindowWithId(detail);
    return null;
  }

  function fileBrowserEntryHasShellTabApp(
    path: string,
    context: { directory: string; showHidden: boolean; isDirectory: boolean },
  ): boolean {
    if (context.isDirectory) return true;
    const category = fileOpenCategoryForPath(path);
    const appId = defaultApps.loaded()
      ? defaultApps.settings()[category]
      : DEFAULT_APPLICATIONS_FALLBACK[category];
    const option = optionById(appId, category, desktopApps.items());
    return (
      option.kind === "shell" ||
      isImageFilePath(path) ||
      isVideoFilePath(path) ||
      isTextEditorFilePath(path) ||
      isPdfFilePath(path)
    );
  }

  function openFileBrowserEntryShellDefaultWindowId(
    path: string,
    context: { directory: string; showHidden: boolean; isDirectory: boolean },
  ): number | null {
    if (context.isDirectory)
      return backedShellWindowActions.openFileBrowserWindowWithId(path);
    const detail = {
      path,
      directory: context.directory,
      showHidden: context.showHidden,
    };
    const category = fileOpenCategoryForPath(path);
    const appId = defaultApps.loaded()
      ? defaultApps.settings()[category]
      : DEFAULT_APPLICATIONS_FALLBACK[category];
    const option = optionById(appId, category, desktopApps.items());
    if (option.kind === "shell") {
      if (option.shellKind === "image_viewer")
        return backedShellWindowActions.openImageViewerWindowWithId(detail);
      if (option.shellKind === "video_viewer")
        return backedShellWindowActions.openVideoViewerWindowWithId(detail);
      if (option.shellKind === "text_editor")
        return backedShellWindowActions.openTextEditorWindowWithId(detail);
      if (option.shellKind === "pdf_viewer")
        return backedShellWindowActions.openPdfViewerWindowWithId(detail);
    }
    return openFileBrowserEntryBackedWindowId(path, context);
  }

  function placeOpenedWindowInTargetGroup(
    openedWindowId: number,
    targetGroupId: string,
    insertIndex: number,
  ) {
    sendWorkspaceMutation({
      type: "move_window_to_group",
      windowId: openedWindowId,
      targetGroupId,
      insertIndex,
    });
    sendWorkspaceMutation({
      type: "select_tab",
      groupId: targetGroupId,
      windowId: openedWindowId,
    });
  }

  function placeOpenedWindowInSourceGroup(
    sourceWindowId: number,
    openedWindowId: number,
    mode: "tab" | "split",
  ) {
    const targetGroupId = workspaceGroupIdForWindow(sourceWindowId);
    if (!targetGroupId) return;
    const targetGroup = workspaceSnapshot().groups.find(
      (group) => group.id === targetGroupId,
    );
    sendWorkspaceMutation({
      type: "move_window_to_group",
      windowId: openedWindowId,
      targetGroupId,
      insertIndex: targetGroup?.windowIds.length ?? 0,
    });
    if (mode === "tab") {
      sendWorkspaceMutation({
        type: "select_tab",
        groupId: targetGroupId,
        windowId: openedWindowId,
      });
      return;
    }
    sendWorkspaceMutation({
      type: "enter_split",
      groupId: targetGroupId,
      leftWindowId: sourceWindowId,
      leftPaneFraction: 0.5,
    });
  }

  function openFileBrowserEntryInWorkspaceGroup(
    sourceWindowId: number,
    path: string,
    context: { directory: string; showHidden: boolean; isDirectory: boolean },
    mode: "tab" | "split",
  ) {
    const openedWindowId = openFileBrowserEntryBackedWindowId(path, context);
    if (openedWindowId === null) {
      void spawnInCompositor(`xdg-open ${shSingleQuotedForSpawn(path)}`);
      return;
    }
    placeOpenedWindowInSourceGroup(sourceWindowId, openedWindowId, mode);
  }

  function openFileBrowserEntryInWorkspaceTarget(
    path: string,
    context: { directory: string; showHidden: boolean; isDirectory: boolean },
    target: TabMergeTarget,
  ): boolean {
    const openedWindowId = openFileBrowserEntryShellDefaultWindowId(
      path,
      context,
    );
    if (openedWindowId === null) {
      reportShellActionIssue("This file does not have a shell tab app.");
      return false;
    }
    placeOpenedWindowInTargetGroup(
      openedWindowId,
      target.groupId,
      target.insertIndex,
    );
    return true;
  }

  function previewFileBrowserEntryAtTabDrop(
    path: string,
    context: { directory: string; showHidden: boolean; isDirectory: boolean },
    label: string,
    clientX: number,
    clientY: number,
  ): boolean {
    const canOpen = fileBrowserEntryHasShellTabApp(path, context);
    const target = canOpen
      ? findMergeTarget(workspaceSnapshot(), 0, clientX, clientY, false)
      : null;
    setFileTabDropDrag({
      target,
      clientX,
      clientY,
      label,
      canDrop: canOpen && target !== null,
    });
    return target !== null;
  }

  function clearFileBrowserTabDropPreview() {
    setFileTabDropDrag(null);
  }

  function openFileBrowserEntryAtTabDrop(
    path: string,
    context: { directory: string; showHidden: boolean; isDirectory: boolean },
    clientX: number,
    clientY: number,
  ): boolean {
    clearFileBrowserTabDropPreview();
    const target = findMergeTarget(
      workspaceSnapshot(),
      0,
      clientX,
      clientY,
      false,
    );
    if (!target) return false;
    return openFileBrowserEntryInWorkspaceTarget(path, context, target);
  }

  function openFileWithOption(
    option: OpenWithOption,
    path: string,
    context: { directory: string; showHidden: boolean },
  ) {
    const detail = {
      path,
      directory: context.directory,
      showHidden: context.showHidden,
    };
    if (option.kind === "shell") {
      if (option.shellKind === "image_viewer")
        backedShellWindowActions.openImageViewerWindow(detail);
      else if (option.shellKind === "video_viewer")
        backedShellWindowActions.openVideoViewerWindow(detail);
      else if (option.shellKind === "text_editor")
        backedShellWindowActions.openTextEditorWindow(detail);
      else if (option.shellKind === "pdf_viewer")
        backedShellWindowActions.openPdfViewerWindow(detail);
      return;
    }
    if (option.kind === "desktop") {
      const command = `${option.app.exec} ${shSingleQuotedForSpawn(path)}`;
      void spawnInCompositor(command, {
        command,
        desktopId: option.app.desktop_id || null,
        appName: option.app.name || null,
      });
      return;
    }
    void spawnInCompositor(`xdg-open ${shSingleQuotedForSpawn(path)}`);
  }

  function openCustomLayoutOverlay(detail: {
    outputName: string;
    layoutId?: string | null;
  }) {
    setCustomLayoutOverlay({
      outputName: detail.outputName,
      initialLayoutId: detail.layoutId ?? null,
    });
  }

  function closeCustomLayoutOverlay() {
    setCustomLayoutOverlay(null);
  }

  function taskbarPinMonitorForWindow(windowId: number) {
    const outputName = shellUiWindowById(windowId)()?.output_name?.trim() ?? "";
    if (!outputName) return null;
    return {
      outputName,
      outputId: outputIdentityForMonitorName(outputName),
    };
  }

  function addFolderTaskbarPin(
    monitor: { outputName: string; outputId: string | null },
    path: string,
    label: string,
  ) {
    shellWireSend(
      "taskbar_pin_add",
      JSON.stringify({
        outputName: monitor.outputName,
        outputId: monitor.outputId,
        pin: {
          kind: "folder",
          id: `folder:${path}`,
          label,
          path,
        },
      }),
    );
  }

  function removeFolderTaskbarPin(
    monitor: { outputName: string; outputId: string | null },
    pinId: string,
  ) {
    shellWireSend(
      "taskbar_pin_remove",
      JSON.stringify({
        outputName: monitor.outputName,
        outputId: monitor.outputId,
        pinId,
      }),
    );
  }

  const shellUiWindowFullscreenAccessors = new Map<
    number,
    () => boolean
  >();

  function shellUiWindowFullscreen(windowId: number) {
    let accessor = shellUiWindowFullscreenAccessors.get(windowId);
    if (!accessor) {
      accessor = createMemo(
        () => shellUiWindowById(windowId)()?.fullscreen ?? false,
      );
      shellUiWindowFullscreenAccessors.set(windowId, accessor);
    }
    return accessor;
  }

  function renderShellWindowContent(windowId: number): JSX.Element | undefined {
    return renderShellHostedWindowContent(windowId, {
      currentMonitorName: () => shellUiWindowById(SHELL_UI_SETTINGS_WINDOW_ID)()?.output_name ?? null,
      shellWindowTitle: (id) => shellUiWindowById(id)()?.title ?? null,
      shellWindowFullscreen: shellUiWindowFullscreen,
      shellHostedAppByWindow,
      shellWireSend,
      taskbarPins: () => workspaceSnapshot().taskbarPins ?? [],
      taskbarPinMonitorForWindow,
      onTaskbarPinFolderAdd: addFolderTaskbarPin,
      onTaskbarPinFolderRemove: removeFolderTaskbarPin,
      onOpenFileBrowserInNewWindow: (path) =>
        backedShellWindowActions.openFileBrowserWindow(path),
      onOpenImageFile: (detail) =>
        backedShellWindowActions.openImageViewerWindow(detail),
      onOpenVideoFile: (detail) =>
        backedShellWindowActions.openVideoViewerWindow(detail),
      onOpenTextFile: (detail) =>
        backedShellWindowActions.openTextEditorWindow(detail),
      onOpenPdfFile: (detail) =>
        backedShellWindowActions.openPdfViewerWindow(detail),
      onOpenFileWith: openFileWithOption,
      onOpenPathInTab: (sourceWindowId, path, context) => {
        openFileBrowserEntryInWorkspaceGroup(
          sourceWindowId,
          path,
          context,
          "tab",
        );
      },
      onOpenPathInTabDrop: openFileBrowserEntryAtTabDrop,
      onPreviewPathInTabDrop: previewFileBrowserEntryAtTabDrop,
      onClearPathInTabDropPreview: clearFileBrowserTabDropPreview,
      onOpenPathInSplitView: (sourceWindowId, path, context) => {
        openFileBrowserEntryInWorkspaceGroup(
          sourceWindowId,
          path,
          context,
          "split",
        );
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
      taskbarAutoHide,
      viewportCss,
      windowsList: shellUiWindowsList,
      pointerClient,
      pointerInMain,
      rootPointerDowns: debugHudRuntime.rootPointerDowns,
      exclusionZonesHud: debugHudRuntime.exclusionZonesHud,
      screenDraft,
      settingsActivePage,
      setSettingsActivePage,
      setScreenDraft,
      markScreenDraftDirty,
      autoShellChromeMonitorName,
      canSessionControl,
      uiScalePercent,
      tilingCfgRev,
      setTilingCfgRev,
      bumpSnapChrome,
      scheduleExclusionZonesSync,
      openCustomLayoutOverlay,
      setShellPrimary: (name) => shellWireSend("set_shell_primary", name),
      setUiScale: (pct) => shellWireSend("set_ui_scale", pct),
      setOutputVrr: (name, enabled) =>
        shellWireSend("set_output_vrr", name, enabled ? 1 : 0),
      setTaskbarAutoHide: (enabled) =>
        shellWireSend("set_taskbar_auto_hide", enabled ? 1 : 0),
      setTaskbarSide: (name, side) =>
        shellWireSend("set_taskbar_side", name, side),
      setTaskbarComponent: (name, component, enabled) =>
        shellWireSend(
          "set_taskbar_component",
          name,
          component,
          enabled ? 1 : 0,
        ),
      applyCompositorLayoutFromDraft: () => {
        const screens = screenDraft.rows.map((r) => ({
          name: r.name,
          x: r.x,
          y: r.y,
          transform: r.transform,
        }));
        shellWireSend("set_output_layout", JSON.stringify({ screens }));
      },
      monitorRefreshLabel,
      keyboardLayoutLabel,
      setDesktopBackgroundJson: (json) =>
        shellWireSend("set_desktop_background", json),
      sessionAutoSaveEnabled: sessionPersistenceRuntime.sessionAutoSaveEnabled,
      setSessionAutoSaveEnabled:
        sessionPersistenceRuntime.updateSessionAutoSavePreference,
      defaultApps,
      desktopApps,
      notificationsState,
    });
  }

  const taskbarScreens = createMemo(() =>
    screensListForLayout(liveScreenRows(), outputGeom(), layoutCanvasOrigin()),
  );
  const exclusionReactiveDeps = createMemo(() => {
    void shellContextMenus.ctxMenuOpen();
    void shellContextMenus.powerMenuOpen();
    void shellContextMenus.volumeMenuOpen();
    void shellContextMenus.tabMenuOpen();
    void shellContextMenus.traySniMenuOpen();
    void portalPickerVisible();
    void floatingLayers.layers().length;
    void chromeOverlayPointerUsers();
    return 0;
  });

  const { scheduleExclusionZonesSync, syncExclusionZonesNow } =
    createShellExclusionSync({
      mainEl: () => mainRef,
      outputGeom,
      layoutCanvasOrigin,
      onHudChange: debugHudRuntime.setExclusionZonesHud,
      exclusionReactiveDeps,
    });
  const shellMeasureEnv = () => {
    const main = mainRef;
    const og = outputGeom();
    if (!main || !og) return null;
    return { main, outputGeom: og, origin: layoutCanvasOrigin() };
  };
  const shellSharedStateSync = createShellUiWindowSyncRuntime({
    invalidateAllShellUiWindows,
    flushShellUiWindowsSyncNow,
    scheduleExclusionZonesSync,
    syncExclusionZonesNow,
    measureEnv: shellMeasureEnv,
  });

  createEffect(() => {
    const main = mainRef;
    if (!main || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      shellSharedStateSync.requestSharedStateSync({
        shellUi: "invalidate-all",
        exclusion: "sync",
      });
    });
    observer.observe(main, { box: "border-box" });
    onCleanup(() => observer.disconnect());
  });

  const workspaceLayoutBridge = createWorkspaceLayoutBridge({
    getWorkspaceState: workspaceSnapshot,
    getAllWindowsMap: compositorWindowMapForGeometry,
    getWindowsByMonitor: compositorWindowsByMonitor,
    getTaskbarRowsByMonitor: taskbarRowsByMonitor,
    getFallbackMonitorName: fallbackMonitorName,
    taskbarAutoHide,
    requestSharedStateSync: shellSharedStateSync.requestSharedStateSync,
    sendWorkspaceMutation,
    shellWireSend,
  });

  function outputIdentityForMonitorName(monitorName: string): string | null {
    return (
      liveScreenRows().find((screen) => screen.name === monitorName)
        ?.identity ?? null
    );
  }

  function taskbarPinsForScreen(screen: LayoutScreen): TaskbarPin[] {
    const pins = workspaceSnapshot().taskbarPins ?? [];
    const row =
      (screen.identity
        ? pins.find((monitor) => (monitor.outputId ?? "") === screen.identity)
        : undefined) ??
      pins.find((monitor) => monitor.outputName === screen.name);
    return row?.pins ?? [];
  }

  function sendTaskbarPinRemove(pin: TaskbarPin, monitorName: string): boolean {
    return shellWireSend(
      "taskbar_pin_remove",
      JSON.stringify({
        outputName: monitorName,
        outputId: outputIdentityForMonitorName(monitorName),
        pinId: pin.id,
      }),
    );
  }

  function activateTaskbarPin(pin: TaskbarPin, monitorName: string) {
    if (pin.kind === "folder") {
      backedShellWindowActions.openFileBrowserWindowAtMonitor(
        pin.path,
        monitorName,
      );
      return;
    }
    shellWireSend(
      "taskbar_pin_launch",
      JSON.stringify({
        outputName: monitorName,
        outputId: outputIdentityForMonitorName(monitorName),
        pinId: pin.id,
      }),
    );
  }

  createEffect(() => {
    void shellWireReadyRev();
    shellSharedStateSync.requestSharedStateSync({
      shellUi: "flush",
      exclusion: "sync",
    });
  });

  function isPrimaryTaskbarScreen(s: LayoutScreen, primary: LayoutScreen) {
    return (
      s.name === primary.name &&
      s.x === primary.x &&
      s.y === primary.y &&
      s.width === primary.width &&
      s.height === primary.height
    );
  }

  /** Memo so pointer/viewport updates re-run (nested `Show` + FC did not track `pointerClient`). */
  const crosshairDebugOverlay = createMemo(() => {
    if (!crosshairCursor()) return null;
    const p = pointerClient();
    if (!p) return null;
    const vpw = viewportCss().w;
    const vph = viewportCss().h;
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
    );
  });
  createEffect(() => {
    outputGeom();
    layoutCanvasOrigin();
    if (shellUiWindowsInvalidateQueued) return;
    shellUiWindowsInvalidateQueued = true;
    queueMicrotask(() => {
      shellUiWindowsInvalidateQueued = false;
      shellSharedStateSync.requestSharedStateSync(
        { shellUi: "invalidate-all" },
        "now",
      );
    });
  });

  function bumpSnapChrome() {
    setSnapChromeRev((n) => n + 1);
  }

  function openShellTestWindow() {
    return backedShellWindowActions.openShellTestWindow();
  }

  const shellWindowGestureRuntime = createShellWindowGestureRuntime({
    getMainRef: () => mainRef,
    outputGeom,
    layoutCanvasOrigin,
    screenDraftRows: liveScreenRows,
    readCompositorWindow: readCompositorWindowForChrome,
    reserveTaskbarForMon: workspaceLayoutBridge.reserveTaskbarForMon,
    occupiedSnapZonesOnMonitor:
      workspaceLayoutBridge.occupiedSnapZonesOnMonitor,
    sendSetMonitorTile: workspaceLayoutBridge.sendSetMonitorTile,
    sendSetPreTileGeometry: workspaceLayoutBridge.sendSetPreTileGeometry,
    sendRemoveMonitorTile: workspaceLayoutBridge.sendRemoveMonitorTile,
    sendClearPreTileGeometry: workspaceLayoutBridge.sendClearPreTileGeometry,
    workspacePreTileSnapshot: workspaceLayoutBridge.workspacePreTileSnapshot,
    workspaceTiledRectMap: workspaceLayoutBridge.workspaceTiledRectMap,
    workspaceTiledZone: (windowId) =>
      workspaceGetTiledZone(workspaceSnapshot(), windowId) ?? null,
    isWorkspaceWindowTiled: (windowId) =>
      workspaceIsWindowTiled(workspaceSnapshot(), windowId),
    workspaceFindMonitorForTiledWindow: (windowId) => {
      const outputName = workspaceFindMonitorForTiledWindow(
        workspaceSnapshot(),
        windowId,
      );
      if (outputName === null) return null;
      return {
        outputName,
        outputId: workspaceFindMonitorIdentityForTiledWindow(
          workspaceSnapshot(),
          windowId,
        ),
      };
    },
    requestSharedStateSync: shellSharedStateSync.requestSharedStateSync,
    requestCompositorSync,
    bumpSnapChrome,
    shellWireSend,
    shellMoveLog,
    clearNativeDragPreview: () => setNativeDragPreview(null),
  });

  const imperativeChromeRenderer = createImperativeChromeRenderer({
    getRoot: () => chromeRootRef,
    getMainRef: () => mainRef,
    desktopApps: desktopApps.items,
    layoutCanvasOrigin,
    outputGeom,
    assistOverlay: shellWindowGestureRuntime.assistOverlay,
    screenCssRect: (screen) =>
      layoutScreenCssRect(screen, layoutCanvasOrigin()),
    snapStrip: shellWindowGestureRuntime.snapStripState,
    snapStripScreen: () =>
      shellWindowGestureRuntime.dragSnapAssistContext()?.screen ?? null,
    snapStripExclusionActive: () =>
      shellWindowGestureRuntime.dragWindowMoved() &&
      shellWindowGestureRuntime.getShellWindowDragId() !== null,
    focusWindowViaShell,
    beginShellWindowMove: shellWindowGestureRuntime.beginShellWindowMove,
    adoptShellWindowMove: shellWindowGestureRuntime.adoptShellWindowMove,
    beginShellWindowResize: shellWindowGestureRuntime.beginShellWindowResize,
    toggleShellMaximizeForWindow:
      shellWindowGestureRuntime.toggleShellMaximizeForWindow,
    externalTabDropDrag: fileTabDropDrag,
    selectGroupWindow,
    setSplitGroupFraction,
    applyTabDrop,
    applyWindowDrop,
    detachGroupWindow,
    openSnapAssistPicker: (windowId, anchorRect) =>
      shellWindowGestureRuntime.openSnapAssistPicker(windowId, "button", anchorRect),
    shellPointerGlobalLogical,
    pointerClient,
    compositorPointerClient: () => compositorInteractionPointerClient(),
    shellWindowDragId: shellWindowGestureRuntime.dragWindowId,
    shellWindowDragMoved: shellWindowGestureRuntime.dragWindowMoved,
    compositorMoveWindowId: () =>
      compositorInteractionState()?.move_window_id ?? null,
    compositorMoveProxyWindowId: () =>
      compositorInteractionState()?.move_proxy_window_id ?? null,
    shellContextHideMenu: shellContextMenus.hideContextMenu,
    closeGroupWindow,
    closeWindow,
    shellContextOpenTabMenu: shellContextMenus.openTabMenu,
    shellHostedContentRoot: getShellHostedContentRoot,
    shellWireSend,
  });
  applyNativeDragPreviewToChrome = imperativeChromeRenderer.setNativeDragPreview;
  applyNativeDragPreviewToChrome(nativeDragPreview);

  const shellHostedContentRoots = new Map<number, HTMLDivElement>();

  function getShellHostedContentRoot(windowId: number) {
    let root = shellHostedContentRoots.get(windowId);
    if (!root) {
      root = document.createElement("div");
      root.className = "h-full min-h-0 min-w-0 [&>*]:h-full [&>*]:min-h-0 [&>*]:min-w-0";
      root.dataset.shellHostedContentRoot = String(windowId);
      shellHostedContentRoots.set(windowId, root);
    }
    return root;
  }

  const shellHostedContentWindowIds = createMemo((prev: readonly number[] = []) => {
    const next = [...shellUiWindowsMap().values()]
      .filter((window) => windowIsShellHosted(window))
      .sort((a, b) => a.window_id - b.window_id)
      .map((window) => window.window_id);
    return sameNumberList(prev, next) ? prev : next;
  });

  createEffect(() => {
    const live = new Set(shellHostedContentWindowIds());
    for (const [windowId, root] of shellHostedContentRoots) {
      if (live.has(windowId)) continue;
      root.remove();
      shellHostedContentRoots.delete(windowId);
    }
  });

  function ShellHostedContentPortal(props: { windowId: number }) {
    return (
      <Portal mount={getShellHostedContentRoot(props.windowId)}>
        <div
          class="h-full min-h-0 min-w-0"
          onPointerDown={() => {
            focusWindowViaShell(props.windowId);
          }}
        >
          {renderShellWindowContent(props.windowId)}
        </div>
      </Portal>
    );
  }

  const windowInteractionCapture = createMemo(() => {
    const state = compositorInteractionState();
    const localDragWindowId = shellWindowGestureRuntime.dragWindowId();
    const activeWindowId =
      state?.move_proxy_window_id ??
      state?.move_window_id ??
      state?.resize_window_id ??
      localDragWindowId;
    if (activeWindowId === null) return null;
    const activeWindow = shellUiWindowsMap().get(activeWindowId);
    if (!activeWindow || !windowIsShellHosted(activeWindow)) return null;
    return {
      cursor:
        state?.resize_window_id !== null
          ? "cursor-default"
          : state?.move_window_id !== null ||
              state?.move_proxy_window_id !== null ||
              localDragWindowId !== null
            ? "cursor-grabbing"
            : "cursor-default",
    };
  });

  const shellSurfaceRuntime = createShellSurfaceRuntime({
    workspaceSecondary: () => workspacePartition().secondary,
    screenCssRect: (screen) =>
      layoutScreenCssRect(screen, layoutCanvasOrigin()),
    debugHudFrameVisible,
    taskbarScreens,
    taskbarHeight: TASKBAR_HEIGHT,
    taskbarAutoHide,
    taskbarPortalMenusOpen: () =>
      shellContextMenus.programsMenuOpen() ||
      shellContextMenus.powerMenuOpen() ||
      shellContextMenus.volumeMenuOpen(),
    pointerInMain,
    screenTaskbarHiddenForFullscreen:
      workspaceLayoutBridge.screenTaskbarHiddenForFullscreen,
    isPrimaryTaskbarScreen: (screen) =>
      isPrimaryTaskbarScreen(screen, workspacePartition().primary),
    batteryState: shellBattery.state,
    trayVolumeState,
    taskbarPinsForScreen,
    taskbarRowsForScreen: workspaceLayoutBridge.taskbarRowsForScreen,
    focusedTaskbarWindowId,
    keyboardLayoutLabel,
    oskEnabled,
    settingsHudFrameVisible,
    trayReservedPx,
    sniTrayItems,
    trayIconSlotPx,
    windows: shellUiWindowsMap,
    closeGroupWindow,
    activateTaskbarGroup,
    activateTaskbarPin,
    unpinTaskbarPin: sendTaskbarPinRemove,
    openSettingsShellWindow: backedShellWindowActions.openSettingsShellWindow,
    openDebugShellWindow: backedShellWindowActions.openDebugShellWindow,
    openTraySniMenu: shellContextMenus.openTraySniMenu,
    shellWireSend,
  });

  const e2eTabDragTarget = createMemo(() => {
    const target = imperativeChromeRenderer.activeDropTarget();
    const windowId = imperativeChromeRenderer.activeDragWindowId();
    if (!target || windowId == null) return null;
    return {
      windowId,
      groupId: target.groupId,
      insertIndex: target.insertIndex,
    };
  });

  const endWorkspaceAwareShellWindowMove = (
    reason: string,
    sendMoveEnd = true,
  ) => {
    const snapActive =
      shellWindowGestureRuntime.snapAssistPicker() !== null ||
      shellWindowGestureRuntime.getActiveSnapZone() !== null ||
      shellWindowGestureRuntime.getActiveSnapPreviewCanvas() !== null;
    const dropAllowed = !snapActive;
    const dropped = dropAllowed
      ? imperativeChromeRenderer.finishWindowDragDrop(
          pointerClient() ?? compositorInteractionPointerClient(),
        )
      : false;
    shellWindowGestureRuntime.endShellWindowMove(
      reason,
      !dropped,
      sendMoveEnd,
      compositorInteractionState()?.interaction_serial ??
        previousCompositorInteractionSerial,
    );
  };

  function markScreenDraftDirty() {
    if (screenDraft.dirty) return;
    setScreenDraft("dirty", true);
  }

  let previousCompositorMoveWindowId: number | null = null;
  let previousCompositorInteractionSerial = 0;
  createEffect(() => {
    const interactionState = compositorInteractionState();
    const compositorMoveWindowId = interactionState?.move_window_id ?? null;
    const compositorResizeWindowId = interactionState?.resize_window_id ?? null;
    const compositorInteractionSerial =
      interactionState?.interaction_serial ?? 0;
    const compositorPointer = compositorInteractionPointerClient();
    const localDragWindowId = shellWindowGestureRuntime.dragWindowId();
    const localDragOwnsCompositorMove =
      localDragWindowId !== null &&
      compositorMoveWindowId === localDragWindowId;
    const ignoreReleasedCompositorMove =
      compositorMoveWindowId !== null &&
      shellWindowGestureRuntime.shouldIgnoreReleasedCompositorMove(
        compositorMoveWindowId,
        compositorInteractionSerial,
      );
    const interactionActive =
      interactionState !== null &&
      (interactionState.move_window_id !== null ||
        interactionState.resize_window_id !== null);
    if (interactionActive && compositorPointer) {
      if (!localDragOwnsCompositorMove && !ignoreReleasedCompositorMove) {
        syncPointerSignalsFromClient(compositorPointer);
      }
      if (
        compositorMoveWindowId !== null &&
        !localDragOwnsCompositorMove &&
        !ignoreReleasedCompositorMove
      ) {
        if (localDragWindowId === null) {
          shellWindowGestureRuntime.adoptShellWindowMove(
            compositorMoveWindowId,
            compositorPointer.x,
            compositorPointer.y,
            true,
            { superHeld: interactionState?.super_held === true },
          );
        }
        shellWindowGestureRuntime.syncShellWindowMovePointer(
          compositorPointer.x,
          compositorPointer.y,
          interactionState?.super_held === true,
        );
      }
      if (
        compositorMoveWindowId !== null &&
        localDragOwnsCompositorMove &&
        !ignoreReleasedCompositorMove
      ) {
        shellWindowGestureRuntime.syncShellWindowMovePointer(
          compositorPointer.x,
          compositorPointer.y,
          interactionState?.super_held === true,
        );
      }
      if (compositorResizeWindowId !== null) {
        shellWindowGestureRuntime.syncShellWindowResizePointer(
          compositorPointer.x,
          compositorPointer.y,
        );
      }
    }
    if (
      localDragWindowId !== null &&
      previousCompositorMoveWindowId === localDragWindowId &&
      compositorMoveWindowId !== localDragWindowId
    ) {
      if (
        shellWindowGestureRuntime.shouldIgnoreReleasedCompositorMoveEnd(
          localDragWindowId,
          previousCompositorInteractionSerial,
          compositorInteractionSerial,
        )
      ) {
        previousCompositorMoveWindowId = compositorMoveWindowId;
        previousCompositorInteractionSerial = compositorInteractionSerial;
        return;
      }
      if (compositorPointer) {
        syncPointerSignalsFromClient(compositorPointer);
        if (
          shellWindowGestureRuntime.getActiveSnapZone() === null &&
          shellWindowGestureRuntime.getActiveSnapPreviewCanvas() === null &&
          shellWindowGestureRuntime.snapAssistPicker() === null
        ) {
          shellWindowGestureRuntime.syncShellWindowMovePointer(
            compositorPointer.x,
            compositorPointer.y,
          );
        }
      }
      endWorkspaceAwareShellWindowMove("compositor-move-ended", false);
    }
    previousCompositorMoveWindowId = compositorMoveWindowId;
    previousCompositorInteractionSerial = compositorInteractionSerial;
  });

  async function spawnInCompositor(
    cmd: string,
    launch?: NativeLaunchMetadata | null,
    sessionRestore = false,
    forcedWindowRef?: SessionWindowRef | null,
  ) {
    const trimmed = cmd.trim();
    if (!trimmed) return;
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
          };
    const pendingWindowRef =
      forcedWindowRef ?? nativeWindowRef(nextNativeWindowSeq());
    if (!forcedWindowRef) {
      setNextNativeWindowSeq((seq) => seq + 1);
    }
    pendingNativeLaunches.push({
      windowRef: pendingWindowRef,
      launch: effectiveLaunch,
    });
    nativeLaunchMetadataByRef.set(pendingWindowRef, effectiveLaunch);
    try {
      if (shellWireSend("spawn", trimmed)) {
        clearShellActionIssue();
        return;
      }
      await spawnViaShellHttp(trimmed, window.__DERP_SPAWN_URL, {
        desktop_id: effectiveLaunch.desktopId ?? undefined,
        app_name: effectiveLaunch.appName ?? undefined,
        session_restore: sessionRestore,
      });
      clearShellActionIssue();
    } catch (error) {
      const index = pendingNativeLaunches.findIndex(
        (entry) => entry.windowRef === pendingWindowRef,
      );
      if (index >= 0) pendingNativeLaunches.splice(index, 1);
      nativeLaunchMetadataByRef.delete(pendingWindowRef);
      reportShellActionIssue(`Launch failed: ${describeError(error)}`);
    }
  }

  onMount(() => {
    queueMicrotask(async () => {
      const base = shellHttpBase();
      if (!base) return;
      try {
        setLockScreenState(
          sanitizeShellLockScreenState(await getShellJson("/lock_state", base)),
        );
      } catch {}
    });
    const disposeNotificationsApi = installShellNotificationsApi();
    const disposeAppRuntimeBootstrap = registerAppRuntimeBootstrap({
      startThemeDomSync,
      subscribeShellWindowState,
      onShellWindowStateChanged:
        sessionPersistenceRuntime.bumpShellWindowStateRev,
      refreshThemeSettingsFromRemote,
      warmDesktopApps: () => desktopApps.warm(),
      warmDefaultApps: () => defaultApps.warm(),
      warmProgramsMenuItems: () => shellContextMenus.warmProgramsMenuItems(),
      bootstrapSessionState: () =>
        sessionPersistenceRuntime.bootstrapSessionState(),
      disposeBackedShellWindowActions: () => backedShellWindowActions.dispose(),
      startShellTransportBridge,
      registerShellE2eBridge: {
        getMainRef: () => mainRef ?? null,
        getViewport: viewportCss,
        getPointerClient: pointerClient,
        getCompositorInteractionState: () => {
          const state = compositorInteractionState();
          if (!state) return null;
          return {
            interaction_serial: state.interaction_serial,
            move_window_id: state.move_window_id,
            resize_window_id: state.resize_window_id,
            move_proxy_window_id: state.move_proxy_window_id,
            move_capture_window_id: state.move_capture_window_id,
            super_held: state.super_held,
            window_switcher_selected_window_id:
              state.window_switcher_selected_window_id,
            move_rect: state.move_rect,
            resize_rect: state.resize_rect,
          };
        },
        getOrigin: layoutCanvasOrigin,
        getCanvas: () => {
          const logicalCanvas = layoutUnionBbox();
          return logicalCanvas
            ? { w: logicalCanvas.w, h: logicalCanvas.h }
            : outputGeom();
        },
        getWindows: compositorWindowsForGeometry,
        getWorkspaceGroups: workspaceGroups,
        getTaskbarRowsByMonitor: taskbarRowsByMonitor,
        getFocusedWindowId: focusedWindowId,
        getBatteryState: shellBattery.state,
        getKeyboardLayoutLabel: keyboardLayoutLabel,
        getScreenshotMode: screenshotMode,
        getCrosshairCursor: crosshairCursor,
        getProgramsMenuOpen: () =>
          shellContextMenus.programsMenuOpen() &&
          !!document.querySelector("[data-shell-programs-menu-panel]"),
        getPowerMenuOpen: shellContextMenus.powerMenuOpen,
        getVolumeMenuOpen: shellContextMenus.volumeMenuOpen,
        getTraySniMenuOpen: shellContextMenus.traySniMenuOpen,
        getDebugWindowVisible: debugHudFrameVisible,
        getSettingsWindowVisible: settingsHudFrameVisible,
        getSnapAssistPicker: shellWindowGestureRuntime.snapAssistPicker,
        getActiveSnapPreviewCanvas:
          shellWindowGestureRuntime.getActiveSnapPreviewCanvas,
        getActiveSnapState: () => ({
          zone: shellWindowGestureRuntime.getActiveSnapZone(),
          dragSuperHeld: shellWindowGestureRuntime.getDragSuperHeld(),
        }),
        getAssistOverlayHoverSpan: () => {
          const overlay = shellWindowGestureRuntime.assistOverlay();
          return overlay?.kind === "assist" ? overlay.hoverSpan : null;
        },
        getProgramsMenuQuery: shellContextMenus.programsMenuProps.query,
        buildSessionSnapshot,
        getSessionRestoreActive: () => sessionRestoreSnapshot() !== null,
        getNotificationsState: notificationsState,
        getFloatingLayers: floatingLayers.layers,
        getTabDragTarget: e2eTabDragTarget,
        projectCurrentMenuElementRect:
          shellContextMenus.projectCurrentMenuElementRect,
        isWorkspaceWindowPinned: (windowId: number) =>
          isWorkspaceWindowPinned(workspaceSnapshot(), windowId),
        openShellTestWindow,
        resetTilingConfig: () => {
          resetPersistedTilingConfig();
          setTilingCfgRev((n) => n + 1);
          bumpSnapChrome();
          shellSharedStateSync.requestSharedStateSync({
            exclusion: "schedule",
          });
        },
        getMenuLayerHostEl: shellContextMenus.menuLayerHostEl,
        flushImperativeChrome: imperativeChromeRenderer.flush,
      },
      registerCompositorBridgeRuntime: {
        setKeyboardLayoutLabel,
        setLockScreenState: (value) =>
          setLockScreenState(sanitizeShellLockScreenState(value)),
        setVolumeOverlay,
        setTrayVolumeState,
        setTrayReservedPx,
        setTrayIconSlotPx,
        setSniTrayItems,
        setOutputTopology,
        setCompositorSnapshotSequence,
        setCompositorInteractionState,
        setNativeDragPreview,
        setNotificationsState,
        getNativeDragPreview,
        markHasSeenCompositorWindowSync:
          sessionPersistenceRuntime.markHasSeenCompositorWindowSync,
        clearWindowSyncRecoveryPending: () => {
          windowSyncRecoveryPending = false;
        },
        scheduleExclusionZonesSync,
        scheduleCompositorFollowup:
          workspaceLayoutBridge.scheduleCompositorFollowup,
        applyModelAuthoritativeSnapshotDetails,
        clearModelAuthoritativeSnapshotDomains,
        closeAllAtlasSelects,
        hideContextMenu: shellContextMenus.hideContextMenu,
        toggleProgramsMenuMeta: shellContextMenus.toggleProgramsMenuMeta,
        applyTraySniMenuDetail: shellContextMenus.applyTraySniMenuDetail,
        handleMutationAck,
        shellWireSend,
        sendWindowIntent,
        requestCompositorSync,
        openSettingsShellWindow:
          backedShellWindowActions.openSettingsShellWindow,
        cycleFocusedWorkspaceGroup,
        beginScreenshotMode,
        toggleShellMaximizeForWindow:
          shellWindowGestureRuntime.toggleShellMaximizeForWindow,
        spawnInCompositor: (cmd) => spawnInCompositor(cmd),
        focusedWindowId,
        allWindowsMap: compositorWindowMapForGeometry,
        windows: compositorWindowMapForGeometry,
        layoutCanvasOrigin,
        screenDraftRows: liveScreenRows,
        outputGeom,
        reserveTaskbarForMon: workspaceLayoutBridge.reserveTaskbarForMon,
        workspaceSnapshot,
        occupiedSnapZonesOnMonitor:
          workspaceLayoutBridge.occupiedSnapZonesOnMonitor,
        sendSetMonitorTile: workspaceLayoutBridge.sendSetMonitorTile,
        bumpSnapChrome,
        sendSetPreTileGeometry: workspaceLayoutBridge.sendSetPreTileGeometry,
        workspacePreTileSnapshot:
          workspaceLayoutBridge.workspacePreTileSnapshot,
        sendRemoveMonitorTile: workspaceLayoutBridge.sendRemoveMonitorTile,
        sendClearPreTileGeometry:
          workspaceLayoutBridge.sendClearPreTileGeometry,
        fallbackMonitorKey: workspaceLayoutBridge.fallbackMonitorKey,
        requestWindowSyncRecovery,
        applyImperativeChromeDetails: imperativeChromeRenderer.applyDetails,
      },
      setViewportCss,
      applyShellWindowMove: shellWindowGestureRuntime.applyShellWindowMove,
      applyShellWindowResize: shellWindowGestureRuntime.applyShellWindowResize,
      endShellWindowMove: endWorkspaceAwareShellWindowMove,
      endShellWindowResize: shellWindowGestureRuntime.endShellWindowResize,
      getShellWindowDragId: shellWindowGestureRuntime.getShellWindowDragId,
      getShellWindowResizeId: shellWindowGestureRuntime.getShellWindowResizeId,
      setPointerClient,
      setPointerInMain,
      getMainRef: () => mainRef,
      onWindowBlur: ({ dragWindowId, resizeWindowId }) => {
        if (dragWindowId !== null) {
          shellMoveLog("window_blur_while_shell_drag", {
            windowId: dragWindowId,
          });
        }
        if (resizeWindowId !== null) {
          shellMoveLog("window_blur_while_shell_resize", {
            windowId: resizeWindowId,
          });
        }
        imperativeChromeRenderer.cancelSplitGroupGesture();
        if (screenshotMode()) stopScreenshotMode();
        if (portalPickerVisible()) closePortalPickerUi();
      },
      requestSharedStateSync: shellSharedStateSync.requestSharedStateSync,
      shellWireSend,
    });
    onCleanup(() => {
      disposeNotificationsApi();
      disposeAppRuntimeBootstrap();
      imperativeChromeRenderer.dispose();
    });
  });

  function copyDebugHudSnapshot() {
    const g = outputGeom();
    const payload = {
      t: Date.now(),
      shellBuild: shellBuildLabel,
      uiFps: debugHudRuntime.hudFps(),
      screens: liveScreenRows().map((r) => ({ ...r })),
      outputGeom: g ? { w: g.w, h: g.h } : null,
      windowCount: compositorWindowsForGeometry().length,
      layoutUnion: layoutUnionBbox(),
    };
    const text = JSON.stringify(payload);
    const clip = navigator.clipboard;
    if (clip && typeof clip.writeText === "function") {
      void clip.writeText(text);
    }
  }

  const shellFloatingRegistry: ShellFloatingRegistry = {
    openOverlay: createShellOverlayRegistry(floatingLayers).openOverlay,
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
    screenDraftRows: liveScreenRows,
  };

  return (
    <ShellFloatingProvider value={shellFloatingRegistry}>
      <ShellContextMenusProvider value={shellContextMenus}>
        <main
          data-shell-main
          data-shell-repaint={snapChromeRev()}
          classList={{
            "relative block box-border overflow-hidden bg-transparent font-sans text-(--shell-text) m-0 min-h-screen pb-0": true,
            "cursor-crosshair": crosshairCursor(),
          }}
          style={{
            width: `${canvasCss().w}px`,
            "min-height": `${canvasCss().h}px`,
          }}
          ref={(el) => {
            mainRef = el;
            shellSharedStateSync.requestSharedStateSync({
              exclusion: "schedule",
            });
          }}
          onPointerDown={() => debugHudRuntime.bumpRootPointerDowns()}
          onContextMenu={(e) => {
            e.preventDefault();
          }}
        >
          <div
            class="pointer-events-none fixed top-0 left-0 z-0 size-px"
            style={{
              opacity: 0.001,
              background: snapChromeRev() % 2 === 0 ? "#000" : "#fff",
            }}
          />
          <Show when={shellBridgeIssue()} keyed>
            {(msg) => (
              <div class="border border-(--shell-warning-border) bg-(--shell-warning-bg) text-(--shell-warning-text) pointer-events-none fixed top-3 left-1/2 z-470100 -translate-x-1/2 rounded-lg px-4 py-2 text-sm font-medium">
                {msg}
              </div>
            )}
          </Show>

          <ShellNotificationLayer notificationsState={notificationsState} />

          <div
            id="shell-chrome-root"
            class="pointer-events-none absolute inset-0"
            ref={(el) => {
              chromeRootRef = el;
              imperativeChromeRenderer.attach();
              imperativeChromeRenderer.schedule();
            }}
          />

          <For each={shellHostedContentWindowIds()}>
            {(windowId) => <ShellHostedContentPortal windowId={windowId} />}
          </For>

          <Show when={windowInteractionCapture()} keyed>
            {(capture) => (
              <div
                data-window-interaction-capture
                class={`fixed inset-0 z-[2000000] touch-none ${capture.cursor}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                }}
              />
            )}
          </Show>

          {volumeOverlayHud()}

          <Show when={screenshotMode()}>
            <ScreenshotOverlay />
          </Show>

          <Show when={portalPickerVisible()}>
            <PortalPickerOverlay />
          </Show>

          <LockScreenOverlay
            state={lockScreenState}
            screens={liveScreenRows}
            canvasOrigin={layoutCanvasOrigin}
            submitPassword={postUnlock}
          />

          <CustomLayoutOverlay
            state={customLayoutOverlay}
            close={closeCustomLayoutOverlay}
            saveLayouts={(outputName, layouts, selectedLayoutId) => {
              const selectedLayout = selectedLayoutId
                ? layouts.find((layout) => layout.id === selectedLayoutId)
                : null;
              setMonitorCustomLayouts(
                outputName,
                layouts,
                selectedLayout
                  ? { kind: "custom", layoutId: selectedLayout.id }
                  : null,
              );
              setTilingCfgRev((n) => n + 1);
              bumpSnapChrome();
              shellSharedStateSync.requestSharedStateSync({
                exclusion: "schedule",
              });
            }}
            getMenuLayerHostEl={shellContextMenus.menuLayerHostEl}
            getMainEl={() => mainRef}
            acquireOverlayPointer={acquireOverlayPointer}
            releaseOverlayPointer={releaseOverlayPointer}
            outputGeom={outputGeom}
            layoutCanvasOrigin={layoutCanvasOrigin}
            screenDraftRows={liveScreenRows}
            reserveTaskbarForMon={(screen) =>
              workspaceLayoutBridge.reserveTaskbarForMon(screen)
            }
            scheduleExclusionZonesSync={scheduleExclusionZonesSync}
          />

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

          <Show
            when={
              shellContextMenus.windowSwitcherOpen() &&
              shellContextMenus.menuLayerHostEl()
            }
            keyed
          >
            {(host) => (
              <DropdownMenu open={shellContextMenus.windowSwitcherOpen()}>
                <DropdownMenuPortal mount={host}>
                  <div class="pointer-events-none">
                    <WindowSwitcherContextMenu />
                  </div>
                </DropdownMenuPortal>
              </DropdownMenu>
            )}
          </Show>

          <div
            class="pointer-events-none fixed inset-0 z-50"
            aria-hidden="true"
          >
            {crosshairDebugOverlay()}
          </div>
        </main>
      </ShellContextMenusProvider>
    </ShellFloatingProvider>
  );
}

export default App;
