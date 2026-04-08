import type { Rect, SnapZone } from './tileZones'
import { snapZoneToBoundsWithOccupied } from './tileZones'

export type TiledWindowEntry = { zone: SnapZone; bounds: Rect }

export type TiledResizeEdge = 'left' | 'right' | 'top' | 'bottom'

export const TILED_RESIZE_MIN_W = 200
export const TILED_RESIZE_MIN_H = 150
export const TILE_RESIZE_EDGE_ALIGN_PX = 12
export const TILE_RESIZE_SEGMENT_MIN_OVERLAP_PX = 8

const RESIZE_TOP = 1
const RESIZE_BOTTOM = 2
const RESIZE_LEFT = 4
const RESIZE_RIGHT = 8

function segmentOverlapLen(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0)
}

export function findEdgeNeighborsInMap(
  rects: ReadonlyMap<number, Rect>,
  windowId: number,
  edge: TiledResizeEdge,
  tolerance: number,
): number[] {
  const s = rects.get(windowId)
  if (!s) return []
  const out: number[] = []
  for (const [oid, o] of rects) {
    if (oid === windowId) continue
    let aligned: boolean
    let overlapOk: boolean
    switch (edge) {
      case 'right':
        aligned = Math.abs(s.x + s.width - o.x) <= tolerance
        overlapOk =
          segmentOverlapLen(s.y, s.y + s.height, o.y, o.y + o.height) >= TILE_RESIZE_SEGMENT_MIN_OVERLAP_PX
        break
      case 'left':
        aligned = Math.abs(s.x - (o.x + o.width)) <= tolerance
        overlapOk =
          segmentOverlapLen(s.y, s.y + s.height, o.y, o.y + o.height) >= TILE_RESIZE_SEGMENT_MIN_OVERLAP_PX
        break
      case 'bottom':
        aligned = Math.abs(s.y + s.height - o.y) <= tolerance
        overlapOk =
          segmentOverlapLen(s.x, s.x + s.width, o.x, o.x + o.width) >= TILE_RESIZE_SEGMENT_MIN_OVERLAP_PX
        break
      case 'top':
        aligned = Math.abs(s.y - (o.y + o.height)) <= tolerance
        overlapOk =
          segmentOverlapLen(s.x, s.x + s.width, o.x, o.x + o.width) >= TILE_RESIZE_SEGMENT_MIN_OVERLAP_PX
        break
    }
    if (aligned && overlapOk) out.push(oid)
  }
  return out
}

export function computeTiledResizeRects(
  primaryId: number,
  edges: number,
  accumDx: number,
  accumDy: number,
  initialRects: ReadonlyMap<number, Rect>,
  minW: number,
  minH: number,
): Map<number, Rect> {
  const P0 = initialRects.get(primaryId)
  if (!P0) return new Map()

  let deltaX = accumDx
  let deltaY = accumDy
  if ((edges & (RESIZE_LEFT | RESIZE_RIGHT)) && (edges & RESIZE_LEFT)) {
    deltaX = -deltaX
  }
  if ((edges & (RESIZE_TOP | RESIZE_BOTTOM)) && (edges & RESIZE_TOP)) {
    deltaY = -deltaY
  }

  let dw = 0
  let dh = 0
  if (edges & (RESIZE_LEFT | RESIZE_RIGHT)) {
    dw = Math.round(deltaX)
  }
  if (edges & (RESIZE_TOP | RESIZE_BOTTOM)) {
    dh = Math.round(deltaY)
  }

  const out = new Map<number, Rect>()
  for (const [k, v] of initialRects) {
    out.set(k, { x: v.x, y: v.y, width: v.width, height: v.height })
  }

  if (edges & RESIZE_RIGHT) {
    const nids = findEdgeNeighborsInMap(initialRects, primaryId, 'right', TILE_RESIZE_EDGE_ALIGN_PX)
    if (nids.length > 0) {
      let d = dw
      d = Math.max(minW - P0.width, d)
      for (const nid of nids) {
        const N0 = initialRects.get(nid)!
        d = Math.min(d, N0.width - minW)
      }
      dw = d
    }
  }

  if (edges & RESIZE_LEFT) {
    const nids = findEdgeNeighborsInMap(initialRects, primaryId, 'left', TILE_RESIZE_EDGE_ALIGN_PX)
    if (nids.length > 0) {
      let d = dw
      d = Math.max(minW - P0.width, d)
      for (const nid of nids) {
        const N0 = initialRects.get(nid)!
        d = Math.min(d, N0.width - minW)
      }
      dw = d
    }
  }

  if (edges & RESIZE_BOTTOM) {
    const nids = findEdgeNeighborsInMap(initialRects, primaryId, 'bottom', TILE_RESIZE_EDGE_ALIGN_PX)
    if (nids.length > 0) {
      let d = dh
      d = Math.max(minH - P0.height, d)
      for (const nid of nids) {
        const N0 = initialRects.get(nid)!
        d = Math.min(d, N0.height - minH)
      }
      dh = d
    }
  }

  if (edges & RESIZE_TOP) {
    const nids = findEdgeNeighborsInMap(initialRects, primaryId, 'top', TILE_RESIZE_EDGE_ALIGN_PX)
    if (nids.length > 0) {
      let d = dh
      d = Math.max(minH - P0.height, d)
      for (const nid of nids) {
        const N0 = initialRects.get(nid)!
        d = Math.min(d, N0.height - minH)
      }
      dh = d
    }
  }

  if (edges & (RESIZE_LEFT | RESIZE_RIGHT)) {
    const P = out.get(primaryId)!
    const nw = Math.max(minW, P0.width + dw)
    P.width = nw
    if (edges & RESIZE_LEFT) {
      P.x = P0.x + P0.width - nw
    }
  }

  if (edges & (RESIZE_TOP | RESIZE_BOTTOM)) {
    const P = out.get(primaryId)!
    const nh = Math.max(minH, P0.height + dh)
    P.height = nh
    if (edges & RESIZE_TOP) {
      P.y = P0.y + P0.height - nh
    }
  }

  const P = out.get(primaryId)!

  if (edges & RESIZE_RIGHT) {
    const dApplied = P.width - P0.width
    for (const nid of findEdgeNeighborsInMap(initialRects, primaryId, 'right', TILE_RESIZE_EDGE_ALIGN_PX)) {
      const N = out.get(nid)!
      const N0 = initialRects.get(nid)!
      N.x = P.x + P.width
      N.width = Math.max(minW, N0.width - dApplied)
    }
  }

  if (edges & RESIZE_LEFT) {
    const dApplied = P.width - P0.width
    for (const nid of findEdgeNeighborsInMap(initialRects, primaryId, 'left', TILE_RESIZE_EDGE_ALIGN_PX)) {
      const N = out.get(nid)!
      const N0 = initialRects.get(nid)!
      N.width = Math.max(minW, N0.width - dApplied)
    }
  }

  if (edges & RESIZE_BOTTOM) {
    const dApplied = P.height - P0.height
    for (const nid of findEdgeNeighborsInMap(initialRects, primaryId, 'bottom', TILE_RESIZE_EDGE_ALIGN_PX)) {
      const N = out.get(nid)!
      const N0 = initialRects.get(nid)!
      N.y = P.y + P.height
      N.height = Math.max(minH, N0.height - dApplied)
    }
  }

  if (edges & RESIZE_TOP) {
    const dApplied = P.height - P0.height
    for (const nid of findEdgeNeighborsInMap(initialRects, primaryId, 'top', TILE_RESIZE_EDGE_ALIGN_PX)) {
      const N = out.get(nid)!
      const N0 = initialRects.get(nid)!
      N.height = Math.max(minH, N0.height - dApplied)
    }
  }

  return out
}

