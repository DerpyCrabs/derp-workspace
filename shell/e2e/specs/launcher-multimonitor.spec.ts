import {
  KEY,
  SHELL_UI_SETTINGS_WINDOW_ID,
  SkipError,
  assert,
  assertTaskbarRowOnMonitor,
  closeTaskbarWindow,
  closeWindow,
  clickPoint,
  clickRect,
  compositorWindowById,
  defineGroup,
  ensureDesktopApps,
  ensureNativePair,
  findLauncherCandidate,
  getJson,
  getShellHtml,
  getSnapshots,
  movePoint,
  openProgramsMenu,
  openSettings,
  pickMonitorMove,
  pointInRect,
  printNote,
  raiseTaskbarWindow,
  rectCenter,
  shellWindowById,
  tapKey,
  tapSuperShortcut,
  taskbarEntry,
  taskbarForMonitor,
  typeText,
  waitFor,
  waitForProgramsMenuClosed,
  waitForWindowGone,
  writeJsonArtifact,
  writeTextArtifact,
  type CompositorSnapshot,
  type DesktopAppEntry,
  type ShellSnapshot,
  type WindowSnapshot,
} from '../lib/runtime.ts'

function resolveWindowOutputName(compositor: CompositorSnapshot, window: WindowSnapshot): string | null {
  const centerX = window.x + Math.floor(window.width / 2)
  const centerY = window.y + Math.floor(window.height / 2)
  const output = compositor.outputs.find(
    (entry) =>
      centerX >= entry.x &&
      centerX < entry.x + entry.width &&
      centerY >= entry.y &&
      centerY < entry.y + entry.height,
  )
  if (output) return output.name
  if (window.output_name) return window.output_name
  return null
}

async function ensureProgramsMenuSearchReady(base: string, shell: ShellSnapshot) {
  assert(shell.controls?.programs_menu_search, 'missing programs menu search control')
  const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
  if (compositor.shell_keyboard_focus) {
    return shell
  }
  await clickRect(base, shell.controls.programs_menu_search)
  await waitFor(
    'wait for launcher search focus',
    async () => {
      const next = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
      return next.shell_keyboard_focus ? next : null
    },
    2000,
    50,
  )
  return getJson<ShellSnapshot>(base, '/test/state/shell')
}

async function openProgramsMenuBySuper(base: string): Promise<ShellSnapshot> {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  if (!shell.programs_menu_open) {
    await tapKey(base, KEY.super)
  }
  return waitFor(
    'wait for programs menu open by super',
    async () => {
      const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return next.programs_menu_open && next.controls?.programs_menu_search ? next : null
    },
    5000,
    100,
  )
}

async function moveFocusedWindowToMonitor(base: string, action: 'move_monitor_left' | 'move_monitor_right') {
  await tapSuperShortcut(base, action === 'move_monitor_left' ? KEY.left : KEY.right, { shift: true })
}

async function launchTerminalAppFromProgramsMenu(
  base: string,
  state: { desktopApps: DesktopAppEntry[]; launcherWindowId: number | null; spawnedNativeWindowIds: Set<number> },
  launcherCandidate: { query: string; app: DesktopAppEntry },
) {
  await ensureProgramsMenuSearchReady(base, await openProgramsMenuBySuper(base))
  await typeText(base, launcherCandidate.query)
  const filteredMenu = await waitFor(
    `wait for launcher query ${launcherCandidate.query}`,
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
  await tapKey(base, KEY.enter)
  const stableLaunch = await waitFor(
    `wait for launcher spawned window ${launcherCandidate.query}`,
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const window = compositor.windows.find((entry) => !entry.shell_hosted && !knownBefore.has(entry.window_id))
      if (!window) return null
      if (window.width < 160 || window.height < 48) return null
      if (!window.title.trim()) return null
      if (shell.programs_menu_open) return null
      if (!taskbarEntry(shell, window.window_id)) return null
      return { compositor, shell, window }
    },
    2000,
    125,
  )
  state.launcherWindowId = stableLaunch.window.window_id
  state.spawnedNativeWindowIds.add(stableLaunch.window.window_id)
  return {
    filteredMenu,
    launched: stableLaunch,
    stableLaunch,
  }
}

