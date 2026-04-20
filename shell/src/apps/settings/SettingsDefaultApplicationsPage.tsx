import { For, Show, onMount } from 'solid-js'
import {
  FILE_OPEN_CATEGORIES,
  openWithOptionsForCategory,
  optionById,
  type DefaultApplicationsController,
} from '@/apps/default-applications/defaultApplications'
import type { DesktopApplicationsController } from '@/features/desktop/desktopApplicationsState'

type SettingsDefaultApplicationsPageProps = {
  defaultApps: DefaultApplicationsController
  desktopApps: DesktopApplicationsController
}

export function SettingsDefaultApplicationsPage(props: SettingsDefaultApplicationsPageProps) {
  onMount(() => {
    void props.defaultApps.refresh()
    void props.desktopApps.refresh()
  })

  return (
    <section class="space-y-4" data-settings-default-applications>
      <div>
        <h2 class="text-base font-semibold text-(--shell-text)">Default applications</h2>
        <p class="mt-1 max-w-2xl text-sm text-(--shell-text-dim)">
          Choose what opens when files are clicked in Files.
        </p>
      </div>
      <Show when={props.defaultApps.err() || props.desktopApps.err()}>
        <div class="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
          {props.defaultApps.err() ?? props.desktopApps.err()}
        </div>
      </Show>
      <div class="space-y-2">
        <For each={FILE_OPEN_CATEGORIES}>
          {(category) => {
            const options = () => openWithOptionsForCategory(category.id, props.desktopApps.items())
            const current = () => optionById(props.defaultApps.settings()[category.id], category.id, props.desktopApps.items())
            return (
              <div class="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] items-center gap-3 rounded border border-(--shell-border) bg-(--shell-surface-elevated) px-3 py-3">
                <div class="min-w-0">
                  <div class="truncate text-sm font-medium text-(--shell-text)">{category.label}</div>
                  <div class="truncate text-xs text-(--shell-text-dim)">{current().label}</div>
                </div>
                <select
                  class="min-w-0 rounded border border-(--shell-border) bg-(--shell-surface-inset) px-2 py-1.5 text-sm text-(--shell-text)"
                  data-default-app-select={category.id}
                  value={props.defaultApps.settings()[category.id]}
                  onChange={(event) => {
                    void props.defaultApps.setDefault(category.id, event.currentTarget.value)
                  }}
                >
                  <For each={options()}>
                    {(option) => (
                      <option value={option.id}>
                        {option.label}
                        {option.kind === 'shell' ? ' (Shell)' : option.kind === 'xdg' ? '' : ' (Desktop app)'}
                      </option>
                    )}
                  </For>
                </select>
              </div>
            )
          }}
        </For>
      </div>
    </section>
  )
}
