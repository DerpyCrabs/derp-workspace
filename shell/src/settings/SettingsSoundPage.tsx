import { For, Show } from 'solid-js'
import { shellAudioSectionTitle, ShellAudioRow } from './ShellAudioControls'
import { useShellAudioState } from './useShellAudioState'

export function SettingsSoundPage() {
  const audio = useShellAudioState()

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-base font-semibold tracking-wide text-(--shell-text)">Sound</h2>
        <button
          type="button"
          class="cursor-pointer rounded-lg border border-(--shell-border-strong) bg-(--shell-control-muted-bg) px-2.5 py-1.5 text-[0.78rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
          disabled={audio.busy() || !audio.hasControlServer()}
          onClick={() => void audio.refresh()}
        >
          {audio.busy() ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      <p class="text-[0.78rem] leading-relaxed text-(--shell-text-dim)">
        Uses PipeWire/WirePlumber control via <span class="text-(--shell-text-muted)">wpctl</span>{' '}
        from the compositor control server.
      </p>
      <Show when={audio.err()}>
        <p class="text-(--shell-warning-text) text-[0.8rem]">{audio.err()}</p>
      </Show>
      <Show when={audio.actionErr()}>
        <p class="text-(--shell-warning-text) text-[0.8rem]">{audio.actionErr()}</p>
      </Show>
      <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface) px-3 py-3 text-(--shell-text)">
        {shellAudioSectionTitle(
          'Output devices',
          'Pick the default playback target and adjust device-level volume.',
        )}
        <Show when={(audio.state()?.sinks.length ?? 0) > 0} fallback={<p class="text-[0.78rem] text-(--shell-text-dim)">No output devices found.</p>}>
          <div class="space-y-3">
            <For each={audio.state()?.sinks ?? []}>
              {(row) => (
                <ShellAudioRow
                  row={row}
                  allowDefault={true}
                  busy={audio.isBusyId(row.id) || !audio.hasControlServer()}
                  onToggleMute={audio.toggleMute}
                  onQueueVolume={audio.queueVolume}
                  onMakeDefault={audio.makeDefault}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
      <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface) px-3 py-3 text-(--shell-text)">
        {shellAudioSectionTitle(
          'Microphones',
          'Pick the default capture source and adjust microphone-level volume.',
        )}
        <Show when={(audio.state()?.sources.length ?? 0) > 0} fallback={<p class="text-[0.78rem] text-(--shell-text-dim)">No microphones found.</p>}>
          <div class="space-y-3">
            <For each={audio.state()?.sources ?? []}>
              {(row) => (
                <ShellAudioRow
                  row={row}
                  allowDefault={true}
                  busy={audio.isBusyId(row.id) || !audio.hasControlServer()}
                  onToggleMute={audio.toggleMute}
                  onQueueVolume={audio.queueVolume}
                  onMakeDefault={audio.makeDefault}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
      <div class="rounded-lg border border-(--shell-border) bg-(--shell-surface) px-3 py-3 text-(--shell-text)">
        {shellAudioSectionTitle(
          'Volume mixer',
          'Adjust active playback and recording streams without changing the default devices.',
        )}
        <div class="space-y-4">
          <div>
            <p class="mb-2 text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
              Playback streams
            </p>
            <Show
              when={(audio.state()?.playback_streams.length ?? 0) > 0}
              fallback={<p class="text-[0.78rem] text-(--shell-text-dim)">No active playback streams.</p>}
            >
              <div class="space-y-3">
                <For each={audio.state()?.playback_streams ?? []}>
                  {(row) => (
                    <ShellAudioRow
                      row={row}
                      allowDefault={false}
                      busy={audio.isBusyId(row.id) || !audio.hasControlServer()}
                      onToggleMute={audio.toggleMute}
                      onQueueVolume={audio.queueVolume}
                    />
                  )}
                </For>
              </div>
            </Show>
          </div>
          <div>
            <p class="mb-2 text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
              Capture streams
            </p>
            <Show
              when={(audio.state()?.capture_streams.length ?? 0) > 0}
              fallback={<p class="text-[0.78rem] text-(--shell-text-dim)">No active capture streams.</p>}
            >
              <div class="space-y-3">
                <For each={audio.state()?.capture_streams ?? []}>
                  {(row) => (
                    <ShellAudioRow
                      row={row}
                      allowDefault={false}
                      busy={audio.isBusyId(row.id) || !audio.hasControlServer()}
                      onToggleMute={audio.toggleMute}
                      onQueueVolume={audio.queueVolume}
                    />
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
