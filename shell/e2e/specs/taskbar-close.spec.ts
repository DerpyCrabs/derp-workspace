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
  dragRectToRect,
  ensureWorkspaceTabShowsWindow,
  getJson,
  getShellHtml,
  movePoint,
  openShellTestWindow,
  prepareFileBrowserFixtures,
  rectCenter,
  rightClickRect,
  shellWindowStack,
  shellWindowById,
  tabGroupByWindow,
  taskbarEntry,
  waitFor,
  waitForWindowGone,
  type ShellSnapshot,
  type TextEditorWindowSnapshot,
} from '../lib/runtime.ts'

const TEXT_EDITOR_APP_ID = 'derp.text-editor'

function tabRect(shell: ShellSnapshot, windowId: number) {
  const group = tabGroupByWindow(shell, windowId)
  assert(group, `missing tab group for window ${windowId}`)
  const tab = group.tabs.find((entry) => entry.window_id === windowId)
  assert(tab?.rect, `missing tab rect for window ${windowId}`)
  return tab.rect
}

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
  test('taskbar context menu close removes markdown text editor', async ({ base, state }) => {
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
    assert(entry?.activate, 'taskbar row must expose activate rect for text editor')
    assert(!entry.close, 'taskbar row should not expose an inline close rect')
    await rightClickRect(base, assertRectMinSize('taskbar row hit target', entry.activate, 12, 12))
    const closeAction = await waitFor(
      'wait taskbar close window action',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const item = shell.file_browser_context_menu?.find((entry) => entry.id === 'close-window')
        return item?.rect ? item : null
      },
      5000,
      40,
    )
    await clickRect(base, assertRectMinSize('taskbar close window action', closeAction.rect, 32, 18))
    await waitForWindowGone(base, editor.windowId, 5000)
  })

  test('taskbar context menu close removes shell test window when taskbar rail crowded', async ({ base, state }) => {
    for (let i = 0; i < 6; i += 1) {
      await openShellTestWindow(base, state)
    }
    const target = await openShellTestWindow(base, state)
    const wid = target.window.window_id
    await waitFor(
      'wait taskbar row for crowded shell test window',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const activate = taskbarEntry(shell, wid)?.activate
        return activate && activate.width >= 12 && activate.height >= 12 ? shell : null
      },
      5000,
      100,
    )
    const shell0 = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const row = taskbarEntry(shell0, wid)
    assert(row?.activate, 'missing taskbar row under crowded rail')
    assert(!row.close, 'crowded taskbar row should not expose inline close')
    await closeTaskbarWindow(base, shell0, wid)
    await waitForWindowGone(base, wid, 5000)
  })

  test('taskbar row tooltip clears when hovered window closes', async ({ base, state }) => {
    const target = await openShellTestWindow(base, state)
    const wid = target.window.window_id
    const shell0 = await waitFor(
      'wait taskbar row for tooltip close target',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return taskbarEntry(shell, wid)?.activate ? shell : null
      },
      5000,
      100,
    )
    const row = taskbarEntry(shell0, wid)
    assert(row?.activate, 'missing taskbar activate rect for tooltip close target')
    const center = rectCenter(row.activate)
    await movePoint(base, center.x, center.y)
    await waitFor(
      'wait taskbar tooltip before close',
      async () => {
        const html = await getShellHtml(base, '[data-shell-taskbar-row-tooltip]')
        return html.includes(target.window.title) ? html : null
      },
      3000,
      40,
    )
    await closeTaskbarWindow(base, shell0, wid)
    await waitForWindowGone(base, wid, 5000)
    await waitFor(
      'wait taskbar tooltip clears after close',
      async () => {
        const html = await getShellHtml(base, '[data-shell-taskbar-row-tooltip]')
        return html.length === 0 ? true : null
      },
      3000,
      40,
    )
  })

  test('taskbar context menu closes whole tab group', async ({ base, state }) => {
    const first = await openShellTestWindow(base, state)
    const second = await openShellTestWindow(base, state)
    const firstId = first.window.window_id
    const secondId = second.window.window_id
    const beforeGroup = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await dragRectToRect(base, tabRect(beforeGroup, secondId), tabRect(beforeGroup, firstId))
    const grouped = await waitFor(
      'wait taskbar grouped row',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const group = tabGroupByWindow(shell, firstId)
        const row = group ? taskbarEntry(shell, group.visible_window_id) : null
        if (!group || !row?.activate || row.tab_count !== 2) return null
        return { shell, row, group }
      },
      5000,
      100,
    )
    await rightClickRect(base, assertRectMinSize('group taskbar row', grouped.row.activate, 12, 12))
    const closeAction = await waitFor(
      'wait taskbar close group action',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const item = shell.file_browser_context_menu?.find((entry) => entry.id === 'close-group')
        return item?.rect ? item : null
      },
      5000,
      40,
    )
    await clickRect(base, assertRectMinSize('taskbar close group action', closeAction.rect, 32, 18))
    await waitForWindowGone(base, firstId, 5000)
    await waitForWindowGone(base, secondId, 5000)
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assert(!shellWindowById(shell, firstId), 'first grouped window survived close group')
    assert(!shellWindowById(shell, secondId), 'second grouped window survived close group')
  })
})
