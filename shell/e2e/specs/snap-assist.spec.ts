import {
  BTN_RIGHT,
  SHELL_UI_SETTINGS_WINDOW_ID,
  activateTaskbarWindow,
  assert,
  assertRectMinSize,
  assertTaskbarRowOnMonitor,
  assertTopWindow,
  clickPoint,
  compositorWindowById,
  createTimingMarks,
  defineGroup,
  ensureNativePair,
  getJson,
  getSnapshots,
  movePoint,
  openSettings,
  pickMonitorMove,
  pointerButton,
  runKeybind,
  taskbarForMonitor,
  waitFor,
  waitForNativeFocus,
  waitForShellUiFocus,
  windowControls,
  writeJsonArtifact,
  type CompositorSnapshot,
  type ShellSnapshot,
  type WindowSnapshot,
} from '../lib/runtime.ts'

const TITLEBAR_PX = 28

function resolveWindowOutputName(compositor: CompositorSnapshot, window: WindowSnapshot): string | null {
  if (window.output_name) return window.output_name
  const centerX = window.x + window.width / 2
  const centerY = window.y + window.height / 2
  const output = compositor.outputs.find(
    (entry) =>
      centerX >= entry.x &&
      centerX < entry.x + entry.width &&
      centerY >= entry.y &&
      centerY < entry.y + entry.height,
  )
  return output?.name ?? null
}

function assertTopThirdWindow(
  window: WindowSnapshot,
  outputName: string,
  compositor: CompositorSnapshot,
  shell: ShellSnapshot,
  column: 'left' | 'center' | 'right',
) {
  const output = compositor.outputs.find((entry) => entry.name === outputName) ?? null
  const taskbar = taskbarForMonitor(shell, outputName)
  assert(output, `missing output ${outputName}`)
  assert(taskbar?.rect, `missing taskbar for ${outputName}`)
  const workBottom = taskbar.rect.global_y
  const thirdWidth = Math.floor(output.width / 3)
  const expectedX =
    column === 'left' ? output.x : column === 'center' ? output.x + thirdWidth : output.x + thirdWidth * 2
  const expectedHeight = Math.floor((workBottom - (output.y + TITLEBAR_PX)) / 2)
  assert(Math.abs(window.x - expectedX) <= 28, `expected ${column} third x near ${expectedX}, got ${window.x}`)
  assert(Math.abs(window.width - thirdWidth) <= 36, `expected ${column} third width near ${thirdWidth}, got ${window.width}`)
  assert(window.y >= output.y && window.y <= output.y + 80, `expected top-row y near ${output.y}, got ${window.y}`)
  assert(Math.abs(window.height - expectedHeight) <= 36, `expected top-row height near ${expectedHeight}, got ${window.height}`)
}

function assertTopTwoThirdsThirdWindow(
  window: WindowSnapshot,
  outputName: string,
  compositor: CompositorSnapshot,
  shell: ShellSnapshot,
  column: 'left' | 'center' | 'right',
) {
  const output = compositor.outputs.find((entry) => entry.name === outputName) ?? null
  const taskbar = taskbarForMonitor(shell, outputName)
  assert(output, `missing output ${outputName}`)
  assert(taskbar?.rect, `missing taskbar for ${outputName}`)
  const workTop = output.y + TITLEBAR_PX
  const workHeight = taskbar.rect.global_y - workTop
  const thirdWidth = Math.floor(output.width / 3)
  const twoThirdHeight = Math.round((workHeight * 2) / 3)
  const expectedX =
    column === 'left' ? output.x : column === 'center' ? output.x + thirdWidth : output.x + thirdWidth * 2
  assert(Math.abs(window.x - expectedX) <= 28, `expected ${column} third x near ${expectedX}, got ${window.x}`)
  assert(Math.abs(window.width - thirdWidth) <= 36, `expected ${column} third width near ${thirdWidth}, got ${window.width}`)
  assert(window.y >= output.y && window.y <= output.y + 80, `expected top-row y near ${output.y}, got ${window.y}`)
  assert(
    Math.abs(window.height - twoThirdHeight) <= 40,
    `expected top two-thirds height near ${twoThirdHeight}, got ${window.height}`,
  )
}

