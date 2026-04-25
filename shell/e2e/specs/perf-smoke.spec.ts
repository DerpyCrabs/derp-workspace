import {
  assert,
  captureScreenshotRect,
  copyArtifactFile,
  defineGroup,
  diffPerfCounters,
  dragBetweenPoints,
  getJson,
  getPerfCounters,
  getSnapshots,
  keyAction,
  measurePointerInteractionPerf,
  outputForWindow,
  pickMonitorMove,
  printNote,
  postJson,
  raiseTaskbarWindow,
  readPngRgba,
  rectCenter,
  resetPerfCounters,
  runKeybind,
  spawnNativeWindow,
  waitFor,
  waitForTaskbarEntry,
  windowControls,
  writeJsonArtifact,
  type CompositorSnapshot,
  type PerfCounterSnapshot,
  type ShellSnapshot,
} from '../lib/runtime.ts'

const SUPER_KEYCODE = 125

function perfStageRow(name: string, sample: PerfCounterSnapshot) {
  const latencySamples = Math.max(1, sample.latency.samples)
  const dirtySamples = Math.max(1, sample.dirty_rects.samples)
  return {
    name,
    latency_samples: sample.latency.samples,
    schedule_to_dmabuf_us_total: sample.latency.schedule_to_dmabuf_us,
    schedule_to_dmabuf_us_avg: sample.latency.schedule_to_dmabuf_us / latencySamples,
    paint_to_dmabuf_us_total: sample.latency.paint_to_dmabuf_us,
    paint_to_dmabuf_us_avg: sample.latency.paint_to_dmabuf_us / latencySamples,
    dmabuf_to_render_us_total: sample.latency.dmabuf_to_render_us,
    dmabuf_to_render_us_avg: sample.latency.dmabuf_to_render_us / latencySamples,
    schedule_to_render_us_total: sample.latency.schedule_to_render_us,
    schedule_to_render_us_avg: sample.latency.schedule_to_render_us / latencySamples,
    schedule_to_render_max_us: sample.latency.schedule_to_render_max_us,
    dirty_samples: sample.dirty_rects.samples,
    dirty_coverage_per_mille_avg: sample.dirty_rects.coverage_per_mille / dirtySamples,
    dirty_coverage_per_mille_max: sample.dirty_rects.max_coverage_per_mille,
    dirty_bbox_full_count: sample.dirty_rects.bbox_full_count,
    snapshot_decode_ms: sample.shell_runtime?.snapshot_decode_ms ?? 0,
    snapshot_decode_bytes: sample.shell_runtime?.snapshot_decode_bytes ?? 0,
    snapshot_apply_ms: sample.shell_runtime?.snapshot_apply_ms ?? 0,
    dom_measure_count: sample.shell_runtime?.dom_measure_count ?? 0,
  }
}

function perfRankRows(stages: ReturnType<typeof perfStageRow>[]) {
  return [
    ...stages.map((stage) => ({
      stage: stage.name,
      metric: 'schedule_to_dmabuf_us_total',
      value: stage.schedule_to_dmabuf_us_total,
    })),
    ...stages.map((stage) => ({
      stage: stage.name,
      metric: 'paint_to_dmabuf_us_total',
      value: stage.paint_to_dmabuf_us_total,
    })),
    ...stages.map((stage) => ({
      stage: stage.name,
      metric: 'dmabuf_to_render_us_total',
      value: stage.dmabuf_to_render_us_total,
    })),
    ...stages.map((stage) => ({
      stage: stage.name,
      metric: 'dirty_coverage_per_mille_avg',
      value: stage.dirty_coverage_per_mille_avg,
    })),
    ...stages.map((stage) => ({
      stage: stage.name,
      metric: 'snapshot_decode_ms',
      value: stage.snapshot_decode_ms,
    })),
    ...stages.map((stage) => ({
      stage: stage.name,
      metric: 'snapshot_apply_ms',
      value: stage.snapshot_apply_ms,
    })),
    ...stages.map((stage) => ({
      stage: stage.name,
      metric: 'dom_measure_count',
      value: stage.dom_measure_count,
    })),
  ]
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
}

