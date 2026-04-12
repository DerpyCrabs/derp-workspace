import { Show, type Accessor } from 'solid-js'
import { PowerContextMenu } from './PowerContextMenu'
import { ProgramsContextMenu } from './ProgramsContextMenu'
import { TabContextMenu } from './TabContextMenu'
import { TraySniContextMenu } from './TraySniContextMenu'

type ShellContextMenuLayerProps = {
  ctxMenuOpen: Accessor<boolean>
  atlasOverlayPointerUsers: Accessor<number>
  shellMenuAtlasTop: Accessor<number>
  setMenuAtlasHostRef: (el: HTMLDivElement) => void
  programsMenuOpen: Accessor<boolean>
  powerMenuOpen: Accessor<boolean>
  tabMenuOpen: Accessor<boolean>
  traySniMenuOpen: Accessor<boolean>
  programsMenuProps: Parameters<typeof ProgramsContextMenu>[0]
  powerMenuProps: Parameters<typeof PowerContextMenu>[0]
  tabMenuProps: Parameters<typeof TabContextMenu>[0]
  traySniMenuProps: Parameters<typeof TraySniContextMenu>[0]
}

export function ShellContextMenuLayer(props: ShellContextMenuLayerProps) {
  return (
    <div
      class="relative z-90000 contain-layout contain-paint overflow-hidden"
      classList={{
        'pointer-events-auto': props.ctxMenuOpen() || props.atlasOverlayPointerUsers() > 0,
        'pointer-events-none': !props.ctxMenuOpen() && props.atlasOverlayPointerUsers() === 0,
      }}
      ref={(el) => {
        props.setMenuAtlasHostRef(el)
      }}
      style={{
        position: 'absolute',
        left: '0',
        right: '0',
        top: `${props.shellMenuAtlasTop()}px`,
        bottom: '0',
      }}
    >
      <Show when={props.programsMenuOpen()}>
        <ProgramsContextMenu {...props.programsMenuProps} />
      </Show>
      <Show when={props.powerMenuOpen()}>
        <PowerContextMenu {...props.powerMenuProps} />
      </Show>
      <Show when={props.tabMenuOpen()}>
        <TabContextMenu {...props.tabMenuProps} />
      </Show>
      <Show when={props.traySniMenuOpen()}>
        <TraySniContextMenu {...props.traySniMenuProps} />
      </Show>
    </div>
  )
}
