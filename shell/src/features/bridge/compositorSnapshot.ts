import type { DerpShellDetail } from '@/host/appWindowState'
import { normalizeWorkspaceSnapshot } from '@/features/workspace/workspaceSnapshot'
import {
  MAX_OUTPUT_LAYOUT_NAME_BYTES,
  MAX_OUTPUT_LAYOUT_SCREENS,
  MAX_WINDOW_ICON_BUFFERS,
  MAX_WINDOW_LIST_ENTRIES,
  MAX_WINDOW_STRING_BYTES,
  MSG_COMPOSITOR_COMMAND_PALETTE_STATE,
  MSG_COMPOSITOR_INTERACTION_STATE,
  MSG_COMPOSITOR_KEYBOARD_LAYOUT,
  MSG_COMPOSITOR_NATIVE_DRAG_PREVIEW,
  MSG_COMPOSITOR_SHELL_HOSTED_APP_STATE,
  MSG_COMPOSITOR_TRAY_HINTS,
  MSG_COMPOSITOR_TRAY_SNI,
  MSG_COMPOSITOR_VOLUME_OVERLAY,
  MSG_COMPOSITOR_WORKSPACE_STATE,
  MSG_COMPOSITOR_WORKSPACE_STATE_BINARY,
  MSG_FOCUS_CHANGED,
  MSG_OUTPUT_GEOMETRY,
  MSG_OUTPUT_LAYOUT,
  MSG_WINDOW_GEOMETRY,
  MSG_WINDOW_LIST,
  MSG_WINDOW_MAPPED,
  MSG_WINDOW_METADATA,
  MSG_WINDOW_ORDER,
  MSG_WINDOW_STATE,
  MSG_WINDOW_UNMAPPED,
  SHELL_SHARED_SNAPSHOT_HEADER_BYTES as SNAPSHOT_HEADER_BYTES,
  SHELL_SHARED_SNAPSHOT_MAGIC as SNAPSHOT_MAGIC,
  SHELL_SNAPSHOT_DOMAIN_CHUNKS_MAGIC as SNAPSHOT_DOMAIN_CHUNKS_MAGIC,
  SHELL_SNAPSHOT_DOMAIN_COMMAND_PALETTE as SNAPSHOT_DOMAIN_COMMAND_PALETTE,
  SHELL_SNAPSHOT_DOMAIN_COUNT as SNAPSHOT_DOMAIN_COUNT,
  SHELL_SNAPSHOT_DOMAIN_FOCUS as SNAPSHOT_DOMAIN_FOCUS,
  SHELL_SNAPSHOT_DOMAIN_INTERACTION as SNAPSHOT_DOMAIN_INTERACTION,
  SHELL_SNAPSHOT_DOMAIN_KEYBOARD as SNAPSHOT_DOMAIN_KEYBOARD,
  SHELL_SNAPSHOT_DOMAIN_NATIVE_DRAG_PREVIEW as SNAPSHOT_DOMAIN_NATIVE_DRAG_PREVIEW,
  SHELL_SNAPSHOT_DOMAIN_OUTPUTS as SNAPSHOT_DOMAIN_OUTPUTS,
  SHELL_SNAPSHOT_DOMAIN_REVISION_BYTES as SNAPSHOT_DOMAIN_REVISION_BYTES,
  SHELL_SNAPSHOT_DOMAIN_SHELL_HOSTED_APPS as SNAPSHOT_DOMAIN_SHELL_HOSTED_APPS,
  SHELL_SNAPSHOT_DOMAIN_TRAY as SNAPSHOT_DOMAIN_TRAY,
  SHELL_SNAPSHOT_DOMAIN_WINDOWS as SNAPSHOT_DOMAIN_WINDOWS,
  SHELL_SNAPSHOT_DOMAIN_WORKSPACE as SNAPSHOT_DOMAIN_WORKSPACE,
  SHELL_SNAPSHOT_DOMAIN_WINDOW_GEOMETRY as SNAPSHOT_DOMAIN_WINDOW_GEOMETRY,
  SHELL_SNAPSHOT_DOMAIN_WINDOW_METADATA as SNAPSHOT_DOMAIN_WINDOW_METADATA,
  SHELL_SNAPSHOT_DOMAIN_WINDOW_ORDER as SNAPSHOT_DOMAIN_WINDOW_ORDER,
  SHELL_SNAPSHOT_DOMAIN_WINDOW_STATE as SNAPSHOT_DOMAIN_WINDOW_STATE,
  WINDOW_GEOMETRY_RECTS_BYTES,
  WINDOW_GEOMETRY_RECTS_SCHEMA_VERSION,
  WINDOW_LIST_HEADER_BYTES,
  WINDOW_LIST_HEADER_BYTES_V1,
  WINDOW_LIST_ROW_BYTES,
  WINDOW_LIST_ROW_BYTES_V1,
  WINDOW_LIST_SCHEMA_VERSION,
  type ShellWindowListRow,
  type ShellWindowOrderEntry,
} from './wireSchema.generated'

const utf8 = new TextDecoder()

