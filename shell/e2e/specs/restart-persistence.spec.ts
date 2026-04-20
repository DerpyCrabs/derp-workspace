import path from 'node:path'

import {
  KEY,
  SHELL_UI_DEBUG_WINDOW_ID,
  SHELL_UI_SETTINGS_WINDOW_ID,
  activateTaskbarWindow,
  assert,
  assertWindowTiled,
  clickPoint,
  clickRect,
  cleanupNativeWindows,
  cleanupShellWindows,
  compositorWindowById,
  defineGroup,
  dragRectToRect,
  getJson,
  getSnapshots,
  movePoint,
  openProgramsMenu,
  openShellTestWindow,
  outputForWindow,
  prepareFileBrowserFixtures,
  restartSession,
  runKeybind,
  shellWindowById,
  spawnNativeWindow,
  tabGroupByWindow,
  tapKey,
  taskbarForMonitor,
  waitFor,
  waitForSessionRestoreIdle,
  waitForTaskbarEntry,
  writeJsonArtifact,
  type FileBrowserFixturePaths,
  type FileBrowserSnapshotAction,
  type FileBrowserSnapshotRow,
  type ShellSnapshot,
  type WindowSnapshot,
} from '../lib/runtime.ts'

const FILE_BROWSER_APP_ID = 'derp.files'
const SHELL_TEST_APP_ID = 'derp.test-shell'

function fileBrowserRow(shell: ShellSnapshot, name: string): FileBrowserSnapshotRow | null {
  return shell.file_browser?.rows.find((row) => row.name === name) ?? null
}

function fileBrowserAction(shell: ShellSnapshot, id: string): FileBrowserSnapshotAction | null {
  return shell.file_browser?.primary_actions.find((action) => action.id === id) ?? null
}

function tabRect(shell: ShellSnapshot, windowId: number) {
  const group = tabGroupByWindow(shell, windowId)
  assert(group, `missing tab group for window ${windowId}`)
  const tab = group.tabs.find((entry) => entry.window_id === windowId)
  assert(tab?.rect, `missing tab rect for window ${windowId}`)
  return tab.rect
}

async function ensureProgramsMenuSearchReady(base: string, shell: ShellSnapshot) {
  assert(shell.controls?.programs_menu_search, 'missing programs menu search control')
  const compositor = await getJson<Record<string, unknown>>(base, '/test/state/compositor')
  if (compositor.shell_keyboard_focus) return shell
  await clickRect(base, shell.controls.programs_menu_search)
  await waitFor(
    'wait for launcher search focus',
    async () => {
      const next = await getJson<Record<string, unknown>>(base, '/test/state/compositor')
      return next.shell_keyboard_focus ? next : null
    },
    2000,
    50,
  )
  return getJson<ShellSnapshot>(base, '/test/state/shell')
}

async function openFileBrowserFromLauncher(
  base: string,
  spawnedShellWindowIds: Set<number>,
): Promise<{ shell: ShellSnapshot; window: WindowSnapshot }> {
  const before = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const existingIds = new Set(
    before.windows
      .filter((window) => window.shell_hosted && window.app_id === FILE_BROWSER_APP_ID)
      .map((window) => window.window_id),
  )
  await ensureProgramsMenuSearchReady(base, await openProgramsMenu(base, 'keybind'))
  await tapKey(base, KEY.enter)
  const opened = await waitFor(
    'wait for file browser window',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const window = shell.windows.find(
        (entry) =>
          entry.shell_hosted &&
          entry.app_id === FILE_BROWSER_APP_ID &&
          !existingIds.has(entry.window_id) &&
          !entry.minimized,
      )
      if (!window) return null
      if (!shell.file_browser?.active_path) return null
      if (shell.programs_menu_open) return null
      return { shell, window }
    },
    5000,
    100,
  )
  spawnedShellWindowIds.add(opened.window.window_id)
  return opened
}

