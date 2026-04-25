import { For, Show, createSignal, onMount } from 'solid-js'
import type { Accessor } from 'solid-js'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import {
  DEFAULT_SHELL_KEYBOARD_SETTINGS,
  keyboardLayoutEntriesToCsv,
  keyboardVariantEntriesToCsv,
  loadShellKeyboardSettings,
  mergeKeyboardLayoutAndVariantCsv,
  saveShellKeyboardSettings,
} from './keyboardSettings'

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

export function SettingsKeyboardPage(props: { keyboardLayoutLabel: Accessor<string | null> }) {
  const [layoutCsv, setLayoutCsv] = createSignal('')
  const [variantCsv, setVariantCsv] = createSignal('')
  const [repeatRate, setRepeatRate] = createSignal(DEFAULT_SHELL_KEYBOARD_SETTINGS.repeat_rate)
  const [repeatDelayMs, setRepeatDelayMs] = createSignal(DEFAULT_SHELL_KEYBOARD_SETTINGS.repeat_delay_ms)
  const [busy, setBusy] = createSignal(false)
  const [saveBusy, setSaveBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | null>(null)
  const [saveErr, setSaveErr] = createSignal<string | null>(null)
  const [savedAt, setSavedAt] = createSignal<number | null>(null)

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

  onMount(() => {
    void load()
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
