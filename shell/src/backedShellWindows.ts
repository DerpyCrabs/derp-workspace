import { CHROME_BORDER_PX, CHROME_TITLEBAR_PX } from './chromeConstants'
import { type CanvasOrigin, rectGlobalToCanvasLocal } from './shellCoords'

export const SHELL_UI_DEBUG_WINDOW_ID = 9001
export const SHELL_UI_SETTINGS_WINDOW_ID = 9002
export const SHELL_UI_SCREENSHOT_WINDOW_ID = 9003

export const SHELL_UI_DEBUG_TITLE = 'Debug'
export const SHELL_UI_DEBUG_APP_ID = 'derp.debug'
export const SHELL_UI_SETTINGS_TITLE = 'Settings'
export const SHELL_UI_SETTINGS_APP_ID = 'derp.settings'

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
  kind: 'debug' | 'settings',
): { x: number; y: number; w: number; h: number } {
  const th = CHROME_TITLEBAR_PX
  const bd = CHROME_BORDER_PX
  let cw: number
  let ch: number
  if (kind === 'debug') {
    cw = Math.round(Math.max(320, Math.min(480, work.w * 0.38)))
    ch = Math.round(Math.max(260, Math.min(520, work.h * 0.45)))
  } else {
    cw = Math.round(Math.max(520, Math.min(900, work.w * 0.62)))
    ch = Math.round(Math.max(400, Math.min(820, work.h * 0.68)))
  }
  const outerW = cw + bd * 2
  const outerH = ch + th + bd * 2
  let gx0 = work.x + Math.floor((work.w - outerW) / 2)
  let gy0 = work.y + Math.floor((work.h - outerH) / 2)
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
): BackedWindowOpenPayload {
  const global = defaultBackedClientAreaGlobal(work, kind)
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
