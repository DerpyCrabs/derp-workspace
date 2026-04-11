import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const BTN_LEFT = 0x110
const KEY_A = 30
const NATIVE_APP_ID = 'derp.e2e.native'
const RED_NATIVE_TITLE = 'Derp Native Red'
const GREEN_NATIVE_TITLE = 'Derp Native Green'
const CRASH_NATIVE_TITLE = 'Derp Native Crash Probe'
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  bgCyan: '\x1b[46m',
  black: '\x1b[30m',
}

function color(text, ...codes) {
  return `${codes.join('')}${text}${ANSI.reset}`
}

function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function testLabel(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function createReporter() {
  const startedAt = Date.now()
  const results = []
  return {
    async run(name, fn) {
      const index = results.length + 1
      process.stdout.write(
        `${color(' RUN ', ANSI.bold, ANSI.black, ANSI.bgCyan)} ${color(`[${index}]`, ANSI.cyan)} ${name}\n`,
      )
      const testStartedAt = Date.now()
      try {
        const value = await fn()
        const elapsedMs = Date.now() - testStartedAt
        results.push({ name, status: 'passed', elapsedMs })
        process.stdout.write(
          `${color(' PASS ', ANSI.bold, ANSI.green)} ${name} ${color(formatMs(elapsedMs), ANSI.dim)}\n`,
        )
        return value
      } catch (error) {
        const elapsedMs = Date.now() - testStartedAt
        results.push({ name, status: 'failed', elapsedMs })
        process.stdout.write(
          `${color(' FAIL ', ANSI.bold, ANSI.red)} ${name} ${color(formatMs(elapsedMs), ANSI.dim)}\n`,
        )
        throw error
      }
    },
    printSummary() {
      const passed = results.filter((result) => result.status === 'passed').length
      const failed = results.filter((result) => result.status === 'failed').length
      const total = results.length
      const elapsedMs = Date.now() - startedAt
      process.stdout.write('\n')
      process.stdout.write(
        `${color(' Test Files ', ANSI.dim)} ${color(
          `${failed === 0 ? total : `${passed}/${total}`} passed`,
          ANSI.bold,
          failed === 0 ? ANSI.green : ANSI.red,
        )}\n`,
      )
      process.stdout.write(
        `${color('      Tests ', ANSI.dim)} ${color(`${passed} passed`, ANSI.bold, ANSI.green)}${
          failed ? ` ${color(`${failed} failed`, ANSI.bold, ANSI.red)}` : ''
        }\n`,
      )
      process.stdout.write(
        `${color('   Duration ', ANSI.dim)} ${color(formatMs(elapsedMs), ANSI.bold)}\n`,
      )
    },
  }
}

function stateHome() {
  if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME
  const home = process.env.HOME
  if (!home) throw new Error('HOME is unset')
  return path.join(home, '.local', 'state')
}

function runtimeDir() {
  return process.env.XDG_RUNTIME_DIR || '/tmp'
}

function artifactDir() {
  return process.env.DERP_E2E_ARTIFACT_DIR || path.join(stateHome(), 'derp', 'e2e', 'artifacts')
}

async function ensureArtifactDir() {
  const dir = artifactDir()
  await mkdir(dir, { recursive: true })
  return dir
}

function artifactPath(name) {
  return path.join(artifactDir(), `${Date.now()}-${name}`)
}

async function discoverBase() {
  if (process.env.DERP_E2E_BASE) return process.env.DERP_E2E_BASE.replace(/\/$/, '')
  const urlFile =
    process.env.DERP_SHELL_HTTP_URL_FILE || path.join(runtimeDir(), 'derp-shell-http-url')
  const base = (await readFile(urlFile, 'utf8')).trim()
  if (!base.startsWith('http://127.0.0.1:')) {
    throw new Error(`unexpected shell HTTP base in ${urlFile}: ${base}`)
  }
  return base.replace(/\/$/, '')
}

async function getJson(base, requestPath) {
  const res = await fetch(`${base}${requestPath}`)
  const text = await res.text()
  if (!res.ok) throw new Error(`GET ${requestPath} failed (${res.status}): ${text}`)
  return JSON.parse(text)
}

async function getText(base, requestPath) {
  const res = await fetch(`${base}${requestPath}`)
  const text = await res.text()
  if (!res.ok) throw new Error(`GET ${requestPath} failed (${res.status}): ${text}`)
  return text
}

async function postJson(base, requestPath, body) {
  const res = await fetch(`${base}${requestPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`POST ${requestPath} failed (${res.status}): ${text}`)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function center(rect) {
  assert(rect, 'missing rect')
  return {
    x: rect.global_x + rect.width / 2,
    y: rect.global_y + rect.height / 2,
  }
}

async function waitFor(description, fn, timeoutMs = 5000, intervalMs = 100) {
  const started = Date.now()
  let lastError = null
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  if (lastError) {
    throw new Error(`${description}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }
  throw new Error(`${description}: timed out after ${timeoutMs}ms`)
}

async function writeJsonArtifact(name, value) {
  const filePath = artifactPath(name)
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
  return filePath
}

async function writeTextArtifact(name, value) {
  const filePath = artifactPath(name)
  await writeFile(filePath, value)
  return filePath
}

async function captureFailureArtifacts(base, label) {
  try {
    const [compositor, shell, html] = await Promise.all([
      getJson(base, '/test/state/compositor'),
      getJson(base, '/test/state/shell'),
      getText(base, '/test/state/html'),
    ])
    await writeJsonArtifact(`${label}-compositor.json`, compositor)
    await writeJsonArtifact(`${label}-shell.json`, shell)
    await writeTextArtifact(`${label}-shell.html`, html)
  } catch (error) {
    await writeTextArtifact(
      `${label}-artifact-error.txt`,
      error instanceof Error ? `${error.stack || error.message}\n` : `${String(error)}\n`,
    )
  }
}

async function click(base, rect) {
  const point = center(rect)
  await postJson(base, '/test/input/click', { x: point.x, y: point.y, button: BTN_LEFT })
}

async function tapKey(base, keycode) {
  await postJson(base, '/test/input/key', { keycode, action: 'tap' })
}

async function runKeybind(base, action) {
  await postJson(base, '/test/keybind', { action })
}

function findWindow(snapshot, predicate) {
  return snapshot.windows.find((window) => predicate(window))
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`
}

function nativeBin() {
  return process.env.DERP_E2E_NATIVE_BIN || 'target/release/derp-test-client'
}

function buildNativeSpawnCommand({ title, token, strip, width = 480, height = 320 }) {
  return [
    nativeBin(),
    '--title',
    shellQuote(title),
    '--app-id',
    NATIVE_APP_ID,
    '--token',
    shellQuote(token),
    '--strip',
    shellQuote(strip),
    '--width',
    String(width),
    '--height',
    String(height),
  ].join(' ')
}

async function spawnNativeWindow(base, knownWindowIds, { title, token, strip, width, height }) {
  const command = buildNativeSpawnCommand({ title, token, strip, width, height })
  await postJson(base, '/spawn', { command })
  const result = await waitFor(
    `wait for ${title}`,
    async () => {
      const snapshot = await getJson(base, '/test/state/compositor')
      const window = findWindow(
        snapshot,
        (entry) =>
          !entry.shell_hosted &&
          !knownWindowIds.has(entry.window_id) &&
          entry.app_id === NATIVE_APP_ID &&
          entry.title === title,
      )
      if (!window) return null
      return { snapshot, window, command }
    },
    10000,
    125,
  )
  knownWindowIds.add(result.window.window_id)
  return result
}

function taskbarEntry(shellSnapshot, windowId) {
  return shellSnapshot.taskbar_windows.find((entry) => entry.window_id === windowId) || null
}

async function activateTaskbarWindow(base, shellSnapshot, windowId) {
  const row = taskbarEntry(shellSnapshot, windowId)
  assert(row?.activate, `missing taskbar activate control for window ${windowId}`)
  await click(base, row.activate)
}

async function waitForFocusedWindow(base, windowId) {
  return waitFor(`wait for focus ${windowId}`, async () => {
    const snapshot = await getJson(base, '/test/state/compositor')
    return snapshot.focused_window_id === windowId ? snapshot : null
  })
}

function outputForWindow(snapshot, window) {
  return snapshot.outputs.find((output) => output.name === window.output_name) || null
}

function taskbarForOutput(shellSnapshot, outputName) {
  return shellSnapshot.taskbars.find((taskbar) => taskbar.monitor === outputName) || null
}

function approxEqual(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected} +/- ${tolerance}, got ${actual}`)
  }
}

