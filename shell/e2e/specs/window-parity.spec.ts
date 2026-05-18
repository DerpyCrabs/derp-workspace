import {
  NATIVE_APP_ID,
  SHELL_TEST_APP_ID,
  defineGroup,
  type CompositorSnapshot,
  type TestContext,
  type WindowSnapshot,
} from '../lib/runtime.ts'
import {
  clickRect,
  clickRectWithoutSync,
  dragBetweenPoints,
  movePoint,
  pointerButton,
  touchDown,
  touchMove,
  touchUp,
} from '../lib/user.ts'
import {
  assert,
  assertRectMinSize,
  captureScreenshotRect,
  compositorWindowById,
  getJson,
  getSnapshots,
  shellWindowById,
  taskbarEntry,
  waitFor,
  waitForWindowGone,
  waitForWindowMinimized,
  waitForWindowRaised,
  windowControls,
  writeJsonArtifact,
  type ShellSnapshot,
} from '../lib/oracle.ts'
import {
  openShellTestWindow,
  spawnNativeWindow,
  spawnCommand,
} from '../lib/setup.ts'

type ParityCase = {
  label: string
  open: (context: TestContext) => Promise<WindowSnapshot>
}

async function waitForControlRect(
  base: string,
  windowId: number,
  label: string,
  kind: 'minimize' | 'maximize' | 'close',
) {
  return waitFor(
    `${label} ${kind} control`,
    async () => {
      const snapshots = await getSnapshots(base)
      const controls = windowControls(snapshots.shell, windowId)
      const window = shellWindowById(snapshots.shell, windowId)
      const actual = controls?.[kind]
      const titlebar = controls?.titlebar
      if (!window || !titlebar || !actual || actual.width < 12 || actual.height < 12) return null
      const expectedTitlebarX = window.maximized || window.fullscreen ? window.x : window.x - 4
      const expectedTitlebarY = window.y - titlebar.height
      if (Math.abs(titlebar.global_x - expectedTitlebarX) > 2) return null
      if (Math.abs(titlebar.global_y - expectedTitlebarY) > 2) return null
      if (actual.global_y !== titlebar.global_y) return null
      if (actual.global_x < titlebar.global_x) return null
      if (actual.global_x + actual.width > titlebar.global_x + titlebar.width) return null
      return actual
    },
    5000,
    100,
  )
}

async function clickMaximize(base: string, windowId: number, label: string) {
  const maximize = await waitForControlRect(base, windowId, label, 'maximize')
  await clickRect(base, maximize)
}

async function clickMaximizeWithoutSync(base: string, windowId: number, label: string) {
  const maximize = await waitForControlRect(base, windowId, label, 'maximize')
  await clickRectWithoutSync(base, maximize)
  return maximize
}

async function clickMinimizeWithoutSync(base: string, windowId: number, label: string) {
  const minimize = await waitForControlRect(base, windowId, label, 'minimize')
  await clickRectWithoutSync(base, minimize)
  return minimize
}

async function clickClose(base: string, windowId: number, label: string) {
  const close = await waitForControlRect(base, windowId, label, 'close')
  await clickRect(base, close)
}

async function clickMinimize(base: string, windowId: number, label: string) {
  const minimize = await waitForControlRect(base, windowId, label, 'minimize')
  await clickRect(base, minimize)
}

async function restoreFromTaskbar(base: string, windowId: number, label: string) {
  const activate = await waitFor(
    `${label} taskbar activate control`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const row = taskbarEntry(shell, windowId)
      const rect = row?.activate
      return rect && rect.width >= 12 && rect.height >= 12 ? rect : null
    },
    5000,
    100,
  )
  await clickRect(base, activate)
  return waitForWindowRaised(base, windowId)
}

async function restoreFromTaskbarWithoutSync(base: string, windowId: number, label: string) {
  const activate = await waitFor(
    `${label} taskbar activate control`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const row = taskbarEntry(shell, windowId)
      const rect = row?.activate
      return rect && rect.width >= 12 && rect.height >= 12 ? rect : null
    },
    5000,
    100,
  )
  await clickRectWithoutSync(base, activate)
  return activate
}

