import type { Rect as TileRect, SnapZone } from './tileZones'
import { snapZoneToBounds } from './tileZones'

export const ASSIST_GRID_SHAPES = ['2x2', '3x2', '2x3', '3x3'] as const
export type AssistGridShape = (typeof ASSIST_GRID_SHAPES)[number]

export const DEFAULT_ASSIST_GRID_SHAPE: AssistGridShape = '3x2'

export type AssistGridSpan = {
  gridCols: number
  gridRows: number
  gc0: number
  gc1: number
  gr0: number
  gr1: number
}

export function assistShapeToDims(shape: AssistGridShape): { cols: number; rows: number } {
  switch (shape) {
    case '2x2':
      return { cols: 2, rows: 2 }
    case '3x2':
      return { cols: 3, rows: 2 }
    case '2x3':
      return { cols: 2, rows: 3 }
    case '3x3':
      return { cols: 3, rows: 3 }
  }
}

export function assistShapeFromSpan(span: AssistGridSpan): AssistGridShape | null {
  if (span.gridCols === 2 && span.gridRows === 2) return '2x2'
  if (span.gridCols === 3 && span.gridRows === 2) return '3x2'
  if (span.gridCols === 2 && span.gridRows === 3) return '2x3'
  if (span.gridCols === 3 && span.gridRows === 3) return '3x3'
  return null
}

export function assistGridGutterPx(
  work: { w: number; h: number },
  shape: AssistGridShape,
): number {
  const { cols, rows } = assistShapeToDims(shape)
  const cap = Math.min(
    6,
    Math.max(2, Math.floor(Math.min(work.w / (cols * 6), work.h / (rows * 6)))),
  )
  return cap
}

export function assistGridMetrics(
  work: { w: number; h: number },
  shape: AssistGridShape,
): { cols: number; rows: number; cellW: number; cellH: number; g: number } {
  const { cols, rows } = assistShapeToDims(shape)
  const g = assistGridGutterPx(work, shape)
  const cellW = (work.w - (cols - 1) * g) / cols
  const cellH = (work.h - (rows - 1) * g) / rows
  return { cols, rows, cellW, cellH, g }
}

export function assistSpanToGridLines(span: AssistGridSpan): {
  colStart: number
  colEnd: number
  rowStart: number
  rowEnd: number
} {
  return {
    colStart: span.gc0 * 2 + 1,
    colEnd: span.gc1 * 2 + 2,
    rowStart: span.gr0 * 2 + 1,
    rowEnd: span.gr1 * 2 + 2,
  }
}

export function assistGridSpansEqual(a: AssistGridSpan, b: AssistGridSpan): boolean {
  return (
    a.gridCols === b.gridCols &&
    a.gridRows === b.gridRows &&
    a.gc0 === b.gc0 &&
    a.gc1 === b.gc1 &&
    a.gr0 === b.gr0 &&
    a.gr1 === b.gr1
  )
}

export function assistPickMatchesGridSpan(
  hover: AssistGridSpan | null,
  span: AssistGridSpan,
): boolean {
  return hover != null && assistGridSpansEqual(hover, span)
}

function colOrRowSpanAlongAxis(
  t: number,
  count: number,
  cellLen: number,
  g: number,
): { i0: number; i1: number } {
  const lx = Math.min(Math.max(0, t), Math.max(0, count * cellLen + (count - 1) * g - 1e-6))
  let pos = 0
  for (let c = 0; c < count; c++) {
    const cellRight = pos + cellLen
    if (lx < cellRight || (c === count - 1 && lx <= cellRight + 1e-6)) {
      return { i0: c, i1: c }
    }
    pos = cellRight
    if (c < count - 1) {
      const gutRight = pos + g
      if (lx < gutRight) {
        return { i0: c, i1: c + 1 }
      }
      pos = gutRight
    }
  }
  return { i0: count - 1, i1: count - 1 }
}

export function assistSpanFromWorkAreaPoint(
  px: number,
  py: number,
  shape: AssistGridShape,
  work: { x: number; y: number; w: number; h: number },
): AssistGridSpan | null {
  if (px < work.x || py < work.y || px > work.x + work.w || py > work.y + work.h) return null
  const { cols, rows, cellW, cellH, g } = assistGridMetrics(work, shape)
  const lx = px - work.x
  const ly = py - work.y
  const xc = colOrRowSpanAlongAxis(lx, cols, cellW, g)
  const yc = colOrRowSpanAlongAxis(ly, rows, cellH, g)
  return {
    gridCols: cols,
    gridRows: rows,
    gc0: xc.i0,
    gc1: xc.i1,
    gr0: yc.i0,
    gr1: yc.i1,
  }
}

export function assistSpanToGlobalPreviewRect(
  span: AssistGridSpan,
  work: { x: number; y: number; w: number; h: number },
  shape: AssistGridShape,
): TileRect {
  const { cellW, cellH, g } = assistGridMetrics(work, shape)
  const x0 = work.x + span.gc0 * (cellW + g)
  const x1 = work.x + span.gc1 * (cellW + g) + cellW
  const y0 = work.y + span.gr0 * (cellH + g)
  const y1 = work.y + span.gr1 * (cellH + g) + cellH
  return {
    x: Math.round(x0),
    y: Math.round(y0),
    width: Math.max(1, Math.round(x1 - x0)),
    height: Math.max(1, Math.round(y1 - y0)),
  }
}

