import {
  KEY,
  assert,
  defineGroup,
  getJson,
  tapKey,
  waitFor,
  waitForProgramsMenuClosed,
  waitForProgramsMenuOpen,
  type ShellSnapshot,
} from '../lib/runtime.ts'

export default defineGroup(import.meta.url, ({ test }) => {
  test('wait helpers observe shell e2e bridge events from real launcher input', async ({ base }) => {
    const before = await getJson<ShellSnapshot>(base, '/test/state/shell')
    if (before.programs_menu_open) {
      await tapKey(base, KEY.escape)
      await waitForProgramsMenuClosed(base)
    }

    await tapKey(base, KEY.super)
    const opened = await waitForProgramsMenuOpen(base)
    assert(opened.programs_menu_open, 'programs menu should open after Super tap')

    await tapKey(base, KEY.escape)
    const closed = await waitForProgramsMenuClosed(base)
    assert(!closed.programs_menu_open, 'programs menu should close after Escape')
  })

  test('generic waitFor resumes on shell mutation events', async ({ base }) => {
    const before = await getJson<ShellSnapshot>(base, '/test/state/shell')
    if (before.programs_menu_open) {
      await tapKey(base, KEY.escape)
      await waitForProgramsMenuClosed(base)
    }

    await tapKey(base, KEY.super)
    const shell = await waitFor(
      'wait for shell bridge mutation launcher open',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.programs_menu_open && next.controls?.programs_menu_panel ? next : null
      },
    )
    assert(shell.controls.programs_menu_panel, 'programs menu panel rect should be reported')

    await tapKey(base, KEY.escape)
    await waitForProgramsMenuClosed(base)
  })
})
