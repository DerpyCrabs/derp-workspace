import { Show, type Accessor } from 'solid-js'
import { TabContextMenu } from './TabContextMenu'
import { TraySniContextMenu } from './TraySniContextMenu'

type ShellContextMenuLayerProps = {
  ctxMenuOpen: Accessor<boolean>
  atlasOverlayPointerUsers: Accessor<number>
  shellMenuAtlasTop: Accessor<number>
  setMenuAtlasHostRef: (el: HTMLDivElement) => void
  volumeMenuOpen: Accessor<boolean>
  tabMenuOpen: Accessor<boolean>
  traySniMenuOpen: Accessor<boolean>
  tabMenuProps: Parameters<typeof TabContextMenu>[0]
  traySniMenuProps: Parameters<typeof TraySniContextMenu>[0]
}

export function ShellContextMenuLayer(props: ShellContextMenuLayerProps) {
  return (
    <div
      class="relative z-90000 contain-layout"
      classList={{
        'pointer-events-auto': props.ctxMenuOpen() || props.atlasOverlayPointerUsers() > 0,
        'pointer-events-none': !props.ctxMenuOpen() && props.atlasOverlayPointerUsers() === 0,
        'overflow-visible': props.volumeMenuOpen(),
        'overflow-hidden': !props.volumeMenuOpen(),
        'contain-paint': !props.volumeMenuOpen(),
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
      <Show when={props.tabMenuOpen()}>
        <TabContextMenu {...props.tabMenuProps} />
      </Show>
      <Show when={props.traySniMenuOpen()}>
        <TraySniContextMenu {...props.traySniMenuProps} />
      </Show>
    </div>
  )
}
