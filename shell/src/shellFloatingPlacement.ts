import {
  logicalWorkspaceBoundsFromScreens,
  menuPlacementForCompositor,
  type LogicalWorkspaceBounds,
} from './contextMenu'
import { hideShellFloatingWire, shellContextMenuWire } from './shellFloatingWire'

export type ShellFloatingAnchor = {
  x: number
  y: number
  alignAboveY?: number
}

export type ShellFloatingScreenLike = {
  x: number
  y: number
  width: number
  height: number
}

export function placementWorkspaceBounds(
  screens: ReadonlyArray<ShellFloatingScreenLike>,
  layoutOrigin: { x: number; y: number } | null,
  canvasW: number,
  canvasH: number,
  physicalH: number,
  atlasBufH: number,
): LogicalWorkspaceBounds {
  return logicalWorkspaceBoundsFromScreens(
    screens,
    layoutOrigin,
    canvasW,
    canvasH,
    physicalH,
    atlasBufH,
  )
}

export function pushShellFloatingWireFromDom(args: {
  main: HTMLElement
  atlasHost: HTMLElement
  panel: HTMLElement
  anchor: ShellFloatingAnchor
  canvasW: number
  canvasH: number
  physicalW: number
  physicalH: number
  contextMenuAtlasBufferH: number
  screens: ReadonlyArray<ShellFloatingScreenLike>
  layoutOrigin: { x: number; y: number } | null
}): boolean {
  const mainRect = args.main.getBoundingClientRect()
  const atlasRect = args.atlasHost.getBoundingClientRect()
  const panelRect = args.panel.getBoundingClientRect()
  const wsBounds = placementWorkspaceBounds(
    args.screens,
    args.layoutOrigin,
    args.canvasW,
    args.canvasH,
    args.physicalH,
    args.contextMenuAtlasBufferH,
  )
  const p = menuPlacementForCompositor(
    mainRect,
    atlasRect,
    panelRect,
    args.canvasW,
    args.canvasH,
    args.physicalW,
    args.physicalH,
    args.contextMenuAtlasBufferH,
    args.anchor.x,
    args.anchor.y,
    args.anchor.alignAboveY ?? null,
    args.layoutOrigin,
    wsBounds,
  )
  return shellContextMenuWire(true, p.bx, p.by, p.bw, p.bh, p.gx, p.gy, p.gw, p.gh)
}

export function hideFloatingPlacementWire(): void {
  hideShellFloatingWire()
}
