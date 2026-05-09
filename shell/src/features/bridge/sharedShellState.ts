import {
  SHELL_SHARED_STATE_ABI_VERSION,
  SHELL_SHARED_STATE_EXCLUSION_FLOATING_HEADER_BYTES,
  SHELL_SHARED_STATE_EXCLUSION_HEADER_BYTES,
  SHELL_SHARED_STATE_EXCLUSION_RECT_BYTES,
  SHELL_SHARED_STATE_EXCLUSION_TRAY_STRIP_BYTES,
  SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES,
  SHELL_SHARED_STATE_KIND_UI_WINDOWS,
  SHELL_SHARED_STATE_PREFIX_BYTES,
  SHELL_SHARED_STATE_UI_WINDOWS_HEADER_BYTES,
  SHELL_SHARED_STATE_UI_WINDOWS_ROW_BYTES,
  type SharedShellExclusionRect,
  type SharedShellExclusionTrayStrip,
  type SharedShellUiWindow,
} from './wireSchema.generated'

export type {
  SharedShellExclusionRect,
  SharedShellExclusionTrayStrip,
  SharedShellUiWindow,
} from './wireSchema.generated'

let shellUiWindowsPayloadScratch = new ArrayBuffer(0)
let shellExclusionPayloadScratch = new ArrayBuffer(0)

function i32(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0
}

function u32(value: number): number {
  return Math.max(0, i32(value)) >>> 0
}

function sharedStateAbi(): number {
  return typeof window.__DERP_SHELL_SHARED_STATE_ABI === 'number'
    ? window.__DERP_SHELL_SHARED_STATE_ABI
    : SHELL_SHARED_STATE_ABI_VERSION
}

function sharedSnapshotEpoch(): number {
  const w = window as Window & {
    __DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE?: number
    __DERP_LAST_COMPOSITOR_STATE_EPOCH?: number
  }
  const snapshotSequence =
    typeof w.__DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE === 'number'
    ? Math.max(
        0,
        Math.trunc(
          w.__DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE ?? 0,
        ),
      )
    : 0
  const stateEpoch =
    typeof w.__DERP_LAST_COMPOSITOR_STATE_EPOCH === 'number'
      ? Math.max(0, Math.trunc(w.__DERP_LAST_COMPOSITOR_STATE_EPOCH ?? 0))
      : 0
  return Math.max(snapshotSequence, stateEpoch)
}

function sharedOutputLayoutRevision(): number {
  return typeof (window as Window & { __DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION?: number }).__DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION === 'number'
    ? Math.max(
        0,
        Math.trunc(
          (window as Window & { __DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION?: number }).__DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION ?? 0,
        ),
      )
    : 0
}

export function sharedShellStateStampKey(): string {
  return `${sharedSnapshotEpoch()}:${sharedOutputLayoutRevision()}`
}

function setSharedPrefix(view: DataView): void {
  view.setBigUint64(0, BigInt(sharedSnapshotEpoch()), true)
  view.setBigUint64(8, BigInt(sharedOutputLayoutRevision()), true)
}

function writeSharedState(path: string | null | undefined, payload: ArrayBuffer, kind: number): boolean {
  const fn = window.__derpShellSharedStateWrite
  if (typeof path !== 'string' || path.length === 0 || typeof fn !== 'function') return false
  try {
    return fn(path, payload, kind, sharedStateAbi()) === true
  } catch {
    return false
  }
}

function scratchBuffer(current: ArrayBuffer, length: number): ArrayBuffer {
  return current.byteLength === length ? current : new ArrayBuffer(length)
}

