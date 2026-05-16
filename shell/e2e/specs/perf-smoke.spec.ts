import {
  BTN_LEFT,
  KEY,
  assert,
  clickRect,
  defineGroup,
  getJson,
  getPerfCounters,
  linePoints,
  movePoint,
  pointerButton,
  resetPerfCounters,
  setShellFrameSampling,
  spawnNativeWindow,
  tapKey,
  waitForCompositorQuiet,
  writeJsonArtifact,
  type PerfCounterSnapshot,
  type ShellSnapshot,
} from '../lib/runtime.ts'
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
    shell_snapshot_decode_ms: raf?.snapshot_decode_ms ?? 0,
    shell_snapshot_apply_ms: raf?.snapshot_apply_ms ?? 0,
    dom_measure_count: raf?.dom_measure_count ?? 0,
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

async function closeProgramsMenuIfOpen(base: string): Promise<ShellSnapshot> {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  if (shell.programs_menu_open) {
    await tapKey(base, KEY.escape)
  }
  const closed = await getJson<ShellSnapshot>(base, '/test/state/shell')
  assert(!closed.programs_menu_open, 'expected programs menu to be closed')
  return closed
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
    const native = await spawnNativeWindow(base, state.knownWindowIds, {
      title: 'Derp Perf Load Drag',
      token: 'perf-load-drag',
      strip: 'blue',
    })
    state.spawnedNativeWindowIds.add(native.window.window_id)
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
    await writeJsonArtifact('active-drag-load-perf.json', {
      load_workers: load.workerCount,
      summary,
      perf,
    })
    assert(summary.raf_sample_count >= 3, `expected RAF frame samples during loaded drag, got ${summary.raf_sample_count}`)
    assert(summary.drm_render_ticks > 0, `expected compositor render ticks during loaded drag, got ${summary.drm_render_ticks}`)
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
  })
})