async function waitForActivePath(base: string, expectedPath: string, windowId?: number) {
  return waitFor(
    `wait for file browser path ${expectedPath}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const fileBrowser =
        windowId === undefined
          ? shell.file_browser
          : shell.file_browser_windows?.find((entry) => entry.window_id === windowId) ?? null
      return fileBrowser?.active_path === expectedPath ? shell : null
    },
    2000,
    100,
  )
}

async function openDirectoryRowWithClicks(base: string, expectedPath: string, rowName: string, windowId: number) {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const row = fileBrowserRow(shell, rowName)
  assert(row?.rect, `missing row rect for ${rowName}`)
  await clickRect(base, row.rect)
  await waitFor(
    `wait for ${rowName} selection`,
    async () => {
      const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
      if (next.file_browser?.active_path === expectedPath) return next
      return fileBrowserRow(next, rowName)?.selected ? next : null
    },
    2000,
    100,
  )
  const openedShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  if (openedShell.file_browser?.active_path === expectedPath) return openedShell
  const selectedRow = fileBrowserRow(openedShell, rowName)
  assert(selectedRow?.rect, `missing selected row rect for ${rowName}`)
  await clickRect(base, selectedRow.rect)
  return waitForActivePath(base, expectedPath, windowId)
}

async function navigateToFixtureRoot(
  base: string,
  spawnedShellWindowIds: Set<number>,
  fixtures: FileBrowserFixturePaths,
): Promise<{ shell: ShellSnapshot; window: WindowSnapshot }> {
  const opened = await openFileBrowserFromLauncher(base, spawnedShellWindowIds)
  const initialPath = opened.shell.file_browser?.active_path
  assert(typeof initialPath === 'string' && initialPath.length > 0, 'missing initial file browser path')
  const relativeSegments = path.posix.relative(initialPath, fixtures.root_path).split('/').filter(Boolean)
  const showHiddenAction = fileBrowserAction(opened.shell, 'show-hidden')
  if (showHiddenAction?.rect) {
    await clickRect(base, showHiddenAction.rect)
    await waitFor(
      'wait for hidden rows to appear',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const toggleApplied = !!fileBrowserAction(shell, 'hide-hidden')
        if (!toggleApplied) return null
        const firstSegment = relativeSegments[0]
        if (!firstSegment) return shell
        return fileBrowserRow(shell, firstSegment) ? shell : null
      },
      2000,
      100,
    )
  }
  let currentPath = initialPath
  for (const segment of relativeSegments) {
    currentPath = path.posix.join(currentPath, segment)
    await openDirectoryRowWithClicks(base, currentPath, segment, opened.window.window_id)
  }
  return {
    shell: await waitForActivePath(base, fixtures.root_path, opened.window.window_id),
    window: opened.window,
  }
}

async function waitForGroupedMembers(base: string, memberWindowIds: number[]) {
  return waitFor(
    `wait for grouped members ${memberWindowIds.join(',')}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const group = tabGroupByWindow(shell, memberWindowIds[0])
      if (!group) return null
      const members = [...group.member_window_ids].sort((a, b) => a - b)
      const expected = [...memberWindowIds].sort((a, b) => a - b)
      return members.join(',') === expected.join(',') ? { shell, group } : null
    },
    2000,
    125,
  )
}

async function waitForNativeWindowByTitle(base: string, title: string) {
  return waitFor(
    `wait for native window ${title}`,
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const window = compositor.windows.find(
        (entry) => !entry.shell_hosted && entry.title === title && entry.app_id === 'derp.e2e.native',
      )
      return window ? { compositor, shell, window } : null
    },
    5000,
    125,
  )
}

