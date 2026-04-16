import type { DerpShellDetail } from '@/host/appWindowState'

export const DERP_SHELL_EVENT = 'derp-shell'
export const DERP_SHELL_SNAPSHOT_EVENT = 'derp-shell-snapshot'

declare global {
  interface Window {
    __DERP_APPLY_COMPOSITOR_BATCH?: (details: readonly DerpShellDetail[]) => void
    __DERP_SYNC_COMPOSITOR_SNAPSHOT?: () => void
  }
}

export function installCompositorBatchHandler(
  handler: (details: readonly DerpShellDetail[]) => void,
): () => void {
  const previous = window.__DERP_APPLY_COMPOSITOR_BATCH
  const wrapped = (details: readonly DerpShellDetail[]) => {
    if (!Array.isArray(details) || details.length === 0) return
    handler(details)
  }
  window.__DERP_APPLY_COMPOSITOR_BATCH = wrapped
  return () => {
    if (window.__DERP_APPLY_COMPOSITOR_BATCH !== wrapped) return
    if (typeof previous === 'function') {
      window.__DERP_APPLY_COMPOSITOR_BATCH = previous
    } else {
      delete window.__DERP_APPLY_COMPOSITOR_BATCH
    }
  }
}

export function installCompositorSnapshotHandler(handler: () => void): () => void {
  const previous = window.__DERP_SYNC_COMPOSITOR_SNAPSHOT
  const wrapped = () => {
    handler()
  }
  window.__DERP_SYNC_COMPOSITOR_SNAPSHOT = wrapped
  return () => {
    if (window.__DERP_SYNC_COMPOSITOR_SNAPSHOT !== wrapped) return
    if (typeof previous === 'function') {
      window.__DERP_SYNC_COMPOSITOR_SNAPSHOT = previous
    } else {
      delete window.__DERP_SYNC_COMPOSITOR_SNAPSHOT
    }
  }
}
