import type { DerpShellDetail } from '@/host/appWindowState'
import {
  HOT_BATCH_MAGIC,
  HOT_DETAIL_FOCUS_CHANGED,
  HOT_DETAIL_INTERACTION_STATE,
  HOT_DETAIL_INTERACTION_STATE_BYTES,
  HOT_DETAIL_WINDOW_GEOMETRY,
  HOT_DETAIL_WINDOW_GEOMETRY_BYTES,
  HOT_DETAIL_WINDOW_ORDER,
  HOT_DETAIL_WINDOW_STATE,
  HOT_DETAIL_WINDOW_UNMAPPED,
} from './wireSchema.generated'

export const DERP_SHELL_EVENT = 'derp-shell'
export const DERP_SHELL_SNAPSHOT_EVENT = 'derp-shell-snapshot'

type DerpShellLatencySample = {
  id: number
  sequence: number
  detailCount: number
  force: boolean
  syncStartAt: number
  decodedAt?: number
  appliedAt?: number
  authoritativeAt?: number
  visualAt?: number
  rafAt?: number
}

let shellLatencyNextId = 1
let shellLatencySample: DerpShellLatencySample | null = null
let hotBatchTextDecoder: TextDecoder | undefined

function shellLatencyNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export function beginShellLatencySample(sequence: number, detailCount: number, force: boolean): number {
  const id = shellLatencyNextId++
  shellLatencySample = {
    id,
    sequence,
    detailCount,
    force,
    syncStartAt: shellLatencyNow(),
  }
  return id
}

export function markShellLatencySample(
  id: number,
  patch: Partial<Omit<DerpShellLatencySample, 'id' | 'sequence' | 'detailCount' | 'force' | 'syncStartAt'>>,
) {
  if (!shellLatencySample || shellLatencySample.id !== id) return null
  shellLatencySample = { ...shellLatencySample, ...patch }
  return shellLatencySample
}

export function markActiveShellLatencySample(
  patch: Partial<Omit<DerpShellLatencySample, 'id' | 'sequence' | 'detailCount' | 'force' | 'syncStartAt'>>,
) {
  if (!shellLatencySample) return null
  shellLatencySample = { ...shellLatencySample, ...patch }
  return shellLatencySample
}

export function flushShellLatencySample(id: number) {
  const sample = shellLatencySample
  if (!sample || sample.id !== id) return false
  shellLatencySample = null
  return true
}

export function flushActiveShellLatencySample() {
  const sample = shellLatencySample
  if (!sample) return false
  return flushShellLatencySample(sample.id)
}

declare global {
  interface Window {
    __DERP_APPLY_COMPOSITOR_BATCH?: (details: readonly DerpShellDetail[]) => void
    __DERP_APPLY_COMPOSITOR_BATCH_JSON?: (json: string) => void
    __DERP_APPLY_COMPOSITOR_BATCH_BINARY?: (buffer: ArrayBuffer) => void
    __DERP_SYNC_COMPOSITOR_SNAPSHOT?: () => void
  }
}

function readString(view: DataView, cursor: { offset: number }): string | null {
  if (cursor.offset + 4 > view.byteLength) return null
  const length = view.getUint32(cursor.offset, true)
  cursor.offset += 4
  if (cursor.offset + length > view.byteLength) return null
  const bytes = new Uint8Array(view.buffer, view.byteOffset + cursor.offset, length)
  cursor.offset += length
  hotBatchTextDecoder ??= new TextDecoder()
  return hotBatchTextDecoder.decode(bytes)
}

function decodeHotVisual(view: DataView, offset: number, windowId: number) {
  if (windowId <= 0) return null
  const flags = view.getUint32(offset + 16, true)
  return {
    x: view.getInt32(offset, true),
    y: view.getInt32(offset + 4, true),
    width: view.getInt32(offset + 8, true),
    height: view.getInt32(offset + 12, true),
    maximized: (flags & 1) !== 0,
    fullscreen: (flags & 2) !== 0,
  }
}

