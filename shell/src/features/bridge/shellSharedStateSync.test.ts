import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentShellMeasureFrame } from './shellMeasureFrame'
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

  it('coalesces overlay exclusion scheduling into microtask and frame phases', async () => {
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
    expect(calls).toEqual(['schedule'])
    await flushMicrotasks()
    expect(calls).toEqual(['schedule', 'schedule'])
  })

  it('shares one measurement frame across immediate shell ui and exclusion sync', () => {
    const rect = {
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    } as DOMRect
    const main = {
      getBoundingClientRect: vi.fn(() => rect),
    } as unknown as HTMLElement
    const frames: unknown[] = []
    const sync = createShellSharedStateSync({
      invalidateAllShellUiWindows: () => frames.push(currentShellMeasureFrame()),
      flushShellUiWindowsSyncNow: () => frames.push(currentShellMeasureFrame()),
      scheduleExclusionZonesSync: () => frames.push(currentShellMeasureFrame()),
      syncExclusionZonesNow: () => frames.push(currentShellMeasureFrame()),
      measureEnv: () => ({ main, outputGeom: { w: 100, h: 100 }, origin: null }),
    })

    sync.requestSharedStateSync({ shellUi: 'flush', exclusion: 'sync' }, 'now')

    expect(main.getBoundingClientRect).toHaveBeenCalledTimes(1)
    expect(frames).toHaveLength(2)
    expect(frames[0]).toBe(frames[1])
  })
})
