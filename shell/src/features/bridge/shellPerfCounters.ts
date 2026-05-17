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
  imperative_chrome_full_apply_count: number
  imperative_chrome_surface_apply_count: number
  imperative_chrome_state_driven_apply_count: number
  imperative_chrome_local_apply_count: number
  imperative_chrome_visual_apply_count: number
  imperative_chrome_visual_windows: number
  imperative_chrome_state_age_ms: number
  imperative_chrome_state_age_max_ms: number
  imperative_chrome_state_age_p95_ms: number
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
  state_to_chrome_count: number
  state_to_chrome_ms: number
  state_to_chrome_max_ms: number
  state_to_chrome_p95_ms: number
  action_to_chrome_count: number
  action_to_chrome_ms: number
  action_to_chrome_max_ms: number
  action_to_chrome_p95_ms: number
  action_to_chrome_pending_count: number
  action_to_chrome_expired_count: number
  action_to_chrome_move_count: number
  action_to_chrome_move_max_ms: number
  action_to_chrome_move_p95_ms: number
  action_to_chrome_resize_count: number
  action_to_chrome_resize_max_ms: number
  action_to_chrome_resize_p95_ms: number
  action_to_chrome_activation_count: number
  action_to_chrome_activation_max_ms: number
  action_to_chrome_activation_p95_ms: number
  action_to_chrome_window_state_count: number
  action_to_chrome_window_state_max_ms: number
  action_to_chrome_window_state_p95_ms: number
  action_to_chrome_workspace_count: number
  action_to_chrome_workspace_max_ms: number
  action_to_chrome_workspace_p95_ms: number
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
  imperative_chrome_full_apply_count: 0,
  imperative_chrome_surface_apply_count: 0,
  imperative_chrome_state_driven_apply_count: 0,
  imperative_chrome_local_apply_count: 0,
  imperative_chrome_visual_apply_count: 0,
  imperative_chrome_visual_windows: 0,
  imperative_chrome_state_age_ms: 0,
  imperative_chrome_state_age_max_ms: 0,
  imperative_chrome_state_age_p95_ms: 0,
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
  state_to_chrome_count: 0,
  state_to_chrome_ms: 0,
  state_to_chrome_max_ms: 0,
  state_to_chrome_p95_ms: 0,
  action_to_chrome_count: 0,
  action_to_chrome_ms: 0,
  action_to_chrome_max_ms: 0,
  action_to_chrome_p95_ms: 0,
  action_to_chrome_pending_count: 0,
  action_to_chrome_expired_count: 0,
  action_to_chrome_move_count: 0,
  action_to_chrome_move_max_ms: 0,
  action_to_chrome_move_p95_ms: 0,
  action_to_chrome_resize_count: 0,
  action_to_chrome_resize_max_ms: 0,
  action_to_chrome_resize_p95_ms: 0,
  action_to_chrome_activation_count: 0,
  action_to_chrome_activation_max_ms: 0,
  action_to_chrome_activation_p95_ms: 0,
  action_to_chrome_window_state_count: 0,
  action_to_chrome_window_state_max_ms: 0,
  action_to_chrome_window_state_p95_ms: 0,
  action_to_chrome_workspace_count: 0,
  action_to_chrome_workspace_max_ms: 0,
  action_to_chrome_workspace_p95_ms: 0,
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
const stateToChromeSamples: number[] = []
const actionToChromeSamples: number[] = []
const actionToChromeBucketSamples = {
  move: [] as number[],
  resize: [] as number[],
  activation: [] as number[],
  windowState: [] as number[],
  workspace: [] as number[],
}
const chromeStateAgeSamples: number[] = []
let pendingShellActionId = 1
const pendingShellActions: Array<{ id: number; op: string; windowId: number | null; startedAt: number }> = []

function perfNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function pushSample(samples: number[], elapsed: number) {
  samples.push(elapsed)
  if (samples.length > 512) samples.splice(0, samples.length - 512)
}

function sampleP95(samples: readonly number[]) {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  return roundMs(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0)
}

