import {
  type JSX,
  type Accessor,
  Show,
  createEffect,
  createMemo,
  onCleanup,
  onMount,
} from 'solid-js'
import {
  invalidateShellUiWindow,
  registerShellUiWindow,
  shellUiWindowMeasureFromEnv,
  type ShellUiMeasureEnv,
} from '@/features/shell-ui/shellUiWindows'
import { registerShellWindowFrame } from './shellWindowFrameDom'
import {
  CHROME_BORDER_PX,
  CHROME_RESIZE_HANDLE_PX,
  CHROME_TITLEBAR_PX,
  SHELL_RESIZE_BOTTOM,
  SHELL_RESIZE_LEFT,
  SHELL_RESIZE_RIGHT,
} from '@/lib/chromeConstants'

export type ShellWindowModel = {
  window_id: number
  surface_id: number
  x: number
  y: number
  width: number
  height: number
  title: string
  app_id: string
  maximized: boolean
  fullscreen: boolean
  snap_tiled?: boolean
}

type MaybeAcc<T> = T | Accessor<T>

function readAcc<T>(v: MaybeAcc<T>): T {
  return typeof v === 'function' ? (v as Accessor<T>)() : v
}

function titlebarInteractionTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement
    ? target.closest('[data-shell-titlebar-controls], [data-workspace-tab], [data-workspace-tab-close]')
    : null
}

type ShellWindowFrameProps = {
  win: ShellWindowModel | Accessor<ShellWindowModel | undefined>
  repaintKey?: MaybeAcc<number>
  focused: MaybeAcc<boolean>
  stackZ: MaybeAcc<number>
  onFocusRequest?: () => void
  onTitlebarPointerDown: (pointerId: number, clientX: number, clientY: number) => void
  onSnapAssistOpen?: (anchorRect: DOMRect) => void
  onResizeEdgeDown: (edges: number, pointerId: number, clientX: number, clientY: number) => void
  onMinimize: () => void
  onMaximize: () => void
  onClose: () => void
  shellUiRegister?: { id: number; z: number; getEnv: () => ShellUiMeasureEnv | null }
  allowImperativeGeometrySync?: boolean
  tabStrip?: JSX.Element
  children?: JSX.Element
}