type SnapshotDecodeResult = {
  sequence: number
  domainFlags: number
  domainRevisions: readonly number[]
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
  if (offset + 32 > view.byteLength) return null
  const revision = Number(view.getBigUint64(offset + 4, true))
  const canvasLogicalWidth = view.getUint32(offset + 12, true)
  const canvasLogicalHeight = view.getUint32(offset + 16, true)
  const canvasPhysicalWidth = view.getUint32(offset + 20, true)
  const canvasPhysicalHeight = view.getUint32(offset + 24, true)
  const count = view.getUint32(offset + 28, true)
  if (count === 0 || count > MAX_OUTPUT_LAYOUT_SCREENS) return null
  let cursor = offset + 32
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
    if (cursor + 4 > view.byteLength) return null
    const identityLen = view.getUint32(cursor, true)
    cursor += 4
    if (identityLen > MAX_OUTPUT_LAYOUT_NAME_BYTES) return null
    const identity = readUtf8(bytes, cursor, identityLen)
    if (identity == null) return null
    cursor += identityLen
    if (cursor + 32 > view.byteLength) return null
    const x = view.getInt32(cursor, true)
    const y = view.getInt32(cursor + 4, true)
    const width = view.getUint32(cursor + 8, true)
    const height = view.getUint32(cursor + 12, true)
    const transform = view.getUint32(cursor + 16, true)
    const refreshMilliHz = view.getUint32(cursor + 20, true)
    const vrrSupported = view.getUint32(cursor + 24, true)
    const vrrEnabled = view.getUint32(cursor + 28, true)
    if (vrrSupported > 1 || vrrEnabled > 1 || vrrEnabled > vrrSupported) return null
    const maxPhysicalWidth = Math.max(canvasPhysicalWidth, canvasLogicalWidth, width, 1) * 8
    const maxPhysicalHeight = Math.max(canvasPhysicalHeight, canvasLogicalHeight, height, 1) * 8
    const tailPhysicalWidth = cursor + 40 <= view.byteLength ? view.getUint32(cursor + 32, true) : 0
    const tailPhysicalHeight = cursor + 40 <= view.byteLength ? view.getUint32(cursor + 36, true) : 0
    const hasPhysicalTail =
      tailPhysicalWidth >= 1 &&
      tailPhysicalWidth <= maxPhysicalWidth &&
      tailPhysicalHeight >= 1 &&
      tailPhysicalHeight <= maxPhysicalHeight
    const physicalWidth = hasPhysicalTail ? tailPhysicalWidth : Math.max(1, width)
    const physicalHeight = hasPhysicalTail ? tailPhysicalHeight : Math.max(1, height)
    cursor += hasPhysicalTail ? 40 : 32
    screens.push({
      name,
      identity,
      x,
      y,
      width,
      height,
      usable_x: x,
      usable_y: y,
      usable_width: Math.max(1, width),
      usable_height: Math.max(1, height),
      physical_width: physicalWidth,
      physical_height: physicalHeight,
      transform,
      refresh_milli_hz: refreshMilliHz,
      vrr_supported: vrrSupported !== 0,
      vrr_enabled: vrrEnabled !== 0,
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
  let taskbarAutoHide = false
  if (cursor < view.byteLength) {
    if (cursor + 8 > view.byteLength) return null
    const autoHide = view.getUint32(cursor, true)
    cursor += 4
    if (autoHide > 1) return null
    taskbarAutoHide = autoHide !== 0
    const sideCount = view.getUint32(cursor, true)
    cursor += 4
    if (sideCount > MAX_OUTPUT_LAYOUT_SCREENS) return null
    for (let i = 0; i < sideCount; i += 1) {
      if (cursor + 4 > view.byteLength) return null
      const nameLen = view.getUint32(cursor, true)
      cursor += 4
      if (nameLen === 0 || nameLen > MAX_OUTPUT_LAYOUT_NAME_BYTES) return null
      const name = readUtf8(bytes, cursor, nameLen)
      if (name == null) return null
      cursor += nameLen
      if (cursor + 4 > view.byteLength) return null
      const side = view.getUint32(cursor, true)
      cursor += 4
      const taskbarSide =
        side === 1 ? 'top' : side === 2 ? 'left' : side === 3 ? 'right' : side === 0 ? 'bottom' : null
      if (taskbarSide === null) return null
      const screen = screens.find((entry) => entry.name === name)
      if (screen) screen.taskbar_side = taskbarSide
    }
  }
  if (cursor < view.byteLength) {
    if (cursor + 4 > view.byteLength) return null
    const usableCount = view.getUint32(cursor, true)
    cursor += 4
    if (usableCount > MAX_OUTPUT_LAYOUT_SCREENS) return null
    for (let i = 0; i < usableCount; i += 1) {
      if (cursor + 4 > view.byteLength) return null
      const nameLen = view.getUint32(cursor, true)
      cursor += 4
      if (nameLen === 0 || nameLen > MAX_OUTPUT_LAYOUT_NAME_BYTES) return null
      const name = readUtf8(bytes, cursor, nameLen)
      if (name == null) return null
      cursor += nameLen
      if (cursor + 16 > view.byteLength) return null
      const usableX = view.getInt32(cursor, true)
      const usableY = view.getInt32(cursor + 4, true)
      const usableWidth = view.getUint32(cursor + 8, true)
      const usableHeight = view.getUint32(cursor + 12, true)
      cursor += 16
      const screen = screens.find((entry) => entry.name === name)
      if (screen) {
        screen.usable_x = usableX
        screen.usable_y = usableY
        screen.usable_width = Math.max(1, usableWidth)
        screen.usable_height = Math.max(1, usableHeight)
      }
    }
  }
  if (cursor !== view.byteLength) return null
  return {
    type: 'output_layout',
    revision,
    canvas_logical_width: canvasLogicalWidth,
    canvas_logical_height: canvasLogicalHeight,
    canvas_logical_origin_x: minX,
    canvas_logical_origin_y: minY,
    canvas_physical_width: canvasPhysicalWidth,
    canvas_physical_height: canvasPhysicalHeight,
    screens: screens.map((screen) => ({ taskbar_side: 'bottom' as const, ...screen })),
    shell_chrome_primary: shellChromePrimary,
    taskbar_auto_hide: taskbarAutoHide,
  }
}

function decodeWindowList(bytes: Uint8Array, view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 16 > view.byteLength) return null
  const revision = Number(view.getBigUint64(offset + 4, true))
  const count = view.getUint32(offset + 12, true)
  if (count > MAX_WINDOW_LIST_ENTRIES) return null
  let cursor = offset + WINDOW_LIST_HEADER_BYTES_V1
  let rowBytes: number = WINDOW_LIST_ROW_BYTES_V1
  if (offset + WINDOW_LIST_HEADER_BYTES <= view.byteLength) {
    const schemaVersion = view.getUint32(offset + 16, true)
    const candidateRowBytes = view.getUint32(offset + 20, true)
    if (schemaVersion === WINDOW_LIST_SCHEMA_VERSION) {
      if (candidateRowBytes !== WINDOW_LIST_ROW_BYTES) return null
      cursor = offset + WINDOW_LIST_HEADER_BYTES
      rowBytes = WINDOW_LIST_ROW_BYTES
    }
  }
  const windows: ShellWindowListRow[] = []
  for (let i = 0; i < count; i += 1) {
    if (cursor + rowBytes > view.byteLength) return null
    const windowId = view.getUint32(cursor, true)
    const surfaceId = view.getUint32(cursor + 4, true)
    const stackZ = view.getUint32(cursor + 8, true)
    const x = view.getInt32(cursor + 12, true)
    const y = view.getInt32(cursor + 16, true)
    const width = view.getInt32(cursor + 20, true)
    const height = view.getInt32(cursor + 24, true)
    const clientX = rowBytes === WINDOW_LIST_ROW_BYTES ? view.getInt32(cursor + 28, true) : x
    const clientY = rowBytes === WINDOW_LIST_ROW_BYTES ? view.getInt32(cursor + 32, true) : y
    const clientWidth = rowBytes === WINDOW_LIST_ROW_BYTES ? view.getInt32(cursor + 36, true) : width
    const clientHeight = rowBytes === WINDOW_LIST_ROW_BYTES ? view.getInt32(cursor + 40, true) : height
    const frameX = rowBytes === WINDOW_LIST_ROW_BYTES ? view.getInt32(cursor + 44, true) : x
    const frameY = rowBytes === WINDOW_LIST_ROW_BYTES ? view.getInt32(cursor + 48, true) : y
    const frameWidth = rowBytes === WINDOW_LIST_ROW_BYTES ? view.getInt32(cursor + 52, true) : width
    const frameHeight = rowBytes === WINDOW_LIST_ROW_BYTES ? view.getInt32(cursor + 56, true) : height
    const restoreX = rowBytes === WINDOW_LIST_ROW_BYTES ? view.getInt32(cursor + 60, true) : 0
    const restoreY = rowBytes === WINDOW_LIST_ROW_BYTES ? view.getInt32(cursor + 64, true) : 0
    const restoreWidth = rowBytes === WINDOW_LIST_ROW_BYTES ? view.getInt32(cursor + 68, true) : 0
    const restoreHeight = rowBytes === WINDOW_LIST_ROW_BYTES ? view.getInt32(cursor + 72, true) : 0
    const minimizedOffset = rowBytes === WINDOW_LIST_ROW_BYTES ? 76 : 28
    const minimized = view.getUint32(cursor + minimizedOffset, true) !== 0
    const maximized = view.getUint32(cursor + minimizedOffset + 4, true) !== 0
    const fullscreen = view.getUint32(cursor + minimizedOffset + 8, true) !== 0
    const clientSideDecoration = view.getUint32(cursor + minimizedOffset + 12, true) !== 0
    const workspaceVisible = view.getUint32(cursor + minimizedOffset + 16, true) !== 0
    const shellFlags = view.getUint32(cursor + minimizedOffset + 20, true)
    const titleLen = view.getUint32(cursor + minimizedOffset + 24, true)
    const appLen = view.getUint32(cursor + minimizedOffset + 28, true)
    cursor += rowBytes
    if (titleLen > MAX_WINDOW_STRING_BYTES || appLen > MAX_WINDOW_STRING_BYTES) return null
    const title = readUtf8(bytes, cursor, titleLen)
    if (title == null) return null
    cursor += titleLen
    const appId = readUtf8(bytes, cursor, appLen)
    if (appId == null) return null
    cursor += appLen
    if (cursor + 4 > view.byteLength) return null
    const outputIdLen = view.getUint32(cursor, true)
    cursor += 4
    if (outputIdLen > MAX_WINDOW_STRING_BYTES) return null
    const outputId = readUtf8(bytes, cursor, outputIdLen)
    if (outputId == null) return null
    cursor += outputIdLen
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
    if (cursor + 4 > view.byteLength) return null
    const kindLen = view.getUint32(cursor, true)
    cursor += 4
    if (kindLen > MAX_WINDOW_STRING_BYTES) return null
    const kind = readUtf8(bytes, cursor, kindLen)
    if (kind == null) return null
    cursor += kindLen
    if (cursor + 4 > view.byteLength) return null
    const x11ClassLen = view.getUint32(cursor, true)
    cursor += 4
    if (x11ClassLen > MAX_WINDOW_STRING_BYTES) return null
    const x11Class = readUtf8(bytes, cursor, x11ClassLen)
    if (x11Class == null) return null
    cursor += x11ClassLen
    if (cursor + 4 > view.byteLength) return null
    const x11InstanceLen = view.getUint32(cursor, true)
    cursor += 4
    if (x11InstanceLen > MAX_WINDOW_STRING_BYTES) return null
    const x11Instance = readUtf8(bytes, cursor, x11InstanceLen)
    if (x11Instance == null) return null
    cursor += x11InstanceLen
    if (cursor + 8 > view.byteLength) return null
    const iconNameLen = view.getUint32(cursor, true)
    cursor += 4
    if (iconNameLen > MAX_WINDOW_STRING_BYTES) return null
    const iconName = readUtf8(bytes, cursor, iconNameLen)
    if (iconName == null) return null
    cursor += iconNameLen
    const iconBufferCount = view.getUint32(cursor, true)
    cursor += 4
    if (iconBufferCount > MAX_WINDOW_ICON_BUFFERS) return null
    if (cursor + iconBufferCount * 12 > view.byteLength) return null
    const iconBuffers: Array<{ width: number; height: number; scale: number }> = []
    for (let iconIndex = 0; iconIndex < iconBufferCount; iconIndex += 1) {
      iconBuffers.push({
        width: view.getInt32(cursor, true),
        height: view.getInt32(cursor + 4, true),
        scale: view.getInt32(cursor + 8, true),
      })
      cursor += 12
    }
    windows.push({
      window_id: windowId,
      surface_id: surfaceId,
      stack_z: stackZ,
      x,
      y,
      width,
      height,
      client_x: clientX,
      client_y: clientY,
      client_width: clientWidth,
      client_height: clientHeight,
      frame_x: frameX,
      frame_y: frameY,
      frame_width: frameWidth,
      frame_height: frameHeight,
      restore_x: restoreX,
      restore_y: restoreY,
      restore_width: restoreWidth,
      restore_height: restoreHeight,
      minimized,
      maximized,
      fullscreen,
      client_side_decoration: clientSideDecoration,
      workspace_visible: workspaceVisible,
      shell_flags: shellFlags,
      title,
      app_id: appId,
      icon_name: iconName,
      icon_buffers: iconBuffers,
      output_id: outputId,
      output_name: outputName,
      capture_identifier: captureIdentifier,
      kind,
      x11_class: x11Class,
      x11_instance: x11Instance,
    })
  }
  if (cursor !== view.byteLength) return null
  return { type: 'window_list', revision, windows }
}

function decodeWindowUnmapped(view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 8 !== view.byteLength) return null
  return { type: 'window_unmapped', window_id: view.getUint32(offset + 4, true) }
}

