import { For, Show, createMemo } from 'solid-js'
import { useShellContextMenus } from './ShellContextMenusContext'

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
            <button
              type="button"
              class="bg-transparent hover:bg-(--shell-overlay-hover) flex w-full cursor-pointer items-center justify-between gap-2 border-0 px-3 py-[0.45rem] text-left font-inherit text-inherit"
              classList={{
                'bg-[color-mix(in_srgb,var(--shell-overlay-active)_78%,var(--shell-accent-soft)_22%)] text-inherit shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
                  props.highlightIdx() === idx(),
                'cursor-not-allowed text-(--shell-text-dim)': !!item.disabled,
              }}
              role="menuitem"
              title={item.title}
              data-power-menu-idx={idx()}
              data-power-menu-action={item.actionId}
              onClick={() => {
                if (item.disabled) return
                item.action()
                props.closeContextMenu()
              }}
            >
              <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {item.label}
              </span>
              <Show when={item.badge} keyed>
                {(badge) => (
                  <span class="border border-(--shell-accent-soft-border) bg-(--shell-accent-soft) text-(--shell-accent-soft-text) shrink-0 rounded px-[0.35rem] py-[0.15rem] text-[0.65rem] tracking-wide uppercase">
                    {badge}
                  </span>
                )}
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
