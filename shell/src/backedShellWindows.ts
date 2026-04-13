import { CHROME_BORDER_PX, CHROME_TITLEBAR_PX } from './chromeConstants'
import { type CanvasOrigin, rectGlobalToCanvasLocal } from './shellCoords'

export const SHELL_UI_DEBUG_WINDOW_ID = 9001
export const SHELL_UI_SETTINGS_WINDOW_ID = 9002
export const SHELL_UI_SCREENSHOT_WINDOW_ID = 9003
export const SHELL_UI_PORTAL_PICKER_WINDOW_ID = 9004
export const SHELL_UI_TEST_WINDOW_ID_BASE = 9100
export const SHELL_UI_TEST_WINDOW_ID_LIMIT = 9199
export const SHELL_UI_FILE_BROWSER_WINDOW_ID_BASE = 9200
export const SHELL_UI_FILE_BROWSER_WINDOW_ID_LIMIT = 9299

export const SHELL_UI_DEBUG_TITLE = 'Debug'
export const SHELL_UI_DEBUG_APP_ID = 'derp.debug'
export const SHELL_UI_SETTINGS_TITLE = 'Settings'
export const SHELL_UI_SETTINGS_APP_ID = 'derp.settings'
export const SHELL_UI_TEST_TITLE_PREFIX = 'JS Test Window'
export const SHELL_UI_TEST_APP_ID = 'derp.test-shell'
export const SHELL_UI_FILE_BROWSER_TITLE = 'Files'
export const SHELL_UI_FILE_BROWSER_APP_ID = 'derp.files'
const SHELL_BACKED_WINDOW_STAGGER_X = 28
const SHELL_BACKED_WINDOW_STAGGER_Y = 24
const SHELL_BACKED_WINDOW_STAGGER_STEPS = 6

export type BackedWindowOpenPayload = {
  window_id: number
  title: string
  app_id: string
  output_name: string
  x: number
  y: number
  w: number
  h: number
}

export function defaultBackedClientAreaGlobal(
  work: { x: number; y: number; w: number; h: number },
  kind: 'debug' | 'settings' | 'test' | 'file_browser',
  staggerIndex = 0,
): { x: number; y: number; w: number; h: number } {
  const th = CHROME_TITLEBAR_PX
  const bd = CHROME_BORDER_PX
  let cw: number
  let ch: number
  if (kind === 'debug') {
    cw = Math.round(Math.max(320, Math.min(480, work.w * 0.38)))
    ch = Math.round(Math.max(260, Math.min(520, work.h * 0.45)))
  } else if (kind === 'settings') {
    cw = Math.round(Math.max(520, Math.min(900, work.w * 0.62)))
    ch = Math.round(Math.max(400, Math.min(820, work.h * 0.68)))
  } else if (kind === 'file_browser') {
    cw = Math.round(Math.max(720, Math.min(1180, work.w * 0.74)))
    ch = Math.round(Math.max(420, Math.min(860, work.h * 0.72)))
  } else {
    cw = Math.round(Math.max(360, Math.min(560, work.w * 0.4)))
    ch = Math.round(Math.max(240, Math.min(360, work.h * 0.32)))
  }
  const outerW = cw + bd * 2
  const outerH = ch + th + bd * 2
  const staggerStep = Math.max(0, Math.trunc(staggerIndex)) % SHELL_BACKED_WINDOW_STAGGER_STEPS
  let gx0 = work.x + Math.floor((work.w - outerW) / 2) + staggerStep * SHELL_BACKED_WINDOW_STAGGER_X
  let gy0 = work.y + Math.floor((work.h - outerH) / 2) + staggerStep * SHELL_BACKED_WINDOW_STAGGER_Y
  const gxOuter = Math.min(
    Math.max(gx0, work.x),
    work.x + Math.max(0, work.w - Math.max(1, outerW)),
  )
  const gyOuter = Math.min(
    Math.max(gy0, work.y),
    work.y + Math.max(0, work.h - Math.max(1, outerH)),
  )
  const gx = gxOuter + bd
  const gy = gyOuter + th + bd
  return { x: gx, y: gy, w: Math.max(1, cw), h: Math.max(1, ch) }
}

