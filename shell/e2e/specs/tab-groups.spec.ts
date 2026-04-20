import {
  BTN_LEFT,
  KEY,
  SkipError,
  activateTaskbarWindow,
  assert,
  assertRectMinSize,
  assertTaskbarRowOnMonitor,
  cleanupNativeWindows,
  clickRect,
  closeWindow,
  compositorWindowById,
  createTimingMarks,
  defineGroup,
  ensureNativePair,
  getJson,
  getShellHtml,
  getSnapshots,
  minimizeWindow,
  movePoint,
  openShellTestWindow,
  outputForWindow,
  pickMonitorMove,
  pointerButton,
  rectCenter,
  rightClickRect,
  runKeybind,
  shellWindowById,
  tabGroupByWindow,
  taskbarForMonitor,
  taskbarEntry,
  tapKey,
  waitFor,
  waitForShellUiFocus,
  waitForWindowGone,
  waitForWindowMinimized,
  writeJsonArtifact,
  type E2eState,
  type Rect,
  type ShellSnapshot,
} from '../lib/runtime.ts'

function tabRect(shell: ShellSnapshot, windowId: number) {
  const group = tabGroupByWindow(shell, windowId)
  assert(group, `missing tab group for window ${windowId}`)
  const tab = group.tabs.find((entry) => entry.window_id === windowId)
  assert(tab, `missing tab for window ${windowId}`)
  const rect = tab.rect ?? tab.handle
  assert(rect, `missing tab rect for window ${windowId}`)
  return { group, tab: { ...tab, rect } }
}

function tabCloseRect(shell: ShellSnapshot, windowId: number) {
  const { tab } = tabRect(shell, windowId)
  assert(tab.close, `missing tab close rect for window ${windowId}`)
  return tab.close
}

function windowTitlebarRect(shell: ShellSnapshot, windowId: number) {
  const controls = shell.window_controls?.find((entry) => entry.window_id === windowId) ?? null
  assert(controls?.titlebar, `missing titlebar rect for window ${windowId}`)
  return controls.titlebar
}

async function waitForVisibleTabWindow(base: string, windowIds: number[]) {
  return waitFor(
    `wait for visible tab window ${windowIds.join(',')}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      for (const windowId of windowIds) {
        const group = tabGroupByWindow(shell, windowId)
        const tab = group?.tabs.find((entry) => entry.window_id === windowId)
        if (tab?.rect) return { shell, windowId, group, tab }
      }
      return null
    },
    5000,
    100,
  )
}

async function resolveNativeTabTarget(base: string, windowIds: number[]) {
  const candidateState = async (windowId: number) => {
    const { compositor, shell } = await getSnapshots(base)
    const window = shellWindowById(shell, windowId)
    const group = tabGroupByWindow(shell, windowId)
    const tab = group?.tabs.find((entry) => entry.window_id === windowId)
    const titlebar = shell.window_controls?.find((entry) => entry.window_id === windowId)?.titlebar ?? null
    const taskbar = window ? taskbarForMonitor(shell, window.output_name) : null
    const output = window ? outputForWindow(compositor, window) : null
    const usable =
      !!window &&
      !window.minimized &&
      !!group &&
      !!tab?.rect &&
      !!titlebar &&
      !!taskbar?.rect &&
      !!output &&
      titlebar.global_x >= output.x &&
      titlebar.global_x + titlebar.width <= output.x + output.width &&
      titlebar.global_y >= output.y &&
      titlebar.global_y + titlebar.height <= taskbar.rect.global_y
    return usable ? { compositor, shell, windowId, window, group, tab } : null
  }

  const visibleCandidates = await Promise.all(windowIds.map((windowId) => candidateState(windowId)))
  const initial = visibleCandidates
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort(
      (a, b) =>
        Number(b.compositor.focused_window_id === b.windowId) -
          Number(a.compositor.focused_window_id === a.windowId) ||
        (b.window?.stack_z ?? 0) - (a.window?.stack_z ?? 0) ||
        b.tab.rect!.width * b.tab.rect!.height - a.tab.rect!.width * a.tab.rect!.height ||
        a.windowId - b.windowId,
    )[0]
  if (initial) return initial

  let lastError: unknown = null
  for (const windowId of windowIds) {
    try {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      await activateTaskbarWindow(base, shell, windowId)
      return await waitFor(
        `wait for usable native tab target ${windowId}`,
        async () => {
          const next = await candidateState(windowId)
          if (!next) return null
          if (next.compositor.focused_window_id !== windowId) return null
          return next
        },
        1500,
        100,
      )
    } catch (error) {
      lastError = error
    }
  }
  if (lastError) throw lastError
  return waitForVisibleTabWindow(base, windowIds)
}

function tabMergeDropPointPx(source: ReturnType<typeof tabRect>, target: ReturnType<typeof tabRect>) {
  const sr = source.tab.rect!
  const tr = target.tab.rect!
  const scx = sr.global_x + sr.width / 2
  const tcy = tr.global_y + tr.height / 2
  const inset = 8
  if (scx < tr.global_x + tr.width / 2) {
    return { x: tr.global_x + inset, y: tcy }
  }
  return { x: tr.global_x + tr.width - inset, y: tcy }
}

function tabDropSlotRect(shell: ShellSnapshot, targetWindowId: number): Rect | null {
  const current = tabGroupByWindow(shell, targetWindowId)
  if (!current) return null
  const idx = current.member_window_ids.indexOf(targetWindowId)
  if (idx < 0) return null
  const insertIndex = idx + 1
  return current.drop_slots?.find((slot) => slot.insert_index === insertIndex)?.rect ?? null
}

async function dragTabOntoTab(
  base: string,
  sourceWindowId: number,
  targetWindowId: number,
) {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const source = tabRect(shell, sourceWindowId)
  const target = tabRect(shell, targetWindowId)
  const start = rectCenter(source.tab.rect!)
  await movePoint(base, start.x, start.y)
  await pointerButton(base, BTN_LEFT, 'press')
  await movePoint(base, start.x + 18, start.y)
  let slotRect: Rect | null = null
  try {
    slotRect = await waitFor(
      `wait for drop slot ${target.group.group_id}`,
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return tabDropSlotRect(next, targetWindowId)
      },
      1500,
      40,
    )
  } catch {
    slotRect = null
  }
  const initialEnd = slotRect ? rectCenter(slotRect) : tabMergeDropPointPx(source, target)
  const pickX = start.x + 18
  const pickY = start.y
  const dragTargetMatches = async () => {
    const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const currentTarget = tabGroupByWindow(next, targetWindowId)
    if (!currentTarget) return null
    const idx = currentTarget.member_window_ids.indexOf(targetWindowId)
    if (idx < 0) return null
    const insertAfter = idx + 1
    const dragTarget = next.tab_drag_target
    if (!dragTarget) return null
    if (dragTarget.window_id !== sourceWindowId || dragTarget.group_id !== currentTarget.group_id) return null
    if (dragTarget.insert_index !== idx && dragTarget.insert_index !== insertAfter) return null
    return dragTarget
  }
  let cx = pickX
  let cy = pickY
  let end = initialEnd
  for (let step = 1; step <= 24; step += 1) {
    const t = step / 24
    cx = pickX + (end.x - pickX) * t
    cy = pickY + (end.y - pickY) * t
    await movePoint(base, cx, cy)
  }
  const midShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const slot2 = tabDropSlotRect(midShell, targetWindowId)
  end = slot2 ? rectCenter(slot2) : tabMergeDropPointPx(source, target)
  for (let step = 1; step <= 24; step += 1) {
    const t = step / 24
    await movePoint(base, cx + (end.x - cx) * t, cy + (end.y - cy) * t)
  }
  cx = end.x
  cy = end.y
  try {
    await waitFor(`wait for tab drag target ${target.group.group_id}`, dragTargetMatches, 2000, 40)
  } catch {}
  await pointerButton(base, BTN_LEFT, 'release')
}

async function closeTabByClick(base: string, windowId: number) {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  await clickRect(base, tabCloseRect(shell, windowId))
}

async function dragTabStep(base: string, windowId: number, target: { x: number; y: number }) {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const { tab } = tabRect(shell, windowId)
  const start = rectCenter(tab.rect!)
  await movePoint(base, start.x, start.y)
  await pointerButton(base, BTN_LEFT, 'press')
  await movePoint(base, target.x, target.y)
}

async function finishDrag(base: string) {
  await pointerButton(base, BTN_LEFT, 'release')
}

async function waitForGroupedMembers(base: string, memberWindowIds: number[], visibleWindowId?: number) {
  const expected = [...memberWindowIds].sort((a, b) => a - b)
  const expectedKey = expected.join(',')
  return waitFor(
    `wait for grouped members ${memberWindowIds.join(',')}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      for (const windowId of memberWindowIds) {
        const group = tabGroupByWindow(shell, windowId)
        if (!group) continue
        const members = [...group.member_window_ids].sort((a, b) => a - b)
        if (members.join(',') !== expectedKey) continue
        if (visibleWindowId !== undefined && group.visible_window_id !== visibleWindowId) continue
        return { shell, group }
      }
      return null
    },
    5000,
    40,
  )
}