async function dragTitlebarDown(base: string, windowId: number, label: string) {
  const titlebar = await waitFor(
    `${label} titlebar control`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const rect = windowControls(shell, windowId)?.titlebar
      return rect && rect.width >= 80 && rect.height >= 16 ? rect : null
    },
    5000,
    100,
  )
  assertRectMinSize(`${label} titlebar`, titlebar, 80, 16)
  const start = {
    x: titlebar.x + Math.min(Math.max(titlebar.width * 0.35, 260), titlebar.width - 260),
    y: titlebar.y + titlebar.height / 2,
  }
  await dragBetweenPoints(base, start.x, start.y, start.x + 180, start.y + 120, 16)
}

async function waitForMaximized(base: string, windowId: number, label: string) {
  return waitFor(
    `${label} maximized`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const window = shellWindowById(shell, windowId)
      return window?.maximized ? { shell, window } : null
    },
    5000,
    100,
  )
}

async function waitForFloating(base: string, windowId: number, label: string) {
  return waitFor(
    `${label} floating`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const window = shellWindowById(shell, windowId)
      return window && !window.maximized && !window.fullscreen ? { shell, window } : null
    },
    5000,
    100,
  )
}

async function waitForChromeSettled(base: string, windowId: number, label: string) {
  return waitFor(
    `${label} chrome settled`,
    async () => {
      const snapshots = await getSnapshots(base)
      const controls = windowControls(snapshots.shell, windowId)
      const window = shellWindowById(snapshots.shell, windowId)
      if (snapshots.compositor.shell_move_window_id !== null) return null
      if (snapshots.compositor.shell_resize_window_id !== null) return null
      if (snapshots.compositor.shell_pointer_grab_window_id !== null) return null
      if (snapshots.compositor.pointer_pressed_button_count !== 0) return null
      if (!window) return null
      if (!controls?.titlebar || controls.dragging) return null
      if (typeof window.frame_width !== 'number') return null
      if (Math.abs(controls.titlebar.width - window.frame_width) > 1) return null
      return snapshots
    },
    5000,
    100,
  )
}

function assertCompositorFrameContract(shell: ShellSnapshot, windowId: number, label: string) {
  const window = shellWindowById(shell, windowId)
  const controls = windowControls(shell, windowId)
  assert(window, `${label} window missing for frame contract`)
  assert(controls?.titlebar, `${label} titlebar missing for frame contract`)
  assert(window.client_x === window.x && window.client_y === window.y, `${label} client origin should be compositor-authored`)
  assert(window.client_width === window.width && window.client_height === window.height, `${label} client size should be compositor-authored`)
  assert(typeof window.frame_x === 'number' && typeof window.frame_y === 'number', `${label} frame origin should be compositor-authored`)
  assert(typeof window.frame_width === 'number' && window.frame_width >= window.width, `${label} frame width should cover client`)
  assert(typeof window.frame_height === 'number' && window.frame_height >= window.height, `${label} frame height should cover client`)
  if (!window.shell_hosted) {
    assert(window.frame_height > window.height, `${label} native frame height should include chrome`)
  }
  assert(
    Math.abs(controls.titlebar.width - window.frame_width) <= 1,
    `${label} titlebar width should match compositor frame width`,
  )
}

function assertShellTracksCompositor(compositor: CompositorSnapshot, shell: ShellSnapshot, windowId: number, label: string) {
  const shellWindow = shellWindowById(shell, windowId)
  const compositorWindow = compositorWindowById(compositor, windowId)
  assert(shellWindow, `${label} shell window missing`)
  assert(compositorWindow, `${label} compositor window missing`)
  assert(shellWindow.x === compositorWindow.x, `${label} x ${shellWindow.x} != compositor ${compositorWindow.x}`)
  assert(shellWindow.y === compositorWindow.y, `${label} y ${shellWindow.y} != compositor ${compositorWindow.y}`)
  assert(shellWindow.width === compositorWindow.width, `${label} width ${shellWindow.width} != compositor ${compositorWindow.width}`)
  assert(shellWindow.height === compositorWindow.height, `${label} height ${shellWindow.height} != compositor ${compositorWindow.height}`)
  assert(shellWindow.maximized === compositorWindow.maximized, `${label} maximized mismatch`)
  assert(shellWindow.minimized === compositorWindow.minimized, `${label} minimized mismatch`)
  assert(shellWindow.fullscreen === compositorWindow.fullscreen, `${label} fullscreen mismatch`)
  assert(shellWindow.output_name === compositorWindow.output_name, `${label} output mismatch`)
}

