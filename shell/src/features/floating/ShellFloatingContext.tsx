import { createContext, useContext, type ParentComponent } from 'solid-js'
import type { Accessor } from 'solid-js'
import type {
  FloatingLayerKind,
  FloatingLayerPlacement,
  FloatingLayerRecord,
  FloatingLayerStoreRecord,
} from './floatingLayers'
import type { ShellOverlayOpenArgs } from './shellOverlay'
import type { ShellFloatingScreenLike } from './shellFloatingPlacement'

export type ShellFloatingRegistry = {
  openOverlay: (args: ShellOverlayOpenArgs) => void
  openLayer: (args: {
    id: string
    parentId?: string | null
    kind: FloatingLayerKind
    closeOnOutside?: boolean
    closeOnEscape?: boolean
    onClose?: () => void
  }) => void
  closeBranch: (id: string) => boolean
  closeAll: (predicate?: (layer: FloatingLayerRecord) => boolean) => boolean
  closeByKind: (kind: FloatingLayerKind) => boolean
  closeTopmostEscapable: () => boolean
  registerLayerSurface: (id: string, fn: (target: Node) => boolean) => void
  unregisterLayerSurface: (id: string, fn: (target: Node) => boolean) => void
  dismissPointerDown: (target: Node | null) => boolean
  setLayerPlacement: (id: string, placement: FloatingLayerPlacement) => void
  clearLayerPlacement: (id: string) => void
  hasLayer: (id: string) => boolean
  hasOpenKind: (kind: FloatingLayerKind) => boolean
  anyOpen: () => boolean
  topmostLayerKind: () => FloatingLayerKind | null
  layers: Accessor<FloatingLayerStoreRecord[]>
  closeAllAtlasSelects: () => boolean
  dismissContextMenus: () => void
  acquireOverlayPointer: () => void
  releaseOverlayPointer: () => void
  mainEl: () => HTMLElement | undefined
  menuLayerHostEl: () => HTMLElement | undefined
  outputGeom: Accessor<{ w: number; h: number } | null>
  outputPhysical: Accessor<{ w: number; h: number } | null>
  layoutCanvasOrigin: Accessor<{ x: number; y: number } | null>
  screenDraftRows: Accessor<readonly ShellFloatingScreenLike[]>
}

const ShellFloatingContext = createContext<ShellFloatingRegistry>()

export const ShellFloatingProvider: ParentComponent<{ value: ShellFloatingRegistry }> = (props) => (
  <ShellFloatingContext.Provider value={props.value}>{props.children}</ShellFloatingContext.Provider>
)

export function useShellFloating(): ShellFloatingRegistry {
  const v = useContext(ShellFloatingContext)
  if (!v) {
    throw new Error('ShellFloatingProvider missing')
  }
  return v
}

export function tryUseShellFloating(): ShellFloatingRegistry | undefined {
  return useContext(ShellFloatingContext)
}
