import { For, Show, onCleanup } from 'solid-js'
import { DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { registerShellExclusionElement } from '@/features/bridge/shellExclusionSync'
import { useShellContextMenus } from './ShellContextMenusContext'

export function WindowSwitcherContextMenu() {
  const props = useShellContextMenus().windowSwitcherProps

  function registerPanel(el: HTMLDivElement) {
    props.setPanelRef(el)
    const registration = registerShellExclusionElement('floating', 'floating', el)
    onCleanup(registration.unregister)
  }

  return (
    <DropdownMenuContent
      data-shell-window-switcher-panel
      data-shell-exclusion-floating
      class="pointer-events-none border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) z-90000 absolute flex flex-col overflow-hidden"
      role="group"
      aria-label="Window switcher"
      ref={registerPanel}
      style={props.placement() ?? undefined}
    >
      <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-2" data-window-switcher-scroll>
        <For each={props.items()}>
          {(item, idx) => (
            <button
              type="button"
              class="bg-transparent flex w-full items-center justify-between gap-2 border-0 px-4 py-3 text-left text-[1rem] font-inherit text-inherit"
              classList={{
                'bg-[color-mix(in_srgb,var(--shell-overlay-active)_78%,var(--shell-accent-soft)_22%)] text-inherit shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
                  props.highlightIdx() === idx(),
              }}
              tabIndex={-1}
              title={item.title}
              data-window-switcher-idx={idx()}
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
    </DropdownMenuContent>
  )
}