function expireShellActions(now = perfNow()) {
  let expired = 0
  for (let index = pendingShellActions.length - 1; index >= 0; index -= 1) {
    if (now - pendingShellActions[index].startedAt <= 2000) continue
    pendingShellActions.splice(index, 1)
    expired += 1
  }
  if (expired > 0) counters.action_to_chrome_expired_count += expired
  counters.action_to_chrome_pending_count = pendingShellActions.length
}

function trackedShellActionWindowId(op: string, args: readonly unknown[]) {
  if (op === 'resize_delta' || op === 'resize_shell_grab_end' || op === 'invalidate_view') return null
  const first = args[0]
  if (typeof first !== 'number' || !Number.isFinite(first)) return null
  const id = Math.trunc(first)
  return id > 0 ? id : null
}

function isTrackedShellAction(op: string) {
  return (
    op === 'move_begin' ||
    op === 'resize_begin' ||
    op === 'resize_delta' ||
    op === 'activate_window' ||
    op === 'taskbar_activate' ||
    op === 'minimize' ||
    op === 'set_maximized' ||
    op === 'set_geometry' ||
    op === 'window_intent' ||
    op === 'workspace_mutation'
  )
}

function actionLatencyBucket(op: string) {
  if (op === 'move_begin') return 'move'
  if (op === 'resize_begin' || op === 'resize_delta') return 'resize'
  if (op === 'activate_window' || op === 'taskbar_activate') return 'activation'
  if (op === 'minimize' || op === 'set_maximized' || op === 'set_geometry') return 'windowState'
  if (op === 'window_intent' || op === 'workspace_mutation') return 'workspace'
  return null
}

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
    surfaceOnly?: boolean
    stateDriven?: boolean
    visualWindows?: number
    stateAgeMs?: number
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
  if (stats.surfaceOnly) counters.imperative_chrome_surface_apply_count += 1
  else counters.imperative_chrome_full_apply_count += 1
  if (stats.stateDriven) counters.imperative_chrome_state_driven_apply_count += 1
  else counters.imperative_chrome_local_apply_count += 1
  const visualWindows = Math.max(0, Math.trunc(stats.visualWindows ?? 0))
  if (visualWindows > 0) {
    counters.imperative_chrome_visual_apply_count += 1
    counters.imperative_chrome_visual_windows += visualWindows
  }
  if (typeof stats.stateAgeMs === 'number' && Number.isFinite(stats.stateAgeMs)) {
    const stateAge = Math.max(0, stats.stateAgeMs)
    counters.imperative_chrome_state_age_ms += stateAge
    counters.imperative_chrome_state_age_max_ms = Math.max(counters.imperative_chrome_state_age_max_ms, stateAge)
    pushSample(chromeStateAgeSamples, stateAge)
    counters.imperative_chrome_state_age_p95_ms = sampleP95(chromeStateAgeSamples)
  }
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

export function beginShellActionToChrome(op: string, ...args: readonly unknown[]) {
  if (!isTrackedShellAction(op)) return
  expireShellActions()
  pendingShellActions.push({
    id: pendingShellActionId++,
    op,
    windowId: trackedShellActionWindowId(op, args),
    startedAt: perfNow(),
  })
  if (pendingShellActions.length > 128) {
    const dropped = pendingShellActions.length - 128
    pendingShellActions.splice(0, dropped)
    counters.action_to_chrome_expired_count += dropped
  }
  counters.action_to_chrome_pending_count = pendingShellActions.length
}

