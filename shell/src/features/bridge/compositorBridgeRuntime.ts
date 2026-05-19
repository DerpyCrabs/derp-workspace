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
  noteShellBatchCoalesce,
  noteShellImperativeChromeDetailApply,
  noteShellInteractionApply,
  noteShellModelUpdate,
  noteShellSnapshotRead,
  noteShellSnapshotApply,
  noteShellSnapshotDecode,
  noteShellStateToChromeApply,
  noteShellVisualFollowup,
  noteShellWindowApply,
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
  super_held: boolean
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

function sameInteractionVisual(
  left: NonNullable<CompositorInteractionState>['move_rect'],
  right: NonNullable<CompositorInteractionState>['move_rect'],
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.maximized === right.maximized &&
    left.fullscreen === right.fullscreen
  )
}

function sameInteractionState(left: CompositorInteractionState, right: CompositorInteractionState): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.revision === right.revision &&
    left.interaction_serial === right.interaction_serial &&
    left.pointer_x === right.pointer_x &&
    left.pointer_y === right.pointer_y &&
    left.move_window_id === right.move_window_id &&
    left.resize_window_id === right.resize_window_id &&
    left.move_proxy_window_id === right.move_proxy_window_id &&
    left.move_capture_window_id === right.move_capture_window_id &&
    left.super_held === right.super_held &&
    left.window_switcher_selected_window_id === right.window_switcher_selected_window_id &&
    sameInteractionVisual(left.move_rect, right.move_rect) &&
    sameInteractionVisual(left.resize_rect, right.resize_rect)
  )
}

function sameTaskbarSniItems(left: readonly TaskbarSniItem[], right: readonly TaskbarSniItem[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index]!
    const r = right[index]!
    if (l.id !== r.id || l.title !== r.title || l.icon_base64 !== r.icon_base64) return false
  }
  return true
}

function sameScreenList(left: readonly LayoutScreen[], right: readonly LayoutScreen[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index]!
    const r = right[index]!
    if (
      l.name !== r.name ||
      l.identity !== r.identity ||
      l.x !== r.x ||
      l.y !== r.y ||
      l.width !== r.width ||
      l.height !== r.height ||
      l.usable_x !== r.usable_x ||
      l.usable_y !== r.usable_y ||
      l.usable_width !== r.usable_width ||
      l.usable_height !== r.usable_height ||
      l.physical_width !== r.physical_width ||
      l.physical_height !== r.physical_height ||
      l.transform !== r.transform ||
      l.refresh_milli_hz !== r.refresh_milli_hz ||
      l.vrr_supported !== r.vrr_supported ||
      l.vrr_enabled !== r.vrr_enabled ||
      l.taskbar_side !== r.taskbar_side ||
      l.taskbar_programs !== r.taskbar_programs ||
      l.taskbar_osk !== r.taskbar_osk ||
      l.taskbar_keyboard_layout !== r.taskbar_keyboard_layout ||
      l.taskbar_clock !== r.taskbar_clock
    ) {
      return false
    }
  }
  return true
}

function sameOutputTopology(left: CompositorOutputTopology | null, right: CompositorOutputTopology | null): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.revision === right.revision &&
    left.logical?.w === right.logical?.w &&
    left.logical?.h === right.logical?.h &&
    left.physical?.w === right.physical?.w &&
    left.physical?.h === right.physical?.h &&
    left.origin?.x === right.origin?.x &&
    left.origin?.y === right.origin?.y &&
    left.uiScalePercent === right.uiScalePercent &&
    left.shellChromePrimaryName === right.shellChromePrimaryName &&
    left.taskbarAutoHide === right.taskbarAutoHide &&
    sameScreenList(left.screens, right.screens)
  )
}

