import { createMemo, For, type Accessor, type Component } from 'solid-js'
import { SnapAssistMasterGrid } from './SnapAssistMasterGrid'
import { ASSIST_GRID_SHAPES, type AssistGridShape } from './assistGrid'
import { firstLeafZoneId } from './customLayouts'
import { CustomLayoutPreview } from './CustomLayoutPreview'
import {
  assistMonitorSnapLayout,
  getMonitorLayout,
  monitorSnapLayoutEquals,
  setMonitorSnapLayout,
} from './tilingConfig'

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

export const SnapLayoutPicker: Component<{
  outputName: string
  revision: Accessor<number>
  onPersisted: () => void
}> = (props) => {
  const monitorLayout = createMemo(() => {
    props.revision()
    return getMonitorLayout(props.outputName)
  })

  return (
    <div class="flex min-w-0 flex-1 flex-col gap-2 text-[0.7rem] tracking-wide text-(--shell-text-muted)">
      <span>snap layout</span>
      <div class="grid min-w-0 gap-2 md:grid-cols-2 xl:grid-cols-3">
        <For each={monitorLayout().customLayouts}>
          {(layout) => {
            const selected = createMemo(() =>
              monitorSnapLayoutEquals(monitorLayout().snapLayout, {
                kind: 'custom',
                layoutId: layout.id,
              }),
            )
            return (
              <button
                type="button"
                data-settings-snap-layout-option={`custom:${layout.id}`}
                data-settings-snap-layout-option-custom={layout.id}
                class="border border-(--shell-border) bg-(--shell-surface) hover:bg-(--shell-surface-elevated) flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl p-2 text-left"
                classList={{
                  'border-(--shell-accent-border) bg-(--shell-accent-soft) shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
                    selected(),
                }}
                onClick={() => {
                  if (selected()) return
                  setMonitorSnapLayout(props.outputName, { kind: 'custom', layoutId: layout.id })
                  props.onPersisted()
                }}
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="truncate text-[0.76rem] font-semibold text-(--shell-text)">{layout.name}</span>
                  <span class="text-[0.68rem] text-(--shell-text-dim)">{selected() ? 'Selected' : 'Use'}</span>
                </div>
                <CustomLayoutPreview
                  layout={layout}
                  selectedZoneId={firstLeafZoneId(layout.root)}
                  class="min-h-[6.5rem]"
                />
              </button>
            )
          }}
        </For>
        <For each={ASSIST_GRID_SHAPES}>
          {(shape) => {
            const snapLayout = assistMonitorSnapLayout(shape)
            const selected = createMemo(() => monitorSnapLayoutEquals(monitorLayout().snapLayout, snapLayout))
            return (
              <button
                type="button"
                data-settings-snap-layout-option={shape}
                class="border border-(--shell-border) bg-(--shell-surface) hover:bg-(--shell-surface-elevated) flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl p-2 text-left"
                classList={{
                  'border-(--shell-accent-border) bg-(--shell-accent-soft) shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
                    selected(),
                }}
                onClick={() => {
                  if (selected()) return
                  setMonitorSnapLayout(props.outputName, snapLayout)
                  props.onPersisted()
                }}
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="text-[0.76rem] font-semibold text-(--shell-text)">{shapeLabel(shape)}</span>
                  <span class="text-[0.68rem] text-(--shell-text-dim)">{selected() ? 'Selected' : 'Use'}</span>
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
            )
          }}
        </For>
      </div>
    </div>
  )
}
