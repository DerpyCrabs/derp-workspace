import { For, Show, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { registerShellExclusionElement } from '@/features/bridge/shellExclusionSync'
import { fitContextMenuClientPosition, type ClientMenuBounds, type ShellContextMenuItem } from '@/host/contextMenu'

type CtxMenuAnchor = { x: number; y: number; alignAboveY?: number }

type TraySniContextMenuProps = {
  anchor: Accessor<CtxMenuAnchor>
  bounds: Accessor<ClientMenuBounds>
  items: Accessor<ShellContextMenuItem[]>
  highlightIdx: Accessor<number>
  setPanelRef: (el: HTMLDivElement) => void
  closeContextMenu: () => void
}

export function TraySniContextMenu(props: TraySniContextMenuProps) {
  const [panelSize, setPanelSize] = createSignal({ w: 192, h: 40 })
  const panelStyle = createMemo(() => {
    const a = props.anchor()
    const size = panelSize()
    const estimateH = Math.max(40, Math.min(520, props.items().length * 32 + 8))
    const placement = fitContextMenuClientPosition(
      a,
      Math.max(192, size.w),
      Math.max(estimateH, size.h),
      props.bounds(),
    )
    return {
      left: `${placement.left}px`,
      top: `${placement.top}px`,
      'max-height': `${Math.round(placement.maxHeight)}px`,
    }
  })
  function registerPanel(el: HTMLElement) {
    props.setPanelRef(el as HTMLDivElement)
    const updateSize = () => {
      setPanelSize({
        w: Math.max(1, Math.round(el.offsetWidth)),
        h: Math.max(1, Math.round(el.scrollHeight || el.offsetHeight)),
      })
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(el)
    const registration = registerShellExclusionElement('floating', 'floating', el)
    onCleanup(() => {
      observer.disconnect()
      registration.unregister()
    })
  }
  return (
    <ContextMenu defaultOpen>
      <ContextMenuContent
        data-shell-exclusion-floating
        data-shell-tray-sni-menu-panel
        class="border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) z-90000 fixed flex min-w-48 flex-col overflow-hidden rounded-[0.35rem]"
        aria-label="Tray"
        when={() => true}
        ref={registerPanel}
        style={panelStyle()}
      >
        <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1">
          <For each={props.items()}>
            {(item, idx) => (
              <Show when={!item.separator} fallback={<ContextMenuSeparator />}>
                <ContextMenuItem
                  title={item.title}
                  disabled={!!item.disabled}
                  classList={{
                    'bg-[color-mix(in_srgb,var(--shell-overlay-active)_78%,var(--shell-accent-soft)_22%)] text-inherit shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
                      props.highlightIdx() === idx(),
                    'cursor-not-allowed text-(--shell-text-dim)': !!item.disabled,
                  }}
                  data-tray-sni-menu-idx={idx()}
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
              </Show>
            )}
          </For>
        </div>
      </ContextMenuContent>
    </ContextMenu>
  )
}
