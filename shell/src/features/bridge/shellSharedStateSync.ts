import { type ShellMeasureEnv, withShellMeasureFrame } from './shellMeasureFrame'
import { noteShellSharedStateSync } from './shellPerfCounters'

export type ShellSharedStateSyncRequest = {
  shellUi?: 'invalidate-all' | 'flush'
  exclusion?: 'schedule' | 'sync'
}

type ShellSharedStateSyncOptions = {
  invalidateAllShellUiWindows: () => void
  flushShellUiWindowsSyncNow: () => void
  scheduleExclusionZonesSync: () => void
  syncExclusionZonesNow: () => void
  measureEnv?: () => ShellMeasureEnv | null
}

function mergeShellUi(
  current: ShellSharedStateSyncRequest['shellUi'] | undefined,
  next: ShellSharedStateSyncRequest['shellUi'] | undefined,
) {
  if (current === 'flush' || next === 'flush') return 'flush'
  return next ?? current
}

function mergeExclusion(
  current: ShellSharedStateSyncRequest['exclusion'] | undefined,
  next: ShellSharedStateSyncRequest['exclusion'] | undefined,
) {
  if (current === 'sync' || next === 'sync') return 'sync'
  return next ?? current
}

export function createShellSharedStateSync(options: ShellSharedStateSyncOptions) {
  let microtaskQueued = false
  let overlayExclusionFollowupQueued = false
  let queuedShellUi: ShellSharedStateSyncRequest['shellUi'] | undefined
  let queuedExclusion: ShellSharedStateSyncRequest['exclusion'] | undefined

  const run = (request: ShellSharedStateSyncRequest) => {
    const start = performance.now()
    const apply = () => {
      if (request.shellUi === 'invalidate-all') options.invalidateAllShellUiWindows()
      if (request.shellUi === 'flush') options.flushShellUiWindowsSyncNow()
      if (request.exclusion === 'sync') {
        options.syncExclusionZonesNow()
      } else if (request.exclusion === 'schedule') {
        options.scheduleExclusionZonesSync()
      }
    }
    try {
      if (options.measureEnv) {
        withShellMeasureFrame(options.measureEnv, apply)
        return
      }
      apply()
    } finally {
      noteShellSharedStateSync(performance.now() - start)
    }
  }

  const flushQueued = () => {
    microtaskQueued = false
    const request = {
      shellUi: queuedShellUi,
      exclusion: queuedExclusion,
    }
    queuedShellUi = undefined
    queuedExclusion = undefined
    run(request)
  }

  const requestSharedStateSync = (
    request: ShellSharedStateSyncRequest,
    timing: 'now' | 'microtask' = 'microtask',
  ) => {
    if (timing === 'now') {
      run(request)
      return
    }
    queuedShellUi = mergeShellUi(queuedShellUi, request.shellUi)
    queuedExclusion = mergeExclusion(queuedExclusion, request.exclusion)
    if (microtaskQueued) return
    microtaskQueued = true
    queueMicrotask(flushQueued)
  }

  const scheduleOverlayExclusionSync = () => {
    requestSharedStateSync({ exclusion: 'sync' })
    if (overlayExclusionFollowupQueued) return
    overlayExclusionFollowupQueued = true
    queueMicrotask(() => {
      overlayExclusionFollowupQueued = false
      requestSharedStateSync({ exclusion: 'schedule' }, 'now')
    })
  }

  return {
    requestSharedStateSync,
    scheduleOverlayExclusionSync,
  }
}
