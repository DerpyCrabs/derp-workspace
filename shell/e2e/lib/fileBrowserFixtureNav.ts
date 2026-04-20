import path from 'node:path'

import {
  assertRectMinSize,
  assert,
  clickRect,
  getJson,
  openProgramsMenu,
  waitFor,
  type FileBrowserFixturePaths,
  type FileBrowserSnapshot,
  type FileBrowserSnapshotAction,
  type FileBrowserSnapshotRow,
  type ShellSnapshot,
} from './runtime.ts'

export const FILE_BROWSER_APP_ID = 'derp.files'

export function fileBrowserSnapshot(shell: ShellSnapshot, windowId?: number): FileBrowserSnapshot | null {
  if (windowId === undefined) return shell.file_browser ?? null
  return shell.file_browser_windows?.find((entry) => entry.window_id === windowId) ?? null
}

export function fileBrowserRow(shell: ShellSnapshot, name: string, windowId?: number): FileBrowserSnapshotRow | null {
  return fileBrowserSnapshot(shell, windowId)?.rows.find((row) => row.name === name) ?? null
}

export function fileBrowserAction(shell: ShellSnapshot, id: string, windowId?: number): FileBrowserSnapshotAction | null {
  return fileBrowserSnapshot(shell, windowId)?.primary_actions.find((action) => action.id === id) ?? null
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

export async function openFileBrowserFromLauncher(
  base: string,
  spawnedShellWindowIds: Set<number>,
): Promise<{ shell: ShellSnapshot; windowId: number }> {
  const before = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const existingIds = new Set(
    before.windows
      .filter((window) => window.shell_hosted && window.app_id === FILE_BROWSER_APP_ID)
      .map((window) => window.window_id),
  )
  const readyMenu = await ensureProgramsMenuSearchReady(base, await openProgramsMenu(base, 'keybind'))
  assert(readyMenu.controls?.programs_menu_first_item, 'missing first launcher item')
  await clickRect(base, assertRectMinSize('launcher first item', readyMenu.controls.programs_menu_first_item, 24, 18))
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
      const fb = fileBrowserSnapshot(shell, window.window_id)
      if (!fb?.active_path) return null
      if (shell.programs_menu_open) return null
      return { shell, windowId: window.window_id }
    },
    5000,
    100,
  )
  spawnedShellWindowIds.add(opened.windowId)
  return opened
}

