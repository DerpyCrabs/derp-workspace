import { For, Show } from 'solid-js'
import type { Accessor, Setter } from 'solid-js'
import { EdgeLayoutPicker } from '@/features/tiling/EdgeLayoutPicker'
import { LayoutTypePicker } from '@/features/tiling/LayoutTypePicker'
import { getMonitorLayout } from '@/features/tiling/tilingConfig'
import type { SettingsLayoutScreen } from './settingsTypes'

export type SettingsTilingPageProps = {
  screenDraftRows: SettingsLayoutScreen[]
  tilingCfgRev: Accessor<number>
  setTilingCfgRev: Setter<number>
  sessionAutoSaveEnabled: Accessor<boolean>
  setSessionAutoSaveEnabled: (enabled: boolean) => void
  clearMonitorTiles: (monitorName: string) => void
  bumpSnapChrome: () => void
  scheduleExclusionZonesSync: () => void
  applyAutoLayout: (monitorName: string) => void
}

export function SettingsTilingPage(props: SettingsTilingPageProps) {
  return (
    <div class="space-y-4" data-settings-tiling-page>
      <h2 class="text-base font-semibold tracking-wide text-(--shell-text)">Tiling and layout</h2>
      <div class="border border-(--shell-border) bg-(--shell-surface) text-(--shell-text) rounded-lg px-3 py-3">
        <Show
          when={props.screenDraftRows.length > 0}
          fallback={
            <p class="text-[0.78rem] text-(--shell-text-muted)">Outputs from the compositor unlock this section.</p>
          }
        >
          <p class="mb-3 text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
            Per-monitor layout
          </p>
          <For each={props.screenDraftRows}>
            {(row) => (
              <div class="mb-4 flex flex-col gap-3 border-b border-(--shell-border) pb-4 last:mb-0 last:border-0 last:pb-0">
                <span class="min-w-24 text-[0.82rem] font-mono font-semibold text-(--shell-text-muted)">
                  {row.name}
                </span>
                <div class="flex flex-wrap items-start gap-x-4 gap-y-3">
                  <LayoutTypePicker
                    outputName={row.name}
                    revision={props.tilingCfgRev}
                    onPersisted={() => {
                      props.setTilingCfgRev((n) => n + 1)
                      const name = row.name
                      queueMicrotask(() => {
                        if (getMonitorLayout(name).layout.type === 'manual-snap') {
                          props.clearMonitorTiles(name)
                          props.bumpSnapChrome()
                          props.scheduleExclusionZonesSync()
                        } else {
                          props.applyAutoLayout(name)
                        }
                      })
                    }}
                  />
                </div>
                <Show when={(() => {
                  props.tilingCfgRev()
                  return getMonitorLayout(row.name).layout.type === 'manual-snap'
                })()}>
                  <EdgeLayoutPicker
                    outputName={row.name}
                    revision={props.tilingCfgRev}
                    onPersisted={() => {
                      props.setTilingCfgRev((n) => n + 1)
                    }}
                  />
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
      <div class="border border-(--shell-border) bg-(--shell-surface) text-(--shell-text) rounded-lg px-3 py-3">
        <p class="mb-2 text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">Session save</p>
        <div class="space-y-3">
          <div class="grid gap-2 text-[0.82rem] text-(--shell-text-muted) md:grid-cols-2">
            <div>
              <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">Automatic save</p>
              <p class="mt-1 font-medium text-(--shell-text)">
                {props.sessionAutoSaveEnabled() ? 'Enabled' : 'Disabled'}
              </p>
            </div>
            <div>
              <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">Manual control</p>
              <p class="mt-1 font-medium text-(--shell-text)">Power menu save and restore</p>
            </div>
          </div>
          <p class="text-[0.78rem] leading-relaxed text-(--shell-text-dim)">
            Automatic save keeps the restart snapshot current in the background. Disable it to save only when you choose
            <span class="text-(--shell-text-muted)"> Save workspace</span> from the power menu.
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              data-settings-session-autosave-enable
              class="border border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover) cursor-pointer rounded-lg px-2.5 py-1.5 text-[0.78rem] font-medium disabled:cursor-default"
              disabled={props.sessionAutoSaveEnabled()}
              onClick={() => props.setSessionAutoSaveEnabled(true)}
            >
              {props.sessionAutoSaveEnabled() ? 'Automatic save enabled' : 'Enable automatic save'}
            </button>
            <button
              type="button"
              data-settings-session-autosave-disable
              class="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) cursor-pointer rounded-lg px-2.5 py-1.5 text-[0.78rem] font-medium disabled:cursor-default"
              disabled={!props.sessionAutoSaveEnabled()}
              onClick={() => props.setSessionAutoSaveEnabled(false)}
            >
              {props.sessionAutoSaveEnabled() ? 'Disable automatic save' : 'Automatic save disabled'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
