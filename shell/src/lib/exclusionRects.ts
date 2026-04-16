import { CHROME_BORDER_PX, CHROME_TITLEBAR_PX } from './chromeConstants'

export const SHELL_CHROME_BG_FOCUSED_OPAQUE = 'hsl(210, 55%, 48%)'
export const SHELL_CHROME_BG_UNFOCUSED_OPAQUE = 'hsl(210, 18%, 15%)'

export type ExclusionRect = {
  x: number
  y: number
  w: number
  h: number
  window_id?: number
}

export type WindowChromeExclusionSource = {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
  fullscreen: boolean
  minimized: boolean
  snap_tiled?: boolean
}

export function shellOuterFrameFromClient(w: WindowChromeExclusionSource): {
  x: number
  y: number
  w: number
  h: number
  inset: number
  th: number
} {
  const th = CHROME_TITLEBAR_PX
  const bd = CHROME_BORDER_PX
  const noTilingChrome = w.maximized || w.fullscreen
  const snapTiled = !!w.snap_tiled && !noTilingChrome
  const inset = noTilingChrome || snapTiled ? 0 : bd
  const x = w.x - inset
  const y = w.y - th - inset
  const ow = w.width + inset * 2
  const oh = w.height + th + inset * 2
  return { x, y, w: ow, h: oh, inset, th }
}

function rangesTouchOrOverlap(a0: number, a1: number, b0: number, b1: number) {
  return Math.max(a0, b0) <= Math.min(a1, b1)
}

function containsRect(a: ExclusionRect, b: ExclusionRect) {
  return a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h
}

function tryMergeExclusionRects(a: ExclusionRect, b: ExclusionRect): ExclusionRect | undefined {
  if ((a.window_id ?? undefined) !== (b.window_id ?? undefined)) return undefined
  if (containsRect(a, b)) return { ...a }
  if (containsRect(b, a)) return { ...b }
  const ax1 = a.x + a.w
  const ay1 = a.y + a.h
  const bx1 = b.x + b.w
  const by1 = b.y + b.h
  if (a.x === b.x && a.w === b.w && rangesTouchOrOverlap(a.y, ay1, b.y, by1)) {
    const y = Math.min(a.y, b.y)
    return { x: a.x, y, w: a.w, h: Math.max(ay1, by1) - y, window_id: a.window_id }
  }
  if (a.y === b.y && a.h === b.h && rangesTouchOrOverlap(a.x, ax1, b.x, bx1)) {
    const x = Math.min(a.x, b.x)
    return { x, y: a.y, w: Math.max(ax1, bx1) - x, h: a.h, window_id: a.window_id }
  }
  return undefined
}

export function mergeExclusionRects(rects: ExclusionRect[]): ExclusionRect[] {
  const out: ExclusionRect[] = []
  for (const rect of rects) {
    if (rect.w < 1 || rect.h < 1) continue
    let next = { ...rect }
    for (;;) {
      let merged = false
      for (let i = 0; i < out.length; i++) {
        const combined = tryMergeExclusionRects(out[i], next)
        if (!combined) continue
        next = combined
        out.splice(i, 1)
        merged = true
        break
      }
      if (!merged) break
    }
    out.push(next)
  }
  return out
}

export function ssdDecorationExclusionRects(
  w: WindowChromeExclusionSource,
): ExclusionRect[] {
  if (w.minimized) return []
  const th = CHROME_TITLEBAR_PX
  const bd = CHROME_BORDER_PX
  const suppressSideStrips = w.maximized || w.fullscreen
  const inset = suppressSideStrips || !!w.snap_tiled ? 0 : bd
  const out: Array<{ x: number; y: number; w: number; h: number }> = []
  out.push({
    x: w.x - inset,
    y: w.y - th - inset,
    w: w.width + inset * 2,
    h: th + inset,
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