function coalescedDetailKey(detail: DerpShellDetail): string | null {
  switch (detail.type) {
    case 'interaction_state':
      return 'interaction_state'
    case 'window_geometry':
      return `window_geometry:${detail.window_id}`
    case 'window_order':
      return 'window_order'
    case 'focus_changed':
      return 'focus_changed'
    case 'workspace_state':
      return 'workspace_state'
    case 'window_list':
      return 'window_list'
    case 'shell_hosted_app_state':
      return 'shell_hosted_app_state'
    case 'command_palette_state':
      return 'command_palette_state'
    case 'lock_state':
      return 'lock_state'
    case 'output_geometry':
      return 'output_geometry'
    case 'output_layout':
      return 'output_layout'
    case 'keyboard_layout':
      return 'keyboard_layout'
    case 'tray_hints':
      return 'tray_hints'
    case 'tray_sni':
      return 'tray_sni'
    case 'native_drag_preview':
      return `native_drag_preview:${detail.window_id}`
    case 'window_state':
      return `window_state:${detail.window_id}`
    case 'window_metadata':
      return `window_metadata:${detail.window_id}`
    default:
      return null
  }
}

function coalesceCompositorDetails(details: readonly DerpShellDetail[]): readonly DerpShellDetail[] {
  if (details.length < 2) return details
  const lastByKey = new Map<string, number>()
  for (let index = 0; index < details.length; index += 1) {
    const key = coalescedDetailKey(details[index]!)
    if (key !== null) lastByKey.set(key, index)
  }
  if (lastByKey.size === 0) return details
  const out: DerpShellDetail[] = []
  let dropped = 0
  for (let index = 0; index < details.length; index += 1) {
    const detail = details[index]!
    const key = coalescedDetailKey(detail)
    if (key !== null && lastByKey.get(key) !== index) {
      dropped += 1
      continue
    }
    out.push(detail)
  }
  if (dropped > 0) noteShellBatchCoalesce(dropped)
  return out.length === details.length ? details : out
}

