import { For, Show, createEffect, onCleanup, type Component } from 'solid-js'

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

export const TransformPicker: Component<{
  value: number
  rowIndex: number
  openIndex: () => number | null
  setOpenIndex: (v: number | null) => void
  onChange: (v: number) => void
}> = (props) => {
  let root: HTMLDivElement | undefined

  const label = () => OPTIONS.find((o) => o.v === props.value)?.l ?? String(props.value)
  const open = () => props.openIndex() === props.rowIndex

  createEffect(() => {
    if (!open()) return
    const close = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && root && !root.contains(t)) {
        props.setOpenIndex(null)
      }
    }
    document.addEventListener('pointerdown', close, true)
    onCleanup(() => document.removeEventListener('pointerdown', close, true))
  })

  return (
    <div class="relative self-start" ref={(el) => (root = el)}>
      <button
        type="button"
        class="min-w-[6.5rem] cursor-pointer rounded border border-white/25 bg-black/35 py-0.5 px-[0.45rem] text-left font-inherit text-inherit hover:bg-black/[0.48]"
        onPointerDown={(e) => {
          e.preventDefault()
          props.setOpenIndex(open() ? null : props.rowIndex)
        }}
      >
        {label()}
      </button>
      <Show when={open()}>
        <div
          class="absolute left-0 top-[calc(100%+2px)] z-[500000] min-w-full rounded-[0.3rem] border border-white/28 bg-[rgba(22,30,48,0.98)] py-0.5 shadow-[0_6px_20px_rgba(0,0,0,0.45)]"
          role="listbox"
        >
          <For each={OPTIONS}>
            {(opt) => (
              <button
                type="button"
                class="block w-full cursor-pointer border-0 bg-transparent px-[0.6rem] py-[0.35rem] text-left font-inherit text-inherit hover:bg-white/10"
                classList={{ 'bg-[rgba(60,120,200,0.35)]': opt.v === props.value }}
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
      </Show>
    </div>
  )
}
