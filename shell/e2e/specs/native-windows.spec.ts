import { fileURLToPath } from 'node:url'

import {
  BTN_LEFT,
  assertTaskbarRowOnMonitor,
  comparePngFixture,
  compositorWindowStack,
  copyArtifactFile,
  GREEN_NATIVE_TITLE,
  NATIVE_APP_ID,
  pickMonitorMove,
  RED_NATIVE_TITLE,
  rectCenter,
  SHELL_UI_DEBUG_WINDOW_ID,
  SHELL_UI_SETTINGS_WINDOW_ID,
  SkipError,
  activateTaskbarWindow,
  autoLayoutManagedWindowsOnOutput,
  assert,
  assertTopWindow,
  assertWindowTiled,
  clickPoint,
  closeWindow,
  compositorWindowById,
  defineGroup,
  dragBetweenPoints,
  ensureNativePair,
  expectedGridAutoLayoutClientRect,
  getPerfCounters,
  getJson,
  getShellHtml,
  getSnapshots,
  movePoint,
  openDebug,
  openSettings,
  outputForWindow,
  pointerButton,
  pointInRect,
  postJson,
  raiseTaskbarWindow,
  resetPerfCounters,
  runKeybind,
  shellWindowStack,
  spawnNativeWindow,
  shellWindowById,
  syncTest,
  taskbarForMonitor,
  taskbarWindowOrderOnMonitor,
  waitFor,
  waitForNativeFocus,
  waitForShellUiFocus,
  waitForWindowRaised,
  waitForWindowGone,
  waitForWindowMinimized,
  assertRectMinSize,
  windowControls,
  writeJsonArtifact,
  type CompositorSnapshot,
  type CompositorWorkspaceRect,
  type ShellSnapshot,
  type WindowSnapshot,
} from '../lib/runtime.ts'

const NATIVE_TITLEBAR_PX = 26
const NATIVE_BORDER_PX = 4

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

function windowCenterOnOutput(
  window: WindowSnapshot,
  output: { x: number; y: number; width: number; height: number },
): boolean {
  const cx = window.x + Math.floor(window.width / 2)
  const cy = window.y + Math.floor(window.height / 2)
  return cx >= output.x && cx < output.x + output.width && cy >= output.y && cy < output.y + output.height
}

function nativeDecorTopRect(
  compositor: CompositorSnapshot,
  windowId: number,
): CompositorWorkspaceRect | null {
  const row = compositor.shell_exclusion_decor?.find((entry) => entry.window_id === windowId)
  if (!row) return null
  return (
    row.rects
      .filter((rect) => rect.height >= NATIVE_TITLEBAR_PX)
      .sort((a, b) => a.y - b.y || b.width - a.width)[0] ?? null
  )
}

function nativeFrameTopLeftFromVisual(visual: {
  x: number
  y: number
}) {
  return {
    x: visual.x - NATIVE_BORDER_PX,
    y: visual.y - NATIVE_TITLEBAR_PX,
  }
}

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

function assertTrackedTaskbarOrder(
  shell: ShellSnapshot,
  monitorName: string,
  trackedWindowIds: number[],
  expectedOrder: number[],
  label: string,
) {
  const tracked = new Set(trackedWindowIds)
  const actual = taskbarWindowOrderOnMonitor(shell, monitorName).filter((windowId) => tracked.has(windowId))
  assert(
    actual.join(',') === expectedOrder.join(','),
    `${label}: expected taskbar order ${expectedOrder.join(', ')}, got ${actual.join(', ')}`,
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
  const rowSet = new Set(row.window_ids)
  const expectedBottomToTop = compositorWindowStack(compositor)
    .filter((windowId) => rowSet.has(windowId))
    .reverse()
  assert(
    row.window_ids.join(',') === expectedBottomToTop.join(','),
    `${label}: expected output order ${expectedBottomToTop.join(', ')}, got ${row.window_ids.join(', ')}`,
  )
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
    2000,
    100,
  )
}