async function cleanupConflictingShellWindows(base: string, spawnedShellWindowIds: Set<number>) {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const windowIds = shell.windows
    .filter(
      (window) =>
        window.shell_hosted &&
        (window.app_id === FILE_BROWSER_APP_ID ||
          window.app_id === SHELL_TEST_APP_ID ||
          window.window_id === SHELL_UI_SETTINGS_WINDOW_ID ||
          window.window_id === SHELL_UI_DEBUG_WINDOW_ID),
    )
    .map((window) => window.window_id)
  for (const windowId of windowIds) {
    spawnedShellWindowIds.delete(windowId)
  }
  await cleanupShellWindows(base, windowIds)
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('session restart restores file browser directory path from compositor', async ({ base, state }) => {
    await waitForSessionRestoreIdle(base)
    await cleanupConflictingShellWindows(base, state.spawnedShellWindowIds)
    const fixtures = await prepareFileBrowserFixtures(base)
    const fileBrowser = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    const mediaPath = path.posix.join(fixtures.root_path, 'media')
    await openDirectoryRowWithClicks(base, mediaPath, 'media', fileBrowser.window.window_id)
    await waitForActivePath(base, mediaPath, fileBrowser.window.window_id)
    const restartedBase = await restartSession(state)
    await waitForActivePath(restartedBase, mediaPath, fileBrowser.window.window_id)
  })

  test('restart restores shell state native window placement and tab groups', async ({ base, state }) => {
    await waitForSessionRestoreIdle(base)
    await cleanupConflictingShellWindows(base, state.spawnedShellWindowIds)
    await cleanupNativeWindows(base, state.spawnedNativeWindowIds)
    state.nativeLaunchByWindowId.clear()
    const fixtures = await prepareFileBrowserFixtures(base)
    const fileBrowser = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    const fileBrowserWindowId = fileBrowser.window.window_id

    const shellTest = await openShellTestWindow(base, state)
    const shellTestWindowId = shellTest.window.window_id

    await dragRectToRect(base, tabRect(shellTest.shell, shellTestWindowId), tabRect(shellTest.shell, fileBrowserWindowId))
    const grouped = await waitForGroupedMembers(base, [fileBrowserWindowId, shellTestWindowId])
    await activateTaskbarWindow(base, grouped.shell, fileBrowserWindowId)
    const groupedFocused = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await clickRect(base, tabRect(groupedFocused, fileBrowserWindowId))
    await waitForActivePath(base, fixtures.root_path, fileBrowserWindowId)

    const nativeTitle = 'Derp Native Restore Probe'
    const spawnedNative = await spawnNativeWindow(base, state.knownWindowIds, {
      title: nativeTitle,
      token: 'native-restore-probe',
      strip: 'green',
    })
    state.spawnedNativeWindowIds.add(spawnedNative.window.window_id)
    state.nativeLaunchByWindowId.set(spawnedNative.window.window_id, spawnedNative.command)
    const shellWithNativeTaskbar = await waitForTaskbarEntry(base, spawnedNative.window.window_id)
    await activateTaskbarWindow(base, shellWithNativeTaskbar, spawnedNative.window.window_id)
    const { compositor: compositorAfterActivate } = await getSnapshots(base)
    const nativeWindow = compositorWindowById(compositorAfterActivate, spawnedNative.window.window_id)
    assert(nativeWindow, 'missing spawned native compositor window')
    const ncx = nativeWindow.x + Math.floor(nativeWindow.width / 2)
    const ncy = nativeWindow.y + Math.floor(nativeWindow.height / 2)
    await movePoint(base, ncx, ncy)
    await clickPoint(base, ncx, ncy)
    await runKeybind(base, 'tile_left', spawnedNative.window.window_id)
    const tiledBeforeRestart = await waitFor(
      'wait for native window tiled left before restart',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const window = compositorWindowById(compositor, spawnedNative.window.window_id)
        if (!window) return null
        const output = outputForWindow(compositor, window)
        const taskbar = output ? taskbarForMonitor(shell, output.name) : null
        if (!output || !taskbar?.rect) return null
        try {
          assertWindowTiled(window, output, taskbar.rect, 'left')
        } catch {
          return null
        }
        return { compositor, shell, window, output }
      },
      5000,
      125,
    )

    const sessionBeforeRestart = await getJson<Record<string, unknown>>(base, '/session_state')
    await writeJsonArtifact('restart-persistence-before.json', {
      fixtures,
      grouped: grouped.group,
      native_window_id: spawnedNative.window.window_id,
      native_output: tiledBeforeRestart.output.name,
      shell: tiledBeforeRestart.shell,
      compositor: tiledBeforeRestart.compositor,
      session: sessionBeforeRestart,
    })

    const restartedBase = await restartSession(state)

    const restoredFileBrowser = await waitForActivePath(restartedBase, fixtures.root_path, fileBrowserWindowId)
    const restoredGroup = await waitForGroupedMembers(restartedBase, [fileBrowserWindowId, shellTestWindowId])
    const restoredNative = await waitForNativeWindowByTitle(restartedBase, nativeTitle)
    const restoredOutput = outputForWindow(restoredNative.compositor, restoredNative.window)
    const restoredTaskbar = restoredOutput ? taskbarForMonitor(restoredNative.shell, restoredOutput.name) : null
    assert(restoredOutput, 'missing restored native output')
    assert(restoredTaskbar?.rect, 'missing restored taskbar for native output')
    assertWindowTiled(restoredNative.window, restoredOutput, restoredTaskbar.rect, 'left')
    assert(shellWindowById(restoredFileBrowser, fileBrowserWindowId), 'missing restored file browser window')
    assert(shellWindowById(restoredGroup.shell, shellTestWindowId), 'missing restored shell test window')
    assert(restoredGroup.group.member_window_ids.includes(fileBrowserWindowId), 'restored group missing file browser')
    assert(restoredGroup.group.member_window_ids.includes(shellTestWindowId), 'restored group missing shell test window')

    state.spawnedNativeWindowIds.delete(spawnedNative.window.window_id)
    state.nativeLaunchByWindowId.delete(spawnedNative.window.window_id)
    state.spawnedNativeWindowIds.add(restoredNative.window.window_id)
    state.nativeLaunchByWindowId.set(restoredNative.window.window_id, spawnedNative.command)

    const sessionAfterRestart = await getJson<Record<string, unknown>>(restartedBase, '/session_state')
    await writeJsonArtifact('restart-persistence-after.json', {
      shell: restoredNative.shell,
      compositor: restoredNative.compositor,
      file_browser: restoredFileBrowser.file_browser,
      restored_group: restoredGroup.group,
      session: sessionAfterRestart,
    })
  })
})