function decodeWindowGeometry(bytes: Uint8Array, view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 28 > view.byteLength) return null
  const windowId = view.getUint32(offset + 4, true)
  const surfaceId = view.getUint32(offset + 8, true)
  const x = view.getInt32(offset + 12, true)
  const y = view.getInt32(offset + 16, true)
  const width = view.getInt32(offset + 20, true)
  const height = view.getInt32(offset + 24, true)
  let cursor = offset + 28
  let maximized = false
  let fullscreen = false
  let client_side_decoration = false
  if (cursor + 8 <= view.byteLength) {
    maximized = view.getUint32(cursor, true) !== 0
    fullscreen = view.getUint32(cursor + 4, true) !== 0
    cursor += 8
  }
  if (cursor + 4 <= view.byteLength) {
    client_side_decoration = view.getUint32(cursor, true) !== 0
    cursor += 4
  }
  let outputName = ''
  let rectCursor = cursor
  if (cursor < view.byteLength) {
    if (cursor + 4 > view.byteLength) return null
    const len = view.getUint32(cursor, true)
    cursor += 4
    if (len > MAX_WINDOW_STRING_BYTES) return null
    const value = readUtf8(bytes, cursor, len)
    if (value == null) return null
    outputName = value
    cursor += len
    rectCursor = cursor
  }
  let client_x = x
  let client_y = y
  let client_width = width
  let client_height = height
  let frame_x = x
  let frame_y = y
  let frame_width = width
  let frame_height = height
  if (cursor !== view.byteLength) {
    if (view.byteLength !== rectCursor + WINDOW_GEOMETRY_RECTS_BYTES) return null
    const schema = view.getUint32(rectCursor, true)
    if (schema !== WINDOW_GEOMETRY_RECTS_SCHEMA_VERSION) return null
    client_x = view.getInt32(rectCursor + 4, true)
    client_y = view.getInt32(rectCursor + 8, true)
    client_width = view.getInt32(rectCursor + 12, true)
    client_height = view.getInt32(rectCursor + 16, true)
    frame_x = view.getInt32(rectCursor + 20, true)
    frame_y = view.getInt32(rectCursor + 24, true)
    frame_width = view.getInt32(rectCursor + 28, true)
    frame_height = view.getInt32(rectCursor + 32, true)
    cursor = view.byteLength
  }
  if (cursor !== view.byteLength) return null
  return {
    type: 'window_geometry',
    window_id: windowId,
    surface_id: surfaceId,
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
    output_id: '',
    output_name: outputName,
    maximized,
    fullscreen,
    client_side_decoration,
  }
}

