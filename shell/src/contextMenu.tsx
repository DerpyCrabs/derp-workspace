export type ShellContextMenuItem = {
  label: string
  action: () => void
  badge?: string
}

export type LogicalWorkspaceBounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function logicalWorkspaceBoundsFromScreens(
  screens: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  origin: { x: number; y: number } | null,
  canvasW: number,
  canvasH: number,
  physicalH: number,
  atlasBufH: number,
): LogicalWorkspaceBounds {
  const cw = Math.max(1, canvasW)
  const ch = Math.max(1, canvasH)
  const ox = origin?.x ?? 0
  const oy = origin?.y ?? 0
  const phys = Math.max(1, Math.round(physicalH))
  const workMaxY = oy + atlasTopFromLayout(ch, phys, atlasBufH)
  const emptyFallback = { minX: ox, minY: oy, maxX: ox + cw, maxY: workMaxY }
  if (screens.length === 0) {
    return emptyFallback
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of screens) {
    minX = Math.min(minX, s.x)
    minY = Math.min(minY, s.y)
    maxX = Math.max(maxX, s.x + s.width)
    maxY = Math.max(maxY, s.y + s.height)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return emptyFallback
  }
  return { minX, minY, maxX, maxY: Math.min(maxY, workMaxY) }
}

export function fitContextMenuGlobalPosition(
  anchorLogical: { x: number; y: number },
  menuLogicalW: number,
  menuLogicalH: number,
  workspace: LogicalWorkspaceBounds,
  flipAboveLogicalY: number | null,
): { gx: number; gy: number } {
  const w = Math.max(1, Math.round(menuLogicalW))
  const h = Math.max(1, Math.round(menuLogicalH))
  const ax = Math.round(anchorLogical.x)
  const ay = Math.round(anchorLogical.y)
  let gx = ax
  let gy = ay
  const { minX, minY, maxX, maxY } = workspace

  if (gy + h > maxY) {
    if (flipAboveLogicalY !== null) {
      gy = Math.round(flipAboveLogicalY) - h
    } else {
      gy = ay - h
    }
  }
  if (gx + w > maxX) {
    const left = ax - w
    if (left >= minX) {
      gx = left
    } else {
      gx = maxX - w
    }
  }
  if (gx < minX) gx = minX
  if (gy + h > maxY) gy = maxY - h
  if (gy < minY) gy = minY
  return { gx, gy }
}

export function atlasTopFromLayout(clh: number, cph: number, atlasBufH: number): number {
  const c = Math.max(1, clh)
  const p = Math.max(1, cph)
  const a = Math.max(1, atlasBufH)
  const atlasLog = Math.max(1, Math.ceil((a * c) / p))
  return Math.max(0, c - atlasLog)
}

function mainRefCssSize(mainRect: DOMRect, clw: number, clh: number) {
  const rw = Math.max(1, Math.min(mainRect.width, clw))
  const rh = Math.max(1, Math.min(mainRect.height, clh))
  return { rw, rh }
}

function clientPointToGlobalLogical(
  clientX: number,
  clientY: number,
  mainRect: DOMRect,
  clw: number,
  clh: number,
  origin: { x: number; y: number } | null,
) {
  const ox = origin?.x ?? 0
  const oy = origin?.y ?? 0
  const { rw, rh } = mainRefCssSize(mainRect, clw, clh)
  const sx = Math.max(1, clw) / rw
  const sy = Math.max(1, clh) / rh
  return {
    x: Math.round((clientX - mainRect.left) * sx + ox),
    y: Math.round((clientY - mainRect.top) * sy + oy),
  }
}

export function menuPlacementForCompositor(
  mainRect: DOMRect,
  atlasRect: DOMRect,
  menuRect: DOMRect,
  clw: number,
  clh: number,
  cpw: number,
  cph: number,
  atlasBufH: number,
  anchorClientX: number,
  anchorClientY: number,
  alignAboveClientY: number | null,
  origin: { x: number; y: number } | null,
  workspace: LogicalWorkspaceBounds,
): {
  bx: number
  by: number
  bw: number
  bh: number
  gx: number
  gy: number
  gw: number
  gh: number
} {
  const awDom = Math.max(1, atlasRect.width)
  const ahDom = Math.max(1, atlasRect.height)
  const stripTop = atlasTopFromLayout(clh, cph, atlasBufH)
  const stripLogicalH = Math.max(1, clh - stripTop)
  const awSpan = Math.max(awDom, clw)
  const ahSpan = Math.max(ahDom, stripLogicalH)
  const mx = menuRect.left - atlasRect.left
  const my = menuRect.top - atlasRect.top
  const bufW = Math.max(1, cpw)
  const bufH = Math.max(1, cph)
  const aStrip = Math.max(1, Math.min(atlasBufH, bufH))
  const { rw, rh } = mainRefCssSize(mainRect, clw, clh)
  const gw = Math.max(1, Math.round((menuRect.width / rw) * clw))
  const gh = Math.max(1, Math.round((menuRect.height / rh) * clh))
  const bx = Math.round((mx / awSpan) * bufW)
  const bw = Math.max(1, Math.round((gw * bufW) / clw))
  const by = Math.round(bufH - aStrip + (my / ahSpan) * aStrip)
  const bh = Math.max(1, Math.round((gh * aStrip) / stripLogicalH))
  const pt = clientPointToGlobalLogical(anchorClientX, anchorClientY, mainRect, clw, clh, origin)
  const flipAboveLogicalY =
    alignAboveClientY === null
      ? null
      : clientPointToGlobalLogical(anchorClientX, alignAboveClientY, mainRect, clw, clh, origin).y
  const fit = fitContextMenuGlobalPosition(pt, gw, gh, workspace, flipAboveLogicalY)
  const gx = fit.gx
  const gy = fit.gy
  return {
    bx,
    by,
    bw,
    bh,
    gx,
    gy,
    gw,
    gh,
  }
}