export class MonitorTileState {
  tiledWindows = new Map<number, TiledWindowEntry>()

  findEdgeNeighbors(windowId: number, edge: TiledResizeEdge, tolerance: number): number[] {
    const m = new Map<number, Rect>()
    for (const [k, v] of this.tiledWindows) {
      m.set(k, v.bounds)
    }
    return findEdgeNeighborsInMap(m, windowId, edge, tolerance)
  }

  setTiledBounds(windowId: number, bounds: Rect): void {
    const cur = this.tiledWindows.get(windowId)
    if (!cur) return
    this.tiledWindows.set(windowId, { zone: cur.zone, bounds: { ...bounds } })
  }

  getOccupiedZones(excludeWindowId?: number): { zone: SnapZone; bounds: Rect }[] {
    const out: { zone: SnapZone; bounds: Rect }[] = []
    for (const [wid, e] of this.tiledWindows) {
      if (excludeWindowId !== undefined && wid === excludeWindowId) continue
      out.push({ zone: e.zone, bounds: e.bounds })
    }
    return out
  }

  tileWindow(windowId: number, zone: SnapZone, workArea: Rect, otherOccupied: { zone: SnapZone; bounds: Rect }[]): Rect {
    const bounds = snapZoneToBoundsWithOccupied(zone, workArea, otherOccupied)
    this.tiledWindows.set(windowId, { zone, bounds })
    return bounds
  }

  untileWindow(windowId: number): void {
    this.tiledWindows.delete(windowId)
  }

  has(windowId: number): boolean {
    return this.tiledWindows.has(windowId)
  }

  getZone(windowId: number): SnapZone | undefined {
    return this.tiledWindows.get(windowId)?.zone
  }
}

export class PerMonitorTileStates {
  private monitors = new Map<string, MonitorTileState>()
  preTileGeometry = new Map<number, { x: number; y: number; w: number; h: number }>()

  stateFor(outputName: string): MonitorTileState {
    let s = this.monitors.get(outputName)
    if (!s) {
      s = new MonitorTileState()
      this.monitors.set(outputName, s)
    }
    return s
  }

  isTiled(windowId: number): boolean {
    for (const st of this.monitors.values()) {
      if (st.has(windowId)) return true
    }
    return false
  }

  findMonitorForTiledWindow(windowId: number): string | null {
    for (const [name, st] of this.monitors) {
      if (st.has(windowId)) return name
    }
    return null
  }

  untileWindowEverywhere(windowId: number): void {
    for (const st of this.monitors.values()) {
      st.untileWindow(windowId)
    }
  }

  getTiledZone(windowId: number): SnapZone | undefined {
    for (const st of this.monitors.values()) {
      const z = st.getZone(windowId)
      if (z !== undefined) return z
    }
    return undefined
  }

  moveTiledWindowToMonitor(
    windowId: number,
    fromOutput: string,
    toOutput: string,
    zone: SnapZone,
    workArea: Rect,
    otherOccupiedOnDestination: { zone: SnapZone; bounds: Rect }[],
  ): Rect {
    this.stateFor(fromOutput).untileWindow(windowId)
    return this.stateFor(toOutput).tileWindow(windowId, zone, workArea, otherOccupiedOnDestination)
  }
}
