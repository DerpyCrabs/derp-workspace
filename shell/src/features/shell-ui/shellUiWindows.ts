import { clientRectToGlobalLogical } from '@/lib/shellCoords'
import { sharedShellStateStampKey, writeShellUiWindowsState } from '@/features/bridge/sharedShellState'
export {
  SHELL_UI_DEBUG_WINDOW_ID,
  SHELL_UI_PORTAL_PICKER_WINDOW_ID,
  SHELL_UI_SCREENSHOT_WINDOW_ID,
  SHELL_UI_SETTINGS_WINDOW_ID,
} from './backedShellWindows'

export const SHELL_WINDOW_FLAG_SHELL_HOSTED = 1
export const SHELL_WINDOW_FLAG_SCRATCHPAD = 2

export type ShellUiMeasureEnv = {
  main: HTMLElement
  outputGeom: { w: number; h: number }
  origin: { x: number; y: number } | null
}

type Entry = {
  id: number
  measure: () => {
    id: number
    z: number
    gx: number
    gy: number
    gw: number
    gh: number
  } | null
  cached:
    | {
        id: number
        z: number
        gx: number
        gy: number
        gw: number
        gh: number
      }
    | null
}

const registry = new Map<number, Entry>()
const dirtyRegistryTokens = new Set<number>()
let nextRegistryToken = 1
let generation = 0
let raf = 0
let microtaskQueued = false
let structureDirty = false
let lastWindows:
  | Array<{ id: number; z: number; gx: number; gy: number; gw: number; gh: number }>
  | null = null
let lastSharedStateStamp: string | null = null

function sameWindows(
  left: Array<{ id: number; z: number; gx: number; gy: number; gw: number; gh: number }>,
  right: Array<{ id: number; z: number; gx: number; gy: number; gw: number; gh: number }> | null,
) {
  if (right === null || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (
      a.id !== b.id ||
      a.z !== b.z ||
      a.gx !== b.gx ||
      a.gy !== b.gy ||
      a.gw !== b.gw ||
      a.gh !== b.gh
    ) {
      return false
    }
  }
  return true
}

function flush() {
  raf = 0
  microtaskQueued = false
  if (!structureDirty && dirtyRegistryTokens.size === 0 && lastWindows !== null) return
  for (const token of dirtyRegistryTokens) {
    const entry = registry.get(token)
    if (!entry) continue
    entry.cached = entry.measure()
  }
  dirtyRegistryTokens.clear()
  structureDirty = false
  const windows: Array<{ id: number; z: number; gx: number; gy: number; gw: number; gh: number }> = []
  for (const [, e] of registry) {
    if (e.cached) windows.push(e.cached)
  }
  windows.sort((a, b) => a.z - b.z || a.id - b.id)
  const stamp = sharedShellStateStampKey()
  if (sameWindows(windows, lastWindows) && stamp === lastSharedStateStamp) return
  const nextGeneration = generation + 1
  const sharedOk = writeShellUiWindowsState(nextGeneration, windows)
  if (!sharedOk) return
  generation = nextGeneration
  lastWindows = windows.map((window) => ({ ...window }))
  lastSharedStateStamp = stamp
}

export function scheduleShellUiWindowsSync() {
  if (!microtaskQueued) {
    microtaskQueued = true
    queueMicrotask(flush)
  }
  if (raf) return
  raf = requestAnimationFrame(flush)
}

export function flushShellUiWindowsSyncNow() {
  if (raf) {
    cancelAnimationFrame(raf)
    raf = 0
  }
  flush()
}

export function invalidateShellUiWindow(id: number) {
  for (const [token, entry] of registry) {
    if (entry.id !== id) continue
    dirtyRegistryTokens.add(token)
  }
  scheduleShellUiWindowsSync()
}

export function invalidateAllShellUiWindows() {
  for (const token of registry.keys()) dirtyRegistryTokens.add(token)
  scheduleShellUiWindowsSync()
}

export function registerShellUiWindow(_id: number, measure: Entry['measure']) {
  const token = nextRegistryToken++
  registry.set(token, { id: _id, measure, cached: null })
  structureDirty = true
  dirtyRegistryTokens.add(token)
  scheduleShellUiWindowsSync()
  return () => {
    registry.delete(token)
    dirtyRegistryTokens.delete(token)
    structureDirty = true
    scheduleShellUiWindowsSync()
  }
}

export function shellUiWindowMeasureFromEnv(
  id: number,
  z: number,
  root: HTMLElement | undefined,
  getEnv: () => ShellUiMeasureEnv | null,
) {
  const el = root
  const env = getEnv()
  if (!el || !env) return null
  const mainRect = env.main.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return null
  const logical = clientRectToGlobalLogical(mainRect, r, env.outputGeom.w, env.outputGeom.h, env.origin)
  return {
    id,
    z,
    gx: logical.x,
    gy: logical.y,
    gw: logical.w,
    gh: logical.h,
  }
}
