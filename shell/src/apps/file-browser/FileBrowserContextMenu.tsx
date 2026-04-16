import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { ShellContextMenuItem } from '@/host/contextMenu'
import { ShellContextMenuItemButton } from '@/host/ShellContextMenuItemButton'

export function FileBrowserContextMenu(props: {
  open: () => boolean
  anchor: () => { x: number; y: number } | null
  items: () => ShellContextMenuItem[]
  onRequestClose: () => void
}) {
  let panelEl: HTMLDivElement | undefined
  const [placed, setPlaced] = createSignal({ left: 0, top: 0 })

  createEffect(() => {
    if (!props.open() || !props.anchor()) return
    const a = props.anchor()!
    const list = props.items()
    const estW = 220
    const estH = Math.min(360, Math.max(44, list.length * 40) + 8)
    const margin = 6
    let left = a.x
    let top = a.y
    if (left + estW > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - estW - margin)
    if (top + estH > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - estH - margin)
    if (left < margin) left = margin
    if (top < margin) top = margin
    setPlaced({ left, top })
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
    <Show when={props.open() && props.anchor()}>
      <Portal mount={document.body}>
        <div
          ref={(el) => {
            panelEl = el
          }}
          class="border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) fixed z-[95000] flex min-w-48 max-h-80 flex-col overflow-hidden rounded-[0.35rem] py-1 shadow-lg"
          role="menu"
          aria-label="Files"
          style={{
            left: `${placed().left}px`,
            top: `${placed().top}px`,
          }}
        >
          <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            <For each={props.items()}>
              {(item, idx) => (
                <ShellContextMenuItemButton
                  item={item}
                  highlighted={false}
                  itemIndex={idx()}
                  itemIndexDataAttr="data-file-browser-context-idx"
                  itemActionDataAttr="data-file-browser-context-action"
                  onMouseDown={(e) => {
                    e.preventDefault()
                  }}
                  onClick={() => {
                    if (item.disabled) return
                    item.action()
                    props.onRequestClose()
                  }}
                />
              )}
            </For>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