async function closeLaunchedWindowAndAssertNoGhost(
  base: string,
  launchedWindow: WindowSnapshot,
) {
  const shellBeforeClose = await getJson<ShellSnapshot>(base, '/test/state/shell')
  if (taskbarEntry(shellBeforeClose, launchedWindow.window_id)?.close) {
    await closeTaskbarWindow(base, shellBeforeClose, launchedWindow.window_id)
  } else {
    await closeWindow(base, launchedWindow.window_id)
  }
  await waitForWindowGone(base, launchedWindow.window_id)
  return waitFor(
    `wait for no tiny launcher ghost ${launchedWindow.window_id}`,
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const suspiciousGhosts = compositor.windows.filter(
        (window) =>
          !window.shell_hosted &&
          (window.app_id === launchedWindow.app_id || window.title === launchedWindow.title) &&
          !window.minimized &&
          (window.width < 160 || window.height < 48),
      )
      if (suspiciousGhosts.length > 0) return null
      if (taskbarEntry(shell, launchedWindow.window_id)) return null
      return { compositor, shell, suspiciousGhosts }
    },
    5000,
    100,
  )
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('programs menu opens searches and optionally launches a terminal app', async ({ base, state }) => {
    const desktopApps = await ensureDesktopApps(base, state)
    const menuOpen = await openProgramsMenu(base, 'click')
    assert(menuOpen.controls?.programs_menu_search, 'missing programs menu search control')
    assert(menuOpen.controls.taskbar_programs_toggle, 'missing programs menu toggle')
    await clickRect(base, menuOpen.controls.taskbar_programs_toggle)
    await waitForProgramsMenuClosed(base)
    const menuBySuper = await ensureProgramsMenuSearchReady(base, await openProgramsMenuBySuper(base))
    await typeText(base, 'a')
    await waitFor(
      'wait for programs menu query',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return shell.programs_menu_query === 'a' ? shell : null
      },
      5000,
      100,
    )
    const launcherCandidate = findLauncherCandidate(desktopApps)
    if (!launcherCandidate) {
      printNote('no stable terminal launcher candidate found')
    } else {
      const shellBeforeLaunch = await getJson<ShellSnapshot>(base, '/test/state/shell')
      assert(shellBeforeLaunch.controls?.taskbar_programs_toggle, 'missing programs toggle before launcher app launch')
      await clickRect(base, shellBeforeLaunch.controls.taskbar_programs_toggle)
      await waitForProgramsMenuClosed(base)
      const { stableLaunch } = await launchTerminalAppFromProgramsMenu(base, state, launcherCandidate)
      await writeJsonArtifact('programs-menu-launch.json', {
        query: launcherCandidate.query,
        app: launcherCandidate.app,
        window: stableLaunch.window,
      })
      await closeLaunchedWindowAndAssertNoGhost(base, stableLaunch.window)
    }
    await writeJsonArtifact('programs-menu-shell.json', menuBySuper)
    const shellAfterLaunch = await getJson<ShellSnapshot>(base, '/test/state/shell')
    if (shellAfterLaunch.programs_menu_open) {
      assert(shellAfterLaunch.controls?.taskbar_programs_toggle, 'missing programs toggle while menu is open')
      await clickRect(base, shellAfterLaunch.controls.taskbar_programs_toggle)
      await waitForProgramsMenuClosed(base)
    }
  })

  test('launcher app closes cleanly without leaving tiny native ghost windows', async ({ base, state }) => {
    const desktopApps = await ensureDesktopApps(base, state)
    const launcherCandidate = findLauncherCandidate(desktopApps)
    if (!launcherCandidate) {
      throw new SkipError('no stable terminal launcher candidate found')
    }
    const cycles: Array<{ launched: WindowSnapshot; closed: { compositor: CompositorSnapshot; shell: ShellSnapshot } }> = []
    for (let index = 0; index < 1; index += 1) {
      const { stableLaunch } = await launchTerminalAppFromProgramsMenu(base, state, launcherCandidate)
      const closed = await closeLaunchedWindowAndAssertNoGhost(base, stableLaunch.window)
      cycles.push({ launched: stableLaunch.window, closed })
    }
    await writeJsonArtifact('programs-menu-launcher-cleanup.json', {
      query: launcherCandidate.query,
      cycles,
    })
  })

  test('launcher open-close cycles keep shell and compositor aligned', async ({ base, state }) => {
    const desktopApps = await ensureDesktopApps(base, state)
    const launcherCandidate = findLauncherCandidate(desktopApps)
    if (!launcherCandidate) {
      throw new SkipError('no stable terminal launcher candidate found')
    }
    const cycles: Array<{
      launched: WindowSnapshot
      aligned: { output_name: string; width: number; height: number }
      closed: { compositor: CompositorSnapshot; shell: ShellSnapshot }
    }> = []
    for (let index = 0; index < 2; index += 1) {
      const { stableLaunch } = await launchTerminalAppFromProgramsMenu(base, state, launcherCandidate)
      const aligned = await waitFor(
        `wait for launcher alignment cycle ${index + 1}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          const compWindow = compositorWindowById(compositor, stableLaunch.window.window_id)
          const shellWindow = shellWindowById(shell, stableLaunch.window.window_id)
          if (!compWindow || !shellWindow) return null
          if (!shellWindow.output_name || compWindow.output_name !== shellWindow.output_name) return null
          const taskbar = taskbarForMonitor(shell, shellWindow.output_name)
          const row = taskbarEntry(shell, stableLaunch.window.window_id)
          if (!taskbar?.rect || !row?.activate) return null
          if (!pointInRect(taskbar.rect, rectCenter(row.activate))) return null
          if (compWindow.width < 160 || compWindow.height < 48) return null
          return {
            output_name: shellWindow.output_name,
            width: compWindow.width,
            height: compWindow.height,
          }
        },
        5000,
        75,
      )
      const closed = await closeLaunchedWindowAndAssertNoGhost(base, stableLaunch.window)
      cycles.push({ launched: stableLaunch.window, aligned, closed })
    }
    await writeJsonArtifact('programs-menu-launcher-alignment-cycles.json', {
      query: launcherCandidate.query,
      cycles,
    })
  })

  test('multi-monitor taskbars and native/js window moves stay aligned', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    await closeWindow(base, green.window.window_id)
    await waitForWindowGone(base, green.window.window_id)
    state.spawnedNativeWindowIds.delete(green.window.window_id)
    state.knownWindowIds.delete(green.window.window_id)
    state.nativeLaunchByWindowId.delete(green.window.window_id)
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

    const redId = red.window.window_id
    const nativeInitial = await waitFor(
      'wait for native multimonitor output assignment',
      async () => {
        const { compositor: nextCompositor, shell: nextShell } = await getSnapshots(base)
        const redShell = shellWindowById(nextShell, redId)
        const redCompositor = compositorWindowById(nextCompositor, redId)
        if (!redShell || !redCompositor) return null
        const outputName = resolveWindowOutputName(nextCompositor, redShell)
        if (!outputName) return null
        const nativeMove = pickMonitorMove(nextCompositor.outputs, outputName)
        if (!nativeMove) return null
        return { compositor: nextCompositor, shell: nextShell, redShell, redCompositor, outputName, nativeMove }
      },
      5000,
      100,
    )
    assertTaskbarRowOnMonitor(nativeInitial.shell, redId, nativeInitial.outputName)
    const nativeMove = nativeInitial.nativeMove
    if (!nativeMove) {
      throw new SkipError(`no adjacent monitor from ${nativeInitial.outputName}`)
    }
    await raiseTaskbarWindow(base, redId)
    const cx = nativeInitial.redCompositor.x + Math.floor(nativeInitial.redCompositor.width / 2)
    const cy = nativeInitial.redCompositor.y + Math.floor(nativeInitial.redCompositor.height / 2)
    await movePoint(base, cx, cy)
    await clickPoint(base, cx, cy)
    await moveFocusedWindowToMonitor(base, nativeMove.action)
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
        if (compWindow.x < output.x || compWindow.x + compWindow.width > output.x + output.width) return null
        return { compositor: nextCompositor, shell: nextShell, compWindow, shellWindow }
      },
      5000,
      125,
    )
    state.multiMonitorNativeMove = {
      window_id: redId,
      target_output: nativeMove.target.name,
    }

    await openSettings(base, 'click')
    const settingsRaised = await raiseTaskbarWindow(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsComp = compositorWindowById(settingsRaised.compositor, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(settingsComp, 'missing settings compositor window')
    const settingsOutputName = resolveWindowOutputName(settingsRaised.compositor, settingsComp)
    assert(settingsOutputName, 'missing settings output name')
    assertTaskbarRowOnMonitor(settingsRaised.shell, SHELL_UI_SETTINGS_WINDOW_ID, settingsOutputName)
    const settingsMove = pickMonitorMove(nativeMoved.compositor.outputs, settingsOutputName)
    if (!settingsMove) {
      throw new SkipError(`no adjacent monitor for settings from ${settingsOutputName}`)
    }
    await moveFocusedWindowToMonitor(base, settingsMove.action)
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
      2000,
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
    for (const output of settingsMoved.compositor.outputs) {
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
