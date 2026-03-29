import {
  CHROME_BORDER_PX,
  CHROME_RESIZE_HANDLE_PX,
  CHROME_TITLEBAR_PX,
  SHELL_RESIZE_BOTTOM,
  SHELL_RESIZE_LEFT,
  SHELL_RESIZE_RIGHT,
  SHELL_RESIZE_TOP,
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
}

type ShellWindowFrameProps = {
  win: ShellWindowModel
  focused: boolean
  /** Stacking vs other chrome (focused window should use the largest). */
  stackZ: number
  onTitlebarPointerDown: (clientX: number, clientY: number) => void
  /** Bitmask: [`SHELL_RESIZE_TOP`] \| … (see chromeConstants). */
  onResizeEdgeDown: (edges: number, clientX: number, clientY: number) => void
  onMinimize: () => void
  onClose: () => void
}

export function ShellWindowFrame(props: ShellWindowFrameProps) {
  const th = CHROME_TITLEBAR_PX
  const bd = CHROME_BORDER_PX
  const rh = CHROME_RESIZE_HANDLE_PX
  const outerW = props.win.width + bd * 2

  const startResize = (edges: number, clientX: number, clientY: number) => {
    props.onResizeEdgeDown(edges, clientX, clientY)
  }

  return (
    <div
      class="shell-window-chrome"
      classList={{ 'shell-window-chrome--focused': props.focused }}
      style={{
        position: 'fixed',
        'z-index': props.stackZ,
        left: `${props.win.x - bd}px`,
        top: `${props.win.y - th - bd}px`,
        width: `${props.win.width + bd * 2}px`,
        height: `${props.win.height + th + bd * 2}px`,
        'box-sizing': 'border-box',
        'pointer-events': 'none',
      }}
    >
      <div
        class="shell-titlebar"
        style={{
          position: 'absolute',
          left: `${bd}px`,
          top: `${bd}px`,
          width: `${props.win.width}px`,
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
          top: `${bd + th}px`,
          width: `${bd}px`,
          height: `${props.win.height}px`,
        }}
      />
      <div
        class="shell-border shell-border--right"
        style={{
          position: 'absolute',
          left: `${bd + props.win.width}px`,
          top: `${bd + th}px`,
          width: `${bd}px`,
          height: `${props.win.height}px`,
        }}
      />
      <div
        class="shell-border shell-border--bottom"
        style={{
          position: 'absolute',
          left: '0',
          top: `${bd + th + props.win.height}px`,
          width: `${props.win.width + bd * 2}px`,
          height: `${bd}px`,
        }}
      />
      {/* Resize hits: corners + edges (compositor owns geometry; deltas via wire). */}
      <div
        class="shell-resize-handle"
        title="Resize"
        style={{
          left: '0',
          top: '0',
          width: `${rh}px`,
          height: `${rh}px`,
          cursor: 'nwse-resize',
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_TOP | SHELL_RESIZE_LEFT, e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0]
          if (!t) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_TOP | SHELL_RESIZE_LEFT, t.clientX, t.clientY)
        }}
      />
      <div
        class="shell-resize-handle"
        title="Resize"
        style={{
          right: '0',
          top: '0',
          width: `${rh}px`,
          height: `${rh}px`,
          cursor: 'nesw-resize',
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_TOP | SHELL_RESIZE_RIGHT, e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0]
          if (!t) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_TOP | SHELL_RESIZE_RIGHT, t.clientX, t.clientY)
        }}
      />
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
          top: '0',
          width: `${Math.max(0, outerW - 2 * rh)}px`,
          height: `${rh}px`,
          cursor: 'ns-resize',
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_TOP, e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0]
          if (!t) return
          e.preventDefault()
          e.stopPropagation()
          startResize(SHELL_RESIZE_TOP, t.clientX, t.clientY)
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
          top: `${rh}px`,
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
          top: `${rh}px`,
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