function decodeWindowMetadata(bytes: Uint8Array, view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 36 > view.byteLength) return null
  const windowId = view.getUint32(offset + 4, true)
  const surfaceId = view.getUint32(offset + 8, true)
  const titleLen = view.getUint32(offset + 28, true)
  const appLen = view.getUint32(offset + 32, true)
  if (titleLen > MAX_WINDOW_STRING_BYTES) return null
  if (appLen > MAX_WINDOW_STRING_BYTES) return null
  let cursor = offset + 36
  const title = readUtf8(bytes, cursor, titleLen)
  if (title == null) return null
  cursor += titleLen
  const appId = readUtf8(bytes, cursor, appLen)
  if (appId == null) return null
  cursor += appLen
  let iconName = ''
  let iconBuffers: Array<{ width: number; height: number; scale: number }> = []
  if (cursor !== view.byteLength) {
    if (cursor + 8 > view.byteLength) return null
    const iconNameLen = view.getUint32(cursor, true)
    cursor += 4
    if (iconNameLen > MAX_WINDOW_STRING_BYTES) return null
    const nextIconName = readUtf8(bytes, cursor, iconNameLen)
    if (nextIconName == null) return null
    iconName = nextIconName
    cursor += iconNameLen
    const iconBufferCount = view.getUint32(cursor, true)
    cursor += 4
    if (iconBufferCount > MAX_WINDOW_ICON_BUFFERS) return null
    if (cursor + iconBufferCount * 12 > view.byteLength) return null
    iconBuffers = []
    for (let iconIndex = 0; iconIndex < iconBufferCount; iconIndex += 1) {
      iconBuffers.push({
        width: view.getInt32(cursor, true),
        height: view.getInt32(cursor + 4, true),
        scale: view.getInt32(cursor + 8, true),
      })
      cursor += 12
    }
  }
  if (cursor !== view.byteLength) return null
  return {
    type: 'window_metadata',
    window_id: windowId,
    surface_id: surfaceId,
    title,
    app_id: appId,
    icon_name: iconName,
    icon_buffers: iconBuffers,
  }
}

