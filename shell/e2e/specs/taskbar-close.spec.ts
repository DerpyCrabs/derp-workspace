import path from 'node:path'

import {
  fileBrowserRow,
  navigateToFixtureRoot,
  openDirectoryRow,
  waitForActivePath,
} from '../lib/fileBrowserFixtureNav.ts'
import {
  assert,
  assertRectMinSize,
  clickRect,
  closeTaskbarWindow,
  defineGroup,
  ensureWorkspaceTabShowsWindow,
  getJson,
  openShellTestWindow,
  prepareFileBrowserFixtures,
  shellWindowStack,
  taskbarEntry,
  waitFor,
  waitForWindowGone,
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
  test('taskbar close removes markdown text editor and exposes close rect', async ({ base, state }) => {
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
      'wait for text editor window',
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
    const shellBefore = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const entry = taskbarEntry(shellBefore, editor.windowId)
    assert(entry?.close, 'taskbar row must expose close rect for text editor')
    assertRectMinSize('taskbar close hit target', entry.close, 4, 4)
    await closeTaskbarWindow(base, shellBefore, editor.windowId)
    await waitForWindowGone(base, editor.windowId, 5000)
  })

  test('taskbar close removes shell test window when taskbar rail crowded', async ({ base, state }) => {
    for (let i = 0; i < 6; i += 1) {
      await openShellTestWindow(base, state)
    }
    const target = await openShellTestWindow(base, state)
    const wid = target.window.window_id
    await waitFor(
      'wait taskbar close rect for crowded shell test window',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const close = taskbarEntry(shell, wid)?.close
        return close && close.width >= 4 && close.height >= 4 ? shell : null
      },
      5000,
      100,
    )
    const shell0 = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const row = taskbarEntry(shell0, wid)
    assert(row?.close, 'missing taskbar close under crowded rail')
    assertRectMinSize('crowded taskbar close', row.close, 4, 4)
    await closeTaskbarWindow(base, shell0, wid)
    await waitForWindowGone(base, wid, 5000)
  })
})
