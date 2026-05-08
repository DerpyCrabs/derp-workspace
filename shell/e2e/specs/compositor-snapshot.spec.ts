import {
  activateTaskbarWindow,
  assert,
  buildNativeSpawnCommand,
  clickPoint,
  compositorWindowStack,
  defineGroup,
  dragBetweenPoints,
  getJson,
  getSnapshots,
  getPerfCounters,
  rectCenter,
  resetPerfCounters,
  shellWindowStack,
  shellWindowById,
  NATIVE_APP_ID,
  spawnNativeWindow,
  waitFor,
  waitForNativeFocus,
  waitForWindowGone,
  waitForWindowMinimized,
  waitForTaskbarEntry,
  windowControls,
  writeStateDiffArtifact,
  type NativeSpawnResult,
  type CompositorSnapshot,
  type ShellSnapshot,
} from '../lib/runtime.ts'
import { closeWindow, openShellTestWindow, spawnCommand } from '../lib/setup.ts'

function trackedStackParity(shell: ShellSnapshot, compositor: CompositorSnapshot, windowIds: number[]) {
  const tracked = new Set(windowIds)
  const shellStack = shellWindowStack(shell).filter((windowId) => tracked.has(windowId))
  const compositorStack = compositorWindowStack(compositor).filter((windowId) => tracked.has(windowId))
  assert(
    shellStack.join(',') === compositorStack.join(','),
    `snapshot stack parity failed: shell=${shellStack.join(',')} compositor=${compositorStack.join(',')}`,
  )
}

function assertSnapshotAuthoritativeBridge(shell: ShellSnapshot, label: string) {
  const debug = shell.bridge_debug as
    | {
        last_drop?: { reason?: string }
        last_snapshot_incremental?: boolean
        last_snapshot_details?: Array<{ type?: string }>
      }
    | null
    | undefined
  assert(debug?.last_snapshot_incremental === false, `${label}: expected shared snapshot bridge`)
  assert(
    debug?.last_drop?.reason?.startsWith('snapshot_state_') === true,
    `${label}: expected compositor state incrementals to be wakeups`,
  )
}

