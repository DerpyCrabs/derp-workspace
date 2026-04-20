import type { SnapZone } from '@/features/tiling/tileZones'
import type { TilingConfig } from '@/features/tiling/tilingConfig'
import { getShellJson, postShellJson } from './shellBridge'
import { waitForShellHttpBase } from './shellHttp'
import { clampWorkspaceSplitPaneFraction } from '@/features/workspace/workspaceState'

export type SessionWindowRef = string

export type NativeLaunchMetadata = {
  command: string
  desktopId: string | null
  appName: string | null
}

export type SavedShellWindowKind =
  | 'debug'
  | 'settings'
  | 'test'
  | 'file_browser'
  | 'image_viewer'
  | 'video_viewer'
  | 'text_editor'
  | 'pdf_viewer'

export type SavedRect = {
  x: number
  y: number
  width: number
  height: number
}

export type SavedShellWindow = {
  windowId: number
  windowRef: SessionWindowRef
  kind: SavedShellWindowKind
  title: string
  appId: string
  outputName: string
  bounds: SavedRect
  minimized: boolean
  maximized: boolean
  fullscreen: boolean
  stackZ: number
  state: unknown | null
}

export type SavedNativeWindow = {
  windowRef: SessionWindowRef
  title: string
  appId: string
  outputName: string
  bounds: SavedRect
  minimized: boolean
  maximized: boolean
  fullscreen: boolean
  launch: NativeLaunchMetadata | null
}

export type SavedWorkspaceGroup = {
  id: string
  windowRefs: SessionWindowRef[]
  activeWindowRef: SessionWindowRef | null
  splitLeftWindowRef: SessionWindowRef | null
  leftPaneFraction: number | null
}

export type SavedMonitorTileEntry = {
  windowRef: SessionWindowRef
  zone: SnapZone
  bounds: SavedRect
}

export type SavedMonitorTileState = {
  outputName: string
  entries: SavedMonitorTileEntry[]
}

export type SavedPreTileGeometry = {
  windowRef: SessionWindowRef
  bounds: SavedRect
}

export type SessionSnapshot = {
  version: 1
  nextNativeWindowSeq: number
  workspace: {
    groups: SavedWorkspaceGroup[]
    pinnedWindowRefs: SessionWindowRef[]
    nextGroupSeq: number
  }
  tilingConfig: TilingConfig
  monitorTiles: SavedMonitorTileState[]
  preTileGeometry: SavedPreTileGeometry[]
  shellWindows: SavedShellWindow[]
  nativeWindows: SavedNativeWindow[]
}

const SESSION_STATE_PATH = '/session_state'
const SESSION_SNAPSHOT_VERSION = 1 as const

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function coercePositiveInt(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  const int = Math.trunc(num)
  return Number.isFinite(int) && int > 0 ? int : fallback
}

function coerceInt(value: unknown, fallback = 0): number {
  const num = typeof value === 'number' ? value : Number(value)
  const int = Math.trunc(num)
  return Number.isFinite(int) ? int : fallback
}

function coerceBool(value: unknown): boolean {
  return value === true
}

function sanitizeWindowRef(value: unknown): SessionWindowRef | null {
  const ref = coerceString(value).trim()
  if (!/^shell:\d+$/.test(ref) && !/^native:\d+$/.test(ref)) return null
  return ref
}

function sanitizeRect(value: unknown): SavedRect {
  const row = isObject(value) ? value : {}
  return {
    x: coerceInt(row.x),
    y: coerceInt(row.y),
    width: Math.max(1, coerceInt(row.width, 1)),
    height: Math.max(1, coerceInt(row.height, 1)),
  }
}

function sanitizeLaunchMetadata(value: unknown): NativeLaunchMetadata | null {
  if (!isObject(value)) return null
  const command = coerceString(value.command).trim()
  if (!command) return null
  const desktopId = coerceString(value.desktopId).trim()
  const appName = coerceString(value.appName).trim()
  return {
    command,
    desktopId: desktopId || null,
    appName: appName || null,
  }
}

function sanitizeShellWindowKind(value: unknown): SavedShellWindowKind {
  switch (value) {
    case 'debug':
    case 'settings':
    case 'test':
    case 'file_browser':
    case 'image_viewer':
    case 'video_viewer':
    case 'text_editor':
    case 'pdf_viewer':
      return value
    default:
      return 'test'
  }
}

function sanitizeShellWindow(value: unknown): SavedShellWindow | null {
  if (!isObject(value)) return null
  const windowId = coercePositiveInt(value.windowId, 0)
  const windowRef = sanitizeWindowRef(value.windowRef) ?? shellWindowRef(windowId)
  if (!windowId || !windowRef.startsWith('shell:')) return null
  return {
    windowId,
    windowRef,
    kind: sanitizeShellWindowKind(value.kind),
    title: coerceString(value.title),
    appId: coerceString(value.appId),
    outputName: coerceString(value.outputName),
    bounds: sanitizeRect(value.bounds),
    minimized: coerceBool(value.minimized),
    maximized: coerceBool(value.maximized),
    fullscreen: coerceBool(value.fullscreen),
    stackZ: coerceInt(value.stackZ),
    state: value.state ?? null,
  }
}

