import {
  BTN_LEFT,
  KEY,
  SkipError,
  activateTaskbarWindow,
  assert,
  assertRectMinSize,
  assertTaskbarRowOnMonitor,
  comparePngFixture,
  cleanupNativeWindows,
  clickRect,
  closeWindow,
  compositorWindowById,
  compositorWindowStack,
  copyArtifactFile,
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
  postJson,
  pickMonitorMove,
  pointerButton,
  spawnCommand,
  rectCenter,
  rightClickRect,
  runKeybind,
  shellWindowById,
  tabGroupByWindow,
  taskbarForMonitor,
  taskbarEntry,
  tapKey,
  waitFor,
  waitForNativeFocus,
  waitForShellUiFocus,
  waitForWindowGone,
  waitForWindowMinimized,
  windowControls,
  writeJsonArtifact,
  type CompositorSnapshot,
  type E2eState,
  type Rect,
  type ShellSnapshot,
} from '../lib/runtime.ts'
import { fileBrowserSnapshot, openFileBrowserFromLauncher } from '../lib/fileBrowserFixtureNav.ts'

function tabRect(shell: ShellSnapshot, windowId: number) {
  const group = tabGroupByWindow(shell, windowId)
  assert(group, `missing tab group for window ${windowId}`)
  const tab = group.tabs.find((entry) => entry.window_id === windowId)
  assert(tab, `missing tab for window ${windowId}`)
  const rect = tab.rect ?? tab.handle
  assert(rect, `missing tab rect for window ${windowId}`)
  return { group, tab: { ...tab, rect } }
}

async function waitForTabRect(base: string, windowId: number) {
  return waitFor(
    `wait for tab rect ${windowId}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      try {
        return tabRect(shell, windowId)
      } catch {
        return null
      }
    },
    3000,
    40,
  )
}

async function captureWindowContentScreenshot(base: string, windowId: number, name: string) {
  const { compositor } = await getSnapshots(base)
  const window = compositorWindowById(compositor, windowId)
  assert(window, `missing compositor window ${windowId}`)
  assert(window.width > 0 && window.height > 0, `bad compositor window size ${windowId}`)
  const insetX = Math.max(24, Math.floor(window.width * 0.18))
  const insetTop = Math.max(48, Math.floor(window.height * 0.22))
  const insetBottom = Math.max(24, Math.floor(window.height * 0.12))
  const capture = {
    x: window.x + insetX,
    y: window.y + insetTop,
    width: Math.max(64, window.width - insetX * 2),
    height: Math.max(64, window.height - insetTop - insetBottom),
  }
  const screenshot = await postJson<{ path?: string }>(base, '/test/screenshot', {
    x: capture.x,
    y: capture.y,
    width: capture.width,
    height: capture.height,
  })
  assert(typeof screenshot.path === 'string' && screenshot.path.length > 0, `missing screenshot path for ${name}`)
  return {
    capture,
    window,
    path: await copyArtifactFile(`${name}.png`, screenshot.path),
  }
}

async function captureRectScreenshot(base: string, rect: Rect, name: string) {
  const screenshot = await postJson<{ path?: string }>(base, '/test/screenshot', {
    x: rect.global_x,
    y: rect.global_y,
    width: rect.width,
    height: rect.height,
  })
  assert(typeof screenshot.path === 'string' && screenshot.path.length > 0, `missing screenshot path for ${name}`)
  return {
    rect,
    path: await copyArtifactFile(`${name}.png`, screenshot.path),
  }
}

async function captureWindowInteriorScreenshot(base: string, windowId: number, name: string) {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const controls = windowControls(shell, windowId)
  const titlebar = assertRectMinSize(`window ${windowId} titlebar`, controls?.titlebar ?? null, 80, 16)
  const bottomRight = assertRectMinSize(
    `window ${windowId} bottom right resize`,
    controls?.resize_bottom_right ?? null,
    4,
    4,
  )
  const rect = {
    x: titlebar.global_x + 20,
    y: titlebar.global_y + titlebar.height + 20,
    width: Math.max(64, titlebar.width - 40),
    height: Math.max(64, bottomRight.global_y + bottomRight.height - (titlebar.global_y + titlebar.height) - 40),
    global_x: titlebar.global_x + 20,
    global_y: titlebar.global_y + titlebar.height + 20,
  }
  return captureRectScreenshot(base, rect, name)
}

async function captureWindowFrameScreenshot(base: string, windowId: number, name: string) {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const controls = windowControls(shell, windowId)
  const titlebar = assertRectMinSize(`window ${windowId} titlebar`, controls?.titlebar ?? null, 80, 16)
  const bottomRight = assertRectMinSize(
    `window ${windowId} bottom right resize`,
    controls?.resize_bottom_right ?? null,
    4,
    4,
  )
  const rect = {
    x: titlebar.global_x - 4,
    y: titlebar.global_y - 4,
    width: Math.max(96, bottomRight.global_x + bottomRight.width - titlebar.global_x + 8),
    height: Math.max(96, bottomRight.global_y + bottomRight.height - titlebar.global_y + 8),
    global_x: titlebar.global_x - 4,
    global_y: titlebar.global_y - 4,
  }
  return captureRectScreenshot(base, rect, name)
}

async function pressTabAndHold(base: string, windowId: number) {
  const { tab } = await waitForTabRect(base, windowId)
  const rect = assertRectMinSize(`tab ${windowId}`, tab.rect!, 12, 10)
  const point = rectCenter(rect)
  await movePoint(base, point.x, point.y)
  await pointerButton(base, BTN_LEFT, 'press')
  return { rect, point }
}

function tabCloseRect(shell: ShellSnapshot, windowId: number) {
  const { tab } = tabRect(shell, windowId)
  assert(tab.close, `missing tab close rect for window ${windowId}`)
  return tab.close
}

async function waitForWindowTitlebarRect(base: string, windowId: number) {
  return waitFor(
    `wait for titlebar rect ${windowId}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return shell.window_controls?.find((entry) => entry.window_id === windowId)?.titlebar ?? null
    },
    3000,
    40,
  )
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

function titlebarDragPoint(shell: ShellSnapshot, windowId: number) {
  const controls = windowControls(shell, windowId)
  const rect = assertRectMinSize(`titlebar ${windowId}`, controls?.titlebar, 80, 16)
  const group = tabGroupByWindow(shell, windowId)
  const tabRight = Math.max(
    rect.global_x + 24,
    ...(group?.tabs.map((tab) => (tab.rect?.global_x ?? rect.global_x) + (tab.rect?.width ?? 0)) ?? []),
  )
  const controlLeft = controls?.minimize?.global_x ?? rect.global_x + rect.width
  const minX = Math.min(controlLeft - 24, tabRight + 20)
  const maxX = Math.max(minX, controlLeft - 24)
  const preferredX = Math.round(rect.global_x + rect.width * 0.72)
  return {
    x: Math.max(minX, Math.min(maxX, preferredX)),
    y: rect.global_y + Math.max(8, Math.min(rect.height - 8, Math.round(rect.height / 2))),
  }
}

function emptyTabStripPoint(shell: ShellSnapshot, windowId: number) {
  const controls = windowControls(shell, windowId)
  const titlebar = assertRectMinSize(`titlebar ${windowId}`, controls?.titlebar, 80, 16)
  const group = tabGroupByWindow(shell, windowId)
  assert(group, `missing tab group for window ${windowId}`)
  const rightTabs = group.tabs
    .filter((tab) => !tab.split_left && !!tab.rect)
    .map((tab) => tab.rect!)
  const tabsRight = rightTabs.length > 0
    ? Math.max(...rightTabs.map((rect) => rect.global_x + rect.width))
    : titlebar.global_x + 20
  const controlsLeft = controls?.minimize?.global_x ?? titlebar.global_x + titlebar.width
  assert(controlsLeft - tabsRight >= 24, `missing blank tab strip area for window ${windowId}`)
  return {
    x: Math.round(Math.max(tabsRight + 12, controlsLeft - 20)),
    y: titlebar.global_y + Math.max(8, Math.min(titlebar.height - 8, Math.round(titlebar.height / 2))),
  }
}

function nativeContentPoint(shell: ShellSnapshot, windowId: number) {
  const controls = windowControls(shell, windowId)
  const titlebar = assertRectMinSize(`titlebar ${windowId}`, controls?.titlebar, 80, 16)
  const window = shellWindowById(shell, windowId)
  assert(window, `missing shell window ${windowId}`)
  return {
    x: Math.round(titlebar.global_x + titlebar.width / 2),
    y: Math.round(
      titlebar.global_y +
        titlebar.height +
        Math.max(32, Math.min(Math.max(48, window.height - 32), 120)),
    ),
  }
}

