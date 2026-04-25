import {
  assert,
  waitForSpawnedWindow,
  waitForNativeFocus,
  writeJsonArtifact,
} from '../lib/oracle.ts'
import { buildNativeSpawnCommand, cleanupNativeWindows, defineGroup, KEY, tapKey } from '../lib/runtime.ts'
import { spawnNativeWindow } from '../lib/setup.ts'

const LAUNCHER_APP_ID = 'derp.e2e.activation.launcher'
const TARGET_APP_ID = 'derp.e2e.activation.target'
const LAUNCHER_TITLE = 'Derp Activation Launcher'
const TARGET_TITLE = 'Derp Activation Target'

export default defineGroup(import.meta.url, ({ test }) => {
  test('launcher keypress requests xdg activation token and focused target consumes it', async ({ base, state }) => {
    const targetCommand = buildNativeSpawnCommand({
      title: TARGET_TITLE,
      appId: TARGET_APP_ID,
      token: 'xdg-activation-target',
      strip: 'orange',
    })
    const launcher = await spawnNativeWindow(base, state.knownWindowIds, {
      title: LAUNCHER_TITLE,
      appId: LAUNCHER_APP_ID,
      token: 'xdg-activation-launcher',
      strip: 'cyan',
      spawnOnPressCommand: targetCommand,
    })
    const launcherId = launcher.window.window_id
    await waitForNativeFocus(base, launcherId)
    await tapKey(base, KEY.enter)

    const target = await waitForSpawnedWindow(base, state.knownWindowIds, {
      title: TARGET_TITLE,
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

    await writeJsonArtifact('xdg-activation-launcher.json', launcher.snapshot)
    await writeJsonArtifact('xdg-activation-target.json', target.snapshot)
    await writeJsonArtifact('xdg-activation-focused.json', focused)
    await cleanupNativeWindows(base, new Set([launcherId, target.window.window_id]))
  })
})
