import {
  BTN_LEFT,
  KEY,
  assert,
  clickRect,
  defineGroup,
  getJson,
  getPerfCounters,
  keyAction,
  linePoints,
  movePoint,
  pointerButton,
  resetPerfCounters,
  setShellFrameSampling,
  tapKey,
  waitFor,
  waitForCompositorQuiet,
  windowControls,
  writeJsonArtifact,
  openShellTestWindow,
  type PerfCounterSnapshot,
  type ShellSnapshot,
} from '../lib/runtime.ts'
import { spawnNativeWindow } from '../lib/setup.ts'
import { availableParallelism } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'

function startCpuLoad(durationMs: number): { workerCount: number; stop: () => Promise<void> } {
  const workerCount = Math.max(
    1,
    Math.trunc(Number(process.env.DERP_E2E_PERF_LOAD_WORKERS) || Math.min(2, Math.max(1, availableParallelism() - 1))),
  )
  const workers: ChildProcess[] = []
  const code = `const end=Date.now()+${Math.max(1, Math.trunc(durationMs))};let x=0;while(Date.now()<end){x+=Math.sqrt((x%997)+1)}if(!Number.isFinite(x))process.exit(2)`
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(spawn(process.execPath, ['-e', code], { stdio: 'ignore' }))
  }
  return {
    workerCount,
    stop: async () => {
      await Promise.all(workers.map((worker) => new Promise<void>((resolve) => {
        if (worker.exitCode !== null || worker.signalCode !== null) {
          resolve()
          return
        }
        worker.once('exit', () => resolve())
        worker.kill()
      })))
    },
  }
}

