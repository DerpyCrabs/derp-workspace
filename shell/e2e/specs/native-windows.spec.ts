import { fileURLToPath } from 'node:url'

import {
  BTN_LEFT,
  assertTaskbarRowOnMonitor,
  comparePngFixture,
  compositorWindowStack,
  copyArtifactFile,
  GREEN_NATIVE_TITLE,
  KEY,
  NATIVE_APP_ID,
  pickMonitorMove,
  RED_NATIVE_TITLE,
  rectCenter,
  SHELL_UI_DEBUG_WINDOW_ID,
  SHELL_UI_SETTINGS_WINDOW_ID,
  SkipError,
  activateTaskbarWindow,
  autoLayoutManagedWindowsOnOutput,
  assert,
  assertTopWindow,
  assertWindowTiled,
  captureScreenshotRect,
  clickPoint,
  closeWindow,
  compositorWindowById,
  defineGroup,
  doubleClickRect,
  ensureNativePair,
  expectedGridAutoLayoutClientRect,
  getPerfCounters,
  getJson,
  getShellHtml,
  getSnapshots,
  keyAction,
  movePoint,
  movePointRelative,
  openDebug,
  openSettings,
  outputForWindow,
  pointerButton,
  pointerWheel,
  pointInRect,
  postJson,
  raiseTaskbarWindow,
  readPngRgba,
  resetPerfCounters,
  runKeybind,
  shellQuote,
  shellWindowStack,
  spawnCommand,
  spawnNativeWindow,
  shellWindowById,
  syncTest,
  tabGroupByWindow,
  taskbarEntry,
  taskbarForMonitor,
  taskbarWindowOrderOnMonitor,
  waitFor,
  waitForNativeFocus,
  waitForWindowSwitcherClosed,
  waitForWindowSwitcherOpen,
  waitForShellUiFocus,
  waitForWindowRaised,
  waitForWindowGone,
  waitForWindowMinimized,
  assertRectMinSize,
  windowControls,
  writeJsonArtifact,
  type CompositorSnapshot,
  type CompositorWorkspaceRect,
  type ShellSnapshot,
  type WindowSnapshot,
} from '../lib/runtime.ts'

const NATIVE_TITLEBAR_PX = 26
const NATIVE_BORDER_PX = 4

async function assertTitlebarEdgeOwnedByClient(path: string, label: string) {
  const png = await readPngRgba(path)
  const minDominantPixels = Math.floor(png.width * 0.6)
  const dominantRows = Array.from({ length: png.height }, (_, y) => {
    const counts = new Map<string, number>()
    for (let x = 0; x < png.width; x += 1) {
      const index = (y * png.width + x) * 4
      const key = `${png.data[index]},${png.data[index + 1]},${png.data[index + 2]},${png.data[index + 3]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    let color = ''
    let count = 0
    for (const [key, value] of counts) {
      if (value > count) {
        color = key
        count = value
      }
    }
    return { y, color, count }
  })
  const chromeColor = dominantRows[0]?.color ?? ''
  const firstClientRow = dominantRows.find((row) => row.color !== chromeColor)
  assert(firstClientRow !== undefined, `${label} should expose native client pixels below titlebar`)
  assert(
    firstClientRow.y <= 7,
    `${label} edge is still shell chrome at row ${firstClientRow.y}: ${JSON.stringify({ chromeColor, dominantRows })}`,
  )
  const nativeBackgroundRow = dominantRows
    .slice(firstClientRow.y + 1)
    .find((row) => row.color !== chromeColor && row.count >= minDominantPixels)
  assert(
    nativeBackgroundRow !== undefined,
    `${label} should have a stable native background below the titlebar: ${JSON.stringify({ chromeColor, dominantRows })}`,
  )
  assert(
    firstClientRow.color === nativeBackgroundRow.color,
    `${label} first client row is a transition artifact: ${JSON.stringify({
      chromeColor,
      firstClientRow,
      nativeBackgroundRow,
      dominantRows,
    })}`,
  )
  return { width: png.width, height: png.height, chromeColor, firstClientRow, nativeBackgroundRow, dominantRows }
}

async function assertRoundedCsdTransparentOutside(
  path: string,
  label: string,
  capture: { x: number; y: number; width: number; height: number },
  window: { x: number; y: number; width: number; height: number },
  cursor?: { x: number; y: number; size?: number | null },
) {
  const png = await readPngRgba(path)
  const scaleX = png.width / capture.width
  const scaleY = png.height / capture.height
  const radius = Math.min(64, Math.max(18, Math.min(window.width, window.height) / 9))
  const edgeTolerance = 1 / Math.min(scaleX, scaleY)
  const cursorHotspot = cursor
    ? {
        x: (cursor.x - capture.x) * scaleX,
        y: (cursor.y - capture.y) * scaleY,
        size: Math.max(24, cursor.size ?? 24) * Math.max(scaleX, scaleY),
      }
    : null
  const colorAt = (x: number, y: number): [number, number, number] => {
    const index = (y * png.width + x) * 4
    return [png.data[index], png.data[index + 1], png.data[index + 2]]
  }
  const channelDelta = (a: [number, number, number], b: [number, number, number]) =>
    Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
  const referenceFor = (
    px: number,
    py: number,
    x: number,
    y: number,
    localX: number,
    localY: number,
  ): [number, number, number] => {
    if (x < window.x) return colorAt(0, py)
    if (x >= window.x + window.width) return colorAt(png.width - 1, py)
    if (y < window.y) return colorAt(px, 0)
    if (y >= window.y + window.height) return colorAt(px, png.height - 1)
    const left = localX < radius
    const top = localY < radius
    const edgeX = left ? 0 : png.width - 1
    const edgeY = top ? 0 : png.height - 1
    const nearestHorizontal = top ? localY : window.height - localY
    const nearestVertical = left ? localX : window.width - localX
    if (nearestHorizontal <= nearestVertical) return colorAt(px, edgeY)
    return colorAt(edgeX, py)
  }
  let leaking = 0
  let checked = 0
  let maxObservedChannelDelta = 0
  for (let py = 0; py < png.height; py += 1) {
    const gx = capture.x
    const y = capture.y + (py + 0.5) / scaleY
    for (let px = 0; px < png.width; px += 1) {
      const x = gx + (px + 0.5) / scaleX
      const localX = x - window.x
      const localY = y - window.y
      let shouldBeClear =
        x < window.x - edgeTolerance ||
        y < window.y - edgeTolerance ||
        x >= window.x + window.width + edgeTolerance ||
        y >= window.y + window.height + edgeTolerance
      if (!shouldBeClear) {
        const left = localX < radius
        const right = localX >= window.width - radius
        const top = localY < radius
        const bottom = localY >= window.height - radius
        if ((left || right) && (top || bottom)) {
          const cx = left ? radius : window.width - radius
          const cy = top ? radius : window.height - radius
          const dx = localX - cx
          const dy = localY - cy
          shouldBeClear = dx * dx + dy * dy > (radius + 2) * (radius + 2)
        }
      }
      if (!shouldBeClear) continue
      if (
        cursorHotspot &&
        px >= cursorHotspot.x - cursorHotspot.size &&
        px <= cursorHotspot.x + cursorHotspot.size * 2.5 &&
        py >= cursorHotspot.y - cursorHotspot.size &&
        py <= cursorHotspot.y + cursorHotspot.size * 3
      ) {
        continue
      }
      checked += 1
      const delta = channelDelta(colorAt(px, py), referenceFor(px, py, x, y, localX, localY))
      maxObservedChannelDelta = Math.max(maxObservedChannelDelta, delta)
      if (delta > 8) leaking += 1
    }
  }
  assert(checked > 0, `${label} did not check any transparent pixels`)
  assert(
    leaking === 0,
    `${label} leaked ${leaking}/${checked} transparent pixels, max channel delta ${maxObservedChannelDelta}`,
  )
  return { width: png.width, height: png.height, checked, leaking, maxObservedChannelDelta }
}

async function assertSolidCsdEdgeBands(
  path: string,
  label: string,
  capture: { x: number; y: number; width: number; height: number },
  window: { x: number; y: number; width: number; height: number },
  clientColor: [number, number, number],
) {
  const png = await readPngRgba(path)
  const scaleX = png.width / capture.width
  const scaleY = png.height / capture.height
  const radius = Math.min(64, Math.max(18, Math.min(window.width, window.height) / 9))
  const colorAt = (x: number, y: number): [number, number, number] => {
    const index = (y * png.width + x) * 4
    return [png.data[index], png.data[index + 1], png.data[index + 2]]
  }
  const delta = (a: [number, number, number], b: [number, number, number]) =>
    Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
  const counts = new Map<string, number>()
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (x > 2 && x < png.width - 3 && y > 2 && y < png.height - 3) continue
      const c = colorAt(x, y)
      const key = `${c[0]},${c[1]},${c[2]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  let background: [number, number, number] = [0, 0, 0]
  let backgroundCount = 0
  for (const [key, count] of counts) {
    if (count <= backgroundCount) continue
    background = key.split(',').map((entry) => Number(entry)) as [number, number, number]
    backgroundCount = count
  }
  let checkedInside = 0
  let checkedOutside = 0
  let insideLeaks = 0
  let outsideLeaks = 0
  let maxInsideDelta = 0
  let maxOutsideDelta = 0
  const samples: Array<{
    kind: string
    px: number
    py: number
    x: number
    y: number
    actual: [number, number, number]
    expected: [number, number, number]
    delta: number
  }> = []
  for (let py = 0; py < png.height; py += 1) {
    const y = capture.y + (py + 0.5) / scaleY
    for (let px = 0; px < png.width; px += 1) {
      const x = capture.x + (px + 0.5) / scaleX
      const localX = x - window.x
      const localY = y - window.y
      const middleY = localY >= radius + 4 && localY <= window.height - radius - 4
      const middleX = localX >= radius + 4 && localX <= window.width - radius - 4
      let expected: [number, number, number] | null = null
      let kind = ''
      if (middleY && localX >= -2 && localX < 0) {
        expected = background
        kind = 'outside-left'
      } else if (middleY && localX >= window.width && localX < window.width + 2) {
        expected = background
        kind = 'outside-right'
      } else if (middleX && localY >= -2 && localY < 0) {
        expected = background
        kind = 'outside-top'
      } else if (middleX && localY >= window.height && localY < window.height + 2) {
        expected = background
        kind = 'outside-bottom'
      } else if (middleY && localX >= 0 && localX < 2) {
        expected = clientColor
        kind = 'inside-left'
      } else if (middleY && localX >= window.width - 2 && localX < window.width) {
        expected = clientColor
        kind = 'inside-right'
      } else if (middleX && localY >= 0 && localY < 2) {
        expected = clientColor
        kind = 'inside-top'
      } else if (middleX && localY >= window.height - 2 && localY < window.height) {
        expected = clientColor
        kind = 'inside-bottom'
      }
      if (!expected) continue
      const actual = colorAt(px, py)
      const d = delta(actual, expected)
      const outside = kind.startsWith('outside')
      if (outside) {
        checkedOutside += 1
        maxOutsideDelta = Math.max(maxOutsideDelta, d)
        if (d > 8) outsideLeaks += 1
      } else {
        checkedInside += 1
        maxInsideDelta = Math.max(maxInsideDelta, d)
        if (d > 8) insideLeaks += 1
      }
      if (d > 8 && samples.length < 16) {
        samples.push({ kind, px, py, x, y, actual, expected, delta: d })
      }
    }
  }
  assert(checkedInside > 0 && checkedOutside > 0, `${label} did not check both edge bands`)
  assert(
    insideLeaks === 0 && outsideLeaks === 0,
    `${label} edge leak ${JSON.stringify({
      insideLeaks,
      checkedInside,
      maxInsideDelta,
      outsideLeaks,
      checkedOutside,
      maxOutsideDelta,
      background,
      samples,
    })}`,
  )
  return {
    width: png.width,
    height: png.height,
    checkedInside,
    checkedOutside,
    maxInsideDelta,
    maxOutsideDelta,
    background,
  }
}

function resolveWindowOutputName(compositor: CompositorSnapshot, window: WindowSnapshot): string | null {
  const centerX = window.x + Math.floor(window.width / 2)
  const centerY = window.y + Math.floor(window.height / 2)
  const output = compositor.outputs.find(
    (entry) =>
      centerX >= entry.x &&
      centerX < entry.x + entry.width &&
      centerY >= entry.y &&
      centerY < entry.y + entry.height,
  )
  if (output) return output.name
  if (window.output_name) return window.output_name
  return null
}

function windowCenterOnOutput(
  window: WindowSnapshot,
  output: { x: number; y: number; width: number; height: number },
): boolean {
  const cx = window.x + Math.floor(window.width / 2)
  const cy = window.y + Math.floor(window.height / 2)
  return cx >= output.x && cx < output.x + output.width && cy >= output.y && cy < output.y + output.height
}

function nativeDecorTopRect(
  compositor: CompositorSnapshot,
  windowId: number,
): CompositorWorkspaceRect | null {
  return compositor.shell_window_frames?.find((entry) => entry.id === windowId)?.global ?? null
}

function nativeFrameTopLeftFromVisual(visual: {
  x: number
  y: number
}) {
  return {
    x: visual.x - NATIVE_BORDER_PX,
    y: visual.y - NATIVE_TITLEBAR_PX,
  }
}

function rectAroundPoint(point: { x: number; y: number }, size = 4) {
  const half = size / 2
  return { x: 0, y: 0, global_x: point.x - half, global_y: point.y - half, width: size, height: size }
}

function trackedStack(shell: ShellSnapshot, windowIds: number[]) {
  const tracked = new Set(windowIds)
  return shellWindowStack(shell).filter((windowId) => tracked.has(windowId))
}

function trackedCompositorStack(compositor: CompositorSnapshot, windowIds: number[]) {
  const tracked = new Set(windowIds)
  return compositorWindowStack(compositor).filter((windowId) => tracked.has(windowId))
}

function assertRestackToFront(beforeShell: ShellSnapshot, afterShell: ShellSnapshot, focusedWindowId: number, windowIds: number[], label: string) {
  const before = trackedStack(beforeShell, windowIds)
  const after = trackedStack(afterShell, windowIds)
  assert(
    after.length === before.length,
    `${label}: expected ${before.length} tracked windows, got ${after.length} (${after.join(', ')})`,
  )
  assert(after[0] === focusedWindowId, `${label}: expected ${focusedWindowId} frontmost, got ${after.join(', ')}`)
  const beforeSet = [...before].sort((a, b) => a - b)
  const afterSet = [...after].sort((a, b) => a - b)
  assert(
    afterSet.join(',') === beforeSet.join(','),
    `${label}: expected tracked set ${beforeSet.join(', ')}, got ${afterSet.join(', ')}`,
  )
}

function assertTrackedTaskbarOrder(
  shell: ShellSnapshot,
  monitorName: string,
  trackedWindowIds: number[],
  expectedOrder: number[],
  label: string,
) {
  const tracked = new Set(trackedWindowIds)
  const actual = taskbarWindowOrderOnMonitor(shell, monitorName).filter((windowId) => tracked.has(windowId))
  assert(
    actual.join(',') === expectedOrder.join(','),
    `${label}: expected taskbar order ${expectedOrder.join(', ')}, got ${actual.join(', ')}`,
  )
}

function assertStackParity(
  compositor: CompositorSnapshot,
  shell: ShellSnapshot,
  windowIds: number[],
  label: string,
) {
  const shellTracked = trackedStack(shell, windowIds)
  const compositorTracked = trackedCompositorStack(compositor, windowIds)
  assert(
    compositorTracked.length === shellTracked.length,
    `${label}: expected ${shellTracked.length} tracked compositor windows, got ${compositorTracked.length} (${compositorTracked.join(', ')})`,
  )
  assert(
    compositorTracked.join(',') === shellTracked.join(','),
    `${label}: compositor stack ${compositorTracked.join(', ')} != shell stack ${shellTracked.join(', ')}`,
  )
}

function assertOutputOrderMatchesGlobalTop(
  compositor: CompositorSnapshot,
  outputName: string,
  expectedTopWindowId: number,
  label: string,
) {
  const row = compositor.ordered_window_ids_by_output?.find((entry) => entry.output_name === outputName)
  assert(row, `${label}: missing ordered stack for output ${outputName}`)
  const rowSet = new Set(row.window_ids)
  const expectedBottomToTop = compositorWindowStack(compositor)
    .filter((windowId) => rowSet.has(windowId))
    .reverse()
  assert(
    row.window_ids.join(',') === expectedBottomToTop.join(','),
    `${label}: expected output order ${expectedBottomToTop.join(', ')}, got ${row.window_ids.join(', ')}`,
  )
  const top = row.window_ids[row.window_ids.length - 1] ?? null
  assert(top === expectedTopWindowId, `${label}: expected top output window ${expectedTopWindowId}, got ${top}`)
}

async function waitForOutputOrderMatchesGlobalTop(
  base: string,
  outputName: string,
  expectedTopWindowId: number,
  label: string,
) {
  return waitFor(
    label,
    async () => {
      const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
      try {
        assertOutputOrderMatchesGlobalTop(compositor, outputName, expectedTopWindowId, label)
      } catch {
        return null
      }
      return compositor
    },
    5000,
    100,
  )
}

async function waitForTrackedStackParity(base: string, windowIds: number[], label: string) {
  return waitFor(
    label,
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      try {
        assertStackParity(compositor, shell, windowIds, label)
      } catch {
        return null
      }
      return { compositor, shell }
    },
    2000,
    100,
  )
}

async function waitForSettingsTilingLayoutTriggerReady(base: string) {
  let lastRectKey = ''
  return waitFor(
    'wait for tiling layout trigger ready',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const rect = shell.controls?.settings_tiling_layout_trigger
      if (!rect) {
        const settingsWindow = shellWindowById(shell, SHELL_UI_SETTINGS_WINDOW_ID)
        if (settingsWindow) {
          await movePoint(
            base,
            settingsWindow.x + Math.floor(settingsWindow.width / 2),
            settingsWindow.y + Math.floor(settingsWindow.height / 2),
          )
          await pointerWheel(base, 0, -360)
        }
        return null
      }
      const nextKey = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`
      if (nextKey !== lastRectKey) {
        lastRectKey = nextKey
        return null
      }
      return shell
    },
    5000,
    100,
  )
}

async function switchSettingsPage(base: string) {
  return waitFor(
    'wait for settings tiling page',
    async () => {
      const html = await getShellHtml(base, '[data-settings-root]')
      if (html.includes('data-settings-active-page="tiling"') && html.includes('data-settings-tiling-page')) {
        return html
      }
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const rect = shell.controls?.settings_tab_tiling
      if (rect) {
        await clickPoint(base, rect.global_x + rect.width / 2, rect.global_y + rect.height / 2)
      }
      return null
    },
    5000,
    100,
  )
}

async function selectSettingsTilingLayout(base: string, layout: 'grid' | 'manual-snap') {
  await switchSettingsPage(base)
  const tilingPageReady = await waitForSettingsTilingLayoutTriggerReady(base)
  const optionKey =
    layout === 'grid' ? 'settings_tiling_layout_option_grid' : 'settings_tiling_layout_option_manual_snap'
  if (!tilingPageReady.controls?.[optionKey]) {
    assert(tilingPageReady.controls?.settings_tiling_layout_trigger, 'missing tiling layout trigger')
    const trigger = tilingPageReady.controls.settings_tiling_layout_trigger
    await clickPoint(base, trigger.global_x + trigger.width / 2, trigger.global_y + trigger.height / 2)
  }
  const tilingLayoutOpen = await waitFor(
    `wait for tiling layout menu option ${layout}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return shell.controls?.[optionKey] ? shell : null
    },
    5000,
    100,
  )
  const option = tilingLayoutOpen.controls![optionKey]!
  await clickPoint(base, option.global_x + option.width / 2, option.global_y + option.height / 2)
  await waitFor(
    `wait for tiling layout set to ${layout}`,
    async () => {
      const html = await getShellHtml(base, '[data-settings-tiling-page]')
      return html.includes(layout) ? html : null
    },
    5000,
    100,
  )
}

function windowContainsPoint(
  window: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number },
): boolean {
  return pointInRect(
    {
      x: window.x,
      y: window.y,
      width: window.width,
      height: window.height,
      global_x: window.x,
      global_y: window.y,
    },
    point,
  )
}

async function tileNativePair(base: string, redId: number, greenId: number) {
  await raiseTaskbarWindow(base, redId)
  await waitForNativeFocus(base, redId, 5000)
  await runKeybind(base, 'tile_left')
  await waitFor(
    'wait for native red tiled left',
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const red = compositorWindowById(compositor, redId)
      if (!red) return null
      const redOutput = outputForWindow(compositor, red)
      const taskbar = redOutput ? taskbarForMonitor(shell, redOutput.name) : null
      if (!redOutput || !taskbar?.rect) return null
      try {
        assertWindowTiled(red, redOutput, taskbar.rect, 'left')
      } catch {
        return null
      }
      return { compositor, shell, red, output: redOutput }
    },
    5000,
    100,
  )
  await raiseTaskbarWindow(base, greenId)
  await waitForNativeFocus(base, greenId, 5000)
  await runKeybind(base, 'tile_right')
  return waitFor(
    'wait for native red and green tiling',
    async () => {
      const { compositor, shell: currentShell } = await getSnapshots(base)
      const red = compositorWindowById(compositor, redId)
      const green = compositorWindowById(compositor, greenId)
      if (!red || !green) return null
      const redOutput = outputForWindow(compositor, red)
      const greenOutput = outputForWindow(compositor, green)
      if (!redOutput || !greenOutput || redOutput.name !== greenOutput.name) return null
      const taskbar = taskbarForMonitor(currentShell, redOutput.name)
      if (!taskbar?.rect) return null
      try {
        assertWindowTiled(red, redOutput, taskbar.rect, 'left')
        assertWindowTiled(green, greenOutput, taskbar.rect, 'right')
      } catch {
        return null
      }
      return { compositor, shell: currentShell, output: redOutput }
    },
    8000,
    100,
  )
}

