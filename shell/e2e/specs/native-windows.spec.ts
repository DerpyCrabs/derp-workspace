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
  waitForWindowRaised,
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
  assert(
    after.length === before.length,
    `${label}: expected ${before.length} tracked windows, got ${after.length} (${after.join(', ')})`,
  )
  assert(after[0] === focusedWindowId, `${label}: expected ${focusedWindowId} frontmost, got ${after.join(', ')}`)
  const beforeSet = [...before].sort((a, b) => a - b)
  const afterSet = [...after].sort((a, b) => a - b)
  assert(
    afterSet.join(',') === beforeSet.join(','),
    `${label}: expected tracked set ${beforeSet.join(', ')}, got ${afterSet.join(', ')}`,
  )
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

async function waitForOutputOrderMatchesGlobalTop(
  base: string,
  outputName: string,
  expectedTopWindowId: number,
  label: string,
) {
  return waitFor(
    label,
    async () => {
      const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
      try {
        assertOutputOrderMatchesGlobalTop(compositor, outputName, expectedTopWindowId, label)
      } catch {
        return null
      }
      return compositor
    },
    5000,
    100,
  )
}

async function waitForTrackedStackParity(base: string, windowIds: number[], label: string) {
  return waitFor(
    label,
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      try {
        assertStackParity(compositor, shell, windowIds, label)
      } catch {
        return null
      }
      return { compositor, shell }
    },
    8000,
    100,
  )
}