function decodeWindowState(view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 12 !== view.byteLength) return null
  return {
    type: 'window_state',
    window_id: view.getUint32(offset + 4, true),
    minimized: view.getUint32(offset + 8, true) !== 0,
  }
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

function decodeWindowOrder(view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 16 > view.byteLength) return null
  const revision = Number(view.getBigUint64(offset + 4, true))
  const count = view.getUint32(offset + 12, true)
  if (count > MAX_WINDOW_LIST_ENTRIES || offset + 16 + count * 8 !== view.byteLength) return null
  const windows: ShellWindowOrderEntry[] = []
  let cursor = offset + 16
  for (let index = 0; index < count; index += 1) {
    windows.push({
      window_id: view.getUint32(cursor, true),
      stack_z: view.getUint32(cursor + 4, true),
    })
    cursor += 8
  }
  return { type: 'window_order', revision, windows }
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

function decodeShellHostedAppState(bytes: Uint8Array, view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 16 > view.byteLength) return null
  const revision = Number(view.getBigUint64(offset + 4, true))
  const jsonLen = view.getUint32(offset + 12, true)
  if (jsonLen === 0) return null
  const json = readUtf8(bytes, offset + 16, jsonLen)
  if (json == null || offset + 16 + jsonLen !== view.byteLength) return null
  try {
    const state = JSON.parse(json) as { byWindowId?: Record<string, unknown> }
    return { type: 'shell_hosted_app_state', revision, state }
  } catch {
    return null
  }
}

function decodeCommandPaletteState(bytes: Uint8Array, view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 16 > view.byteLength) return null
  const revision = Number(view.getBigUint64(offset + 4, true))
  const jsonLen = view.getUint32(offset + 12, true)
  if (jsonLen === 0) return null
  const json = readUtf8(bytes, offset + 16, jsonLen)
  if (json == null || offset + 16 + jsonLen !== view.byteLength) return null
  try {
    const state = JSON.parse(json)
    return { type: 'command_palette_state', revision, state }
  } catch {
    return null
  }
}

function decodeInteractionState(view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 80 !== view.byteLength && offset + 88 !== view.byteLength && offset + 92 !== view.byteLength) return null
  const decodeVisual = (windowId: number, base: number) => {
    if (windowId <= 0) return null
    const flags = view.getUint32(base + 16, true)
    return {
      x: view.getInt32(base, true),
      y: view.getInt32(base + 4, true),
      width: view.getInt32(base + 8, true),
      height: view.getInt32(base + 12, true),
      maximized: (flags & 1) !== 0,
      fullscreen: (flags & 2) !== 0,
    }
  }
  const revision = Number(view.getBigUint64(offset + 4, true))
  const moveWindowId = view.getUint32(offset + 20, true)
  const resizeWindowId = view.getUint32(offset + 24, true)
  const moveProxyWindowId = view.getUint32(offset + 28, true)
  const moveCaptureWindowId = view.getUint32(offset + 32, true)
  const windowSwitcherSelectedWindowId = view.getUint32(offset + 76, true)
  const interactionSerial = offset + 88 <= view.byteLength ? Number(view.getBigUint64(offset + 80, true)) : 0
  const superHeld = offset + 92 === view.byteLength && view.getUint32(offset + 88, true) !== 0
  return {
    type: 'interaction_state',
    revision,
    interaction_serial: interactionSerial,
    pointer_x: view.getInt32(offset + 12, true),
    pointer_y: view.getInt32(offset + 16, true),
    move_window_id: moveWindowId > 0 ? moveWindowId : null,
    resize_window_id: resizeWindowId > 0 ? resizeWindowId : null,
    move_proxy_window_id: moveProxyWindowId > 0 ? moveProxyWindowId : null,
    move_capture_window_id: moveCaptureWindowId > 0 ? moveCaptureWindowId : null,
    move_rect: decodeVisual(moveWindowId, offset + 36),
    resize_rect: decodeVisual(resizeWindowId, offset + 56),
    window_switcher_selected_window_id:
      windowSwitcherSelectedWindowId > 0 ? windowSwitcherSelectedWindowId : null,
    ...(superHeld ? { super_held: true } : {}),
  }
}

function decodeNativeDragPreview(bytes: Uint8Array, view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 16 > view.byteLength) return null
  const windowId = view.getUint32(offset + 4, true)
  const generation = view.getUint32(offset + 8, true)
  const pathLen = view.getUint32(offset + 12, true)
  if (windowId === 0 || generation === 0 || pathLen > MAX_WINDOW_STRING_BYTES) return null
  const imagePath = readUtf8(bytes, offset + 16, pathLen)
  if (imagePath == null || offset + 16 + pathLen !== view.byteLength) return null
  return {
    type: 'native_drag_preview',
    window_id: windowId,
    generation,
    image_path: imagePath,
  }
}

function decodeWorkspaceState(bytes: Uint8Array, view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 16 > view.byteLength) return null
  const revision = Number(view.getBigUint64(offset + 4, true))
  const jsonLen = view.getUint32(offset + 12, true)
  if (jsonLen === 0) return null
  const json = readUtf8(bytes, offset + 16, jsonLen)
  if (json == null) return null
  try {
    return {
      type: 'workspace_state',
      revision,
      state: normalizeWorkspaceSnapshot(JSON.parse(json)),
    }
  } catch {
    return null
  }
}

