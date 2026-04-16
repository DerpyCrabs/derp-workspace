import { access, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  KEY,
  assertRectMinSize,
  assert,
  clickRect,
  defineGroup,
  getJson,
  getShellHtml,
  openProgramsMenu,
  prepareFileBrowserFixtures,
  resetFileBrowserFixtures,
  restartSession,
  rightClickRect,
  tapKey,
  waitFor,
  writeJsonArtifact,
  type FileBrowserFixturePaths,
  type FileBrowserSnapshot,
  type FileBrowserSnapshotAction,
  type FileBrowserSnapshotRow,
  type ShellSnapshot,
} from '../lib/runtime.ts'

const FILE_BROWSER_APP_ID = 'derp.files'
const WRITABLE_TEXT = 'Phase 1 writable fixture\nThis file should reset between runs.\n'
const READ_ONLY_TEXT = 'Phase 1 read-only fixture\nThis file should refuse direct writes.\n'

function fileBrowserSnapshot(shell: ShellSnapshot, windowId?: number): FileBrowserSnapshot | null {
  if (windowId === undefined) return shell.file_browser ?? null
  return shell.file_browser_windows?.find((entry) => entry.window_id === windowId) ?? null
}

function fileBrowserRow(shell: ShellSnapshot, name: string, windowId?: number): FileBrowserSnapshotRow | null {
  return fileBrowserSnapshot(shell, windowId)?.rows.find((row) => row.name === name) ?? null
}

function fileBrowserAction(shell: ShellSnapshot, id: string, windowId?: number): FileBrowserSnapshotAction | null {
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

async function openFileBrowserFromLauncher(
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
      if (!fileBrowserSnapshot(shell, window.window_id)?.active_path) return null
      if (shell.programs_menu_open) return null
      return { shell, windowId: window.window_id }
    },
    10000,
    100,
  )
  spawnedShellWindowIds.add(opened.windowId)
  return opened
}

