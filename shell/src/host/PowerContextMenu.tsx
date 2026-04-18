import { For, createMemo } from 'solid-js'
import { useShellContextMenus } from './ShellContextMenusContext'
import { shellMenuPlacementWarn } from '@/host/shellMenuPlacementWarn'
import { ShellContextMenuItemButton } from './ShellContextMenuItemButton'

export function PowerContextMenu() {
  const props = useShellContextMenus().powerMenuProps
  const panelStyle = createMemo(() => {
    const anchor = props.anchor()
    const top = Math.round(anchor.alignAboveY ?? anchor.y)
    shellMenuPlacementWarn('power_menu', {
      anchor: { x: anchor.x, y: anchor.y, alignAboveY: anchor.alignAboveY },
      style_top_px: top,
    })
    const ax = Math.round(anchor.x)
    return {
      left: `${ax}px`,
      top: `${top}px`,
      transform: 'translateX(-100%) translateY(-100%)',
    }
  })
  return (
    <div
      data-shell-exclusion-floating
      data-shell-power-menu-panel
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