function domainForMessageType(msgType: number): number {
  switch (msgType) {
    case MSG_OUTPUT_GEOMETRY:
    case MSG_OUTPUT_LAYOUT:
      return SNAPSHOT_DOMAIN_OUTPUTS
    case MSG_WINDOW_MAPPED:
    case MSG_WINDOW_UNMAPPED:
    case MSG_WINDOW_LIST:
      return SNAPSHOT_DOMAIN_WINDOWS
    case MSG_WINDOW_ORDER:
      return SNAPSHOT_DOMAIN_WINDOW_ORDER
    case MSG_WINDOW_GEOMETRY:
      return SNAPSHOT_DOMAIN_WINDOW_GEOMETRY
    case MSG_WINDOW_METADATA:
      return SNAPSHOT_DOMAIN_WINDOW_METADATA
    case MSG_WINDOW_STATE:
      return SNAPSHOT_DOMAIN_WINDOW_STATE
    case MSG_FOCUS_CHANGED:
      return SNAPSHOT_DOMAIN_FOCUS
    case MSG_COMPOSITOR_KEYBOARD_LAYOUT:
      return SNAPSHOT_DOMAIN_KEYBOARD
    case MSG_COMPOSITOR_WORKSPACE_STATE:
    case MSG_COMPOSITOR_WORKSPACE_STATE_BINARY:
      return SNAPSHOT_DOMAIN_WORKSPACE
    case MSG_COMPOSITOR_SHELL_HOSTED_APP_STATE:
      return SNAPSHOT_DOMAIN_SHELL_HOSTED_APPS
    case MSG_COMPOSITOR_COMMAND_PALETTE_STATE:
      return SNAPSHOT_DOMAIN_COMMAND_PALETTE
    case MSG_COMPOSITOR_INTERACTION_STATE:
      return SNAPSHOT_DOMAIN_INTERACTION
    case MSG_COMPOSITOR_NATIVE_DRAG_PREVIEW:
      return SNAPSHOT_DOMAIN_NATIVE_DRAG_PREVIEW
    case MSG_COMPOSITOR_TRAY_HINTS:
    case MSG_COMPOSITOR_TRAY_SNI:
      return SNAPSHOT_DOMAIN_TRAY
    default:
      return 0
  }
}

class BinaryCursor {
  bytes: Uint8Array
  view: DataView
  offset: number

  constructor(bytes: Uint8Array, view: DataView, offset: number) {
    this.bytes = bytes
    this.view = view
    this.offset = offset
  }

  u32(): number | null {
    if (this.offset + 4 > this.view.byteLength) return null
    const value = this.view.getUint32(this.offset, true)
    this.offset += 4
    return value
  }

  i32(): number | null {
    if (this.offset + 4 > this.view.byteLength) return null
    const value = this.view.getInt32(this.offset, true)
    this.offset += 4
    return value
  }

  f64(): number | null {
    if (this.offset + 8 > this.view.byteLength) return null
    const value = this.view.getFloat64(this.offset, true)
    this.offset += 8
    return value
  }

  string(max = MAX_WINDOW_STRING_BYTES): string | null {
    const len = this.u32()
    if (len === null || len > max) return null
    const value = readUtf8(this.bytes, this.offset, len)
    if (value === null) return null
    this.offset += len
    return value
  }
}

function layoutTypeFromCode(code: number): 'manual-snap' | 'master-stack' | 'columns' | 'grid' | 'custom-auto' {
  if (code === 1) return 'master-stack'
  if (code === 2) return 'columns'
  if (code === 3) return 'grid'
  if (code === 4) return 'custom-auto'
  return 'manual-snap'
}

function ruleFieldFromCode(code: number): 'app_id' | 'title' | 'x11_class' | 'x11_instance' | 'kind' {
  if (code === 1) return 'title'
  if (code === 2) return 'x11_class'
  if (code === 3) return 'x11_instance'
  if (code === 4) return 'kind'
  return 'app_id'
}

function ruleOpFromCode(code: number): 'equals' | 'contains' | 'starts_with' {
  if (code === 1) return 'contains'
  if (code === 2) return 'starts_with'
  return 'equals'
}