function completeShellActionToChrome(windowId: number | null, ops: readonly string[]) {
  expireShellActions()
  const now = perfNow()
  const index = pendingShellActions.findIndex((entry) =>
    ops.includes(entry.op) && (windowId === null || entry.windowId === null || entry.windowId === windowId),
  )
  if (index < 0) return
  const [entry] = pendingShellActions.splice(index, 1)
  const elapsed = Math.max(0, now - entry.startedAt)
  counters.action_to_chrome_count += 1
  counters.action_to_chrome_ms += elapsed
  counters.action_to_chrome_max_ms = Math.max(counters.action_to_chrome_max_ms, elapsed)
  pushSample(actionToChromeSamples, elapsed)
  counters.action_to_chrome_p95_ms = sampleP95(actionToChromeSamples)
  const bucket = actionLatencyBucket(entry.op)
  if (bucket === 'move') {
    counters.action_to_chrome_move_count += 1
    counters.action_to_chrome_move_max_ms = Math.max(counters.action_to_chrome_move_max_ms, elapsed)
    pushSample(actionToChromeBucketSamples.move, elapsed)
    counters.action_to_chrome_move_p95_ms = sampleP95(actionToChromeBucketSamples.move)
  } else if (bucket === 'resize') {
    counters.action_to_chrome_resize_count += 1
    counters.action_to_chrome_resize_max_ms = Math.max(counters.action_to_chrome_resize_max_ms, elapsed)
    pushSample(actionToChromeBucketSamples.resize, elapsed)
    counters.action_to_chrome_resize_p95_ms = sampleP95(actionToChromeBucketSamples.resize)
  } else if (bucket === 'activation') {
    counters.action_to_chrome_activation_count += 1
    counters.action_to_chrome_activation_max_ms = Math.max(counters.action_to_chrome_activation_max_ms, elapsed)
    pushSample(actionToChromeBucketSamples.activation, elapsed)
    counters.action_to_chrome_activation_p95_ms = sampleP95(actionToChromeBucketSamples.activation)
  } else if (bucket === 'windowState') {
    counters.action_to_chrome_window_state_count += 1
    counters.action_to_chrome_window_state_max_ms = Math.max(counters.action_to_chrome_window_state_max_ms, elapsed)
    pushSample(actionToChromeBucketSamples.windowState, elapsed)
    counters.action_to_chrome_window_state_p95_ms = sampleP95(actionToChromeBucketSamples.windowState)
  } else if (bucket === 'workspace') {
    counters.action_to_chrome_workspace_count += 1
    counters.action_to_chrome_workspace_max_ms = Math.max(counters.action_to_chrome_workspace_max_ms, elapsed)
    pushSample(actionToChromeBucketSamples.workspace, elapsed)
    counters.action_to_chrome_workspace_p95_ms = sampleP95(actionToChromeBucketSamples.workspace)
  }
  counters.action_to_chrome_pending_count = pendingShellActions.length
}

function detailWindowId(detail: { window_id?: unknown }) {
  const raw = detail.window_id
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const id = Math.trunc(raw)
  return id > 0 ? id : null
}

