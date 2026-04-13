import Volume2 from 'lucide-solid/icons/volume-2'
import VolumeX from 'lucide-solid/icons/volume-x'
import { Show, type JSX } from 'solid-js'
import type { ShellAudioDevice } from './audioState'
import { isAudioDevice, sliderMax, type AudioRow } from './useShellAudioState'

export function shellAudioSectionTitle(title: string, body: string) {
  return (
    <div class="mb-3">
      <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">{title}</p>
      <p class="mt-1 text-[0.78rem] leading-relaxed text-(--shell-text-dim)">{body}</p>
    </div>
  )
}

type ShellAudioRowProps = {
  row: AudioRow
  busy: boolean
  allowDefault: boolean
  compact?: boolean
  onToggleMute: (row: AudioRow) => void
  onQueueVolume: (id: number, nextVolume: number) => void
  onMakeDefault?: (row: ShellAudioDevice) => void
  extra?: JSX.Element
}

export function ShellAudioRow(props: ShellAudioRowProps) {
  const compact = () => props.compact === true
  const deviceRow = () => (isAudioDevice(props.row) ? props.row : null)
  return (
    <div
      classList={{
        'rounded-lg border border-(--shell-border) bg-(--shell-surface-elevated) p-3': !compact(),
        'rounded-md border border-(--shell-border) bg-(--shell-surface-elevated) px-2.5 py-2': compact(),
      }}
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <div
            classList={{
              'text-[0.84rem] font-semibold text-(--shell-text)': !compact(),
              'text-[0.76rem] font-semibold text-(--shell-text)': compact(),
            }}
          >
            {props.row.label}
          </div>
          <Show when={props.row.subtitle}>
            <div
              classList={{
                'mt-1 break-all text-[0.74rem] text-(--shell-text-dim)': !compact(),
                'mt-0.5 break-all text-[0.68rem] text-(--shell-text-dim)': compact(),
              }}
            >
              {props.row.subtitle}
            </div>
          </Show>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={props.allowDefault && deviceRow()?.is_default}>
            <span class="rounded-md border border-(--shell-accent-border) bg-(--shell-accent-soft) px-2 py-1 text-[0.68rem] font-semibold uppercase tracking-wide text-(--shell-accent-soft-text)">
              Default
            </span>
          </Show>
          <Show when={props.allowDefault && deviceRow() && !deviceRow()!.is_default}>
            <button
              type="button"
              class="cursor-pointer rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2 py-1 text-[0.74rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
              disabled={props.busy}
              onClick={() => props.onMakeDefault?.(deviceRow()!)}
            >
              Make default
            </button>
          </Show>
          {props.extra}
          <button
            type="button"
            class="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
            disabled={props.busy}
            title={props.row.muted ? 'Unmute' : 'Mute'}
            aria-label={props.row.muted ? 'Unmute' : 'Mute'}
            onClick={() => props.onToggleMute(props.row)}
          >
            <Show when={props.row.muted} fallback={<Volume2 class="h-4 w-4" stroke-width={2} />}>
              <VolumeX class="h-4 w-4" stroke-width={2} />
            </Show>
          </button>
        </div>
      </div>
      <div class="mt-3 flex items-center gap-3">
        <input
          type="range"
          min="0"
          max={sliderMax(props.row)}
          value={props.row.volume_percent}
          disabled={props.busy}
          class="h-2 w-full cursor-pointer accent-(--shell-accent) disabled:cursor-default"
          onInput={(event) => props.onQueueVolume(props.row.id, event.currentTarget.valueAsNumber)}
        />
        <span
          classList={{
            'w-14 shrink-0 text-right text-[0.76rem] text-(--shell-text-muted)': !compact(),
            'w-12 shrink-0 text-right text-[0.7rem] text-(--shell-text-muted)': compact(),
          }}
        >
          {props.row.volume_known ? `${props.row.volume_percent}%` : 'Unknown'}
        </span>
      </div>
    </div>
  )
}
