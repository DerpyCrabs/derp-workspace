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

export function clientPointerDeltaToCanvasLogical(
  dClientX: number,
  dClientY: number,
  mainRect: DOMRect,
  canvasW: number,
  canvasH: number,
): { dx: number; dy: number } {
  const cw = Math.max(1, canvasW)
  const ch = Math.max(1, canvasH)
  const mw = Math.max(1, mainRect.width)
  const mh = Math.max(1, mainRect.height)
  const sx = cw / mw
  const sy = ch / mh
  return {
    dx: Math.round(dClientX * sx),
    dy: Math.round(dClientY * sy),
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

export function clientRectToGlobalLogical(
  mainRect: DOMRect,
  elRect: DOMRect,
  canvasW: number,
  canvasH: number,
  origin: CanvasOrigin,
) {
  const { ox, oy } = canvasOriginXY(origin)
  const cw = Math.max(1, canvasW)
  const ch = Math.max(1, canvasH)
  const mw = Math.max(1, mainRect.width)
  const mh = Math.max(1, mainRect.height)
  const sx = cw / mw
  const sy = ch / mh
  const lx = (elRect.left - mainRect.left) * sx
  const ly = (elRect.top - mainRect.top) * sy
  const lw = elRect.width * sx
  const lh = elRect.height * sy
  return {
    x: Math.round(lx + ox),
    y: Math.round(ly + oy),
    w: Math.max(1, Math.round(lw)),
    h: Math.max(1, Math.round(lh)),
  }
}

export function canvasRectToClientCss(
  x: number,
  y: number,
  w: number,
  h: number,
  mainRect: DOMRect,
  canvasW: number,
  canvasH: number,
): { left: number; top: number; width: number; height: number } {
  const cw = Math.max(1, canvasW)
  const ch = Math.max(1, canvasH)
  const mw = Math.max(1, mainRect.width)
  const mh = Math.max(1, mainRect.height)
  const sx = mw / cw
  const sy = mh / ch
  return {
    left: mainRect.left + x * sx,
    top: mainRect.top + y * sy,
    width: Math.max(0, w * sx),
    height: Math.max(0, h * sy),
  }
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
  return null
}

export function pickScreenForPointerSnap<T extends { x: number; y: number; width: number; height: number }>(
  px: number,
  py: number,
  screens: ReadonlyArray<T>,
): T | null {
  if (screens.length === 0) return null
  const hit = pickScreenContainingGlobalPoint(px, py, screens)
  if (hit) return hit
  let best = screens[0]!
  let bestD = Infinity
  for (const s of screens) {
    const nx = Math.min(Math.max(px, s.x), s.x + s.width)
    const ny = Math.min(Math.max(py, s.y), s.y + s.height)
    const d = (px - nx) ** 2 + (py - ny) ** 2
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return best
}

export function pickScreenForWindow<T extends { x: number; y: number; width: number; height: number }>(
  win: ShellRect,
  screens: ReadonlyArray<T>,
  origin: CanvasOrigin,
): T | null {
  const { cx, cy } = windowCenterGlobal(win, origin)
  return pickScreenForPointerSnap(cx, cy, screens)
}

export function findAdjacentMonitor<
  T extends { x: number; y: number; width: number; height: number; name: string },
>(current: T, allScreens: ReadonlyArray<T>, direction: 'left' | 'right'): T | null {
  if (allScreens.length === 0) return null
  const sorted = [...allScreens].sort((a, b) => a.x - b.x || a.y - b.y || a.name.localeCompare(b.name))
  const idx = sorted.findIndex(
    (s) =>
      s.name === current.name &&
      s.x === current.x &&
      s.y === current.y &&
      s.width === current.width &&
      s.height === current.height,
  )
  if (idx < 0) return null
  if (direction === 'left') return idx > 0 ? sorted[idx - 1]! : null
  return idx < sorted.length - 1 ? sorted[idx + 1]! : null
}
