import { CHROME_TASKBAR_RESERVE_PX, CHROME_TITLEBAR_PX } from '@/lib/chromeConstants'
import { snapZoneFromEdgePointer, type AssistGridShape } from './assistGrid'
import type { SnapZone } from './tileZones'
import type { TaskbarSide } from '@/host/types'

export type LayoutScreen = {
  x: number
  y: number
  width: number
  height: number
  usable_x?: number
  usable_y?: number
  usable_width?: number
  usable_height?: number
}

export const TILE_SNAP_EDGE_PX = 18

export function monitorTileFrameAreaGlobal(
  mon: LayoutScreen,
  reserveTaskbar: boolean,
  taskbarSide: TaskbarSide = 'bottom',
  taskbarReservePx: number = CHROME_TASKBAR_RESERVE_PX,
): { x: number; y: number; w: number; h: number } {
  const base = {
    x: typeof mon.usable_x === 'number' && Number.isFinite(mon.usable_x) ? mon.usable_x : mon.x,
    y: typeof mon.usable_y === 'number' && Number.isFinite(mon.usable_y) ? mon.usable_y : mon.y,
    width:
      typeof mon.usable_width === 'number' && Number.isFinite(mon.usable_width)
        ? mon.usable_width
        : mon.width,
    height:
      typeof mon.usable_height === 'number' && Number.isFinite(mon.usable_height)
        ? mon.usable_height
        : mon.height,
  }
  const tb = reserveTaskbar ? taskbarReservePx : 0
  if (tb <= 0) {
    return {
      x: base.x,
      y: base.y,
      w: Math.max(1, base.width),
      h: Math.max(1, base.height),
    }
  }
  if (taskbarSide === 'top') {
    return {
      x: base.x,
      y: base.y + tb,
      w: Math.max(1, base.width),
      h: Math.max(1, base.height - tb),
    }
  }
  if (taskbarSide === 'left') {
    return {
      x: base.x + tb,
      y: base.y,
      w: Math.max(1, base.width - tb),
      h: Math.max(1, base.height),
    }
  }
  if (taskbarSide === 'right') {
    return {
      x: base.x,
      y: base.y,
      w: Math.max(1, base.width - tb),
      h: Math.max(1, base.height),
    }
  }
  return {
    x: base.x,
    y: base.y,
    w: Math.max(1, base.width),
    h: Math.max(1, base.height - tb),
  }
}

export function monitorWorkAreaGlobal(
  mon: LayoutScreen,
  reserveTaskbar: boolean,
  titlebarPx: number = CHROME_TITLEBAR_PX,
  taskbarReservePx: number = CHROME_TASKBAR_RESERVE_PX,
  taskbarSide: TaskbarSide = 'bottom',
): { x: number; y: number; w: number; h: number } {
  const frame = monitorTileFrameAreaGlobal(mon, reserveTaskbar, taskbarSide, taskbarReservePx)
  return {
    x: frame.x,
    y: frame.y + titlebarPx,
    w: frame.w,
    h: Math.max(1, frame.h - titlebarPx),
  }
}

export function tiledFrameRectToClientRect(rect: {
  x: number
  y: number
  width: number
  height: number
}): { x: number; y: number; width: number; height: number } {
  return {
    x: rect.x,
    y: rect.y + CHROME_TITLEBAR_PX,
    width: rect.width,
    height: Math.max(1, rect.height - CHROME_TITLEBAR_PX),
  }
}

export function tiledClientRectToFrameRect(rect: {
  x: number
  y: number
  width: number
  height: number
}): { x: number; y: number; width: number; height: number } {
  return {
    x: rect.x,
    y: rect.y - CHROME_TITLEBAR_PX,
    width: rect.width,
    height: rect.height + CHROME_TITLEBAR_PX,
  }
}

export function hitTestSnapZoneGlobal(
  px: number,
  py: number,
  work: { x: number; y: number; w: number; h: number },
  shape: AssistGridShape = '2x2',
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
  if (nearL || nearR || nearT || nearB) {
    return snapZoneFromEdgePointer(px, py, shape, work, nearL, nearR, nearT, nearB)
  }
  return null
}