export function noteShellStateToChromeApply(startedAt: number, details: readonly { type?: unknown; window_id?: unknown; move_window_id?: unknown; resize_window_id?: unknown }[]) {
  const elapsed = Math.max(0, perfNow() - startedAt)
  counters.state_to_chrome_count += 1
  counters.state_to_chrome_ms += elapsed
  counters.state_to_chrome_max_ms = Math.max(counters.state_to_chrome_max_ms, elapsed)
  pushSample(stateToChromeSamples, elapsed)
  counters.state_to_chrome_p95_ms = sampleP95(stateToChromeSamples)
  for (const detail of details) {
    if (detail.type === 'window_geometry') {
      completeShellActionToChrome(detailWindowId(detail), ['move_begin', 'resize_begin', 'resize_delta', 'resize_end', 'set_geometry', 'set_maximized', 'window_intent', 'workspace_mutation'])
    } else if (detail.type === 'interaction_state') {
      const moveId = detailWindowId({ window_id: detail.move_window_id })
      const resizeId = detailWindowId({ window_id: detail.resize_window_id })
      if (moveId !== null) completeShellActionToChrome(moveId, ['move_begin'])
      if (resizeId !== null) completeShellActionToChrome(resizeId, ['resize_begin', 'resize_delta'])
    } else if (detail.type === 'focus_changed') {
      completeShellActionToChrome(detailWindowId(detail), ['activate_window', 'taskbar_activate'])
    } else if (detail.type === 'window_state') {
      completeShellActionToChrome(detailWindowId(detail), ['minimize', 'set_maximized'])
    } else if (detail.type === 'window_order' || detail.type === 'workspace_state') {
      completeShellActionToChrome(null, ['workspace_mutation', 'window_intent'])
    }
  }
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
  counters.imperative_chrome_full_apply_count = 0
  counters.imperative_chrome_surface_apply_count = 0
  counters.imperative_chrome_state_driven_apply_count = 0
  counters.imperative_chrome_local_apply_count = 0
  counters.imperative_chrome_visual_apply_count = 0
  counters.imperative_chrome_visual_windows = 0
  counters.imperative_chrome_state_age_ms = 0
  counters.imperative_chrome_state_age_max_ms = 0
  counters.imperative_chrome_state_age_p95_ms = 0
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
  counters.state_to_chrome_count = 0
  counters.state_to_chrome_ms = 0
  counters.state_to_chrome_max_ms = 0
  counters.state_to_chrome_p95_ms = 0
  counters.action_to_chrome_count = 0
  counters.action_to_chrome_ms = 0
  counters.action_to_chrome_max_ms = 0
  counters.action_to_chrome_p95_ms = 0
  counters.action_to_chrome_pending_count = 0
  counters.action_to_chrome_expired_count = 0
  counters.action_to_chrome_move_count = 0
  counters.action_to_chrome_move_max_ms = 0
  counters.action_to_chrome_move_p95_ms = 0
  counters.action_to_chrome_resize_count = 0
  counters.action_to_chrome_resize_max_ms = 0
  counters.action_to_chrome_resize_p95_ms = 0
  counters.action_to_chrome_activation_count = 0
  counters.action_to_chrome_activation_max_ms = 0
  counters.action_to_chrome_activation_p95_ms = 0
  counters.action_to_chrome_window_state_count = 0
  counters.action_to_chrome_window_state_max_ms = 0
  counters.action_to_chrome_window_state_p95_ms = 0
  counters.action_to_chrome_workspace_count = 0
  counters.action_to_chrome_workspace_max_ms = 0
  counters.action_to_chrome_workspace_p95_ms = 0
  stateToChromeSamples.length = 0
  actionToChromeSamples.length = 0
  actionToChromeBucketSamples.move.length = 0
  actionToChromeBucketSamples.resize.length = 0
  actionToChromeBucketSamples.activation.length = 0
  actionToChromeBucketSamples.windowState.length = 0
  actionToChromeBucketSamples.workspace.length = 0
  chromeStateAgeSamples.length = 0
  pendingShellActions.length = 0
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
    imperative_chrome_state_age_ms: roundMs(counters.imperative_chrome_state_age_ms),
    imperative_chrome_state_age_max_ms: roundMs(counters.imperative_chrome_state_age_max_ms),
    imperative_chrome_state_age_p95_ms: roundMs(counters.imperative_chrome_state_age_p95_ms),
    action_to_chrome_max_ms: roundMs(counters.action_to_chrome_max_ms),
    action_to_chrome_p95_ms: roundMs(counters.action_to_chrome_p95_ms),
    action_to_chrome_move_max_ms: roundMs(counters.action_to_chrome_move_max_ms),
    action_to_chrome_move_p95_ms: roundMs(counters.action_to_chrome_move_p95_ms),
    action_to_chrome_resize_max_ms: roundMs(counters.action_to_chrome_resize_max_ms),
    action_to_chrome_resize_p95_ms: roundMs(counters.action_to_chrome_resize_p95_ms),
    action_to_chrome_activation_max_ms: roundMs(counters.action_to_chrome_activation_max_ms),
    action_to_chrome_activation_p95_ms: roundMs(counters.action_to_chrome_activation_p95_ms),
    action_to_chrome_window_state_max_ms: roundMs(counters.action_to_chrome_window_state_max_ms),
    action_to_chrome_window_state_p95_ms: roundMs(counters.action_to_chrome_window_state_p95_ms),
    action_to_chrome_workspace_max_ms: roundMs(counters.action_to_chrome_workspace_max_ms),
    action_to_chrome_workspace_p95_ms: roundMs(counters.action_to_chrome_workspace_p95_ms),
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
