import { pickScreenForWindow, type CanvasOrigin } from '@/lib/shellCoords'
import { SHELL_WINDOW_FLAG_SHELL_HOSTED } from '@/features/shell-ui/shellHostedSurfaceRegistry'
import { groupIdForWindow, type WorkspaceSnapshot } from '@/features/workspace/workspaceSnapshot'
import type { DerpWindow } from '@/features/bridge/wireSchema.generated'
export type { DerpShellDetail, DerpWindow } from '@/features/bridge/wireSchema.generated'
import type { LayoutScreen } from './types'

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

function coerceIconBuffers(raw: unknown): Array<{ width: number; height: number; scale: number }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ width: number; height: number; scale: number }> = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const width = Number(r.width)
    const height = Number(r.height)
    const scale = Number(r.scale)
    if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(scale)) continue
    out.push({ width: Math.trunc(width), height: Math.trunc(height), scale: Math.trunc(scale) })
  }
  return out
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
      restore_x: coerceOptionalFiniteNumber(r.restore_x),
      restore_y: coerceOptionalFiniteNumber(r.restore_y),
      restore_width: coerceOptionalFiniteNumber(r.restore_width),
      restore_height: coerceOptionalFiniteNumber(r.restore_height),
      title: typeof r.title === 'string' ? r.title : '',
      app_id: typeof r.app_id === 'string' ? r.app_id : '',
      icon_name: typeof r.icon_name === 'string' ? r.icon_name : '',
      icon_buffers: coerceIconBuffers(r.icon_buffers),
      output_id: coerceOutputId(r.output_id),
      output_name: coerceOutputName(r.output_name),
      kind: typeof r.kind === 'string' ? r.kind : '',
      x11_class: typeof r.x11_class === 'string' ? r.x11_class : '',
      x11_instance: typeof r.x11_instance === 'string' ? r.x11_instance : '',
      minimized: !!r.minimized,
      maximized: !!r.maximized,
      fullscreen: !!r.fullscreen,
      client_side_decoration: !!r.client_side_decoration,
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
    left.restore_x === right.restore_x &&
    left.restore_y === right.restore_y &&
    left.restore_width === right.restore_width &&
    left.restore_height === right.restore_height &&
    left.title === right.title &&
    left.app_id === right.app_id &&
    left.icon_name === right.icon_name &&
    left.icon_buffers.length === right.icon_buffers.length &&
    left.icon_buffers.every((buffer, index) => {
      const other = right.icon_buffers[index]
      return !!other && buffer.width === other.width && buffer.height === other.height && buffer.scale === other.scale
    }) &&
    left.output_id === right.output_id &&
    left.output_name === right.output_name &&
    left.kind === right.kind &&
    left.x11_class === right.x11_class &&
    left.x11_instance === right.x11_instance &&
    left.minimized === right.minimized &&
    left.maximized === right.maximized &&
    left.fullscreen === right.fullscreen &&
    left.client_side_decoration === right.client_side_decoration &&
    left.shell_flags === right.shell_flags &&
    left.capture_identifier === right.capture_identifier &&
    left.workspace_visible === right.workspace_visible
  )
}