type CompositorBridgeRuntimeOptions = {
  setKeyboardLayoutLabel: (label: string | null) => void
  setLockScreenState?: (value: unknown) => void
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
  applyImperativeChromeDetails?: (details: readonly DerpShellDetail[]) => void
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
  let lastKeyboardLayoutLabel: string | null = null
  let lastVolumeOverlay: { linear: number; muted: boolean; stateKnown: boolean } | null = null
  let lastTrayVolumeState: { muted: boolean; volumePercent: number | null } = { muted: false, volumePercent: null }
  let lastTrayReservedPx = -1
  let lastTrayIconSlotPx = -1
  let lastSniTrayItems: TaskbarSniItem[] = []
  let lastOutputTopology: CompositorOutputTopology | null = null
  let lastCompositorSnapshotSequenceSignal = -1

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
  const snapshotDomainWindowGeometry = 1 << 10
  const snapshotDomainWindowMetadata = 1 << 11
  const snapshotDomainWindowState = 1 << 12
  const snapshotDomainCommandPalette = 1 << 13
  const snapshotRecoveryDomainIndexes = [1, 2, 4, 9]
  let lastSnapshotDomainRevisions: readonly number[] | null = null

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
    const start = performance.now()
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
    noteShellVisualFollowup(performance.now() - start)
  }
  const applyImperativeChromeDetails = (details: readonly DerpShellDetail[], stateStartedAt = performance.now()) => {
    const start = performance.now()
    options.applyImperativeChromeDetails?.(details)
    noteShellImperativeChromeDetailApply(performance.now() - start, details.length)
    if (details.length > 0) noteShellStateToChromeApply(stateStartedAt, details)
  }
  const detailSnapshotEpoch = (detail: DerpShellDetail) => {
    return runtimeDetailSnapshotEpoch(detail)
  }
  const detailNeedsWindowSyncRecovery = (detail: DerpShellDetail) => {
    switch (detail.type) {
      case 'focus_changed':
      case 'window_list':
      case 'window_order':
      case 'window_geometry':
      case 'window_mapped':
      case 'window_state':
      case 'window_unmapped':
      case 'window_metadata':
      case 'output_geometry':
      case 'output_layout':
      case 'shell_hosted_app_state':
      case 'workspace_state':
        return true
      default:
        return false
    }
  }
  const epochlessDetailNeedsWindowSyncRecovery = (detail: DerpShellDetail) => {
    switch (detail.type) {
      case 'focus_changed':
      case 'window_list':
      case 'window_order':
      case 'window_mapped':
      case 'window_unmapped':
      case 'output_geometry':
      case 'output_layout':
      case 'shell_hosted_app_state':
        return true
      default:
        return false
    }
  }
  const snapshotDomainForDetail = (detail: DerpShellDetail) => {
    switch (detail.type) {
      case 'output_geometry':
      case 'output_layout':
        return snapshotDomainOutputs
      case 'window_list':
      case 'window_mapped':
      case 'window_unmapped':
        return snapshotDomainWindows
      case 'focus_changed':
        return snapshotDomainFocus
      case 'keyboard_layout':
        return snapshotDomainKeyboard
      case 'workspace_state':
        return snapshotDomainWorkspace
      case 'shell_hosted_app_state':
        return snapshotDomainShellHostedApps
      case 'interaction_state':
        return snapshotDomainInteraction
      case 'native_drag_preview':
        return snapshotDomainNativeDragPreview
      case 'tray_hints':
      case 'tray_sni':
        return snapshotDomainTray
      case 'window_order':
        return snapshotDomainWindowOrder
      case 'window_geometry':
        return snapshotDomainWindowGeometry
      case 'window_metadata':
        return snapshotDomainWindowMetadata
      case 'window_state':
        return snapshotDomainWindowState
      case 'command_palette_state':
        return snapshotDomainCommandPalette
      default:
        return 0
    }
  }
  const snapshotDetailCoveredByDomainFlags = (detail: DerpShellDetail, domainFlags: number) => {
    const domain = snapshotDomainForDetail(detail)
    return domain !== 0 && (domainFlags & domain) !== 0
  }
  const snapshotDetailCanApplyWhenSyncedSnapshotOmitsDomain = (detail: DerpShellDetail) =>
    detail.type === 'focus_changed' ||
    detail.type === 'window_order' ||
    detail.type === 'workspace_state'
  const shouldRequestWindowSyncRecovery = (details: readonly DerpShellDetail[]) => {
    for (const detail of details) {
      const epoch = detailSnapshotEpoch(detail)
      if (epoch > lastSnapshotSequence) return true
      if (epoch === 0 && epochlessDetailNeedsWindowSyncRecovery(detail)) return true
      if (epoch === 0) continue
      const domain = snapshotDomainForDetail(detail)
      if (
        detail.type === 'interaction_state' &&
        epoch < lastSnapshotSequence &&
        domain !== 0 &&
        (lastSnapshotDomainFlags & domain) === 0 &&
        (lastKnownInteractionState?.window_switcher_selected_window_id != null ||
          detail.window_switcher_selected_window_id != null)
      ) {
        return true
      }
      if (
        epoch < lastSnapshotSequence &&
        domain !== 0 &&
        (lastSnapshotDomainFlags & domain) === 0 &&
        detailNeedsWindowSyncRecovery(detail)
      ) {
        return true
      }
    }
    return false
  }
  const canApplyEpochlessSnapshotDetailDirectly = (detail: DerpShellDetail) =>
    detailIsSnapshotState(detail) &&
    detailSnapshotEpoch(detail) === 0 &&
    !epochlessDetailNeedsWindowSyncRecovery(detail)

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
    const next = label.length > 0 ? label : null
    if (lastKeyboardLayoutLabel === next) return
    lastKeyboardLayoutLabel = next
    options.setKeyboardLayoutLabel(next)
  }

  const applyVolumeOverlayDetail = (d: Extract<DerpShellDetail, { type: 'volume_overlay' }>) => {
    if (volumeOverlayHideTimer !== undefined) clearTimeout(volumeOverlayHideTimer)
    const linRaw = d.volume_linear_percent_x100
    const lin = typeof linRaw === 'number' && Number.isFinite(linRaw) ? Math.max(0, linRaw) : 0
    const nextOverlay = {
      linear: lin,
      muted: !!d.muted,
      stateKnown: d.state_known !== false,
    }
    if (
      !lastVolumeOverlay ||
      lastVolumeOverlay.linear !== nextOverlay.linear ||
      lastVolumeOverlay.muted !== nextOverlay.muted ||
      lastVolumeOverlay.stateKnown !== nextOverlay.stateKnown
    ) {
      lastVolumeOverlay = nextOverlay
      options.setVolumeOverlay(nextOverlay)
    }
    const nextTrayVolume = {
      muted: !!d.muted,
      volumePercent: d.state_known === false ? null : Math.min(100, Math.round(lin / 100)),
    }
    if (
      lastTrayVolumeState.muted !== nextTrayVolume.muted ||
      lastTrayVolumeState.volumePercent !== nextTrayVolume.volumePercent
    ) {
      lastTrayVolumeState = nextTrayVolume
      options.setTrayVolumeState(nextTrayVolume)
    }
    volumeOverlayHideTimer = setTimeout(() => {
      lastVolumeOverlay = null
      options.setVolumeOverlay(null)
      volumeOverlayHideTimer = undefined
    }, 2200)
    dispatchAudioStateChanged({ reason: 'volume_overlay' })
  }

  const applyTrayHintsDetail = (d: Extract<DerpShellDetail, { type: 'tray_hints' }>) => {
    const rw = typeof d.reserved_w === 'number' && Number.isFinite(d.reserved_w) ? Math.max(0, d.reserved_w) : 0
    if (lastTrayReservedPx !== rw) {
      lastTrayReservedPx = rw
      options.setTrayReservedPx(rw)
    }
    const sw =
      typeof d.slot_w === 'number' && Number.isFinite(d.slot_w)
        ? Math.max(24, Math.min(64, Math.round(d.slot_w)))
        : 40
    if (lastTrayIconSlotPx !== sw) {
      lastTrayIconSlotPx = sw
      options.setTrayIconSlotPx(sw)
    }
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
    if (!sameTaskbarSniItems(lastSniTrayItems, next)) {
      lastSniTrayItems = next
      options.setSniTrayItems(next)
    }
    queueMicrotask(() => options.scheduleExclusionZonesSync())
  }

  const applyOutputGeometryDetail = (d: Extract<DerpShellDetail, { type: 'output_geometry' }>) => {
    const prev = lastOutputTopology
    const next = {
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
    }
    if (!sameOutputTopology(prev, next)) {
      lastOutputTopology = next
      options.setOutputTopology(next)
    }
    options.scheduleCompositorFollowup({ syncExclusion: true, flushWindows: true })
  }

  const applyOutputLayoutDetail = (d: Extract<DerpShellDetail, { type: 'output_layout' }>) => {
    const pr =
      typeof d.shell_chrome_primary === 'string' && d.shell_chrome_primary.length > 0
        ? d.shell_chrome_primary
        : null
    const fallbackPrimaryName = pr ?? d.screens.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x))[0]?.name ?? null
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
      taskbar_programs: typeof s.taskbar_programs === 'boolean' ? s.taskbar_programs : s.name === fallbackPrimaryName,
      taskbar_osk: typeof s.taskbar_osk === 'boolean' ? s.taskbar_osk : s.name === fallbackPrimaryName,
      taskbar_keyboard_layout:
        typeof s.taskbar_keyboard_layout === 'boolean' ? s.taskbar_keyboard_layout : s.name === fallbackPrimaryName,
      taskbar_clock: typeof s.taskbar_clock === 'boolean' ? s.taskbar_clock : s.name === fallbackPrimaryName,
    }))
    const next = {
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
    }
    if (!sameOutputTopology(lastOutputTopology, next)) {
      lastOutputTopology = next
      options.setOutputTopology(next)
    }
    ;(window as Window & { __DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION?: number }).__DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION =
      typeof d.revision === 'number' && Number.isFinite(d.revision) ? Math.trunc(d.revision) : 0
    options.scheduleCompositorFollowup({
      syncExclusion: true,
      flushWindows: true,
      resetScroll: true,
    })
  }

  const applyInteractionStateDetail = (d: Extract<DerpShellDetail, { type: 'interaction_state' }>) => {
    const applyStart = performance.now()
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
      super_held: d.super_held === true,
      window_switcher_selected_window_id: coerceShellWindowId(d.window_switcher_selected_window_id),
      move_rect: d.move_rect,
      resize_rect: d.resize_rect,
    } satisfies NonNullable<CompositorInteractionState>
    const previousActiveWindowId =
      lastKnownInteractionState?.move_window_id ?? lastKnownInteractionState?.resize_window_id ?? null
    const nextActiveWindowId = nextInteractionState.move_window_id ?? nextInteractionState.resize_window_id ?? null
    if (sameInteractionState(lastKnownInteractionState, nextInteractionState)) {
      noteShellInteractionApply(performance.now() - applyStart)
      return
    }
    options.setCompositorInteractionState(nextInteractionState)
    lastKnownInteractionState = nextInteractionState
    if (previousActiveWindowId !== null || nextActiveWindowId !== null) {
    }
    noteShellInteractionApply(performance.now() - applyStart)
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

  const applyCompositorSnapshot = (
    details: readonly DerpShellDetail[],
    domainFlags: number,
    stateStartedAt = performance.now(),
    scheduleFollowup = true,
  ) => {
    const coalescedDetails = coalesceCompositorDetails(details)
    applyImperativeChromeDetails(coalescedDetails, stateStartedAt)
    const skipOutputGeometry = coalescedDetails.some((detail) => detail.type === 'output_layout')
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
      if (coalescedDetails.length > 0) {
        const modelStart = performance.now()
        options.applyModelAuthoritativeSnapshotDetails(coalescedDetails)
        noteShellModelUpdate(performance.now() - modelStart)
      }
      const windowStart = performance.now()
      for (const detail of coalescedDetails) {
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
        lastOutputTopology = null
        options.setOutputTopology(null)
        ;(window as Window & { __DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION?: number }).__DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION = 0
      }
      if ((domainFlags & snapshotDomainKeyboard) !== 0 && !sawKeyboard) {
        lastKeyboardLayoutLabel = null
        options.setKeyboardLayoutLabel(null)
      }
      if ((domainFlags & snapshotDomainTray) !== 0 && !sawTray) {
        lastTrayReservedPx = 0
        lastTrayIconSlotPx = 36
        lastSniTrayItems = []
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
      noteShellWindowApply(performance.now() - windowStart)
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
    if (scheduleFollowup) scheduleCompositorVisualFollowup(coalescedDetails)
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
    if (d.type === 'lock_state') {
      options.setLockScreenState?.(d.state)
      return
    }
    if (d.type === 'notification_event') {
      applyNotificationEventDetail(d)
      return
    }
    if (detailIsSnapshotState(d)) {
      const synced = syncCompositorSnapshot()
      if (
        synced &&
        snapshotDetailCanApplyWhenSyncedSnapshotOmitsDomain(d) &&
        !snapshotDetailCoveredByDomainFlags(d, synced.domainFlags)
      ) {
        applyCompositorSnapshot([d], 0)
      }
      if (!synced) {
        if (canApplyEpochlessSnapshotDetailDirectly(d)) applyCompositorSnapshot([d], 0)
        scheduleCompositorVisualFollowup([d])
        if (shouldRequestWindowSyncRecovery([d])) options.requestWindowSyncRecovery()
      }
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
    const stateStartedAt = applyStart
    const coalescedDetails = coalesceCompositorDetails(details)
    const hasSnapshotState = coalescedDetails.some(detailIsSnapshotState)
    let synced: false | { domainFlags: number; detailsLength: number } = false
    if (hasSnapshotState) synced = syncCompositorSnapshot()
    const uncoveredSnapshotDetails = synced
      ? coalescedDetails.filter(
          (detail) =>
            detailIsSnapshotState(detail) &&
            snapshotDetailCanApplyWhenSyncedSnapshotOmitsDomain(detail) &&
            !snapshotDetailCoveredByDomainFlags(detail, synced.domainFlags),
        )
      : []
    const directChromeDetails = synced
      ? coalescedDetails.filter((detail) => !detailIsSnapshotState(detail))
      : coalescedDetails
    applyImperativeChromeDetails(directChromeDetails, stateStartedAt)
    batch(() => {
      for (const detail of coalescedDetails) {
        if (detail.type === 'mutation_ack') applyCompositorDetail(detail)
      }
      if (hasSnapshotState) {
        if (synced && uncoveredSnapshotDetails.length > 0) {
          const syncedChromeAffectingDomain =
            (synced.domainFlags &
              (snapshotDomainWindows |
                snapshotDomainWindowOrder |
                snapshotDomainFocus |
                snapshotDomainWorkspace |
                snapshotDomainOutputs)) !==
            0
          applyCompositorSnapshot(uncoveredSnapshotDetails, 0, stateStartedAt, !syncedChromeAffectingDomain)
        }
        if (!synced) {
          const directSnapshotDetails = coalescedDetails.filter(canApplyEpochlessSnapshotDetailDirectly)
          if (directSnapshotDetails.length > 0) applyCompositorSnapshot(directSnapshotDetails, 0, stateStartedAt)
          scheduleCompositorVisualFollowup(coalescedDetails.filter(detailIsSnapshotState))
          if (shouldRequestWindowSyncRecovery(coalescedDetails)) options.requestWindowSyncRecovery()
        }
        bridgeDebug({
          last_drop: {
            reason: synced ? 'snapshot_state_batch_replaced_by_snapshot' : 'snapshot_state_batch_waiting_for_snapshot',
            type: 'batch',
            snapshot_epoch: Math.max(0, ...coalescedDetails.map(detailSnapshotEpoch)),
            sequence: lastSnapshotSequence,
          },
        })
      }
      for (const detail of coalescedDetails) {
        if (!detailIsSnapshotState(detail) && detail.type !== 'mutation_ack') applyCompositorDetail(detail)
      }
    })
    noteShellBatchApply(performance.now() - applyStart, coalescedDetails.length)
  }

  const syncCompositorSnapshot = (force = false) => {
    const path = window.__DERP_COMPOSITOR_SNAPSHOT_PATH
    if (typeof path !== 'string' || path.length === 0) return false
    const readSnapshot = window.__derpCompositorSnapshotRead
    if (typeof readSnapshot !== 'function') return false
    const readSnapshotIfChanged = window.__derpCompositorSnapshotReadIfChanged
    let raw: ArrayBuffer | null = null
    const readStart = performance.now()
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
    noteShellSnapshotRead(performance.now() - readStart)
    if (!(raw instanceof ArrayBuffer)) return false
    const decodeStart = performance.now()
    const decoded = decodeCompositorSnapshot(raw)
    noteShellSnapshotDecode(performance.now() - decodeStart, raw.byteLength)
    if (!decoded) return false
    const stateStartedAt = performance.now()
    const snapshotDetails = decoded.details
    const previousDomainRevisions = lastSnapshotDomainRevisions
    if (previousDomainRevisions) {
      for (const index of snapshotRecoveryDomainIndexes) {
        const domain = 1 << index
        if ((decoded.domainFlags & domain) !== 0) continue
        const previous = previousDomainRevisions[index] ?? 0
        const next = decoded.domainRevisions[index] ?? previous
        if (next > previous) {
          options.requestWindowSyncRecovery()
          break
        }
      }
    }
    lastSnapshotDomainRevisions = decoded.domainRevisions
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
    if (lastCompositorSnapshotSequenceSignal !== decoded.sequence) {
      lastCompositorSnapshotSequenceSignal = decoded.sequence
      options.setCompositorSnapshotSequence(decoded.sequence)
    }
    ;(window as Window & { __DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE?: number }).__DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE =
      decoded.sequence
    ;(window as Window & { __DERP_LAST_COMPOSITOR_SNAPSHOT_DOMAIN_FLAGS?: number }).__DERP_LAST_COMPOSITOR_SNAPSHOT_DOMAIN_FLAGS =
      lastSnapshotDomainFlags
    const applyStart = performance.now()
    applyCompositorSnapshot(snapshotDetails, lastSnapshotDomainFlags, stateStartedAt)
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
