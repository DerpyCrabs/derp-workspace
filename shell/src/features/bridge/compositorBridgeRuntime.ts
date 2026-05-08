import { batch } from 'solid-js'
import { dispatchAudioStateChanged } from '@/features/audio/audioEvents'
import {
  beginShellLatencySample,
  DERP_SHELL_EVENT,
  DERP_SHELL_SNAPSHOT_EVENT,
  installCompositorBatchHandler,
  installCompositorSnapshotHandler,
  markShellLatencySample,
} from '@/features/bridge/compositorEvents'
import { decodeCompositorSnapshot } from '@/features/bridge/compositorSnapshot'
import {
  installShellRuntimePerfCounters,
  noteShellBatchApply,
  noteShellSnapshotApply,
  noteShellSnapshotDecode,
} from '@/features/bridge/shellPerfCounters'
import type { TraySniMenuEntry } from '@/host/createShellContextMenus'
import { coerceShellWindowId, type DerpShellDetail, type DerpWindow } from '@/host/appWindowState'
import type { LayoutScreen } from '@/host/types'
import type { TaskbarSniItem } from '@/features/taskbar/Taskbar'
import type { Rect as TileRect, SnapZone } from '@/features/tiling/tileZones'
import type { CompositorAuthoritativeDomainClears } from '@/features/bridge/compositorModel'
import type { WorkspaceSnapshot } from '@/features/workspace/workspaceSnapshot'
import {
  sanitizeNotificationsState,
  sanitizeNotificationEvent,
  type ShellNotificationsState,
} from '@/features/notifications/notificationsState'
import { dispatchShellNotificationEvent } from '@/features/notifications/shellNotifications'

type CompositorFollowup = {
  syncExclusion?: boolean
  flushWindows?: boolean
  resetScroll?: boolean
}

type CompositorInteractionState = {
  revision: number
  interaction_serial: number
  pointer_x: number
  pointer_y: number
  move_window_id: number | null
  resize_window_id: number | null
  move_proxy_window_id: number | null
  move_capture_window_id: number | null
  window_switcher_selected_window_id: number | null
  move_rect: {
    x: number
    y: number
    width: number
    height: number
    maximized: boolean
    fullscreen: boolean
  } | null
  resize_rect: {
    x: number
    y: number
    width: number
    height: number
    maximized: boolean
    fullscreen: boolean
  } | null
} | null

type NativeDragPreviewState = {
  window_id: number
  generation: number
  image_path: string
} | null

type CompositorRuntimeWireOp =
  | 'close'
  | 'invalidate_view'
  | 'set_fullscreen'
  | 'set_maximized'
  | 'set_geometry'
  | 'presentation_fullscreen'
  | 'window_intent'

export type CompositorOutputTopology = {
  revision: number
  logical: { w: number; h: number } | null
  physical: { w: number; h: number } | null
  origin: { x: number; y: number } | null
  uiScalePercent: 100 | 150 | 200
  screens: LayoutScreen[]
  shellChromePrimaryName: string | null
  taskbarAutoHide: boolean
}

function runtimeDetailSnapshotEpoch(detail: DerpShellDetail) {
  const raw = (detail as { snapshot_epoch?: unknown }).snapshot_epoch
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
  return Math.max(0, Math.trunc(raw))
}

