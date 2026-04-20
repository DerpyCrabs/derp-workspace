import { access, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  fileBrowserAction,
  fileBrowserRow,
  fileBrowserSnapshot,
  navigateToFixtureRoot,
  openDirectoryRow,
  openDirectoryRowWithClicks,
  openFileBrowserFromLauncher,
  waitForActivePath,
  waitForDirectoryRowRect,
} from '../lib/fileBrowserFixtureNav.ts'
import {
  KEY,
  assertRectMinSize,
  assert,
  clickRect,
  dragBetweenPoints,
  defineGroup,
  getJson,
  getShellHtml,
  prepareFileBrowserFixtures,
  rectCenter,
  resetFileBrowserFixtures,
  rightClickRect,
  tapKey,
  typeText,
  waitFor,
  waitForShellUiFocus,
  writeJsonArtifact,
  type ShellSnapshot,
} from '../lib/runtime.ts'

const IMAGE_VIEWER_APP_ID = 'derp.image-viewer'
const VIDEO_VIEWER_APP_ID = 'derp.video-viewer'
const PDF_VIEWER_APP_ID = 'derp.pdf-viewer'
const WRITABLE_TEXT = 'Phase 1 writable fixture\nThis file should reset between runs.\n'
const READ_ONLY_TEXT = 'Phase 1 read-only fixture\nThis file should refuse direct writes.\n'
const READ_ONLY_MD = '# Read only doc\n\nbody\n'

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
      fixtures.markdown_with_image,
      fixtures.read_only_markdown,
      fixtures.image_file,
      fixtures.image_file_green,
      fixtures.pdf_file,
      fixtures.video_file,
      fixtures.unsupported_file,
    ]) {
      await access(fixturePath)
    }
    assert((await readFile(fixtures.writable_text, 'utf8')) === WRITABLE_TEXT, 'unexpected writable fixture contents')
    assert((await readFile(fixtures.read_only_text, 'utf8')) === READ_ONLY_TEXT, 'unexpected read-only fixture contents')
    const [imageStats, imageGreenStats, pdfStats, videoStats, unsupportedStats] = await Promise.all([
      stat(fixtures.image_file),
      stat(fixtures.image_file_green),
      stat(fixtures.pdf_file),
      stat(fixtures.video_file),
      stat(fixtures.unsupported_file),
    ])
    assert(imageStats.size > 0, 'expected image fixture bytes')
    assert(imageGreenStats.size > 0, 'expected second image fixture bytes')
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
      shell.file_browser.list_state == null || typeof shell.file_browser.list_state === 'string',
      'expected file_browser list_state to be absent, null, or a string',
    )
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
    assert((await readFile(reset.read_only_markdown, 'utf8')) === READ_ONLY_MD, 'read-only markdown fixture did not reset')
    let mdRoFail = false
    try {
      await writeFile(fixtures.read_only_markdown, 'x', 'utf8')
    } catch {
      mdRoFail = true
    }
    assert(mdRoFail, 'expected read-only markdown fixture write to fail')
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
      2000,
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
      5000,
      100,
    )
    const newEntry = opened.file_browser_windows?.find(
      (w) => w.active_path === expectedMediaPath && w.window_id !== navigated.windowId,
    )
    assert(newEntry, 'expected a second file browser window at the media directory path')
    state.spawnedShellWindowIds.add(newEntry.window_id)
  })

  test('file browser drags a writable file into a folder', async ({ base, state }) => {
    const fixtures = await resetFileBrowserFixtures(base)
    const navigated = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    const emptyName = 'empty-folder'
    const ready = await waitFor(
      'wait for source and target rows',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const sourceRow = fileBrowserRow(shell, '.hidden-file.txt', navigated.windowId)
        const targetRow = fileBrowserRow(shell, emptyName, navigated.windowId)
        return sourceRow?.rect && targetRow?.rect ? { shell, sourceRow, targetRow } : null
      },
      5000,
      100,
    )
    const start = rectCenter(assertRectMinSize('hidden file drag source', ready.sourceRow.rect, 32, 24))
    const target = rectCenter(assertRectMinSize('empty-folder drop target', ready.targetRow.rect, 32, 24))
    await dragBetweenPoints(base, start.x, start.y, target.x, target.y, 18)
    const moved = await waitFor(
      'wait for file move after drop',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        if (fileBrowserRow(shell, '.hidden-file.txt', navigated.windowId)) return null
        return shell
      },
      5000,
      100,
    )
    await access(path.posix.join(fixtures.empty_dir, '.hidden-file.txt'))
    let sourceStillExists = true
    try {
      await access(fixtures.hidden_file)
    } catch {
      sourceStillExists = false
    }
    assert(!sourceStillExists, 'expected hidden file to move out of source directory')
    await writeJsonArtifact('file-browser-dnd-move.json', {
      windowId: navigated.windowId,
      targetPath: fixtures.empty_dir,
      shell: moved,
    })
  })

  test('image viewer opens from file browser and arrow keys switch images', async ({ base, state }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    const navigated = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    const mediaPath = path.posix.join(fixtures.root_path, 'media')
    await openDirectoryRow(base, mediaPath, 'media', navigated.windowId)
    const mediaShell = await waitForActivePath(base, mediaPath, navigated.windowId)
    const blueRow = fileBrowserRow(mediaShell, 'blue-image.png', navigated.windowId)
    assert(blueRow?.rect, 'missing blue-image row')
    await clickRect(base, assertRectMinSize('select blue-image', blueRow.rect, 32, 24))
    await waitFor(
      'wait for blue-image row selected',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return fileBrowserRow(shell, 'blue-image.png', navigated.windowId)?.selected ? shell : null
      },
      5000,
      100,
    )
    const blueSelected = fileBrowserRow(await getJson<ShellSnapshot>(base, '/test/state/shell'), 'blue-image.png', navigated.windowId)
    assert(blueSelected?.rect, 'missing blue-image row rect after selection')
    await clickRect(base, assertRectMinSize('open blue-image second click', blueSelected.rect, 32, 24))
    const viewerWindow = await waitFor(
      'wait for image viewer window',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const w = shell.windows.find(
          (entry) => entry.shell_hosted && entry.app_id === IMAGE_VIEWER_APP_ID && !entry.minimized,
        )
        return w ? { shell, windowId: w.window_id } : null
      },
      5000,
      100,
    )
    state.spawnedShellWindowIds.add(viewerWindow.windowId)
    const frameSelector = `[data-shell-window-frame="${viewerWindow.windowId}"]`
    const html0 = await waitFor(
      'wait for image viewer markup',
      async () => {
        const html = await getShellHtml(base, frameSelector)
        return html.includes('data-image-viewer-counter') && html.includes('1 of 2') ? html : null
      },
      2000,
      100,
    )
    assert(html0.includes('alt="blue-image.png"'), 'expected blue image alt')
    const imageControls = await waitFor(
      'wait for image rotate control',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const row = shell.image_viewer_windows?.find((entry) => entry.window_id === viewerWindow.windowId)
        return row?.rotate_rect && row.fit_rect ? row : null
      },
      2000,
      100,
    )
    await clickRect(base, assertRectMinSize('image rotate', imageControls.rotate_rect, 8, 8))
    const rotated = await waitFor(
      'wait for image rotation',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const row = shell.image_viewer_windows?.find((entry) => entry.window_id === viewerWindow.windowId)
        return row?.img_transform.includes('rotate(90deg)') ? row : null
      },
      2000,
      100,
    )
    assert(rotated.img_transform.includes('rotate(90deg)'), 'expected rotated image transform')
    await clickRect(base, assertRectMinSize('image fit reset', imageControls.fit_rect, 8, 8))
    await waitFor(
      'wait for image rotation reset',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const row = shell.image_viewer_windows?.find((entry) => entry.window_id === viewerWindow.windowId)
        return row?.img_transform.includes('rotate(0deg)') ? row : null
      },
      2000,
      100,
    )
    await tapKey(base, KEY.right)
    const html1 = await waitFor(
      'wait for second image',
      async () => {
        const html = await getShellHtml(base, frameSelector)
        return html.includes('2 of 2') && html.includes('alt="green-dot.png"') ? html : null
      },
      2000,
      100,
    )
    assert(html1.includes('data-image-viewer-counter'), 'expected counter after next')
    await tapKey(base, KEY.left)
    const html2 = await waitFor(
      'wait for first image again',
      async () => {
        const html = await getShellHtml(base, frameSelector)
        return html.includes('1 of 2') && html.includes('alt="blue-image.png"') ? html : null
      },
      2000,
      100,
    )
    assert(html2.includes('data-image-viewer-counter'), 'expected counter after previous')
  })

  test('video viewer opens from file browser and shows video element', async ({ base, state }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    const navigated = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    const mediaPath = path.posix.join(fixtures.root_path, 'media')
    await openDirectoryRow(base, mediaPath, 'media', navigated.windowId)
    const mediaShell = await waitForActivePath(base, mediaPath, navigated.windowId)
    const videoRow = fileBrowserRow(mediaShell, 'test-pattern.webm', navigated.windowId)
    assert(videoRow?.rect, 'missing test-pattern.webm row')
    await clickRect(base, assertRectMinSize('select test-pattern.webm', videoRow.rect, 32, 24))
    await waitFor(
      'wait for test-pattern row selected',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return fileBrowserRow(shell, 'test-pattern.webm', navigated.windowId)?.selected ? shell : null
      },
      5000,
      100,
    )
    const videoSelected = fileBrowserRow(await getJson<ShellSnapshot>(base, '/test/state/shell'), 'test-pattern.webm', navigated.windowId)
    assert(videoSelected?.rect, 'missing test-pattern row rect after selection')
    await clickRect(base, assertRectMinSize('open test-pattern second click', videoSelected.rect, 32, 24))
    const viewerWindow = await waitFor(
      'wait for video viewer window',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const w = shell.windows.find(
          (entry) => entry.shell_hosted && entry.app_id === VIDEO_VIEWER_APP_ID && !entry.minimized,
        )
        return w ? { shell, windowId: w.window_id } : null
      },
      5000,
      100,
    )
    state.spawnedShellWindowIds.add(viewerWindow.windowId)
    const frameSelector = `[data-shell-window-frame="${viewerWindow.windowId}"]`
    const html = await waitFor(
      'wait for video viewer markup',
      async () => {
        const h = await getShellHtml(base, frameSelector)
        return h.includes('data-video-viewer-element') && h.includes('data-video-viewer-counter') && h.includes('1 of 1')
          ? h
          : null
      },
      5000,
      100,
    )
    assert(html.includes('file_browser/stream'), 'expected video src to use stream endpoint')
  })

  test('pdf viewer opens from file browser and streams document', async ({ base, state }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    const navigated = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    const mediaPath = path.posix.join(fixtures.root_path, 'media')
    await openDirectoryRow(base, mediaPath, 'media', navigated.windowId)
    const mediaShell = await waitForActivePath(base, mediaPath, navigated.windowId)
    const pdfRow = fileBrowserRow(mediaShell, 'derp-doc.pdf', navigated.windowId)
    assert(pdfRow?.rect, 'missing derp-doc.pdf row')
    await clickRect(base, assertRectMinSize('select derp-doc.pdf', pdfRow.rect, 32, 24))
    await waitFor(
      'wait for derp-doc row selected',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return fileBrowserRow(shell, 'derp-doc.pdf', navigated.windowId)?.selected ? shell : null
      },
      5000,
      100,
    )
    const pdfSelected = fileBrowserRow(await getJson<ShellSnapshot>(base, '/test/state/shell'), 'derp-doc.pdf', navigated.windowId)
    assert(pdfSelected?.rect, 'missing derp-doc row rect after selection')
    await clickRect(base, assertRectMinSize('open derp-doc second click', pdfSelected.rect, 32, 24))
    const viewerWindow = await waitFor(
      'wait for pdf viewer window',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const w = shell.windows.find(
          (entry) => entry.shell_hosted && entry.app_id === PDF_VIEWER_APP_ID && !entry.minimized,
        )
        const row = w ? shell.pdf_viewer_windows?.find((entry) => entry.window_id === w.window_id) : null
        return w && row?.document_rect ? { shell, windowId: w.window_id, row } : null
      },
      5000,
      100,
    )
    state.spawnedShellWindowIds.add(viewerWindow.windowId)
    const frameSelector = `[data-shell-window-frame="${viewerWindow.windowId}"]`
    const html = await waitFor(
      'wait for pdf viewer markup',
      async () => {
        const h = await getShellHtml(base, frameSelector)
        return h.includes('data-pdf-viewer-document') && h.includes('derp-doc.pdf') ? h : null
      },
      5000,
      100,
    )
    assert(html.includes('application/pdf'), 'expected pdf object type')
    assert(html.includes('file_browser/stream'), 'expected pdf object to use stream endpoint')
    await writeJsonArtifact('file-browser-pdf-viewer.json', viewerWindow)
  })

  test('file browser mkdir rename delete via dialogs', async ({ base, state }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    const navigated = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    await openDirectoryRow(base, fixtures.empty_dir, 'empty-folder', navigated.windowId)
    await waitForActivePath(base, fixtures.empty_dir, navigated.windowId)
    const focused = await waitForShellUiFocus(base, navigated.windowId, 5000)
    const newFolderBtn = fileBrowserAction(focused.shell, 'new-folder', navigated.windowId)
    assert(newFolderBtn?.rect, 'new-folder action')
    await clickRect(base, assertRectMinSize('new-folder', newFolderBtn.rect, 24, 18))
    await waitFor(
      'file browser dialog input',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const r = fileBrowserSnapshot(shell, navigated.windowId)?.dialog_input_rect
        return r && r.width > 4 ? shell : null
      },
      5000,
      100,
    )
    const shellDlg = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const inputRect = fileBrowserSnapshot(shellDlg, navigated.windowId)?.dialog_input_rect
    assert(inputRect && inputRect.width > 4, 'dialog input rect')
    await clickRect(base, assertRectMinSize('dialog input', inputRect, 40, 20))
    await typeText(base, 'a')
    const shellBeforeOk = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const okRect = fileBrowserSnapshot(shellBeforeOk, navigated.windowId)?.dialog_confirm_rect
    assert(okRect && okRect.width > 4, 'dialog confirm rect')
    await clickRect(base, assertRectMinSize('dialog ok', okRect, 24, 18))
    await waitFor(
      'mkdir row',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return fileBrowserRow(shell, 'a', navigated.windowId) ? shell : null
      },
      5000,
      100,
    )
    const shellRow = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const rowA = fileBrowserRow(shellRow, 'a', navigated.windowId)
    assert(rowA?.rect, 'row a')
    await rightClickRect(base, assertRectMinSize('row a ctx', rowA.rect, 24, 18))
    const renameItem = await waitFor(
      'rename context item',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const item = shell.file_browser_context_menu?.find((entry) => entry.id === 'rename')
        return item?.rect ? item : null
      },
      2000,
      100,
    )
    await clickRect(base, assertRectMinSize('rename', renameItem.rect!, 20, 16))
    await waitFor(
      'rename dialog',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const r = fileBrowserSnapshot(shell, navigated.windowId)?.dialog_input_rect
        return r && r.width > 4 ? shell : null
      },
      5000,
      100,
    )
    const shellRen = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const inpRen = fileBrowserSnapshot(shellRen, navigated.windowId)?.dialog_input_rect
    assert(inpRen, 'rename dialog input rect')
    await clickRect(base, assertRectMinSize('rename input', inpRen, 40, 20))
    await tapKey(base, KEY.backspace)
    await typeText(base, 'b')
    const okRen = fileBrowserSnapshot(await getJson<ShellSnapshot>(base, '/test/state/shell'), navigated.windowId)?.dialog_confirm_rect
    assert(okRen, 'rename dialog confirm rect')
    await clickRect(base, assertRectMinSize('rename ok', okRen, 24, 18))
    await waitFor(
      'row b',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return fileBrowserRow(shell, 'b', navigated.windowId) ? shell : null
      },
      5000,
      100,
    )
    const shellB = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const rowB = fileBrowserRow(shellB, 'b', navigated.windowId)
    assert(rowB?.rect, 'row b rect')
    await rightClickRect(base, assertRectMinSize('row b ctx', rowB.rect, 24, 18))
    const delItem = await waitFor(
      'delete context item',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const item = shell.file_browser_context_menu?.find((entry) => entry.id === 'delete')
        return item?.rect ? item : null
      },
      2000,
      100,
    )
    await clickRect(base, assertRectMinSize('delete', delItem.rect!, 20, 16))
    const delOk = await waitFor(
      'delete confirm',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const r = fileBrowserSnapshot(shell, navigated.windowId)?.dialog_confirm_rect
        return r && r.width > 4 ? r : null
      },
      2000,
      100,
    )
    await clickRect(base, assertRectMinSize('delete ok', delOk!, 24, 18))
    await waitFor(
      'row b gone',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return !fileBrowserRow(shell, 'b', navigated.windowId) ? shell : null
      },
      5000,
      100,
    )
  })

  test('file browser opens a directory when clicking an already selected row', async ({ base, state }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    const navigated = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    const targetRow =
      fileBrowserSnapshot(navigated.shell, navigated.windowId)?.rows.find((row) => row.kind === 'directory') ?? null
    assert(targetRow, 'expected a directory row in fixture root')
    const openedDirectory = await openDirectoryRowWithClicks(
      base,
      targetRow.path,
      targetRow.name,
      navigated.windowId,
    )
    assert(
      fileBrowserSnapshot(openedDirectory, navigated.windowId)?.active_path === targetRow.path,
      'expected directory path after second click',
    )
    assert(
      openedDirectory.windows.some((window) => window.window_id === navigated.windowId),
      'expected file browser window to remain open',
    )
  })
})
