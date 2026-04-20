import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'

import {
  CRASH_NATIVE_TITLE,
  assert,
  crashWindow,
  defineGroup,
  ensureNativeWindow,
  getJson,
  postJson,
  taskbarEntry,
  waitFor,
  waitForWindowGone,
  writeJsonArtifact,
  type ShellSnapshot,
} from '../lib/runtime.ts'

const execFileAsync = promisify(execFile)

export default defineGroup(import.meta.url, ({ test }) => {
  test('capture workspace screenshot', async ({ base, state }) => {
    state.screenshot = await postJson<{ path?: string }>(base, '/test/screenshot', {})
    assert(state.screenshot?.path, 'screenshot response missing path')
    await access(state.screenshot.path)
    await writeJsonArtifact('workspace-screenshot-result.json', state.screenshot)
  })

  test('debug harness captures snapshots and screenshot artifacts', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      'shell/e2e/harness.mjs',
      'snapshot',
      'e2e-harness-smoke',
      '--html',
      '--screenshot',
    ])
    const result = JSON.parse(stdout) as {
      ok?: boolean
      results?: Array<{
        compositor?: string
        shell?: string
        html?: string
        screenshot?: { path?: string; manifest?: string }
      }>
    }
    assert(result.ok, 'harness smoke should return ok')
    const capture = result.results?.[0]
    assert(capture?.compositor, 'harness smoke missing compositor artifact')
    assert(capture.shell, 'harness smoke missing shell artifact')
    assert(capture.html, 'harness smoke missing html artifact')
    assert(capture.screenshot?.path, 'harness smoke missing screenshot path')
    assert(capture.screenshot.manifest, 'harness smoke missing screenshot manifest')
    await access(capture.compositor)
    await access(capture.shell)
    await access(capture.html)
    await access(capture.screenshot.path)
    await access(capture.screenshot.manifest)
    await writeJsonArtifact('harness-smoke-result.json', result)
  })

  test('debug harness reproduces native maximize over shell file browser', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      'shell/e2e/harness.mjs',
      'scenario',
      'maximize-file-browser-then-foot',
    ])
    const result = JSON.parse(stdout) as {
      ok?: boolean
      results?: Array<{
        ok?: boolean
        footTop?: boolean
        focusOk?: boolean
        summary?: string
        after?: {
          compositor?: string
          shell?: string
          html?: string
          screenshot?: { path?: string; manifest?: string }
        }
      }>
    }
    assert(result.ok, 'harness scenario should return ok')
    const scenario = result.results?.[0]
    assert(scenario?.ok, 'foot should be topmost and focused after maximize')
    assert(scenario.footTop, 'harness scenario should report foot topmost')
    assert(scenario.focusOk, 'harness scenario should report foot focused')
    assert(scenario.summary, 'harness scenario missing summary artifact')
    assert(scenario.after?.compositor, 'harness scenario missing after compositor artifact')
    assert(scenario.after.shell, 'harness scenario missing after shell artifact')
    assert(scenario.after.html, 'harness scenario missing after html artifact')
    assert(scenario.after.screenshot?.path, 'harness scenario missing after screenshot')
    await access(scenario.summary)
    await access(scenario.after.compositor)
    await access(scenario.after.shell)
    await access(scenario.after.html)
    await access(scenario.after.screenshot.path)
    await writeJsonArtifact('harness-maximize-file-browser-then-foot-result.json', result)
  })

  test('debug harness verifies native close clears decoration', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      'shell/e2e/harness.mjs',
      'scenario',
      'native-close-decoration-clears',
    ])
    const result = JSON.parse(stdout) as {
      ok?: boolean
      results?: Array<{
        ok?: boolean
        compositorHasDecor?: boolean
        shellFocusedClosedWindow?: boolean
        summary?: string
        immediateScreenshot?: { path?: string; manifest?: string }
        after?: {
          compositor?: string
          shell?: string
          html?: string
          screenshot?: { path?: string; manifest?: string }
        }
      }>
    }
    assert(result.ok, 'native close harness should return ok')
    const scenario = result.results?.[0]
    assert(scenario?.ok, 'native close should remove compositor window and shell decoration')
    assert(!scenario.compositorHasDecor, 'closed native window decoration should not remain registered')
    assert(!scenario.shellFocusedClosedWindow, 'closed native window should not remain shell-focused')
    assert(scenario.summary, 'native close harness missing summary artifact')
    assert(scenario.immediateScreenshot?.path, 'native close harness missing immediate screenshot')
    assert(scenario.after?.compositor, 'native close harness missing after compositor artifact')
    assert(scenario.after.shell, 'native close harness missing after shell artifact')
    assert(scenario.after.html, 'native close harness missing after html artifact')
    assert(scenario.after.screenshot?.path, 'native close harness missing after screenshot')
    await access(scenario.summary)
    await access(scenario.immediateScreenshot.path)
    await access(scenario.after.compositor)
    await access(scenario.after.shell)
    await access(scenario.after.html)
    await access(scenario.after.screenshot.path)
    await writeJsonArtifact('harness-native-close-decoration-clears-result.json', result)
  })

  test('crash probe window disappears from compositor and shell', async ({ base, state }) => {
    state.crashProbe = await ensureNativeWindow(base, state, 'crashProbe', {
      title: CRASH_NATIVE_TITLE,
      token: 'native-crash-probe',
      strip: 'orange',
    })
    await waitFor(
      'wait for crash probe taskbar row',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return taskbarEntry(shell, state.crashProbe!.window.window_id) ? shell : null
      },
      2000,
      125,
    )
    await crashWindow(base, state.crashProbe.window.window_id)
    const crashGone = await waitForWindowGone(base, state.crashProbe.window.window_id)
    assert(
      ((crashGone.compositor.orphaned_wayland_surface_protocol_ids as number[] | undefined) ?? []).length === 0,
      `orphaned mapped wayland surfaces remained after crash cleanup: ${JSON.stringify(
        crashGone.compositor.orphaned_wayland_surface_protocol_ids ?? [],
      )}`,
    )
    state.spawnedNativeWindowIds.delete(state.crashProbe.window.window_id)
    await writeJsonArtifact('native-crash-cleanup-compositor.json', crashGone.compositor)
    await writeJsonArtifact('native-crash-cleanup-shell.json', crashGone.shell)
  })
})
