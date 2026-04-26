import path from 'node:path'

import {
  KEY,
  SkipError,
  assert,
  assertRectMinSize,
  clickRect,
  compositorWindowById,
  defineGroup,
  ensureDesktopApps,
  findLauncherCandidate,
  getJson,
  getSnapshots,
  pointInRect,
  rectCenter,
  restartSession,
  rightClickRect,
  shellWindowById,
  tapKey,
  taskbarEntry,
  taskbarForMonitor,
  typeText,
  waitFor,
  waitForProgramsMenuClosed,
  waitForWindowGone,
  writeJsonArtifact,
  type CompositorSnapshot,
  type DesktopAppEntry,
  type Rect,
  type ShellSnapshot,
  type ShellTaskbarPin,
  type WindowSnapshot,
} from '../lib/runtime.ts'
import { closeWindow, prepareFileBrowserFixtures } from '../lib/setup.ts'
import {
  FILE_BROWSER_APP_ID,
  fileBrowserRow,
  fileBrowserSnapshot,
  navigateToFixtureRoot,
  waitForActivePath,
} from '../lib/fileBrowserFixtureNav.ts'

function desktopAppPinId(app: DesktopAppEntry): string {
  const desktopId = typeof app.desktop_id === 'string' ? app.desktop_id.trim() : ''
  const exec = typeof app.exec === 'string' ? app.exec.trim() : ''
  return `app:${desktopId || exec}`
}

function folderPinId(folderPath: string): string {
  return `folder:${folderPath}`
}

function rectStable(a: Rect | null | undefined, b: Rect | null | undefined): boolean {
  return !!a && !!b && a.global_x === b.global_x && a.global_y === b.global_y && a.width === b.width && a.height === b.height
}

function monitorForRect(shell: ShellSnapshot, rect: Rect): string {
  const center = rectCenter(rect)
  const taskbar = shell.taskbars.find((entry) => pointInRect(entry.rect, center))
  assert(taskbar?.monitor, 'could not resolve monitor for rect')
  return taskbar.monitor
}

function taskbarPin(shell: ShellSnapshot, id: string, monitor?: string): ShellTaskbarPin | null {
  return shell.taskbar_pins?.find((pin) => pin.id === id && (!monitor || pin.monitor === monitor)) ?? null
}

async function waitForTaskbarPin(base: string, id: string, monitor: string): Promise<{ shell: ShellSnapshot; pin: ShellTaskbarPin }> {
  return waitFor(
    `wait for taskbar pin ${id}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const pin = taskbarPin(shell, id, monitor)
      return pin?.rect ? { shell, pin } : null
    },
    5000,
    100,
  )
}

async function waitForNoTaskbarPin(base: string, id: string, monitor?: string): Promise<ShellSnapshot> {
  return waitFor(
    `wait for taskbar pin removed ${id}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return taskbarPin(shell, id, monitor) ? null : shell
    },
    5000,
    100,
  )
}

async function unpinRenderedPinIfPresent(base: string, id: string, monitor?: string) {
  for (;;) {
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const pin = taskbarPin(shell, id, monitor)
    if (!pin?.rect) return
    await rightClickRect(base, assertRectMinSize(`taskbar pin ${id}`, pin.rect, 24, 24))
    const unpinAction = await contextAction(base, 'unpin-from-monitor')
    await clickRect(base, assertRectMinSize('unpin from monitor', unpinAction.rect, 32, 18))
    await waitForNoTaskbarPin(base, id, monitor)
  }
}