function summarizePerf(perf: PerfCounterSnapshot) {
  const raf = perf.shell_runtime
  const avgRafDeltaMs = raf && raf.raf_sample_count > 0 ? raf.raf_sample_ms / raf.raf_sample_count : 0
  const avg = (total: number, count: number) => (count > 0 ? Math.round(total / count) : 0)
  return {
    raf_sample_count: raf?.raf_sample_count ?? 0,
    raf_avg_delta_ms: Math.round(avgRafDeltaMs * 1000) / 1000,
    raf_estimated_fps: avgRafDeltaMs > 0 ? Math.round((1000 / avgRafDeltaMs) * 10) / 10 : 0,
    raf_max_delta_ms: raf?.raf_max_delta_ms ?? 0,
    raf_over_17_count: raf?.raf_over_17_count ?? 0,
    raf_over_25_count: raf?.raf_over_25_count ?? 0,
    raf_over_50_count: raf?.raf_over_50_count ?? 0,
    drm_render_ticks: perf.begin_frame.drm_render_ticks,
    drm_render_late_timers: perf.begin_frame.drm_render_late_timers,
    cef_send_external_begin_frame: perf.begin_frame.cef_send_external_begin_frame,
    cef_software_paints: perf.begin_frame.cef_software_paints,
    shell_batch_decode_ms: raf?.batch_decode_ms ?? 0,
    shell_batch_decode_details: raf?.batch_decode_details ?? 0,
    shell_batch_coalesce_dropped: raf?.batch_coalesce_dropped ?? 0,
    shell_snapshot_read_ms: raf?.snapshot_read_ms ?? 0,
    shell_snapshot_decode_ms: raf?.snapshot_decode_ms ?? 0,
    shell_snapshot_apply_ms: raf?.snapshot_apply_ms ?? 0,
    shell_snapshot_apply_max_ms: raf?.snapshot_apply_max_ms ?? 0,
    shell_model_update_ms: raf?.model_update_ms ?? 0,
    shell_model_update_max_ms: raf?.model_update_max_ms ?? 0,
    shell_interaction_apply_ms: raf?.interaction_apply_ms ?? 0,
    shell_interaction_apply_max_ms: raf?.interaction_apply_max_ms ?? 0,
    shell_window_apply_ms: raf?.window_apply_ms ?? 0,
    shell_window_apply_max_ms: raf?.window_apply_max_ms ?? 0,
    shell_batch_apply_max_ms: raf?.batch_apply_max_ms ?? 0,
    shell_visual_followup_count: raf?.visual_followup_count ?? 0,
    shell_visual_followup_ms: raf?.visual_followup_ms ?? 0,
    shell_visual_followup_max_ms: raf?.visual_followup_max_ms ?? 0,
    shell_imperative_chrome_detail_apply_count: raf?.imperative_chrome_detail_apply_count ?? 0,
    shell_imperative_chrome_detail_apply_ms: raf?.imperative_chrome_detail_apply_ms ?? 0,
    shell_imperative_chrome_detail_apply_avg_ms:
      raf && raf.imperative_chrome_detail_apply_count > 0
        ? Math.round((raf.imperative_chrome_detail_apply_ms / raf.imperative_chrome_detail_apply_count) * 1000) / 1000
        : 0,
    shell_imperative_chrome_detail_apply_max_ms: raf?.imperative_chrome_detail_apply_max_ms ?? 0,
    shell_imperative_chrome_detail_apply_details: raf?.imperative_chrome_detail_apply_details ?? 0,
    shell_imperative_chrome_apply_count: raf?.imperative_chrome_apply_count ?? 0,
    shell_imperative_chrome_apply_ms: raf?.imperative_chrome_apply_ms ?? 0,
    shell_imperative_chrome_apply_avg_ms:
      raf && raf.imperative_chrome_apply_count > 0
        ? Math.round((raf.imperative_chrome_apply_ms / raf.imperative_chrome_apply_count) * 1000) / 1000
        : 0,
    shell_imperative_chrome_apply_max_ms: raf?.imperative_chrome_apply_max_ms ?? 0,
    shell_imperative_chrome_nodes: raf?.imperative_chrome_nodes ?? 0,
    shell_imperative_chrome_dom_writes: raf?.imperative_chrome_dom_writes ?? 0,
    shell_imperative_chrome_created_nodes: raf?.imperative_chrome_created_nodes ?? 0,
    shell_imperative_chrome_removed_nodes: raf?.imperative_chrome_removed_nodes ?? 0,
    shell_imperative_chrome_expected_windows: raf?.imperative_chrome_expected_windows ?? 0,
    shell_imperative_chrome_rendered_windows: raf?.imperative_chrome_rendered_windows ?? 0,
    shell_imperative_chrome_render_gap_count: raf?.imperative_chrome_render_gap_count ?? 0,
    shell_imperative_chrome_render_gap_max_windows: raf?.imperative_chrome_render_gap_max_windows ?? 0,
    shell_imperative_chrome_root_missing_count: raf?.imperative_chrome_root_missing_count ?? 0,
    shell_imperative_chrome_surface_root_missing_count: raf?.imperative_chrome_surface_root_missing_count ?? 0,
    shell_ui_windows_flush_count: raf?.shell_ui_windows_flush_count ?? 0,
    shell_ui_windows_flush_ms: raf?.shell_ui_windows_flush_ms ?? 0,
    shell_ui_windows_flush_avg_ms:
      raf && raf.shell_ui_windows_flush_count > 0
        ? Math.round((raf.shell_ui_windows_flush_ms / raf.shell_ui_windows_flush_count) * 1000) / 1000
        : 0,
    shell_ui_windows_flush_max_ms: raf?.shell_ui_windows_flush_max_ms ?? 0,
    shell_ui_windows_write_count: raf?.shell_ui_windows_write_count ?? 0,
    shell_ui_windows_changed_count: raf?.shell_ui_windows_changed_count ?? 0,
    shell_ui_windows_stamp_refresh_count: raf?.shell_ui_windows_stamp_refresh_count ?? 0,
    shell_ui_windows_rows: raf?.shell_ui_windows_rows ?? 0,
    shared_state_sync_count: raf?.shared_state_sync_count ?? 0,
    shared_state_sync_ms: raf?.shared_state_sync_ms ?? 0,
    shared_state_sync_avg_ms:
      raf && raf.shared_state_sync_count > 0
        ? Math.round((raf.shared_state_sync_ms / raf.shared_state_sync_count) * 1000) / 1000
        : 0,
    shared_state_sync_max_ms: raf?.shared_state_sync_max_ms ?? 0,
    dom_measure_count: raf?.dom_measure_count ?? 0,
    dom_measure_ms: raf?.dom_measure_ms ?? 0,
    schedule_to_render_max_us: perf.latency.schedule_to_render_max_us,
    dirty_rect_max_coverage_per_mille: perf.dirty_rects.max_coverage_per_mille,
    action_renderer_to_browser_count: perf.shell_bridge.action_renderer_to_browser_count,
    action_renderer_to_browser_avg_us: avg(
      perf.shell_bridge.action_renderer_to_browser_us,
      perf.shell_bridge.action_renderer_to_browser_count,
    ),
    action_renderer_to_browser_max_us: perf.shell_bridge.action_renderer_to_browser_max_us,
    action_browser_to_compositor_count: perf.shell_bridge.action_browser_to_compositor_count,
    action_browser_to_compositor_avg_us: avg(
      perf.shell_bridge.action_browser_to_compositor_us,
      perf.shell_bridge.action_browser_to_compositor_count,
    ),
    action_browser_to_compositor_max_us: perf.shell_bridge.action_browser_to_compositor_max_us,
    state_compositor_to_ui_count: perf.shell_bridge.state_compositor_to_ui_count,
    state_compositor_to_ui_avg_us: avg(
      perf.shell_bridge.state_compositor_to_ui_us,
      perf.shell_bridge.state_compositor_to_ui_count,
    ),
    state_compositor_to_ui_max_us: perf.shell_bridge.state_compositor_to_ui_max_us,
    state_browser_to_renderer_count: perf.shell_bridge.state_browser_to_renderer_count,
    state_browser_to_renderer_avg_us: avg(
      perf.shell_bridge.state_browser_to_renderer_us,
      perf.shell_bridge.state_browser_to_renderer_count,
    ),
    state_browser_to_renderer_max_us: perf.shell_bridge.state_browser_to_renderer_max_us,
    state_renderer_apply_count: perf.shell_bridge.state_renderer_apply_count,
    state_renderer_apply_avg_us: avg(
      perf.shell_bridge.state_renderer_apply_us,
      perf.shell_bridge.state_renderer_apply_count,
    ),
    state_renderer_apply_max_us: perf.shell_bridge.state_renderer_apply_max_us,
  }
}

