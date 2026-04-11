import { For, Show, createSignal, onCleanup, onMount } from 'solid-js'
import { DERP_AUDIO_STATE_CHANGED_EVENT } from '../audioEvents'
import { shellHttpBase } from '../shellHttp'
import {
  loadShellAudioState,
  setShellAudioDefault,
  setShellAudioMute,
  setShellAudioVolume,
  type ShellAudioDevice,
  type ShellAudioState,
  type ShellAudioStream,
} from './audioState'

type AudioRow = ShellAudioDevice | ShellAudioStream

function isAudioDevice(row: AudioRow): row is ShellAudioDevice {
  return 'is_default' in row
}

function sliderMax(row: AudioRow): number {
  return Math.max(150, Math.min(200, row.volume_percent))
}

export function SettingsSoundPage() {
  const [state, setState] = createSignal<ShellAudioState | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | null>(null)
  const [actionErr, setActionErr] = createSignal<string | null>(null)
  const [busyIds, setBusyIds] = createSignal<number[]>([])
  const pendingVolumeTimers = new Map<number, number>()
  let externalRefreshTimer: number | undefined

  function isBusyId(id: number) {
    return busyIds().includes(id)
  }

  function setBusyId(id: number, next: boolean) {
    setBusyIds((prev) => {
      if (next) return prev.includes(id) ? prev : [...prev, id]
      return prev.filter((value) => value !== id)
    })
  }

  function updateLocalRow(
    id: number,
    apply: (row: ShellAudioDevice | ShellAudioStream) => ShellAudioDevice | ShellAudioStream,
  ) {
    setState((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        sinks: prev.sinks.map((row) => (row.id === id ? (apply(row) as ShellAudioDevice) : row)),
        sources: prev.sources.map((row) => (row.id === id ? (apply(row) as ShellAudioDevice) : row)),
        playback_streams: prev.playback_streams.map((row) =>
          row.id === id ? (apply(row) as ShellAudioStream) : row,
        ),
        capture_streams: prev.capture_streams.map((row) =>
          row.id === id ? (apply(row) as ShellAudioStream) : row,
        ),
      }
    })
  }

  async function load() {
    const base = shellHttpBase()
    if (!base) {
      setErr('Needs cef_host control server to read PipeWire audio state.')
      setState(null)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      setState(await loadShellAudioState(base))
    } catch (error) {
      setState(null)
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function runAction(id: number, action: () => Promise<void>) {
    const base = shellHttpBase()
    if (!base) {
      setActionErr('Needs cef_host control server to update audio state.')
      return
    }
    setBusyId(id, true)
    setActionErr(null)
    try {
      await action()
      await load()
    } catch (error) {
      setActionErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyId(id, false)
    }
  }

  function queueVolume(id: number, nextVolume: number) {
    const volume = Math.max(0, Math.min(200, Math.round(nextVolume)))
    updateLocalRow(id, (row) => ({
      ...row,
      volume_percent: volume,
      volume_known: true,
    }))
    const prevTimer = pendingVolumeTimers.get(id)
    if (prevTimer !== undefined) window.clearTimeout(prevTimer)
    const timer = window.setTimeout(() => {
      pendingVolumeTimers.delete(id)
      void runAction(id, () => setShellAudioVolume(id, volume, shellHttpBase()))
    }, 140)
    pendingVolumeTimers.set(id, timer)
  }

  function toggleMute(row: AudioRow) {
    updateLocalRow(row.id, (current) => ({
      ...current,
      muted: !current.muted,
    }))
    void runAction(row.id, () => setShellAudioMute(row.id, !row.muted, shellHttpBase()))
  }

  function makeDefault(row: ShellAudioDevice) {
    void runAction(row.id, () => setShellAudioDefault(row.id, shellHttpBase()))
  }

  onMount(() => {
    void load()
    const onAudioStateChanged = () => {
      if (externalRefreshTimer !== undefined) window.clearTimeout(externalRefreshTimer)
      externalRefreshTimer = window.setTimeout(() => {
        externalRefreshTimer = undefined
        void load()
      }, 120)
    }
    window.addEventListener(DERP_AUDIO_STATE_CHANGED_EVENT, onAudioStateChanged)
    onCleanup(() => {
      window.removeEventListener(DERP_AUDIO_STATE_CHANGED_EVENT, onAudioStateChanged)
    })
  })

  onCleanup(() => {
    for (const timer of pendingVolumeTimers.values()) window.clearTimeout(timer)
    pendingVolumeTimers.clear()
    if (externalRefreshTimer !== undefined) window.clearTimeout(externalRefreshTimer)
  })

  function audioRow(row: AudioRow, allowDefault: boolean) {
    const deviceRow = isAudioDevice(row) ? row : null
    return (
      <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface-elevated) p-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-[0.84rem] font-semibold text-(--shell-text)">{row.label}</div>
            <Show when={row.subtitle}>
              <div class="mt-1 break-all text-[0.74rem] text-(--shell-text-dim)">{row.subtitle}</div>
            </Show>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Show when={allowDefault && deviceRow?.is_default}>
              <span class="rounded-md border border-(--shell-accent-border) bg-(--shell-accent-soft) px-2 py-1 text-[0.68rem] font-semibold uppercase tracking-wide text-(--shell-accent-soft-text)">
                Default
              </span>
            </Show>
            <Show when={allowDefault && deviceRow && !deviceRow.is_default}>
              <button
                type="button"
                class="cursor-pointer rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2 py-1 text-[0.74rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
                disabled={isBusyId(row.id) || !shellHttpBase()}
                onClick={() => makeDefault(deviceRow!)}
              >
                Make default
              </button>
            </Show>
            <button
              type="button"
              class="cursor-pointer rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2 py-1 text-[0.74rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
              disabled={isBusyId(row.id) || !shellHttpBase()}
              onClick={() => toggleMute(row)}
            >
              {row.muted ? 'Unmute' : 'Mute'}
            </button>
          </div>
        </div>
        <div class="mt-3 flex items-center gap-3">
          <input
            type="range"
            min="0"
            max={sliderMax(row)}
            value={row.volume_percent}
            disabled={!shellHttpBase()}
            class="h-2 w-full cursor-pointer accent-(--shell-accent) disabled:cursor-default"
            onInput={(event) => queueVolume(row.id, event.currentTarget.valueAsNumber)}
          />
          <span class="w-14 shrink-0 text-right text-[0.76rem] text-(--shell-text-muted)">
            {row.volume_known ? `${row.volume_percent}%` : 'Unknown'}
          </span>
        </div>
      </div>
    )
  }

  function sectionTitle(title: string, body: string) {
    return (
      <div class="mb-3">
        <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">{title}</p>
        <p class="mt-1 text-[0.78rem] leading-relaxed text-(--shell-text-dim)">{body}</p>
      </div>
    )
  }

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-base font-semibold tracking-wide text-(--shell-text)">Sound</h2>
        <button
          type="button"
          class="cursor-pointer rounded-lg border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2.5 py-1.5 text-[0.78rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
          disabled={busy() || !shellHttpBase()}
          onClick={() => void load()}
        >
          {busy() ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      <p class="text-[0.78rem] leading-relaxed text-(--shell-text-dim)">
        Uses PipeWire/WirePlumber control via <span class="text-(--shell-text-muted)">wpctl</span>{' '}
        from the compositor control server.
      </p>
      <Show when={err()}>
        <p class="text-(--shell-warning-text) text-[0.8rem]">{err()}</p>
      </Show>
      <Show when={actionErr()}>
        <p class="text-(--shell-warning-text) text-[0.8rem]">{actionErr()}</p>
      </Show>
      <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface) px-3 py-3 text-(--shell-text)">
        {sectionTitle(
          'Output devices',
          'Pick the default playback target and adjust device-level volume.',
        )}
        <Show when={(state()?.sinks.length ?? 0) > 0} fallback={<p class="text-[0.78rem] text-(--shell-text-dim)">No output devices found.</p>}>
          <div class="space-y-3">
            <For each={state()?.sinks ?? []}>{(row) => audioRow(row, true)}</For>
          </div>
        </Show>
      </div>
      <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface) px-3 py-3 text-(--shell-text)">
        {sectionTitle(
          'Microphones',
          'Pick the default capture source and adjust microphone-level volume.',
        )}
        <Show when={(state()?.sources.length ?? 0) > 0} fallback={<p class="text-[0.78rem] text-(--shell-text-dim)">No microphones found.</p>}>
          <div class="space-y-3">
            <For each={state()?.sources ?? []}>{(row) => audioRow(row, true)}</For>
          </div>
        </Show>
      </div>
      <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface) px-3 py-3 text-(--shell-text)">
        {sectionTitle(
          'Volume mixer',
          'Adjust active playback and recording streams without changing the default devices.',
        )}
        <div class="space-y-4">
          <div>
            <p class="mb-2 text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
              Playback streams
            </p>
            <Show
              when={(state()?.playback_streams.length ?? 0) > 0}
              fallback={<p class="text-[0.78rem] text-(--shell-text-dim)">No active playback streams.</p>}
            >
              <div class="space-y-3">
                <For each={state()?.playback_streams ?? []}>{(row) => audioRow(row, false)}</For>
              </div>
            </Show>
          </div>
          <div>
            <p class="mb-2 text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
              Capture streams
            </p>
            <Show
              when={(state()?.capture_streams.length ?? 0) > 0}
              fallback={<p class="text-[0.78rem] text-(--shell-text-dim)">No active capture streams.</p>}
            >
              <div class="space-y-3">
                <For each={state()?.capture_streams ?? []}>{(row) => audioRow(row, false)}</For>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
