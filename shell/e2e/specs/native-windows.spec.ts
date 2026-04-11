import {
  GREEN_NATIVE_TITLE,
  RED_NATIVE_TITLE,
  SHELL_UI_DEBUG_WINDOW_ID,
  SHELL_UI_SETTINGS_WINDOW_ID,
  activateTaskbarWindow,
  assert,
  assertTopWindow,
  assertWindowTiled,
  clickPoint,
  compositorWindowById,
  defineGroup,
  getJson,
  getSnapshots,
  openDebug,
  openSettings,
  outputForWindow,
  runKeybind,
  shellWindowStack,
  shellWindowById,
  spawnNativeWindow,
  taskbarEntry,
  taskbarForMonitor,
  waitFor,
  waitForNativeFocus,
  waitForShellUiFocus,
  waitForWindowMinimized,
  writeJsonArtifact,
  type ShellSnapshot,
} from '../lib/runtime.ts'

function trackedStack(shell: ShellSnapshot, windowIds: number[]) {
  const tracked = new Set(windowIds)
  return shellWindowStack(shell).filter((windowId) => tracked.has(windowId))
}

function assertRestackToFront(beforeShell: ShellSnapshot, afterShell: ShellSnapshot, focusedWindowId: number, windowIds: number[], label: string) {
  const before = trackedStack(beforeShell, windowIds)
  const after = trackedStack(afterShell, windowIds)
  const expected = [focusedWindowId, ...before.filter((windowId) => windowId !== focusedWindowId)]
  assert(
    after.length === expected.length,
    `${label}: expected ${expected.length} tracked windows, got ${after.length} (${after.join(', ')})`,
  )
  assert(after.join(',') === expected.join(','), `${label}: expected ${expected.join(', ')}, got ${after.join(', ')}`)
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('spawn native red and green windows', async ({ base, state }) => {
    state.redSpawn = await spawnNativeWindow(base, state.knownWindowIds, {
      title: RED_NATIVE_TITLE,
      token: 'native-red',
      strip: 'red',
    })
    state.greenSpawn = await spawnNativeWindow(base, state.knownWindowIds, {
      title: GREEN_NATIVE_TITLE,
      token: 'native-green',
      strip: 'green',
    })
    state.spawnedNativeWindowIds.add(state.redSpawn.window.window_id)
    state.spawnedNativeWindowIds.add(state.greenSpawn.window.window_id)
    await waitFor(
      'wait for native taskbar rows',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return taskbarEntry(shell, state.redSpawn!.window.window_id) &&
          taskbarEntry(shell, state.greenSpawn!.window.window_id)
          ? shell
          : null
      },
      8000,
      125,
    )
    await writeJsonArtifact('native-red-spawn.json', state.redSpawn.snapshot)
    await writeJsonArtifact('native-green-spawn.json', state.greenSpawn.snapshot)
  })

  test('native taskbar focus and tile left/right', async ({ base, state }) => {
    const redId = state.redSpawn!.window.window_id
    const greenId = state.greenSpawn!.window.window_id
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shell, redId)
    await waitForNativeFocus(base, redId)
    const shellWithRedFocus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellWithRedFocus, redId)
    const redMinimized = await waitForWindowMinimized(base, redId)
    assert(shellWindowById(redMinimized.shell, redId)?.minimized, 'red taskbar activation should minimize when focused')
    await activateTaskbarWindow(base, redMinimized.shell, redId)
    await waitForNativeFocus(base, redId)
    await runKeybind(base, 'tile_left')
    const shellAfterRed = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellAfterRed, greenId)
    await waitForNativeFocus(base, greenId)
    await runKeybind(base, 'tile_right')
    const tiled = await waitFor(
      'wait for red and green tiling',
      async () => {
        const { compositor, shell: currentShell } = await getSnapshots(base)
        const red = compositorWindowById(compositor, redId)
        const green = compositorWindowById(compositor, greenId)
        if (!red || !green) return null
        const redOutput = outputForWindow(compositor, red)
        const greenOutput = outputForWindow(compositor, green)
        if (!redOutput || !greenOutput || redOutput.name !== greenOutput.name) return null
        const taskbar = taskbarForMonitor(currentShell, redOutput.name)
        if (!taskbar?.rect) return null
        try {
          assertWindowTiled(red, redOutput, taskbar.rect, 'left')
          assertWindowTiled(green, greenOutput, taskbar.rect, 'right')
        } catch {
          return null
        }
        return { compositor, shell: currentShell, output: redOutput }
      },
      10000,
      125,
    )
    state.tiledOutput = tiled.output.name
    await writeJsonArtifact('native-tiling-compositor.json', tiled.compositor)
    await writeJsonArtifact('native-tiling-shell.json', tiled.shell)
  })

  test('native maximize fullscreen and tile up/down transitions', async ({ base, state }) => {
    const redId = state.redSpawn!.window.window_id
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shell, redId)
    await waitForNativeFocus(base, redId)
    const before = compositorWindowById((await getSnapshots(base)).compositor, redId)
    assert(before, 'missing red native window before state tests')
    await runKeybind(base, 'toggle_maximize')
    const maximized = await waitFor(
      'wait for maximize',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window?.maximized ? { compositor, window } : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'toggle_maximize')
    await waitFor(
      'wait for maximize restore',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        if (!window || window.maximized) return null
        return Math.abs(window.width - before.width) < 80 ? { compositor, window } : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'toggle_fullscreen')
    await waitFor(
      'wait for fullscreen',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window?.fullscreen ? { compositor, window } : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'toggle_fullscreen')
    await waitFor(
      'wait for fullscreen restore',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window && !window.fullscreen ? { compositor, window } : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'tile_up')
    await waitFor(
      'wait for tile up maximize',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window?.maximized ? { compositor, window } : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'tile_down')
    const restored = await waitFor(
      'wait for tile down restore',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window && !window.maximized && !window.fullscreen ? { compositor, window } : null
      },
      5000,
      100,
    )
    await writeJsonArtifact('native-state-transitions.json', {
      before,
      maximized: maximized.window,
      restored: restored.window,
    })
  })

  test('native and shell windows share focus stacking and taskbar parity', async ({ base, state }) => {
    const redId = state.redSpawn!.window.window_id
    await openSettings(base, 'click')
    await openDebug(base)
    const paritySnapshots = await getSnapshots(base)
    const redCompositor = compositorWindowById(paritySnapshots.compositor, redId)
    const settingsCompositor = compositorWindowById(paritySnapshots.compositor, SHELL_UI_SETTINGS_WINDOW_ID)
    const debugCompositor = compositorWindowById(paritySnapshots.compositor, SHELL_UI_DEBUG_WINDOW_ID)
    assert(redCompositor, 'missing red compositor window')
    assert(settingsCompositor, 'missing settings compositor window')
    assert(debugCompositor, 'missing debug compositor window')
    await clickPoint(base, redCompositor.x + redCompositor.width / 2, redCompositor.y + redCompositor.height / 2)
    await waitForNativeFocus(base, redId)
    const shellBeforeSettingsFocus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeSettingsFocus, SHELL_UI_SETTINGS_WINDOW_ID)
    await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    await clickPoint(
      base,
      settingsCompositor.x + Math.min(48, Math.max(16, Math.floor(settingsCompositor.width / 8))),
      settingsCompositor.y + Math.min(48, Math.max(16, Math.floor(settingsCompositor.height / 8))),
    )
    await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const shellBeforeDebugFocus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeDebugFocus, SHELL_UI_DEBUG_WINDOW_ID)
    await waitForShellUiFocus(base, SHELL_UI_DEBUG_WINDOW_ID)
    await clickPoint(
      base,
      debugCompositor.x + Math.min(48, Math.max(16, Math.floor(debugCompositor.width / 8))),
      debugCompositor.y + Math.min(48, Math.max(16, Math.floor(debugCompositor.height / 8))),
    )
    await waitForShellUiFocus(base, SHELL_UI_DEBUG_WINDOW_ID)
    const shellAfterClicks = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assertTopWindow(shellAfterClicks, SHELL_UI_DEBUG_WINDOW_ID, 'debug should be frontmost after direct click')
    const shellWithSettings = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellWithSettings, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsFocused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertTopWindow(settingsFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should be frontmost after taskbar activate')
    await writeJsonArtifact('native-js-parity-shell.json', settingsFocused.shell)
  })

  test('js and native windows preserve restack order across focus changes', async ({ base, state }) => {
    const redId = state.redSpawn!.window.window_id
    const greenId = state.greenSpawn!.window.window_id
    const trackedWindowIds = [redId, greenId, SHELL_UI_DEBUG_WINDOW_ID, SHELL_UI_SETTINGS_WINDOW_ID]

    await openSettings(base, 'click')
    const debugOpen = await openDebug(base)
    const redWindow = compositorWindowById(debugOpen.compositor, redId)
    assert(redWindow, 'missing red compositor window')

    await clickPoint(base, redWindow.x + redWindow.width / 2, redWindow.y + redWindow.height / 2)
    const redFocused = await waitForNativeFocus(base, redId)
    assertRestackToFront(debugOpen.shell, redFocused.shell, redId, trackedWindowIds, 'red focus restack order')

    await activateTaskbarWindow(base, redFocused.shell, greenId)
    const greenFocused = await waitForNativeFocus(base, greenId)
    assertRestackToFront(redFocused.shell, greenFocused.shell, greenId, trackedWindowIds, 'green focus restack order')

    await activateTaskbarWindow(base, greenFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsFocused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertRestackToFront(
      greenFocused.shell,
      settingsFocused.shell,
      SHELL_UI_SETTINGS_WINDOW_ID,
      trackedWindowIds,
      'settings focus restack order',
    )

    await activateTaskbarWindow(base, settingsFocused.shell, SHELL_UI_DEBUG_WINDOW_ID)
    const debugFocused = await waitForShellUiFocus(base, SHELL_UI_DEBUG_WINDOW_ID)
    assertRestackToFront(
      settingsFocused.shell,
      debugFocused.shell,
      SHELL_UI_DEBUG_WINDOW_ID,
      trackedWindowIds,
      'debug focus restack order',
    )

    await activateTaskbarWindow(base, debugFocused.shell, redId)
    const redRefocused = await waitForNativeFocus(base, redId)
    assertRestackToFront(
      debugFocused.shell,
      redRefocused.shell,
      redId,
      trackedWindowIds,
      'red refocus restack order',
    )

    await writeJsonArtifact('native-js-restack-red.json', redFocused.shell)
    await writeJsonArtifact('native-js-restack-green.json', greenFocused.shell)
    await writeJsonArtifact('native-js-restack-settings.json', settingsFocused.shell)
    await writeJsonArtifact('native-js-restack-debug.json', debugFocused.shell)
    await writeJsonArtifact('native-js-restack-red-refocused.json', redRefocused.shell)
  })
})
