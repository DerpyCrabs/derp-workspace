import {
  activateTaskbarWindow,
  assert,
  defineGroup,
  ensureNativePair,
  getJson,
  openProgramsMenu,
  raiseTaskbarWindow,
  shellWindowById,
  taskbarEntry,
  waitFor,
  waitForNativeFocus,
  waitForProgramsMenuClosed,
  waitForWindowMinimized,
  type CompositorSnapshot,
} from '../lib/runtime.ts'
import { keyAction } from '../lib/user.ts'

const SUPER_KEYCODE = 125

export default defineGroup(import.meta.url, ({ test }) => {
  test('taskbar minimizes focused native after programs menu returns to shell', async ({ base, state }) => {
    const { red } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    await raiseTaskbarWindow(base, redId)
    await openProgramsMenu(base, 'click')
    await keyAction(base, SUPER_KEYCODE, 'tap')
    await waitForProgramsMenuClosed(base)
    await waitFor(
      'compositor keyboard back on native or shell routing idle',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        if (compositor.focused_window_id === redId) return compositor
        if (compositor.shell_keyboard_focus === true) return compositor
        return null
      },
      5000,
      50,
    )
    const shellBefore = await getJson(base, '/test/state/shell')
    assert(taskbarEntry(shellBefore, redId)?.activate, 'missing native taskbar activate rect')
    await activateTaskbarWindow(base, shellBefore, redId)
    const minimized = await waitForWindowMinimized(base, redId)
    assert(
      shellWindowById(minimized.shell, redId)?.minimized,
      'taskbar should minimize native window after programs menu',
    )
  })

  test('taskbar click restores minimized native window', async ({ base, state }) => {
    const { red } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    await raiseTaskbarWindow(base, redId)
    const shellBefore = await getJson(base, '/test/state/shell')
    assert(taskbarEntry(shellBefore, redId)?.activate, 'missing native taskbar activate rect')
    await activateTaskbarWindow(base, shellBefore, redId)
    const minimized = await waitForWindowMinimized(base, redId)
    assert(shellWindowById(minimized.shell, redId)?.minimized, 'expected minimized before restore')
    await activateTaskbarWindow(base, minimized.shell, redId)
    await waitForNativeFocus(base, redId)
    await waitFor(
      'wait for shell restored native state',
      async () => {
        const after = await getJson(base, '/test/state/shell')
        return shellWindowById(after, redId)?.minimized === false ? after : null
      },
      2000,
      50,
    )
  })
})
