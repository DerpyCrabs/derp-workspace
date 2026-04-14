import {
  compositorWindowStack,
  GREEN_NATIVE_TITLE,
  NATIVE_APP_ID,
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
  ensureNativePair,
  getJson,
  getSnapshots,
  openDebug,
  openSettings,
  outputForWindow,
  pointInRect,
  runKeybind,
  shellWindowStack,
  spawnNativeWindow,
  shellWindowById,
  taskbarForMonitor,
  waitFor,
  waitForNativeFocus,
  waitForShellUiFocus,
  waitForWindowGone,
  waitForWindowMinimized,
  writeJsonArtifact,
  type CompositorSnapshot,
  type ShellSnapshot,
} from '../lib/runtime.ts'

function trackedStack(shell: ShellSnapshot, windowIds: number[]) {
  const tracked = new Set(windowIds)
  return shellWindowStack(shell).filter((windowId) => tracked.has(windowId))
}

function trackedCompositorStack(compositor: CompositorSnapshot, windowIds: number[]) {
  const tracked = new Set(windowIds)
  return compositorWindowStack(compositor).filter((windowId) => tracked.has(windowId))
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

function assertStackParity(
  compositor: CompositorSnapshot,
  shell: ShellSnapshot,
  windowIds: number[],
  label: string,
) {
  const shellTracked = trackedStack(shell, windowIds)
  const compositorTracked = trackedCompositorStack(compositor, windowIds)
  assert(
    compositorTracked.length === shellTracked.length,
    `${label}: expected ${shellTracked.length} tracked compositor windows, got ${compositorTracked.length} (${compositorTracked.join(', ')})`,
  )
  assert(
    compositorTracked.join(',') === shellTracked.join(','),
    `${label}: compositor stack ${compositorTracked.join(', ')} != shell stack ${shellTracked.join(', ')}`,
  )
}

function assertOutputOrderMatchesGlobalTop(
  compositor: CompositorSnapshot,
  outputName: string,
  expectedTopWindowId: number,
  label: string,
) {
  const row = compositor.ordered_window_ids_by_output?.find((entry) => entry.output_name === outputName)
  assert(row, `${label}: missing ordered stack for output ${outputName}`)
  const top = row.window_ids[row.window_ids.length - 1] ?? null
  assert(top === expectedTopWindowId, `${label}: expected top output window ${expectedTopWindowId}, got ${top}`)
}

function windowContainsPoint(
  window: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number },
): boolean {
  return pointInRect(
    {
      x: window.x,
      y: window.y,
      width: window.width,
      height: window.height,
      global_x: window.x,
      global_y: window.y,
    },
    point,
  )
}

