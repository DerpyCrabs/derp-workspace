import { CHROME_BORDER_PX, CHROME_TITLEBAR_PX } from './chromeConstants'
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
  onMinimize: () => void
  onClose: () => void
}

export function ShellWindowFrame(props: ShellWindowFrameProps) {
  const th = CHROME_TITLEBAR_PX
  const bd = CHROME_BORDER_PX

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
    </div>
  )
}
