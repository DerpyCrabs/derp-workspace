import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sharedShellStateStampKey', () => {
  it('does not change when only the snapshot sequence advances', async () => {
    vi.stubGlobal('window', {
      __DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE: 10,
      __DERP_LAST_COMPOSITOR_STATE_EPOCH: 10,
      __DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION: 4,
    })
    const mod = await import('./sharedShellState')
    const first = mod.sharedShellStateStampKey()
    ;(window as Window & { __DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE?: number }).__DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE = 14
    ;(window as Window & { __DERP_LAST_COMPOSITOR_STATE_EPOCH?: number }).__DERP_LAST_COMPOSITOR_STATE_EPOCH = 14
    expect(mod.sharedShellStateStampKey()).toBe(first)
    ;(window as Window & { __DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION?: number }).__DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION = 5
    expect(mod.sharedShellStateStampKey()).not.toBe(first)
  })
})
