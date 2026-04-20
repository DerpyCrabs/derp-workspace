import { mkdir, readFile } from 'node:fs/promises'
import {
  BTN_LEFT,
  BTN_RIGHT,
  SHELL_TEST_APP_ID,
  assert,
  artifactDir,
  captureFailureArtifacts,
  compositorWindowById,
  discoverReadyBase,
  dragBetweenPoints,
  ensureArtifactDir,
  getJson,
  getShellHtml,
  getSnapshots,
  movePoint,
  openShellTestWindow,
  postJson,
  runKeybind,
  shellWindowById,
  spawnNativeWindow,
  waitFor,
  waitForNativeFocus,
  waitForWindowRaised,
  writeJsonArtifact,
  writeTextArtifact,
  type E2eState,
  type ShellSnapshot,
  type WindowSnapshot,
} from './lib/runtime.ts'

type HarnessCommand =
  | { op: 'snapshot'; label?: string; html?: boolean; screenshot?: boolean; selector?: string }
  | { op: 'html'; label?: string; selector?: string }
  | { op: 'screenshot'; label?: string; rect?: SnapshotRect }
  | { op: 'move'; x: number; y: number }
  | { op: 'click'; x: number; y: number; button?: number }
  | { op: 'drag'; x0: number; y0: number; x1: number; y1: number; steps?: number }
  | { op: 'key'; keycode: number; action?: 'tap' | 'press' | 'release' }
  | { op: 'keybind'; action: string; window_id?: number }
  | { op: 'spawn'; command: string }
  | { op: 'open-shell-test-window' }
  | { op: 'scenario'; name: 'maximize-native-behind-shell' }

type SnapshotRect = { x: number; y: number; width: number; height: number }

type HarnessState = {
  base: string
  state: E2eState
}

const keyNames: Record<string, number> = {
  esc: 1,
  escape: 1,
  enter: 28,
  super: 125,
  left: 105,
  right: 106,
  up: 103,
  down: 108,
}

function createState(base: string): E2eState {
  return {
    base,
    knownWindowIds: new Set(),
    spawnedNativeWindowIds: new Set(),
    nativeLaunchByWindowId: new Map(),
    desktopApps: [],
    redSpawn: null,
    greenSpawn: null,
    crashProbe: null,
    spawnedShellWindowIds: new Set(),
    launcherWindowId: null,
    screenshot: null,
    multiMonitorNativeMove: null,
    multiMonitorShellMove: null,
    tiledOutput: null,
  }
}

function usage(): string {
  return [
    'Usage: node shell/e2e/harness.mjs <command> [args]',
    '',
    'Commands:',
    '  snapshot [label] [--html] [--screenshot] [--selector <css>]',
    '  html [label] [--selector <css>]',
    '  screenshot [label] [--rect x,y,w,h]',
    '  move <x> <y>',
    '  click <x> <y> [left|right|button]',
    '  drag <x0> <y0> <x1> <y1> [steps]',
    '  key <keycode|name> [tap|press|release]',
    '  keybind <action> [window_id]',
    '  spawn <command...>',
    '  open-shell-test-window',
    '  scenario maximize-native-behind-shell',
    '  run-json <file>',
    '',
    `Artifacts: ${artifactDir()}`,
  ].join('\n')
}

