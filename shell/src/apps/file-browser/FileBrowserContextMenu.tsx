import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
} from '@/components/ui/context-menu'
import { registerShellExclusionElement } from '@/features/bridge/shellExclusionSync'
import { fitContextMenuClientPosition, type ClientMenuBounds, type ShellContextMenuItem } from '@/host/contextMenu'

export function FileBrowserContextMenu(props: {
  open: () => boolean
  anchor: () => { x: number; y: number; alignAboveY?: number } | null
  items: () => ShellContextMenuItem[]
  onRequestClose: () => void
  bounds?: () => ClientMenuBounds | null
  portalMount?: () => Node | undefined
}) {
  let panelEl: HTMLDivElement | undefined
  const [placed, setPlaced] = createSignal({ left: 0, top: 0, maxHeight: 320 })

  function registerPanel(el: HTMLDivElement) {
    panelEl = el
    const registration = registerShellExclusionElement('floating', 'floating', el)
    onCleanup(registration.unregister)
  }

  createEffect(() => {
    if (!props.open() || !props.anchor()) return
    const a = props.anchor()!
    const list = props.items()
    const estW = 220
    const margin = 6
    const bounds = props.bounds?.() ?? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
    const maxHeight = Math.max(44, bounds.h - margin * 2)
    const estH = Math.min(maxHeight, Math.max(44, list.length * 40) + 8)
    const fitted = fitContextMenuClientPosition(a, estW, estH, bounds, margin)
    setPlaced({ left: fitted.left, top: fitted.top, maxHeight: Math.max(44, fitted.maxHeight) })
  })

  createEffect(() => {
    if (!props.open()) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onRequestClose()
      }
    }
    const onPointer = (e: PointerEvent) => {
      const t = e.target
      if (!(t instanceof Node)) return
      if (panelEl?.contains(t)) return
      props.onRequestClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointer, true)
    onCleanup(() => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointer, true)
    })
  })

  return (
    <ContextMenu
      open={props.open()}
      onOpenChange={(next) => {
        if (!next) props.onRequestClose()
      }}
    >
      <Show when={props.open() && props.anchor()}>
        <ContextMenuPortal mount={props.portalMount?.() ?? document.body}>
          <ContextMenuContent
            ref={registerPanel}
            data-shell-exclusion-floating
            class="pointer-events-auto border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) fixed z-95000 flex min-w-48 flex-col overflow-hidden rounded-[0.35rem] py-1 shadow-lg"
            aria-label="Files"
            style={{
              left: `${placed().left}px`,
              top: `${placed().top}px`,
              'max-height': `${placed().maxHeight}px`,
            }}
          >
            <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
              <For each={props.items()}>
                {(item, idx) => {
                  let activated = false
                  const activate = () => {
                    if (activated || item.disabled) return
                    activated = true
                    item.action()
                    props.onRequestClose()
                  }
                  return (
                    <Show
                      when={!item.separator}
                      fallback={<div class="my-1 h-px bg-(--shell-overlay-border)" role="separator" />}
                    >
                      <ContextMenuItem
                        title={item.title}
                        disabled={!!item.disabled}
                        classList={{
                          'cursor-not-allowed text-(--shell-text-dim)': !!item.disabled,
                        }}
                        data-file-browser-context-idx={idx()}
                        {...(item.actionId ? { 'data-file-browser-context-action': item.actionId } : {})}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return
                          e.preventDefault()
                          e.stopPropagation()
                          activate()
                        }}
                        onMouseDown={(e) => {
                          if (e.button !== 0) return
                          e.preventDefault()
                          e.stopPropagation()
                          activate()
                        }}
                        onClick={() => activate()}
                      >
                        <Show when={item.icon} keyed>
                          {(icon) => <span class="shrink-0 text-(--shell-text-dim)">{icon}</span>}
                        </Show>
                        <span data-file-browser-context-label class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{item.label}</span>
                        <Show when={item.badge} keyed>
                          {(badge) => (
                            <span class="border border-(--shell-accent-soft-border) bg-(--shell-accent-soft) text-(--shell-accent-soft-text) shrink-0 rounded px-[0.35rem] py-[0.15rem] text-[0.65rem] tracking-wide uppercase">
                              {badge}
                            </span>
                          )}
                        </Show>
                      </ContextMenuItem>
                    </Show>
                  )
                }}
              </For>
            </div>
          </ContextMenuContent>
        </ContextMenuPortal>
      </Show>
    </ContextMenu>
  )
}