function visibleWindowClickPoint(shell: ShellSnapshot, windowId: number): { x: number; y: number } {
  const target = shellWindowById(shell, windowId)
  assert(target, `missing shell snapshot for window ${windowId}`)
  const stack = shellWindowStack(shell)
  const targetStackIndex = stack.indexOf(windowId)
  assert(targetStackIndex >= 0, `window ${windowId} missing from shell stack`)
  const blockers = stack
    .slice(0, targetStackIndex)
    .map((id) => shellWindowById(shell, id))
    .filter((window): window is NonNullable<typeof window> => !!window && !window.minimized)
  const clampInset = (value: number, size: number) => Math.max(8, Math.min(size - 8, Math.floor(value)))
  const xOffsets = [
    12,
    20,
    32,
    48,
    72,
    Math.floor(target.width / 2),
    target.width - 72,
    target.width - 48,
    target.width - 32,
    target.width - 20,
    target.width - 12,
  ]
  const yOffsets = [
    12,
    20,
    32,
    48,
    72,
    Math.floor(target.height / 2),
    target.height - 72,
    target.height - 48,
    target.height - 32,
    target.height - 20,
    target.height - 12,
  ]
  const uniqueX = [...new Set(xOffsets.map((offset) => clampInset(offset, target.width)))]
  const uniqueY = [...new Set(yOffsets.map((offset) => clampInset(offset, target.height)))]
  const candidates = uniqueX.flatMap((xOffset) =>
    uniqueY.map((yOffset) => ({
      x: target.x + xOffset,
      y: target.y + yOffset,
    })),
  )
  const visible = candidates.find((candidate) =>
    windowContainsPoint(target, candidate) && blockers.every((window) => !windowContainsPoint(window, candidate)),
  )
  assert(visible, `window ${windowId} has no exposed click point`)
  return visible
}

async function waitForNativeTitleContains(
  base: string,
  windowId: number,
  expected: string,
  label: string,
) {
  return waitFor(
    label,
    async () => {
      const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
      const window = compositorWindowById(compositor, windowId)
      if (!window || !window.title.includes(expected)) return null
      return { compositor, window }
    },
    5000,
    100,
  )
}

async function waitForNativeWindowGeometry(
  base: string,
  windowId: number,
  label: string,
) {
  return waitFor(
    label,
    async () => {
      const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
      const window = compositorWindowById(compositor, windowId)
      if (!window || window.width < 1 || window.height < 1) return null
      return { compositor, window }
    },
    5000,
    100,
  )
}

