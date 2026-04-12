import {
  activateTaskbarWindow,
  assert,
  closeTaskbarWindow,
  compositorWindowById,
  defineGroup,
  getJson,
  getSnapshots,
  ensureXtermWindow,
  movePoint,
  pointerButton,
  runKeybind,
  shellWindowById,
  waitFor,
  waitForNativeFocus,
  waitForTaskbarEntry,
  waitForWindowGone,
  waitForWindowMinimized,
  windowControls,
  writeJsonArtifact,
  type ShellSnapshot,
} from '../lib/runtime.ts'

const XTERM_TITLE = 'Derp X11 Xterm'

export default defineGroup(import.meta.url, ({ test }) => {
  test('x11 xterm participates in shell taskbar and window actions', async ({ base, state }) => {
    const spawned = await ensureXtermWindow(base, state, XTERM_TITLE)
    const windowId = spawned.window.window_id
    assert(spawned.window.x > 0, `expected x11 spawn x > 0, got ${spawned.window.x}`)
    assert(spawned.window.y > 0, `expected x11 spawn y > 0, got ${spawned.window.y}`)

    const shellWithTaskbar = await waitForTaskbarEntry(base, windowId)
    const shellWindow = shellWindowById(shellWithTaskbar, windowId)
    assert(shellWindow, 'missing x11 shell window')
    assert(shellWindow.title === XTERM_TITLE, `unexpected x11 title ${shellWindow?.title}`)

    await waitForNativeFocus(base, windowId)

    const beforeMove = compositorWindowById((await getSnapshots(base)).compositor, windowId)
    assert(beforeMove, 'missing x11 compositor window before move')
    const controlsBeforeMove = windowControls(
      await getJson<ShellSnapshot>(base, '/test/state/shell'),
      windowId,
    )
    assert(controlsBeforeMove?.titlebar, 'missing x11 titlebar controls')
    const startX = controlsBeforeMove.titlebar.global_x + controlsBeforeMove.titlebar.width / 2
    const startY = controlsBeforeMove.titlebar.global_y + controlsBeforeMove.titlebar.height / 2
    await movePoint(base, startX, startY)
    await pointerButton(base, 0x110, 'press')
    try {
      await movePoint(base, startX + 48, startY)
      await movePoint(base, startX + 120, startY)
      await movePoint(base, startX + 180, startY)
    } finally {
      await pointerButton(base, 0x110, 'release')
    }
    const moved = await waitFor(
      'wait for x11 move',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, windowId)
        if (!window) return null
        return Math.abs(window.x - beforeMove.x) >= 20 || Math.abs(window.y - beforeMove.y) >= 20
          ? { compositor, window }
          : null
      },
      5000,
      100,
    )

    const shellBeforeMinimize = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeMinimize, windowId)
    const minimized = await waitForWindowMinimized(base, windowId)
    assert(shellWindowById(minimized.shell, windowId)?.minimized, 'x11 taskbar minimize should mark shell window minimized')

    await activateTaskbarWindow(base, minimized.shell, windowId)
    await waitForNativeFocus(base, windowId)

    await runKeybind(base, 'toggle_fullscreen')
    const fullscreenOn = await waitFor(
      'wait for x11 fullscreen on',
      async () => {
        const { compositor } = await getSnapshots(base)
        const window = compositorWindowById(compositor, windowId)
        return window?.fullscreen ? { compositor, window } : null
      },
      5000,
      100,
    )

    await runKeybind(base, 'toggle_fullscreen')
    const fullscreenOff = await waitFor(
      'wait for x11 fullscreen off',
      async () => {
        const { compositor } = await getSnapshots(base)
        const window = compositorWindowById(compositor, windowId)
        return window && !window.fullscreen ? { compositor, window } : null
      },
      5000,
      100,
    )

    const shellBeforeClose = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await closeTaskbarWindow(base, shellBeforeClose, windowId)
    const gone = await waitForWindowGone(base, windowId, 8000)

    await writeJsonArtifact('x11-xterm-parity.json', {
      spawned: spawned.window,
      moved: moved.window,
      fullscreenOn: fullscreenOn.window,
      fullscreenOff: fullscreenOff.window,
      gone,
    })
  })
})
