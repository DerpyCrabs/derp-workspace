import { Show } from 'solid-js'
import {
  CHROME_BORDER_PX,
  CHROME_RESIZE_HANDLE_PX,
  CHROME_TITLEBAR_PX,
  SHELL_RESIZE_BOTTOM,
  SHELL_RESIZE_LEFT,
  SHELL_RESIZE_RIGHT,
} from './chromeConstants'
import {
  SHELL_CHROME_BG_FOCUSED_OPAQUE,
  SHELL_CHROME_BG_UNFOCUSED_OPAQUE,
} from './exclusionRects'

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
  client_side_decoration?: boolean
}

type ShellWindowFrameProps = {
  win: ShellWindowModel
  focused: boolean
  stackZ: number
  onTitlebarPointerDown: (clientX: number, clientY: number) => void
  onResizeEdgeDown: (edges: number, clientX: number, clientY: number) => void
  onMinimize: () => void
  onMaximize: () => void
  onClose: () => void
}

export function ShellWindowFrame(props: ShellWindowFrameProps) {
  const csd = !!props.win.client_side_decoration
  const th = csd ? 0 : CHROME_TITLEBAR_PX
  const bd = CHROME_BORDER_PX
  const rh = CHROME_RESIZE_HANDLE_PX
  const tiling = props.win.maximized || props.win.fullscreen
  const inset = tiling ? 0 : bd
  const outerW = props.win.width + inset * 2

  const startResize = (edges: number, clientX: number, clientY: number) => {
    props.onResizeEdgeDown(edges, clientX, clientY)
  }

  const chromeBg = props.focused
    ? SHELL_CHROME_BG_FOCUSED_OPAQUE
    : SHELL_CHROME_BG_UNFOCUSED_OPAQUE

  return (
    <div
      class="pointer-events-none box-border"
      style={{
        position: 'fixed',
        'z-index': props.stackZ,
        left: `${props.win.x - inset}px`,
        top: `${props.win.y - th - inset}px`,
        width: `${props.win.width + inset * 2}px`,
        height: `${props.win.height + th + inset * 2}px`,
        'box-sizing': 'border-box',
        'pointer-events': 'none',
        '--shell-chrome-bg': chromeBg,
      }}
    >
      <div
        class="pointer-events-none absolute z-[4] box-border border-0"
        style={{
          left: `${inset}px`,
          top: `${inset + th}px`,
          width: `${props.win.width}px`,
          height: `${props.win.height}px`,
          background: 'var(--shell-chrome-bg)',
        }}
      />
      <Show when={!csd}>
        <div
          class="absolute right-0 left-0 box-border flex items-center gap-1.5 py-0 pr-1.5 pl-2.5 select-none touch-none"
          classList={{
            'rounded-t-md': !tiling,
            'rounded-none': tiling,
          }}
          style={{
            top: `${inset}px`,
            height: `${th}px`,
            'z-index': 6,
            background: 'var(--shell-chrome-bg)',
            'pointer-events': 'auto',
          }}
          onPointerDown={(e) => {
            if (!e.isPrimary) return
            if (e.button !== 0) return
            if ((e.target as HTMLElement).closest('[data-shell-titlebar-controls]')) return
            e.preventDefault()
            e.stopPropagation()
            console.log(
              `[derp-shell-move] titlebar pointerdown win=${props.win.window_id} ${e.clientX},${e.clientY}`,
            )
            props.onTitlebarPointerDown(e.clientX, e.clientY)
          }}
          onTouchStart={(e) => {
            if ((e.target as HTMLElement).closest('[data-shell-titlebar-controls]')) return
            const t = e.changedTouches[0]
            if (!t) return
            e.preventDefault()
            e.stopPropagation()
            console.log(
              `[derp-shell-move] titlebar touchstart win=${props.win.window_id} ${t.clientX},${t.clientY}`,
            )
            props.onTitlebarPointerDown(t.clientX, t.clientY)
          }}
        >
          <span
            class="min-w-0 flex-1 overflow-hidden text-[13px] font-semibold text-ellipsis whitespace-nowrap"
            classList={{
              'opacity-[0.72]': !props.focused,
              'opacity-[0.95]': props.focused,
            }}
          >
            {props.win.title || props.win.app_id || `window ${props.win.window_id}`}
          </span>
          <div class="flex shrink-0 items-center gap-1" data-shell-titlebar-controls>
            <button
              type="button"
              class="m-0 flex h-[22px] w-7 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-white/12 p-0 text-base leading-none font-bold text-neutral-200 hover:bg-white/[0.22]"
              title="Minimize window"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => props.onMinimize()}
            >
              −
            </button>
            <button
              type="button"
              class="m-0 flex h-[22px] w-7 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-white/12 p-0 text-sm leading-none text-neutral-200 hover:bg-white/[0.22]"
              title={props.win.maximized ? 'Restore' : 'Maximize'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => props.onMaximize()}
            >
              {props.win.maximized ? (
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
              class="m-0 flex h-[22px] w-7 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-white/12 p-0 text-lg leading-none text-neutral-200 hover:bg-[rgba(220,60,60,0.85)] hover:text-white"
              title="Close window"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => props.onClose()}
            >
              ×
            </button>
          </div>
        </div>
      </Show>
      <div
        class="pointer-events-none z-[5] box-border border-0 bg-[var(--shell-chrome-bg)]"
        classList={{ hidden: tiling }}
        style={{
          position: 'absolute',
          left: '0',
          top: `${inset + th}px`,
          width: `${bd}px`,
          height: `${props.win.height}px`,
        }}
      />
      <div
        class="pointer-events-none z-[5] box-border border-0 bg-[var(--shell-chrome-bg)]"
        classList={{ hidden: tiling }}
        style={{
          position: 'absolute',
          right: '0',
          top: `${inset + th}px`,
          width: `${bd}px`,
          height: `${props.win.height}px`,
        }}
      />
      <div
        class="pointer-events-none z-[5] box-border border-0 bg-[var(--shell-chrome-bg)]"
        classList={{ hidden: tiling }}
        style={{
          position: 'absolute',
          left: '0',
          right: '0',
          top: `${inset + th + props.win.height}px`,
          height: `${bd}px`,
        }}
      />
      <div
        class="pointer-events-auto touch-none z-[3] box-border"
        classList={{ hidden: tiling }}
        title="Resize"
        style={{
          position: 'absolute',
          left: '0',
          bottom: '0',
          width: `${rh}px`,
          height: `${rh}px`,
          cursor: 'nesw-resize',
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_BOTTOM | SHELL_RESIZE_LEFT, e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0]
          if (!t) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_BOTTOM | SHELL_RESIZE_LEFT, t.clientX, t.clientY)
        }}
      />
      <div
        class="pointer-events-auto touch-none z-[3] box-border"
        classList={{ hidden: tiling }}
        title="Resize"
        style={{
          position: 'absolute',
          right: '0',
          bottom: '0',
          width: `${rh}px`,
          height: `${rh}px`,
          cursor: 'nwse-resize',
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_BOTTOM | SHELL_RESIZE_RIGHT, e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0]
          if (!t) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_BOTTOM | SHELL_RESIZE_RIGHT, t.clientX, t.clientY)
        }}
      />
      <div
        class="pointer-events-auto touch-none z-[3] box-border"
        classList={{ hidden: tiling }}
        title="Resize height"
        style={{
          position: 'absolute',
          left: `${rh}px`,
          bottom: '0',
          width: `${Math.max(0, outerW - 2 * rh)}px`,
          height: `${rh}px`,
          cursor: 'ns-resize',
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_BOTTOM, e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0]
          if (!t) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_BOTTOM, t.clientX, t.clientY)
        }}
      />
      <div
        class="pointer-events-auto touch-none z-[3] box-border"
        classList={{ hidden: tiling }}
        title="Resize width"
        style={{
          position: 'absolute',
          left: '0',
          top: `${inset + th}px`,
          width: `${rh}px`,
          bottom: `${rh}px`,
          cursor: 'ew-resize',
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_LEFT, e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0]
          if (!t) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_LEFT, t.clientX, t.clientY)
        }}
      />
      <div
        class="pointer-events-auto touch-none z-[3] box-border"
        classList={{ hidden: tiling }}
        title="Resize width"
        style={{
          position: 'absolute',
          right: '0',
          top: `${inset + th}px`,
          width: `${rh}px`,
          bottom: `${rh}px`,
          cursor: 'ew-resize',
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_RIGHT, e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0]
          if (!t) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_RIGHT, t.clientX, t.clientY)
        }}
      />
    </div>
  )
}
