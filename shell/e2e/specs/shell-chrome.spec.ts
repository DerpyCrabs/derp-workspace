import {
  SHELL_UI_SETTINGS_WINDOW_ID,
  assert,
  assertTopWindow,
  clickRect,
  closeTaskbarWindow,
  defineGroup,
  getJson,
  getShellHtml,
  getSnapshots,
  openDebug,
  openSettings,
  waitFor,
  waitForShellUiFocus,
  waitForWindowGone,
  writeJsonArtifact,
  writeTextArtifact,
  type ShellSnapshot,
} from '../lib/runtime.ts'

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

  test('settings window opens from taskbar, switches tabs, and reopens from keybind', async ({ base }) => {
    const settingsOpen = await openSettings(base, 'click')
    assert(settingsOpen.shell.controls?.settings_tab_user, 'missing settings user tab rect')
    assert(settingsOpen.shell.controls?.settings_tab_tiling, 'missing settings tiling tab rect')
    assert(settingsOpen.shell.controls?.settings_tab_displays, 'missing settings displays tab rect')
    assert(settingsOpen.shell.controls?.settings_tab_keyboard, 'missing settings keyboard tab rect')
    await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    await clickRect(base, settingsOpen.shell.controls.settings_tab_user)
    const userHtml = await waitFor(
      'wait for settings user page',
      async () => {
        const html = await getShellHtml(base, '[data-settings-root]')
        return html.includes('data-settings-active-page="user"') && html.includes('data-settings-user-page')
          ? html
          : null
      },
      5000,
      100,
    )
    await clickRect(base, settingsOpen.shell.controls.settings_tab_keyboard)
    const keyboardHtml = await waitFor(
      'wait for settings keyboard page',
      async () => {
        const html = await getShellHtml(base, '[data-settings-root]')
        return html.includes('data-settings-active-page="keyboard"') &&
          html.includes('data-settings-keyboard-page') &&
          html.includes('Apply keyboard settings')
          ? html
          : null
      },
      5000,
      100,
    )
    await clickRect(base, settingsOpen.shell.controls.settings_tab_tiling)
    await waitFor(
      'wait for settings tiling page',
      async () => {
        const html = await getShellHtml(base, '[data-settings-root]')
        return html.includes('data-settings-active-page="tiling"') ? html : null
      },
      5000,
      100,
    )
    await clickRect(base, settingsOpen.shell.controls.settings_tab_displays)
    const settingsHtml = await waitFor(
      'wait for settings displays page',
      async () => {
        const html = await getShellHtml(base, '[data-settings-root]')
        return html.includes('data-settings-active-page="displays"') ? html : null
      },
      5000,
      100,
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
})
