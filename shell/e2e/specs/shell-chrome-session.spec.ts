import {
  SHELL_UI_SETTINGS_WINDOW_ID,
  assert,
  clickRect,
  cleanupNativeWindows,
  cleanupShellWindows,
  closeTaskbarWindow,
  defineGroup,
  getJson,
  getShellHtml,
  getSnapshots,
  openPowerMenu,
  openSettings,
  openShellTestWindow,
  postJson,
  SkipError,
  waitFor,
  waitForSessionRestoreIdle,
  waitForWindowGone,
  windowControls,
  writeJsonArtifact,
  type ShellSnapshot,
} from '../lib/runtime.ts'

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
    nativeWindows: Array<{ windowRef: string }>
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

export default defineGroup(import.meta.url, ({ test }) => {
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
