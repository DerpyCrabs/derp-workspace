import {
  assert,
  assertRectMinSize,
  defineGroup,
  getJson,
  waitFor,
  writeJsonArtifact,
  type ShellSnapshot,
} from '../lib/runtime.ts'
import { ensureNativeWindow, openShellTestWindow, postJson } from '../lib/setup.ts'
import { clickRect } from '../lib/user.ts'

async function waitForPortalPickerVisible(base: string, timeoutMs = 5000): Promise<ShellSnapshot> {
  return waitFor(
    'wait for portal picker visible',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return shell.portal_picker_visible === true && shell.portal_picker_panel ? shell : null
    },
    timeoutMs,
    50,
  )
}

async function waitForPortalPickerClosed(base: string, timeoutMs = 5000): Promise<ShellSnapshot> {
  return waitFor(
    'wait for portal picker closed',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return shell.portal_picker_visible ? null : shell
    },
    timeoutMs,
    50,
  )
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('portal display capture picks monitor from shell layout', async ({ base }) => {
    const pickPromise = postJson<string>(base, '/portal_screencast_pick', { types: 1 })
    const shell = await waitForPortalPickerVisible(base)

    assert((shell.portal_picker_windows?.length ?? 0) === 0, 'display-only picker should not show window options')
    assert((shell.portal_picker_monitors?.length ?? 0) > 0, 'display-only picker should show monitor options')

    const option = shell.portal_picker_monitors?.[0] ?? null
    assert(option?.rect, 'display-only picker missing first monitor rect')

    await writeJsonArtifact('portal-display-capture-picker.json', {
      panel: shell.portal_picker_panel,
      monitors: shell.portal_picker_monitors,
      windows: shell.portal_picker_windows,
    })

    await clickRect(base, assertRectMinSize('portal display capture monitor option', option.rect, 24, 24))

    const selection = await pickPromise
    assert(selection === `Monitor: ${option.name}`, `expected monitor selection ${option.name}, got ${selection}`)

    await waitForPortalPickerClosed(base)
    await writeJsonArtifact('portal-display-capture-selection.json', { selection, monitor: option.name })
  })

  test('portal window capture lists native windows and returns capture identifier', async ({ base, state }) => {
    const nativeSpawn = await ensureNativeWindow(base, state, 'redSpawn', {
      title: 'Derp Native Red',
      token: 'native-red',
      strip: 'red',
    })
    const shellWindow = await openShellTestWindow(base, state)

    const pickPromise = postJson<string>(base, '/portal_screencast_pick', { types: 2 })
    const shell = await waitForPortalPickerVisible(base)

    assert((shell.portal_picker_monitors?.length ?? 0) === 0, 'window-only picker should not show monitor options')
    assert((shell.portal_picker_windows?.length ?? 0) > 0, 'window-only picker should show native window options')

    const nativeOption =
      shell.portal_picker_windows?.find((entry) => entry.window_id === nativeSpawn.window.window_id) ?? null
    assert(nativeOption, `window-only picker missing native window ${nativeSpawn.window.window_id}`)
    assert(nativeOption.capture_identifier.length > 0, 'window-only picker missing native capture identifier')
    assert(
      !(shell.portal_picker_windows ?? []).some((entry) => entry.window_id === shellWindow.window.window_id),
      'window-only picker should not show shell-hosted windows',
    )

    await writeJsonArtifact('portal-window-capture-picker.json', {
      panel: shell.portal_picker_panel,
      windows: shell.portal_picker_windows,
      monitors: shell.portal_picker_monitors,
      chosen_window_id: nativeSpawn.window.window_id,
      shell_window_id: shellWindow.window.window_id,
    })

    assert(nativeOption.rect, `window-only picker missing rect for native window ${nativeSpawn.window.window_id}`)
    await clickRect(base, assertRectMinSize('portal window capture native option', nativeOption.rect, 24, 24))

    const selection = await pickPromise
    assert(
      selection === `Window: ${nativeOption.capture_identifier}`,
      `expected window selection ${nativeOption.capture_identifier}, got ${selection}`,
    )

    await waitForPortalPickerClosed(base)
    await writeJsonArtifact('portal-window-capture-selection.json', {
      selection,
      capture_identifier: nativeOption.capture_identifier,
      window_id: nativeOption.window_id,
      title: nativeOption.title,
    })
  })
})
