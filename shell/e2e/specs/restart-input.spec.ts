import {
  KEY,
  assert,
  clickRect,
  defineGroup,
  getJson,
  postJson,
  restartSession,
  runKeybind,
  waitFor,
  waitForProgramsMenuClosed,
  waitForSessionRestoreIdle,
  writeJsonArtifact,
  type CompositorSnapshot,
  type ShellSnapshot,
} from '../lib/runtime.ts'

export default defineGroup(import.meta.url, ({ test }) => {
  test('restart keeps shell keybind and click input responsive', async ({ base, state }) => {
    await waitForSessionRestoreIdle(base)
    const initialShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    if (initialShell.programs_menu_open) {
      await runKeybind(base, 'toggle_programs_menu')
      await waitForProgramsMenuClosed(base)
    }

    const restartedBase = await restartSession(state)

    await postJson(restartedBase, '/test/input/key', { keycode: 125, action: 'press' })
    const afterSuperPress = await waitFor(
      'wait for launcher stay closed after restart super press',
      async () => {
        const shell = await getJson<ShellSnapshot>(restartedBase, '/test/state/shell')
        return shell.programs_menu_open ? null : shell
      },
      5000,
      100,
    )
    await postJson(restartedBase, '/test/input/key', { keycode: 125, action: 'release' })
    const openedBySuperTap = await waitFor(
      'wait for programs menu open after restart super tap',
      async () => {
        const [shell, compositor] = await Promise.all([
          getJson<ShellSnapshot>(restartedBase, '/test/state/shell'),
          getJson<CompositorSnapshot>(restartedBase, '/test/state/compositor'),
        ])
        return shell.programs_menu_open &&
          shell.controls?.programs_menu_search &&
          (compositor.shell_floating_layers?.length ?? 0) > 0
          ? { shell, compositor }
          : null
      },
      5000,
      100,
    )
    assert(openedBySuperTap.shell.programs_menu_open, 'programs menu should open on first Super tap after restart')
    assert(
      (openedBySuperTap.compositor.shell_floating_layers?.length ?? 0) > 0,
      'programs menu floating layer should reach compositor on first Super tap after restart',
    )
    await postJson(restartedBase, '/test/input/key', { keycode: 125, action: 'press' })
    const whileClosingSuperHeld = await waitFor(
      'wait for launcher stay open while second super press is held',
      async () => {
        const shell = await getJson<ShellSnapshot>(restartedBase, '/test/state/shell')
        return shell.programs_menu_open ? shell : null
      },
      5000,
      100,
    )
    await postJson(restartedBase, '/test/input/key', { keycode: 125, action: 'release' })
    const closedBySecondSuperTap = await waitFor(
      'wait for programs menu close after second super tap',
      async () => {
        const shell = await getJson<ShellSnapshot>(restartedBase, '/test/state/shell')
        return shell.programs_menu_open ? null : shell
      },
      5000,
      100,
    )
    await postJson(restartedBase, '/test/input/key', { keycode: 125, action: 'press' })
    const whileReopeningSuperHeld = await waitFor(
      'wait for launcher stay closed while third super press is held',
      async () => {
        const shell = await getJson<ShellSnapshot>(restartedBase, '/test/state/shell')
        return shell.programs_menu_open ? null : shell
      },
      5000,
      100,
    )
    await postJson(restartedBase, '/test/input/key', { keycode: 125, action: 'release' })
    const reopenedByThirdSuperTap = await waitFor(
      'wait for programs menu reopen after third super tap',
      async () => {
        const shell = await getJson<ShellSnapshot>(restartedBase, '/test/state/shell')
        return shell.programs_menu_open && shell.controls?.programs_menu_search ? shell : null
      },
      5000,
      100,
    )
    await runKeybind(restartedBase, 'toggle_programs_menu')
    await waitForProgramsMenuClosed(restartedBase)

    await waitForSessionRestoreIdle(restartedBase)

    const shellBeforeClick = await getJson<ShellSnapshot>(restartedBase, '/test/state/shell')
    assert(shellBeforeClick.controls?.taskbar_programs_toggle, 'missing programs toggle after restart')
    await clickRect(restartedBase, shellBeforeClick.controls.taskbar_programs_toggle)
    const openedByClick = await waitFor(
      'wait for programs menu open after restart click',
      async () => {
        const shell = await getJson<ShellSnapshot>(restartedBase, '/test/state/shell')
        return shell.programs_menu_open && shell.controls?.programs_menu_search ? shell : null
      },
      5000,
      100,
    )
    assert(openedByClick.programs_menu_open, 'programs menu should open by click after restart')
    await runKeybind(restartedBase, 'toggle_programs_menu')
    await waitForProgramsMenuClosed(restartedBase)

    const compositorBeforeHeldSuperEnter = await getJson<CompositorSnapshot>(restartedBase, '/test/state/compositor')
    const heldSuperEnterBaselineTerminalCount = compositorBeforeHeldSuperEnter.windows.filter(
      (window) => !window.shell_hosted && window.app_id === 'foot' && !window.minimized,
    ).length
    await postJson(restartedBase, '/test/input/key', { keycode: 125, action: 'press' })
    const afterSuperEnterSuperPress = await waitFor(
      'wait for launcher stay closed after restart super enter super press',
      async () => {
        const shell = await getJson<ShellSnapshot>(restartedBase, '/test/state/shell')
        return shell.programs_menu_open ? null : shell
      },
      5000,
      100,
    )
    await postJson(restartedBase, '/test/input/key', { keycode: KEY.enter, action: 'press' })
    const afterSuperEnterPress = await waitFor(
      'wait for launcher stay closed after restart super enter press',
      async () => {
        const shell = await getJson<ShellSnapshot>(restartedBase, '/test/state/shell')
        return shell.programs_menu_open ? null : shell
      },
      5000,
      100,
    )
    await postJson(restartedBase, '/test/input/key', { keycode: KEY.enter, action: 'release' })
    const afterFirstHeldSuperEnter = await waitFor(
      'wait for first held super enter terminal launch',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(restartedBase, '/test/state/compositor')
        const terminalCount = compositor.windows.filter(
          (window) => !window.shell_hosted && window.app_id === 'foot' && !window.minimized,
        ).length
        return terminalCount >= heldSuperEnterBaselineTerminalCount + 1 ? compositor : null
      },
      5000,
      100,
    )
    await postJson(restartedBase, '/test/input/key', { keycode: KEY.enter, action: 'press' })
    const afterRepeatedSuperEnterPress = await waitFor(
      'wait for launcher stay closed after repeated held super enter press',
      async () => {
        const shell = await getJson<ShellSnapshot>(restartedBase, '/test/state/shell')
        return shell.programs_menu_open ? null : shell
      },
      5000,
      100,
    )
    await postJson(restartedBase, '/test/input/key', { keycode: KEY.enter, action: 'release' })
    const afterSecondHeldSuperEnter = await waitFor(
      'wait for second held super enter terminal launch',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(restartedBase, '/test/state/compositor')
        const terminalCount = compositor.windows.filter(
          (window) => !window.shell_hosted && window.app_id === 'foot' && !window.minimized,
        ).length
        return terminalCount >= heldSuperEnterBaselineTerminalCount + 2 ? compositor : null
      },
      5000,
      100,
    )
    await postJson(restartedBase, '/test/input/key', { keycode: 125, action: 'release' })
    const afterSuperEnter = await waitFor(
      'wait for launcher state after restart super enter',
      async () => {
        const shell = await getJson<ShellSnapshot>(restartedBase, '/test/state/shell')
        return shell.programs_menu_open ? null : shell
      },
      5000,
      100,
    )

    await writeJsonArtifact('restart-input-ready.json', {
      super_press_open: afterSuperPress.programs_menu_open,
      super_tap_open: openedBySuperTap.shell.programs_menu_open,
      super_tap_layers: openedBySuperTap.compositor.shell_floating_layers?.length ?? 0,
      second_super_press_open: whileClosingSuperHeld.programs_menu_open,
      second_super_tap_open: closedBySecondSuperTap.programs_menu_open,
      third_super_press_open: whileReopeningSuperHeld.programs_menu_open,
      third_super_tap_open: reopenedByThirdSuperTap.programs_menu_open,
      click_open: openedByClick.programs_menu_open,
      held_super_enter_baseline_terminal_count: heldSuperEnterBaselineTerminalCount,
      super_enter_super_press_open: afterSuperEnterSuperPress.programs_menu_open,
      super_enter_press_open: afterSuperEnterPress.programs_menu_open,
      super_enter_first_terminal_count: afterFirstHeldSuperEnter.windows.filter(
        (window) => !window.shell_hosted && window.app_id === 'foot' && !window.minimized,
      ).length,
      super_enter_second_press_open: afterRepeatedSuperEnterPress.programs_menu_open,
      super_enter_second_terminal_count: afterSecondHeldSuperEnter.windows.filter(
        (window) => !window.shell_hosted && window.app_id === 'foot' && !window.minimized,
      ).length,
      super_enter_open: afterSuperEnter.programs_menu_open,
    })
  })
})