async function waitForShellTracksCompositor(base: string, windowId: number, label: string) {
  return waitFor(
    `${label} shell compositor parity`,
    async () => {
      const snapshots = await getSnapshots(base)
      try {
        assertShellTracksCompositor(snapshots.compositor, snapshots.shell, windowId, label)
      } catch {
        return null
      }
      return snapshots
    },
    5000,
    40,
  )
}

async function waitForRestoredShellTracksCompositor(base: string, windowId: number, label: string) {
  return waitFor(
    `${label} restored shell compositor parity`,
    async () => {
      const snapshots = await getSnapshots(base)
      try {
        assertShellTracksCompositor(snapshots.compositor, snapshots.shell, windowId, label)
      } catch {
        return null
      }
      const compositorWindow = compositorWindowById(snapshots.compositor, windowId)
      const shellWindow = shellWindowById(snapshots.shell, windowId)
      if (!compositorWindow || !shellWindow) return null
      if (compositorWindow.minimized || shellWindow.minimized) return null
      return snapshots
    },
    5000,
    40,
  )
}

async function waitForResizeRightRect(base: string, windowId: number, label: string) {
  return waitFor(
    `${label} right resize control`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const rect = windowControls(shell, windowId)?.resize_right
      return rect && rect.width >= 2 && rect.height >= 40 ? rect : null
    },
    5000,
    40,
  )
}

async function dragRightResizeEdge(base: string, windowId: number, dx: number, label: string) {
  const before = await waitForShellTracksCompositor(base, windowId, `${label} before resize`)
  const beforeWindow = shellWindowById(before.shell, windowId)
  assert(beforeWindow, `${label} missing window before resize`)
  const handle = await waitForResizeRightRect(base, windowId, label)
  const startX = handle.global_x + handle.width - 1
  const startY = handle.global_y + handle.height / 2
  await movePoint(base, startX, startY)
  await pointerButton(base, 0x110, 'press')
  await movePoint(base, startX + dx, startY)
  const during = await getSnapshots(base)
  const resizeRect = during.compositor.shell_resize_visual
  assert(resizeRect, `${label} missing active resize rect`)
  assert(
    Math.abs(resizeRect.x + resizeRect.width - (beforeWindow.x + beforeWindow.width + dx)) <= 2,
    `${label} active right edge should follow pointer: ${JSON.stringify({
      before: beforeWindow,
      resizeRect,
      dx,
    })}`,
  )
  await pointerButton(base, 0x110, 'release')
  const settled = await waitForChromeSettled(base, windowId, `${label} resize settled`)
  const afterWindow = shellWindowById(settled.shell, windowId)
  assert(afterWindow, `${label} missing window after resize`)
  assert(
    Math.abs(afterWindow.width - (beforeWindow.width + dx)) <= 2,
    `${label} resize delta should match pointer delta: ${JSON.stringify({
      before: beforeWindow,
      after: afterWindow,
      dx,
    })}`,
  )
  return { before: beforeWindow, after: afterWindow, during: resizeRect, handle }
}

