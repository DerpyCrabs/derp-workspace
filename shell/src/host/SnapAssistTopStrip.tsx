import type { LayoutScreen, SnapAssistStripState } from './types'

export type SnapAssistTopStripProps = {
  strip: SnapAssistStripState
  screen: LayoutScreen
  screenCssRect: (screen: LayoutScreen) => LayoutScreen
}

export function SnapAssistTopStrip(props: SnapAssistTopStripProps) {
  return (
    <div
      class="pointer-events-none fixed z-401200"
      style={{
        left: `${props.screenCssRect(props.screen).x}px`,
        top: `${props.screenCssRect(props.screen).y}px`,
        width: `${props.screenCssRect(props.screen).width}px`,
        height: '0px',
      }}
    >
      <button
        type="button"
        data-shell-snap-strip-trigger
        data-shell-snap-strip-monitor={props.strip.monitorName}
        class="pointer-events-auto border border-(--shell-border) bg-(--shell-surface-panel) text-(--shell-text) absolute top-2 left-1/2 flex h-8 min-w-[132px] -translate-x-1/2 items-center justify-center rounded-full px-4 text-[12px] font-semibold shadow-lg transition-colors"
        classList={{
          'bg-(--shell-accent-soft)': props.strip.open,
        }}
      >
        Snap layouts
      </button>
    </div>
  )
}