function decodeHotWindowGeometry(
  view: DataView,
  cursor: { offset: number },
  snapshot_epoch: number,
): Extract<DerpShellDetail, { type: 'window_geometry' }> | null {
  if (cursor.offset + HOT_DETAIL_WINDOW_GEOMETRY_BYTES > view.byteLength) return null
  const window_id = view.getUint32(cursor.offset, true)
  const surface_id = view.getUint32(cursor.offset + 4, true)
  const x = view.getInt32(cursor.offset + 8, true)
  const y = view.getInt32(cursor.offset + 12, true)
  const width = view.getInt32(cursor.offset + 16, true)
  const height = view.getInt32(cursor.offset + 20, true)
  const flags = view.getUint8(cursor.offset + 24)
  const client_x = view.getInt32(cursor.offset + 25, true)
  const client_y = view.getInt32(cursor.offset + 29, true)
  const client_width = view.getInt32(cursor.offset + 33, true)
  const client_height = view.getInt32(cursor.offset + 37, true)
  const frame_x = view.getInt32(cursor.offset + 41, true)
  const frame_y = view.getInt32(cursor.offset + 45, true)
  const frame_width = view.getInt32(cursor.offset + 49, true)
  const frame_height = view.getInt32(cursor.offset + 53, true)
  cursor.offset += HOT_DETAIL_WINDOW_GEOMETRY_BYTES
  const output_id = readString(view, cursor)
  const output_name = readString(view, cursor)
  if (output_id === null || output_name === null) return null
  return {
    type: 'window_geometry',
    window_id,
    surface_id,
    x,
    y,
    width,
    height,
    client_x,
    client_y,
    client_width,
    client_height,
    frame_x,
    frame_y,
    frame_width,
    frame_height,
    output_id,
    output_name,
    maximized: (flags & 1) !== 0,
    fullscreen: (flags & 2) !== 0,
    client_side_decoration: (flags & 4) !== 0,
    ...(snapshot_epoch > 0 ? { snapshot_epoch } : {}),
  }
}

export function decodeCompositorHotBatch(buffer: ArrayBuffer): DerpShellDetail[] | null {
  const view = new DataView(buffer)
  if (view.byteLength < 8) return null
  if (
    view.getUint8(0) !== HOT_BATCH_MAGIC[0] ||
    view.getUint8(1) !== HOT_BATCH_MAGIC[1] ||
    view.getUint8(2) !== HOT_BATCH_MAGIC[2] ||
    view.getUint8(3) !== HOT_BATCH_MAGIC[3]
  ) {
    return null
  }
  const count = view.getUint32(4, true)
  const details: DerpShellDetail[] = []
  const cursor = { offset: 8 }
  for (let index = 0; index < count; index += 1) {
    if (cursor.offset + 9 > view.byteLength) return null
    const tag = view.getUint8(cursor.offset)
    cursor.offset += 1
    const snapshot_epoch = Number(view.getBigUint64(cursor.offset, true))
    cursor.offset += 8
    if (tag === HOT_DETAIL_WINDOW_GEOMETRY) {
      const detail = decodeHotWindowGeometry(view, cursor, snapshot_epoch)
      if (detail === null) return null
      details.push(detail)
      continue
    }
    if (tag === HOT_DETAIL_WINDOW_STATE) {
      if (cursor.offset + 5 > view.byteLength) return null
      const window_id = view.getUint32(cursor.offset, true)
      const minimized = view.getUint8(cursor.offset + 4) !== 0
      cursor.offset += 5
      details.push({
        type: 'window_state',
        window_id,
        minimized,
        ...(snapshot_epoch > 0 ? { snapshot_epoch } : {}),
      })
      continue
    }
    if (tag === HOT_DETAIL_WINDOW_UNMAPPED) {
      if (cursor.offset + 4 > view.byteLength) return null
      const window_id = view.getUint32(cursor.offset, true)
      cursor.offset += 4
      details.push({
        type: 'window_unmapped',
        window_id,
        ...(snapshot_epoch > 0 ? { snapshot_epoch } : {}),
      })
      continue
    }
    if (tag === HOT_DETAIL_FOCUS_CHANGED) {
      if (cursor.offset + 10 > view.byteLength) return null
      const hasSurface = view.getUint8(cursor.offset) !== 0
      const surface_id = view.getUint32(cursor.offset + 1, true)
      const hasWindow = view.getUint8(cursor.offset + 5) !== 0
      const window_id = view.getUint32(cursor.offset + 6, true)
      cursor.offset += 10
      details.push({
        type: 'focus_changed',
        surface_id: hasSurface ? surface_id : null,
        window_id: hasWindow ? window_id : null,
        ...(snapshot_epoch > 0 ? { snapshot_epoch } : {}),
      })
      continue
    }
    if (tag === HOT_DETAIL_WINDOW_ORDER) {
      if (cursor.offset + 12 > view.byteLength) return null
      const revision = Number(view.getBigUint64(cursor.offset, true))
      const windowCount = view.getUint32(cursor.offset + 8, true)
      cursor.offset += 12
      if (cursor.offset + windowCount * 8 > view.byteLength) return null
      const windows: Array<{ window_id: number; stack_z: number }> = []
      for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
        windows.push({
          window_id: view.getUint32(cursor.offset, true),
          stack_z: view.getUint32(cursor.offset + 4, true),
        })
        cursor.offset += 8
      }
      details.push({
        type: 'window_order',
        revision,
        windows,
        ...(snapshot_epoch > 0 ? { snapshot_epoch } : {}),
      })
      continue
    }
    if (tag === HOT_DETAIL_INTERACTION_STATE) {
      if (cursor.offset + HOT_DETAIL_INTERACTION_STATE_BYTES > view.byteLength) return null
      const revision = Number(view.getBigUint64(cursor.offset, true))
      const pointer_x = view.getInt32(cursor.offset + 8, true)
      const pointer_y = view.getInt32(cursor.offset + 12, true)
      const moveWindowId = view.getUint32(cursor.offset + 16, true)
      const resizeWindowId = view.getUint32(cursor.offset + 20, true)
      const moveProxyWindowId = view.getUint32(cursor.offset + 24, true)
      const moveCaptureWindowId = view.getUint32(cursor.offset + 28, true)
      const moveVisualWindowId = moveWindowId || moveProxyWindowId || moveCaptureWindowId
      const move_rect = decodeHotVisual(view, cursor.offset + 32, moveVisualWindowId)
      const resize_rect = decodeHotVisual(view, cursor.offset + 52, resizeWindowId)
      const windowSwitcherSelectedWindowId = view.getUint32(cursor.offset + 72, true)
      const interaction_serial = Number(view.getBigUint64(cursor.offset + 76, true))
      const super_held = view.getUint32(cursor.offset + 84, true) !== 0
      cursor.offset += HOT_DETAIL_INTERACTION_STATE_BYTES
      details.push({
        type: 'interaction_state',
        revision,
        interaction_serial,
        pointer_x,
        pointer_y,
        move_window_id: moveWindowId > 0 ? moveWindowId : null,
        resize_window_id: resizeWindowId > 0 ? resizeWindowId : null,
        move_proxy_window_id: moveProxyWindowId > 0 ? moveProxyWindowId : null,
        move_capture_window_id: moveCaptureWindowId > 0 ? moveCaptureWindowId : null,
        move_rect,
        resize_rect,
        window_switcher_selected_window_id:
          windowSwitcherSelectedWindowId > 0 ? windowSwitcherSelectedWindowId : null,
        ...(super_held ? { super_held: true } : {}),
        ...(snapshot_epoch > 0 ? { snapshot_epoch } : {}),
      })
      continue
    }
    return null
  }
  return cursor.offset === view.byteLength ? details : null
}