async function dragTitlebarByTouch(base: string, windowId: number, dx: number, dy: number, label: string) {
  const before = await waitForShellTracksCompositor(base, windowId, `${label} before touch drag`)
  const beforeWindow = shellWindowById(before.shell, windowId)
  assert(beforeWindow, `${label} missing window before touch drag`)
  const titlebar = await waitFor(
    `${label} touch titlebar control`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const rect = windowControls(shell, windowId)?.titlebar
      return rect && rect.width >= 80 && rect.height >= 16 ? rect : null
    },
    5000,
    40,
  )
  const startX = titlebar.global_x + Math.min(Math.max(titlebar.width * 0.35, 80), titlebar.width - 80)
  const startY = titlebar.global_y + titlebar.height / 2
  await touchDown(base, startX, startY)
  await touchMove(base, startX + dx, startY + dy)
  const during = await getSnapshots(base)
  assert(during.compositor.shell_move_visual, `${label} missing active touch move rect`)
  await touchUp(base)
  const settled = await waitForChromeSettled(base, windowId, `${label} touch drag settled`)
  const afterWindow = shellWindowById(settled.shell, windowId)
  assert(afterWindow, `${label} missing window after touch drag`)
  assert(
    Math.abs(afterWindow.x - (beforeWindow.x + dx)) <= 2 && Math.abs(afterWindow.y - (beforeWindow.y + dy)) <= 2,
    `${label} touch drag delta should move window: ${JSON.stringify({
      before: beforeWindow,
      after: afterWindow,
      dx,
      dy,
    })}`,
  )
  return { before: beforeWindow, after: afterWindow, during: during.compositor.shell_move_visual, titlebar }
}

async function dragRightResizeEdgeByTouch(base: string, windowId: number, dx: number, label: string) {
  const before = await waitForShellTracksCompositor(base, windowId, `${label} before touch resize`)
  const beforeWindow = shellWindowById(before.shell, windowId)
  assert(beforeWindow, `${label} missing window before touch resize`)
  const handle = await waitForResizeRightRect(base, windowId, label)
  const startX = handle.global_x + handle.width - 1
  const startY = handle.global_y + handle.height / 2
  await touchDown(base, startX, startY)
  await waitFor(
    `${label} touch resize started`,
    async () => {
      const snapshots = await getSnapshots(base)
      return snapshots.compositor.shell_resize_visual ? snapshots : null
    },
    5000,
    40,
  )
  await touchMove(base, startX + dx, startY)
  const resizeRect = await waitFor(
    `${label} active touch resize rect follows pointer`,
    async () => {
      const during = await getSnapshots(base)
      const rect = during.compositor.shell_resize_visual
      if (!rect) return null
      return Math.abs(rect.x + rect.width - (beforeWindow.x + beforeWindow.width + dx)) <= 2 ? rect : null
    },
    5000,
    40,
  )
  await touchUp(base)
  const afterWindow = await waitFor(
    `${label} touch resize committed geometry`,
    async () => {
      const snapshots = await getSnapshots(base)
      if (snapshots.compositor.shell_resize_window_id !== null) return null
      if (snapshots.compositor.shell_pointer_grab_window_id !== null) return null
      if (snapshots.compositor.pointer_pressed_button_count !== 0) return null
      const controls = windowControls(snapshots.shell, windowId)
      if (controls?.dragging) return null
      const after = shellWindowById(snapshots.shell, windowId)
      if (!after) return null
      return Math.abs(after.width - (beforeWindow.width + dx)) <= 2 ? after : null
    },
    5000,
    40,
  )
  return { before: beforeWindow, after: afterWindow, during: resizeRect, handle }
}

