import type { DerpShellDetail } from './app/appWindowState'
import type { WorkspaceState } from './workspaceState'

const MSG_OUTPUT_GEOMETRY = 5
const MSG_FOCUS_CHANGED = 10
const MSG_WINDOW_LIST = 11
const MSG_OUTPUT_LAYOUT = 44
const MSG_COMPOSITOR_KEYBOARD_LAYOUT = 52
const MSG_COMPOSITOR_VOLUME_OVERLAY = 53
const MSG_COMPOSITOR_TRAY_HINTS = 55
const MSG_COMPOSITOR_TRAY_SNI = 56
const MSG_COMPOSITOR_WORKSPACE_STATE = 57

const SNAPSHOT_MAGIC = 0x44525053
const SNAPSHOT_ABI = 1
const SNAPSHOT_HEADER_BYTES = 32
const MAX_WINDOW_STRING_BYTES = 4096
const MAX_OUTPUT_LAYOUT_NAME_BYTES = 128
const MAX_WINDOW_LIST_ENTRIES = 512
const MAX_OUTPUT_LAYOUT_SCREENS = 16

const utf8 = new TextDecoder()

type SnapshotDecodeResult = {
  sequence: number
  details: DerpShellDetail[]
}

function readUtf8(bytes: Uint8Array, start: number, len: number): string | null {
  if (start < 0 || len < 0 || start + len > bytes.length) return null
  return utf8.decode(bytes.subarray(start, start + len))
}

function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    const part = bytes.subarray(i, Math.min(bytes.length, i + chunk))
    let s = ''
    for (const value of part) s += String.fromCharCode(value)
    out += btoa(s)
  }
  return out
}

function decodeOutputGeometry(view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 20 > view.byteLength) return null
  return {
    type: 'output_geometry',
    logical_width: view.getUint32(offset + 4, true),
    logical_height: view.getUint32(offset + 8, true),
  }
}

function decodeOutputLayout(bytes: Uint8Array, view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 24 > view.byteLength) return null
  const canvasLogicalWidth = view.getUint32(offset + 4, true)
  const canvasLogicalHeight = view.getUint32(offset + 8, true)
  const canvasPhysicalWidth = view.getUint32(offset + 12, true)
  const canvasPhysicalHeight = view.getUint32(offset + 16, true)
  const count = view.getUint32(offset + 20, true)
  if (count === 0 || count > MAX_OUTPUT_LAYOUT_SCREENS) return null
  let cursor = offset + 24
  const screens: NonNullable<Extract<DerpShellDetail, { type: 'output_layout' }>['screens']> = []
  let minX = 0
  let minY = 0
  let haveOrigin = false
  for (let i = 0; i < count; i += 1) {
    if (cursor + 4 > view.byteLength) return null
    const nameLen = view.getUint32(cursor, true)
    cursor += 4
    if (nameLen === 0 || nameLen > MAX_OUTPUT_LAYOUT_NAME_BYTES) return null
    const name = readUtf8(bytes, cursor, nameLen)
    if (name == null) return null
    cursor += nameLen
    if (cursor + 24 > view.byteLength) return null
    const x = view.getInt32(cursor, true)
    const y = view.getInt32(cursor + 4, true)
    const width = view.getUint32(cursor + 8, true)
    const height = view.getUint32(cursor + 12, true)
    const transform = view.getUint32(cursor + 16, true)
    const refreshMilliHz = view.getUint32(cursor + 20, true)
    cursor += 24
    screens.push({
      name,
      x,
      y,
      width,
      height,
      transform,
      refresh_milli_hz: refreshMilliHz,
    })
    if (!haveOrigin) {
      minX = x
      minY = y
      haveOrigin = true
    } else {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
    }
  }
  if (cursor + 4 > view.byteLength) return null
  const primaryLen = view.getUint32(cursor, true)
  cursor += 4
  if (primaryLen > MAX_OUTPUT_LAYOUT_NAME_BYTES) return null
  const shellChromePrimary = primaryLen === 0 ? null : readUtf8(bytes, cursor, primaryLen)
  if (shellChromePrimary === null && primaryLen !== 0) return null
  cursor += primaryLen
  if (cursor + 4 > view.byteLength) return null
  const contextMenuAtlasBufferH = view.getUint32(cursor, true)
  cursor += 4
  if (cursor !== view.byteLength) return null
  return {
    type: 'output_layout',
    canvas_logical_width: canvasLogicalWidth,
    canvas_logical_height: canvasLogicalHeight,
    canvas_logical_origin_x: minX,
    canvas_logical_origin_y: minY,
    canvas_physical_width: canvasPhysicalWidth,
    canvas_physical_height: canvasPhysicalHeight,
    context_menu_atlas_buffer_h: contextMenuAtlasBufferH,
    screens,
    shell_chrome_primary: shellChromePrimary,
  }
}