function numberArg(value: string | undefined, label: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`)
  return n
}

function intArg(value: string | undefined, label: string): number {
  const n = numberArg(value, label)
  if (!Number.isInteger(n)) throw new Error(`${label} must be an integer`)
  return n
}

function optionalFlagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
  return value
}

function positionalArgs(argv: string[]): string[] {
  const valueFlags = new Set(['--selector', '--rect'])
  const values: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value?.startsWith('--')) {
      if (valueFlags.has(value) && index + 1 < argv.length && !argv[index + 1]?.startsWith('--')) index += 1
      continue
    }
    if (value !== undefined) values.push(value)
  }
  return values
}

function parseRect(value: string): SnapshotRect {
  const parts = value.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 4) throw new Error(`bad rect ${value}; expected x,y,w,h`)
  const [x, y, width, height] = parts
  if (![x, y, width, height].every(Number.isFinite)) {
    throw new Error(`bad rect ${value}; expected x,y,w,h`)
  }
  return { x, y, width, height }
}

function parseKey(value: string | undefined): number {
  if (!value) throw new Error('key needs a keycode or name')
  const named = keyNames[value.toLowerCase()]
  if (named !== undefined) return named
  return intArg(value, 'keycode')
}

function parseCli(argv: string[]): HarnessCommand[] {
  const [command, ...rest] = argv
  switch (command) {
    case 'snapshot':
      return [{
        op: 'snapshot',
        label: positionalArgs(rest)[0],
        html: rest.includes('--html'),
        screenshot: rest.includes('--screenshot'),
        selector: optionalFlagValue(rest, '--selector'),
      }]
    case 'html':
      return [{
        op: 'html',
        label: positionalArgs(rest)[0],
        selector: optionalFlagValue(rest, '--selector'),
      }]
    case 'screenshot':
      return [{
        op: 'screenshot',
        label: positionalArgs(rest)[0],
        rect: optionalFlagValue(rest, '--rect') ? parseRect(optionalFlagValue(rest, '--rect') as string) : undefined,
      }]
    case 'move':
      return [{ op: 'move', x: numberArg(rest[0], 'x'), y: numberArg(rest[1], 'y') }]
    case 'click': {
      const buttonArg = rest[2]
      const button = buttonArg === 'right' ? BTN_RIGHT : buttonArg === 'left' || !buttonArg ? BTN_LEFT : intArg(buttonArg, 'button')
      return [{ op: 'click', x: numberArg(rest[0], 'x'), y: numberArg(rest[1], 'y'), button }]
    }
    case 'drag':
      return [{
        op: 'drag',
        x0: numberArg(rest[0], 'x0'),
        y0: numberArg(rest[1], 'y0'),
        x1: numberArg(rest[2], 'x1'),
        y1: numberArg(rest[3], 'y1'),
        steps: rest[4] === undefined ? undefined : intArg(rest[4], 'steps'),
      }]
    case 'key':
      return [{ op: 'key', keycode: parseKey(rest[0]), action: (rest[1] as 'tap' | 'press' | 'release' | undefined) ?? 'tap' }]
    case 'keybind':
      return [{ op: 'keybind', action: rest[0] ?? '', window_id: rest[1] === undefined ? undefined : intArg(rest[1], 'window_id') }]
    case 'spawn':
      return [{ op: 'spawn', command: rest.join(' ') }]
    case 'open-shell-test-window':
      return [{ op: 'open-shell-test-window' }]
    case 'scenario':
      if (rest[0] !== 'maximize-native-behind-shell') throw new Error(`unknown scenario ${rest[0] ?? ''}`)
      return [{ op: 'scenario', name: rest[0] }]
    case 'run-json':
      return readJsonCommandsPlaceholder(rest[0])
    default:
      throw new Error(usage())
  }
}

function readJsonCommandsPlaceholder(_file: string | undefined): HarnessCommand[] {
  throw new Error('run-json must be loaded asynchronously')
}

async function parseCommands(argv: string[]): Promise<HarnessCommand[]> {
  if (argv[0] !== 'run-json') return parseCli(argv)
  const file = argv[1]
  if (!file) throw new Error('run-json needs a file')
  const parsed = JSON.parse(await readFile(file, 'utf8')) as HarnessCommand | HarnessCommand[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function takeScreenshot(base: string, label: string, rect?: SnapshotRect): Promise<unknown> {
  const body = rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : {}
  const result = await postJson(base, '/test/screenshot', body)
  const saved = await writeJsonArtifact(`${label}-screenshot.json`, result)
  return { ...result, manifest: saved }
}

async function saveSnapshot(base: string, label: string, includeHtml: boolean, includeScreenshot: boolean, selector?: string): Promise<Record<string, unknown>> {
  const { compositor, shell } = await getSnapshots(base)
  const compositorPath = await writeJsonArtifact(`${label}-compositor.json`, compositor)
  const shellPath = await writeJsonArtifact(`${label}-shell.json`, shell)
  const out: Record<string, unknown> = { compositor: compositorPath, shell: shellPath }
  if (includeHtml) {
    out.html = await writeTextArtifact(`${label}-shell.html`, await getShellHtml(base, selector))
  }
  if (includeScreenshot) {
    out.screenshot = await takeScreenshot(base, label)
  }
  return out
}

function findNewestShellTestWindow(shell: ShellSnapshot): WindowSnapshot | null {
  return shell.windows
    .filter((window) => window.shell_hosted && window.app_id === SHELL_TEST_APP_ID)
    .sort((a, b) => b.window_id - a.window_id)[0] ?? null
}

async function ensureShellMaximized(base: string, state: E2eState): Promise<WindowSnapshot> {
  const opened = await openShellTestWindow(base, state)
  let shellWindow = opened.window
  await waitForWindowRaised(base, shellWindow.window_id)
  if (!shellWindow.maximized) {
    await runKeybind(base, 'toggle_maximize', shellWindow.window_id)
  }
  const result = await waitFor(
    'wait for shell test window maximized',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const window = shellWindowById(shell, shellWindow.window_id) ?? findNewestShellTestWindow(shell)
      return window?.maximized ? window : null
    },
    5000,
    50,
  )
  shellWindow = result
  return shellWindow
}

async function runMaximizeNativeBehindShellScenario(harness: HarnessState): Promise<Record<string, unknown>> {
  const { base, state } = harness
  const before = await saveSnapshot(base, 'harness-maximize-native-before', true, true)
  const shellWindow = await ensureShellMaximized(base, state)
  const native = await spawnNativeWindow(base, state.knownWindowIds, {
    title: 'Derp Harness Native Maximize Probe',
    token: 'harness-native-maximize-probe',
    strip: 'green',
  })
  state.spawnedNativeWindowIds.add(native.window.window_id)
  await waitForNativeFocus(base, native.window.window_id, 5000)
  await runKeybind(base, 'toggle_maximize', native.window.window_id)
  const maximized = await waitFor(
    'wait for native maximize probe result',
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const nativeWindow = compositorWindowById(compositor, native.window.window_id)
      const shellProbe = shellWindowById(shell, shellWindow.window_id)
      if (!nativeWindow?.maximized || !shellProbe?.maximized) return null
      return { compositor, shell, nativeWindow, shellProbe }
    },
    5000,
    50,
  )
  const after = await saveSnapshot(base, 'harness-maximize-native-after', true, true)
  const shellStack = maximized.shell.window_stack_order ?? []
  const compositorStack = maximized.compositor.window_stack_order ?? []
  const nativeTop = shellStack[0] === native.window.window_id && compositorStack[0] === native.window.window_id
  const focusOk = maximized.compositor.focused_window_id === native.window.window_id
  const summary = {
    ok: nativeTop && focusOk,
    nativeTop,
    focusOk,
    shellWindowId: shellWindow.window_id,
    nativeWindowId: native.window.window_id,
    shellStack,
    compositorStack,
    focusedWindowId: maximized.compositor.focused_window_id,
    before,
    after,
  }
  const summaryPath = await writeJsonArtifact('harness-maximize-native-behind-shell-summary.json', summary)
  return { ...summary, summary: summaryPath }
}

async function executeCommand(harness: HarnessState, command: HarnessCommand): Promise<unknown> {
  const { base } = harness
  switch (command.op) {
    case 'snapshot':
      return saveSnapshot(base, command.label ?? 'harness-snapshot', command.html ?? true, command.screenshot ?? false, command.selector)
    case 'html':
      return writeTextArtifact(`${command.label ?? 'harness'}-shell.html`, await getShellHtml(base, command.selector))
    case 'screenshot':
      return takeScreenshot(base, command.label ?? 'harness', command.rect)
    case 'move':
      await movePoint(base, command.x, command.y)
      return { ok: true }
    case 'click':
      await postJson(base, '/test/input/click', { x: command.x, y: command.y, button: command.button ?? BTN_LEFT })
      return { ok: true }
    case 'drag':
      await dragBetweenPoints(base, command.x0, command.y0, command.x1, command.y1, command.steps)
      return { ok: true }
    case 'key':
      await postJson(base, '/test/input/key', { keycode: command.keycode, action: command.action ?? 'tap' })
      return { ok: true }
    case 'keybind':
      assert(command.action, 'keybind action is required')
      await runKeybind(base, command.action, command.window_id)
      return { ok: true }
    case 'spawn':
      assert(command.command, 'spawn command is required')
      await postJson(base, '/spawn', { command: command.command })
      return { ok: true }
    case 'open-shell-test-window':
      return openShellTestWindow(base, harness.state)
    case 'scenario':
      return runMaximizeNativeBehindShellScenario(harness)
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.length <= 2) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  await mkdir(artifactDir(), { recursive: true })
  await ensureArtifactDir()
  const commands = await parseCommands(process.argv.slice(2))
  const base = await discoverReadyBase()
  const harness: HarnessState = { base, state: createState(base) }
  const results: unknown[] = []
  try {
    for (const command of commands) {
      results.push(await executeCommand(harness, command))
    }
  } catch (error) {
    await captureFailureArtifacts(base, `harness-failure-${Date.now()}`)
    throw error
  }
  process.stdout.write(`${JSON.stringify({ ok: true, base, artifact_dir: artifactDir(), results }, null, 2)}\n`)
}

await main()