async function runChromeContract(context: TestContext, parity: ParityCase) {
  const { base } = context
  const opened = await parity.open(context)
  await waitForWindowRaised(base, opened.window_id)
  const focusedSnapshots = await waitForChromeSettled(base, opened.window_id, parity.label)
  const focused = focusedSnapshots.shell
  const visible = shellWindowById(focused, opened.window_id)
  assert(visible && !visible.minimized, `${parity.label} window visible after open`)
  assertShellTracksCompositor(focusedSnapshots.compositor, focused, opened.window_id, parity.label)
  assertCompositorFrameContract(focused, opened.window_id, parity.label)

  await clickMaximize(base, opened.window_id, parity.label)
  const maximized = await waitForMaximized(base, opened.window_id, parity.label)
  assert(maximized.window.maximized, `${parity.label} should maximize through chrome click`)
  const maximizedSnapshots = await waitForShellTracksCompositor(base, opened.window_id, `${parity.label} maximized`)
  assertCompositorFrameContract(maximizedSnapshots.shell, opened.window_id, `${parity.label} maximized`)

  const serialBeforeDrag = maximized.shell.compositor_interaction_state?.interaction_serial ?? 0
  await dragTitlebarDown(base, opened.window_id, parity.label)
  const restored = await waitForFloating(base, opened.window_id, parity.label)
  assert(restored.window.width > 100 && restored.window.height > 100, `${parity.label} restore keeps usable size`)
  const settled = await waitForChromeSettled(base, opened.window_id, parity.label)
  assertShellTracksCompositor(settled.compositor, settled.shell, opened.window_id, `${parity.label} restored`)
  assert(
    (settled.shell.compositor_interaction_state?.interaction_serial ?? 0) > serialBeforeDrag,
    `${parity.label} interaction serial should advance after titlebar drag`,
  )

  await clickMinimize(base, opened.window_id, parity.label)
  const minimized = await waitForWindowMinimized(base, opened.window_id)
  const minimizedWindow = shellWindowById(minimized.shell, opened.window_id)
  assert(minimizedWindow?.minimized, `${parity.label} should minimize through chrome click`)
  assertShellTracksCompositor(minimized.compositor, minimized.shell, opened.window_id, `${parity.label} minimized`)

  const taskbarRestored = await restoreFromTaskbar(base, opened.window_id, parity.label)
  assert(!taskbarRestored.window.minimized, `${parity.label} should restore through taskbar click`)
  assertShellTracksCompositor(taskbarRestored.compositor, taskbarRestored.shell, opened.window_id, `${parity.label} taskbar restored`)

  await clickClose(base, opened.window_id, parity.label)
  await waitForWindowGone(base, opened.window_id, 5000)
  await writeJsonArtifact(`window-parity-${parity.label}.json`, {
    windowId: opened.window_id,
    appId: opened.app_id,
    maximized: maximized.window,
    restored: restored.window,
    minimized: minimizedWindow,
    taskbarRestored: taskbarRestored.window,
  })
}

async function runFootMaximizeWithoutForcedSync(context: TestContext) {
  const { base, state } = context
  await spawnCommand(base, 'foot')
  const opened = await waitFor(
    'wait for raw foot maximize window',
    async () => {
      const snapshot = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
      return snapshot.windows.find(
        (entry) =>
          !entry.shell_hosted &&
          !state.knownWindowIds.has(entry.window_id) &&
          entry.app_id === 'foot' &&
          !entry.minimized,
      ) ?? null
    },
    5000,
    40,
  )
  state.knownWindowIds.add(opened.window_id)
  state.spawnedNativeWindowIds.add(opened.window_id)
  const maximizeRect = await clickMaximizeWithoutSync(base, opened.window_id, 'foot raw')
  const maximizedScreenshot = await captureScreenshotRect(base, maximizeRect)
  await waitForShellTracksCompositor(base, opened.window_id, 'foot raw maximized')
  const maximizedSnapshots = await waitForChromeSettled(base, opened.window_id, 'foot raw maximized')
  assertCompositorFrameContract(maximizedSnapshots.shell, opened.window_id, 'foot raw maximized')

  const restoreRect = await clickMaximizeWithoutSync(base, opened.window_id, 'foot raw restored')
  const restoredScreenshot = await captureScreenshotRect(base, restoreRect)
  await waitForShellTracksCompositor(base, opened.window_id, 'foot raw restored')
  const restoredSnapshots = await waitForChromeSettled(base, opened.window_id, 'foot raw restored')
  assertCompositorFrameContract(restoredSnapshots.shell, opened.window_id, 'foot raw restored')

  const minimizeRect = await clickMinimizeWithoutSync(base, opened.window_id, 'foot raw minimized')
  await waitForWindowMinimized(base, opened.window_id)
  const restoreTaskbarRect = await restoreFromTaskbarWithoutSync(base, opened.window_id, 'foot raw taskbar restored')
  const taskbarRestoredScreenshot = await captureScreenshotRect(base, restoreTaskbarRect)
  await waitForRestoredShellTracksCompositor(base, opened.window_id, 'foot raw taskbar restored')
  const taskbarRestoredSnapshots = await waitForChromeSettled(base, opened.window_id, 'foot raw taskbar restored')
  assertCompositorFrameContract(taskbarRestoredSnapshots.shell, opened.window_id, 'foot raw taskbar restored')

  await writeJsonArtifact('window-parity-foot-raw-maximize-restore.json', {
    windowId: opened.window_id,
    maximizedScreenshot,
    restoredScreenshot,
    taskbarRestoredScreenshot,
    minimizeRect,
    shell: shellWindowById(taskbarRestoredSnapshots.shell, opened.window_id),
    compositor: compositorWindowById(taskbarRestoredSnapshots.compositor, opened.window_id),
    controls: windowControls(taskbarRestoredSnapshots.shell, opened.window_id),
  })
}

