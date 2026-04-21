import {
  BTN_LEFT,
  BTN_RIGHT,
  SHELL_UI_SETTINGS_WINDOW_ID,
  activateTaskbarWindow,
  assert,
  assertRectMinSize,
  assertTaskbarRowOnMonitor,
  assertTopWindow,
  clickRect,
  clickPoint,
  compositorWindowById,
  createTimingMarks,
  defineGroup,
  ensureNativePair,
  getJson,
  getSnapshots,
  keyAction,
  movePoint,
  openSettings,
  pickMonitorMove,
  pointerButton,
  postJson,
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

const TITLEBAR_PX = 26
const SHIFT_KEYCODE = 42
const SUPER_KEYCODE = 125

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

function assertTopRightQuarterWindow(
  window: WindowSnapshot,
  outputName: string,
  compositor: CompositorSnapshot,
  shell: ShellSnapshot,
) {
  const output = compositor.outputs.find((entry) => entry.name === outputName) ?? null
  const taskbar = taskbarForMonitor(shell, outputName)
  assert(output, `missing output ${outputName}`)
  assert(taskbar?.rect, `missing taskbar for ${outputName}`)
  const workTop = output.y + TITLEBAR_PX
  const workBottom = taskbar.rect.global_y
  const halfWidth = Math.floor(output.width / 2)
  const halfHeight = Math.floor((workBottom - workTop) / 2)
  const expectedX = output.x + halfWidth
  assert(Math.abs(window.x - expectedX) <= 28, `expected top-right quarter x near ${expectedX}, got ${window.x}`)
  assert(Math.abs(window.width - (output.width - halfWidth)) <= 36, `expected top-right quarter width near ${output.width - halfWidth}, got ${window.width}`)
  assert(Math.abs(window.y - workTop) <= 28, `expected top-right quarter y near ${workTop}, got ${window.y}`)
  assert(Math.abs(window.height - halfHeight) <= 36, `expected top-right quarter height near ${halfHeight}, got ${window.height}`)
}

function assertWindowMatchesRect(
  window: WindowSnapshot,
  expected: { x: number; y: number; width: number; height: number },
  label: string,
) {
  assert(Math.abs(window.x - expected.x) <= 28, `expected ${label} x near ${expected.x}, got ${window.x}`)
  assert(Math.abs(window.y - expected.y) <= 28, `expected ${label} y near ${expected.y}, got ${window.y}`)
  assert(Math.abs(window.width - expected.width) <= 36, `expected ${label} width near ${expected.width}, got ${window.width}`)
  assert(Math.abs(window.height - expected.height) <= 36, `expected ${label} height near ${expected.height}, got ${window.height}`)
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

function assertFullHeightTwoThirdsWindow(
  window: WindowSnapshot,
  outputName: string,
  compositor: CompositorSnapshot,
  shell: ShellSnapshot,
  side: 'left' | 'right',
) {
  const output = compositor.outputs.find((entry) => entry.name === outputName) ?? null
  const taskbar = taskbarForMonitor(shell, outputName)
  assert(output, `missing output ${outputName}`)
  assert(taskbar?.rect, `missing taskbar for ${outputName}`)
  const workTop = output.y + TITLEBAR_PX
  const workHeight = taskbar.rect.global_y - workTop
  const thirdWidth = Math.floor(output.width / 3)
  const twoThirdWidth = Math.round((output.width * 2) / 3)
  const expectedX = side === 'left' ? output.x : output.x + thirdWidth
  assert(Math.abs(window.x - expectedX) <= 28, `expected ${side} two-thirds x near ${expectedX}, got ${window.x}`)
  assert(
    Math.abs(window.width - twoThirdWidth) <= 40,
    `expected ${side} two-thirds width near ${twoThirdWidth}, got ${window.width}`,
  )
  assert(window.y >= output.y && window.y <= output.y + 80, `expected full-height y near ${output.y}, got ${window.y}`)
  assert(
    Math.abs(window.height - workHeight) <= 40,
    `expected full-height two-thirds height near ${workHeight}, got ${window.height}`,
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

function assertNoVerticalGapBetweenRects(
  label: string,
  anchor: { global_y: number; height: number },
  picker: { global_y: number; height: number },
) {
  const anchorBottom = anchor.global_y + anchor.height
  const pickerBottom = picker.global_y + picker.height
  const gap =
    picker.global_y >= anchorBottom
      ? picker.global_y - anchorBottom
      : anchor.global_y >= pickerBottom
        ? anchor.global_y - pickerBottom
        : 0
  assert(gap <= 1, `${label} expected no vertical gap between trigger and picker, got ${gap}`)
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

async function selectSettingsSnapLayout(base: string, layout: '2x2' | '3x2') {
  await openSettings(base, 'click')
  await focusSettingsWindow(base)
  let shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  assert(shell.controls?.settings_tab_tiling, 'missing settings tiling tab rect')
  await clickRect(base, shell.controls.settings_tab_tiling)
  shell = await waitFor(
    `wait for settings ${layout} snap layout option`,
    async () => {
      const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const control =
        layout === '2x2'
          ? next.controls?.settings_snap_layout_option_2x2
          : next.controls?.settings_snap_layout_option_3x2
      return control ? next : null
    },
    2000,
    125,
  )
  const control =
    layout === '2x2'
      ? shell.controls?.settings_snap_layout_option_2x2
      : shell.controls?.settings_snap_layout_option_3x2
  await clickRect(base, assertRectMinSize(`settings ${layout} snap layout option`, control, 12))
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('dragging a native titlebar into the strip opens the picker', async ({ base, state }) => {
    await selectSettingsSnapLayout(base, '3x2')
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
      const pickerRoot = assertRectMinSize('picker root', pickerOpen.controls?.snap_picker_root, 48)
      assertRectCenteredOnOutput(pickerRoot, output)
      assertNoVerticalGapBetweenRects(
        'strip picker',
        assertRectMinSize('snap strip trigger', pickerOpen.controls?.snap_strip_trigger, 12),
        pickerRoot,
      )
      await pointerButton(base, 0x110, 'release')
      await waitForPickerClosed(base, redId)
    } finally {
      await pointerButton(base, 0x110, 'release')
    }
  })

  test('drag picker commits a native window layout', async ({ base, state }) => {
    await selectSettingsSnapLayout(base, '3x2')
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
    await selectSettingsSnapLayout(base, '3x2')
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
    const controls = windowControls(pickerOpen, SHELL_UI_SETTINGS_WINDOW_ID)
    assertNoVerticalGapBetweenRects(
      'maximize button picker',
      assertRectMinSize('settings maximize button', controls?.maximize, 12),
      assertRectMinSize('settings picker root', pickerOpen.controls?.snap_picker_root, 48),
    )
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

  test('maximize button picker snaps a 3x2 two-column span to two-thirds width', async ({ base }) => {
    await openSettings(base, 'click')
    await focusSettingsWindow(base)
    const pickerOpen = await openPickerFromMaximizeButton(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(pickerOpen.snap_picker_source === 'button', 'expected maximize button to open picker')
    const rightTwoThirds = assertRectMinSize(
      '3x2 right two-thirds cell',
      pickerOpen.controls?.snap_picker_right_two_thirds,
      12,
    )
    const rightTwoThirdsCenter = rectGlobalCenter(rightTwoThirds)
    await clickPoint(base, rightTwoThirdsCenter.x, rightTwoThirdsCenter.y)
    const snapped = await waitFor(
      'wait for settings right two-thirds snap',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const window = compositorWindowById(compositor, SHELL_UI_SETTINGS_WINDOW_ID)
        if (!window) return null
        try {
          assertFullHeightTwoThirdsWindow(window, window.output_name, compositor, shell, 'right')
        } catch {
          return null
        }
        return { compositor, shell, window }
      },
      2000,
      125,
    )
    await writeJsonArtifact('snap-assist-picker-settings-right-two-thirds.json', snapped)
  })

  test('selected layout changes top-right edge tiling per monitor', async ({ base }) => {
    await openSettings(base, 'click')
    await focusSettingsWindow(base)
    let shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assert(shell.controls?.settings_tab_tiling, 'missing settings tiling tab rect')
    await clickRect(base, shell.controls.settings_tab_tiling)
    shell = await waitFor(
      'wait for settings snap layout options',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.settings_snap_layout_option_2x2 &&
          next.controls?.settings_snap_layout_option_3x2
          ? next
          : null
      },
      2000,
      125,
    )
    await clickRect(base, assertRectMinSize('settings 2x2 snap layout option', shell.controls?.settings_snap_layout_option_2x2, 12))

    let controls = windowControls(shell, SHELL_UI_SETTINGS_WINDOW_ID)
    const titlebar2x2 = assertRectMinSize('settings titlebar after 2x2 snap', controls?.titlebar, 12)
    const titlebar2x2Center = rectGlobalCenter(titlebar2x2)
    const window2x2 = compositorWindowById((await getJson<CompositorSnapshot>(base, '/test/state/compositor')), SHELL_UI_SETTINGS_WINDOW_ID)
    assert(window2x2, 'missing settings compositor window after 2x2 snap')
    const output2x2 = (await getJson<CompositorSnapshot>(base, '/test/state/compositor')).outputs.find((entry) => entry.name === window2x2.output_name) ?? null
    assert(output2x2, `missing output ${window2x2.output_name}`)
    await movePoint(base, titlebar2x2Center.x, titlebar2x2Center.y)
    await pointerButton(base, BTN_LEFT, 'press')
    try {
      await movePoint(base, output2x2.x + output2x2.width - 8, output2x2.y + TITLEBAR_PX + 8)
      await pointerButton(base, BTN_LEFT, 'release')
      const snapped2x2 = await waitFor(
        'wait for 2x2 top-right edge snap',
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          const window = compositorWindowById(compositor, SHELL_UI_SETTINGS_WINDOW_ID)
          if (!window) return null
          try {
            assertTopRightQuarterWindow(window, window.output_name, compositor, shell)
          } catch {
            return null
          }
          return { compositor, shell, window }
        },
        2000,
        125,
      )
      await writeJsonArtifact('snap-assist-edge-layout-2x2.json', snapped2x2)
    } finally {
      await pointerButton(base, BTN_LEFT, 'release')
    }

    const picker3x2 = await openPickerFromMaximizeButton(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const topCenter3x2 = assertRectMinSize(
      '3x2 top-center cell',
      picker3x2.controls?.snap_picker_top_center_cell,
      12,
    )
    const topCenter3x2Center = rectGlobalCenter(topCenter3x2)
    await clickPoint(base, topCenter3x2Center.x, topCenter3x2Center.y)
    await waitFor(
      'wait for settings 3x2 picker snap',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const window = compositorWindowById(compositor, SHELL_UI_SETTINGS_WINDOW_ID)
        if (!window) return null
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

    shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    controls = windowControls(shell, SHELL_UI_SETTINGS_WINDOW_ID)
    const titlebar3x2 = assertRectMinSize('settings titlebar after 3x2 snap', controls?.titlebar, 12)
    const titlebar3x2Center = rectGlobalCenter(titlebar3x2)
    const compositor3x2 = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    const window3x2 = compositorWindowById(compositor3x2, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(window3x2, 'missing settings compositor window after 3x2 snap')
    const output3x2 = compositor3x2.outputs.find((entry) => entry.name === window3x2.output_name) ?? null
    assert(output3x2, `missing output ${window3x2.output_name}`)
    await movePoint(base, titlebar3x2Center.x, titlebar3x2Center.y)
    await pointerButton(base, BTN_LEFT, 'press')
    try {
      await movePoint(base, output3x2.x + output3x2.width - 8, output3x2.y + TITLEBAR_PX + 8)
      await pointerButton(base, BTN_LEFT, 'release')
      const snapped3x2 = await waitFor(
        'wait for 3x2 top-right edge snap',
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          const window = compositorWindowById(compositor, SHELL_UI_SETTINGS_WINDOW_ID)
          if (!window) return null
          try {
            assertTopThirdWindow(window, window.output_name, compositor, shell, 'right')
          } catch {
            return null
          }
          return { compositor, shell, window }
        },
        2000,
        125,
      )
      await writeJsonArtifact('snap-assist-edge-layout-3x2.json', snapped3x2)
    } finally {
      await pointerButton(base, BTN_LEFT, 'release')
    }
  })

  test('custom layouts created in tiling settings appear in snap picker and snap shell windows', async ({ base }) => {
    await openSettings(base, 'click')
    await focusSettingsWindow(base)
    let shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assert(shell.controls?.settings_tab_tiling, 'missing settings tiling tab rect')
    await clickRect(base, shell.controls.settings_tab_tiling)
    shell = await waitFor(
      'wait for custom layout add control',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.settings_custom_layout_add ? next : null
      },
      5000,
      100,
    )
    assert(shell.controls?.settings_custom_layout_add, 'missing add custom layout control')
    await clickRect(base, shell.controls.settings_custom_layout_add)
    shell = await waitFor(
      'wait for custom layout overlay',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.custom_layout_overlay_root &&
          next.controls?.custom_layout_overlay_add &&
          next.controls?.custom_layout_overlay_save
          ? next
          : null
      },
      3000,
      100,
    )
    assert(shell.controls?.custom_layout_overlay_add, 'missing overlay add control')
    await clickRect(base, shell.controls.custom_layout_overlay_add)
    shell = await waitFor(
      'wait for overlay zone after add',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.settings_custom_layout_editor_zone ? next : null
      },
      3000,
      100,
    )
    const firstEditorZone = assertRectMinSize('initial editor zone', shell.controls?.settings_custom_layout_editor_zone, 80)
    await clickPoint(
      base,
      firstEditorZone.global_x + firstEditorZone.width * 0.5,
      firstEditorZone.global_y + firstEditorZone.height * 0.7,
    )
    shell = await waitFor(
      'wait for off-center horizontal split',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const zone = next.controls?.settings_custom_layout_editor_zone
        if (!zone) return null
        return Math.abs(zone.global_x - firstEditorZone.global_x) > 12 ? next : null
      },
      3000,
      100,
    )
    const secondEditorZone = assertRectMinSize('editor zone after first split', shell.controls?.settings_custom_layout_editor_zone, 80)
    await keyAction(base, SHIFT_KEYCODE, 'press')
    try {
      await clickPoint(
        base,
        secondEditorZone.global_x + secondEditorZone.width * 0.88,
        secondEditorZone.global_y + secondEditorZone.height * 0.5,
      )
    } finally {
      await keyAction(base, SHIFT_KEYCODE, 'release')
    }
    shell = await waitFor(
      'wait for off-center vertical split',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const zone = next.controls?.settings_custom_layout_editor_zone
        if (!zone) return null
        return zone.width < secondEditorZone.width - 12 ? next : null
      },
      3000,
      100,
    )
    assert(shell.controls?.custom_layout_overlay_save, 'missing overlay save control')
    await clickRect(base, shell.controls.custom_layout_overlay_save)
    await waitFor(
      'wait for custom layout overlay close',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.custom_layout_overlay_root ? null : next
      },
      3000,
      100,
    )

    const pickerOpen = await openPickerFromMaximizeButton(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const customZone = assertRectMinSize('custom picker zone', pickerOpen.controls?.snap_picker_custom_zone, 12)
    await clickPoint(base, rectGlobalCenter(customZone).x, rectGlobalCenter(customZone).y)
    const snapped = await waitFor(
      'wait for settings custom picker snap',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const window = compositorWindowById(compositor, SHELL_UI_SETTINGS_WINDOW_ID)
        if (!window) return null
        try {
          const output = compositor.outputs.find((entry) => entry.name === window.output_name)
          const taskbar = taskbarForMonitor(shell, window.output_name)
          assert(output, `missing output ${window.output_name}`)
          assert(taskbar?.rect, `missing taskbar for ${window.output_name}`)
          const workTop = output.y + TITLEBAR_PX
          const workBottom = taskbar.rect.global_y
          const halfWidth = Math.floor(output.width / 2)
          const clickedRightHalf = secondEditorZone.global_x >= output.x + halfWidth - 24
          const halfStart = clickedRightHalf ? output.x + halfWidth : output.x
          const halfWidthPx = clickedRightHalf ? output.width - halfWidth : halfWidth
          assertWindowMatchesRect(
            window,
            {
              x: halfStart,
              y: workTop,
              width: Math.round(halfWidthPx * 0.88),
              height: workBottom - workTop,
            },
            'custom layout largest zone',
          )
        } catch {
          return null
        }
        return { compositor, shell, window }
      },
      2000,
      125,
    )
    await writeJsonArtifact('snap-assist-picker-custom-layout.json', snapped)
  })

  test('settings-selected custom snap layout snaps a shell window on super drag', async ({ base }) => {
    await openSettings(base, 'click')
    await focusSettingsWindow(base)
    let shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assert(shell.controls?.settings_tab_tiling, 'missing settings tiling tab rect')
    await clickRect(base, shell.controls.settings_tab_tiling)
    shell = await waitFor(
      'wait for custom layout add control',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.settings_custom_layout_add ? next : null
      },
      5000,
      100,
    )
    assert(shell.controls?.settings_custom_layout_add, 'missing add custom layout control')
    await clickRect(base, shell.controls.settings_custom_layout_add)
    shell = await waitFor(
      'wait for custom layout overlay',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.custom_layout_overlay_root &&
          next.controls?.custom_layout_overlay_add &&
          next.controls?.custom_layout_overlay_save
          ? next
          : null
      },
      3000,
      100,
    )
    assert(shell.controls?.custom_layout_overlay_add, 'missing overlay add control')
    await clickRect(base, shell.controls.custom_layout_overlay_add)
    shell = await waitFor(
      'wait for overlay zone after add',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.settings_custom_layout_editor_zone ? next : null
      },
      3000,
      100,
    )
    const firstEditorZone = assertRectMinSize('initial editor zone', shell.controls?.settings_custom_layout_editor_zone, 80)
    await clickPoint(
      base,
      firstEditorZone.global_x + firstEditorZone.width * 0.5,
      firstEditorZone.global_y + firstEditorZone.height * 0.7,
    )
    shell = await waitFor(
      'wait for off-center horizontal split',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const zone = next.controls?.settings_custom_layout_editor_zone
        if (!zone) return null
        return Math.abs(zone.global_x - firstEditorZone.global_x) > 12 ? next : null
      },
      3000,
      100,
    )
    const secondEditorZone = assertRectMinSize('editor zone after first split', shell.controls?.settings_custom_layout_editor_zone, 80)
    await keyAction(base, SHIFT_KEYCODE, 'press')
    try {
      await clickPoint(
        base,
        secondEditorZone.global_x + secondEditorZone.width * 0.88,
        secondEditorZone.global_y + secondEditorZone.height * 0.5,
      )
    } finally {
      await keyAction(base, SHIFT_KEYCODE, 'release')
    }
    shell = await waitFor(
      'wait for custom layout save after second split',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.custom_layout_overlay_save &&
          next.controls?.settings_custom_layout_editor_zone
          ? next
          : null
      },
      3000,
      100,
    )
    assert(shell.controls?.custom_layout_overlay_save, 'missing overlay save control')
    await clickRect(base, shell.controls.custom_layout_overlay_save)
    shell = await waitFor(
      'wait for custom layout overlay close',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.custom_layout_overlay_root ? null : next
      },
      3000,
      100,
    )
    assert(shell.controls?.settings_snap_layout_option_custom, 'missing custom snap layout option')
    await clickRect(base, shell.controls.settings_snap_layout_option_custom)

    const focused = await focusSettingsWindow(base)
    const window = compositorWindowById(focused.compositor, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(window, 'missing settings compositor window before super drag')
    const output = focused.compositor.outputs.find((entry) => entry.name === window.output_name)
    const taskbar = taskbarForMonitor(focused.shell, window.output_name)
    assert(output, `missing output ${window.output_name}`)
    assert(taskbar?.rect, `missing taskbar for ${window.output_name}`)
    const workTop = output.y + TITLEBAR_PX
    const workBottom = taskbar.rect.global_y
    const halfWidth = Math.floor(output.width / 2)
    const clickedRightHalf = secondEditorZone.global_x >= output.x + halfWidth - 24
    const halfStart = clickedRightHalf ? output.x + halfWidth : output.x
    const halfWidthPx = clickedRightHalf ? output.width - halfWidth : halfWidth
    const target = {
      x: halfStart + Math.round(halfWidthPx * 0.44),
      y: workTop + Math.round((workBottom - workTop) * 0.5),
    }
    const controls = windowControls(focused.shell, SHELL_UI_SETTINGS_WINDOW_ID)
    const titlebar = assertRectMinSize('settings titlebar before super drag', controls?.titlebar, 12)
    const titlebarCenter = rectGlobalCenter(titlebar)

    await movePoint(base, titlebarCenter.x, titlebarCenter.y)
    await pointerButton(base, BTN_LEFT, 'press')
    await keyAction(base, SUPER_KEYCODE, 'press')
    try {
      await movePoint(base, target.x, target.y)
      await waitFor(
        'wait for custom super drag preview',
        async () => {
          const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
          return next.snap_preview_visible ? next : null
        },
        2000,
        16,
      )
      await keyAction(base, SUPER_KEYCODE, 'release')
      const afterSuperReleaseDuringDrag = await waitFor(
        'wait for programs menu stay closed after super keyup during drag',
        async () => {
          const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
          return next.programs_menu_open ? null : next
        },
        2000,
        16,
      )
      assert(!afterSuperReleaseDuringDrag.programs_menu_open, 'programs menu should stay closed when super is released before mouseup')
      await keyAction(base, SUPER_KEYCODE, 'press')
      await movePoint(base, target.x, target.y)
      await waitFor(
        'wait for custom super drag preview after re-press',
        async () => {
          const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
          return next.snap_preview_visible ? next : null
        },
        2000,
        16,
      )
      await pointerButton(base, BTN_LEFT, 'release')
      const snapped = await waitFor(
        'wait for custom super drag snap',
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          const current = compositorWindowById(compositor, SHELL_UI_SETTINGS_WINDOW_ID)
          if (!current) return null
          try {
            assertWindowMatchesRect(
              current,
              {
                x: halfStart,
                y: workTop,
                width: Math.round(halfWidthPx * 0.88),
                height: workBottom - workTop,
              },
              'custom layout super drag zone',
            )
          } catch {
            return null
          }
          return { compositor, shell, window: current }
        },
        2000,
        125,
      )
      await keyAction(base, SUPER_KEYCODE, 'release')
      const afterSuperRelease = await waitFor(
        'wait for programs menu stay closed after custom super drag',
        async () => {
          const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
          return next.programs_menu_open ? null : next
        },
        2000,
        16,
      )
      assert(!afterSuperRelease.programs_menu_open, 'programs menu should stay closed after custom super drag snap')
      await writeJsonArtifact('snap-assist-super-drag-custom-layout.json', snapped)
    } finally {
      await pointerButton(base, BTN_LEFT, 'release')
      await keyAction(base, SUPER_KEYCODE, 'release')
    }
  })

  test('custom layout preview follows cursor movement inside one zone and shift flips axis in place', async ({ base }) => {
    await openSettings(base, 'click')
    await focusSettingsWindow(base)
    let shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assert(shell.controls?.settings_tab_tiling, 'missing settings tiling tab rect')
    await clickRect(base, shell.controls.settings_tab_tiling)
    shell = await waitFor(
      'wait for custom layout add control',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.settings_custom_layout_add ? next : null
      },
      5000,
      100,
    )
    assert(shell.controls?.settings_custom_layout_add, 'missing add custom layout control')
    await clickRect(base, shell.controls.settings_custom_layout_add)
    shell = await waitFor(
      'wait for custom layout overlay',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.custom_layout_overlay_add && next.controls?.custom_layout_overlay_close ? next : null
      },
      3000,
      100,
    )
    assert(shell.controls?.custom_layout_overlay_add, 'missing overlay add control')
    await clickRect(base, shell.controls.custom_layout_overlay_add)
    shell = await waitFor(
      'wait for previewable editor zone',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.settings_custom_layout_editor_zone ? next : null
      },
      3000,
      100,
    )
    const overlayScreenshot = await postJson<{ path?: string }>(base, '/test/screenshot', {})
    await writeJsonArtifact('custom-layout-overlay-dialog-screenshot.json', overlayScreenshot)
    const zone = assertRectMinSize('preview editor zone', shell.controls?.settings_custom_layout_editor_zone, 80)

    await movePoint(base, zone.global_x + zone.width * 0.5, zone.global_y + zone.height * 0.2)
    const horizontalTop = await waitFor(
      'wait for horizontal preview near top',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const first = next.controls?.settings_custom_layout_preview_first
        const second = next.controls?.settings_custom_layout_preview_second
        if (!first || !second) return null
        if (first.height >= zone.height * 0.35) return null
        if (Math.abs(first.width - zone.width) > 8) return null
        return { next, first, second }
      },
      1000,
      16,
    )

    await movePoint(base, zone.global_x + zone.width * 0.5, zone.global_y + zone.height * 0.75)
    const horizontalLower = await waitFor(
      'wait for horizontal preview lower in same zone',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const first = next.controls?.settings_custom_layout_preview_first
        const second = next.controls?.settings_custom_layout_preview_second
        if (!first || !second) return null
        if (first.height <= horizontalTop.first.height + 40) return null
        if (Math.abs(first.width - zone.width) > 8) return null
        return { next, first, second }
      },
      1000,
      16,
    )

    await keyAction(base, SHIFT_KEYCODE, 'press')
    const verticalAtSamePoint = await waitFor(
      'wait for shift vertical preview without moving zones',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const first = next.controls?.settings_custom_layout_preview_first
        const second = next.controls?.settings_custom_layout_preview_second
        if (!first || !second) return null
        if (Math.abs(first.height - zone.height) > 8) return null
        if (first.width >= zone.width * 0.7) return null
        return { next, first, second }
      },
      1000,
      16,
    )

    await movePoint(base, zone.global_x + zone.width * 0.82, zone.global_y + zone.height * 0.75)
    const verticalMoved = await waitFor(
      'wait for vertical preview moved within same zone',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const first = next.controls?.settings_custom_layout_preview_first
        const second = next.controls?.settings_custom_layout_preview_second
        if (!first || !second) return null
        if (Math.abs(first.height - zone.height) > 8) return null
        if (first.width <= verticalAtSamePoint.first.width + 40) return null
        return { next, first, second }
      },
      1000,
      16,
    )
    await keyAction(base, SHIFT_KEYCODE, 'release')

    assert(horizontalLower.first.height > horizontalTop.first.height, 'horizontal preview should move with pointer inside one zone')
    assert(verticalAtSamePoint.first.width < horizontalLower.first.width - 40, 'shift should flip preview axis in place')
    assert(verticalMoved.first.width > verticalAtSamePoint.first.width, 'vertical preview should move with pointer inside one zone')

    assert(shell.controls?.custom_layout_overlay_close, 'missing overlay close control')
    await clickRect(base, shell.controls.custom_layout_overlay_close)
    await waitFor(
      'wait for custom layout overlay close after preview verification',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.controls?.custom_layout_overlay_root ? null : next
      },
      3000,
      100,
    )

    await writeJsonArtifact('snap-assist-custom-layout-preview-horizontal-top.json', horizontalTop.next)
    await writeJsonArtifact('snap-assist-custom-layout-preview-horizontal-lower.json', horizontalLower.next)
    await writeJsonArtifact('snap-assist-custom-layout-preview-vertical-same-point.json', verticalAtSamePoint.next)
    await writeJsonArtifact('snap-assist-custom-layout-preview-vertical-moved.json', verticalMoved.next)
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
