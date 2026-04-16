import { createContext, useContext, type ParentComponent } from 'solid-js'
import type { createShellContextMenus } from './createShellContextMenus'

export type ShellContextMenusController = ReturnType<typeof createShellContextMenus>

const ShellContextMenusContext = createContext<ShellContextMenusController>()

export const ShellContextMenusProvider: ParentComponent<{ value: ShellContextMenusController }> = (props) => (
  <ShellContextMenusContext.Provider value={props.value}>{props.children}</ShellContextMenusContext.Provider>
)

export function useShellContextMenus(): ShellContextMenusController {
  const value = useContext(ShellContextMenusContext)
  if (!value) {
    throw new Error('ShellContextMenusProvider missing')
  }
  return value
}
