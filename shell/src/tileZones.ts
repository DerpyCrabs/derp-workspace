export type SnapZone =
  | 'auto-fill'
  | 'left-half'
  | 'right-half'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'left-third'
  | 'center-third'
  | 'right-third'
  | 'top-left-two-thirds'
  | 'top-center-two-thirds'
  | 'top-right-two-thirds'
  | 'top-left-third'
  | 'top-center-third'
  | 'top-right-third'
  | 'bottom-left-two-thirds'
  | 'bottom-center-two-thirds'
  | 'bottom-right-two-thirds'
  | 'bottom-left-third'
  | 'bottom-center-third'
  | 'bottom-right-third'

export type Rect = { x: number; y: number; width: number; height: number }

export const LEFT_SIDE_ZONES: ReadonlySet<SnapZone> = new Set([
  'left-half',
  'top-left',
  'bottom-left',
  'left-third',
  'top-left-two-thirds',
  'top-left-third',
  'bottom-left-two-thirds',
  'bottom-left-third',
])

export const RIGHT_SIDE_ZONES: ReadonlySet<SnapZone> = new Set([
  'right-half',
  'top-right',
  'bottom-right',
  'right-third',
  'top-right-two-thirds',
  'top-right-third',
  'bottom-right-two-thirds',
  'bottom-right-third',
])

export const TOP_ZONES: ReadonlySet<SnapZone> = new Set([
  'top-left',
  'top-right',
  'top-left-two-thirds',
  'top-center-two-thirds',
  'top-right-two-thirds',
  'top-left-third',
  'top-center-third',
  'top-right-third',
])

export const BOTTOM_ZONES: ReadonlySet<SnapZone> = new Set([
  'bottom-left',
  'bottom-right',
  'bottom-left-two-thirds',
  'bottom-center-two-thirds',
  'bottom-right-two-thirds',
  'bottom-left-third',
  'bottom-center-third',
  'bottom-right-third',
])

function defaultSnapZoneBoundsLocal(zone: SnapZone, ww: number, wh: number): Rect {
  const halfW = Math.round(ww / 2)
  const halfH = Math.round(wh / 2)
  const thirdW = Math.round(ww / 3)
  const twoThirdW = Math.round((ww * 2) / 3)
  const thirdH = Math.round(wh / 3)
  const twoThirdH = Math.round((wh * 2) / 3)
  const ox = 0
  const oy = 0
  switch (zone) {
    case 'auto-fill':
      return { x: ox, y: oy, width: ww, height: wh }
    case 'left-half':
      return { x: ox, y: oy, width: halfW, height: wh }
    case 'right-half':
      return { x: ox + halfW, y: oy, width: ww - halfW, height: wh }
    case 'top-left':
      return { x: ox, y: oy, width: halfW, height: halfH }
    case 'top-right':
      return { x: ox + halfW, y: oy, width: ww - halfW, height: halfH }
    case 'bottom-left':
      return { x: ox, y: oy + halfH, width: halfW, height: wh - halfH }
    case 'bottom-right':
      return {
        x: ox + halfW,
        y: oy + halfH,
        width: ww - halfW,
        height: wh - halfH,
      }
    case 'left-third':
      return { x: ox, y: oy, width: thirdW, height: wh }
    case 'center-third':
      return { x: ox + thirdW, y: oy, width: twoThirdW - thirdW, height: wh }
    case 'right-third':
      return { x: ox + twoThirdW, y: oy, width: ww - twoThirdW, height: wh }
    case 'top-left-two-thirds':
      return { x: ox, y: oy, width: thirdW, height: twoThirdH }
    case 'top-center-two-thirds':
      return { x: ox + thirdW, y: oy, width: twoThirdW - thirdW, height: twoThirdH }
    case 'top-right-two-thirds':
      return { x: ox + twoThirdW, y: oy, width: ww - twoThirdW, height: twoThirdH }
    case 'top-left-third':
      return { x: ox, y: oy, width: thirdW, height: halfH }
    case 'top-center-third':
      return { x: ox + thirdW, y: oy, width: twoThirdW - thirdW, height: halfH }
    case 'top-right-third':
      return { x: ox + twoThirdW, y: oy, width: ww - twoThirdW, height: halfH }
    case 'bottom-left-two-thirds':
      return { x: ox, y: oy + thirdH, width: thirdW, height: wh - thirdH }
    case 'bottom-center-two-thirds':
      return {
        x: ox + thirdW,
        y: oy + thirdH,
        width: twoThirdW - thirdW,
        height: wh - thirdH,
      }
    case 'bottom-right-two-thirds':
      return {
        x: ox + twoThirdW,
        y: oy + thirdH,
        width: ww - twoThirdW,
        height: wh - thirdH,
      }
    case 'bottom-left-third':
      return { x: ox, y: oy + halfH, width: thirdW, height: wh - halfH }
    case 'bottom-center-third':
      return {
        x: ox + thirdW,
        y: oy + halfH,
        width: twoThirdW - thirdW,
        height: wh - halfH,
      }
    case 'bottom-right-third':
      return {
        x: ox + twoThirdW,
        y: oy + halfH,
        width: ww - twoThirdW,
        height: wh - halfH,
      }
  }
}

