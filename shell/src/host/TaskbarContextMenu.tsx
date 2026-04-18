import { Show, createContext, createEffect, useContext, type Accessor, type JSX, type ParentComponent } from 'solid-js'
import { DropdownMenu, DropdownMenuPortal } from '@/components/ui/dropdown-menu'
import { shellMenuPlacementWarn } from '@/host/shellMenuPlacementWarn'
import { useShellContextMenus } from './ShellContextMenusContext'

type TaskbarContextMenuApi = {
  open: Accessor<boolean>
  onClick?: (e: MouseEvent & { currentTarget: HTMLButtonElement }) => void
  onPointerDown?: (e: PointerEvent & { currentTarget: HTMLButtonElement }) => void
}

const TaskbarContextMenuContext = createContext<TaskbarContextMenuApi>()

function useTaskbarContextMenu() {
  const value = useContext(TaskbarContextMenuContext)
  if (!value) {
    throw new Error('TaskbarContextMenu provider missing')
  }
  return value
}

function TaskbarContextMenuRoot(props: { api: TaskbarContextMenuApi; children: JSX.Element }) {
  return <TaskbarContextMenuContext.Provider value={props.api}>{props.children}</TaskbarContextMenuContext.Provider>
}

export const ProgramsTaskbarMenu: ParentComponent = (props) => {
  const shellContextMenus = useShellContextMenus()
  let suppressClick = false
  return (
    <DropdownMenu
      open={shellContextMenus.programsMenuOpen()}
      onOpenChange={(next) => {
        if (!next) shellContextMenus.hideContextMenu()
      }}
    >
      <TaskbarContextMenuRoot
        api={{
          open: shellContextMenus.programsMenuOpen,
          onPointerDown: (e) => {
            e.preventDefault()
            suppressClick = true
            shellContextMenus.onProgramsMenuClick(e)
          },
          onClick: (e) => {
            if (suppressClick) {
              suppressClick = false
              return
            }
            shellContextMenus.onProgramsMenuClick(e)
          },
        }}
      >
        {props.children}
      </TaskbarContextMenuRoot>
    </DropdownMenu>
  )
}

export const PowerTaskbarMenu: ParentComponent = (props) => {
  const shellContextMenus = useShellContextMenus()
  let suppressClick = false
  return (
    <DropdownMenu
      open={shellContextMenus.powerMenuOpen()}
      onOpenChange={(next) => {
        if (!next) shellContextMenus.hideContextMenu()
      }}
    >
      <TaskbarContextMenuRoot
        api={{
          open: shellContextMenus.powerMenuOpen,
          onPointerDown: (e) => {
            e.preventDefault()
            suppressClick = true
            shellContextMenus.onPowerMenuClick(e)
          },
          onClick: (e) => {
            if (suppressClick) {
              suppressClick = false
              return
            }
            shellContextMenus.onPowerMenuClick(e)
          },
        }}
      >
        {props.children}
      </TaskbarContextMenuRoot>
    </DropdownMenu>
  )
}

export const VolumeTaskbarMenu: ParentComponent = (props) => {
  const shellContextMenus = useShellContextMenus()
  let suppressClick = false
  return (
    <DropdownMenu
      open={shellContextMenus.volumeMenuOpen()}
      onOpenChange={(next) => {
        if (!next) shellContextMenus.hideContextMenu()
      }}
    >
      <TaskbarContextMenuRoot
        api={{
          open: shellContextMenus.volumeMenuOpen,
          onPointerDown: (e) => {
            e.preventDefault()
            suppressClick = true
            shellContextMenus.onVolumeMenuClick(e)
          },
          onClick: (e) => {
            if (suppressClick) {
              suppressClick = false
              return
            }
            shellContextMenus.onVolumeMenuClick(e)
          },
        }}
      >
        {props.children}
      </TaskbarContextMenuRoot>
    </DropdownMenu>
  )
}

export function TaskbarContextMenuTrigger(props: {
  children: (api: TaskbarContextMenuApi) => JSX.Element
}) {
  return props.children(useTaskbarContextMenu())
}

export function TaskbarContextMenuContent(props: { children: JSX.Element }) {
  const taskbarContextMenu = useTaskbarContextMenu()
  const shellContextMenus = useShellContextMenus()
  createEffect(() => {
    if (!taskbarContextMenu.open()) return
    const host = shellContextMenus.menuLayerHostEl()
    if (host) return
    shellMenuPlacementWarn('taskbar_context_menu_portal', { awaiting_menu_layer_host: true })
  })
  return (
    <Show when={taskbarContextMenu.open() && shellContextMenus.menuLayerHostEl()} keyed>
      {(host) => (
        <DropdownMenuPortal mount={host}>
          <div class="pointer-events-auto">{props.children}</div>
        </DropdownMenuPortal>
      )}
    </Show>
  )
}
