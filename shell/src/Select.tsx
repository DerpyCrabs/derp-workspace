import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type Component,
} from 'solid-js'
import { Portal } from 'solid-js/web'
import { useShellFloating } from './ShellFloatingContext'
import {
  hideFloatingPlacementWire,
  pushShellFloatingWireFromDom,
  type ShellFloatingAnchor,
} from './shellFloatingPlacement'

export type SelectProps<T> = {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  itemLabel: (v: T) => string
  equals?: (a: T, b: T) => boolean
  triggerClass?: string
  listClass?: string
  minMenuWidthPx?: number
  open?: Accessor<boolean>
  setOpen?: (v: boolean) => void
}

const DEFAULT_TRIGGER_CLASS =
  'border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) min-w-[7.5rem] max-w-[12rem] cursor-pointer rounded px-[0.45rem] py-0.5 text-left font-inherit text-[0.78rem]'

const DEFAULT_LIST_CLASS =
  'border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) absolute top-2 left-2 z-90000 flex max-h-[min(320px,50vh,calc(100%-16px))] min-w-48 flex-col overflow-hidden rounded-[0.35rem] py-0.5'

export const Select: Component<SelectProps<unknown>> = (props) => {
  const shellFloat = useShellFloating()
  const [internalOpen, setInternalOpen] = createSignal(false)
  const isOpen = () =>
    props.open !== undefined ? props.open() : internalOpen()
  const setIsOpen = (v: boolean) => {
    props.setOpen?.(v)
    if (props.open === undefined) setInternalOpen(v)
  }

  let anchorWrap: HTMLDivElement | undefined
  let triggerBtn: HTMLButtonElement | undefined
  let panelEl: HTMLDivElement | undefined

  const [anchorPt, setAnchorPt] = createSignal<ShellFloatingAnchor>({ x: 0, y: 0 })

  const eq = () => props.equals ?? ((a: unknown, b: unknown) => a === b)

  onMount(() => {
    const closer = () => {
      if (!isOpen()) return false
      setIsOpen(false)
      return true
    }
    shellFloat.registerAtlasSelectCloser(closer)
    onCleanup(() => shellFloat.unregisterAtlasSelectCloser(closer))
  })

  createEffect(() => {
    if (!isOpen()) return
    shellFloat.acquireAtlasOverlayPointer()
    onCleanup(() => shellFloat.releaseAtlasOverlayPointer())
  })

  createEffect(() => {
    if (!isOpen()) return
    const syncAnchor = () => {
      const b = triggerBtn?.getBoundingClientRect()
      if (b) {
        setAnchorPt({ x: b.left, y: b.bottom, alignAboveY: b.top })
      }
    }
    queueMicrotask(syncAnchor)
    syncAnchor()
    window.addEventListener('resize', syncAnchor)
    window.addEventListener('scroll', syncAnchor, true)
    onCleanup(() => {
      window.removeEventListener('resize', syncAnchor)
      window.removeEventListener('scroll', syncAnchor, true)
    })
  })

  createEffect(() => {
    if (!isOpen()) return
    const onPtr = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (anchorWrap?.contains(t)) return
      if (panelEl?.contains(t)) return
      setIsOpen(false)
    }
    document.addEventListener('pointerdown', onPtr, true)
    onCleanup(() => document.removeEventListener('pointerdown', onPtr, true))
  })

  createEffect(() => {
    if (!isOpen()) {
      hideFloatingPlacementWire()
      return
    }
    void props.options.length
    void props.value
    const anch = anchorPt()
    const og = shellFloat.outputGeom()
    const ph = shellFloat.outputPhysical()
    const rid = requestAnimationFrame(() => {
      const main = shellFloat.mainEl()
      const atlas = shellFloat.atlasHostEl()
      const panel = panelEl
      const bufH = shellFloat.atlasBufferH()
      if (!main || !atlas || !panel || !og || !ph) return
      pushShellFloatingWireFromDom({
        main,
        atlasHost: atlas,
        panel,
        anchor: anch,
        canvasW: og.w,
        canvasH: og.h,
        physicalW: ph.w,
        physicalH: ph.h,
        contextMenuAtlasBufferH: bufH,
        screens: shellFloat.screenDraftRows(),
        layoutOrigin: shellFloat.layoutCanvasOrigin(),
      })
    })
    onCleanup(() => cancelAnimationFrame(rid))
  })

  createEffect(() => {
    if (!isOpen()) return
    const onKey = (e: KeyboardEvent) => {
      const opts = props.options
      const n = opts.length
      if (n === 0) return
      let hi = opts.findIndex((o) => eq()(o, props.value))
      if (hi < 0) hi = 0
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const ni = (hi + 1) % n
        props.onChange(opts[ni]!)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const ni = (hi - 1 + n) % n
        props.onChange(opts[ni]!)
      } else if (!e.repeat && !e.isComposing && e.key === 'Enter') {
        e.preventDefault()
        setIsOpen(false)
      } else if (e.key === 'Home') {
        e.preventDefault()
        props.onChange(opts[0]!)
      } else if (e.key === 'End') {
        e.preventDefault()
        props.onChange(opts[n - 1]!)
      }
    }
    document.addEventListener('keydown', onKey, true)
    onCleanup(() => document.removeEventListener('keydown', onKey, true))
  })

  const minW = () => Math.max(120, props.minMenuWidthPx ?? 120)

  return (
    <div class="relative self-start" ref={(el) => (anchorWrap = el)}>
      <button
        type="button"
        ref={(el) => (triggerBtn = el)}
        class={props.triggerClass ?? DEFAULT_TRIGGER_CLASS}
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (isOpen()) {
            setIsOpen(false)
            return
          }
          shellFloat.closeAllAtlasSelects()
          shellFloat.dismissContextMenus()
          const b = triggerBtn?.getBoundingClientRect()
          if (b) setAnchorPt({ x: b.left, y: b.bottom, alignAboveY: b.top })
          setIsOpen(true)
        }}
      >
        {props.itemLabel(props.value)}
      </button>
      <Show when={isOpen()}>
        {(() => {
          const host = shellFloat.atlasHostEl()
          if (!host) return <></>
          return (
            <Portal mount={host}>
              <div
                ref={(el) => (panelEl = el)}
                class={props.listClass ?? DEFAULT_LIST_CLASS}
                style={{ 'min-width': `${minW()}px` }}
                role="listbox"
              >
                <For each={props.options as unknown[]}>
                  {(opt) => (
                    <button
                      type="button"
                      class="bg-transparent hover:bg-(--shell-overlay-hover) block w-full cursor-pointer border-0 px-[0.6rem] py-[0.35rem] text-left font-inherit text-[0.78rem]"
                      classList={{
                        'bg-[color-mix(in_srgb,var(--shell-overlay-active)_78%,var(--shell-accent-soft)_22%)] text-(--shell-text) shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
                          eq()(opt, props.value),
                      }}
                      role="option"
                      aria-selected={eq()(opt, props.value)}
                      onPointerDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        props.onChange(opt)
                        setIsOpen(false)
                      }}
                    >
                      {props.itemLabel(opt)}
                    </button>
                  )}
                </For>
              </div>
            </Portal>
          )
        })()}
      </Show>
    </div>
  )
}