function decodeWindowList(bytes: Uint8Array, view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 8 > view.byteLength) return null
  const count = view.getUint32(offset + 4, true)
  if (count > MAX_WINDOW_LIST_ENTRIES) return null
  let cursor = offset + 8
  const windows: unknown[] = []
  for (let i = 0; i < count; i += 1) {
    if (cursor + 56 > view.byteLength) return null
    const windowId = view.getUint32(cursor, true)
    const surfaceId = view.getUint32(cursor + 4, true)
    const stackZ = view.getUint32(cursor + 8, true)
    const x = view.getInt32(cursor + 12, true)
    const y = view.getInt32(cursor + 16, true)
    const width = view.getInt32(cursor + 20, true)
    const height = view.getInt32(cursor + 24, true)
    const minimized = view.getUint32(cursor + 28, true) !== 0
    const maximized = view.getUint32(cursor + 32, true) !== 0
    const fullscreen = view.getUint32(cursor + 36, true) !== 0
    const clientSideDecoration = view.getUint32(cursor + 40, true) !== 0
    const shellFlags = view.getUint32(cursor + 44, true)
    const titleLen = view.getUint32(cursor + 48, true)
    const appLen = view.getUint32(cursor + 52, true)
    cursor += 56
    if (titleLen > MAX_WINDOW_STRING_BYTES || appLen > MAX_WINDOW_STRING_BYTES) return null
    const title = readUtf8(bytes, cursor, titleLen)
    if (title == null) return null
    cursor += titleLen
    const appId = readUtf8(bytes, cursor, appLen)
    if (appId == null) return null
    cursor += appLen
    if (cursor + 4 > view.byteLength) return null
    const outputLen = view.getUint32(cursor, true)
    cursor += 4
    if (outputLen > MAX_WINDOW_STRING_BYTES) return null
    const outputName = readUtf8(bytes, cursor, outputLen)
    if (outputName == null) return null
    cursor += outputLen
    if (cursor + 4 > view.byteLength) return null
    const captureLen = view.getUint32(cursor, true)
    cursor += 4
    if (captureLen > MAX_WINDOW_STRING_BYTES) return null
    const captureIdentifier = readUtf8(bytes, cursor, captureLen)
    if (captureIdentifier == null) return null
    cursor += captureLen
    windows.push({
      window_id: windowId,
      surface_id: surfaceId,
      stack_z: stackZ,
      x,
      y,
      width,
      height,
      minimized,
      maximized,
      fullscreen,
      client_side_decoration: clientSideDecoration,
      shell_flags: shellFlags,
      title,
      app_id: appId,
      output_name: outputName,
      capture_identifier: captureIdentifier,
    })
  }
  if (cursor !== view.byteLength) return null
  return { type: 'window_list', windows }
}

function decodeFocusChanged(view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 12 > view.byteLength) return null
  const surfaceId = view.getUint32(offset + 4, true)
  const windowId = view.getUint32(offset + 8, true)
  return {
    type: 'focus_changed',
    surface_id: surfaceId === 0 ? null : surfaceId,
    window_id: windowId === 0 ? null : windowId,
  }
}

function decodeKeyboardLayout(bytes: Uint8Array, view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 8 > view.byteLength) return null
  const labelLen = view.getUint32(offset + 4, true)
  const label = readUtf8(bytes, offset + 8, labelLen)
  if (label == null || offset + 8 + labelLen !== view.byteLength) return null
  return { type: 'keyboard_layout', label }
}

function decodeVolumeOverlay(view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 8 > view.byteLength) return null
  const volumeLinearPercentX100 = view.getUint16(offset + 4, true)
  const flags = view.getUint16(offset + 6, true)
  return {
    type: 'volume_overlay',
    volume_linear_percent_x100: volumeLinearPercentX100,
    muted: (flags & 1) !== 0,
    state_known: (flags & 2) !== 0,
  }
}

function decodeTrayHints(view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 16 > view.byteLength) return null
  return {
    type: 'tray_hints',
    slot_count: view.getUint32(offset + 4, true),
    slot_w: view.getInt32(offset + 8, true),
    reserved_w: view.getUint32(offset + 12, true),
  }
}

