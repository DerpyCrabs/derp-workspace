import { backedShellWindowKind } from '../backedShellWindows'
import { pickScreenForWindow, type CanvasOrigin } from '../shellCoords'
import { SHELL_WINDOW_FLAG_SHELL_HOSTED } from '../shellUiWindows'
import { groupIdForWindow, type WorkspaceState } from '../workspaceState'
import type { LayoutScreen } from './types'

export type DerpShellDetail =
  | { type: 'output_geometry'; logical_width: number; logical_height: number }
  | {
      type: 'output_layout'
      canvas_logical_width: number
      canvas_logical_height: number
      canvas_logical_origin_x?: number
      canvas_logical_origin_y?: number
      canvas_physical_width: number
      canvas_physical_height: number
      screens: Array<{
        name: string
        x: number
        y: number
        width: number
        height: number
        transform: number
        refresh_milli_hz?: number
      }>
      shell_chrome_primary?: string | null
      context_menu_atlas_buffer_h?: number
    }
  | {
      type: 'window_mapped'
      window_id: number
      surface_id: number
      x: number
      y: number
      width: number
      height: number
      title: string
      app_id: string
      output_name?: string
    }
  | { type: 'window_unmapped'; window_id: number }
  | {
      type: 'window_geometry'
      window_id: number
      surface_id: number
      x: number
      y: number
      width: number
      height: number
      output_name?: string
      maximized?: boolean
      fullscreen?: boolean
    }
  | {
      type: 'window_metadata'
      window_id: number
      surface_id: number
      title: string
      app_id: string
    }
  | { type: 'focus_changed'; surface_id: number | null; window_id: number | null }
  | { type: 'window_state'; window_id: number; minimized: boolean }
  | { type: 'window_list'; windows: unknown[] }
  | { type: 'context_menu_dismiss' }
  | { type: 'programs_menu_toggle'; output_name?: string }
  | { type: 'compositor_ping' }
  | { type: 'keybind'; action: string; target_window_id?: number; output_name?: string }
  | { type: 'keyboard_layout'; label: string }
  | {
      type: 'volume_overlay'
      volume_linear_percent_x100: number
      muted: boolean
      state_known: boolean
    }
  | { type: 'tray_hints'; slot_count: number; slot_w: number; reserved_w: number }
  | {
      type: 'tray_sni'
      items: { id: string; title: string; icon_base64: string }[]
    }
  | {
      type: 'tray_sni_menu'
      request_serial: number
      notifier_id: string
      menu_path: string
      entries: {
        dbusmenu_id: number
        label: string
        separator: boolean
        enabled: boolean
      }[]
    }

export type DerpWindow = {
  window_id: number
  surface_id: number
  stack_z: number
  x: number
  y: number
  width: number
  height: number
  title: string
  app_id: string
  output_name: string
  minimized: boolean
  maximized: boolean
  fullscreen: boolean
  shell_flags: number
  capture_identifier: string
}

export function workspaceGroupWindowIds(state: WorkspaceState, windowId: number): number[] {
  const groupId = groupIdForWindow(state, windowId)
  return groupId ? state.groups.find((group) => group.id === groupId)?.windowIds ?? [windowId] : [windowId]
}

export function windowIsShellHosted(window: Pick<DerpWindow, 'window_id' | 'app_id' | 'shell_flags'>): boolean {
  return (
    (window.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) !== 0 ||
    backedShellWindowKind(window.window_id, window.app_id) !== null
  )
}

export function coerceShellWindowId(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return null
  const t = Math.trunc(n)
  return t > 0 ? t : null
}

export function windowOnMonitor(
  w: DerpWindow,
  mon: LayoutScreen,
  list: LayoutScreen[],
  co: CanvasOrigin,
): boolean {
  if (w.output_name && w.output_name === mon.name) return true
  const p = pickScreenForWindow(w, list, co)
  return p !== null && p.name === mon.name
}

