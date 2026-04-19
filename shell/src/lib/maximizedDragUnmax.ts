export function maximizedDragUnmaxCanvasPosition(args: {
  pointerCanvasX: number
  pointerCanvasY: number
  frameX: number
  frameY: number
  frameW: number
  frameH: number
  restoreW: number
  restoreH: number
}): { x: number; y: number; rx: number; ry: number } {
  const fw = Math.max(1, args.frameW)
  const fh = Math.max(1, args.frameH)
  const rw = Math.max(1, args.restoreW)
  const rh = Math.max(1, args.restoreH)
  const ox = Math.min(Math.max(args.pointerCanvasX - args.frameX, 0), fw)
  const oy = Math.min(Math.max(args.pointerCanvasY - args.frameY, 0), fh)
  const rx = ox / fw
  const ry = oy / fh
  const x = Math.round(args.pointerCanvasX - rx * rw)
  const y = Math.round(args.pointerCanvasY - ry * rh)
  return { x, y, rx, ry }
}
