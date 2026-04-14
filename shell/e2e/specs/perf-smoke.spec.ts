import {
  activateTaskbarWindow,
  assert,
  clickRect,
  compositorWindowById,
  defineGroup,
  dragBetweenPoints,
  getJson,
  getPerfCounters,
  getSnapshots,
  printNote,
  rectCenter,
  resetPerfCounters,
  shellWindowById,
  spawnNativeWindow,
  waitFor,
  waitForNativeFocus,
  waitForTaskbarEntry,
  waitForWindowMinimized,
  windowControls,
  writeJsonArtifact,
  type PerfCounterSnapshot,
  type ShellSnapshot,
} from '../lib/runtime.ts'

function diffPerfCounters(after: PerfCounterSnapshot, before: PerfCounterSnapshot): PerfCounterSnapshot {
  return {
    begin_frame: {
      compositor_schedules: after.begin_frame.compositor_schedules - before.begin_frame.compositor_schedules,
      compositor_schedules_idle: after.begin_frame.compositor_schedules_idle - before.begin_frame.compositor_schedules_idle,
      compositor_schedules_active: after.begin_frame.compositor_schedules_active - before.begin_frame.compositor_schedules_active,
      compositor_schedules_forced: after.begin_frame.compositor_schedules_forced - before.begin_frame.compositor_schedules_forced,
      cef_send_external_begin_frame:
        after.begin_frame.cef_send_external_begin_frame - before.begin_frame.cef_send_external_begin_frame,
      drm_render_ticks: after.begin_frame.drm_render_ticks - before.begin_frame.drm_render_ticks,
    },
    shell_updates: {
      batch_count: after.shell_updates.batch_count - before.shell_updates.batch_count,
      message_count: after.shell_updates.message_count - before.shell_updates.message_count,
      window_list_messages: after.shell_updates.window_list_messages - before.shell_updates.window_list_messages,
      window_mapped_messages: after.shell_updates.window_mapped_messages - before.shell_updates.window_mapped_messages,
      window_geometry_messages:
        after.shell_updates.window_geometry_messages - before.shell_updates.window_geometry_messages,
      window_metadata_messages:
        after.shell_updates.window_metadata_messages - before.shell_updates.window_metadata_messages,
      window_state_messages: after.shell_updates.window_state_messages - before.shell_updates.window_state_messages,
      focus_changed_messages: after.shell_updates.focus_changed_messages - before.shell_updates.focus_changed_messages,
    },
    shell_sync: {
      full_window_list_replies:
        after.shell_sync.full_window_list_replies - before.shell_sync.full_window_list_replies,
    },
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function focusNativeWindow(base: string, windowId: number): Promise<void> {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const controls = windowControls(shell, windowId)
  if (controls?.titlebar) {
    await clickRect(base, controls.titlebar)
    try {
      await waitForNativeFocus(base, windowId, 1500)
      return
    } catch {}
  }
  await activateTaskbarWindow(base, shell, windowId)
  await waitForNativeFocus(base, windowId, 4000)
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('idle and window churn expose stable perf counters', async ({ base, state }) => {
    const stamp = Date.now()

    await sleep(750)
    await resetPerfCounters(base)
    await sleep(1500)
    const idleSample = await getPerfCounters(base)

    assert(
      idleSample.begin_frame.cef_send_external_begin_frame <= 16,
      `idle begin frames regressed: expected <= 16, got ${idleSample.begin_frame.cef_send_external_begin_frame}`,
    )
    assert(
      idleSample.begin_frame.compositor_schedules_idle <= 16,
      `idle compositor schedules regressed: expected <= 16, got ${idleSample.begin_frame.compositor_schedules_idle}`,
    )
    assert(
      idleSample.shell_sync.full_window_list_replies <= 1,
      `idle full window list replies regressed: expected <= 1, got ${idleSample.shell_sync.full_window_list_replies}`,
    )

    const red = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Perf Red ${stamp}`,
      token: `perf-red-${stamp}`,
      strip: 'red',
    })
    state.spawnedNativeWindowIds.add(red.window.window_id)

    const green = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Perf Green ${stamp}`,
      token: `perf-green-${stamp}`,
      strip: 'green',
    })
    state.spawnedNativeWindowIds.add(green.window.window_id)

    const mover = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Perf Move ${stamp}`,
      token: `perf-move-${stamp}`,
      strip: 'red',
    })
    state.spawnedNativeWindowIds.add(mover.window.window_id)

    await waitForTaskbarEntry(base, red.window.window_id)
    await waitForTaskbarEntry(base, green.window.window_id)
    await waitForTaskbarEntry(base, mover.window.window_id)
    await sleep(250)
    const openedSample = await getPerfCounters(base)
    const openDelta = diffPerfCounters(openedSample, idleSample)

    assert(
      openDelta.shell_updates.window_mapped_messages >= 3,
      `window open churn should map at least 3 windows, got ${openDelta.shell_updates.window_mapped_messages}`,
    )
    assert(
      openDelta.shell_sync.full_window_list_replies <= 1,
      `window open churn should not require repeated full window lists, got ${openDelta.shell_sync.full_window_list_replies}`,
    )

    await focusNativeWindow(base, mover.window.window_id)
    const moveStart = compositorWindowById((await getSnapshots(base)).compositor, mover.window.window_id)
    assert(moveStart, 'missing mover window before perf move')
    const focusedShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const controls = windowControls(focusedShell, mover.window.window_id)
    assert(controls?.titlebar, 'missing mover titlebar before perf move')
    const titlebarCenter = rectCenter(controls.titlebar)
    await dragBetweenPoints(base, titlebarCenter.x, titlebarCenter.y, titlebarCenter.x + 180, titlebarCenter.y + 48, 18)
    await waitFor(
      'wait for perf move',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const moved = compositorWindowById(compositor, mover.window.window_id)
        if (!moved) return null
        return Math.abs(moved.x - moveStart.x) >= 40 || Math.abs(moved.y - moveStart.y) >= 24 ? moved : null
      },
      5000,
      100,
    )
    await sleep(250)
    const movedSample = await getPerfCounters(base)
    const moveDelta = diffPerfCounters(movedSample, openedSample)

    assert(
      moveDelta.shell_updates.window_geometry_messages >= 1,
      `window move should emit geometry updates, got ${moveDelta.shell_updates.window_geometry_messages}`,
    )
    assert(
      moveDelta.begin_frame.cef_send_external_begin_frame >= 1,
      `window move should drive begin frames, got ${moveDelta.begin_frame.cef_send_external_begin_frame}`,
    )

    const shellBeforeMinimize = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeMinimize, mover.window.window_id)
    const minimized = await waitForWindowMinimized(base, mover.window.window_id)
    assert(shellWindowById(minimized.shell, mover.window.window_id)?.minimized, 'mover window should minimize in perf smoke test')
    await sleep(250)
    const minimizedSample = await getPerfCounters(base)
    const minimizeDelta = diffPerfCounters(minimizedSample, movedSample)

    await activateTaskbarWindow(base, minimized.shell, mover.window.window_id)
    await waitForNativeFocus(base, mover.window.window_id)
    await waitFor(
      'wait for perf restore',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const restored = shellWindowById(shell, mover.window.window_id)
        return restored && !restored.minimized ? shell : null
      },
      5000,
      125,
    )
    await sleep(250)
    const restoredSample = await getPerfCounters(base)
    const restoreDelta = diffPerfCounters(restoredSample, minimizedSample)

    const minimizeRestoreStateMessages =
      minimizeDelta.shell_updates.window_state_messages + restoreDelta.shell_updates.window_state_messages
    const churnDelta = diffPerfCounters(restoredSample, idleSample)

    assert(
      minimizeRestoreStateMessages >= 2,
      `minimize and restore should emit at least 2 window state updates, got ${minimizeRestoreStateMessages}`,
    )
    assert(
      churnDelta.shell_sync.full_window_list_replies <= 2,
      `window churn should not trigger repeated full window list replies, got ${churnDelta.shell_sync.full_window_list_replies}`,
    )
    assert(
      churnDelta.shell_updates.batch_count > idleSample.shell_updates.batch_count,
      `window churn should emit more shell update batches than idle, got idle=${idleSample.shell_updates.batch_count} churn=${churnDelta.shell_updates.batch_count}`,
    )

    printNote(
      `perf idle begin=${idleSample.begin_frame.cef_send_external_begin_frame} mapped=${openDelta.shell_updates.window_mapped_messages} moved=${moveDelta.shell_updates.window_geometry_messages} state=${minimizeRestoreStateMessages} full_lists=${churnDelta.shell_sync.full_window_list_replies}`,
    )

    await writeJsonArtifact('perf-smoke-counters.json', {
      idle: idleSample,
      after_open: openedSample,
      after_move: movedSample,
      after_minimize: minimizedSample,
      after_restore: restoredSample,
      deltas: {
        open: openDelta,
        move: moveDelta,
        minimize: minimizeDelta,
        restore: restoreDelta,
        churn: churnDelta,
      },
      windows: {
        red: red.window,
        green: green.window,
        mover: mover.window,
      },
    })
  })
})
