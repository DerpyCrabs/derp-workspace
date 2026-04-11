import { Show, createSignal, onMount } from 'solid-js'
import { shellHttpBase } from '../shellHttp'
import { loadShellUserSettings, saveShellUserSettings, type ShellUserSettings } from './userSettings'

export function SettingsUserPage() {
  const [settings, setSettings] = createSignal<ShellUserSettings | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [saveBusy, setSaveBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | null>(null)
  const [saveErr, setSaveErr] = createSignal<string | null>(null)
  const [saveNote, setSaveNote] = createSignal<string | null>(null)

  async function load() {
    const base = shellHttpBase()
    if (!base) {
      setErr('Needs cef_host control server to load user settings.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      setSettings(await loadShellUserSettings(base))
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
      setSettings(null)
    } finally {
      setBusy(false)
    }
  }

  async function save(enabled: boolean) {
    const base = shellHttpBase()
    if (!base) {
      setSaveErr('Needs cef_host control server to save user settings.')
      return
    }
    const current = settings()
    if (current && current.enabled === enabled) {
      setSaveErr(null)
      setSaveNote(
        enabled
          ? `Autologin is already enabled for ${current.configured_user || current.current_user || 'the current user'}.`
          : 'Autologin is already disabled.',
      )
      return
    }
    setSaveBusy(true)
    setSaveErr(null)
    setSaveNote(null)
    try {
      await saveShellUserSettings(enabled, base)
      await load()
      const next = settings()
      setSaveNote(
        enabled
          ? `Autologin enabled for ${next?.configured_user || next?.current_user || 'the current user'}.`
          : 'Autologin disabled.',
      )
    } catch (error) {
      setSaveErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSaveBusy(false)
    }
  }

  onMount(() => {
    void load()
  })

  return (
    <div class="space-y-4" data-settings-user-page>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-base font-semibold tracking-wide text-(--shell-text)">User</h2>
        <button
          type="button"
          class="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) cursor-pointer rounded-lg px-2.5 py-1.5 text-[0.78rem] font-medium disabled:cursor-default"
          disabled={busy() || !shellHttpBase()}
          onClick={() => void load()}
        >
          {busy() ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      <div class="border border-(--shell-border) bg-(--shell-surface) text-(--shell-text) rounded-lg px-3 py-3">
        <p class="mb-2 text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
          GDM autologin
        </p>
        <Show when={settings()} fallback={<p class="text-[0.82rem] text-(--shell-text-muted)">Waiting for user settings…</p>}>
          {(current) => (
            <div class="space-y-3">
              <div class="grid gap-2 text-[0.82rem] text-(--shell-text-muted) md:grid-cols-2">
                <div>
                  <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
                    Status
                  </p>
                  <p class="mt-1 font-medium text-(--shell-text)">
                    {current().enabled ? 'Enabled' : 'Disabled'}
                  </p>
                </div>
                <div>
                  <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
                    Current user
                  </p>
                  <p class="mt-1 font-medium text-(--shell-text)">{current().current_user || 'unknown'}</p>
                </div>
                <div class="md:col-span-2">
                  <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
                    Current GDM target
                  </p>
                  <p class="mt-1 font-medium text-(--shell-text)">
                    {current().enabled ? current().configured_user || current().current_user : 'Disabled'}
                  </p>
                </div>
              </div>
              <p class="text-[0.78rem] leading-relaxed text-(--shell-text-dim)">
                This updates <span class="text-(--shell-text-muted)">{current().config_path}</span>. The{' '}
                current session user can be made the automatic login target for GDM.
              </p>
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-settings-user-autologin-enable
                  class="border border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover) cursor-pointer rounded-lg px-2.5 py-1.5 text-[0.78rem] font-medium disabled:cursor-default"
                  disabled={saveBusy() || !shellHttpBase() || current().enabled}
                  onClick={() => void save(true)}
                >
                  {saveBusy() ? 'Saving…' : current().enabled ? 'Already enabled' : `Enable for ${current().current_user || 'current user'}`}
                </button>
                <button
                  type="button"
                  data-settings-user-autologin-disable
                  class="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) cursor-pointer rounded-lg px-2.5 py-1.5 text-[0.78rem] font-medium disabled:cursor-default"
                  disabled={saveBusy() || !shellHttpBase() || !current().enabled}
                  onClick={() => void save(false)}
                >
                  {saveBusy() ? 'Saving…' : current().enabled ? 'Disable autologin' : 'Already disabled'}
                </button>
              </div>
            </div>
          )}
        </Show>
        <Show when={err()}>
          <p class="mt-3 text-[0.8rem] text-(--shell-warning-text)">{err()}</p>
        </Show>
        <Show when={saveErr()}>
          <p class="mt-3 text-[0.8rem] text-(--shell-warning-text)">{saveErr()}</p>
        </Show>
        <Show when={saveNote()}>
          <p class="mt-3 text-[0.8rem] text-(--shell-text-muted)">{saveNote()}</p>
        </Show>
      </div>
    </div>
  )
}
