import {
  SHELL_UI_SETTINGS_WINDOW_ID,
  assert,
  assertRectMinSize,
  clickRect,
  cleanupNativeWindows,
  cleanupShellWindows,
  closeTaskbarWindow,
  compositorWindowById,
  defineGroup,
  discoverReadyBase,
  dragBetweenPoints,
  doubleClickRect,
  ensureDesktopApps,
  getJson,
  getShellHtml,
  getSnapshots,
  openPowerMenu,
  openSettings,
  openShellTestWindow,
  postJson,
  rectCenter,
  shellQuote,
  SkipError,
  waitFor,
  waitForSessionRestoreIdle,
  waitForWindowGone,
  windowControls,
  writeJsonArtifact,
  type CompositorSnapshot,
  type DesktopAppEntry,
  type ShellSnapshot,
} from '../lib/runtime.ts'
import { runKeybind, spawnCommand, spawnNativeWindow } from '../lib/setup.ts'

type SessionStateResponse = {
  version: number
  shell: {
    version: number
    nextNativeWindowSeq: number
    workspace: { groups: unknown[]; pinnedWindowRefs: unknown[]; nextGroupSeq: number }
    monitorLayouts: unknown[]
    monitorTiles: unknown[]
    preTileGeometry: unknown[]
    shellWindows: Array<{ windowId: number }>
    nativeWindows: Array<{
      windowRef: string
      title?: string
      appId?: string
      bounds?: { x: number; y: number; width: number; height: number }
      maximized?: false | { outputId?: string; outputName?: string }
      launch?: { command?: string; desktopId?: string | null; appName?: string | null } | null
    }>
  }
}

type SessionMonitorLayout = {
  outputId?: string
  outputName: string
  layout: string
  params?: Record<string, unknown>
  snapLayout?: string
  customLayouts?: unknown[]
}

async function waitForSessionShellWindow(base: string, windowId: number | null, present: boolean, timeoutMs = 5000) {
  return waitFor(
    `wait for session shell window ${windowId ?? 'none'} ${present ? 'present' : 'absent'}`,
    async () => {
      const state = await getJson<SessionStateResponse>(base, '/session_state')
      const hasWindow = state.shell.shellWindows.some((entry) => entry.windowId === windowId)
      return hasWindow === present ? state : null
    },
    timeoutMs,
    100,
  )
}

async function clearSessionState(base: string) {
  await postJson(base, '/session_state', {
    version: 1,
    shell: {
      version: 1,
      nextNativeWindowSeq: 1,
      workspace: { groups: [], pinnedWindowRefs: [], nextGroupSeq: 1 },
      monitorLayouts: [],
      monitorTiles: [],
      preTileGeometry: [],
      shellWindows: [],
      nativeWindows: [],
    },
  })
}

function sessionLayoutFor(state: SessionStateResponse, outputName: string, outputId?: string | null) {
  return state.shell.monitorLayouts.find((layout) => {
    const entry = layout as SessionMonitorLayout
    return outputId ? entry.outputId === outputId : entry.outputName === outputName
  }) as SessionMonitorLayout | undefined
}

