import { For, Show } from 'solid-js'
import type { Accessor, Setter } from 'solid-js'
import type { SetStoreFunction } from 'solid-js/store'
import { TransformPicker } from './TransformPicker'
import { LayoutTypePicker } from './LayoutTypePicker'
import { getMonitorLayout } from './tilingConfig'
import type { PerMonitorTileStates } from './tileState'

export type SettingsLayoutScreen = {
  name: string
  x: number
  y: number
  width: number
  height: number
  transform: number
  refresh_milli_hz: number
}

export type SettingsPanelProps = {
  screenDraft: { rows: SettingsLayoutScreen[] }
  setScreenDraft: SetStoreFunction<{ rows: SettingsLayoutScreen[] }>
  shellChromePrimaryName: Accessor<string | null>
  autoShellChromeMonitorName: Accessor<string | null>
  canSessionControl: Accessor<boolean>
  uiScalePercent: Accessor<100 | 150 | 200>
  orientationPickerOpen: Accessor<number | null>
  setOrientationPickerOpen: Setter<number | null>
  tilingCfgRev: Accessor<number>
  setTilingCfgRev: Setter<number>
  perMonitorTiles: PerMonitorTileStates
  bumpSnapChrome: () => void
  scheduleExclusionZonesSync: () => void
  applyAutoLayout: (monitorName: string) => void
  setShellPrimary: (name: string) => void
  setUiScale: (pct: 100 | 150 | 200) => void
  applyCompositorLayoutFromDraft: () => void
  spawnUrlLine: Accessor<string>
  spawnCommand: Accessor<string>
  setSpawnCommand: Setter<string>
  spawnBusy: Accessor<boolean>
  spawnStatus: Accessor<string | null>
  onRunNative: () => void
  onSpawnBtnPointerDown: () => void
  monitorRefreshLabel: (milli: number) => string
}

