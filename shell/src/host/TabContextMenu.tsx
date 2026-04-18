import { For, Show, createMemo, type Accessor } from 'solid-js'
import { ContextMenu, ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu'
import type { ShellContextMenuItem } from '@/host/contextMenu'

type CtxMenuAnchor = { x: number; y: number; alignAboveY?: number }

type TabContextMenuProps = {
  anchor: Accessor<CtxMenuAnchor>
  items: Accessor<ShellContextMenuItem[]>
  highlightIdx: Accessor<number>
  setPanelRef: (el: HTMLDivElement) => void
  closeContextMenu: () => void
}

export function TabContextMenu(props: TabContextMenuProps) {
  const panelStyle = createMemo(() => {
    const a = props.anchor()
    return {
      left: `${Math.round(a.x)}px`,
      top: `${Math.round(a.y)}px`,
    }
  })
  return (
    <ContextMenu defaultOpen>
      <ContextMenuContent
        data-shell-exclusion-floating
        class="border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) z-90000 fixed flex min-w-48 flex-col overflow-hidden rounded-[0.35rem]"
        aria-label="Tab"
        when={() => true}
        ref={(el) => {
          props.setPanelRef(el)
        }}
        style={panelStyle()}
      >
        <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1">
          <For each={props.items()}>
            {(item, idx) => (
              <ContextMenuItem
                title={item.title}
                disabled={!!item.disabled}
                classList={{
                  'bg-[color-mix(in_srgb,var(--shell-overlay-active)_78%,var(--shell-accent-soft)_22%)] text-inherit shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
                    props.highlightIdx() === idx(),
                  'cursor-not-allowed text-(--shell-text-dim)': !!item.disabled,
                }}
                data-tab-menu-idx={idx()}
                {...(item.actionId ? { 'data-tab-menu-action': item.actionId } : {})}
                onMouseDown={(e) => {
                  e.preventDefault()
                }}
                onClick={() => {
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
              </ContextMenuItem>
            )}
          </For>
        </div>
      </ContextMenuContent>
    </ContextMenu>
  )
}