function visibleWindowClickPoint(shell: ShellSnapshot, windowId: number): { x: number; y: number } {
  const target = shellWindowById(shell, windowId)
  assert(target, `missing shell snapshot for window ${windowId}`)
  const stack = shellWindowStack(shell)
  const targetStackIndex = stack.indexOf(windowId)
  assert(targetStackIndex >= 0, `window ${windowId} missing from shell stack`)
  const blockers = stack
    .slice(0, targetStackIndex)
    .map((id) => shellWindowById(shell, id))
    .filter((window): window is NonNullable<typeof window> => !!window && !window.minimized)
  const insetX = Math.min(96, Math.max(48, Math.floor(target.width / 8)))
  const insetY = Math.min(96, Math.max(48, Math.floor(target.height / 8)))
  const candidates = [
    { x: target.x + insetX, y: target.y + insetY },
    { x: target.x + insetX, y: target.y + target.height - insetY },
    { x: target.x + target.width - insetX, y: target.y + insetY },
    { x: target.x + target.width - insetX, y: target.y + target.height - insetY },
    { x: target.x + insetX, y: target.y + target.height / 2 },
    { x: target.x + target.width / 2, y: target.y + insetY },
  ]
  const visible = candidates.find((candidate) =>
    windowContainsPoint(target, candidate) && blockers.every((window) => !windowContainsPoint(window, candidate)),
  )
  assert(visible, `window ${windowId} has no exposed click point`)
  return visible
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('spawn native red and green windows', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    await writeJsonArtifact('native-red-spawn.json', red.snapshot)
    await writeJsonArtifact('native-green-spawn.json', green.snapshot)
  })

  test('decorated native window disappears when its client drops content', async ({ base, state }) => {
    const dropped = await spawnNativeWindow(base, state.knownWindowIds, {
      title: 'Derp Native Buffer Drop',
      token: 'native-buffer-drop',
      strip: 'green',
      dropBufferAfterDraw: true,
    })
    state.spawnedNativeWindowIds.add(dropped.window.window_id)
    const gone = await waitForWindowGone(base, dropped.window.window_id, 5000)
    assert(
      !(gone.compositor.pending_deferred_window_ids ?? []).includes(dropped.window.window_id),
      'dropped native window should not remain pending deferred',
    )
    assert(
      !compositorWindowStack(gone.compositor).includes(dropped.window.window_id),
      'dropped native window should be removed from compositor stack order',
    )
    await writeJsonArtifact('native-buffer-drop-pruned-compositor.json', gone.compositor)
    await writeJsonArtifact('native-buffer-drop-pruned-shell.json', gone.shell)
  })

  test('native taskbar focus and tile left/right', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
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
          assert(red.title === RED_NATIVE_TITLE, `expected red title ${RED_NATIVE_TITLE}, got ${red.title}`)
          assert(green.title === GREEN_NATIVE_TITLE, `expected green title ${GREEN_NATIVE_TITLE}, got ${green.title}`)
          assert(red.app_id === NATIVE_APP_ID, `expected red app_id ${NATIVE_APP_ID}, got ${red.app_id}`)
          assert(green.app_id === NATIVE_APP_ID, `expected green app_id ${NATIVE_APP_ID}, got ${green.app_id}`)
          assert(red.output_name === redOutput.name, `expected red output ${redOutput.name}, got ${red.output_name}`)
          assert(green.output_name === greenOutput.name, `expected green output ${greenOutput.name}, got ${green.output_name}`)
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
    const { red } = await ensureNativePair(base, state)
    const redId = red.window.window_id
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
    const { red } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    await openSettings(base, 'click')
    await openDebug(base)
    const paritySnapshots = await getSnapshots(base)
    const redCompositor = compositorWindowById(paritySnapshots.compositor, redId)
    const settingsCompositor = compositorWindowById(paritySnapshots.compositor, SHELL_UI_SETTINGS_WINDOW_ID)
    const debugCompositor = compositorWindowById(paritySnapshots.compositor, SHELL_UI_DEBUG_WINDOW_ID)
    assert(redCompositor, 'missing red compositor window')
    assert(settingsCompositor, 'missing settings compositor window')
    assert(debugCompositor, 'missing debug compositor window')
    const redClickPoint = visibleWindowClickPoint(paritySnapshots.shell, redId)
    await clickPoint(base, redClickPoint.x, redClickPoint.y)
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
    const debugFocused = await waitForShellUiFocus(base, SHELL_UI_DEBUG_WINDOW_ID)
    assertStackParity(
      debugFocused.compositor,
      debugFocused.shell,
      [redId, SHELL_UI_SETTINGS_WINDOW_ID, SHELL_UI_DEBUG_WINDOW_ID],
      'debug click focus parity',
    )
    const shellAfterClicks = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assertTopWindow(shellAfterClicks, SHELL_UI_DEBUG_WINDOW_ID, 'debug should be frontmost after direct click')
    const shellWithSettings = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellWithSettings, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsFocused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertTopWindow(settingsFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should be frontmost after taskbar activate')
    assertStackParity(
      settingsFocused.compositor,
      settingsFocused.shell,
      [redId, SHELL_UI_SETTINGS_WINDOW_ID, SHELL_UI_DEBUG_WINDOW_ID],
      'settings taskbar focus parity',
    )
    await writeJsonArtifact('native-js-parity-shell.json', settingsFocused.shell)
    await writeJsonArtifact('native-js-parity-compositor.json', settingsFocused.compositor)
  })

  test('js and native windows preserve restack order across focus changes', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
    const trackedWindowIds = [redId, greenId, SHELL_UI_DEBUG_WINDOW_ID, SHELL_UI_SETTINGS_WINDOW_ID]

    await openSettings(base, 'click')
    const debugOpen = await openDebug(base)
    const redWindow = compositorWindowById(debugOpen.compositor, redId)
    assert(redWindow, 'missing red compositor window')

    const redClickPoint = visibleWindowClickPoint(debugOpen.shell, redId)
    await clickPoint(base, redClickPoint.x, redClickPoint.y)
    const redFocused = await waitForNativeFocus(base, redId)
    assertRestackToFront(debugOpen.shell, redFocused.shell, redId, trackedWindowIds, 'red focus restack order')
    assertStackParity(redFocused.compositor, redFocused.shell, trackedWindowIds, 'red focus stack parity')
    assertOutputOrderMatchesGlobalTop(
      redFocused.compositor,
      redFocused.compositor.windows.find((window) => window.window_id === redId)?.output_name ?? '',
      redId,
      'red focus output order',
    )

    await activateTaskbarWindow(base, redFocused.shell, greenId)
    const greenFocused = await waitForNativeFocus(base, greenId)
    assertRestackToFront(redFocused.shell, greenFocused.shell, greenId, trackedWindowIds, 'green focus restack order')
    assertStackParity(greenFocused.compositor, greenFocused.shell, trackedWindowIds, 'green focus stack parity')
    assertOutputOrderMatchesGlobalTop(
      greenFocused.compositor,
      greenFocused.compositor.windows.find((window) => window.window_id === greenId)?.output_name ?? '',
      greenId,
      'green focus output order',
    )

    await activateTaskbarWindow(base, greenFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsFocused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertRestackToFront(
      greenFocused.shell,
      settingsFocused.shell,
      SHELL_UI_SETTINGS_WINDOW_ID,
      trackedWindowIds,
      'settings focus restack order',
    )
    assertStackParity(settingsFocused.compositor, settingsFocused.shell, trackedWindowIds, 'settings focus stack parity')

    await activateTaskbarWindow(base, settingsFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsMinimized = await waitForWindowMinimized(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(
      shellWindowById(settingsMinimized.shell, SHELL_UI_SETTINGS_WINDOW_ID)?.minimized,
      'settings taskbar activation should minimize when focused',
    )

    await activateTaskbarWindow(base, settingsMinimized.shell, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsRestored = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertTopWindow(settingsRestored.shell, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should return to the front after restore')
    assertStackParity(settingsRestored.compositor, settingsRestored.shell, trackedWindowIds, 'settings restore stack parity')

    await activateTaskbarWindow(base, settingsRestored.shell, SHELL_UI_DEBUG_WINDOW_ID)
    const debugFocused = await waitForShellUiFocus(base, SHELL_UI_DEBUG_WINDOW_ID)
    assertRestackToFront(
      settingsRestored.shell,
      debugFocused.shell,
      SHELL_UI_DEBUG_WINDOW_ID,
      trackedWindowIds,
      'debug focus restack order',
    )
    assertStackParity(debugFocused.compositor, debugFocused.shell, trackedWindowIds, 'debug focus stack parity')

    await activateTaskbarWindow(base, debugFocused.shell, redId)
    const redRefocused = await waitForNativeFocus(base, redId)
    assertRestackToFront(
      debugFocused.shell,
      redRefocused.shell,
      redId,
      trackedWindowIds,
      'red refocus restack order',
    )
    assertStackParity(redRefocused.compositor, redRefocused.shell, trackedWindowIds, 'red refocus stack parity')

    await writeJsonArtifact('native-js-restack-red.json', redFocused.shell)
    await writeJsonArtifact('native-js-restack-green.json', greenFocused.shell)
    await writeJsonArtifact('native-js-restack-settings.json', settingsFocused.shell)
    await writeJsonArtifact('native-js-restack-settings-restored.json', settingsRestored.shell)
    await writeJsonArtifact('native-js-restack-debug.json', debugFocused.shell)
    await writeJsonArtifact('native-js-restack-red-refocused.json', redRefocused.shell)
    await writeJsonArtifact('native-js-restack-red-compositor.json', redFocused.compositor)
    await writeJsonArtifact('native-js-restack-green-compositor.json', greenFocused.compositor)
    await writeJsonArtifact('native-js-restack-settings-compositor.json', settingsFocused.compositor)
    await writeJsonArtifact('native-js-restack-settings-restored-compositor.json', settingsRestored.compositor)
    await writeJsonArtifact('native-js-restack-debug-compositor.json', debugFocused.compositor)
    await writeJsonArtifact('native-js-restack-red-refocused-compositor.json', redRefocused.compositor)
  })
})
