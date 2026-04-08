import { CHROME_BORDER_PX, CHROME_TITLEBAR_PX } from './chromeConstants'

export const SHELL_CHROME_BG_FOCUSED_OPAQUE = 'hsl(210, 55%, 48%)'
export const SHELL_CHROME_BG_UNFOCUSED_OPAQUE = 'hsl(210, 18%, 15%)'

export const SHELL_EXCLUSION_ZONES_SENT_MAX = 128

export type WindowChromeExclusionSource = {
  x: number
  y: number
  width: number
  height: number
  client_side_decoration?: boolean
  maximized: boolean
  fullscreen: boolean
  minimized: boolean
  snap_tiled?: boolean
}

export function ssdDecorationExclusionRects(
  w: WindowChromeExclusionSource,
): Array<{ x: number; y: number; w: number; h: number }> {
  if (w.minimized) return []
  if (w.client_side_decoration) return []
  const th = CHROME_TITLEBAR_PX
  const bd = CHROME_BORDER_PX
  const suppressSideStrips = w.maximized || w.fullscreen
  const inset = suppressSideStrips || !!w.snap_tiled ? 0 : bd
  const out: Array<{ x: number; y: number; w: number; h: number }> = []
  out.push({
    x: w.x - inset,
    y: w.y - th,
    w: w.width + inset * 2,
    h: th,
  })
  if (!suppressSideStrips) {
    out.push({
      x: w.x - inset,
      y: w.y,
      w: bd,
      h: w.height,
    })
    out.push({
      x: w.x + w.width + inset - bd,
      y: w.y,
      w: bd,
      h: w.height,
    })
    out.push({
      x: w.x - inset,
      y: w.y + w.height,
      w: w.width + inset * 2,
      h: bd,
    })
  }
  return out
}