const MAP_2X2: SnapZone[][] = [
  ['top-left', 'top-right'],
  ['bottom-left', 'bottom-right'],
]

const MAP_3X2: SnapZone[][] = [
  ['top-left-third', 'top-center-third', 'top-right-third'],
  ['bottom-left-third', 'bottom-center-third', 'bottom-right-third'],
]

const ALL_SNAP_ZONES: SnapZone[] = [
  'left-half',
  'right-half',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'left-third',
  'center-third',
  'right-third',
  'left-two-thirds',
  'right-two-thirds',
  'top-left-two-thirds',
  'top-center-two-thirds',
  'top-right-two-thirds',
  'top-left-third',
  'top-center-third',
  'top-right-third',
  'bottom-left-two-thirds',
  'bottom-center-two-thirds',
  'bottom-right-two-thirds',
  'bottom-left-third',
  'bottom-center-third',
  'bottom-right-third',
]

function rectOverlapArea(a: TileRect, b: TileRect): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  if (x2 <= x1 || y2 <= y1) return 0
  return (x2 - x1) * (y2 - y1)
}

function rectArea(rect: TileRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height)
}

function bestSnapZoneForRect(workRect: TileRect, cell: TileRect): SnapZone {
  let best: SnapZone = 'center-third'
  let bestA = -1
  let bestAreaDiff = Number.POSITIVE_INFINITY
  const cellArea = rectArea(cell)
  for (const z of ALL_SNAP_ZONES) {
    const b = snapZoneToBounds(z, workRect)
    const a = rectOverlapArea(cell, b)
    const areaDiff = Math.abs(rectArea(b) - cellArea)
    if (a > bestA || (a === bestA && areaDiff < bestAreaDiff)) {
      bestA = a
      bestAreaDiff = areaDiff
      best = z
    }
  }
  return best
}

function zoneFromSingleCell(
  shape: AssistGridShape,
  col: number,
  row: number,
  work: { x: number; y: number; w: number; h: number },
  previewRect: TileRect,
): SnapZone {
  if (shape === '2x2') return MAP_2X2[row][col]
  if (shape === '3x2') return MAP_3X2[row][col]
  const workRect: TileRect = { x: work.x, y: work.y, width: work.w, height: work.h }
  return bestSnapZoneForRect(workRect, previewRect)
}

export function snapZoneAndPreviewFromAssistSpan(
  span: AssistGridSpan,
  shape: AssistGridShape,
  work: { x: number; y: number; w: number; h: number },
): { zone: SnapZone; previewRect: TileRect } {
  const previewRect = assistSpanToGlobalPreviewRect(span, work, shape)
  const workRect: TileRect = { x: work.x, y: work.y, width: work.w, height: work.h }
  if (span.gc0 === span.gc1 && span.gr0 === span.gr1) {
    return {
      zone: zoneFromSingleCell(shape, span.gc0, span.gr0, work, previewRect),
      previewRect,
    }
  }
  return { zone: bestSnapZoneForRect(workRect, previewRect), previewRect }
}

function clampIndex(value: number, count: number): number {
  return Math.max(0, Math.min(count - 1, value))
}

function columnFromPoint(px: number, work: { x: number; w: number }, cols: number): number {
  const ratio = (px - work.x) / Math.max(1, work.w)
  return clampIndex(Math.floor(ratio * cols), cols)
}

export function snapZoneFromEdgePointer(
  px: number,
  _py: number,
  shape: AssistGridShape,
  work: { x: number; y: number; w: number; h: number },
  nearLeft: boolean,
  nearRight: boolean,
  nearTop: boolean,
  nearBottom: boolean,
): SnapZone {
  const { cols, rows } = assistShapeToDims(shape)
  if (nearTop) {
    const col = columnFromPoint(px, work, cols)
    return snapZoneAndPreviewFromAssistSpan(
      {
        gridCols: cols,
        gridRows: rows,
        gc0: col,
        gc1: col,
        gr0: 0,
        gr1: 0,
      },
      shape,
      work,
    ).zone
  }
  if (nearBottom) {
    const col = columnFromPoint(px, work, cols)
    return snapZoneAndPreviewFromAssistSpan(
      {
        gridCols: cols,
        gridRows: rows,
        gc0: col,
        gc1: col,
        gr0: rows - 1,
        gr1: rows - 1,
      },
      shape,
      work,
    ).zone
  }
  if (nearLeft) {
    return snapZoneAndPreviewFromAssistSpan(
      {
        gridCols: cols,
        gridRows: rows,
        gc0: 0,
        gc1: 0,
        gr0: 0,
        gr1: rows - 1,
      },
      shape,
      work,
    ).zone
  }
  if (nearRight) {
    return snapZoneAndPreviewFromAssistSpan(
      {
        gridCols: cols,
        gridRows: rows,
        gc0: cols - 1,
        gc1: cols - 1,
        gr0: 0,
        gr1: rows - 1,
      },
      shape,
      work,
    ).zone
  }
  return 'center-third'
}