function assertWindowTiled(window, output, taskbarRect, side) {
  assert(output, `missing output for window ${window.window_id}`)
  assert(taskbarRect, `missing taskbar for output ${window.output_name}`)
  const workX = output.x
  const workWidth = output.width
  const workBottom = taskbarRect.global_y
  const expectedHalfWidth = Math.floor(workWidth / 2)
  const expectedX = side === 'left' ? workX : workX + expectedHalfWidth
  approxEqual(window.x, expectedX, 8, `${side} window x`)
  approxEqual(window.width, expectedHalfWidth, 12, `${side} window width`)
  assert(
    window.y >= output.y && window.y <= output.y + 80,
    `${side} window y: expected top inset within 80px, got ${window.y}`,
  )
  approxEqual(window.y + window.height, workBottom, 12, `${side} window bottom`)
}

async function closeTaskbarWindow(base, shellSnapshot, windowId) {
  const row = shellSnapshot.taskbar_windows.find((entry) => entry.window_id === windowId)
  if (!row?.close) return
  await click(base, row.close)
}

async function closeWindow(base, windowId) {
  await postJson(base, '/test/window/close', { window_id: windowId })
}

async function crashWindow(base, windowId) {
  await postJson(base, '/test/window/crash', { window_id: windowId })
}

async function waitForWindowGone(base, windowId) {
  return waitFor(`wait for window ${windowId} gone`, async () => {
    const [compositor, shell] = await Promise.all([
      getJson(base, '/test/state/compositor'),
      getJson(base, '/test/state/shell'),
    ])
    const compositorHas = compositor.windows.some((window) => window.window_id === windowId)
    const shellHas =
      shell.windows.some((window) => window.window_id === windowId) ||
      shell.taskbar_windows.some((entry) => entry.window_id === windowId)
    return compositorHas || shellHas ? null : { compositor, shell }
  })
}

