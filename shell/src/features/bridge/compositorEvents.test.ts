import { afterEach, describe, expect, it, vi } from 'vitest'
import { installCompositorBatchHandler } from './compositorEvents'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('installCompositorBatchHandler', () => {
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
})
