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
  raf_sample_count: number
  raf_sample_ms: number
  raf_max_delta_ms: number
  raf_over_17_count: number
  raf_over_25_count: number
  raf_over_50_count: number
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
  raf_sample_count: 0,
  raf_sample_ms: 0,
  raf_max_delta_ms: 0,
  raf_over_17_count: 0,
  raf_over_25_count: 0,
  raf_over_50_count: 0,
}

const roundMs = (value: number) => Math.round(value * 1000) / 1000
let rafSampleId = 0
let rafSampleLast = 0

function resetShellRuntimeRafCounters() {
  counters.raf_sample_count = 0
  counters.raf_sample_ms = 0
  counters.raf_max_delta_ms = 0
  counters.raf_over_17_count = 0
  counters.raf_over_25_count = 0
  counters.raf_over_50_count = 0
}

function shellRuntimeRafStep(now: number) {
  if (rafSampleLast > 0) {
    const delta = Math.max(0, now - rafSampleLast)
    counters.raf_sample_count += 1
    counters.raf_sample_ms += delta
    counters.raf_max_delta_ms = Math.max(counters.raf_max_delta_ms, delta)
    if (delta > 17) counters.raf_over_17_count += 1
    if (delta > 25) counters.raf_over_25_count += 1
    if (delta > 50) counters.raf_over_50_count += 1
  }
  rafSampleLast = now
  rafSampleId = requestAnimationFrame(shellRuntimeRafStep)
}

export function startShellRuntimeFrameSampling() {
  resetShellRuntimeRafCounters()
  rafSampleLast = 0
  if (rafSampleId) cancelAnimationFrame(rafSampleId)
  rafSampleId = requestAnimationFrame(shellRuntimeRafStep)
}

export function stopShellRuntimeFrameSampling() {
  if (rafSampleId) cancelAnimationFrame(rafSampleId)
  rafSampleId = 0
  rafSampleLast = 0
}

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
  resetShellRuntimeRafCounters()
}

export function shellRuntimePerfSnapshot(): ShellRuntimePerfSnapshot {
  return {
    ...counters,
    snapshot_decode_ms: roundMs(counters.snapshot_decode_ms),
    snapshot_apply_ms: roundMs(counters.snapshot_apply_ms),
    batch_apply_ms: roundMs(counters.batch_apply_ms),
    raf_sample_ms: roundMs(counters.raf_sample_ms),
    raf_max_delta_ms: roundMs(counters.raf_max_delta_ms),
  }
}

export function installShellRuntimePerfCounters() {
  window.__DERP_SHELL_PERF_SNAPSHOT = shellRuntimePerfSnapshot
  window.__DERP_SHELL_PERF_RESET = resetShellRuntimePerfCounters
  window.__DERP_SHELL_PERF_FRAME_SAMPLE_START = startShellRuntimeFrameSampling
  window.__DERP_SHELL_PERF_FRAME_SAMPLE_STOP = stopShellRuntimeFrameSampling
  return () => {
    stopShellRuntimeFrameSampling()
    if (window.__DERP_SHELL_PERF_SNAPSHOT === shellRuntimePerfSnapshot) delete window.__DERP_SHELL_PERF_SNAPSHOT
    if (window.__DERP_SHELL_PERF_RESET === resetShellRuntimePerfCounters) delete window.__DERP_SHELL_PERF_RESET
    if (window.__DERP_SHELL_PERF_FRAME_SAMPLE_START === startShellRuntimeFrameSampling) delete window.__DERP_SHELL_PERF_FRAME_SAMPLE_START
    if (window.__DERP_SHELL_PERF_FRAME_SAMPLE_STOP === stopShellRuntimeFrameSampling) delete window.__DERP_SHELL_PERF_FRAME_SAMPLE_STOP
  }
}
