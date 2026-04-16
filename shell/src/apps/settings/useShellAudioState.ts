import { createSignal, type Accessor } from 'solid-js'
import { DERP_AUDIO_STATE_CHANGED_EVENT } from '@/features/audio/audioEvents'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import {
  loadShellAudioState,
  setShellAudioDefault,
  setShellAudioMute,
  setShellAudioVolume,
  type ShellAudioDevice,
  type ShellAudioState,
  type ShellAudioStream,
} from './audioState'

export type AudioRow = ShellAudioDevice | ShellAudioStream

export function isAudioDevice(row: AudioRow): row is ShellAudioDevice {
  return 'is_default' in row
}

export function sliderMax(_row: AudioRow): number {
  return 100
}

export function defaultAudioDevice(rows: ShellAudioDevice[]): ShellAudioDevice | null {
  return rows.find((row) => row.is_default) ?? rows[0] ?? null
}

export type ShellAudioController = {
  state: Accessor<ShellAudioState | null>
  busy: Accessor<boolean>
  err: Accessor<string | null>
  actionErr: Accessor<string | null>
  hasControlServer: Accessor<boolean>
  isBusyId: (id: number) => boolean
  refresh: () => Promise<void>
  queueVolume: (id: number, nextVolume: number) => void
  toggleMute: (row: AudioRow) => void
  makeDefault: (row: ShellAudioDevice) => void
}

const [sharedState, setSharedState] = createSignal<ShellAudioState | null>(null)
const [sharedBusy, setSharedBusy] = createSignal(false)
const [sharedErr, setSharedErr] = createSignal<string | null>(null)
const [sharedActionErr, setSharedActionErr] = createSignal<string | null>(null)
const [sharedBusyIds, setSharedBusyIds] = createSignal<number[]>([])

const pendingVolumeTimers = new Map<number, number>()
let backgroundRefreshTimer: number | undefined
let backgroundPollTimer: number | undefined
let started = false
let inflightRefresh: Promise<void> | null = null

function isBusyId(id: number) {
  return sharedBusyIds().includes(id)
}

function setBusyId(id: number, next: boolean) {
  setSharedBusyIds((prev) => {
    if (next) return prev.includes(id) ? prev : [...prev, id]
    return prev.filter((value) => value !== id)
  })
}

function updateLocalRow(id: number, apply: (row: AudioRow) => AudioRow) {
  setSharedState((prev) => {
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

async function refresh() {
  if (inflightRefresh) return inflightRefresh
  inflightRefresh = (async () => {
    const base = shellHttpBase()
    if (!base) {
      setSharedErr('Needs cef_host control server to read PipeWire audio state.')
      setSharedState(null)
      return
    }
    setSharedBusy(true)
    setSharedErr(null)
    try {
      setSharedState(await loadShellAudioState(base))
    } catch (error) {
      setSharedState(null)
      setSharedErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSharedBusy(false)
      inflightRefresh = null
    }
  })()
  return inflightRefresh
}

function backgroundPollDelay(): number {
  if (shellHttpBase() === null) return 400
  if (sharedState() === null) return 800
  if (typeof document === 'undefined') return 2500
  return document.visibilityState === 'visible' ? 2500 : 12000
}

function scheduleBackgroundPoll() {
  if (backgroundPollTimer !== undefined) window.clearTimeout(backgroundPollTimer)
  backgroundPollTimer = window.setTimeout(() => {
    backgroundPollTimer = undefined
    if (shellHttpBase() !== null) void refresh()
    scheduleBackgroundPoll()
  }, backgroundPollDelay())
}

function scheduleRefresh(delayMs: number) {
  if (backgroundRefreshTimer !== undefined) window.clearTimeout(backgroundRefreshTimer)
  backgroundRefreshTimer = window.setTimeout(() => {
    backgroundRefreshTimer = undefined
    void refresh()
  }, delayMs)
}

async function runAction(id: number, action: () => Promise<void>) {
  const base = shellHttpBase()
  if (!base) {
    setSharedActionErr('Needs cef_host control server to update audio state.')
    return
  }
  setBusyId(id, true)
  setSharedActionErr(null)
  try {
    await action()
    await refresh()
  } catch (error) {
    setSharedActionErr(error instanceof Error ? error.message : String(error))
  } finally {
    setBusyId(id, false)
  }
}

function queueVolume(id: number, nextVolume: number) {
  const volume = Math.max(0, Math.min(100, Math.round(nextVolume)))
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

function ensureStarted() {
  if (started || typeof window === 'undefined') return
  started = true
  void refresh()
  window.addEventListener(DERP_AUDIO_STATE_CHANGED_EVENT, () => scheduleRefresh(120))
  document.addEventListener('visibilitychange', () => {
    scheduleRefresh(100)
    scheduleBackgroundPoll()
  })
  scheduleBackgroundPoll()
}

const controller: ShellAudioController = {
  state: sharedState,
  busy: sharedBusy,
  err: sharedErr,
  actionErr: sharedActionErr,
  hasControlServer: () => shellHttpBase() !== null,
  isBusyId,
  refresh,
  queueVolume,
  toggleMute,
  makeDefault,
}

export function useShellAudioState(): ShellAudioController {
  ensureStarted()
  return controller
}
