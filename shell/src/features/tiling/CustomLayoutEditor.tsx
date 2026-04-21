import { createMemo, For, Show, type Accessor, type Component } from 'solid-js'
import { firstLeafZoneId, type CustomLayout } from './customLayouts'
import { CustomLayoutPreview } from './CustomLayoutPreview'
import { getMonitorLayout } from './tilingConfig'

function collectZoneIds(node: CustomLayout['root']): string[] {
  if (node.kind === 'leaf') return [node.zoneId]
  return [...collectZoneIds(node.first), ...collectZoneIds(node.second)]
}

export const CustomLayoutEditor: Component<{
  outputName: string
  revision: Accessor<number>
  onOpenOverlay: (detail: { outputName: string; layoutId?: string | null }) => void
}> = (props) => {
  const layouts = createMemo(() => {
    props.revision()
    return getMonitorLayout(props.outputName).customLayouts
  })

  return (
    <div class="flex min-w-0 flex-1 flex-col gap-3 text-[0.7rem] tracking-wide text-(--shell-text-muted)">
      <div class="flex items-center justify-between gap-2">
        <span>custom snap layouts</span>
        <button
          type="button"
          data-settings-custom-layout-open-overlay
          data-settings-custom-layout-monitor={props.outputName}
          class="border border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover) cursor-pointer rounded-lg px-2.5 py-1.5 text-[0.74rem] font-medium"
          onClick={() => props.onOpenOverlay({ outputName: props.outputName })}
        >
          {layouts().length > 0 ? 'Edit on screen' : 'Create on screen'}
        </button>
      </div>
      <Show
        when={layouts().length > 0}
        fallback={<div class="hidden" />}
      >
        <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          <For each={layouts()}>
            {(layout) => (
              <button
                type="button"
                data-settings-custom-layout-select={layout.id}
                class="border border-(--shell-border) bg-(--shell-surface) hover:bg-(--shell-surface-elevated) cursor-pointer rounded-xl p-2 text-left"
                onClick={() => props.onOpenOverlay({ outputName: props.outputName, layoutId: layout.id })}
              >
                <div class="mb-2 flex items-center justify-between gap-2">
                  <span class="truncate text-[0.76rem] font-semibold text-(--shell-text)">{layout.name}</span>
                  <span class="text-[0.68rem] text-(--shell-text-dim)">{collectZoneIds(layout.root).length} zones</span>
                </div>
                <CustomLayoutPreview
                  layout={layout}
                  selectedZoneId={firstLeafZoneId(layout.root)}
                  square
                  zoneAttrs={() => ({
                    'data-settings-custom-layout-zone': firstLeafZoneId(layout.root),
                    'data-settings-custom-layout-monitor': props.outputName,
                  })}
                />
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
