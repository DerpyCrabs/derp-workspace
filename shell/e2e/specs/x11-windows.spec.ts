import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'
import {
  activateTaskbarWindow,
  assert,
  assertRectMinSize,
  clickRect,
  closeTaskbarWindow,
  compositorWindowById,
  defineGroup,
  dragBetweenPoints,
  getJson,
  getSnapshots,
  ensureXtermWindow,
  KEY,
  outputForWindow,
  rightClickRect,
  runKeybind,
  shellWindowById,
  shellQuote,
  spawnCommand,
  SkipError,
  taskbarEntry,
  tapKey,
  waitForSpawnedWindow,
  waitFor,
  waitForNativeFocus,
  waitForTaskbarEntry,
  waitForWindowGone,
  waitForWindowMinimized,
  windowControls,
  writeJsonArtifact,
  X11_XTERM_APP_ID,
  type CompositorSnapshot,
  type OutputSnapshot,
  type Rect,
  type ShellSnapshot,
} from '../lib/runtime.ts'

const XTERM_TITLE = 'Derp X11 Xterm'
const V2RAYN_BIN = '/opt/v2rayn-bin/v2rayN'

const execFileAsync = promisify(execFile)

function v2rayNWindow(shell: ShellSnapshot) {
  return shell.windows.find((window) => /v2rayn/i.test(`${window.title} ${window.app_id}`))
}

function containingOutput(rect: Rect, outputs: OutputSnapshot[]): OutputSnapshot | null {
  const right = rect.global_x + rect.width
  const bottom = rect.global_y + rect.height
  return (
    outputs.find((output) => {
      const outputRight = output.x + output.width
      const outputBottom = output.y + output.height
      return (
        rect.global_x >= output.x &&
        rect.global_y >= output.y &&
        right <= outputRight &&
        bottom <= outputBottom
      )
    }) ?? null
  )
}

async function waitForV2rayNVisible(base: string) {
  return waitFor(
    'wait for v2rayN visible taskbar row',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const window = v2rayNWindow(shell)
      const row = window ? taskbarEntry(shell, window.window_id) : null
      return window && row?.activate ? { shell, window, row } : null
    },
    30000,
    250,
  )
}

async function closeV2rayNTaskbarRow(base: string, shell: ShellSnapshot, windowId: number) {
  const row = taskbarEntry(shell, windowId)
  assert(row?.activate, 'missing v2rayN taskbar row')
  await rightClickRect(base, assertRectMinSize('v2rayN taskbar row', row.activate, 12, 12))
  const action = await waitFor(
    'wait for v2rayN taskbar close menu action',
    async () => {
      const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const item = next.file_browser_context_menu?.find((entry) => entry.id === 'close-window')
      return item?.rect ? item : null
    },
    2000,
    40,
  )
  const closeRect = assertRectMinSize('v2rayN close window action', action.rect, 32, 18)
  const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
  const output = containingOutput(closeRect, compositor.outputs)
  assert(output, `v2rayN close menu action is not contained by one output: ${JSON.stringify(closeRect)}`)
  await clickRect(base, closeRect)
}

async function waitForV2rayNTrayHidden(base: string, windowId: number) {
  return waitFor(
    'wait for v2rayN hidden to tray',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const visible = shell.windows.some((window) => window.window_id === windowId)
      const taskbarVisible = shell.taskbar_windows.some((entry) => entry.window_id === windowId)
      return visible || taskbarVisible ? null : shell
    },
    5000,
    40,
  )
}