function sanitizeNativeWindow(value: unknown): SavedNativeWindow | null {
  if (!isObject(value)) return null
  const windowRef = sanitizeWindowRef(value.windowRef)
  if (!windowRef || !windowRef.startsWith('native:')) return null
  return {
    windowRef,
    title: coerceString(value.title),
    appId: coerceString(value.appId),
    outputName: coerceString(value.outputName),
    bounds: sanitizeRect(value.bounds),
    minimized: coerceBool(value.minimized),
    maximized: coerceBool(value.maximized),
    fullscreen: coerceBool(value.fullscreen),
    launch: sanitizeLaunchMetadata(value.launch),
  }
}

function sanitizeWorkspaceGroup(value: unknown): SavedWorkspaceGroup | null {
  if (!isObject(value)) return null
  const id = coerceString(value.id).trim()
  if (!id) return null
  const rawRefs = Array.isArray(value.windowRefs) ? value.windowRefs : []
  const seen = new Set<string>()
  const windowRefs: SessionWindowRef[] = []
  for (const rawRef of rawRefs) {
    const ref = sanitizeWindowRef(rawRef)
    if (!ref || seen.has(ref)) continue
    seen.add(ref)
    windowRefs.push(ref)
  }
  if (windowRefs.length === 0) return null
  const activeWindowRef = sanitizeWindowRef(value.activeWindowRef)
  const splitLeftWindowRef = sanitizeWindowRef(value.splitLeftWindowRef)
  const rawFraction =
    typeof value.leftPaneFraction === 'number' ? value.leftPaneFraction : Number(value.leftPaneFraction)
  const validSplitLeftWindowRef =
    splitLeftWindowRef && windowRefs.includes(splitLeftWindowRef) && windowRefs.length > 1 ? splitLeftWindowRef : null
  return {
    id,
    windowRefs,
    activeWindowRef: activeWindowRef && windowRefs.includes(activeWindowRef) ? activeWindowRef : windowRefs[0],
    splitLeftWindowRef: validSplitLeftWindowRef,
    leftPaneFraction:
      validSplitLeftWindowRef !== null ? clampWorkspaceSplitPaneFraction(rawFraction) : null,
  }
}

function sanitizePinnedRefs(value: unknown): SessionWindowRef[] {
  if (!Array.isArray(value)) return []
  const out: SessionWindowRef[] = []
  const seen = new Set<string>()
  for (const rawRef of value) {
    const ref = sanitizeWindowRef(rawRef)
    if (!ref || seen.has(ref)) continue
    seen.add(ref)
    out.push(ref)
  }
  return out
}

function sanitizeZone(value: unknown): SnapZone {
  switch (value) {
    case 'left-half':
    case 'right-half':
    case 'top-left':
    case 'top-right':
    case 'bottom-left':
    case 'bottom-right':
    case 'left-third':
    case 'center-third':
    case 'right-third':
    case 'left-two-thirds':
    case 'right-two-thirds':
    case 'top-left-two-thirds':
    case 'top-center-two-thirds':
    case 'top-right-two-thirds':
    case 'top-left-third':
    case 'top-center-third':
    case 'top-right-third':
    case 'bottom-left-two-thirds':
    case 'bottom-center-two-thirds':
    case 'bottom-right-two-thirds':
    case 'bottom-left-third':
    case 'bottom-center-third':
    case 'bottom-right-third':
    case 'auto-fill':
      return value
    default:
      return 'auto-fill'
  }
}

function sanitizeMonitorTileEntry(value: unknown): SavedMonitorTileEntry | null {
  if (!isObject(value)) return null
  const windowRef = sanitizeWindowRef(value.windowRef)
  if (!windowRef) return null
  return {
    windowRef,
    zone: sanitizeZone(value.zone),
    bounds: sanitizeRect(value.bounds),
  }
}

function sanitizeMonitorTileState(value: unknown): SavedMonitorTileState | null {
  if (!isObject(value)) return null
  const outputName = coerceString(value.outputName).trim()
  if (!outputName) return null
  const entriesRaw = Array.isArray(value.entries) ? value.entries : []
  const entries: SavedMonitorTileEntry[] = []
  const seen = new Set<string>()
  for (const rawEntry of entriesRaw) {
    const entry = sanitizeMonitorTileEntry(rawEntry)
    if (!entry || seen.has(entry.windowRef)) continue
    seen.add(entry.windowRef)
    entries.push(entry)
  }
  return entries.length > 0 ? { outputName, entries } : null
}

function sanitizePreTileGeometry(value: unknown): SavedPreTileGeometry | null {
  if (!isObject(value)) return null
  const windowRef = sanitizeWindowRef(value.windowRef)
  if (!windowRef) return null
  return {
    windowRef,
    bounds: sanitizeRect(value.bounds),
  }
}

