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
import {
  findAdjacentMonitor,
  pickScreenForWindow,
  rectCanvasLocalToGlobal,
  rectGlobalToCanvasLocal,
} from '@/lib/shellCoords'
import { screensListForLayout, shellMaximizedWorkAreaGlobalRect } from '@/host/appLayout'
import { coerceShellWindowId, type DerpShellDetail, type DerpWindow } from '@/host/appWindowState'
import type { LayoutScreen } from '@/host/types'
import type { TaskbarSniItem } from '@/features/taskbar/Taskbar'
import { monitorWorkAreaGlobal } from '@/features/tiling/tileSnap'
import type { Rect as TileRect, SnapZone } from '@/features/tiling/tileZones'
import { snapZoneToBoundsWithOccupied } from '@/features/tiling/tileZones'
import { workspaceGetTiledZone, workspaceIsWindowTiled, type WorkspaceState } from '@/features/workspace/workspaceState'
import { SHELL_LAYOUT_FLOATING, SHELL_LAYOUT_MAXIMIZED } from '@/lib/chromeConstants'

type WindowDraftPatch = Partial<
  Pick<DerpWindow, 'x' | 'y' | 'width' | 'height' | 'maximized' | 'output_name'>
>

type CompositorFollowup = {
  syncExclusion?: boolean
  flushWindows?: boolean
  relayoutAll?: boolean
  relayoutMonitor?: string | null
  resetScroll?: boolean
}

type CompositorRuntimeWireOp =
  | 'close'
  | 'shell_ipc_pong'
  | 'set_fullscreen'
  | 'set_geometry'
  | 'presentation_fullscreen'

