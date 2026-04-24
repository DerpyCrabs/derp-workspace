export type SharedShellUiWindow = {
  id: number
  z: number
  gx: number
  gy: number
  gw: number
  gh: number
}

export type SharedShellExclusionRect = {
  x: number
  y: number
  w: number
  h: number
  window_id?: number
}

export type SharedShellExclusionTrayStrip = {
  x: number
  y: number
  w: number
  h: number
}

const SHARED_STATE_ABI = 2
const KIND_EXCLUSION_ZONES = 1
const KIND_UI_WINDOWS = 2
const SHARED_STATE_PREFIX_BYTES = 16

function i32(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0
}

function u32(value: number): number {
  return Math.max(0, i32(value)) >>> 0
}

function sharedStateAbi(): number {
  return typeof window.__DERP_SHELL_SHARED_STATE_ABI === 'number'
    ? window.__DERP_SHELL_SHARED_STATE_ABI
    : SHARED_STATE_ABI
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

export function writeShellUiWindowsState(
  generation: number,
  windows: readonly SharedShellUiWindow[],
): boolean {
  const payload = new ArrayBuffer(SHARED_STATE_PREFIX_BYTES + 8 + windows.length * 28)
  const view = new DataView(payload)
  setSharedPrefix(view)
  view.setUint32(SHARED_STATE_PREFIX_BYTES + 0, u32(generation), true)
  view.setUint32(SHARED_STATE_PREFIX_BYTES + 4, u32(windows.length), true)
  let offset = SHARED_STATE_PREFIX_BYTES + 8
  for (const window of windows) {
    view.setUint32(offset, u32(window.id), true)
    view.setInt32(offset + 4, i32(window.gx), true)
    view.setInt32(offset + 8, i32(window.gy), true)
    view.setUint32(offset + 12, u32(window.gw), true)
    view.setUint32(offset + 16, u32(window.gh), true)
    view.setUint32(offset + 20, u32(window.z), true)
    view.setUint32(offset + 24, 0, true)
    offset += 28
  }
  return writeSharedState(window.__DERP_SHELL_UI_WINDOWS_STATE_PATH, payload, KIND_UI_WINDOWS)
}

export function writeShellExclusionState(
  rects: readonly SharedShellExclusionRect[],
  trayStrip: SharedShellExclusionTrayStrip | null,
  overlayOpen: boolean,
  floatingRects: readonly SharedShellExclusionRect[],
): boolean {
  const payload = new ArrayBuffer(
    SHARED_STATE_PREFIX_BYTES + 8 + rects.length * 20 + (trayStrip ? 16 : 0) + 8 + floatingRects.length * 20,
  )
  const view = new DataView(payload)
  setSharedPrefix(view)
  view.setUint32(SHARED_STATE_PREFIX_BYTES + 0, u32(rects.length), true)
  view.setUint32(SHARED_STATE_PREFIX_BYTES + 4, trayStrip ? 1 : 0, true)
  let offset = SHARED_STATE_PREFIX_BYTES + 8
  for (const rect of rects) {
    view.setInt32(offset, i32(rect.x), true)
    view.setInt32(offset + 4, i32(rect.y), true)
    view.setInt32(offset + 8, i32(rect.w), true)
    view.setInt32(offset + 12, i32(rect.h), true)
    view.setUint32(offset + 16, u32(rect.window_id ?? 0), true)
    offset += 20
  }
  if (trayStrip) {
    view.setInt32(offset, i32(trayStrip.x), true)
    view.setInt32(offset + 4, i32(trayStrip.y), true)
    view.setInt32(offset + 8, i32(trayStrip.w), true)
    view.setInt32(offset + 12, i32(trayStrip.h), true)
    offset += 16
  }
  view.setUint32(offset, overlayOpen ? 1 : 0, true)
  view.setUint32(offset + 4, u32(floatingRects.length), true)
  offset += 8
  for (const rect of floatingRects) {
    view.setInt32(offset, i32(rect.x), true)
    view.setInt32(offset + 4, i32(rect.y), true)
    view.setInt32(offset + 8, i32(rect.w), true)
    view.setInt32(offset + 12, i32(rect.h), true)
    view.setUint32(offset + 16, u32(rect.window_id ?? 0), true)
    offset += 20
  }
  return writeSharedState(
    window.__DERP_SHELL_EXCLUSION_STATE_PATH,
    payload,
    KIND_EXCLUSION_ZONES,
  )
}