export function SettingsPanel(props: SettingsPanelProps) {
  return (
    <div class="px-5 py-4 text-left [&_strong]:text-shell-hud-strong">
      <h1 class="mb-3 text-lg font-semibold tracking-wide text-neutral-100">Settings</h1>
      <div class="mb-3 max-w-none rounded-lg bg-black/25 px-3 py-[0.65rem]">
        <h2 class="mb-2 text-[0.72rem] font-semibold">Monitors</h2>
        <div class="mb-[0.6rem] flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8rem]">
          <span class="mr-1 opacity-90">Shell panel + taskbar</span>
          <button
            type="button"
            class="cursor-pointer rounded-[0.3rem] border border-white/28 bg-black/35 px-[0.55rem] py-1 font-inherit text-inherit hover:bg-[rgba(40,100,170,0.45)] disabled:cursor-default disabled:opacity-[0.55]"
            classList={{
              'border-[rgba(160,200,255,0.45)] bg-[rgba(30,80,140,0.55)] disabled:opacity-[0.85]':
                !props.shellChromePrimaryName(),
            }}
            disabled={!props.canSessionControl() || !props.shellChromePrimaryName()}
            title={
              !props.canSessionControl() ? 'Needs cef_host wire' : 'Use top-left output (min x, then y)'
            }
            onClick={() => props.setShellPrimary('')}
          >
            Auto
          </button>
        </div>
        <div class="mb-[0.6rem] flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8rem]">
          <span class="mr-1 opacity-90">UI scale (all heads)</span>
          <button
            type="button"
            class="cursor-pointer rounded-[0.3rem] border border-white/28 bg-black/35 px-[0.55rem] py-1 font-inherit text-inherit hover:bg-[rgba(40,100,170,0.45)] disabled:cursor-default disabled:opacity-[0.55]"
            classList={{
              'border-[rgba(160,200,255,0.45)] bg-[rgba(30,80,140,0.55)] disabled:opacity-[0.85]':
                props.uiScalePercent() === 100,
            }}
            disabled={!props.canSessionControl() || props.uiScalePercent() === 100}
            title={!props.canSessionControl() ? 'Needs cef_host wire' : undefined}
            onClick={() => props.setUiScale(100)}
          >
            100%
          </button>
          <button
            type="button"
            class="cursor-pointer rounded-[0.3rem] border border-white/28 bg-black/35 px-[0.55rem] py-1 font-inherit text-inherit hover:bg-[rgba(40,100,170,0.45)] disabled:cursor-default disabled:opacity-[0.55]"
            classList={{
              'border-[rgba(160,200,255,0.45)] bg-[rgba(30,80,140,0.55)] disabled:opacity-[0.85]':
                props.uiScalePercent() === 150,
            }}
            disabled={!props.canSessionControl() || props.uiScalePercent() === 150}
            title={!props.canSessionControl() ? 'Needs cef_host wire' : undefined}
            onClick={() => props.setUiScale(150)}
          >
            150%
          </button>
          <button
            type="button"
            class="cursor-pointer rounded-[0.3rem] border border-white/28 bg-black/35 px-[0.55rem] py-1 font-inherit text-inherit hover:bg-[rgba(40,100,170,0.45)] disabled:cursor-default disabled:opacity-[0.55]"
            classList={{
              'border-[rgba(160,200,255,0.45)] bg-[rgba(30,80,140,0.55)] disabled:opacity-[0.85]':
                props.uiScalePercent() === 200,
            }}
            disabled={!props.canSessionControl() || props.uiScalePercent() === 200}
            title={!props.canSessionControl() ? 'Needs cef_host wire' : undefined}
            onClick={() => props.setUiScale(200)}
          >
            200%
          </button>
        </div>
        <ul class="mb-2.5 list-none pl-[18px] text-xs leading-snug text-neutral-200">
          <For
            each={props.screenDraft.rows}
            fallback={
              <li class="list-disc text-[hsl(45,85%,72%)]">
                No outputs listed — compositor should send <code>output_layout</code> with one entry per
                head.
              </li>
            }
          >
            {(row) => (
              <li class="mb-1.5 list-disc">
                <div class="flex flex-wrap items-start justify-between gap-x-2.5 gap-y-1.5">
                  <div class="min-w-0 flex-[1_1_12rem]">
                    <span class="font-semibold text-neutral-100">{row.name || '—'}</span>
                    <span class="opacity-92">
                      @ {row.x},{row.y} · {row.width}×{row.height} ·{' '}
                      {props.monitorRefreshLabel(row.refresh_milli_hz)} · orientation {row.transform}
                      {!props.shellChromePrimaryName() &&
                      row.name &&
                      row.name === props.autoShellChromeMonitorName() ? (
                        <span class="font-semibold text-shell-accent-badge"> · auto</span>
                      ) : null}
                    </span>
                  </div>
                  <button
                    type="button"
                    class="shrink-0 cursor-pointer whitespace-nowrap rounded-[0.3rem] border border-white/28 bg-black/35 px-[0.45rem] py-0.5 text-[0.72rem] font-semibold tracking-wide text-inherit hover:bg-[rgba(40,100,170,0.45)] disabled:cursor-default disabled:opacity-[0.55]"
                    classList={{
                      'border-[rgba(160,200,255,0.45)] bg-[rgba(30,80,140,0.55)] disabled:opacity-[0.85]':
                        !!props.shellChromePrimaryName() && props.shellChromePrimaryName() === row.name,
                    }}
                    disabled={!props.canSessionControl()}
                    title={
                      !props.canSessionControl() ? 'Needs cef_host wire' : 'Show panel and taskbar on this head'
                    }
                    onClick={() => props.setShellPrimary(row.name)}
                  >
                    Shell chrome
                  </button>
                </div>
              </li>
            )}
          </For>
        </ul>
        <Show
          when={props.screenDraft.rows.length > 0}
          fallback={
            <p class="mb-2 text-[0.78rem] opacity-[0.88]">
              Position/orientation editor unlocks once screens are known.
            </p>
          }
        >
          <For each={props.screenDraft.rows}>
            {(row, i) => (
              <div class="mb-[0.45rem] flex flex-wrap items-center gap-x-[0.65rem] gap-y-[0.45rem] text-[0.82rem]">
                <span class="min-w-0 flex-[1_1_6rem] font-mono opacity-92">{row.name}</span>
                <label class="uppercase flex flex-col gap-[0.15rem] text-[0.7rem] tracking-wide opacity-80">
                  x
                  <input
                    type="number"
                    class="w-[4.5rem] rounded border border-white/25 bg-black/35 px-[0.35rem] py-0.5 text-inherit"
                    value={row.x}
                    onInput={(e) =>
                      props.setScreenDraft('rows', i(), 'x', Number(e.currentTarget.value) || 0)
                    }
                  />
                </label>
                <label class="uppercase flex flex-col gap-[0.15rem] text-[0.7rem] tracking-wide opacity-80">
                  y
                  <input
                    type="number"
                    class="w-[4.5rem] rounded border border-white/25 bg-black/35 px-[0.35rem] py-0.5 text-inherit"
                    value={row.y}
                    onInput={(e) =>
                      props.setScreenDraft('rows', i(), 'y', Number(e.currentTarget.value) || 0)
                    }
                  />
                </label>
                <label class="flex flex-col gap-[0.15rem] text-[0.7rem] tracking-wide opacity-80 [&_.relative]:mt-[0.15rem]">
                  orientation
                  <TransformPicker
                    value={row.transform}
                    rowIndex={i()}
                    openIndex={props.orientationPickerOpen}
                    setOpenIndex={props.setOrientationPickerOpen}
                    onChange={(v) => props.setScreenDraft('rows', i(), 'transform', v)}
                  />
                </label>
                <LayoutTypePicker
                  outputName={row.name}
                  revision={props.tilingCfgRev}
                  onPersisted={() => {
                    props.setTilingCfgRev((n) => n + 1)
                    const name = row.name
                    queueMicrotask(() => {
                      if (getMonitorLayout(name).layout.type === 'manual-snap') {
                        props.perMonitorTiles.stateFor(name).clearAllTiled()
                        props.bumpSnapChrome()
                        props.scheduleExclusionZonesSync()
                      } else {
                        props.applyAutoLayout(name)
                      }
                    })
                  }}
                />
                <span class="text-[0.75rem] opacity-65">
                  {row.width}×{row.height} · {props.monitorRefreshLabel(row.refresh_milli_hz)}
                </span>
              </div>
            )}
          </For>
          <button
            type="button"
            class="mt-2 cursor-pointer rounded-[0.35rem] border border-white/28 bg-[rgba(30,80,140,0.55)] px-3 py-1.5 text-[0.85rem] hover:bg-[rgba(40,100,170,0.65)]"
            onClick={() => props.applyCompositorLayoutFromDraft()}
          >
            Apply layout to compositor
          </button>
        </Show>
      </div>
      <p class="mb-[0.85rem] max-w-[22rem] text-[0.72rem] leading-snug break-all opacity-[0.88]">
        {props.spawnUrlLine()}
      </p>
      <label class="mb-[0.65rem] block max-w-[22rem]">
        <span class="mb-[0.35rem] block text-[0.72rem] opacity-[0.88]">
          Command (`sh -c`, nested Wayland display)
        </span>
        <input
          class="box-border w-full rounded-[0.4rem] border border-white/25 bg-black/35 px-[0.55rem] py-[0.45rem] text-[0.9rem] text-inherit"
          type="text"
          value={props.spawnCommand()}
          onInput={(e) => props.setSpawnCommand(e.currentTarget.value)}
          autocomplete="off"
          spellcheck={false}
        />
      </label>
      <button
        type="button"
        class="mt-1 cursor-pointer rounded-lg border-0 bg-shell-btn-primary px-[1.2rem] py-[0.6rem] text-[0.95rem] font-semibold tracking-wide text-neutral-900 shadow-[0_0.15rem_0.5rem_rgba(0,0,0,0.25)] hover:brightness-[1.06] disabled:cursor-wait disabled:opacity-65"
        disabled={props.spawnBusy()}
        onPointerDown={() => props.onSpawnBtnPointerDown()}
        onClick={() => props.onRunNative()}
      >
        {props.spawnBusy() ? 'Spawning…' : 'Run native app in compositor'}
      </button>
      <Show when={props.spawnStatus()}>
        {(st) => (
          <p class="mt-[0.85rem] max-w-[22rem] text-[0.875rem] leading-snug opacity-90">{st()}</p>
        )}
      </Show>
    </div>
  )
}