export function writeShellUiWindowsState(
  generation: number,
  windows: readonly SharedShellUiWindow[],
): boolean {
  const payloadLength = SHELL_SHARED_STATE_PREFIX_BYTES + SHELL_SHARED_STATE_UI_WINDOWS_HEADER_BYTES + windows.length * SHELL_SHARED_STATE_UI_WINDOWS_ROW_BYTES
  const payload = scratchBuffer(shellUiWindowsPayloadScratch, payloadLength)
  shellUiWindowsPayloadScratch = payload
  const view = new DataView(payload)
  setSharedPrefix(view)
  view.setUint32(SHELL_SHARED_STATE_PREFIX_BYTES + 0, u32(generation), true)
  view.setUint32(SHELL_SHARED_STATE_PREFIX_BYTES + 4, u32(windows.length), true)
  let offset = SHELL_SHARED_STATE_PREFIX_BYTES + SHELL_SHARED_STATE_UI_WINDOWS_HEADER_BYTES
  for (const window of windows) {
    view.setUint32(offset, u32(window.id), true)
    view.setInt32(offset + 4, i32(window.gx), true)
    view.setInt32(offset + 8, i32(window.gy), true)
    view.setUint32(offset + 12, u32(window.gw), true)
    view.setUint32(offset + 16, u32(window.gh), true)
    view.setUint32(offset + 20, u32(window.z), true)
    view.setUint32(offset + 24, 0, true)
    offset += SHELL_SHARED_STATE_UI_WINDOWS_ROW_BYTES
  }
  return writeSharedState(window.__DERP_SHELL_UI_WINDOWS_STATE_PATH, payload, SHELL_SHARED_STATE_KIND_UI_WINDOWS)
}

export function writeShellExclusionState(
  rects: readonly SharedShellExclusionRect[],
  trayStrip: SharedShellExclusionTrayStrip | null,
  overlayOpen: boolean,
  floatingRects: readonly SharedShellExclusionRect[],
): boolean {
  const payloadLength =
    SHELL_SHARED_STATE_PREFIX_BYTES +
    SHELL_SHARED_STATE_EXCLUSION_HEADER_BYTES +
    rects.length * SHELL_SHARED_STATE_EXCLUSION_RECT_BYTES +
    (trayStrip ? SHELL_SHARED_STATE_EXCLUSION_TRAY_STRIP_BYTES : 0) +
    SHELL_SHARED_STATE_EXCLUSION_FLOATING_HEADER_BYTES +
    floatingRects.length * SHELL_SHARED_STATE_EXCLUSION_RECT_BYTES
  const payload = scratchBuffer(shellExclusionPayloadScratch, payloadLength)
  shellExclusionPayloadScratch = payload
  const view = new DataView(payload)
  setSharedPrefix(view)
  view.setUint32(SHELL_SHARED_STATE_PREFIX_BYTES + 0, u32(rects.length), true)
  view.setUint32(SHELL_SHARED_STATE_PREFIX_BYTES + 4, trayStrip ? 1 : 0, true)
  let offset = SHELL_SHARED_STATE_PREFIX_BYTES + SHELL_SHARED_STATE_EXCLUSION_HEADER_BYTES
  for (const rect of rects) {
    view.setInt32(offset, i32(rect.x), true)
    view.setInt32(offset + 4, i32(rect.y), true)
    view.setInt32(offset + 8, i32(rect.w), true)
    view.setInt32(offset + 12, i32(rect.h), true)
    view.setUint32(offset + 16, u32(rect.window_id ?? 0), true)
    offset += SHELL_SHARED_STATE_EXCLUSION_RECT_BYTES
  }
  if (trayStrip) {
    view.setInt32(offset, i32(trayStrip.x), true)
    view.setInt32(offset + 4, i32(trayStrip.y), true)
    view.setInt32(offset + 8, i32(trayStrip.w), true)
    view.setInt32(offset + 12, i32(trayStrip.h), true)
    offset += SHELL_SHARED_STATE_EXCLUSION_TRAY_STRIP_BYTES
  }
  view.setUint32(offset, overlayOpen ? 1 : 0, true)
  view.setUint32(offset + 4, u32(floatingRects.length), true)
  offset += SHELL_SHARED_STATE_EXCLUSION_FLOATING_HEADER_BYTES
  for (const rect of floatingRects) {
    view.setInt32(offset, i32(rect.x), true)
    view.setInt32(offset + 4, i32(rect.y), true)
    view.setInt32(offset + 8, i32(rect.w), true)
    view.setInt32(offset + 12, i32(rect.h), true)
    view.setUint32(offset + 16, u32(rect.window_id ?? 0), true)
    offset += SHELL_SHARED_STATE_EXCLUSION_RECT_BYTES
  }
  return writeSharedState(
    window.__DERP_SHELL_EXCLUSION_STATE_PATH,
    payload,
    SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES,
  )
}
