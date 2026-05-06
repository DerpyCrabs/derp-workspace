import {
  assert,
  defineGroup,
  dragBetweenPoints,
  getJson,
  getPerfCounters,
  rectCenter,
  resetPerfCounters,
  shellWindowById,
  spawnNativeWindow,
  waitFor,
  waitForTaskbarEntry,
  windowControls,
  writeStateDiffArtifact,
  type ShellSnapshot,
} from '../lib/runtime.ts'

export default defineGroup(import.meta.url, ({ test }) => {
  test('native window churn refreshes shell through direct compositor batches', async ({ base, state }) => {
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
    assert(row.client_x === row.x && row.client_y === row.y, 'native row should expose compositor client origin')
    assert(row.client_width === row.width && row.client_height === row.height, 'native row should expose compositor client size')
    assert(typeof row.frame_x === 'number' && typeof row.frame_y === 'number', 'native row should expose compositor frame origin')
    assert(typeof row.frame_width === 'number' && row.frame_width >= row.width, 'native row should expose compositor frame width')
    assert(typeof row.frame_height === 'number' && row.frame_height > row.height, 'native row should expose compositor frame height')
    await writeStateDiffArtifact(base, 'compositor-snapshot-domain-state-diff.json')

    const perf = await getPerfCounters(base)
    assert(perf.shell_updates.batch_count >= 1, 'expected compositor batch delivery after native window spawn')
    assert(perf.shell_updates.window_mapped_messages >= 1, 'expected mapped window detail after native window spawn')
    assert(perf.shell_sync.snapshot_reads <= 1, `expected <= 1 snapshot read after native window spawn, got ${perf.shell_sync.snapshot_reads}`)

    const controls = windowControls(shell, spawned.window.window_id)
    assert(controls?.titlebar, 'spawned native window missing shell titlebar controls')
    assert(
      Math.abs(controls.titlebar.width - (row.frame_width ?? 0)) <= 1,
      `titlebar width should come from compositor frame width (${controls.titlebar.width} vs ${row.frame_width})`,
    )
    const start = rectCenter(controls.titlebar)
    await resetPerfCounters(base)
    await dragBetweenPoints(base, start.x, start.y, start.x + 72, start.y, 8)
    const moved = await waitFor(
      'wait for shell snapshot bridge geometry',
      async () => {
        const current = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const next = shellWindowById(current, spawned.window.window_id)
        return next && next.x !== row.x ? { shell: current, row: next } : null
      },
      5000,
      100,
    )

    assert(moved.row.x !== row.x, 'shell snapshot did not receive moved window geometry')
    const movePerf = await getPerfCounters(base)
    assert(
      (movePerf.shell_runtime?.batch_apply_count ?? 0) >= 1,
      `expected batched shell detail apply after native window geometry change, got ${movePerf.shell_runtime?.batch_apply_count ?? 0}`,
    )
    assert(
      (movePerf.shell_runtime?.batch_apply_details ?? 0) >= 1,
      `expected batched shell detail apply details after native window geometry change, got ${movePerf.shell_runtime?.batch_apply_details ?? 0}`,
    )
    assert(
      movePerf.shell_updates.window_geometry_messages <= 20,
      `expected bounded geometry churn during one drag, got ${movePerf.shell_updates.window_geometry_messages}`,
    )
    assert(
      movePerf.shell_sync.snapshot_reads >= 1,
      `expected immutable snapshot read after native window geometry change, got ${movePerf.shell_sync.snapshot_reads}`,
    )
  })
})
