import { For, Index, Show, createSignal, onMount } from 'solid-js'
import type { DerpWindow } from '@/host/appWindowState'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import {
  createDefaultScratchpad,
  loadScratchpadSettings,
  saveScratchpadSettings,
  type ScratchpadItem,
  type ScratchpadRule,
  type ScratchpadRuleField,
  type ScratchpadRuleOp,
  type ScratchpadSettings,
} from './scratchpadSettings'

const RULE_FIELDS: { value: ScratchpadRuleField; label: string }[] = [
  { value: 'app_id', label: 'App id' },
  { value: 'title', label: 'Title' },
  { value: 'x11_class', label: 'X11 class' },
  { value: 'x11_instance', label: 'X11 instance' },
  { value: 'kind', label: 'Kind' },
]

const RULE_OPS: { value: ScratchpadRuleOp; label: string }[] = [
  { value: 'equals', label: 'Equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'starts_with', label: 'Starts with' },
]

function updateItemAt(settings: ScratchpadSettings, index: number, next: ScratchpadItem): ScratchpadSettings {
  return { items: settings.items.map((item, itemIndex) => (itemIndex === index ? next : item)) }
}

function updateRule(item: ScratchpadItem, index: number, next: ScratchpadRule): ScratchpadItem {
  return {
    ...item,
    rules: item.rules.map((rule, ruleIndex) => (ruleIndex === index ? next : rule)),
  }
}

function ruleValueRows(window: DerpWindow): { field: ScratchpadRuleField; value: string }[] {
  return [
    { field: 'app_id', value: window.app_id },
    { field: 'title', value: window.title },
    { field: 'kind', value: window.kind },
    { field: 'x11_class', value: window.x11_class },
    { field: 'x11_instance', value: window.x11_instance },
  ]
}

function visibleValue(value: string): string {
  return value.trim().length > 0 ? value : '(empty)'
}

export function SettingsScratchpadsPage(props: { windows: () => readonly DerpWindow[] }) {
  const [settings, setSettings] = createSignal<ScratchpadSettings>({ items: [] })
  const [err, setErr] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [saveErr, setSaveErr] = createSignal<string | null>(null)

  async function load() {
    const base = shellHttpBase()
    if (!base) {
      setErr('Needs cef_host control server to load scratchpads.')
      return
    }
    try {
      setErr(null)
      setSettings(await loadScratchpadSettings(base))
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    }
  }

  async function save() {
    const base = shellHttpBase()
    if (!base) {
      setSaveErr('Needs cef_host control server to save scratchpads.')
      return
    }
    setBusy(true)
    setSaveErr(null)
    try {
      await saveScratchpadSettings(settings(), base)
      await load()
    } catch (error) {
      setSaveErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  onMount(() => {
    void load()
  })

  const addScratchpad = () => {
    const seq = settings().items.length + 1
    setSettings((current) => ({ items: [...current.items, createDefaultScratchpad(seq)] }))
  }

  return (
    <div class="flex h-full min-h-0 flex-col gap-4" data-settings-scratchpads-page>
      <div class="flex shrink-0 items-center justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold text-(--shell-text)">Scratchpads</h2>
          <p class="text-[0.78rem] text-(--shell-text-muted)">Floating windows matched by compositor rules.</p>
        </div>
        <button
          type="button"
          class="rounded-md border border-(--shell-border) bg-(--shell-control-muted-bg) px-3 py-1.5 text-xs font-medium text-(--shell-text) hover:bg-(--shell-control-muted-hover)"
          data-settings-scratchpad-add
          onClick={addScratchpad}
        >
          Add
        </button>
      </div>

      <Show when={err()}>
        <p class="rounded-md border border-(--shell-warning-border) bg-(--shell-warning-bg) px-3 py-2 text-xs text-(--shell-warning-text)">
          {err()}
        </p>
      </Show>

      <details
        class="shrink-0 rounded-lg border border-(--shell-border) bg-(--shell-surface-elevated) text-(--shell-text)"
        data-settings-scratchpad-window-inspector
      >
        <summary class="cursor-pointer px-3 py-2 text-xs font-semibold text-(--shell-text-muted)">
          Open windows ({props.windows().length})
        </summary>
        <div class="max-h-72 space-y-2 overflow-y-auto border-t border-(--shell-border) p-3">
          <Show
            when={props.windows().length > 0}
            fallback={<p class="text-xs text-(--shell-text-muted)">No compositor windows are open.</p>}
          >
            <For each={props.windows()}>
              {(window) => (
                <section
                  class="rounded-md border border-(--shell-border) bg-(--shell-surface-panel) p-2"
                  data-settings-scratchpad-window-row={window.window_id}
                >
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <strong class="min-w-0 truncate text-sm font-semibold text-(--shell-text)">
                      {window.title || window.app_id || `Window ${window.window_id}`}
                    </strong>
                    <span class="font-mono text-[0.68rem] text-(--shell-text-dim)">#{window.window_id}</span>
                  </div>
                  <div class="mt-2 grid grid-cols-1 gap-1 text-[0.72rem] sm:grid-cols-2">
                    <For each={ruleValueRows(window)}>
                      {(row) => (
                        <div class="min-w-0 rounded border border-(--shell-border) bg-(--shell-surface-elevated) px-2 py-1">
                          <span class="font-mono text-(--shell-text-dim)">{row.field}</span>
                          <span class="mx-1 text-(--shell-text-dim)">=</span>
                          <span class="break-all font-mono text-(--shell-text)">{visibleValue(row.value)}</span>
                        </div>
                      )}
                    </For>
                  </div>
                  <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[0.68rem] text-(--shell-text-dim)">
                    <span>output={visibleValue(window.output_name)}</span>
                    <span>
                      rect={window.x},{window.y} {window.width}x{window.height}
                    </span>
                    <Show when={window.minimized}>
                      <span>minimized</span>
                    </Show>
                    <Show when={window.maximized}>
                      <span>maximized</span>
                    </Show>
                    <Show when={window.fullscreen}>
                      <span>fullscreen</span>
                    </Show>
                  </div>
                </section>
              )}
            </For>
          </Show>
        </div>
      </details>

      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1" data-settings-scratchpad-list>
        <Index each={settings().items}>
          {(item, itemIndex) => (
            <section class="rounded-lg border border-(--shell-border) bg-(--shell-surface-elevated) p-3" data-settings-scratchpad={item().id}>
              <div class="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto]">
                <label class="space-y-1 text-xs text-(--shell-text-muted)">
                  <span>Name</span>
                  <input
                    class="w-full rounded-md border border-(--shell-border) bg-(--shell-surface-panel) px-2 py-1.5 text-sm text-(--shell-text)"
                    value={item().name}
                    onInput={(event) => setSettings((current) => updateItemAt(current, itemIndex, { ...item(), name: event.currentTarget.value }))}
                  />
                </label>
                <label class="space-y-1 text-xs text-(--shell-text-muted)">
                  <span>Hotkey</span>
                  <input
                    class="w-full rounded-md border border-(--shell-border) bg-(--shell-surface-panel) px-2 py-1.5 text-sm text-(--shell-text)"
                    value={item().hotkey}
                    data-settings-scratchpad-hotkey={item().id}
                    onInput={(event) => setSettings((current) => updateItemAt(current, itemIndex, { ...item(), hotkey: event.currentTarget.value }))}
                  />
                </label>
                <button
                  type="button"
                  class="self-end rounded-md border border-(--shell-border) bg-(--shell-control-muted-bg) px-3 py-1.5 text-xs text-(--shell-text-muted) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text)"
                  onClick={() => setSettings((current) => ({ items: current.items.filter((_, rowIndex) => rowIndex !== itemIndex) }))}
                >
                  Remove
                </button>
              </div>

              <div class="mt-3 grid grid-cols-1 gap-2 md:grid-cols-4">
                <label class="space-y-1 text-xs text-(--shell-text-muted)">
                  <span>Id</span>
                  <input
                    class="w-full rounded-md border border-(--shell-border) bg-(--shell-surface-panel) px-2 py-1.5 text-sm text-(--shell-text)"
                    value={item().id}
                    onInput={(event) => setSettings((current) => updateItemAt(current, itemIndex, { ...item(), id: event.currentTarget.value }))}
                  />
                </label>
                <label class="space-y-1 text-xs text-(--shell-text-muted)">
                  <span>Monitor</span>
                  <input
                    class="w-full rounded-md border border-(--shell-border) bg-(--shell-surface-panel) px-2 py-1.5 text-sm text-(--shell-text)"
                    value={item().placement.monitor}
                    onInput={(event) => setSettings((current) => updateItemAt(current, itemIndex, { ...item(), placement: { ...item().placement, monitor: event.currentTarget.value } }))}
                  />
                </label>
                <label class="space-y-1 text-xs text-(--shell-text-muted)">
                  <span>Width %</span>
                  <input
                    type="number"
                    min="20"
                    max="100"
                    class="w-full rounded-md border border-(--shell-border) bg-(--shell-surface-panel) px-2 py-1.5 text-sm text-(--shell-text)"
                    value={item().placement.width_percent}
                    onInput={(event) => setSettings((current) => updateItemAt(current, itemIndex, { ...item(), placement: { ...item().placement, width_percent: Number(event.currentTarget.value) } }))}
                  />
                </label>
                <label class="space-y-1 text-xs text-(--shell-text-muted)">
                  <span>Height %</span>
                  <input
                    type="number"
                    min="20"
                    max="100"
                    class="w-full rounded-md border border-(--shell-border) bg-(--shell-surface-panel) px-2 py-1.5 text-sm text-(--shell-text)"
                    value={item().placement.height_percent}
                    onInput={(event) => setSettings((current) => updateItemAt(current, itemIndex, { ...item(), placement: { ...item().placement, height_percent: Number(event.currentTarget.value) } }))}
                  />
                </label>
              </div>

              <div class="mt-3 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={item().default_visible}
                  data-settings-scratchpad-default-visible={item().id}
                  onChange={(event) => setSettings((current) => updateItemAt(current, itemIndex, { ...item(), default_visible: event.currentTarget.checked }))}
                />
                <span class="text-xs text-(--shell-text-muted)">Visible by default</span>
              </div>

              <div class="mt-3 space-y-2">
                <div class="flex items-center justify-between">
                  <h3 class="text-xs font-semibold uppercase tracking-wide text-(--shell-text-dim)">Rules</h3>
                  <button
                    type="button"
                    class="rounded-md border border-(--shell-border) bg-(--shell-control-muted-bg) px-2 py-1 text-xs text-(--shell-text-muted) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text)"
                    data-settings-scratchpad-rule-add={item().id}
                    onClick={() => setSettings((current) => updateItemAt(current, itemIndex, { ...item(), rules: [...item().rules, { field: 'app_id', op: 'equals', value: '' }] }))}
                  >
                    Add rule
                  </button>
                </div>
                <Index each={item().rules}>
                  {(rule, ruleIndex) => (
                    <div class="grid grid-cols-1 gap-2 md:grid-cols-[9rem_9rem_1fr_auto]">
                      <select
                        class="rounded-md border border-(--shell-border) bg-(--shell-surface-panel) px-2 py-1.5 text-sm text-(--shell-text)"
                        value={rule().field}
                        data-settings-scratchpad-rule-field={`${item().id}:${ruleIndex}`}
                        onChange={(event) => setSettings((current) => updateItemAt(current, itemIndex, updateRule(item(), ruleIndex, { ...rule(), field: event.currentTarget.value as ScratchpadRuleField })))}
                      >
                        <For each={RULE_FIELDS}>
                          {(field) => <option value={field.value}>{field.label}</option>}
                        </For>
                      </select>
                      <select
                        class="rounded-md border border-(--shell-border) bg-(--shell-surface-panel) px-2 py-1.5 text-sm text-(--shell-text)"
                        value={rule().op}
                        onChange={(event) => setSettings((current) => updateItemAt(current, itemIndex, updateRule(item(), ruleIndex, { ...rule(), op: event.currentTarget.value as ScratchpadRuleOp })))}
                      >
                        <For each={RULE_OPS}>
                          {(op) => <option value={op.value}>{op.label}</option>}
                        </For>
                      </select>
                      <input
                        class="rounded-md border border-(--shell-border) bg-(--shell-surface-panel) px-2 py-1.5 text-sm text-(--shell-text)"
                        value={rule().value}
                        data-settings-scratchpad-rule-value={`${item().id}:${ruleIndex}`}
                        onInput={(event) => setSettings((current) => updateItemAt(current, itemIndex, updateRule(item(), ruleIndex, { ...rule(), value: event.currentTarget.value })))}
                      />
                      <button
                        type="button"
                        class="rounded-md border border-(--shell-border) bg-(--shell-control-muted-bg) px-2 py-1.5 text-xs text-(--shell-text-muted) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text)"
                        onClick={() => setSettings((current) => updateItemAt(current, itemIndex, { ...item(), rules: item().rules.filter((_, rowIndex) => rowIndex !== ruleIndex) }))}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </Index>
              </div>
            </section>
          )}
        </Index>
      </div>

      <div class="flex shrink-0 items-center gap-3">
        <button
          type="button"
          class="rounded-md border border-(--shell-border) bg-(--shell-accent) px-3 py-1.5 text-xs font-semibold text-(--shell-accent-foreground) hover:brightness-110 disabled:opacity-60"
          data-settings-scratchpad-save
          disabled={busy()}
          onClick={() => void save()}
        >
          {busy() ? 'Saving...' : 'Apply scratchpads'}
        </button>
        <Show when={saveErr()}>
          <span class="text-xs text-(--shell-warning-text)">{saveErr()}</span>
        </Show>
      </div>
    </div>
  )
}
