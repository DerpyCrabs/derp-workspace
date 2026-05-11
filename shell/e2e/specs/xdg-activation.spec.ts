import {
  assert,
  waitForSpawnedWindow,
  waitForNativeFocus,
  waitForWindowMinimized,
  waitForWindowRaised,
  writeJsonArtifact,
} from '../lib/oracle.ts'
import {
  buildNativeSpawnCommand,
  cleanupNativeWindows,
  clickPoint,
  compositorWindowById,
  defineGroup,
  getSnapshots,
  KEY,
  minimizeWindow,
  rectCenter,
  shellWindowById,
  tapKey,
  taskbarEntry,
  waitFor,
  waitForTaskbarEntry,
} from '../lib/runtime.ts'
import { postJson, spawnNativeWindow } from '../lib/setup.ts'

const LAUNCHER_APP_ID = 'derp.e2e.activation.launcher'
const TARGET_APP_ID = 'derp.e2e.activation.target'
const LAUNCHER_TITLE = 'Derp Activation Launcher'
const TARGET_TITLE = 'Derp Activation Target'

export default defineGroup(import.meta.url, ({ test }) => {
  for (const activationOmitSurface of [false, true]) {
    test(
      `launcher keypress requests xdg activation token and focused child consumes it ${
        activationOmitSurface ? 'without' : 'with'
      } requesting surface`,
      async ({ base, state }) => {
        const suffix = activationOmitSurface ? 'No Surface' : 'Surface'
        const targetCommand = buildNativeSpawnCommand({
          title: `${TARGET_TITLE} ${suffix}`,
          appId: TARGET_APP_ID,
          token: `xdg-activation-target-${activationOmitSurface ? 'no-surface' : 'surface'}`,
          strip: 'orange',
        })
        const launcher = await spawnNativeWindow(base, state.knownWindowIds, {
          title: `${LAUNCHER_TITLE} ${suffix}`,
          appId: LAUNCHER_APP_ID,
          token: `xdg-activation-launcher-${activationOmitSurface ? 'no-surface' : 'surface'}`,
          strip: 'cyan',
          spawnOnPressCommand: targetCommand,
          activationAppId: TARGET_APP_ID,
          activationOmitSurface,
        })
        const launcherId = launcher.window.window_id
        await waitForNativeFocus(base, launcherId)
        await tapKey(base, KEY.enter)

        const target = await waitForSpawnedWindow(base, state.knownWindowIds, {
          title: `${TARGET_TITLE} ${suffix}`,
          appId: TARGET_APP_ID,
          command: targetCommand,
        })
        const focused = await waitForNativeFocus(base, target.window.window_id)

        assert(
          focused.compositor.focused_window_id === target.window.window_id,
          `expected target focus ${target.window.window_id}, got ${focused.compositor.focused_window_id}`,
        )
        assert(
          focused.compositor.focused_window_id !== launcherId,
          'launcher should lose focus after target consumes activation token',
        )

        await writeJsonArtifact(
          `xdg-activation-launcher-${activationOmitSurface ? 'no-surface' : 'surface'}.json`,
          launcher.snapshot,
        )
        await writeJsonArtifact(
          `xdg-activation-target-${activationOmitSurface ? 'no-surface' : 'surface'}.json`,
          target.snapshot,
        )
        await writeJsonArtifact(
          `xdg-activation-focused-${activationOmitSurface ? 'no-surface' : 'surface'}.json`,
          focused,
        )
        await cleanupNativeWindows(base, new Set([launcherId, target.window.window_id]))
      },
    )
  }

  test('stale xdg activation token is rejected', async ({ base, state }) => {
    const targetCommand = buildNativeSpawnCommand({
      title: `${TARGET_TITLE} Stale`,
      appId: TARGET_APP_ID,
      token: 'xdg-activation-stale-target',
      strip: 'orange',
    })
    const launcher = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `${LAUNCHER_TITLE} Stale`,
      appId: LAUNCHER_APP_ID,
      token: 'xdg-activation-stale-launcher',
      strip: 'cyan',
      spawnOnPressCommand: targetCommand,
      activationAppId: TARGET_APP_ID,
    })
    const launcherId = launcher.window.window_id
    try {
      await waitForNativeFocus(base, launcherId)
      await postJson(base, '/test/xdg_activation/max_age', { milliseconds: 0 })
      await tapKey(base, KEY.enter)
      const target = await waitForSpawnedWindow(base, state.knownWindowIds, {
        title: `${TARGET_TITLE} Stale`,
        appId: TARGET_APP_ID,
        command: targetCommand,
      })
      state.spawnedNativeWindowIds.add(target.window.window_id)
      const settled = await waitFor(
        'wait for stale activation rejection',
        async () => {
          const snapshots = await getSnapshots(base)
          return snapshots.compositor.focused_window_id === target.window.window_id ? null : snapshots
        },
        2000,
        50,
      )
      await writeJsonArtifact('xdg-activation-stale-rejected.json', settled)
      await cleanupNativeWindows(base, new Set([launcherId, target.window.window_id]))
    } finally {
      await postJson(base, '/test/xdg_activation/max_age', { reset: true })
    }
  })

  test('unrelated or unfocused origin token cannot focus another window', async ({ base, state }) => {
    const targetCommand = buildNativeSpawnCommand({
      title: `${TARGET_TITLE} Foreign`,
      appId: TARGET_APP_ID,
      token: 'xdg-activation-foreign-target',
      strip: 'orange',
    })
    const launcher = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `${LAUNCHER_TITLE} Foreign`,
      appId: LAUNCHER_APP_ID,
      token: 'xdg-activation-foreign-launcher',
      strip: 'cyan',
      spawnOnPressCommand: targetCommand,
      activationAppId: LAUNCHER_APP_ID,
    })
    const decoy = await spawnNativeWindow(base, state.knownWindowIds, {
      title: 'Derp Activation Decoy',
      appId: 'derp.e2e.activation.decoy',
      token: 'xdg-activation-decoy',
      strip: 'green',
    })
    const launcherId = launcher.window.window_id
    const decoyId = decoy.window.window_id
    await waitForNativeFocus(base, decoyId)
    const snapshots = await getSnapshots(base)
    const launcherWindow = compositorWindowById(snapshots.compositor, launcherId)
    assert(launcherWindow, 'missing launcher window for unrelated activation')
    await clickPoint(
      base,
      launcherWindow.x + Math.min(16, launcherWindow.width - 1),
      launcherWindow.y + Math.min(16, launcherWindow.height - 1),
    )
    await waitForNativeFocus(base, launcherId)
    await tapKey(base, KEY.enter)
    const target = await waitForSpawnedWindow(base, state.knownWindowIds, {
      title: `${TARGET_TITLE} Foreign`,
      appId: TARGET_APP_ID,
      command: targetCommand,
    })
    state.spawnedNativeWindowIds.add(target.window.window_id)
    const settled = await waitFor(
      'wait for unrelated activation rejection',
      async () => {
        const next = await getSnapshots(base)
        return next.compositor.focused_window_id === target.window.window_id ? null : next
      },
      2000,
      50,
    )
    await writeJsonArtifact('xdg-activation-unrelated-rejected.json', settled)
    await cleanupNativeWindows(base, new Set([launcherId, decoyId, target.window.window_id]))
  })

  test('minimized non-scratchpad taskbar restore still works', async ({ base, state }) => {
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: 'Derp Activation Minimized Restore',
      appId: 'derp.e2e.activation.minimized',
      token: 'xdg-activation-minimized',
      strip: 'purple',
    })
    const windowId = spawned.window.window_id
    state.spawnedNativeWindowIds.add(windowId)
    await waitForTaskbarEntry(base, windowId)
    await minimizeWindow(base, windowId)
    await waitForWindowMinimized(base, windowId)
    const shell = (await getSnapshots(base)).shell
    const row = taskbarEntry(shell, windowId)
    assert(row?.activate, 'minimized non-scratchpad should keep a taskbar activation target')
    await clickPoint(base, rectCenter(row.activate).x, rectCenter(row.activate).y)
    const restored = await waitForWindowRaised(base, windowId)
    await writeJsonArtifact('xdg-activation-minimized-restored.json', restored)
    await cleanupNativeWindows(base, new Set([windowId]))
  })

  test('scratchpad minimized taskbar policy remains unchanged', async ({ base, state }) => {
    const title = `Derp Activation Scratchpad ${Date.now()}`
    let windowId: number | null = null
    try {
      await postJson(base, '/settings_scratchpads', {
        items: [
          {
            id: 'activation-pad',
            name: 'Activation pad',
            hotkey: 'Super+shift+grave',
            default_visible: false,
            placement: { monitor: 'focused', width_percent: 60, height_percent: 50 },
            rules: [{ field: 'title', op: 'equals', value: title }],
          },
        ],
      })
      const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
        title,
        appId: 'derp.e2e.activation.scratchpad',
        token: 'xdg-activation-scratchpad',
        strip: 'pink',
      })
      windowId = spawned.window.window_id
      state.spawnedNativeWindowIds.add(windowId)
      const hidden = await waitFor(
        'wait for activation scratchpad minimized',
        async () => {
          const snapshots = await getSnapshots(base)
          const shellWindow = shellWindowById(snapshots.shell, windowId!)
          const compositorWindow = compositorWindowById(snapshots.compositor, windowId!)
          if (!shellWindow?.scratchpad || !shellWindow.minimized || !compositorWindow?.minimized) return null
          if (taskbarEntry(snapshots.shell, windowId!)) return null
          return snapshots
        },
        5000,
        50,
      )
      await writeJsonArtifact('xdg-activation-scratchpad-minimized-policy.json', hidden)
    } finally {
      if (windowId !== null) await cleanupNativeWindows(base, new Set([windowId]))
      await postJson(base, '/settings_scratchpads', { items: [] })
    }
  })
})
