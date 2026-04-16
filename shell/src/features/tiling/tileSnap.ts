import { CHROME_TASKBAR_RESERVE_PX, CHROME_TITLEBAR_PX } from '@/lib/chromeConstants'
import type { SnapZone } from './tileZones'

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

export function hitTestSnapZoneGlobal(
  px: number,
  py: number,
  work: { x: number; y: number; w: number; h: number },
  edgePx: number = TILE_SNAP_EDGE_PX,
  titlebarProbePx: number = CHROME_TITLEBAR_PX,
): SnapZone | null {
  const { x, y, w, h } = work
  const yTop = y - titlebarProbePx
  if (px < x || py < yTop || px > x + w || py > y + h) return null
  const dl = px - x
  const dr = x + w - px
  const nearT = py >= y ? py - y <= edgePx : y - py <= titlebarProbePx
  const db = y + h - py
  const nearL = dl <= edgePx
  const nearR = dr <= edgePx
  const nearB = db <= edgePx
  if (nearL && nearT) return 'top-left'
  if (nearR && nearT) return 'top-right'
  if (nearL && nearB) return 'bottom-left'
  if (nearR && nearB) return 'bottom-right'
  if (nearL) return 'left-half'
  if (nearR) return 'right-half'
  return null
}
