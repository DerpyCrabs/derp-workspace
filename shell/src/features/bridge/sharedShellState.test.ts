import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sharedShellStateStampKey', () => {
  it('tracks payload and layout stamps separately', async () => {
    vi.stubGlobal('window', {
      __DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE: 10,
      __DERP_LAST_COMPOSITOR_STATE_EPOCH: 10,
      __DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION: 4,
    })
    const mod = await import('./sharedShellState')
    const first = mod.sharedShellStateStampKey()
    const firstLayout = mod.sharedShellLayoutStampKey()
    ;(window as Window & { __DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE?: number }).__DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE = 14
    ;(window as Window & { __DERP_LAST_COMPOSITOR_STATE_EPOCH?: number }).__DERP_LAST_COMPOSITOR_STATE_EPOCH = 14
    expect(mod.sharedShellStateStampKey()).not.toBe(first)
    expect(mod.sharedShellLayoutStampKey()).toBe(firstLayout)
    const second = mod.sharedShellStateStampKey()
    ;(window as Window & { __DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION?: number }).__DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION = 5
    expect(mod.sharedShellStateStampKey()).not.toBe(second)
    expect(mod.sharedShellLayoutStampKey()).not.toBe(firstLayout)
  })

  it('stamps shell ui windows and exclusion payloads with compositor snapshot and output revisions', async () => {
    const write = vi.fn(() => true)
    vi.stubGlobal('window', {
      __DERP_LAST_COMPOSITOR_SNAPSHOT_SEQUENCE: 10,
      __DERP_LAST_COMPOSITOR_STATE_EPOCH: 14,
      __DERP_LAST_COMPOSITOR_OUTPUT_LAYOUT_REVISION: 5,
      __DERP_SHELL_UI_WINDOWS_STATE_PATH: '/tmp/ui-windows.bin',
      __DERP_SHELL_EXCLUSION_STATE_PATH: '/tmp/exclusion.bin',
      __derpShellSharedStateWrite: write,
    })
    const mod = await import('./sharedShellState')

    expect(mod.writeShellUiWindowsState(1, [{ id: 7, z: 2, gx: 10, gy: 20, gw: 300, gh: 200 }])).toBe(true)
    expect(mod.writeShellExclusionState([{ x: 1, y: 2, w: 3, h: 4 }], null, false, [])).toBe(true)

    expect(write).toHaveBeenCalledTimes(2)
    for (const [, payload] of write.mock.calls as unknown as Array<[string, ArrayBuffer, number, number]>) {
      const view = new DataView(payload)
      expect(Number(view.getBigUint64(0, true))).toBe(14)
      expect(Number(view.getBigUint64(8, true))).toBe(5)
    }
  })
})