function assertHotChromeBudget(
  label: string,
  summary: ReturnType<typeof summarizePerf>,
  options: { snapshotTotals?: boolean } = {},
) {
  assert(
    summary.shell_imperative_chrome_apply_avg_ms <= 2.5,
    `${label} imperative chrome avg apply too high: ${summary.shell_imperative_chrome_apply_avg_ms}ms`,
  )
  assert(
    summary.shell_imperative_chrome_apply_max_ms <= 12,
    `${label} imperative chrome max apply too high: ${summary.shell_imperative_chrome_apply_max_ms}ms`,
  )
  assert(
    summary.shell_imperative_chrome_detail_apply_max_ms <= 14,
    `${label} imperative chrome detail apply too high: ${summary.shell_imperative_chrome_detail_apply_max_ms}ms`,
  )
  assert(
    summary.shell_imperative_chrome_root_missing_count === 0,
    `${label} imperative chrome root was missing during hot path: ${summary.shell_imperative_chrome_root_missing_count}`,
  )
  assert(
    summary.shell_imperative_chrome_expected_windows === summary.shell_imperative_chrome_rendered_windows,
    `${label} imperative chrome rendered ${summary.shell_imperative_chrome_rendered_windows}/${summary.shell_imperative_chrome_expected_windows} expected windows`,
  )
  assert(
    summary.shell_imperative_chrome_render_gap_count === 0,
    `${label} imperative chrome had ${summary.shell_imperative_chrome_render_gap_count} render gaps, max missing ${summary.shell_imperative_chrome_render_gap_max_windows}`,
  )
  if (options.snapshotTotals !== false) {
    assert(
      summary.shell_snapshot_apply_max_ms <= 14,
      `${label} snapshot apply spike too high: ${summary.shell_snapshot_apply_max_ms}ms`,
    )
    assert(
      summary.shell_model_update_max_ms <= 5,
      `${label} Solid model update spike too high: ${summary.shell_model_update_max_ms}ms`,
    )
  }
  assert(
    summary.shell_batch_coalesce_dropped <= 2,
    `${label} dropped too many coalesced batch details: ${summary.shell_batch_coalesce_dropped}`,
  )
}

async function closeProgramsMenuIfOpen(base: string): Promise<ShellSnapshot> {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  if (shell.programs_menu_open) {
    await tapKey(base, KEY.escape)
  }
  const closed = await getJson<ShellSnapshot>(base, '/test/state/shell')
  assert(!closed.programs_menu_open, 'expected programs menu to be closed')
  return closed
}

async function captureDragPerf(
  base: string,
  state: { knownWindowIds: Set<number>; spawnedNativeWindowIds: Set<number> },
  label: string,
) {
  const native = await spawnNativeWindow(base, state.knownWindowIds, {
    title: `Derp Perf Load Drag ${label}`,
    token: `perf-load-drag-${label}`,
    strip: 'blue',
  })
  state.spawnedNativeWindowIds.add(native.window.window_id)
  await waitFor(`wait for perf drag chrome ${native.window.window_id}`, async () => {
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    return windowControls(shell, native.window.window_id)?.titlebar ? shell : null
  })
  const start = {
    x: native.window.x + native.window.width / 2,
    y: native.window.y + 14,
  }
  const end = {
    x: start.x + 360,
    y: start.y + 96,
  }
  await resetPerfCounters(base)
  await setShellFrameSampling(base, true)
  const load = startCpuLoad(2500)
  try {
    await movePoint(base, start.x, start.y)
    await pointerButton(base, BTN_LEFT, 'press')
    for (const point of linePoints(start.x, start.y, end.x, end.y, 96)) {
      await movePoint(base, point.x, point.y)
    }
    await pointerButton(base, BTN_LEFT, 'release')
  } finally {
    await setShellFrameSampling(base, false)
    await load.stop()
  }
  const perf = await getPerfCounters(base)
  const summary = summarizePerf(perf)
  return { load, summary, perf }
}

