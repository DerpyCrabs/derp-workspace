import {
  CHROME_BORDER_PX,
  CHROME_RESIZE_HANDLE_PX,
  CHROME_TITLEBAR_PX,
} from '@/lib/chromeConstants'
import { shellOuterFrameFromClient } from '@/lib/exclusionRects'

export type ShellWindowFrameLayoutModel = {
  x: number
  y: number
  width: number
  height: number
  client_x?: number
  client_y?: number
  client_width?: number
  client_height?: number
  frame_x?: number
  frame_y?: number
  frame_width?: number
  frame_height?: number
  maximized: boolean
  fullscreen: boolean
  client_side_decoration?: boolean
  snap_tiled?: boolean
}

export type ShellWindowFrameLayout = {
  th: number
  bd: number
  rh: number
  inset: number
  insetTop: number
  outerW: number
  contentLeft: number
  contentTop: number
  contentW: number
  contentH: number
  showBorderChrome: boolean
  ox: number
  oy: number
  ow: number
  oh: number
}

export function emptyShellWindowFrameLayout(): ShellWindowFrameLayout {
  return {
    th: 0,
    bd: CHROME_BORDER_PX,
    rh: CHROME_RESIZE_HANDLE_PX,
    inset: 0,
    insetTop: 0,
    outerW: 1,
    contentLeft: 0,
    contentTop: 0,
    contentW: 1,
    contentH: 1,
    showBorderChrome: false,
    ox: 0,
    oy: 0,
    ow: 1,
    oh: 1,
  }
}

export function shellWindowFrameLayout(w: ShellWindowFrameLayoutModel): ShellWindowFrameLayout {
  const bd = CHROME_BORDER_PX
  const rh = CHROME_RESIZE_HANDLE_PX
  const noTilingChrome = w.maximized || w.fullscreen
  const hasCompositorFrame =
    Number.isFinite(w.client_x) &&
    Number.isFinite(w.client_y) &&
    Number.isFinite(w.client_width) &&
    Number.isFinite(w.client_height) &&
    Number.isFinite(w.frame_x) &&
    Number.isFinite(w.frame_y) &&
    Number.isFinite(w.frame_width) &&
    Number.isFinite(w.frame_height) &&
    (w.frame_width ?? 0) > 0 &&
    (w.frame_height ?? 0) > 0
  if (hasCompositorFrame) {
    const contentLeft = Math.max(0, (w.client_x ?? w.x) - (w.frame_x ?? w.x))
    const contentTop = Math.max(0, (w.client_y ?? w.y) - (w.frame_y ?? w.y))
    const frameW = Math.max(1, w.frame_width ?? w.width)
    const frameH = Math.max(1, w.frame_height ?? w.height)
    const clientW = Math.max(1, w.client_width ?? w.width)
    const clientH = Math.max(1, w.client_height ?? w.height)
    const noShellChrome =
      contentLeft === 0 &&
      contentTop === 0 &&
      frameW === clientW &&
      frameH === clientH
    const th = noShellChrome ? 0 : CHROME_TITLEBAR_PX
    const showBorderChrome = !noTilingChrome && th > 0
    const inset = showBorderChrome ? Math.max(contentLeft, bd) : contentLeft
    const insetTop = Math.max(0, contentTop - th)
    const outerW = frameW
    return {
      th,
      bd,
      rh,
      inset,
      insetTop,
      outerW,
      contentLeft,
      contentTop,
      contentW: clientW,
      contentH: clientH,
      showBorderChrome,
      ox: w.frame_x ?? w.x,
      oy: w.frame_y ?? w.y,
      ow: outerW,
      oh: frameH,
    }
  }
  const o = shellOuterFrameFromClient({
    x: w.x,
    y: w.y,
    width: w.width,
    height: w.height,
    maximized: w.maximized,
    fullscreen: w.fullscreen,
    minimized: false,
    snap_tiled: w.snap_tiled,
  })
  const th = o.th
  const inset = o.inset
  const insetTop = o.insetTop
  const outerW = w.width + inset * 2
  return {
    th,
    bd,
    rh,
    inset,
    insetTop,
    outerW,
    contentLeft: inset,
    contentTop: insetTop + th,
    contentW: w.width,
    contentH: w.height,
    showBorderChrome: !noTilingChrome,
    ox: o.x,
    oy: o.y,
    ow: o.w,
    oh: o.h,
  }
}