async function selectTabByClick(base: string, windowId: number) {
  const { rect } = await waitFor(
    `wait for tab click target ${windowId}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const group = tabGroupByWindow(shell, windowId)
      const tab = group?.tabs.find((entry) => entry.window_id === windowId)
      const rect = tab?.rect ?? tab?.handle
      if (!rect || rect.width < 12 || rect.height < 10) return null
      return { rect }
    },
    3000,
    40,
  )
  await clickRect(base, assertRectMinSize(`tab ${windowId}`, rect, 12, 10))
}

async function selectTabByFastClick(base: string, windowId: number) {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const tab = tabRect(shell, windowId)
  await clickRect(base, tab.tab.rect!)
}

async function openTabMenu(base: string, windowId: number) {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const tab = tabRect(shell, windowId)
  await rightClickRect(base, tab.tab.rect!)
  return waitFor(
    `wait for tab menu ${windowId}`,
    async () => {
      const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return next.controls?.tab_menu_pin || next.controls?.tab_menu_unpin ? next : null
    },
    5000,
    100,
  )
}

async function waitForSplitGroup(base: string, windowId: number, leftWindowId: number) {
  return waitFor(
    `wait for split group ${windowId}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const group = tabGroupByWindow(shell, windowId)
      if (!group) return null
      if (group.split_left_window_id !== leftWindowId) return null
      if (!group.split_left_rect || !group.split_right_rect || !group.split_divider_rect) return null
      return { shell, group }
    },
    2000,
    125,
  )
}

async function enterSplitViewFromTabMenu(base: string, leftWindowId: number) {
  await openTabMenu(base, leftWindowId)
  const shell = await waitFor(
    `wait for split menu action ${leftWindowId}`,
    async () => {
      const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return next.controls?.tab_menu_use_split_left ? next : null
    },
    5000,
    100,
  )
  assert(shell.controls?.tab_menu_use_split_left, 'missing split-left menu action')
  await tapKey(base, KEY.down)
  await tapKey(base, KEY.enter)
  return waitForSplitGroup(base, leftWindowId, leftWindowId)
}

async function exitSplitViewFromTabMenu(base: string, leftWindowId: number) {
  await openTabMenu(base, leftWindowId)
  const shell = await waitFor(
    `wait for exit split action ${leftWindowId}`,
    async () => {
      const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return next.controls?.tab_menu_exit_split ? next : null
    },
    5000,
    100,
  )
  assert(shell.controls?.tab_menu_exit_split, 'missing exit split menu action')
  await tapKey(base, KEY.down)
  await tapKey(base, KEY.enter)
}

async function moveShellWindowToOtherMonitor(base: string, windowId: number) {
  await selectTabByClick(base, windowId)
  let focused
  try {
    focused = await waitForShellUiFocus(base, windowId)
  } catch {
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shell, windowId)
    focused = await waitForShellUiFocus(base, windowId)
  }
  const shellWindow = shellWindowById(focused.shell, windowId)
  assert(shellWindow?.output_name, `missing shell output for ${windowId}`)
  const move = pickMonitorMove(focused.compositor.outputs, shellWindow.output_name)
  if (!move) {
    throw new SkipError(`no adjacent monitor from ${shellWindow.output_name}`)
  }
  await runKeybind(base, move.action, windowId)
  return waitFor(
    `wait for shell window ${windowId} moved`,
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const movedWindow = compositorWindowById(compositor, windowId)
      const movedShellWindow = shellWindowById(shell, windowId)
      if (!movedWindow || !movedShellWindow) return null
      if (movedWindow.output_name !== move.target.name || movedShellWindow.output_name !== move.target.name) return null
      assertTaskbarRowOnMonitor(shell, windowId, move.target.name)
      return { compositor, shell, movedWindow, movedShellWindow, move }
    },
    2000,
    125,
  )
}

