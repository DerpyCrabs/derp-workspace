import { afterEach, describe, expect, it, vi } from 'vitest'
import { createShellSharedStateSync } from './shellSharedStateSync'

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createShellSharedStateSync', () => {
  it('coalesces microtask requests and flushes ui before syncing exclusions', async () => {
    const calls: string[] = []
    const sync = createShellSharedStateSync({
      invalidateAllShellUiWindows: () => calls.push('invalidate'),
      flushShellUiWindowsSyncNow: () => calls.push('flush'),
      scheduleExclusionZonesSync: () => calls.push('schedule'),
      syncExclusionZonesNow: () => calls.push('sync'),
    })

    sync.requestSharedStateSync({ shellUi: 'invalidate-all', exclusion: 'schedule' })
    sync.requestSharedStateSync({ shellUi: 'flush', exclusion: 'sync' })
    await flushMicrotasks()

    expect(calls).toEqual(['flush', 'sync'])
  })

  it('keeps overlay exclusion scheduling in now microtask and frame phases', async () => {
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      fn(0)
      return 1
    })
    const calls: string[] = []
    const sync = createShellSharedStateSync({
      invalidateAllShellUiWindows: () => calls.push('invalidate'),
      flushShellUiWindowsSyncNow: () => calls.push('flush'),
      scheduleExclusionZonesSync: () => calls.push('schedule'),
      syncExclusionZonesNow: () => calls.push('sync'),
    })

    sync.scheduleOverlayExclusionSync()
    expect(calls).toEqual(['schedule', 'schedule'])
    await flushMicrotasks()
    expect(calls).toEqual(['schedule', 'schedule', 'schedule'])
  })
})
