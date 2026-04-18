import { Show, type Accessor } from 'solid-js'
import { TabContextMenu } from './TabContextMenu'
import { TraySniContextMenu } from './TraySniContextMenu'

type ShellContextMenuLayerProps = {
  ctxMenuOpen: Accessor<boolean>
  chromeOverlayPointerUsers: Accessor<number>
  setMenuLayerHostRef: (el: HTMLDivElement | undefined) => void
  taskbarPortalMenusOpen: Accessor<boolean>
  tabMenuOpen: Accessor<boolean>
  traySniMenuOpen: Accessor<boolean>
  tabMenuProps: Parameters<typeof TabContextMenu>[0]
  traySniMenuProps: Parameters<typeof TraySniContextMenu>[0]
}

export function ShellContextMenuLayer(props: ShellContextMenuLayerProps) {
  return (
    <div
      id="derp-shell-menu-layer-host"
      data-shell-menu-layer-host
      data-shell-menu-layer-z="420000"
      class="pointer-events-none fixed inset-0 z-[420000]"
      classList={{
        'pointer-events-auto':
          props.ctxMenuOpen() || props.taskbarPortalMenusOpen() || props.chromeOverlayPointerUsers() > 0,
        'pointer-events-none':
          !props.ctxMenuOpen() && !props.taskbarPortalMenusOpen() && props.chromeOverlayPointerUsers() === 0,
        'overflow-visible':
          props.ctxMenuOpen() || props.taskbarPortalMenusOpen() || props.chromeOverlayPointerUsers() > 0,
        'overflow-hidden':
          !props.ctxMenuOpen() &&
          !props.taskbarPortalMenusOpen() &&
          props.chromeOverlayPointerUsers() === 0,
      }}
      ref={(el) => {
        props.setMenuLayerHostRef(el ?? undefined)
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
