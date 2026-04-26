import { For, Show, createMemo, createSignal, onMount } from 'solid-js'
import type { Accessor } from 'solid-js'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import type { DesktopApplicationsController } from '@/features/desktop/desktopApplicationsState'
import { Select } from '@/host/Select'
import {
  DEFAULT_SHELL_KEYBOARD_SETTINGS,
  keyboardLayoutEntriesToCsv,
  keyboardVariantEntriesToCsv,
  loadShellKeyboardSettings,
  mergeKeyboardLayoutAndVariantCsv,
  saveShellKeyboardSettings,
} from './keyboardSettings'
import {
  BUILTIN_HOTKEY_ACTIONS,
  hotkeyBindingFromDesktopApp,
  hotkeyConflict,
  hotkeyLaunchLabel,
  loadHotkeySettings,
  normalizeHotkeyChord,
  saveHotkeySettings,
  type HotkeyAction,
  type HotkeyBinding,
  type HotkeySettings,
} from './hotkeySettings'

const SHORTCUT_ROWS: { keys: string; action: string }[] = [
  { keys: 'Alt + Tab', action: 'Switch windows' },
  { keys: 'Super + Space', action: 'Cycle keyboard layout' },
  { keys: 'Super + Enter', action: 'Launch terminal (spawn command)' },
  { keys: 'Super + Q', action: 'Close focused window' },
  { keys: 'Super + D', action: 'Toggle programs menu' },
  { keys: 'Super + F', action: 'Toggle fullscreen' },
  { keys: 'Super + M', action: 'Toggle maximize' },
  { keys: 'Super + Left / Right', action: 'Tile half left / right' },
  { keys: 'Super + Up', action: 'Maximize' },
  { keys: 'Super + Down', action: 'Restore or untile' },
  { keys: 'Super + Shift + Left', action: 'Move window to monitor on the left' },
  { keys: 'Super + Shift + Right', action: 'Move window to monitor on the right' },
  { keys: 'Super + ,', action: 'Open settings' },
]

const HOTKEY_SELECT_TRIGGER_CLASS =
  'border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) w-full min-w-0 max-w-none cursor-pointer rounded-md px-2 py-1.5 text-left font-inherit text-sm'

const ENABLED_OPTIONS = ['yes', 'no'] as const
const ACTION_OPTIONS: HotkeyAction[] = ['builtin', 'launch', 'scratchpad']

function updateHotkeyBinding(settings: HotkeySettings, index: number, next: HotkeyBinding): HotkeySettings {
  return { bindings: settings.bindings.map((binding, rowIndex) => (rowIndex === index ? next : binding)) }
}

function createHotkeyBinding(seq: number): HotkeyBinding {
  return {
    id: `custom-${seq}`,
    enabled: true,
    chord: 'Super+B',
    action: 'launch',
    builtin: '',
    command: 'foot',
    desktop_id: '',
    app_name: '',
    scratchpad_id: '',
  }
}

function hotkeyActionLabel(binding: HotkeyBinding): string {
  if (binding.action === 'launch') return `Launch ${hotkeyLaunchLabel(binding)}`
  if (binding.action === 'scratchpad') return `Scratchpad ${binding.scratchpad_id}`
  return BUILTIN_HOTKEY_ACTIONS.find((entry) => entry.value === binding.builtin)?.label ?? binding.builtin
}

function hotkeyWithAction(binding: HotkeyBinding, action: HotkeyAction): HotkeyBinding {
  if (action === 'builtin') {
    return { ...binding, action, builtin: binding.builtin || BUILTIN_HOTKEY_ACTIONS[0].value }
  }
  if (action === 'launch') {
    return { ...binding, action, command: binding.command || 'foot' }
  }
  return { ...binding, action, scratchpad_id: binding.scratchpad_id || 'scratchpad-1' }
}

function actionLabel(action: HotkeyAction): string {
  if (action === 'builtin') return 'Built-in'
  if (action === 'launch') return 'Launch'
  return 'Scratchpad'
}

