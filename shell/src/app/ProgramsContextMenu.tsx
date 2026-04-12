import { For, Show, onCleanup, onMount, type Accessor, type JSX } from 'solid-js'
import type { ShellContextMenuItem } from '../contextMenu'

type ProgramsContextMenuProps = {
  placement: Accessor<JSX.CSSProperties | null>
  query: Accessor<string>
  setQuery: (value: string) => void
  highlightIdx: Accessor<number>
  items: Accessor<ShellContextMenuItem[]>
  setSearchRef: (el: HTMLInputElement) => void
  setPanelRef: (el: HTMLDivElement) => void
  activateSelection: () => void
  closeContextMenu: () => void
}

export function ProgramsContextMenu(props: ProgramsContextMenuProps) {
  let searchRef: HTMLInputElement | undefined

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
    document.addEventListener('keydown', redirectLauncherTyping, true)
  })

  onCleanup(() => {
    document.removeEventListener('keydown', redirectLauncherTyping, true)
  })

  return (
    <div
      class="border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) z-90000 absolute flex flex-col overflow-hidden"
      role="group"
      aria-label="Application search"
      ref={(el) => {
        props.setPanelRef(el)
      }}
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
      <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-2">
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
              onMouseDown={(e) => {
                e.preventDefault()
              }}
              onFocus={(e) => {
                if (e.target !== searchRef) queueMicrotask(() => searchRef?.focus())
              }}
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
