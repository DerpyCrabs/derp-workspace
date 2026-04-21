import { createMemo, For, type Accessor, type Component } from 'solid-js'
import { SnapAssistMasterGrid } from './SnapAssistMasterGrid'
import { ASSIST_GRID_SHAPES, type AssistGridShape } from './assistGrid'
import { getMonitorLayout, setMonitorEdgeLayout } from './tilingConfig'

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

export const EdgeLayoutPicker: Component<{
  outputName: string
  revision: Accessor<number>
  onPersisted: () => void
}> = (props) => {
  const value = createMemo(() => {
    props.revision()
    return getMonitorLayout(props.outputName).edgeLayout
  })

  const chooseShape = (shape: AssistGridShape) => {
    if (value() === shape) return
    setMonitorEdgeLayout(props.outputName, shape)
    props.onPersisted()
  }

  return (
    <div class="flex min-w-0 flex-1 flex-col gap-2 text-[0.7rem] tracking-wide text-(--shell-text-muted)">
      <span>edge layout</span>
      <div class="grid min-w-0 grid-cols-2 gap-2">
        <For each={ASSIST_GRID_SHAPES}>
          {(shape) => (
            <button
              type="button"
              class="border border-(--shell-border) bg-(--shell-surface) hover:bg-(--shell-surface-elevated) flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl p-2 text-left"
              classList={{
                'border-(--shell-accent-border) bg-(--shell-accent-soft) shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
                  value() === shape,
              }}
              onClick={() => chooseShape(shape)}
            >
              <div class="flex items-center justify-between gap-2">
                <span class="text-[0.76rem] font-semibold text-(--shell-text)">{shapeLabel(shape)}</span>
                <span class="text-[0.68rem] text-(--shell-text-dim)">
                  {value() === shape ? 'Selected' : 'Use'}
                </span>
              </div>
              <div class="flex h-[6.5rem] min-h-0 w-full min-w-0">
                <SnapAssistMasterGrid
                  shape={shape}
                  gutterPx={12}
                  layoutLabel={shapeLabel(shape)}
                  getHoverSpan={() => null}
                />
              </div>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
