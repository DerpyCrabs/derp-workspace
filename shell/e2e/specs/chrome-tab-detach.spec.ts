import {
  BTN_LEFT,
  SkipError,
  cleanupNativeWindows,
  cleanupShellWindows,
  clickPoint,
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

async function dragPointer(base: string, start: { x: number; y: number }, end: { x: number; y: number }, steps = 24): Promise<void> {
  await movePoint(base, start.x, start.y)
  await pointerButton(base, BTN_LEFT, 'press')
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps
    await movePoint(base, start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t)
  }
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('real chrome tab drag detaches then merges back into existing chrome window', async ({ base: initialBase, state }) => {
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
    try {
      await spawnCommand(
        base,
        `${shellQuote(chromeExecutable)} --user-data-dir=${shellQuote(profileDir)} --no-first-run --disable-first-run-ui --disable-component-update --simulate-outdated-no-au='Tue, 31 Dec 2099 23:59:59 GMT' --ozone-platform=wayland --new-window ${shellQuote(firstUrl)} ${shellQuote(secondUrl)}`,
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
        x: Math.max(320, chrome.x - 720),
        y: chrome.y + 180,
      }
      await dragPointer(base, start, end)
      const detached = await waitFor(
        'wait for detached real chrome native window during drag',
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
      const original = detached.windows.find((window) => window.window_id === chrome.window_id) ?? detached.windows[0]
      const detachedWindow = detached.windows.find((window) => window.window_id !== original.window_id)
      if (!detachedWindow) throw new Error(`detached chrome window missing: ${JSON.stringify(detached.windows)}`)
      state.spawnedNativeWindowIds.add(detachedWindow.window_id)
      const reattachEnd = {
        x: original.x + Math.min(180, Math.max(130, Math.floor(original.width * 0.16))),
        y: original.y + 18,
      }
      const returnStart = {
        x: end.x,
        y: end.y,
      }
      for (let step = 1; step <= 36; step += 1) {
        const t = step / 36
        await movePoint(base, returnStart.x + (reattachEnd.x - returnStart.x) * t, returnStart.y + (reattachEnd.y - returnStart.y) * t)
      }
      for (let step = 0; step < 10; step += 1) {
        await movePoint(base, reattachEnd.x + (step % 2 === 0 ? 16 : -16), reattachEnd.y)
      }
      const duringReattachDrag = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
      await writeJsonArtifact('real-chrome-tab-reattach-during-drag.json', {
        start,
        end,
        reattachEnd,
        detached: detached.windows,
        duringReattachDrag,
      })

      const reattached = await waitFor(
        'wait for real chrome detached tab to reattach during drag',
        async () => {
          const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          const windows = compositor.windows.filter(
            (entry) =>
              !entry.shell_hosted &&
              /chrome|chromium/i.test(`${entry.app_id} ${entry.title}`) &&
              !knownWindowIds.has(entry.window_id),
          )
          return windows.length === 1 ? { compositor, windows } : null
        },
        8000,
        100,
      )
      await pointerButton(base, BTN_LEFT, 'release')
      await writeJsonArtifact('real-chrome-tab-reattach.json', {
        start,
        end,
        reattachEnd,
        detached: detached.windows,
        reattached: reattached.windows,
      })

      for (const window of reattached.windows) {
        await runKeybind(base, 'close_focused', window.window_id)
        await waitForWindowGone(base, window.window_id, 5000).catch(() => undefined)
        state.spawnedNativeWindowIds.delete(window.window_id)
      }
    } catch (error) {
      await pointerButton(base, BTN_LEFT, 'release').catch(() => undefined)
      throw error
    }
  })

  test('real chrome CSD close button closes the native window', async ({ base: initialBase, state }) => {
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
    const profileDir = `/tmp/derp-e2e-chrome-csd-close-${stamp}`
    const url = `data:text/html,<title>Derp Chrome CSD Close ${stamp}</title><body>close</body>`
    state.afterSuiteCleanup.push(async (activeBase) => {
      await spawnCommand(activeBase, `pkill -f ${shellQuote(profileDir)} || true`)
      await spawnCommand(activeBase, `rm -rf ${shellQuote(profileDir)}`)
    })

    const beforeSpawn = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    const knownWindowIds = new Set(beforeSpawn.windows.map((window) => window.window_id))
    await spawnCommand(
      base,
      `${shellQuote(chromeExecutable)} --user-data-dir=${shellQuote(profileDir)} --no-first-run --disable-first-run-ui --ozone-platform=wayland --new-window ${shellQuote(url)}`,
    )
    const chrome = await waitFor(
      'wait for real chrome CSD close source window',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositor.windows.find(
          (entry) =>
            !entry.shell_hosted &&
            !knownWindowIds.has(entry.window_id) &&
            /chrome|chromium/i.test(`${entry.app_id} ${entry.title}`),
        )
        return window && window.width > 400 && window.height > 250 && window.client_side_decoration ? window : null
      },
      12000,
      100,
    )
    state.spawnedNativeWindowIds.add(chrome.window_id)
    const closePoint = {
      x: chrome.x + chrome.width - 18,
      y: chrome.y + 18,
    }
    await clickPoint(base, closePoint.x, closePoint.y)
    await waitForWindowGone(base, chrome.window_id, 8000)
    state.spawnedNativeWindowIds.delete(chrome.window_id)
    await writeJsonArtifact('real-chrome-csd-close.json', {
      window: chrome,
      closePoint,
    })
  })
})