function decodeWorkspaceStateBinary(bytes: Uint8Array, view: DataView, offset: number): DerpShellDetail | null {
  if (offset + 12 > view.byteLength) return null
  const revision = Number(view.getBigUint64(offset + 4, true))
  const cursor = new BinaryCursor(bytes, view, offset + 12)
  const groupsCount = cursor.u32()
  if (groupsCount === null) return null
  const groups: unknown[] = []
  for (let i = 0; i < groupsCount; i += 1) {
    const id = cursor.string()
    const count = cursor.u32()
    if (id === null || count === null) return null
    const windowIds: number[] = []
    for (let index = 0; index < count; index += 1) {
      const windowId = cursor.u32()
      if (windowId === null) return null
      windowIds.push(windowId)
    }
    groups.push({ id, windowIds })
  }
  const activeCount = cursor.u32()
  if (activeCount === null) return null
  const activeTabByGroupId: Record<string, number> = {}
  for (let i = 0; i < activeCount; i += 1) {
    const groupId = cursor.string()
    const windowId = cursor.u32()
    if (groupId === null || windowId === null) return null
    activeTabByGroupId[groupId] = windowId
  }
  const pinnedCount = cursor.u32()
  if (pinnedCount === null) return null
  const pinnedWindowIds: number[] = []
  for (let i = 0; i < pinnedCount; i += 1) {
    const windowId = cursor.u32()
    if (windowId === null) return null
    pinnedWindowIds.push(windowId)
  }
  const splitCount = cursor.u32()
  if (splitCount === null) return null
  const splitByGroupId: Record<string, unknown> = {}
  for (let i = 0; i < splitCount; i += 1) {
    const groupId = cursor.string()
    const leftWindowId = cursor.u32()
    const leftPaneFraction = cursor.f64()
    if (groupId === null || leftWindowId === null || leftPaneFraction === null) return null
    splitByGroupId[groupId] = { leftWindowId, leftPaneFraction }
  }
  const monitorTileCount = cursor.u32()
  if (monitorTileCount === null) return null
  const monitorTiles: unknown[] = []
  for (let i = 0; i < monitorTileCount; i += 1) {
    const outputId = cursor.string()
    const outputName = cursor.string()
    const entryCount = cursor.u32()
    if (outputId === null || outputName === null || entryCount === null) return null
    const entries: unknown[] = []
    for (let index = 0; index < entryCount; index += 1) {
      const windowId = cursor.u32()
      const zone = cursor.string()
      const x = cursor.i32()
      const y = cursor.i32()
      const width = cursor.i32()
      const height = cursor.i32()
      if (windowId === null || zone === null || x === null || y === null || width === null || height === null) return null
      entries.push({ windowId, zone, bounds: { x, y, width, height } })
    }
    monitorTiles.push({ outputId, outputName, entries })
  }
  const monitorLayoutCount = cursor.u32()
  if (monitorLayoutCount === null) return null
  const monitorLayouts: unknown[] = []
  for (let i = 0; i < monitorLayoutCount; i += 1) {
    const outputId = cursor.string()
    const outputName = cursor.string()
    const layoutCode = cursor.u32()
    const masterRatio = cursor.f64()
    const maxColumns = cursor.u32()
    const customLayoutId = cursor.string()
    const slotCount = cursor.u32()
    if (outputId === null || outputName === null || layoutCode === null || masterRatio === null || maxColumns === null || customLayoutId === null || slotCount === null) return null
    const customSlots: unknown[] = []
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      const slotId = cursor.string()
      const x = cursor.f64()
      const y = cursor.f64()
      const width = cursor.f64()
      const height = cursor.f64()
      const ruleCount = cursor.u32()
      if (slotId === null || x === null || y === null || width === null || height === null || ruleCount === null) return null
      const rules: unknown[] = []
      for (let ruleIndex = 0; ruleIndex < ruleCount; ruleIndex += 1) {
        const field = cursor.u32()
        const op = cursor.u32()
        const value = cursor.string()
        if (field === null || op === null || value === null) return null
        rules.push({ field: ruleFieldFromCode(field), op: ruleOpFromCode(op), value })
      }
      customSlots.push({ slotId, x, y, width, height, rules })
    }
    const snapLayout = cursor.string()
    const customLayoutsJson = cursor.string()
    if (snapLayout === null || customLayoutsJson === null) return null
    let customLayouts: unknown[] = []
    try {
      const parsed = JSON.parse(customLayoutsJson || '[]')
      if (Array.isArray(parsed)) customLayouts = parsed
    } catch {
      customLayouts = []
    }
    monitorLayouts.push({
      outputId,
      outputName,
      layout: layoutTypeFromCode(layoutCode),
      params: {
        ...(masterRatio > 0 ? { masterRatio } : {}),
        ...(maxColumns > 0 ? { maxColumns } : {}),
        ...(customLayoutId ? { customLayoutId } : {}),
        ...(customSlots.length > 0 ? { customSlots } : {}),
      },
      ...(snapLayout ? { snapLayout } : {}),
      ...(customLayouts.length > 0 ? { customLayouts } : {}),
    })
  }
  const preTileCount = cursor.u32()
  if (preTileCount === null) return null
  const preTileGeometry: unknown[] = []
  for (let i = 0; i < preTileCount; i += 1) {
    const windowId = cursor.u32()
    const x = cursor.i32()
    const y = cursor.i32()
    const width = cursor.i32()
    const height = cursor.i32()
    if (windowId === null || x === null || y === null || width === null || height === null) return null
    preTileGeometry.push({ windowId, bounds: { x, y, width, height } })
  }
  const taskbarPinMonitorCount = cursor.u32()
  if (taskbarPinMonitorCount === null) return null
  const taskbarPins: unknown[] = []
  for (let i = 0; i < taskbarPinMonitorCount; i += 1) {
    const outputId = cursor.string()
    const outputName = cursor.string()
    const pinCount = cursor.u32()
    if (outputId === null || outputName === null || pinCount === null) return null
    const pins: unknown[] = []
    for (let pinIndex = 0; pinIndex < pinCount; pinIndex += 1) {
      const kind = cursor.u32()
      const id = cursor.string()
      const label = cursor.string()
      if (kind === null || id === null || label === null) return null
      if (kind === 1) {
        const path = cursor.string()
        if (path === null) return null
        pins.push({ kind: 'folder', id, label, path })
      } else {
        const command = cursor.string()
        const desktopId = cursor.string()
        const appName = cursor.string()
        const desktopIcon = cursor.string()
        if (command === null || desktopId === null || appName === null || desktopIcon === null) return null
        pins.push({
          kind: 'app',
          id,
          label,
          command,
          desktopId: desktopId || null,
          appName: appName || null,
          desktopIcon: desktopIcon || null,
        })
      }
    }
    taskbarPins.push({ outputId, outputName, pins })
  }
  const nextGroupSeq = cursor.u32()
  if (nextGroupSeq === null || cursor.offset !== view.byteLength) return null
  return {
    type: 'workspace_state',
    revision,
    state: normalizeWorkspaceSnapshot({
      groups,
      activeTabByGroupId,
      pinnedWindowIds,
      splitByGroupId,
      monitorTiles,
      monitorLayouts,
      preTileGeometry,
      taskbarPins,
      nextGroupSeq,
    }),
  }
}

