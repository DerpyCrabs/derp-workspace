import { For, Show } from 'solid-js'
import type { Accessor } from 'solid-js'

const SHORTCUT_ROWS: { keys: string; action: string }[] = [
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
  return (
    <div class="space-y-4">
      <h2 class="text-base font-semibold tracking-wide text-(--shell-text)">Keyboard</h2>
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
