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
  outputForWindow,
  pointerButton,
  runKeybind,
  shellWindowById,
  shellQuote,
  spawnCommand,
  waitForSpawnedWindow,
  waitFor,
  waitForNativeFocus,
  waitForTaskbarEntry,
  waitForWindowGone,
  waitForWindowMinimized,
  windowControls,
  writeJsonArtifact,
  X11_XTERM_APP_ID,
  type ShellSnapshot,
} from '../lib/runtime.ts'

const XTERM_TITLE = 'Derp X11 Xterm'

export default defineGroup(import.meta.url, ({ test }) => {
  test('x11 xterm participates in shell taskbar and window actions', async ({ base, state }) => {
    const spawned = await ensureXtermWindow(base, state, XTERM_TITLE)
    const windowId = spawned.window.window_id
    const spawnedOutput = outputForWindow(spawned.snapshot, spawned.window)
    assert(spawned.window.x > 0, `expected x11 spawn x > 0, got ${spawned.window.x}`)
    assert(spawned.window.y > 0, `expected x11 spawn y > 0, got ${spawned.window.y}`)
    assert(spawnedOutput?.scale === 1.5, `expected 1.5 output scale, got ${spawnedOutput?.scale}`)
    assert(spawned.window.xwayland_scale === 1, `expected x11 preferred scale 1, got ${spawned.window.xwayland_scale}`)

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
      spawnedOutput,
      moved: moved.window,
      fullscreenOn: fullscreenOn.window,
      fullscreenOff: fullscreenOff.window,
      gone,
    })
  })

  test('clipboard copies from wayland clients into x11 clients', async ({ base, state }) => {
    const expected = `Derp Wayland Clipboard ${Date.now()}`
    const command = ['sh', '-lc', shellQuote(`wl-copy ${shellQuote(expected)} && TITLE=''; for _ in $(seq 1 50); do TITLE=$(xclip -selection clipboard -o 2>/dev/null | tr -d '\\r\\n'); [ -n "$TITLE" ] && break; sleep 0.1; done; exec xterm -T "$TITLE" -class ${shellQuote(X11_XTERM_APP_ID)}`)].join(' ')
    await spawnCommand(base, command)
    const probe = await waitForSpawnedWindow(base, state.knownWindowIds, {
      title: expected,
      appId: X11_XTERM_APP_ID,
      command,
    })
    assert(probe.window.title === expected, `expected x11 clipboard title ${expected}, got ${probe.window.title}`)
    assert(probe.window.xwayland_scale === 1, `expected x11 clipboard probe scale 1, got ${probe.window.xwayland_scale}`)
    await writeJsonArtifact('x11-wayland-to-x11-clipboard.json', {
      expected,
      probe: probe.window,
    })
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await closeTaskbarWindow(base, shell, probe.window.window_id)
    await waitForWindowGone(base, probe.window.window_id, 8000)
  })

  test('clipboard copies from x11 clients into wayland clients', async ({ base, state }) => {
    const expected = `Derp X11 Clipboard ${Date.now()}`
    const command = ['sh', '-lc', shellQuote(`printf %s ${shellQuote(expected)} | xclip -selection clipboard -loops 1 & TITLE=''; for _ in $(seq 1 50); do TITLE=$(wl-paste -n 2>/dev/null | tr -d '\\r\\n'); [ -n "$TITLE" ] && break; sleep 0.1; done; exec xterm -T "$TITLE" -class ${shellQuote(X11_XTERM_APP_ID)}`)].join(' ')
    await spawnCommand(base, command)
    const probe = await waitForSpawnedWindow(base, state.knownWindowIds, {
      title: expected,
      appId: X11_XTERM_APP_ID,
      command,
    })
    assert(probe.window.title === expected, `expected wayland clipboard title ${expected}, got ${probe.window.title}`)
    await writeJsonArtifact('x11-x11-to-wayland-clipboard.json', {
      expected,
      probe: probe.window,
    })
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await closeTaskbarWindow(base, shell, probe.window.window_id)
    await waitForWindowGone(base, probe.window.window_id, 8000)
  })
})
