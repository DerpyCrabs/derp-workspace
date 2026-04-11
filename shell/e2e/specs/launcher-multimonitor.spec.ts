import {
  SHELL_UI_SETTINGS_WINDOW_ID,
  SkipError,
  activateTaskbarWindow,
  assert,
  assertTaskbarRowOnMonitor,
  clickRect,
  clickPoint,
  compositorWindowById,
  defineGroup,
  findLauncherCandidate,
  getJson,
  getShellHtml,
  getSnapshots,
  openProgramsMenu,
  pickMonitorMove,
  pointInRect,
  postJson,
  printNote,
  rectCenter,
  runKeybind,
  shellWindowById,
  taskbarEntry,
  taskbarForMonitor,
  waitFor,
  waitForNativeFocus,
  waitForProgramsMenuClosed,
  waitForProgramsMenuOpen,
  waitForShellUiFocus,
  writeJsonArtifact,
  writeTextArtifact,
  type CompositorSnapshot,
  type ShellSnapshot,
} from '../lib/runtime.ts'

export default defineGroup(import.meta.url, ({ test }) => {
  test('programs menu opens searches and optionally launches a terminal app', async ({ base, state }) => {
    const menuOpen = await openProgramsMenu(base, 'click')
    assert(menuOpen.controls?.programs_menu_search, 'missing programs menu search control')
    assert(menuOpen.controls.taskbar_programs_toggle, 'missing programs menu toggle')
    await clickRect(base, menuOpen.controls.taskbar_programs_toggle)
    await waitForProgramsMenuClosed(base)
    await openProgramsMenu(base, 'keybind')
    const menuByKeybind = await waitForProgramsMenuOpen(base)
    assert(menuByKeybind.controls?.programs_menu_search, 'missing programs menu search control after keybind')
    await postJson(base, '/test/programs_menu_query', { query: 'a' })
    await waitFor(
      'wait for programs menu query',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return shell.programs_menu_query === 'a' ? shell : null
      },
      5000,
      100,
    )
    const launcherCandidate = findLauncherCandidate(state.desktopApps)
    if (!launcherCandidate) {
      printNote('no stable terminal launcher candidate found')
    } else {
      await runKeybind(base, 'toggle_programs_menu')
      await waitForProgramsMenuClosed(base)
      const menuForLaunch = await openProgramsMenu(base, 'keybind')
      assert(menuForLaunch.controls?.programs_menu_search, 'missing programs menu search control for launch')
      await postJson(base, '/test/programs_menu_query', { query: launcherCandidate.query })
      const filteredMenu = await waitFor(
        'wait for launcher query',
        async () => {
          const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
          return shell.programs_menu_query === launcherCandidate.query && shell.controls?.programs_menu_first_item
            ? shell
            : null
        },
        5000,
        100,
      )
      assert(filteredMenu.controls?.programs_menu_first_item, 'missing first launcher result rect')
      const knownBefore = new Set((await getJson<CompositorSnapshot>(base, '/test/state/compositor')).windows.map((window) => window.window_id))
      await postJson(base, '/test/programs_menu_activate', {})
      const launched = await waitFor(
        'wait for launcher spawned window',
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          const window = compositor.windows.find((entry) => !entry.shell_hosted && !knownBefore.has(entry.window_id))
          if (!window) return null
          return { compositor, shell, window }
        },
        12000,
        125,
      )
      state.launcherWindowId = launched.window.window_id
      state.spawnedNativeWindowIds.add(launched.window.window_id)
      await writeJsonArtifact('programs-menu-launch.json', {
        query: launcherCandidate.query,
        app: launcherCandidate.app,
        window: launched.window,
      })
    }
    await writeJsonArtifact('programs-menu-shell.json', menuByKeybind)
    if ((await getJson<ShellSnapshot>(base, '/test/state/shell')).programs_menu_open) {
      await runKeybind(base, 'toggle_programs_menu')
      await waitForProgramsMenuClosed(base)
    }
  })

  test('multi-monitor taskbars and native/js window moves stay aligned', async ({ base, state }) => {
    const { compositor, shell } = await getSnapshots(base)
    if (compositor.outputs.length < 2) {
      throw new SkipError('requires at least two outputs')
    }
    assert(shell.taskbars.length >= compositor.outputs.length, 'expected at least one taskbar per output')
    const primaryControls = [
      shell.controls?.taskbar_programs_toggle,
      shell.controls?.taskbar_settings_toggle,
      shell.controls?.taskbar_debug_toggle,
      shell.controls?.taskbar_power_toggle,
    ]
    const primaryMonitors = new Set(
      primaryControls
        .filter((rect): rect is NonNullable<typeof rect> => !!rect)
        .map((rect) => {
          const point = rectCenter(rect)
          const taskbar = shell.taskbars.find((entry) => pointInRect(entry.rect, point))
          return taskbar?.monitor ?? ''
        })
        .filter(Boolean),
    )
    assert(primaryMonitors.size === 1, `expected primary-only controls on one monitor, got ${[...primaryMonitors].join(', ')}`)

    const redId = state.redSpawn!.window.window_id
    const redShell = shellWindowById(shell, redId)
    const redCompositor = compositorWindowById(compositor, redId)
    assert(redShell?.output_name, 'missing red shell output name')
    assert(redCompositor, 'missing red compositor window')
    assertTaskbarRowOnMonitor(shell, redId, redShell.output_name)
    const nativeMove = pickMonitorMove(compositor.outputs, redShell.output_name)
    if (!nativeMove) {
      throw new SkipError(`no adjacent monitor from ${redShell.output_name}`)
    }
    await clickPoint(base, redCompositor.x + redCompositor.width / 2, redCompositor.y + redCompositor.height / 2)
    try {
      await waitForNativeFocus(base, redId, 1500)
    } catch {}
    await runKeybind(base, nativeMove.action)
    const nativeMoved = await waitFor(
      'wait for native monitor move',
      async () => {
        const { compositor: nextCompositor, shell: nextShell } = await getSnapshots(base)
        const compWindow = compositorWindowById(nextCompositor, redId)
        const shellWindow = shellWindowById(nextShell, redId)
        if (!compWindow || !shellWindow) return null
        if (compWindow.output_name !== nativeMove.target.name || shellWindow.output_name !== nativeMove.target.name) {
          return null
        }
        const taskbar = taskbarForMonitor(nextShell, nativeMove.target.name)
        const output = nextCompositor.outputs.find((entry) => entry.name === nativeMove.target.name)
        if (!taskbar?.rect || !output) return null
        const row = taskbarEntry(nextShell, redId)
        if (!row?.activate || !pointInRect(taskbar.rect, rectCenter(row.activate))) return null
        if (compWindow.x < output.x || compWindow.x + compWindow.width > output.x + output.width) return null
        return { compositor: nextCompositor, shell: nextShell, compWindow, shellWindow }
      },
      8000,
      125,
    )
    state.multiMonitorNativeMove = {
      window_id: redId,
      target_output: nativeMove.target.name,
    }

    await activateTaskbarWindow(base, await getJson<ShellSnapshot>(base, '/test/state/shell'), SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsFocused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsWindow = shellWindowById(settingsFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(settingsWindow?.output_name, 'missing settings output name')
    assertTaskbarRowOnMonitor(settingsFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID, settingsWindow.output_name)
    const settingsMove = pickMonitorMove(compositor.outputs, settingsWindow.output_name)
    if (!settingsMove) {
      throw new SkipError(`no adjacent monitor for settings from ${settingsWindow.output_name}`)
    }
    await runKeybind(base, settingsMove.action)
    const settingsMoved = await waitFor(
      'wait for settings monitor move',
      async () => {
        const { compositor: nextCompositor, shell: nextShell } = await getSnapshots(base)
        const compWindow = compositorWindowById(nextCompositor, SHELL_UI_SETTINGS_WINDOW_ID)
        const shellUiWindow = shellWindowById(nextShell, SHELL_UI_SETTINGS_WINDOW_ID)
        if (!compWindow || !shellUiWindow) return null
        if (compWindow.output_name !== settingsMove.target.name || shellUiWindow.output_name !== settingsMove.target.name) {
          return null
        }
        const taskbar = taskbarForMonitor(nextShell, settingsMove.target.name)
        const row = taskbarEntry(nextShell, SHELL_UI_SETTINGS_WINDOW_ID)
        if (!taskbar?.rect || !row?.activate || !pointInRect(taskbar.rect, rectCenter(row.activate))) {
          return null
        }
        return { compositor: nextCompositor, shell: nextShell, compWindow, shellUiWindow }
      },
      8000,
      125,
    )
    assert(settingsMoved.shell.controls?.settings_tab_displays, 'missing settings displays tab rect after move')
    await clickRect(base, settingsMoved.shell.controls.settings_tab_displays)
    await waitFor(
      'wait for settings displays tab after move',
      async () => {
        const html = await getShellHtml(base, '[data-settings-root]')
        return html.includes('data-settings-active-page="displays"') ? html : null
      },
      5000,
      100,
    )
    const displaysHtml = await getShellHtml(base, '[data-settings-displays-page]')
    for (const output of compositor.outputs) {
      assert(displaysHtml.includes(output.name), `settings displays page missing output ${output.name}`)
    }
    state.multiMonitorShellMove = {
      window_id: SHELL_UI_SETTINGS_WINDOW_ID,
      target_output: settingsMove.target.name,
    }
    await writeJsonArtifact('multimonitor-native-move.json', nativeMoved)
    await writeJsonArtifact('multimonitor-shell-move.json', settingsMoved)
    await writeTextArtifact('settings-displays-page.html', displaysHtml)
  })
})
