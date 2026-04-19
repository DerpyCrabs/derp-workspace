import {
  activateTaskbarWindow,
  assert,
  clickRect,
  defineGroup,
  dragBetweenPoints,
  getJson,
  getPerfCounters,
  printNote,
  rectCenter,
  resetPerfCounters,
  spawnNativeWindow,
  waitFor,
  waitForWindowRaised,
  waitForNativeFocus,
  waitForTaskbarEntry,
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
      snapshot_notifies: after.shell_sync.snapshot_notifies - before.shell_sync.snapshot_notifies,
      snapshot_reads: after.shell_sync.snapshot_reads - before.shell_sync.snapshot_reads,
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
  await waitForWindowRaised(base, windowId, 4000)
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('idle and window churn expose stable perf counters', async ({ base, state }) => {
    const stamp = Date.now()
    const maxIdleBeginFrames = 96

    await sleep(750)
    let idleSample: PerfCounterSnapshot | null = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await resetPerfCounters(base)
      await sleep(1000)
      const sample = await getPerfCounters(base)
      if (
        sample.begin_frame.cef_send_external_begin_frame <= maxIdleBeginFrames &&
        sample.begin_frame.compositor_schedules_idle <= maxIdleBeginFrames &&
        sample.shell_sync.full_window_list_replies <= 1
      ) {
        idleSample = sample
        break
      }
      await sleep(250)
    }
    if (!idleSample) idleSample = await getPerfCounters(base)

    assert(
      idleSample.begin_frame.cef_send_external_begin_frame <= maxIdleBeginFrames,
      `idle begin frames regressed: expected <= ${maxIdleBeginFrames}, got ${idleSample.begin_frame.cef_send_external_begin_frame}`,
    )
    assert(
      idleSample.begin_frame.compositor_schedules_idle <= maxIdleBeginFrames,
      `idle compositor schedules regressed: expected <= ${maxIdleBeginFrames}, got ${idleSample.begin_frame.compositor_schedules_idle}`,
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
    const openedSample = await waitFor(
      'wait for perf counters after window open churn',
      async () => {
        const sample = await getPerfCounters(base)
        const delta = diffPerfCounters(sample, idleSample)
        if (delta.shell_updates.window_mapped_messages < 3) return null
        if (delta.shell_sync.full_window_list_replies > 4) return null
        if (delta.shell_sync.snapshot_notifies < 1) return null
        return sample
      },
      5000,
      100,
    )
    const openDelta = diffPerfCounters(openedSample, idleSample)

    assert(
      openDelta.shell_updates.window_mapped_messages >= 3,
      `window open churn should map at least 3 windows, got ${openDelta.shell_updates.window_mapped_messages}`,
    )
    assert(
      openDelta.shell_sync.full_window_list_replies <= 4,
      `window open churn should not require repeated full window lists, got ${openDelta.shell_sync.full_window_list_replies}`,
    )
    assert(openDelta.shell_sync.snapshot_notifies >= 1, 'window open churn should notify snapshot readers')

    await focusNativeWindow(base, mover.window.window_id)
    const focusedShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const controls = windowControls(focusedShell, mover.window.window_id)
    assert(controls?.titlebar, 'missing mover titlebar before perf move')
    const titlebarCenter = rectCenter(controls.titlebar)
    await dragBetweenPoints(base, titlebarCenter.x, titlebarCenter.y, titlebarCenter.x + 180, titlebarCenter.y + 48, 18)
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

    const churnDelta = diffPerfCounters(movedSample, idleSample)

    assert(
      churnDelta.shell_sync.full_window_list_replies <= 5,
      `window churn should not trigger repeated full window list replies, got ${churnDelta.shell_sync.full_window_list_replies}`,
    )
    printNote(
      `perf idle begin=${idleSample.begin_frame.cef_send_external_begin_frame} mapped=${openDelta.shell_updates.window_mapped_messages} moved=${moveDelta.shell_updates.window_geometry_messages} full_lists=${churnDelta.shell_sync.full_window_list_replies} snapshot_notifies=${churnDelta.shell_sync.snapshot_notifies} snapshot_reads=${churnDelta.shell_sync.snapshot_reads}`,
    )

    await writeJsonArtifact('perf-smoke-counters.json', {
      idle: idleSample,
      after_open: openedSample,
      after_move: movedSample,
      deltas: {
        open: openDelta,
        move: moveDelta,
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
