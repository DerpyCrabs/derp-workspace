export type ShellRuntimePerfSnapshot = {
  snapshot_decode_count: number
  snapshot_decode_ms: number
  snapshot_decode_bytes: number
  snapshot_apply_count: number
  snapshot_apply_ms: number
  snapshot_apply_details: number
  batch_apply_count: number
  batch_apply_ms: number
  batch_apply_details: number
  dom_measure_count: number
}

const counters: ShellRuntimePerfSnapshot = {
  snapshot_decode_count: 0,
  snapshot_decode_ms: 0,
  snapshot_decode_bytes: 0,
  snapshot_apply_count: 0,
  snapshot_apply_ms: 0,
  snapshot_apply_details: 0,
  batch_apply_count: 0,
  batch_apply_ms: 0,
  batch_apply_details: 0,
  dom_measure_count: 0,
}

const roundMs = (value: number) => Math.round(value * 1000) / 1000

export function noteShellSnapshotDecode(ms: number, bytes: number) {
  counters.snapshot_decode_count += 1
  counters.snapshot_decode_ms += Math.max(0, ms)
  counters.snapshot_decode_bytes += Math.max(0, bytes)
}

export function noteShellSnapshotApply(ms: number, details: number) {
  counters.snapshot_apply_count += 1
  counters.snapshot_apply_ms += Math.max(0, ms)
  counters.snapshot_apply_details += Math.max(0, details)
}

export function noteShellBatchApply(ms: number, details: number) {
  counters.batch_apply_count += 1
  counters.batch_apply_ms += Math.max(0, ms)
  counters.batch_apply_details += Math.max(0, details)
}

export function noteShellDomMeasure(count = 1) {
  counters.dom_measure_count += Math.max(0, Math.trunc(count))
}

export function resetShellRuntimePerfCounters() {
  counters.snapshot_decode_count = 0
  counters.snapshot_decode_ms = 0
  counters.snapshot_decode_bytes = 0
  counters.snapshot_apply_count = 0
  counters.snapshot_apply_ms = 0
  counters.snapshot_apply_details = 0
  counters.batch_apply_count = 0
  counters.batch_apply_ms = 0
  counters.batch_apply_details = 0
  counters.dom_measure_count = 0
}

export function shellRuntimePerfSnapshot(): ShellRuntimePerfSnapshot {
  return {
    ...counters,
    snapshot_decode_ms: roundMs(counters.snapshot_decode_ms),
    snapshot_apply_ms: roundMs(counters.snapshot_apply_ms),
    batch_apply_ms: roundMs(counters.batch_apply_ms),
  }
}

export function installShellRuntimePerfCounters() {
  window.__DERP_SHELL_PERF_SNAPSHOT = shellRuntimePerfSnapshot
  window.__DERP_SHELL_PERF_RESET = resetShellRuntimePerfCounters
  return () => {
    if (window.__DERP_SHELL_PERF_SNAPSHOT === shellRuntimePerfSnapshot) delete window.__DERP_SHELL_PERF_SNAPSHOT
    if (window.__DERP_SHELL_PERF_RESET === resetShellRuntimePerfCounters) delete window.__DERP_SHELL_PERF_RESET
  }
}