async function waitForSettingsTilingLayoutTriggerReady(base: string) {
  let lastRectKey = ''
  return waitFor(
    'wait for tiling layout trigger ready',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const rect = shell.controls?.settings_tiling_layout_trigger
      if (!rect) return null
      const nextKey = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`
      if (nextKey !== lastRectKey) {
        lastRectKey = nextKey
        return null
      }
      return shell
    },
    5000,
    100,
  )
}

async function switchSettingsPage(base: string) {
  return waitFor(
    'wait for settings tiling page',
    async () => {
      const html = await getShellHtml(base, '[data-settings-root]')
      if (html.includes('data-settings-active-page="tiling"') && html.includes('data-settings-tiling-page')) {
        return html
      }
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const rect = shell.controls?.settings_tab_tiling
      if (rect) {
        await clickPoint(base, rect.global_x + rect.width / 2, rect.global_y + rect.height / 2)
      }
      return null
    },
    5000,
    100,
  )
}

async function selectSettingsTilingLayout(base: string, layout: 'grid' | 'manual-snap') {
  await switchSettingsPage(base)
  const tilingPageReady = await waitForSettingsTilingLayoutTriggerReady(base)
  const optionKey =
    layout === 'grid' ? 'settings_tiling_layout_option_grid' : 'settings_tiling_layout_option_manual_snap'
  if (!tilingPageReady.controls?.[optionKey]) {
    assert(tilingPageReady.controls?.settings_tiling_layout_trigger, 'missing tiling layout trigger')
    const trigger = tilingPageReady.controls.settings_tiling_layout_trigger
    await clickPoint(base, trigger.global_x + trigger.width / 2, trigger.global_y + trigger.height / 2)
  }
  const tilingLayoutOpen = await waitFor(
    `wait for tiling layout menu option ${layout}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return shell.controls?.[optionKey] ? shell : null
    },
    5000,
    100,
  )
  const option = tilingLayoutOpen.controls![optionKey]!
  await clickPoint(base, option.global_x + option.width / 2, option.global_y + option.height / 2)
  await waitFor(
    `wait for tiling layout set to ${layout}`,
    async () => {
      const html = await getShellHtml(base, '[data-settings-tiling-page]')
      return html.includes(layout) ? html : null
    },
    5000,
    100,
  )
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
  await waitForNativeFocus(base, redId, 5000)
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
  await waitForNativeFocus(base, greenId, 5000)
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
    8000,
    100,
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
    const gone = await waitForWindowGone(base, greenId, 2000)
    const refocused = await waitForNativeFocus(base, redId, 2000)
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

  test('maximized native titlebar drag leaves maximized for geometry diagnostics', async ({ base, state }) => {
    const { red } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    await raiseTaskbarWindow(base, redId)
    await waitForNativeFocus(base, redId, 4000)
    await runKeybind(base, 'toggle_maximize')
    await waitFor(
      'wait for red maximized',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window?.maximized ? { window } : null
      },
      5000,
      100,
    )
    const shellMax = await waitFor(
      'wait for red maximized in shell snapshot',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const window = shellWindowById(shell, redId)
        const controls = windowControls(shell, redId)
        if (!window?.maximized || !controls?.titlebar) return null
        return { titlebar: controls.titlebar }
      },
      5000,
      100,
    )
    const start = rectCenter(shellMax.titlebar)
    await dragBetweenPoints(base, start.x, start.y, start.x, start.y + 160, 18)
    const unmaxed = await waitFor(
      'wait for red unmaximized after titlebar drag',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        if (!window || window.maximized || window.fullscreen) return null
        const output = outputForWindow(compositor, window)
        if (!output) return null
        const stillFullBleed =
          window.width >= output.width - 24 && window.height >= output.height - 120
        if (stillFullBleed) return null
        return { window }
      },
      5000,
      100,
    )
    const w = unmaxed.window
    const centerX = w.x + w.width / 2
    assert(
      Math.abs(centerX - start.x) < 220,
      `restored window center x ${centerX} should stay near titlebar grab ${start.x}`,
    )
    await writeJsonArtifact('native-max-titlebar-drag-unmax.json', {
      redId,
      grab: { x: start.x, y: start.y },
      after: { x: w.x, y: w.y, w: w.width, h: w.height, output: w.output_name, centerX },
    })
  })

  test('native decoration exclusion keeps up during active drag', async ({ base, state }) => {
    const stamp = Date.now()
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Native Drag Exclusion ${stamp}`,
      token: `native-drag-exclusion-${stamp}`,
      strip: 'green',
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    const windowId = spawned.window.window_id
    await waitForWindowRaised(base, windowId)
    await waitForNativeFocus(base, windowId, 4000)
    const shellReady = await waitFor(
      'wait for native drag exclusion titlebar',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const controls = windowControls(shell, windowId)
        return controls?.titlebar ? controls.titlebar : null
      },
      5000,
      100,
    )
    const titlebar = assertRectMinSize('native drag exclusion titlebar', shellReady, 80, 16)
    const startX = Math.round(titlebar.global_x + Math.min(140, Math.max(40, titlebar.width * 0.35)))
    const startY = Math.round(titlebar.global_y + titlebar.height / 2)

    await movePoint(base, startX, startY)
    await pointerButton(base, BTN_LEFT, 'press')
    const dx = 240
    const dy = 96
    const steps = 28
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps
      await postJson(base, '/test/input/pointer_move', {
        x: startX + dx * t,
        y: startY + dy * t,
      })
    }

    const duringDrag = await waitFor(
      'wait for native exclusion decor during active drag',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const movedWindow = compositorWindowById(compositor, windowId)
        const decorTop = nativeDecorTopRect(compositor, windowId)
        if (!movedWindow || !decorTop) return null
        const expectedTopX = movedWindow.x - NATIVE_BORDER_PX
        const expectedTopY = movedWindow.y - NATIVE_TITLEBAR_PX
        if (Math.abs(decorTop.x - expectedTopX) > 8) return null
        if (Math.abs(decorTop.y - expectedTopY) > 8) return null
        return { compositor, movedWindow, decorTop }
      },
      1000,
      20,
    )

    await pointerButton(base, BTN_LEFT, 'release')
    await syncTest(base)

    await writeJsonArtifact('native-drag-exclusion-live.json', {
      windowId,
      titlebar: {
        x: titlebar.global_x,
        y: titlebar.global_y,
        width: titlebar.width,
        height: titlebar.height,
      },
      movedWindow: duringDrag.movedWindow,
      decorTop: duringDrag.decorTop,
      compositorDuringDrag: duringDrag.compositor,
    })
  })

  test('native drag preview keeps shell titlebar aligned with captured content', async ({ base, state }) => {
    const stamp = Date.now()
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Native Drag Visual ${stamp}`,
      token: 'native-drag-preview-green',
      strip: 'green',
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    const windowId = spawned.window.window_id
    await waitForWindowRaised(base, windowId)
    await waitForNativeFocus(base, windowId, 4000)
    const shellReady = await waitFor(
      'wait for native drag visual titlebar',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const controls = windowControls(shell, windowId)
        return controls?.titlebar ? controls.titlebar : null
      },
      5000,
      100,
    )
    const titlebar = assertRectMinSize('native drag visual titlebar', shellReady, 80, 16)
    const startX = Math.round(titlebar.global_x + Math.min(140, Math.max(40, titlebar.width * 0.35)))
    const startY = Math.round(titlebar.global_y + titlebar.height / 2)

    await movePoint(base, startX, startY)
    await pointerButton(base, BTN_LEFT, 'press')
    const dx = -220
    const dy = -84
    const steps = 30
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps
      await postJson(base, '/test/input/pointer_move', {
        x: startX + dx * t,
        y: startY + dy * t,
      })
    }

    const duringDrag = await waitFor(
      'wait for native drag preview to track compositor move visual',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        if (compositor.shell_move_window_id !== windowId || !compositor.shell_move_visual) return null
        if (compositor.shell_move_proxy_window_id != null) return null
        if (compositor.shell_native_drag_preview_window_id !== windowId) return null
        if (compositor.shell_native_drag_preview_shell_ready !== true) return null
        if (!compositor.shell_native_drag_preview_image_path) return null
        if (!compositor.shell_native_drag_preview_clip_rect) return null
        const controls = windowControls(shell, windowId)
        if (
          !controls?.dragging ||
          !controls.titlebar ||
          !controls.native_drag_preview_rect ||
          controls.native_drag_preview_loaded !== true ||
          controls.native_drag_preview_source_width == null ||
          controls.native_drag_preview_source_height == null ||
          controls.native_drag_preview_backing_width == null ||
          controls.native_drag_preview_backing_height == null
        ) {
          return null
        }
        if (Math.abs(controls.native_drag_preview_source_width - controls.native_drag_preview_backing_width) > 1) {
          return null
        }
        if (Math.abs(controls.native_drag_preview_source_height - controls.native_drag_preview_backing_height) > 1) {
          return null
        }
        const expected = nativeFrameTopLeftFromVisual(compositor.shell_move_visual)
        const previewRect = controls.native_drag_preview_rect
        const clipRect = compositor.shell_native_drag_preview_clip_rect
        if (Math.abs(controls.titlebar.global_x - expected.x) > 8) return null
        if (Math.abs(controls.titlebar.global_y - expected.y) > 8) return null
        if (Math.abs(previewRect.global_x - compositor.shell_move_visual.x) > 8) return null
        if (Math.abs(previewRect.global_y - compositor.shell_move_visual.y) > 8) return null
        if (Math.abs(previewRect.width - compositor.shell_move_visual.width) > 8) return null
        if (Math.abs(previewRect.height - compositor.shell_move_visual.height) > 8) return null
        const expectedClip = {
          x: expected.x,
          y: expected.y,
          width: compositor.shell_move_visual.width + 2 * NATIVE_BORDER_PX,
          height: compositor.shell_move_visual.height + NATIVE_TITLEBAR_PX + NATIVE_BORDER_PX,
        }
        if (Math.abs(clipRect.x - expectedClip.x) > 8) return null
        if (Math.abs(clipRect.y - expectedClip.y) > 8) return null
        if (Math.abs(clipRect.width - expectedClip.width) > 8) return null
        if (Math.abs(clipRect.height - expectedClip.height) > 8) return null
        return {
          compositor,
          shell,
          controls,
          expected,
          previewRect,
          clipRect,
        }
      },
      1000,
      20,
    )
    const previewFixture = fileURLToPath(
      new URL('../fixtures/visual/native-drag-preview-green.png', import.meta.url),
    )
    const previewActualArtifact = await copyArtifactFile(
      'native-drag-preview-green-actual.png',
      String(duringDrag.compositor.shell_native_drag_preview_image_path),
    )
    const previewVisual = await comparePngFixture(
      String(duringDrag.compositor.shell_native_drag_preview_image_path),
      previewFixture,
      {
        maxDifferentPixels: 240,
        maxChannelDelta: 3,
      },
    )
    const dragScreenshot = await postJson<{ path?: string }>(base, '/test/screenshot', {
      x: Math.max(0, duringDrag.expected.x - 24),
      y: Math.max(0, duringDrag.expected.y - 24),
      width: duringDrag.clipRect.width + 48,
      height: duringDrag.clipRect.height + 48,
    })
    assert(dragScreenshot.path, 'native drag visual screenshot path missing')

    await pointerButton(base, BTN_LEFT, 'release')
    const afterRelease = await waitFor(
      'wait for native drag preview handoff back to live titlebar',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        if (
          compositor.shell_move_window_id !== null ||
          compositor.shell_move_proxy_window_id != null ||
          compositor.shell_native_drag_preview_window_id != null
        ) {
          return null
        }
        const controls = windowControls(shell, windowId)
        const titlebar = controls?.titlebar
        const movedWindow = compositorWindowById(compositor, windowId)
        if (!titlebar || !movedWindow) return null
        const expected = nativeFrameTopLeftFromVisual(movedWindow)
        if (Math.abs(titlebar.global_x - expected.x) > 8) return null
        if (Math.abs(titlebar.global_y - expected.y) > 8) return null
        return {
          compositor,
          shell,
          controls,
          titlebar,
          expected,
        }
      },
      1000,
      20,
    )
    const firstPreviewGeneration = duringDrag.controls.native_drag_preview_generation
    assert(firstPreviewGeneration != null, 'native drag preview generation missing during first drag')

    const secondStartX = Math.round(
      afterRelease.titlebar.global_x + Math.min(140, Math.max(40, afterRelease.titlebar.width * 0.35)),
    )
    const secondStartY = Math.round(afterRelease.titlebar.global_y + afterRelease.titlebar.height / 2)
    await movePoint(base, secondStartX, secondStartY)
    await pointerButton(base, BTN_LEFT, 'press')
    await postJson(base, '/test/input/pointer_move', {
      x: secondStartX + 28,
      y: secondStartY + 16,
    })
    const secondDragStart = await waitFor(
      'wait for second native drag start without stale preview reuse',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        if (compositor.shell_move_window_id !== windowId || !compositor.shell_move_visual) return null
        const controls = windowControls(shell, windowId)
        return {
          compositor,
          shell,
          controls,
          previewGeneration: controls?.native_drag_preview_generation ?? null,
        }
      },
      400,
      10,
    )
    assert(
      secondDragStart.previewGeneration !== firstPreviewGeneration,
      `second drag reused stale native preview generation ${String(firstPreviewGeneration)}`,
    )

    await pointerButton(base, BTN_LEFT, 'release')
    const afterSecondRelease = await waitFor(
      'wait for second native drag preview handoff back to live titlebar',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        if (
          compositor.shell_move_window_id !== null ||
          compositor.shell_move_proxy_window_id != null ||
          compositor.shell_native_drag_preview_window_id != null
        ) {
          return null
        }
        const controls = windowControls(shell, windowId)
        const titlebar = controls?.titlebar
        const movedWindow = compositorWindowById(compositor, windowId)
        if (!titlebar || !movedWindow) return null
        const expected = nativeFrameTopLeftFromVisual(movedWindow)
        if (Math.abs(titlebar.global_x - expected.x) > 8) return null
        if (Math.abs(titlebar.global_y - expected.y) > 8) return null
        return {
          compositor,
          shell,
          controls,
          titlebar,
          expected,
        }
      },
      1000,
      20,
    )
    await syncTest(base)

    await writeJsonArtifact('native-drag-titlebar-live.json', {
      windowId,
      previewRect: duringDrag.previewRect,
      clipRect: duringDrag.clipRect,
      expected: duringDrag.expected,
      previewImagePath: duringDrag.compositor.shell_native_drag_preview_image_path,
      previewReady: duringDrag.compositor.shell_native_drag_preview_shell_ready,
      previewLoaded: duringDrag.controls.native_drag_preview_loaded,
      previewSourceWidth: duringDrag.controls.native_drag_preview_source_width,
      previewSourceHeight: duringDrag.controls.native_drag_preview_source_height,
      previewBackingWidth: duringDrag.controls.native_drag_preview_backing_width,
      previewBackingHeight: duringDrag.controls.native_drag_preview_backing_height,
      previewActualArtifact,
      previewVisual,
      dragScreenshot,
      dragScreenshotArtifact: await copyArtifactFile('native-drag-proxy-full-actual.png', dragScreenshot.path),
      firstPreviewGeneration,
      secondDragPreviewGeneration: secondDragStart.previewGeneration,
      compositorDuringDrag: duringDrag.compositor,
      shellDuringDrag: duringDrag.shell,
      compositorAfterRelease: afterRelease.compositor,
      shellAfterRelease: afterRelease.shell,
      titlebarAfterRelease: afterRelease.titlebar,
      compositorSecondDragStart: secondDragStart.compositor,
      shellSecondDragStart: secondDragStart.shell,
      compositorAfterSecondRelease: afterSecondRelease.compositor,
      shellAfterSecondRelease: afterSecondRelease.shell,
      titlebarAfterSecondRelease: afterSecondRelease.titlebar,
    })
  })

  test('native drag preview keeps clipped left edge unstretched', async ({ base, state }) => {
    const stamp = Date.now()
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Native Drag Clipped ${stamp}`,
      token: 'native-drag-preview-green',
      strip: 'green',
      width: 2200,
      height: 240,
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    const windowId = spawned.window.window_id
    await waitForWindowRaised(base, windowId)
    await waitForNativeFocus(base, windowId, 4000)
    const initial = await waitFor(
      'wait for clipped native drag start geometry',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const controls = windowControls(shell, windowId)
        const titlebar = controls?.titlebar
        const window = compositorWindowById(compositor, windowId)
        if (!titlebar || !window) return null
        const output = outputForWindow(compositor, window)
        if (!output) return null
        const clipped =
          window.x < output.x ||
          window.y < output.y ||
          window.x + window.width > output.x + output.width ||
          window.y + window.height > output.y + output.height
        if (!clipped) return null
        return { compositor, shell, controls, titlebar, window, output }
      },
      5000,
      100,
    )
    const titlebar = assertRectMinSize('clipped native drag titlebar', initial.titlebar, 80, 16)
    const visibleLeft = Math.max(titlebar.global_x, initial.output.x)
    const visibleRight = Math.min(titlebar.global_x + titlebar.width, initial.output.x + initial.output.width)
    const dragStartX = Math.round(
      Math.max(visibleLeft + 40, Math.min(visibleRight - 40, visibleLeft + (visibleRight - visibleLeft) / 2)),
    )
    const dragStartY = Math.round(titlebar.global_y + titlebar.height / 2)
    await movePoint(base, dragStartX, dragStartY)
    await pointerButton(base, BTN_LEFT, 'press')
    const dx = 96
    const dy = 36
    const dragSteps = 24
    for (let index = 1; index <= dragSteps; index += 1) {
      const t = index / dragSteps
      await postJson(base, '/test/input/pointer_move', {
        x: dragStartX + dx * t,
        y: dragStartY + dy * t,
      })
    }

    const duringDrag = await waitFor(
      'wait for clipped native drag preview to load',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        if (compositor.shell_move_window_id !== windowId || !compositor.shell_move_visual) return null
        if (compositor.shell_native_drag_preview_window_id !== windowId) return null
        if (compositor.shell_native_drag_preview_shell_ready !== true) return null
        if (!compositor.shell_native_drag_preview_image_path) return null
        const controls = windowControls(shell, windowId)
        if (
          !controls?.dragging ||
          !controls.titlebar ||
          !controls.native_drag_preview_rect ||
          controls.native_drag_preview_loaded !== true ||
          controls.native_drag_preview_source_width == null ||
          controls.native_drag_preview_source_height == null ||
          controls.native_drag_preview_backing_width == null ||
          controls.native_drag_preview_backing_height == null
        ) {
          return null
        }
        if (Math.abs(controls.native_drag_preview_source_width - controls.native_drag_preview_backing_width) > 1) {
          return null
        }
        if (Math.abs(controls.native_drag_preview_source_height - controls.native_drag_preview_backing_height) > 1) {
          return null
        }
        return { compositor, shell, controls }
      },
      1000,
      20,
    )
    const previewFixture = fileURLToPath(
      new URL('../fixtures/visual/native-drag-preview-green-left-clipped.png', import.meta.url),
    )
    const previewActualArtifact = await copyArtifactFile(
      'native-drag-preview-green-left-clipped-actual.png',
      String(duringDrag.compositor.shell_native_drag_preview_image_path),
    )
    const previewVisual = await comparePngFixture(
      String(duringDrag.compositor.shell_native_drag_preview_image_path),
      previewFixture,
      {
        maxDifferentPixels: 240,
        maxChannelDelta: 3,
      },
    )

    await pointerButton(base, BTN_LEFT, 'release')
    await syncTest(base)

    await writeJsonArtifact('native-drag-preview-left-clipped.json', {
      windowId,
      initialTitlebar: initial.titlebar,
      initialWindow: initial.window,
      initialOutput: initial.output,
      previewRect: duringDrag.controls.native_drag_preview_rect,
      previewLoaded: duringDrag.controls.native_drag_preview_loaded,
      previewSourceWidth: duringDrag.controls.native_drag_preview_source_width,
      previewSourceHeight: duringDrag.controls.native_drag_preview_source_height,
      previewBackingWidth: duringDrag.controls.native_drag_preview_backing_width,
      previewBackingHeight: duringDrag.controls.native_drag_preview_backing_height,
      previewImagePath: duringDrag.compositor.shell_native_drag_preview_image_path,
      previewActualArtifact,
      previewVisual,
      compositorDuringDrag: duringDrag.compositor,
      shellDuringDrag: duringDrag.shell,
    })
  })

  test('multi-monitor super fullscreen maximize and tile hotkeys track window output', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    await closeWindow(base, green.window.window_id)
    await waitForWindowGone(base, green.window.window_id)
    state.spawnedNativeWindowIds.delete(green.window.window_id)
    state.knownWindowIds.delete(green.window.window_id)
    state.nativeLaunchByWindowId.delete(green.window.window_id)
    const redId = red.window.window_id
    const compositor0 = (await getSnapshots(base)).compositor
    if (compositor0.outputs.length < 2) {
      throw new SkipError('requires at least two outputs')
    }
    const nativeInitial = await waitFor(
      'wait for native multimonitor output assignment',
      async () => {
        const { compositor: nextCompositor, shell: nextShell } = await getSnapshots(base)
        const redShell = shellWindowById(nextShell, redId)
        const redCompositor = compositorWindowById(nextCompositor, redId)
        if (!redShell || !redCompositor) return null
        const outputName = resolveWindowOutputName(nextCompositor, redCompositor)
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
    await runKeybind(base, nativeMove.action, redId)
    const moved = await waitFor(
      'wait for native monitor move',
      async () => {
        const { compositor: nextCompositor, shell: nextShell } = await getSnapshots(base)
        const compWindow = compositorWindowById(nextCompositor, redId)
        const shellWindow = shellWindowById(nextShell, redId)
        if (!compWindow || !shellWindow) return null
        const output = nextCompositor.outputs.find((entry) => entry.name === nativeMove.target.name)
        if (!output) return null
        if (!windowCenterOnOutput(compWindow, output)) return null
        return { compositor: nextCompositor, shell: nextShell, compWindow, output }
      },
      5000,
      50,
    )
    await runKeybind(base, 'toggle_fullscreen', redId)
    const fullscreenOn = await waitFor(
      'wait for fullscreen on secondary output',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        const output = compositor.outputs.find((entry) => entry.name === nativeMove.target.name)
        if (!window?.fullscreen || !output) return null
        if (!windowCenterOnOutput(window, output)) return null
        return { compositor, window, output }
      },
      5000,
      100,
    )
    await runKeybind(base, 'toggle_fullscreen', redId)
    await waitFor(
      'wait for fullscreen off after multimonitor',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window && !window.fullscreen ? { compositor, window } : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'toggle_maximize', redId)
    const maximizedOnTarget = await waitFor(
      'wait for maximize on moved monitor',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        if (!window?.maximized) return null
        const output = compositor.outputs.find((entry) => entry.name === nativeMove.target.name)
        if (!output || !windowCenterOnOutput(window, output)) return null
        return { compositor, window }
      },
      5000,
      100,
    )
    await raiseTaskbarWindow(base, redId)
    await waitForWindowRaised(base, redId, 5000)
    await runKeybind(base, 'toggle_maximize', redId)
    await waitFor(
      'wait for unmaximize on moved monitor',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window && !window.maximized ? { compositor, window } : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'tile_up', redId)
    const tileUpMax = await waitFor(
      'wait for tile up on moved monitor',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        if (!window?.maximized) return null
        const output = compositor.outputs.find((entry) => entry.name === nativeMove.target.name)
        if (!output || !windowCenterOnOutput(window, output)) return null
        return { compositor, window }
      },
      5000,
      100,
    )
    await runKeybind(base, 'tile_down', redId)
    const tileDown = await waitFor(
      'wait for tile down restore on moved monitor',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window && !window.maximized && !window.fullscreen ? { compositor, window } : null
      },
      5000,
      100,
    )
    state.multiMonitorNativeMove = {
      window_id: redId,
      target_output: nativeMove.target.name,
    }
    await writeJsonArtifact('native-multimonitor-super-hotkeys.json', {
      moved,
      fullscreenOn,
      maximizedOnTarget,
      tileUpMax,
      tileDown,
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

  test('native and shell focus changes keep taskbar order stable', async ({ base, state }) => {
    const { red } = await ensureNativePair(base, state)
    const redId = red.window.window_id

    await openSettings(base, 'click')
    const initial = await getSnapshots(base)
    const nativeWindow = shellWindowById(initial.shell, redId)
    const settingsWindow = shellWindowById(initial.shell, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(nativeWindow, 'missing native shell snapshot for taskbar order test')
    assert(settingsWindow, 'missing settings shell snapshot for taskbar order test')
    const monitorName = nativeWindow.output_name
    assert(
      monitorName === settingsWindow.output_name,
      `expected native and settings windows on same monitor, got ${monitorName} and ${settingsWindow.output_name}`,
    )
    const trackedWindowIds = [redId, SHELL_UI_SETTINGS_WINDOW_ID]
    const initialOrder = taskbarWindowOrderOnMonitor(initial.shell, monitorName).filter((windowId) =>
      trackedWindowIds.includes(windowId),
    )
    assert(
      initialOrder.length === trackedWindowIds.length,
      `expected ${trackedWindowIds.length} tracked taskbar windows, got ${initialOrder.join(', ')}`,
    )

    const redFocused = await raiseTaskbarWindow(base, redId)
    assertTrackedTaskbarOrder(redFocused.shell, monitorName, trackedWindowIds, initialOrder, 'native focus taskbar order')

    const settingsFocused = await raiseTaskbarWindow(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertTrackedTaskbarOrder(
      settingsFocused.shell,
      monitorName,
      trackedWindowIds,
      initialOrder,
      'shell focus taskbar order',
    )

    await writeJsonArtifact('native-shell-taskbar-order-initial.json', initial.shell)
    await writeJsonArtifact('native-shell-taskbar-order-native-focused.json', redFocused.shell)
    await writeJsonArtifact('native-shell-taskbar-order-shell-focused.json', settingsFocused.shell)
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

  test('native windows open directly into compositor auto layout geometry', async ({ base, state }) => {
    await openSettings(base, 'click')
    try {
      await selectSettingsTilingLayout(base, 'grid')
      await closeWindow(base, SHELL_UI_SETTINGS_WINDOW_ID)
      await waitForWindowGone(base, SHELL_UI_SETTINGS_WINDOW_ID)
      await resetPerfCounters(base)
      const beforeOpen = await getSnapshots(base)

      const opened = await spawnNativeWindow(base, state.knownWindowIds, {
        title: 'Derp Native Grid Open',
        token: 'native-grid-open',
        strip: '#2573c2',
        width: 480,
        height: 320,
      })
      state.spawnedNativeWindowIds.add(opened.window.window_id)
      const windowId = opened.window.window_id
      const settled = await waitFor(
        'wait for grid-opened native window geometry',
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          const window = compositorWindowById(compositor, windowId)
          const output = compositor.outputs.find((entry) => entry.name === window?.output_name) ?? null
          const taskbar = window ? taskbarForMonitor(shell, window.output_name) : null
          if (!window || !output || !taskbar?.rect) return null
          const expected = expectedGridAutoLayoutClientRect(
            output,
            taskbar.rect,
            autoLayoutManagedWindowsOnOutput(beforeOpen.compositor, output.name),
            windowId,
          )
          if (Math.abs(window.x - expected.x) > 24) return null
          if (Math.abs(window.y - expected.y) > 24) return null
          if (Math.abs(window.width - expected.width) > 24) return null
          if (Math.abs(window.height - expected.height) > 24) return null
          return { compositor, shell, window, expected }
        },
        2000,
        40,
      )
      const perf = await getPerfCounters(base)
      assert(perf.shell_updates.window_mapped_messages >= 1, 'native open should emit a mapped message')
      const followup = await getSnapshots(base)
      const followupWindow = compositorWindowById(followup.compositor, windowId)
      assert(followupWindow, 'missing follow-up native compositor window')
      assert(
        followupWindow.x === settled.window.x &&
          followupWindow.y === settled.window.y &&
          followupWindow.width === settled.window.width &&
          followupWindow.height === settled.window.height,
        'native auto-layout open geometry should stay stable after mapping',
      )
      await writeJsonArtifact('native-grid-open.json', {
        windowId,
        perf,
        existingWindowIds: autoLayoutManagedWindowsOnOutput(
          beforeOpen.compositor,
          settled.window.output_name,
        ).map((window) => window.window_id),
        expected: settled.expected,
        initial: {
          x: opened.window.x,
          y: opened.window.y,
          width: opened.window.width,
          height: opened.window.height,
          output: opened.window.output_name,
        },
        actual: {
          x: settled.window.x,
          y: settled.window.y,
          width: settled.window.width,
          height: settled.window.height,
          output: settled.window.output_name,
        },
        followup: {
          x: followupWindow.x,
          y: followupWindow.y,
          width: followupWindow.width,
          height: followupWindow.height,
          output: followupWindow.output_name,
        },
      })
    } finally {
      try {
        await openSettings(base, 'click')
        await selectSettingsTilingLayout(base, 'manual-snap')
      } finally {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        if (shellWindowById(shell, SHELL_UI_SETTINGS_WINDOW_ID)) {
          await closeWindow(base, SHELL_UI_SETTINGS_WINDOW_ID)
          await waitForWindowGone(base, SHELL_UI_SETTINGS_WINDOW_ID)
        }
      }
    }
  })
})