export default defineGroup(import.meta.url, ({ test }) => {
  const cases: ParityCase[] = [
    {
      label: 'shell-hosted',
      open: async ({ base, state }) => {
        const opened = await openShellTestWindow(base, state)
        assert(opened.window.app_id === SHELL_TEST_APP_ID, `expected ${SHELL_TEST_APP_ID}, got ${opened.window.app_id}`)
        return opened.window
      },
    },
    {
      label: 'native',
      open: async ({ base, state }) => {
        const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
          title: 'Derp Native Parity Probe',
          token: 'native-parity-probe',
          strip: 'red',
        })
        state.spawnedNativeWindowIds.add(spawned.window.window_id)
        assert(spawned.window.app_id === NATIVE_APP_ID, `expected ${NATIVE_APP_ID}, got ${spawned.window.app_id}`)
        return spawned.window
      },
    },
    {
      label: 'foot',
      open: async ({ base, state }) => {
        await spawnCommand(base, 'foot')
        const opened = await waitFor(
          'wait for foot parity window',
          async () => {
            const snapshot = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
            return snapshot.windows.find(
              (entry) =>
                !entry.shell_hosted &&
                !state.knownWindowIds.has(entry.window_id) &&
                entry.app_id === 'foot' &&
                !entry.minimized,
            ) ?? null
          },
          5000,
          40,
        )
        state.knownWindowIds.add(opened.window_id)
        state.spawnedNativeWindowIds.add(opened.window_id)
        return opened
      },
    },
  ]

  for (const parity of cases) {
    test(`${parity.label} window chrome follows common contract`, async (context) => {
      await runChromeContract(context, parity)
    })
  }

  test('foot maximize click updates chrome without forced snapshot sync', async (context) => {
    await runFootMaximizeWithoutForcedSync(context)
  })

  test('shell-hosted right resize edge tracks pointer delta at fractional scale', async (context) => {
    const { base, state } = context
    const opened = await openShellTestWindow(base, state)
    await waitForWindowRaised(base, opened.window.window_id)
    const resize = await dragRightResizeEdge(base, opened.window.window_id, 120, 'shell-hosted fractional resize')
    await writeJsonArtifact('window-parity-shell-hosted-resize-fractional.json', resize)
  })

  const touchDragCases = cases.slice(0, 2)
  const touchResizeCases: ParityCase[] = [
    cases[0],
    {
      label: 'native',
      open: async ({ base, state }) => {
        const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
          title: 'Derp Native Touch Resize Probe',
          token: 'native-touch-resize-probe',
          strip: 'red',
          resizable: true,
        })
        state.spawnedNativeWindowIds.add(spawned.window.window_id)
        assert(spawned.window.app_id === NATIVE_APP_ID, `expected ${NATIVE_APP_ID}, got ${spawned.window.app_id}`)
        return spawned.window
      },
    },
  ]

  for (const parity of touchDragCases) {
    test(`${parity.label} titlebar drag follows touchscreen motion`, async (context) => {
      const { base } = context
      const opened = await parity.open(context)
      await waitForWindowRaised(base, opened.window_id)
      const drag = await dragTitlebarByTouch(base, opened.window_id, 96, 64, `${parity.label} touch drag`)
      await writeJsonArtifact(`window-parity-${parity.label}-touch-drag.json`, drag)
    })
  }

  for (const parity of touchResizeCases) {
    test(`${parity.label} right resize edge follows touchscreen motion`, async (context) => {
      const { base } = context
      const opened = await parity.open(context)
      await waitForWindowRaised(base, opened.window_id)
      const resize = await dragRightResizeEdgeByTouch(base, opened.window_id, 104, `${parity.label} touch resize`)
      await writeJsonArtifact(`window-parity-${parity.label}-touch-resize.json`, resize)
    })
  }
})
