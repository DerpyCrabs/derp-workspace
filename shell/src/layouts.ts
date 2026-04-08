import type { Rect } from './tileZones'

export type LayoutType = 'manual-snap' | 'master-stack' | 'columns' | 'grid'

export type LayoutParams = { masterRatio?: number }

export interface TilingLayout {
  type: LayoutType
  computeLayout(windowIds: number[], workArea: Rect, params: LayoutParams): Map<number, Rect>
  addWindow(
    windowId: number,
    currentLayout: Map<number, Rect>,
    workArea: Rect,
    params: LayoutParams,
  ): Map<number, Rect>
  removeWindow(
    windowId: number,
    currentLayout: Map<number, Rect>,
    workArea: Rect,
    params: LayoutParams,
  ): Map<number, Rect>
}

const DEFAULT_MASTER_RATIO = 0.55

function clampRatio(r: number): number {
  if (Number.isNaN(r)) return DEFAULT_MASTER_RATIO
  return Math.min(0.99, Math.max(0.01, r))
}

function masterStackFromIds(windowIds: number[], workArea: Rect, masterRatio: number): Map<number, Rect> {
  const out = new Map<number, Rect>()
  const nAll = windowIds.length
  if (nAll === 0) return out

  const ratio = clampRatio(masterRatio)
  const { x, y, width: w, height: h } = workArea

  if (nAll === 1) {
    out.set(windowIds[0], { x, y, width: w, height: h })
    return out
  }

  const masterW = Math.floor(w * ratio)
  const stackW = w - masterW
  out.set(windowIds[0], { x, y, width: masterW, height: h })

  const stackIds = windowIds.slice(1)
  const n = stackIds.length
  for (let i = 0; i < n; i++) {
    const top = y + Math.round((i * h) / n)
    const bottom = y + Math.round(((i + 1) * h) / n)
    out.set(stackIds[i], { x: x + masterW, y: top, width: stackW, height: bottom - top })
  }
  return out
}

export const ManualSnapLayout: TilingLayout = {
  type: 'manual-snap',
  computeLayout() {
    return new Map()
  },
  addWindow(_windowId, currentLayout) {
    return new Map(currentLayout)
  },
  removeWindow(windowId, currentLayout) {
    const m = new Map(currentLayout)
    m.delete(windowId)
    return m
  },
}

export const MasterStackLayout: TilingLayout = {
  type: 'master-stack',
  computeLayout(windowIds, workArea, params) {
    const r = params.masterRatio ?? DEFAULT_MASTER_RATIO
    return masterStackFromIds(windowIds, workArea, r)
  },
  addWindow(windowId, currentLayout, workArea, params) {
    const r = params.masterRatio ?? DEFAULT_MASTER_RATIO
    const ids: number[] = []
    for (const id of currentLayout.keys()) {
      ids.push(id)
    }
    if (!ids.includes(windowId)) ids.push(windowId)
    return masterStackFromIds(ids, workArea, r)
  },
  removeWindow(windowId, currentLayout, workArea, params) {
    const r = params.masterRatio ?? DEFAULT_MASTER_RATIO
    const ids: number[] = []
    for (const id of currentLayout.keys()) {
      if (id !== windowId) ids.push(id)
    }
    return masterStackFromIds(ids, workArea, r)
  },
}