export async function waitForActivePath(base: string, expectedPath: string, windowId?: number) {
  return waitFor(
    `wait for file browser path ${expectedPath}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const fb = fileBrowserSnapshot(shell, windowId)
      if (fb?.active_path !== expectedPath) return null
      if (fb.list_state === 'loading' || fb.list_state === 'error') return null
      return shell
    },
    2000,
    100,
  )
}

export async function waitForDirectoryRowRect(base: string, currentPath: string, rowName: string, windowId: number) {
  return waitFor(
    `wait for ${rowName} row rect`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const fb = fileBrowserSnapshot(shell, windowId)
      if (fb?.active_path !== currentPath) return null
      if (fb.list_state === 'loading' || fb.list_state === 'error') return null
      const row = fileBrowserRow(shell, rowName, windowId)
      return row?.rect ? { shell, row } : null
    },
    2000,
    100,
  )
}

async function ensureHiddenRowVisible(base: string, currentPath: string, rowName: string, windowId: number) {
  if (!rowName.startsWith('.')) return
  const shell = await waitForActivePath(base, currentPath, windowId)
  if (fileBrowserRow(shell, rowName, windowId)?.rect) return
  const showHiddenAction = fileBrowserAction(shell, 'show-hidden', windowId)
  if (!showHiddenAction?.rect) return
  await clickRect(base, assertRectMinSize('show hidden action', showHiddenAction.rect, 28, 20))
  await waitFor(
    `wait for hidden row ${rowName}`,
    async () => {
      const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const fb = fileBrowserSnapshot(next, windowId)
      if (fb?.active_path !== currentPath) return null
      if (fb.list_state === 'loading' || fb.list_state === 'error') return null
      return fileBrowserRow(next, rowName, windowId)?.rect ? next : null
    },
    2000,
    100,
  )
}

export async function openDirectoryRow(base: string, expectedPath: string, rowName: string, windowId: number) {
  const currentPath = path.posix.dirname(expectedPath)
  await ensureHiddenRowVisible(base, currentPath, rowName, windowId)
  const { row } = await waitForDirectoryRowRect(base, currentPath, rowName, windowId)
  const rect1 = assertRectMinSize(`file browser row ${rowName}`, row.rect, 32, 24)
  await clickRect(base, rect1)
  const peek1 = await getJson<ShellSnapshot>(base, '/test/state/shell')
  if (fileBrowserSnapshot(peek1, windowId)?.active_path === expectedPath) return peek1
  const afterFirst = await waitFor(
    `wait for ${rowName} selection or navigate`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      if (fileBrowserSnapshot(shell, windowId)?.active_path === expectedPath) return shell
      return fileBrowserRow(shell, rowName, windowId)?.selected ? shell : null
    },
    4000,
    40,
  )
  if (fileBrowserSnapshot(afterFirst, windowId)?.active_path === expectedPath) return afterFirst
  const rect2 = fileBrowserRow(afterFirst, rowName, windowId)?.rect ?? rect1
  await clickRect(base, assertRectMinSize(`file browser row open ${rowName}`, rect2, 32, 24))
  return waitForActivePath(base, expectedPath, windowId)
}

export async function openDirectoryRowWithClicks(base: string, expectedPath: string, rowName: string, windowId: number) {
  return openDirectoryRow(base, expectedPath, rowName, windowId)
}

export async function navigateToFixtureRoot(
  base: string,
  spawnedShellWindowIds: Set<number>,
  fixtures: FileBrowserFixturePaths,
): Promise<{ shell: ShellSnapshot; windowId: number }> {
  const opened = await openFileBrowserFromLauncher(base, spawnedShellWindowIds)
  const settled = await waitFor(
    'wait for file browser primary actions',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const fb = fileBrowserSnapshot(shell, opened.windowId)
      if (!fb?.active_path) return null
      if (fb.list_state !== 'ready') return null
      return fileBrowserAction(shell, 'show-hidden', opened.windowId) || fileBrowserAction(shell, 'hide-hidden', opened.windowId)
        ? shell
        : null
    },
    2000,
    40,
  )
  const initialPath = fileBrowserSnapshot(settled, opened.windowId)?.active_path
  assert(typeof initialPath === 'string' && initialPath.length > 0, 'missing initial file browser path')
  let walkPath = initialPath
  let relativeSegments = path.posix.relative(walkPath, fixtures.root_path).split('/').filter(Boolean)
  for (let guard = 0; guard < 32 && relativeSegments[0] === '..'; guard += 1) {
    const shellUp = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const upAction = fileBrowserAction(shellUp, 'up', opened.windowId)
    assert(upAction?.rect, 'file browser up action')
    await clickRect(base, assertRectMinSize('file browser up', upAction.rect, 28, 20))
    const settledUp = await waitFor(
      'file browser path after up',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const ap = fileBrowserSnapshot(shell, opened.windowId)?.active_path
        const fb = fileBrowserSnapshot(shell, opened.windowId)
        if (!ap || fb?.list_state === 'loading' || fb?.list_state === 'error') return null
        const rel = path.posix.relative(ap, fixtures.root_path).split('/').filter(Boolean)
        if (rel[0] === '..') return null
        return shell
      },
      2000,
      100,
    )
    walkPath = fileBrowserSnapshot(settledUp, opened.windowId)?.active_path ?? ''
    assert(walkPath.length > 0, 'missing path after file browser up')
    relativeSegments = path.posix.relative(walkPath, fixtures.root_path).split('/').filter(Boolean)
  }
  assert(relativeSegments[0] !== '..', 'fixture root not reachable from file browser')
  relativeSegments = relativeSegments.filter((segment) => segment !== '.')
  const shellAfterWalk = await getJson<ShellSnapshot>(base, '/test/state/shell')
  walkPath = fileBrowserSnapshot(shellAfterWalk, opened.windowId)?.active_path ?? walkPath
  const showHiddenAction = fileBrowserAction(shellAfterWalk, 'show-hidden', opened.windowId)
  if (showHiddenAction?.rect) {
    await clickRect(base, assertRectMinSize('show hidden action', showHiddenAction.rect, 28, 20))
    await waitFor(
      'wait for hidden rows to appear',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const fb = fileBrowserSnapshot(shell, opened.windowId)
        const toggleApplied = !!fileBrowserAction(shell, 'hide-hidden', opened.windowId)
        if (!toggleApplied) return null
        if (fb?.active_path !== walkPath) return null
        if (fb.list_state === 'loading' || fb.list_state === 'error') return null
        const firstSegment = relativeSegments[0]
        if (!firstSegment) return shell
        return fileBrowserRow(shell, firstSegment, opened.windowId) ? shell : null
      },
      2000,
      100,
    )
  }
  for (const segment of relativeSegments) {
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const currentPath = fileBrowserSnapshot(shell, opened.windowId)?.active_path
    assert(typeof currentPath === 'string' && currentPath.length > 0, 'missing file browser path during fixture walk')
    await ensureHiddenRowVisible(base, currentPath, segment, opened.windowId)
    const expectedPath = path.posix.normalize(path.posix.join(currentPath, segment))
    await openDirectoryRow(base, expectedPath, segment, opened.windowId)
  }
  return {
    shell: await waitForActivePath(base, fixtures.root_path, opened.windowId),
    windowId: opened.windowId,
  }
}