async function raiseTaskbarWindow(base: string, windowId: number) {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const shellWindow = shellWindowById(shell, windowId)
    if (!(shell.focused_window_id === windowId && shellWindow && !shellWindow.minimized)) {
      await activateTaskbarWindow(base, shell, windowId)
    }
    try {
      if (windowId === SHELL_UI_SETTINGS_WINDOW_ID || windowId === SHELL_UI_DEBUG_WINDOW_ID) {
        const focused = await waitForShellUiFocus(base, windowId, 2500)
        return { ...focused, window: shellWindowById(focused.shell, windowId)! }
      }
      const focused = await waitForNativeFocus(base, windowId, 2500)
      return { ...focused, window: shellWindowById(focused.shell, windowId)! }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
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

async function tileNativePair(base: string, redId: number, greenId: number) {
  await raiseTaskbarWindow(base, redId)
  await runKeybind(base, 'tile_left')
  await waitFor(
    'wait for native red tiled left',
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const red = compositorWindowById(compositor, redId)
      if (!red) return null
      const redOutput = outputForWindow(compositor, red)
      const taskbar = redOutput ? taskbarForMonitor(shell, redOutput.name) : null
      if (!redOutput || !taskbar?.rect) return null
      try {
        assertWindowTiled(red, redOutput, taskbar.rect, 'left')
      } catch {
        return null
      }
      return { compositor, shell, red, output: redOutput }
    },
    5000,
    100,
  )
  await raiseTaskbarWindow(base, greenId)
  await runKeybind(base, 'tile_right')
  return waitFor(
    'wait for native red and green tiling',
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
  const clampInset = (value: number, size: number) => Math.max(8, Math.min(size - 8, Math.floor(value)))
  const xOffsets = [
    12,
    20,
    32,
    48,
    72,
    Math.floor(target.width / 2),
    target.width - 72,
    target.width - 48,
    target.width - 32,
    target.width - 20,
    target.width - 12,
  ]
  const yOffsets = [
    12,
    20,
    32,
    48,
    72,
    Math.floor(target.height / 2),
    target.height - 72,
    target.height - 48,
    target.height - 32,
    target.height - 20,
    target.height - 12,
  ]
  const uniqueX = [...new Set(xOffsets.map((offset) => clampInset(offset, target.width)))]
  const uniqueY = [...new Set(yOffsets.map((offset) => clampInset(offset, target.height)))]
  const candidates = uniqueX.flatMap((xOffset) =>
    uniqueY.map((yOffset) => ({
      x: target.x + xOffset,
      y: target.y + yOffset,
    })),
  )
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
    const redFocused = await raiseTaskbarWindow(base, redId)
    const shellWithRedFocus = redFocused.shell
    await activateTaskbarWindow(base, shellWithRedFocus, redId)
    const redMinimized = await waitForWindowMinimized(base, redId)
    assert(shellWindowById(redMinimized.shell, redId)?.minimized, 'red taskbar activation should minimize when focused')
    await raiseTaskbarWindow(base, redId)
    const tiled = await tileNativePair(base, redId, greenId)
    const tiledRed = compositorWindowById(tiled.compositor, redId)
    const tiledGreen = compositorWindowById(tiled.compositor, greenId)
    assert(tiledRed, 'missing tiled red window')
    assert(tiledGreen, 'missing tiled green window')
    assert(tiledRed.title === RED_NATIVE_TITLE, `expected red title ${RED_NATIVE_TITLE}, got ${tiledRed.title}`)
    assert(tiledGreen.title === GREEN_NATIVE_TITLE, `expected green title ${GREEN_NATIVE_TITLE}, got ${tiledGreen.title}`)
    assert(tiledRed.app_id === NATIVE_APP_ID, `expected red app_id ${NATIVE_APP_ID}, got ${tiledRed.app_id}`)
    assert(tiledGreen.app_id === NATIVE_APP_ID, `expected green app_id ${NATIVE_APP_ID}, got ${tiledGreen.app_id}`)
    assert(tiledRed.output_name === tiled.output.name, `expected red output ${tiled.output.name}, got ${tiledRed.output_name}`)
    assert(tiledGreen.output_name === tiled.output.name, `expected green output ${tiled.output.name}, got ${tiledGreen.output_name}`)
    state.tiledOutput = tiled.output.name
    await writeJsonArtifact('native-tiling-compositor.json', tiled.compositor)
    await writeJsonArtifact('native-tiling-shell.json', tiled.shell)
  })

  test('closing a focused native window by keybind refocuses the previous window', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
    await raiseTaskbarWindow(base, redId)
    await raiseTaskbarWindow(base, greenId)
    await runKeybind(base, 'close_focused')
    const gone = await waitForWindowGone(base, greenId, 8000)
    const refocused = await waitForNativeFocus(base, redId, 8000)
    await writeJsonArtifact('native-close-refocus-gone.json', gone)
    await writeJsonArtifact('native-close-refocus-refocused.json', refocused)
  })

  test('native maximize fullscreen and tile up/down transitions', async ({ base, state }) => {
    const { red } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    await raiseTaskbarWindow(base, redId)
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

  test('native windows raise to front when clicking content', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
    const trackedWindowIds = [redId, greenId]

    await tileNativePair(base, redId, greenId)
    const initial = await waitForTrackedStackParity(base, trackedWindowIds, 'native click initial parity')

    const redClickPoint = visibleWindowClickPoint(initial.shell, redId)
    await clickPoint(base, redClickPoint.x, redClickPoint.y)
    const redFocused = await waitForNativeFocus(base, redId)
    assertRestackToFront(
      initial.shell,
      redFocused.shell,
      redId,
      trackedWindowIds,
      'native red content click restack order',
    )

    const greenClickPoint = visibleWindowClickPoint(redFocused.shell, greenId)
    await clickPoint(base, greenClickPoint.x, greenClickPoint.y)
    const greenFocused = await waitForNativeFocus(base, greenId)
    assertRestackToFront(
      redFocused.shell,
      greenFocused.shell,
      greenId,
      trackedWindowIds,
      'native green content click restack order',
    )

    const parity = await waitForTrackedStackParity(base, trackedWindowIds, 'native click final parity')
    await writeJsonArtifact('native-content-click-focus.json', {
      redId,
      greenId,
      redClickPoint,
      greenClickPoint,
      initialShell: initial.shell,
      redFocused: redFocused.shell,
      greenFocused: greenFocused.shell,
      finalCompositor: parity.compositor,
    })
  })

  test('native and shell windows share focus stacking and taskbar parity', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
    await tileNativePair(base, redId, greenId)
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
    await waitForWindowRaised(base, redId)
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
    await waitForTrackedStackParity(
      base,
      [redId, SHELL_UI_SETTINGS_WINDOW_ID, SHELL_UI_DEBUG_WINDOW_ID],
      'debug click focus parity',
    )
    const shellAfterClicks = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assertTopWindow(shellAfterClicks, SHELL_UI_DEBUG_WINDOW_ID, 'debug should be frontmost after direct click')
    await raiseTaskbarWindow(base, SHELL_UI_SETTINGS_WINDOW_ID)
    await clickPoint(
      base,
      settingsCompositor.x + Math.min(48, Math.max(16, Math.floor(settingsCompositor.width / 8))),
      settingsCompositor.y + Math.min(48, Math.max(16, Math.floor(settingsCompositor.height / 8))),
    )
    await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsFocused = await waitForTrackedStackParity(
      base,
      [redId, SHELL_UI_SETTINGS_WINDOW_ID, SHELL_UI_DEBUG_WINDOW_ID],
      'settings taskbar focus parity',
    )
    assertTopWindow(settingsFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should be frontmost after taskbar activate')
    await writeJsonArtifact('native-js-parity-shell.json', settingsFocused.shell)
    await writeJsonArtifact('native-js-parity-compositor.json', settingsFocused.compositor)
  })

  test('mouse clicks switch focus between native and shell windows with stack parity', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
    const trackedWindowIds = [redId, greenId, SHELL_UI_SETTINGS_WINDOW_ID]

    await tileNativePair(base, redId, greenId)
    await openSettings(base, 'click')
    const initial = await waitForTrackedStackParity(base, trackedWindowIds, 'native shell click initial parity')

    const redClickPoint = visibleWindowClickPoint(initial.shell, redId)
    await clickPoint(base, redClickPoint.x, redClickPoint.y)
    const redFocused = await waitForNativeFocus(base, redId)
    assertRestackToFront(
      initial.shell,
      redFocused.shell,
      redId,
      trackedWindowIds,
      'native shell red click restack order',
    )

    const settingsClickPoint = visibleWindowClickPoint(redFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID)
    await clickPoint(base, settingsClickPoint.x, settingsClickPoint.y)
    const settingsFocused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertRestackToFront(
      redFocused.shell,
      settingsFocused.shell,
      SHELL_UI_SETTINGS_WINDOW_ID,
      trackedWindowIds,
      'native shell settings click restack order',
    )

    const greenClickPoint = visibleWindowClickPoint(settingsFocused.shell, greenId)
    await clickPoint(base, greenClickPoint.x, greenClickPoint.y)
    const greenFocused = await waitForNativeFocus(base, greenId)
    assertRestackToFront(
      settingsFocused.shell,
      greenFocused.shell,
      greenId,
      trackedWindowIds,
      'native shell green click restack order',
    )

    const parity = await waitForTrackedStackParity(base, trackedWindowIds, 'native shell click final parity')
    assertTopWindow(parity.shell, greenId, 'green should be frontmost after mixed mouse activation')
    await writeJsonArtifact('native-shell-content-click-focus.json', {
      redId,
      greenId,
      redClickPoint,
      settingsClickPoint,
      greenClickPoint,
      initialShell: initial.shell,
      redFocused: redFocused.shell,
      settingsFocused: settingsFocused.shell,
      greenFocused: greenFocused.shell,
      finalCompositor: parity.compositor,
    })
  })

  test('js and native windows preserve restack order across focus changes', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
    const trackedWindowIds = [redId, greenId, SHELL_UI_DEBUG_WINDOW_ID, SHELL_UI_SETTINGS_WINDOW_ID]

    await tileNativePair(base, redId, greenId)
    await openSettings(base, 'click')
    const debugOpen = await openDebug(base)
    const redWindow = compositorWindowById(debugOpen.compositor, redId)
    assert(redWindow, 'missing red compositor window')

    const redClickPoint = visibleWindowClickPoint(debugOpen.shell, redId)
    await clickPoint(base, redClickPoint.x, redClickPoint.y)
    const redFocused = await waitForWindowRaised(base, redId)
    assertRestackToFront(debugOpen.shell, redFocused.shell, redId, trackedWindowIds, 'red focus restack order')
    await waitForOutputOrderMatchesGlobalTop(
      base,
      redFocused.compositor.windows.find((window) => window.window_id === redId)?.output_name ?? '',
      redId,
      'red focus output order',
    )

    const greenFocused = await raiseTaskbarWindow(base, greenId)
    assertRestackToFront(redFocused.shell, greenFocused.shell, greenId, trackedWindowIds, 'green focus restack order')
    await waitForOutputOrderMatchesGlobalTop(
      base,
      greenFocused.compositor.windows.find((window) => window.window_id === greenId)?.output_name ?? '',
      greenId,
      'green focus output order',
    )

    const settingsRaised = await raiseTaskbarWindow(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsWindow = compositorWindowById(settingsRaised.compositor, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(settingsWindow, 'missing settings compositor window after taskbar focus')
    await clickPoint(
      base,
      settingsWindow.x + Math.min(48, Math.max(16, Math.floor(settingsWindow.width / 8))),
      settingsWindow.y + Math.min(48, Math.max(16, Math.floor(settingsWindow.height / 8))),
    )
    const settingsFocused = await waitForWindowRaised(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertRestackToFront(
      greenFocused.shell,
      settingsFocused.shell,
      SHELL_UI_SETTINGS_WINDOW_ID,
      trackedWindowIds,
      'settings focus restack order',
    )

    await activateTaskbarWindow(base, settingsFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsMinimized = await waitForWindowMinimized(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(
      shellWindowById(settingsMinimized.shell, SHELL_UI_SETTINGS_WINDOW_ID)?.minimized,
      'settings taskbar activation should minimize when focused',
    )

    const settingsRestored = await raiseTaskbarWindow(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertTopWindow(settingsRestored.shell, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should return to the front after restore')

    const debugFocused = await raiseTaskbarWindow(base, SHELL_UI_DEBUG_WINDOW_ID)
    assertRestackToFront(
      settingsRestored.shell,
      debugFocused.shell,
      SHELL_UI_DEBUG_WINDOW_ID,
      trackedWindowIds,
      'debug focus restack order',
    )

    const redRefocused = await raiseTaskbarWindow(base, redId)
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