function decodeSnapshotPacket(bodyBytes: Uint8Array, bodyView: DataView): DerpShellDetail | null {
  if (bodyView.byteLength < 4) return null
  const msgType = bodyView.getUint32(0, true)
  switch (msgType) {
    case MSG_OUTPUT_GEOMETRY:
      return decodeOutputGeometry(bodyView, 0)
    case MSG_OUTPUT_LAYOUT:
      return decodeOutputLayout(bodyBytes, bodyView, 0)
    case MSG_WINDOW_LIST:
      return decodeWindowList(bodyBytes, bodyView, 0)
    case MSG_WINDOW_UNMAPPED:
      return decodeWindowUnmapped(bodyView, 0)
    case MSG_WINDOW_GEOMETRY:
      return decodeWindowGeometry(bodyBytes, bodyView, 0)
    case MSG_WINDOW_METADATA:
      return decodeWindowMetadata(bodyBytes, bodyView, 0)
    case MSG_WINDOW_STATE:
      return decodeWindowState(bodyView, 0)
    case MSG_WINDOW_ORDER:
      return decodeWindowOrder(bodyView, 0)
    case MSG_FOCUS_CHANGED:
      return decodeFocusChanged(bodyView, 0)
    case MSG_COMPOSITOR_KEYBOARD_LAYOUT:
      return decodeKeyboardLayout(bodyBytes, bodyView, 0)
    case MSG_COMPOSITOR_VOLUME_OVERLAY:
      return decodeVolumeOverlay(bodyView, 0)
    case MSG_COMPOSITOR_TRAY_HINTS:
      return decodeTrayHints(bodyView, 0)
    case MSG_COMPOSITOR_TRAY_SNI:
      return decodeTraySni(bodyBytes, bodyView, 0)
    case MSG_COMPOSITOR_WORKSPACE_STATE:
      return decodeWorkspaceState(bodyBytes, bodyView, 0)
    case MSG_COMPOSITOR_WORKSPACE_STATE_BINARY:
      return decodeWorkspaceStateBinary(bodyBytes, bodyView, 0)
    case MSG_COMPOSITOR_SHELL_HOSTED_APP_STATE:
      return decodeShellHostedAppState(bodyBytes, bodyView, 0)
    case MSG_COMPOSITOR_COMMAND_PALETTE_STATE:
      return decodeCommandPaletteState(bodyBytes, bodyView, 0)
    case MSG_COMPOSITOR_INTERACTION_STATE:
      return decodeInteractionState(bodyView, 0)
    case MSG_COMPOSITOR_NATIVE_DRAG_PREVIEW:
      return decodeNativeDragPreview(bodyBytes, bodyView, 0)
    default:
      return null
  }
}

function domainIndex(domain: number): number {
  if (domain <= 0) return -1
  if ((domain & (domain - 1)) !== 0) return -1
  return Math.trunc(Math.log2(domain))
}

export function decodeCompositorSnapshot(buffer: ArrayBufferLike): SnapshotDecodeResult | null {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.byteLength < SNAPSHOT_HEADER_BYTES) return null
  const magic = view.getUint32(0, true)
  const payloadLen = view.getUint32(8, true)
  const domainFlags = view.getUint32(12, true)
  const sequence = view.getBigUint64(16, true)
  if (
    magic !== SNAPSHOT_MAGIC ||
    sequence % 2n !== 0n ||
    SNAPSHOT_HEADER_BYTES + payloadLen > view.byteLength
  ) {
    return null
  }
  if (payloadLen !== 0 && payloadLen < SNAPSHOT_DOMAIN_REVISION_BYTES) return null
  const payloadStart: number = SNAPSHOT_HEADER_BYTES
  const payloadEnd = payloadStart + payloadLen
  const domainRevisions: number[] = []
  let offset: number = payloadStart
  if (payloadLen >= SNAPSHOT_DOMAIN_REVISION_BYTES) {
    for (let index = 0; index < SNAPSHOT_DOMAIN_COUNT; index += 1) {
      domainRevisions.push(Number(view.getBigUint64(offset + index * 8, true)))
    }
    offset += SNAPSHOT_DOMAIN_REVISION_BYTES
  } else {
    for (let index = 0; index < SNAPSHOT_DOMAIN_COUNT; index += 1) domainRevisions.push(0)
  }
  const details: DerpShellDetail[] = []
  if (offset + 8 <= payloadEnd && view.getUint32(offset, true) === SNAPSHOT_DOMAIN_CHUNKS_MAGIC) {
    const chunkCount = view.getUint32(offset + 4, true)
    offset += 8
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      if (offset + 8 > payloadEnd) return null
      const domain = view.getUint32(offset, true)
      const chunkLen = view.getUint32(offset + 4, true)
      const chunkStart = offset + 8
      const chunkEnd = chunkStart + chunkLen
      if (chunkEnd > payloadEnd) return null
      if (domain !== 0 && domainIndex(domain) < 0) return null
      offset = chunkEnd
      let packetOffset = chunkStart
      while (packetOffset < chunkEnd) {
        if (packetOffset + 8 > chunkEnd) return null
        const bodyLen = view.getUint32(packetOffset, true)
        const bodyStart = packetOffset + 4
        const bodyEnd = bodyStart + bodyLen
        if (bodyEnd > chunkEnd || bodyStart + 4 > bodyEnd) return null
        const bodyBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + bodyStart, bodyLen)
        const bodyView = new DataView(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength)
        const detail = decodeSnapshotPacket(bodyBytes, bodyView)
        if (detail) details.push(detail)
        packetOffset = bodyEnd
      }
    }
    if (offset !== payloadEnd) return null
    return {
      sequence: Number(sequence),
      domainFlags,
      domainRevisions,
      details,
    }
  }
  while (offset < payloadEnd) {
    if (offset + 8 > payloadEnd) return null
    const bodyLen = view.getUint32(offset, true)
    const bodyStart = offset + 4
    const bodyEnd = bodyStart + bodyLen
    if (bodyEnd > payloadEnd || bodyStart + 4 > bodyEnd) return null
    const msgType = view.getUint32(bodyStart, true)
    const domain = domainForMessageType(msgType)
    if (domain !== 0 && domainIndex(domain) < 0) return null
    const bodyBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + bodyStart, bodyLen)
    const bodyView = new DataView(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength)
    const detail = decodeSnapshotPacket(bodyBytes, bodyView)
    if (detail) details.push(detail)
    offset = bodyEnd
  }
  return {
    sequence: Number(sequence),
    domainFlags,
    domainRevisions,
    details,
  }
}
