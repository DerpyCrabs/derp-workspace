import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeCompositorHotBatch,
  installCompositorBatchHandler,
  installCompositorSnapshotHandler,
} from './compositorEvents'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('installCompositorBatchHandler', () => {
  const hotBatch = () => {
    const outputId = new TextEncoder().encode('dp-1')
    const outputName = new TextEncoder().encode('DP-1')
    const bytes = new ArrayBuffer(8 + 1 + 8 + 25 + 4 + outputId.length + 4 + outputName.length)
    const view = new DataView(bytes)
    let offset = 0
    for (const value of [0x44, 0x48, 0x42, 0x31]) view.setUint8(offset++, value)
    view.setUint32(offset, 1, true)
    offset += 4
    view.setUint8(offset++, 1)
    view.setBigUint64(offset, 7n, true)
    offset += 8
    view.setUint32(offset, 42, true)
    view.setUint32(offset + 4, 84, true)
    view.setInt32(offset + 8, 10, true)
    view.setInt32(offset + 12, 20, true)
    view.setInt32(offset + 16, 640, true)
    view.setInt32(offset + 20, 480, true)
    view.setUint8(offset + 24, 1)
    offset += 25
    view.setUint32(offset, outputId.length, true)
    offset += 4
    new Uint8Array(bytes, offset, outputId.length).set(outputId)
    offset += outputId.length
    view.setUint32(offset, outputName.length, true)
    offset += 4
    new Uint8Array(bytes, offset, outputName.length).set(outputName)
    return bytes
  }

  it('forwards compositor batches to the installed handler', () => {
    const calls: unknown[][] = []
    vi.stubGlobal('window', {})
    const dispose = installCompositorBatchHandler((details) => {
      calls.push([...details])
    })

    window.__DERP_APPLY_COMPOSITOR_BATCH?.([{ type: 'compositor_ping' }])

    expect(calls).toEqual([[{ type: 'compositor_ping' }]])

    dispose()
  })

  it('restores the previous handler when disposed', () => {
    const previous = vi.fn()
    vi.stubGlobal('window', {
      __DERP_APPLY_COMPOSITOR_BATCH: previous,
    })
    const dispose = installCompositorBatchHandler(() => {})

    dispose()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([{ type: 'compositor_ping' }])

    expect(window.__DERP_APPLY_COMPOSITOR_BATCH).toBe(previous)
    expect(previous).toHaveBeenCalledWith([{ type: 'compositor_ping' }])
  })

  it('ignores non-array payloads', () => {
    const handler = vi.fn()
    vi.stubGlobal('window', {})
    installCompositorBatchHandler(handler)

    window.__DERP_APPLY_COMPOSITOR_BATCH?.({ type: 'compositor_ping' } as never)

    expect(handler).not.toHaveBeenCalled()
  })

  it('decodes hot binary compositor batches', () => {
    expect(decodeCompositorHotBatch(hotBatch())).toEqual([
      {
        type: 'window_geometry',
        window_id: 42,
        surface_id: 84,
        x: 10,
        y: 20,
        width: 640,
        height: 480,
        output_id: 'dp-1',
        output_name: 'DP-1',
        maximized: true,
        fullscreen: false,
        snapshot_epoch: 7,
      },
    ])
  })

  it('forwards hot binary compositor batches to the installed handler', () => {
    const handler = vi.fn()
    vi.stubGlobal('window', {})
    const dispose = installCompositorBatchHandler(handler)

    window.__DERP_APPLY_COMPOSITOR_BATCH_BINARY?.(hotBatch())

    expect(handler).toHaveBeenCalledWith([
      {
        type: 'window_geometry',
        window_id: 42,
        surface_id: 84,
        x: 10,
        y: 20,
        width: 640,
        height: 480,
        output_id: 'dp-1',
        output_name: 'DP-1',
        maximized: true,
        fullscreen: false,
        snapshot_epoch: 7,
      },
    ])

    dispose()
  })
})

describe('installCompositorSnapshotHandler', () => {
  it('forwards compositor snapshot sync to the installed handler', () => {
    const handler = vi.fn()
    vi.stubGlobal('window', {})
    const dispose = installCompositorSnapshotHandler(handler)

    window.__DERP_SYNC_COMPOSITOR_SNAPSHOT?.()

    expect(handler).toHaveBeenCalledTimes(1)

    dispose()
  })

  it('restores the previous handler when disposed', () => {
    const previous = vi.fn()
    vi.stubGlobal('window', {
      __DERP_SYNC_COMPOSITOR_SNAPSHOT: previous,
    })
    const dispose = installCompositorSnapshotHandler(() => {})

    dispose()
    window.__DERP_SYNC_COMPOSITOR_SNAPSHOT?.()

    expect(window.__DERP_SYNC_COMPOSITOR_SNAPSHOT).toBe(previous)
    expect(previous).toHaveBeenCalledTimes(1)
  })
})