async function contextAction(base: string, actionId: string) {
  return waitFor(
    `wait for context action ${actionId}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const item = shell.file_browser_context_menu?.find((entry) => entry.id === actionId)
      return item?.rect ? item : null
    },
    5000,
    100,
  )
}

async function openProgramsSearch(base: string, query: string): Promise<ShellSnapshot> {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  if (shell.programs_menu_open) {
    await tapKey(base, KEY.escape)
    await waitForProgramsMenuClosed(base)
  }
  const closedShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  assert(closedShell.controls?.taskbar_programs_toggle, 'missing programs toggle')
  await clickRect(base, closedShell.controls.taskbar_programs_toggle)
  const menu = await waitFor(
    'wait for programs menu search',
    async () => {
      const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return next.programs_menu_open && next.controls?.programs_menu_search ? next : null
    },
    5000,
    100,
  )
  await clickRect(base, assertRectMinSize('programs search', menu.controls.programs_menu_search, 32, 20))
  await typeText(base, query)
  return waitFor(
    `wait for programs query ${query}`,
    async () => {
      const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return next.programs_menu_query === query && next.controls?.programs_menu_first_item ? next : null
    },
    5000,
    100,
  )
}

async function pinAppFromPrograms(base: string, app: DesktopAppEntry, query: string): Promise<{ monitor: string; pinId: string; shell: ShellSnapshot; pin: ShellTaskbarPin }> {
  const pinId = desktopAppPinId(app)
  await unpinRenderedPinIfPresent(base, pinId)
  const menu = await openProgramsSearch(base, query)
  const itemRect = assertRectMinSize('programs first item', menu.controls.programs_menu_first_item, 32, 24)
  const monitor = monitorForRect(menu, menu.controls.taskbar_programs_toggle!)
  await rightClickRect(base, itemRect)
  const pinAction = await contextAction(base, 'pin-to-monitor')
  await clickRect(base, assertRectMinSize('pin app to monitor', pinAction.rect, 32, 18))
  await tapKey(base, KEY.escape)
  await waitForProgramsMenuClosed(base)
  const pinned = await waitForTaskbarPin(base, pinId, monitor)
  const shell = pinned.shell
  const duplicates = (shell.taskbar_pins ?? []).filter((pin) => pin.id === pinId)
  assert(duplicates.length === 1, `expected app pin on one monitor, got ${duplicates.length}`)
  assert(duplicates[0]?.monitor === monitor, `expected app pin on ${monitor}, got ${duplicates[0]?.monitor}`)
  return { monitor, pinId, shell, pin: pinned.pin }
}

async function launchAppPin(base: string, pinId: string, monitor: string): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot; window: WindowSnapshot; pin: ShellTaskbarPin }> {
  const before = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
  const known = new Set(before.windows.map((window) => window.window_id))
  const pinned = await waitForTaskbarPin(base, pinId, monitor)
  await clickRect(base, assertRectMinSize(`app pin ${pinId}`, pinned.pin.rect, 24, 24))
  return waitFor(
    `wait for pinned app launch ${pinId}`,
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const window = compositor.windows.find((entry) => !entry.shell_hosted && !known.has(entry.window_id))
      if (!window) return null
      if (window.output_name !== monitor) return null
      if (window.width < 160 || window.height < 48) return null
      if (!taskbarEntry(shell, window.window_id)?.activate) return null
      const pin = taskbarPin(shell, pinId, monitor)
      return pin?.rect ? { compositor, shell, window, pin } : null
    },
    5000,
    100,
  )
}

async function pinFolderFromFileBrowser(base: string, windowId: number, folderPath: string, folderName: string): Promise<{ monitor: string; pinId: string; shell: ShellSnapshot; pin: ShellTaskbarPin }> {
  const pinId = folderPinId(folderPath)
  await unpinRenderedPinIfPresent(base, pinId)
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const window = shellWindowById(shell, windowId)
  assert(window?.output_name, 'missing file browser output before folder pin')
  const row = fileBrowserRow(shell, folderName, windowId)
  await rightClickRect(base, assertRectMinSize(`folder row ${folderName}`, row?.rect, 32, 24))
  const pinAction = await contextAction(base, 'pin-to-monitor')
  await clickRect(base, assertRectMinSize('pin folder to monitor', pinAction.rect, 32, 18))
  const pinned = await waitForTaskbarPin(base, pinId, window.output_name)
  const duplicates = (pinned.shell.taskbar_pins ?? []).filter((pin) => pin.id === pinId)
  assert(duplicates.length === 1, `expected folder pin on one monitor, got ${duplicates.length}`)
  assert(duplicates[0]?.monitor === window.output_name, `expected folder pin on ${window.output_name}, got ${duplicates[0]?.monitor}`)
  return { monitor: window.output_name, pinId, shell: pinned.shell, pin: pinned.pin }
}

async function launchFolderPin(base: string, pinId: string, monitor: string, folderPath: string): Promise<{ shell: ShellSnapshot; windowId: number; pin: ShellTaskbarPin }> {
  const before = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const known = new Set(before.windows.filter((window) => window.shell_hosted && window.app_id === FILE_BROWSER_APP_ID).map((window) => window.window_id))
  const pinned = await waitForTaskbarPin(base, pinId, monitor)
  await clickRect(base, assertRectMinSize(`folder pin ${pinId}`, pinned.pin.rect, 24, 24))
  return waitFor(
    `wait for pinned folder launch ${folderPath}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const window = shell.windows.find((entry) => entry.shell_hosted && entry.app_id === FILE_BROWSER_APP_ID && !known.has(entry.window_id))
      if (!window) return null
      if (window.output_name !== monitor) return null
      const fb = fileBrowserSnapshot(shell, window.window_id)
      if (fb?.active_path !== folderPath || fb.list_state === 'loading' || fb.list_state === 'error') return null
      const pin = taskbarPin(shell, pinId, monitor)
      return pin?.rect ? { shell, windowId: window.window_id, pin } : null
    },
    5000,
    100,
  )
}

