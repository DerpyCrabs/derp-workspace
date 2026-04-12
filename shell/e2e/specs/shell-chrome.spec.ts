import {
  ensureNativePair,
  SHELL_UI_SETTINGS_WINDOW_ID,
  activateTaskbarWindow,
  assert,
  assertTopWindow,
  clickPoint,
  clickRect,
  closeTaskbarWindow,
  compositorWindowById,
  defineGroup,
  getJson,
  getShellHtml,
  getSnapshots,
  movePoint,
  openDebug,
  openPowerMenu,
  openProgramsMenu,
  openSettings,
  openShellTestWindow,
  pointerWheel,
  pointInRect,
  assertRectMinSize,
  runKeybind,
  waitForPowerMenuClosed,
  waitForPowerMenuOpen,
  waitForProgramsMenuClosed,
  waitFor,
  waitForNativeFocus,
  waitForShellUiFocus,
  waitForWindowGone,
  writeJsonArtifact,
  writeTextArtifact,
  type Rect,
  type ShellSnapshot,
} from '../lib/runtime.ts'

async function switchSettingsPage(
  base: string,
  controlKey:
    | 'settings_tab_user'
    | 'settings_tab_displays'
    | 'settings_tab_tiling'
    | 'settings_tab_keyboard',
  pageId: 'user' | 'displays' | 'tiling' | 'keyboard',
  marker: string,
): Promise<string> {
  return waitFor(
    `wait for settings ${pageId} page`,
    async () => {
      const html = await getShellHtml(base, '[data-settings-root]')
      if (html.includes(`data-settings-active-page="${pageId}"`) && html.includes(marker)) {
        return html
      }
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const rect = shell.controls?.[controlKey]
      if (rect) await clickRect(base, rect)
      return null
    },
    5000,
    100,
  )
}