export function buildBackedWindowOpenPayload(
  monName: string,
  work: { x: number; y: number; w: number; h: number },
  kind: 'debug' | 'settings',
  origin: CanvasOrigin,
  staggerIndex = 0,
): BackedWindowOpenPayload {
  const global = defaultBackedClientAreaGlobal(work, kind, staggerIndex)
  const loc = rectGlobalToCanvasLocal(global.x, global.y, global.w, global.h, origin)
  if (kind === 'debug') {
    return {
      window_id: SHELL_UI_DEBUG_WINDOW_ID,
      title: SHELL_UI_DEBUG_TITLE,
      app_id: SHELL_UI_DEBUG_APP_ID,
      output_name: monName,
      x: loc.x,
      y: loc.y,
      w: loc.w,
      h: loc.h,
    }
  }
  return {
    window_id: SHELL_UI_SETTINGS_WINDOW_ID,
    title: SHELL_UI_SETTINGS_TITLE,
    app_id: SHELL_UI_SETTINGS_APP_ID,
    output_name: monName,
    x: loc.x,
    y: loc.y,
    w: loc.w,
    h: loc.h,
  }
}

export function isShellTestWindowId(windowId: number): boolean {
  return windowId >= SHELL_UI_TEST_WINDOW_ID_BASE && windowId <= SHELL_UI_TEST_WINDOW_ID_LIMIT
}

export function isFileBrowserWindowId(windowId: number): boolean {
  return windowId >= SHELL_UI_FILE_BROWSER_WINDOW_ID_BASE && windowId <= SHELL_UI_FILE_BROWSER_WINDOW_ID_LIMIT
}

export function shellTestWindowId(instance: number): number {
  return SHELL_UI_TEST_WINDOW_ID_BASE + instance
}

export function fileBrowserWindowId(instance: number): number {
  return SHELL_UI_FILE_BROWSER_WINDOW_ID_BASE + instance
}

export function shellTestWindowTitle(instance: number): string {
  return `${SHELL_UI_TEST_TITLE_PREFIX} ${instance + 1}`
}

export function fileBrowserWindowTitle(instance: number): string {
  return instance === 0 ? SHELL_UI_FILE_BROWSER_TITLE : `${SHELL_UI_FILE_BROWSER_TITLE} ${instance + 1}`
}

export function buildShellTestWindowOpenPayload(
  monName: string,
  work: { x: number; y: number; w: number; h: number },
  windowId: number,
  title: string,
  origin: CanvasOrigin,
  staggerIndex = 0,
): BackedWindowOpenPayload {
  const global = defaultBackedClientAreaGlobal(work, 'test', staggerIndex)
  const loc = rectGlobalToCanvasLocal(global.x, global.y, global.w, global.h, origin)
  return {
    window_id: windowId,
    title,
    app_id: SHELL_UI_TEST_APP_ID,
    output_name: monName,
    x: loc.x,
    y: loc.y,
    w: loc.w,
    h: loc.h,
  }
}

export function buildFileBrowserWindowOpenPayload(
  monName: string,
  work: { x: number; y: number; w: number; h: number },
  windowId: number,
  title: string,
  origin: CanvasOrigin,
  staggerIndex = 0,
): BackedWindowOpenPayload {
  const global = defaultBackedClientAreaGlobal(work, 'file_browser', staggerIndex)
  const loc = rectGlobalToCanvasLocal(global.x, global.y, global.w, global.h, origin)
  return {
    window_id: windowId,
    title,
    app_id: SHELL_UI_FILE_BROWSER_APP_ID,
    output_name: monName,
    x: loc.x,
    y: loc.y,
    w: loc.w,
    h: loc.h,
  }
}
