export type ShellRuntimePerfSnapshot = {
  batch_decode_count: number
  batch_decode_ms: number
  batch_decode_details: number
  batch_coalesce_dropped: number
  snapshot_read_count: number
  snapshot_read_ms: number
  snapshot_decode_count: number
  snapshot_decode_ms: number
  snapshot_decode_bytes: number
  snapshot_apply_count: number
  snapshot_apply_ms: number
  snapshot_apply_max_ms: number
  snapshot_apply_details: number
  model_update_count: number
  model_update_ms: number
  model_update_max_ms: number
  interaction_apply_count: number
  interaction_apply_ms: number
  interaction_apply_max_ms: number
  window_apply_count: number
  window_apply_ms: number
  window_apply_max_ms: number
  batch_apply_count: number
  batch_apply_ms: number
  batch_apply_max_ms: number
  batch_apply_details: number
  visual_followup_count: number
  visual_followup_ms: number
  visual_followup_max_ms: number
  dom_measure_count: number
  dom_measure_ms: number
  imperative_chrome_detail_apply_count: number
  imperative_chrome_detail_apply_ms: number
  imperative_chrome_detail_apply_max_ms: number
  imperative_chrome_detail_apply_details: number
  imperative_chrome_apply_count: number
  imperative_chrome_apply_ms: number
  imperative_chrome_apply_max_ms: number
  imperative_chrome_nodes: number
  imperative_chrome_dom_writes: number
  imperative_chrome_created_nodes: number
  imperative_chrome_removed_nodes: number
  imperative_chrome_expected_windows: number
  imperative_chrome_rendered_windows: number
  imperative_chrome_render_gap_count: number
  imperative_chrome_render_gap_max_windows: number
  imperative_chrome_root_missing_count: number
  imperative_chrome_surface_root_missing_count: number
  shell_ui_windows_flush_count: number
  shell_ui_windows_flush_ms: number
  shell_ui_windows_flush_max_ms: number
  shell_ui_windows_write_count: number
  shell_ui_windows_changed_count: number
  shell_ui_windows_stamp_refresh_count: number
  shell_ui_windows_rows: number
  shared_state_sync_count: number
  shared_state_sync_ms: number
  shared_state_sync_max_ms: number
  raf_sample_count: number
  raf_sample_ms: number
  raf_max_delta_ms: number
  raf_over_17_count: number
  raf_over_25_count: number
  raf_over_50_count: number
}

