import { pickScreenForWindow, type CanvasOrigin } from '@/lib/shellCoords'
import { SHELL_WINDOW_FLAG_SHELL_HOSTED } from '@/features/shell-ui/shellUiWindows'
import { groupIdForWindow, type WorkspaceSnapshot } from '@/features/workspace/workspaceSnapshot'
import type { ExternalCommandPaletteState } from '@/features/command-palette/commandPalette'
import type { LayoutScreen } from './types'

export type DerpShellDetail = ({
  snapshot_epoch?: number
} & (
  | { type: 'output_geometry'; logical_width: number; logical_height: number }
  | {
      type: 'output_layout'
      revision?: number
      canvas_logical_width: number
      canvas_logical_height: number
      canvas_logical_origin_x?: number
      canvas_logical_origin_y?: number
      canvas_physical_width: number
      canvas_physical_height: number
      screens: Array<{
        name: string
        identity?: string
        x: number
        y: number
        width: number
        height: number
        usable_x?: number
        usable_y?: number
        usable_width?: number
        usable_height?: number
        physical_width?: number
        physical_height?: number
        transform: number
        refresh_milli_hz?: number
        vrr_supported?: boolean
        vrr_enabled?: boolean
        taskbar_side?: 'bottom' | 'top' | 'left' | 'right'
      }>
      shell_chrome_primary?: string | null
      taskbar_auto_hide?: boolean
    }
  | {
      type: 'window_mapped'
      window_id: number
      surface_id: number
      x: number
      y: number
      width: number
      height: number
      client_x?: number
      client_y?: number
      client_width?: number
      client_height?: number
      frame_x?: number
      frame_y?: number
      frame_width?: number
      frame_height?: number
      title: string
      app_id: string
      output_id?: string
      output_name?: string
      stack_z?: number
      minimized?: boolean
      maximized?: boolean
      fullscreen?: boolean
      shell_flags?: number
      capture_identifier?: string
      kind?: string
      x11_class?: string
      x11_instance?: string
      workspace_visible?: boolean
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
      client_x?: number
      client_y?: number
      client_width?: number
      client_height?: number
      frame_x?: number
      frame_y?: number
      frame_width?: number
      frame_height?: number
      output_id?: string
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
  | { type: 'window_list'; revision?: number; windows: unknown[] }
  | { type: 'window_order'; revision?: number; windows: unknown[] }
  | { type: 'workspace_state'; revision?: number; state: WorkspaceSnapshot }
  | { type: 'shell_hosted_app_state'; revision?: number; state: { byWindowId?: Record<string, unknown> } }
  | { type: 'command_palette_state'; revision?: number; state: ExternalCommandPaletteState }
  | {
      type: 'interaction_state'
      revision?: number
      interaction_serial?: number
      pointer_x: number
      pointer_y: number
      move_window_id: number | null
      resize_window_id: number | null
      move_proxy_window_id: number | null
      move_capture_window_id: number | null
      move_rect:
        | {
            x: number
            y: number
            width: number
            height: number
            maximized: boolean
            fullscreen: boolean
          }
        | null
      resize_rect:
        | {
            x: number
            y: number
            width: number
            height: number
            maximized: boolean
            fullscreen: boolean
          }
        | null
      window_switcher_selected_window_id?: number | null
    }
  | {
      type: 'native_drag_preview'
      window_id: number
      generation: number
      image_path: string
    }
  | { type: 'context_menu_dismiss' }
  | { type: 'programs_menu_toggle'; output_name?: string }
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
  | {
      type: 'notifications_state'
      state: unknown
    }
  | {
      type: 'notification_event'
      notification_id: number
      event_type: string
      action_key?: string | null
      close_reason?: number | null
      source: string
    }
  | {
      type: 'mutation_ack'
      domain: string
      client_mutation_id: number
      status: string
      snapshot_epoch?: number
    }))

export type DerpWindow = {
  window_id: number
  surface_id: number
  stack_z: number
  x: number
  y: number
  width: number
  height: number
  client_x?: number
  client_y?: number
  client_width?: number
  client_height?: number
  frame_x?: number
  frame_y?: number
  frame_width?: number
  frame_height?: number
  title: string
  app_id: string
  output_id: string
  output_name: string
  kind: string
  x11_class: string
  x11_instance: string
  minimized: boolean
  maximized: boolean
  fullscreen: boolean
  shell_flags: number
  capture_identifier: string
  workspace_visible: boolean
}

export function workspaceGroupWindowIds(state: WorkspaceSnapshot, windowId: number): number[] {
  const groupId = groupIdForWindow(state, windowId)
  return groupId ? state.groups.find((group) => group.id === groupId)?.windowIds ?? [windowId] : [windowId]
}

function coerceOutputName(nextValue: unknown): string {
  return typeof nextValue === 'string' && nextValue.length > 0 ? nextValue : ''
}

function coerceOutputId(nextValue: unknown): string {
  return typeof nextValue === 'string' && nextValue.length > 0 ? nextValue : ''
}

function coerceOptionalFiniteNumber(nextValue: unknown): number | undefined {
  return typeof nextValue === 'number' && Number.isFinite(nextValue) ? nextValue : undefined
}

export function windowIsShellHosted(window: Pick<DerpWindow, 'window_id' | 'app_id' | 'shell_flags'>): boolean {
  return (window.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) !== 0
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
  if (w.output_id && mon.identity && w.output_id === mon.identity) return true
  if (w.output_name && w.output_name === mon.name) return true
  const p = pickScreenForWindow(w, list, co)
  return p !== null && p.name === mon.name
}

export function pickLayoutScreenForMove(w: DerpWindow, list: LayoutScreen[], co: CanvasOrigin): LayoutScreen | null {
  if (list.length === 0) return null
  if (w.output_id) {
    const byIdentity = list.find((s) => s.identity === w.output_id)
    if (byIdentity) return byIdentity
  }
  if (w.output_name) {
    const byName = list.find((s) => s.name === w.output_name)
    if (byName) return byName
  }
  return pickScreenForWindow(w, list, co) ?? list[0] ?? null
}

export function buildWindowsMapFromList(
  raw: unknown,
  prev?: Map<number, DerpWindow>,
): Map<number, DerpWindow> {
  const next = new Map<number, DerpWindow>()
  if (!Array.isArray(raw)) return prev && prev.size === 0 ? prev : next
  const prevIterator = prev?.entries()
  let identical = !!prev
  let seen = 0
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const wid = coerceShellWindowId(r.window_id)
    const sid = coerceShellWindowId(r.surface_id)
    if (wid === null || sid === null) continue
    const previousWindow = prev?.get(wid)
    const sfRaw = r.shell_flags
    const shell_flags =
      typeof sfRaw === 'number' && Number.isFinite(sfRaw)
        ? Math.trunc(sfRaw)
        : 0
    const szRaw = r.stack_z
    const stack_z =
      typeof szRaw === 'number' && Number.isFinite(szRaw)
        ? Math.trunc(szRaw)
        : wid
    const window: DerpWindow = {
      window_id: wid,
      surface_id: sid,
      stack_z,
      x: Number(r.x) || 0,
      y: Number(r.y) || 0,
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
      client_x: coerceOptionalFiniteNumber(r.client_x),
      client_y: coerceOptionalFiniteNumber(r.client_y),
      client_width: coerceOptionalFiniteNumber(r.client_width),
      client_height: coerceOptionalFiniteNumber(r.client_height),
      frame_x: coerceOptionalFiniteNumber(r.frame_x),
      frame_y: coerceOptionalFiniteNumber(r.frame_y),
      frame_width: coerceOptionalFiniteNumber(r.frame_width),
      frame_height: coerceOptionalFiniteNumber(r.frame_height),
      title: typeof r.title === 'string' ? r.title : '',
      app_id: typeof r.app_id === 'string' ? r.app_id : '',
      output_id: coerceOutputId(r.output_id),
      output_name: coerceOutputName(r.output_name),
      kind: typeof r.kind === 'string' ? r.kind : '',
      x11_class: typeof r.x11_class === 'string' ? r.x11_class : '',
      x11_instance: typeof r.x11_instance === 'string' ? r.x11_instance : '',
      minimized: !!r.minimized,
      maximized: !!r.maximized,
      fullscreen: !!r.fullscreen,
      shell_flags,
      capture_identifier:
        typeof r.capture_identifier === 'string'
          ? r.capture_identifier
          : '',
      workspace_visible:
        typeof r.workspace_visible === 'boolean'
          ? r.workspace_visible
          : true,
    }
    const sameAsPrevious = previousWindow !== undefined && sameDerpWindow(previousWindow, window)
    const stableWindow = sameAsPrevious ? previousWindow : window
    next.set(wid, stableWindow)
    if (identical) {
      const previousEntry = prevIterator?.next().value
      if (!previousEntry || previousEntry[0] !== wid || previousEntry[1] !== stableWindow) identical = false
    }
    seen += 1
  }
  if (identical && prev && prev.size === seen) return prev
  return next
}

function sameDerpWindow(left: DerpWindow, right: DerpWindow): boolean {
  return (
    left.window_id === right.window_id &&
    left.surface_id === right.surface_id &&
    left.stack_z === right.stack_z &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.client_x === right.client_x &&
    left.client_y === right.client_y &&
    left.client_width === right.client_width &&
    left.client_height === right.client_height &&
    left.frame_x === right.frame_x &&
    left.frame_y === right.frame_y &&
    left.frame_width === right.frame_width &&
    left.frame_height === right.frame_height &&
    left.title === right.title &&
    left.app_id === right.app_id &&
    left.output_id === right.output_id &&
    left.output_name === right.output_name &&
    left.kind === right.kind &&
    left.x11_class === right.x11_class &&
    left.x11_instance === right.x11_instance &&
    left.minimized === right.minimized &&
    left.maximized === right.maximized &&
    left.fullscreen === right.fullscreen &&
    left.shell_flags === right.shell_flags &&
    left.capture_identifier === right.capture_identifier &&
    left.workspace_visible === right.workspace_visible
  )
}
