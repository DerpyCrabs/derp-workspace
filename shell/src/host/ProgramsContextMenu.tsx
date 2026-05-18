import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type Component, type JSX } from 'solid-js'
import { DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { registerShellExclusionElement } from '@/features/bridge/shellExclusionSync'
import { FileBrowserContextMenu } from '@/apps/file-browser/FileBrowserContextMenu'
import type { ShellContextMenuItem } from '@/host/contextMenu'
import type { CommandPaletteItem } from '@/features/command-palette/commandPalette'
import { useShellContextMenus } from './ShellContextMenusContext'
import AppWindow from 'lucide-solid/icons/app-window'
import Bell from 'lucide-solid/icons/bell'
import BellOff from 'lucide-solid/icons/bell-off'
import Bluetooth from 'lucide-solid/icons/bluetooth'
import CircleAlert from 'lucide-solid/icons/circle-alert'
import Columns3 from 'lucide-solid/icons/columns-3'
import Command from 'lucide-solid/icons/command'
import FileQuestion from 'lucide-solid/icons/file-question'
import FolderOpen from 'lucide-solid/icons/folder-open'
import Grid3X3 from 'lucide-solid/icons/grid-3x3'
import Keyboard from 'lucide-solid/icons/keyboard'
import Laptop from 'lucide-solid/icons/laptop'
import LoaderCircle from 'lucide-solid/icons/loader-circle'
import LogOut from 'lucide-solid/icons/log-out'
import Maximize2 from 'lucide-solid/icons/maximize-2'
import Monitor from 'lucide-solid/icons/monitor'
import Moon from 'lucide-solid/icons/moon'
import Palette from 'lucide-solid/icons/palette'
import Power from 'lucide-solid/icons/power'
import RefreshCw from 'lucide-solid/icons/refresh-cw'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import Save from 'lucide-solid/icons/save'
import SearchX from 'lucide-solid/icons/search-x'
import Settings from 'lucide-solid/icons/settings'
import SlidersHorizontal from 'lucide-solid/icons/sliders-horizontal'
import Sun from 'lucide-solid/icons/sun'
import User from 'lucide-solid/icons/user'
import Volume2 from 'lucide-solid/icons/volume-2'
import Wifi from 'lucide-solid/icons/wifi'

const COMMAND_ROW_HEIGHT = 58
const COMMAND_HEADING_HEIGHT = 25
const COMMAND_LIST_OVERSCAN_PX = 180

type CommandPaletteVisualRow =
  | {
    kind: 'heading'
    key: string
    category: string
    label: string
    top: number
    height: number
  }
  | {
    kind: 'item'
    key: string
    item: CommandPaletteItem
    itemIndex: number
    top: number
    height: number
  }

function paletteIcon(Icon: Component<{ class?: string; 'stroke-width'?: number }>): JSX.Element {
  return (
    <span class="bg-(--shell-surface-elevated) flex h-7 w-7 shrink-0 items-center justify-center rounded text-(--shell-text-muted)">
      <Icon class="h-4 w-4" stroke-width={2} />
    </span>
  )
}

function commandPaletteIcon(item: CommandPaletteItem): JSX.Element {
  if (item.icon) return item.icon
  if (item.iconFactory) return item.iconFactory()
  if (item.id === 'apps:loading') return paletteIcon(LoaderCircle)
  if (item.id === 'apps:error') return paletteIcon(CircleAlert)
  if (item.id === 'apps:empty') return paletteIcon(SearchX)
  if (item.id === 'shell:settings') return paletteIcon(Settings)
  if (item.id === 'shell:file_browser') return paletteIcon(FolderOpen)
  if (item.category === 'windows') return paletteIcon(AppWindow)
  if (item.id === 'settings:user') return paletteIcon(User)
  if (item.id === 'settings:displays') return paletteIcon(Monitor)
  if (item.id === 'settings:tiling') return paletteIcon(Grid3X3)
  if (item.id === 'settings:scratchpads') return paletteIcon(AppWindow)
  if (item.id === 'settings:keyboard') return paletteIcon(Keyboard)
  if (item.id === 'settings:notifications') return paletteIcon(Bell)
  if (item.id === 'settings:sound') return paletteIcon(Volume2)
  if (item.id === 'settings:wifi') return paletteIcon(Wifi)
  if (item.id === 'settings:bluetooth') return paletteIcon(Bluetooth)
  if (item.id === 'settings:appearance') return paletteIcon(Palette)
  if (item.id === 'settings:default-applications') return paletteIcon(FileQuestion)
  if (item.id === 'settings:notifications-enable') return paletteIcon(Bell)
  if (item.id === 'settings:notifications-disable') return paletteIcon(BellOff)
  if (item.id === 'settings:theme-mode:light') return paletteIcon(Sun)
  if (item.id === 'settings:theme-mode:dark') return paletteIcon(Moon)
  if (item.id === 'settings:theme-mode:system') return paletteIcon(Laptop)
  if (item.id.startsWith('settings:theme-palette:')) return paletteIcon(Palette)
  if (item.id.startsWith('settings:ui-scale:')) return paletteIcon(SlidersHorizontal)
  if (item.id.startsWith('settings:primary:')) return paletteIcon(Monitor)
  if (item.id.startsWith('settings:vrr:')) return paletteIcon(RefreshCw)
  if (item.id.includes(':manual-snap')) return paletteIcon(Maximize2)
  if (item.id.includes(':master-stack')) return paletteIcon(Columns3)
  if (item.id.includes(':columns')) return paletteIcon(Columns3)
  if (item.id.includes(':grid')) return paletteIcon(Grid3X3)
  if (item.id.includes(':custom-auto')) return paletteIcon(SlidersHorizontal)
  if (item.id === 'workspace:save-session') return paletteIcon(Save)
  if (item.id === 'workspace:restore-session') return paletteIcon(RotateCcw)
  if (item.id === 'workspace:suspend') return paletteIcon(Moon)
  if (item.id === 'workspace:restart') return paletteIcon(RefreshCw)
  if (item.id === 'workspace:shutdown') return paletteIcon(Power)
  if (item.id === 'workspace:exit-session') return paletteIcon(LogOut)
  if (item.category === 'settings') return paletteIcon(Settings)
  if (item.category === 'workspace') return paletteIcon(Command)
  if (item.category === 'apps') return paletteIcon(AppWindow)
  return paletteIcon(Command)
}

export function ProgramsContextMenu() {
  const props = useShellContextMenus().programsMenuProps
  let searchRef: HTMLInputElement | undefined
  let panelRef: HTMLDivElement | undefined
  let listRef: HTMLDivElement | undefined
  const [itemMenu, setItemMenu] = createSignal<{ x: number; y: number; items: ShellContextMenuItem[] } | null>(null)
  const [listScrollTop, setListScrollTop] = createSignal(0)
  const [listViewportHeight, setListViewportHeight] = createSignal(480)

  const visualRows = createMemo(() => {
    const items = props.items()
    const rows: CommandPaletteVisualRow[] = []
    let top = 0
    let previousCategory = ''
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index] as CommandPaletteItem
      if (index === 0 || previousCategory !== item.category) {
        rows.push({
          kind: 'heading',
          key: `heading:${index}:${item.category}`,
          category: item.category,
          label: item.categoryLabel ?? 'Commands',
          top,
          height: COMMAND_HEADING_HEIGHT,
        })
        top += COMMAND_HEADING_HEIGHT
        previousCategory = item.category
      }
      rows.push({
        kind: 'item',
        key: item.id,
        item,
        itemIndex: index,
        top,
        height: COMMAND_ROW_HEIGHT,
      })
      top += COMMAND_ROW_HEIGHT
    }
    return { rows, height: top }
  })

  const visibleRows = createMemo(() => {
    const start = Math.max(0, listScrollTop() - COMMAND_LIST_OVERSCAN_PX)
    const end = listScrollTop() + listViewportHeight() + COMMAND_LIST_OVERSCAN_PX
    return visualRows().rows.filter((row) => row.top + row.height >= start && row.top <= end)
  })

  const syncListViewport = () => {
    const height = listRef?.clientHeight
    if (height && height > 0) setListViewportHeight(height)
  }

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
    syncListViewport()
    requestAnimationFrame(() => {
      syncSearchFocus()
      syncListViewport()
      requestAnimationFrame(() => {
        syncSearchFocus()
        syncListViewport()
      })
    })
    document.addEventListener('keydown', redirectLauncherTyping, true)
    window.addEventListener('resize', syncListViewport)
  })

  onCleanup(() => {
    document.removeEventListener('keydown', redirectLauncherTyping, true)
    window.removeEventListener('resize', syncListViewport)
  })

  function registerPanel(el: HTMLDivElement) {
    panelRef = el
    props.setPanelRef(el)
    const registration = registerShellExclusionElement('floating', 'floating', el)
    onCleanup(registration.unregister)
  }

  createEffect(() => {
    const list = listRef
    if (!list) return
    const idx = props.highlightIdx()
    const row = visualRows().rows.find((entry) => entry.kind === 'item' && entry.itemIndex === idx)
    if (!row) return
    queueMicrotask(() => {
      const currentList = listRef
      if (!currentList) return
      const top = row.top
      const bottom = row.top + row.height
      if (top < currentList.scrollTop) currentList.scrollTop = top
      else if (bottom > currentList.scrollTop + currentList.clientHeight) {
        currentList.scrollTop = Math.max(0, bottom - currentList.clientHeight)
      }
    })
  })

  return (
    <DropdownMenuContent
      data-shell-programs-menu-panel
      data-command-palette-panel
      data-shell-exclusion-floating
      class="border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) z-90000 absolute flex flex-col overflow-hidden"
      role="group"
      aria-label="Command palette"
      ref={registerPanel}
      style={props.placement() ?? undefined}
    >
      <div class="shrink-0 border-b border-(--shell-border)">
        <input
          type="text"
          inputMode="search"
          autocomplete="off"
          class="bg-(--shell-input-bg) placeholder:text-(--shell-text-dim) focus:outline-none focus-visible:outline-none box-border w-full border-0 px-4 py-4 text-[1.15rem] font-inherit text-inherit"
          placeholder="Search apps, windows, settings, and commands"
          aria-label="Search commands"
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
      <div
        class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-2"
        data-programs-menu-scroll
        ref={(el) => {
          listRef = el
          syncListViewport()
        }}
        onScroll={(e) => {
          setListScrollTop(e.currentTarget.scrollTop)
          syncListViewport()
        }}
      >
        <div class="relative" style={{ height: `${visualRows().height}px` }}>
          <For each={visibleRows()}>
            {(row) => (
              <div
                class="absolute right-0 left-0"
                style={{
                  top: `${row.top}px`,
                  height: `${row.height}px`,
                }}
              >
                {row.kind === 'heading' ? (
                  <div
                    class="box-border h-full px-3 pt-2 pb-1 text-[0.68rem] font-semibold tracking-wide text-(--shell-text-dim) uppercase"
                    data-command-palette-category={row.category}
                  >
                    {row.label}
                  </div>
                ) : (
                <button
                  type="button"
                  class="bg-transparent hover:bg-(--shell-overlay-hover) flex h-full w-full cursor-pointer items-center justify-between gap-3 border-0 px-4 py-2.5 text-left font-inherit text-inherit"
                  classList={{
                    'bg-[color-mix(in_srgb,var(--shell-overlay-active)_78%,var(--shell-accent-soft)_22%)] text-inherit shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
                      props.highlightIdx() === row.itemIndex,
                    'cursor-not-allowed text-(--shell-text-dim)': !!row.item.disabled,
                  }}
                  tabIndex={-1}
                  title={row.item.title ?? row.item.subtitle}
                  data-programs-menu-idx={row.itemIndex}
                  data-command-palette-idx={row.itemIndex}
                  data-command-palette-id={row.item.id}
                  data-command-palette-category-row={row.item.category}
                  onPointerDown={(e) => {
                    if (!e.isPrimary || e.button !== 0) return
                    e.preventDefault()
                    e.stopPropagation()
                    if (row.item.disabled) return
                    props.closeContextMenu()
                    row.item.action()
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault()
                  }}
                  onClick={(e) => {
                    if (e.detail !== 0) return
                    if (row.item.disabled) return
                    props.closeContextMenu()
                    row.item.action()
                  }}
                  onContextMenu={(e) => {
                    const contextItems = row.item.contextItems?.() ?? []
                    if (contextItems.length === 0) return
                    e.preventDefault()
                    e.stopPropagation()
                    setItemMenu({ x: e.clientX, y: e.clientY, items: contextItems })
                  }}
                >
                  <span class="flex min-w-0 flex-1 items-center gap-3">
                    <span class="shrink-0" data-command-palette-icon>
                      {commandPaletteIcon(row.item)}
                    </span>
                    <span class="min-w-0 flex flex-1 flex-col gap-0.5">
                      <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.96rem]">
                        {row.item.label}
                      </span>
                      <Show when={row.item.subtitle}>
                        <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.76rem] text-(--shell-text-dim)">
                          {row.item.subtitle}
                        </span>
                      </Show>
                    </span>
                  </span>
                  <Show when={row.item.badge} keyed>
                    {(badge) => (
                      <span class="border border-(--shell-accent-soft-border) bg-(--shell-accent-soft) text-(--shell-accent-soft-text) shrink-0 rounded px-[0.35rem] py-[0.15rem] text-[0.65rem] tracking-wide uppercase">
                        {badge}
                      </span>
                    )}
                  </Show>
                </button>
                )}
              </div>
            )}
          </For>
        </div>
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
