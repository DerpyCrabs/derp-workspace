import { createSignal, type Accessor } from 'solid-js'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import { loadShellBatteryState, type ShellBatteryState } from './batteryState'

export type ShellBatteryController = {
  state: Accessor<ShellBatteryState | null>
  busy: Accessor<boolean>
  err: Accessor<string | null>
  hasControlServer: Accessor<boolean>
  refresh: () => Promise<void>
}

const [sharedState, setSharedState] = createSignal<ShellBatteryState | null>(null)
const [sharedBusy, setSharedBusy] = createSignal(false)
const [sharedErr, setSharedErr] = createSignal<string | null>(null)

let backgroundPollTimer: number | undefined
let started = false
let inflightRefresh: Promise<void> | null = null

async function refresh() {
  if (inflightRefresh) return inflightRefresh
  inflightRefresh = (async () => {
    const base = shellHttpBase()
    if (!base) {
      setSharedErr('Needs cef_host control server to read battery state.')
      setSharedState(null)
      inflightRefresh = null
      return
    }
    setSharedBusy(true)
    setSharedErr(null)
    try {
      setSharedState(await loadShellBatteryState(base))
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
  if (shellHttpBase() === null) return 500
  if (sharedState() === null) return 1200
  if (typeof document === 'undefined') return 15000
  return document.visibilityState === 'visible' ? 15000 : 60000
}

function scheduleBackgroundPoll() {
  if (backgroundPollTimer !== undefined) window.clearTimeout(backgroundPollTimer)
  backgroundPollTimer = window.setTimeout(() => {
    backgroundPollTimer = undefined
    if (shellHttpBase() !== null) void refresh()
    scheduleBackgroundPoll()
  }, backgroundPollDelay())
}

function ensureStarted() {
  if (started || typeof window === 'undefined') return
  started = true
  void refresh()
  document.addEventListener('visibilitychange', () => {
    void refresh()
    scheduleBackgroundPoll()
  })
  scheduleBackgroundPoll()
}

const controller: ShellBatteryController = {
  state: sharedState,
  busy: sharedBusy,
  err: sharedErr,
  hasControlServer: () => shellHttpBase() !== null,
  refresh,
}

export function useShellBatteryState(): ShellBatteryController {
  ensureStarted()
  return controller
}
