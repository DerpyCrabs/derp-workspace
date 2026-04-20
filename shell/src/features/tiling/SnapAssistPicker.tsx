import { createEffect, createMemo, createSignal, For, onCleanup, onMount } from 'solid-js'
import type { AssistGridShape, AssistGridSpan } from './assistGrid'
import { SnapAssistMasterGrid } from './SnapAssistMasterGrid'
import type { SnapAssistPickerAnchorRect } from '@/host/types'
import {
  invalidateShellUiWindow,
  registerShellUiWindow,
  shellUiWindowMeasureFromEnv,
  type ShellUiMeasureEnv,
} from '@/features/shell-ui/shellUiWindows'

const SNAP_ASSIST_SHAPES: AssistGridShape[] = ['3x2', '3x3', '2x2', '2x3']
const PICKER_APPROX_WIDTH = 360
const PICKER_APPROX_HEIGHT = 520
const PICKER_GUTTER_PX = 18
const DEFAULT_PICKER_SPAN: AssistGridSpan = {
  gridCols: 3,
  gridRows: 2,
  gc0: 0,
  gc1: 0,
  gr0: 0,
  gr1: 0,
}

function shapeLabel(shape: AssistGridShape): string {
  switch (shape) {
    case '3x2':
      return '3x2'
    case '3x3':
      return '3x3'
    case '2x2':
      return '2x2'
    case '2x3':
      return '2x3'
  }
}

export type SnapAssistPickerProps = {
  anchorRect: SnapAssistPickerAnchorRect
  container: HTMLElement
  hoverSpan: AssistGridSpan | null
  autoHover?: boolean
  shellUiWindowId?: number
  shellUiWindowZ?: number
  getShellUiMeasureEnv?: () => ShellUiMeasureEnv | null
  onHoverSpanChange: (span: AssistGridSpan | null) => void
  onSelectSpan: (span: AssistGridSpan) => void
  onClose: () => void
}

export function SnapAssistPicker(props: SnapAssistPickerProps) {
  let pickerRef: HTMLDivElement | undefined
  const [layoutRev, setLayoutRev] = createSignal(0)
  const [measuredBox, setMeasuredBox] = createSignal<{ width: number; height: number } | null>(null)

  createEffect(() => {
    void layoutRev()
    const node = pickerRef
    if (!node) {
      setMeasuredBox(null)
      return
    }
    let raf = 0
    raf = requestAnimationFrame(() => {
      const rect = node.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setMeasuredBox({ width: rect.width, height: rect.height })
      }
    })
    onCleanup(() => cancelAnimationFrame(raf))
  })

  createEffect(() => {
    const container = props.container
    const bump = () => setLayoutRev((v) => v + 1)
    const ro = new ResizeObserver(bump)
    ro.observe(container)
    window.addEventListener('resize', bump)
    onCleanup(() => {
      ro.disconnect()
      window.removeEventListener('resize', bump)
    })
  })

  const position = createMemo(() => {
    void layoutRev()
    const box = measuredBox()
    const width = Math.max(1, box?.width ?? PICKER_APPROX_WIDTH)
    const height = Math.max(1, box?.height ?? PICKER_APPROX_HEIGHT)
    const containerRect = props.container.getBoundingClientRect()
    const minLeft = containerRect.left + 8
    const maxLeft = containerRect.right - width - 8
    const minTop = containerRect.top + 8
    const maxTop = containerRect.bottom - height - 8
    let left = props.anchorRect.left + props.anchorRect.width / 2 - width / 2
    if (maxLeft >= minLeft) {
      if (left > maxLeft) left = maxLeft
      if (left < minLeft) left = minLeft
    } else {
      left = containerRect.left + Math.max(0, (containerRect.width - width) / 2)
    }
    let top = props.anchorRect.bottom
    if (top > maxTop) top = props.anchorRect.top - height
    if (maxTop >= minTop) {
      if (top > maxTop) top = maxTop
      if (top < minTop) top = minTop
    } else {
      top = containerRect.top + Math.max(0, (containerRect.height - height) / 2)
    }
    return { left, top }
  })

  createEffect(() => {
    if (!props.shellUiWindowId || props.shellUiWindowZ == null || !props.getShellUiMeasureEnv) return
    position()
    invalidateShellUiWindow(props.shellUiWindowId)
  })

  onMount(() => {
    if (props.shellUiWindowId && props.shellUiWindowZ != null && props.getShellUiMeasureEnv) {
      const unreg = registerShellUiWindow(props.shellUiWindowId, () =>
        shellUiWindowMeasureFromEnv(
          props.shellUiWindowId!,
          props.shellUiWindowZ!,
          pickerRef,
          props.getShellUiMeasureEnv!,
        ),
      )
      onCleanup(unreg)
    }
    if (props.autoHover !== false) {
      props.onHoverSpanChange(props.hoverSpan ?? DEFAULT_PICKER_SPAN)
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (pickerRef?.contains(target)) return
      props.onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      props.onHoverSpanChange(null)
    })
  })

  return (
    <div
      ref={(el) => {
        pickerRef = el
      }}
      data-shell-snap-picker
      data-tiling-picker
      class="fixed z-460200 max-h-[min(80vh,520px)] w-[min(360px,calc(100vw-16px))] overflow-y-auto rounded-lg border border-(--shell-border) bg-(--shell-surface-panel) p-3 shadow-2xl"
      style={{
        left: `${position().left}px`,
        top: `${position().top}px`,
      }}
    >
      <div class="mb-2 text-[11px] font-semibold tracking-wider text-(--shell-text-dim) uppercase">
        Snap layouts
      </div>
      <div class="flex flex-col gap-2.5">
        <For each={SNAP_ASSIST_SHAPES}>
          {(shape) => (
            <SnapAssistMasterGrid
              shape={shape}
              gutterPx={PICKER_GUTTER_PX}
              layoutLabel={shapeLabel(shape)}
              getHoverSpan={() => props.hoverSpan}
              pickMode
              onHoverSpan={props.onHoverSpanChange}
              onPickSpan={props.onSelectSpan}
            />
          )}
        </For>
      </div>
    </div>
  )
}