function decodeTraySni(bytes: Uint8Array, view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 8 > view.byteLength) return null
  const count = view.getUint32(offset + 4, true)
  let cursor = offset + 8
  const items: { id: string; title: string; icon_base64: string }[] = []
  for (let i = 0; i < count; i += 1) {
    if (cursor + 4 > view.byteLength) return null
    const idLen = view.getUint32(cursor, true)
    cursor += 4
    if (idLen > MAX_WINDOW_STRING_BYTES) return null
    const id = readUtf8(bytes, cursor, idLen)
    if (id == null) return null
    cursor += idLen
    if (cursor + 4 > view.byteLength) return null
    const titleLen = view.getUint32(cursor, true)
    cursor += 4
    if (titleLen > MAX_WINDOW_STRING_BYTES) return null
    const title = readUtf8(bytes, cursor, titleLen)
    if (title == null) return null
    cursor += titleLen
    if (cursor + 4 > view.byteLength) return null
    const iconLen = view.getUint32(cursor, true)
    cursor += 4
    if (cursor + iconLen > view.byteLength) return null
    const iconBase64 = bytesToBase64(bytes.subarray(cursor, cursor + iconLen))
    cursor += iconLen
    items.push({ id, title, icon_base64: iconBase64 })
  }
  if (cursor !== view.byteLength) return null
  return { type: 'tray_sni', items }
}

function decodeWorkspaceState(bytes: Uint8Array, view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 8 > view.byteLength) return null
  const jsonLen = view.getUint32(offset + 4, true)
  if (jsonLen === 0) return null
  const json = readUtf8(bytes, offset + 8, jsonLen)
  if (json == null) return null
  try {
    return {
      type: 'workspace_state',
      state: JSON.parse(json) as WorkspaceState,
    }
  } catch {
    return null
  }
}

export function decodeCompositorSnapshot(buffer: ArrayBufferLike): SnapshotDecodeResult | null {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.byteLength < SNAPSHOT_HEADER_BYTES) return null
  const magic = view.getUint32(0, true)
  const abiVersion = view.getUint32(4, true)
  const payloadLen = view.getUint32(8, true)
  const sequence = view.getBigUint64(16, true)
  if (
    magic !== SNAPSHOT_MAGIC ||
    abiVersion !== SNAPSHOT_ABI ||
    sequence % 2n !== 0n ||
    SNAPSHOT_HEADER_BYTES + payloadLen > view.byteLength
  ) {
    return null
  }
  const payloadStart = SNAPSHOT_HEADER_BYTES
  const payloadEnd = payloadStart + payloadLen
  const details: DerpShellDetail[] = []
  let offset = payloadStart
  while (offset < payloadEnd) {
    if (offset + 8 > payloadEnd) return null
    const bodyLen = view.getUint32(offset, true)
    const bodyStart = offset + 4
    const bodyEnd = bodyStart + bodyLen
    if (bodyEnd > payloadEnd || bodyStart + 4 > bodyEnd) return null
    const msgType = view.getUint32(bodyStart, true)
    const bodyBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + bodyStart, bodyLen)
    const bodyView = new DataView(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength)
    let detail: DerpShellDetail | null = null
    switch (msgType) {
      case MSG_OUTPUT_GEOMETRY:
        detail = decodeOutputGeometry(bodyView, 0)
        break
      case MSG_OUTPUT_LAYOUT:
        detail = decodeOutputLayout(bodyBytes, bodyView, 0)
        break
      case MSG_WINDOW_LIST:
        detail = decodeWindowList(bodyBytes, bodyView, 0)
        break
      case MSG_FOCUS_CHANGED:
        detail = decodeFocusChanged(bodyView, 0)
        break
      case MSG_COMPOSITOR_KEYBOARD_LAYOUT:
        detail = decodeKeyboardLayout(bodyBytes, bodyView, 0)
        break
      case MSG_COMPOSITOR_VOLUME_OVERLAY:
        detail = decodeVolumeOverlay(bodyView, 0)
        break
      case MSG_COMPOSITOR_TRAY_HINTS:
        detail = decodeTrayHints(bodyView, 0)
        break
      case MSG_COMPOSITOR_TRAY_SNI:
        detail = decodeTraySni(bodyBytes, bodyView, 0)
        break
      case MSG_COMPOSITOR_WORKSPACE_STATE:
        detail = decodeWorkspaceState(bodyBytes, bodyView, 0)
        break
      default:
        break
    }
    if (detail) details.push(detail)
    offset = bodyEnd
  }
  return {
    sequence: Number(sequence),
    details,
  }
}

export function compositorSnapshotAbi(): number {
  return SNAPSHOT_ABI
}