async function waitForFootWindow(base: string, knownWindowIds: Set<number>, label: string) {
  return waitFor(
    label,
    async () => {
      const snapshots = await getSnapshots(base)
      const window = snapshots.compositor.windows.find(
        (entry) =>
          !entry.shell_hosted &&
          !knownWindowIds.has(entry.window_id) &&
          entry.app_id === 'foot' &&
          !entry.minimized,
      )
      if (!window) return null
      const controls = windowControls(snapshots.shell, window.window_id)
      if (!controls?.titlebar) return null
      return { ...snapshots, window, controls }
    },
    5000,
    100,
  )
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('screen sharing indicator stays native-only and above managed windows', async ({ base, state }) => {
    const stamp = Date.now()
    const normal = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Managed Native ${stamp}`,
      token: `managed-native-${stamp}`,
      strip: 'green',
      width: 520,
      height: 340,
    })
    const alternate = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Alternate Native ${stamp}`,
      token: `alternate-native-${stamp}`,
      strip: 'red',
      width: 520,
      height: 340,
    })
    const indicator = await spawnNativeWindow(base, state.knownWindowIds, {
      title: 'meet.example.test is sharing your screen.',
      appId: 'google-chrome-unstable',
      token: `sharing-indicator-${stamp}`,
      strip: 'blue',
      width: 610,
      height: 64,
      moveOnHeaderPress: true,
    })
    state.spawnedNativeWindowIds.add(normal.window.window_id)
    state.spawnedNativeWindowIds.add(alternate.window.window_id)
    state.spawnedNativeWindowIds.add(indicator.window.window_id)

    const hidden = await waitFor(
      'wait for sharing indicator hidden from shell model',
      async () => {
        const snapshots = await getSnapshots(base)
        const compositorIndicator = compositorWindowById(snapshots.compositor, indicator.window.window_id)
        if (!compositorIndicator) return null
        if (shellWindowById(snapshots.shell, indicator.window.window_id)) return null
        if (taskbarEntry(snapshots.shell, indicator.window.window_id)) return null
        if (tabGroupByWindow(snapshots.shell, indicator.window.window_id)) return null
        return snapshots
      },
      5000,
      50,
    )
    const hiddenIndicator = compositorWindowById(hidden.compositor, indicator.window.window_id)
    assert(hiddenIndicator !== null, 'sharing indicator should exist in compositor')
    const output = outputForWindow(hidden.compositor, hiddenIndicator)
    assert(output !== null, 'sharing indicator should have an output')
    const usableY = output.usable_y ?? output.y
    const usableHeight = output.usable_height ?? output.height
    assert(
      hiddenIndicator.y >= usableY + Math.floor(usableHeight * 0.55),
      `sharing indicator should open near bottom of output: ${JSON.stringify({ indicator: hiddenIndicator, output })}`,
    )

    const dragStart = {
      x: Math.round(hiddenIndicator.x + Math.min(hiddenIndicator.width, 180) / 2),
      y: Math.round(hiddenIndicator.y + Math.min(hiddenIndicator.height, 24) / 2),
    }
    await movePoint(base, dragStart.x, dragStart.y)
    await pointerButton(base, BTN_LEFT, 'press')
    await movePoint(base, dragStart.x + 90, dragStart.y + 36)
    const duringDrag = await waitFor(
      'wait for sharing indicator native move',
      async () => {
        const snapshots = await getSnapshots(base)
        if (snapshots.compositor.shell_move_window_id !== indicator.window.window_id) return null
        return snapshots
      },
      1000,
      20,
    )
    await movePoint(base, dragStart.x + 180, dragStart.y + 60)
    await pointerButton(base, BTN_LEFT, 'release')
    await syncTest(base)
    const afterDrag = await waitFor(
      'wait for sharing indicator drag position',
      async () => {
        const snapshots = await getSnapshots(base)
        const moved = compositorWindowById(snapshots.compositor, indicator.window.window_id)
        if (!moved) return null
        if (Math.abs(moved.x - hiddenIndicator.x) < 20 && Math.abs(moved.y - hiddenIndicator.y) < 20) return null
        if (shellWindowById(snapshots.shell, indicator.window.window_id)) return null
        if (taskbarEntry(snapshots.shell, indicator.window.window_id)) return null
        if (tabGroupByWindow(snapshots.shell, indicator.window.window_id)) return null
        return { snapshots, moved }
      },
      2000,
      50,
    )

    await raiseTaskbarWindow(base, normal.window.window_id)
    const raised = await waitForWindowRaised(base, normal.window.window_id)
    const stack = compositorWindowStack(raised.compositor)
    assert(
      stack[0] === indicator.window.window_id,
      `sharing indicator should remain topmost after managed window raise: ${JSON.stringify(stack)}`,
    )

    await keyAction(base, KEY.alt, 'press')
    await keyAction(base, KEY.tab, 'tap')
    const switcher = await waitForWindowSwitcherOpen(base)
    assert(
      switcher.window_switcher_selected_window_id !== indicator.window.window_id,
      'window switcher should not select sharing indicator',
    )
    await keyAction(base, KEY.alt, 'release')
    await waitForWindowSwitcherClosed(base)

    await writeJsonArtifact('screen-sharing-indicator-native-only.json', {
      normal: normal.window,
      alternate: alternate.window,
      indicator: indicator.window,
      hiddenIndicator,
      movedIndicator: afterDrag.moved,
      stack,
      switcherSelectedWindowId: switcher.window_switcher_selected_window_id,
      duringDragCompositor: duringDrag.compositor,
    })
  })

  test('spawn native red and green windows', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    await writeJsonArtifact('native-red-spawn.json', red.snapshot)
    await writeJsonArtifact('native-green-spawn.json', green.snapshot)
  })

  test('native content stays stable after cursor sweep', async ({ base, state }) => {
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: 'Derp Native Cursor Damage',
      token: 'native-cursor-damage',
      strip: 'cyan',
      width: 680,
      height: 440,
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    const windowId = spawned.window.window_id
    await waitForWindowRaised(base, windowId)
    await waitForNativeFocus(base, windowId, 4000)
    const ready = await waitForNativeWindowGeometry(base, windowId, 'wait for native cursor damage geometry')
    const window = ready.window
    const rect = {
      x: window.x + 48,
      y: window.y + 48,
      width: Math.min(420, window.width - 96),
      height: Math.min(260, window.height - 96),
    }
    assert(rect.width >= 180 && rect.height >= 120, `native cursor damage rect too small ${rect.width}x${rect.height}`)
    const outside = {
      x: window.x + Math.min(window.width - 12, rect.x - window.x + rect.width + 48),
      y: window.y + Math.min(window.height - 12, rect.y - window.y + rect.height + 48),
    }
    await movePoint(base, outside.x, outside.y)
    const before = await captureScreenshotRect(base, rect)
    const bottomSeamRect = {
      x: window.x - NATIVE_BORDER_PX,
      y: window.y + window.height - 5,
      width: Math.min(520, window.width + NATIVE_BORDER_PX * 2),
      height: 10,
    }
    const topSeamRect = {
      x: window.x - NATIVE_BORDER_PX,
      y: window.y - 5,
      width: Math.min(520, window.width + NATIVE_BORDER_PX * 2),
      height: 10,
    }
    const leftSeamRect = {
      x: window.x - 5,
      y: window.y + 12,
      width: 10,
      height: Math.min(260, window.height - 24),
    }
    const rightSeamRect = {
      x: window.x + window.width - 5,
      y: window.y + 12,
      width: 10,
      height: Math.min(260, window.height - 24),
    }
    const bottomSeamBefore = await captureScreenshotRect(base, bottomSeamRect)
    const topSeamBefore = await captureScreenshotRect(base, topSeamRect)
    const leftSeamBefore = await captureScreenshotRect(base, leftSeamRect)
    const rightSeamBefore = await captureScreenshotRect(base, rightSeamRect)
    const ys = [
      rect.y + 16,
      rect.y + Math.floor(rect.height / 2),
      rect.y + rect.height - 16,
    ]
    for (const y of ys) {
      for (let x = rect.x + 8; x <= rect.x + rect.width - 8; x += 37) {
        await movePoint(base, x, y)
      }
    }
    for (let x = bottomSeamRect.x + 8; x <= bottomSeamRect.x + bottomSeamRect.width - 8; x += 29) {
      await movePoint(base, x, window.y + window.height - 1)
      await movePoint(base, x, window.y + window.height + 1)
    }
    for (let x = topSeamRect.x + 8; x <= topSeamRect.x + topSeamRect.width - 8; x += 29) {
      await movePoint(base, x, window.y - 1)
      await movePoint(base, x, window.y + 1)
    }
    for (let y = leftSeamRect.y + 8; y <= leftSeamRect.y + leftSeamRect.height - 8; y += 29) {
      await movePoint(base, window.x - 1, y)
      await movePoint(base, window.x + 1, y)
    }
    for (let y = rightSeamRect.y + 8; y <= rightSeamRect.y + rightSeamRect.height - 8; y += 29) {
      await movePoint(base, window.x + window.width - 1, y)
      await movePoint(base, window.x + window.width + 1, y)
    }
    await movePoint(base, outside.x, outside.y)
    await syncTest(base)
    const after = await captureScreenshotRect(base, rect)
    const bottomSeamAfter = await captureScreenshotRect(base, bottomSeamRect)
    const topSeamAfter = await captureScreenshotRect(base, topSeamRect)
    const leftSeamAfter = await captureScreenshotRect(base, leftSeamRect)
    const rightSeamAfter = await captureScreenshotRect(base, rightSeamRect)
    const comparison = await comparePngFixture(after.path, before.path)
    const bottomSeamComparison = await comparePngFixture(bottomSeamAfter.path, bottomSeamBefore.path, {
      maxChannelDelta: 31,
    })
    const topSeamComparison = await comparePngFixture(topSeamAfter.path, topSeamBefore.path)
    const topEdgeOwnership = await assertTitlebarEdgeOwnedByClient(topSeamAfter.path, 'native titlebar seam')
    const leftSeamComparison = await comparePngFixture(leftSeamAfter.path, leftSeamBefore.path)
    const rightSeamComparison = await comparePngFixture(rightSeamAfter.path, rightSeamBefore.path)
    const beforeArtifact = await copyArtifactFile('native-cursor-damage-before.png', before.path)
    const afterArtifact = await copyArtifactFile('native-cursor-damage-after.png', after.path)
    const bottomSeamBeforeArtifact = await copyArtifactFile(
      'native-cursor-damage-bottom-seam-before.png',
      bottomSeamBefore.path,
    )
    const bottomSeamAfterArtifact = await copyArtifactFile(
      'native-cursor-damage-bottom-seam-after.png',
      bottomSeamAfter.path,
    )
    const topSeamBeforeArtifact = await copyArtifactFile('native-cursor-damage-top-seam-before.png', topSeamBefore.path)
    const topSeamAfterArtifact = await copyArtifactFile('native-cursor-damage-top-seam-after.png', topSeamAfter.path)
    const leftSeamBeforeArtifact = await copyArtifactFile('native-cursor-damage-left-seam-before.png', leftSeamBefore.path)
    const leftSeamAfterArtifact = await copyArtifactFile('native-cursor-damage-left-seam-after.png', leftSeamAfter.path)
    const rightSeamBeforeArtifact = await copyArtifactFile('native-cursor-damage-right-seam-before.png', rightSeamBefore.path)
    const rightSeamAfterArtifact = await copyArtifactFile('native-cursor-damage-right-seam-after.png', rightSeamAfter.path)
    await writeJsonArtifact('native-cursor-damage.json', {
      windowId,
      window,
      rect,
      bottomSeamRect,
      topSeamRect,
      leftSeamRect,
      rightSeamRect,
      outside,
      before: beforeArtifact,
      after: afterArtifact,
      bottomSeamBefore: bottomSeamBeforeArtifact,
      bottomSeamAfter: bottomSeamAfterArtifact,
      topSeamBefore: topSeamBeforeArtifact,
      topSeamAfter: topSeamAfterArtifact,
      leftSeamBefore: leftSeamBeforeArtifact,
      leftSeamAfter: leftSeamAfterArtifact,
      rightSeamBefore: rightSeamBeforeArtifact,
      rightSeamAfter: rightSeamAfterArtifact,
      comparison,
      bottomSeamComparison,
      topSeamComparison,
      topEdgeOwnership,
      leftSeamComparison,
      rightSeamComparison,
    })
  })

  test('CSD native edges stay stable after cursor sweep', async ({ base, state }) => {
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: 'Derp CSD Cursor Damage',
      token: 'csd-cursor-damage',
      strip: 'green',
      width: 680,
      height: 440,
      xdgDecorationClientSide: true,
      moveOnHeaderPress: true,
      roundedCorners: true,
      noBorder: true,
      solidClient: true,
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    const windowId = spawned.window.window_id
    await waitForWindowRaised(base, windowId)
    await waitForNativeFocus(base, windowId, 4000)
    const ready = await waitFor(
      'wait for CSD cursor damage geometry',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const window = compositorWindowById(compositor, windowId)
        const shellWindow = shell.windows.find((entry) => entry.window_id === windowId)
        if (!window || !shellWindow) return null
        if (!window.client_side_decoration || !shellWindow.client_side_decoration) return null
        const controls = windowControls(shell, windowId)
        if (controls?.titlebar) return null
        return { compositor, shell, window }
      },
      3000,
      40,
    )
    const window = ready.window
    const topSeamRect = {
      x: window.x,
      y: window.y - 5,
      width: Math.min(520, window.width),
      height: 10,
    }
    const leftSeamRect = {
      x: window.x - 5,
      y: window.y,
      width: 10,
      height: Math.min(360, window.height),
    }
    const rightSeamRect = {
      x: window.x + window.width - 5,
      y: window.y,
      width: 10,
      height: Math.min(360, window.height),
    }
    const bottomSeamRect = {
      x: window.x,
      y: window.y + window.height - 5,
      width: Math.min(520, window.width),
      height: 10,
    }
    const fullEdgeRect = {
      x: window.x - 8,
      y: window.y - 8,
      width: window.width + 16,
      height: window.height + 16,
    }
    const outside = {
      x: window.x + Math.min(window.width - 12, 80),
      y: window.y + Math.min(window.height - 12, 80),
    }
    await movePoint(base, outside.x, outside.y)
    await syncTest(base)
    const topBefore = await captureScreenshotRect(base, topSeamRect)
    const leftBefore = await captureScreenshotRect(base, leftSeamRect)
    const rightBefore = await captureScreenshotRect(base, rightSeamRect)
    const bottomBefore = await captureScreenshotRect(base, bottomSeamRect)
    const fullBefore = await captureScreenshotRect(base, fullEdgeRect)
    for (let x = topSeamRect.x + 8; x <= topSeamRect.x + topSeamRect.width - 8; x += 29) {
      await movePoint(base, x, window.y - 1)
      await movePoint(base, x, window.y + 1)
    }
    for (let y = leftSeamRect.y + 8; y <= leftSeamRect.y + leftSeamRect.height - 8; y += 29) {
      await movePoint(base, window.x - 1, y)
      await movePoint(base, window.x + 1, y)
      await movePoint(base, window.x + window.width - 1, y)
      await movePoint(base, window.x + window.width + 1, y)
    }
    for (let x = bottomSeamRect.x + 8; x <= bottomSeamRect.x + bottomSeamRect.width - 8; x += 29) {
      await movePoint(base, x, window.y + window.height - 1)
      await movePoint(base, x, window.y + window.height + 1)
    }
    await movePoint(base, outside.x, outside.y)
    await syncTest(base)
    const topAfter = await captureScreenshotRect(base, topSeamRect)
    const leftAfter = await captureScreenshotRect(base, leftSeamRect)
    const rightAfter = await captureScreenshotRect(base, rightSeamRect)
    const bottomAfter = await captureScreenshotRect(base, bottomSeamRect)
    const fullAfter = await captureScreenshotRect(base, fullEdgeRect)
    const topComparison = await comparePngFixture(topAfter.path, topBefore.path, {
      maxChannelDelta: 4,
      maxDifferentPixels: 16,
    })
    const leftComparison = await comparePngFixture(leftAfter.path, leftBefore.path, {
      maxChannelDelta: 4,
      maxDifferentPixels: 16,
    })
    const rightComparison = await comparePngFixture(rightAfter.path, rightBefore.path, {
      maxChannelDelta: 4,
      maxDifferentPixels: 16,
    })
    const bottomComparison = await comparePngFixture(bottomAfter.path, bottomBefore.path, {
      maxChannelDelta: 4,
      maxDifferentPixels: 16,
    })
    const topBeforeArtifact = await copyArtifactFile('csd-native-seam-top-before.png', topBefore.path)
    const topAfterArtifact = await copyArtifactFile('csd-native-seam-top-after.png', topAfter.path)
    const leftBeforeArtifact = await copyArtifactFile('csd-native-seam-left-before.png', leftBefore.path)
    const leftAfterArtifact = await copyArtifactFile('csd-native-seam-left-after.png', leftAfter.path)
    const rightBeforeArtifact = await copyArtifactFile('csd-native-seam-right-before.png', rightBefore.path)
    const rightAfterArtifact = await copyArtifactFile('csd-native-seam-right-after.png', rightAfter.path)
    const bottomBeforeArtifact = await copyArtifactFile('csd-native-seam-bottom-before.png', bottomBefore.path)
    const bottomAfterArtifact = await copyArtifactFile('csd-native-seam-bottom-after.png', bottomAfter.path)
    const fullBeforeArtifact = await copyArtifactFile('csd-native-seam-full-before.png', fullBefore.path)
    const fullAfterArtifact = await copyArtifactFile('csd-native-seam-full-after.png', fullAfter.path)
    const fullBeforeAlpha = await assertRoundedCsdTransparentOutside(
      fullBefore.path,
      'CSD transparent edge before cursor sweep',
      fullEdgeRect,
      window,
    )
    const fullAfterAlpha = await assertRoundedCsdTransparentOutside(
      fullAfter.path,
      'CSD transparent edge after cursor sweep',
      fullEdgeRect,
      window,
    )
    const fullBeforeSolidBands = await assertSolidCsdEdgeBands(
      fullBefore.path,
      'CSD solid edge before cursor sweep',
      fullEdgeRect,
      window,
      [50, 190, 90],
    )
    const fullAfterSolidBands = await assertSolidCsdEdgeBands(
      fullAfter.path,
      'CSD solid edge after cursor sweep',
      fullEdgeRect,
      window,
      [50, 190, 90],
    )
    await writeJsonArtifact('csd-native-cursor-damage.json', {
      windowId,
      window,
      topSeamRect,
      leftSeamRect,
      rightSeamRect,
      bottomSeamRect,
      fullEdgeRect,
      topBefore: topBeforeArtifact,
      topAfter: topAfterArtifact,
      leftBefore: leftBeforeArtifact,
      leftAfter: leftAfterArtifact,
      rightBefore: rightBeforeArtifact,
      rightAfter: rightAfterArtifact,
      bottomBefore: bottomBeforeArtifact,
      bottomAfter: bottomAfterArtifact,
      fullBefore: fullBeforeArtifact,
      fullAfter: fullAfterArtifact,
      topComparison,
      leftComparison,
      rightComparison,
      bottomComparison,
      fullBeforeAlpha,
      fullAfterAlpha,
      fullBeforeSolidBands,
      fullAfterSolidBands,
    })
  })

  test('real foot native decoration seams stay stable after cursor sweep', async ({ base, state }) => {
    await spawnCommand(base, `foot --title derp-native-seam-foot sh -c ${shellQuote('printf "\\033[2J\\033[H"; sleep 60')}`)
    const opened = await waitForFootWindow(base, state.knownWindowIds, 'wait for foot native seam window')
    const windowId = opened.window.window_id
    state.knownWindowIds.add(windowId)
    state.spawnedNativeWindowIds.add(windowId)
    await waitForWindowRaised(base, windowId)
    await waitForNativeFocus(base, windowId, 4000)
    const ready = await waitForNativeWindowGeometry(base, windowId, 'wait for foot native seam geometry')
    const window = ready.window
    const outside = {
      x: window.x + Math.min(window.width - 12, 80),
      y: window.y + Math.min(window.height - 12, 80),
    }
    const topSeamRect = {
      x: window.x - NATIVE_BORDER_PX,
      y: window.y - 5,
      width: Math.min(520, window.width + NATIVE_BORDER_PX * 2),
      height: 10,
    }
    const bottomSeamRect = {
      x: window.x - NATIVE_BORDER_PX,
      y: window.y + window.height - 5,
      width: Math.min(520, window.width + NATIVE_BORDER_PX * 2),
      height: 10,
    }
    const leftSeamRect = {
      x: window.x - 5,
      y: window.y + 12,
      width: 10,
      height: Math.min(260, window.height - 24),
    }
    const rightSeamRect = {
      x: window.x + window.width - 5,
      y: window.y + 12,
      width: 10,
      height: Math.min(260, window.height - 24),
    }
    await movePoint(base, outside.x, outside.y)
    await syncTest(base)
    const topBefore = await captureScreenshotRect(base, topSeamRect)
    const bottomBefore = await captureScreenshotRect(base, bottomSeamRect)
    const leftBefore = await captureScreenshotRect(base, leftSeamRect)
    const rightBefore = await captureScreenshotRect(base, rightSeamRect)
    for (let x = topSeamRect.x + 8; x <= topSeamRect.x + topSeamRect.width - 8; x += 29) {
      await movePoint(base, x, window.y - 1)
      await movePoint(base, x, window.y + 1)
    }
    for (let x = bottomSeamRect.x + 8; x <= bottomSeamRect.x + bottomSeamRect.width - 8; x += 29) {
      await movePoint(base, x, window.y + window.height - 1)
      await movePoint(base, x, window.y + window.height + 1)
    }
    for (let y = leftSeamRect.y + 8; y <= leftSeamRect.y + leftSeamRect.height - 8; y += 29) {
      await movePoint(base, window.x - 1, y)
      await movePoint(base, window.x + 1, y)
    }
    for (let y = rightSeamRect.y + 8; y <= rightSeamRect.y + rightSeamRect.height - 8; y += 29) {
      await movePoint(base, window.x + window.width - 1, y)
      await movePoint(base, window.x + window.width + 1, y)
    }
    await movePoint(base, outside.x, outside.y)
    await syncTest(base)
    const topAfter = await captureScreenshotRect(base, topSeamRect)
    const bottomAfter = await captureScreenshotRect(base, bottomSeamRect)
    const leftAfter = await captureScreenshotRect(base, leftSeamRect)
    const rightAfter = await captureScreenshotRect(base, rightSeamRect)
    const topComparison = await comparePngFixture(topAfter.path, topBefore.path, { maxDifferentPixels: 1200 })
    const bottomComparison = await comparePngFixture(bottomAfter.path, bottomBefore.path, {
      maxChannelDelta: 8,
      maxDifferentPixels: 300,
    })
    const topEdgeOwnership = await assertTitlebarEdgeOwnedByClient(topAfter.path, 'foot native titlebar seam')
    const leftComparison = await comparePngFixture(leftAfter.path, leftBefore.path, { maxDifferentPixels: 300 })
    const rightComparison = await comparePngFixture(rightAfter.path, rightBefore.path, { maxDifferentPixels: 300 })
    const topBeforeArtifact = await copyArtifactFile('foot-native-seam-top-before.png', topBefore.path)
    const topAfterArtifact = await copyArtifactFile('foot-native-seam-top-after.png', topAfter.path)
    const bottomBeforeArtifact = await copyArtifactFile('foot-native-seam-bottom-before.png', bottomBefore.path)
    const bottomAfterArtifact = await copyArtifactFile('foot-native-seam-bottom-after.png', bottomAfter.path)
    const leftBeforeArtifact = await copyArtifactFile('foot-native-seam-left-before.png', leftBefore.path)
    const leftAfterArtifact = await copyArtifactFile('foot-native-seam-left-after.png', leftAfter.path)
    const rightBeforeArtifact = await copyArtifactFile('foot-native-seam-right-before.png', rightBefore.path)
    const rightAfterArtifact = await copyArtifactFile('foot-native-seam-right-after.png', rightAfter.path)
    await writeJsonArtifact('foot-native-seams.json', {
      windowId,
      window,
      topSeamRect,
      bottomSeamRect,
      leftSeamRect,
      rightSeamRect,
      topBefore: topBeforeArtifact,
      topAfter: topAfterArtifact,
      bottomBefore: bottomBeforeArtifact,
      bottomAfter: bottomAfterArtifact,
      leftBefore: leftBeforeArtifact,
      leftAfter: leftAfterArtifact,
      rightBefore: rightBeforeArtifact,
      rightAfter: rightAfterArtifact,
      topComparison,
      bottomComparison,
      topEdgeOwnership,
      leftComparison,
      rightComparison,
    })
  })

  test('decorated native window disappears when its client drops content', async ({ base, state }) => {
    const dropped = await spawnNativeWindow(base, state.knownWindowIds, {
      title: 'Derp Native Buffer Drop',
      token: 'native-buffer-drop',
      strip: 'green',
      dropBufferAfterDraw: true,
    })
    state.spawnedNativeWindowIds.add(dropped.window.window_id)
    try {
      const gone = await waitForWindowGone(base, dropped.window.window_id, 5000)
      assert(
        !(gone.compositor.pending_deferred_window_ids ?? []).includes(dropped.window.window_id),
        'dropped native window should not remain pending deferred',
      )
      assert(
        !compositorWindowStack(gone.compositor).includes(dropped.window.window_id),
        'dropped native window should be removed from compositor stack order',
      )
      await writeJsonArtifact('native-buffer-drop-pruned-compositor.json', gone.compositor)
      await writeJsonArtifact('native-buffer-drop-pruned-shell.json', gone.shell)
    } finally {
      const pid = dropped.window.wayland_client_pid
      if (pid && pid > 0) {
        await spawnCommand(base, `kill -KILL ${pid} 2>/dev/null || true`)
      }
      state.spawnedNativeWindowIds.delete(dropped.window.window_id)
      state.knownWindowIds.delete(dropped.window.window_id)
    }
  })

  test('native game windows support relative pointer and pointer constraints', async ({ base, state }) => {
    const lockedSpawn = await spawnNativeWindow(base, state.knownWindowIds, {
      title: 'Derp Native Relative Lock',
      token: 'native-relative-lock',
      strip: 'blue',
      width: 520,
      height: 360,
      pointerConstraint: 'lock',
    })
    state.spawnedNativeWindowIds.add(lockedSpawn.window.window_id)
    const lockedId = lockedSpawn.window.window_id
    const lockedWindowReady = await waitForNativeWindowGeometry(base, lockedId, 'wait for locked native window geometry')
    const lockCenter = rectCenter({
      x: lockedWindowReady.window.x,
      y: lockedWindowReady.window.y,
      width: lockedWindowReady.window.width,
      height: lockedWindowReady.window.height,
      global_x: lockedWindowReady.window.x,
      global_y: lockedWindowReady.window.y,
    })
    await movePoint(base, lockCenter.x, lockCenter.y)
    const lockedActive = await waitForNativeTitleContains(base, lockedId, 'lock=1', 'wait for native pointer lock')
    assert(lockedActive.compositor.pointer, 'missing locked pointer snapshot')
    const lockedPointerBefore = { ...lockedActive.compositor.pointer }
    await movePointRelative(base, 140, 80)
    const lockedRelative = await waitForNativeTitleContains(
      base,
      lockedId,
      'last=140,80',
      'wait for native relative pointer delta',
    )
    assert(lockedRelative.compositor.pointer, 'missing locked relative pointer snapshot')
    assert(
      Math.abs(lockedRelative.compositor.pointer.x - lockedPointerBefore.x) < 0.01 &&
        Math.abs(lockedRelative.compositor.pointer.y - lockedPointerBefore.y) < 0.01,
      `locked pointer should stay in place, got ${lockedRelative.compositor.pointer.x},${lockedRelative.compositor.pointer.y} from ${lockedPointerBefore.x},${lockedPointerBefore.y}`,
    )
    assert(lockedRelative.compositor.focused_window_id === lockedId, `expected locked focus ${lockedId}`)
    await closeWindow(base, lockedId)
    await waitForWindowGone(base, lockedId, 5000)

    const confinedSpawn = await spawnNativeWindow(base, state.knownWindowIds, {
      title: 'Derp Native Relative Confine',
      token: 'native-relative-confine',
      strip: 'cyan',
      width: 520,
      height: 360,
      pointerConstraint: 'confine',
    })
    state.spawnedNativeWindowIds.add(confinedSpawn.window.window_id)
    const confinedId = confinedSpawn.window.window_id
    const confinedWindowReady = await waitForNativeWindowGeometry(
      base,
      confinedId,
      'wait for confined native window geometry',
    )
    const confinedCenter = rectCenter({
      x: confinedWindowReady.window.x,
      y: confinedWindowReady.window.y,
      width: confinedWindowReady.window.width,
      height: confinedWindowReady.window.height,
      global_x: confinedWindowReady.window.x,
      global_y: confinedWindowReady.window.y,
    })
    await movePoint(base, confinedCenter.x, confinedCenter.y)
    const confinedActive = await waitForNativeTitleContains(
      base,
      confinedId,
      'confine=1',
      'wait for native pointer confine',
    )
    assert(confinedActive.compositor.pointer, 'missing confined pointer snapshot')
    const confinedPointerBefore = { ...confinedActive.compositor.pointer }
    await movePointRelative(base, 40, 0)
    const confinedRelative = await waitForNativeTitleContains(
      base,
      confinedId,
      'last=40,0',
      'wait for confined relative pointer delta',
    )
    assert(confinedRelative.compositor.pointer, 'missing confined relative pointer snapshot')
    assert(
      confinedRelative.compositor.pointer.x > confinedPointerBefore.x + 10,
      `confined relative motion should move pointer inside window, got ${confinedRelative.compositor.pointer.x} from ${confinedPointerBefore.x}`,
    )
    const confinedWindow = compositorWindowById(confinedRelative.compositor, confinedId)
    assert(confinedWindow, 'missing confined native window')
    const confinedPointerAfterRelative = { ...confinedRelative.compositor.pointer }
    await movePoint(base, confinedWindow.x + confinedWindow.width + 120, confinedCenter.y)
    const confinedBlocked = await waitFor(
      'wait for confined pointer block',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, confinedId)
        if (!window || !compositor.pointer) return null
        const inside =
          compositor.pointer.x >= window.x &&
          compositor.pointer.x < window.x + window.width &&
          compositor.pointer.y >= window.y &&
          compositor.pointer.y < window.y + window.height
        if (!inside) return null
        return { compositor, window }
      },
      5000,
      100,
    )
    assert(confinedBlocked.compositor.pointer, 'missing confined blocked pointer snapshot')
    assert(
      Math.abs(confinedBlocked.compositor.pointer.x - confinedPointerAfterRelative.x) < 0.01 &&
        Math.abs(confinedBlocked.compositor.pointer.y - confinedPointerAfterRelative.y) < 0.01,
      `confined pointer should stay inside the game window, got ${confinedBlocked.compositor.pointer.x},${confinedBlocked.compositor.pointer.y} from ${confinedPointerAfterRelative.x},${confinedPointerAfterRelative.y}`,
    )
    assert(confinedBlocked.compositor.focused_window_id === confinedId, `expected confined focus ${confinedId}`)
    await writeJsonArtifact('native-game-pointer-support.json', {
      lockedId,
      lockedPointerBefore,
      lockedRelative: {
        title: lockedRelative.window.title,
        pointer: lockedRelative.compositor.pointer,
      },
      confinedId,
      confinedPointerBefore,
      confinedRelative: {
        title: confinedRelative.window.title,
        pointer: confinedRelative.compositor.pointer,
      },
      confinedBlocked: {
        title: confinedBlocked.window.title,
        pointer: confinedBlocked.compositor.pointer,
      },
    })
  })

  test('native taskbar focus and tile left/right', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
    const redFocused = await raiseTaskbarWindow(base, redId)
    const shellWithRedFocus = redFocused.shell
    await activateTaskbarWindow(base, shellWithRedFocus, redId)
    const redMinimized = await waitForWindowMinimized(base, redId)
    assert(shellWindowById(redMinimized.shell, redId)?.minimized, 'red taskbar activation should minimize when focused')
    await raiseTaskbarWindow(base, redId)
    const tiled = await tileNativePair(base, redId, greenId)
    const tiledRed = compositorWindowById(tiled.compositor, redId)
    const tiledGreen = compositorWindowById(tiled.compositor, greenId)
    assert(tiledRed, 'missing tiled red window')
    assert(tiledGreen, 'missing tiled green window')
    assert(tiledRed.title === RED_NATIVE_TITLE, `expected red title ${RED_NATIVE_TITLE}, got ${tiledRed.title}`)
    assert(tiledGreen.title === GREEN_NATIVE_TITLE, `expected green title ${GREEN_NATIVE_TITLE}, got ${tiledGreen.title}`)
    assert(tiledRed.app_id === NATIVE_APP_ID, `expected red app_id ${NATIVE_APP_ID}, got ${tiledRed.app_id}`)
    assert(tiledGreen.app_id === NATIVE_APP_ID, `expected green app_id ${NATIVE_APP_ID}, got ${tiledGreen.app_id}`)
    assert(tiledRed.output_name === tiled.output.name, `expected red output ${tiled.output.name}, got ${tiledRed.output_name}`)
    assert(tiledGreen.output_name === tiled.output.name, `expected green output ${tiled.output.name}, got ${tiledGreen.output_name}`)
    state.tiledOutput = tiled.output.name
    await writeJsonArtifact('native-tiling-compositor.json', tiled.compositor)
    await writeJsonArtifact('native-tiling-shell.json', tiled.shell)
  })

  test('closing a focused native window by keybind refocuses the previous window', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
    await raiseTaskbarWindow(base, redId)
    await raiseTaskbarWindow(base, greenId)
    await runKeybind(base, 'close_focused')
    const gone = await waitForWindowGone(base, greenId, 2000)
    const refocused = await waitForNativeFocus(base, redId, 2000)
    await writeJsonArtifact('native-close-refocus-gone.json', gone)
    await writeJsonArtifact('native-close-refocus-refocused.json', refocused)
  })

  test('native maximize fullscreen and tile up/down transitions', async ({ base, state }) => {
    const { red } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    await raiseTaskbarWindow(base, redId)
    const before = compositorWindowById((await getSnapshots(base)).compositor, redId)
    assert(before, 'missing red native window before state tests')
    await runKeybind(base, 'toggle_maximize')
    const maximized = await waitFor(
      'wait for maximize',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window?.maximized ? { compositor, window } : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'toggle_maximize')
    await waitFor(
      'wait for maximize restore',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        if (!window || window.maximized) return null
        return Math.abs(window.width - before.width) < 80 ? { compositor, window } : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'toggle_fullscreen')
    await waitFor(
      'wait for fullscreen',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window?.fullscreen ? { compositor, window } : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'toggle_fullscreen')
    await waitFor(
      'wait for fullscreen restore',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window && !window.fullscreen ? { compositor, window } : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'tile_up')
    await waitFor(
      'wait for tile up maximize',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window?.maximized ? { compositor, window } : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'tile_down')
    const restored = await waitFor(
      'wait for tile down restore',
      async () => {
        const compositor = await getJson(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window && !window.maximized && !window.fullscreen ? { compositor, window } : null
      },
      5000,
      100,
    )
    await writeJsonArtifact('native-state-transitions.json', {
      before,
      maximized: maximized.window,
      restored: restored.window,
    })
  })

  test('native titlebar double click toggles maximize and restore', async ({ base, state }) => {
    const { red } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    await raiseTaskbarWindow(base, redId)
    const focused = await waitForNativeFocus(base, redId, 4000)
    const before = compositorWindowById(focused.compositor, redId)
    assert(before && !before.maximized, 'missing non-maximized native window before titlebar double click')
    const titlebar = assertRectMinSize(
      'native titlebar before double click',
      windowControls(focused.shell, redId)?.titlebar,
      80,
      16,
    )
    const start = rectCenter(titlebar)
    await doubleClickRect(base, rectAroundPoint(start))
    const maximized = await waitFor(
      'wait for native maximized after titlebar double click',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const window = compositorWindowById(compositor, redId)
        const controls = windowControls(shell, redId)
        if (!window?.maximized || !controls?.titlebar) return null
        return { compositor, shell, window, titlebar: controls.titlebar }
      },
      5000,
      100,
    )
    const second = rectCenter(assertRectMinSize('native maximized titlebar before double click restore', maximized.titlebar, 80, 16))
    await doubleClickRect(base, rectAroundPoint(second))
    const restored = await waitFor(
      'wait for native restored after titlebar double click',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        if (!window || window.maximized || window.fullscreen || window.minimized) return null
        if (Math.abs(window.x - before.x) > 80) return null
        if (Math.abs(window.y - before.y) > 80) return null
        if (Math.abs(window.width - before.width) > 80) return null
        if (Math.abs(window.height - before.height) > 80) return null
        return { compositor, window }
      },
      5000,
      100,
    )
    await writeJsonArtifact('native-titlebar-double-click-maximize.json', {
      redId,
      firstClick: start,
      secondClick: second,
      before,
      maximized: maximized.window,
      restored: restored.window,
    })
  })

  test('maximized native titlebar drag leaves maximized for geometry diagnostics', async ({ base, state }) => {
    const { red } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    await raiseTaskbarWindow(base, redId)
    await waitForNativeFocus(base, redId, 4000)
    await runKeybind(base, 'toggle_maximize')
    await waitFor(
      'wait for red maximized',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window?.maximized ? { window } : null
      },
      5000,
      100,
    )
    const shellMax = await waitFor(
      'wait for red maximized in shell snapshot',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const window = shellWindowById(shell, redId)
        const controls = windowControls(shell, redId)
        if (!window?.maximized || !controls?.titlebar) return null
        return { titlebar: controls.titlebar }
      },
      5000,
      100,
    )
    const start = rectCenter(shellMax.titlebar)
    let previewDuringDrag: {
      window: WindowSnapshot
      sourceWidth: number
      sourceHeight: number
      backingWidth: number
      backingHeight: number
      previewRect: CompositorWorkspaceRect
      generation: number | null
      imagePath: string | null
    } | null = null
    await movePoint(base, start.x, start.y)
    await pointerButton(base, BTN_LEFT, 'press')
    try {
      await movePoint(base, start.x, start.y + 4)
      await waitFor(
        'wait for red unmaximized after small titlebar drag',
        async () => {
          const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          const window = compositorWindowById(compositor, redId)
          return window && !window.maximized && !window.fullscreen ? { window } : null
        },
        5000,
        100,
      )
      await movePoint(base, start.x, start.y + 160)
      const { compositor, shell } = await getSnapshots(base)
      const window = compositorWindowById(compositor, redId)
      const controls = windowControls(shell, redId)
      if (
        window &&
        !window.maximized &&
        !window.fullscreen &&
        compositor.shell_native_drag_preview_window_id === redId &&
        compositor.shell_native_drag_preview_shell_ready === true &&
        compositor.shell_native_drag_preview_image_path &&
        controls?.native_drag_preview_rect &&
        controls.native_drag_preview_loaded === true &&
        controls.native_drag_preview_source_width != null &&
        controls.native_drag_preview_source_height != null &&
        controls.native_drag_preview_backing_width != null &&
        controls.native_drag_preview_backing_height != null &&
        Math.abs(controls.native_drag_preview_source_width - window.width) <= 8 &&
        Math.abs(controls.native_drag_preview_source_height - window.height) <= 8 &&
        Math.abs(controls.native_drag_preview_backing_width - controls.native_drag_preview_source_width) <= 1 &&
        Math.abs(controls.native_drag_preview_backing_height - controls.native_drag_preview_source_height) <= 1
      ) {
        previewDuringDrag = {
          window,
          sourceWidth: controls.native_drag_preview_source_width,
          sourceHeight: controls.native_drag_preview_source_height,
          backingWidth: controls.native_drag_preview_backing_width,
          backingHeight: controls.native_drag_preview_backing_height,
          previewRect: controls.native_drag_preview_rect,
          generation: controls.native_drag_preview_generation ?? null,
          imagePath: compositor.shell_native_drag_preview_image_path,
        }
      }
    } finally {
      await pointerButton(base, BTN_LEFT, 'release')
    }
    const unmaxed = await waitFor(
      'wait for red unmaximized after titlebar drag',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        if (!window || window.maximized || window.fullscreen) return null
        const output = outputForWindow(compositor, window)
        if (!output) return null
        const stillFullBleed =
          window.width >= output.width - 24 && window.height >= output.height - 120
        if (stillFullBleed) return null
        return { window }
      },
      5000,
      100,
    )
    const w = unmaxed.window
    const centerX = w.x + w.width / 2
    assert(
      Math.abs(centerX - start.x) < 220,
      `restored window center x ${centerX} should stay near titlebar grab ${start.x}`,
    )
    await writeJsonArtifact('native-max-titlebar-drag-unmax.json', {
      redId,
      grab: { x: start.x, y: start.y },
      after: { x: w.x, y: w.y, w: w.width, h: w.height, output: w.output_name, centerX },
      previewDuringDrag,
    })
  })

  test('native decoration placement keeps up during active drag', async ({ base, state }) => {
    const stamp = Date.now()
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Native Drag Placement ${stamp}`,
      token: `native-drag-placement-${stamp}`,
      strip: 'green',
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    const windowId = spawned.window.window_id
    await waitForWindowRaised(base, windowId)
    await waitForNativeFocus(base, windowId, 4000)
    const shellReady = await waitFor(
      'wait for native drag placement titlebar',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const controls = windowControls(shell, windowId)
        return controls?.titlebar ? controls.titlebar : null
      },
      5000,
      100,
    )
    const titlebar = assertRectMinSize('native drag placement titlebar', shellReady, 80, 16)
    const startX = Math.round(titlebar.global_x + Math.max(40, Math.min(titlebar.width - 136, titlebar.width * 0.72)))
    const startY = Math.round(titlebar.global_y + titlebar.height / 2)

    await movePoint(base, startX, startY)
    await pointerButton(base, BTN_LEFT, 'press')
    const dx = 240
    const dy = 96
    const steps = 28
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps
      await movePoint(base, startX + dx * t, startY + dy * t)
    }

    const duringDrag = await waitFor(
      'wait for native decoration placement during active drag',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const movedWindow = compositorWindowById(compositor, windowId)
        const decorTop = nativeDecorTopRect(compositor, windowId)
        if (!movedWindow || !decorTop) return null
        assert(!('shell_exclusion_decor' in compositor), 'native decorations must not be exposed as exclusion rects')
        const expectedTopX = movedWindow.x - NATIVE_BORDER_PX
        const expectedTopY = movedWindow.y - NATIVE_TITLEBAR_PX
        if (Math.abs(decorTop.x - expectedTopX) > 8) return null
        if (Math.abs(decorTop.y - expectedTopY) > 8) return null
        return { compositor, movedWindow, decorTop }
      },
      1000,
      20,
    )

    await pointerButton(base, BTN_LEFT, 'release')
    await syncTest(base)

    await writeJsonArtifact('native-drag-decoration-live.json', {
      windowId,
      titlebar: {
        x: titlebar.global_x,
        y: titlebar.global_y,
        width: titlebar.width,
        height: titlebar.height,
      },
      movedWindow: duringDrag.movedWindow,
      decorTop: duringDrag.decorTop,
      compositorDuringDrag: duringDrag.compositor,
    })
  })

  test('native window can request KDE undecorated mode', async ({ base, state }) => {
    const stamp = Date.now()
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Native KDE Undecorated ${stamp}`,
      token: `native-kde-undecorated-${stamp}`,
      strip: 'blue',
      width: 420,
      height: 96,
      kdeDecorationNone: true,
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    const windowId = spawned.window.window_id
    const ready = await waitFor(
      'wait for KDE undecorated native frame',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const window = compositorWindowById(compositor, windowId)
        if (!window) return null
        const frame = nativeDecorTopRect(compositor, windowId)
        if (!frame) return null
        if (
          frame.x !== window.x ||
          frame.y !== window.y ||
          frame.width !== window.width ||
          frame.height !== window.height
        ) {
          return null
        }
        const controls = windowControls(shell, windowId)
        if (controls?.titlebar) return null
        return { compositor, shell, window, frame }
      },
      5000,
      100,
    )
    await writeJsonArtifact('native-kde-undecorated.json', {
      windowId,
      window: ready.window,
      frame: ready.frame,
      compositor: ready.compositor,
      shell: ready.shell,
    })
  })

  test('native window can request raw xdg undecorated mode', async ({ base, state }) => {
    const stamp = Date.now()
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Native XDG Undecorated ${stamp}`,
      token: `native-xdg-undecorated-${stamp}`,
      strip: 'blue',
      width: 420,
      height: 96,
      xdgDecorationRawNone: true,
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    const windowId = spawned.window.window_id
    const ready = await waitFor(
      'wait for xdg undecorated native frame',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const window = compositorWindowById(compositor, windowId)
        if (!window) return null
        const frame = nativeDecorTopRect(compositor, windowId)
        if (!frame) return null
        if (
          frame.x !== window.x ||
          frame.y !== window.y ||
          frame.width !== window.width ||
          frame.height !== window.height
        ) {
          return null
        }
        const controls = windowControls(shell, windowId)
        if (controls?.titlebar) return null
        return { compositor, shell, window, frame }
      },
      5000,
      100,
    )
    await writeJsonArtifact('native-xdg-undecorated.json', {
      windowId,
      window: ready.window,
      frame: ready.frame,
      compositor: ready.compositor,
      shell: ready.shell,
    })
  })

  test('native drag preview keeps shell titlebar aligned with captured content', async ({ base, state }) => {
    const stamp = Date.now()
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Native Drag Visual ${stamp}`,
      token: 'native-drag-preview-green',
      strip: 'green',
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    const windowId = spawned.window.window_id
    await waitForWindowRaised(base, windowId)
    await waitForNativeFocus(base, windowId, 4000)
    const shellReady = await waitFor(
      'wait for native drag visual titlebar',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const controls = windowControls(shell, windowId)
        return controls?.titlebar ? controls.titlebar : null
      },
      5000,
      100,
    )
    const titlebar = assertRectMinSize('native drag visual titlebar', shellReady, 80, 16)
    const startX = Math.round(titlebar.global_x + Math.min(140, Math.max(40, titlebar.width * 0.35)))
    const startY = Math.round(titlebar.global_y + titlebar.height / 2)

    await movePoint(base, startX, startY)
    await pointerButton(base, BTN_LEFT, 'press')
    const dx = -220
    const dy = -84
    const steps = 30
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps
      await movePoint(base, startX + dx * t, startY + dy * t)
    }

    const duringDrag = await waitFor(
      'wait for native drag preview to track compositor move visual',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        if (compositor.shell_move_window_id !== windowId || !compositor.shell_move_visual) return null
        if (compositor.shell_move_proxy_window_id != null) return null
        if (compositor.shell_native_drag_preview_window_id !== windowId) return null
        if (compositor.shell_native_drag_preview_shell_ready !== true) return null
        if (!compositor.shell_native_drag_preview_image_path) return null
        if (!compositor.shell_native_drag_preview_clip_rect) return null
        const controls = windowControls(shell, windowId)
        if (
          !controls?.dragging ||
          !controls.titlebar ||
          !controls.native_drag_preview_rect ||
          controls.native_drag_preview_loaded !== true ||
          controls.native_drag_preview_source_width == null ||
          controls.native_drag_preview_source_height == null ||
          controls.native_drag_preview_backing_width == null ||
          controls.native_drag_preview_backing_height == null
        ) {
          return null
        }
        if (Math.abs(controls.native_drag_preview_source_width - controls.native_drag_preview_backing_width) > 1) {
          return null
        }
        if (Math.abs(controls.native_drag_preview_source_height - controls.native_drag_preview_backing_height) > 1) {
          return null
        }
        const expected = nativeFrameTopLeftFromVisual(compositor.shell_move_visual)
        const previewRect = controls.native_drag_preview_rect
        const clipRect = compositor.shell_native_drag_preview_clip_rect
        if (Math.abs(controls.titlebar.global_x - expected.x) > 8) return null
        if (Math.abs(controls.titlebar.global_y - expected.y) > 8) return null
        if (Math.abs(previewRect.global_x - compositor.shell_move_visual.x) > 8) return null
        if (Math.abs(previewRect.global_y - compositor.shell_move_visual.y) > 8) return null
        if (Math.abs(previewRect.width - compositor.shell_move_visual.width) > 8) return null
        if (Math.abs(previewRect.height - compositor.shell_move_visual.height) > 8) return null
        const expectedClip = {
          x: expected.x,
          y: expected.y,
          width: compositor.shell_move_visual.width + 2 * NATIVE_BORDER_PX,
          height: compositor.shell_move_visual.height + NATIVE_TITLEBAR_PX + NATIVE_BORDER_PX,
        }
        if (Math.abs(clipRect.x - expectedClip.x) > 8) return null
        if (Math.abs(clipRect.y - expectedClip.y) > 8) return null
        if (Math.abs(clipRect.width - expectedClip.width) > 8) return null
        if (Math.abs(clipRect.height - expectedClip.height) > 8) return null
        return {
          compositor,
          shell,
          controls,
          expected,
          previewRect,
          clipRect,
        }
      },
      1000,
      20,
    )
    const duringTitlebar = assertRectMinSize('during native drag titlebar', duringDrag.controls.titlebar, 80, 16)
    const titlebarMoveDx = duringTitlebar.global_x - titlebar.global_x
    const titlebarMoveDy = duringTitlebar.global_y - titlebar.global_y
    assert(
      Math.abs(titlebarMoveDx) <= Math.abs(dx) + 32,
      `native titlebar drag x moved ${titlebarMoveDx} for pointer dx ${dx}`,
    )
    assert(
      Math.abs(titlebarMoveDy) <= Math.abs(dy) + 32,
      `native titlebar drag y moved ${titlebarMoveDy} for pointer dy ${dy}`,
    )
    const previewFixture = fileURLToPath(
      new URL('../fixtures/visual/native-drag-preview-green.png', import.meta.url),
    )
    const previewActualArtifact = await copyArtifactFile(
      'native-drag-preview-green-actual.png',
      String(duringDrag.compositor.shell_native_drag_preview_image_path),
    )
    const previewVisual = await comparePngFixture(
      String(duringDrag.compositor.shell_native_drag_preview_image_path),
      previewFixture,
      {
        maxDifferentPixels: 240,
        maxChannelDelta: 3,
      },
    )
    const dragScreenshot = await postJson<{ path?: string }>(base, '/test/screenshot', {
      x: Math.max(0, duringDrag.expected.x - 24),
      y: Math.max(0, duringDrag.expected.y - 24),
      width: duringDrag.clipRect.width + 48,
      height: duringDrag.clipRect.height + 48,
    })
    assert(dragScreenshot.path, 'native drag visual screenshot path missing')

    await pointerButton(base, BTN_LEFT, 'release')
    const afterRelease = await waitFor(
      'wait for native drag preview handoff back to live titlebar',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        if (
          compositor.shell_move_window_id !== null ||
          compositor.shell_move_proxy_window_id != null ||
          compositor.shell_native_drag_preview_window_id != null
        ) {
          return null
        }
        const controls = windowControls(shell, windowId)
        const titlebar = controls?.titlebar
        const movedWindow = compositorWindowById(compositor, windowId)
        if (!titlebar || !movedWindow) return null
        const expected = nativeFrameTopLeftFromVisual(movedWindow)
        if (Math.abs(titlebar.global_x - expected.x) > 8) return null
        if (Math.abs(titlebar.global_y - expected.y) > 8) return null
        return {
          compositor,
          shell,
          controls,
          titlebar,
          expected,
        }
      },
      1000,
      20,
    )
    const firstPreviewGeneration = duringDrag.controls.native_drag_preview_generation
    assert(firstPreviewGeneration != null, 'native drag preview generation missing during first drag')

    const secondStartX = Math.round(
      afterRelease.titlebar.global_x + Math.min(140, Math.max(40, afterRelease.titlebar.width * 0.35)),
    )
    const secondStartY = Math.round(afterRelease.titlebar.global_y + afterRelease.titlebar.height / 2)
    await movePoint(base, secondStartX, secondStartY)
    await pointerButton(base, BTN_LEFT, 'press')
    await movePoint(base, secondStartX + 28, secondStartY + 16)
    const secondDragStart = await waitFor(
      'wait for second native drag start without stale preview reuse',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        if (compositor.shell_move_window_id !== windowId || !compositor.shell_move_visual) return null
        const controls = windowControls(shell, windowId)
        return {
          compositor,
          shell,
          controls,
          previewGeneration: controls?.native_drag_preview_generation ?? null,
        }
      },
      400,
      10,
    )
    assert(
      secondDragStart.previewGeneration !== firstPreviewGeneration,
      `second drag reused stale native preview generation ${String(firstPreviewGeneration)}`,
    )

    await pointerButton(base, BTN_LEFT, 'release')
    const afterSecondRelease = await waitFor(
      'wait for second native drag preview handoff back to live titlebar',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        if (
          compositor.shell_move_window_id !== null ||
          compositor.shell_move_proxy_window_id != null ||
          compositor.shell_native_drag_preview_window_id != null
        ) {
          return null
        }
        const controls = windowControls(shell, windowId)
        const titlebar = controls?.titlebar
        const movedWindow = compositorWindowById(compositor, windowId)
        if (!titlebar || !movedWindow) return null
        const expected = nativeFrameTopLeftFromVisual(movedWindow)
        if (Math.abs(titlebar.global_x - expected.x) > 8) return null
        if (Math.abs(titlebar.global_y - expected.y) > 8) return null
        return {
          compositor,
          shell,
          controls,
          titlebar,
          expected,
        }
      },
      1000,
      20,
    )
    await syncTest(base)

    await writeJsonArtifact('native-drag-titlebar-live.json', {
      windowId,
      previewRect: duringDrag.previewRect,
      clipRect: duringDrag.clipRect,
      expected: duringDrag.expected,
      previewImagePath: duringDrag.compositor.shell_native_drag_preview_image_path,
      previewReady: duringDrag.compositor.shell_native_drag_preview_shell_ready,
      previewLoaded: duringDrag.controls.native_drag_preview_loaded,
      previewSourceWidth: duringDrag.controls.native_drag_preview_source_width,
      previewSourceHeight: duringDrag.controls.native_drag_preview_source_height,
      previewBackingWidth: duringDrag.controls.native_drag_preview_backing_width,
      previewBackingHeight: duringDrag.controls.native_drag_preview_backing_height,
      titlebarMoveDx,
      titlebarMoveDy,
      previewActualArtifact,
      previewVisual,
      dragScreenshot,
      dragScreenshotArtifact: await copyArtifactFile('native-drag-proxy-full-actual.png', dragScreenshot.path),
      firstPreviewGeneration,
      secondDragPreviewGeneration: secondDragStart.previewGeneration,
      compositorDuringDrag: duringDrag.compositor,
      shellDuringDrag: duringDrag.shell,
      compositorAfterRelease: afterRelease.compositor,
      shellAfterRelease: afterRelease.shell,
      titlebarAfterRelease: afterRelease.titlebar,
      compositorSecondDragStart: secondDragStart.compositor,
      shellSecondDragStart: secondDragStart.shell,
      compositorAfterSecondRelease: afterSecondRelease.compositor,
      shellAfterSecondRelease: afterSecondRelease.shell,
      titlebarAfterSecondRelease: afterSecondRelease.titlebar,
    })
  })

  test('native drag preview keeps clipped left edge unstretched', async ({ base, state }) => {
    const stamp = Date.now()
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Native Drag Clipped ${stamp}`,
      token: 'native-drag-preview-green',
      strip: 'green',
      width: 2200,
      height: 240,
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    const windowId = spawned.window.window_id
    await waitForWindowRaised(base, windowId)
    await waitForNativeFocus(base, windowId, 4000)
    const initial = await waitFor(
      'wait for clipped native drag start geometry',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const controls = windowControls(shell, windowId)
        const titlebar = controls?.titlebar
        const window = compositorWindowById(compositor, windowId)
        if (!titlebar || !window) return null
        const output = outputForWindow(compositor, window)
        if (!output) return null
        const clipped =
          window.x < output.x ||
          window.y < output.y ||
          window.x + window.width > output.x + output.width ||
          window.y + window.height > output.y + output.height
        if (!clipped) return null
        return { compositor, shell, controls, titlebar, window, output }
      },
      5000,
      100,
    )
    const titlebar = assertRectMinSize('clipped native drag titlebar', initial.titlebar, 80, 16)
    const visibleLeft = Math.max(titlebar.global_x, initial.output.x)
    const visibleRight = Math.min(titlebar.global_x + titlebar.width, initial.output.x + initial.output.width)
    const dragStartX = Math.round(
      Math.max(visibleLeft + 40, Math.min(visibleRight - 40, visibleLeft + (visibleRight - visibleLeft) / 2)),
    )
    const dragStartY = Math.round(titlebar.global_y + titlebar.height / 2)
    await movePoint(base, dragStartX, dragStartY)
    await pointerButton(base, BTN_LEFT, 'press')
    const dx = 96
    const dy = 36
    const dragSteps = 24
    for (let index = 1; index <= dragSteps; index += 1) {
      const t = index / dragSteps
      await movePoint(base, dragStartX + dx * t, dragStartY + dy * t)
    }

    const duringDrag = await waitFor(
      'wait for clipped native drag preview to load',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        if (compositor.shell_move_window_id !== windowId || !compositor.shell_move_visual) return null
        if (compositor.shell_native_drag_preview_window_id !== windowId) return null
        if (compositor.shell_native_drag_preview_shell_ready !== true) return null
        if (!compositor.shell_native_drag_preview_image_path) return null
        const controls = windowControls(shell, windowId)
        if (
          !controls?.dragging ||
          !controls.titlebar ||
          !controls.native_drag_preview_rect ||
          controls.native_drag_preview_loaded !== true ||
          controls.native_drag_preview_source_width == null ||
          controls.native_drag_preview_source_height == null ||
          controls.native_drag_preview_backing_width == null ||
          controls.native_drag_preview_backing_height == null
        ) {
          return null
        }
        if (Math.abs(controls.native_drag_preview_source_width - controls.native_drag_preview_backing_width) > 1) {
          return null
        }
        if (Math.abs(controls.native_drag_preview_source_height - controls.native_drag_preview_backing_height) > 1) {
          return null
        }
        return { compositor, shell, controls }
      },
      1000,
      20,
    )
    const previewFixture = fileURLToPath(
      new URL('../fixtures/visual/native-drag-preview-green-left-clipped.png', import.meta.url),
    )
    const previewActualArtifact = await copyArtifactFile(
      'native-drag-preview-green-left-clipped-actual.png',
      String(duringDrag.compositor.shell_native_drag_preview_image_path),
    )
    const previewVisual = await comparePngFixture(
      String(duringDrag.compositor.shell_native_drag_preview_image_path),
      previewFixture,
      {
        maxDifferentPixels: 240,
        maxChannelDelta: 3,
      },
    )

    await pointerButton(base, BTN_LEFT, 'release')
    await syncTest(base)

    await writeJsonArtifact('native-drag-preview-left-clipped.json', {
      windowId,
      initialTitlebar: initial.titlebar,
      initialWindow: initial.window,
      initialOutput: initial.output,
      previewRect: duringDrag.controls.native_drag_preview_rect,
      previewLoaded: duringDrag.controls.native_drag_preview_loaded,
      previewSourceWidth: duringDrag.controls.native_drag_preview_source_width,
      previewSourceHeight: duringDrag.controls.native_drag_preview_source_height,
      previewBackingWidth: duringDrag.controls.native_drag_preview_backing_width,
      previewBackingHeight: duringDrag.controls.native_drag_preview_backing_height,
      previewImagePath: duringDrag.compositor.shell_native_drag_preview_image_path,
      previewActualArtifact,
      previewVisual,
      compositorDuringDrag: duringDrag.compositor,
      shellDuringDrag: duringDrag.shell,
    })
  })

  test('CSD native drag keeps transparent rounded edges clear', async ({ base, state }) => {
    const stamp = Date.now()
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp CSD Drag Transparent ${stamp}`,
      token: 'csd-drag-transparent',
      strip: 'green',
      width: 520,
      height: 360,
      xdgDecorationClientSide: true,
      moveOnHeaderPress: true,
      roundedCorners: true,
      noBorder: true,
      solidClient: true,
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    const windowId = spawned.window.window_id
    await waitForWindowRaised(base, windowId)
    await waitForNativeFocus(base, windowId, 4000)
    const ready = await waitFor(
      'wait for transparent CSD drag geometry',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const window = compositorWindowById(compositor, windowId)
        if (!window?.client_side_decoration) return null
        const controls = windowControls(shell, windowId)
        if (controls?.titlebar) return null
        return { compositor, shell, window }
      },
      5000,
      100,
    )
    const startX = Math.round(ready.window.x + Math.min(140, Math.max(40, ready.window.width * 0.35)))
    const startY = Math.round(ready.window.y + Math.min(24, Math.max(14, ready.window.height * 0.08)))
    await movePoint(base, startX, startY)
    await pointerButton(base, BTN_LEFT, 'press')
    const dx = -180
    const dy = 64
    const steps = 24
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps
      await movePoint(base, startX + dx * t, startY + dy * t)
    }
    const duringDrag = await waitFor(
      'wait for transparent CSD drag visual',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const window = compositorWindowById(compositor, windowId)
        if (shell.compositor_interaction_state?.move_window_id !== windowId) return null
        if (!window?.client_side_decoration) return null
        const alpha = window.render_alpha ?? 1
        if (alpha < 0.7 || alpha > 0.82) return null
        if (compositor.shell_native_drag_preview_window_id != null) return null
        const controls = windowControls(shell, windowId)
        if (controls?.titlebar) return null
        return { compositor, shell, controls, window }
      },
      1000,
      20,
    )
    const visual = duringDrag.window
    assert(visual.width >= 120 && visual.height >= 120, `transparent CSD drag visual too small ${JSON.stringify(visual)}`)
    const capture = {
      x: Math.floor(visual.x - 10),
      y: Math.floor(visual.y - 10),
      width: Math.ceil(visual.width + 20),
      height: Math.ceil(visual.height + 20),
    }
    const screenshot = await captureScreenshotRect(base, capture)
    const pointer = duringDrag.compositor.pointer
    if (!pointer) throw new Error('transparent CSD drag pointer snapshot missing')
    const transparentCorners = await assertRoundedCsdTransparentOutside(
      screenshot.path,
      'transparent CSD drag corners',
      capture,
      {
        x: visual.x,
        y: visual.y,
        width: visual.width,
        height: visual.height,
      },
      {
        x: pointer.x,
        y: pointer.y,
        size: duringDrag.compositor.cursor_size,
      },
    )
    await pointerButton(base, BTN_LEFT, 'release')
    await syncTest(base)
    await writeJsonArtifact('csd-native-drag-transparent-corners.json', {
      windowId,
      initialWindow: ready.window,
      visual,
      capture,
      screenshot,
      screenshotArtifact: await copyArtifactFile('csd-native-drag-transparent-corners.png', screenshot.path),
      transparentCorners,
      compositorDuringDrag: duringDrag.compositor,
      shellDuringDrag: duringDrag.shell,
    })
  })

  test('multi-monitor super fullscreen maximize and tile hotkeys track window output', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    await closeWindow(base, green.window.window_id)
    await waitForWindowGone(base, green.window.window_id)
    state.spawnedNativeWindowIds.delete(green.window.window_id)
    state.knownWindowIds.delete(green.window.window_id)
    state.nativeLaunchByWindowId.delete(green.window.window_id)
    const redId = red.window.window_id
    const compositor0 = (await getSnapshots(base)).compositor
    if (compositor0.outputs.length < 2) {
      throw new SkipError('requires at least two outputs')
    }
    const nativeInitial = await waitFor(
      'wait for native multimonitor output assignment',
      async () => {
        const { compositor: nextCompositor, shell: nextShell } = await getSnapshots(base)
        const redShell = shellWindowById(nextShell, redId)
        const redCompositor = compositorWindowById(nextCompositor, redId)
        if (!redShell || !redCompositor) return null
        const outputName = resolveWindowOutputName(nextCompositor, redCompositor)
        if (!outputName) return null
        const nativeMove = pickMonitorMove(nextCompositor.outputs, outputName)
        if (!nativeMove) return null
        return { compositor: nextCompositor, shell: nextShell, redShell, redCompositor, outputName, nativeMove }
      },
      5000,
      100,
    )
    assertTaskbarRowOnMonitor(nativeInitial.shell, redId, nativeInitial.outputName)
    const nativeMove = nativeInitial.nativeMove
    if (!nativeMove) {
      throw new SkipError(`no adjacent monitor from ${nativeInitial.outputName}`)
    }
    await raiseTaskbarWindow(base, redId)
    const cx = nativeInitial.redCompositor.x + Math.floor(nativeInitial.redCompositor.width / 2)
    const cy = nativeInitial.redCompositor.y + Math.floor(nativeInitial.redCompositor.height / 2)
    await movePoint(base, cx, cy)
    await clickPoint(base, cx, cy)
    await runKeybind(base, nativeMove.action, redId)
    const moved = await waitFor(
      'wait for native monitor move',
      async () => {
        const { compositor: nextCompositor, shell: nextShell } = await getSnapshots(base)
        const compWindow = compositorWindowById(nextCompositor, redId)
        const shellWindow = shellWindowById(nextShell, redId)
        if (!compWindow || !shellWindow) return null
        const output = nextCompositor.outputs.find((entry) => entry.name === nativeMove.target.name)
        if (!output) return null
        if (!windowCenterOnOutput(compWindow, output)) return null
        return { compositor: nextCompositor, shell: nextShell, compWindow, output }
      },
      5000,
      50,
    )
    await runKeybind(base, 'toggle_fullscreen', redId)
    const fullscreenOn = await waitFor(
      'wait for fullscreen on secondary output',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        const output = compositor.outputs.find((entry) => entry.name === nativeMove.target.name)
        if (!window?.fullscreen || !output) return null
        if (!windowCenterOnOutput(window, output)) return null
        return { compositor, window, output }
      },
      5000,
      100,
    )
    await runKeybind(base, 'toggle_fullscreen', redId)
    await waitFor(
      'wait for fullscreen off after multimonitor',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window && !window.fullscreen ? { compositor, window } : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'toggle_maximize', redId)
    const maximizedOnTarget = await waitFor(
      'wait for maximize on moved monitor',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        if (!window?.maximized) return null
        const output = compositor.outputs.find((entry) => entry.name === nativeMove.target.name)
        if (!output || !windowCenterOnOutput(window, output)) return null
        return { compositor, window }
      },
      5000,
      100,
    )
    await raiseTaskbarWindow(base, redId)
    await waitForWindowRaised(base, redId, 5000)
    await runKeybind(base, 'toggle_maximize', redId)
    await waitFor(
      'wait for unmaximize on moved monitor',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window && !window.maximized ? { compositor, window } : null
      },
      5000,
      100,
    )
    await runKeybind(base, 'tile_up', redId)
    const tileUpMax = await waitFor(
      'wait for tile up on moved monitor',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        if (!window?.maximized) return null
        const output = compositor.outputs.find((entry) => entry.name === nativeMove.target.name)
        if (!output || !windowCenterOnOutput(window, output)) return null
        return { compositor, window }
      },
      5000,
      100,
    )
    await runKeybind(base, 'tile_down', redId)
    const tileDown = await waitFor(
      'wait for tile down restore on moved monitor',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, redId)
        return window && !window.maximized && !window.fullscreen ? { compositor, window } : null
      },
      5000,
      100,
    )
    state.multiMonitorNativeMove = {
      window_id: redId,
      target_output: nativeMove.target.name,
    }
    await writeJsonArtifact('native-multimonitor-super-hotkeys.json', {
      moved,
      fullscreenOn,
      maximizedOnTarget,
      tileUpMax,
      tileDown,
    })
  })

  test('native windows raise to front when clicking content', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
    const trackedWindowIds = [redId, greenId]

    await tileNativePair(base, redId, greenId)
    const initial = await waitForTrackedStackParity(base, trackedWindowIds, 'native click initial parity')

    const redClickPoint = visibleWindowClickPoint(initial.shell, redId)
    await clickPoint(base, redClickPoint.x, redClickPoint.y)
    const redFocused = await waitForNativeFocus(base, redId)
    assertRestackToFront(
      initial.shell,
      redFocused.shell,
      redId,
      trackedWindowIds,
      'native red content click restack order',
    )

    const greenClickPoint = visibleWindowClickPoint(redFocused.shell, greenId)
    await clickPoint(base, greenClickPoint.x, greenClickPoint.y)
    const greenFocused = await waitForNativeFocus(base, greenId)
    assertRestackToFront(
      redFocused.shell,
      greenFocused.shell,
      greenId,
      trackedWindowIds,
      'native green content click restack order',
    )

    const parity = await waitForTrackedStackParity(base, trackedWindowIds, 'native click final parity')
    await writeJsonArtifact('native-content-click-focus.json', {
      redId,
      greenId,
      redClickPoint,
      greenClickPoint,
      initialShell: initial.shell,
      redFocused: redFocused.shell,
      greenFocused: greenFocused.shell,
      finalCompositor: parity.compositor,
    })
  })

  test('native and shell windows share focus stacking and taskbar parity', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
    await tileNativePair(base, redId, greenId)
    await openSettings(base, 'click')
    await openDebug(base)
    const paritySnapshots = await getSnapshots(base)
    const redCompositor = compositorWindowById(paritySnapshots.compositor, redId)
    const settingsCompositor = compositorWindowById(paritySnapshots.compositor, SHELL_UI_SETTINGS_WINDOW_ID)
    const debugCompositor = compositorWindowById(paritySnapshots.compositor, SHELL_UI_DEBUG_WINDOW_ID)
    assert(redCompositor, 'missing red compositor window')
    assert(settingsCompositor, 'missing settings compositor window')
    assert(debugCompositor, 'missing debug compositor window')
    const redClickPoint = visibleWindowClickPoint(paritySnapshots.shell, redId)
    await clickPoint(base, redClickPoint.x, redClickPoint.y)
    await waitForWindowRaised(base, redId)
    const shellBeforeSettingsFocus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeSettingsFocus, SHELL_UI_SETTINGS_WINDOW_ID)
    await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    await clickPoint(
      base,
      settingsCompositor.x + Math.min(48, Math.max(16, Math.floor(settingsCompositor.width / 8))),
      settingsCompositor.y + Math.min(48, Math.max(16, Math.floor(settingsCompositor.height / 8))),
    )
    await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const shellBeforeDebugFocus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeDebugFocus, SHELL_UI_DEBUG_WINDOW_ID)
    await waitForShellUiFocus(base, SHELL_UI_DEBUG_WINDOW_ID)
    await clickPoint(
      base,
      debugCompositor.x + Math.min(48, Math.max(16, Math.floor(debugCompositor.width / 8))),
      debugCompositor.y + Math.min(48, Math.max(16, Math.floor(debugCompositor.height / 8))),
    )
    await waitForShellUiFocus(base, SHELL_UI_DEBUG_WINDOW_ID)
    await waitForTrackedStackParity(
      base,
      [redId, SHELL_UI_SETTINGS_WINDOW_ID, SHELL_UI_DEBUG_WINDOW_ID],
      'debug click focus parity',
    )
    const shellAfterClicks = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assertTopWindow(shellAfterClicks, SHELL_UI_DEBUG_WINDOW_ID, 'debug should be frontmost after direct click')
    await raiseTaskbarWindow(base, SHELL_UI_SETTINGS_WINDOW_ID)
    await clickPoint(
      base,
      settingsCompositor.x + Math.min(48, Math.max(16, Math.floor(settingsCompositor.width / 8))),
      settingsCompositor.y + Math.min(48, Math.max(16, Math.floor(settingsCompositor.height / 8))),
    )
    await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsFocused = await waitForTrackedStackParity(
      base,
      [redId, SHELL_UI_SETTINGS_WINDOW_ID, SHELL_UI_DEBUG_WINDOW_ID],
      'settings taskbar focus parity',
    )
    assertTopWindow(settingsFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should be frontmost after taskbar activate')
    await writeJsonArtifact('native-js-parity-shell.json', settingsFocused.shell)
    await writeJsonArtifact('native-js-parity-compositor.json', settingsFocused.compositor)
  })

  test('mouse clicks switch focus between native and shell windows with stack parity', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
    const trackedWindowIds = [redId, greenId, SHELL_UI_SETTINGS_WINDOW_ID]

    await tileNativePair(base, redId, greenId)
    await openSettings(base, 'click')
    const initial = await waitForTrackedStackParity(base, trackedWindowIds, 'native shell click initial parity')

    const redClickPoint = visibleWindowClickPoint(initial.shell, redId)
    await clickPoint(base, redClickPoint.x, redClickPoint.y)
    const redFocused = await waitForNativeFocus(base, redId)
    assertRestackToFront(
      initial.shell,
      redFocused.shell,
      redId,
      trackedWindowIds,
      'native shell red click restack order',
    )

    const settingsClickPoint = visibleWindowClickPoint(redFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID)
    await clickPoint(base, settingsClickPoint.x, settingsClickPoint.y)
    const settingsFocused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertRestackToFront(
      redFocused.shell,
      settingsFocused.shell,
      SHELL_UI_SETTINGS_WINDOW_ID,
      trackedWindowIds,
      'native shell settings click restack order',
    )

    const greenClickPoint = visibleWindowClickPoint(settingsFocused.shell, greenId)
    await clickPoint(base, greenClickPoint.x, greenClickPoint.y)
    const greenFocused = await waitForNativeFocus(base, greenId)
    assertRestackToFront(
      settingsFocused.shell,
      greenFocused.shell,
      greenId,
      trackedWindowIds,
      'native shell green click restack order',
    )

    const parity = await waitForTrackedStackParity(base, trackedWindowIds, 'native shell click final parity')
    assertTopWindow(parity.shell, greenId, 'green should be frontmost after mixed mouse activation')
    await writeJsonArtifact('native-shell-content-click-focus.json', {
      redId,
      greenId,
      redClickPoint,
      settingsClickPoint,
      greenClickPoint,
      initialShell: initial.shell,
      redFocused: redFocused.shell,
      settingsFocused: settingsFocused.shell,
      greenFocused: greenFocused.shell,
      finalCompositor: parity.compositor,
    })
  })

  test('native and shell focus changes keep taskbar order stable', async ({ base, state }) => {
    const { red } = await ensureNativePair(base, state)
    const redId = red.window.window_id

    await openSettings(base, 'click')
    const initial = await getSnapshots(base)
    const nativeWindow = shellWindowById(initial.shell, redId)
    const settingsWindow = shellWindowById(initial.shell, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(nativeWindow, 'missing native shell snapshot for taskbar order test')
    assert(settingsWindow, 'missing settings shell snapshot for taskbar order test')
    const monitorName = nativeWindow.output_name
    assert(
      monitorName === settingsWindow.output_name,
      `expected native and settings windows on same monitor, got ${monitorName} and ${settingsWindow.output_name}`,
    )
    const trackedWindowIds = [redId, SHELL_UI_SETTINGS_WINDOW_ID]
    const initialOrder = taskbarWindowOrderOnMonitor(initial.shell, monitorName).filter((windowId) =>
      trackedWindowIds.includes(windowId),
    )
    assert(
      initialOrder.length === trackedWindowIds.length,
      `expected ${trackedWindowIds.length} tracked taskbar windows, got ${initialOrder.join(', ')}`,
    )

    const redFocused = await raiseTaskbarWindow(base, redId)
    assertTrackedTaskbarOrder(redFocused.shell, monitorName, trackedWindowIds, initialOrder, 'native focus taskbar order')

    const settingsFocused = await raiseTaskbarWindow(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertTrackedTaskbarOrder(
      settingsFocused.shell,
      monitorName,
      trackedWindowIds,
      initialOrder,
      'shell focus taskbar order',
    )

    await writeJsonArtifact('native-shell-taskbar-order-initial.json', initial.shell)
    await writeJsonArtifact('native-shell-taskbar-order-native-focused.json', redFocused.shell)
    await writeJsonArtifact('native-shell-taskbar-order-shell-focused.json', settingsFocused.shell)
  })

  test('js and native windows preserve restack order across focus changes', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
    const trackedWindowIds = [redId, greenId, SHELL_UI_DEBUG_WINDOW_ID, SHELL_UI_SETTINGS_WINDOW_ID]

    await tileNativePair(base, redId, greenId)
    await openSettings(base, 'click')
    const debugOpen = await openDebug(base)
    const redWindow = compositorWindowById(debugOpen.compositor, redId)
    assert(redWindow, 'missing red compositor window')

    const redClickPoint = visibleWindowClickPoint(debugOpen.shell, redId)
    await clickPoint(base, redClickPoint.x, redClickPoint.y)
    const redFocused = await waitForWindowRaised(base, redId)
    assertRestackToFront(debugOpen.shell, redFocused.shell, redId, trackedWindowIds, 'red focus restack order')
    await waitForOutputOrderMatchesGlobalTop(
      base,
      redFocused.compositor.windows.find((window) => window.window_id === redId)?.output_name ?? '',
      redId,
      'red focus output order',
    )

    const greenFocused = await raiseTaskbarWindow(base, greenId)
    assertRestackToFront(redFocused.shell, greenFocused.shell, greenId, trackedWindowIds, 'green focus restack order')
    await waitForOutputOrderMatchesGlobalTop(
      base,
      greenFocused.compositor.windows.find((window) => window.window_id === greenId)?.output_name ?? '',
      greenId,
      'green focus output order',
    )

    const settingsRaised = await raiseTaskbarWindow(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsWindow = compositorWindowById(settingsRaised.compositor, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(settingsWindow, 'missing settings compositor window after taskbar focus')
    await clickPoint(
      base,
      settingsWindow.x + Math.min(48, Math.max(16, Math.floor(settingsWindow.width / 8))),
      settingsWindow.y + Math.min(48, Math.max(16, Math.floor(settingsWindow.height / 8))),
    )
    const settingsFocused = await waitForWindowRaised(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertRestackToFront(
      greenFocused.shell,
      settingsFocused.shell,
      SHELL_UI_SETTINGS_WINDOW_ID,
      trackedWindowIds,
      'settings focus restack order',
    )

    await activateTaskbarWindow(base, settingsFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsMinimized = await waitForWindowMinimized(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(
      shellWindowById(settingsMinimized.shell, SHELL_UI_SETTINGS_WINDOW_ID)?.minimized,
      'settings taskbar activation should minimize when focused',
    )

    const settingsRestored = await raiseTaskbarWindow(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertTopWindow(settingsRestored.shell, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should return to the front after restore')

    const debugFocused = await raiseTaskbarWindow(base, SHELL_UI_DEBUG_WINDOW_ID)
    assertRestackToFront(
      settingsRestored.shell,
      debugFocused.shell,
      SHELL_UI_DEBUG_WINDOW_ID,
      trackedWindowIds,
      'debug focus restack order',
    )

    const redRefocused = await raiseTaskbarWindow(base, redId)
    assertRestackToFront(
      debugFocused.shell,
      redRefocused.shell,
      redId,
      trackedWindowIds,
      'red refocus restack order',
    )

    await writeJsonArtifact('native-js-restack-red.json', redFocused.shell)
    await writeJsonArtifact('native-js-restack-green.json', greenFocused.shell)
    await writeJsonArtifact('native-js-restack-settings.json', settingsFocused.shell)
    await writeJsonArtifact('native-js-restack-settings-restored.json', settingsRestored.shell)
    await writeJsonArtifact('native-js-restack-debug.json', debugFocused.shell)
    await writeJsonArtifact('native-js-restack-red-refocused.json', redRefocused.shell)
    await writeJsonArtifact('native-js-restack-red-compositor.json', redFocused.compositor)
    await writeJsonArtifact('native-js-restack-green-compositor.json', greenFocused.compositor)
    await writeJsonArtifact('native-js-restack-settings-compositor.json', settingsFocused.compositor)
    await writeJsonArtifact('native-js-restack-settings-restored-compositor.json', settingsRestored.compositor)
    await writeJsonArtifact('native-js-restack-debug-compositor.json', debugFocused.compositor)
    await writeJsonArtifact('native-js-restack-red-refocused-compositor.json', redRefocused.compositor)
  })

  test('native windows open directly into compositor auto layout geometry', async ({ base, state }) => {
    await openSettings(base, 'click')
    try {
      await selectSettingsTilingLayout(base, 'grid')
      await closeWindow(base, SHELL_UI_SETTINGS_WINDOW_ID)
      await waitForWindowGone(base, SHELL_UI_SETTINGS_WINDOW_ID)
      await resetPerfCounters(base)
      const beforeOpen = await getSnapshots(base)

      const opened = await spawnNativeWindow(base, state.knownWindowIds, {
        title: 'Derp Native Grid Open',
        token: 'native-grid-open',
        strip: '#2573c2',
        width: 480,
        height: 320,
      })
      state.spawnedNativeWindowIds.add(opened.window.window_id)
      const windowId = opened.window.window_id
      const settled = await waitFor(
        'wait for grid-opened native window geometry',
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          const window = compositorWindowById(compositor, windowId)
          const output = compositor.outputs.find((entry) => entry.name === window?.output_name) ?? null
          const taskbar = window ? taskbarForMonitor(shell, window.output_name) : null
          if (!window || !output || !taskbar?.rect) return null
          const expected = expectedGridAutoLayoutClientRect(
            output,
            taskbar.rect,
            autoLayoutManagedWindowsOnOutput(beforeOpen.compositor, output.name),
            windowId,
          )
          if (Math.abs(window.x - expected.x) > 24) return null
          if (Math.abs(window.y - expected.y) > 24) return null
          if (Math.abs(window.width - expected.width) > 24) return null
          if (Math.abs(window.height - expected.height) > 24) return null
          return { compositor, shell, window, expected }
        },
        2000,
        40,
      )
      const perf = await getPerfCounters(base)
      assert(perf.shell_updates.window_mapped_messages >= 1, 'native open should emit a mapped message')
      const followup = await getSnapshots(base)
      const followupWindow = compositorWindowById(followup.compositor, windowId)
      assert(followupWindow, 'missing follow-up native compositor window')
      assert(
        followupWindow.x === settled.window.x &&
          followupWindow.y === settled.window.y &&
          followupWindow.width === settled.window.width &&
          followupWindow.height === settled.window.height,
        'native auto-layout open geometry should stay stable after mapping',
      )
      await writeJsonArtifact('native-grid-open.json', {
        windowId,
        perf,
        existingWindowIds: autoLayoutManagedWindowsOnOutput(
          beforeOpen.compositor,
          settled.window.output_name,
        ).map((window) => window.window_id),
        expected: settled.expected,
        initial: {
          x: opened.window.x,
          y: opened.window.y,
          width: opened.window.width,
          height: opened.window.height,
          output: opened.window.output_name,
        },
        actual: {
          x: settled.window.x,
          y: settled.window.y,
          width: settled.window.width,
          height: settled.window.height,
          output: settled.window.output_name,
        },
        followup: {
          x: followupWindow.x,
          y: followupWindow.y,
          width: followupWindow.width,
          height: followupWindow.height,
          output: followupWindow.output_name,
        },
      })
    } finally {
      try {
        await postJson(base, '/test/tiling/reset', {})
      } finally {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        if (shellWindowById(shell, SHELL_UI_SETTINGS_WINDOW_ID)) {
          await closeWindow(base, SHELL_UI_SETTINGS_WINDOW_ID)
          await waitForWindowGone(base, SHELL_UI_SETTINGS_WINDOW_ID)
        }
      }
    }
  })
})