async function waitForActivePath(base: string, expectedPath: string, windowId?: number) {
  return waitFor(
    `wait for file browser path ${expectedPath}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return fileBrowserSnapshot(shell, windowId)?.active_path === expectedPath ? shell : null
    },
    8000,
    100,
  )
}

async function waitForDirectoryRowRect(base: string, currentPath: string, rowName: string, windowId: number) {
  return waitFor(
    `wait for ${rowName} row rect`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      if (fileBrowserSnapshot(shell, windowId)?.active_path !== currentPath) return null
      const row = fileBrowserRow(shell, rowName, windowId)
      return row?.rect ? { shell, row } : null
    },
    8000,
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
      if (fileBrowserSnapshot(next, windowId)?.active_path !== currentPath) return null
      return fileBrowserRow(next, rowName, windowId)?.rect ? next : null
    },
    8000,
    100,
  )
}

async function openDirectoryRow(base: string, expectedPath: string, rowName: string, windowId: number) {
  const currentPath = path.posix.dirname(expectedPath)
  await ensureHiddenRowVisible(base, currentPath, rowName, windowId)
  const { row } = await waitForDirectoryRowRect(base, currentPath, rowName, windowId)
  await clickRect(base, assertRectMinSize(`file browser row ${rowName}`, row.rect, 32, 24))
  const selectedOrOpened = await waitFor(
    `wait for ${rowName} selection`,
    async () => {
      const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
      if (fileBrowserSnapshot(next, windowId)?.active_path === expectedPath) return next
      return fileBrowserRow(next, rowName, windowId)?.selected ? next : null
    },
    4000,
    100,
  )
  if (fileBrowserSnapshot(selectedOrOpened, windowId)?.active_path === expectedPath) return selectedOrOpened
  await tapKey(base, KEY.enter)
  return waitForActivePath(base, expectedPath, windowId)
}

async function openDirectoryRowWithClicks(base: string, expectedPath: string, rowName: string, windowId: number) {
  const currentPath = path.posix.dirname(expectedPath)
  await ensureHiddenRowVisible(base, currentPath, rowName, windowId)
  const { row } = await waitForDirectoryRowRect(base, currentPath, rowName, windowId)
  await clickRect(base, assertRectMinSize(`file browser row ${rowName}`, row.rect, 32, 24))
  await waitFor(
    `wait for ${rowName} selection`,
    async () => {
      const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
      if (fileBrowserSnapshot(next, windowId)?.active_path === expectedPath) return next
      return fileBrowserRow(next, rowName, windowId)?.selected ? next : null
    },
    4000,
    100,
  )
  const openedShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  if (fileBrowserSnapshot(openedShell, windowId)?.active_path === expectedPath) return openedShell
  const { row: selectedRow } = await waitForDirectoryRowRect(base, currentPath, rowName, windowId)
  await clickRect(base, assertRectMinSize(`selected file browser row ${rowName}`, selectedRow.rect, 32, 24))
  return waitForActivePath(base, expectedPath, windowId)
}

async function navigateToFixtureRoot(
  base: string,
  spawnedShellWindowIds: Set<number>,
  fixtures: FileBrowserFixturePaths,
): Promise<{ shell: ShellSnapshot; windowId: number }> {
  const opened = await openFileBrowserFromLauncher(base, spawnedShellWindowIds)
  const settled = await waitFor(
    'wait for file browser primary actions',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      if (!fileBrowserSnapshot(shell, opened.windowId)?.active_path) return null
      return fileBrowserAction(shell, 'show-hidden', opened.windowId) || fileBrowserAction(shell, 'hide-hidden', opened.windowId)
        ? shell
        : null
    },
    8000,
    100,
  )
  const initialPath = fileBrowserSnapshot(settled, opened.windowId)?.active_path
  assert(typeof initialPath === 'string' && initialPath.length > 0, 'missing initial file browser path')
  const relativeSegments = path.posix.relative(initialPath, fixtures.root_path).split('/').filter(Boolean)
  const showHiddenAction = fileBrowserAction(settled, 'show-hidden', opened.windowId)
  if (showHiddenAction?.rect) {
    await clickRect(base, assertRectMinSize('show hidden action', showHiddenAction.rect, 28, 20))
    await waitFor(
      'wait for hidden rows to appear',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const toggleApplied = !!fileBrowserAction(shell, 'hide-hidden', opened.windowId)
        if (!toggleApplied) return null
        if (fileBrowserSnapshot(shell, opened.windowId)?.active_path !== initialPath) return null
        const firstSegment = relativeSegments[0]
        if (!firstSegment) return shell
        return fileBrowserRow(shell, firstSegment, opened.windowId) ? shell : null
      },
      8000,
      100,
    )
  }
  let currentPath = initialPath
  for (const segment of relativeSegments) {
    currentPath = path.posix.join(currentPath, segment)
    await openDirectoryRow(base, currentPath, segment, opened.windowId)
  }
  return {
    shell: await waitForActivePath(base, fixtures.root_path, opened.windowId),
    windowId: opened.windowId,
  }
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('file browser fixtures prepare deterministically and expose snapshot contract', async ({ base, state }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    for (const fixturePath of [
      fixtures.root_path,
      fixtures.empty_dir,
      fixtures.hidden_dir,
      fixtures.hidden_file,
      fixtures.hidden_dir_file,
      fixtures.writable_text,
      fixtures.read_only_text,
      fixtures.nested_text,
      fixtures.image_file,
      fixtures.pdf_file,
      fixtures.video_file,
      fixtures.unsupported_file,
    ]) {
      await access(fixturePath)
    }
    assert((await readFile(fixtures.writable_text, 'utf8')) === WRITABLE_TEXT, 'unexpected writable fixture contents')
    assert((await readFile(fixtures.read_only_text, 'utf8')) === READ_ONLY_TEXT, 'unexpected read-only fixture contents')
    const [imageStats, pdfStats, videoStats, unsupportedStats] = await Promise.all([
      stat(fixtures.image_file),
      stat(fixtures.pdf_file),
      stat(fixtures.video_file),
      stat(fixtures.unsupported_file),
    ])
    assert(imageStats.size > 0, 'expected image fixture bytes')
    assert(pdfStats.size > 0, 'expected pdf fixture bytes')
    assert(videoStats.size > 0, 'expected video fixture bytes')
    assert(unsupportedStats.size > 0, 'expected unsupported fixture bytes')
    let shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    if (!shell.file_browser) {
      const opened = await openFileBrowserFromLauncher(base, state.spawnedShellWindowIds)
      shell = opened.shell
    }
    assert(shell.file_browser && typeof shell.file_browser === 'object', 'missing file_browser snapshot section')
    assert(Array.isArray(shell.file_browser.rows), 'file_browser rows should be an array')
    assert(Array.isArray(shell.file_browser.breadcrumbs), 'file_browser breadcrumbs should be an array')
    assert(Array.isArray(shell.file_browser.primary_actions), 'file_browser primary_actions should be an array')
    assert(
      shell.file_browser.active_path === null || typeof shell.file_browser.active_path === 'string',
      'expected file_browser active_path to be null or a string',
    )
    assert(
      shell.file_browser.viewer_editor_title === null || typeof shell.file_browser.viewer_editor_title === 'string',
      'expected viewer/editor title to be null or a string',
    )
    await writeJsonArtifact('file-browser-phase1-prepare.json', {
      fixtures,
      file_browser_snapshot: shell.file_browser,
    })
  })

  test('file browser fixtures reset writable changes and preserve read-only guardrails', async ({ base }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    const mutated = `${WRITABLE_TEXT}mutated during test\n`
    await writeFile(fixtures.writable_text, mutated, 'utf8')
    assert((await readFile(fixtures.writable_text, 'utf8')) === mutated, 'expected writable fixture mutation to stick before reset')
    let readOnlyWriteFailed = false
    try {
      await writeFile(fixtures.read_only_text, 'should fail\n', 'utf8')
    } catch {
      readOnlyWriteFailed = true
    }
    assert(readOnlyWriteFailed, 'expected read-only fixture write to fail')
    const reset = await resetFileBrowserFixtures(base)
    assert(reset.root_path === fixtures.root_path, 'fixture root path changed across reset')
    assert((await readFile(reset.writable_text, 'utf8')) === WRITABLE_TEXT, 'writable fixture did not reset')
    assert((await readFile(reset.read_only_text, 'utf8')) === READ_ONLY_TEXT, 'read-only fixture did not reset')
    await writeJsonArtifact('file-browser-phase1-reset.json', {
      prepared: fixtures,
      reset,
    })
  })

  test('file browser opens from launcher and supports breadcrumbs hidden items refresh and empty state', async ({ base, state }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    const navigated = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    let shell = navigated.shell
    assert(fileBrowserSnapshot(shell, navigated.windowId)?.active_path === fixtures.root_path, 'expected fixture root to be active')
    assert(fileBrowserRow(shell, '.hidden-file.txt', navigated.windowId), 'expected hidden file after enabling hidden items')
    assert(fileBrowserRow(shell, '.hidden-folder', navigated.windowId), 'expected hidden folder after enabling hidden items')
    const refreshAction = fileBrowserAction(shell, 'refresh', navigated.windowId)
    assert(refreshAction?.rect, 'missing refresh action')
    await clickRect(base, assertRectMinSize('refresh action', refreshAction.rect, 28, 20))
    shell = await waitForActivePath(base, fixtures.root_path, navigated.windowId)
    const browserHtml = await getShellHtml(base, `[data-shell-window-frame="${navigated.windowId}"]`)
    assert(browserHtml.includes('Modified'), 'file browser html should include modified column')
    assert(browserHtml.includes('Size'), 'file browser html should include size column')
    await openDirectoryRow(base, fixtures.empty_dir, 'empty-folder', navigated.windowId)
    const emptyHtml = await getShellHtml(base, '[data-file-browser-active-path]')
    assert(emptyHtml.includes(fixtures.empty_dir), 'expected empty folder path marker')
    const emptyWindowHtml = await getShellHtml(base, `[data-shell-window-frame="${navigated.windowId}"]`)
    assert(emptyWindowHtml.includes('This folder is empty.'), 'expected empty state copy')
    const rootBreadcrumb = fileBrowserSnapshot(await getJson<ShellSnapshot>(base, '/test/state/shell'), navigated.windowId)?.breadcrumbs.find(
      (crumb) => crumb.path === fixtures.root_path,
    )
    assert(rootBreadcrumb?.rect, 'missing root breadcrumb')
    await clickRect(base, assertRectMinSize('file browser root breadcrumb', rootBreadcrumb.rect, 24, 18))
    await waitForActivePath(base, fixtures.root_path, navigated.windowId)
  })

  test('file browser keyboard navigation selects rows and Enter opens a directory', async ({ base, state }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    const navigated = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    const initialShell = navigated.shell
    const emptyRow = fileBrowserRow(initialShell, 'empty-folder', navigated.windowId)
    assert(emptyRow?.rect, 'missing empty-folder row')
    await clickRect(base, assertRectMinSize('empty-folder row', emptyRow.rect, 32, 24))
    await tapKey(base, KEY.down)
    const mediaSelected = await waitFor(
      'wait for media row selection',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const mediaRow = fileBrowserRow(shell, 'media', navigated.windowId)
        return mediaRow?.selected ? shell : null
      },
      5000,
      100,
    )
    assert(fileBrowserRow(mediaSelected, 'media', navigated.windowId)?.selected, 'expected media row selected after ArrowDown')
    await tapKey(base, KEY.enter)
    const mediaPath = path.posix.join(fixtures.root_path, 'media')
    const openedMedia = await waitForActivePath(base, mediaPath, navigated.windowId)
    assert(fileBrowserRow(openedMedia, 'blue-image.png', navigated.windowId), 'expected media directory contents after Enter')
  })

  test('file browser open in new window lists the selected directory path', async ({ base, state }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    const navigated = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    const rootPath = fixtures.root_path
    const { row } = await waitForDirectoryRowRect(base, rootPath, 'media', navigated.windowId)
    const expectedMediaPath = row.path
    const rowRect = assertRectMinSize('media row context target', row.rect, 32, 24)
    await rightClickRect(base, rowRect)
    const openNewItem = await waitFor(
      'wait for open in new window context menu item',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const item = shell.file_browser_context_menu?.find((entry) => entry.id === 'open-new')
        return item?.rect ? item : null
      },
      8000,
      100,
    )
    await clickRect(base, assertRectMinSize('open in new window menu item', openNewItem.rect!, 24, 18))
    const opened = await waitFor(
      'wait for file browser window at media path',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const match = shell.file_browser_windows?.find(
          (w) => w.active_path === expectedMediaPath && w.window_id !== navigated.windowId,
        )
        return match ? shell : null
      },
      10000,
      100,
    )
    const newEntry = opened.file_browser_windows?.find(
      (w) => w.active_path === expectedMediaPath && w.window_id !== navigated.windowId,
    )
    assert(newEntry, 'expected a second file browser window at the media directory path')
    state.spawnedShellWindowIds.add(newEntry.window_id)
  })

  test('session restart restores file browser directory path from compositor', async ({ base, state }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    const navigated = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    const mediaPath = path.posix.join(fixtures.root_path, 'media')
    await openDirectoryRow(base, mediaPath, 'media', navigated.windowId)
    await waitForActivePath(base, mediaPath, navigated.windowId)
    const restartedBase = await restartSession(state)
    await waitForActivePath(restartedBase, mediaPath, navigated.windowId)
  })

  test('file browser opens a directory when clicking an already selected row', async ({ base, state }) => {
    const opened = await openFileBrowserFromLauncher(base, state.spawnedShellWindowIds)
    const settled = await waitFor(
      'wait for a visible directory row',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const fileBrowser = fileBrowserSnapshot(shell, opened.windowId)
        if (!fileBrowser?.active_path) return null
        return fileBrowser.rows.find((row) => row.kind === 'directory') ? shell : null
      },
      8000,
      100,
    )
    const targetRow = fileBrowserSnapshot(settled, opened.windowId)?.rows.find((row) => row.kind === 'directory') ?? null
    assert(targetRow, 'expected a directory row to be visible')
    const openedDirectory = await openDirectoryRowWithClicks(base, targetRow.path, targetRow.name, opened.windowId)
    assert(fileBrowserSnapshot(openedDirectory, opened.windowId)?.active_path === targetRow.path, 'expected directory path after second click')
    assert(openedDirectory.windows.some((window) => window.window_id === opened.windowId), 'expected file browser window to remain open')
  })
})