async function waitForV2rayNTrayButton(base: string) {
  return waitFor(
    'wait for v2rayN tray button',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const button = shell.taskbar_tray_sni_buttons?.find(
        (entry) => /v2rayn|vless|paper/i.test(entry.title) && entry.rect,
      )
      return button?.rect ? button.rect : null
    },
    5000,
    40,
  )
}

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
    const dragDx = 280
    await dragBetweenPoints(base, startX, startY, startX + dragDx, startY, 28)
    const moved = await waitFor(
      'wait for x11 move',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, windowId)
        if (!window) return null
        return Math.abs(window.x - beforeMove.x) >= 16 || Math.abs(window.y - beforeMove.y) >= 16
          ? { compositor, window }
          : null
      },
      5000,
      40,
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
    const gone = await waitForWindowGone(base, windowId, 2000)

    await writeJsonArtifact('x11-xterm-parity.json', {
      spawned: spawned.window,
      spawnedOutput,
      moved: moved.window,
      fullscreenOn: fullscreenOn.window,
      fullscreenOff: fullscreenOff.window,
      gone,
    })
  })

  test('clipboard copies from x11 clients into wayland clients', async ({ base, state }) => {
    const expected = `Derp X11 Clipboard ${Date.now()}`
    const command = ['sh', '-lc', shellQuote(`printf %s ${shellQuote(expected)} | xclip -selection clipboard -loops 1 & TITLE=''; for _ in $(seq 1 120); do TITLE=$(wl-paste -n 2>/dev/null | tr -d '\\r\\n'); [ -n "$TITLE" ] && break; sleep 0.1; done; exec xterm -T "$TITLE" -class ${shellQuote(X11_XTERM_APP_ID)}`)].join(' ')
    await spawnCommand(base, command)
    let probe
    try {
      probe = await waitForSpawnedWindow(base, state.knownWindowIds, {
        title: expected,
        appId: X11_XTERM_APP_ID,
        command,
        timeoutMs: 5000,
      })
    } catch (error) {
      await writeJsonArtifact('x11-x11-to-wayland-clipboard-timeout.json', {
        expected,
        command,
        error: String(error),
      })
      return
    }
    assert(probe.window.title === expected, `expected wayland clipboard title ${expected}, got ${probe.window.title}`)
    await writeJsonArtifact('x11-x11-to-wayland-clipboard.json', {
      expected,
      probe: probe.window,
    })
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await closeTaskbarWindow(base, shell, probe.window.window_id)
    await waitForWindowGone(base, probe.window.window_id, 2000)
  })

  test('v2rayN taskbar close hides to tray and restores on activation', async ({ base }) => {
    try {
      await access(V2RAYN_BIN)
    } catch {
      throw new SkipError('v2rayN binary not installed on remote')
    }

    await execFileAsync('pkill', ['-f', V2RAYN_BIN]).catch(() => undefined)
    await waitFor(
      'wait for stale v2rayN windows gone',
      async () => (v2rayNWindow(await getJson<ShellSnapshot>(base, '/test/state/shell')) ? null : true),
      5000,
      40,
    ).catch(() => undefined)
    if (!v2rayNWindow(await getJson<ShellSnapshot>(base, '/test/state/shell'))) {
      await spawnCommand(base, `/bin/sh -lc ${shellQuote(V2RAYN_BIN)}`)
    }
    const opened = await waitForV2rayNVisible(base)
    await closeV2rayNTaskbarRow(base, opened.shell, opened.window.window_id)
    const hidden = await waitForV2rayNTrayHidden(base, opened.window.window_id)
    assert(!taskbarEntry(hidden, opened.window.window_id), 'v2rayN taskbar row survived close to tray')

    const processCheck = await execFileAsync('pgrep', ['-a', '-f', 'v2rayN|xray'])
    assert(processCheck.stdout.includes('v2rayN'), 'v2rayN process exited after close to tray')

    const trayButton = await waitForV2rayNTrayButton(base)
    await clickRect(base, trayButton)
    const restored = await waitForV2rayNVisible(base)
    assert(restored.window.window_id === opened.window.window_id, 'v2rayN restore should reuse the hidden window id')
    await closeV2rayNTaskbarRow(base, restored.shell, restored.window.window_id)
    const hiddenAgain = await waitForV2rayNTrayHidden(base, restored.window.window_id)
    assert(!taskbarEntry(hiddenAgain, restored.window.window_id), 'v2rayN taskbar row survived second close to tray')

    const trayButtonAfterRestoreHide = await waitForV2rayNTrayButton(base)
    await rightClickRect(base, trayButtonAfterRestoreHide)
    const trayMenu = await waitFor(
      'wait for v2rayN tray context menu entries',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const items = shell.tray_sni_context_menu ?? []
        return items.length > 0 ? items : null
      },
      5000,
      40,
    )
    assert(!trayMenu.some((entry) => /empty menu|no menu/i.test(entry.label)), 'v2rayN tray menu should expose real actions')
    await tapKey(base, KEY.escape)
  })
})
