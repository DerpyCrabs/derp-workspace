import { For, createMemo } from 'solid-js'
import { useShellContextMenus } from './ShellContextMenusContext'
import { ShellContextMenuItemButton } from './ShellContextMenuItemButton'

export function PowerContextMenu() {
  const props = useShellContextMenus().powerMenuProps
  const panelStyle = createMemo(() => ({
    right: `calc(100% - ${Math.round(props.anchor().x)}px)`,
    top: '8px',
  }))
  return (
    <div
      class="border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) z-90000 absolute flex min-w-48 flex-col overflow-hidden rounded-[0.35rem]"
      role="menu"
      aria-label="Power"
      ref={(el) => {
        props.setPanelRef(el)
      }}
      style={panelStyle()}
    >
      <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1">
        <For each={props.items()}>
          {(item, idx) => (
            <ShellContextMenuItemButton
              item={item}
              highlighted={props.highlightIdx() === idx()}
              itemIndex={idx()}
              itemIndexDataAttr="data-power-menu-idx"
              itemActionDataAttr="data-power-menu-action"
              onPointerDown={(e) => {
                if (!e.isPrimary || e.button !== 0) return
                e.preventDefault()
                e.stopPropagation()
                if (item.disabled) return
                item.action()
                props.closeContextMenu()
              }}
              onMouseDown={(e) => {
                e.preventDefault()
              }}
              onClick={(e) => {
                if (e.detail !== 0) return
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