function defaultSnapshot(): SessionSnapshot {
  return {
    version: SESSION_SNAPSHOT_VERSION,
    nextNativeWindowSeq: 1,
    workspace: {
      groups: [],
      pinnedWindowRefs: [],
      nextGroupSeq: 1,
    },
    tilingConfig: { monitors: {} },
    monitorTiles: [],
    preTileGeometry: [],
    shellWindows: [],
    nativeWindows: [],
  }
}

export function shellWindowRef(windowId: number): SessionWindowRef {
  return `shell:${Math.max(1, Math.trunc(windowId))}`
}

export function nativeWindowRef(seq: number): SessionWindowRef {
  return `native:${Math.max(1, Math.trunc(seq))}`
}

export function sanitizeSessionSnapshot(value: unknown): SessionSnapshot {
  if (!isObject(value)) return defaultSnapshot()
  const workspaceRaw = isObject(value.workspace) ? value.workspace : {}
  const groupsRaw = Array.isArray(workspaceRaw.groups) ? workspaceRaw.groups : []
  const groups: SavedWorkspaceGroup[] = []
  const seenGroupIds = new Set<string>()
  for (const rawGroup of groupsRaw) {
    const group = sanitizeWorkspaceGroup(rawGroup)
    if (!group || seenGroupIds.has(group.id)) continue
    seenGroupIds.add(group.id)
    groups.push(group)
  }
  const monitorTilesRaw = Array.isArray(value.monitorTiles) ? value.monitorTiles : []
  const monitorTiles: SavedMonitorTileState[] = []
  const seenMonitorNames = new Set<string>()
  for (const rawMonitor of monitorTilesRaw) {
    const monitor = sanitizeMonitorTileState(rawMonitor)
    if (!monitor || seenMonitorNames.has(monitor.outputName)) continue
    seenMonitorNames.add(monitor.outputName)
    monitorTiles.push(monitor)
  }
  const preTileRaw = Array.isArray(value.preTileGeometry) ? value.preTileGeometry : []
  const preTileGeometry: SavedPreTileGeometry[] = []
  const seenPreTileRefs = new Set<string>()
  for (const rawPreTile of preTileRaw) {
    const entry = sanitizePreTileGeometry(rawPreTile)
    if (!entry || seenPreTileRefs.has(entry.windowRef)) continue
    seenPreTileRefs.add(entry.windowRef)
    preTileGeometry.push(entry)
  }
  const shellWindowsRaw = Array.isArray(value.shellWindows) ? value.shellWindows : []
  const shellWindows: SavedShellWindow[] = []
  const seenShellWindowIds = new Set<number>()
  for (const rawWindow of shellWindowsRaw) {
    const window = sanitizeShellWindow(rawWindow)
    if (!window || seenShellWindowIds.has(window.windowId)) continue
    seenShellWindowIds.add(window.windowId)
    shellWindows.push(window)
  }
  const nativeWindowsRaw = Array.isArray(value.nativeWindows) ? value.nativeWindows : []
  const nativeWindows: SavedNativeWindow[] = []
  const seenNativeRefs = new Set<string>()
  for (const rawWindow of nativeWindowsRaw) {
    const window = sanitizeNativeWindow(rawWindow)
    if (!window || seenNativeRefs.has(window.windowRef)) continue
    seenNativeRefs.add(window.windowRef)
    nativeWindows.push(window)
  }
  const tilingConfig =
    isObject(value.tilingConfig) && isObject(value.tilingConfig.monitors)
      ? { monitors: { ...(value.tilingConfig.monitors as Record<string, unknown>) } }
      : { monitors: {} }
  return {
    version: SESSION_SNAPSHOT_VERSION,
    nextNativeWindowSeq: coercePositiveInt(value.nextNativeWindowSeq, 1),
    workspace: {
      groups,
      pinnedWindowRefs: sanitizePinnedRefs(workspaceRaw.pinnedWindowRefs),
      nextGroupSeq: coercePositiveInt(workspaceRaw.nextGroupSeq, 1),
    },
    tilingConfig: tilingConfig as TilingConfig,
    monitorTiles,
    preTileGeometry,
    shellWindows,
    nativeWindows,
  }
}

export async function loadSessionSnapshot(): Promise<SessionSnapshot> {
  const base = await waitForShellHttpBase()
  if (!base) return defaultSnapshot()
  const value = await getShellJson(SESSION_STATE_PATH, base)
  const shellValue = isObject(value) ? value.shell : null
  return sanitizeSessionSnapshot(shellValue)
}

export async function saveSessionSnapshot(snapshot: SessionSnapshot): Promise<void> {
  const base = await waitForShellHttpBase()
  if (!base) return
  await postShellJson(
    SESSION_STATE_PATH,
    {
      version: SESSION_SNAPSHOT_VERSION,
      shell: sanitizeSessionSnapshot(snapshot),
    },
    base,
  )
}
