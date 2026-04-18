import { For, Show, createMemo } from 'solid-js'
import { DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useShellContextMenus } from './ShellContextMenusContext'
import { shellMenuPlacementWarn } from '@/host/shellMenuPlacementWarn'

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
    <DropdownMenuContent
      data-shell-exclusion-floating
      data-shell-power-menu-panel
      class="border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) z-90000 absolute flex min-w-48 flex-col overflow-hidden rounded-[0.35rem]"
      aria-label="Power"
      ref={(el) => {
        props.setPanelRef(el)
      }}
      style={panelStyle()}
    >
      <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1">
        <For each={props.items()}>
          {(item, idx) => (
            <DropdownMenuItem
              title={item.title}
              disabled={!!item.disabled}
              classList={{
                'bg-[color-mix(in_srgb,var(--shell-overlay-active)_78%,var(--shell-accent-soft)_22%)] text-inherit shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
                  props.highlightIdx() === idx(),
                'cursor-not-allowed text-(--shell-text-dim)': !!item.disabled,
              }}
              data-power-menu-idx={idx()}
              {...(item.actionId ? { 'data-power-menu-action': item.actionId } : {})}
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
            >
              <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{item.label}</span>
              <Show when={item.badge} keyed>
                {(badge) => (
                  <span class="border border-(--shell-accent-soft-border) bg-(--shell-accent-soft) text-(--shell-accent-soft-text) shrink-0 rounded px-[0.35rem] py-[0.15rem] text-[0.65rem] tracking-wide uppercase">
                    {badge}
                  </span>
                )}
              </Show>
            </DropdownMenuItem>
          )}
        </For>
      </div>
    </DropdownMenuContent>
  )
}