export function buildWindowsMapFromList(
  raw: unknown,
  prev?: Map<number, DerpWindow>,
): Map<number, DerpWindow> {
  const next = new Map<number, DerpWindow>()
  if (!Array.isArray(raw)) return next
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const wid = coerceShellWindowId(r.window_id)
    const sid = coerceShellWindowId(r.surface_id)
    if (wid === null || sid === null) continue
    const outputName = typeof r.output_name === 'string' ? r.output_name : ''
    const sfRaw = r.shell_flags
    const shell_flags =
      typeof sfRaw === 'number' && Number.isFinite(sfRaw)
        ? Math.trunc(sfRaw)
        : (prev?.get(wid)?.shell_flags ?? 0)
    const szRaw = r.stack_z
    const stack_z =
      typeof szRaw === 'number' && Number.isFinite(szRaw)
        ? Math.trunc(szRaw)
        : (prev?.get(wid)?.stack_z ?? wid)
    next.set(wid, {
      window_id: wid,
      surface_id: sid,
      stack_z,
      x: Number(r.x) || 0,
      y: Number(r.y) || 0,
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
      title: typeof r.title === 'string' ? r.title : '',
      app_id: typeof r.app_id === 'string' ? r.app_id : '',
      output_name: outputName,
      minimized: !!r.minimized,
      maximized: !!r.maximized,
      fullscreen: !!r.fullscreen,
      shell_flags,
      capture_identifier:
        typeof r.capture_identifier === 'string'
          ? r.capture_identifier
          : (prev?.get(wid)?.capture_identifier ?? ''),
    })
  }
  return next
}

function nextStackZ(map: Map<number, DerpWindow>): number {
  let max = 0
  for (const window of map.values()) {
    if (window.stack_z > max) max = window.stack_z
  }
  return max + 1
}

export function promoteWindowStack(map: Map<number, DerpWindow>, windowId: number): Map<number, DerpWindow> {
  const window = map.get(windowId)
  if (!window) return map
  const stack_z = nextStackZ(map)
  if (window.stack_z === stack_z) return map
  const next = new Map(map)
  next.set(windowId, { ...window, stack_z })
  return next
}

export function applyDetail(map: Map<number, DerpWindow>, detail: DerpShellDetail): Map<number, DerpWindow> {
  const next = new Map(map)
  switch (detail.type) {
    case 'window_mapped': {
      const wid = coerceShellWindowId(detail.window_id)
      const sid = coerceShellWindowId(detail.surface_id)
      if (wid === null || sid === null) break
      const shell_flags =
        next.get(wid)?.shell_flags ??
        (backedShellWindowKind(wid, detail.app_id) !== null ? SHELL_WINDOW_FLAG_SHELL_HOSTED : 0)
      next.set(wid, {
        window_id: wid,
        surface_id: sid,
        stack_z: nextStackZ(next),
        x: detail.x,
        y: detail.y,
        width: detail.width,
        height: detail.height,
        title: detail.title,
        app_id: detail.app_id,
        output_name: typeof detail.output_name === 'string' ? detail.output_name : '',
        minimized: false,
        maximized: false,
        fullscreen: false,
        shell_flags,
        capture_identifier: next.get(wid)?.capture_identifier ?? '',
      })
      break
    }
    case 'window_unmapped': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid !== null) next.delete(wid)
      break
    }
    case 'window_geometry': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null) break
      const w = next.get(wid)
      if (w) {
        next.set(wid, {
          ...w,
          x: detail.x,
          y: detail.y,
          width: detail.width,
          height: detail.height,
          output_name:
            detail.output_name !== undefined
              ? typeof detail.output_name === 'string'
                ? detail.output_name
                : ''
              : w.output_name,
          maximized: detail.maximized ?? w.maximized,
          fullscreen: detail.fullscreen ?? w.fullscreen,
        })
      }
      break
    }
    case 'window_state': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null) break
      const w = next.get(wid)
      if (w) {
        next.set(wid, { ...w, minimized: detail.minimized })
      }
      break
    }
    case 'window_metadata': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null) break
      const w = next.get(wid)
      if (w) {
        next.set(wid, {
          ...w,
          title: detail.title,
          app_id: detail.app_id,
          shell_flags:
            (w.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) !== 0 ||
            backedShellWindowKind(wid, detail.app_id) !== null
              ? w.shell_flags | SHELL_WINDOW_FLAG_SHELL_HOSTED
              : w.shell_flags,
        })
      }
      break
    }
    case 'focus_changed': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid !== null) {
        return promoteWindowStack(next, wid)
      }
      break
    }
    default:
      break
  }
  return next
}
