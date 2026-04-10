import { clientRectToGlobalLogical } from './shellCoords'
export {
  SHELL_UI_DEBUG_WINDOW_ID,
  SHELL_UI_SCREENSHOT_WINDOW_ID,
  SHELL_UI_SETTINGS_WINDOW_ID,
} from './backedShellWindows'

export const SHELL_WINDOW_FLAG_SHELL_HOSTED = 1

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
let lastWindowsJson: string | null = null

function flush() {
  raf = 0
  const windows: Array<{ id: number; z: number; gx: number; gy: number; gw: number; gh: number }> = []
  for (const [, e] of registry) {
    const m = e.measure()
    if (m) windows.push(m)
  }
  windows.sort((a, b) => a.z - b.z || a.id - b.id)
  const fn = window.__derpShellWireSend
  if (typeof fn === 'function') {
    const windowsJson = JSON.stringify(windows)
    if (windowsJson === lastWindowsJson) return
    generation += 1
    lastWindowsJson = windowsJson
    const payload = { generation, windows }
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