export function installCompositorBatchHandler(
  handler: (details: readonly DerpShellDetail[]) => void,
): () => void {
  const previous = window.__DERP_APPLY_COMPOSITOR_BATCH
  const previousJson = window.__DERP_APPLY_COMPOSITOR_BATCH_JSON
  const previousBinary = window.__DERP_APPLY_COMPOSITOR_BATCH_BINARY
  const wrapped = (details: readonly DerpShellDetail[]) => {
    if (!Array.isArray(details) || details.length === 0) return
    handler(details)
  }
  const wrappedJson = (json: string) => {
    const details = JSON.parse(json) as readonly DerpShellDetail[]
    wrapped(details)
  }
  const wrappedBinary = (buffer: ArrayBuffer) => {
    const details = decodeCompositorHotBatch(buffer)
    if (details) wrapped(details)
  }
  window.__DERP_APPLY_COMPOSITOR_BATCH = wrapped
  window.__DERP_APPLY_COMPOSITOR_BATCH_JSON = wrappedJson
  window.__DERP_APPLY_COMPOSITOR_BATCH_BINARY = wrappedBinary
  return () => {
    if (window.__DERP_APPLY_COMPOSITOR_BATCH === wrapped) {
      if (typeof previous === 'function') {
        window.__DERP_APPLY_COMPOSITOR_BATCH = previous
      } else {
        delete window.__DERP_APPLY_COMPOSITOR_BATCH
      }
    }
    if (window.__DERP_APPLY_COMPOSITOR_BATCH_JSON === wrappedJson) {
      if (typeof previousJson === 'function') {
        window.__DERP_APPLY_COMPOSITOR_BATCH_JSON = previousJson
      } else {
        delete window.__DERP_APPLY_COMPOSITOR_BATCH_JSON
      }
    }
    if (window.__DERP_APPLY_COMPOSITOR_BATCH_BINARY === wrappedBinary) {
      if (typeof previousBinary === 'function') {
        window.__DERP_APPLY_COMPOSITOR_BATCH_BINARY = previousBinary
      } else {
        delete window.__DERP_APPLY_COMPOSITOR_BATCH_BINARY
      }
    }
  }
}

export function installCompositorSnapshotHandler(handler: () => void): () => void {
  const previous = window.__DERP_SYNC_COMPOSITOR_SNAPSHOT
  const wrapped = () => {
    handler()
  }
  window.__DERP_SYNC_COMPOSITOR_SNAPSHOT = wrapped
  return () => {
    if (window.__DERP_SYNC_COMPOSITOR_SNAPSHOT !== wrapped) return
    if (typeof previous === 'function') {
      window.__DERP_SYNC_COMPOSITOR_SNAPSHOT = previous
    } else {
      delete window.__DERP_SYNC_COMPOSITOR_SNAPSHOT
    }
  }
}