function rectAroundPoint(point: { x: number; y: number }, size = 4) {
  const half = size / 2
  return { x: 0, y: 0, global_x: point.x - half, global_y: point.y - half, width: size, height: size }
}

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
  test('session restore reapplies maximized native window bounds before titlebar restore', async ({ base, state }) => {
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
    await clearSessionState(base)

    const title = `Derp Session Maximized Native ${Date.now()}`
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title,
      token: 'session-maximized-native',
      strip: 'blue',
      width: 460,
      height: 280,
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    state.nativeLaunchByWindowId.set(spawned.window.window_id, spawned.command)

    let shell = await waitFor(
      'wait for native session window controls',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return windowControls(next, spawned.window.window_id)?.maximize ? next : null
      },
      5000,
      100,
    )
    const controls = windowControls(shell, spawned.window.window_id)
    assert(controls?.maximize, 'missing maximize control for native session window')
    await clickRect(base, controls.maximize)
    const maximized = await waitFor(
      'wait for saved native window maximized',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, spawned.window.window_id)
        return window?.maximized ? { compositor, window } : null
      },
      5000,
      100,
    )

    const savedSession = {
      version: 1,
      shell: {
        version: 1,
        nextNativeWindowSeq: 2,
        workspace: { groups: [], pinnedWindowRefs: [], nextGroupSeq: 1 },
        monitorLayouts: [],
        monitorTiles: [],
        preTileGeometry: [],
        shellWindows: [],
        nativeWindows: [
          {
            windowRef: 'native:1',
            title,
            appId: maximized.window.app_id,
            outputId: '',
            outputName: maximized.window.output_name,
            bounds: {
              x: maximized.window.x,
              y: maximized.window.y,
              width: maximized.window.width,
              height: maximized.window.height,
            },
            minimized: false,
            maximized: true,
            fullscreen: false,
            launch: { command: spawned.command, desktopId: null, appName: null },
          },
        ],
      },
    }
    await postJson(base, '/session_state', savedSession)

    shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await closeTaskbarWindow(base, shell, spawned.window.window_id)
    await waitForWindowGone(base, spawned.window.window_id)
    state.spawnedNativeWindowIds.delete(spawned.window.window_id)
    await postJson(base, '/session_reload', savedSession)
    await waitFor(
      'wait for shell http restart after maximized native session reload',
      async () => {
        try {
          await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          return null
        } catch {
          return true
        }
      },
      5000,
      100,
    )
    const restoredBase = await discoverReadyBase(45000)
    state.base = restoredBase
    const restored = await waitFor(
      'wait for restored maximized native window bounds',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(restoredBase, '/test/state/compositor')
        const shellSnapshot = await getJson<ShellSnapshot>(restoredBase, '/test/state/shell')
        const window = compositor.windows.find(
          (entry) => !entry.shell_hosted && entry.title === title && entry.app_id === maximized.window.app_id,
        )
        if (!window?.maximized || window.minimized || window.fullscreen || window.lifecycle !== 'mapped') return null
        if ((window.mapped_width ?? 0) <= 100 || (window.mapped_height ?? 0) <= 100) return null
        if (Math.abs(window.x - maximized.window.x) > 8) return null
        if (Math.abs(window.y - maximized.window.y) > 8) return null
        if (Math.abs(window.width - maximized.window.width) > 8) return null
        if (Math.abs(window.height - maximized.window.height) > 8) return null
        const titlebar = windowControls(shellSnapshot, window.window_id)?.titlebar
        if (!titlebar) return null
        return { compositor, shell: shellSnapshot, window, titlebar }
      },
      8000,
      100,
    )
    state.spawnedNativeWindowIds.add(restored.window.window_id)

    const beforeRestore = restored.window
    await doubleClickRect(restoredBase, rectAroundPoint(rectCenter(assertRectMinSize('restored native titlebar', restored.titlebar, 80, 16))))
    const floating = await waitFor(
      'wait for restored native window visible after titlebar double click',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(restoredBase, '/test/state/compositor')
        const window = compositorWindowById(compositor, beforeRestore.window_id)
        if (!window || window.maximized || window.fullscreen || window.minimized) return null
        if (window.width < 80 || window.height < 60) return null
        return window
      },
      5000,
      100,
    )

    await writeJsonArtifact('session-restore-maximized-native-window.json', {
      saved: maximized.window,
      restored: beforeRestore,
      floating,
    })
    shell = await getJson<ShellSnapshot>(restoredBase, '/test/state/shell')
    await closeTaskbarWindow(restoredBase, shell, restored.window.window_id)
    await waitForWindowGone(restoredBase, restored.window.window_id)
    state.spawnedNativeWindowIds.delete(restored.window.window_id)
    await clearSessionState(restoredBase)
  })

  test('power menu save restores a maximized chrome window launched outside shell', async ({ base: initialBase, state }) => {
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
    await clearSessionState(base)

    const chromeApp = chromeDesktopApp(await ensureDesktopApps(base, state))
    if (!chromeApp) throw new SkipError('requires google chrome or chromium desktop application')
    const chromeExecutable = chromeApp.executable?.trim() || desktopAppString(chromeApp, 'executable') || ''
    if (!chromeExecutable) throw new SkipError('requires chrome desktop application executable')

    const profileDir = `/tmp/derp-e2e-chrome-session-${Date.now()}`
    state.afterSuiteCleanup.push(async (activeBase) => {
      await spawnCommand(activeBase, `pkill -f ${shellQuote(profileDir)} || true`)
      await spawnCommand(activeBase, `rm -rf ${shellQuote(profileDir)}`)
    })

    const beforeSpawn = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    const knownWindowIds = new Set(beforeSpawn.windows.map((window) => window.window_id))
    await spawnCommand(
      base,
      `${shellQuote(chromeExecutable)} --user-data-dir=${shellQuote(profileDir)} --no-first-run --disable-first-run-ui --ozone-platform=wayland about:blank`,
    )
    const chrome = await waitFor(
      'wait for harness-launched chrome window',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositor.windows.find(
          (entry) =>
            !entry.shell_hosted &&
            !knownWindowIds.has(entry.window_id) &&
            /chrome|chromium/i.test(`${entry.app_id} ${entry.title}`),
        )
        return window && window.width > 100 && window.height > 100 ? window : null
      },
      10000,
      100,
    )
    state.spawnedNativeWindowIds.add(chrome.window_id)

    await dragBetweenPoints(
      base,
      chrome.x + Math.floor(chrome.width / 2),
      chrome.y + 20,
      chrome.x + Math.floor(chrome.width / 2) + 120,
      chrome.y + 60,
      12,
    )
    const draggedChrome = await waitFor(
      'wait for chrome CSD drag to keep real bounds',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, chrome.window_id)
        return window && !window.minimized && window.width > 100 && window.height > 100 ? window : null
      },
      5000,
      100,
    )

    await runKeybind(base, 'toggle_maximize', chrome.window_id)
    const maximized = await waitFor(
      'wait for chrome maximized before save',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, chrome.window_id)
        return window?.maximized ? window : null
      },
      5000,
      100,
    )

    let powerMenu = await openPowerMenu(base)
    assert(powerMenu.controls?.power_menu_save_session, 'missing save workspace power control')
    await clickRect(base, powerMenu.controls.power_menu_save_session)
    const savedSession = await waitFor(
      'wait for saved chrome session launch metadata',
      async () => {
        const session = await getJson<SessionStateResponse>(base, '/session_state')
        const saved = session.shell.nativeWindows.find((entry) => /chrome|chromium/i.test(`${entry.appId} ${entry.title}`))
        return saved?.maximized && saved.launch?.command ? session : null
      },
      3000,
      100,
    )
    const savedChrome = savedSession.shell.nativeWindows.find((entry) => /chrome|chromium/i.test(`${entry.appId} ${entry.title}`))
    const savedChromeBounds = savedChrome?.bounds
    assert(savedChromeBounds, 'missing saved chrome bounds')
    assert(/chrome|chromium/i.test(savedChrome.launch?.command ?? ''), 'saved chrome launch command should relaunch chrome')
    assert(savedChrome.maximized && typeof savedChrome.maximized === 'object', 'saved maximized chrome should store output identity, not maximized coordinates')
    assert(savedChrome.maximized.outputName === maximized.output_name, 'saved maximized chrome output identity should match live output')
    assert(Math.abs(savedChromeBounds.x - draggedChrome.x) <= 8, `saved maximized chrome restore x ${savedChromeBounds.x} should match floating x ${draggedChrome.x}`)
    assert(Math.abs(savedChromeBounds.y - draggedChrome.y) <= 8, `saved maximized chrome restore y ${savedChromeBounds.y} should match floating y ${draggedChrome.y}`)
    assert(Math.abs(savedChromeBounds.width - draggedChrome.width) <= 8, `saved maximized chrome restore width ${savedChromeBounds.width} should match floating width ${draggedChrome.width}`)
    assert(Math.abs(savedChromeBounds.height - draggedChrome.height) <= 8, `saved maximized chrome restore height ${savedChromeBounds.height} should match floating height ${draggedChrome.height}`)

    await runKeybind(base, 'close_focused', chrome.window_id)
    await waitForWindowGone(base, chrome.window_id)
    state.spawnedNativeWindowIds.delete(chrome.window_id)
    await postJson(base, '/session_state', savedSession)

    powerMenu = await openPowerMenu(base)
    assert(powerMenu.controls?.power_menu_restore_session, 'missing restore workspace power control')
    await clickRect(base, powerMenu.controls.power_menu_restore_session)
    const restored = await waitFor(
      'wait for restored maximized chrome bounds',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositor.windows.find(
          (entry) =>
            !entry.shell_hosted &&
            entry.window_id !== chrome.window_id &&
            /chrome|chromium/i.test(`${entry.app_id} ${entry.title}`),
        )
        if (!window?.maximized || window.minimized || window.fullscreen || window.lifecycle !== 'mapped') return null
        if ((window.mapped_width ?? 0) <= 100 || (window.mapped_height ?? 0) <= 100) return null
        const output = compositor.outputs.find((entry) => entry.name === window.output_name)
        if (!output) return null
        const restoredUsableX = output.usable_x ?? output.x
        const restoredUsableY = output.usable_y ?? output.y
        const restoredUsableWidth = output.usable_width ?? output.width
        const restoredUsableHeight = output.usable_height ?? output.height
        if (Math.abs(window.x - restoredUsableX) > 8) return null
        if (Math.abs(window.y - restoredUsableY) > 8) return null
        if (Math.abs(window.width - restoredUsableWidth) > 8) return null
        if (window.height < restoredUsableHeight - 80) return null
        if (window.width < savedChromeBounds.width - 80) return null
        return { window }
      },
      12000,
      100,
    )
    state.spawnedNativeWindowIds.add(restored.window.window_id)

    await writeJsonArtifact('session-restore-maximized-real-chrome.json', {
      saved: savedSession.shell.nativeWindows.find((entry) => /chrome|chromium/i.test(`${entry.appId} ${entry.title}`)),
      draggedChrome,
      maximized,
      restored: restored.window,
    })
    await runKeybind(base, 'close_focused', restored.window.window_id)
    await waitForWindowGone(base, restored.window.window_id)
    state.spawnedNativeWindowIds.delete(restored.window.window_id)
    await clearSessionState(base)
  })

  test('remembered maximized chrome launch is anchored to its output work area', async ({ base: initialBase, state }) => {
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
    await clearSessionState(base)

    const chromeApp = chromeDesktopApp(await ensureDesktopApps(base, state))
    if (!chromeApp) throw new SkipError('requires google chrome or chromium desktop application')
    const chromeExecutable = chromeApp.executable?.trim() || desktopAppString(chromeApp, 'executable') || ''
    if (!chromeExecutable) throw new SkipError('requires chrome desktop application executable')

    const profileDir = `/tmp/derp-e2e-chrome-remembered-max-${Date.now()}`
    state.afterSuiteCleanup.push(async (activeBase) => {
      await spawnCommand(activeBase, `pkill -f ${shellQuote(profileDir)} || true`)
      await spawnCommand(activeBase, `rm -rf ${shellQuote(profileDir)}`)
    })

    const command = `${shellQuote(chromeExecutable)} --user-data-dir=${shellQuote(profileDir)} --no-first-run --disable-first-run-ui --ozone-platform=wayland about:blank`
    const beforeSpawn = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    const knownWindowIds = new Set(beforeSpawn.windows.map((window) => window.window_id))
    await spawnCommand(base, command)
    const firstChrome = await waitFor(
      'wait for first remembered-max chrome window',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositor.windows.find(
          (entry) =>
            !entry.shell_hosted &&
            !knownWindowIds.has(entry.window_id) &&
            /chrome|chromium/i.test(`${entry.app_id} ${entry.title}`),
        )
        return window && window.width > 100 && window.height > 100 ? window : null
      },
      10000,
      100,
    )
    state.spawnedNativeWindowIds.add(firstChrome.window_id)
    await runKeybind(base, 'toggle_maximize', firstChrome.window_id)
    await waitFor(
      'wait for first remembered-max chrome maximized',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, firstChrome.window_id)
        return window?.maximized ? window : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'close_focused', firstChrome.window_id)
    await waitForWindowGone(base, firstChrome.window_id)
    state.spawnedNativeWindowIds.delete(firstChrome.window_id)
    await spawnCommand(base, `pkill -f ${shellQuote(profileDir)} || true`)

    await clearSessionState(base)
    const beforeRelaunch = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    const knownRelaunchIds = new Set(beforeRelaunch.windows.map((window) => window.window_id))
    await spawnCommand(base, command)
    const relaunched = await waitFor(
      'wait for remembered-max chrome anchored to output',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositor.windows.find(
          (entry) =>
            !entry.shell_hosted &&
            !knownRelaunchIds.has(entry.window_id) &&
            /chrome|chromium/i.test(`${entry.app_id} ${entry.title}`),
        )
        if (!window?.maximized || window.minimized || window.fullscreen || window.lifecycle !== 'mapped') return null
        if ((window.mapped_width ?? 0) <= 100 || (window.mapped_height ?? 0) <= 100) return null
        const output = compositor.outputs.find((entry) => entry.name === window.output_name)
        if (!output) return null
        const usableX = output.usable_x ?? output.x
        const usableY = output.usable_y ?? output.y
        const usableWidth = output.usable_width ?? output.width
        const usableHeight = output.usable_height ?? output.height
        if (Math.abs(window.x - usableX) > 8) return null
        if (Math.abs(window.y - usableY) > 8) return null
        if (Math.abs(window.width - usableWidth) > 8) return null
        if (window.height < usableHeight - 80) return null
        return { window, output }
      },
      12000,
      100,
    )
    state.spawnedNativeWindowIds.add(relaunched.window.window_id)
    await writeJsonArtifact('chrome-remembered-maximized-launch.json', relaunched)
    await runKeybind(base, 'close_focused', relaunched.window.window_id)
    await waitForWindowGone(base, relaunched.window.window_id)
    state.spawnedNativeWindowIds.delete(relaunched.window.window_id)
    await clearSessionState(base)
  })

  test('session restore keeps multi-monitor tiling layouts in compositor workspace state', async ({ base }) => {
    await waitForSessionRestoreIdle(base)
    const bootstrap = await getSnapshots(base)
    if (bootstrap.compositor.outputs.length < 2) {
      throw new SkipError('requires at least two outputs')
    }
    await clearSessionState(base)
    const [first, second] = bootstrap.compositor.outputs
    await postJson(base, '/session_state', {
      version: 1,
      shell: {
        version: 1,
        nextNativeWindowSeq: 1,
        workspace: { groups: [], pinnedWindowRefs: [], nextGroupSeq: 1 },
        monitorLayouts: [
          {
            outputName: first.name,
            layout: 'grid',
            params: { maxColumns: 2 },
            snapLayout: '2x2',
          },
          {
            outputName: second.name,
            layout: 'manual-snap',
            params: {},
            snapLayout: '3x3',
          },
        ],
        monitorTiles: [],
        preTileGeometry: [],
        shellWindows: [],
        nativeWindows: [],
      },
    })

    const powerMenu = await openPowerMenu(base)
    assert(powerMenu.controls?.power_menu_restore_session, 'missing restore workspace power control')
    await clickRect(base, powerMenu.controls.power_menu_restore_session)
    const restored = await waitFor(
      'wait for restored multi-monitor monitor layouts',
      async () => {
        const state = await getJson<SessionStateResponse>(base, '/session_state')
        const firstLayout = sessionLayoutFor(state, first.name)
        const secondLayout = sessionLayoutFor(state, second.name)
        return firstLayout?.layout === 'grid' &&
          firstLayout.params?.maxColumns === 2 &&
          firstLayout.snapLayout === '2x2' &&
          secondLayout?.layout === 'manual-snap' &&
          secondLayout.snapLayout === '3x3'
          ? state
          : null
      },
      5000,
      100,
    )

    await writeJsonArtifact('session-restore-multimonitor-tiling-layouts.json', restored)
    await clearSessionState(base)
  })

  test('session autosave toggle and power menu save restore actions work', async ({ base, state }) => {
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
    await clearSessionState(base)
    const settingsOpen = await openSettings(base, 'click')
    assert(settingsOpen.shell.controls?.settings_tab_tiling, 'missing settings tiling tab rect')
    await clickRect(base, settingsOpen.shell.controls.settings_tab_tiling)
    let shell = await waitFor(
      'wait for tiling settings session controls',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.settings_session_autosave_disable && next.controls?.settings_session_autosave_enable
          ? next
          : null
      },
      5000,
      100,
    )
    assert(shell.controls?.settings_session_autosave_disable, 'missing disable autosave control')
    await clickRect(base, shell.controls.settings_session_autosave_disable)
    await waitFor(
      'wait for automatic save disabled',
      async () => {
        const html = await getShellHtml(base, '[data-settings-root]')
        return html.includes('Automatic save disabled') ? html : null
      },
      2000,
      100,
    )

    const shellTest = await openShellTestWindow(base, state)
    const shellTestWindowId = shellTest.window.window_id
    await waitForSessionShellWindow(base, shellTestWindowId, false)

    const settingsAfterShellTest = await openSettings(base, 'click')
    assert(settingsAfterShellTest.shell.controls?.settings_tab_tiling, 'missing settings tiling tab rect')
    await clickRect(base, settingsAfterShellTest.shell.controls.settings_tab_tiling)
    shell = await waitFor(
      'wait for enable autosave control',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.settings_session_autosave_enable ? next : null
      },
      5000,
      100,
    )
    assert(shell.controls?.settings_session_autosave_enable, 'missing enable autosave control')
    await clickRect(base, shell.controls.settings_session_autosave_enable)
    await waitFor(
      'wait for automatic save enabled',
      async () => {
        const html = await getShellHtml(base, '[data-settings-root]')
        return html.includes('Automatic save enabled') ? html : null
      },
      2000,
      100,
    )

    await clearSessionState(base)
    const settingsAfterClear = await openSettings(base, 'click')
    assert(settingsAfterClear.shell.controls?.settings_tab_tiling, 'missing settings tiling tab rect')
    await clickRect(base, settingsAfterClear.shell.controls.settings_tab_tiling)
    shell = await waitFor(
      'wait for disable autosave control after enabling',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.settings_session_autosave_disable ? next : null
      },
      5000,
      100,
    )
    assert(shell.controls?.settings_session_autosave_disable, 'missing disable autosave control after enabling')
    await clickRect(base, shell.controls.settings_session_autosave_disable)
    await waitFor(
      'wait for automatic save disabled after re-disable',
      async () => {
        const html = await getShellHtml(base, '[data-settings-root]')
        return html.includes('Automatic save disabled') ? html : null
      },
      2000,
      100,
    )
    await waitForSessionShellWindow(base, shellTestWindowId, false, 2000)
    await waitForSessionRestoreIdle(base)

    let powerMenu = await openPowerMenu(base)
    assert(powerMenu.controls?.power_menu_save_session, 'missing save workspace power control')
    await clickRect(base, powerMenu.controls.power_menu_save_session)
    await waitForSessionShellWindow(base, shellTestWindowId, true, 2000)

    shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await closeTaskbarWindow(base, shell, shellTestWindowId)
    await waitForWindowGone(base, shellTestWindowId)

    powerMenu = await openPowerMenu(base)
    assert(powerMenu.controls?.power_menu_restore_session, 'missing restore workspace power control')
    await clickRect(base, powerMenu.controls.power_menu_restore_session)
    const restored = await waitFor(
      `wait for restored shell test window ${shellTestWindowId}`,
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.windows.some((window) => window.window_id === shellTestWindowId && !window.minimized) ? next : null
      },
      2000,
      100,
    )

    await writeJsonArtifact('session-controls-shell.json', restored)
    await writeJsonArtifact('session-controls-state.json', await getJson<SessionStateResponse>(base, '/session_state'))

    shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await closeTaskbarWindow(base, shell, shellTestWindowId)
    await waitForWindowGone(base, shellTestWindowId)

    shell = await waitFor(
      'wait for enable autosave control for cleanup',
      async () => {
        const opened = await openSettings(base, 'click')
        if (opened.shell.controls?.settings_tab_tiling) {
          await clickRect(base, opened.shell.controls.settings_tab_tiling)
        }
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.settings_session_autosave_enable ? next : null
      },
      5000,
      100,
    )
    assert(shell.controls?.settings_session_autosave_enable, 'missing enable autosave control for cleanup')
    await waitFor(
      'wait for automatic save re-enabled for later tests',
      async () => {
        const current = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const settingsWindow = current.windows.find((window) => window.window_id === SHELL_UI_SETTINGS_WINDOW_ID) ?? null
        const enableRect = current.controls?.settings_session_autosave_enable ?? null
        const settingsChrome = windowControls(current, SHELL_UI_SETTINGS_WINDOW_ID)
        const enableVisible =
          !!settingsWindow &&
          !!enableRect &&
          enableRect.global_x >= settingsWindow.x &&
          enableRect.global_y >= settingsWindow.y &&
          enableRect.global_x + enableRect.width <= settingsWindow.x + settingsWindow.width &&
          enableRect.global_y + enableRect.height <= settingsWindow.y + settingsWindow.height
        if (!enableVisible && settingsWindow && settingsWindow.height < 600 && settingsChrome?.maximize) {
          await clickRect(base, settingsChrome.maximize)
          return null
        }
        if (enableRect) {
          await clickRect(base, enableRect)
        }
        const html = await getShellHtml(base, '[data-settings-root]')
        return html.includes('Automatic save enabled') ? html : null
      },
      2000,
      100,
    )
  })
})