type CompositorBridgeRuntimeOptions = {
  setKeyboardLayoutLabel: (label: string | null) => void
  setVolumeOverlay: (value: { linear: number; muted: boolean; stateKnown: boolean } | null) => void
  setTrayVolumeState: (value: { muted: boolean; volumePercent: number | null }) => void
  setTrayReservedPx: (value: number) => void
  setTrayIconSlotPx: (value: number) => void
  setSniTrayItems: (items: TaskbarSniItem[]) => void
  setOutputGeom: (value: { w: number; h: number }) => void
  setOutputPhysical: (value: { w: number; h: number }) => void
  setContextMenuAtlasBufferH: (value: number) => void
  setLayoutCanvasOrigin: (value: { x: number; y: number } | null) => void
  setUiScalePercent: (value: 100 | 150 | 200) => void
  setScreenDraftRows: (rows: LayoutScreen[]) => void
  bumpTilingCfgRev: () => void
  setShellChromePrimaryName: (value: string | null) => void
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
  shellWireSend: (
    op: CompositorRuntimeWireOp,
    arg?: number | string,
    arg2?: number | string,
    arg3?: number,
    arg4?: number,
    arg5?: number,
    arg6?: number,
  ) => boolean
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
  sendSetMonitorTile: (windowId: number, outputName: string, zone: SnapZone, bounds: TileRect) => boolean
  patchWindowDrafts: (
    windowIds: readonly number[],
    buildPatch: (windowId: number, current: DerpWindow) => WindowDraftPatch,
  ) => void
  bumpSnapChrome: () => void
  applyAutoLayout: (monitorName: string) => void
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
  let bootstrapSnapshotRetry = 0
  let bootstrapSnapshotTimer: number | undefined

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
    options.setOutputGeom({ w: d.logical_width, h: d.logical_height })
    options.scheduleCompositorFollowup({ syncExclusion: true, flushWindows: true })
  }

  const applyOutputLayoutDetail = (d: Extract<DerpShellDetail, { type: 'output_layout' }>) => {
    batch(() => {
      options.setOutputGeom({ w: d.canvas_logical_width, h: d.canvas_logical_height })
      options.setOutputPhysical({
        w: d.canvas_physical_width,
        h: d.canvas_physical_height,
      })
      if (typeof d.context_menu_atlas_buffer_h === 'number' && d.context_menu_atlas_buffer_h > 0) {
        options.setContextMenuAtlasBufferH(d.context_menu_atlas_buffer_h)
      }
      if (typeof d.canvas_logical_origin_x === 'number' && typeof d.canvas_logical_origin_y === 'number') {
        options.setLayoutCanvasOrigin({ x: d.canvas_logical_origin_x, y: d.canvas_logical_origin_y })
      } else {
        options.setLayoutCanvasOrigin(null)
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
        options.setUiScalePercent(best)
      }
      options.setScreenDraftRows(
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
      options.bumpTilingCfgRev()
      const pr =
        typeof d.shell_chrome_primary === 'string' && d.shell_chrome_primary.length > 0
          ? d.shell_chrome_primary
          : null
      options.setShellChromePrimaryName(pr)
    })
    options.scheduleCompositorFollowup({
      syncExclusion: true,
      flushWindows: true,
      relayoutAll: true,
      resetScroll: true,
    })
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
    return false
  }

  const applyCompositorSnapshot = (details: readonly DerpShellDetail[]) => {
    if (details.length === 0) return
    const skipOutputGeometry = details.some((detail) => detail.type === 'output_layout')
    let sawWindowList = false
    batch(() => {
      options.applyModelCompositorSnapshot(details)
      for (const detail of details) {
        if (detail.type === 'window_list') {
          sawWindowList = true
          continue
        }
        applySnapshotVisualDetail(detail, skipOutputGeometry)
      }
      if (sawWindowList) options.markHasSeenCompositorWindowSync()
    })
    if (sawWindowList) options.clearWindowSyncRecoveryPending()
  }

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
    if (d.type === 'keybind') {
      const action = typeof d.action === 'string' ? d.action : ''
      const fid = options.focusedWindowId()
      const wmap = options.allWindowsMap()
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
        if (fid === null) return
        const w = wmap.get(fid)
        if (!w) return
        options.shellWireSend('set_fullscreen', fid, w.fullscreen ? 0 : 1)
        return
      }
      if (action === 'toggle_maximize') {
        const fromEv = coerceShellWindowId(d.target_window_id)
        const tid = fromEv ?? fid
        if (tid === null) return
        options.toggleShellMaximizeForWindow(tid)
        return
      }
      if (action === 'move_monitor_left' || action === 'move_monitor_right') {
        if (fid === null) return
        const w = wmap.get(fid)
        if (!w || w.minimized || w.fullscreen) return
        const co = options.layoutCanvasOrigin()
        const list = screensListForLayout(options.screenDraftRows(), options.outputGeom(), co)
        const curMon = pickScreenForWindow(w, list, co) ?? list[0] ?? null
        if (!curMon) return
        const tgtMon = findAdjacentMonitor(
          curMon,
          list,
          action === 'move_monitor_left' ? 'left' : 'right',
        )
        if (!tgtMon) return
        const reserveCur = options.reserveTaskbarForMon(curMon)
        const reserveTgt = options.reserveTaskbarForMon(tgtMon)
        const glob = rectCanvasLocalToGlobal(w.x, w.y, w.width, w.height, co)
        let gRect: { x: number; y: number; w: number; h: number }
        let layoutFlag: typeof SHELL_LAYOUT_FLOATING | typeof SHELL_LAYOUT_MAXIMIZED
        if (w.maximized) {
          gRect = shellMaximizedWorkAreaGlobalRect(tgtMon, reserveTgt)
          layoutFlag = SHELL_LAYOUT_MAXIMIZED
        } else if (workspaceIsWindowTiled(options.workspaceState(), fid)) {
          const zone = workspaceGetTiledZone(options.workspaceState(), fid)!
          const tw = monitorWorkAreaGlobal(tgtMon, reserveTgt)
          const workRect: TileRect = { x: tw.x, y: tw.y, width: tw.w, height: tw.h }
          const occ = options.occupiedSnapZonesOnMonitor(tgtMon, fid)
          const gb = snapZoneToBoundsWithOccupied(zone, workRect, occ)
          if (!options.sendSetMonitorTile(fid, tgtMon.name, zone, gb)) return
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
        options.shellWireSend('set_geometry', fid, loc.x, loc.y, loc.w, loc.h, layoutFlag)
        options.patchWindowDrafts([fid], () => ({
          output_name: tgtMon.name,
          x: loc.x,
          y: loc.y,
          width: loc.w,
          height: loc.h,
          maximized: layoutFlag === SHELL_LAYOUT_MAXIMIZED,
        }))
        options.scheduleExclusionZonesSync()
        options.bumpSnapChrome()
        queueMicrotask(() => {
          options.applyAutoLayout(curMon.name)
          options.applyAutoLayout(tgtMon.name)
        })
        return
      }
      if (action === 'tile_left' || action === 'tile_right') {
        if (fid === null) return
        const w = wmap.get(fid)
        if (!w || w.minimized) return
        const co = options.layoutCanvasOrigin()
        const list = screensListForLayout(options.screenDraftRows(), options.outputGeom(), co)
        const mon = pickScreenForWindow(w, list, co) ?? list[0] ?? null
        if (!mon) return
        const zone: SnapZone = action === 'tile_left' ? 'left-half' : 'right-half'
        const reserveTb = options.reserveTaskbarForMon(mon)
        const wr = monitorWorkAreaGlobal(mon, reserveTb)
        const workRect: TileRect = { x: wr.x, y: wr.y, width: wr.w, height: wr.h }
        const occ = options.occupiedSnapZonesOnMonitor(mon, fid)
        const gb = snapZoneToBoundsWithOccupied(zone, workRect, occ)
        const gRect = { x: gb.x, y: gb.y, w: gb.width, h: gb.height }
        const loc = rectGlobalToCanvasLocal(gRect.x, gRect.y, gRect.w, gRect.h, co)
        const preTile = w.maximized
          ? (options.floatBeforeMaximize.get(fid) ?? {
              x: w.x,
              y: w.y,
              w: w.width,
              h: w.height,
            })
          : { x: w.x, y: w.y, w: w.width, h: w.height }
        if (!options.sendSetPreTileGeometry(fid, preTile)) return
        if (!options.sendSetMonitorTile(fid, mon.name, zone, gb)) return
        if (w.maximized) options.floatBeforeMaximize.delete(fid)
        options.shellWireSend('set_geometry', fid, loc.x, loc.y, loc.w, loc.h, SHELL_LAYOUT_FLOATING)
        options.patchWindowDrafts([fid], () => ({
          x: loc.x,
          y: loc.y,
          width: loc.w,
          height: loc.h,
          maximized: false,
        }))
        options.scheduleExclusionZonesSync()
        options.bumpSnapChrome()
        return
      }
      if (action === 'tile_up') {
        if (fid === null) return
        options.toggleShellMaximizeForWindow(fid)
        return
      }
      if (action === 'tile_down') {
        if (fid === null) return
        const w = wmap.get(fid)
        if (!w || w.minimized) return
        if (w.maximized) {
          const rest = options.floatBeforeMaximize.get(fid) ?? {
            x: w.x,
            y: w.y,
            w: w.width,
            h: w.height,
          }
          options.floatBeforeMaximize.delete(fid)
          options.shellWireSend('set_geometry', fid, rest.x, rest.y, rest.w, rest.h, SHELL_LAYOUT_FLOATING)
          options.patchWindowDrafts([fid], () => ({
            x: rest.x,
            y: rest.y,
            width: rest.w,
            height: rest.h,
            maximized: false,
          }))
          options.scheduleExclusionZonesSync()
          options.bumpSnapChrome()
          return
        }
        if (workspaceIsWindowTiled(options.workspaceState(), fid)) {
          const tr = options.workspacePreTileSnapshot(fid)
          if (tr) {
            options.shellWireSend('set_geometry', fid, tr.x, tr.y, tr.w, tr.h, SHELL_LAYOUT_FLOATING)
            options.patchWindowDrafts([fid], () => ({
              x: tr.x,
              y: tr.y,
              width: tr.w,
              height: tr.h,
              maximized: false,
            }))
          }
          if (!options.sendRemoveMonitorTile(fid)) return
          if (!options.sendClearPreTileGeometry(fid)) return
          options.scheduleExclusionZonesSync()
          options.bumpSnapChrome()
          return
        }
        return
      }
      return
    }
    if (d.type === 'focus_changed') {
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
      const wid = result.windowId ?? null
      if (wid !== null) {
        queueMicrotask(() => {
          const w2 = options.windows().get(wid)
          const fb = options.fallbackMonitorKey()
          const newMon = w2 ? w2.output_name || fb : null
          const prevMon = result.previousWindow?.output_name || fb
          if (newMon !== null && prevMon !== newMon) {
            options.applyAutoLayout(prevMon)
            options.applyAutoLayout(newMon)
          }
        })
      }
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
    syncCompositorSnapshot(true)
  })

  return () => {
    if (volumeOverlayHideTimer !== undefined) clearTimeout(volumeOverlayHideTimer)
    if (bootstrapSnapshotTimer !== undefined) clearTimeout(bootstrapSnapshotTimer)
    removeCompositorBatchHandler()
    removeCompositorSnapshotHandler()
    window.removeEventListener(DERP_SHELL_EVENT, onDerpShell as EventListener)
    window.removeEventListener(DERP_SHELL_SNAPSHOT_EVENT, onCompositorSnapshot as EventListener)
  }
}
