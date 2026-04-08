import { CHROME_TASKBAR_RESERVE_PX, CHROME_TITLEBAR_PX } from './chromeConstants'

export type LayoutScreen = {
  x: number
  y: number
  width: number
  height: number
}

export const TILE_SNAP_EDGE_PX = 18

export function monitorWorkAreaGlobal(
  mon: LayoutScreen,
  reserveTaskbar: boolean,
  titlebarPx: number = CHROME_TITLEBAR_PX,
  taskbarReservePx: number = CHROME_TASKBAR_RESERVE_PX,
): { x: number; y: number; w: number; h: number } {
  const tb = reserveTaskbar ? taskbarReservePx : 0
  return {
    x: mon.x,
    y: mon.y + titlebarPx,
    w: Math.max(1, mon.width),
    h: Math.max(1, mon.height - titlebarPx - tb),
  }
}

function quarterRect(work: { x: number; y: number; w: number; h: number }, q: 'tl' | 'tr' | 'bl' | 'br') {
  const halfW = Math.floor(work.w / 2)
  const halfH = Math.floor(work.h / 2)
  const restW = work.w - halfW
  const restH = work.h - halfH
  switch (q) {
    case 'tl':
      return { x: work.x, y: work.y, w: Math.max(1, halfW), h: Math.max(1, halfH) }
    case 'tr':
      return { x: work.x + halfW, y: work.y, w: Math.max(1, restW), h: Math.max(1, halfH) }
    case 'bl':
      return { x: work.x, y: work.y + halfH, w: Math.max(1, halfW), h: Math.max(1, restH) }
    case 'br':
      return { x: work.x + halfW, y: work.y + halfH, w: Math.max(1, restW), h: Math.max(1, restH) }
  }
}

function halfRect(work: { x: number; y: number; w: number; h: number }, side: 'left' | 'right') {
  const halfW = Math.floor(work.w / 2)
  const restW = work.w - halfW
  if (side === 'left') {
    return { x: work.x, y: work.y, w: Math.max(1, halfW), h: Math.max(1, work.h) }
  }
  return { x: work.x + halfW, y: work.y, w: Math.max(1, restW), h: Math.max(1, work.h) }
}

function primaryMatchesMon(mon: LayoutScreen, primaryChromeMon: LayoutScreen | null): boolean {
  return (
    !!primaryChromeMon &&
    mon.x === primaryChromeMon.x &&
    mon.y === primaryChromeMon.y &&
    mon.width === primaryChromeMon.width &&
    mon.height === primaryChromeMon.height
  )
}

export function keyboardTileHalfRectGlobal(
  mon: LayoutScreen,
  primaryChromeMon: LayoutScreen | null,
  side: 'left' | 'right',
): { x: number; y: number; w: number; h: number } {
  const work = monitorWorkAreaGlobal(mon, primaryMatchesMon(mon, primaryChromeMon))
  return halfRect(work, side)
}

export function hitTestSnapRectGlobal(
  px: number,
  py: number,
  work: { x: number; y: number; w: number; h: number },
  edgePx: number = TILE_SNAP_EDGE_PX,
): { x: number; y: number; w: number; h: number } | null {
  const { x, y, w, h } = work
  if (px < x || py < y || px > x + w || py > y + h) return null
  const dl = px - x
  const dr = x + w - px
  const dt = py - y
  const db = y + h - py
  const nearL = dl <= edgePx
  const nearR = dr <= edgePx
  const nearT = dt <= edgePx
  const nearB = db <= edgePx
  if (nearL && nearT) return quarterRect(work, 'tl')
  if (nearR && nearT) return quarterRect(work, 'tr')
  if (nearL && nearB) return quarterRect(work, 'bl')
  if (nearR && nearB) return quarterRect(work, 'br')
  if (nearL) return halfRect(work, 'left')
  if (nearR) return halfRect(work, 'right')
  return null
}

export function snapRectGlobalForPointerOnMonitor(
  px: number,
  py: number,
  mon: LayoutScreen,
  primaryChromeMon: LayoutScreen | null,
  edgePx: number = TILE_SNAP_EDGE_PX,
): { x: number; y: number; w: number; h: number } | null {
  const reserveTb =
    !!primaryChromeMon &&
    mon.x === primaryChromeMon.x &&
    mon.y === primaryChromeMon.y &&
    mon.width === primaryChromeMon.width &&
    mon.height === primaryChromeMon.height
  const work = monitorWorkAreaGlobal(mon, reserveTb)
  return hitTestSnapRectGlobal(px, py, work, edgePx)
}