async function dragWindowHandleOntoTab(
  base: string,
  sourceWindowId: number,
  start: { x: number; y: number },
  targetWindowId: number,
  dropPoint?: { x: number; y: number },
) {
  const before = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
  if (before.shell_context_menu_visible) {
    await tapKey(base, KEY.escape)
    await waitFor(
      'wait for shell context menu dismissed before window drag',
      async () => {
        const next = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        return next.shell_context_menu_visible ? null : next
      },
      1000,
      40,
    )
  }
  const target = await waitForTabRect(base, targetWindowId)
  await movePoint(base, start.x, start.y)
  await pointerButton(base, BTN_LEFT, 'press')
  await movePoint(base, start.x + 28, start.y)
  let slotRect: Rect | null = null
  try {
    slotRect = await waitFor(
      `wait for window drop slot ${target.group.group_id}`,
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
  const end = dropPoint ?? (slotRect ? rectCenter(slotRect) : rectCenter(target.tab.rect!))
  for (let step = 1; step <= 24; step += 1) {
    const t = step / 24
    await movePoint(base, start.x + 28 + (end.x - (start.x + 28)) * t, start.y + (end.y - start.y) * t)
  }
  await waitFor(
    `wait for window drag target ${sourceWindowId}->${targetWindowId}`,
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const currentTarget = tabGroupByWindow(shell, targetWindowId)
      const dragTarget = shell.tab_drag_target
      if (!currentTarget || !dragTarget) return null
      const targetIndex = currentTarget.member_window_ids.indexOf(targetWindowId)
      const expectedInsertIndex = targetIndex >= 0 ? targetIndex + 1 : currentTarget.member_window_ids.length
      if (compositor.shell_move_window_id !== sourceWindowId) return null
      if (dragTarget.window_id !== sourceWindowId || dragTarget.group_id !== currentTarget.group_id) return null
      if (dragTarget.insert_index !== expectedInsertIndex) return null
      return { compositor, shell, dragTarget }
    },
    2000,
    40,
  )
}

async function dragTabOntoTab(base: string, sourceWindowId: number, targetWindowId: number) {
  let source: ReturnType<typeof tabRect>
  try {
    source = await waitForTabRect(base, sourceWindowId)
  } catch (error) {
    const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    const window = compositorWindowById(compositor, sourceWindowId)
    if (window?.minimized) {
      const shellWithTaskbarRow = await waitFor(
        `wait for minimized source taskbar row ${sourceWindowId}`,
        async () => {
          const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
          return taskbarEntry(next, sourceWindowId)?.activate ? next : null
        },
        2000,
        40,
      )
      await activateTaskbarWindow(base, shellWithTaskbarRow, sourceWindowId)
      source = await waitForTabRect(base, sourceWindowId)
    } else {
      throw error
    }
  }
  const target = await waitForTabRect(base, targetWindowId)
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
  const clickOnce = async (preferHandle: boolean) => {
    const { rect } = await waitFor(
      `wait for tab click target ${windowId}`,
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const group = tabGroupByWindow(shell, windowId)
        const tab = group?.tabs.find((entry) => entry.window_id === windowId)
        const rect = preferHandle ? (tab?.handle ?? tab?.rect) : (tab?.rect ?? tab?.handle)
        if (!rect || rect.width < 12 || rect.height < 10) return null
        return { rect }
      },
      3000,
      40,
    )
    const tabRect = assertRectMinSize(`tab ${windowId}`, rect, 12, 10)
    const c = rectCenter(tabRect)
    await movePoint(base, c.x, c.y)
    await clickRect(base, tabRect)
  }
  const activated = async () =>
    waitFor(
      `wait for tab activation ${windowId}`,
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const group = tabGroupByWindow(shell, windowId)
        if (!group) return null
        const visible = group.visible_window_ids?.includes(windowId) || group.visible_window_id === windowId
        return visible ? { shell, group } : null
      },
      700,
      40,
    )
  await clickOnce(false)
  try {
    await activated()
    return
  } catch {}
  await clickOnce(true)
  await activated()
}

