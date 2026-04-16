import {
  logicalWorkspaceBoundsFromScreens,
  menuPlacementForCompositor,
  type LogicalWorkspaceBounds,
} from '@/host/contextMenu'
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

export type MeasuredShellFloatingPlacement = {
  panelRect: DOMRect
  placement: {
    bx: number
    by: number
    bw: number
    bh: number
    gx: number
    gy: number
    gw: number
    gh: number
  }
}

let lastFloatingPlacementSignature: string | null = null

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

export function measureShellFloatingPlacementFromDom(args: {
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
}): MeasuredShellFloatingPlacement {
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
  const placement = menuPlacementForCompositor(
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
  return { panelRect, placement }
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
  const { placement } = measureShellFloatingPlacementFromDom(args)
  const signature = [
    placement.bx,
    placement.by,
    placement.bw,
    placement.bh,
    placement.gx,
    placement.gy,
    placement.gw,
    placement.gh,
  ].join(':')
  if (signature === lastFloatingPlacementSignature) return true
  lastFloatingPlacementSignature = signature
  return shellContextMenuWire(
    true,
    placement.bx,
    placement.by,
    placement.bw,
    placement.bh,
    placement.gx,
    placement.gy,
    placement.gw,
    placement.gh,
  )
}

export function hideFloatingPlacementWire(): void {
  lastFloatingPlacementSignature = null
  hideShellFloatingWire()
}
