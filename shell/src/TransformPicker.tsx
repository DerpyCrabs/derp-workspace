import { For, Show, createEffect, createSignal, onCleanup, type Component } from 'solid-js'
import { Portal } from 'solid-js/web'

const OPTIONS = [
  { v: 0, l: '0°' },
  { v: 1, l: '90°' },
  { v: 2, l: '180°' },
  { v: 3, l: '270°' },
  { v: 4, l: 'flip' },
  { v: 5, l: 'flip 90°' },
  { v: 6, l: 'flip 180°' },
  { v: 7, l: 'flip 270°' },
] as const

const PICKER_Z = 600000

export const TransformPicker: Component<{
  value: number
  rowIndex: number
  openIndex: () => number | null
  setOpenIndex: (v: number | null) => void
  onChange: (v: number) => void
}> = (props) => {
  let anchor: HTMLDivElement | undefined
  let triggerBtn: HTMLButtonElement | undefined
  let menuEl: HTMLDivElement | undefined
  const [menuBox, setMenuBox] = createSignal({ top: 0, left: 0, w: 104 })

  const label = () => OPTIONS.find((o) => o.v === props.value)?.l ?? String(props.value)
  const open = () => props.openIndex() === props.rowIndex

  createEffect(() => {
    if (!open()) return
    const sync = () => {
      const b = triggerBtn?.getBoundingClientRect()
      if (b) {
        setMenuBox({
          top: Math.round(b.bottom + 2),
          left: Math.round(b.left),
          w: Math.round(Math.max(b.width, 104)),
        })
      }
    }
    queueMicrotask(sync)
    sync()
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    onCleanup(() => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    })
  })

  createEffect(() => {
    if (!open()) return
    const close = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (anchor?.contains(t)) return
      if (menuEl?.contains(t)) return
      props.setOpenIndex(null)
    }
    document.addEventListener('pointerdown', close, true)
    onCleanup(() => document.removeEventListener('pointerdown', close, true))
  })

  return (
    <div class="relative self-start" ref={(el) => (anchor = el)}>
      <button
        type="button"
        ref={(el) => (triggerBtn = el)}
        class="min-w-[6.5rem] cursor-pointer rounded border border-white/35 bg-[rgb(28,32,44)] py-0.5 px-[0.45rem] text-left font-inherit text-[0.78rem] text-neutral-100 hover:bg-[rgb(38,44,58)]"
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          props.setOpenIndex(open() ? null : props.rowIndex)
        }}
      >
        {label()}
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={(el) => (menuEl = el)}
            class="fixed rounded-md border border-white/40 bg-[rgb(22,28,38)] py-0.5 shadow-[0_8px_28px_rgba(0,0,0,0.65)]"
            style={{
              'z-index': PICKER_Z,
              top: `${menuBox().top}px`,
              left: `${menuBox().left}px`,
              'min-width': `${menuBox().w}px`,
            }}
            role="listbox"
          >
            <For each={OPTIONS}>
              {(opt) => (
                <button
                  type="button"
                  class="block w-full cursor-pointer border-0 px-[0.6rem] py-[0.35rem] text-left font-inherit text-[0.78rem] text-neutral-100 hover:bg-[rgb(48,56,72)]"
                  classList={{ 'bg-[rgb(42,72,118)]': opt.v === props.value }}
                  role="option"
                  aria-selected={opt.v === props.value}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    props.onChange(opt.v)
                    props.setOpenIndex(null)
                  }}
                >
                  {opt.l}
                </button>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </div>
  )
}