type CompositorBridgeRuntimeOptions = {
  setKeyboardLayoutLabel: (label: string | null) => void
  setVolumeOverlay: (value: { linear: number; muted: boolean; stateKnown: boolean } | null) => void
  setTrayVolumeState: (value: { muted: boolean; volumePercent: number | null }) => void
  setTrayReservedPx: (value: number) => void
  setTrayIconSlotPx: (value: number) => void
  setSniTrayItems: (items: TaskbarSniItem[]) => void
  setOutputTopology: (
    value:
      | CompositorOutputTopology
      | null
      | ((prev: CompositorOutputTopology | null) => CompositorOutputTopology),
  ) => void
  setCompositorSnapshotSequence: (value: number) => void
  setCompositorInteractionState: (value: CompositorInteractionState) => void
  setNativeDragPreview: (value: NativeDragPreviewState) => void
  setNotificationsState: (value: ShellNotificationsState | null) => void
  getNativeDragPreview: () => NativeDragPreviewState
  markHasSeenCompositorWindowSync: () => void
  clearWindowSyncRecoveryPending: () => void
  scheduleExclusionZonesSync: () => void
  scheduleCompositorFollowup: (options?: CompositorFollowup) => void
  applyModelAuthoritativeSnapshotDetails: (details: readonly DerpShellDetail[]) => void
  clearModelAuthoritativeSnapshotDomains: (clears: CompositorAuthoritativeDomainClears) => void
  closeAllAtlasSelects: () => boolean
  hideContextMenu: () => void
  toggleProgramsMenuMeta: (outputName: string | null) => void
  applyTraySniMenuDetail: (detail: {
    request_serial: number
    notifier_id: string
    menu_path: string
    entries: TraySniMenuEntry[]
  }) => void
  handleMutationAck: (detail: Extract<DerpShellDetail, { type: 'mutation_ack' }>) => void
  shellWireSend: (
    op: CompositorRuntimeWireOp,
    arg?: number | string,
    arg2?: number | string,
    arg3?: number,
    arg4?: number,
    arg5?: number,
    arg6?: number,
  ) => boolean
  sendWindowIntent?: (action: string, windowId: number) => boolean
  requestCompositorSync: () => void
  openSettingsShellWindow: () => void
  cycleFocusedWorkspaceGroup: (delta: 1 | -1) => void
  beginScreenshotMode: () => void
  toggleShellMaximizeForWindow: (windowId: number) => void
  spawnInCompositor: (cmd: string) => Promise<void>
  focusedWindowId: () => number | null
  allWindowsMap: () => ReadonlyMap<number, DerpWindow>
  windows: () => ReadonlyMap<number, DerpWindow>
  layoutCanvasOrigin: () => { x: number; y: number } | null
  screenDraftRows: () => LayoutScreen[]
  outputGeom: () => { w: number; h: number } | null
  reserveTaskbarForMon: (mon: LayoutScreen) => boolean
  workspaceSnapshot: () => WorkspaceSnapshot
  occupiedSnapZonesOnMonitor: (mon: LayoutScreen, excludeWindowId: number) => { zone: SnapZone; bounds: TileRect }[]
  sendSetMonitorTile: (windowId: number, outputName: string, zone: SnapZone, bounds: TileRect, outputId?: string | null) => boolean
  bumpSnapChrome: () => void
  sendSetPreTileGeometry: (windowId: number, bounds: { x: number; y: number; w: number; h: number }) => boolean
  workspacePreTileSnapshot: (windowId: number) => { x: number; y: number; w: number; h: number } | null
  sendRemoveMonitorTile: (windowId: number) => boolean
  sendClearPreTileGeometry: (windowId: number) => boolean
  fallbackMonitorKey: () => string
  requestWindowSyncRecovery: () => void
}

function traySniMenuEntriesFromDetail(detail: DerpShellDetail): {
  request_serial: number
  notifier_id: string
  menu_path: string
  entries: TraySniMenuEntry[]
} {
  const raw = detail as Record<string, unknown>
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
  return { request_serial, notifier_id, menu_path, entries }
}

