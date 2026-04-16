import { For, type Accessor } from 'solid-js'
import type { ShellContextMenuItem } from '@/host/contextMenu'
import { ShellContextMenuItemButton } from './ShellContextMenuItemButton'

type TabContextMenuProps = {
  items: Accessor<ShellContextMenuItem[]>
  highlightIdx: Accessor<number>
  setPanelRef: (el: HTMLDivElement) => void
  closeContextMenu: () => void
}

export function TabContextMenu(props: TabContextMenuProps) {
  return (
    <div
      class="border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) z-90000 absolute top-2 left-2 flex min-w-48 flex-col overflow-hidden rounded-[0.35rem]"
      role="menu"
      aria-label="Tab"
      ref={(el) => {
        props.setPanelRef(el)
      }}
    >
      <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1">
        <For each={props.items()}>
          {(item, idx) => (
            <ShellContextMenuItemButton
              item={item}
              highlighted={props.highlightIdx() === idx()}
              itemIndex={idx()}
              itemIndexDataAttr="data-tab-menu-idx"
              itemActionDataAttr="data-tab-menu-action"
              onMouseDown={(e) => {
                e.preventDefault()
              }}
              onClick={() => {
                if (item.disabled) return
                item.action()
                props.closeContextMenu()
              }}
            />
          )}
        </For>
      </div>
    </div>
  )
}
