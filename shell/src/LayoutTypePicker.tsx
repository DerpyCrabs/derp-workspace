import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
} from 'solid-js'
import type { Accessor } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { LayoutType } from './layouts'
import { getMonitorLayout, setMonitorLayout } from './tilingConfig'

const OPTIONS: LayoutType[] = ['manual-snap', 'master-stack', 'columns', 'grid']

const PICKER_Z = 600000

export const LayoutTypePicker: Component<{
  outputName: string
  revision: Accessor<number>
  onPersisted: () => void
}> = (props) => {
  let anchor: HTMLDivElement | undefined
  let triggerBtn: HTMLButtonElement | undefined
  let menuEl: HTMLDivElement | undefined
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [menuBox, setMenuBox] = createSignal({ top: 0, left: 0, w: 120 })

  const value = createMemo(() => {
    props.revision()
    return getMonitorLayout(props.outputName).layout.type
  })

  createEffect(() => {
    if (!menuOpen()) return
    const sync = () => {
      const b = triggerBtn?.getBoundingClientRect()
      if (b) {
        setMenuBox({ top: Math.round(b.bottom + 2), left: Math.round(b.left), w: Math.round(b.width) })
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
    if (!menuOpen()) return
    const close = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (anchor?.contains(t)) return
      if (menuEl?.contains(t)) return
      setMenuOpen(false)
    }
    document.addEventListener('pointerdown', close, true)
    onCleanup(() => document.removeEventListener('pointerdown', close, true))
  })

  return (
    <div class="flex flex-col gap-[0.15rem] text-[0.7rem] tracking-wide text-neutral-200">
      <span>tiling layout</span>
      <div class="relative self-start" ref={(el) => (anchor = el)}>
        <button
          type="button"
          ref={(el) => (triggerBtn = el)}
          class="min-w-[7.5rem] max-w-[12rem] cursor-pointer rounded border border-white/35 bg-[rgb(28,32,44)] py-0.5 px-[0.45rem] text-left font-inherit text-[0.78rem] text-neutral-100 hover:bg-[rgb(38,44,58)]"
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenuOpen((o) => !o)
          }}
        >
          {value()}
        </button>
        <Show when={menuOpen()}>
          <Portal>
            <div
              ref={(el) => (menuEl = el)}
              class="fixed rounded-md border border-white/40 bg-[rgb(22,28,38)] py-0.5 shadow-[0_8px_28px_rgba(0,0,0,0.65)]"
              style={{
                'z-index': PICKER_Z,
                top: `${menuBox().top}px`,
                left: `${menuBox().left}px`,
                'min-width': `${Math.max(menuBox().w, 120)}px`,
              }}
              role="listbox"
            >
              <For each={OPTIONS}>
                {(opt) => (
                  <button
                    type="button"
                    class="block w-full cursor-pointer border-0 px-[0.6rem] py-[0.35rem] text-left font-inherit text-[0.78rem] text-neutral-100 hover:bg-[rgb(48,56,72)]"
                    classList={{ 'bg-[rgb(42,72,118)]': opt === value() }}
                    role="option"
                    aria-selected={opt === value()}
                    onPointerDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setMonitorLayout(props.outputName, opt)
                      props.onPersisted()
                      setMenuOpen(false)
                    }}
                  >
                    {opt}
                  </button>
                )}
              </For>
            </div>
          </Portal>
        </Show>
      </div>
    </div>
  )
}