export function registerCompositorBridgeRuntime(options: CompositorBridgeRuntimeOptions) {
  const bridgeDebug = (patch: Record<string, unknown>) => {
    const current =
      typeof window.__DERP_BRIDGE_DEBUG === 'object' && window.__DERP_BRIDGE_DEBUG !== null
        ? window.__DERP_BRIDGE_DEBUG
        : {}
    window.__DERP_BRIDGE_DEBUG = { ...current, ...patch }
  }
  let volumeOverlayHideTimer: ReturnType<typeof setTimeout> | undefined
  let lastSnapshotSequence = 0
  let lastSnapshotDomainFlags = 0
  let lastInteractionRevision = -1
  let lastKnownInteractionState: CompositorInteractionState = null
  const removeShellRuntimePerfCounters = installShellRuntimePerfCounters()

  const snapshotDomainOutputs = 1 << 0
  const snapshotDomainWindows = 1 << 1
  const snapshotDomainFocus = 1 << 2
  const snapshotDomainKeyboard = 1 << 3
  const snapshotDomainWorkspace = 1 << 4
  const snapshotDomainShellHostedApps = 1 << 5
  const snapshotDomainInteraction = 1 << 6
  const snapshotDomainNativeDragPreview = 1 << 7
  const snapshotDomainTray = 1 << 8
  const snapshotDomainWindowOrder = 1 << 9
  const snapshotDomainCommandPalette = 1 << 13

  const compositorVisualFollowupForDetail = (detail: DerpShellDetail): CompositorFollowup & { repaint?: boolean } => {
    switch (detail.type) {
      case 'output_geometry':
        return { syncExclusion: true, flushWindows: true, repaint: true }
      case 'output_layout':
        return { syncExclusion: true, flushWindows: true, resetScroll: true, repaint: true }
      case 'focus_changed':
      case 'window_list':
      case 'window_order':
      case 'window_geometry':
      case 'window_mapped':
      case 'window_state':
      case 'window_unmapped':
      case 'workspace_state':
        return { syncExclusion: true, flushWindows: true, repaint: true }
      case 'window_metadata':
      case 'shell_hosted_app_state':
      case 'interaction_state':
      case 'native_drag_preview':
        return { flushWindows: true, repaint: true }
      default:
        return {}
    }
  }
  const scheduleCompositorVisualFollowup = (details: readonly DerpShellDetail[]) => {
    let syncExclusion = false
    let flushWindows = false
    let resetScroll = false
    let repaint = false
    for (const detail of details) {
      const followup = compositorVisualFollowupForDetail(detail)
      syncExclusion ||= followup.syncExclusion === true
      flushWindows ||= followup.flushWindows === true
      resetScroll ||= followup.resetScroll === true
      repaint ||= followup.repaint === true
    }
    if (syncExclusion || flushWindows || resetScroll) {
      options.scheduleCompositorFollowup({ syncExclusion, flushWindows, resetScroll })
    }
    if (repaint) {
      options.bumpSnapChrome()
      options.shellWireSend('invalidate_view')
    }
  }
  const detailSnapshotEpoch = (detail: DerpShellDetail) => {
    return runtimeDetailSnapshotEpoch(detail)
  }

  const markCompositorStateEpoch = (epoch: number) => {
    if (epoch <= 0) return
    const w = window as Window & { __DERP_LAST_COMPOSITOR_STATE_EPOCH?: number }
    w.__DERP_LAST_COMPOSITOR_STATE_EPOCH = Math.max(
      typeof w.__DERP_LAST_COMPOSITOR_STATE_EPOCH === 'number' ? w.__DERP_LAST_COMPOSITOR_STATE_EPOCH : 0,
      epoch,
    )
  }

  const outputUiScalePercent = (logicalWidth: number, physicalWidth: number): 100 | 150 | 200 => {
    const lw = Math.max(1, logicalWidth)
    const pw = Math.max(1, physicalWidth)
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
    return best
  }

  const applyKeyboardLayoutDetail = (d: Extract<DerpShellDetail, { type: 'keyboard_layout' }>) => {
    const label = typeof d.label === 'string' ? d.label.trim() : ''
    options.setKeyboardLayoutLabel(label.length > 0 ? label : null)
  }

  const applyVolumeOverlayDetail = (d: Extract<DerpShellDetail, { type: 'volume_overlay' }>) => {
    if (volumeOverlayHideTimer !== undefined) clearTimeout(volumeOverlayHideTimer)
    const linRaw = d.volume_linear_percent_x100
    const lin = typeof linRaw === 'number' && Number.isFinite(linRaw) ? Math.max(0, linRaw) : 0
    options.setVolumeOverlay({
      linear: lin,
      muted: !!d.muted,
      stateKnown: d.state_known !== false,
    })
    options.setTrayVolumeState({
      muted: !!d.muted,
      volumePercent: d.state_known === false ? null : Math.min(100, Math.round(lin / 100)),
    })
    volumeOverlayHideTimer = setTimeout(() => {
      options.setVolumeOverlay(null)
      volumeOverlayHideTimer = undefined
    }, 2200)
    dispatchAudioStateChanged({ reason: 'volume_overlay' })
  }

  const applyTrayHintsDetail = (d: Extract<DerpShellDetail, { type: 'tray_hints' }>) => {
    const rw = typeof d.reserved_w === 'number' && Number.isFinite(d.reserved_w) ? Math.max(0, d.reserved_w) : 0
    options.setTrayReservedPx(rw)
    const sw =
      typeof d.slot_w === 'number' && Number.isFinite(d.slot_w)
        ? Math.max(24, Math.min(64, Math.round(d.slot_w)))
        : 40
    options.setTrayIconSlotPx(sw)
    queueMicrotask(() => options.scheduleExclusionZonesSync())
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
    options.setSniTrayItems(next)
    queueMicrotask(() => options.scheduleExclusionZonesSync())
  }

  const applyOutputGeometryDetail = (d: Extract<DerpShellDetail, { type: 'output_geometry' }>) => {
    options.setOutputTopology((prev) => ({
      revision: prev?.revision ?? 0,
      logical: { w: d.logical_width, h: d.logical_height },
      physical: prev?.physical ?? null,
      origin: prev?.origin ?? null,
      uiScalePercent:
        prev?.uiScalePercent ??
        outputUiScalePercent(d.logical_width, prev?.physical?.w ?? d.logical_width),
      screens: prev?.screens ?? [],
      shellChromePrimaryName: prev?.shellChromePrimaryName ?? null,
      taskbarAutoHide: prev?.taskbarAutoHide ?? false,
    }))
    options.scheduleCompositorFollowup({ syncExclusion: true, flushWindows: true })
  }

  const applyOutputLayoutDetail = (d: Extract<DerpShellDetail, { type: 'output_layout' }>) => {
    const screens = d.screens.map((s) => ({
      name: s.name,
      identity: s.identity,
      x: s.x,
      y: s.y,
      width: s.width,
      height: s.height,
      usable_x:
        typeof s.usable_x === 'number' && Number.isFinite(s.usable_x) ? Math.round(s.usable_x) : Math.round(s.x),
      usable_y:
        typeof s.usable_y === 'number' && Number.isFinite(s.usable_y) ? Math.round(s.usable_y) : Math.round(s.y),
      usable_width:
        typeof s.usable_width === 'number' && Number.isFinite(s.usable_width)
          ? Math.max(1, Math.round(s.usable_width))
          : Math.max(1, Math.round(s.width)),
      usable_height:
        typeof s.usable_height === 'number' && Number.isFinite(s.usable_height)
          ? Math.max(1, Math.round(s.usable_height))
          : Math.max(1, Math.round(s.height)),
      physical_width:
        typeof s.physical_width === 'number' && Number.isFinite(s.physical_width)
          ? Math.max(1, Math.round(s.physical_width))
          : Math.max(1, Math.round(s.width)),
      physical_height:
        typeof s.physical_height === 'number' && Number.isFinite(s.physical_height)
          ? Math.max(1, Math.round(s.physical_height))
          : Math.max(1, Math.round(s.height)),
      transform: s.transform,
      refresh_milli_hz: typeof s.refresh_milli_hz === 'number' ? s.refresh_milli_hz : 0,
      vrr_supported: s.vrr_supported === true,
      vrr_enabled: s.vrr_supported === true && s.vrr_enabled === true,
      taskbar_side:
        s.taskbar_side === 'top' || s.taskbar_side === 'left' || s.taskbar_side === 'right'
          ? s.taskbar_side
          : ('bottom' as const),
    }))
    const pr =
      typeof d.shell_chrome_primary === 'string' && d.shell_chrome_primary.length > 0
        ? d.shell_chrome_primary
        : null
    options.setOutputTopology({
      revision: typeof d.revision === 'number' && Number.isFinite(d.revision) ? Math.trunc(d.revision) : 0,
      logical: { w: d.canvas_logical_width, h: d.canvas_logical_height },
      physical: {
        w: d.canvas_physical_width,
        h: d.canvas_physical_height,
      },
      origin:
        typeof d.canvas_logical_origin_x === 'number' && typeof d.canvas_logical_origin_y === 'number'
          ? { x: d.canvas_logical_origin_x, y: d.canvas_logical_origin_y }
          : null,
      uiScalePercent: outputUiScalePercent(d.canvas_logical_width, d.canvas_physical_width),
      screens,
      shellChromePrimaryName: pr,
      taskbarAutoHide: d.taskbar_auto_hide === true,
    })
    ;(window as Window & { __DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION?: number }).__DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION =
      typeof d.revision === 'number' && Number.isFinite(d.revision) ? Math.trunc(d.revision) : 0
    options.scheduleCompositorFollowup({
      syncExclusion: true,
      flushWindows: true,
      resetScroll: true,
    })
  }

  const applyInteractionStateDetail = (d: Extract<DerpShellDetail, { type: 'interaction_state' }>) => {
    const revision = typeof d.revision === 'number' && Number.isFinite(d.revision) ? Math.trunc(d.revision) : 0
    if (revision < lastInteractionRevision) return
    lastInteractionRevision = revision
    const interactionSerial =
      typeof d.interaction_serial === 'number' && Number.isFinite(d.interaction_serial)
        ? Math.max(0, Math.trunc(d.interaction_serial))
        : 0
    const moveWindowId = coerceShellWindowId(d.move_window_id)
    const nextInteractionState = {
      revision,
      interaction_serial: interactionSerial,
      pointer_x: d.pointer_x,
      pointer_y: d.pointer_y,
      move_window_id: moveWindowId,
      resize_window_id: coerceShellWindowId(d.resize_window_id),
      move_proxy_window_id: coerceShellWindowId(d.move_proxy_window_id),
      move_capture_window_id: coerceShellWindowId(d.move_capture_window_id),
      window_switcher_selected_window_id: coerceShellWindowId(d.window_switcher_selected_window_id),
      move_rect: d.move_rect,
      resize_rect: d.resize_rect,
    } satisfies NonNullable<CompositorInteractionState>
    const previousActiveWindowId =
      lastKnownInteractionState?.move_window_id ?? lastKnownInteractionState?.resize_window_id ?? null
    const nextActiveWindowId = nextInteractionState.move_window_id ?? nextInteractionState.resize_window_id ?? null
    options.setCompositorInteractionState(nextInteractionState)
    lastKnownInteractionState = nextInteractionState
    if (previousActiveWindowId !== null || nextActiveWindowId !== null) {
    }
  }

  const applyNativeDragPreviewDetail = (d: Extract<DerpShellDetail, { type: 'native_drag_preview' }>) => {
    const window_id = coerceShellWindowId(d.window_id) ?? d.window_id
    const generation = Math.max(1, Math.trunc(d.generation))
    if (d.image_path.length === 0) {
      const current = options.getNativeDragPreview()
      if (
        current &&
        (current.window_id !== window_id || current.generation !== generation)
      ) {
        return
      }
      options.setNativeDragPreview(null)
      return
    }
    const next = {
      window_id,
      generation,
      image_path: d.image_path,
    }
    const current = options.getNativeDragPreview()
    if (
      current?.window_id === next.window_id &&
      current.generation === next.generation &&
      current.image_path === next.image_path
    ) {
      return
    }
    options.setNativeDragPreview(next)
  }

  const applyNotificationsStateDetail = (d: Extract<DerpShellDetail, { type: 'notifications_state' }>) => {
    options.setNotificationsState(sanitizeNotificationsState(d.state))
  }

  const applyNotificationEventDetail = (d: Extract<DerpShellDetail, { type: 'notification_event' }>) => {
    const event = sanitizeNotificationEvent(d)
    if (!event) return
    dispatchShellNotificationEvent(event)
  }

  const applySnapshotVisualDetail = (d: DerpShellDetail, skipOutputGeometry: boolean) => {
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
    if (d.type === 'interaction_state') {
      applyInteractionStateDetail(d)
      return true
    }
    if (d.type === 'native_drag_preview') {
      applyNativeDragPreviewDetail(d)
      return true
    }
    if (d.type === 'notifications_state') {
      applyNotificationsStateDetail(d)
      return true
    }
    return false
  }

  const applyCompositorSnapshot = (details: readonly DerpShellDetail[], domainFlags: number) => {
    const skipOutputGeometry = details.some((detail) => detail.type === 'output_layout')
    let sawWindowList = false
    let sawWindowOrder = false
    let sawFocus = false
    let sawOutput = false
    let sawKeyboard = false
    let sawWorkspace = false
    let sawShellHostedApps = false
    let sawCommandPalette = false
    let sawInteractionState = false
    let sawNativeDragPreview = false
    let sawTray = false
    batch(() => {
      if (details.length > 0) options.applyModelAuthoritativeSnapshotDetails(details)
      for (const detail of details) {
        if (detail.type === 'window_list') {
          sawWindowList = true
          continue
        }
        if (detail.type === 'window_order') sawWindowOrder = true
        if (detail.type === 'focus_changed') sawFocus = true
        if (detail.type === 'output_geometry' || detail.type === 'output_layout') sawOutput = true
        if (detail.type === 'keyboard_layout') sawKeyboard = true
        if (detail.type === 'workspace_state') sawWorkspace = true
        if (detail.type === 'shell_hosted_app_state') sawShellHostedApps = true
        if (detail.type === 'command_palette_state') sawCommandPalette = true
        if (detail.type === 'interaction_state') {
          sawInteractionState = true
        }
        if (detail.type === 'native_drag_preview') sawNativeDragPreview = true
        if (detail.type === 'tray_hints' || detail.type === 'tray_sni') sawTray = true
        applySnapshotVisualDetail(detail, skipOutputGeometry)
      }
      const clears: CompositorAuthoritativeDomainClears = {}
      if ((domainFlags & snapshotDomainWindows) !== 0 && !sawWindowList) clears.windows = true
      if ((domainFlags & snapshotDomainWindowOrder) !== 0 && !sawWindowOrder) clears.windowOrder = true
      if ((domainFlags & snapshotDomainFocus) !== 0 && !sawFocus) clears.focus = true
      if ((domainFlags & snapshotDomainWorkspace) !== 0 && !sawWorkspace) clears.workspace = true
      if ((domainFlags & snapshotDomainShellHostedApps) !== 0 && !sawShellHostedApps) clears.shellHostedApps = true
      if ((domainFlags & snapshotDomainCommandPalette) !== 0 && !sawCommandPalette) clears.commandPalette = true
      if (Object.keys(clears).length > 0) options.clearModelAuthoritativeSnapshotDomains(clears)
      if ((domainFlags & snapshotDomainOutputs) !== 0 && !sawOutput) {
        options.setOutputTopology(null)
        ;(window as Window & { __DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION?: number }).__DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION = 0
      }
      if ((domainFlags & snapshotDomainKeyboard) !== 0 && !sawKeyboard) {
        options.setKeyboardLayoutLabel(null)
      }
      if ((domainFlags & snapshotDomainTray) !== 0 && !sawTray) {
        options.setTrayReservedPx(0)
        options.setTrayIconSlotPx(36)
        options.setSniTrayItems([])
      }
      if ((domainFlags & snapshotDomainInteraction) !== 0 && !sawInteractionState) {
        lastKnownInteractionState = null
        options.setCompositorInteractionState(null)
      }
      if ((domainFlags & snapshotDomainNativeDragPreview) !== 0 && !sawNativeDragPreview) {
        options.setNativeDragPreview(null)
      }
      if (sawWindowList) options.markHasSeenCompositorWindowSync()
    })
    if (sawWindowList) options.clearWindowSyncRecoveryPending()
    const clearedChromeAffectingDomain =
      ((domainFlags & snapshotDomainWindows) !== 0 && !sawWindowList) ||
      ((domainFlags & snapshotDomainWindowOrder) !== 0 && !sawWindowOrder) ||
      ((domainFlags & snapshotDomainFocus) !== 0 && !sawFocus) ||
      ((domainFlags & snapshotDomainWorkspace) !== 0 && !sawWorkspace) ||
      ((domainFlags & snapshotDomainOutputs) !== 0 && !sawOutput)
    const clearedWindowContentDomain =
      ((domainFlags & snapshotDomainShellHostedApps) !== 0 && !sawShellHostedApps) ||
      ((domainFlags & snapshotDomainInteraction) !== 0 && !sawInteractionState) ||
      ((domainFlags & snapshotDomainNativeDragPreview) !== 0 && !sawNativeDragPreview)
    if (clearedChromeAffectingDomain || clearedWindowContentDomain) {
      options.scheduleCompositorFollowup({
        syncExclusion: clearedChromeAffectingDomain,
        flushWindows: true,
        resetScroll: (domainFlags & snapshotDomainOutputs) !== 0 && !sawOutput,
      })
      options.bumpSnapChrome()
      options.shellWireSend('invalidate_view')
    }
    scheduleCompositorVisualFollowup(details)
  }

  const keybindTargetWindowId = (d: Extract<DerpShellDetail, { type: 'keybind' }>, focusedWindowId: number | null) =>
    coerceShellWindowId(d.target_window_id) ?? focusedWindowId

  const sendWindowIntent = (action: string, windowId: number) =>
    options.sendWindowIntent?.(action, windowId) ??
    options.shellWireSend('window_intent', JSON.stringify({ action, windowId }))

  const applyKeybindDetail = (d: Extract<DerpShellDetail, { type: 'keybind' }>) => {
    const action = typeof d.action === 'string' ? d.action : ''
    const fid = options.focusedWindowId()
    if (action === 'launch_terminal') {
      void options.spawnInCompositor('foot')
      return
    }
    if (action === 'close_focused') {
      if (fid !== null) options.shellWireSend('close', fid)
      return
    }
    if (action === 'toggle_programs_menu') {
      options.toggleProgramsMenuMeta(typeof d.output_name === 'string' ? d.output_name : null)
      return
    }
    if (action === 'open_settings') {
      options.openSettingsShellWindow()
      return
    }
    if (action === 'tab_next') {
      options.cycleFocusedWorkspaceGroup(1)
      return
    }
    if (action === 'tab_previous') {
      options.cycleFocusedWorkspaceGroup(-1)
      return
    }
    if (action === 'screenshot_region') {
      options.beginScreenshotMode()
      return
    }
    if (action === 'toggle_fullscreen') {
      const tidFs = keybindTargetWindowId(d, fid)
      if (tidFs === null) return
      sendWindowIntent(action, tidFs)
      return
    }
    if (action === 'toggle_maximize') {
      const tid = keybindTargetWindowId(d, fid)
      if (tid === null) return
      sendWindowIntent(action, tid)
      return
    }
    if (action === 'move_monitor_left' || action === 'move_monitor_right') {
      const tid = keybindTargetWindowId(d, fid)
      if (tid === null) return
      sendWindowIntent(action, tid)
      return
    }
    if (action === 'tile_left' || action === 'tile_right') {
      const tid = keybindTargetWindowId(d, fid)
      if (tid === null) return
      sendWindowIntent(action, tid)
      return
    }
    if (action === 'tile_up') {
      const tidUp = keybindTargetWindowId(d, fid)
      if (tidUp === null) return
      sendWindowIntent(action, tidUp)
      return
    }
    if (action === 'tile_down') {
      const tidDown = keybindTargetWindowId(d, fid)
      if (tidDown === null) return
      sendWindowIntent(action, tidDown)
    }
  }

  const detailIsSnapshotState = (d: DerpShellDetail) =>
    d.type === 'focus_changed' ||
    d.type === 'window_list' ||
    d.type === 'window_order' ||
    d.type === 'workspace_state' ||
    d.type === 'shell_hosted_app_state' ||
    d.type === 'command_palette_state' ||
    d.type === 'window_state' ||
    d.type === 'window_unmapped' ||
    d.type === 'window_geometry' ||
    d.type === 'window_mapped' ||
    d.type === 'window_metadata' ||
    d.type === 'output_geometry' ||
    d.type === 'output_layout' ||
    d.type === 'keyboard_layout' ||
    d.type === 'tray_hints' ||
    d.type === 'tray_sni' ||
    d.type === 'interaction_state' ||
    d.type === 'native_drag_preview'

  const applyCompositorDetail = (d: DerpShellDetail) => {
    if (d.type === 'context_menu_dismiss') {
      options.closeAllAtlasSelects()
      options.hideContextMenu()
      return
    }
    if (d.type === 'programs_menu_toggle') {
      options.toggleProgramsMenuMeta(typeof d.output_name === 'string' ? d.output_name : null)
      return
    }
    if (d.type === 'volume_overlay') {
      applyVolumeOverlayDetail(d)
      return
    }
    if (d.type === 'tray_sni_menu') {
      options.applyTraySniMenuDetail(traySniMenuEntriesFromDetail(d))
      return
    }
    if (d.type === 'mutation_ack') {
      options.handleMutationAck(d)
      return
    }
    if (d.type === 'keybind') {
      applyKeybindDetail(d)
      return
    }
    if (d.type === 'notifications_state') {
      applyNotificationsStateDetail(d)
      return
    }
    if (d.type === 'notification_event') {
      applyNotificationEventDetail(d)
      return
    }
    if (detailIsSnapshotState(d)) {
      const synced = syncCompositorSnapshot()
      if (!synced) scheduleCompositorVisualFollowup([d])
      bridgeDebug({
        last_drop: {
          reason: synced ? 'snapshot_state_event_replaced_by_snapshot' : 'snapshot_state_event_waiting_for_snapshot',
          type: d.type,
          snapshot_epoch: detailSnapshotEpoch(d),
          sequence: lastSnapshotSequence,
        },
      })
      return
    }
  }

  const applyCompositorBatch = (details: readonly DerpShellDetail[]) => {
    if (details.length === 0) return
    const applyStart = performance.now()
    batch(() => {
      const hasSnapshotState = details.some(detailIsSnapshotState)
      if (hasSnapshotState) {
        const synced = syncCompositorSnapshot()
        if (!synced) scheduleCompositorVisualFollowup(details.filter(detailIsSnapshotState))
        bridgeDebug({
          last_drop: {
            reason: synced ? 'snapshot_state_batch_replaced_by_snapshot' : 'snapshot_state_batch_waiting_for_snapshot',
            type: 'batch',
            snapshot_epoch: Math.max(0, ...details.map(detailSnapshotEpoch)),
            sequence: lastSnapshotSequence,
          },
        })
      }
      for (const detail of details) {
        if (!detailIsSnapshotState(detail)) applyCompositorDetail(detail)
      }
    })
    noteShellBatchApply(performance.now() - applyStart, details.length)
  }

  const syncCompositorSnapshot = (force = false) => {
    const path = window.__DERP_COMPOSITOR_SNAPSHOT_PATH
    if (typeof path !== 'string' || path.length === 0) return false
    const readSnapshot = window.__derpCompositorSnapshotRead
    if (typeof readSnapshot !== 'function') return false
    const readSnapshotIfChanged = window.__derpCompositorSnapshotReadIfChanged
    let raw: ArrayBuffer | null = null
    if (!force && typeof readSnapshotIfChanged === 'function') {
      raw = readSnapshotIfChanged(path, lastSnapshotSequence)
    } else if (!force) {
      const snapshotVersion = window.__derpCompositorSnapshotVersion
      if (typeof snapshotVersion === 'function') {
        const version = snapshotVersion(path)
        if (typeof version === 'number' && Number.isFinite(version) && version === lastSnapshotSequence) {
          return false
        }
      }
      raw = readSnapshot(path)
    } else {
      raw = readSnapshot(path)
    }
    if (!(raw instanceof ArrayBuffer)) return false
    const decodeStart = performance.now()
    const decoded = decodeCompositorSnapshot(raw)
    noteShellSnapshotDecode(performance.now() - decodeStart, raw.byteLength)
    if (!decoded) return false
    const snapshotDetails = decoded.details
    lastSnapshotDomainFlags = decoded.domainFlags
    bridgeDebug({
      last_snapshot_sequence: decoded.sequence,
      last_snapshot_domain_flags: lastSnapshotDomainFlags,
      last_snapshot_incremental: false,
      last_snapshot_details: snapshotDetails.map((detail) =>
        detail.type === 'window_geometry'
          ? {
              type: detail.type,
              window_id: detail.window_id,
              x: detail.x,
              y: detail.y,
              width: detail.width,
              height: detail.height,
            }
          : { type: detail.type },
      ),
    })
    const shouldTrace =
      snapshotDetails.some((detail) => detail.type.startsWith('window_')) ||
      snapshotDetails.some((detail) => detail.type === 'focus_changed' || detail.type === 'workspace_state')
    const shellLatencySampleId = shouldTrace
      ? beginShellLatencySample(decoded.sequence, snapshotDetails.length, force)
      : 0
    if (shellLatencySampleId !== 0) {
      markShellLatencySample(shellLatencySampleId, { decodedAt: performance.now() })
    }
    lastSnapshotSequence = decoded.sequence
    markCompositorStateEpoch(decoded.sequence)
    options.setCompositorSnapshotSequence(decoded.sequence)
    ;(window as Window & { __DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE?: number }).__DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE =
      decoded.sequence
    ;(window as Window & { __DERP_LAST_COMPOSITOR_SNAPSHOT_DOMAIN_FLAGS?: number }).__DERP_LAST_COMPOSITOR_SNAPSHOT_DOMAIN_FLAGS =
      lastSnapshotDomainFlags
    const applyStart = performance.now()
    applyCompositorSnapshot(snapshotDetails, lastSnapshotDomainFlags)
    noteShellSnapshotApply(performance.now() - applyStart, snapshotDetails.length)
    if (shellLatencySampleId !== 0) {
      markShellLatencySample(shellLatencySampleId, { appliedAt: performance.now() })
    }
    return { domainFlags: lastSnapshotDomainFlags, detailsLength: snapshotDetails.length }
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
  const removeCompositorSnapshotHandler = installCompositorSnapshotHandler(() => {
    syncCompositorSnapshot()
  })

  window.addEventListener(DERP_SHELL_EVENT, onDerpShell as EventListener)
  window.addEventListener(DERP_SHELL_SNAPSHOT_EVENT, onCompositorSnapshot as EventListener)

  queueMicrotask(() => {
    syncCompositorSnapshot(true)
  })

  return () => {
    if (volumeOverlayHideTimer !== undefined) clearTimeout(volumeOverlayHideTimer)
    removeCompositorBatchHandler()
    removeCompositorSnapshotHandler()
    removeShellRuntimePerfCounters()
    window.removeEventListener(DERP_SHELL_EVENT, onDerpShell as EventListener)
    window.removeEventListener(DERP_SHELL_SNAPSHOT_EVENT, onCompositorSnapshot as EventListener)
  }
}