async function main() {
  await ensureArtifactDir()
  const base = await discoverBase()
  const runStart = Date.now()
  const reporter = createReporter()
  let currentTestName = 'bootstrap'

  try {
    let compositor0
    let shell0
    let knownWindowIds
    let redSpawn
    let greenSpawn
    let tiled
    let screenshot
    let crashProbe

    currentTestName = 'shell-settings-and-key-input'
    await reporter.run('shell settings and key input', async () => {
      compositor0 = await getJson(base, '/test/state/compositor')
      assert(Array.isArray(compositor0.windows), 'compositor snapshot missing windows array')

      shell0 = await getJson(base, '/test/state/shell')
      assert(shell0.controls?.taskbar_settings_toggle, 'shell snapshot missing settings toggle')
      assert(shell0.controls?.taskbar_programs_toggle, 'shell snapshot missing programs toggle')

      const shellSettings =
        shell0.settings_window_visible &&
        shell0.windows.some((window) => window.window_id === 9002 && !window.minimized)
          ? shell0
          : await (async () => {
              await click(base, shell0.controls.taskbar_settings_toggle)
              return waitFor('wait for settings window', async () => {
                const shell = await getJson(base, '/test/state/shell')
                return shell.windows.some((window) => window.window_id === 9002 && !window.minimized)
                  ? shell
                  : null
              })
            })()

      await writeJsonArtifact('settings-shell.json', shellSettings)

      await tapKey(base, KEY_A)
      const shellAfterKey = await getJson(base, '/test/state/shell')
      await writeJsonArtifact('post-key-shell.json', shellAfterKey)
      await closeTaskbarWindow(base, shellAfterKey, 9002)
    })

    currentTestName = 'native-window-tiling'
    await reporter.run('native red/green tile left and right', async () => {
      knownWindowIds = new Set(compositor0.windows.map((window) => window.window_id))
      redSpawn = await spawnNativeWindow(base, knownWindowIds, {
        title: RED_NATIVE_TITLE,
        token: 'native-red',
        strip: 'red',
      })
      greenSpawn = await spawnNativeWindow(base, knownWindowIds, {
        title: GREEN_NATIVE_TITLE,
        token: 'native-green',
        strip: 'green',
      })
      await writeJsonArtifact('native-red-spawn-compositor.json', redSpawn.snapshot)
      await writeJsonArtifact('native-green-spawn-compositor.json', greenSpawn.snapshot)

      const shellAfterNative = await waitFor('wait for native taskbar rows', async () => {
        const shell = await getJson(base, '/test/state/shell')
        return taskbarEntry(shell, redSpawn.window.window_id) &&
          taskbarEntry(shell, greenSpawn.window.window_id)
          ? shell
          : null
      })
      await activateTaskbarWindow(base, shellAfterNative, redSpawn.window.window_id)
      await waitForFocusedWindow(base, redSpawn.window.window_id)
      await runKeybind(base, 'tile_left')

      await activateTaskbarWindow(base, shellAfterNative, greenSpawn.window.window_id)
      await waitForFocusedWindow(base, greenSpawn.window.window_id)
      await runKeybind(base, 'tile_right')

      tiled = await waitFor('wait for red and green tiling', async () => {
        const [compositor, shell] = await Promise.all([
          getJson(base, '/test/state/compositor'),
          getJson(base, '/test/state/shell'),
        ])
        const red = findWindow(compositor, (entry) => entry.window_id === redSpawn.window.window_id)
        const green = findWindow(compositor, (entry) => entry.window_id === greenSpawn.window.window_id)
        if (!red || !green) return null
        const redOutput = outputForWindow(compositor, red)
        const greenOutput = outputForWindow(compositor, green)
        if (!redOutput || !greenOutput || redOutput.name !== greenOutput.name) return null
        const taskbar = taskbarForOutput(shell, redOutput.name)
        if (!taskbar?.rect) return null
        try {
          assertWindowTiled(red, redOutput, taskbar.rect, 'left')
          assertWindowTiled(green, greenOutput, taskbar.rect, 'right')
        } catch {
          return null
        }
        return { compositor, shell, red, green, output: redOutput }
      })
      await writeJsonArtifact('native-tiling-compositor.json', tiled.compositor)
      await writeJsonArtifact('native-tiling-shell.json', tiled.shell)
    })

    currentTestName = 'screenshot-capture'
    await reporter.run('capture tiled workspace screenshot', async () => {
      screenshot = await postJson(base, '/test/screenshot', {})
      assert(screenshot?.path, 'screenshot response missing path')
      await access(screenshot.path)
      await writeJsonArtifact('native-tiling-screenshot-result.json', screenshot)
    })

    currentTestName = 'crash-cleanup'
    await reporter.run('crash probe window disappears from compositor and shell', async () => {
      crashProbe = await spawnNativeWindow(base, knownWindowIds, {
        title: CRASH_NATIVE_TITLE,
        token: 'native-crash-probe',
        strip: 'orange',
      })
      await writeJsonArtifact('native-crash-probe-spawn-compositor.json', crashProbe.snapshot)
      await waitFor('wait for crash probe taskbar row', async () => {
        const shell = await getJson(base, '/test/state/shell')
        return taskbarEntry(shell, crashProbe.window.window_id) ? shell : null
      })
      await crashWindow(base, crashProbe.window.window_id)
      const crashGone = await waitForWindowGone(base, crashProbe.window.window_id)
      await writeJsonArtifact('native-crash-cleanup-compositor.json', crashGone.compositor)
      await writeJsonArtifact('native-crash-cleanup-shell.json', crashGone.shell)
    })

    currentTestName = 'cleanup'
    await reporter.run('cleanup spawned native windows', async () => {
      await crashWindow(base, redSpawn.window.window_id)
      await waitForWindowGone(base, redSpawn.window.window_id)
      await crashWindow(base, greenSpawn.window.window_id)
      await waitForWindowGone(base, greenSpawn.window.window_id)
    })

    const summary = {
      ok: true,
      base,
      native_bin: nativeBin(),
      red_spawn_command: redSpawn.command,
      green_spawn_command: greenSpawn.command,
      duration_ms: Date.now() - runStart,
      settings_window_id: 9002,
      red_window_id: redSpawn.window.window_id,
      green_window_id: greenSpawn.window.window_id,
      crash_probe_window_id: crashProbe.window.window_id,
      tiled_output: tiled.output.name,
      screenshot,
    }
    const summaryPath = await writeJsonArtifact('summary.json', summary)
    process.stdout.write(`${color('    Output ', ANSI.dim)} ${summaryPath}\n`)
    process.stdout.write(`${color(' Screenshot ', ANSI.dim)} ${screenshot.path}\n`)
  } catch (error) {
    const label = `failure-${Date.now()}-${testLabel(currentTestName)}`
    await captureFailureArtifacts(base, label)
    await writeTextArtifact(
      `${label}-error.txt`,
      error instanceof Error ? `${error.stack || error.message}\n` : `${String(error)}\n`,
    )
    throw error
  } finally {
    reporter.printSummary()
  }
}

await main()