async function captureSnapOverlayPerf(
  base: string,
  state: { knownWindowIds: Set<number>; spawnedNativeWindowIds: Set<number> },
  label: string,
) {
  const native = await spawnNativeWindow(base, state.knownWindowIds, {
    title: `Derp Perf Snap Overlay ${label}`,
    token: `perf-snap-overlay-${label}`,
    strip: 'blue',
  })
  state.spawnedNativeWindowIds.add(native.window.window_id)
  await waitFor(`wait for perf snap chrome ${native.window.window_id}`, async () => {
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    return windowControls(shell, native.window.window_id)?.titlebar ? shell : null
  })
  const start = {
    x: native.window.x + native.window.width / 2,
    y: native.window.y + 14,
  }
  const end = {
    x: start.x + 420,
    y: start.y + 180,
  }
  await resetPerfCounters(base)
  await setShellFrameSampling(base, true)
  const load = startCpuLoad(2500)
  let pointerDown = false
  let superDown = false
  try {
    await keyAction(base, KEY.super, 'press')
    superDown = true
    await movePoint(base, start.x, start.y)
    await pointerButton(base, BTN_LEFT, 'press')
    pointerDown = true
    for (const point of linePoints(start.x, start.y, end.x, end.y, 120)) {
      await movePoint(base, point.x, point.y)
    }
  } finally {
    if (pointerDown) await pointerButton(base, BTN_LEFT, 'release')
    if (superDown) await keyAction(base, KEY.super, 'release')
    await setShellFrameSampling(base, false)
    await load.stop()
  }
  const perf = await getPerfCounters(base)
  const summary = summarizePerf(perf)
  return { load, summary, perf }
}