async function waitForPickerOpen(base: string, windowId: number): Promise<ShellSnapshot> {
  return waitFor(
    `wait for picker open ${windowId}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return shell.snap_picker_open &&
        shell.snap_picker_window_id === windowId &&
        shell.controls?.snap_picker_root
        ? shell
        : null
    },
    5000,
    100,
  )
}

async function waitForSnapStripTrigger(base: string) {
  const shell = await waitFor(
    'wait for snap strip trigger',
    async () => {
      const current = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return current.controls?.snap_strip_trigger ? current : null
    },
    4000,
    100,
  )
  return assertRectMinSize('snap strip trigger', shell.controls?.snap_strip_trigger, 12)
}

async function openPickerWhileDragging(base: string, windowId: number): Promise<ShellSnapshot> {
  const stripCenter = rectGlobalCenter(await waitForSnapStripTrigger(base))
  await movePoint(base, stripCenter.x, stripCenter.y)
  return waitForPickerOpen(base, windowId)
}

async function waitForPickerClosed(base: string, windowId: number): Promise<ShellSnapshot> {
  return waitFor(
    `wait for picker closed ${windowId}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return !shell.snap_picker_open && shell.snap_picker_window_id !== windowId ? shell : null
    },
    4000,
    100,
  )
}

async function hoverPickerCellWhileDragging(
  base: string,
  label: string,
  rect: { global_x: number; global_y: number; width: number; height: number },
): Promise<ShellSnapshot> {
  const center = rectGlobalCenter(rect)
  await movePoint(base, center.x, center.y)
  return waitFor(
    label,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return shell.snap_hover_span ? shell : null
    },
    4000,
    100,
  )
}

function rectGlobalCenter(rect: { global_x: number; global_y: number; width: number; height: number }) {
  return {
    x: rect.global_x + rect.width / 2,
    y: rect.global_y + rect.height / 2,
  }
}

function assertRectCenteredOnOutput(
  rect: { global_x: number; width: number },
  output: { x: number; width: number; name: string },
  tolerance = 24,
) {
  const rectCenter = rect.global_x + rect.width / 2
  const outputCenter = output.x + output.width / 2
  assert(
    Math.abs(rectCenter - outputCenter) <= tolerance,
    `expected picker center near ${output.name} center ${outputCenter}, got ${rectCenter}`,
  )
}

async function openPickerFromMaximizeButton(base: string, windowId: number): Promise<ShellSnapshot> {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const controls = windowControls(shell, windowId)
  const maximize = assertRectMinSize('maximize button', controls?.maximize, 12)
  const center = rectGlobalCenter(maximize)
  await movePoint(base, center.x, center.y)
  await pointerButton(base, BTN_RIGHT, 'press')
  await pointerButton(base, BTN_RIGHT, 'release')
  return waitForPickerOpen(base, windowId)
}

async function focusNativeWindow(base: string, windowId: number): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot }> {
  const { compositor, shell } = await getSnapshots(base)
  if (compositor.focused_window_id === windowId) {
    try {
      assertTopWindow(shell, windowId, `native focus ${windowId}`)
      return { compositor, shell }
    } catch {}
  }
  const window = compositorWindowById(compositor, windowId)
  assert(window, `missing compositor window ${windowId}`)
  try {
    await activateTaskbarWindow(base, shell, windowId)
    return await waitForNativeFocus(base, windowId, 2000)
  } catch {
    await clickPoint(base, window.x + window.width / 2, window.y + window.height / 2)
    try {
      return await waitForNativeFocus(base, windowId, 2000)
    } catch {
      const nextShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      await activateTaskbarWindow(base, nextShell, windowId)
      return waitForNativeFocus(base, windowId, 2000)
    }
  }
}