async function spawnMetadataChangingNative(
  base: string,
  knownWindowIds: Set<number>,
  title: string,
  token: string,
): Promise<NativeSpawnResult> {
  const command = buildNativeSpawnCommand({
    title,
    token,
    strip: 'green',
    presentationSmoke: true,
  })
  await spawnCommand(base, command)
  return waitFor(
    `wait for ${title}`,
    async () => {
      const snapshot = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
      const window = snapshot.windows.find(
        (entry) =>
          !entry.shell_hosted &&
          !knownWindowIds.has(entry.window_id) &&
          entry.app_id === NATIVE_APP_ID &&
          entry.title.startsWith(title),
      )
      return window ? { snapshot, window, command } : null
    },
    5000,
    40,
  )
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('native window churn refreshes shell from authoritative shared snapshots', async ({ base, state }) => {
    await resetPerfCounters(base)
    const stamp = Date.now()
    const spawned = await spawnMetadataChangingNative(
      base,
      state.knownWindowIds,
      `Derp Snapshot ${stamp}`,
      `snapshot-${stamp}`,
    )
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
    assertSnapshotAuthoritativeBridge(shell, 'native spawn')
    assert(row.client_x === row.x && row.client_y === row.y, 'native row should expose compositor client origin')
    assert(row.client_width === row.width && row.client_height === row.height, 'native row should expose compositor client size')
    assert(typeof row.frame_x === 'number' && typeof row.frame_y === 'number', 'native row should expose compositor frame origin')
    assert(typeof row.frame_width === 'number' && row.frame_width >= row.width, 'native row should expose compositor frame width')
    assert(typeof row.frame_height === 'number' && row.frame_height > row.height, 'native row should expose compositor frame height')
    await writeStateDiffArtifact(base, 'compositor-snapshot-domain-state-diff.json')

    const perf = await getPerfCounters(base)
    assert(perf.shell_updates.batch_count >= 1, 'expected compositor batch delivery after native window spawn')
    assert(perf.shell_updates.window_mapped_messages >= 1, 'expected mapped window detail after native window spawn')
    assert(
      (perf.shell_runtime?.snapshot_apply_count ?? 0) >= 1,
      `expected snapshot apply after native window spawn, got ${perf.shell_runtime?.snapshot_apply_count ?? 0}`,
    )
    assert(perf.shell_sync.snapshot_reads <= 6, `expected bounded snapshot reads after native window spawn, got ${perf.shell_sync.snapshot_reads}`)

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
    assertSnapshotAuthoritativeBridge(moved.shell, 'native move')
    const movedCompositor = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const movedAuthoritativeRow = shellWindowById(movedCompositor, spawned.window.window_id)
    assert(movedAuthoritativeRow, 'moved window missing after authoritative snapshot refresh')
    assert(
      movedAuthoritativeRow.x === moved.row.x &&
        movedAuthoritativeRow.y === moved.row.y &&
        movedAuthoritativeRow.width === moved.row.width &&
        movedAuthoritativeRow.height === moved.row.height,
      'shell state should remain stable after the snapshot-authoritative move settles',
    )
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
    assert(
      (movePerf.shell_runtime?.snapshot_apply_count ?? 0) >= 1,
      `expected snapshot apply after native window geometry change, got ${movePerf.shell_runtime?.snapshot_apply_count ?? 0}`,
    )

    const metadata = await waitFor(
      'wait for shell snapshot bridge metadata',
      async () => {
        const current = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const next = shellWindowById(current, spawned.window.window_id)
        return next && next.title.includes('presented=') ? { shell: current, row: next } : null
      },
      5000,
      100,
    )
    assert(metadata.row.title.includes('presented='), 'shell snapshot did not receive native metadata change')

    const minimizeControls = windowControls(metadata.shell, spawned.window.window_id)
    assert(minimizeControls?.minimize, 'spawned native window missing minimize control')
    await resetPerfCounters(base)
    const minimizePoint = rectCenter(minimizeControls.minimize)
    await clickPoint(base, minimizePoint.x, minimizePoint.y)
    const minimized = await waitForWindowMinimized(base, spawned.window.window_id)
    assert(shellWindowById(minimized.shell, spawned.window.window_id)?.minimized, 'shell snapshot did not receive minimized state')
    assertSnapshotAuthoritativeBridge(minimized.shell, 'native minimize')
    const minimizePerf = await getPerfCounters(base)
    assert(
      minimizePerf.shell_updates.window_state_messages >= 1,
      `expected window state wakeup after minimize, got ${minimizePerf.shell_updates.window_state_messages}`,
    )
    assert(
      (minimizePerf.shell_runtime?.snapshot_apply_count ?? 0) >= 1,
      `expected snapshot apply after minimize, got ${minimizePerf.shell_runtime?.snapshot_apply_count ?? 0}`,
    )

    await activateTaskbarWindow(base, minimized.shell, spawned.window.window_id)
    await waitForNativeFocus(base, spawned.window.window_id)

    const second = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Snapshot Peer ${stamp}`,
      token: `snapshot-peer-${stamp}`,
      strip: 'red',
    })
    state.spawnedNativeWindowIds.add(second.window.window_id)
    await waitForTaskbarEntry(base, second.window.window_id)
    await resetPerfCounters(base)
    const focusControls = windowControls(await getJson<ShellSnapshot>(base, '/test/state/shell'), spawned.window.window_id)
    assert(focusControls?.titlebar, 'spawned native window missing focus titlebar')
    const focusPoint = rectCenter(focusControls.titlebar)
    await clickPoint(base, focusPoint.x, focusPoint.y)
    const focused = await waitForNativeFocus(base, spawned.window.window_id)
    trackedStackParity(focused.shell, focused.compositor, [spawned.window.window_id, second.window.window_id])
    assertSnapshotAuthoritativeBridge(focused.shell, 'native focus')
    const focusPerf = await getPerfCounters(base)
    assert(
      focusPerf.shell_updates.focus_changed_messages >= 1,
      `expected focus wakeup after titlebar click, got ${focusPerf.shell_updates.focus_changed_messages}`,
    )
    assert(
      (focusPerf.shell_runtime?.snapshot_apply_count ?? 0) >= 1,
      `expected snapshot apply after focus/restack, got ${focusPerf.shell_runtime?.snapshot_apply_count ?? 0}`,
    )

    await resetPerfCounters(base)
    await closeWindow(base, second.window.window_id)
    await waitForWindowGone(base, second.window.window_id)
    const afterClose = await getSnapshots(base)
    assert(!shellWindowById(afterClose.shell, second.window.window_id), 'closed native window remained in shell snapshot')
    trackedStackParity(afterClose.shell, afterClose.compositor, [spawned.window.window_id])
    assertSnapshotAuthoritativeBridge(afterClose.shell, 'native close')
    const closePerf = await getPerfCounters(base)
    assert(
      (closePerf.shell_runtime?.snapshot_apply_count ?? 0) >= 1,
      `expected snapshot apply after native unmap, got ${closePerf.shell_runtime?.snapshot_apply_count ?? 0}`,
    )

    await resetPerfCounters(base)
    const shellHosted = await openShellTestWindow(base, state)
    trackedStackParity(shellHosted.shell, shellHosted.compositor, [
      spawned.window.window_id,
      shellHosted.window.window_id,
    ])
    assertSnapshotAuthoritativeBridge(shellHosted.shell, 'shell-hosted open')
    const shellHostedPerf = await getPerfCounters(base)
    assert(
      (shellHostedPerf.shell_runtime?.snapshot_apply_count ?? 0) >= 1,
      `expected snapshot apply after shell-hosted open, got ${shellHostedPerf.shell_runtime?.snapshot_apply_count ?? 0}`,
    )
  })
})
