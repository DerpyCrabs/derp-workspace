import { clientRectToGlobalLogical } from './shellCoords'

export const SHELL_UI_DEBUG_WINDOW_ID = 9001

export const SHELL_WINDOW_FLAG_SHELL_HOSTED = 1

export function isShellUiToolboxRow(shellFlags: number, windowId: number): boolean {
  return (shellFlags & SHELL_WINDOW_FLAG_SHELL_HOSTED) !== 0 || windowId === SHELL_UI_DEBUG_WINDOW_ID
}

export type ShellUiMeasureEnv = {
  main: HTMLElement
  outputGeom: { w: number; h: number }
  origin: { x: number; y: number } | null
}

type Entry = {
  measure: () => {
    id: number
    z: number
    gx: number
    gy: number
    gw: number
    gh: number
  } | null
}

const registry = new Map<number, Entry>()
let generation = 0
let raf = 0

function flush() {
  raf = 0
  const windows: Array<{
    id: number
    z: number
    gx: number
    gy: number
    gw: number
    gh: number
    flags: number
  }> = []
  for (const [, e] of registry) {
    const m = e.measure()
    if (m) windows.push({ ...m, flags: 0 })
  }
  windows.sort((a, b) => a.z - b.z || a.id - b.id)
  generation += 1
  const fn = window.__derpShellWireSend
  if (typeof fn === 'function') {
    const sup = (
      window as unknown as {
        __derpSuppressShellUiPlacementHoles?: () => boolean
      }
    ).__derpSuppressShellUiPlacementHoles
    const suppressed = typeof sup === 'function' && sup()
    const payload = suppressed
      ? { generation, windows: [], suppress_osr_exclusion: true }
      : { generation, windows, suppress_osr_exclusion: false }
    fn('set_shell_ui_windows', JSON.stringify(payload))
  }
}

export function scheduleShellUiWindowsSync() {
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

export function registerShellUiWindow(id: number, measure: Entry['measure']) {
  registry.set(id, { measure })
  scheduleShellUiWindowsSync()
  return () => {
    registry.delete(id)
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
