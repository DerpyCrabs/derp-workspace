import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  fileBrowserRow,
  navigateToFixtureRoot,
  openDirectoryRow,
  waitForActivePath,
} from '../lib/fileBrowserFixtureNav.ts'
import {
  KEY,
  assert,
  assertRectMinSize,
  clickPoint,
  clickRect,
  compositorWindowById,
  defineGroup,
  ensureWorkspaceTabShowsWindow,
  getJson,
  getShellHtml,
  prepareFileBrowserFixtures,
  movePoint,
  rectCenter,
  shellWindowStack,
  tapKey,
  typeText,
  waitFor,
  waitForCompositorKeyboardWindow,
  type CompositorSnapshot,
  type ShellSnapshot,
  type TextEditorWindowSnapshot,
} from '../lib/runtime.ts'

const TEXT_EDITOR_APP_ID = 'derp.text-editor'

function resolveTextEditorWindowId(
  shell: ShellSnapshot,
  rowPredicate: (row: TextEditorWindowSnapshot | undefined) => boolean,
): number | null {
  const candidates = shell.windows.filter(
    (w) => w.shell_hosted && w.app_id === TEXT_EDITOR_APP_ID && !w.minimized,
  )
  if (!candidates.length) return null
  const rows = shell.text_editor_windows ?? []
  const stack = shellWindowStack(shell)
  let best: { windowId: number; idx: number } | null = null
  for (const c of candidates) {
    const row = rows.find((e) => e.window_id === c.window_id)
    if (!rowPredicate(row)) continue
    const idx = stack.indexOf(c.window_id)
    if (idx < 0) continue
    if (!best || idx < best.idx) best = { windowId: c.window_id, idx }
  }
  return best?.windowId ?? null
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('text editor opens markdown with image and fullscreen', async ({ base, state }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    const navigated = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    const notesPath = path.posix.join(fixtures.root_path, 'notes')
    await openDirectoryRow(base, notesPath, 'notes', navigated.windowId)
    const notesShell = await waitForActivePath(base, notesPath, navigated.windowId)
    const mdRow = fileBrowserRow(notesShell, 'markdown-with-image.md', navigated.windowId)
    assert(mdRow?.rect, 'missing markdown-with-image row')
    await clickRect(base, assertRectMinSize('select md row', mdRow.rect, 32, 24))
    await waitFor(
      'wait md selected',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return fileBrowserRow(shell, 'markdown-with-image.md', navigated.windowId)?.selected ? shell : null
      },
      5000,
      100,
    )
    const mdSelected = fileBrowserRow(await getJson<ShellSnapshot>(base, '/test/state/shell'), 'markdown-with-image.md', navigated.windowId)
    assert(mdSelected?.rect, 'missing md row after select')
    await clickRect(base, assertRectMinSize('open md second click', mdSelected.rect, 32, 24))
    const editor = await waitFor(
      'wait for text editor window with markdown preview image',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const id = resolveTextEditorWindowId(shell, (row) => {
          const r = row?.markdown_img_rect
          return !!(r && r.width >= 4 && r.height >= 4)
        })
        return id !== null ? { windowId: id } : null
      },
      5000,
      100,
    )
    state.spawnedShellWindowIds.add(editor.windowId)
    await ensureWorkspaceTabShowsWindow(base, editor.windowId)
    const frameSel = `[data-shell-window-frame="${editor.windowId}"]`
    const editorHtml = await waitFor(
      'wait for markdown h1 and img',
      async () => {
        const h = await getShellHtml(base, frameSel)
        if (!h.includes('data-text-editor-markdown')) return null
        if (!h.includes('Fixture image md')) return null
        if (!h.includes('file_browser/read')) return null
        if (!h.includes('blue-image.png')) return null
        return h
      },
      5000,
      100,
    )
    assert(editorHtml.includes('data-viewer-copy-path'), 'expected text editor copy path action')
    assert(editorHtml.includes('data-viewer-open-containing-folder'), 'expected text editor folder action')
    assert(editorHtml.includes('data-viewer-open-external'), 'expected text editor external action')
    await ensureWorkspaceTabShowsWindow(base, editor.windowId)
    const withImg = await waitFor(
      'wait for markdown img snapshot rect',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const row = shell.text_editor_windows?.find((e) => e.window_id === editor.windowId) as TextEditorWindowSnapshot | undefined
        const r = row?.markdown_img_rect
        if (!r || r.width < 4 || r.height < 4) return null
        return r
      },
      5000,
      100,
    )
    const compositor0 = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    const hostWin = compositorWindowById(compositor0, editor.windowId)
    assert(hostWin, 'missing compositor window for text editor')
    const titleAim = {
      x: hostWin.x + Math.floor(hostWin.width / 2),
      y: hostWin.y + 14,
    }
    await movePoint(base, titleAim.x, titleAim.y)
    await clickPoint(base, titleAim.x, titleAim.y)
    const imgAim = rectCenter(withImg)
    await movePoint(base, imgAim.x, imgAim.y)
    await clickRect(base, assertRectMinSize('markdown preview img', withImg, 8, 8))
    await waitFor(
      'wait image fullscreen dialog',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const row = shell.text_editor_windows?.find((e) => e.window_id === editor.windowId) as
          | TextEditorWindowSnapshot
          | undefined
        return row?.markdown_img_dialog_open ? shell : null
      },
      5000,
      50,
    )
    await tapKey(base, KEY.escape)
    await waitFor(
      'wait dialog close',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const row = shell.text_editor_windows?.find((e) => e.window_id === editor.windowId) as
          | TextEditorWindowSnapshot
          | undefined
        return row && !row.markdown_img_dialog_open ? shell : null
      },
      5000,
      50,
    )
  })

  test('text editor save persists writable note to disk', async ({ base, state }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    const navigated = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    const notesPath = path.posix.join(fixtures.root_path, 'notes')
    await openDirectoryRow(base, notesPath, 'notes', navigated.windowId)
    const notesShell = await waitForActivePath(base, notesPath, navigated.windowId)
    const txtRow = fileBrowserRow(notesShell, 'writable-note.txt', navigated.windowId)
    assert(txtRow?.rect, 'missing writable-note row')
    await clickRect(base, assertRectMinSize('select txt row', txtRow.rect, 32, 24))
    await waitFor(
      'wait txt selected',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return fileBrowserRow(shell, 'writable-note.txt', navigated.windowId)?.selected ? shell : null
      },
      5000,
      100,
    )
    const sel = fileBrowserRow(await getJson<ShellSnapshot>(base, '/test/state/shell'), 'writable-note.txt', navigated.windowId)
    assert(sel?.rect, 'missing txt row after select')
    await clickRect(base, assertRectMinSize('open txt second click', sel.rect, 32, 24))
    const editor = await waitFor(
      'wait for text editor window with edit control',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const id = resolveTextEditorWindowId(shell, (row) => {
          const r = row?.edit_rect
          return !!(r && r.width >= 4 && r.height >= 4)
        })
        return id !== null ? { windowId: id } : null
      },
      5000,
      100,
    )
    state.spawnedShellWindowIds.add(editor.windowId)
    await ensureWorkspaceTabShowsWindow(base, editor.windowId)
    const editRect = await waitFor(
      'wait edit rect',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const row = shell.text_editor_windows?.find((e) => e.window_id === editor.windowId) as TextEditorWindowSnapshot | undefined
        const r = row?.edit_rect
        if (!r || r.width < 4 || r.height < 4) return null
        return r
      },
      5000,
      100,
    )
    const editCenter = rectCenter(editRect)
    await movePoint(base, editCenter.x, editCenter.y)
    await clickRect(base, assertRectMinSize('text editor edit', editRect, 8, 8))
    const taRect = await waitFor(
      'wait textarea rect',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const row = shell.text_editor_windows?.find((e) => e.window_id === editor.windowId) as TextEditorWindowSnapshot | undefined
        const r = row?.textarea_rect
        if (!r || r.width < 4 || r.height < 4) return null
        return r
      },
      5000,
      100,
    )
    const taCenter = rectCenter(taRect)
    await movePoint(base, taCenter.x, taCenter.y)
    await clickRect(base, assertRectMinSize('focus textarea', taRect, 8, 8))
    await waitForCompositorKeyboardWindow(base, editor.windowId)
    await typeText(base, 'zzz')
    const saveRect = await waitFor(
      'wait save rect',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const row = shell.text_editor_windows?.find((e) => e.window_id === editor.windowId) as TextEditorWindowSnapshot | undefined
        const r = row?.save_rect
        if (!r || r.width < 4 || r.height < 4) return null
        return r
      },
      5000,
      100,
    )
    await clickRect(base, assertRectMinSize('save', saveRect, 8, 8))
    await waitFor(
      'wait disk has typed marker',
      async () => {
        const disk = await readFile(fixtures.writable_text, 'utf8')
        return disk.includes('zzz') ? disk : null
      },
      5000,
      100,
    )
  })

  test('read-only markdown has no edit control in snapshot', async ({ base, state }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    const navigated = await navigateToFixtureRoot(base, state.spawnedShellWindowIds, fixtures)
    const notesPath = path.posix.join(fixtures.root_path, 'notes')
    await openDirectoryRow(base, notesPath, 'notes', navigated.windowId)
    const notesShell = await waitForActivePath(base, notesPath, navigated.windowId)
    const row = fileBrowserRow(notesShell, 'read-only-doc.md', navigated.windowId)
    assert(row?.rect, 'missing read-only-doc row')
    await clickRect(base, assertRectMinSize('select read only md', row.rect, 32, 24))
    await waitFor(
      'wait selected',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return fileBrowserRow(shell, 'read-only-doc.md', navigated.windowId)?.selected ? shell : null
      },
      5000,
      100,
    )
    const sel = fileBrowserRow(await getJson<ShellSnapshot>(base, '/test/state/shell'), 'read-only-doc.md', navigated.windowId)
    assert(sel?.rect, 'missing row after select')
    await clickRect(base, assertRectMinSize('open read only md', sel.rect, 32, 24))
    const editor = await waitFor(
      'wait for read-only text editor window',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const id = resolveTextEditorWindowId(shell, (row) => !!row && row.edit_rect === null)
        return id !== null ? { windowId: id } : null
      },
      5000,
      100,
    )
    state.spawnedShellWindowIds.add(editor.windowId)
    await ensureWorkspaceTabShowsWindow(base, editor.windowId)
    await waitFor(
      'wait snapshot no edit rect',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const te = shell.text_editor_windows?.find((e) => e.window_id === editor.windowId) as TextEditorWindowSnapshot | undefined
        if (!te) return null
        if (te.edit_rect !== null) return null
        return te
      },
      5000,
      100,
    )
  })
})
