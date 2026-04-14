import { Show, createContext, useContext, type Accessor, type JSX, type ParentComponent } from 'solid-js'
import { Portal } from 'solid-js/web'
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
  return (
    <TaskbarContextMenuRoot
      api={{
        open: shellContextMenus.programsMenuOpen,
        onClick: shellContextMenus.onProgramsMenuClick,
      }}
    >
      {props.children}
    </TaskbarContextMenuRoot>
  )
}

export const PowerTaskbarMenu: ParentComponent = (props) => {
  const shellContextMenus = useShellContextMenus()
  return (
    <TaskbarContextMenuRoot
      api={{
        open: shellContextMenus.powerMenuOpen,
        onClick: shellContextMenus.onPowerMenuClick,
      }}
    >
      {props.children}
    </TaskbarContextMenuRoot>
  )
}

export const VolumeTaskbarMenu: ParentComponent = (props) => {
  const shellContextMenus = useShellContextMenus()
  let suppressClick = false
  return (
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
  return (
    <Show when={taskbarContextMenu.open() && shellContextMenus.atlasHostEl()} keyed>
      {(host) => <Portal mount={host}>{props.children}</Portal>}
    </Show>
  )
}
