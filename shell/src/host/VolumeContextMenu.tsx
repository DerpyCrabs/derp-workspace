import Volume2 from 'lucide-solid/icons/volume-2'
import VolumeX from 'lucide-solid/icons/volume-x'
import { For, Show } from 'solid-js'
import { createMemo } from 'solid-js'
import { Select } from '@/host/Select'
import { ShellAudioRow } from '@/apps/settings/ShellAudioControls'
import type { ShellAudioDevice } from '@/apps/settings/audioState'
import { defaultAudioDevice, sliderMax, useShellAudioState } from '@/apps/settings/useShellAudioState'
import { useShellContextMenus } from './ShellContextMenusContext'

function audioDeviceSelectLabel(row: ShellAudioDevice | null, emptyLabel: string) {
  if (!row) return emptyLabel
  return row.label
}

function AudioDeviceControl(props: {
  row: ShellAudioDevice
  busy: boolean
  onToggleMute: (row: ShellAudioDevice) => void
  onQueueVolume: (id: number, nextVolume: number) => void
}) {
  return (
    <div class="flex items-center gap-2 rounded-md border border-(--shell-border) bg-(--shell-surface-elevated) px-2.5 py-2">
      <button
        type="button"
        class="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) disabled:cursor-default"
        disabled={props.busy}
        title={props.row.muted ? 'Unmute' : 'Mute'}
        aria-label={props.row.muted ? 'Unmute' : 'Mute'}
        onClick={() => props.onToggleMute(props.row)}
      >
        <Show when={props.row.muted} fallback={<Volume2 class="h-4 w-4" stroke-width={2} />}>
          <VolumeX class="h-4 w-4" stroke-width={2} />
        </Show>
      </button>
      <input
        type="range"
        min="0"
        max={sliderMax(props.row)}
        value={props.row.volume_percent}
        disabled={props.busy}
        class="h-2 w-full cursor-pointer accent-(--shell-accent) disabled:cursor-default"
        onInput={(event) => props.onQueueVolume(props.row.id, event.currentTarget.valueAsNumber)}
      />
      <span class="w-12 shrink-0 text-right text-[0.7rem] text-(--shell-text-muted)">
        {props.row.volume_known ? `${props.row.volume_percent}%` : 'Unknown'}
      </span>
    </div>
  )
}

