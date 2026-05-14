import {
  assert,
  defineGroup,
  getJson,
  getPerfCounters,
  resetPerfCounters,
  waitForCompositorQuiet,
  writeJsonArtifact,
  type ShellSnapshot,
} from '../lib/runtime.ts'

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
})
