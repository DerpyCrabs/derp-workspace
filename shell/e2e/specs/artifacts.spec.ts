import { access } from 'node:fs/promises'

import {
  CRASH_NATIVE_TITLE,
  assert,
  crashWindow,
  defineGroup,
  getJson,
  postJson,
  spawnNativeWindow,
  taskbarEntry,
  waitFor,
  waitForWindowGone,
  writeJsonArtifact,
  type ShellSnapshot,
} from '../lib/runtime.ts'

export default defineGroup(import.meta.url, ({ test }) => {
  test('capture workspace screenshot', async ({ base, state }) => {
    state.screenshot = await postJson<{ path?: string }>(base, '/test/screenshot', {})
    assert(state.screenshot?.path, 'screenshot response missing path')
    await access(state.screenshot.path)
    await writeJsonArtifact('workspace-screenshot-result.json', state.screenshot)
  })

  test('crash probe window disappears from compositor and shell', async ({ base, state }) => {
    state.crashProbe = await spawnNativeWindow(base, state.knownWindowIds, {
      title: CRASH_NATIVE_TITLE,
      token: 'native-crash-probe',
      strip: 'orange',
    })
    state.spawnedNativeWindowIds.add(state.crashProbe.window.window_id)
    await waitFor(
      'wait for crash probe taskbar row',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return taskbarEntry(shell, state.crashProbe!.window.window_id) ? shell : null
      },
      8000,
      125,
    )
    await crashWindow(base, state.crashProbe.window.window_id)
    const crashGone = await waitForWindowGone(base, state.crashProbe.window.window_id)
    state.spawnedNativeWindowIds.delete(state.crashProbe.window.window_id)
    await writeJsonArtifact('native-crash-cleanup-compositor.json', crashGone.compositor)
    await writeJsonArtifact('native-crash-cleanup-shell.json', crashGone.shell)
  })
})
