import {
  assert,
  defineGroup,
  getJson,
  getPerfCounters,
  resetPerfCounters,
  shellWindowById,
  spawnNativeWindow,
  waitFor,
  waitForTaskbarEntry,
  type ShellSnapshot,
} from '../lib/runtime.ts'

export default defineGroup(import.meta.url, ({ test }) => {
  test('native window churn refreshes shell through compositor snapshot reads', async ({ base, state }) => {
    await resetPerfCounters(base)
    const stamp = Date.now()
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Snapshot ${stamp}`,
      token: `snapshot-${stamp}`,
      strip: 'green',
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)

    await waitForTaskbarEntry(base, spawned.window.window_id)
    const shell = await waitFor(
      'wait for shell snapshot bridge window',
      async () => {
        const current = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return shellWindowById(current, spawned.window.window_id) ? current : null
      },
      5000,
      100,
    )

    const row = shellWindowById(shell, spawned.window.window_id)
    assert(row, 'spawned native window missing from shell snapshot state')

    const perf = await getPerfCounters(base)
    assert(perf.shell_sync.snapshot_notifies >= 1, 'expected compositor snapshot notify after native window spawn')
    assert(perf.shell_sync.snapshot_reads >= 1, 'expected shell snapshot read after native window spawn')
  })
})
