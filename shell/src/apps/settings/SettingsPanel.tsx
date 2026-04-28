import { For, Show, createSignal } from 'solid-js'
import type { Accessor, Setter } from 'solid-js'
import type { SetStoreFunction } from 'solid-js/store'
import { SettingsAppearancePage } from './SettingsAppearancePage'
import { SettingsBluetoothPage } from './SettingsBluetoothPage'
import { SettingsDisplaysPage } from './SettingsDisplaysPage'
import { SettingsDefaultApplicationsPage } from './SettingsDefaultApplicationsPage'
import { SettingsKeyboardPage } from './SettingsKeyboardPage'
import { SettingsNotificationsPage } from './SettingsNotificationsPage'
import { SettingsSoundPage } from './SettingsSoundPage'
import { SettingsScratchpadsPage } from './SettingsScratchpadsPage'
import { SettingsTilingPage } from './SettingsTilingPage'
import { SettingsUserPage } from './SettingsUserPage'
import { SettingsWifiPage } from './SettingsWifiPage'
import type { SettingsLayoutScreen } from './settingsTypes'
import { SETTINGS_NAV, type SettingsPageId } from './settingsNavigation'
import type { DefaultApplicationsController } from '@/apps/default-applications/defaultApplications'
import type { DesktopApplicationsController } from '@/features/desktop/desktopApplicationsState'
import type { ShellNotificationsState } from '@/features/notifications/notificationsState'
import type { DerpWindow } from '@/host/appWindowState'

export type { SettingsLayoutScreen }

export type SettingsPanelProps = {
  activePage?: Accessor<SettingsPageId>
  setActivePage?: Setter<SettingsPageId>
  screenDraft: { rows: SettingsLayoutScreen[] }
  setScreenDraft: SetStoreFunction<{ rows: SettingsLayoutScreen[] }>
  currentMonitorName: Accessor<string | null>
  shellChromePrimaryName: Accessor<string | null>
  autoShellChromeMonitorName: Accessor<string | null>
  taskbarAutoHide: Accessor<boolean>
  canSessionControl: Accessor<boolean>
  uiScalePercent: Accessor<100 | 150 | 200>
  tilingCfgRev: Accessor<number>
  setTilingCfgRev: Setter<number>
  bumpSnapChrome: () => void
  scheduleExclusionZonesSync: () => void
  openCustomLayoutOverlay: (detail: { outputName: string; layoutId?: string | null }) => void
  setShellPrimary: (name: string) => void
  setUiScale: (pct: 100 | 150 | 200) => void
  setOutputVrr: (name: string, enabled: boolean) => void
  setTaskbarAutoHide: (enabled: boolean) => void
  setTaskbarSide: (name: string, side: 'bottom' | 'top' | 'left' | 'right') => void
  applyCompositorLayoutFromDraft: () => void
  monitorRefreshLabel: (milli: number) => string
  keyboardLayoutLabel: Accessor<string | null>
  setDesktopBackgroundJson: (json: string) => void
  sessionAutoSaveEnabled: Accessor<boolean>
  setSessionAutoSaveEnabled: (enabled: boolean) => void
  defaultApps: DefaultApplicationsController
  desktopApps: DesktopApplicationsController
  windowsList: Accessor<readonly DerpWindow[]>
  notificationsState: Accessor<ShellNotificationsState | null>
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [localActivePage, setLocalActivePage] = createSignal<SettingsPageId>('displays')
  const activePage = props.activePage ?? localActivePage
  const setActivePage = props.setActivePage ?? setLocalActivePage
  const [orientationPickerOpen, setOrientationPickerOpen] = createSignal<number | null>(null)

  return (
    <div
      class="flex h-full min-h-0 min-w-0 bg-(--shell-surface-panel) text-left text-(--shell-text) [&_strong]:text-shell-hud-strong"
      data-settings-root
    >
      <nav
        class="flex w-52 shrink-0 flex-col gap-0.5 border-r border-(--shell-border) bg-(--shell-surface-elevated) py-3 pr-2 pl-2"
        aria-label="Settings sections"
      >
        <p class="mb-2 px-2 text-[0.68rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
          Settings
        </p>
        <For each={SETTINGS_NAV}>
          {(item) => (
            <button
              type="button"
              role="tab"
              data-settings-tab={item.id}
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
        class="min-h-0 min-w-0 flex-1 px-4 py-3"
        classList={{
          'flex flex-col overflow-hidden': activePage() === 'scratchpads',
          'overflow-y-auto': activePage() !== 'scratchpads',
        }}
        role="tabpanel"
        data-settings-active-page={activePage()}
      >
        <Show when={activePage() === 'user'}>
          <SettingsUserPage />
        </Show>
        <Show when={activePage() === 'displays'}>
          <SettingsDisplaysPage
            screenDraft={props.screenDraft}
            setScreenDraft={props.setScreenDraft}
            shellChromePrimaryName={props.shellChromePrimaryName}
            autoShellChromeMonitorName={props.autoShellChromeMonitorName}
            taskbarAutoHide={props.taskbarAutoHide}
            canSessionControl={props.canSessionControl}
            uiScalePercent={props.uiScalePercent}
            orientationPickerOpen={orientationPickerOpen}
            setOrientationPickerOpen={setOrientationPickerOpen}
            setShellPrimary={props.setShellPrimary}
            setUiScale={props.setUiScale}
            setOutputVrr={props.setOutputVrr}
            setTaskbarAutoHide={props.setTaskbarAutoHide}
            setTaskbarSide={props.setTaskbarSide}
            applyCompositorLayoutFromDraft={props.applyCompositorLayoutFromDraft}
            monitorRefreshLabel={props.monitorRefreshLabel}
          />
        </Show>
        <Show when={activePage() === 'tiling'}>
          <SettingsTilingPage
            screenDraftRows={props.screenDraft.rows}
            currentMonitorName={props.currentMonitorName}
            tilingCfgRev={props.tilingCfgRev}
            setTilingCfgRev={props.setTilingCfgRev}
            bumpSnapChrome={props.bumpSnapChrome}
            scheduleExclusionZonesSync={props.scheduleExclusionZonesSync}
            openCustomLayoutOverlay={props.openCustomLayoutOverlay}
            sessionAutoSaveEnabled={props.sessionAutoSaveEnabled}
            setSessionAutoSaveEnabled={props.setSessionAutoSaveEnabled}
          />
        </Show>
        <Show when={activePage() === 'scratchpads'}>
          <SettingsScratchpadsPage windows={props.windowsList} />
        </Show>
        <Show when={activePage() === 'keyboard'}>
          <SettingsKeyboardPage keyboardLayoutLabel={props.keyboardLayoutLabel} desktopApps={props.desktopApps} />
        </Show>
        <Show when={activePage() === 'notifications'}>
          <SettingsNotificationsPage notificationsState={props.notificationsState} />
        </Show>
        <Show when={activePage() === 'sound'}>
          <SettingsSoundPage />
        </Show>
        <Show when={activePage() === 'wifi'}>
          <SettingsWifiPage />
        </Show>
        <Show when={activePage() === 'bluetooth'}>
          <SettingsBluetoothPage />
        </Show>
        <Show when={activePage() === 'appearance'}>
          <SettingsAppearancePage setDesktopBackgroundJson={props.setDesktopBackgroundJson} />
        </Show>
        <Show when={activePage() === 'default-applications'}>
          <SettingsDefaultApplicationsPage defaultApps={props.defaultApps} desktopApps={props.desktopApps} />
        </Show>
      </div>
    </div>
  )
}
