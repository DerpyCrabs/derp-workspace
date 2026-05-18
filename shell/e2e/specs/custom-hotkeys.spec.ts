import {
  KEY,
  SHELL_UI_SETTINGS_WINDOW_ID,
  assert,
  buildNativeSpawnCommand,
  clickRect,
  cleanupNativeWindows,
  defineGroup,
  getJson,
  getShellHtml,
  movePoint,
  openSettings,
  pointerWheel,
  tapSuperShortcut,
  waitFor,
  waitForSpawnedWindow,
  waitForSettingsVisible,
  writeJsonArtifact,
  writeTextArtifact,
  type ShellSnapshot,
} from '../lib/runtime.ts'
import {
  postJson,
} from '../lib/setup.ts'

type HotkeyBinding = {
  id: string
  enabled: boolean
  chord: string
  action: 'builtin' | 'launch' | 'scratchpad'
  builtin: string
  command: string
  desktop_id: string
  app_name: string
  scratchpad_id: string
}

type HotkeySettings = {
  bindings: HotkeyBinding[]
}

async function loadHotkeys(base: string): Promise<HotkeySettings> {
  return getJson<HotkeySettings>(base, '/settings_hotkeys')
}

async function saveHotkeys(base: string, settings: HotkeySettings): Promise<void> {
  await postJson(base, '/settings_hotkeys', settings)
}

async function openKeyboardSettings(base: string): Promise<void> {
  await openSettings(base, 'click')
  await waitFor(
    'wait for keyboard settings page',
    async () => {
      const html = await getShellHtml(base, '[data-settings-root]')
      if (html.includes('data-settings-active-page="keyboard"') && html.includes('data-settings-keyboard-page')) return true
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      if (shell.controls?.settings_tab_keyboard) await clickRect(base, shell.controls.settings_tab_keyboard)
      return null
    },
    5000,
    100,
  )
}

async function scrollToHotkeyActionTrigger(base: string): Promise<ShellSnapshot> {
  let shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const settingsWindow = shell.windows.find((window) => window.window_id === SHELL_UI_SETTINGS_WINDOW_ID)
    assert(settingsWindow, 'missing settings window for hotkey scroll')
    const trigger = shell.controls?.settings_hotkey_cycle_action_trigger ?? shell.controls?.settings_hotkey_action_trigger
    if (trigger) {
      const minY = settingsWindow.y + 140
      const maxY = settingsWindow.y + settingsWindow.height - 180
      if (trigger.global_y >= minY && trigger.global_y + trigger.height <= maxY) return shell
    }
    await movePoint(
      base,
      settingsWindow.x + Math.round(settingsWindow.width * 0.68),
      settingsWindow.y + Math.round(settingsWindow.height * 0.62),
    )
    await pointerWheel(base, 0, 180)
    shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  }
  return shell
}

async function clickScratchpadActionOption(base: string): Promise<void> {
  const option = await waitFor(
    'wait for hotkey action option',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const openOption = shell.controls?.settings_hotkey_action_scratchpad_option
      if (openOption) return openOption
      const trigger = shell.controls?.settings_hotkey_cycle_action_trigger ?? shell.controls?.settings_hotkey_action_trigger
      if (!trigger) return null
      await clickRect(base, trigger)
      const afterClick = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return afterClick.controls?.settings_hotkey_action_scratchpad_option ?? null
    },
    5000,
    100,
  )
  await clickRect(base, option)
}

function launchBinding(id: string, chord: string, command: string): HotkeyBinding {
  return {
    id,
    enabled: true,
    chord,
    action: 'launch',
    builtin: '',
    command,
    desktop_id: '',
    app_name: '',
    scratchpad_id: '',
  }
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('custom hotkey dropdowns respond to pointer selection', async ({ base }) => {
    await openKeyboardSettings(base)
    const ready = await scrollToHotkeyActionTrigger(base)
    assert(ready.controls?.settings_hotkey_cycle_action_trigger ?? ready.controls?.settings_hotkey_action_trigger, 'missing hotkey dropdown trigger')
    await clickScratchpadActionOption(base)
    const scratchpadHtml = await waitFor(
      'wait for scratchpad hotkey editor',
      async () => {
        const html = await getShellHtml(base, '[data-settings-hotkeys]')
        return html.includes('Scratchpad id') ? html : null
      },
      5000,
      100,
    )
    await writeTextArtifact('custom-hotkey-dropdowns.html', scratchpadHtml)
  })

  test('custom Super hotkey launches command', async ({ base, state }) => {
    const original = await loadHotkeys(base)
    const title = `Hotkey Launch ${Date.now()}`
    const command = buildNativeSpawnCommand({
      title,
      token: 'custom-hotkey-launch',
      strip: 'green',
      width: 500,
      height: 320,
    })
    let windowId: number | null = null
    try {
      await saveHotkeys(base, {
        bindings: [...original.bindings, launchBinding('e2e-launch-b', 'Super+B', command)],
      })
      await tapSuperShortcut(base, KEY.b)
      const spawned = await waitForSpawnedWindow(base, state.knownWindowIds, {
        title,
        appId: 'derp.e2e.native',
        command,
      })
      windowId = spawned.window.window_id
      state.spawnedNativeWindowIds.add(windowId)
      await writeJsonArtifact('custom-hotkey-launch.json', spawned.snapshot)
    } finally {
      if (windowId !== null) await cleanupNativeWindows(base, new Set([windowId]))
      await saveHotkeys(base, original)
    }
  })

  test('custom hotkey remaps builtin and rejects conflicts', async ({ base }) => {
    const original = await loadHotkeys(base)
    try {
      const duplicate = await fetch(`${base}/settings_hotkeys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bindings: [
            launchBinding('dup-one', 'Super+B', 'foot'),
            {
              ...launchBinding('dup-two', 'Win+b', 'foot'),
              command: 'foot --title duplicate',
            },
          ],
        }),
      })
      assert(!duplicate.ok, 'duplicate active hotkey save should fail')

      await saveHotkeys(base, {
        bindings: original.bindings.map((binding) =>
          binding.id === 'open-settings' ? { ...binding, chord: 'Super+Y' } : binding,
        ),
      })
      await tapSuperShortcut(base, KEY.comma)
      const shellAfterOld = await getJson<{ settings_window_visible?: boolean }>(base, '/test/state/shell')
      assert(shellAfterOld.settings_window_visible !== true, 'old settings chord should not open settings after remap')
      await tapSuperShortcut(base, KEY.y)
      const opened = await waitForSettingsVisible(base)
      await writeJsonArtifact('custom-hotkey-remap-settings.json', opened.shell)
    } finally {
      await saveHotkeys(base, original)
    }
  })
})
