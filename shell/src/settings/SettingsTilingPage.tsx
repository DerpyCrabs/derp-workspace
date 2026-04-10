import { For, Show } from 'solid-js'
import type { Accessor, Setter } from 'solid-js'
import { LayoutTypePicker } from '../LayoutTypePicker'
import { getMonitorLayout } from '../tilingConfig'
import type { PerMonitorTileStates } from '../tileState'
import type { SettingsLayoutScreen } from './settingsTypes'

export type SettingsTilingPageProps = {
  screenDraftRows: SettingsLayoutScreen[]
  tilingCfgRev: Accessor<number>
  setTilingCfgRev: Setter<number>
  perMonitorTiles: PerMonitorTileStates
  bumpSnapChrome: () => void
  scheduleExclusionZonesSync: () => void
  applyAutoLayout: (monitorName: string) => void
}

export function SettingsTilingPage(props: SettingsTilingPageProps) {
  return (
    <div class="space-y-4">
      <h2 class="text-base font-semibold tracking-wide text-(--shell-text)">Tiling and layout</h2>
      <div class="border border-(--shell-border) bg-(--shell-surface) text-(--shell-text) rounded-lg px-3 py-3">
        <Show
          when={props.screenDraftRows.length > 0}
          fallback={
            <p class="text-[0.78rem] opacity-[0.88]">Outputs from the compositor unlock this section.</p>
          }
        >
          <p class="mb-3 text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
            Per-monitor layout
          </p>
          <For each={props.screenDraftRows}>
            {(row) => (
              <div class="mb-4 flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-(--shell-border) pb-4 last:mb-0 last:border-0 last:pb-0">
                <span class="min-w-24 text-[0.82rem] font-mono font-semibold text-(--shell-text-muted)">
                  {row.name}
                </span>
                <LayoutTypePicker
                  outputName={row.name}
                  revision={props.tilingCfgRev}
                  onPersisted={() => {
                    props.setTilingCfgRev((n) => n + 1)
                    const name = row.name
                    queueMicrotask(() => {
                      if (getMonitorLayout(name).layout.type === 'manual-snap') {
                        props.perMonitorTiles.stateFor(name).clearAllTiled()
                        props.bumpSnapChrome()
                        props.scheduleExclusionZonesSync()
                      } else {
                        props.applyAutoLayout(name)
                      }
                    })
                  }}
                />
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}
