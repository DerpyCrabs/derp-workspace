import { createEffect, onCleanup, type Accessor } from 'solid-js'
import { registerShellExclusionElement } from '@/features/bridge/shellExclusionSync'
import type { LayoutScreen, SnapAssistStripState } from './types'

export type SnapAssistTopStripProps = {
  strip: SnapAssistStripState
  screen: LayoutScreen
  screenCssRect: (screen: LayoutScreen) => LayoutScreen
  exclusionActive: Accessor<boolean>
}

export function SnapAssistTopStrip(props: SnapAssistTopStripProps) {
  const screenRect = () => props.screenCssRect(props.screen)
  let stripEl: HTMLElement | undefined
  createEffect(() => {
    const el = stripEl
    if (!el || !props.exclusionActive()) return
    const registration = registerShellExclusionElement('base', 'snap-strip', el)
    onCleanup(registration.unregister)
  })
  return (
    <div
      class="pointer-events-none fixed z-401200"
      style={{
        left: `${screenRect().x}px`,
        top: `${screenRect().y}px`,
        width: `${screenRect().width}px`,
        height: '0px',
      }}
    >
      <button
        type="button"
        data-shell-snap-strip-trigger
        data-shell-snap-strip-monitor={props.strip.monitorName}
        class="pointer-events-auto border border-(--shell-border) bg-(--shell-surface-panel) text-(--shell-text) absolute top-2 left-1/2 flex h-8 min-w-[132px] -translate-x-1/2 items-center justify-center rounded-full px-4 text-[12px] font-semibold shadow-lg transition-colors"
        ref={(el) => {
          stripEl = el
        }}
        classList={{
          'bg-(--shell-accent-soft)': props.strip.open,
        }}
      >
        Snap layouts
      </button>
    </div>
  )
}
