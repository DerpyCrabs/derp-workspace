import {
  CHROME_BORDER_PX,
  CHROME_RESIZE_HANDLE_PX,
  CHROME_TITLEBAR_PX,
  SHELL_RESIZE_BOTTOM,
  SHELL_RESIZE_LEFT,
  SHELL_RESIZE_RIGHT,
} from './chromeConstants'
import './App.css'

/** Mirrors compositor window geometry + metadata (OSR overlay chrome). */
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
}

type ShellWindowFrameProps = {
  win: ShellWindowModel
  focused: boolean
  /** Stacking vs other chrome (focused window should use the largest). */
  stackZ: number
  onTitlebarPointerDown: (clientX: number, clientY: number) => void
  /** Bitmask: [`SHELL_RESIZE_BOTTOM`] \| … (see chromeConstants). */
  onResizeEdgeDown: (edges: number, clientX: number, clientY: number) => void
  onMinimize: () => void
  onMaximize: () => void
  onClose: () => void
}

export function ShellWindowFrame(props: ShellWindowFrameProps) {
  const th = CHROME_TITLEBAR_PX
  const bd = CHROME_BORDER_PX
  const rh = CHROME_RESIZE_HANDLE_PX
  const tiling = props.win.maximized || props.win.fullscreen
  /** Tiling hides borders; don’t reserve outer inset or gaps stay visible around the frame. */
  const inset = tiling ? 0 : bd
  const outerW = props.win.width + inset * 2

  const startResize = (edges: number, clientX: number, clientY: number) => {
    props.onResizeEdgeDown(edges, clientX, clientY)
  }

  return (
    <div
      class="shell-window-chrome"
      classList={{
        'shell-window-chrome--focused': props.focused,
        'shell-window-chrome--tiling':
          props.win.maximized || props.win.fullscreen,
      }}
      style={{
        position: 'fixed',
        'z-index': props.stackZ,
        left: `${props.win.x - inset}px`,
        top: `${props.win.y - th - inset}px`,
        width: `${props.win.width + inset * 2}px`,
        height: `${props.win.height + th + inset * 2}px`,
        'box-sizing': 'border-box',
        'pointer-events': 'none',
      }}
    >
      <div
        class="shell-titlebar"
        style={{
          top: `${inset}px`,
          height: `${th}px`,
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary) return
          if (e.button !== 0) return
          if ((e.target as HTMLElement).closest('.shell-titlebar__controls')) return
          e.preventDefault()
          e.stopPropagation()
          console.log(
            `[derp-shell-move] titlebar pointerdown win=${props.win.window_id} ${e.clientX},${e.clientY}`,
          )
          props.onTitlebarPointerDown(e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          if ((e.target as HTMLElement).closest('.shell-titlebar__controls')) return
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
        <span class="shell-titlebar__text">
          {props.win.title || props.win.app_id || `window ${props.win.window_id}`}
        </span>
        <div class="shell-titlebar__controls">
          <button
            type="button"
            class="shell-titlebar__minimize"
            title="Minimize window"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => props.onMinimize()}
          >
            −
          </button>
          <button
            type="button"
            class="shell-titlebar__maximize-tile"
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
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
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
            class="shell-titlebar__close"
            title="Close window"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => props.onClose()}
          >
            ×
          </button>
        </div>
      </div>
      <div
        class="shell-border shell-border--left"
        style={{
          position: 'absolute',
          left: '0',
          top: `${inset + th}px`,
          width: `${bd}px`,
          height: `${props.win.height}px`,
        }}
      />
      <div
        class="shell-border shell-border--right"
        style={{
          position: 'absolute',
          right: '0',
          top: `${inset + th}px`,
          width: `${bd}px`,
          height: `${props.win.height}px`,
        }}
      />
      <div
        class="shell-border shell-border--bottom"
        style={{
          position: 'absolute',
          left: '0',
          right: '0',
          top: `${inset + th + props.win.height}px`,
          height: `${bd}px`,
        }}
      />
      {/* Resize hits: bottom + sides only. Side strips start below titlebar so the top band is not a resize target. */}
      <div
        class="shell-resize-handle"
        title="Resize"
        style={{
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
        class="shell-resize-handle"
        title="Resize"
        style={{
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
        class="shell-resize-handle"
        title="Resize height"
        style={{
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
        class="shell-resize-handle"
        title="Resize width"
        style={{
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
        class="shell-resize-handle"
        title="Resize width"
        style={{
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