async function ensureFreshNativePair(base: string, state: E2eState) {
  await cleanupNativeWindows(base, state.spawnedNativeWindowIds)
  if (state.redSpawn) state.nativeLaunchByWindowId.delete(state.redSpawn.window.window_id)
  if (state.greenSpawn) state.nativeLaunchByWindowId.delete(state.greenSpawn.window.window_id)
  state.redSpawn = null
  state.greenSpawn = null
  state.multiMonitorNativeMove = null
  state.tiledOutput = null
  return ensureNativePair(base, state)
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('js test windows support multi-instance shell fixtures', async ({ base, state }) => {
    const timing = createTimingMarks('tab-js-fixtures')
    const created: number[] = []
    try {
      const first = await timing.step('open first js test window', () => openShellTestWindow(base, state))
      const second = await timing.step('open second js test window', () => openShellTestWindow(base, state))
      created.push(first.window.window_id, second.window.window_id)
      assert(first.window.window_id !== second.window.window_id, 'expected distinct js test window ids')
      assert(first.window.shell_hosted && second.window.shell_hosted, 'expected shell-hosted js test windows')
      assert(taskbarEntry(first.shell, first.window.window_id), 'missing taskbar row for first js test window')
      assert(taskbarEntry(second.shell, second.window.window_id), 'missing taskbar row for second js test window')
      await timing.step('write fixture artifact', () => writeJsonArtifact('tab-groups-js-test-windows.json', {
        first: first.window,
        second: second.window,
      }))
    } finally {
      for (const windowId of created) {
        try {
          await closeWindow(base, windowId)
          await waitForWindowGone(base, windowId)
        } catch {}
      }
    }
  })

  test('taskbar collapses grouped native and js windows into one row', async ({ base, state }) => {
    const timing = createTimingMarks('tab-merge-native-js')
    let jsWindowId: number | null = null
    try {
      const { red, green } = await ensureFreshNativePair(base, state)
      const initial = await getSnapshots(base)
      if (initial.compositor.outputs.length < 2) {
        throw new SkipError('requires at least two outputs')
      }
      const jsWindow = await timing.step('open js test window', () => openShellTestWindow(base, state))
      jsWindowId = jsWindow.window.window_id
      await timing.step('move js window to other monitor', () => moveShellWindowToOtherMonitor(base, jsWindow.window.window_id))
      const target = await timing.step('resolve visible native target', () =>
        resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
      )
      await timing.step('drag js tab into native tab', () => dragTabOntoTab(base, jsWindow.window.window_id, target.windowId))
      const merged = await timing.step('wait for merged group', () => waitFor(
        'wait for native/js group merge',
        async () => {
          const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
          const group = tabGroupByWindow(shell, target.windowId)
          if (!group) return null
          if (!group.member_window_ids.includes(jsWindow.window.window_id)) return null
          const row = taskbarEntry(shell, target.windowId)
          if (!row || row.tab_count !== 2) return null
          if (taskbarEntry(shell, jsWindow.window.window_id)) return null
          return { shell, group, row }
        },
        2000,
        125,
      ))
      await timing.step('select js tab', () => selectTabByClick(base, jsWindow.window.window_id))
      const jsVisible = await timing.step('wait for js tab visible', () => waitFor(
        'wait for js tab visible',
        async () => {
          const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
          const group = tabGroupByWindow(shell, jsWindow.window.window_id)
          if (!group || group.visible_window_id !== jsWindow.window.window_id) return null
          const row = taskbarEntry(shell, jsWindow.window.window_id)
          if (!row || row.tab_count !== 2) return null
          return { shell, group, row }
        },
        2000,
        125,
      ))
      await timing.step('write merge artifact', () => writeJsonArtifact('tab-groups-native-js-merged.json', {
        merged,
        jsVisible,
      }))
    } finally {
      if (jsWindowId !== null) {
        try {
          await closeWindow(base, jsWindowId)
          await waitForWindowGone(base, jsWindowId)
        } catch {}
      }
    }
  })

  test('active grouped tab can move the group row across monitors', async ({ base, state }) => {
    const timing = createTimingMarks('tab-multimonitor-switch')
    let jsWindowId: number | null = null
    try {
      const { red, green } = await ensureFreshNativePair(base, state)
      const jsWindow = await timing.step('open js test window', () => openShellTestWindow(base, state))
      jsWindowId = jsWindow.window.window_id
      const { compositor } = await getSnapshots(base)
      if (compositor.outputs.length < 2) {
        throw new SkipError('requires at least two outputs')
      }
      await timing.step('move js window to other monitor', () => moveShellWindowToOtherMonitor(base, jsWindow.window.window_id))
      const target = await timing.step('resolve visible native target', () =>
        resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
      )
      await timing.step('drag js tab into native tab', () => dragTabOntoTab(base, jsWindow.window.window_id, target.windowId))
      await timing.step('wait for grouped members', () => waitForGroupedMembers(base, [target.windowId, jsWindow.window.window_id]))
      await timing.step('select js tab', () => selectTabByClick(base, jsWindow.window.window_id))
      const jsFocused = await timing.step('focus grouped js tab', () => waitForShellUiFocus(base, jsWindow.window.window_id))
      const jsSnapshot = shellWindowById(jsFocused.shell, jsWindow.window.window_id)
      assert(jsSnapshot?.output_name, 'missing js test window output')
      const move = pickMonitorMove(compositor.outputs, jsSnapshot.output_name)
      if (!move) {
        throw new SkipError(`no adjacent monitor from ${jsSnapshot.output_name}`)
      }
      await timing.step(`run keybind ${move.action}`, () => runKeybind(base, move.action, jsWindow.window.window_id))
      const switched = await timing.step('wait for grouped row moved', () => waitFor(
        'wait for grouped row on js monitor',
        async () => {
          const { compositor: switchedCompositor, shell: switchedShell } = await getSnapshots(base)
          const group = tabGroupByWindow(switchedShell, jsWindow.window.window_id)
          if (!group || group.visible_window_id !== jsWindow.window.window_id) return null
          const movedWindow = compositorWindowById(switchedCompositor, jsWindow.window.window_id)
          if (!movedWindow || movedWindow.output_name !== move.target.name) return null
          assertTaskbarRowOnMonitor(switchedShell, jsWindow.window.window_id, move.target.name)
          return { switchedCompositor, switchedShell, group }
        },
        2000,
        125,
      ))
      await timing.step('write multimonitor artifact', () => writeJsonArtifact('tab-groups-multimonitor-switch.json', switched))
    } finally {
      if (jsWindowId !== null) {
        try {
          await closeWindow(base, jsWindowId)
          await waitForWindowGone(base, jsWindowId)
        } catch {}
      }
    }
  })

  test('single click switches grouped native tabs without moving the group', async ({ base, state }) => {
    const timing = createTimingMarks('tab-single-click-switch')
    const { red, green } = await ensureFreshNativePair(base, state)
    const target = await timing.step('resolve visible native target', () =>
      resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
    )
    const draggedWindowId = target.windowId === red.window.window_id ? green.window.window_id : red.window.window_id
    await timing.step('group native windows', () => dragTabOntoTab(base, draggedWindowId, target.windowId))
    const grouped = await timing.step('wait for grouped pair', () =>
      waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], target.windowId),
    )
    const anchorTitlebar = windowTitlebarRect(grouped.shell, target.windowId)
    const switched = await timing.step('single click hidden dragged tab', async () => {
      await selectTabByClick(base, draggedWindowId)
      return waitFor(
        `wait for single click switch ${draggedWindowId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          const group = tabGroupByWindow(shell, draggedWindowId)
          const switchedTitlebar = shell.window_controls?.find((entry) => entry.window_id === draggedWindowId)?.titlebar
          if (!group || group.visible_window_id !== draggedWindowId || !switchedTitlebar) return null
          if (
            Math.abs(switchedTitlebar.global_x - anchorTitlebar.global_x) > 12 ||
            Math.abs(switchedTitlebar.global_y - anchorTitlebar.global_y) > 12
          ) {
            return null
          }
          return { compositor, shell, group, switchedTitlebar }
        },
        2000,
        125,
      )
    })
    await timing.step('write single click switch artifact', () =>
      writeJsonArtifact('tab-groups-single-click-switch.json', {
        grouped,
        switched,
        anchorTitlebar,
        draggedWindowId,
      }),
    )
  })

  test('fast click switches grouped tab immediately', async ({ base, state }) => {
    const timing = createTimingMarks('tab-fast-click-switch')
    const { red, green } = await ensureFreshNativePair(base, state)
    const target = await timing.step('resolve visible native target', () =>
      resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
    )
    const draggedWindowId = target.windowId === red.window.window_id ? green.window.window_id : red.window.window_id
    await timing.step('group native windows', () => dragTabOntoTab(base, draggedWindowId, target.windowId))
    const grouped = await timing.step('wait for grouped pair', () =>
      waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], target.windowId),
    )
    await timing.step('fast click hidden grouped tab', () => selectTabByFastClick(base, draggedWindowId))
    const switched = await timing.step('wait for fast click switch', () =>
      waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], draggedWindowId),
    )
    await timing.step('write fast click artifact', () =>
      writeJsonArtifact('tab-groups-fast-click-switch.json', {
        grouped,
        switched,
        draggedWindowId,
      }),
    )
  })

  test('tab menu closes when its window closes', async ({ base, state }) => {
    const timing = createTimingMarks('tab-menu-close-lifecycle')
    const { red, green } = await ensureFreshNativePair(base, state)
    const target = await timing.step('resolve visible native target', () =>
      resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
    )
    const targetWindowId = target.windowId
    await timing.step('open tab menu', () => openTabMenu(base, targetWindowId))
    await timing.step('close backing window', () => closeWindow(base, targetWindowId))
    await timing.step('wait for window gone', () => waitForWindowGone(base, targetWindowId))
    const closed = await timing.step('wait for tab menu dismissed', () =>
      waitFor(
        'wait for tab menu dismissed after close',
        async () => {
          const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
          return shell.controls?.tab_menu_pin || shell.controls?.tab_menu_unpin ? null : shell
        },
        2000,
        125,
      ),
    )
    await timing.step('write menu-close artifact', () =>
      writeJsonArtifact('tab-groups-menu-close-dismiss.json', {
        closed,
        closed_window_id: targetWindowId,
      }),
    )
  })

  test('dragging grouped tab tears out the real window during the same drag', async ({ base, state }) => {
    const timing = createTimingMarks('tab-tear-out-real-window')
    let jsWindowId: number | null = null
    let released = false
    try {
      const { red, green } = await ensureFreshNativePair(base, state)
      const jsWindow = await timing.step('open js test window', () => openShellTestWindow(base, state))
      jsWindowId = jsWindow.window.window_id
      await timing.step('move js window to other monitor', () =>
        moveShellWindowToOtherMonitor(base, jsWindow.window.window_id),
      )
      const target = await timing.step('resolve visible native target', () =>
        resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
      )
      await timing.step('merge js tab into native tab', () =>
        dragTabOntoTab(base, jsWindow.window.window_id, target.windowId),
      )
      const merged = await timing.step('wait for merged members', () =>
        waitForGroupedMembers(base, [target.windowId, jsWindow.window.window_id], target.windowId),
      )
      const draggedWindowId = jsWindow.window.window_id
      const remainingWindowId = target.windowId
      const dragShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const draggedTab = tabRect(dragShell, draggedWindowId)
      const dragStart = rectCenter(draggedTab.tab.rect!)
      const previewPoint = {
        x: Math.min(dragStart.x + 48, draggedTab.tab.rect!.global_x + draggedTab.tab.rect!.width - 6),
        y: dragStart.y,
      }
      await timing.step('start grouped tab drag', () => dragTabStep(base, draggedWindowId, previewPoint))
      const tearOutPoint = {
        x: previewPoint.x + 24,
        y: draggedTab.tab.rect!.global_y - 64,
      }
      await timing.step('move grouped tab out of strip', () => movePoint(base, tearOutPoint.x, tearOutPoint.y))
      const detachedDuringDrag = await timing.step('wait for tear-out during drag', () =>
        waitFor(
          `wait for dragged tab ${draggedWindowId} detached`,
          async () => {
            const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
            const draggedGroup = tabGroupByWindow(shell, draggedWindowId)
            const remainingGroup = tabGroupByWindow(shell, remainingWindowId)
            if (!draggedGroup || !remainingGroup || draggedGroup.group_id === remainingGroup.group_id) {
              return null
            }
            if (draggedGroup.member_window_ids.length !== 1 || draggedGroup.member_window_ids[0] !== draggedWindowId) {
              return null
            }
            const draggedWindow = shell.windows.find((window) => window.window_id === draggedWindowId)
            if (!draggedWindow || draggedWindow.minimized) return null
            return { shell, draggedGroup, remainingGroup, draggedWindow }
          },
          5000,
          100,
        ),
      )
      await timing.step('release tear-out drag', () => finishDrag(base))
      released = true
      const split = await timing.step('wait for unmerged tab', () =>
        waitFor(
          `wait for unmerged tab ${draggedWindowId}`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const draggedGroup = tabGroupByWindow(shell, draggedWindowId)
            const remainingGroup = tabGroupByWindow(shell, remainingWindowId)
            const draggedWindow = shell.windows.find((window) => window.window_id === draggedWindowId) ?? null
            const draggedRow = taskbarEntry(shell, draggedWindowId)
            const remainingRow = taskbarEntry(shell, remainingWindowId)
            if (
              !draggedGroup ||
              !remainingGroup ||
              !draggedWindow ||
              !draggedRow ||
              !remainingRow
            ) {
              return null
            }
            if (draggedGroup.group_id === remainingGroup.group_id) return null
            if (draggedGroup.member_window_ids.length !== 1 || draggedGroup.member_window_ids[0] !== draggedWindowId) {
              return null
            }
            if (
              remainingGroup.member_window_ids.length !== 1 ||
              remainingGroup.member_window_ids[0] !== remainingWindowId
            ) {
              return null
            }
            if (draggedRow.tab_count !== 1 || remainingRow.tab_count !== 1) return null
            return {
              compositor,
              shell,
              draggedGroup,
              remainingGroup,
              draggedWindow,
              draggedRow,
              remainingRow,
            }
          },
          2000,
          125,
        ),
      )
      await timing.step('write drag preview tear-out artifact', () =>
        writeJsonArtifact('tab-groups-drag-preview-unmerge.json', {
          merged,
          detached_during_drag: detachedDuringDrag,
          split,
        }),
      )
    } finally {
      if (!released) {
        try {
          await finishDrag(base)
        } catch {}
      }
      if (jsWindowId !== null) {
        try {
          await closeWindow(base, jsWindowId)
          await waitForWindowGone(base, jsWindowId)
        } catch {}
      }
    }
  })

  test('torn-out window can merge into another tab bar during the same drag with a visible drop indicator', async ({ base, state }) => {
    const timing = createTimingMarks('tab-tear-out-and-remerge')
    let jsWindowIdA: number | null = null
    let jsWindowIdB: number | null = null
    let released = false
    try {
      const { red, green } = await ensureFreshNativePair(base, state)
      const jsWindowA = await timing.step('open first js test window', () => openShellTestWindow(base, state))
      jsWindowIdA = jsWindowA.window.window_id
      await timing.step('move first js window to other monitor', () =>
        moveShellWindowToOtherMonitor(base, jsWindowA.window.window_id),
      )
      const nativeTarget = await timing.step('resolve visible native target', () =>
        resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
      )
      await timing.step('merge first js tab into native tab', () =>
        dragTabOntoTab(base, jsWindowA.window.window_id, nativeTarget.windowId),
      )
      await timing.step('wait for grouped source members', () =>
        waitForGroupedMembers(base, [nativeTarget.windowId, jsWindowA.window.window_id], nativeTarget.windowId),
      )
      const jsWindowB = await timing.step('open second js test window', () => openShellTestWindow(base, state))
      jsWindowIdB = jsWindowB.window.window_id
      await timing.step('move second js window to other monitor', () =>
        moveShellWindowToOtherMonitor(base, jsWindowB.window.window_id),
      )
      const draggedTabShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const draggedTab = tabRect(draggedTabShell, jsWindowA.window.window_id)
      const dragStart = rectCenter(draggedTab.tab.rect!)
      const armedPoint = {
        x: Math.min(dragStart.x + 48, draggedTab.tab.rect!.global_x + draggedTab.tab.rect!.width - 6),
        y: dragStart.y,
      }
      await timing.step('start source drag', () => dragTabStep(base, jsWindowA.window.window_id, armedPoint))
      await timing.step('pull grouped tab out', () => movePoint(base, armedPoint.x + 24, draggedTab.tab.rect!.global_y - 64))
      await timing.step('wait for source window detached', () =>
        waitFor(
          `wait for detached ${jsWindowA.window.window_id}`,
          async () => {
            const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
            const detachedGroup = tabGroupByWindow(shell, jsWindowA.window.window_id)
            const sourceGroup = tabGroupByWindow(shell, nativeTarget.windowId)
            if (!detachedGroup || !sourceGroup || detachedGroup.group_id === sourceGroup.group_id) return null
            if (detachedGroup.member_window_ids.length !== 1) return null
            return { shell, detachedGroup, sourceGroup }
          },
          5000,
          100,
        ),
      )
      const targetShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const remergeTarget = tabRect(targetShell, jsWindowB.window.window_id)
      const remergeTargetGroupId = remergeTarget.group.group_id
      await timing.step('drag torn out window onto second js tab bar', () =>
        movePoint(base, rectCenter(remergeTarget.tab.rect!).x, rectCenter(remergeTarget.tab.rect!).y),
      )
      const dropIndicatorHtml = await timing.step('wait for drop indicator', () =>
        waitFor(
          `wait for drop indicator ${remergeTargetGroupId}`,
          async () => {
            const html = await getShellHtml(base, '[data-tab-drop-indicator]')
            return html.includes(remergeTargetGroupId) ? html : null
          },
          5000,
          100,
        ),
      )
      await timing.step('release merged drag on second js tab bar', () => finishDrag(base))
      released = true
      const remerged = await timing.step('wait for same-drag remerge', () =>
        waitFor(
          `wait for regrouped ${jsWindowA.window.window_id},${jsWindowB.window.window_id}`,
          async () => {
            const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
            const group = tabGroupByWindow(shell, jsWindowB.window.window_id)
            if (!group) return null
            const members = [...group.member_window_ids].sort((a, b) => a - b)
            const expected = [jsWindowA.window.window_id, jsWindowB.window.window_id].sort((a, b) => a - b)
            if (members.join(',') !== expected.join(',')) return null
            const row = taskbarEntry(shell, jsWindowB.window.window_id)
            if (!row || row.tab_count !== 2) return null
            if (taskbarEntry(shell, jsWindowA.window.window_id)) return null
            return { shell, group, row }
          },
          2000,
          125,
        ),
      )
      await timing.step('write same drag remerge artifact', () =>
        writeJsonArtifact('tab-groups-tear-out-remerge.json', {
          drop_indicator_html: dropIndicatorHtml,
          remerged,
        }),
      )
    } finally {
      if (!released) {
        try {
          await finishDrag(base)
        } catch {}
      }
      for (const windowId of [jsWindowIdA, jsWindowIdB]) {
        if (windowId === null) continue
        try {
          await closeWindow(base, windowId)
          await waitForWindowGone(base, windowId)
        } catch {}
      }
    }
  })

  test('grouped native tabs keep geometry and close via tab buttons', async ({ base, state }) => {
    const timing = createTimingMarks('tab-native-geometry-and-close')
    let jsWindowId: number | null = null
    try {
      const { red, green } = await ensureFreshNativePair(base, state)
      const jsWindow = await timing.step('open js test window', () => openShellTestWindow(base, state))
      jsWindowId = jsWindow.window.window_id
      await timing.step('move js window to other monitor', () =>
        moveShellWindowToOtherMonitor(base, jsWindow.window.window_id),
      )
      const target = await timing.step('merge js into native target', async () => {
        const visibleNative = await resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id])
        await dragTabOntoTab(base, jsWindow.window.window_id, visibleNative.windowId)
        return waitForGroupedMembers(
          base,
          [visibleNative.windowId, jsWindow.window.window_id],
          visibleNative.windowId,
        )
      })
      const nativeWindowId = target.group.visible_window_id
      const leaderSnapshot = await getSnapshots(base)
      const nativeWindow = compositorWindowById(leaderSnapshot.compositor, nativeWindowId)
      assert(nativeWindow, `missing grouped native leader ${nativeWindowId}`)
      const nativeTitlebar = windowTitlebarRect(leaderSnapshot.shell, nativeWindowId)
      await timing.step('select js tab in mixed group', () => selectTabByClick(base, jsWindow.window.window_id))
      await timing.step('wait for js tab visible', () =>
        waitForGroupedMembers(base, [nativeWindowId, jsWindow.window.window_id], jsWindow.window.window_id),
      )
      await timing.step('select native tab in mixed group', () => selectTabByClick(base, nativeWindowId))
      await timing.step('wait for native geometry after switch', () =>
        waitFor(
          'wait for native geometry after switch',
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const group = tabGroupByWindow(shell, nativeWindowId)
            const restoredNative = compositorWindowById(compositor, nativeWindowId)
            const restoredTitlebar = shell.window_controls?.find((entry) => entry.window_id === nativeWindowId)
            if (!group || group.visible_window_id !== nativeWindowId || !restoredNative) return null
            if (!restoredTitlebar?.titlebar) return null
            if (restoredNative.output_name !== nativeWindow.output_name) return null
            if (
              Math.abs(restoredTitlebar.titlebar.global_x - nativeTitlebar.global_x) > 12 ||
              Math.abs(restoredTitlebar.titlebar.global_y - nativeTitlebar.global_y) > 12
            ) {
              return null
            }
            return { compositor, shell, group, restoredNative, restoredTitlebar: restoredTitlebar.titlebar }
          },
          2000,
          125,
        ),
      )
      await timing.step('close grouped native tab by button', () => closeTabByClick(base, nativeWindowId))
      const closed = await timing.step('wait for grouped native tab closed', () =>
        waitFor(
          `wait for grouped native tab ${nativeWindowId} closed`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            if (compositorWindowById(compositor, nativeWindowId)) return null
            if (shell.windows.some((window) => window.window_id === nativeWindowId)) return null
            const group = tabGroupByWindow(shell, jsWindow.window.window_id)
            if (!group || group.member_window_ids.includes(nativeWindowId)) return null
            const row = taskbarEntry(shell, jsWindow.window.window_id)
            if (!row || row.tab_count !== 1) return null
            return { compositor, shell, group, row }
          },
          2000,
          125,
        ),
      )
      jsWindowId = null
      await timing.step('write native tab regression artifact', () =>
        writeJsonArtifact('tab-groups-native-geometry-close.json', {
          target,
          closed,
        }),
      )
    } finally {
      if (jsWindowId !== null) {
        try {
          await closeWindow(base, jsWindowId)
          await waitForWindowGone(base, jsWindowId)
        } catch {}
      }
    }
  })

  test('tab menu enters and exits split view for grouped native tabs', async ({ base, state }) => {
    const timing = createTimingMarks('tab-split-enter-exit')
    const { red, green } = await ensureFreshNativePair(base, state)
    const target = await timing.step('resolve visible native target', () =>
      resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
    )
    await timing.step('group native windows', () =>
      dragTabOntoTab(
        base,
        target.windowId === red.window.window_id ? green.window.window_id : red.window.window_id,
        target.windowId,
      ),
    )
    await timing.step('wait for grouped pair', () =>
      waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], target.windowId),
    )
    const split = await timing.step('enter split from tab menu', () => enterSplitViewFromTabMenu(base, target.windowId))
    await timing.step('exit split from left tab menu', async () => {
      await exitSplitViewFromTabMenu(base, target.windowId)
      await waitFor(
        'wait for split exit',
        async () => {
          const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
          const group = tabGroupByWindow(shell, target.windowId)
          return group && !group.split_left_rect && !group.split_right_rect ? { shell, group } : null
        },
        2000,
        125,
      )
    })
    await timing.step('write split enter exit artifact', () =>
      writeJsonArtifact('tab-groups-split-enter-exit.json', split),
    )
  })

  test('activating a hidden split tab keeps the split frame stable', async ({ base, state }) => {
    const timing = createTimingMarks('tab-split-activate-stable')
    let jsWindowId: number | null = null
    try {
      const { red, green } = await ensureFreshNativePair(base, state)
      const jsWindow = await timing.step('open js test window', () => openShellTestWindow(base, state))
      jsWindowId = jsWindow.window.window_id
      await timing.step('move js window to other monitor', () =>
        moveShellWindowToOtherMonitor(base, jsWindow.window.window_id),
      )
      const target = await timing.step('resolve visible native target', () =>
        resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
      )
      await timing.step('merge js into native target', () =>
        dragTabOntoTab(base, jsWindow.window.window_id, target.windowId),
      )
      await timing.step('wait for native/js group', () =>
        waitForGroupedMembers(base, [target.windowId, jsWindow.window.window_id], target.windowId),
      )
      const otherNativeId = target.windowId === red.window.window_id ? green.window.window_id : red.window.window_id
      await timing.step('merge second native into grouped target', () =>
        dragTabOntoTab(base, otherNativeId, target.windowId),
      )
      await timing.step('wait for three tab group', () =>
        waitForGroupedMembers(base, [target.windowId, jsWindow.window.window_id, otherNativeId], target.windowId),
      )
      const split = await timing.step('enter split', () => enterSplitViewFromTabMenu(base, target.windowId))
      const hiddenRightWindowId =
        [jsWindow.window.window_id, otherNativeId].find(
          (windowId) => !(split.group.visible_window_ids ?? []).includes(windowId),
        ) ?? null
      assert(hiddenRightWindowId !== null, 'expected a hidden right tab after entering split')
      const initialWidth =
        split.group.split_left_rect!.width +
        split.group.split_right_rect!.width +
        split.group.split_divider_rect!.width
      await timing.step('activate hidden split tab', () => selectTabByClick(base, hiddenRightWindowId))
      const activated = await timing.step('wait for stable split activation', () =>
        waitFor(
          `wait for split activation ${hiddenRightWindowId}`,
          async () => {
            const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
            const group = tabGroupByWindow(shell, hiddenRightWindowId)
            if (!group || group.visible_window_id !== hiddenRightWindowId) return null
            if (!group.split_left_rect || !group.split_right_rect || !group.split_divider_rect) return null
            const width =
              group.split_left_rect.width +
              group.split_right_rect.width +
              group.split_divider_rect.width
            const tol = 56
            if (Math.abs(width - initialWidth) > tol) return null
            return { shell, group }
          },
          3500,
          40,
        ),
      )
      await timing.step('write split activation artifact', () =>
        writeJsonArtifact('tab-groups-split-activation-stable.json', {
          split,
          activated,
          hiddenRightWindowId,
          initialWidth,
        }),
      )
    } finally {
      if (jsWindowId !== null) {
        try {
          await closeWindow(base, jsWindowId)
          await waitForWindowGone(base, jsWindowId)
        } catch {}
      }
    }
  })

  test('split divider keeps both native panes above minimum width', async ({ base, state }) => {
    const timing = createTimingMarks('tab-split-divider')
    const { red, green } = await ensureFreshNativePair(base, state)
    const target = await timing.step('resolve visible native target', () =>
      resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
    )
    const otherWindowId = target.windowId === red.window.window_id ? green.window.window_id : red.window.window_id
    await timing.step('group native windows', () => dragTabOntoTab(base, otherWindowId, target.windowId))
    await timing.step('wait for grouped pair', () =>
      waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], target.windowId),
    )
    const split = await timing.step('enter split', () => enterSplitViewFromTabMenu(base, target.windowId))
    assert(split.group.split_divider_rect, 'missing split divider')
    assert(split.group.split_right_rect, 'missing split right rect')
    const divider = split.group.split_divider_rect
    const start = rectCenter(divider)
    const dragMidX = Math.round(start.x + split.group.split_right_rect.width * 0.35)
    const dragEndX = Math.round(split.group.split_right_rect.x + split.group.split_right_rect.width * 0.7)
    await timing.step('drag split divider', async () => {
      await movePoint(base, start.x, start.y)
      await pointerButton(base, BTN_LEFT, 'press')
      await movePoint(base, start.x + 36, start.y)
      await movePoint(base, dragMidX, start.y)
      await movePoint(base, dragEndX, start.y)
      await pointerButton(base, BTN_LEFT, 'release')
    })
    const resized = await timing.step('wait for resized split panes', () =>
      waitForSplitGroup(base, target.windowId, target.windowId),
    )
    const left = resized.group.split_left_rect!
    const right = resized.group.split_right_rect!
    const rowWidth = left.width + right.width
    assert(left.width / rowWidth >= 0.28, `left pane too narrow: ${left.width}/${rowWidth}`)
    assert(right.width / rowWidth >= 0.28, `right pane too narrow: ${right.width}/${rowWidth}`)
    await timing.step('write split divider artifact', () =>
      writeJsonArtifact('tab-groups-split-divider.json', resized),
    )
  })

  test('split-left tab does not tear out but right tab still can', async ({ base, state }) => {
    const timing = createTimingMarks('tab-split-tear-out-rules')
    let released = false
    try {
      const { red, green } = await ensureFreshNativePair(base, state)
      const target = await timing.step('resolve visible native target', () =>
        resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
      )
      const otherWindowId = target.windowId === red.window.window_id ? green.window.window_id : red.window.window_id
      await timing.step('group native windows', () => dragTabOntoTab(base, otherWindowId, target.windowId))
      await timing.step('wait for grouped pair', () =>
        waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], target.windowId),
      )
      await timing.step('enter split', () => enterSplitViewFromTabMenu(base, target.windowId))

      const leftShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const leftTab = tabRect(leftShell, target.windowId)
      const leftStart = rectCenter(leftTab.tab.rect!)
      await timing.step('attempt left tab tear-out', async () => {
        await movePoint(base, leftStart.x, leftStart.y)
        await pointerButton(base, BTN_LEFT, 'press')
        await movePoint(base, leftStart.x, leftStart.y + 96)
        await pointerButton(base, BTN_LEFT, 'release')
      })
      const stillSplit = await timing.step('confirm split-left stayed grouped', () =>
        waitForSplitGroup(base, target.windowId, target.windowId),
      )
      assert(
        tabGroupByWindow(stillSplit.shell, otherWindowId)?.group_id === stillSplit.group.group_id,
        'split-left tab should stay grouped',
      )

      const rightShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const rightTab = tabRect(rightShell, otherWindowId)
      const rightStart = rectCenter(rightTab.tab.rect!)
      const rr = rightTab.tab.rect!
      const previewPoint = {
        x: Math.min(rightStart.x + 48, rr.global_x + rr.width - 6),
        y: rightStart.y,
      }
      await timing.step('start right tab drag', () => dragTabStep(base, otherWindowId, previewPoint))
      await timing.step('pull right tab out of strip', async () => {
        const endX = previewPoint.x + 24
        const endY = rightTab.tab.rect!.global_y - 96
        for (let step = 1; step <= 16; step += 1) {
          const t = step / 16
          await movePoint(base, previewPoint.x + (endX - previewPoint.x) * t, previewPoint.y + (endY - previewPoint.y) * t)
        }
      })
      await timing.step('wait for right tab detached', () =>
        waitFor(
          `wait for split right tab ${otherWindowId} detached`,
          async () => {
            const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
            const leftGroup = tabGroupByWindow(shell, target.windowId)
            const rightGroup = tabGroupByWindow(shell, otherWindowId)
            if (!leftGroup || !rightGroup || leftGroup.group_id === rightGroup.group_id) return null
            return { shell, leftGroup, rightGroup }
          },
          2000,
          100,
        ),
      )
      await timing.step('release right tab drag', () => finishDrag(base))
      released = true
      const split = await timing.step('confirm right tab became separate group', () =>
        waitFor(
          `wait for split right tab ${otherWindowId} separated`,
          async () => {
            const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
            const leftGroup = tabGroupByWindow(shell, target.windowId)
            const rightGroup = tabGroupByWindow(shell, otherWindowId)
            if (!leftGroup || !rightGroup || leftGroup.group_id === rightGroup.group_id) return null
            if (leftGroup.member_window_ids.length !== 1 || rightGroup.member_window_ids.length !== 1) return null
            return { shell, leftGroup, rightGroup }
          },
          2000,
          125,
        ),
      )
      await timing.step('write split tear-out artifact', () =>
        writeJsonArtifact('tab-groups-split-tear-out.json', split),
      )
    } finally {
      if (!released) {
        try {
          await finishDrag(base)
        } catch {}
      }
    }
  })

  test('grouped tabs keep group geometry, render drag handles, and close via tab buttons', async ({ base, state }) => {
    const timing = createTimingMarks('tab-geometry-and-close')
    let jsWindowId: number | null = null
    try {
      const { red, green } = await ensureFreshNativePair(base, state)
      const initial = await getSnapshots(base)
      if (initial.compositor.outputs.length < 2) {
        throw new SkipError('requires at least two outputs')
      }
      const jsWindow = await timing.step('open js test window', () => openShellTestWindow(base, state))
      jsWindowId = jsWindow.window.window_id
      const movedJs = await timing.step('move js window to other monitor', () =>
        moveShellWindowToOtherMonitor(base, jsWindow.window.window_id),
      )
      const target = await timing.step('resolve visible native target', () =>
        resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
      )
      const merged = await timing.step('merge js tab into native tab', async () => {
        await dragTabOntoTab(base, jsWindow.window.window_id, target.windowId)
        return waitForGroupedMembers(base, [target.windowId, jsWindow.window.window_id], target.windowId)
      })
      const leaderSnapshot = await getSnapshots(base)
      const leaderBeforeSwitch = compositorWindowById(leaderSnapshot.compositor, target.windowId)
      assert(leaderBeforeSwitch, `missing merged leader window ${target.windowId}`)
      const leaderTitlebar = windowTitlebarRect(leaderSnapshot.shell, target.windowId)
      const tabStripHtml = await timing.step('read tab strip html', () =>
        getShellHtml(base, `[data-workspace-tab-strip="${merged.group.group_id}"]`),
      )
      assert(tabStripHtml.includes('data-workspace-tab-handle='), 'missing tab drag handle markup')
      await timing.step('select js tab', () => selectTabByClick(base, jsWindow.window.window_id))
      await timing.step('wait for switched js geometry', () =>
        waitFor(
          'wait for switched js geometry',
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const group = tabGroupByWindow(shell, jsWindow.window.window_id)
            const jsRect = compositorWindowById(compositor, jsWindow.window.window_id)
            const jsTitlebar = shell.window_controls?.find((entry) => entry.window_id === jsWindow.window.window_id)
            if (!group || group.visible_window_id !== jsWindow.window.window_id || !jsRect) return null
            if (!jsTitlebar?.titlebar) return null
            if (jsRect.output_name !== leaderBeforeSwitch.output_name) return null
            if (
              Math.abs(jsTitlebar.titlebar.global_x - leaderTitlebar.global_x) > 12 ||
              Math.abs(jsTitlebar.titlebar.global_y - leaderTitlebar.global_y) > 12
            ) {
              return null
            }
            if (jsRect.x === movedJs.movedWindow.x && jsRect.y === movedJs.movedWindow.y) return null
            return { compositor, shell, group, jsRect, jsTitlebar: jsTitlebar.titlebar }
          },
          2000,
          125,
        ),
      )
      await timing.step('close grouped js tab by button', () => closeTabByClick(base, jsWindow.window.window_id))
      const closed = await timing.step('wait for grouped js tab closed', () =>
        waitFor(
          `wait for grouped js tab ${jsWindow.window.window_id} closed`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            if (compositorWindowById(compositor, jsWindow.window.window_id)) return null
            if (shell.windows.some((window) => window.window_id === jsWindow.window.window_id)) return null
            const group = tabGroupByWindow(shell, target.windowId)
            if (!group || group.member_window_ids.includes(jsWindow.window.window_id)) return null
            const row = taskbarEntry(shell, target.windowId)
            if (!row || row.tab_count !== 1) return null
            return { compositor, shell, group, row }
          },
          2000,
          125,
        ),
      )
      jsWindowId = null
      await timing.step('write tab regression artifact', () =>
        writeJsonArtifact('tab-groups-geometry-close.json', {
          merged,
          closed,
        }),
      )
    } finally {
      if (jsWindowId !== null) {
        try {
          await closeWindow(base, jsWindowId)
          await waitForWindowGone(base, jsWindowId)
        } catch {}
      }
    }
  })

  test('minimized grouped native tab tear-out restores near pointer', async ({ base, state }) => {
    const timing = createTimingMarks('tab-minimized-tear')
    let released = false
    try {
      const { red, green } = await ensureFreshNativePair(base, state)
      const target = await timing.step('resolve visible native target', () =>
        resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
      )
      const otherId = target.windowId === red.window.window_id ? green.window.window_id : red.window.window_id
      await timing.step('group native windows', () => dragTabOntoTab(base, otherId, target.windowId))
      await timing.step('wait for grouped pair', () =>
        waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], target.windowId),
      )
      await timing.step('minimize visible native', () => minimizeWindow(base, target.windowId))
      await timing.step('wait minimized', () => waitForWindowMinimized(base, target.windowId))
      await timing.step('assert compositor geometry survives test minimize', async () => {
        const { compositor } = await getSnapshots(base)
        const cw = compositorWindowById(compositor, target.windowId)
        assert(cw, 'missing compositor window after minimize')
        assert(
          cw.width >= 32 && cw.height >= 32,
          `minimized native should retain non-trivial compositor size (got ${cw.width}x${cw.height})`,
        )
      })
      const shellBeforeDrag = await timing.step('wait shell tab snapshot after minimize', () =>
        waitFor(
          `shell tab surface for ${target.windowId} after minimize`,
          async () => {
            const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
            const peer = shellWindowById(shell, otherId)
            if (!peer || peer.minimized) return null
            try {
              tabRect(shell, target.windowId)
              return shell
            } catch {
              return null
            }
          },
          2000,
          125,
        ),
      )
      const tab = tabRect(shellBeforeDrag, target.windowId)
      const start = rectCenter(tab.tab.rect!)
      const previewPoint = { x: start.x + 40, y: start.y }
      await timing.step('start minimized tab drag', () => dragTabStep(base, target.windowId, previewPoint))
      await timing.step('pull tab out for tear-out', async () => {
        const endX = previewPoint.x + 24
        const endY = start.y - 120
        for (let step = 1; step <= 16; step += 1) {
          const t = step / 16
          await movePoint(base, previewPoint.x + (endX - previewPoint.x) * t, previewPoint.y + (endY - previewPoint.y) * t)
        }
      })
      const torn = await timing.step('wait tear-out unminimized near pointer', () =>
        waitFor(
          `wait torn ${target.windowId} unminimized`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const w = shellWindowById(shell, target.windowId)
            if (!w || w.minimized) return null
            const gOther = tabGroupByWindow(shell, otherId)
            const gTorn = tabGroupByWindow(shell, target.windowId)
            if (!gOther || !gTorn || gOther.group_id === gTorn.group_id) return null
            const px = compositor.pointer?.x
            const py = compositor.pointer?.y
            if (px === undefined || py === undefined) return null
            if (w.x === 0 && w.y === 0) return null
            const cx = w.x + w.width / 2
            const cy = w.y + w.height / 2
            const dist = Math.hypot(cx - px, cy - py)
            if (dist > 420) return null
            return { compositor, shell, w, dist }
          },
          5000,
          125,
        ),
      )
      assert(torn.w.x !== 0 || torn.w.y !== 0, 'torn minimized window should not map to origin')
      assert(torn.dist <= 420, `window center should be near pointer (dist=${torn.dist})`)
      await timing.step('release drag', () => finishDrag(base))
      released = true
      await timing.step('write artifact', () =>
        writeJsonArtifact('tab-groups-minimized-tear-out.json', {
          windowId: target.windowId,
          x: torn.w.x,
          y: torn.w.y,
          dist: torn.dist,
        }),
      )
    } finally {
      if (!released) {
        try {
          await finishDrag(base)
        } catch {}
      }
    }
  })

})
