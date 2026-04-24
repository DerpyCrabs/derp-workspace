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
import type { CompositorApplyResult } from '@/features/bridge/compositorModel'
import { compositorSnapshotAbi, decodeCompositorSnapshot } from '@/features/bridge/compositorSnapshot'
import type { TraySniMenuEntry } from '@/host/createShellContextMenus'
import { coerceShellWindowId, type DerpShellDetail, type DerpWindow } from '@/host/appWindowState'
import type { LayoutScreen } from '@/host/types'
import type { TaskbarSniItem } from '@/features/taskbar/Taskbar'
import type { Rect as TileRect, SnapZone } from '@/features/tiling/tileZones'
import type { WorkspaceState } from '@/features/workspace/workspaceState'

type CompositorFollowup = {
  syncExclusion?: boolean
  flushWindows?: boolean
  resetScroll?: boolean
}

type CompositorInteractionState = {
  pointer_x: number
  pointer_y: number
  move_window_id: number | null
  resize_window_id: number | null
  move_proxy_window_id: number | null
  move_capture_window_id: number | null
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
  | 'shell_ipc_pong'
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
      | ((prev: CompositorOutputTopology | null) => CompositorOutputTopology),
  ) => void
  setCompositorSnapshotSequence: (value: number) => void
  setCompositorInteractionState: (value: CompositorInteractionState) => void
  setNativeDragPreview: (value: NativeDragPreviewState) => void
  getNativeDragPreview: () => NativeDragPreviewState
  markHasSeenCompositorWindowSync: () => void
  clearWindowSyncRecoveryPending: () => void
  scheduleExclusionZonesSync: () => void
  scheduleCompositorFollowup: (options?: CompositorFollowup) => void
  applyModelCompositorSnapshot: (details: readonly DerpShellDetail[]) => void
  applyModelCompositorDetail: (
    detail: DerpShellDetail,
    options: {
      fallbackMonitorKey: () => string
      requestWindowSyncRecovery: () => void
    },
  ) => CompositorApplyResult
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
  workspaceState: () => WorkspaceState
  occupiedSnapZonesOnMonitor: (mon: LayoutScreen, excludeWindowId: number) => { zone: SnapZone; bounds: TileRect }[]
  sendSetMonitorTile: (windowId: number, outputName: string, zone: SnapZone, bounds: TileRect, outputId?: string | null) => boolean
  bumpSnapChrome: () => void
  sendSetPreTileGeometry: (windowId: number, bounds: { x: number; y: number; w: number; h: number }) => boolean
  floatBeforeMaximize: Map<number, { x: number; y: number; w: number; h: number }>
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
  let volumeOverlayHideTimer: ReturnType<typeof setTimeout> | undefined
  let lastSnapshotSequence = 0

  const detailSnapshotEpoch = (detail: DerpShellDetail) => {
    const raw = (detail as { snapshot_epoch?: unknown }).snapshot_epoch
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
    return Math.max(0, Math.trunc(raw))
  }

  const shouldApplyLiveDetail = (detail: DerpShellDetail) => {
    const epoch = detailSnapshotEpoch(detail)
    return epoch === 0 || epoch >= lastSnapshotSequence
  }

  const detailCanBeSupersededBySnapshot = (detail: DerpShellDetail) =>
    detail.type === 'window_list' ||
    detail.type === 'focus_changed' ||
    detail.type === 'workspace_state' ||
    detail.type === 'shell_hosted_app_state' ||
    detail.type === 'output_layout' ||
    detail.type === 'keyboard_layout' ||
    detail.type === 'tray_hints' ||
    detail.type === 'tray_sni'

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
      transform: s.transform,
      refresh_milli_hz: typeof s.refresh_milli_hz === 'number' ? s.refresh_milli_hz : 0,
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
    const moveWindowId = coerceShellWindowId(d.move_window_id)
    options.setCompositorInteractionState({
      pointer_x: d.pointer_x,
      pointer_y: d.pointer_y,
      move_window_id: moveWindowId,
      resize_window_id: coerceShellWindowId(d.resize_window_id),
      move_proxy_window_id: coerceShellWindowId(d.move_proxy_window_id),
      move_capture_window_id: coerceShellWindowId(d.move_capture_window_id),
      move_rect: d.move_rect,
      resize_rect: d.resize_rect,
    })
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
    return false
  }

  const applyCompositorSnapshot = (details: readonly DerpShellDetail[]) => {
    if (details.length === 0) return
    const skipOutputGeometry = details.some((detail) => detail.type === 'output_layout')
    let sawWindowList = false
    let sawInteractionState = false
    let sawFocusChanged = false
    batch(() => {
      options.applyModelCompositorSnapshot(details)
      for (const detail of details) {
        if (detail.type === 'window_list') {
          sawWindowList = true
          continue
        }
        if (detail.type === 'interaction_state') {
          sawInteractionState = true
        }
        if (detail.type === 'focus_changed') {
          sawFocusChanged = true
        }
        applySnapshotVisualDetail(detail, skipOutputGeometry)
      }
      if (!sawInteractionState) options.setCompositorInteractionState(null)
      if (sawWindowList) options.markHasSeenCompositorWindowSync()
    })
    if (sawWindowList) options.clearWindowSyncRecoveryPending()
    if (sawFocusChanged) queueMicrotask(() => options.shellWireSend('invalidate_view'))
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

  const applyCompositorDetail = (d: DerpShellDetail) => {
    if (!shouldApplyLiveDetail(d)) return
    const detailEpoch = detailSnapshotEpoch(d)
    if (detailEpoch > lastSnapshotSequence && detailCanBeSupersededBySnapshot(d)) {
      syncCompositorSnapshot()
      if (lastSnapshotSequence >= detailEpoch) return
    }
    if (d.type === 'context_menu_dismiss') {
      options.closeAllAtlasSelects()
      options.hideContextMenu()
      return
    }
    if (d.type === 'programs_menu_toggle') {
      options.toggleProgramsMenuMeta(typeof d.output_name === 'string' ? d.output_name : null)
      return
    }
    if (d.type === 'compositor_ping') {
      options.shellWireSend('shell_ipc_pong')
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
    if (d.type === 'focus_changed') {
      if (syncCompositorSnapshot()) return
      const result = options.applyModelCompositorDetail(d, {
        fallbackMonitorKey: options.fallbackMonitorKey,
        requestWindowSyncRecovery: options.requestWindowSyncRecovery,
      })
      if (result.followup) options.scheduleCompositorFollowup(result.followup)
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
    if (d.type === 'interaction_state') {
      applyInteractionStateDetail(d)
      return
    }
    if (d.type === 'native_drag_preview') {
      applyNativeDragPreviewDetail(d)
      return
    }
    if (d.type === 'window_list') {
      options.markHasSeenCompositorWindowSync()
      options.clearWindowSyncRecoveryPending()
      const result = options.applyModelCompositorDetail(d, {
        fallbackMonitorKey: options.fallbackMonitorKey,
        requestWindowSyncRecovery: options.requestWindowSyncRecovery,
      })
      if (result.followup) options.scheduleCompositorFollowup(result.followup)
      return
    }
    if (d.type === 'workspace_state') {
      options.applyModelCompositorDetail(d, {
        fallbackMonitorKey: options.fallbackMonitorKey,
        requestWindowSyncRecovery: options.requestWindowSyncRecovery,
      })
      return
    }
    if (d.type === 'shell_hosted_app_state') {
      options.applyModelCompositorDetail(d, {
        fallbackMonitorKey: options.fallbackMonitorKey,
        requestWindowSyncRecovery: options.requestWindowSyncRecovery,
      })
      return
    }
    if (d.type === 'window_state') {
      options.markHasSeenCompositorWindowSync()
      const result = options.applyModelCompositorDetail(d, {
        fallbackMonitorKey: options.fallbackMonitorKey,
        requestWindowSyncRecovery: options.requestWindowSyncRecovery,
      })
      if (result.followup) options.scheduleCompositorFollowup(result.followup)
      return
    }
    if (d.type === 'window_unmapped') {
      options.markHasSeenCompositorWindowSync()
      const result = options.applyModelCompositorDetail(d, {
        fallbackMonitorKey: options.fallbackMonitorKey,
        requestWindowSyncRecovery: options.requestWindowSyncRecovery,
      })
      if (result.followup) options.scheduleCompositorFollowup(result.followup)
      return
    }
    if (d.type === 'window_geometry') {
      options.markHasSeenCompositorWindowSync()
      const result = options.applyModelCompositorDetail(d, {
        fallbackMonitorKey: options.fallbackMonitorKey,
        requestWindowSyncRecovery: options.requestWindowSyncRecovery,
      })
      if (result.kind === 'recovery_requested') return
      return
    }
    if (d.type === 'window_mapped') {
      options.markHasSeenCompositorWindowSync()
      const result = options.applyModelCompositorDetail(d, {
        fallbackMonitorKey: options.fallbackMonitorKey,
        requestWindowSyncRecovery: options.requestWindowSyncRecovery,
      })
      if (result.followup) options.scheduleCompositorFollowup(result.followup)
      return
    }
    if (d.type === 'window_metadata') {
      options.markHasSeenCompositorWindowSync()
      options.applyModelCompositorDetail(d, {
        fallbackMonitorKey: options.fallbackMonitorKey,
        requestWindowSyncRecovery: options.requestWindowSyncRecovery,
      })
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

  const syncCompositorSnapshot = (force = false) => {
    const path = window.__DERP_COMPOSITOR_SNAPSHOT_PATH
    if (typeof path !== 'string' || path.length === 0) return false
    const readSnapshot = window.__derpCompositorSnapshotRead
    if (typeof readSnapshot !== 'function') return false
    const readSnapshotIfChanged = window.__derpCompositorSnapshotReadIfChanged
    const abi = window.__DERP_COMPOSITOR_SNAPSHOT_ABI ?? compositorSnapshotAbi()
    let raw: ArrayBuffer | null = null
    if (!force && typeof readSnapshotIfChanged === 'function') {
      raw = readSnapshotIfChanged(path, lastSnapshotSequence, abi)
    } else if (!force) {
      const snapshotVersion = window.__derpCompositorSnapshotVersion
      if (typeof snapshotVersion === 'function') {
        const version = snapshotVersion(path, abi)
        if (typeof version === 'number' && Number.isFinite(version) && version === lastSnapshotSequence) {
          return false
        }
      }
      raw = readSnapshot(path, abi)
    } else {
      raw = readSnapshot(path, abi)
    }
    if (!(raw instanceof ArrayBuffer)) return false
    const decoded = decodeCompositorSnapshot(raw)
    if (!decoded || decoded.details.length === 0) return false
    const shouldTrace =
      decoded.details.some((detail) => detail.type.startsWith('window_')) ||
      decoded.details.some((detail) => detail.type === 'focus_changed' || detail.type === 'workspace_state')
    const shellLatencySampleId = shouldTrace
      ? beginShellLatencySample(decoded.sequence, decoded.details.length, force)
      : 0
    if (shellLatencySampleId !== 0) {
      markShellLatencySample(shellLatencySampleId, { decodedAt: performance.now() })
    }
    lastSnapshotSequence = decoded.sequence
    options.setCompositorSnapshotSequence(decoded.sequence)
    ;(window as Window & { __DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE?: number }).__DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE =
      decoded.sequence
    ;(window as Window & { __DERP_LAST_COMPOSITOR_SNAPSHOT_DOMAIN_FLAGS?: number }).__DERP_LAST_COMPOSITOR_SNAPSHOT_DOMAIN_FLAGS =
      decoded.domainFlags
    applyCompositorSnapshot(decoded.details)
    if (shellLatencySampleId !== 0) {
      markShellLatencySample(shellLatencySampleId, { appliedAt: performance.now() })
    }
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
    window.removeEventListener(DERP_SHELL_EVENT, onDerpShell as EventListener)
    window.removeEventListener(DERP_SHELL_SNAPSHOT_EVENT, onCompositorSnapshot as EventListener)
  }
}