function bodyClickPoint(
  target: { x: number; y: number; width: number; height: number },
  other: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  const insetX = Math.min(16, Math.max(8, Math.floor(target.width / 18)))
  const insetY = Math.min(16, Math.max(8, Math.floor(target.height / 18)))
  const otherRect: Rect = {
    x: other.x,
    y: other.y,
    global_x: other.x,
    global_y: other.y,
    width: other.width,
    height: other.height,
  }
  const candidates = [
    { x: target.x + insetX, y: target.y + insetY },
    { x: target.x + insetX, y: target.y + Math.floor(target.height / 2) },
    { x: target.x + Math.floor(target.width / 2), y: target.y + insetY },
    { x: target.x + target.width - insetX, y: target.y + insetY },
    { x: target.x + target.width - insetX, y: target.y + Math.floor(target.height / 2) },
    { x: target.x + insetX, y: target.y + target.height - insetY },
    { x: target.x + Math.floor(target.width / 2), y: target.y + target.height - insetY },
    { x: target.x + target.width - insetX, y: target.y + target.height - insetY },
  ]
  for (const candidate of candidates) {
    if (!pointInRect(otherRect, candidate)) return candidate
  }
  return { x: target.x + Math.floor(target.width / 2), y: target.y + Math.floor(target.height / 2) }
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('bootstrap snapshots and launcher catalog', async ({ base, state }) => {
    const { compositor, shell } = await getSnapshots(base)
    assert(Array.isArray(compositor.windows), 'compositor snapshot missing windows array')
    assert(Array.isArray(shell.windows), 'shell snapshot missing windows array')
    assert(shell.controls?.taskbar_settings_toggle, 'shell snapshot missing settings toggle')
    assert(shell.controls?.taskbar_programs_toggle, 'shell snapshot missing programs toggle')
    state.knownWindowIds = new Set(compositor.windows.map((window) => window.window_id))
    const desktopApplications = await getJson<{ apps?: typeof state.desktopApps }>(base, '/desktop_applications')
    const apps = Array.isArray(desktopApplications?.apps) ? desktopApplications.apps : []
    state.desktopApps = apps
    await writeJsonArtifact('bootstrap-compositor.json', compositor)
    await writeJsonArtifact('bootstrap-shell.json', shell)
    await writeJsonArtifact('desktop-applications.json', desktopApplications)
  })

  test('programs menu list scrolls with pointer wheel over launcher', async ({ base, state }) => {
    assert(state.desktopApps.length >= 6, `need desktop apps for launcher scroll test, got ${state.desktopApps.length}`)
    const opened = await openProgramsMenu(base, 'click')
    assert(opened.programs_menu_open, 'programs menu should be open')
    const metrics0 = opened.programs_menu_list_scroll
    assert(metrics0, 'missing programs_menu_list_scroll')
    assert(
      metrics0.scroll_height > metrics0.client_height + 32,
      `expected programs list overflow for wheel test (scroll_height ${metrics0.scroll_height} client_height ${metrics0.client_height})`,
    )
    const { compositor, shell } = await getSnapshots(base)
    assert(shell.programs_menu_open, 'programs menu should stay open')
    const menuG = compositor.shell_context_menu_global
    assert(
      menuG && menuG.width > 0 && menuG.height > 0,
      'compositor must expose shell_context_menu_global while programs menu is open',
    )
    const menuAsRect: Rect = {
      x: 0,
      y: 0,
      global_x: menuG.x,
      global_y: menuG.y,
      width: menuG.width,
      height: menuG.height,
    }
    const px = menuG.x + menuG.width * 0.5
    const py = menuG.y + menuG.height * 0.58
    await movePoint(base, px, py)
    const { compositor: comp2, shell: shell2 } = await getSnapshots(base)
    const pt = comp2.pointer
    assert(pt && Number.isFinite(pt.x) && Number.isFinite(pt.y), 'compositor snapshot missing pointer')
    assert(
      pointInRect(menuAsRect, pt),
      `pointer ${pt.x},${pt.y} should be inside compositor shell_context_menu_global (x=${menuG.x} y=${menuG.y} w=${menuG.width} h=${menuG.height}; moved to ${px},${py})`,
    )
    const list = shell2.controls.programs_menu_list
    assert(list, 'missing programs_menu_list')
    assertRectMinSize('programs_menu_list', list, 32, 32)
    assert(shell2.programs_menu_open, 'programs menu should stay open')
    const beforeTop = metrics0.scroll_top
    await pointerWheel(base, 0, 120)
    const scrolledDown = await waitFor(
      'programs menu scroll increases after wheel',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const m = shell.programs_menu_list_scroll
        if (!m || !shell.programs_menu_open) return null
        if (m.scroll_top > beforeTop + 8) return shell
        return null
      },
      8000,
      50,
    )
    const peak = scrolledDown.programs_menu_list_scroll?.scroll_top
    assert(peak !== undefined && peak > beforeTop + 8, 'expected scroll_top after wheel down')
    await new Promise((resolve) => setTimeout(resolve, 700))
    await pointerWheel(base, 0, -120)
    await waitFor(
      'programs menu scroll decreases after wheel up',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const m = shell.programs_menu_list_scroll
        if (!m || !shell.programs_menu_open) return null
        if (m.scroll_top < peak - 8) return shell
        return null
      },
      8000,
      50,
    )
    await runKeybind(base, 'toggle_programs_menu')
    await waitForProgramsMenuClosed(base)
  })

  test('settings window opens from taskbar, switches tabs, and reopens from keybind', async ({ base }) => {
    const settingsOpen = await openSettings(base, 'click')
    assert(settingsOpen.shell.controls?.settings_tab_user, 'missing settings user tab rect')
    assert(settingsOpen.shell.controls?.settings_tab_tiling, 'missing settings tiling tab rect')
    assert(settingsOpen.shell.controls?.settings_tab_displays, 'missing settings displays tab rect')
    assert(settingsOpen.shell.controls?.settings_tab_keyboard, 'missing settings keyboard tab rect')
    await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    await clickRect(base, settingsOpen.shell.controls.settings_tab_user)
    const userHtml = await switchSettingsPage(base, 'settings_tab_user', 'user', 'data-settings-user-page')
    const keyboardHtml = await switchSettingsPage(
      base,
      'settings_tab_keyboard',
      'keyboard',
      'Apply keyboard settings',
    )
    await switchSettingsPage(base, 'settings_tab_tiling', 'tiling', 'data-settings-active-page="tiling"')
    const settingsHtml = await switchSettingsPage(
      base,
      'settings_tab_displays',
      'displays',
      'data-settings-displays-page',
    )
    const keyboardSettings = await getJson(base, '/settings_keyboard')
    const userSettings = await getJson(base, '/settings_user')
    await writeTextArtifact('settings-root.html', settingsHtml)
    await writeTextArtifact('settings-user-page.html', userHtml)
    await writeTextArtifact('settings-keyboard-page.html', keyboardHtml)
    await writeJsonArtifact('settings-keyboard.json', keyboardSettings)
    await writeJsonArtifact('settings-user.json', userSettings)
    const shellBeforeClose = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await closeTaskbarWindow(base, shellBeforeClose, SHELL_UI_SETTINGS_WINDOW_ID)
    await waitForWindowGone(base, SHELL_UI_SETTINGS_WINDOW_ID)
    await openSettings(base, 'keybind')
    const settingsFocused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertTopWindow(settingsFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID, 'settings reopen')
    await writeJsonArtifact('settings-shell.json', settingsFocused.shell)
  })

  test('debug window opens and toggles crosshair state', async ({ base }) => {
    const debugOpen = await openDebug(base)
    assert(debugOpen.shell.controls?.debug_crosshair_toggle, 'missing debug crosshair toggle rect')
    assert(debugOpen.shell.controls?.debug_reload_button, 'missing debug reload button rect')
    assert(debugOpen.shell.controls?.debug_copy_snapshot_button, 'missing debug copy snapshot button rect')
    const debugHtml = await getShellHtml(base, '[data-shell-debug-root]')
    assert(debugHtml.includes('Reload shell'), 'debug html missing reload button')
    assert(debugHtml.includes('Copy snapshot'), 'debug html missing copy snapshot button')
    assert(debugHtml.includes('Crosshair'), 'debug html missing crosshair control')
    await clickRect(base, debugOpen.shell.controls.debug_crosshair_toggle)
    const crosshairOn = await waitFor(
      'wait for debug crosshair on',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return shell.crosshair_cursor === true ? shell : null
      },
      5000,
      100,
    )
    assert(crosshairOn.controls.debug_crosshair_toggle, 'missing debug crosshair toggle rect after enabling')
    await clickRect(base, crosshairOn.controls.debug_crosshair_toggle)
    const crosshairOff = await waitFor(
      'wait for debug crosshair off',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return shell.crosshair_cursor === false ? shell : null
      },
      5000,
      100,
    )
    await writeJsonArtifact('debug-shell.json', crosshairOff)
  })

  test('js windows raise to front when clicking content', async ({ base, state }) => {
    const first = await openShellTestWindow(base, state)
    const second = await openShellTestWindow(base, state)
    const firstId = first.window.window_id
    const secondId = second.window.window_id

    const secondFocused = await waitForShellUiFocus(base, secondId)
    assertTopWindow(secondFocused.shell, secondId, 'second js window should open frontmost')

    const firstWindow = compositorWindowById(secondFocused.compositor, firstId)
    const secondWindow = compositorWindowById(secondFocused.compositor, secondId)
    assert(firstWindow, 'missing first js compositor window')
    assert(secondWindow, 'missing second js compositor window')

    const firstPoint = bodyClickPoint(firstWindow, secondWindow)
    await clickPoint(base, firstPoint.x, firstPoint.y)
    const firstFocused = await waitForShellUiFocus(base, firstId)
    assertTopWindow(firstFocused.shell, firstId, 'first js window content click should bring it frontmost')

    const secondPoint = bodyClickPoint(secondWindow, firstWindow)
    await clickPoint(base, secondPoint.x, secondPoint.y)
    const refocusedSecond = await waitForShellUiFocus(base, secondId)
    assertTopWindow(refocusedSecond.shell, secondId, 'second js window content click should bring it frontmost')

    await writeJsonArtifact('js-content-click-focus.json', {
      firstId,
      secondId,
      firstPoint,
      secondPoint,
      firstFocused: firstFocused.shell,
      refocusedSecond: refocusedSecond.shell,
    })
  })

  test('taskbar context menus switch cleanly without disturbing shell focus', async ({ base }) => {
    await openSettings(base, 'click')
    await openDebug(base)
    const shellBeforeFocus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeFocus, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsFocused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsWindow = compositorWindowById(settingsFocused.compositor, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(settingsWindow, 'missing settings compositor window')

    const powerOpen = await openPowerMenu(base)
    assert(powerOpen.power_menu_open, 'power menu should be open')
    assert(!powerOpen.programs_menu_open, 'programs menu should stay closed while power menu is open')
    assertTopWindow(powerOpen, SHELL_UI_SETTINGS_WINDOW_ID, 'power menu should not change focused shell window')
    const powerHtml = await getShellHtml(base, '[aria-label="Power"]')
    assert(powerHtml.includes('Suspend'), 'power menu missing suspend action')
    assert(powerHtml.includes('Restart'), 'power menu missing restart action')
    assert(powerHtml.includes('Shut down'), 'power menu missing shutdown action')

    const programsOpen = await openProgramsMenu(base, 'click')
    assert(programsOpen.programs_menu_open, 'programs menu should be open')
    assert(!programsOpen.power_menu_open, 'power menu should close when programs menu opens')
    assertTopWindow(programsOpen, SHELL_UI_SETTINGS_WINDOW_ID, 'programs menu should not change focused shell window')
    const programsHtml = await getShellHtml(base, '[aria-label="Application search"]')
    assert(programsHtml.includes('Search apps, keywords, and commands'), 'programs menu missing search placeholder')

    await clickPoint(
      base,
      settingsWindow.x + settingsWindow.width / 2,
      settingsWindow.y + Math.min(72, Math.max(24, Math.floor(settingsWindow.height / 4))),
    )
    const programsClosed = await waitForProgramsMenuClosed(base)
    assert(!programsClosed.power_menu_open, 'power menu should remain closed after dismissing programs menu')
    assertTopWindow(programsClosed, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should stay frontmost after dismissing programs menu')

    await openPowerMenu(base)
    const powerReopened = await waitForPowerMenuOpen(base)
    assertTopWindow(powerReopened, SHELL_UI_SETTINGS_WINDOW_ID, 'reopened power menu should not change focused shell window')

    await clickPoint(
      base,
      settingsWindow.x + settingsWindow.width / 2,
      settingsWindow.y + Math.min(72, Math.max(24, Math.floor(settingsWindow.height / 4))),
    )
    const powerClosed = await waitForPowerMenuClosed(base)
    assertTopWindow(powerClosed, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should stay frontmost after dismissing power menu')

    await writeJsonArtifact('taskbar-context-menus.json', {
      powerOpen,
      programsOpen,
      programsClosed,
      powerReopened,
      powerClosed,
    })
    await writeTextArtifact('taskbar-power-menu.html', powerHtml)
    await writeTextArtifact('taskbar-programs-menu.html', programsHtml)
  })

  test('native windows do not cover focused shell windows during taskbar menu churn', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
    const settingsOpen = await openSettings(base, 'click')
    const redWindow = compositorWindowById(settingsOpen.compositor, redId)
    const greenWindow = compositorWindowById(settingsOpen.compositor, greenId)
    const settingsWindow = compositorWindowById(settingsOpen.compositor, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(redWindow, 'missing red compositor window')
    assert(greenWindow, 'missing green compositor window')
    assert(settingsWindow, 'missing settings compositor window')

    const shellBeforeRedFocus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeRedFocus, redId)
    await waitForNativeFocus(base, redId)

    const shellBeforeSettingsFocus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeSettingsFocus, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsFocused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertTopWindow(settingsFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should restack above native windows')

    const contentPoints = [
      {
        x: settingsWindow.x + Math.min(80, Math.max(24, Math.floor(settingsWindow.width / 5))),
        y: settingsWindow.y + Math.min(92, Math.max(36, Math.floor(settingsWindow.height / 4))),
      },
      {
        x: settingsWindow.x + Math.max(48, Math.floor(settingsWindow.width / 2)),
        y: settingsWindow.y + Math.max(64, Math.floor(settingsWindow.height / 2)),
      },
    ]

    for (const [index, point] of contentPoints.entries()) {
      await clickPoint(base, point.x, point.y)
      const refocused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
      assertTopWindow(refocused.shell, SHELL_UI_SETTINGS_WINDOW_ID, `settings content click ${index} should stay frontmost`)
    }

    const powerOpen = await openPowerMenu(base)
    assertTopWindow(powerOpen, SHELL_UI_SETTINGS_WINDOW_ID, 'power menu should not let native windows overtake settings')
    const programsOpen = await openProgramsMenu(base, 'click')
    assertTopWindow(programsOpen, SHELL_UI_SETTINGS_WINDOW_ID, 'programs menu should not let native windows overtake settings')

    await clickPoint(base, contentPoints[0].x, contentPoints[0].y)
    const programsClosed = await waitForProgramsMenuClosed(base)
    assertTopWindow(programsClosed, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should stay frontmost after menu dismiss')
    await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)

    const shellBeforeGreenFocus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeGreenFocus, greenId)
    await waitForNativeFocus(base, greenId)
    const shellBeforeRefocus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeRefocus, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsRefocused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertTopWindow(settingsRefocused.shell, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should recover above native windows after native refocus')

    await clickPoint(base, contentPoints[1].x, contentPoints[1].y)
    const finalFocus = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertTopWindow(finalFocus.shell, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should remain clickable after native focus churn')

    await writeJsonArtifact('shell-chrome-native-menu-focus.json', {
      settingsFocused: settingsFocused.shell,
      programsOpen,
      programsClosed,
      settingsRefocused: settingsRefocused.shell,
      finalFocus: finalFocus.shell,
    })
  })
})
