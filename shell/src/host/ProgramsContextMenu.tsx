import { For, Show, createSignal, onCleanup, onMount } from 'solid-js'
import { DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { registerShellExclusionElement } from '@/features/bridge/shellExclusionSync'
import { FileBrowserContextMenu } from '@/apps/file-browser/FileBrowserContextMenu'
import type { ShellContextMenuItem } from '@/host/contextMenu'
import { useShellContextMenus } from './ShellContextMenusContext'

export function ProgramsContextMenu() {
  const props = useShellContextMenus().programsMenuProps
  let searchRef: HTMLInputElement | undefined
  let panelRef: HTMLDivElement | undefined
  const [itemMenu, setItemMenu] = createSignal<{ x: number; y: number; items: ShellContextMenuItem[] } | null>(null)

  const syncSearchFocus = () => {
    queueMicrotask(() => searchRef?.focus())
  }

  const redirectLauncherTyping = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return
    if (document.activeElement === searchRef) return
    if (e.ctrlKey || e.altKey || e.metaKey) return
    if (e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      props.setQuery(props.query().slice(0, -1))
      syncSearchFocus()
      return
    }
    if (e.key.length !== 1) return
    e.preventDefault()
    e.stopPropagation()
    props.setQuery(`${props.query()}${e.key}`)
    syncSearchFocus()
  }

  onMount(() => {
    syncSearchFocus()
    requestAnimationFrame(() => {
      syncSearchFocus()
      requestAnimationFrame(() => syncSearchFocus())
    })
    document.addEventListener('keydown', redirectLauncherTyping, true)
  })

  onCleanup(() => {
    document.removeEventListener('keydown', redirectLauncherTyping, true)
  })

  function registerPanel(el: HTMLDivElement) {
    panelRef = el
    props.setPanelRef(el)
    const registration = registerShellExclusionElement('floating', 'floating', el)
    onCleanup(registration.unregister)
  }

  return (
    <DropdownMenuContent
      data-shell-programs-menu-panel
      data-shell-exclusion-floating
      class="border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) z-90000 absolute flex flex-col overflow-hidden"
      role="group"
      aria-label="Application search"
      ref={registerPanel}
      style={props.placement() ?? undefined}
    >
      <div class="shrink-0 border-b border-(--shell-border)">
        <input
          type="text"
          inputMode="search"
          autocomplete="off"
          class="bg-(--shell-input-bg) placeholder:text-(--shell-text-dim) focus:outline-none focus-visible:outline-none box-border w-full border-0 px-4 py-4 text-[1.15rem] font-inherit text-inherit"
          placeholder="Search apps, keywords, and commands"
          aria-label="Search applications"
          value={props.query()}
          ref={(el) => {
            searchRef = el
            props.setSearchRef(el)
          }}
          onInput={(ev) => {
            props.setQuery(ev.currentTarget.value)
          }}
          onKeyDown={(e) => {
            if (!e.repeat && !e.isComposing && e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              props.activateSelection()
            }
          }}
        />
      </div>
      <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-2" data-programs-menu-scroll>
        <For each={props.items()}>
          {(item, idx) => (
            <button
              type="button"
              class="bg-transparent hover:bg-(--shell-overlay-hover) flex w-full cursor-pointer items-center justify-between gap-2 border-0 px-4 py-3 text-left text-[1rem] font-inherit text-inherit"
              classList={{
                'bg-[color-mix(in_srgb,var(--shell-overlay-active)_78%,var(--shell-accent-soft)_22%)] text-inherit shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
                  props.highlightIdx() === idx(),
                'cursor-not-allowed text-(--shell-text-dim)': !!item.disabled,
              }}
              tabIndex={-1}
              title={item.title}
              data-programs-menu-idx={idx()}
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
              onContextMenu={(e) => {
                const contextItems = item.contextItems?.() ?? []
                if (contextItems.length === 0) return
                e.preventDefault()
                e.stopPropagation()
                setItemMenu({ x: e.clientX, y: e.clientY, items: contextItems })
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
      <FileBrowserContextMenu
        open={() => itemMenu() !== null}
        anchor={() => {
          const menu = itemMenu()
          return menu ? { x: menu.x, y: menu.y } : null
        }}
        items={() => itemMenu()?.items ?? []}
        onRequestClose={() => setItemMenu(null)}
        portalMount={() => panelRef}
      />
    </DropdownMenuContent>
  )
}
