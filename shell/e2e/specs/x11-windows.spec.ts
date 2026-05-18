import { execFile } from 'node:child_process'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import {
  activateTaskbarWindow,
  assert,
  assertRectMinSize,
  BTN_MIDDLE,
  clickRect,
  cleanupNativeWindows,
  closeTaskbarWindow,
  compositorWindowById,
  defineGroup,
  dragBetweenPoints,
  getJson,
  getSnapshots,
  ensureXtermWindow,
  BTN_LEFT,
  KEY,
  NATIVE_APP_ID,
  outputForWindow,
  rightClickRect,
  shellWindowById,
  shellQuote,
  SkipError,
  taskbarEntry,
  tapKey,
  waitForSpawnedWindow,
  waitFor,
  waitForFileValue,
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
import {
  spawnNativeWindow,
  spawnCommand,
} from '../lib/setup.ts'
import {
  movePoint,
  pointerButton,
  runKeybind,
} from '../lib/user.ts'

const XTERM_TITLE = 'Derp X11 Xterm'
const V2RAYN_BIN = '/opt/v2rayn-bin/v2rayN'

const execFileAsync = promisify(execFile)

async function middleClickPoint(base: string, x: number, y: number) {
  await movePoint(base, x, y)
  await pointerButton(base, BTN_MIDDLE, 'press')
  await pointerButton(base, BTN_MIDDLE, 'release')
}

async function readTrimmed(path: string) {
  return (await readFile(path, 'utf8')).replace(/\r/g, '').trim()
}

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
    const initial = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    await cleanupNativeWindows(
      base,
      new Set(
        initial.windows
          .filter((window) =>
            !window.shell_hosted &&
            (window.app_id === X11_XTERM_APP_ID || window.app_id === 'XTerm' || window.app_id === 'org.gnome.gedit'),
          )
          .map((window) => window.window_id),
      ),
    )
    const spawned = await ensureXtermWindow(base, state, XTERM_TITLE)
    const windowId = spawned.window.window_id
    const spawnedOutput = outputForWindow(spawned.snapshot, spawned.window)
    assert(spawned.window.x > 0, `expected x11 spawn x > 0, got ${spawned.window.x}`)
    assert(spawned.window.y > 0, `expected x11 spawn y > 0, got ${spawned.window.y}`)
    assert(spawnedOutput?.scale === 1.5, `expected 1.5 output scale, got ${spawnedOutput?.scale}`)
    assert(spawned.window.xwayland_scale === 1, `expected x11 preferred scale 1, got ${spawned.window.xwayland_scale}`)
    assert(spawned.window.backend === 'x11', `expected x11 backend, got ${spawned.window.backend}`)
    assert(spawned.window.lifecycle === 'mapped', `expected mapped lifecycle, got ${spawned.window.lifecycle}`)

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
    await movePoint(base, startX, startY)
    await pointerButton(base, BTN_LEFT, 'press')
    for (let index = 1; index <= 28; index += 1) {
      const t = index / 28
      await movePoint(base, startX + dragDx * t, startY)
    }
    const previewDuringMove = await waitFor(
      'wait for x11 native drag preview',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const controls = windowControls(shell, windowId)
        if (compositor.shell_move_window_id !== windowId) return null
        if (compositor.shell_native_drag_preview_window_id !== windowId) return null
        if (compositor.shell_native_drag_preview_shell_ready !== true) return null
        if (!compositor.shell_native_drag_preview_image_path) return null
        if (!compositor.shell_native_drag_preview_clip_rect) return null
        if (!controls?.native_drag_preview_rect || controls.native_drag_preview_loaded !== true) return null
        return { compositor, shell, controls }
      },
      3000,
      40,
    )
    await pointerButton(base, BTN_LEFT, 'release')
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
    assert(compositorWindowById(minimized.compositor, windowId)?.lifecycle === 'minimized', 'x11 lifecycle did not minimize')

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
      previewDuringMove,
      moved: moved.window,
      fullscreenOn: fullscreenOn.window,
      fullscreenOff: fullscreenOff.window,
      gone,
    })
  })

  test('clipboard copies from x11 clients into wayland clients', async ({ base, state }) => {
    const expected = `Derp X11 Clipboard ${Date.now()}`
    const command = ['sh', '-lc', shellQuote(`TMP=$(mktemp); wl-paste --watch sh -c 'VALUE=$(cat); [ "$VALUE" = "$2" ] || exit 0; printf %s "$VALUE" > "$1"; kill "$PPID"' sh "$TMP" ${shellQuote(expected)} & WATCH=$!; printf %s ${shellQuote(expected)} | xclip -selection clipboard -loops 5 & XCLIP=$!; wait "$WATCH" 2>/dev/null || true; kill "$XCLIP" 2>/dev/null || true; TITLE=$(tr -d '\\r\\n' < "$TMP"); rm -f "$TMP"; exec xterm -T "$TITLE" -class ${shellQuote(X11_XTERM_APP_ID)}`)].join(' ')
    await spawnCommand(base, command)
    const probe = await waitForSpawnedWindow(base, state.knownWindowIds, {
      title: expected,
      appId: X11_XTERM_APP_ID,
      command,
      timeoutMs: 5000,
    })
    assert(probe.window.title === expected, `expected wayland clipboard title ${expected}, got ${probe.window.title}`)
    await writeJsonArtifact('x11-x11-to-wayland-clipboard.json', {
      expected,
      probe: probe.window,
    })
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await closeTaskbarWindow(base, shell, probe.window.window_id)
    await waitForWindowGone(base, probe.window.window_id, 2000)
  })

  test('primary selection middle-click paste from wayland native into x11 client', async ({ base, state }) => {
    const expected = `Derp Wayland Primary ${Date.now()}`
    const outPath = `/tmp/derp-primary-wayland-to-x11-${Date.now()}.txt`
    await rm(outPath, { force: true }).catch(() => undefined)

    const cleanupWindowIds = new Set<number>()
    try {
      const native = await spawnNativeWindow(base, state.knownWindowIds, {
        title: 'Derp Primary Wayland Source',
        token: 'primary-wayland-source',
        strip: '#2d7f5e',
        width: 520,
        height: 260,
        primarySelectionText: expected,
      })
      state.spawnedNativeWindowIds.add(native.window.window_id)
      cleanupWindowIds.add(native.window.window_id)
      const source = native.window
      await clickRect(base, {
        x: source.x,
        y: source.y,
        width: source.width,
        height: source.height,
        global_x: source.x,
        global_y: source.y,
      })
      await waitForNativeFocus(base, source.window_id)
      const y = source.y + Math.floor(source.height / 2)
      await dragBetweenPoints(base, source.x + 36, y, source.x + Math.min(source.width - 36, 320), y, 18)
      const selectedSource = await waitFor(
        'wait for native primary selection claim',
        async () => {
          const snapshot = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          return snapshot.windows.find((window) =>
            !window.shell_hosted &&
            window.window_id === source.window_id &&
            window.app_id === NATIVE_APP_ID &&
            /^Derp Primary Wayland Source Selected [1-9]\d*$/.test(window.title),
          ) ?? null
        },
        5000,
        40,
      )
      const title = 'Derp X11 Primary Target'
      const command = `stty raw -echo; dd bs=1 count=${expected.length} of=${shellQuote(outPath)} status=none; while :; do sleep 60; done`
      const fullCommand = `xterm -T ${shellQuote(title)} -class ${shellQuote(X11_XTERM_APP_ID)} -geometry 80x12 -e sh -lc ${shellQuote(command)}`
      await spawnCommand(base, fullCommand)
      const xterm = await waitForSpawnedWindow(base, state.knownWindowIds, {
        title,
        appId: X11_XTERM_APP_ID,
        command: fullCommand,
        timeoutMs: 5000,
      })
      cleanupWindowIds.add(xterm.window.window_id)
      const target = xterm.window
      await waitForNativeFocus(base, target.window_id)
      await middleClickPoint(base, target.x + 24, target.y + 24)

      const actual = await waitForFileValue(
        'wait for wayland primary paste in x11',
        outPath,
        async () => {
          try {
            const text = await readTrimmed(outPath)
            return text === expected ? text : null
          } catch {
            return null
          }
        },
        10000,
      )
      assert(actual === expected, `expected x11 primary paste ${expected}, got ${actual}`)
      await writeJsonArtifact('x11-primary-wayland-to-x11.json', { expected, actual, outPath, source: selectedSource, target })
    } finally {
      await cleanupNativeWindows(base, cleanupWindowIds)
    }
  })

  test('primary selection middle-click paste from x11 into wayland native client', async ({ base, state }) => {
    const expected = `Derp X11 Primary ${Date.now()}`
    const statusPath = `/tmp/derp-primary-x11-to-wayland-${Date.now()}.json`
    await rm(statusPath, { force: true }).catch(() => undefined)
    await writeFile(statusPath, '{"paste_count":0,"text":""}\n')

    const cleanupWindowIds = new Set<number>()
    try {
      const title = 'Derp X11 Primary Source'
      const command = `printf '%s\\n' ${shellQuote(expected)}`
      const fullCommand = `xterm -hold -T ${shellQuote(title)} -class ${shellQuote(X11_XTERM_APP_ID)} -geometry 80x12 -e sh -lc ${shellQuote(command)}`
      await spawnCommand(base, fullCommand)
      const xterm = await waitForSpawnedWindow(base, state.knownWindowIds, {
        title,
        appId: X11_XTERM_APP_ID,
        command: fullCommand,
        timeoutMs: 5000,
      })
      cleanupWindowIds.add(xterm.window.window_id)
      const source = xterm.window
      await waitForNativeFocus(base, source.window_id)
      const sourceTextY = source.y + 7
      await dragBetweenPoints(base, source.x + 2, sourceTextY, source.x + 4 + expected.length * 6, sourceTextY, 24)
      const relayReadyPath = `/tmp/derp-primary-x11-relay-${Date.now()}.ready`
      const relayTextPath = `/tmp/derp-primary-x11-relay-${Date.now()}.txt`
      await rm(relayReadyPath, { force: true }).catch(() => undefined)
      await rm(relayTextPath, { force: true }).catch(() => undefined)
      const relayTitle = 'Derp X11 Primary Relay'
      const relayCommand = `timeout 5 xclip -selection primary -o > ${shellQuote(relayTextPath)} && printf ready > ${shellQuote(relayReadyPath)}; while :; do sleep 60; done`
      const relayFullCommand = `xterm -T ${shellQuote(relayTitle)} -class ${shellQuote(X11_XTERM_APP_ID)} -geometry 40x6 -e sh -lc ${shellQuote(relayCommand)}`
      await spawnCommand(base, relayFullCommand)
      const relay = await waitForSpawnedWindow(base, state.knownWindowIds, {
        title: relayTitle,
        appId: X11_XTERM_APP_ID,
        command: relayFullCommand,
        timeoutMs: 5000,
      })
      cleanupWindowIds.add(relay.window.window_id)
      await waitFor(
        'wait for x11 primary relay',
        async () => {
          try {
            await access(relayReadyPath)
            const text = await readTrimmed(relayTextPath)
            return text === expected ? true : null
          } catch {
            return null
          }
        },
        5000,
        40,
      )

      const native = await spawnNativeWindow(base, state.knownWindowIds, {
        title: 'Derp Primary Wayland Target',
        token: 'primary-wayland-target',
        strip: '#7f4db8',
        width: 520,
        height: 260,
        primaryPasteStatusJson: statusPath,
      })
      state.spawnedNativeWindowIds.add(native.window.window_id)
      cleanupWindowIds.add(native.window.window_id)
      const target = native.window
      let activationShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      await activateTaskbarWindow(base, activationShell, source.window_id)
      await waitForNativeFocus(base, source.window_id)
      activationShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      await activateTaskbarWindow(base, activationShell, target.window_id)
      await waitForNativeFocus(base, target.window_id)
      await middleClickPoint(base, target.x + Math.floor(target.width / 2), target.y + Math.floor(target.height / 2))

      const pastedTarget = await waitFor(
        'wait for x11 primary paste request in wayland',
        async () => {
          const snapshot = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          return snapshot.windows.find((window) =>
            !window.shell_hosted &&
            window.window_id === target.window_id &&
            /^Derp Primary Wayland Target Pasted [1-9]\d*$/.test(window.title),
          ) ?? null
        },
        5000,
        40,
      )
      const pastedStatus = await waitForFileValue(
        'wait for x11 primary paste status in wayland',
        statusPath,
        async () => {
          const status = JSON.parse(await readFile(statusPath, 'utf8')) as { text?: string }
          return status.text?.replace(/\r/g, '').trim() === expected ? status : null
        },
        5000,
      )
      assert(
        pastedStatus.text?.replace(/\r/g, '').trim() === expected,
        `expected wayland primary paste ${expected}, got ${pastedStatus.text}`,
      )
      await writeJsonArtifact('x11-primary-x11-to-wayland.json', { expected, pastedStatus, pastedTarget, source, target, statusPath })
    } finally {
      await cleanupNativeWindows(base, cleanupWindowIds)
    }
  })

  test('v2rayN taskbar close hides to tray and restores on activation', async ({ base, state }) => {
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
    state.spawnedNativeWindowIds.add(opened.window.window_id)
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