async function closeTrackedWindows(base: string, nativeIds: number[], shellIds: number[]) {
  for (const windowId of nativeIds) {
    await closeWindow(base, windowId)
    await waitForWindowGone(base, windowId)
  }
  for (const windowId of shellIds) {
    await closeWindow(base, windowId)
    await waitForWindowGone(base, windowId)
  }
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('taskbar pins are per-monitor pure shortcuts for apps and folders', async ({ base, state }) => {
    const activeBase = base
    const desktopApps = await ensureDesktopApps(activeBase, state)
    const launcherCandidate = findLauncherCandidate(desktopApps)
    if (!launcherCandidate) {
      throw new SkipError('no stable terminal launcher candidate found')
    }
    const appPin = await pinAppFromPrograms(activeBase, launcherCandidate.app, launcherCandidate.query)
    const firstAppLaunch = await launchAppPin(activeBase, appPin.pinId, appPin.monitor)
    state.spawnedNativeWindowIds.add(firstAppLaunch.window.window_id)
    state.nativeLaunchByWindowId.set(firstAppLaunch.window.window_id, String(launcherCandidate.app.exec ?? ''))
    assert(rectStable(appPin.pin.rect, firstAppLaunch.pin.rect), 'app pin moved after matching app launch')
    const secondAppLaunch = await launchAppPin(activeBase, appPin.pinId, appPin.monitor)
    state.spawnedNativeWindowIds.add(secondAppLaunch.window.window_id)
    state.nativeLaunchByWindowId.set(secondAppLaunch.window.window_id, String(launcherCandidate.app.exec ?? ''))
    assert(secondAppLaunch.window.window_id !== firstAppLaunch.window.window_id, 'app pin reused existing window')
    assert(rectStable(appPin.pin.rect, secondAppLaunch.pin.rect), 'app pin moved after second launch')
    for (const launched of [firstAppLaunch, secondAppLaunch]) {
      const row = taskbarEntry(launched.shell, launched.window.window_id)
      const taskbar = taskbarForMonitor(launched.shell, appPin.monitor)
      assert(row?.activate && taskbar?.rect, 'missing launched app taskbar row')
      assert(pointInRect(taskbar.rect, rectCenter(row.activate)), 'launched app row not on pin monitor')
      assert(appPin.pin.rect!.global_x < row.activate.global_x, 'app pin should render before running rows')
    }

    const fixtures = await prepareFileBrowserFixtures(activeBase)
    const navigated = await navigateToFixtureRoot(activeBase, state.spawnedShellWindowIds, fixtures)
    await waitForActivePath(activeBase, fixtures.root_path, navigated.windowId)
    const folderName = path.posix.basename(fixtures.empty_dir)
    const folderPin = await pinFolderFromFileBrowser(activeBase, navigated.windowId, fixtures.empty_dir, folderName)
    const firstFolderLaunch = await launchFolderPin(activeBase, folderPin.pinId, folderPin.monitor, fixtures.empty_dir)
    state.spawnedShellWindowIds.add(firstFolderLaunch.windowId)
    assert(rectStable(folderPin.pin.rect, firstFolderLaunch.pin.rect), 'folder pin moved after matching folder launch')
    const secondFolderLaunch = await launchFolderPin(activeBase, folderPin.pinId, folderPin.monitor, fixtures.empty_dir)
    state.spawnedShellWindowIds.add(secondFolderLaunch.windowId)
    assert(secondFolderLaunch.windowId !== firstFolderLaunch.windowId, 'folder pin reused existing file browser')
    assert(rectStable(folderPin.pin.rect, secondFolderLaunch.pin.rect), 'folder pin moved after second folder launch')
    for (const windowId of [firstFolderLaunch.windowId, secondFolderLaunch.windowId]) {
      const shell = await getJson<ShellSnapshot>(activeBase, '/test/state/shell')
      const row = taskbarEntry(shell, windowId)
      const taskbar = taskbarForMonitor(shell, folderPin.monitor)
      assert(row?.activate && taskbar?.rect, 'missing launched folder taskbar row')
      assert(pointInRect(taskbar.rect, rectCenter(row.activate)), 'launched folder row not on pin monitor')
      assert(folderPin.pin.rect!.global_x < row.activate.global_x, 'folder pin should render before running rows')
    }

    await closeTrackedWindows(
      activeBase,
      [firstAppLaunch.window.window_id, secondAppLaunch.window.window_id],
      [firstFolderLaunch.windowId, secondFolderLaunch.windowId],
    )
    state.spawnedNativeWindowIds.delete(firstAppLaunch.window.window_id)
    state.spawnedNativeWindowIds.delete(secondAppLaunch.window.window_id)
    state.spawnedShellWindowIds.delete(firstFolderLaunch.windowId)
    state.spawnedShellWindowIds.delete(secondFolderLaunch.windowId)
    const currentShell = await getJson<ShellSnapshot>(activeBase, '/test/state/shell')
    await writeJsonArtifact('taskbar-pins.json', {
      appPin: taskbarPin(currentShell, appPin.pinId, appPin.monitor),
      folderPin: taskbarPin(currentShell, folderPin.pinId, folderPin.monitor),
      appMonitor: appPin.monitor,
      folderMonitor: folderPin.monitor,
      folderPath: fixtures.empty_dir,
    })
    await unpinRenderedPinIfPresent(activeBase, appPin.pinId, appPin.monitor)
    await unpinRenderedPinIfPresent(activeBase, folderPin.pinId, folderPin.monitor)
    const finalShell = await getJson<ShellSnapshot>(activeBase, '/test/state/shell')
    assert(!taskbarPin(finalShell, appPin.pinId, appPin.monitor), 'app pin did not unpin from monitor')
    assert(!taskbarPin(finalShell, folderPin.pinId, folderPin.monitor), 'folder pin did not unpin from monitor')
    assert(!compositorWindowById((await getSnapshots(activeBase)).compositor, firstAppLaunch.window.window_id), 'first app launch survived cleanup')
  })

  test('taskbar pins persist across session restart', async ({ base, state }) => {
    let activeBase = base
    const desktopApps = await ensureDesktopApps(activeBase, state)
    const launcherCandidate = findLauncherCandidate(desktopApps)
    if (!launcherCandidate) {
      throw new SkipError('no stable terminal launcher candidate found')
    }
    const appPin = await pinAppFromPrograms(activeBase, launcherCandidate.app, launcherCandidate.query)
    const fixtures = await prepareFileBrowserFixtures(activeBase)
    const navigated = await navigateToFixtureRoot(activeBase, state.spawnedShellWindowIds, fixtures)
    await waitForActivePath(activeBase, fixtures.root_path, navigated.windowId)
    const folderName = path.posix.basename(fixtures.empty_dir)
    const folderPin = await pinFolderFromFileBrowser(activeBase, navigated.windowId, fixtures.empty_dir, folderName)
    activeBase = await restartSession(state)
    const restoredApp = await waitForTaskbarPin(activeBase, appPin.pinId, appPin.monitor)
    const restoredFolder = await waitForTaskbarPin(activeBase, folderPin.pinId, folderPin.monitor)
    assert(restoredApp.pin.kind === 'app', 'restored app pin kind mismatch')
    assert(restoredFolder.pin.kind === 'folder', 'restored folder pin kind mismatch')
    await writeJsonArtifact('taskbar-pins-restart.json', {
      appPin: restoredApp.pin,
      folderPin: restoredFolder.pin,
      appMonitor: appPin.monitor,
      folderMonitor: folderPin.monitor,
      folderPath: fixtures.empty_dir,
    })
    await unpinRenderedPinIfPresent(activeBase, appPin.pinId, appPin.monitor)
    await unpinRenderedPinIfPresent(activeBase, folderPin.pinId, folderPin.monitor)
    const finalShell = await getJson<ShellSnapshot>(activeBase, '/test/state/shell')
    assert(!taskbarPin(finalShell, appPin.pinId, appPin.monitor), 'restarted app pin did not unpin from monitor')
    assert(!taskbarPin(finalShell, folderPin.pinId, folderPin.monitor), 'restarted folder pin did not unpin from monitor')
  }, { shellRestart: true })
})