const counters: ShellRuntimePerfSnapshot = {
  batch_decode_count: 0,
  batch_decode_ms: 0,
  batch_decode_details: 0,
  batch_coalesce_dropped: 0,
  snapshot_read_count: 0,
  snapshot_read_ms: 0,
  snapshot_decode_count: 0,
  snapshot_decode_ms: 0,
  snapshot_decode_bytes: 0,
  snapshot_apply_count: 0,
  snapshot_apply_ms: 0,
  snapshot_apply_max_ms: 0,
  snapshot_apply_details: 0,
  model_update_count: 0,
  model_update_ms: 0,
  model_update_max_ms: 0,
  interaction_apply_count: 0,
  interaction_apply_ms: 0,
  interaction_apply_max_ms: 0,
  window_apply_count: 0,
  window_apply_ms: 0,
  window_apply_max_ms: 0,
  batch_apply_count: 0,
  batch_apply_ms: 0,
  batch_apply_max_ms: 0,
  batch_apply_details: 0,
  visual_followup_count: 0,
  visual_followup_ms: 0,
  visual_followup_max_ms: 0,
  dom_measure_count: 0,
  dom_measure_ms: 0,
  imperative_chrome_detail_apply_count: 0,
  imperative_chrome_detail_apply_ms: 0,
  imperative_chrome_detail_apply_max_ms: 0,
  imperative_chrome_detail_apply_details: 0,
  imperative_chrome_apply_count: 0,
  imperative_chrome_apply_ms: 0,
  imperative_chrome_apply_max_ms: 0,
  imperative_chrome_nodes: 0,
  imperative_chrome_dom_writes: 0,
  imperative_chrome_created_nodes: 0,
  imperative_chrome_removed_nodes: 0,
  imperative_chrome_expected_windows: 0,
  imperative_chrome_rendered_windows: 0,
  imperative_chrome_render_gap_count: 0,
  imperative_chrome_render_gap_max_windows: 0,
  imperative_chrome_root_missing_count: 0,
  imperative_chrome_surface_root_missing_count: 0,
  shell_ui_windows_flush_count: 0,
  shell_ui_windows_flush_ms: 0,
  shell_ui_windows_flush_max_ms: 0,
  shell_ui_windows_write_count: 0,
  shell_ui_windows_changed_count: 0,
  shell_ui_windows_stamp_refresh_count: 0,
  shell_ui_windows_rows: 0,
  shared_state_sync_count: 0,
  shared_state_sync_ms: 0,
  shared_state_sync_max_ms: 0,
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

export function noteShellBatchDecode(ms: number, details: number) {
  counters.batch_decode_count += 1
  counters.batch_decode_ms += Math.max(0, ms)
  counters.batch_decode_details += Math.max(0, details)
}

export function noteShellBatchCoalesce(dropped: number) {
  counters.batch_coalesce_dropped += Math.max(0, Math.trunc(dropped))
}

export function noteShellSnapshotRead(ms: number) {
  counters.snapshot_read_count += 1
  counters.snapshot_read_ms += Math.max(0, ms)
}

export function noteShellSnapshotApply(ms: number, details: number) {
  const elapsed = Math.max(0, ms)
  counters.snapshot_apply_count += 1
  counters.snapshot_apply_ms += elapsed
  counters.snapshot_apply_max_ms = Math.max(counters.snapshot_apply_max_ms, elapsed)
  counters.snapshot_apply_details += Math.max(0, details)
}

export function noteShellModelUpdate(ms: number) {
  const elapsed = Math.max(0, ms)
  counters.model_update_count += 1
  counters.model_update_ms += elapsed
  counters.model_update_max_ms = Math.max(counters.model_update_max_ms, elapsed)
}

export function noteShellInteractionApply(ms: number) {
  const elapsed = Math.max(0, ms)
  counters.interaction_apply_count += 1
  counters.interaction_apply_ms += elapsed
  counters.interaction_apply_max_ms = Math.max(counters.interaction_apply_max_ms, elapsed)
}

export function noteShellWindowApply(ms: number) {
  const elapsed = Math.max(0, ms)
  counters.window_apply_count += 1
  counters.window_apply_ms += elapsed
  counters.window_apply_max_ms = Math.max(counters.window_apply_max_ms, elapsed)
}

export function noteShellBatchApply(ms: number, details: number) {
  const elapsed = Math.max(0, ms)
  counters.batch_apply_count += 1
  counters.batch_apply_ms += elapsed
  counters.batch_apply_max_ms = Math.max(counters.batch_apply_max_ms, elapsed)
  counters.batch_apply_details += Math.max(0, details)
}

export function noteShellVisualFollowup(ms: number) {
  const elapsed = Math.max(0, ms)
  counters.visual_followup_count += 1
  counters.visual_followup_ms += elapsed
  counters.visual_followup_max_ms = Math.max(counters.visual_followup_max_ms, elapsed)
}

export function noteShellDomMeasure(count = 1, ms = 0) {
  counters.dom_measure_count += Math.max(0, Math.trunc(count))
  counters.dom_measure_ms += Math.max(0, ms)
}

export function noteShellImperativeChromeDetailApply(ms: number, details: number) {
  const elapsed = Math.max(0, ms)
  counters.imperative_chrome_detail_apply_count += 1
  counters.imperative_chrome_detail_apply_ms += elapsed
  counters.imperative_chrome_detail_apply_max_ms = Math.max(counters.imperative_chrome_detail_apply_max_ms, elapsed)
  counters.imperative_chrome_detail_apply_details += Math.max(0, Math.trunc(details))
}

export function noteShellImperativeChromeApply(
  ms: number,
  nodes: number,
  domWrites = 0,
  stats: {
    createdNodes?: number
    removedNodes?: number
    expectedWindows?: number
    renderedWindows?: number
    rootMissing?: boolean
    surfaceRootMissing?: boolean
  } = {},
) {
  const elapsed = Math.max(0, ms)
  counters.imperative_chrome_apply_count += 1
  counters.imperative_chrome_apply_ms += elapsed
  counters.imperative_chrome_apply_max_ms = Math.max(counters.imperative_chrome_apply_max_ms, elapsed)
  counters.imperative_chrome_nodes = Math.max(0, Math.trunc(nodes))
  counters.imperative_chrome_dom_writes += Math.max(0, Math.trunc(domWrites))
  counters.imperative_chrome_created_nodes += Math.max(0, Math.trunc(stats.createdNodes ?? 0))
  counters.imperative_chrome_removed_nodes += Math.max(0, Math.trunc(stats.removedNodes ?? 0))
  counters.imperative_chrome_expected_windows = Math.max(0, Math.trunc(stats.expectedWindows ?? counters.imperative_chrome_expected_windows))
  counters.imperative_chrome_rendered_windows = Math.max(0, Math.trunc(stats.renderedWindows ?? counters.imperative_chrome_rendered_windows))
  const missingWindows = Math.max(0, counters.imperative_chrome_expected_windows - counters.imperative_chrome_rendered_windows)
  if (missingWindows > 0) {
    counters.imperative_chrome_render_gap_count += 1
    counters.imperative_chrome_render_gap_max_windows = Math.max(counters.imperative_chrome_render_gap_max_windows, missingWindows)
  }
  if (stats.rootMissing) counters.imperative_chrome_root_missing_count += 1
  if (stats.surfaceRootMissing) counters.imperative_chrome_surface_root_missing_count += 1
}

export function noteShellUiWindowsFlush(
  ms: number,
  rows: number,
  wrote: boolean,
  changed: boolean,
  stampRefresh: boolean,
) {
  const elapsed = Math.max(0, ms)
  counters.shell_ui_windows_flush_count += 1
  counters.shell_ui_windows_flush_ms += elapsed
  counters.shell_ui_windows_flush_max_ms = Math.max(counters.shell_ui_windows_flush_max_ms, elapsed)
  counters.shell_ui_windows_rows = Math.max(0, Math.trunc(rows))
  if (wrote) counters.shell_ui_windows_write_count += 1
  if (changed) counters.shell_ui_windows_changed_count += 1
  if (stampRefresh) counters.shell_ui_windows_stamp_refresh_count += 1
}

export function noteShellSharedStateSync(ms: number) {
  const elapsed = Math.max(0, ms)
  counters.shared_state_sync_count += 1
  counters.shared_state_sync_ms += elapsed
  counters.shared_state_sync_max_ms = Math.max(counters.shared_state_sync_max_ms, elapsed)
}

export function resetShellRuntimePerfCounters() {
  counters.batch_decode_count = 0
  counters.batch_decode_ms = 0
  counters.batch_decode_details = 0
  counters.batch_coalesce_dropped = 0
  counters.snapshot_read_count = 0
  counters.snapshot_read_ms = 0
  counters.snapshot_decode_count = 0
  counters.snapshot_decode_ms = 0
  counters.snapshot_decode_bytes = 0
  counters.snapshot_apply_count = 0
  counters.snapshot_apply_ms = 0
  counters.snapshot_apply_max_ms = 0
  counters.snapshot_apply_details = 0
  counters.model_update_count = 0
  counters.model_update_ms = 0
  counters.model_update_max_ms = 0
  counters.interaction_apply_count = 0
  counters.interaction_apply_ms = 0
  counters.interaction_apply_max_ms = 0
  counters.window_apply_count = 0
  counters.window_apply_ms = 0
  counters.window_apply_max_ms = 0
  counters.batch_apply_count = 0
  counters.batch_apply_ms = 0
  counters.batch_apply_max_ms = 0
  counters.batch_apply_details = 0
  counters.visual_followup_count = 0
  counters.visual_followup_ms = 0
  counters.visual_followup_max_ms = 0
  counters.dom_measure_count = 0
  counters.dom_measure_ms = 0
  counters.imperative_chrome_detail_apply_count = 0
  counters.imperative_chrome_detail_apply_ms = 0
  counters.imperative_chrome_detail_apply_max_ms = 0
  counters.imperative_chrome_detail_apply_details = 0
  counters.imperative_chrome_apply_count = 0
  counters.imperative_chrome_apply_ms = 0
  counters.imperative_chrome_apply_max_ms = 0
  counters.imperative_chrome_nodes = 0
  counters.imperative_chrome_dom_writes = 0
  counters.imperative_chrome_created_nodes = 0
  counters.imperative_chrome_removed_nodes = 0
  counters.imperative_chrome_expected_windows = 0
  counters.imperative_chrome_rendered_windows = 0
  counters.imperative_chrome_render_gap_count = 0
  counters.imperative_chrome_render_gap_max_windows = 0
  counters.imperative_chrome_root_missing_count = 0
  counters.imperative_chrome_surface_root_missing_count = 0
  counters.shell_ui_windows_flush_count = 0
  counters.shell_ui_windows_flush_ms = 0
  counters.shell_ui_windows_flush_max_ms = 0
  counters.shell_ui_windows_write_count = 0
  counters.shell_ui_windows_changed_count = 0
  counters.shell_ui_windows_stamp_refresh_count = 0
  counters.shell_ui_windows_rows = 0
  counters.shared_state_sync_count = 0
  counters.shared_state_sync_ms = 0
  counters.shared_state_sync_max_ms = 0
  resetShellRuntimeRafCounters()
}

export function shellRuntimePerfSnapshot(): ShellRuntimePerfSnapshot {
  return {
    ...counters,
    batch_decode_ms: roundMs(counters.batch_decode_ms),
    snapshot_read_ms: roundMs(counters.snapshot_read_ms),
    snapshot_decode_ms: roundMs(counters.snapshot_decode_ms),
    snapshot_apply_ms: roundMs(counters.snapshot_apply_ms),
    snapshot_apply_max_ms: roundMs(counters.snapshot_apply_max_ms),
    model_update_ms: roundMs(counters.model_update_ms),
    model_update_max_ms: roundMs(counters.model_update_max_ms),
    interaction_apply_ms: roundMs(counters.interaction_apply_ms),
    interaction_apply_max_ms: roundMs(counters.interaction_apply_max_ms),
    window_apply_ms: roundMs(counters.window_apply_ms),
    window_apply_max_ms: roundMs(counters.window_apply_max_ms),
    batch_apply_ms: roundMs(counters.batch_apply_ms),
    batch_apply_max_ms: roundMs(counters.batch_apply_max_ms),
    visual_followup_ms: roundMs(counters.visual_followup_ms),
    visual_followup_max_ms: roundMs(counters.visual_followup_max_ms),
    dom_measure_ms: roundMs(counters.dom_measure_ms),
    imperative_chrome_detail_apply_ms: roundMs(counters.imperative_chrome_detail_apply_ms),
    imperative_chrome_detail_apply_max_ms: roundMs(counters.imperative_chrome_detail_apply_max_ms),
    imperative_chrome_apply_ms: roundMs(counters.imperative_chrome_apply_ms),
    imperative_chrome_apply_max_ms: roundMs(counters.imperative_chrome_apply_max_ms),
    shell_ui_windows_flush_ms: roundMs(counters.shell_ui_windows_flush_ms),
    shell_ui_windows_flush_max_ms: roundMs(counters.shell_ui_windows_flush_max_ms),
    shared_state_sync_ms: roundMs(counters.shared_state_sync_ms),
    shared_state_sync_max_ms: roundMs(counters.shared_state_sync_max_ms),
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
