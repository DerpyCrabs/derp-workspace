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
    <div class="shell-transform-picker" ref={(el) => (root = el)}>
      <button
        type="button"
        class="shell-transform-picker__toggle"
        onPointerDown={(e) => {
          e.preventDefault()
          props.setOpenIndex(open() ? null : props.rowIndex)
        }}
      >
        {label()}
      </button>
      <Show when={open()}>
        <div class="shell-transform-picker__menu" role="listbox">
          <For each={OPTIONS}>
            {(opt) => (
              <button
                type="button"
                class="shell-transform-picker__opt"
                classList={{ 'shell-transform-picker__opt--active': opt.v === props.value }}
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
