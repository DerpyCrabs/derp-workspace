import type {
  FloatingLayerKind,
  FloatingLayerPlacement,
  FloatingLayerRecord,
  FloatingLayerStoreRecord,
  createFloatingLayerStore,
} from './floatingLayers'

export type ShellOverlayAnchor = {
  x: number
  y: number
  w?: number
  h?: number
  space?: 'global' | 'client'
}

export type ShellOverlayPlacement = 'point' | 'below-start' | 'below-end' | 'above-start' | 'above-end'

export type ShellOverlayOpenArgs = {
  id: string
  kind: FloatingLayerKind
  ownerWindowId?: number | null
  parentId?: string | null
  anchor: ShellOverlayAnchor
  placement?: ShellOverlayPlacement
  size?: { w: number; h: number }
  closeOnOutside?: boolean
  closeOnEscape?: boolean
  onClose?: () => void
}

export type ShellOverlayRegistry = {
  openOverlay: (args: ShellOverlayOpenArgs) => void
  closeOverlayBranch: (id: string) => boolean
  closeOverlays: (predicate?: (layer: FloatingLayerRecord) => boolean) => boolean
  closeOverlaysByKind: (kind: FloatingLayerKind) => boolean
  closeTopmostOverlay: () => boolean
  registerOverlaySurface: (id: string, fn: (target: Node) => boolean) => void
  unregisterOverlaySurface: (id: string, fn: (target: Node) => boolean) => void
  dismissOverlayPointerDown: (target: Node | null) => boolean
  hasOverlay: (id: string) => boolean
  hasOpenOverlayKind: (kind: FloatingLayerKind) => boolean
  anyOverlayOpen: () => boolean
  topmostOverlayKind: () => FloatingLayerKind | null
  overlayLayers: () => FloatingLayerStoreRecord[]
}

function placementFromAnchor(args: ShellOverlayOpenArgs): FloatingLayerPlacement {
  const w = Math.max(1, Math.round(args.size?.w ?? args.anchor.w ?? 1))
  const h = Math.max(1, Math.round(args.size?.h ?? args.anchor.h ?? 1))
  const ax = Math.round(args.anchor.x)
  const ay = Math.round(args.anchor.y)
  const aw = Math.max(0, Math.round(args.anchor.w ?? 0))
  const ah = Math.max(0, Math.round(args.anchor.h ?? 0))
  const placement = args.placement ?? 'point'
  let gx = ax
  let gy = ay
  if (placement === 'below-start') {
    gy = ay + ah
  } else if (placement === 'below-end') {
    gx = ax + aw - w
    gy = ay + ah
  } else if (placement === 'above-start') {
    gy = ay - h
  } else if (placement === 'above-end') {
    gx = ax + aw - w
    gy = ay - h
  }
  return {
    bx: gx,
    by: gy,
    bw: w,
    bh: h,
    gx,
    gy,
    gw: w,
    gh: h,
  }
}

export function createShellOverlayRegistry(
  store: ReturnType<typeof createFloatingLayerStore>,
): ShellOverlayRegistry {
  function openOverlay(args: ShellOverlayOpenArgs) {
    store.openLayer({
      id: args.id,
      parentId: args.parentId,
      kind: args.kind,
      closeOnOutside: args.closeOnOutside,
      closeOnEscape: args.closeOnEscape,
      onClose: args.onClose,
    })
    store.setLayerPlacement(args.id, placementFromAnchor(args))
  }

  return {
    openOverlay,
    closeOverlayBranch: store.closeBranch,
    closeOverlays: store.closeAll,
    closeOverlaysByKind: store.closeByKind,
    closeTopmostOverlay: store.closeTopmostEscapable,
    registerOverlaySurface: store.registerSurface,
    unregisterOverlaySurface: store.unregisterSurface,
    dismissOverlayPointerDown: store.dismissPointerDown,
    hasOverlay: store.hasLayer,
    hasOpenOverlayKind: store.hasOpenKind,
    anyOverlayOpen: store.anyOpen,
    topmostOverlayKind: store.topmostLayerKind,
    overlayLayers: store.layers,
  }
}
