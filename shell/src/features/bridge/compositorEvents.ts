import type { DerpShellDetail } from '@/host/appWindowState'

export const DERP_SHELL_EVENT = 'derp-shell'
export const DERP_SHELL_SNAPSHOT_EVENT = 'derp-shell-snapshot'

type DerpShellLatencySample = {
  id: number
  sequence: number
  detailCount: number
  force: boolean
  syncStartAt: number
  decodedAt?: number
  appliedAt?: number
  authoritativeAt?: number
  visualAt?: number
  rafAt?: number
}

let shellLatencyNextId = 1
let shellLatencySample: DerpShellLatencySample | null = null

function shellLatencyNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export function beginShellLatencySample(sequence: number, detailCount: number, force: boolean): number {
  const id = shellLatencyNextId++
  shellLatencySample = {
    id,
    sequence,
    detailCount,
    force,
    syncStartAt: shellLatencyNow(),
  }
  return id
}

export function markShellLatencySample(
  id: number,
  patch: Partial<Omit<DerpShellLatencySample, 'id' | 'sequence' | 'detailCount' | 'force' | 'syncStartAt'>>,
) {
  if (!shellLatencySample || shellLatencySample.id !== id) return null
  shellLatencySample = { ...shellLatencySample, ...patch }
  return shellLatencySample
}

export function markActiveShellLatencySample(
  patch: Partial<Omit<DerpShellLatencySample, 'id' | 'sequence' | 'detailCount' | 'force' | 'syncStartAt'>>,
) {
  if (!shellLatencySample) return null
  shellLatencySample = { ...shellLatencySample, ...patch }
  return shellLatencySample
}

export function flushShellLatencySample(id: number) {
  const sample = shellLatencySample
  if (!sample || sample.id !== id) return false
  shellLatencySample = null
  return true
}

export function flushActiveShellLatencySample() {
  const sample = shellLatencySample
  if (!sample) return false
  return flushShellLatencySample(sample.id)
}

declare global {
  interface Window {
    __DERP_APPLY_COMPOSITOR_BATCH?: (details: readonly DerpShellDetail[]) => void
    __DERP_APPLY_COMPOSITOR_BATCH_JSON?: (json: string) => void
    __DERP_SYNC_COMPOSITOR_SNAPSHOT?: () => void
  }
}

export function installCompositorBatchHandler(
  handler: (details: readonly DerpShellDetail[]) => void,
): () => void {
  const previous = window.__DERP_APPLY_COMPOSITOR_BATCH
  const previousJson = window.__DERP_APPLY_COMPOSITOR_BATCH_JSON
  const wrapped = (details: readonly DerpShellDetail[]) => {
    if (!Array.isArray(details) || details.length === 0) return
    handler(details)
  }
  const wrappedJson = (json: string) => {
    const details = JSON.parse(json) as readonly DerpShellDetail[]
    wrapped(details)
  }
  window.__DERP_APPLY_COMPOSITOR_BATCH = wrapped
  window.__DERP_APPLY_COMPOSITOR_BATCH_JSON = wrappedJson
  return () => {
    if (window.__DERP_APPLY_COMPOSITOR_BATCH === wrapped) {
      if (typeof previous === 'function') {
        window.__DERP_APPLY_COMPOSITOR_BATCH = previous
      } else {
        delete window.__DERP_APPLY_COMPOSITOR_BATCH
      }
    }
    if (window.__DERP_APPLY_COMPOSITOR_BATCH_JSON === wrappedJson) {
      if (typeof previousJson === 'function') {
        window.__DERP_APPLY_COMPOSITOR_BATCH_JSON = previousJson
      } else {
        delete window.__DERP_APPLY_COMPOSITOR_BATCH_JSON
      }
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