async function selectTabByFastClick(base: string, windowId: number) {
  const { rect } = await waitFor(
    `wait for fast tab click target ${windowId}`,
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
  await clickRect(base, assertRectMinSize(`fast tab ${windowId}`, rect, 12, 10))
}

async function openTabMenu(base: string, windowId: number) {
  const tab = await waitForTabRect(base, windowId)
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

async function waitForSplitGroupMembers(
  base: string,
  windowId: number,
  leftWindowId: number,
  memberWindowIds: number[],
) {
  const expected = [...memberWindowIds].sort((a, b) => a - b).join(',')
  return waitFor(
    `wait for split group members ${memberWindowIds.join(',')}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const group = tabGroupByWindow(shell, windowId)
      if (!group) return null
      if (group.split_left_window_id !== leftWindowId) return null
      if (!group.split_left_rect || !group.split_right_rect || !group.split_divider_rect) return null
      const members = [...group.member_window_ids].sort((a, b) => a - b).join(',')
      return members === expected ? { shell, group } : null
    },
    2000,
    40,
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
          if (group.visible_window_id !== jsWindow.window.window_id) return null
          const row = taskbarEntry(shell, jsWindow.window.window_id)
          if (!row || row.tab_count !== 2) return null
          if (taskbarEntry(shell, target.windowId)) return null
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
      waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], draggedWindowId),
    )
    const anchorTitlebar = await timing.step('wait for grouped titlebar', () =>
      waitFor(
        `wait for grouped titlebar ${draggedWindowId},${target.windowId}`,
        async () => {
          const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
          const group = tabGroupByWindow(shell, draggedWindowId)
          if (!group || group.visible_window_id !== draggedWindowId) return null
          return (
            shell.window_controls?.find((entry) => entry.window_id === draggedWindowId)?.titlebar ??
            shell.window_controls?.find((entry) => entry.window_id === target.windowId)?.titlebar ??
            null
          )
        },
        2000,
        40,
      ),
    )
    const switched = await timing.step('single click hidden dragged tab', async () => {
      await selectTabByClick(base, target.windowId)
      let previewHandoff = null
      try {
        previewHandoff = await waitFor(
          `wait for single click preview handoff ${target.windowId}`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const group = tabGroupByWindow(shell, target.windowId)
            const controls = windowControls(shell, target.windowId)
            if (!group || group.visible_window_id !== target.windowId) return null
            if (compositor.shell_native_drag_preview_window_id !== target.windowId) return null
            if (!controls?.native_drag_preview_rect) return null
            return { compositor, shell, group, controls }
          },
          1000,
          10,
        )
      } catch {}
      const settled = await waitFor(
        `wait for single click switch ${target.windowId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          const group = tabGroupByWindow(shell, target.windowId)
          const switchedTitlebar = shell.window_controls?.find((entry) => entry.window_id === target.windowId)?.titlebar
          const switchedWindow = compositorWindowById(compositor, target.windowId)
          const controls = windowControls(shell, target.windowId)
          if (!group || group.visible_window_id !== target.windowId || !switchedTitlebar || !switchedWindow) return null
          if (compositor.focused_window_id !== target.windowId) return null
          if (switchedWindow.workspace_visible !== true) return null
          if (controls?.native_drag_preview_rect) return null
          if (
            Math.abs(switchedTitlebar.global_x - anchorTitlebar.global_x) > 12 ||
            Math.abs(switchedTitlebar.global_y - anchorTitlebar.global_y) > 12
          ) {
            return null
          }
          return { compositor, shell, group, switchedTitlebar, switchedWindow }
        },
        2000,
        40,
      )
      return { previewHandoff, settled }
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

  test('clicking the active grouped native tab does not arm a preview or switch content', async ({ base, state }) => {
    const timing = createTimingMarks('tab-active-native-click-stable')
    const { red, green } = await ensureFreshNativePair(base, state)
    const target = await timing.step('resolve visible native target', () =>
      resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
    )
    const groupedWindowId = target.windowId === red.window.window_id ? green.window.window_id : red.window.window_id
    await timing.step('group native windows', () => dragTabOntoTab(base, groupedWindowId, target.windowId))
    const grouped = await timing.step('wait for grouped pair', () =>
      waitForGroupedMembers(base, [red.window.window_id, green.window.window_id]),
    )
    const activeWindowId = grouped.group.visible_window_id
    const beforePress = await timing.step('capture active grouped native content before press', () =>
      captureWindowContentScreenshot(base, activeWindowId, 'tab-groups-active-native-click-before'),
    )
    let duringPress: Awaited<ReturnType<typeof captureWindowContentScreenshot>> | null = null
    let contentStable: Awaited<ReturnType<typeof comparePngFixture>> | null = null
    await timing.step('press active grouped native tab', async () => {
      await pressTabAndHold(base, activeWindowId)
      try {
        duringPress = await captureWindowContentScreenshot(base, activeWindowId, 'tab-groups-active-native-click-during')
        contentStable = await comparePngFixture(duringPress.path, beforePress.path, {
          maxDifferentPixels: 0,
          maxChannelDelta: 0,
        })
      } finally {
        await pointerButton(base, BTN_LEFT, 'release')
      }
    })
    const settled = await timing.step('wait for active grouped native tab to stay live', () =>
      waitFor(
        `wait for active grouped native tab ${activeWindowId} stable`,
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          const group = tabGroupByWindow(shell, activeWindowId)
          const controls = windowControls(shell, activeWindowId)
          if (!group || group.visible_window_id !== activeWindowId) return null
          if (compositor.shell_native_drag_preview_window_id !== null) return null
          if (compositor.shell_move_window_id !== null) return null
          if (controls?.native_drag_preview_rect) return null
          return { compositor, shell, group, controls }
        },
        2000,
        40,
      ),
    )
    await timing.step('write active native click artifact', () =>
      writeJsonArtifact('tab-groups-active-native-click-stable.json', {
        grouped,
        beforePress,
        duringPress,
        contentStable,
        settled,
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
      waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], draggedWindowId),
    )
    await timing.step('fast click hidden grouped tab', () => selectTabByFastClick(base, target.windowId))
    const previewHandoff = await timing.step('sample fast click preview handoff', async () => {
      try {
        return await waitFor(
          `wait for fast click preview handoff ${target.windowId}`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const group = tabGroupByWindow(shell, target.windowId)
            const controls = windowControls(shell, target.windowId)
            if (!group || group.visible_window_id !== target.windowId) return null
            if (compositor.shell_native_drag_preview_window_id !== target.windowId) return null
            if (!controls?.native_drag_preview_rect) return null
            return { compositor, shell, group, controls }
          },
          1000,
          10,
        )
      } catch {
        return null
      }
    })
    const switched = await timing.step('wait for fast click switch', () =>
      waitFor(
        `wait for fast click switch ${target.windowId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          const group = tabGroupByWindow(shell, target.windowId)
          const controls = windowControls(shell, target.windowId)
          const switchedWindow = compositorWindowById(compositor, target.windowId)
          if (!group || group.visible_window_id !== target.windowId || !switchedWindow) return null
          if (compositor.focused_window_id !== target.windowId) return null
          if (switchedWindow.workspace_visible !== true) return null
          if (controls?.native_drag_preview_rect) return null
          return { compositor, shell, group, switchedWindow, controls }
        },
        2000,
        40,
      ),
    )
    await timing.step('write fast click artifact', () =>
      writeJsonArtifact('tab-groups-fast-click-switch.json', {
        grouped,
        previewHandoff,
        switched,
        draggedWindowId,
      }),
    )
  })

  test('single-tab tab drag uses window move and drops into another tab bar', async ({ base, state }) => {
    const timing = createTimingMarks('tab-single-window-drag-drop')
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
      const shellBefore = await timing.step('read source tab shell snapshot', () =>
        getJson<ShellSnapshot>(base, '/test/state/shell'),
      )
      const sourceTab = tabRect(shellBefore, jsWindow.window.window_id)
      await timing.step('drag single-tab window by tab into native tab bar', () =>
        dragWindowHandleOntoTab(base, jsWindow.window.window_id, rectCenter(sourceTab.tab.rect!), target.windowId),
      )
      const dragging = await timing.step('wait for compositor-backed tab drag state', () =>
        waitFor(
          `wait for single-tab window drag ${jsWindow.window.window_id}`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const controls = shell.window_controls?.find((entry) => entry.window_id === jsWindow.window.window_id) ?? null
            if (compositor.shell_move_window_id !== jsWindow.window.window_id) return null
            if (!controls?.dragging || (controls.frame_opacity ?? 1) >= 0.99) return null
            const dragTarget = shell.tab_drag_target
            const targetGroup = tabGroupByWindow(shell, target.windowId)
            if (!dragTarget || !targetGroup || dragTarget.group_id !== targetGroup.group_id) return null
            return { compositor, shell, controls, dragTarget }
          },
          2000,
          40,
        ),
      )
      await timing.step('release grouped drop', () => finishDrag(base))
      released = true
      const grouped = await timing.step('wait for merged members', () =>
        waitForGroupedMembers(base, [target.windowId, jsWindow.window.window_id], jsWindow.window.window_id),
      )
      const focused = await timing.step('wait for grouped shell window focus', () =>
        waitForShellUiFocus(base, jsWindow.window.window_id),
      )
      await timing.step('write single-tab drag artifact', () =>
        writeJsonArtifact('tab-groups-single-tab-window-drag.json', {
          dragging,
          grouped,
          focused,
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

  test('titlebar drag drops a grouped native window into empty tab strip area with all tabs', async ({ base, state }) => {
    const timing = createTimingMarks('tab-titlebar-group-drag-drop')
    let jsWindowId: number | null = null
    let released = false
    try {
      const { red, green } = await ensureFreshNativePair(base, state)
      const sourceTarget = await timing.step('resolve source native target', () =>
        resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
      )
      const sourcePeerWindowId =
        sourceTarget.windowId === red.window.window_id ? green.window.window_id : red.window.window_id
      await timing.step('group native source pair', () => dragTabOntoTab(base, sourcePeerWindowId, sourceTarget.windowId))
      const groupedNative = await timing.step('wait for grouped native source', () =>
        waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], sourcePeerWindowId),
      )
      const steadyVisibility = await timing.step('wait for grouped native steady visibility', () =>
        waitFor(
          `wait for grouped native visibility ${sourcePeerWindowId}`,
          async () => {
            const { compositor } = await getSnapshots(base)
            const sourceWindow = compositorWindowById(compositor, sourcePeerWindowId)
            const hiddenWindow = compositorWindowById(compositor, sourceTarget.windowId)
            if (!sourceWindow || !hiddenWindow) return null
            const outputStack = compositor.ordered_window_ids_by_output?.find(
              (entry) => entry.output_name === sourceWindow.output_name,
            )
            if (!outputStack) return null
            if (sourceWindow.workspace_visible !== true || hiddenWindow.workspace_visible !== false) return null
            if (outputStack.window_ids.includes(sourceTarget.windowId)) return null
            return { compositor, sourceWindow, hiddenWindow, outputStack }
          },
          2000,
          40,
        ),
      )
      const jsWindow = await timing.step('open js target window', () => openShellTestWindow(base, state))
      jsWindowId = jsWindow.window.window_id
      await timing.step('move js target window to other monitor', () =>
        moveShellWindowToOtherMonitor(base, jsWindow.window.window_id),
      )
      const shellBefore = await timing.step('read grouped source shell snapshot', () =>
        getJson<ShellSnapshot>(base, '/test/state/shell'),
      )
      await timing.step('drag grouped native titlebar onto js empty tab strip area', () =>
        dragWindowHandleOntoTab(
          base,
          sourcePeerWindowId,
          titlebarDragPoint(shellBefore, sourcePeerWindowId),
          jsWindow.window.window_id,
          emptyTabStripPoint(shellBefore, jsWindow.window.window_id),
        ),
      )
      const dragging = await timing.step('wait for grouped native drag state', () =>
        waitFor(
          `wait for grouped native drag ${sourcePeerWindowId}`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const controls = shell.window_controls?.find((entry) => entry.window_id === sourcePeerWindowId) ?? null
            const sourceWindow = compositorWindowById(compositor, sourcePeerWindowId)
            const hiddenWindow = compositorWindowById(compositor, sourceTarget.windowId)
            const dragTarget = shell.tab_drag_target
            const targetGroup = tabGroupByWindow(shell, jsWindow.window.window_id)
            if (!controls?.dragging || (controls.frame_opacity ?? 1) >= 0.99) return null
            if (!sourceWindow || (sourceWindow.render_alpha ?? 1) >= 0.99) return null
            if (!hiddenWindow || hiddenWindow.workspace_visible !== false) return null
            if (compositor.shell_move_window_id !== sourcePeerWindowId) return null
            if (!dragTarget || !targetGroup || dragTarget.group_id !== targetGroup.group_id) return null
            return { compositor, shell, controls, sourceWindow, hiddenWindow, dragTarget }
          },
          2000,
          40,
        ),
      )
      await timing.step('release grouped native drop', () => finishDrag(base))
      released = true
      const merged = await timing.step('wait for whole group merged into js tab bar', () =>
        waitForGroupedMembers(
          base,
          [red.window.window_id, green.window.window_id, jsWindow.window.window_id],
          sourcePeerWindowId,
        ),
      )
      const focused = await timing.step('wait for grouped native focus after drop', () =>
        waitForNativeFocus(base, sourcePeerWindowId),
      )
      await timing.step('write titlebar drag artifact', () =>
        writeJsonArtifact('tab-groups-titlebar-group-drag.json', {
          grouped_native: groupedNative,
          steady_visibility: steadyVisibility,
          dragging,
          merged,
          focused,
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

  test('grouped native titlebar drag released over native content does not stay stuck', async ({ base, state }) => {
    const timing = createTimingMarks('tab-titlebar-release-over-native')
    let jsWindowId: number | null = null
    let released = false
    try {
      const { red, green } = await ensureFreshNativePair(base, state)
      const sourceTarget = await timing.step('resolve source native target', () =>
        resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
      )
      const releaseProbeWindowId =
        sourceTarget.windowId === red.window.window_id ? green.window.window_id : red.window.window_id
      const jsWindow = await timing.step('open js tab source', () => openShellTestWindow(base, state))
      jsWindowId = jsWindow.window.window_id
      await timing.step('move js source to other monitor', () =>
        moveShellWindowToOtherMonitor(base, jsWindow.window.window_id),
      )
      await timing.step('group js tab into native source', () =>
        dragTabOntoTab(base, jsWindow.window.window_id, sourceTarget.windowId),
      )
      await timing.step('wait for grouped native/js source', () =>
        waitForGroupedMembers(base, [sourceTarget.windowId, jsWindow.window.window_id], jsWindow.window.window_id),
      )
      await timing.step('select native tab for grouped drag', () => selectTabByClick(base, sourceTarget.windowId))
      await timing.step('wait for native tab focus before grouped drag', () => waitForNativeFocus(base, sourceTarget.windowId))
      const shellBefore = await timing.step('read grouped source shell snapshot', () =>
        getJson<ShellSnapshot>(base, '/test/state/shell'),
      )
      const { compositor: compositorBeforeDrag } = await timing.step('read grouped source compositor snapshot', () =>
        getSnapshots(base),
      )
      const sourceBeforeDrag = compositorWindowById(compositorBeforeDrag, sourceTarget.windowId)
      assert(sourceBeforeDrag, `missing source window ${sourceTarget.windowId} before drag`)
      const start = titlebarDragPoint(shellBefore, sourceTarget.windowId)
      const releasePoint = nativeContentPoint(shellBefore, releaseProbeWindowId)
      await timing.step('start grouped native drag over release probe', async () => {
        await movePoint(base, start.x, start.y)
        await pointerButton(base, BTN_LEFT, 'press')
        await movePoint(base, start.x + 28, start.y)
        for (let step = 1; step <= 20; step += 1) {
          const t = step / 20
          await movePoint(
            base,
            start.x + 28 + (releasePoint.x - (start.x + 28)) * t,
            start.y + (releasePoint.y - start.y) * t,
          )
        }
      })
      await timing.step('wait for grouped native drag to keep moving over native content', () =>
        waitFor(
          `wait for grouped native motion ${sourceTarget.windowId}`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const controls = shell.window_controls?.find((entry) => entry.window_id === sourceTarget.windowId) ?? null
            const sourceWindow = compositorWindowById(compositor, sourceTarget.windowId)
            if (!controls?.dragging || !sourceWindow) return null
            if (compositor.shell_move_window_id !== sourceTarget.windowId) return null
            const moved = Math.hypot(
              sourceWindow.x - sourceBeforeDrag.x,
              sourceWindow.y - sourceBeforeDrag.y,
            )
            if (moved < 140) return null
            return { compositor, shell, sourceWindow, moved }
          },
          2000,
          40,
        ),
      )
      await timing.step('wait for grouped native drag state', () =>
        waitFor(
          `wait for grouped native drag ${sourceTarget.windowId}`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const controls = shell.window_controls?.find((entry) => entry.window_id === sourceTarget.windowId) ?? null
            const sourceWindow = compositorWindowById(compositor, sourceTarget.windowId)
            if (!controls?.dragging || !sourceWindow) return null
            if (compositor.shell_move_window_id !== sourceTarget.windowId) return null
            return { compositor, shell, controls, sourceWindow }
          },
          2000,
          40,
        ),
      )
      const releasedState = await timing.step('release drag over native content', async () => {
        await pointerButton(base, BTN_LEFT, 'release')
        released = true
        return waitFor(
          `wait for drag release ${sourceTarget.windowId}`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const controls = shell.window_controls?.find((entry) => entry.window_id === sourceTarget.windowId) ?? null
            if (compositor.shell_move_window_id !== null) return null
            if (controls?.dragging) return null
            if (shell.tab_drag_target) return null
            const window = compositorWindowById(compositor, sourceTarget.windowId)
            if (!window) return null
            if ((controls?.frame_opacity ?? 1) < 0.99) return null
            return { compositor, shell, window, controls }
          },
          2000,
          40,
        )
      })
      const afterRelease = releasedState.window
      const movedAfterRelease = await timing.step('move pointer after release and confirm no continued drag', async () => {
        await movePoint(base, releasePoint.x + 160, releasePoint.y + 90)
        return waitFor(
          `wait for no stuck drag ${sourceTarget.windowId}`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const window = compositorWindowById(compositor, sourceTarget.windowId)
            const controls = shell.window_controls?.find((entry) => entry.window_id === sourceTarget.windowId) ?? null
            if (!window) return null
            if (compositor.shell_move_window_id !== null) return null
            if (controls?.dragging) return null
            if (window.x !== afterRelease.x || window.y !== afterRelease.y) return null
            return { compositor, shell, window, controls }
          },
          2000,
          40,
        )
      })
      await timing.step('write release-over-native artifact', () =>
        writeJsonArtifact('tab-groups-titlebar-release-over-native.json', {
          released_state: releasedState,
          moved_after_release: movedAfterRelease,
          release_probe_window_id: releaseProbeWindowId,
          source_group_window_ids: [sourceTarget.windowId, jsWindow.window.window_id],
        }),
      )
    } finally {
      if (!released) {
        try {
          await pointerButton(base, BTN_LEFT, 'release')
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
        waitForGroupedMembers(base, [target.windowId, jsWindow.window.window_id], jsWindow.window.window_id),
      )
      const draggedWindowId = jsWindow.window.window_id
      const remainingWindowId = target.windowId
      const draggedTab = await timing.step('wait for dragged tab rect', () => waitForTabRect(base, draggedWindowId))
      const dragStart = rectCenter(draggedTab.tab.rect!)
      const previewPoint = {
        x: Math.min(dragStart.x + 48, draggedTab.tab.rect!.global_x + draggedTab.tab.rect!.width - 6),
        y: dragStart.y,
      }
      await timing.step('start grouped tab drag', () => dragTabStep(base, draggedWindowId, previewPoint))
      const tearOutPoint = {
        x: previewPoint.x + 24,
        y: draggedTab.tab.rect!.global_y - 96,
      }
      await timing.step('move grouped tab out of strip', () => movePoint(base, tearOutPoint.x, tearOutPoint.y))
      const detachedDuringDrag = await timing.step('wait for tear-out during drag', () =>
        waitFor(
          `wait for dragged tab ${draggedWindowId} detached`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
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
            if (compositor.shell_move_window_id !== draggedWindowId) return null
            return { compositor, shell, draggedGroup, remainingGroup, draggedWindow }
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
            if (compositor.shell_move_window_id !== null) return null
            if (compositor.shell_pointer_grab_window_id !== null) return null
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

  test('dragging grouped native tab tears out and keeps moving during the same drag', async ({ base, state }) => {
    const timing = createTimingMarks('tab-tear-out-native-real-window')
    let released = false
    try {
      const { red, green } = await ensureFreshNativePair(base, state)
      const target = await timing.step('resolve visible native target', () =>
        resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
      )
      const groupedWindowId = target.windowId === red.window.window_id ? green.window.window_id : red.window.window_id
      const draggedWindowId = target.windowId
      await timing.step('group native windows', () => dragTabOntoTab(base, groupedWindowId, target.windowId))
      const merged = await timing.step('wait for grouped native members', () =>
        waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], groupedWindowId),
      )
      const draggedTab = await timing.step('wait for grouped native dragged tab rect', () => waitForTabRect(base, draggedWindowId))
      const visibleBeforePreTearOut = await timing.step('capture grouped native frame before pre-tear-out drag', () =>
        captureWindowFrameScreenshot(base, groupedWindowId, 'tab-groups-native-before-pretearout-frame'),
      )
      const dragStart = rectCenter(draggedTab.tab.rect!)
      const previewPoint = {
        x: Math.min(dragStart.x + 48, draggedTab.tab.rect!.global_x + draggedTab.tab.rect!.width - 6),
        y: dragStart.y,
      }
      await timing.step('start grouped native tab drag', () => dragTabStep(base, draggedWindowId, previewPoint))
      const visibleDuringPreTearOut = await timing.step('capture grouped native frame during pre-tear-out drag', () =>
        captureWindowFrameScreenshot(base, groupedWindowId, 'tab-groups-native-during-pretearout-frame'),
      )
      const noInlinePreviewBeforeTearOut = await timing.step('confirm grouped native drag stays live before tear-out', () =>
        waitFor(
          `wait for grouped native tab ${draggedWindowId} live before tear-out`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const group = tabGroupByWindow(shell, draggedWindowId)
            const controls = windowControls(shell, draggedWindowId)
            if (!group || group.group_id !== merged.group.group_id) return null
            if (compositor.shell_move_window_id !== null) return null
            if (controls?.native_drag_preview_rect) return null
            return { compositor, shell, group, controls }
          },
          2000,
          20,
        ),
      )
      const tearOutPoint = {
        x: previewPoint.x + 24,
        y: draggedTab.tab.rect!.global_y - 96,
      }
      await timing.step('move grouped native tab out of strip', () => movePoint(base, tearOutPoint.x, tearOutPoint.y))
      const detachedDuringDrag = await timing.step('wait for grouped native tear-out during drag', () =>
        waitFor(
          `wait for grouped native tab ${draggedWindowId} detached`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const draggedGroup = tabGroupByWindow(shell, draggedWindowId)
            const remainingGroup = tabGroupByWindow(shell, groupedWindowId)
            const draggedWindow = compositorWindowById(compositor, draggedWindowId)
            const controls = windowControls(shell, draggedWindowId)
            if (!draggedGroup || !remainingGroup || draggedGroup.group_id === remainingGroup.group_id) return null
            if (!draggedWindow || !controls?.dragging) return null
            if (compositor.shell_move_window_id !== draggedWindowId) return null
            return { compositor, shell, draggedGroup, remainingGroup, draggedWindow, controls }
          },
          5000,
          100,
        ),
      )
      const continuedPoint = {
        x: tearOutPoint.x + 120,
        y: tearOutPoint.y - 24,
      }
      await timing.step('continue moving grouped native torn-out tab', async () => {
        for (let step = 1; step <= 12; step += 1) {
          const t = step / 12
          await movePoint(
            base,
            tearOutPoint.x + (continuedPoint.x - tearOutPoint.x) * t,
            tearOutPoint.y + (continuedPoint.y - tearOutPoint.y) * t,
          )
        }
      })
      const continued = await timing.step('wait for grouped native torn-out tab to keep moving', () =>
        waitFor(
          `wait for grouped native tab ${draggedWindowId} continued move`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const draggedWindow = compositorWindowById(compositor, draggedWindowId)
            const controls = windowControls(shell, draggedWindowId)
            if (!draggedWindow || !controls?.dragging) return null
            if (compositor.shell_move_window_id !== draggedWindowId) return null
            if (
              draggedWindow.x === detachedDuringDrag.draggedWindow.x &&
              draggedWindow.y === detachedDuringDrag.draggedWindow.y
            ) {
              return null
            }
            return { compositor, shell, draggedWindow, controls }
          },
          5000,
          100,
        ),
      )
      await timing.step('release grouped native tear-out drag', () => finishDrag(base))
      released = true
      const releasedState = await timing.step('wait for grouped native tear-out release', () =>
        waitFor(
          `wait for grouped native tab ${draggedWindowId} release`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const draggedWindow = compositorWindowById(compositor, draggedWindowId)
            const controls = windowControls(shell, draggedWindowId)
            if (!draggedWindow) return null
            if (compositor.shell_move_window_id !== null) return null
            if (controls?.dragging) return null
            return { compositor, shell, draggedWindow, controls }
          },
          5000,
          100,
        ),
      )
      await timing.step('write grouped native tear-out artifact', () =>
        writeJsonArtifact('tab-groups-native-drag-preview-unmerge.json', {
          merged,
          visibleBeforePreTearOut,
          visibleDuringPreTearOut,
          noInlinePreviewBeforeTearOut,
          detachedDuringDrag,
          continued,
          releasedState,
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

  test('dragging a grouped foot tab out of a file browser group keeps moving during the same drag', async ({ base, state }) => {
    const timing = createTimingMarks('tab-tear-out-file-browser-foot')
    let released = false
    let footWindowId: number | null = null
    try {
      const opened = await timing.step('open file browser window', () =>
        openFileBrowserFromLauncher(base, state.spawnedShellWindowIds),
      )
      const fileBrowserWindowId = opened.windowId
      const before = await timing.step('capture known compositor windows before foot', () => getSnapshots(base))
      const knownWindowIds = new Set(before.compositor.windows.map((window) => window.window_id))
      await timing.step('spawn foot terminal', () => spawnCommand(base, 'foot'))
      const footWindow = await timing.step('wait for foot terminal window', () =>
        waitFor(
          'wait for grouped foot window',
          async () => {
            const { compositor } = await getSnapshots(base)
            return (
              compositor.windows.find(
                (entry) => !entry.shell_hosted && !knownWindowIds.has(entry.window_id) && entry.app_id === 'foot',
              ) ?? null
            )
          },
          5000,
          100,
        ),
      )
      footWindowId = footWindow.window_id
      state.spawnedNativeWindowIds.add(footWindowId)
      const compositorFootAboveFileBrowser = (compositor: CompositorSnapshot) => {
        const stack = compositorWindowStack(compositor)
        const footIndex = stack.indexOf(footWindowId!)
        const fileBrowserIndex = stack.indexOf(fileBrowserWindowId)
        if (footIndex < 0 || fileBrowserIndex < 0) return null
        return footIndex < fileBrowserIndex ? compositor : null
      }
      await timing.step('raise spawned foot above file browser', async () => {
        const snapshots = await getSnapshots(base)
        if (
          !compositorFootAboveFileBrowser(snapshots.compositor) &&
          snapshots.compositor.focused_window_id !== footWindowId &&
          snapshots.shell.focused_window_id !== footWindowId
        ) {
          const shellWithTaskbarRow = await waitFor(
            `wait for foot taskbar row ${footWindowId}`,
            async () => {
              const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
              return taskbarEntry(next, footWindowId!)?.activate ? next : null
            },
            2000,
            40,
          )
          await activateTaskbarWindow(base, shellWithTaskbarRow, footWindowId!)
        }
      })
      await timing.step('merge foot window into file browser tab', async () => {
        await dragTabOntoTab(base, footWindowId!, fileBrowserWindowId)
      })
      const merged = await timing.step('wait for file browser and foot grouped', () =>
        waitForGroupedMembers(base, [fileBrowserWindowId, footWindowId!], footWindowId!),
      )
      const activeFootFrameBeforeHold = await timing.step('capture active grouped foot frame before tab hold', () =>
        captureWindowFrameScreenshot(base, footWindowId!, 'tab-groups-file-browser-foot-active-before-hold-frame'),
      )
      const activeFootContentBeforeHold = await timing.step('capture active grouped foot content before tab hold', () =>
        captureWindowInteriorScreenshot(base, footWindowId!, 'tab-groups-file-browser-foot-active-before-hold-content'),
      )
      let activeFootFrameDuringHold: Awaited<ReturnType<typeof captureRectScreenshot>> | null = null
      let activeFootContentDuringHold: Awaited<ReturnType<typeof captureRectScreenshot>> | null = null
      let activeFootContentStable: Awaited<ReturnType<typeof comparePngFixture>> | null = null
      const activeFootHoldStable = await timing.step('hold active grouped foot tab without hiding native content', async () => {
        await pressTabAndHold(base, footWindowId!)
        try {
          const stable = await waitFor(
            `wait for active grouped foot ${footWindowId} hold to stay live`,
            async () => {
              const { compositor, shell } = await getSnapshots(base)
              const group = tabGroupByWindow(shell, footWindowId!)
              const controls = windowControls(shell, footWindowId!)
              if (!group || group.visible_window_id !== footWindowId) return null
              if (compositor.shell_native_drag_preview_window_id !== null) return null
              if (compositor.shell_move_window_id !== null) return null
              if (controls?.native_drag_preview_rect) return null
              return { compositor, shell, group, controls }
            },
            2000,
            40,
          )
          activeFootFrameDuringHold = await captureRectScreenshot(
            base,
            activeFootFrameBeforeHold.rect,
            'tab-groups-file-browser-foot-active-during-hold-frame',
          )
          activeFootContentDuringHold = await captureRectScreenshot(
            base,
            activeFootContentBeforeHold.rect,
            'tab-groups-file-browser-foot-active-during-hold-content',
          )
          activeFootContentStable = await comparePngFixture(activeFootContentDuringHold.path, activeFootContentBeforeHold.path, {
            maxDifferentPixels: 4000,
            maxChannelDelta: 16,
          })
          return stable
        } finally {
          await pointerButton(base, BTN_LEFT, 'release')
        }
      })
      await timing.step('select file browser tab in mixed group', () => selectTabByClick(base, fileBrowserWindowId))
      const hiddenFoot = await timing.step('wait for file browser visible and foot hidden', () =>
        waitForGroupedMembers(base, [fileBrowserWindowId, footWindowId!], fileBrowserWindowId),
      )
      const hiddenFootBeforePrewarm = await timing.step(
        'capture hidden grouped foot geometry before preview prewarm',
        () => getSnapshots(base),
      )
      const visibleFileBrowserRect = await timing.step('resolve visible file browser row rect before hidden tab hold', async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const row = fileBrowserSnapshot(shell, fileBrowserWindowId)?.rows.find((entry) => entry.rect) ?? null
        assert(row?.rect, `missing file browser row rect for window ${fileBrowserWindowId}`)
        return row.rect
      })
      await timing.step('click visible file browser content before hidden tab hold', () =>
        clickRect(base, visibleFileBrowserRect),
      )
      const draggedTab = await timing.step('wait for hidden grouped foot tab rect', () => waitForTabRect(base, footWindowId!))
      await timing.step('move pointer onto hidden grouped foot tab before content capture', () => {
        const start = rectCenter(draggedTab.tab.rect!)
        return movePoint(base, start.x, start.y)
      })
      const visibleFrameBeforeHold = await timing.step('capture visible file browser frame before hidden tab hold', () =>
        captureWindowFrameScreenshot(base, fileBrowserWindowId, 'tab-groups-file-browser-foot-before-hold-frame'),
      )
      const visibleBeforeHold = await timing.step('capture visible file browser content before hidden tab hold', () =>
        captureWindowInteriorScreenshot(base, fileBrowserWindowId, 'tab-groups-file-browser-foot-before-hold'),
      )
      let visibleFrameDuringHold: Awaited<ReturnType<typeof captureRectScreenshot>> | null = null
      let visibleDuringHold: Awaited<ReturnType<typeof captureRectScreenshot>> | null = null
      let holdContentStable: Awaited<ReturnType<typeof comparePngFixture>> | null = null
      const holdStable = await timing.step('hold hidden grouped foot tab without tearing out', async () => {
        await pressTabAndHold(base, footWindowId!)
        try {
          const stable = await waitFor(
            `wait for grouped foot ${footWindowId} hold to stay live`,
            async () => {
              const { compositor, shell } = await getSnapshots(base)
              const group = tabGroupByWindow(shell, footWindowId!)
              const controls = windowControls(shell, footWindowId!)
              if (!group || group.visible_window_id !== fileBrowserWindowId) return null
              if (compositor.shell_native_drag_preview_window_id !== null) return null
              if (compositor.shell_move_window_id !== null) return null
              if (controls?.native_drag_preview_rect) return null
              return { compositor, shell, group, controls }
            },
            2000,
            40,
          )
          visibleFrameDuringHold = await captureWindowFrameScreenshot(
            base,
            fileBrowserWindowId,
            'tab-groups-file-browser-foot-during-hold-frame',
          )
          visibleDuringHold = await captureWindowInteriorScreenshot(
            base,
            fileBrowserWindowId,
            'tab-groups-file-browser-foot-during-hold',
          )
          holdContentStable = await comparePngFixture(visibleDuringHold.path, visibleBeforeHold.path, {
            maxDifferentPixels: 24,
            maxChannelDelta: 8,
          })
          return stable
        } finally {
          await pointerButton(base, BTN_LEFT, 'release')
        }
      })
      await timing.step('restore file browser tab after hidden tab hold', () => selectTabByClick(base, fileBrowserWindowId))
      await timing.step('wait for file browser visible again after hidden tab hold', () =>
        waitForGroupedMembers(base, [fileBrowserWindowId, footWindowId!], fileBrowserWindowId),
      )
      const dragStart = rectCenter(draggedTab.tab.rect!)
      const previewSlots = draggedTab.group.drop_slots ?? []
      const previewSlot = previewSlots[previewSlots.length - 1]?.rect ?? null
      const previewPoint = {
        x: previewSlot ? previewSlot.global_x + Math.round(previewSlot.width / 2) : dragStart.x + 64,
        y: previewSlot ? previewSlot.global_y + Math.round(previewSlot.height / 2) : dragStart.y,
      }
      await timing.step('start hidden grouped foot tab drag', () => dragTabStep(base, footWindowId!, previewPoint))
      const visibleFrameDuringPreTearOut = await timing.step(
        'capture visible file browser frame during hidden grouped foot pre-tear-out drag',
        () => captureWindowFrameScreenshot(base, fileBrowserWindowId, 'tab-groups-file-browser-foot-pretearout-frame'),
      )
      const visibleDuringPreTearOut = await timing.step(
        'capture visible file browser content during hidden grouped foot pre-tear-out drag',
        () => captureWindowInteriorScreenshot(base, fileBrowserWindowId, 'tab-groups-file-browser-foot-pretearout-content'),
      )
      const preTearOutContentStable = await timing.step(
        'compare visible file browser content during hidden grouped foot pre-tear-out drag',
        () =>
          comparePngFixture(visibleDuringPreTearOut.path, visibleBeforeHold.path, {
            maxDifferentPixels: 24,
            maxChannelDelta: 8,
          }),
      )
      const armedBeforeTearOut = await timing.step('capture hidden grouped foot drag before tear-out', () =>
        getSnapshots(base),
      )
      await timing.step('write hidden grouped foot pre-tear-out artifact', () =>
        writeJsonArtifact('tab-groups-file-browser-foot-pretearout.json', armedBeforeTearOut),
      )
      const armedGroupedFoot = tabGroupByWindow(armedBeforeTearOut.shell, footWindowId!)
      const armedGroupedFileBrowser = tabGroupByWindow(armedBeforeTearOut.shell, fileBrowserWindowId)
      const armedControls = windowControls(armedBeforeTearOut.shell, footWindowId!)
      assert(
        armedGroupedFoot && armedGroupedFileBrowser && armedGroupedFoot.group_id === armedGroupedFileBrowser.group_id,
        'hidden grouped foot should remain in the file browser group before tear-out',
      )
      assert(
        armedGroupedFoot.visible_window_id === fileBrowserWindowId,
        'file browser should stay visible before hidden foot tears out',
      )
      assert(
        armedBeforeTearOut.compositor.shell_move_window_id === null,
        'hidden grouped foot should not start a compositor move before tear-out',
      )
      assert(
        armedBeforeTearOut.compositor.shell_native_drag_preview_window_id === null,
        'hidden grouped foot should not arm a native drag preview before tear-out',
      )
      assert(
        armedControls?.titlebar == null,
        'hidden grouped foot should not expose a detached shell frame before tear-out',
      )
      assert(
        armedControls?.native_drag_preview_rect == null,
        'hidden grouped foot should not show a native drag preview before tear-out',
      )
      const tearOutPoint = {
        x: previewPoint.x + 24,
        y: draggedTab.tab.rect!.global_y - 96,
      }
      await timing.step('move grouped foot tab out of strip', () => movePoint(base, tearOutPoint.x, tearOutPoint.y))
      const detachedPreview = await timing.step('wait for grouped foot preview visible during tear-out', () =>
        waitFor(
          `wait for grouped foot ${footWindowId} tear-out preview`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const draggedGroup = tabGroupByWindow(shell, footWindowId!)
            const remainingGroup = tabGroupByWindow(shell, fileBrowserWindowId)
            const controls = windowControls(shell, footWindowId!)
            if (!draggedGroup || !remainingGroup || draggedGroup.group_id === remainingGroup.group_id) return null
            if (!controls?.dragging || !controls.native_drag_preview_rect) return null
            return { compositor, shell, draggedGroup, remainingGroup, controls }
          },
          5000,
          10,
        ),
      )
      const detachedDuringDrag = await timing.step('wait for grouped foot tear-out during drag', () =>
        waitFor(
          `wait for grouped foot ${footWindowId} detached`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const draggedGroup = tabGroupByWindow(shell, footWindowId!)
            const remainingGroup = tabGroupByWindow(shell, fileBrowserWindowId)
            const draggedWindow = compositorWindowById(compositor, footWindowId!)
            const controls = windowControls(shell, footWindowId!)
            if (!draggedGroup || !remainingGroup || draggedGroup.group_id === remainingGroup.group_id) return null
            if (!draggedWindow || !controls?.dragging) return null
            if (compositor.shell_move_window_id !== footWindowId) return null
            return { compositor, shell, draggedGroup, remainingGroup, draggedWindow, controls }
          },
          5000,
          100,
        ),
      )
      const continuedPoint = {
        x: tearOutPoint.x + 120,
        y: tearOutPoint.y - 24,
      }
      await timing.step('continue moving grouped foot torn-out tab', async () => {
        for (let step = 1; step <= 12; step += 1) {
          const t = step / 12
          await movePoint(
            base,
            tearOutPoint.x + (continuedPoint.x - tearOutPoint.x) * t,
            tearOutPoint.y + (continuedPoint.y - tearOutPoint.y) * t,
          )
        }
      })
      const continued = await timing.step('wait for grouped foot torn-out tab to keep moving', () =>
        waitFor(
          `wait for grouped foot ${footWindowId} continued move`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const draggedWindow = compositorWindowById(compositor, footWindowId!)
            const controls = windowControls(shell, footWindowId!)
            if (!draggedWindow || !controls?.dragging) return null
            if (compositor.shell_move_window_id !== footWindowId) return null
            if (
              draggedWindow.x === detachedDuringDrag.draggedWindow.x &&
              draggedWindow.y === detachedDuringDrag.draggedWindow.y
            ) {
              return null
            }
            return { compositor, shell, draggedWindow, controls }
          },
          5000,
          100,
        ),
      )
      await timing.step('release grouped foot tear-out drag', () => finishDrag(base))
      released = true
      const releasedState = await timing.step('wait for grouped foot tear-out release', () =>
        waitFor(
          `wait for grouped foot ${footWindowId} release`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const draggedWindow = compositorWindowById(compositor, footWindowId!)
            const controls = windowControls(shell, footWindowId!)
            if (!draggedWindow) return null
            if (compositor.shell_move_window_id !== null) return null
            if (controls?.dragging) return null
            return { compositor, shell, draggedWindow, controls }
          },
          5000,
          100,
        ),
      )
      await timing.step('write file browser foot tear-out artifact', () =>
        writeJsonArtifact('tab-groups-file-browser-foot-unmerge.json', {
          merged,
          activeFootFrameBeforeHold,
          activeFootContentBeforeHold,
          activeFootFrameDuringHold,
          activeFootContentDuringHold,
          activeFootContentStable,
          activeFootHoldStable,
          hiddenFoot,
          hiddenFootBeforePrewarm,
          visibleFrameBeforeHold,
          visibleFrameDuringHold,
          armedBeforeTearOut,
          visibleBeforeHold,
          visibleDuringHold,
          holdContentStable,
          holdStable,
          visibleFrameDuringPreTearOut,
          visibleDuringPreTearOut,
          preTearOutContentStable,
          detachedPreview,
          detachedDuringDrag,
          continued,
          releasedState,
        }),
      )
    } finally {
      if (!released) {
        try {
          await finishDrag(base)
        } catch {}
      }
      if (footWindowId !== null) {
        state.spawnedNativeWindowIds.add(footWindowId)
      }
    }
  })

  test('merging and tearing out a file browser tab keeps the shell window mounted and loaded', async ({ base, state }) => {
    const timing = createTimingMarks('tab-file-browser-merge-tear-out-stable')
    let released = false
    const jsWindow = await timing.step('open js target window', () => openShellTestWindow(base, state))
    const fileBrowser = await timing.step('open file browser window', () =>
      openFileBrowserFromLauncher(base, state.spawnedShellWindowIds),
    )
    const targetWindowId = jsWindow.window.window_id
    const fileBrowserWindowId = fileBrowser.windowId
    const beforeReady = await timing.step('wait for file browser ready before merge', () =>
      waitFor(
        `wait for file browser ${fileBrowserWindowId} ready`,
        async () => {
          const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
          const fb = fileBrowserSnapshot(shell, fileBrowserWindowId)
          if (!fb || fb.list_state !== 'ready' || !fb.active_path) return null
          if (typeof fb.mount_seq !== 'number' || typeof fb.load_count !== 'number') return null
          return { shell, fb }
        },
        5000,
        100,
      ),
    )
    try {
      await timing.step('merge file browser tab into js target', () =>
        dragTabOntoTab(base, fileBrowserWindowId, targetWindowId),
      )
      const afterMerge = await timing.step('wait for merged ready file browser', () =>
        waitFor(
          `wait for merged file browser ${fileBrowserWindowId}`,
          async () => {
            const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
            const group = tabGroupByWindow(shell, fileBrowserWindowId)
            const targetGroup = tabGroupByWindow(shell, targetWindowId)
            const fb = fileBrowserSnapshot(shell, fileBrowserWindowId)
            if (!group || !targetGroup || group.group_id !== targetGroup.group_id) return null
            if (!fb || fb.list_state !== 'ready' || !fb.active_path) return null
            if (fb.mount_seq !== beforeReady.fb.mount_seq || fb.load_count !== beforeReady.fb.load_count) {
              return null
            }
            return { shell, group, fb }
          },
          5000,
          100,
        ),
      )
      const draggedTab = await timing.step('wait for merged file browser tab rect', () =>
        waitForTabRect(base, fileBrowserWindowId),
      )
      const dragStart = rectCenter(draggedTab.tab.rect!)
      const armedPoint = {
        x: Math.min(dragStart.x + 48, draggedTab.tab.rect!.global_x + draggedTab.tab.rect!.width - 6),
        y: dragStart.y,
      }
      const tearOutPoint = {
        x: armedPoint.x + 36,
        y: draggedTab.tab.rect!.global_y - 104,
      }
      await timing.step('start file browser tear-out drag', () => dragTabStep(base, fileBrowserWindowId, armedPoint))
      await timing.step('pull file browser tab out of strip', () => movePoint(base, tearOutPoint.x, tearOutPoint.y))
      const detachedDuringDrag = await timing.step('wait for detached file browser drag without remount', () =>
        waitFor(
          `wait for detached file browser ${fileBrowserWindowId}`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const draggedGroup = tabGroupByWindow(shell, fileBrowserWindowId)
            const targetGroup = tabGroupByWindow(shell, targetWindowId)
            const fb = fileBrowserSnapshot(shell, fileBrowserWindowId)
            if (!draggedGroup || !targetGroup || draggedGroup.group_id === targetGroup.group_id) return null
            if (draggedGroup.member_window_ids.length !== 1 || draggedGroup.visible_window_id !== fileBrowserWindowId) {
              return null
            }
            if (!fb || fb.list_state !== 'ready' || !fb.active_path) return null
            if (fb.mount_seq !== beforeReady.fb.mount_seq || fb.load_count !== beforeReady.fb.load_count) {
              return null
            }
            if (compositor.shell_move_window_id !== fileBrowserWindowId) return null
            if (compositor.shell_move_proxy_window_id !== null) return null
            return { compositor, shell, draggedGroup, targetGroup, fb }
          },
          5000,
          100,
        ),
      )
      await timing.step('release file browser tear-out drag', () => finishDrag(base))
      released = true
      const settled = await timing.step('wait for settled file browser tear-out', () =>
        waitFor(
          `wait for settled file browser ${fileBrowserWindowId}`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const draggedGroup = tabGroupByWindow(shell, fileBrowserWindowId)
            const targetGroup = tabGroupByWindow(shell, targetWindowId)
            const fb = fileBrowserSnapshot(shell, fileBrowserWindowId)
            if (!draggedGroup || !targetGroup || draggedGroup.group_id === targetGroup.group_id) return null
            if (draggedGroup.member_window_ids.length !== 1 || draggedGroup.visible_window_id !== fileBrowserWindowId) {
              return null
            }
            if (!fb || fb.list_state !== 'ready' || !fb.active_path) return null
            if (fb.mount_seq !== beforeReady.fb.mount_seq || fb.load_count !== beforeReady.fb.load_count) {
              return null
            }
            if (compositor.shell_move_window_id !== null || compositor.shell_move_proxy_window_id !== null) {
              return null
            }
            return { compositor, shell, draggedGroup, targetGroup, fb }
          },
          5000,
          100,
        ),
      )
      await timing.step('write file browser merge tear-out artifact', () =>
        writeJsonArtifact('tab-groups-file-browser-merge-tear-out.json', {
          targetWindowId,
          fileBrowserWindowId,
          beforeReady,
          afterMerge,
          detachedDuringDrag,
          settled,
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

  test('dragging a hidden grouped shell tab does not move the visible shell window or leak focus below', async ({ base, state }) => {
    const timing = createTimingMarks('tab-hidden-tear-out-ownership')
    let released = false
    try {
      const lower = await timing.step('open lower js window', () => openShellTestWindow(base, state))
      const visible = await timing.step('open visible js window', () => openShellTestWindow(base, state))
      const hidden = await timing.step('open hidden js window', () => openShellTestWindow(base, state))
      const lowerId = lower.window.window_id
      const visibleId = visible.window.window_id
      const hiddenId = hidden.window.window_id

      await timing.step('merge visible source tab onto hidden target', () => dragTabOntoTab(base, visibleId, hiddenId))
      await timing.step('wait for visible hidden-shell group', () =>
        waitForGroupedMembers(base, [visibleId, hiddenId], visibleId),
      )

      const hiddenTab = await timing.step('wait for hidden tab rect', () => waitForTabRect(base, hiddenId))
      const lowerTitlebar = await timing.step('wait for lower titlebar', () =>
        waitForWindowTitlebarRect(base, lowerId),
      )
      const dragStart = rectCenter(hiddenTab.tab.rect!)
      const armedPoint = {
        x: Math.min(dragStart.x + 48, hiddenTab.tab.rect!.global_x + hiddenTab.tab.rect!.width - 6),
        y: dragStart.y,
      }

      await timing.step('start hidden tab drag', () => dragTabStep(base, hiddenId, armedPoint))
      const preDetach = await timing.step('wait for hidden tab drag without compositor move takeover', () =>
        waitFor(
          `wait for hidden tab ${hiddenId} drag without compositor move`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const group = tabGroupByWindow(shell, hiddenId)
            if (!group || group.visible_window_id !== visibleId) return null
            if (compositor.focused_shell_ui_window_id === lowerId) return null
            if (compositor.focused_shell_ui_window_id === hiddenId) return null
            return { compositor, shell, group }
          },
          2000,
          40,
        ),
      )

      const lowerHoverPoint = rectCenter(lowerTitlebar)
      await timing.step('hover lower titlebar during hidden tab drag', () =>
        movePoint(base, lowerHoverPoint.x, lowerHoverPoint.y),
      )
      const hoverBlocked = await timing.step('wait for lower titlebar hover to stay blocked', () =>
        waitFor(
          `wait for lower titlebar ${lowerId} to stay unfocused during hidden drag`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const group = tabGroupByWindow(shell, hiddenId)
            if (!group || group.visible_window_id !== visibleId) return null
            if (compositor.focused_shell_ui_window_id === lowerId) return null
            if (compositor.focused_window_id === lowerId) return null
            return { compositor, shell, group }
          },
          2000,
          40,
        ),
      )

      const tearOutPoint = {
        x: lowerHoverPoint.x + 24,
        y: lowerTitlebar.global_y - 96,
      }
      await timing.step('pull hidden tab out of strip', () => movePoint(base, tearOutPoint.x, tearOutPoint.y))
      const detachedDuringDrag = await timing.step('wait for hidden tab detached live drag ownership', () =>
        waitFor(
          `wait for hidden tab ${hiddenId} detached live drag ownership`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const draggedGroup = tabGroupByWindow(shell, hiddenId)
            const sourceGroup = tabGroupByWindow(shell, visibleId)
            if (!draggedGroup || !sourceGroup || draggedGroup.group_id === sourceGroup.group_id) {
              return null
            }
            if (draggedGroup.member_window_ids.length !== 1 || draggedGroup.visible_window_id !== hiddenId) {
              return null
            }
            if (sourceGroup.member_window_ids.length !== 1 || sourceGroup.visible_window_id !== visibleId) {
              return null
            }
            if (compositor.shell_move_window_id !== hiddenId) return null
            if (compositor.shell_move_proxy_window_id !== null) return null
            if (compositor.focused_shell_ui_window_id === lowerId) return null
            if (compositor.focused_window_id === lowerId) return null
            return { compositor, shell, draggedGroup, sourceGroup }
          },
          5000,
          100,
        ),
      )

      await timing.step('release hidden tab tear-out drag', () => finishDrag(base))
      released = true
      const settled = await timing.step('wait for hidden tab tear-out settled', () =>
        waitFor(
          `wait for hidden tab ${hiddenId} tear-out settled`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const draggedGroup = tabGroupByWindow(shell, hiddenId)
            const sourceGroup = tabGroupByWindow(shell, visibleId)
            if (!draggedGroup || !sourceGroup || draggedGroup.group_id === sourceGroup.group_id) {
              return null
            }
            if (draggedGroup.member_window_ids.length !== 1 || draggedGroup.visible_window_id !== hiddenId) {
              return null
            }
            if (sourceGroup.member_window_ids.length !== 1 || sourceGroup.visible_window_id !== visibleId) {
              return null
            }
            if (compositor.shell_move_window_id !== null) return null
            if (compositor.shell_move_proxy_window_id !== null) return null
            if (compositor.shell_pointer_grab_window_id !== null) return null
            if (compositor.focused_shell_ui_window_id === lowerId) return null
            if (compositor.focused_window_id === lowerId) return null
            return { compositor, shell, draggedGroup, sourceGroup }
          },
          2000,
          125,
        ),
      )

      await timing.step('write hidden tab tear-out artifact', () =>
        writeJsonArtifact('tab-groups-hidden-tab-tear-out.json', {
          lowerId,
          visibleId,
          hiddenId,
          armedPoint,
          lowerHoverPoint,
          tearOutPoint,
          preDetach,
          hoverBlocked,
          detachedDuringDrag,
          settled,
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
        waitForGroupedMembers(base, [nativeTarget.windowId, jsWindowA.window.window_id], jsWindowA.window.window_id),
      )
      const jsWindowB = await timing.step('open second js test window', () => openShellTestWindow(base, state))
      jsWindowIdB = jsWindowB.window.window_id
      await timing.step('move second js window to other monitor', () =>
        moveShellWindowToOtherMonitor(base, jsWindowB.window.window_id),
      )
      const draggedTab = await timing.step('wait for dragged source tab rect', () =>
        waitForTabRect(base, jsWindowA.window.window_id),
      )
      const dragStart = rectCenter(draggedTab.tab.rect!)
      const armedPoint = {
        x: Math.min(dragStart.x + 48, draggedTab.tab.rect!.global_x + draggedTab.tab.rect!.width - 6),
        y: dragStart.y,
      }
      const tearOutPoint = {
        x: Math.max(armedPoint.x + 72, draggedTab.tab.rect!.global_x + draggedTab.tab.rect!.width + 24),
        y: draggedTab.tab.rect!.global_y - 120,
      }
      await timing.step('start source drag', () => dragTabStep(base, jsWindowA.window.window_id, armedPoint))
      await timing.step('pull grouped tab out', async () => {
        await movePoint(base, armedPoint.x + 36, draggedTab.tab.rect!.global_y - 72)
        await movePoint(base, tearOutPoint.x, tearOutPoint.y)
      })
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
      const remergeTarget = await timing.step('wait for remerge target tab rect', () =>
        waitForTabRect(base, jsWindowB.window.window_id),
      )
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
            if (group.visible_window_id !== jsWindowA.window.window_id) return null
            const row = taskbarEntry(shell, jsWindowA.window.window_id)
            if (!row || row.tab_count !== 2) return null
            if (taskbarEntry(shell, jsWindowB.window.window_id)) return null
            return { shell, group, row }
          },
          2000,
          125,
        ),
      )
      await timing.step('write same drag remerge artifact', () =>
        writeJsonArtifact('tab-groups-tear-out-remerge.json', {
          tear_out_point: tearOutPoint,
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
      const merged = await timing.step('merge js into native target', async () => {
        const visibleNative = await resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id])
        await dragTabOntoTab(base, jsWindow.window.window_id, visibleNative.windowId)
        const grouped = await waitForGroupedMembers(
          base,
          [visibleNative.windowId, jsWindow.window.window_id],
          jsWindow.window.window_id,
        )
        return { visibleNative, grouped }
      })
      const nativeWindowId = merged.visibleNative.windowId
      const leaderSnapshot = await getSnapshots(base)
      const nativeWindow = compositorWindowById(leaderSnapshot.compositor, nativeWindowId)
      assert(nativeWindow, `missing grouped native leader ${nativeWindowId}`)
      const groupedTitlebar = await timing.step('wait for grouped titlebar', () =>
        waitForWindowTitlebarRect(base, jsWindow.window.window_id),
      )
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
              Math.abs(restoredTitlebar.titlebar.global_x - groupedTitlebar.global_x) > 12 ||
              Math.abs(restoredTitlebar.titlebar.global_y - groupedTitlebar.global_y) > 12
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

  test('tab menu enters and exits split view for grouped native tabs', async ({ base, state }) => {
    const timing = createTimingMarks('tab-split-enter-exit')
    const { red, green } = await ensureFreshNativePair(base, state)
    const target = await timing.step('resolve visible native target', () =>
      resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
    )
    const groupedWindowId = target.windowId === red.window.window_id ? green.window.window_id : red.window.window_id
    await timing.step('group native windows', () =>
      dragTabOntoTab(
        base,
        groupedWindowId,
        target.windowId,
      ),
    )
    await timing.step('wait for grouped pair', () =>
      waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], groupedWindowId),
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
        waitForGroupedMembers(base, [target.windowId, jsWindow.window.window_id], jsWindow.window.window_id),
      )
      const otherNativeId = target.windowId === red.window.window_id ? green.window.window_id : red.window.window_id
      await timing.step('merge second native into grouped target', () =>
        dragTabOntoTab(base, otherNativeId, target.windowId),
      )
      await timing.step('wait for three tab group', () =>
        waitForGroupedMembers(base, [target.windowId, jsWindow.window.window_id, otherNativeId], otherNativeId),
      )
      await timing.step('enter split', () => enterSplitViewFromTabMenu(base, target.windowId))
      const split = await timing.step('wait for three-member split stable', () =>
        waitForSplitGroupMembers(base, target.windowId, target.windowId, [
          target.windowId,
          jsWindow.window.window_id,
          otherNativeId,
        ]),
      )
      const hiddenRightWindowId =
        [jsWindow.window.window_id, otherNativeId].find(
          (windowId) => !(split.group.visible_window_ids ?? []).includes(windowId),
        ) ?? null
      assert(hiddenRightWindowId !== null, 'expected a hidden right tab after entering split')
      const initialWidth =
        split.group.split_left_rect!.width +
        split.group.split_right_rect!.width +
        split.group.split_divider_rect!.width
      await timing.step('wait for hidden split tab target', () => waitForTabRect(base, hiddenRightWindowId))
      await timing.step('activate hidden split tab', () => selectTabByClick(base, hiddenRightWindowId))
      const activated = await timing.step('wait for stable split activation', () =>
        waitFor(
          `wait for split activation ${hiddenRightWindowId}`,
          async () => {
            const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
            const group = tabGroupByWindow(shell, hiddenRightWindowId)
            if (!group) return null
            const vis =
              group.visible_window_ids && group.visible_window_ids.length > 0
                ? group.visible_window_ids
                : group.visible_window_id != null
                  ? [group.visible_window_id]
                  : []
            if (!vis.includes(hiddenRightWindowId)) return null
            if (!group.split_left_rect || !group.split_right_rect || !group.split_divider_rect) return null
            const width =
              group.split_left_rect.width + group.split_right_rect.width + group.split_divider_rect.width
            const tol = 56
            if (Math.abs(width - initialWidth) > tol) return null
            return { shell, group }
          },
          5000,
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
      waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], otherWindowId),
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
        waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], otherWindowId),
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
      const detachedDuringDrag = await timing.step('wait for right tab detached', () =>
        waitFor(
          `wait for split right tab ${otherWindowId} detached`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const leftGroup = tabGroupByWindow(shell, target.windowId)
            const rightGroup = tabGroupByWindow(shell, otherWindowId)
            const rightWindow = compositorWindowById(compositor, otherWindowId)
            const controls = windowControls(shell, otherWindowId)
            if (!leftGroup || !rightGroup || leftGroup.group_id === rightGroup.group_id) return null
            if (!rightWindow || !controls?.dragging) return null
            if (compositor.shell_move_window_id !== otherWindowId) return null
            return { compositor, shell, leftGroup, rightGroup, rightWindow, controls }
          },
          2000,
          100,
        ),
      )
      const continuedPoint = {
        x: previewPoint.x + 96,
        y: rightTab.tab.rect!.global_y - 132,
      }
      await timing.step('continue moving detached right tab', async () => {
        for (let step = 1; step <= 12; step += 1) {
          const t = step / 12
          await movePoint(
            base,
            previewPoint.x + 24 + (continuedPoint.x - (previewPoint.x + 24)) * t,
            rightTab.tab.rect!.global_y - 96 + (continuedPoint.y - (rightTab.tab.rect!.global_y - 96)) * t,
          )
        }
      })
      const continued = await timing.step('wait for detached right tab to keep following pointer', () =>
        waitFor(
          `wait for split right tab ${otherWindowId} continued move`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const leftGroup = tabGroupByWindow(shell, target.windowId)
            const rightGroup = tabGroupByWindow(shell, otherWindowId)
            const rightWindow = compositorWindowById(compositor, otherWindowId)
            const controls = windowControls(shell, otherWindowId)
            if (!leftGroup || !rightGroup || leftGroup.group_id === rightGroup.group_id) return null
            if (!rightWindow || !controls?.dragging) return null
            if (compositor.shell_move_window_id !== otherWindowId) return null
            if (
              rightWindow.x === detachedDuringDrag.rightWindow.x &&
              rightWindow.y === detachedDuringDrag.rightWindow.y
            ) {
              return null
            }
            return { compositor, shell, leftGroup, rightGroup, rightWindow, controls }
          },
          2000,
          100,
        ),
      )
      await timing.step('release right tab drag', () => finishDrag(base))
      released = true
      const releasedState = await timing.step('wait for detached right tab drag released', () =>
        waitFor(
          `wait for detached right tab ${otherWindowId} release`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const window = compositorWindowById(compositor, otherWindowId)
            const controls = windowControls(shell, otherWindowId)
            const leftGroup = tabGroupByWindow(shell, target.windowId)
            const rightGroup = tabGroupByWindow(shell, otherWindowId)
            if (!window || !leftGroup || !rightGroup) return null
            if (compositor.shell_move_window_id !== null) return null
            if (controls?.dragging) return null
            if (shell.tab_drag_target) return null
            return { compositor, shell, window, controls, leftGroup, rightGroup }
          },
          2000,
          100,
        ),
      )
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
      const afterRelease = releasedState.window
      const releasedPointerPoint = {
        x: continuedPoint.x + 144,
        y: continuedPoint.y + 96,
      }
      const stopped = await timing.step('confirm detached right tab stays stopped after release', async () => {
        await movePoint(base, releasedPointerPoint.x, releasedPointerPoint.y)
        return waitFor(
          `wait for detached right tab ${otherWindowId} stopped`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const window = compositorWindowById(compositor, otherWindowId)
            const controls = windowControls(shell, otherWindowId)
            if (!window) return null
            if (compositor.shell_move_window_id !== null) return null
            if (controls?.dragging) return null
            if (window.x !== afterRelease.x || window.y !== afterRelease.y) return null
            return { compositor, shell, window, controls }
          },
          2000,
          100,
        )
      })
      await timing.step('write split tear-out artifact', () =>
        writeJsonArtifact('tab-groups-split-tear-out.json', {
          detachedDuringDrag,
          continued,
          releasedState,
          split,
          stopped,
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
        return waitForGroupedMembers(base, [target.windowId, jsWindow.window.window_id], jsWindow.window.window_id)
      })
      const leaderSnapshot = await getSnapshots(base)
      const leaderBeforeSwitch = compositorWindowById(leaderSnapshot.compositor, jsWindow.window.window_id)
      assert(leaderBeforeSwitch, `missing merged leader window ${jsWindow.window.window_id}`)
      const leaderTitlebar = await timing.step('wait for grouped js titlebar', () =>
        waitForWindowTitlebarRect(base, jsWindow.window.window_id),
      )
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

  test('grouped window frame close closes every member in the tab group', async ({ base, state }) => {
    const timing = createTimingMarks('tab-group-frame-close')
    let jsWindowId: number | null = null
    try {
      const { red, green } = await ensureFreshNativePair(base, state)
      const jsWindow = await timing.step('open js test window', () => openShellTestWindow(base, state))
      jsWindowId = jsWindow.window.window_id
      const target = await timing.step('resolve visible native target', () =>
        resolveNativeTabTarget(base, [green.window.window_id, red.window.window_id]),
      )
      const grouped = await timing.step('merge js tab into native tab', async () => {
        await dragTabOntoTab(base, jsWindow.window.window_id, target.windowId)
        return waitForGroupedMembers(base, [target.windowId, jsWindow.window.window_id], jsWindow.window.window_id)
      })
      const shellBeforeClose = grouped.shell
      const controls = windowControls(shellBeforeClose, jsWindow.window.window_id)
      assert(controls?.close, `missing close button for grouped window ${jsWindow.window.window_id}`)
      await timing.step('click grouped frame close button', () => clickRect(base, controls.close!))
      const closed = await timing.step('wait for grouped members closed', () =>
        waitFor(
          `wait for grouped windows ${target.windowId} and ${jsWindow.window.window_id} closed`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            if (compositorWindowById(compositor, target.windowId)) return null
            if (compositorWindowById(compositor, jsWindow.window.window_id)) return null
            if (shell.windows.some((window) => window.window_id === target.windowId)) return null
            if (shell.windows.some((window) => window.window_id === jsWindow.window.window_id)) return null
            if (taskbarEntry(shell, target.windowId)) return null
            if (taskbarEntry(shell, jsWindow.window.window_id)) return null
            return { compositor, shell }
          },
          5000,
          125,
        ),
      )
      jsWindowId = null
      await timing.step('write frame close artifact', () =>
        writeJsonArtifact('tab-groups-frame-close.json', {
          targetWindowId: target.windowId,
          jsWindowId: jsWindow.window.window_id,
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
      const minimizedWindowId = otherId
      await timing.step('group native windows', () => dragTabOntoTab(base, otherId, target.windowId))
      await timing.step('wait for grouped pair', () =>
        waitForGroupedMembers(base, [red.window.window_id, green.window.window_id], minimizedWindowId),
      )
      await timing.step('minimize visible native', () => minimizeWindow(base, minimizedWindowId))
      await timing.step('wait minimized', () => waitForWindowMinimized(base, minimizedWindowId))
      await timing.step('assert compositor geometry survives test minimize', async () => {
        const { compositor } = await getSnapshots(base)
        const cw = compositorWindowById(compositor, minimizedWindowId)
        assert(cw, 'missing compositor window after minimize')
        assert(
          cw.width >= 32 && cw.height >= 32,
          `minimized native should retain non-trivial compositor size (got ${cw.width}x${cw.height})`,
        )
      })
      const shellBeforeDrag = await timing.step('wait shell tab snapshot after minimize', () =>
        waitFor(
          `shell tab surface for ${minimizedWindowId} after minimize`,
          async () => {
            const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
            const peer = shellWindowById(shell, target.windowId)
            if (!peer || peer.minimized) return null
            try {
              tabRect(shell, minimizedWindowId)
              return shell
            } catch {
              return null
            }
          },
          2000,
          125,
        ),
      )
      const tab = tabRect(shellBeforeDrag, minimizedWindowId)
      const start = rectCenter(tab.tab.rect!)
      const previewPoint = { x: start.x + 40, y: start.y }
      await timing.step('start minimized tab drag', () => dragTabStep(base, minimizedWindowId, previewPoint))
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
          `wait torn ${minimizedWindowId} unminimized`,
          async () => {
            const { compositor, shell } = await getSnapshots(base)
            const w = shellWindowById(shell, minimizedWindowId)
            if (!w || w.minimized) return null
            const gOther = tabGroupByWindow(shell, target.windowId)
            const gTorn = tabGroupByWindow(shell, minimizedWindowId)
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
          windowId: minimizedWindowId,
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
