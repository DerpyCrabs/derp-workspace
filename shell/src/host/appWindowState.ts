import { pickScreenForWindow, type CanvasOrigin } from '@/lib/shellCoords'
import { SHELL_WINDOW_FLAG_SHELL_HOSTED } from '@/features/shell-ui/shellUiWindows'
import { groupIdForWindow, type WorkspaceSnapshot } from '@/features/workspace/workspaceSnapshot'
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
        transform: number
        refresh_milli_hz?: number
      }>
      shell_chrome_primary?: string | null
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
  | {
      type: 'interaction_state'
      revision?: number
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
    }
  | {
      type: 'native_drag_preview'
      window_id: number
      generation: number
      image_path: string
    }
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

function coerceOutputName(nextValue: unknown, previousValue: string): string {
  return typeof nextValue === 'string' && nextValue.length > 0 ? nextValue : previousValue
}

function coerceOutputId(nextValue: unknown, previousValue: string): string {
  return typeof nextValue === 'string' && nextValue.length > 0 ? nextValue : previousValue
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
    const outputName = coerceOutputName(r.output_name, previousWindow?.output_name ?? '')
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
    const window: DerpWindow = {
      window_id: wid,
      surface_id: sid,
      stack_z,
      x: Number(r.x) || 0,
      y: Number(r.y) || 0,
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
      title: typeof r.title === 'string' ? r.title : '',
      app_id: typeof r.app_id === 'string' ? r.app_id : '',
      output_id: coerceOutputId(r.output_id, previousWindow?.output_id ?? ''),
      output_name: outputName,
      kind: typeof r.kind === 'string' ? r.kind : (prev?.get(wid)?.kind ?? ''),
      x11_class: typeof r.x11_class === 'string' ? r.x11_class : (prev?.get(wid)?.x11_class ?? ''),
      x11_instance: typeof r.x11_instance === 'string' ? r.x11_instance : (prev?.get(wid)?.x11_instance ?? ''),
      minimized: !!r.minimized,
      maximized: !!r.maximized,
      fullscreen: !!r.fullscreen,
      shell_flags,
      capture_identifier:
        typeof r.capture_identifier === 'string'
          ? r.capture_identifier
          : (prev?.get(wid)?.capture_identifier ?? ''),
      workspace_visible:
        typeof r.workspace_visible === 'boolean'
          ? r.workspace_visible
          : (prev?.get(wid)?.workspace_visible ?? true),
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

function nextStackZ(map: Map<number, DerpWindow>, excludeWindowId?: number): number {
  let max = 0
  for (const [windowId, window] of map) {
    if (windowId === excludeWindowId) continue
    if (window.stack_z > max) max = window.stack_z
  }
  return max + 1
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

function mappedWindow(detail: Extract<DerpShellDetail, { type: 'window_mapped' }>, map: Map<number, DerpWindow>) {
  const wid = coerceShellWindowId(detail.window_id)
  const sid = coerceShellWindowId(detail.surface_id)
  if (wid === null || sid === null) return null
  const current = map.get(wid)
  const shell_flags =
    typeof detail.shell_flags === 'number' && Number.isFinite(detail.shell_flags)
      ? Math.trunc(detail.shell_flags)
      : (current?.shell_flags ?? 0)
  const stack_z =
    typeof detail.stack_z === 'number' && Number.isFinite(detail.stack_z)
      ? Math.trunc(detail.stack_z)
      : nextStackZ(map, wid)
  return {
    window_id: wid,
    surface_id: sid,
    stack_z,
    x: detail.x,
    y: detail.y,
    width: detail.width,
    height: detail.height,
    title: detail.title,
    app_id: detail.app_id,
    output_id: coerceOutputId(detail.output_id, current?.output_id ?? ''),
    output_name: coerceOutputName(detail.output_name, current?.output_name ?? ''),
    kind: typeof detail.kind === 'string' ? detail.kind : (current?.kind ?? ''),
    x11_class: typeof detail.x11_class === 'string' ? detail.x11_class : (current?.x11_class ?? ''),
    x11_instance: typeof detail.x11_instance === 'string' ? detail.x11_instance : (current?.x11_instance ?? ''),
    minimized: detail.minimized ?? false,
    maximized: detail.maximized ?? false,
    fullscreen: detail.fullscreen ?? false,
    shell_flags,
    capture_identifier:
      typeof detail.capture_identifier === 'string'
        ? detail.capture_identifier
        : (current?.capture_identifier ?? ''),
    workspace_visible: detail.workspace_visible ?? current?.workspace_visible ?? true,
  } satisfies DerpWindow
}

export function applyDetailMutable(map: Map<number, DerpWindow>, detail: DerpShellDetail): boolean {
  switch (detail.type) {
    case 'window_mapped': {
      const nextWindow = mappedWindow(detail, map)
      if (!nextWindow) break
      const current = map.get(nextWindow.window_id)
      if (current && sameDerpWindow(current, nextWindow)) return false
      map.set(nextWindow.window_id, nextWindow)
      return true
    }
    case 'window_unmapped': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null || !map.has(wid)) break
      map.delete(wid)
      return true
    }
    case 'window_geometry': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null) break
      const w = map.get(wid)
      if (!w) break
      const nextWindow = {
        ...w,
        x: detail.x,
        y: detail.y,
        width: detail.width,
        height: detail.height,
        output_id:
          detail.output_id !== undefined
            ? coerceOutputId(detail.output_id, w.output_id)
            : w.output_id,
        output_name:
          detail.output_name !== undefined
            ? coerceOutputName(detail.output_name, w.output_name)
            : w.output_name,
        maximized: detail.maximized ?? w.maximized,
        fullscreen: detail.fullscreen ?? w.fullscreen,
      }
      if (
        nextWindow.x === w.x &&
        nextWindow.y === w.y &&
        nextWindow.width === w.width &&
        nextWindow.height === w.height &&
        nextWindow.output_id === w.output_id &&
        nextWindow.output_name === w.output_name &&
        nextWindow.maximized === w.maximized &&
        nextWindow.fullscreen === w.fullscreen
      ) {
        return false
      }
      map.set(wid, nextWindow)
      return true
    }
    case 'window_state': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null) break
      const w = map.get(wid)
      if (!w || w.minimized === detail.minimized) break
      map.set(wid, { ...w, minimized: detail.minimized })
      return true
    }
    case 'window_metadata': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null) break
      const w = map.get(wid)
      if (!w) break
      if (w.title === detail.title && w.app_id === detail.app_id) return false
      map.set(wid, { ...w, title: detail.title, app_id: detail.app_id })
      return true
    }
    case 'window_order': {
      if (!Array.isArray(detail.windows)) break
      let changed = false
      for (const row of detail.windows) {
        if (!row || typeof row !== 'object') continue
        const r = row as Record<string, unknown>
        const wid = coerceShellWindowId(r.window_id)
        const stackRaw = r.stack_z
        if (wid === null || typeof stackRaw !== 'number' || !Number.isFinite(stackRaw)) continue
        const window = map.get(wid)
        if (!window) continue
        const stack_z = Math.trunc(stackRaw)
        if (window.stack_z === stack_z) continue
        map.set(wid, { ...window, stack_z })
        changed = true
      }
      return changed
    }
    default:
      break
  }
  return false
}

