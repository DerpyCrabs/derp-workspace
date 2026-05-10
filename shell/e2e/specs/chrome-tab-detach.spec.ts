import {
  BTN_LEFT,
  SkipError,
  assert,
  cleanupNativeWindows,
  cleanupShellWindows,
  defineGroup,
  ensureDesktopApps,
  getJson,
  getSnapshots,
  movePoint,
  pointerButton,
  shellQuote,
  waitFor,
  waitForSessionRestoreIdle,
  waitForWindowGone,
  writeJsonArtifact,
  type CompositorSnapshot,
  type DesktopAppEntry,
} from '../lib/runtime.ts'
import { runKeybind, spawnCommand } from '../lib/setup.ts'

function chromeDesktopApp(apps: DesktopAppEntry[]): DesktopAppEntry | null {
  return apps.find((app) =>
    [app.name, app.exec, app.executable, app.generic_name, app.full_name, desktopAppString(app, 'desktop_id')]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .some((value) => /google[- ]chrome|chromium/i.test(value)),
  ) ?? null
}

function desktopAppString(app: DesktopAppEntry, key: string): string {
  const value = app[key]
  return typeof value === 'string' ? value.trim() : ''
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('real chrome tab drag detaches into a native window', async ({ base: initialBase, state }) => {
    let base = state.base || initialBase
    await waitForSessionRestoreIdle(base)
    const bootstrap = await getSnapshots(base)
    await cleanupShellWindows(
      base,
      bootstrap.shell.windows.filter((window) => window.shell_hosted).map((window) => window.window_id),
    )
    await cleanupNativeWindows(
      base,
      new Set(bootstrap.compositor.windows.filter((window) => !window.shell_hosted).map((window) => window.window_id)),
    )
    state.spawnedNativeWindowIds.clear()
    state.nativeLaunchByWindowId.clear()

    const chromeApp = chromeDesktopApp(await ensureDesktopApps(base, state))
    if (!chromeApp) throw new SkipError('requires google chrome or chromium desktop application')
    const chromeExecutable = chromeApp.executable?.trim() || desktopAppString(chromeApp, 'executable') || ''
    if (!chromeExecutable) throw new SkipError('requires chrome desktop application executable')

    const stamp = Date.now()
    const profileDir = `/tmp/derp-e2e-chrome-tab-detach-${stamp}`
    const firstUrl = `data:text/html,<title>Derp Chrome Detach A ${stamp}</title><body>A</body>`
    const secondUrl = `data:text/html,<title>Derp Chrome Detach B ${stamp}</title><body>B</body>`
    state.afterSuiteCleanup.push(async (activeBase) => {
      await spawnCommand(activeBase, `pkill -f ${shellQuote(profileDir)} || true`)
      await spawnCommand(activeBase, `rm -rf ${shellQuote(profileDir)}`)
    })

    const beforeSpawn = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    const knownWindowIds = new Set(beforeSpawn.windows.map((window) => window.window_id))
    await spawnCommand(
      base,
      `${shellQuote(chromeExecutable)} --user-data-dir=${shellQuote(profileDir)} --no-first-run --disable-first-run-ui --ozone-platform=wayland --new-window ${shellQuote(firstUrl)} ${shellQuote(secondUrl)}`,
    )
    const chrome = await waitFor(
      'wait for real chrome tab detach source window',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositor.windows.find(
          (entry) =>
            !entry.shell_hosted &&
            !knownWindowIds.has(entry.window_id) &&
            /chrome|chromium/i.test(`${entry.app_id} ${entry.title}`),
        )
        return window && window.width > 400 && window.height > 250 ? window : null
      },
      12000,
      100,
    )
    state.spawnedNativeWindowIds.add(chrome.window_id)

    const start = {
      x: chrome.x + Math.min(180, Math.max(90, Math.floor(chrome.width * 0.24))),
      y: chrome.y + 18,
    }
    const end = {
      x: Math.min(chrome.x + chrome.width - 80, start.x + 220),
      y: chrome.y + Math.min(260, Math.max(160, Math.floor(chrome.height * 0.45))),
    }
    await movePoint(base, start.x, start.y)
    await pointerButton(base, BTN_LEFT, 'press')
    for (let step = 1; step <= 24; step += 1) {
      const t = step / 24
      await movePoint(base, start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t)
    }
    const duringDrag = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    await pointerButton(base, BTN_LEFT, 'release')

    const detached = await waitFor(
      'wait for detached real chrome native window',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const windows = compositor.windows.filter(
          (entry) =>
            !entry.shell_hosted &&
            /chrome|chromium/i.test(`${entry.app_id} ${entry.title}`) &&
            !knownWindowIds.has(entry.window_id),
        )
        return windows.length >= 2 ? { compositor, windows } : null
      },
      8000,
      100,
    )
    for (const window of detached.windows) state.spawnedNativeWindowIds.add(window.window_id)
    await writeJsonArtifact('real-chrome-tab-detach.json', {
      chrome,
      start,
      end,
      duringDrag,
      detached: detached.windows,
    })

    assert(detached.windows.some((window) => window.window_id !== chrome.window_id), 'real chrome did not create a detached native window')

    for (const window of detached.windows) {
      await runKeybind(base, 'close_focused', window.window_id)
      await waitForWindowGone(base, window.window_id, 5000).catch(() => undefined)
      state.spawnedNativeWindowIds.delete(window.window_id)
    }
  })
})