function shiftToWorkArea(local: Rect, workArea: Rect): Rect {
  return {
    x: workArea.x + local.x,
    y: workArea.y + local.y,
    width: local.width,
    height: local.height,
  }
}

export function snapZoneToBounds(zone: SnapZone, workArea: Rect): Rect {
  const local = defaultSnapZoneBoundsLocal(zone, workArea.width, workArea.height)
  return shiftToWorkArea(local, workArea)
}

export function snapZoneToBoundsWithOccupied(
  zone: SnapZone,
  workArea: Rect,
  occupiedZones: { zone: SnapZone; bounds: Rect }[],
): Rect {
  const local = defaultSnapZoneBoundsLocal(zone, workArea.width, workArea.height)
  let { x, y, width, height } = shiftToWorkArea(local, workArea)

  if (occupiedZones.length === 0) {
    return { x, y, width, height }
  }

  const isThirdZone = zone.includes('third')
  const wx1 = workArea.x + workArea.width
  const wy1 = workArea.y + workArea.height

  const leftOccupied = occupiedZones.filter((o) => LEFT_SIDE_ZONES.has(o.zone))
  const rightOccupied = occupiedZones.filter((o) => RIGHT_SIDE_ZONES.has(o.zone))
  const topOccupied = occupiedZones.filter((o) => TOP_ZONES.has(o.zone))
  const bottomOccupied = occupiedZones.filter((o) => BOTTOM_ZONES.has(o.zone))

  if (!isThirdZone) {
    if (RIGHT_SIDE_ZONES.has(zone) && leftOccupied.length > 0) {
      const leftEdge = Math.max(...leftOccupied.map((o) => o.bounds.x + o.bounds.width))
      x = leftEdge
      width = wx1 - leftEdge
    }
    if (LEFT_SIDE_ZONES.has(zone) && rightOccupied.length > 0) {
      const rightEdge = Math.min(...rightOccupied.map((o) => o.bounds.x))
      width = rightEdge - x
    }
  }

  if (BOTTOM_ZONES.has(zone) && topOccupied.length > 0) {
    const topEdge = Math.max(...topOccupied.map((o) => o.bounds.y + o.bounds.height))
    y = topEdge
    height = wy1 - topEdge
  }
  if (TOP_ZONES.has(zone) && bottomOccupied.length > 0) {
    const bottomEdge = Math.min(...bottomOccupied.map((o) => o.bounds.y))
    height = bottomEdge - y
  }

  width = Math.max(1, width)
  height = Math.max(1, height)

  return { x, y, width, height }
}