export function ShellWindowFrame(props: ShellWindowFrameProps) {
  let root: HTMLDivElement | undefined
  let unregisterFrame: (() => void) | undefined
  const requestFocus = () => {
    props.onFocusRequest?.()
  }
  const model = createMemo((): ShellWindowModel | undefined => {
    const v = props.win
    return typeof v === 'function' ? (v as Accessor<ShellWindowModel | undefined>)() : v
  })
  const layout = createMemo(() => {
    const w = model()
    if (!w) {
      return {
        th: 0,
        bd: CHROME_BORDER_PX,
        rh: CHROME_RESIZE_HANDLE_PX,
        inset: 0,
        outerW: 1,
        showBorderChrome: false,
      }
    }
    const th = CHROME_TITLEBAR_PX
    const bd = CHROME_BORDER_PX
    const rh = CHROME_RESIZE_HANDLE_PX
    const noTilingChrome = w.maximized || w.fullscreen
    const snapTiled = !!w.snap_tiled && !noTilingChrome
    const inset = noTilingChrome || snapTiled ? 0 : bd
    const outerW = w.width + inset * 2
    const showBorderChrome = !noTilingChrome
    return { th, bd, rh, inset, outerW, showBorderChrome }
  })
  const chromeBg = createMemo(() =>
    readAcc(props.focused)
      ? 'var(--shell-window-chrome-focused)'
      : 'var(--shell-window-chrome-unfocused)',
  )
  const startResize = (edges: number, pointerId: number, clientX: number, clientY: number) => {
    props.onResizeEdgeDown(edges, pointerId, clientX, clientY)
  }

  onMount(() => {
    if (!props.shellUiRegister) return
    const unreg = registerShellUiWindow(props.shellUiRegister.id, () => {
      const cfg = props.shellUiRegister
      if (!cfg) return null
      return shellUiWindowMeasureFromEnv(cfg.id, cfg.z, root, cfg.getEnv)
    })
    onCleanup(unreg)
  })

  createEffect(() => {
    unregisterFrame?.()
    unregisterFrame = undefined
    const windowId = model()?.window_id
    if (!root || windowId == null || props.allowImperativeGeometrySync === false) return
    unregisterFrame = registerShellWindowFrame(windowId, root)
  })

  onCleanup(() => {
    unregisterFrame?.()
  })

  createEffect(() => {
    if (!props.shellUiRegister) return
    const w = model()
    if (w) {
      w.x
      w.y
      w.width
      w.height
      w.snap_tiled
    }
    readAcc(props.stackZ)
    props.shellUiRegister.z
    invalidateShellUiWindow(props.shellUiRegister.id)
  })

  return (
    <div
      ref={(el) => {
        root = el
      }}
      data-shell-window-frame={model()?.window_id ?? 0}
      data-shell-frame-inset={layout().inset}
      data-shell-frame-titlebar={layout().th}
      data-shell-repaint={props.repaintKey !== undefined ? readAcc(props.repaintKey) : 0}
      class="pointer-events-none box-border"
      style={{
        position: 'absolute',
        'z-index': 1000 + readAcc(props.stackZ),
        left: '0',
        top: '0',
        width: `${(model()?.width ?? 0) + layout().inset * 2}px`,
        height: `${(model()?.height ?? 0) + layout().th + layout().inset * 2}px`,
        transform: `translate3d(${(model()?.x ?? 0) - layout().inset}px, ${(model()?.y ?? 0) - layout().th - layout().inset}px, 0)`,
        'will-change': 'transform',
        'box-sizing': 'border-box',
        'pointer-events': 'none',
        contain: 'layout paint',
        background: 'var(--shell-chrome-bg)',
        '--shell-chrome-bg': chromeBg(),
      }}
    >
      <Show when={props.children}>
        <div
          class="pointer-events-auto absolute z-5 box-border min-h-0 min-w-0 overflow-auto bg-(--shell-surface-inset) text-(--shell-text)"
          style={{
            left: `${layout().inset}px`,
            top: `${layout().inset + layout().th}px`,
            width: `${model()?.width ?? 0}px`,
            height: `${model()?.height ?? 0}px`,
          }}
          onPointerDown={(e) => {
            if (!e.isPrimary || e.button !== 0) return
            requestFocus()
          }}
          onTouchStart={() => {
            requestFocus()
          }}
        >
          {props.children}
        </div>
      </Show>
      <div
        data-shell-titlebar={model()?.window_id ?? 0}
        class="absolute right-0 left-0 box-border flex items-center gap-1.5 border-b border-(--shell-border) py-0 pr-1.5 pl-2.5 select-none touch-none"
        style={{
          top: `${layout().inset}px`,
          height: `${layout().th}px`,
          'z-index': 6,
          background: 'var(--shell-chrome-bg)',
          'pointer-events': 'auto',
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary) return
          if (e.button !== 0) return
          requestFocus()
          if (titlebarInteractionTarget(e.target)) return
          e.preventDefault()
          e.stopPropagation()
          props.onTitlebarPointerDown(e.pointerId, e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          requestFocus()
          if (titlebarInteractionTarget(e.target)) return
          const t = e.changedTouches[0]
          if (!t) return
          e.preventDefault()
          e.stopPropagation()
          props.onTitlebarPointerDown(-1, t.clientX, t.clientY)
        }}
      >
        <Show
          when={props.tabStrip}
          fallback={
            <span
              class="min-w-0 flex-1 overflow-hidden text-[13px] font-semibold text-ellipsis whitespace-nowrap"
              classList={{
                'text-(--shell-text-muted)': !readAcc(props.focused),
                'text-(--shell-text)': readAcc(props.focused),
              }}
            >
              {model()?.title || model()?.app_id || `window ${model()?.window_id ?? 0}`}
            </span>
          }
        >
          <div class="min-w-0 flex-1 overflow-hidden">{props.tabStrip}</div>
        </Show>
        <div class="flex shrink-0 items-center gap-1" data-shell-titlebar-controls>
          <button
            type="button"
            class="m-0 flex h-[22px] w-7 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent p-0 text-base leading-none font-bold text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-bg) hover:text-(--shell-text)"
            title="Minimize window"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => props.onMinimize()}
          >
            −
          </button>
          <button
            type="button"
            data-shell-maximize-trigger={model()?.window_id ?? 0}
            class="m-0 flex h-[22px] w-7 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent p-0 text-sm leading-none text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-bg) hover:text-(--shell-text)"
            title={model()?.maximized ? 'Restore' : 'Maximize'}
            onPointerDown={(e) => {
              e.stopPropagation()
              if (e.button !== 2) return
              e.preventDefault()
              props.onSnapAssistOpen?.(e.currentTarget.getBoundingClientRect())
            }}
            onClick={() => props.onMaximize()}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              props.onSnapAssistOpen?.(e.currentTarget.getBoundingClientRect())
            }}
          >
            {model()?.maximized ? (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.35"
                  stroke-linejoin="miter"
                  d="M1.5 3.5h7v7h-7z M3.5 1.5h7v7h-7z"
                />
              </svg>
            ) : (
              <svg class="block shrink-0" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect
                  x="2"
                  y="2"
                  width="8"
                  height="8"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.35"
                />
              </svg>
            )}
          </button>
          <button
            type="button"
            class="m-0 flex h-[22px] w-7 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent p-0 text-lg leading-none text-(--shell-control-muted-text) hover:bg-[color-mix(in_srgb,var(--shell-warning-bg)_70%,var(--shell-accent)_30%)] hover:text-(--shell-text)"
            title="Close window"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => props.onClose()}
          >
            ×
          </button>
        </div>
      </div>
      <div
        class="pointer-events-auto touch-none z-3 box-border"
        classList={{ hidden: !layout().showBorderChrome }}
        title="Resize"
        style={{
          position: 'absolute',
          left: '0',
          bottom: '0',
          width: `${layout().rh}px`,
          height: `${layout().rh}px`,
          cursor: 'nesw-resize',
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_BOTTOM | SHELL_RESIZE_LEFT, e.pointerId, e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0]
          if (!t) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_BOTTOM | SHELL_RESIZE_LEFT, -1, t.clientX, t.clientY)
        }}
      />
      <div
        class="pointer-events-auto touch-none z-3 box-border"
        classList={{ hidden: !layout().showBorderChrome }}
        title="Resize"
        style={{
          position: 'absolute',
          right: '0',
          bottom: '0',
          width: `${layout().rh}px`,
          height: `${layout().rh}px`,
          cursor: 'nwse-resize',
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_BOTTOM | SHELL_RESIZE_RIGHT, e.pointerId, e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0]
          if (!t) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_BOTTOM | SHELL_RESIZE_RIGHT, -1, t.clientX, t.clientY)
        }}
      />
      <div
        class="pointer-events-auto touch-none z-3 box-border"
        classList={{ hidden: !layout().showBorderChrome }}
        title="Resize height"
        style={{
          position: 'absolute',
          left: `${layout().rh}px`,
          bottom: '0',
          width: `${Math.max(0, layout().outerW - 2 * layout().rh)}px`,
          height: `${layout().rh}px`,
          cursor: 'ns-resize',
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_BOTTOM, e.pointerId, e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0]
          if (!t) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_BOTTOM, -1, t.clientX, t.clientY)
        }}
      />
      <div
        class="pointer-events-auto touch-none z-3 box-border"
        classList={{ hidden: !layout().showBorderChrome }}
        title="Resize width"
        style={{
          position: 'absolute',
          left: '0',
          top: `${layout().inset + layout().th}px`,
          width: `${layout().rh}px`,
          bottom: `${layout().rh}px`,
          cursor: 'ew-resize',
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_LEFT, e.pointerId, e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0]
          if (!t) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_LEFT, -1, t.clientX, t.clientY)
        }}
      />
      <div
        class="pointer-events-auto touch-none z-3 box-border"
        classList={{ hidden: !layout().showBorderChrome }}
        title="Resize width"
        style={{
          position: 'absolute',
          right: '0',
          top: `${layout().inset + layout().th}px`,
          width: `${layout().rh}px`,
          bottom: `${layout().rh}px`,
          cursor: 'ew-resize',
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_RIGHT, e.pointerId, e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0]
          if (!t) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_RIGHT, -1, t.clientX, t.clientY)
        }}
      />
    </div>
  )
}
