import { For, Show, createMemo, createSignal, onMount } from 'solid-js'
import { shellHttpBase } from '../shellHttp'
import {
  connectShellBluetoothDevice,
  disconnectShellBluetoothDevice,
  forgetShellBluetoothDevice,
  loadShellBluetoothState,
  pairAndConnectShellBluetoothDevice,
  scanShellBluetooth,
  setShellBluetoothDiscoverable,
  setShellBluetoothPairable,
  setShellBluetoothRadio,
  setShellBluetoothTrust,
  type ShellBluetoothDevice,
  type ShellBluetoothState,
} from './bluetoothState'

function statusBadge(label: string, tone: 'accent' | 'muted') {
  return (
    <span
      class="rounded-md px-2 py-1 text-[0.66rem] font-semibold uppercase tracking-wide"
      classList={{
        'border border-(--shell-accent-border) bg-(--shell-accent-soft) text-(--shell-accent-soft-text)':
          tone === 'accent',
        'border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text)':
          tone === 'muted',
      }}
    >
      {label}
    </span>
  )
}

export function SettingsBluetoothPage() {
  const [state, setState] = createSignal<ShellBluetoothState | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | null>(null)
  const [actionErr, setActionErr] = createSignal<string | null>(null)
  const [busyKey, setBusyKey] = createSignal<string | null>(null)

  const controller = createMemo(() => state()?.controller ?? null)

  function isBusy(nextKey: string) {
    return busyKey() === nextKey
  }

  async function load() {
    const base = shellHttpBase()
    if (!base) {
      setErr('Needs cef_host control server to read BlueZ Bluetooth state.')
      setState(null)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      setState(await loadShellBluetoothState(base))
    } catch (error) {
      setState(null)
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function runAction(key: string, action: () => Promise<void>) {
    if (!shellHttpBase()) {
      setActionErr('Needs cef_host control server to update Bluetooth state.')
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

  function rescan() {
    void runAction('scan', () => scanShellBluetooth(shellHttpBase()))
  }

  function toggleRadio(enabled: boolean) {
    if (controller()?.powered === enabled) return
    void runAction(enabled ? 'radio:on' : 'radio:off', () =>
      setShellBluetoothRadio(enabled, shellHttpBase()),
    )
  }

  function togglePairable(enabled: boolean) {
    if (controller()?.pairable === enabled) return
    void runAction(enabled ? 'pairable:on' : 'pairable:off', () =>
      setShellBluetoothPairable(enabled, shellHttpBase()),
    )
  }

  function toggleDiscoverable(enabled: boolean) {
    if (controller()?.discoverable === enabled) return
    void runAction(enabled ? 'discoverable:on' : 'discoverable:off', () =>
      setShellBluetoothDiscoverable(enabled, shellHttpBase()),
    )
  }

  function pairAndConnect(device: ShellBluetoothDevice) {
    void runAction(`pair:${device.address}`, () =>
      pairAndConnectShellBluetoothDevice(device.address, shellHttpBase()),
    )
  }

  function connect(device: ShellBluetoothDevice) {
    void runAction(`connect:${device.address}`, () =>
      connectShellBluetoothDevice(device.address, shellHttpBase()),
    )
  }

  function disconnect(device: ShellBluetoothDevice) {
    void runAction(`disconnect:${device.address}`, () =>
      disconnectShellBluetoothDevice(device.address, shellHttpBase()),
    )
  }

  function setTrusted(device: ShellBluetoothDevice, trusted: boolean) {
    void runAction(`${trusted ? 'trust' : 'untrust'}:${device.address}`, () =>
      setShellBluetoothTrust(device.address, trusted, shellHttpBase()),
    )
  }

  function forget(device: ShellBluetoothDevice) {
    void runAction(`forget:${device.address}`, () =>
      forgetShellBluetoothDevice(device.address, shellHttpBase()),
    )
  }

  onMount(() => {
    void load()
  })

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-base font-semibold tracking-wide text-(--shell-text)">Bluetooth</h2>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="cursor-pointer rounded-lg border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2.5 py-1.5 text-[0.78rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
            disabled={isBusy('scan') || !shellHttpBase() || !controller()?.powered}
            onClick={() => rescan()}
          >
            {isBusy('scan') ? 'Scanning...' : 'Scan'}
          </button>
          <button
            type="button"
            class="cursor-pointer rounded-lg border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2.5 py-1.5 text-[0.78rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
            disabled={busy() || !shellHttpBase()}
            onClick={() => void load()}
          >
            {busy() ? 'Reading...' : 'Refresh'}
          </button>
        </div>
      </div>
      <p class="text-[0.78rem] leading-relaxed text-(--shell-text-dim)">
        Uses <span class="text-(--shell-text-muted)">BlueZ</span> via{' '}
        <span class="text-(--shell-text-muted)">bluetoothctl</span> on the compositor control
        server.
      </p>
      <Show when={err()}>
        <p class="text-(--shell-warning-text) text-[0.8rem]">{err()}</p>
      </Show>
      <Show when={actionErr()}>
        <p class="text-(--shell-warning-text) text-[0.8rem]">{actionErr()}</p>
      </Show>
      <Show when={state()?.soft_blocked || state()?.hard_blocked}>
        <p class="text-(--shell-warning-text) text-[0.8rem]">
          {state()?.hard_blocked
            ? 'Bluetooth is hard blocked by rfkill.'
            : 'Bluetooth is soft blocked by rfkill.'}
        </p>
      </Show>
      <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface) px-3 py-3 text-(--shell-text)">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
              Controller
            </p>
            <Show
              when={controller()}
              fallback={
                <p class="mt-1 text-[0.78rem] text-(--shell-text-dim)">
                  No Bluetooth controller detected.
                </p>
              }
            >
              {(activeController) => (
                <div class="mt-1 space-y-1 text-[0.78rem] text-(--shell-text-dim)">
                  <p>{activeController().alias}</p>
                  <p>{activeController().address}</p>
                  <p>
                    {activeController().discovering
                      ? 'Currently scanning for nearby devices.'
                      : activeController().powered
                        ? 'Ready to discover and connect devices.'
                        : 'Bluetooth radio is off.'}
                  </p>
                </div>
              )}
            </Show>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="cursor-pointer rounded-md px-3 py-1.5 text-[0.8rem] font-medium"
              classList={{
                'border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover)':
                  controller()?.powered === true,
                'border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover)':
                  controller()?.powered !== true,
              }}
              disabled={isBusy('radio:on') || !shellHttpBase() || !controller()}
              onClick={() => toggleRadio(true)}
            >
              {isBusy('radio:on') ? 'Turning on...' : 'On'}
            </button>
            <button
              type="button"
              class="cursor-pointer rounded-md px-3 py-1.5 text-[0.8rem] font-medium"
              classList={{
                'border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover)':
                  controller()?.powered === false,
                'border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover)':
                  controller()?.powered !== false,
              }}
              disabled={isBusy('radio:off') || !shellHttpBase() || !controller()}
              onClick={() => toggleRadio(false)}
            >
              {isBusy('radio:off') ? 'Turning off...' : 'Off'}
            </button>
          </div>
        </div>
        <Show when={controller()}>
          {(activeController) => (
            <div class="grid gap-3 md:grid-cols-2">
              <div class="rounded-md border border-(--shell-border) bg-(--shell-surface-elevated) p-3">
                <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
                    Pairable
                  </p>
                  <span class="text-[0.74rem] text-(--shell-text-dim)">
                    {activeController().pairable ? 'Accepting pair requests' : 'Pair requests off'}
                  </span>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button
                    type="button"
                    class="cursor-pointer rounded-md px-3 py-1.5 text-[0.8rem] font-medium"
                    classList={{
                      'border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover)':
                        activeController().pairable,
                      'border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover)':
                        !activeController().pairable,
                    }}
                    disabled={isBusy('pairable:on') || !shellHttpBase() || !activeController().powered}
                    onClick={() => togglePairable(true)}
                  >
                    {isBusy('pairable:on') ? 'Applying...' : 'On'}
                  </button>
                  <button
                    type="button"
                    class="cursor-pointer rounded-md px-3 py-1.5 text-[0.8rem] font-medium"
                    classList={{
                      'border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover)':
                        !activeController().pairable,
                      'border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover)':
                        activeController().pairable,
                    }}
                    disabled={
                      isBusy('pairable:off') || !shellHttpBase() || !activeController().powered
                    }
                    onClick={() => togglePairable(false)}
                  >
                    {isBusy('pairable:off') ? 'Applying...' : 'Off'}
                  </button>
                </div>
              </div>
              <div class="rounded-md border border-(--shell-border) bg-(--shell-surface-elevated) p-3">
                <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
                    Discoverable
                  </p>
                  <span class="text-[0.74rem] text-(--shell-text-dim)">
                    {activeController().discoverable ? 'Visible to nearby devices' : 'Hidden'}
                  </span>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button
                    type="button"
                    class="cursor-pointer rounded-md px-3 py-1.5 text-[0.8rem] font-medium"
                    classList={{
                      'border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover)':
                        activeController().discoverable,
                      'border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover)':
                        !activeController().discoverable,
                    }}
                    disabled={
                      isBusy('discoverable:on') || !shellHttpBase() || !activeController().powered
                    }
                    onClick={() => toggleDiscoverable(true)}
                  >
                    {isBusy('discoverable:on') ? 'Applying...' : 'On'}
                  </button>
                  <button
                    type="button"
                    class="cursor-pointer rounded-md px-3 py-1.5 text-[0.8rem] font-medium"
                    classList={{
                      'border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover)':
                        !activeController().discoverable,
                      'border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover)':
                        activeController().discoverable,
                    }}
                    disabled={
                      isBusy('discoverable:off') || !shellHttpBase() || !activeController().powered
                    }
                    onClick={() => toggleDiscoverable(false)}
                  >
                    {isBusy('discoverable:off') ? 'Applying...' : 'Off'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </Show>
      </div>
      <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface) px-3 py-3 text-(--shell-text)">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
              Devices
            </p>
            <p class="mt-1 text-[0.78rem] leading-relaxed text-(--shell-text-dim)">
              Scan to refresh nearby devices. Pairing follows BlueZ on the remote host, then trusts
              and connects the device in one step.
            </p>
          </div>
          <span class="text-[0.74rem] text-(--shell-text-dim)">
            {state()?.devices.length ?? 0} known
          </span>
        </div>
        <Show
          when={controller()}
          fallback={
            <p class="text-[0.78rem] text-(--shell-text-dim)">
              Attach a Bluetooth adapter to manage devices here.
            </p>
          }
        >
          <Show
            when={(state()?.devices.length ?? 0) > 0}
            fallback={
              <p class="text-[0.78rem] text-(--shell-text-dim)">
                No Bluetooth devices found yet. Turn Bluetooth on and run a scan.
              </p>
            }
          >
            <div class="space-y-3">
              <For each={state()?.devices ?? []}>
                {(device) => {
                  const pairKey = () => `pair:${device.address}`
                  const connectKey = () => `connect:${device.address}`
                  const disconnectKey = () => `disconnect:${device.address}`
                  const trustKey = () => `${device.trusted ? 'untrust' : 'trust'}:${device.address}`
                  const forgetKey = () => `forget:${device.address}`
                  return (
                    <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface-elevated) p-3">
                      <div class="flex flex-wrap items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="flex flex-wrap items-center gap-2">
                            <div class="text-[0.86rem] font-semibold text-(--shell-text)">
                              {device.name}
                            </div>
                            <Show when={device.connected}>{statusBadge('Connected', 'accent')}</Show>
                            <Show when={device.paired}>{statusBadge('Paired', 'muted')}</Show>
                            <Show when={device.trusted}>{statusBadge('Trusted', 'muted')}</Show>
                            <Show when={device.bonded && !device.paired}>
                              {statusBadge('Bonded', 'muted')}
                            </Show>
                          </div>
                          <div class="mt-1 break-all text-[0.74rem] text-(--shell-text-dim)">
                            {device.address}
                          </div>
                        </div>
                        <div class="flex flex-wrap gap-2">
                          <Show when={device.connected}>
                            <button
                              type="button"
                              class="cursor-pointer rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2.5 py-1.5 text-[0.74rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
                              disabled={isBusy(disconnectKey()) || !shellHttpBase()}
                              onClick={() => disconnect(device)}
                            >
                              {isBusy(disconnectKey()) ? 'Disconnecting...' : 'Disconnect'}
                            </button>
                          </Show>
                          <Show when={!device.connected && device.paired}>
                            <button
                              type="button"
                              class="cursor-pointer rounded-md border border-(--shell-accent-border) bg-(--shell-accent) px-2.5 py-1.5 text-[0.74rem] font-medium text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover) disabled:cursor-default"
                              disabled={isBusy(connectKey()) || !shellHttpBase() || !controller()?.powered}
                              onClick={() => connect(device)}
                            >
                              {isBusy(connectKey()) ? 'Connecting...' : 'Connect'}
                            </button>
                          </Show>
                          <Show when={!device.connected && !device.paired}>
                            <button
                              type="button"
                              class="cursor-pointer rounded-md border border-(--shell-accent-border) bg-(--shell-accent) px-2.5 py-1.5 text-[0.74rem] font-medium text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover) disabled:cursor-default"
                              disabled={isBusy(pairKey()) || !shellHttpBase() || !controller()?.powered}
                              onClick={() => pairAndConnect(device)}
                            >
                              {isBusy(pairKey()) ? 'Pairing...' : 'Pair and connect'}
                            </button>
                          </Show>
                          <Show when={device.paired || device.trusted}>
                            <button
                              type="button"
                              class="cursor-pointer rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2.5 py-1.5 text-[0.74rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
                              disabled={isBusy(trustKey()) || !shellHttpBase()}
                              onClick={() => setTrusted(device, !device.trusted)}
                            >
                              {isBusy(trustKey())
                                ? 'Applying...'
                                : device.trusted
                                  ? 'Untrust'
                                  : 'Trust'}
                            </button>
                          </Show>
                          <Show when={device.paired || device.bonded || device.trusted}>
                            <button
                              type="button"
                              class="cursor-pointer rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2.5 py-1.5 text-[0.74rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
                              disabled={isBusy(forgetKey()) || !shellHttpBase()}
                              onClick={() => forget(device)}
                            >
                              {isBusy(forgetKey()) ? 'Forgetting...' : 'Forget'}
                            </button>
                          </Show>
                        </div>
                      </div>
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
