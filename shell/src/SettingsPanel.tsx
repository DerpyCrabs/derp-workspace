import { For, Show, createSignal } from 'solid-js'
import type { Accessor, Setter } from 'solid-js'
import type { SetStoreFunction } from 'solid-js/store'
import type { PerMonitorTileStates } from './tileState'
import { SettingsAppearancePage } from './settings/SettingsAppearancePage'
import { SettingsDisplaysPage } from './settings/SettingsDisplaysPage'
import { SettingsKeyboardPage } from './settings/SettingsKeyboardPage'
import { SettingsSoundPage } from './settings/SettingsSoundPage'
import { SettingsTilingPage } from './settings/SettingsTilingPage'
import type { SettingsLayoutScreen } from './settings/settingsTypes'

export type { SettingsLayoutScreen }

type SettingsPageId = 'displays' | 'tiling' | 'keyboard' | 'sound' | 'appearance'

const NAV: { id: SettingsPageId; label: string }[] = [
  { id: 'displays', label: 'Displays' },
  { id: 'tiling', label: 'Tiling' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'sound', label: 'Sound' },
  { id: 'appearance', label: 'Appearance' },
]

export type SettingsPanelProps = {
  screenDraft: { rows: SettingsLayoutScreen[] }
  setScreenDraft: SetStoreFunction<{ rows: SettingsLayoutScreen[] }>
  shellChromePrimaryName: Accessor<string | null>
  autoShellChromeMonitorName: Accessor<string | null>
  canSessionControl: Accessor<boolean>
  uiScalePercent: Accessor<100 | 150 | 200>
  orientationPickerOpen: Accessor<number | null>
  setOrientationPickerOpen: Setter<number | null>
  tilingCfgRev: Accessor<number>
  setTilingCfgRev: Setter<number>
  perMonitorTiles: PerMonitorTileStates
  bumpSnapChrome: () => void
  scheduleExclusionZonesSync: () => void
  applyAutoLayout: (monitorName: string) => void
  setShellPrimary: (name: string) => void
  setUiScale: (pct: 100 | 150 | 200) => void
  applyCompositorLayoutFromDraft: () => void
  monitorRefreshLabel: (milli: number) => string
  keyboardLayoutLabel: Accessor<string | null>
  setDesktopBackgroundJson: (json: string) => void
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [activePage, setActivePage] = createSignal<SettingsPageId>('displays')

  return (
    <div class="flex h-full min-h-0 min-w-0 bg-(--shell-surface-panel) text-left text-(--shell-text) [&_strong]:text-shell-hud-strong">
      <nav
        class="flex w-[13rem] shrink-0 flex-col gap-0.5 border-r border-(--shell-border) bg-(--shell-surface-elevated) py-3 pr-2 pl-2"
        aria-label="Settings sections"
      >
        <p class="mb-2 px-2 text-[0.68rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
          Settings
        </p>
        <For each={NAV}>
          {(item) => (
            <button
              type="button"
              role="tab"
              aria-selected={activePage() === item.id}
              class="w-full cursor-pointer rounded-lg border-0 px-2.5 py-2 text-left text-[0.84rem] font-medium text-(--shell-text-muted) hover:bg-(--shell-surface-hover)"
              classList={{
                'bg-(--shell-accent-soft) font-semibold text-(--shell-accent-soft-text)':
                  activePage() === item.id,
              }}
              onClick={() => setActivePage(item.id)}
            >
              {item.label}
            </button>
          )}
        </For>
      </nav>
      <div
        class="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3"
        role="tabpanel"
      >
        <Show when={activePage() === 'displays'}>
          <SettingsDisplaysPage
            screenDraft={props.screenDraft}
            setScreenDraft={props.setScreenDraft}
            shellChromePrimaryName={props.shellChromePrimaryName}
            autoShellChromeMonitorName={props.autoShellChromeMonitorName}
            canSessionControl={props.canSessionControl}
            uiScalePercent={props.uiScalePercent}
            orientationPickerOpen={props.orientationPickerOpen}
            setOrientationPickerOpen={props.setOrientationPickerOpen}
            setShellPrimary={props.setShellPrimary}
            setUiScale={props.setUiScale}
            applyCompositorLayoutFromDraft={props.applyCompositorLayoutFromDraft}
            monitorRefreshLabel={props.monitorRefreshLabel}
          />
        </Show>
        <Show when={activePage() === 'tiling'}>
          <SettingsTilingPage
            screenDraftRows={props.screenDraft.rows}
            tilingCfgRev={props.tilingCfgRev}
            setTilingCfgRev={props.setTilingCfgRev}
            perMonitorTiles={props.perMonitorTiles}
            bumpSnapChrome={props.bumpSnapChrome}
            scheduleExclusionZonesSync={props.scheduleExclusionZonesSync}
            applyAutoLayout={props.applyAutoLayout}
          />
        </Show>
        <Show when={activePage() === 'keyboard'}>
          <SettingsKeyboardPage keyboardLayoutLabel={props.keyboardLayoutLabel} />
        </Show>
        <Show when={activePage() === 'sound'}>
          <SettingsSoundPage />
        </Show>
        <Show when={activePage() === 'appearance'}>
          <SettingsAppearancePage setDesktopBackgroundJson={props.setDesktopBackgroundJson} />
        </Show>
      </div>
    </div>
  )
}
