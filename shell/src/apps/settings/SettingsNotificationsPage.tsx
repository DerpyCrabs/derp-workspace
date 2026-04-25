import { For, Show, createSignal } from 'solid-js'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import {
  setNotificationsEnabledViaShell,
  type ShellNotificationsState,
} from '@/features/notifications/notificationsState'

type SettingsNotificationsPageProps = {
  notificationsState: () => ShellNotificationsState | null
}

function formatTime(timestampMs: number | null) {
  if (!timestampMs) return 'Active'
  return new Date(timestampMs).toLocaleString()
}

export function SettingsNotificationsPage(props: SettingsNotificationsPageProps) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [note, setNote] = createSignal<string | null>(null)

  async function save(enabled: boolean) {
    const base = shellHttpBase()
    if (!base) {
      setError('Needs cef_host control server to update notification settings.')
      return
    }
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await setNotificationsEnabledViaShell(enabled, base)
      setNote(enabled ? 'Notification banners enabled.' : 'Notification banners disabled.')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="space-y-4" data-settings-notifications-page>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-base font-semibold tracking-wide text-(--shell-text)">Notifications</h2>
          <p class="mt-1 text-[0.78rem] text-(--shell-text-dim)">
            Native apps talk over <span class="text-(--shell-text-muted)">org.freedesktop.Notifications</span>. Shell apps can use <span class="text-(--shell-text-muted)">window.__DERP_NOTIFICATIONS__</span>.
          </p>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            data-settings-notifications-enable
            class="cursor-pointer rounded-lg border border-(--shell-accent-border) bg-(--shell-accent) px-2.5 py-1.5 text-[0.78rem] font-medium text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover) disabled:cursor-default"
            disabled={busy() || !shellHttpBase() || props.notificationsState()?.enabled === true}
            onClick={() => void save(true)}
          >
            {busy() ? 'Saving…' : props.notificationsState()?.enabled === true ? 'Enabled' : 'Enable banners'}
          </button>
          <button
            type="button"
            data-settings-notifications-disable
            class="cursor-pointer rounded-lg border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2.5 py-1.5 text-[0.78rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
            disabled={busy() || !shellHttpBase() || props.notificationsState()?.enabled === false}
            onClick={() => void save(false)}
          >
            {busy() ? 'Saving…' : props.notificationsState()?.enabled === false ? 'Disabled' : 'Disable banners'}
          </button>
        </div>
      </div>

      <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface) px-3 py-3 text-(--shell-text)">
        <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">Status</p>
        <p class="mt-2 text-[0.86rem] font-medium text-(--shell-text)">
          {props.notificationsState()?.enabled === false ? 'Banners hidden, history still recorded.' : 'Banners and history are active.'}
        </p>
        <Show when={error()}>
          <p class="mt-3 text-[0.8rem] text-(--shell-warning-text)">{error()}</p>
        </Show>
        <Show when={note()}>
          <p class="mt-3 text-[0.8rem] text-(--shell-text-muted)">{note()}</p>
        </Show>
      </div>

      <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface) px-3 py-3 text-(--shell-text)">
        <div class="flex items-center justify-between gap-2">
          <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">Active</p>
          <p class="text-[0.78rem] text-(--shell-text-dim)">{props.notificationsState()?.active.length ?? 0}</p>
        </div>
        <Show
          when={(props.notificationsState()?.active.length ?? 0) > 0}
          fallback={<p class="mt-3 text-[0.8rem] text-(--shell-text-dim)">No active notifications.</p>}
        >
          <div class="mt-3 space-y-2">
            <For each={props.notificationsState()?.active ?? []}>
              {(entry) => (
                <section
                  data-settings-notification-active={entry.id}
                  class="rounded-xl border border-(--shell-border) bg-(--shell-surface-elevated) px-3 py-3"
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="truncate text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-(--shell-text-dim)">
                        {entry.app_name || (entry.source === 'native' ? 'Native app' : 'Shell app')}
                      </p>
                      <p class="mt-1 text-[0.9rem] font-semibold text-(--shell-text)">{entry.summary}</p>
                      <Show when={entry.body}>
                        <p class="mt-1 text-[0.8rem] leading-relaxed text-(--shell-text-muted)">{entry.body}</p>
                      </Show>
                    </div>
                    <p class="shrink-0 text-[0.72rem] text-(--shell-text-dim)">{formatTime(entry.updated_at_ms)}</p>
                  </div>
                </section>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface) px-3 py-3 text-(--shell-text)">
        <div class="flex items-center justify-between gap-2">
          <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">History</p>
          <p class="text-[0.78rem] text-(--shell-text-dim)">{props.notificationsState()?.history.length ?? 0}</p>
        </div>
        <Show
          when={(props.notificationsState()?.history.length ?? 0) > 0}
          fallback={<p class="mt-3 text-[0.8rem] text-(--shell-text-dim)">No notification history yet.</p>}
        >
          <div class="mt-3 space-y-2" data-settings-notifications-history>
            <For each={props.notificationsState()?.history ?? []}>
              {(entry) => (
                <section
                  data-settings-notification-history={entry.id}
                  class="rounded-xl border border-(--shell-border) bg-(--shell-surface-elevated) px-3 py-3"
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="truncate text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-(--shell-text-dim)">
                        {entry.app_name || (entry.source === 'native' ? 'Native app' : 'Shell app')}
                      </p>
                      <p class="mt-1 text-[0.9rem] font-semibold text-(--shell-text)">{entry.summary}</p>
                      <Show when={entry.body}>
                        <p class="mt-1 text-[0.8rem] leading-relaxed text-(--shell-text-muted)">{entry.body}</p>
                      </Show>
                      <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.74rem] text-(--shell-text-dim)">
                        <span>Source: {entry.source}</span>
                        <span>Closed: {entry.close_reason ?? 'Active'}</span>
                        <Show when={entry.action_key}>
                          <span>Action: {entry.action_key}</span>
                        </Show>
                      </div>
                    </div>
                    <p class="shrink-0 text-[0.72rem] text-(--shell-text-dim)">{formatTime(entry.closed_at_ms ?? entry.updated_at_ms)}</p>
                  </div>
                </section>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
