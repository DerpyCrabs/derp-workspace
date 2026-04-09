import { createContext, useContext, type ParentComponent } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { ShellFloatingScreenLike } from './shellFloatingPlacement'

export type ShellFloatingRegistry = {
  registerAtlasSelectCloser: (fn: () => boolean) => void
  unregisterAtlasSelectCloser: (fn: () => boolean) => void
  closeAllAtlasSelects: () => boolean
  dismissContextMenus: () => void
  acquireAtlasOverlayPointer: () => void
  releaseAtlasOverlayPointer: () => void
  mainEl: () => HTMLElement | undefined
  atlasHostEl: () => HTMLElement | undefined
  atlasBufferH: Accessor<number>
  menuAtlasTopPx: Accessor<number>
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
