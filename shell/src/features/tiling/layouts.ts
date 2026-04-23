import type { Rect } from './tileZones'

import type { CustomLayoutSlotRule } from './customLayouts'

export type LayoutType = 'manual-snap' | 'master-stack' | 'columns' | 'grid' | 'custom-auto'

export type CustomAutoSlotParam = {
  slotId: string
  x: number
  y: number
  width: number
  height: number
  rules?: CustomLayoutSlotRule[]
}

export type LayoutParams = {
  masterRatio?: number
  maxColumns?: number
  customLayoutId?: string
  customSlots?: CustomAutoSlotParam[]
}

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

export const CustomAutoLayout: TilingLayout = {
  type: 'custom-auto',
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

function orderedIdsFromMap(currentLayout: Map<number, Rect>): number[] {
  const ids: number[] = []
  for (const id of currentLayout.keys()) {
    ids.push(id)
  }
  return ids
}

function columnsFromIds(windowIds: number[], workArea: Rect, maxColumns?: number): Map<number, Rect> {
  const out = new Map<number, Rect>()
  const n = windowIds.length
  if (n === 0) return out

  const { x, y, width: w, height: h } = workArea
  const cap = maxColumns !== undefined && maxColumns >= 1 ? maxColumns : n

  if (n <= cap) {
    for (let i = 0; i < n; i++) {
      const left = x + Math.floor((i * w) / n)
      const right = i === n - 1 ? x + w : x + Math.floor(((i + 1) * w) / n)
      out.set(windowIds[i], { x: left, y, width: right - left, height: h })
    }
    return out
  }

  const numCols = cap
  for (let j = 0; j < numCols - 1; j++) {
    const left = x + Math.floor((j * w) / numCols)
    const right = x + Math.floor(((j + 1) * w) / numCols)
    out.set(windowIds[j], { x: left, y, width: right - left, height: h })
  }

  const stackIds = windowIds.slice(numCols - 1)
  const k = stackIds.length
  const lastLeft = x + Math.floor(((numCols - 1) * w) / numCols)
  const lastRight = x + w
  for (let i = 0; i < k; i++) {
    const top = y + Math.round((i * h) / k)
    const bottom = y + Math.round(((i + 1) * h) / k)
    out.set(stackIds[i], { x: lastLeft, y: top, width: lastRight - lastLeft, height: bottom - top })
  }
  return out
}

export const ColumnsLayout: TilingLayout = {
  type: 'columns',
  computeLayout(windowIds, workArea, params) {
    return columnsFromIds(windowIds, workArea, params.maxColumns)
  },
  addWindow(windowId, currentLayout, workArea, params) {
    const ids = orderedIdsFromMap(currentLayout)
    if (!ids.includes(windowId)) ids.push(windowId)
    return columnsFromIds(ids, workArea, params.maxColumns)
  },
  removeWindow(windowId, currentLayout, workArea, params) {
    const ids = orderedIdsFromMap(currentLayout).filter((id) => id !== windowId)
    return columnsFromIds(ids, workArea, params.maxColumns)
  },
}

function gridFromIds(windowIds: number[], workArea: Rect): Map<number, Rect> {
  const out = new Map<number, Rect>()
  const n = windowIds.length
  if (n === 0) return out

  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const { x, y, width: W, height: H } = workArea
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    const left = x + Math.floor((col * W) / cols)
    const top = y + Math.floor((row * H) / rows)
    const right = col === cols - 1 ? x + W : x + Math.floor(((col + 1) * W) / cols)
    const bottom = row === rows - 1 ? y + H : y + Math.floor(((row + 1) * H) / rows)
    out.set(windowIds[i], { x: left, y: top, width: right - left, height: bottom - top })
  }
  return out
}

export const GridLayout: TilingLayout = {
  type: 'grid',
  computeLayout(windowIds, workArea) {
    return gridFromIds(windowIds, workArea)
  },
  addWindow(windowId, currentLayout, workArea) {
    const ids = orderedIdsFromMap(currentLayout)
    if (!ids.includes(windowId)) ids.push(windowId)
    return gridFromIds(ids, workArea)
  },
  removeWindow(windowId, currentLayout, workArea) {
    const ids = orderedIdsFromMap(currentLayout).filter((id) => id !== windowId)
    return gridFromIds(ids, workArea)
  },
}

export function createLayout(type: LayoutType): TilingLayout {
  switch (type) {
    case 'manual-snap':
      return ManualSnapLayout
    case 'master-stack':
      return MasterStackLayout
    case 'columns':
      return ColumnsLayout
    case 'grid':
      return GridLayout
    case 'custom-auto':
      return CustomAutoLayout
    default: {
      const _exhaustive: never = type
      return _exhaustive
    }
  }
}