export function SettingsKeyboardPage(props: {
  keyboardLayoutLabel: Accessor<string | null>
  desktopApps: DesktopApplicationsController
}) {
  const [layoutCsv, setLayoutCsv] = createSignal('')
  const [variantCsv, setVariantCsv] = createSignal('')
  const [repeatRate, setRepeatRate] = createSignal(DEFAULT_SHELL_KEYBOARD_SETTINGS.repeat_rate)
  const [repeatDelayMs, setRepeatDelayMs] = createSignal(DEFAULT_SHELL_KEYBOARD_SETTINGS.repeat_delay_ms)
  const [busy, setBusy] = createSignal(false)
  const [saveBusy, setSaveBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | null>(null)
  const [saveErr, setSaveErr] = createSignal<string | null>(null)
  const [savedAt, setSavedAt] = createSignal<number | null>(null)
  const [hotkeys, setHotkeys] = createSignal<HotkeySettings>({ bindings: [] })
  const [hotkeysBusy, setHotkeysBusy] = createSignal(false)
  const [hotkeysSaveBusy, setHotkeysSaveBusy] = createSignal(false)
  const [hotkeysErr, setHotkeysErr] = createSignal<string | null>(null)
  const [hotkeysSavedAt, setHotkeysSavedAt] = createSignal<number | null>(null)
  const hotkeyConflictText = createMemo(() => hotkeyConflict(hotkeys()))

  async function load() {
    const base = shellHttpBase()
    if (!base) {
      setErr('Needs cef_host control server to load keyboard settings.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const settings = await loadShellKeyboardSettings(base)
      setLayoutCsv(keyboardLayoutEntriesToCsv(settings.layouts))
      setVariantCsv(keyboardVariantEntriesToCsv(settings.layouts))
      setRepeatRate(settings.repeat_rate)
      setRepeatDelayMs(settings.repeat_delay_ms)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function loadHotkeys() {
    const base = shellHttpBase()
    if (!base) {
      setHotkeysErr('Needs cef_host control server to load hotkeys.')
      return
    }
    setHotkeysBusy(true)
    setHotkeysErr(null)
    try {
      setHotkeys(await loadHotkeySettings(base))
      await props.desktopApps.refresh()
    } catch (error) {
      setHotkeysErr(error instanceof Error ? error.message : String(error))
    } finally {
      setHotkeysBusy(false)
    }
  }

  async function save() {
    const base = shellHttpBase()
    if (!base) {
      setSaveErr('Needs cef_host control server to save keyboard settings.')
      return
    }
    const layouts = mergeKeyboardLayoutAndVariantCsv(layoutCsv(), variantCsv())
    if (layouts.length === 0) {
      setSaveErr('Provide at least one XKB layout code such as us or us,de.')
      return
    }
    setSaveBusy(true)
    setSaveErr(null)
    setSavedAt(null)
    try {
      await saveShellKeyboardSettings(
        {
          layouts,
          repeat_rate: repeatRate(),
          repeat_delay_ms: repeatDelayMs(),
        },
        base,
      )
      setSavedAt(Date.now())
      await load()
    } catch (error) {
      setSaveErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSaveBusy(false)
    }
  }

  async function saveHotkeys() {
    const base = shellHttpBase()
    if (!base) {
      setHotkeysErr('Needs cef_host control server to save hotkeys.')
      return
    }
    const conflict = hotkeyConflictText()
    if (conflict) {
      setHotkeysErr(conflict)
      return
    }
    setHotkeysSaveBusy(true)
    setHotkeysErr(null)
    setHotkeysSavedAt(null)
    try {
      const normalized = {
        bindings: hotkeys().bindings.map((binding) => ({
          ...binding,
          chord: normalizeHotkeyChord(binding.chord) ?? binding.chord,
        })),
      }
      await saveHotkeySettings(normalized, base)
      setHotkeysSavedAt(Date.now())
      await loadHotkeys()
    } catch (error) {
      setHotkeysErr(error instanceof Error ? error.message : String(error))
    } finally {
      setHotkeysSaveBusy(false)
    }
  }

  onMount(() => {
    void load()
    void loadHotkeys()
  })

  return (
    <div class="space-y-4" data-settings-keyboard-page>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-base font-semibold tracking-wide text-(--shell-text)">Keyboard</h2>
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
          Active layout
        </p>
        <Show
          when={props.keyboardLayoutLabel()}
          fallback={
            <p class="text-[0.82rem] text-(--shell-text-muted)">Waiting for layout from compositor…</p>
          }
        >
          <p class="text-[0.95rem] font-semibold tabular-nums text-(--shell-text)">
            {props.keyboardLayoutLabel()!}
          </p>
        </Show>
      </div>
      <div class="border border-(--shell-border) bg-(--shell-surface) text-(--shell-text) rounded-lg px-3 py-3">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
            Available layouts
          </p>
          <span class="text-[0.75rem] text-(--shell-text-dim)">Saved in settings.json</span>
        </div>
        <div class="space-y-3">
          <label class="block">
            <span class="mb-1 block text-[0.8rem] font-medium text-(--shell-text)">XKB layouts</span>
            <input
              data-settings-keyboard-layouts-input
              class="w-full rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-3 py-2 text-[0.82rem] text-(--shell-text) outline-none"
              type="text"
              value={layoutCsv()}
              onInput={(event) => setLayoutCsv(event.currentTarget.value)}
              spellcheck={false}
              placeholder="us, de"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-[0.8rem] font-medium text-(--shell-text)">Variants</span>
            <input
              data-settings-keyboard-variants-input
              class="w-full rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-3 py-2 text-[0.82rem] text-(--shell-text) outline-none"
              type="text"
              value={variantCsv()}
              onInput={(event) => setVariantCsv(event.currentTarget.value)}
              spellcheck={false}
              placeholder=", nodeadkeys"
            />
          </label>
          <p class="text-[0.75rem] leading-relaxed text-(--shell-text-dim)">
            Enter comma-separated XKB layout codes. Variants line up by position, so{' '}
            <span class="text-(--shell-text-muted)">us, de</span> with{' '}
            <span class="text-(--shell-text-muted)">, nodeadkeys</span> keeps US default first and
            German nodeadkeys second.
          </p>
        </div>
      </div>
      <div class="border border-(--shell-border) bg-(--shell-surface) text-(--shell-text) rounded-lg px-3 py-3">
        <p class="mb-3 text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
          Key repeat
        </p>
        <div class="space-y-4">
          <label class="block">
            <div class="mb-1 flex items-center justify-between gap-3 text-[0.8rem]">
              <span class="font-medium text-(--shell-text)">Repeat rate</span>
              <span class="tabular-nums text-(--shell-text-muted)">{repeatRate()} repeats/sec</span>
            </div>
            <input
              data-settings-keyboard-repeat-rate
              class="w-full"
              type="range"
              min="1"
              max="60"
              step="1"
              value={repeatRate()}
              onInput={(event) => setRepeatRate(Number(event.currentTarget.value))}
            />
          </label>
          <label class="block">
            <div class="mb-1 flex items-center justify-between gap-3 text-[0.8rem]">
              <span class="font-medium text-(--shell-text)">Repeat delay</span>
              <span class="tabular-nums text-(--shell-text-muted)">{repeatDelayMs()} ms</span>
            </div>
            <input
              data-settings-keyboard-repeat-delay
              class="w-full"
              type="range"
              min="100"
              max="1000"
              step="25"
              value={repeatDelayMs()}
              onInput={(event) => setRepeatDelayMs(Number(event.currentTarget.value))}
            />
          </label>
        </div>
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-settings-keyboard-save
            class="border border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover) cursor-pointer rounded-lg px-2.5 py-1.5 text-[0.78rem] font-medium disabled:cursor-default"
            disabled={saveBusy() || !shellHttpBase()}
            onClick={() => void save()}
          >
            {saveBusy() ? 'Saving…' : 'Apply keyboard settings'}
          </button>
          <Show when={savedAt()}>
            <span class="text-[0.76rem] text-(--shell-text-dim)">Applied just now.</span>
          </Show>
        </div>
        <Show when={err()}>
          <p class="mt-3 text-[0.8rem] text-(--shell-warning-text)">{err()}</p>
        </Show>
        <Show when={saveErr()}>
          <p class="mt-3 text-[0.8rem] text-(--shell-warning-text)">{saveErr()}</p>
        </Show>
      </div>
      <div class="border border-(--shell-border) bg-(--shell-surface) text-(--shell-text) rounded-lg px-3 py-3" data-settings-hotkeys>
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
              Super hotkeys
            </p>
            <p class="mt-1 text-[0.75rem] text-(--shell-text-dim)">
              Built-ins, scratchpads, and app launches.
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) cursor-pointer rounded-lg px-2.5 py-1.5 text-[0.78rem] font-medium disabled:cursor-default"
              disabled={hotkeysBusy() || !shellHttpBase()}
              onClick={() => void loadHotkeys()}
            >
              {hotkeysBusy() ? 'Reading…' : 'Refresh'}
            </button>
            <button
              type="button"
              data-settings-hotkey-add
              class="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) cursor-pointer rounded-lg px-2.5 py-1.5 text-[0.78rem] font-medium"
              onClick={() => setHotkeys((current) => ({ bindings: [...current.bindings, createHotkeyBinding(current.bindings.length + 1)] }))}
            >
              Add
            </button>
          </div>
        </div>
        <div class="space-y-2">
          <For each={hotkeys().bindings}>
            {(binding, index) => (
              <section class="rounded-md border border-(--shell-border) bg-(--shell-surface-panel) p-2" data-settings-hotkey={binding.id}>
                <div class="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_8rem_10rem_auto]">
                  <label class="min-w-0 space-y-1 text-xs text-(--shell-text-muted)">
                    <span>Shortcut</span>
                    <input
                      class="w-full rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2 py-1.5 text-sm text-(--shell-text) outline-none"
                      data-settings-hotkey-chord={binding.id}
                      value={binding.chord}
                      spellcheck={false}
                      onInput={(event) => setHotkeys((current) => updateHotkeyBinding(current, index(), { ...binding, chord: event.currentTarget.value }))}
                    />
                  </label>
                  <label class="space-y-1 text-xs text-(--shell-text-muted)">
                    <span>Enabled</span>
                    <Select
                      options={ENABLED_OPTIONS}
                      value={binding.enabled ? 'yes' : 'no'}
                      onChange={(value) => setHotkeys((current) => updateHotkeyBinding(current, index(), { ...binding, enabled: value === 'yes' }))}
                      itemLabel={(value) => (value === 'yes' ? 'On' : 'Off')}
                      equals={(a, b) => a === b}
                      triggerClass={HOTKEY_SELECT_TRIGGER_CLASS}
                      triggerAttrs={{ 'data-settings-hotkey-enabled': binding.id }}
                      optionAttrs={(value) => ({ 'data-settings-hotkey-enabled-option': String(value) })}
                    />
                  </label>
                  <label class="space-y-1 text-xs text-(--shell-text-muted)">
                    <span>Action</span>
                    <Select
                      options={ACTION_OPTIONS}
                      value={binding.action}
                      onChange={(value) => setHotkeys((current) => updateHotkeyBinding(current, index(), hotkeyWithAction(binding, value as HotkeyAction)))}
                      itemLabel={(value) => actionLabel(value as HotkeyAction)}
                      equals={(a, b) => a === b}
                      triggerClass={HOTKEY_SELECT_TRIGGER_CLASS}
                      triggerAttrs={{ 'data-settings-hotkey-action': binding.id }}
                      optionAttrs={(value) => ({ 'data-settings-hotkey-action-option': String(value) })}
                    />
                  </label>
                  <button
                    type="button"
                    class="self-end rounded-md border border-(--shell-border) bg-(--shell-control-muted-bg) px-2 py-1.5 text-xs text-(--shell-text-muted) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text)"
                    onClick={() => setHotkeys((current) => ({ bindings: current.bindings.filter((_, rowIndex) => rowIndex !== index()) }))}
                  >
                    Remove
                  </button>
                </div>
                <Show when={binding.action === 'builtin'}>
                  <label class="mt-2 block space-y-1 text-xs text-(--shell-text-muted)">
                    <span>Built-in command</span>
                    <Select
                      options={BUILTIN_HOTKEY_ACTIONS.map((action) => action.value)}
                      value={binding.builtin}
                      onChange={(value) => setHotkeys((current) => updateHotkeyBinding(current, index(), { ...binding, builtin: String(value) }))}
                      itemLabel={(value) => BUILTIN_HOTKEY_ACTIONS.find((action) => action.value === value)?.label ?? String(value)}
                      equals={(a, b) => a === b}
                      triggerClass={HOTKEY_SELECT_TRIGGER_CLASS}
                      minMenuWidthPx={280}
                      triggerAttrs={{ 'data-settings-hotkey-builtin': binding.id }}
                      optionAttrs={(value) => ({ 'data-settings-hotkey-builtin-option': String(value) })}
                    />
                  </label>
                </Show>
                <Show when={binding.action === 'launch'}>
                  <div class="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <label class="min-w-0 space-y-1 text-xs text-(--shell-text-muted)">
                      <span>Application</span>
                      <Select
                        options={['', ...props.desktopApps.items().map((app) => app.desktop_id)]}
                        value={binding.desktop_id}
                        onChange={(value) => {
                          const desktopId = String(value)
                          if (!desktopId) {
                            setHotkeys((current) => updateHotkeyBinding(current, index(), { ...binding, desktop_id: '', app_name: '' }))
                            return
                          }
                          const app = props.desktopApps.items().find((entry) => entry.desktop_id === desktopId)
                          if (app) setHotkeys((current) => updateHotkeyBinding(current, index(), hotkeyBindingFromDesktopApp(app, binding)))
                        }}
                        itemLabel={(value) => {
                          const desktopId = String(value)
                          if (!desktopId) return 'Custom command'
                          return props.desktopApps.items().find((app) => app.desktop_id === desktopId)?.name ?? desktopId
                        }}
                        equals={(a, b) => a === b}
                        triggerClass={HOTKEY_SELECT_TRIGGER_CLASS}
                        minMenuWidthPx={280}
                        triggerAttrs={{ 'data-settings-hotkey-app': binding.id }}
                        optionAttrs={(value) => ({ 'data-settings-hotkey-app-option': String(value) })}
                      />
                    </label>
                    <label class="min-w-0 space-y-1 text-xs text-(--shell-text-muted)">
                      <span>Command</span>
                      <input
                        class="w-full rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2 py-1.5 text-sm text-(--shell-text) outline-none"
                        data-settings-hotkey-command={binding.id}
                        value={binding.command}
                        spellcheck={false}
                        onInput={(event) => setHotkeys((current) => updateHotkeyBinding(current, index(), { ...binding, action: 'launch', command: event.currentTarget.value, desktop_id: '', app_name: '' }))}
                      />
                    </label>
                  </div>
                </Show>
                <Show when={binding.action === 'scratchpad'}>
                  <label class="mt-2 block space-y-1 text-xs text-(--shell-text-muted)">
                    <span>Scratchpad id</span>
                    <input
                      class="w-full rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2 py-1.5 text-sm text-(--shell-text) outline-none"
                      data-settings-hotkey-scratchpad={binding.id}
                      value={binding.scratchpad_id}
                      spellcheck={false}
                      onInput={(event) => setHotkeys((current) => updateHotkeyBinding(current, index(), { ...binding, scratchpad_id: event.currentTarget.value }))}
                    />
                  </label>
                </Show>
                <p class="mt-2 truncate text-[0.72rem] text-(--shell-text-dim)">{hotkeyActionLabel(binding)}</p>
              </section>
            )}
          </For>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-settings-hotkey-save
            class="border border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover) cursor-pointer rounded-lg px-2.5 py-1.5 text-[0.78rem] font-medium disabled:cursor-default"
            disabled={hotkeysSaveBusy() || !shellHttpBase() || !!hotkeyConflictText()}
            onClick={() => void saveHotkeys()}
          >
            {hotkeysSaveBusy() ? 'Saving…' : 'Apply hotkeys'}
          </button>
          <Show when={hotkeysSavedAt()}>
            <span class="text-[0.76rem] text-(--shell-text-dim)">Applied just now.</span>
          </Show>
        </div>
        <Show when={hotkeyConflictText()}>
          <p class="mt-3 text-[0.8rem] text-(--shell-warning-text)">{hotkeyConflictText()}</p>
        </Show>
        <Show when={hotkeysErr()}>
          <p class="mt-3 text-[0.8rem] text-(--shell-warning-text)">{hotkeysErr()}</p>
        </Show>
      </div>
      <div class="border border-(--shell-border) bg-(--shell-surface) text-(--shell-text) rounded-lg px-3 py-3">
        <p class="mb-2 text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
          Default shortcuts
        </p>
        <table class="w-full border-collapse text-left text-[0.78rem] text-(--shell-text-muted)">
          <thead>
            <tr class="border-b border-(--shell-border) text-[0.65rem] uppercase tracking-wide text-(--shell-text-dim)">
              <th class="py-1.5 pr-3 font-semibold">Shortcut</th>
              <th class="py-1.5 font-semibold">Action</th>
            </tr>
          </thead>
          <tbody>
            <For each={SHORTCUT_ROWS}>
              {(row) => (
                <tr class="border-b border-(--shell-border) last:border-0">
                  <td class="py-1.5 pr-3 font-mono text-[0.72rem] text-(--shell-text-dim)">
                    {row.keys}
                  </td>
                  <td class="py-1.5 text-(--shell-text)">{row.action}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  )
}
