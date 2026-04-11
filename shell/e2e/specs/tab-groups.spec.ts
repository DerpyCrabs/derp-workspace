import {
  SkipError,
  assert,
  assertTaskbarRowOnMonitor,
  closeWindow,
  compositorWindowById,
  defineGroup,
  ensureNativePair,
  getJson,
  getSnapshots,
  mergeWindowsIntoGroup,
  openShellTestWindow,
  pickMonitorMove,
  runKeybind,
  selectGroupedWindow,
  shellWindowById,
  tabGroupByWindow,
  taskbarEntry,
  waitFor,
  waitForShellUiFocus,
  waitForWindowGone,
  writeJsonArtifact,
  type ShellSnapshot,
} from '../lib/runtime.ts'

export default defineGroup(import.meta.url, ({ test }) => {
  test('js test windows support multi-instance shell fixtures', async ({ base, state }) => {
    const created: number[] = []
    try {
      const first = await openShellTestWindow(base, state)
      const second = await openShellTestWindow(base, state)
      created.push(first.window.window_id, second.window.window_id)
      assert(first.window.window_id !== second.window.window_id, 'expected distinct js test window ids')
      assert(first.window.shell_hosted && second.window.shell_hosted, 'expected shell-hosted js test windows')
      assert(taskbarEntry(first.shell, first.window.window_id), 'missing taskbar row for first js test window')
      assert(taskbarEntry(second.shell, second.window.window_id), 'missing taskbar row for second js test window')
      await writeJsonArtifact('tab-groups-js-test-windows.json', {
        first: first.window,
        second: second.window,
      })
    } finally {
      for (const windowId of created) {
        try {
          await closeWindow(base, windowId)
          await waitForWindowGone(base, windowId)
        } catch {}
      }
    }
  })

  test('taskbar collapses grouped native and js windows into one row', async ({ base, state }) => {
    let jsWindowId: number | null = null
    try {
      const { red } = await ensureNativePair(base, state)
      const jsWindow = await openShellTestWindow(base, state)
      jsWindowId = jsWindow.window.window_id
      await mergeWindowsIntoGroup(base, jsWindow.window.window_id, red.window.window_id)
      const merged = await waitFor(
        'wait for native/js group merge',
        async () => {
          const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
          const group = tabGroupByWindow(shell, red.window.window_id)
          if (!group) return null
          if (!group.member_window_ids.includes(jsWindow.window.window_id)) return null
          const row = taskbarEntry(shell, red.window.window_id)
          if (!row || row.tab_count !== 2) return null
          if (taskbarEntry(shell, jsWindow.window.window_id)) return null
          return { shell, group, row }
        },
        8000,
        125,
      )
      await selectGroupedWindow(base, jsWindow.window.window_id)
      const jsVisible = await waitFor(
        'wait for js tab visible',
        async () => {
          const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
          const group = tabGroupByWindow(shell, jsWindow.window.window_id)
          if (!group || group.visible_window_id !== jsWindow.window.window_id) return null
          const row = taskbarEntry(shell, jsWindow.window.window_id)
          if (!row || row.tab_count !== 2) return null
          return { shell, group, row }
        },
        8000,
        125,
      )
      await writeJsonArtifact('tab-groups-native-js-merged.json', {
        merged,
        jsVisible,
      })
    } finally {
      if (jsWindowId !== null) {
        try {
          await closeWindow(base, jsWindowId)
          await waitForWindowGone(base, jsWindowId)
        } catch {}
      }
    }
  })

  test('active grouped tab can move the group row across monitors', async ({ base, state }) => {
    let jsWindowId: number | null = null
    try {
      const { red } = await ensureNativePair(base, state)
      const jsWindow = await openShellTestWindow(base, state)
      jsWindowId = jsWindow.window.window_id
      const { compositor } = await getSnapshots(base)
      if (compositor.outputs.length < 2) {
        throw new SkipError('requires at least two outputs')
      }
      await selectGroupedWindow(base, jsWindow.window.window_id)
      const jsFocused = await waitForShellUiFocus(base, jsWindow.window.window_id)
      const jsSnapshot = shellWindowById(jsFocused.shell, jsWindow.window.window_id)
      assert(jsSnapshot?.output_name, 'missing js test window output')
      const move = pickMonitorMove(compositor.outputs, jsSnapshot.output_name)
      if (!move) {
        throw new SkipError(`no adjacent monitor from ${jsSnapshot.output_name}`)
      }
      await runKeybind(base, move.action)
      await waitFor(
        'wait for js test window monitor move',
        async () => {
          const { compositor: movedCompositor, shell: movedShell } = await getSnapshots(base)
          const movedWindow = compositorWindowById(movedCompositor, jsWindow.window.window_id)
          const movedShellWindow = shellWindowById(movedShell, jsWindow.window.window_id)
          if (!movedWindow || !movedShellWindow) return null
          if (movedWindow.output_name !== move.target.name || movedShellWindow.output_name !== move.target.name) return null
          assertTaskbarRowOnMonitor(movedShell, jsWindow.window.window_id, move.target.name)
          return { movedCompositor, movedShell, movedWindow }
        },
        8000,
        125,
      )
      await mergeWindowsIntoGroup(base, jsWindow.window.window_id, red.window.window_id)
      await waitFor(
        'wait for grouped windows after monitor move',
        async () => {
          const shellAfterMerge = await getJson<ShellSnapshot>(base, '/test/state/shell')
          const group = tabGroupByWindow(shellAfterMerge, red.window.window_id)
          return group && group.member_window_ids.includes(jsWindow.window.window_id) ? group : null
        },
        8000,
        125,
      )
      await selectGroupedWindow(base, jsWindow.window.window_id)
      const switched = await waitFor(
        'wait for grouped row on js monitor',
        async () => {
          const { compositor: switchedCompositor, shell: switchedShell } = await getSnapshots(base)
          const group = tabGroupByWindow(switchedShell, jsWindow.window.window_id)
          if (!group || group.visible_window_id !== jsWindow.window.window_id) return null
          const movedWindow = compositorWindowById(switchedCompositor, jsWindow.window.window_id)
          if (!movedWindow || movedWindow.output_name !== move.target.name) return null
          assertTaskbarRowOnMonitor(switchedShell, jsWindow.window.window_id, move.target.name)
          return { switchedCompositor, switchedShell, group }
        },
        8000,
        125,
      )
      await writeJsonArtifact('tab-groups-multimonitor-switch.json', switched)
    } finally {
      if (jsWindowId !== null) {
        try {
          await closeWindow(base, jsWindowId)
          await waitForWindowGone(base, jsWindowId)
        } catch {}
      }
    }
  })

  test('closing the active grouped tab promotes the next tab', async ({ base, state }) => {
    let jsAId: number | null = null
    let jsBId: number | null = null
    try {
      const jsA = await openShellTestWindow(base, state)
      const jsB = await openShellTestWindow(base, state)
      jsAId = jsA.window.window_id
      jsBId = jsB.window.window_id
      await mergeWindowsIntoGroup(base, jsB.window.window_id, jsA.window.window_id)
      await waitFor(
        'wait for js pair merged',
        async () => {
          const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
          const group = tabGroupByWindow(shell, jsA.window.window_id)
          return group && group.member_window_ids.includes(jsB.window.window_id) ? group : null
        },
        8000,
        125,
      )
      await selectGroupedWindow(base, jsB.window.window_id)
      await waitFor(
        'wait for jsB active before close',
        async () => {
          const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
          const group = tabGroupByWindow(shell, jsB.window.window_id)
          return group?.visible_window_id === jsB.window.window_id ? group : null
        },
        8000,
        125,
      )
      await closeWindow(base, jsB.window.window_id)
      const promoted = await waitFor(
        'wait for grouped close promotion',
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          if (compositorWindowById(compositor, jsB.window.window_id)) return null
          const group = tabGroupByWindow(shell, jsA.window.window_id)
          if (!group || group.visible_window_id !== jsA.window.window_id) return null
          return { compositor, shell, group }
        },
        8000,
        125,
      )
      await waitForWindowGone(base, jsB.window.window_id)
      jsBId = null
      await writeJsonArtifact('tab-groups-close-promotion.json', promoted)
    } finally {
      for (const windowId of [jsBId, jsAId]) {
        if (windowId === null) continue
        try {
          await closeWindow(base, windowId)
          await waitForWindowGone(base, windowId)
        } catch {}
      }
    }
  })
})