export function switchVisibleWindowLocally(
  map: Map<number, DerpWindow>,
  windowId: number,
  previousVisibleWindowId: number,
): Map<number, DerpWindow> {
  if (windowId === previousVisibleWindowId) return map
  const nextWindow = map.get(windowId)
  const previousVisibleWindow = map.get(previousVisibleWindowId)
  let next: Map<number, DerpWindow> | null = null
  if (nextWindow && nextWindow.minimized) {
    next = new Map(map)
    next.set(windowId, { ...nextWindow, minimized: false })
  }
  if (previousVisibleWindow && !previousVisibleWindow.minimized) {
    if (!next) next = new Map(map)
    next.set(previousVisibleWindowId, { ...previousVisibleWindow, minimized: true })
  }
  return next ?? map
}

export function applyDetail(map: Map<number, DerpWindow>, detail: DerpShellDetail): Map<number, DerpWindow> {
  switch (detail.type) {
    case 'window_mapped': {
      const nextWindow = mappedWindow(detail, map)
      if (!nextWindow) break
      const current = map.get(nextWindow.window_id)
      if (current && sameDerpWindow(current, nextWindow)) return map
      const next = new Map(map)
      next.set(nextWindow.window_id, nextWindow)
      return next
    }
    case 'window_unmapped': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null || !map.has(wid)) break
      const next = new Map(map)
      next.delete(wid)
      return next
    }
    case 'window_geometry': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null) break
      const w = map.get(wid)
      if (w) {
        const nextWindow = {
          ...w,
          x: detail.x,
          y: detail.y,
          width: detail.width,
          height: detail.height,
          output_id:
            detail.output_id !== undefined
              ? coerceOutputId(detail.output_id, w.output_id)
              : w.output_id,
          output_name:
            detail.output_name !== undefined
              ? coerceOutputName(detail.output_name, w.output_name)
              : w.output_name,
          maximized: detail.maximized ?? w.maximized,
          fullscreen: detail.fullscreen ?? w.fullscreen,
        }
        if (
          nextWindow.x === w.x &&
          nextWindow.y === w.y &&
          nextWindow.width === w.width &&
          nextWindow.height === w.height &&
          nextWindow.output_id === w.output_id &&
          nextWindow.output_name === w.output_name &&
          nextWindow.maximized === w.maximized &&
          nextWindow.fullscreen === w.fullscreen
        ) {
          return map
        }
        const next = new Map(map)
        next.set(wid, nextWindow)
        return next
      }
      break
    }
    case 'window_state': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null) break
      const w = map.get(wid)
      if (w) {
        if (w.minimized === detail.minimized) return map
        const next = new Map(map)
        next.set(wid, { ...w, minimized: detail.minimized })
        return next
      }
      break
    }
    case 'window_metadata': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null) break
      const w = map.get(wid)
      if (w) {
        const nextWindow = {
          ...w,
          title: detail.title,
          app_id: detail.app_id,
          shell_flags: w.shell_flags,
        }
        if (
          nextWindow.title === w.title &&
          nextWindow.app_id === w.app_id &&
          nextWindow.shell_flags === w.shell_flags
        ) {
          return map
        }
        const next = new Map(map)
        next.set(wid, nextWindow)
        return next
      }
      break
    }
    case 'focus_changed': {
      const wid = coerceShellWindowId(detail.window_id)
      if (wid === null) break
      if (!map.has(wid)) break
      return map
    }
    case 'window_order': {
      if (!Array.isArray(detail.windows)) break
      let next: Map<number, DerpWindow> | null = null
      for (const row of detail.windows) {
        if (!row || typeof row !== 'object') continue
        const r = row as Record<string, unknown>
        const wid = coerceShellWindowId(r.window_id)
        const stackRaw = r.stack_z
        if (wid === null || typeof stackRaw !== 'number' || !Number.isFinite(stackRaw)) continue
        const window = (next ?? map).get(wid)
        if (!window) continue
        const stack_z = Math.trunc(stackRaw)
        if (window.stack_z === stack_z) continue
        if (!next) next = new Map(map)
        next.set(wid, { ...window, stack_z })
      }
      return next ?? map
    }
    default:
      break
  }
  return map
}