async function focusSettingsWindow(base: string) {
  const { compositor, shell } = await getSnapshots(base)
  if (compositor.focused_shell_ui_window_id === SHELL_UI_SETTINGS_WINDOW_ID) {
    try {
      assertTopWindow(shell, SHELL_UI_SETTINGS_WINDOW_ID, `shell focus ${SHELL_UI_SETTINGS_WINDOW_ID}`)
      return { compositor, shell }
    } catch {}
  }
  const nextShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  await activateTaskbarWindow(base, nextShell, SHELL_UI_SETTINGS_WINDOW_ID)
  return waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('dragging a native titlebar into the strip opens the picker and snaps on release', async ({ base, state }) => {
    const { red } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const focused = await focusNativeWindow(base, redId)
    const focusedWindow = compositorWindowById(focused.compositor, redId)
    const output = focused.compositor.outputs.find((entry) => entry.name === focusedWindow?.output_name) ?? null
    const dragShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const controls = windowControls(dragShell, redId)
    assert(controls?.titlebar, 'missing red titlebar rect')
    const titlebarCenter = rectGlobalCenter(controls.titlebar)
    await movePoint(base, titlebarCenter.x, titlebarCenter.y)
    await pointerButton(base, 0x110, 'press')
    try {
      const pickerOpen = await openPickerWhileDragging(base, redId)
      assert(pickerOpen.snap_picker_source === 'strip', 'expected strip drag to open the picker')
      assert(output, 'missing focused output')
      assertRectCenteredOnOutput(assertRectMinSize('picker root', pickerOpen.controls?.snap_picker_root, 48), output)
      const topCenter = assertRectMinSize('picker top-center cell', pickerOpen.controls?.snap_picker_top_center_cell, 12)
      const hover = await hoverPickerCellWhileDragging(base, 'hover picker top-center cell', topCenter)
      assert(hover.snap_hover_span?.gc0 === 1, 'expected strip drag hover to reach center column')
      await pointerButton(base, 0x110, 'release')
      const snapped = await waitFor(
        'wait for strip picker snap',
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          const window = compositorWindowById(compositor, redId)
          if (!window || window.output_name !== state.tiledOutput && !taskbarForMonitor(shell, window.output_name)?.rect) return null
          try {
            assertTopThirdWindow(window, window.output_name, compositor, shell, 'center')
          } catch {
            return null
          }
          return { compositor, shell, window }
        },
        2000,
        125,
      )
      await writeJsonArtifact('snap-assist-drag-native.json', snapped)
    } finally {
      await pointerButton(base, 0x110, 'release')
    }
  })

  test('drag picker commits a native window layout', async ({ base, state }) => {
    const timing = createTimingMarks('snap native picker')
    const { red } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    await timing.step('focus native window', () => focusNativeWindow(base, redId))
    const shellFocused = await timing.step('read shell snapshot', () => getJson<ShellSnapshot>(base, '/test/state/shell'))
    const controls = windowControls(shellFocused, redId)
    assert(controls?.titlebar, 'missing red titlebar rect')
    const titlebarCenter = rectGlobalCenter(controls.titlebar)
    await movePoint(base, titlebarCenter.x, titlebarCenter.y)
    await pointerButton(base, 0x110, 'press')
    try {
      const pickerOpen = await timing.step('open drag picker', () => openPickerWhileDragging(base, redId))
      const firstCell = assertRectMinSize('picker first cell', pickerOpen.controls?.snap_picker_first_cell, 12)
      await timing.step('hover first cell', () => hoverPickerCellWhileDragging(base, 'hover picker first cell', firstCell))
      await timing.step('release drag on first cell', () => pointerButton(base, 0x110, 'release'))
      const snapped = await timing.step('wait for native picker snap', () =>
        waitFor(
          'wait for native picker snap',
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const window = compositorWindowById(compositor, redId)
            if (!window) return null
            try {
              assertTopThirdWindow(window, window.output_name, compositor, shell, 'left')
            } catch {
              return null
            }
            return { compositor, shell, window }
          },
          2000,
          125,
        ),
      )
      await writeJsonArtifact('snap-assist-picker-native.json', snapped)
    } finally {
      await pointerButton(base, 0x110, 'release')
    }
  })

  test('drag picker closes when pointer leaves the strip and picker', async ({ base, state }) => {
    const { red } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const focused = await focusNativeWindow(base, redId)
    const controls = windowControls(focused.shell, redId)
    assert(controls?.titlebar, 'missing red titlebar rect')
    const titlebarCenter = rectGlobalCenter(controls.titlebar)
    await movePoint(base, titlebarCenter.x, titlebarCenter.y)
    await pointerButton(base, 0x110, 'press')
    try {
      const pickerOpen = await openPickerWhileDragging(base, redId)
      assert(pickerOpen.snap_picker_open, 'expected drag picker to open')
      const window = compositorWindowById(focused.compositor, redId)
      assert(window, 'missing focused native window')
      const output = focused.compositor.outputs.find((entry) => entry.name === window.output_name) ?? null
      assert(output, `missing output ${window.output_name}`)
      await movePoint(base, output.x + output.width / 2, output.y + output.height - 120)
      const closed = await waitForPickerClosed(base, redId)
      assert(!closed.snap_hover_span, 'expected picker hover to clear after leaving picker')
    } finally {
      await pointerButton(base, 0x110, 'release')
    }
  })

  test('maximize button picker snaps the settings window and keeps shell focus parity', async ({ base }) => {
    await openSettings(base, 'click')
    await focusSettingsWindow(base)
    const pickerOpen = await openPickerFromMaximizeButton(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(pickerOpen.snap_picker_source === 'button', 'expected maximize button to open picker')
    const firstCell = assertRectMinSize('settings picker first cell', pickerOpen.controls?.snap_picker_first_cell, 12)
    const firstCellCenter = rectGlobalCenter(firstCell)
    await clickPoint(base, firstCellCenter.x, firstCellCenter.y)
    const snapped = await waitFor(
      'wait for settings picker snap',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const window = compositorWindowById(compositor, SHELL_UI_SETTINGS_WINDOW_ID)
        if (!window) return null
        try {
          assertTopThirdWindow(window, window.output_name, compositor, shell, 'left')
          assertTaskbarRowOnMonitor(shell, SHELL_UI_SETTINGS_WINDOW_ID, window.output_name)
          assertTopWindow(shell, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should stay frontmost after picker snap')
        } catch {
          return null
        }
        return { compositor, shell, window }
      },
      2000,
      125,
    )
    await writeJsonArtifact('snap-assist-picker-settings.json', snapped)
  })

  test('maximize button right click opens picker and 3x3 top two-thirds keeps partial height', async ({ base }) => {
    await openSettings(base, 'click')
    await focusSettingsWindow(base)
    const pickerOpen = await openPickerFromMaximizeButton(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(pickerOpen.snap_picker_source === 'button', 'expected maximize button to open picker')
    const topTwoThirds = assertRectMinSize(
      '3x3 top two-thirds left cell',
      pickerOpen.controls?.snap_picker_top_two_thirds_left,
      12,
    )
    const topTwoThirdsCenter = rectGlobalCenter(topTwoThirds)
    await clickPoint(base, topTwoThirdsCenter.x, topTwoThirdsCenter.y)
    const snapped = await waitFor(
      'wait for settings top two-thirds third snap',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const window = compositorWindowById(compositor, SHELL_UI_SETTINGS_WINDOW_ID)
        if (!window) return null
        try {
          assertTopTwoThirdsThirdWindow(window, window.output_name, compositor, shell, 'left')
        } catch {
          return null
        }
        return { compositor, shell, window }
      },
      2000,
      125,
    )
    await writeJsonArtifact('snap-assist-picker-settings-top-two-thirds.json', snapped)
  })

  test('picker stays monitor-local for native and shell windows on multi-monitor setups', async ({ base, state }) => {
    const { green } = await ensureNativePair(base, state)
    const redId = green.window.window_id
    const initial = await getSnapshots(base)
    if (initial.compositor.outputs.length < 2) {
      return
    }
    const nativeInitial = await waitFor(
      'wait for native output assignment before monitor move',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const redWindow = compositorWindowById(compositor, redId)
        if (!redWindow) return null
        const outputName = resolveWindowOutputName(compositor, redWindow)
        if (!outputName) return null
        const nativeMove = pickMonitorMove(compositor.outputs, outputName)
        if (!nativeMove) return null
        return { compositor, shell, redWindow, nativeMove, outputName }
      },
      5000,
      100,
    )
    const nativeMove = nativeInitial.nativeMove
    await focusNativeWindow(base, redId)
    await runKeybind(base, nativeMove.action, redId)
    const nativeMoved = await waitFor(
      'wait for native monitor move before picker',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const window = compositorWindowById(compositor, redId)
        if (!window || window.output_name !== nativeMove.target.name) return null
        try {
          assertTaskbarRowOnMonitor(shell, redId, nativeMove.target.name)
        } catch {
          return null
        }
        return { compositor, shell, window }
      },
      2000,
      125,
    )
    const nativeControls = windowControls(nativeMoved.shell, redId)
    assert(nativeControls?.titlebar, 'missing moved native titlebar rect')
    const nativeTitlebarCenter = rectGlobalCenter(nativeControls.titlebar)
    await movePoint(base, nativeTitlebarCenter.x, nativeTitlebarCenter.y)
    await pointerButton(base, 0x110, 'press')
    let nativeSnapped
    try {
      const nativePicker = await openPickerWhileDragging(base, redId)
      assert(nativePicker.snap_picker_monitor === nativeMove.target.name, 'native picker should stay on moved monitor')
      const nativeOutput = nativeMoved.compositor.outputs.find((entry) => entry.name === nativeMove.target.name) ?? null
      assert(nativeOutput, `missing moved native output ${nativeMove.target.name}`)
      assertRectCenteredOnOutput(assertRectMinSize('native picker root', nativePicker.controls?.snap_picker_root, 48), nativeOutput)
      const topCenter = assertRectMinSize('native picker top-center cell', nativePicker.controls?.snap_picker_top_center_cell, 12)
      await hoverPickerCellWhileDragging(base, 'hover native picker top-center cell', topCenter)
      await pointerButton(base, 0x110, 'release')
      nativeSnapped = await waitFor(
        'wait for native monitor-local picker snap',
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          const window = compositorWindowById(compositor, redId)
          if (!window || window.output_name !== nativeMove.target.name) return null
          try {
            assertTopThirdWindow(window, nativeMove.target.name, compositor, shell, 'center')
            assertTaskbarRowOnMonitor(shell, redId, nativeMove.target.name)
          } catch {
            return null
          }
          return { compositor, shell, window }
        },
        2000,
        125,
      )
    } finally {
      await pointerButton(base, 0x110, 'release')
    }

    await openSettings(base, 'click')
    const settingsFocused = await focusSettingsWindow(base)
    const settingsWindow = compositorWindowById(settingsFocused.compositor, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(settingsWindow, 'missing settings compositor window')
    const settingsOutputName = resolveWindowOutputName(settingsFocused.compositor, settingsWindow)
    assert(settingsOutputName, 'missing settings output assignment')
    const shellMove = pickMonitorMove(settingsFocused.compositor.outputs, settingsOutputName)
    assert(shellMove, `no adjacent monitor from ${settingsOutputName}`)
    await runKeybind(base, shellMove.action, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsMoved = await waitFor(
      'wait for settings monitor move before picker',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const window = compositorWindowById(compositor, SHELL_UI_SETTINGS_WINDOW_ID)
        if (!window || window.output_name !== shellMove.target.name) return null
        try {
          assertTaskbarRowOnMonitor(shell, SHELL_UI_SETTINGS_WINDOW_ID, shellMove.target.name)
        } catch {
          return null
        }
        return { compositor, shell, window }
      },
      2000,
      125,
    )
    const settingsPicker = await openPickerFromMaximizeButton(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(settingsPicker.snap_picker_monitor === shellMove.target.name, 'settings picker should stay on moved monitor')
    const settingsOutput = settingsMoved.compositor.outputs.find((entry) => entry.name === shellMove.target.name) ?? null
    assert(settingsOutput, `missing moved settings output ${shellMove.target.name}`)
    const settingsPickerRoot = assertRectMinSize('settings picker root', settingsPicker.controls?.snap_picker_root, 48)
    const settingsPickerCenter = rectGlobalCenter(settingsPickerRoot)
    assert(
      settingsPickerCenter.x >= settingsOutput.x &&
        settingsPickerCenter.x < settingsOutput.x + settingsOutput.width &&
        settingsPickerCenter.y >= settingsOutput.y &&
        settingsPickerCenter.y < settingsOutput.y + settingsOutput.height,
      `expected settings picker center to stay within ${settingsOutput.name}, got ${settingsPickerCenter.x},${settingsPickerCenter.y}`,
    )
    const firstCell = assertRectMinSize('settings picker first cell', settingsPicker.controls?.snap_picker_first_cell, 12)
    const firstCellCenter = rectGlobalCenter(firstCell)
    await clickPoint(base, firstCellCenter.x, firstCellCenter.y)
    const settingsSnapped = await waitFor(
      'wait for settings monitor-local picker snap',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const window = compositorWindowById(compositor, SHELL_UI_SETTINGS_WINDOW_ID)
        if (!window || window.output_name !== shellMove.target.name) return null
        try {
          assertTaskbarRowOnMonitor(shell, SHELL_UI_SETTINGS_WINDOW_ID, shellMove.target.name)
        } catch {
          return null
        }
        return { compositor, shell, window }
      },
      2000,
      125,
    )

    state.multiMonitorNativeMove = {
      window_id: redId,
      target_output: nativeMove.target.name,
    }
    state.multiMonitorShellMove = {
      window_id: SHELL_UI_SETTINGS_WINDOW_ID,
      target_output: shellMove.target.name,
    }
    await writeJsonArtifact('snap-assist-multimonitor-native.json', nativeSnapped)
    await writeJsonArtifact('snap-assist-multimonitor-settings.json', settingsSnapped)
  })
})
