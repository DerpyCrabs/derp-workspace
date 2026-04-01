export type CanvasOrigin = { x: number; y: number } | null

export function canvasOriginXY(origin: CanvasOrigin): { ox: number; oy: number } {
  return { ox: origin?.x ?? 0, oy: origin?.y ?? 0 }
}

export function rectCanvasLocalToGlobal(
  x: number,
  y: number,
  w: number,
  h: number,
  origin: CanvasOrigin,
): { x: number; y: number; w: number; h: number } {
  const { ox, oy } = canvasOriginXY(origin)
  return { x: x + ox, y: y + oy, w, h }
}

export function rectGlobalToCanvasLocal(
  x: number,
  y: number,
  w: number,
  h: number,
  origin: CanvasOrigin,
): { x: number; y: number; w: number; h: number } {
  const { ox, oy } = canvasOriginXY(origin)
  return { x: x - ox, y: y - oy, w, h }
}

export function clientPointToCanvasLocal(
  clientX: number,
  clientY: number,
  mainRect: DOMRect,
  canvasW: number,
  canvasH: number,
): { x: number; y: number } {
  const cw = Math.max(1, canvasW)
  const ch = Math.max(1, canvasH)
  const mw = Math.max(1, mainRect.width)
  const mh = Math.max(1, mainRect.height)
  const sx = cw / mw
  const sy = ch / mh
  return {
    x: Math.round((clientX - mainRect.left) * sx),
    y: Math.round((clientY - mainRect.top) * sy),
  }
}

export function clientPointToGlobalLogical(
  clientX: number,
  clientY: number,
  mainRect: DOMRect,
  canvasW: number,
  canvasH: number,
  origin: CanvasOrigin,
): { x: number; y: number } {
  const p = clientPointToCanvasLocal(clientX, clientY, mainRect, canvasW, canvasH)
  const { ox, oy } = canvasOriginXY(origin)
  return { x: p.x + ox, y: p.y + oy }
}

export type ShellRect = { x: number; y: number; width: number; height: number }

export function windowCenterGlobal(win: ShellRect, origin: CanvasOrigin): { cx: number; cy: number } {
  const { ox, oy } = canvasOriginXY(origin)
  return {
    cx: win.x + ox + Math.floor(win.width / 2),
    cy: win.y + oy + Math.floor(win.height / 2),
  }
}

export function pickScreenContainingGlobalPoint<T extends { x: number; y: number; width: number; height: number }>(
  px: number,
  py: number,
  screens: ReadonlyArray<T>,
): T | null {
  if (screens.length === 0) return null
  for (const s of screens) {
    if (px >= s.x && py >= s.y && px < s.x + s.width && py < s.y + s.height) {
      return s
    }
  }
  return screens[0] ?? null
}

export function pickScreenForWindow<T extends { x: number; y: number; width: number; height: number }>(
  win: ShellRect,
  screens: ReadonlyArray<T>,
  origin: CanvasOrigin,
): T | null {
  const { cx, cy } = windowCenterGlobal(win, origin)
  return pickScreenContainingGlobalPoint(cx, cy, screens)
}