async function captureShellHostedDragPerf(
  base: string,
  state: Parameters<typeof openShellTestWindow>[1],
) {
  const opened = await openShellTestWindow(base, state)
  await waitFor(`wait for shell-hosted perf drag chrome ${opened.window.window_id}`, async () => {
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    return windowControls(shell, opened.window.window_id)?.titlebar ? shell : null
  })
  const controls = windowControls(opened.shell, opened.window.window_id)
  const titlebar = controls?.titlebar
  assert(titlebar, 'missing shell-hosted perf drag titlebar')
  const start = {
    x: titlebar.x + titlebar.width / 2,
    y: titlebar.y + titlebar.height / 2,
  }
  const end = {
    x: start.x + 300,
    y: start.y + 80,
  }
  await resetPerfCounters(base)
  await setShellFrameSampling(base, true)
  const load = startCpuLoad(2500)
  try {
    await movePoint(base, start.x, start.y)
    await pointerButton(base, BTN_LEFT, 'press')
    for (const point of linePoints(start.x, start.y, end.x, end.y, 96)) {
      await movePoint(base, point.x, point.y)
    }
    await pointerButton(base, BTN_LEFT, 'release')
  } finally {
    await setShellFrameSampling(base, false)
    await load.stop()
  }
  const perf = await getPerfCounters(base)
  const summary = summarizePerf(perf)
  return { load, summary, perf }
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('idle compositor does not redraw at refresh cadence', async ({ base }) => {
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assert(shell.controls.taskbar_programs_toggle, 'expected idle shell taskbar controls')
    await resetPerfCounters(base)
    await waitForCompositorQuiet(500, 1500)
    const perf = await getPerfCounters(base)
    await writeJsonArtifact('idle-render-perf.json', perf)
    assert(
      perf.begin_frame.drm_render_ticks <= 6,
      `idle compositor rendered too often: ${perf.begin_frame.drm_render_ticks} ticks`,
    )
    assert(
      perf.begin_frame.drm_render_late_timers <= 2,
      `idle compositor armed too many late render timers: ${perf.begin_frame.drm_render_late_timers}`,
    )
  })

  test('captures active drag frame pacing under CPU load', async ({ base, state }) => {
    const sample = await captureDragPerf(base, state, 'imperative')
    await writeJsonArtifact('active-drag-load-perf.json', {
      load_workers: sample.load.workerCount,
      summary: sample.summary,
      perf: sample.perf,
    })
    assert(
      sample.summary.shell_imperative_chrome_apply_count > 0,
      `expected imperative chrome applies during loaded drag, got ${sample.summary.shell_imperative_chrome_apply_count}`,
    )
    assert(sample.summary.raf_sample_count >= 3, `expected RAF frame samples during loaded drag, got ${sample.summary.raf_sample_count}`)
    assert(sample.summary.drm_render_ticks > 0, `expected compositor render ticks during loaded drag, got ${sample.summary.drm_render_ticks}`)
    assertHotChromeBudget('loaded drag', sample.summary)
  })

  test('captures snap overlay frame pacing under CPU load', async ({ base, state }) => {
    const sample = await captureSnapOverlayPerf(base, state, 'imperative')
    await writeJsonArtifact('snap-overlay-load-perf.json', {
      load_workers: sample.load.workerCount,
      summary: sample.summary,
      perf: sample.perf,
    })
    assert(
      sample.summary.shell_imperative_chrome_apply_count > 0,
      `expected imperative snap overlay applies during loaded drag, got ${sample.summary.shell_imperative_chrome_apply_count}`,
    )
    assert(sample.summary.raf_sample_count >= 3, `expected RAF frame samples during loaded snap overlay drag, got ${sample.summary.raf_sample_count}`)
    assertHotChromeBudget('loaded snap overlay', sample.summary)
  })

  test('captures shell-hosted drag placement sync under CPU load', async ({ base, state }) => {
    const sample = await captureShellHostedDragPerf(base, state)
    await writeJsonArtifact('shell-hosted-drag-load-perf.json', {
      load_workers: sample.load.workerCount,
      summary: sample.summary,
      perf: sample.perf,
    })
    assert(
      sample.summary.shell_imperative_chrome_apply_count > 0,
      `expected imperative chrome applies during shell-hosted loaded drag, got ${sample.summary.shell_imperative_chrome_apply_count}`,
    )
    assert(sample.summary.shell_ui_windows_flush_count > 0, 'expected shell-hosted drag to flush shell-ui placement state')
    assert(sample.summary.shared_state_sync_max_ms <= 4, `shell-hosted shared state sync too high: ${sample.summary.shared_state_sync_max_ms}ms`)
    assertHotChromeBudget('loaded shell-hosted drag', sample.summary, { snapshotTotals: false })
  })

  test('captures shell action latency under CPU load', async ({ base }) => {
    const initial = await closeProgramsMenuIfOpen(base)
    assert(initial.controls.taskbar_programs_toggle, 'missing programs toggle')
    await resetPerfCounters(base)
    const load = startCpuLoad(2500)
    try {
      for (let index = 0; index < 8; index += 1) {
        const closed = await getJson<ShellSnapshot>(base, '/test/state/shell')
        assert(!closed.programs_menu_open, `programs menu unexpectedly open before cycle ${index}`)
        assert(closed.controls.taskbar_programs_toggle, 'missing programs toggle')
        await clickRect(base, closed.controls.taskbar_programs_toggle)
        const opened = await getJson<ShellSnapshot>(base, '/test/state/shell')
        assert(opened.programs_menu_open, `programs menu did not open in cycle ${index}`)
        await tapKey(base, KEY.escape)
        const nextClosed = await getJson<ShellSnapshot>(base, '/test/state/shell')
        assert(!nextClosed.programs_menu_open, `programs menu did not close in cycle ${index}`)
      }
    } finally {
      await load.stop()
    }
    const perf = await getPerfCounters(base)
    const summary = summarizePerf(perf)
    await writeJsonArtifact('shell-action-load-perf.json', {
      load_workers: load.workerCount,
      summary,
      perf,
    })
    assert(
      summary.action_browser_to_compositor_count >= 16,
      `expected shell actions to reach compositor, got ${summary.action_browser_to_compositor_count}`,
    )
    assert(
      summary.state_browser_to_renderer_count > 0,
      `expected state updates to reach renderer, got ${summary.state_browser_to_renderer_count}`,
    )
    assert(
      summary.shell_snapshot_apply_ms <= 8,
      `shell action snapshot apply too high: ${summary.shell_snapshot_apply_ms}ms`,
    )
    assert(
      summary.shell_model_update_ms <= 8,
      `shell action Solid model updates too high: ${summary.shell_model_update_ms}ms`,
    )
  })
})