async function assertScreenshotRectMostlyFlat(path: string, label: string) {
  const png = await readPngRgba(path)
  let minR = 255
  let minG = 255
  let minB = 255
  let maxR = 0
  let maxG = 0
  let maxB = 0
  for (let index = 0; index < png.data.length; index += 4) {
    const r = png.data[index] ?? 0
    const g = png.data[index + 1] ?? 0
    const b = png.data[index + 2] ?? 0
    minR = Math.min(minR, r)
    minG = Math.min(minG, g)
    minB = Math.min(minB, b)
    maxR = Math.max(maxR, r)
    maxG = Math.max(maxG, g)
    maxB = Math.max(maxB, b)
  }
  const spread = Math.max(maxR - minR, maxG - minG, maxB - minB)
  assert(spread <= 6, `${label} should be cleared to desktop, got RGB spread ${spread}`)
}

async function focusNativeWindow(base: string, windowId: number): Promise<ShellSnapshot> {
  await raiseTaskbarWindow(base, windowId)
  return waitFor(
    `wait for native titlebar rects ${windowId}`,
    async () => {
      const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return windowControls(next, windowId)?.titlebar ? next : null
    },
    2000,
    50,
  )
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('idle and window churn expose stable perf counters', async ({ base, state }) => {
    const stamp = Date.now()
    const maxIdleBeginFrames = 96

    await resetPerfCounters(base)
    const idleSample = await waitFor(
      'wait for idle perf counter baseline',
      async () => {
        const sample = await getPerfCounters(base)
        if (
          sample.begin_frame.cef_send_external_begin_frame <= maxIdleBeginFrames &&
          sample.begin_frame.compositor_schedules_idle <= maxIdleBeginFrames &&
          sample.shell_sync.full_window_list_replies <= 1
        ) {
          return sample
        }
        await resetPerfCounters(base)
        return null
      },
      5000,
      150,
    )

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
        if (delta.shell_updates.batch_count < 1) return null
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
    assert(openDelta.shell_updates.batch_count >= 1, 'window open churn should deliver compositor batches')
    assert(
      openDelta.shell_sync.snapshot_full_bytes === 0,
      `window open churn should avoid full snapshot payload reads, got ${openDelta.shell_sync.snapshot_full_bytes} bytes`,
    )
    assert(
      openDelta.shell_sync.snapshot_dirty_fallbacks === 0,
      `window open churn dirty snapshots should not fall back to full payloads, got ${openDelta.shell_sync.snapshot_dirty_fallbacks}`,
    )

    await resetPerfCounters(base)
    await getJson<ShellSnapshot>(base, '/test/snapshot/sync')
    await getJson<ShellSnapshot>(base, '/test/snapshot/sync')
    const dirtySample = await getPerfCounters(base)

    assert(
      dirtySample.shell_sync.snapshot_dirty_reads >= 1,
      `snapshot sync should call the dirty snapshot reader, got ${dirtySample.shell_sync.snapshot_dirty_reads}`,
    )
    assert(
      dirtySample.shell_sync.snapshot_dirty_unchanged >= 1,
      `unchanged snapshot sync should return an explicit status, got ${dirtySample.shell_sync.snapshot_dirty_unchanged}`,
    )
    assert(
      dirtySample.shell_sync.snapshot_dirty_fallbacks === 0,
      `unchanged dirty snapshots should not fall back to full payloads, got ${dirtySample.shell_sync.snapshot_dirty_fallbacks}`,
    )

    const focusedShell = await focusNativeWindow(base, red.window.window_id)
    const controls = windowControls(focusedShell, red.window.window_id)
    assert(controls?.titlebar, 'missing red titlebar before perf move')
    const titlebarCenter = rectCenter(controls.titlebar)
    await resetPerfCounters(base)
    await dragBetweenPoints(base, titlebarCenter.x, titlebarCenter.y, titlebarCenter.x + 180, titlebarCenter.y + 48, 18)
    const movedSample = await waitFor(
      'wait for perf counters after window drag',
      async () => {
        const sample = await getPerfCounters(base)
        if (sample.shell_updates.window_geometry_messages < 1) return null
        if (sample.begin_frame.cef_send_external_begin_frame < 1) return null
        return sample
      },
      5000,
      100,
    )
    const moveDelta = movedSample

    assert(
      moveDelta.shell_updates.window_geometry_messages >= 1,
      `window move should emit geometry updates, got ${moveDelta.shell_updates.window_geometry_messages}`,
    )
    assert(
      moveDelta.begin_frame.cef_send_external_begin_frame >= 1,
      `window move should drive begin frames, got ${moveDelta.begin_frame.cef_send_external_begin_frame}`,
    )
    assert(
      moveDelta.begin_frame.compositor_schedules_forced <= 2,
      `window move should not rely on forced begin frames, got ${moveDelta.begin_frame.compositor_schedules_forced}`,
    )
    assert(
      moveDelta.begin_frame.cef_send_external_begin_frame <= moveDelta.begin_frame.drm_render_ticks + 8,
      `window move begin frames regressed: expected <= drm ticks + 8, got begin=${moveDelta.begin_frame.cef_send_external_begin_frame} drm=${moveDelta.begin_frame.drm_render_ticks}`,
    )
    assert(
      moveDelta.begin_frame.cef_software_paints === 0,
      `CEF shell should stay on accelerated OSR during move, got software paints=${moveDelta.begin_frame.cef_software_paints}`,
    )
    assert(moveDelta.latency.samples >= 1, `window move should expose latency samples, got ${moveDelta.latency.samples}`)
    assert(
      moveDelta.latency.schedule_to_render_us > 0,
      `window move latency should include schedule-to-render time, got ${moveDelta.latency.schedule_to_render_us}us`,
    )

    assert(
      moveDelta.shell_sync.full_window_list_replies <= 2,
      `window drag should not trigger repeated full window list replies, got ${moveDelta.shell_sync.full_window_list_replies}`,
    )
    assert(
      moveDelta.shell_sync.snapshot_notifies <= 2,
      `window drag should not trigger repeated snapshot notifications, got ${moveDelta.shell_sync.snapshot_notifies}`,
    )

    const afterShortDrag = await focusNativeWindow(base, red.window.window_id)
    const longDragControls = windowControls(afterShortDrag, red.window.window_id)
    assert(longDragControls?.titlebar, 'missing red titlebar before long perf move')
    const longDragStart = rectCenter(longDragControls.titlebar)
    const longDragMeasured = await measurePointerInteractionPerf(
      base,
      'long window drag',
      () =>
        postJson(base, '/test/input/drag', {
          x0: longDragStart.x,
          y0: longDragStart.y,
          x1: longDragStart.x + 520,
          y1: longDragStart.y + 96,
          button: 0x110,
          steps: 240,
        }),
      {
        afterInteraction: () =>
          waitFor(
            'wait for perf counters after long window drag',
            async () => {
              const sample = await getPerfCounters(base)
              if (sample.shell_updates.window_geometry_messages < 1) return null
              return sample
            },
            5000,
            100,
          ),
        budget: {
          sharedStateUiWindowWrites: 4,
          sharedStateExclusionWrites: 4,
          fullWindowListReplies: 2,
          snapshotDirtyFallbacks: 0,
          snapshotEncodeUs: 200000,
          snapshotDecodeMs: 100,
          snapshotDecodeBytes: 128 * 1024,
          snapshotApplyMs: 80,
          domMeasureCount: 24,
        },
      },
    )
    const longDragSample = longDragMeasured.sample

    assert(
      longDragSample.shell_updates.window_geometry_messages <= 48,
      `long drag should coalesce geometry updates, got ${longDragSample.shell_updates.window_geometry_messages}`,
    )
    assert(
      longDragSample.shell_updates.message_count <= 96,
      `long drag should not flood shell messages, got ${longDragSample.shell_updates.message_count}`,
    )
    assert(
      longDragSample.begin_frame.compositor_schedules_forced <= 2,
      `long drag should not rely on forced begin frames, got ${longDragSample.begin_frame.compositor_schedules_forced}`,
    )
    assert(
      longDragSample.begin_frame.cef_send_external_begin_frame <= longDragSample.begin_frame.drm_render_ticks + 8,
      `long drag begin frames regressed: expected <= drm ticks + 8, got begin=${longDragSample.begin_frame.cef_send_external_begin_frame} drm=${longDragSample.begin_frame.drm_render_ticks}`,
    )
    assert(
      longDragSample.shell_sync.snapshot_notifies <= 4,
      `long drag should not trigger repeated snapshot notifications, got ${longDragSample.shell_sync.snapshot_notifies}`,
    )
    assert(
      longDragSample.shell_sync.snapshot_reads <= 2,
      `long drag should not require full snapshot reads, got ${longDragSample.shell_sync.snapshot_reads}`,
    )

    const stressDragControls = windowControls(await focusNativeWindow(base, red.window.window_id), red.window.window_id)
    assert(stressDragControls?.titlebar, 'missing red titlebar before stress perf move')
    const stressDragStart = rectCenter(stressDragControls.titlebar)
    const stressDragMeasured = await measurePointerInteractionPerf(
      base,
      'stress window drag',
      () =>
        postJson(base, '/test/input/drag', {
          x0: stressDragStart.x,
          y0: stressDragStart.y,
          x1: stressDragStart.x + 360,
          y1: stressDragStart.y + 36,
          button: 0x110,
          steps: 720,
        }),
      {
        afterInteraction: () =>
          waitFor(
            'wait for perf counters after stress window drag',
            async () => {
              const sample = await getPerfCounters(base)
              if (sample.shell_updates.window_geometry_messages < 1) return null
              return sample
            },
            5000,
            100,
          ),
        budget: {
          sharedStateUiWindowWrites: 4,
          sharedStateExclusionWrites: 4,
          fullWindowListReplies: 2,
          snapshotDirtyFallbacks: 0,
          snapshotEncodeUs: 300000,
          snapshotDecodeMs: 160,
          snapshotDecodeBytes: 256 * 1024,
          snapshotApplyMs: 120,
          domMeasureCount: 24,
        },
      },
    )
    const stressDragSample = stressDragMeasured.sample
    assert(
      stressDragSample.shell_updates.window_geometry_messages <= 96,
      `stress drag should coalesce geometry updates, got ${stressDragSample.shell_updates.window_geometry_messages}`,
    )
    assert(
      stressDragSample.shell_updates.message_count <= 480,
      `stress drag should not flood shell messages, got ${stressDragSample.shell_updates.message_count}`,
    )
    assert(
      stressDragSample.shell_sync.shared_state_exclusion_writes <= 4,
      `stress drag should not repeatedly write exclusion zones, got ${stressDragSample.shell_sync.shared_state_exclusion_writes}`,
    )

    await resetPerfCounters(base)
    for (let cycle = 0; cycle < 6; cycle += 1) {
      await keyAction(base, SUPER_KEYCODE, 'tap')
      await keyAction(base, SUPER_KEYCODE, 'tap')
    }
    const menuChurnSample = await getPerfCounters(base)
    const afterMenuChurn = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assert(!afterMenuChurn.programs_menu_open, 'programs menu churn should end closed')
    assert(
      menuChurnSample.shell_sync.full_window_list_replies <= 2,
      `programs menu churn should avoid full window lists, got ${menuChurnSample.shell_sync.full_window_list_replies}`,
    )
    assert(
      menuChurnSample.shell_sync.snapshot_notifies <= 4,
      `programs menu churn should avoid snapshot notifies, got ${menuChurnSample.shell_sync.snapshot_notifies}`,
    )
    assert(
      menuChurnSample.begin_frame.compositor_schedules_forced <= 2,
      `programs menu churn should avoid forced begin frames, got ${menuChurnSample.begin_frame.compositor_schedules_forced}`,
    )
    assert(
      menuChurnSample.shell_sync.shared_state_exclusion_writes <= 12,
      `programs menu churn should coalesce exclusion writes, got ${menuChurnSample.shell_sync.shared_state_exclusion_writes}`,
    )
    assert(
      menuChurnSample.shell_sync.shared_state_ui_window_writes <= 24,
      `programs menu churn should coalesce shell ui writes, got ${menuChurnSample.shell_sync.shared_state_ui_window_writes}`,
    )

    const beforeScale = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    await resetPerfCounters(base)
    await runKeybind(base, 'toggle_fullscreen', red.window.window_id)
    const fullscreenBypassSample = await waitFor(
      'wait for fullscreen native shell bypass',
      async () => {
        const sample = await getPerfCounters(base)
        if (sample.begin_frame.drm_fullscreen_shell_bypasses < 1) return null
        return sample
      },
      5000,
      100,
    )
    assert(
      fullscreenBypassSample.begin_frame.drm_fullscreen_shell_bypasses >= 1,
      `fullscreen native should bypass shell plane, got ${fullscreenBypassSample.begin_frame.drm_fullscreen_shell_bypasses}`,
    )
    assert(
      fullscreenBypassSample.begin_frame.cef_software_paints === 0,
      `fullscreen native bypass should not trigger CEF software paint, got ${fullscreenBypassSample.begin_frame.cef_software_paints}`,
    )
    await runKeybind(base, 'toggle_fullscreen', red.window.window_id)

    await resetPerfCounters(base)
    const scaleWindows: Awaited<ReturnType<typeof spawnNativeWindow>>[] = []
    for (let index = 0; index < 20; index += 1) {
      const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
        title: `Derp Perf Scale ${stamp}-${index}`,
        token: `perf-scale-${stamp}-${index}`,
        strip: index % 2 === 0 ? 'red' : 'green',
        width: 260,
        height: 180,
      })
      state.spawnedNativeWindowIds.add(spawned.window.window_id)
      await waitForTaskbarEntry(base, spawned.window.window_id)
      scaleWindows.push(spawned)
    }
    const scaleOpenSample = await getPerfCounters(base)
    assert(
      scaleOpenSample.shell_sync.snapshot_dirty_fallbacks === 0,
      `20-window churn dirty snapshots should not fall back to full payloads, got ${scaleOpenSample.shell_sync.snapshot_dirty_fallbacks}`,
    )
    assert(
      scaleOpenSample.shell_sync.full_window_list_replies <= 8,
      `20-window churn should keep full window lists bounded, got ${scaleOpenSample.shell_sync.full_window_list_replies}`,
    )
    assert(
      scaleOpenSample.shell_sync.shared_state_ui_window_writes <= 48,
      `20-window churn should coalesce shell ui writes, got ${scaleOpenSample.shell_sync.shared_state_ui_window_writes}`,
    )
    assert(
      scaleOpenSample.shell_sync.shared_state_exclusion_writes <= 16,
      `20-window churn should keep tray/taskbar exclusion writes bounded, got ${scaleOpenSample.shell_sync.shared_state_exclusion_writes}`,
    )

    let scaleMonitorMoveSample = null
    if (beforeScale.outputs.length >= 2 && scaleWindows.length > 0) {
      const latest = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
      const first = scaleWindows[0]!
      const current = latest.windows.find((window) => window.window_id === first.window.window_id) ?? first.window
      const currentOutput = outputForWindow(latest, current)
      const move = currentOutput ? pickMonitorMove(latest.outputs, currentOutput.name) : null
      if (move) {
        await resetPerfCounters(base)
        await runKeybind(base, move.action, current.window_id)
        await waitFor(
          'wait for scaled window monitor move',
          async () => {
            const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
            const moved = compositor.windows.find((window) => window.window_id === current.window_id)
            return moved?.output_name === move.target.name ? compositor : null
          },
          5000,
          100,
        )
        scaleMonitorMoveSample = await getPerfCounters(base)
        assert(
          scaleMonitorMoveSample.shell_sync.snapshot_dirty_fallbacks === 0,
          `20-window multimonitor move should not fall back to full snapshots, got ${scaleMonitorMoveSample.shell_sync.snapshot_dirty_fallbacks}`,
        )
        assert(
          scaleMonitorMoveSample.shell_sync.full_window_list_replies <= 4,
          `20-window multimonitor move should keep full window lists bounded, got ${scaleMonitorMoveSample.shell_sync.full_window_list_replies}`,
        )
        assert(
          scaleMonitorMoveSample.shell_sync.shared_state_exclusion_writes <= 6,
          `20-window multimonitor move should keep tray/taskbar exclusion writes bounded, got ${scaleMonitorMoveSample.shell_sync.shared_state_exclusion_writes}`,
        )
      }
    }

    const beforeScaleClose = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    const staleProbeWindow =
      beforeScaleClose.windows.find((window) => window.window_id === scaleWindows.at(-1)?.window.window_id) ??
      scaleWindows.at(-1)?.window
    assert(staleProbeWindow, 'missing scaled window before bulk close stale probe')
    const staleProbeRect = {
      x: Math.max(0, staleProbeWindow.x - 4),
      y: Math.max(0, staleProbeWindow.y - 32),
      width: Math.max(1, staleProbeWindow.width + 8),
      height: Math.max(1, staleProbeWindow.height + 40),
    }
    const bulkCloseWindowIds = [
      red.window.window_id,
      green.window.window_id,
      mover.window.window_id,
      ...scaleWindows.map((entry) => entry.window.window_id),
    ]
    for (const windowId of bulkCloseWindowIds) {
      await postJson(base, '/test/window/close', { window_id: windowId })
    }
    await waitFor(
      'wait for perf windows to close',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const closeIds = new Set(bulkCloseWindowIds)
        const compositorHas = compositor.windows.some((window) => closeIds.has(window.window_id))
        const shellHas =
          shell.windows.some((window) => closeIds.has(window.window_id)) ||
          shell.taskbar_windows.some((window) => closeIds.has(window.window_id))
        return compositorHas || shellHas ? null : { compositor, shell }
      },
      5000,
      100,
    )
    const staleProbeScreenshot = await captureScreenshotRect(base, staleProbeRect)
    const staleProbeArtifact = await copyArtifactFile(
      'perf-bulk-unmap-clears-decoration.png',
      staleProbeScreenshot.path,
    )
    await assertScreenshotRectMostlyFlat(staleProbeArtifact, 'bulk unmap stale decoration probe')

    printNote(
      `perf idle begin=${idleSample.begin_frame.cef_send_external_begin_frame} mapped=${openDelta.shell_updates.window_mapped_messages} dirty_reads=${dirtySample.shell_sync.snapshot_dirty_reads} dirty_unchanged=${dirtySample.shell_sync.snapshot_dirty_unchanged} dirty_fallbacks=${dirtySample.shell_sync.snapshot_dirty_fallbacks} moved=${moveDelta.shell_updates.window_geometry_messages} long_moved=${longDragSample.shell_updates.window_geometry_messages} stress_moved=${stressDragSample.shell_updates.window_geometry_messages} stress_messages=${stressDragSample.shell_updates.message_count} drag_begin=${moveDelta.begin_frame.cef_send_external_begin_frame} drag_drm=${moveDelta.begin_frame.drm_render_ticks} latency_samples=${moveDelta.latency.samples} latency_schedule_to_render_us=${moveDelta.latency.schedule_to_render_us} latency_max_us=${moveDelta.latency.schedule_to_render_max_us} dirty_avg=${moveDelta.dirty_rects.samples > 0 ? Math.round(moveDelta.dirty_rects.coverage_per_mille / moveDelta.dirty_rects.samples) : 0} dirty_max=${moveDelta.dirty_rects.max_coverage_per_mille} late_timers=${moveDelta.begin_frame.drm_render_late_timers} fullscreen_bypass=${fullscreenBypassSample.begin_frame.drm_fullscreen_shell_bypasses} cef_sw=${moveDelta.begin_frame.cef_software_paints} full_lists=${moveDelta.shell_sync.full_window_list_replies} snapshot_notifies=${moveDelta.shell_sync.snapshot_notifies} long_snapshot_notifies=${longDragSample.shell_sync.snapshot_notifies} stress_exclusion_writes=${stressDragSample.shell_sync.shared_state_exclusion_writes} menu_forced=${menuChurnSample.begin_frame.compositor_schedules_forced} menu_exclusion_writes=${menuChurnSample.shell_sync.shared_state_exclusion_writes} menu_ui_writes=${menuChurnSample.shell_sync.shared_state_ui_window_writes} scale_full_lists=${scaleOpenSample.shell_sync.full_window_list_replies} scale_ui_writes=${scaleOpenSample.shell_sync.shared_state_ui_window_writes} scale_exclusion_writes=${scaleOpenSample.shell_sync.shared_state_exclusion_writes} scale_monitor_exclusion_writes=${scaleMonitorMoveSample?.shell_sync.shared_state_exclusion_writes ?? 'n/a'} snapshot_reads=${moveDelta.shell_sync.snapshot_reads} ui_writes=${longDragSample.shell_sync.shared_state_ui_window_writes} exclusion_writes=${longDragSample.shell_sync.shared_state_exclusion_writes} long_decode_bytes=${longDragSample.shell_runtime?.snapshot_decode_bytes ?? 'n/a'} stress_decode_bytes=${stressDragSample.shell_runtime?.snapshot_decode_bytes ?? 'n/a'} long_dom_measures=${longDragSample.shell_runtime?.dom_measure_count ?? 'n/a'}`,
    )

    const perfStages = [
      perfStageRow('move', moveDelta),
      perfStageRow('long_move', longDragSample),
      perfStageRow('stress_move', stressDragSample),
      perfStageRow('programs_menu_churn', menuChurnSample),
      perfStageRow('scale_open', scaleOpenSample),
      ...(scaleMonitorMoveSample ? [perfStageRow('scale_monitor_move', scaleMonitorMoveSample)] : []),
    ]
    const perfRank = perfRankRows(perfStages)

    await writeJsonArtifact('perf-smoke-counters.json', {
      idle: idleSample,
      after_open: openedSample,
      after_move: movedSample,
      deltas: {
        open: openDelta,
        dirty: dirtySample,
        move: moveDelta,
        long_move: longDragSample,
        stress_move: stressDragSample,
        fullscreen_bypass: fullscreenBypassSample,
        programs_menu_churn: menuChurnSample,
        scale_open: scaleOpenSample,
        scale_monitor_move: scaleMonitorMoveSample,
      },
      rank: perfRank,
      stages: perfStages,
      windows: {
        red: red.window,
        green: green.window,
        mover: mover.window,
        scale: scaleWindows.map((entry) => entry.window),
      },
    })
  })
})