export function VolumeContextMenu() {
  const props = useShellContextMenus().volumeMenuProps
  const audio = useShellAudioState()
  const defaultSink = () => defaultAudioDevice(audio.state()?.sinks ?? [])
  const defaultSource = () => defaultAudioDevice(audio.state()?.sources ?? [])

  const panelStyle = createMemo(() => {
    const bounds = props.bounds()
    const width = Math.min(480, Math.max(320, bounds.w - 16))
    return {
      right: `calc(100% - ${Math.round(props.anchor().x)}px)`,
      top: '8px',
      width: `${Math.round(width)}px`,
      'max-height': `${Math.max(240, bounds.h - 16)}px`,
    }
  })

  return (
    <div
      data-shell-volume-menu-panel
      class="border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) z-90000 absolute flex max-w-120 flex-col overflow-hidden rounded-[0.35rem] shadow-[0_16px_40px_rgba(0,0,0,0.34)]"
      role="dialog"
      aria-label="Volume"
      ref={(el) => {
        props.setPanelRef(el)
      }}
      style={panelStyle()}
    >
      <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto px-3 py-3">
        <Show when={audio.err() && !audio.state()}>
          <p class="text-(--shell-warning-text) text-[0.76rem]">{audio.err()}</p>
        </Show>
        <Show when={audio.actionErr()}>
          <p class="text-(--shell-warning-text) text-[0.76rem]">{audio.actionErr()}</p>
        </Show>
        <Show when={audio.state()}>
          <div class="space-y-3">
            <div class="space-y-2">
              <div class="text-[0.68rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
                Output
              </div>
              <Show
                when={(audio.state()?.sinks.length ?? 0) > 0}
                fallback={<p class="text-[0.74rem] text-(--shell-text-dim)">No output devices found.</p>}
              >
                <div class="space-y-2">
                  <div data-shell-volume-output-select>
                    <Select
                      options={audio.state()?.sinks ?? []}
                      value={defaultSink() ?? (audio.state()?.sinks?.[0] as ShellAudioDevice)}
                      onChange={(row) => audio.makeDefault(row as ShellAudioDevice)}
                      itemLabel={(row) => audioDeviceSelectLabel(row as ShellAudioDevice | null, 'No output devices')}
                      equals={(a, b) => (a as ShellAudioDevice).id === (b as ShellAudioDevice).id}
                      panelDataId="volume-output"
                      placement="floating"
                      contextMenuPolicy="preserve"
                      triggerClass="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) w-full cursor-pointer rounded px-[0.55rem] py-[0.45rem] text-left font-inherit text-[0.76rem]"
                      listClass="border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) absolute top-2 left-2 z-90000 flex max-h-52 min-w-48 flex-col overflow-y-auto rounded-[0.35rem] py-0.5 shadow-[0_12px_32px_rgba(0,0,0,0.28)]"
                    />
                  </div>
                  <Show when={defaultSink()}>
                    {(row) => (
                      <div data-shell-volume-output-default>
                        <AudioDeviceControl
                          row={row()}
                          busy={audio.isBusyId(row().id) || !audio.hasControlServer()}
                          onToggleMute={(next) => audio.toggleMute(next)}
                          onQueueVolume={audio.queueVolume}
                        />
                      </div>
                    )}
                  </Show>
                </div>
              </Show>
            </div>

            <div class="space-y-2">
              <div class="text-[0.68rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
                Input
              </div>
              <Show
                when={(audio.state()?.sources.length ?? 0) > 0}
                fallback={<p class="text-[0.74rem] text-(--shell-text-dim)">No microphones found.</p>}
              >
                <div class="space-y-2">
                  <div data-shell-volume-input-select>
                    <Select
                      options={audio.state()?.sources ?? []}
                      value={defaultSource() ?? (audio.state()?.sources?.[0] as ShellAudioDevice)}
                      onChange={(row) => audio.makeDefault(row as ShellAudioDevice)}
                      itemLabel={(row) => audioDeviceSelectLabel(row as ShellAudioDevice | null, 'No microphones')}
                      equals={(a, b) => (a as ShellAudioDevice).id === (b as ShellAudioDevice).id}
                      panelDataId="volume-input"
                      placement="floating"
                      contextMenuPolicy="preserve"
                      triggerClass="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) w-full cursor-pointer rounded px-[0.55rem] py-[0.45rem] text-left font-inherit text-[0.76rem]"
                      listClass="border border-(--shell-overlay-border) bg-(--shell-overlay) text-(--shell-text) absolute top-2 left-2 z-90000 flex max-h-52 min-w-48 flex-col overflow-y-auto rounded-[0.35rem] py-0.5 shadow-[0_12px_32px_rgba(0,0,0,0.28)]"
                    />
                  </div>
                  <Show when={defaultSource()}>
                    {(row) => (
                      <div data-shell-volume-input-default>
                        <AudioDeviceControl
                          row={row()}
                          busy={audio.isBusyId(row().id) || !audio.hasControlServer()}
                          onToggleMute={(next) => audio.toggleMute(next)}
                          onQueueVolume={audio.queueVolume}
                        />
                      </div>
                    )}
                  </Show>
                </div>
              </Show>
            </div>

            <Show
              when={(audio.state()?.playback_streams.length ?? 0) > 0}
              fallback={<p class="text-[0.74rem] text-(--shell-text-dim)">No active playback streams.</p>}
            >
              <div data-shell-volume-playback-list class="space-y-2">
                <For each={audio.state()?.playback_streams ?? []}>
                  {(row, idx) => (
                    <div data-shell-volume-playback-row={idx() === 0 ? 'first' : undefined}>
                      <ShellAudioRow
                        row={row}
                        allowDefault={false}
                        compact={true}
                        busy={audio.isBusyId(row.id) || !audio.hasControlServer()}
                        onToggleMute={audio.toggleMute}
                        onQueueVolume={audio.queueVolume}
                      />
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
