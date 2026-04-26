import {
  assert,
  defineGroup,
  getJson,
  getPerfCounters,
  resetPerfCounters,
  waitFor,
  type ShellSnapshot,
} from '../lib/runtime.ts'

export default defineGroup(import.meta.url, ({ test }) => {
  test('shell boots and paints through CEF software OSR', async ({ base }) => {
    await resetPerfCounters(base)
    const shell = await waitFor(
      'wait for software-rendered shell chrome',
      async () => {
        const current = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return current.controls.taskbar_programs_toggle ? current : null
      },
      5000,
      50,
    )
    assert(shell.taskbars.length >= 1, 'expected taskbar in software-rendered shell')
    const perf = await waitFor(
      'wait for CEF software paints',
      async () => {
        const current = await getPerfCounters(base)
        return current.begin_frame.cef_software_paints > 0 ? current : null
      },
      5000,
      50,
    )
    assert(
      perf.begin_frame.cef_accelerated_paints === 0,
      `expected software OSR without accelerated paints, got ${perf.begin_frame.cef_accelerated_paints}`,
    )
  })
})
