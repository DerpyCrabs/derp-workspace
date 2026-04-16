import { For, Show } from 'solid-js'
import { createMemo } from 'solid-js'
import { Select } from '@/host/Select'
import { ShellAudioRow } from '@/apps/settings/ShellAudioControls'
import type { ShellAudioDevice } from '@/apps/settings/audioState'
import {
  defaultAudioDevice,
  type AudioRow,
  useShellAudioState,
} from '@/apps/settings/useShellAudioState'
import { useShellContextMenus } from './ShellContextMenusContext'

const EMPTY_AUDIO_DEVICES: ShellAudioDevice[] = []
const EMPTY_AUDIO_ROWS: AudioRow[] = []

function audioDeviceSelectLabel(row: ShellAudioDevice | null, emptyLabel: string) {
  if (!row) return emptyLabel
  return row.label
}

export function VolumeContextMenu() {
  const props = useShellContextMenus().volumeMenuProps
  const audio = useShellAudioState()
  const defaultSink = () => defaultAudioDevice(audio.state()?.sinks ?? EMPTY_AUDIO_DEVICES)
  const defaultSource = () => defaultAudioDevice(audio.state()?.sources ?? EMPTY_AUDIO_DEVICES)

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
                      options={audio.state()?.sinks ?? EMPTY_AUDIO_DEVICES}
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
                        <ShellAudioRow
                          row={row()}
                          allowDefault={false}
                          compact={true}
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
                      options={audio.state()?.sources ?? EMPTY_AUDIO_DEVICES}
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
                        <ShellAudioRow
                          row={row()}
                          allowDefault={false}
                          compact={true}
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
                <For each={audio.state()?.playback_streams ?? EMPTY_AUDIO_ROWS}>
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
