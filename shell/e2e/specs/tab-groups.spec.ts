import {
  BTN_LEFT,
  SkipError,
  activateTaskbarWindow,
  assert,
  assertTaskbarRowOnMonitor,
  clickRect,
  closeWindow,
  compositorWindowById,
  createTimingMarks,
  defineGroup,
  dragRectToRect,
  ensureNativePair,
  getJson,
  getShellHtml,
  getSnapshots,
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
  waitFor,
  waitForShellUiFocus,
  waitForWindowGone,
  writeJsonArtifact,
  type ShellSnapshot,
} from '../lib/runtime.ts'

function tabRect(shell: ShellSnapshot, windowId: number) {
  const group = tabGroupByWindow(shell, windowId)
  assert(group, `missing tab group for window ${windowId}`)
  const tab = group.tabs.find((entry) => entry.window_id === windowId)
  assert(tab?.rect, `missing tab rect for window ${windowId}`)
  return { group, tab }
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
    return usable ? { compositor, shell, windowId, group, tab } : null
  }

  const visibleCandidates = await Promise.all(windowIds.map((windowId) => candidateState(windowId)))
  const initial = visibleCandidates
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => b.tab.rect!.width * b.tab.rect!.height - a.tab.rect!.width * a.tab.rect!.height || a.windowId - b.windowId)[0]
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

async function dragTabOntoTab(
  base: string,
  sourceWindowId: number,
  target: { x?: number; y?: number; global_x: number; global_y: number; width: number; height: number },
) {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const source = tabRect(shell, sourceWindowId)
  await dragRectToRect(base, source.tab.rect!, {
    x: target.x ?? target.global_x,
    y: target.y ?? target.global_y,
    width: target.width,
    height: target.height,
    global_x: target.global_x,
    global_y: target.global_y,
  })
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
  return waitFor(
    `wait for grouped members ${memberWindowIds.join(',')}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const group = tabGroupByWindow(shell, memberWindowIds[0])
      if (!group) return null
      const members = [...group.member_window_ids].sort((a, b) => a - b)
      const expected = [...memberWindowIds].sort((a, b) => a - b)
      if (members.join(',') !== expected.join(',')) return null
      if (visibleWindowId !== undefined && group.visible_window_id !== visibleWindowId) return null
      return { shell, group }
    },
    8000,
    125,
  )
}

async function selectTabByClick(base: string, windowId: number) {
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
  await runKeybind(base, move.action)
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
    8000,
    125,
  )
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
      const { red, green } = await ensureNativePair(base, state)
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
      await timing.step('drag js tab into native tab', () => dragTabOntoTab(base, jsWindow.window.window_id, target.tab.rect!))
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
        8000,
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
        8000,
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
      const { red, green } = await ensureNativePair(base, state)
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
      await timing.step('drag js tab into native tab', () => dragTabOntoTab(base, jsWindow.window.window_id, target.tab.rect!))
      await timing.step('wait for grouped members', () => waitForGroupedMembers(base, [target.windowId, jsWindow.window.window_id]))
      await timing.step('select js tab', () => selectTabByClick(base, jsWindow.window.window_id))
      const jsFocused = await timing.step('focus grouped js tab', () => waitForShellUiFocus(base, jsWindow.window.window_id))
      const jsSnapshot = shellWindowById(jsFocused.shell, jsWindow.window.window_id)
      assert(jsSnapshot?.output_name, 'missing js test window output')
      const move = pickMonitorMove(compositor.outputs, jsSnapshot.output_name)
      if (!move) {
        throw new SkipError(`no adjacent monitor from ${jsSnapshot.output_name}`)
      }
      await timing.step(`run keybind ${move.action}`, () => runKeybind(base, move.action))
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
        8000,
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

  test('tab menu closes when its window closes', async ({ base, state }) => {
    const timing = createTimingMarks('tab-menu-close-lifecycle')
    const { red, green } = await ensureNativePair(base, state)
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
        8000,
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
      const { red, green } = await ensureNativePair(base, state)
      const jsWindow = await timing.step('open js test window', () => openShellTestWindow(base, state))
      jsWindowId = jsWindow.window.window_id
      await timing.step('move js window to other monitor', () =>
        moveShellWindowToOtherMonitor(base, jsWindow.window.window_id),
      )
      const target = await timing.step('resolve visible native target', () =>
        resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
      )
      await timing.step('merge js tab into native tab', () =>
        dragTabOntoTab(base, jsWindow.window.window_id, target.tab.rect!),
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
          8000,
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
      const { red, green } = await ensureNativePair(base, state)
      const jsWindowA = await timing.step('open first js test window', () => openShellTestWindow(base, state))
      jsWindowIdA = jsWindowA.window.window_id
      await timing.step('move first js window to other monitor', () =>
        moveShellWindowToOtherMonitor(base, jsWindowA.window.window_id),
      )
      const nativeTarget = await timing.step('resolve visible native target', () =>
        resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
      )
      await timing.step('merge first js tab into native tab', () =>
        dragTabOntoTab(base, jsWindowA.window.window_id, nativeTarget.tab.rect!),
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
          8000,
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
      const { red, green } = await ensureNativePair(base, state)
      const jsWindow = await timing.step('open js test window', () => openShellTestWindow(base, state))
      jsWindowId = jsWindow.window.window_id
      await timing.step('move js window to other monitor', () =>
        moveShellWindowToOtherMonitor(base, jsWindow.window.window_id),
      )
      const target = await timing.step('merge js into native target', async () => {
        const visibleNative = await resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id])
        await dragTabOntoTab(base, jsWindow.window.window_id, visibleNative.tab.rect!)
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
          8000,
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
          8000,
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

  test('grouped tabs keep group geometry, render drag handles, and close via tab buttons', async ({ base, state }) => {
    const timing = createTimingMarks('tab-geometry-and-close')
    let jsWindowId: number | null = null
    try {
      const { red, green } = await ensureNativePair(base, state)
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
        await dragTabOntoTab(base, jsWindow.window.window_id, target.tab.rect!)
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
          8000,
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
          8000,
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

})
