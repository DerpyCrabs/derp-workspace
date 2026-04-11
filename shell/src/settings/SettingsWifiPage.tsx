import { For, Show, createMemo, createSignal, onMount } from 'solid-js'
import { shellHttpBase } from '../shellHttp'
import {
  connectShellWifi,
  disconnectShellWifi,
  loadShellWifiState,
  scanShellWifi,
  setShellWifiRadio,
  type ShellWifiAccessPoint,
  type ShellWifiState,
} from './wifiState'

export function SettingsWifiPage() {
  const [state, setState] = createSignal<ShellWifiState | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | null>(null)
  const [actionErr, setActionErr] = createSignal<string | null>(null)
  const [busyKey, setBusyKey] = createSignal<string | null>(null)
  const [expandedSsid, setExpandedSsid] = createSignal<string | null>(null)
  const [passwords, setPasswords] = createSignal<Record<string, string>>({})
  const [passwordVisible, setPasswordVisible] = createSignal<Record<string, boolean>>({})

  const activeDevice = createMemo(() => state()?.devices[0] ?? null)
  const activeAccessPoint = createMemo(
    () => state()?.access_points.find((row) => row.in_use) ?? null,
  )

  function setPassword(ssid: string, value: string) {
    setPasswords((prev) => ({ ...prev, [ssid]: value }))
  }

  function togglePasswordVisible(ssid: string) {
    setPasswordVisible((prev) => ({ ...prev, [ssid]: !prev[ssid] }))
  }

  function isBusy(nextKey: string) {
    return busyKey() === nextKey
  }

  async function load() {
    const base = shellHttpBase()
    if (!base) {
      setErr('Needs cef_host control server to read NetworkManager Wi-Fi state.')
      setState(null)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      setState(await loadShellWifiState(base))
    } catch (error) {
      setState(null)
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function runAction(key: string, action: () => Promise<void>) {
    if (!shellHttpBase()) {
      setActionErr('Needs cef_host control server to update Wi-Fi state.')
      return
    }
    setBusyKey(key)
    setActionErr(null)
    try {
      await action()
      await load()
    } catch (error) {
      setActionErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyKey(null)
    }
  }

  function toggleRadio(enabled: boolean) {
    if (state()?.wifi_enabled === enabled) return
    void runAction(enabled ? 'radio:on' : 'radio:off', () =>
      setShellWifiRadio(enabled, shellHttpBase()),
    )
  }

  function rescan() {
    void runAction('scan', () => scanShellWifi(shellHttpBase()))
  }

  function disconnectCurrent() {
    void runAction('disconnect', () =>
      disconnectShellWifi(activeDevice()?.device, shellHttpBase()),
    )
  }

  function connect(accessPoint: ShellWifiAccessPoint) {
    const password = (passwords()[accessPoint.ssid] ?? '').trim()
    if (accessPoint.requires_password && !accessPoint.is_saved && !password) {
      setExpandedSsid(accessPoint.ssid)
      setActionErr(`Enter a password for ${accessPoint.ssid}.`)
      return
    }
    void runAction(`connect:${accessPoint.ssid}`, async () => {
      await connectShellWifi(accessPoint.ssid, password || undefined, shellHttpBase())
      setExpandedSsid(null)
    })
  }

  onMount(() => {
    void load()
  })

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-base font-semibold tracking-wide text-(--shell-text)">Wi-Fi</h2>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="cursor-pointer rounded-lg border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2.5 py-1.5 text-[0.78rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
            disabled={isBusy('scan') || !shellHttpBase() || !state()?.wifi_enabled}
            onClick={() => rescan()}
          >
            {isBusy('scan') ? 'Scanning…' : 'Scan'}
          </button>
          <button
            type="button"
            class="cursor-pointer rounded-lg border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2.5 py-1.5 text-[0.78rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
            disabled={busy() || !shellHttpBase()}
            onClick={() => void load()}
          >
            {busy() ? 'Reading…' : 'Refresh'}
          </button>
        </div>
      </div>
      <p class="text-[0.78rem] leading-relaxed text-(--shell-text-dim)">
        Uses <span class="text-(--shell-text-muted)">NetworkManager</span> via{' '}
        <span class="text-(--shell-text-muted)">nmcli</span> on the compositor control server.
      </p>
      <Show when={err()}>
        <p class="text-(--shell-warning-text) text-[0.8rem]">{err()}</p>
      </Show>
      <Show when={actionErr()}>
        <p class="text-(--shell-warning-text) text-[0.8rem]">{actionErr()}</p>
      </Show>
      <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface) px-3 py-3 text-(--shell-text)">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
              Radio
            </p>
            <p class="mt-1 text-[0.78rem] text-(--shell-text-dim)">
              {state()?.wifi_enabled ? 'Wi-Fi is enabled.' : 'Wi-Fi is disabled.'}
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="cursor-pointer rounded-md px-3 py-1.5 text-[0.8rem] font-medium"
              classList={{
                'border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover)':
                  state()?.wifi_enabled === true,
                'border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover)':
                  state()?.wifi_enabled !== true,
              }}
              disabled={isBusy('radio:on') || !shellHttpBase()}
              onClick={() => toggleRadio(true)}
            >
              {isBusy('radio:on') ? 'Turning on…' : 'On'}
            </button>
            <button
              type="button"
              class="cursor-pointer rounded-md px-3 py-1.5 text-[0.8rem] font-medium"
              classList={{
                'border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover)':
                  state()?.wifi_enabled === false,
                'border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover)':
                  state()?.wifi_enabled !== false,
              }}
              disabled={isBusy('radio:off') || !shellHttpBase()}
              onClick={() => toggleRadio(false)}
            >
              {isBusy('radio:off') ? 'Turning off…' : 'Off'}
            </button>
          </div>
        </div>
        <div class="rounded-md border border-(--shell-border) bg-(--shell-surface-elevated) p-3">
          <p class="mb-2 text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
            Active connection
          </p>
          <Show
            when={activeAccessPoint()}
            fallback={<p class="text-[0.78rem] text-(--shell-text-dim)">Not connected to a Wi-Fi network.</p>}
          >
            {(accessPoint) => (
              <div class="space-y-3">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="text-[0.92rem] font-semibold text-(--shell-text)">
                      {accessPoint().ssid}
                    </div>
                    <div class="mt-1 flex flex-wrap gap-2 text-[0.74rem] text-(--shell-text-dim)">
                      <span>{accessPoint().signal_percent}% signal</span>
                      <span>{accessPoint().bars || 'Signal unavailable'}</span>
                      <span>{accessPoint().security || 'Open network'}</span>
                      <Show when={activeDevice()?.device}>
                        <span>{activeDevice()!.device}</span>
                      </Show>
                    </div>
                  </div>
                  <button
                    type="button"
                    class="cursor-pointer rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2.5 py-1.5 text-[0.74rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
                    disabled={isBusy('disconnect') || !shellHttpBase()}
                    onClick={() => disconnectCurrent()}
                  >
                    {isBusy('disconnect') ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                </div>
              </div>
            )}
          </Show>
        </div>
      </div>
      <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface) px-3 py-3 text-(--shell-text)">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
              Networks
            </p>
            <p class="mt-1 text-[0.78rem] leading-relaxed text-(--shell-text-dim)">
              Strongest access point per SSID. Saved networks can reconnect without re-entering a
              password.
            </p>
          </div>
          <span class="text-[0.74rem] text-(--shell-text-dim)">
            {state()?.access_points.length ?? 0} visible
          </span>
        </div>
        <Show
          when={state()?.wifi_enabled}
          fallback={<p class="text-[0.78rem] text-(--shell-text-dim)">Enable Wi-Fi to scan nearby networks.</p>}
        >
          <Show
            when={(state()?.access_points.length ?? 0) > 0}
            fallback={<p class="text-[0.78rem] text-(--shell-text-dim)">No nearby Wi-Fi networks found.</p>}
          >
            <div class="space-y-3">
              <For each={state()?.access_points ?? []}>
                {(accessPoint) => {
                  const busyConnectKey = () => `connect:${accessPoint.ssid}`
                  const expanded = () => expandedSsid() === accessPoint.ssid
                  const password = () => passwords()[accessPoint.ssid] ?? ''
                  return (
                    <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface-elevated) p-3">
                      <div class="flex flex-wrap items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="flex flex-wrap items-center gap-2">
                            <div class="text-[0.86rem] font-semibold text-(--shell-text)">
                              {accessPoint.ssid}
                            </div>
                            <Show when={accessPoint.in_use}>
                              <span class="rounded-md border border-(--shell-accent-border) bg-(--shell-accent-soft) px-2 py-1 text-[0.66rem] font-semibold uppercase tracking-wide text-(--shell-accent-soft-text)">
                                Connected
                              </span>
                            </Show>
                            <Show when={accessPoint.is_saved && !accessPoint.in_use}>
                              <span class="rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2 py-1 text-[0.66rem] font-semibold uppercase tracking-wide text-(--shell-control-muted-text)">
                                Saved
                              </span>
                            </Show>
                          </div>
                          <div class="mt-1 flex flex-wrap gap-2 text-[0.74rem] text-(--shell-text-dim)">
                            <span>{accessPoint.signal_percent}% signal</span>
                            <span>{accessPoint.bars || 'Signal unavailable'}</span>
                            <span>{accessPoint.security || 'Open network'}</span>
                          </div>
                        </div>
                        <div class="flex flex-wrap gap-2">
                          <Show when={!accessPoint.in_use}>
                            <button
                              type="button"
                              class="cursor-pointer rounded-md border border-(--shell-accent-border) bg-(--shell-accent) px-2.5 py-1.5 text-[0.74rem] font-medium text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover) disabled:cursor-default"
                              disabled={isBusy(busyConnectKey()) || !shellHttpBase()}
                              onClick={() => {
                                if (
                                  accessPoint.requires_password &&
                                  !accessPoint.is_saved &&
                                  !expanded()
                                ) {
                                  setExpandedSsid(accessPoint.ssid)
                                  return
                                }
                                connect(accessPoint)
                              }}
                            >
                              {isBusy(busyConnectKey())
                                ? 'Connecting…'
                                : accessPoint.requires_password &&
                                    !accessPoint.is_saved &&
                                    !expanded()
                                  ? 'Enter password'
                                  : 'Connect'}
                            </button>
                          </Show>
                        </div>
                      </div>
                      <Show when={!accessPoint.in_use && accessPoint.requires_password && expanded()}>
                        <div class="mt-3 flex flex-wrap items-center gap-2">
                          <input
                            type={passwordVisible()[accessPoint.ssid] ? 'text' : 'password'}
                            placeholder={accessPoint.is_saved ? 'Saved password or new password' : 'Wi-Fi password'}
                            class="w-full min-w-0 flex-1 rounded-md border border-(--shell-input-border) bg-(--shell-input-bg) px-2.5 py-1.5 text-[0.82rem] text-(--shell-text) placeholder:text-(--shell-text-dim) focus:border-(--shell-input-focus) focus:outline-none focus-visible:border-(--shell-input-focus) focus-visible:outline-none"
                            value={password()}
                            onInput={(event) => setPassword(accessPoint.ssid, event.currentTarget.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                connect(accessPoint)
                              }
                            }}
                          />
                          <button
                            type="button"
                            class="cursor-pointer rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2.5 py-1.5 text-[0.74rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover)"
                            onClick={() => togglePasswordVisible(accessPoint.ssid)}
                          >
                            {passwordVisible()[accessPoint.ssid] ? 'Hide' : 'Show'}
                          </button>
                          <button
                            type="button"
                            class="cursor-pointer rounded-md border border-(--shell-accent-border) bg-(--shell-accent) px-2.5 py-1.5 text-[0.74rem] font-medium text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover) disabled:cursor-default"
                            disabled={isBusy(busyConnectKey()) || !shellHttpBase()}
                            onClick={() => connect(accessPoint)}
                          >
                            {isBusy(busyConnectKey()) ? 'Connecting…' : 'Connect'}
                          </button>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
