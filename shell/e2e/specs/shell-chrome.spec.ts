import {
  BTN_LEFT,
  KEY,
  comparePngFixture,
  ensureNativePair,
  RED_NATIVE_TITLE,
  SHELL_UI_SETTINGS_WINDOW_ID,
  activateTaskbarWindow,
  assert,
  assertTopWindow,
  captureScreenshotRect,
  clickPoint,
  clickRect,
  cleanupNativeWindows,
  closeTaskbarWindow,
  copyArtifactFile,
  compositorFloatingLayerContainsPoint,
  compositorFloatingLayerCount,
  compositorFloatingLayers,
  compositorWindowById,
  autoLayoutManagedWindowsOnOutput,
  dragBetweenPoints,
  defineGroup,
  expectedGridAutoLayoutClientRect,
  getPerfCounters,
  getJson,
  getShellHtml,
  getSnapshots,
  keyAction,
  measurePointerInteractionPerf,
  movePoint,
  openDebug,
  openPowerMenu,
  openProgramsMenu,
  openVolumeMenu,
  openSettings,
  openShellTestWindow,
  pointerButton,
  pointerWheel,
  pointInRect,
  rectCenter,
  assertRectMinSize,
  resetPerfCounters,
  shellWindowById,
  spawnNativeWindow,
  taskbarEntry,
  taskbarForMonitor,
  waitForPowerMenuClosed,
  waitForPowerMenuOpen,
  waitForProgramsMenuClosed,
  waitForProgramsMenuOpen,
  waitForVolumeMenuClosed,
  waitFor,
  waitForCompositorShellUiFocus,
  waitForNativeFocus,
  waitForShellUiFocus,
  waitForTaskbarEntry,
  waitForWindowGone,
  windowControls,
  writeJsonArtifact,
  writeTextArtifact,
  type CompositorSnapshot,
  type Rect,
  type ShellSnapshot,
} from '../lib/runtime.ts'
import { openFileBrowserFromLauncher } from '../lib/fileBrowserFixtureNav.ts'

function compositorFrameTitlebar(snapshot: CompositorSnapshot, windowId: number): Rect | null {
  const frame = snapshot.shell_window_frames?.find((entry) => entry.id === windowId)?.global
  return frame ? { x: 0, y: 0, global_x: frame.x, global_y: frame.y, width: frame.width, height: 26 } : null
}

async function waitForProgramsMenuScrollStable(base: string, minimumTop: number) {
  let lastTop = -1
  let lastChangedAt = Date.now()
  await waitFor(
    'wait for programs menu scroll settle',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const metrics = shell.programs_menu_list_scroll
      if (!metrics || !shell.programs_menu_open) return null
      if (metrics.scroll_top < minimumTop) return null
      if (Math.abs(metrics.scroll_top - lastTop) > 1) {
        lastTop = metrics.scroll_top
        lastChangedAt = Date.now()
        return null
      }
      return Date.now() - lastChangedAt >= 75 ? shell : null
    },
    400,
    25,
  )
}

async function waitForPointerIdle(base: string) {
  let lastPointerKey = ''
  let lastChangedAt = Date.now()
  await waitFor(
    'wait for pointer idle',
    async () => {
      const { compositor } = await getSnapshots(base)
      const pointer = compositor.pointer
      if (!pointer) return null
      const nextKey = `${Math.round(pointer.x)}:${Math.round(pointer.y)}`
      if (nextKey !== lastPointerKey) {
        lastPointerKey = nextKey
        lastChangedAt = Date.now()
        return null
      }
      return Date.now() - lastChangedAt >= 75 ? compositor : null
    },
    400,
    25,
  )
}

async function ensureProgramsMenuClosedForFocusTest(base: string) {
  const before = await getJson<ShellSnapshot>(base, '/test/state/shell')
  if (before.programs_menu_open) {
    assert(before.controls?.taskbar_programs_toggle, 'missing programs toggle while closing menu')
    await clickRect(base, before.controls.taskbar_programs_toggle)
    await waitForProgramsMenuClosed(base)
  }
}

async function closeProgramsMenuByTaskbarToggle(base: string, shell: ShellSnapshot) {
  assert(shell.controls?.taskbar_programs_toggle, 'missing programs toggle while menu is open')
  await clickRect(base, shell.controls.taskbar_programs_toggle)
  await waitForProgramsMenuClosed(base)
}

async function captureNativeInteriorScreenshot(base: string, windowId: number, name: string) {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const controls = windowControls(shell, windowId)
  const titlebar = assertRectMinSize(`window ${windowId} titlebar`, controls?.titlebar ?? null, 80, 16)
  const bottomRight = assertRectMinSize(
    `window ${windowId} bottom right resize`,
    controls?.resize_bottom_right ?? null,
    4,
    4,
  )
  const rect = {
    x: titlebar.global_x + 24,
    y: titlebar.global_y + titlebar.height + 24,
    width: Math.max(80, titlebar.width - 48),
    height: Math.max(80, bottomRight.global_y + bottomRight.height - (titlebar.global_y + titlebar.height) - 48),
  }
  const screenshot = await captureScreenshotRect(base, rect)
  return {
    rect,
    path: await copyArtifactFile(`${name}.png`, screenshot.path),
  }
}

async function waitForProgramsMenuOpenWithNativeOwner(
  base: string,
  windowId: number,
  label: string,
  requireNativeKeyboardFocus: boolean,
) {
  return waitFor(
    label,
    async () => {
      const snapshots = await getSnapshots(base)
      if (!snapshots.shell.programs_menu_open) return null
      if (snapshots.shell.focused_window_id !== windowId) return null
      if (snapshots.compositor.shell_keyboard_focus !== true) return null
      if (requireNativeKeyboardFocus && snapshots.compositor.focused_window_id !== windowId) return null
      if (!requireNativeKeyboardFocus && snapshots.compositor.focused_window_id !== null && snapshots.compositor.focused_window_id !== windowId) return null
      return snapshots
    },
    5000,
    100,
  )
}

async function waitForProgramsMenuClosedWithNativeFocus(base: string, windowId: number, label: string) {
  return waitFor(
    label,
    async () => {
      const snapshots = await getSnapshots(base)
      if (snapshots.shell.programs_menu_open) return null
      if (snapshots.compositor.focused_window_id !== windowId) return null
      if (snapshots.shell.focused_window_id !== windowId) return null
      if (snapshots.compositor.shell_keyboard_focus === true) return null
      return snapshots
    },
    5000,
    100,
  )
}

function pointCoveredByShellExclusion(compositor: CompositorSnapshot, point: { x: number; y: number }) {
  return (compositor.shell_exclusion_global ?? []).some(
    (rect) =>
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height,
  )
}

async function waitForSettingsTilingLayoutTriggerReady(base: string) {
  let lastRectKey = ''
  return waitFor(
    'wait for tiling layout trigger ready',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const rect = shell.controls?.settings_tiling_layout_trigger
      if (!rect) return null
      const nextKey = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`
      if (nextKey !== lastRectKey) {
        lastRectKey = nextKey
        return null
      }
      return shell
    },
    5000,
    100,
  )
}

async function pressSuperEnter(base: string) {
  await keyAction(base, 125, 'press')
  await keyAction(base, KEY.enter, 'press')
  await keyAction(base, KEY.enter, 'release')
  await keyAction(base, 125, 'release')
}

async function switchSettingsPage(
  base: string,
  controlKey:
    | 'settings_tab_user'
    | 'settings_tab_displays'
    | 'settings_tab_tiling'
    | 'settings_tab_scratchpads'
    | 'settings_tab_keyboard'
    | 'settings_tab_default_applications',
  pageId: 'user' | 'displays' | 'tiling' | 'scratchpads' | 'keyboard' | 'default-applications',
  marker: string,
): Promise<string> {
  return waitFor(
    `wait for settings ${pageId} page`,
    async () => {
      const html = await getShellHtml(base, '[data-settings-root]')
      if (html.includes(`data-settings-active-page="${pageId}"`) && html.includes(marker)) {
        return html
      }
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const rect = shell.controls?.[controlKey]
      if (rect) await clickRect(base, rect)
      return null
    },
    5000,
    100,
  )
}

async function selectSettingsTilingLayout(base: string, layout: 'grid' | 'manual-snap') {
  await switchSettingsPage(base, 'settings_tab_tiling', 'tiling', 'data-settings-tiling-page')
  const tilingPageReady = await waitForSettingsTilingLayoutTriggerReady(base)
  const optionKey =
    layout === 'grid' ? 'settings_tiling_layout_option_grid' : 'settings_tiling_layout_option_manual_snap'
  if (!tilingPageReady.controls?.[optionKey]) {
    assert(tilingPageReady.controls?.settings_tiling_layout_trigger, 'missing tiling layout trigger')
    await clickRect(base, tilingPageReady.controls.settings_tiling_layout_trigger)
  }
  const tilingLayoutOpen = await waitFor(
    `wait for tiling layout menu option ${layout}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return shell.controls?.[optionKey] ? shell : null
    },
    5000,
    100,
  )
  await clickRect(base, tilingLayoutOpen.controls![optionKey]!)
  await waitFor(
    `wait for tiling layout set to ${layout}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const settingsWindow = shellWindowById(shell, SHELL_UI_SETTINGS_WINDOW_ID)
      const monitorName = settingsWindow?.output_name
      const sessionSnapshot = shell.session_snapshot as
        | {
            tilingConfig?: {
              monitors?: Record<string, { layout?: string | null } | null> | null
            } | null
          }
        | null
      if (!monitorName) return null
      const nextLayout = sessionSnapshot?.tilingConfig?.monitors?.[monitorName]?.layout
      return nextLayout === layout ? shell : null
    },
    5000,
    100,
  )
}

function bodyClickPoint(
  target: { x: number; y: number; width: number; height: number },
  other: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  const insetX = Math.min(16, Math.max(8, Math.floor(target.width / 18)))
  const insetY = Math.min(16, Math.max(8, Math.floor(target.height / 18)))
  const otherRect: Rect = {
    x: other.x,
    y: other.y,
    global_x: other.x,
    global_y: other.y,
    width: other.width,
    height: other.height,
  }
  const candidates = [
    { x: target.x + insetX, y: target.y + insetY },
    { x: target.x + insetX, y: target.y + Math.floor(target.height / 2) },
    { x: target.x + Math.floor(target.width / 2), y: target.y + insetY },
    { x: target.x + target.width - insetX, y: target.y + insetY },
    { x: target.x + target.width - insetX, y: target.y + Math.floor(target.height / 2) },
    { x: target.x + insetX, y: target.y + target.height - insetY },
    { x: target.x + Math.floor(target.width / 2), y: target.y + target.height - insetY },
    { x: target.x + target.width - insetX, y: target.y + target.height - insetY },
  ]
  for (const candidate of candidates) {
    if (!pointInRect(otherRect, candidate)) return candidate
  }
  return { x: target.x + Math.floor(target.width / 2), y: target.y + Math.floor(target.height / 2) }
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('bootstrap snapshots and launcher catalog', async ({ base, state }) => {
    const { compositor, shell } = await getSnapshots(base)
    assert(Array.isArray(compositor.windows), 'compositor snapshot missing windows array')
    assert(Array.isArray(shell.windows), 'shell snapshot missing windows array')
    assert(shell.controls?.taskbar_settings_toggle, 'shell snapshot missing settings toggle')
    assert(shell.controls?.taskbar_programs_toggle, 'shell snapshot missing programs toggle')
    assert(shell.menu_layer_host_connected === true, 'shell snapshot missing menu layer host')
    state.knownWindowIds = new Set(compositor.windows.map((window) => window.window_id))
    const desktopApplications = await getJson<{ apps?: typeof state.desktopApps }>(base, '/desktop_applications')
    const apps = Array.isArray(desktopApplications?.apps) ? desktopApplications.apps : []
    state.desktopApps = apps
    await writeJsonArtifact('bootstrap-compositor.json', compositor)
    await writeJsonArtifact('bootstrap-shell.json', shell)
    await writeJsonArtifact('desktop-applications.json', desktopApplications)
  })

  test('volume and power menus mount portaled panels with visible geometry', async ({ base }) => {
    const vol = await openVolumeMenu(base)
    assert(vol.volume_menu_open, 'volume menu should be open')
    assert(vol.menu_layer_host_connected === true, 'menu layer host connected with volume open')
    assert(vol.overlay_menu_dom?.host_connected, 'overlay_menu_dom.host_connected volume')
    assert(vol.overlay_menu_dom?.volume_panel_dom, 'volume panel must exist in DOM')
    assert(vol.controls?.volume_menu_panel, 'volume_menu_panel control rect')
    assertRectMinSize('volume_menu_panel', vol.controls.volume_menu_panel, 32, 32)
    assert(
      typeof vol.menu_layer_host_z_index === 'number' && vol.menu_layer_host_z_index > 400000,
      'menu layer z-index above shell surface while volume open',
    )
    assert(vol.menu_portal_hit_test?.hit_ok === true, 'volume panel center hit resolves under menu layer host')
    assert(
      vol.menu_portal_hit_test?.tray_flap_above_toggle === true,
      'volume menu geometry clears taskbar toggle (opens upward)',
    )
    assert(vol.controls.taskbar_volume_toggle, 'taskbar volume toggle for dismiss')
    await clickRect(base, vol.controls.taskbar_volume_toggle)
    await waitForVolumeMenuClosed(base)
    const pow = await openPowerMenu(base)
    assert(pow.power_menu_open, 'power menu should be open')
    assert(pow.menu_layer_host_connected === true, 'menu layer host connected with power open')
    assert(pow.overlay_menu_dom?.power_menu_dom, 'power menu must exist in DOM')
    assert(pow.controls?.power_menu_save_session, 'power_menu_save_session rect')
    assertRectMinSize('power_menu_save_session', pow.controls.power_menu_save_session, 8, 8)
    assert(
      typeof pow.menu_layer_host_z_index === 'number' && pow.menu_layer_host_z_index > 400000,
      'menu layer z-index above shell surface while power open',
    )
    assert(pow.menu_portal_hit_test?.hit_ok === true, 'power panel center hit resolves under menu layer host')
    assert(
      pow.menu_portal_hit_test?.tray_flap_above_toggle === true,
      'power menu geometry clears taskbar toggle (opens upward)',
    )
    assert(pow.controls.taskbar_power_toggle, 'taskbar power toggle for dismiss')
    await clickRect(base, pow.controls.taskbar_power_toggle)
    await waitForPowerMenuClosed(base)
  })

  test('programs portaled menu hit-tests inside menu layer host', async ({ base, state }) => {
    assert(state.desktopApps.length >= 1, `need desktop apps, got ${state.desktopApps.length}`)
    const opened = await openProgramsMenu(base, 'click')
    assert(opened.programs_menu_open, 'programs menu should be open')
    assert(
      typeof opened.menu_layer_host_z_index === 'number' && opened.menu_layer_host_z_index > 400000,
      'menu layer z-index above shell surface while programs menu open',
    )
    assert(opened.menu_portal_hit_test?.hit_ok === true, 'programs panel center hit resolves under menu layer host')
    assert(
      opened.menu_portal_hit_test?.tray_flap_above_toggle === null,
      'programs launcher is not a tray flap menu',
    )
    await closeProgramsMenuByTaskbarToggle(base, opened)
  })

  test('super tap toggles programs menu after pointer movement while held', async ({ base }) => {
    const before = await getJson<ShellSnapshot>(base, '/test/state/shell')
    if (before.programs_menu_open) {
      await closeProgramsMenuByTaskbarToggle(base, before)
    }
    const { compositor } = await getSnapshots(base)
    const output = compositor.outputs[0]
    assert(output, 'expected at least one output')
    const start = {
      x: output.x + Math.floor(output.width / 2),
      y: output.y + Math.min(96, Math.max(48, Math.floor(output.height / 5))),
    }
    await movePoint(base, start.x, start.y)
    await keyAction(base, 125, 'press')
    await movePoint(base, start.x + 18, start.y + 14)
    await keyAction(base, 125, 'release')
    const opened = await waitForProgramsMenuOpen(base)
    assert(opened.programs_menu_open, 'programs menu should open after moved Super tap')
    await keyAction(base, 125, 'press')
    await movePoint(base, start.x + 32, start.y + 22)
    await keyAction(base, 125, 'release')
    await waitForProgramsMenuClosed(base)
  })

  test('programs menu super toggle preserves focused native window when dismissed', async ({ base, state }) => {
    await ensureProgramsMenuClosedForFocusTest(base)
    const stamp = Date.now()
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Launcher Focus ${stamp}`,
      token: `launcher-focus-${stamp}`,
      strip: 'red',
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    const windowId = spawned.window.window_id
    await waitForNativeFocus(base, windowId)

    await keyAction(base, 125, 'tap')
    const opened = await waitForProgramsMenuOpenWithNativeOwner(
      base,
      windowId,
      'wait for programs menu open without native focus loss',
      true,
    )
    assert(opened.compositor.shell_keyboard_focus === true, 'programs menu should capture shell keyboard while native focus is preserved logically')

    await keyAction(base, 125, 'tap')
    const closed = await waitForProgramsMenuClosedWithNativeFocus(
      base,
      windowId,
      'wait for programs menu close without native focus loss',
    )
    assert(closed.compositor.focused_window_id === windowId, 'native window should remain focused after closing programs menu')
  })

  test('programs menu click open restores focused native window when dismissed by super', async ({ base, state }) => {
    await ensureProgramsMenuClosedForFocusTest(base)
    const stamp = Date.now()
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Launcher Click Focus ${stamp}`,
      token: `launcher-click-focus-${stamp}`,
      strip: 'green',
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    const windowId = spawned.window.window_id
    await waitForNativeFocus(base, windowId)

    await openProgramsMenu(base, 'click')
    const opened = await waitForProgramsMenuOpenWithNativeOwner(
      base,
      windowId,
      'wait for click-opened programs menu to keep native logical owner',
      false,
    )
    assert(opened.shell.focused_window_id === windowId, 'shell logical focus should stay on native window while programs menu is open')

    await keyAction(base, 125, 'tap')
    const closed = await waitForProgramsMenuClosedWithNativeFocus(
      base,
      windowId,
      'wait for click-opened programs menu dismissal to restore native focus',
    )
    assert(closed.compositor.focused_window_id === windowId, 'native window should regain keyboard focus after click-opened programs menu closes')
  })

  test('closing programs menu immediately restores native content under its old exclusion', async ({ base, state }) => {
    await ensureProgramsMenuClosedForFocusTest(base)
    const stamp = Date.now()
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Launcher Content ${stamp}`,
      token: `launcher-content-${stamp}`,
      strip: '#15803d',
      width: 900,
      height: 620,
    })
    state.spawnedNativeWindowIds.add(spawned.window.window_id)
    const windowId = spawned.window.window_id
    await waitForNativeFocus(base, windowId)
    const before = await captureNativeInteriorScreenshot(base, windowId, 'programs-menu-native-content-before')
    const opened = await openProgramsMenu(base, 'click')
    assert(opened.programs_menu_open, 'programs menu should open over native content')
    await closeProgramsMenuByTaskbarToggle(base, opened)
    await waitForProgramsMenuClosed(base)
    const closed = await waitFor(
      'wait for compositor menu exclusion cleared before native content capture',
      async () => {
        const snapshots = await getSnapshots(base)
        if (snapshots.shell.programs_menu_open) return null
        if (snapshots.compositor.shell_context_menu_visible) return null
        if ((snapshots.compositor.shell_floating_layers ?? []).length > 0) return null
        return snapshots
      },
      5000,
      100,
    )
    assert(!closed.compositor.shell_context_menu_visible, 'compositor should not keep stale context menu visible after close')
    const after = await captureNativeInteriorScreenshot(base, windowId, 'programs-menu-native-content-after')
    const comparison = await comparePngFixture(after.path, before.path, {
      maxDifferentPixels: 32,
      maxChannelDelta: 8,
    })
    await writeJsonArtifact('programs-menu-native-content-restore.json', {
      windowId,
      before,
      after,
      comparison,
      closedCompositor: closed.compositor,
    })
  })

  test('programs menu closes with one super tap after shell titlebar drag without stealing focus', async ({ base, state }) => {
    await ensureProgramsMenuClosedForFocusTest(base)
    const opened = await openShellTestWindow(base, state)
    const windowId = opened.window.window_id
    await waitForShellUiFocus(base, windowId)
    const titlebar = await waitFor(
      'wait for shell titlebar before menu close after drag',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const rect = windowControls(shell, windowId)?.titlebar
        return rect && rect.width >= 80 && rect.height >= 16 ? rect : null
      },
      5000,
      100,
    )
    const start = rectCenter(titlebar)
    await dragBetweenPoints(base, start.x, start.y, start.x + 180, start.y + 80, 18)
    await waitFor(
      'wait for shell drag settled before menu close regression',
      async () => {
        const snapshots = await getSnapshots(base)
        const controls = windowControls(snapshots.shell, windowId)
        if (snapshots.compositor.shell_move_window_id !== null) return null
        if (snapshots.compositor.shell_resize_window_id !== null) return null
        if (snapshots.compositor.shell_pointer_grab_window_id !== null) return null
        if (snapshots.compositor.pointer_pressed_button_count !== 0) return null
        if (!controls || controls.dragging) return null
        if (snapshots.shell.focused_window_id !== windowId) return null
        if (snapshots.compositor.focused_shell_ui_window_id !== windowId) return null
        return snapshots
      },
      5000,
      100,
    )

    const measured = await measurePointerInteractionPerf(
      base,
      'post-drag programs menu super close',
      async () => {
        await keyAction(base, 125, 'tap')
        const openedBySuper = await waitFor(
          'wait for post-drag programs menu open with shell focus retained',
          async () => {
            const snapshots = await getSnapshots(base)
            if (!snapshots.shell.programs_menu_open) return null
            if (snapshots.shell.focused_window_id !== windowId) return null
            if (snapshots.compositor.focused_shell_ui_window_id !== windowId) return null
            assertTopWindow(snapshots.shell, windowId, 'programs menu open should not raise another shell window')
            return snapshots
          },
          5000,
          100,
        )
        await keyAction(base, 125, 'tap')
        return openedBySuper
      },
      {
        afterInteraction: () =>
          waitFor(
            'wait for post-drag programs menu closed by single super tap',
            async () => {
              const snapshots = await getSnapshots(base)
              if (snapshots.shell.programs_menu_open) return null
              if (snapshots.shell.focused_window_id !== windowId) return null
              if (snapshots.compositor.focused_shell_ui_window_id !== windowId) return null
              assertTopWindow(snapshots.shell, windowId, 'programs menu close should keep dragged shell window focused')
              return snapshots
            },
            5000,
            100,
          ),
        budget: {
          sharedStateUiWindowWrites: 8,
          sharedStateExclusionWrites: 8,
          fullWindowListReplies: 2,
          snapshotDirtyFallbacks: 0,
        },
      },
    )

    await writeJsonArtifact('programs-menu-super-close-after-drag.json', {
      openedBySuper: measured.result,
      closedBySuper: measured.after,
      perf: measured.sample,
    })
  })

  test('programs menu list scrolls with pointer wheel over launcher', async ({ base, state }) => {
    assert(state.desktopApps.length >= 6, `need desktop apps for launcher scroll test, got ${state.desktopApps.length}`)
    const opened = await openProgramsMenu(base, 'click')
    assert(opened.programs_menu_open, 'programs menu should be open')
    const metrics0 = opened.programs_menu_list_scroll
    assert(metrics0, 'missing programs_menu_list_scroll')
    assert(
      metrics0.scroll_height > metrics0.client_height + 32,
      `expected programs list overflow for wheel test (scroll_height ${metrics0.scroll_height} client_height ${metrics0.client_height})`,
    )
    const menuG = await waitFor(
      'compositor shell_context_menu_global while programs menu open',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        if (!shell.programs_menu_open) return null
        const g = compositor.shell_context_menu_global
        if (!g || g.width <= 0 || g.height <= 0) return null
        return g
      },
      3000,
      50,
    )
    const menuAsRect: Rect = {
      x: 0,
      y: 0,
      global_x: menuG.x,
      global_y: menuG.y,
      width: menuG.width,
      height: menuG.height,
    }
    const list = await waitFor(
      'programs menu list control rect',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const l = shell.controls?.programs_menu_list
        if (!shell.programs_menu_open || !l || l.width < 32 || l.height < 32) return null
        return l
      },
      3000,
      50,
    )
    assertRectMinSize('programs_menu_list', list, 32, 32)
    const aim = rectCenter(list)
    await movePoint(base, aim.x, aim.y)
    const { compositor: comp2, shell: shell2 } = await getSnapshots(base)
    const pt = comp2.pointer
    assert(pt && Number.isFinite(pt.x) && Number.isFinite(pt.y), 'compositor snapshot missing pointer')
    assert(
      pointInRect(menuAsRect, pt),
      `pointer ${pt.x},${pt.y} should be inside compositor shell_context_menu_global (x=${menuG.x} y=${menuG.y} w=${menuG.width} h=${menuG.height}; moved to ${aim.x},${aim.y})`,
    )
    assert(shell2.programs_menu_open, 'programs menu should stay open')
    const beforeTop = metrics0.scroll_top
    await pointerWheel(base, 0, 200)
    await pointerWheel(base, 0, 200)
    const scrolledDown = await waitFor(
      'programs menu scroll increases after wheel',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const m = shell.programs_menu_list_scroll
        if (!m || !shell.programs_menu_open) return null
        if (m.scroll_top > beforeTop + 8) return shell
        return null
      },
      4000,
      40,
    )
    const peak = scrolledDown.programs_menu_list_scroll?.scroll_top
    assert(peak !== undefined && peak > beforeTop + 8, 'expected scroll_top after wheel down')
    await waitForProgramsMenuScrollStable(base, peak - 1)
    await pointerWheel(base, 0, -200)
    await pointerWheel(base, 0, -200)
    await waitFor(
      'programs menu scroll decreases after wheel up',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const m = shell.programs_menu_list_scroll
        if (!m || !shell.programs_menu_open) return null
        if (m.scroll_top < peak - 8) return shell
        return null
      },
      4000,
      40,
    )
    await closeProgramsMenuByTaskbarToggle(base, await getJson<ShellSnapshot>(base, '/test/state/shell'))
  })

  test('settings window opens from taskbar, switches tabs, and reopens from keybind', async ({ base }) => {
    const settingsOpen = await openSettings(base, 'click')
    assert(settingsOpen.shell.controls?.settings_tab_user, 'missing settings user tab rect')
    assert(settingsOpen.shell.controls?.settings_tab_tiling, 'missing settings tiling tab rect')
    assert(settingsOpen.shell.controls?.settings_tab_scratchpads, 'missing settings scratchpads tab rect')
    assert(settingsOpen.shell.controls?.settings_tab_displays, 'missing settings displays tab rect')
    assert(settingsOpen.shell.controls?.settings_tab_keyboard, 'missing settings keyboard tab rect')
    assert(settingsOpen.shell.controls?.settings_tab_default_applications, 'missing default applications tab rect')
    await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    await clickRect(base, settingsOpen.shell.controls.settings_tab_user)
    const userHtml = await switchSettingsPage(base, 'settings_tab_user', 'user', 'data-settings-user-page')
    const keyboardHtml = await switchSettingsPage(
      base,
      'settings_tab_keyboard',
      'keyboard',
      'Apply keyboard settings',
    )
    await waitFor(
      'wait for settings tiling page',
      async () => {
        const html = await getShellHtml(base, '[data-settings-tiling-page]')
        if (html.includes('Per-monitor layout')) return html
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const rect = shell.controls?.settings_tab_tiling
        if (rect) await clickRect(base, rect)
        return null
      },
      5000,
      100,
    )
    const tilingPageReady = await waitForSettingsTilingLayoutTriggerReady(base)
    assert(tilingPageReady.controls?.settings_tiling_layout_trigger, 'missing tiling layout trigger')
    await clickRect(base, tilingPageReady.controls.settings_tiling_layout_trigger)
    const tilingLayoutOpen = await waitFor(
      'wait for tiling layout menu open',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return shell.controls?.settings_tiling_layout_option_grid ? shell : null
      },
      5000,
      100,
    )
    assert(tilingLayoutOpen.controls?.settings_tiling_layout_option_grid, 'missing tiling layout grid option')
    await clickRect(base, tilingLayoutOpen.controls.settings_tiling_layout_option_grid)
    const tilingGridHtml = await waitFor(
      'wait for tiling layout set to grid',
      async () => {
        const html = await getShellHtml(base, '[data-settings-tiling-page]')
        return html.includes('grid') ? html : null
      },
      5000,
      100,
    )
    const tilingGridShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assert(
      !tilingGridShell.controls?.settings_tiling_layout_option_grid,
      'tiling layout menu should close after selecting grid',
    )
    await clickRect(base, tilingGridShell.controls!.settings_tiling_layout_trigger!)
    const tilingManualOpen = await waitFor(
      'wait for tiling layout manual snap option',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return shell.controls?.settings_tiling_layout_option_manual_snap ? shell : null
      },
      5000,
      100,
    )
    await clickRect(base, tilingManualOpen.controls!.settings_tiling_layout_option_manual_snap!)
    await waitFor(
      'wait for tiling layout restored to manual snap',
      async () => {
        const html = await getShellHtml(base, '[data-settings-tiling-page]')
        return html.includes('manual-snap') ? html : null
      },
      5000,
      100,
    )
    const defaultAppsHtml = await switchSettingsPage(
      base,
      'settings_tab_default_applications',
      'default-applications',
      'data-settings-default-applications',
    )
    assert(defaultAppsHtml.includes('Image Viewer'), 'expected shell image viewer default option')
    assert(defaultAppsHtml.includes('Text Editor'), 'expected shell text editor default option')
    const scratchpadsHtml = await switchSettingsPage(
      base,
      'settings_tab_scratchpads',
      'scratchpads',
      'data-settings-scratchpads-page',
    )
    assert(scratchpadsHtml.includes('Apply scratchpads'), 'expected scratchpad apply action')
    assert(scratchpadsHtml.includes('Open windows'), 'expected scratchpad open windows inspector')
    assert(scratchpadsHtml.includes('app_id'), 'expected app_id rule field in scratchpad inspector')
    assert(scratchpadsHtml.includes('kind'), 'expected kind rule field in scratchpad inspector')
    const scratchpadsShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const settingsWindow = shellWindowById(scratchpadsShell, SHELL_UI_SETTINGS_WINDOW_ID)
    const scratchpadsPage = scratchpadsShell.controls?.settings_scratchpads_page
    const scratchpadInspector = scratchpadsShell.controls?.settings_scratchpad_window_inspector
    const scratchpadList = scratchpadsShell.controls?.settings_scratchpad_list
    const scratchpadSave = scratchpadsShell.controls?.settings_scratchpad_save
    assert(settingsWindow, 'missing settings window for scratchpad geometry')
    assertRectMinSize('settings_scratchpads_page', scratchpadsPage, 120, 120)
    assertRectMinSize('settings_scratchpad_window_inspector', scratchpadInspector, 120, 24)
    assertRectMinSize('settings_scratchpad_list', scratchpadList, 120, 120)
    assertRectMinSize('settings_scratchpad_save', scratchpadSave, 24, 18)
    assert(
      scratchpadsPage!.height >= settingsWindow.height - 40,
      `scratchpad page should fill settings height (page ${scratchpadsPage!.height}, window ${settingsWindow.height})`,
    )
    assert(
      scratchpadSave!.global_y + scratchpadSave!.height >= settingsWindow.y + settingsWindow.height - 18,
      'scratchpad save action should sit near the bottom of the settings pane',
    )
    const settingsHtml = await switchSettingsPage(
      base,
      'settings_tab_displays',
      'displays',
      'data-settings-displays-page',
    )
    const keyboardSettings = await getJson(base, '/settings_keyboard')
    const userSettings = await getJson(base, '/settings_user')
    const defaultApplicationSettings = await getJson(base, '/settings_default_applications')
    await writeTextArtifact('settings-root.html', settingsHtml)
    await writeTextArtifact('settings-user-page.html', userHtml)
    await writeTextArtifact('settings-keyboard-page.html', keyboardHtml)
    await writeTextArtifact('settings-tiling-grid-page.html', tilingGridHtml)
    await writeTextArtifact('settings-scratchpads-page.html', scratchpadsHtml)
    await writeTextArtifact('settings-default-applications-page.html', defaultAppsHtml)
    await writeJsonArtifact('settings-keyboard.json', keyboardSettings)
    await writeJsonArtifact('settings-user.json', userSettings)
    await writeJsonArtifact('settings-default-applications.json', defaultApplicationSettings)
    const shellBeforeClose = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await closeTaskbarWindow(base, shellBeforeClose, SHELL_UI_SETTINGS_WINDOW_ID)
    await waitForWindowGone(base, SHELL_UI_SETTINGS_WINDOW_ID)
    await openSettings(base, 'keybind')
    const settingsFocused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    assertTopWindow(settingsFocused.shell, SHELL_UI_SETTINGS_WINDOW_ID, 'settings reopen')
    await writeJsonArtifact('settings-shell.json', settingsFocused.shell)
  })

  test('tiling layout persistence can be mutated within a test', async ({ base }) => {
    await openSettings(base, 'click')
    await selectSettingsTilingLayout(base, 'grid')
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const settingsWindow = shellWindowById(shell, SHELL_UI_SETTINGS_WINDOW_ID)
    const monitorName = settingsWindow?.output_name
    const sessionSnapshot = shell.session_snapshot as
      | {
          tilingConfig?: {
            monitors?: Record<string, { layout?: string | null } | null> | null
          } | null
        }
      | null
    assert(monitorName, 'missing settings monitor name after tiling config mutation')
    assert(
      sessionSnapshot?.tilingConfig?.monitors?.[monitorName]?.layout === 'grid',
      'expected grid tiling layout to persist during the test',
    )
  })

  test('prime state clears persisted tiling config before the next test', async ({ base }) => {
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const sessionSnapshot = shell.session_snapshot as
      | {
          tilingConfig?: {
            monitors?: Record<string, unknown> | null
          } | null
        }
      | null
    assert(sessionSnapshot, 'missing session snapshot after prime state')
    assert(
      Object.keys(sessionSnapshot.tilingConfig?.monitors ?? {}).length === 0,
      'expected prime state to clear persisted tiling config',
    )
  })

  test('focused shell window close button keeps native windows open', async ({ base }) => {
    const before = await getSnapshots(base)
    const knownIds = new Set(before.compositor.windows.map((w) => w.window_id))
    await pressSuperEnter(base)
    const terminal = await waitFor(
      'wait for foot from super enter',
      async () => {
        const { compositor } = await getSnapshots(base)
        return (
          compositor.windows.find(
            (e) => !e.shell_hosted && !knownIds.has(e.window_id) && e.app_id === 'foot',
          ) ?? null
        )
      },
      5000,
      100,
    )
    assert(terminal, 'expected foot')
    await waitForNativeFocus(base, terminal.window_id)
    await openSettings(base, 'click')
    const focused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const close = assertRectMinSize(
      'settings close button with native window present',
      windowControls(focused.shell, SHELL_UI_SETTINGS_WINDOW_ID)?.close,
      12,
    )
    await clickRect(base, close)
    await waitForWindowGone(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const after = await getSnapshots(base)
    assert(
      after.compositor.windows.some((w) => w.window_id === terminal.window_id),
      'native foot should stay open when closing focused shell window',
    )
    await cleanupNativeWindows(base, new Set([terminal.window_id]))
  })

  test('super enter launches terminal without opening programs menu', async ({ base }) => {
    const before = await getSnapshots(base)
    const knownWindowIds = new Set(before.compositor.windows.map((window) => window.window_id))
    await pressSuperEnter(base)
    const launched = await waitFor(
      'wait for super enter terminal launch',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        if (shell.programs_menu_open) return null
        const window = compositor.windows.find(
          (entry) => !entry.shell_hosted && !knownWindowIds.has(entry.window_id) && entry.app_id === 'foot',
        )
        return window ? { compositor, shell, window } : null
      },
      5000,
      100,
    )
    await writeJsonArtifact('super-enter-terminal.json', {
      before: {
        programs_menu_open: before.shell.programs_menu_open,
        window_ids: [...knownWindowIds],
      },
      after: {
        programs_menu_open: launched.shell.programs_menu_open,
        window_id: launched.window.window_id,
        app_id: launched.window.app_id,
        title: launched.window.title,
      },
    })
    await cleanupNativeWindows(base, new Set([launched.window.window_id]))
  })

  test('taskbar settings wakes cleanly after idle pointer move', async ({ base }) => {
    const idleProbe = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assert(!idleProbe.session_restore_active, 'expected session restore inactive before taskbar idle wake test')
    const initialShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    if (initialShell.settings_window_visible) {
      await closeTaskbarWindow(base, initialShell, SHELL_UI_SETTINGS_WINDOW_ID)
      await waitForWindowGone(base, SHELL_UI_SETTINGS_WINDOW_ID)
    }
    const idleShell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const toggle = idleShell.controls?.taskbar_settings_toggle
    assert(toggle, 'missing taskbar settings toggle before idle wake test')
    const target = {
      x: toggle.global_x + toggle.width / 2,
      y: toggle.global_y + toggle.height / 2,
    }
    await waitForPointerIdle(base)
    await movePoint(base, target.x, target.y)
    const awake = await waitFor(
      'pointer reaches taskbar settings after idle move',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const currentToggle = shell.controls?.taskbar_settings_toggle
        const pointer = compositor.pointer
        if (!currentToggle || !pointer || !pointInRect(currentToggle, pointer)) return null
        return { compositor, shell }
      },
      1500,
      50,
    )
    await clickRect(base, awake.shell.controls!.taskbar_settings_toggle!)
    const focused = await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID, 1500)
    await writeJsonArtifact('settings-idle-pointer-wake.json', {
      compositor: focused.compositor,
      shell: focused.shell,
    })
    await closeTaskbarWindow(base, focused.shell, SHELL_UI_SETTINGS_WINDOW_ID)
    await waitForWindowGone(base, SHELL_UI_SETTINGS_WINDOW_ID)
  })

  test('debug window opens and toggles crosshair state', async ({ base }) => {
    const debugOpen = await openDebug(base)
    assert(debugOpen.shell.controls?.debug_crosshair_toggle, 'missing debug crosshair toggle rect')
    assert(debugOpen.shell.controls?.debug_reload_button, 'missing debug reload button rect')
    assert(debugOpen.shell.controls?.debug_copy_snapshot_button, 'missing debug copy snapshot button rect')
    const debugHtml = await getShellHtml(base, '[data-shell-debug-root]')
    assert(debugHtml.includes('Reload shell'), 'debug html missing reload button')
    assert(debugHtml.includes('Copy snapshot'), 'debug html missing copy snapshot button')
    assert(debugHtml.includes('Crosshair'), 'debug html missing crosshair control')
    await clickRect(base, debugOpen.shell.controls.debug_crosshair_toggle)
    const crosshairOn = await waitFor(
      'wait for debug crosshair on',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return shell.crosshair_cursor === true ? shell : null
      },
      5000,
      100,
    )
    assert(crosshairOn.controls.debug_crosshair_toggle, 'missing debug crosshair toggle rect after enabling')
    await clickRect(base, crosshairOn.controls.debug_crosshair_toggle)
    const crosshairOff = await waitFor(
      'wait for debug crosshair off',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return shell.crosshair_cursor === false ? shell : null
      },
      5000,
      100,
    )
    await writeJsonArtifact('debug-shell.json', crosshairOff)
  })

  test('js windows raise to front when clicking content', async ({ base, state }) => {
    const first = await openShellTestWindow(base, state)
    const second = await openShellTestWindow(base, state)
    const firstId = first.window.window_id
    const secondId = second.window.window_id

    const secondFocused = await waitForShellUiFocus(base, secondId)
    assertTopWindow(secondFocused.shell, secondId, 'second js window should open frontmost')

    const firstWindow = compositorWindowById(secondFocused.compositor, firstId)
    const secondWindow = compositorWindowById(secondFocused.compositor, secondId)
    assert(firstWindow, 'missing first js compositor window')
    assert(secondWindow, 'missing second js compositor window')

    const firstPoint = bodyClickPoint(firstWindow, secondWindow)
    await clickPoint(base, firstPoint.x, firstPoint.y)
    const firstFocused = await waitForShellUiFocus(base, firstId)
    assertTopWindow(firstFocused.shell, firstId, 'first js window content click should bring it frontmost')

    const secondPoint = bodyClickPoint(secondWindow, firstWindow)
    await clickPoint(base, secondPoint.x, secondPoint.y)
    const refocusedSecond = await waitForShellUiFocus(base, secondId)
    assertTopWindow(refocusedSecond.shell, secondId, 'second js window content click should bring it frontmost')

    await writeJsonArtifact('js-content-click-focus.json', {
      firstId,
      secondId,
      firstPoint,
      secondPoint,
      firstFocused: firstFocused.shell,
      refocusedSecond: refocusedSecond.shell,
    })
  })

  test('maximized shell window titlebar drag restores under pointer', async ({ base, state }) => {
    const opened = await openShellTestWindow(base, state)
    const windowId = opened.window.window_id
    const focused = await waitForShellUiFocus(base, windowId)
    const maximize = assertRectMinSize(
      'shell test maximize button before titlebar drag',
      windowControls(focused.shell, windowId)?.maximize,
      12,
    )
    await clickRect(base, maximize)
    const maximized = await waitFor(
      'wait for shell test maximized',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, windowId)
        return window?.maximized ? { compositor, window } : null
      },
      5000,
      100,
    )
    const shellMax = await waitFor(
      'wait for shell test maximized titlebar',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const window = shellWindowById(shell, windowId)
        const controls = windowControls(shell, windowId)
        if (!window?.maximized || !controls?.titlebar) return null
        return { titlebar: controls.titlebar }
      },
      5000,
      100,
    )
    const start = rectCenter(shellMax.titlebar)
    await dragBetweenPoints(base, start.x, start.y, start.x, start.y + 160, 18)
    const restored = await waitFor(
      'wait for shell test unmaximized after titlebar drag',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositorWindowById(compositor, windowId)
        if (!window || window.maximized || window.fullscreen || window.minimized) return null
        if (window.width >= maximized.window.width - 24 && window.height >= maximized.window.height - 120) return null
        return { window }
      },
      5000,
      100,
    )
    const centerX = restored.window.x + restored.window.width / 2
    assert(
      Math.abs(centerX - start.x) < 220,
      `restored shell window center x ${centerX} should stay near titlebar grab ${start.x}`,
    )
    await writeJsonArtifact('shell-max-titlebar-drag-unmax.json', {
      windowId,
      grab: { x: start.x, y: start.y },
      after: {
        x: restored.window.x,
        y: restored.window.y,
        w: restored.window.width,
        h: restored.window.height,
        output: restored.window.output_name,
        centerX,
      },
    })
  })

  test('super taps alternate programs menu open and closed after completed shell titlebar drag', async ({ base, state }) => {
    const before = await getJson<ShellSnapshot>(base, '/test/state/shell')
    if (before.programs_menu_open) {
      await closeProgramsMenuByTaskbarToggle(base, before)
    }
    const opened = await openShellTestWindow(base, state)
    const windowId = opened.window.window_id
    await waitForShellUiFocus(base, windowId)
    const titlebar = await waitFor(
      'wait for shell titlebar before super-after-drag',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const rect = windowControls(shell, windowId)?.titlebar
        return rect && rect.width >= 80 && rect.height >= 16 ? rect : null
      },
      5000,
      100,
    )
    const start = rectCenter(titlebar)
    await dragBetweenPoints(base, start.x, start.y, start.x + 180, start.y + 80, 18)
    await waitFor(
      'wait for shell titlebar drag to settle before super tap',
      async () => {
        const snapshots = await getSnapshots(base)
        const controls = windowControls(snapshots.shell, windowId)
        if (snapshots.compositor.shell_move_window_id !== null) return null
        if (snapshots.compositor.shell_resize_window_id !== null) return null
        if (snapshots.compositor.shell_pointer_grab_window_id !== null) return null
        if (snapshots.compositor.pointer_pressed_button_count !== 0) return null
        if (!controls || controls.dragging) return null
        return snapshots
      },
      5000,
      100,
    )
    for (let tap = 1; tap <= 10; tap += 1) {
      await keyAction(base, 125, 'tap')
      if (tap % 2 === 1) {
        const openedByTap = await waitForProgramsMenuOpen(base)
        assert(openedByTap.programs_menu_open, `programs menu should open on post-drag Super tap ${tap}`)
        assert(openedByTap.controls?.programs_menu_panel || openedByTap.controls?.programs_menu_search, `programs menu should have visible controls on post-drag Super tap ${tap}`)
        assert(openedByTap.focused_window_id === windowId, `shell focus should stay on dragged window while programs menu is open on tap ${tap}`)
      } else {
        const closedByTap = await waitForProgramsMenuClosed(base)
        assert(!closedByTap.programs_menu_open, `programs menu should close on post-drag Super tap ${tap}`)
        assert(!closedByTap.controls?.programs_menu_panel, `programs menu panel should be gone on post-drag Super tap ${tap}`)
        assert(closedByTap.focused_window_id === windowId, `shell focus should return to dragged window after programs menu closes on tap ${tap}`)
      }
    }
  })

  test('shell drag stays live and blocks pointer hover below', async ({ base, state }) => {
    const lower = await openShellTestWindow(base, state)
    const upper = await openShellTestWindow(base, state)
    const lowerId = lower.window.window_id
    const upperId = upper.window.window_id
    await waitForShellUiFocus(base, upperId)

    const lowerWindow = compositorWindowById(upper.compositor, lowerId)
    const upperWindow = compositorWindowById(upper.compositor, upperId)
    assert(lowerWindow, 'missing lower shell window')
    assert(upperWindow, 'missing upper shell window')

    const dragTarget = bodyClickPoint(lowerWindow, upperWindow)
    const titlebar = await waitFor(
      'wait for upper shell titlebar',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        const rect = windowControls(shell, upperId)?.titlebar
        return rect && rect.width >= 80 && rect.height >= 16 ? rect : null
      },
      5000,
      100,
    )
    const start = rectCenter(titlebar)

    await movePoint(base, start.x, start.y)
    await pointerButton(base, BTN_LEFT, 'press')
    await movePoint(base, start.x, start.y + 24)
    await movePoint(base, dragTarget.x, dragTarget.y)

    const duringDrag = await waitFor(
      'wait for shell drag capture shield',
      async () => {
        const snapshots = await getSnapshots(base)
        const controls = windowControls(snapshots.shell, upperId)
        if (snapshots.compositor.shell_move_window_id !== upperId) return null
        if (snapshots.compositor.shell_move_proxy_window_id !== null) return null
        if (!snapshots.shell.window_interaction_capture) return null
        if (snapshots.shell.window_interaction_capture_blocks_pointer !== true) return null
        if (snapshots.shell.window_interaction_capture_hit_pointer !== true) return null
        if (!controls || controls.hidden) return null
        if (!controls.titlebar) return null
        return {
          compositor: snapshots.compositor,
          shell: snapshots.shell,
          controls,
        }
      },
      5000,
      100,
    )

    await pointerButton(base, BTN_LEFT, 'release')

    const settled = await waitFor(
      'wait for shell drag release',
      async () => {
        const snapshots = await getSnapshots(base)
        const controls = windowControls(snapshots.shell, upperId)
        if (snapshots.compositor.shell_move_window_id !== null) return null
        if (snapshots.compositor.shell_move_proxy_window_id !== null) return null
        if (!controls || controls.hidden) return null
        if (snapshots.shell.window_interaction_capture) return null
        return {
          compositor: snapshots.compositor,
          shell: snapshots.shell,
          controls,
        }
      },
      5000,
      8,
    )

    assert(settled.controls?.titlebar, 'missing settled titlebar')

    await writeJsonArtifact('shell-drag-live-frame.json', {
      lowerId,
      upperId,
      start,
      dragTarget,
      duringDrag: {
        hidden: duringDrag.controls.hidden,
        titlebar: duringDrag.controls.titlebar ?? null,
        interactionCapture: duringDrag.shell.window_interaction_capture,
        interactionCaptureBlocksPointer: duringDrag.shell.window_interaction_capture_blocks_pointer,
        interactionCaptureHitPointer: duringDrag.shell.window_interaction_capture_hit_pointer,
      },
      settled: {
        proxyWindowId: settled.compositor.shell_move_proxy_window_id,
        hidden: settled.controls?.hidden ?? null,
        titlebar: settled.controls?.titlebar ?? null,
        interactionCapture: settled.shell.window_interaction_capture,
      },
    })
  })

  test('dragging an unfocused file browser keeps the live shell frame active without a compositor proxy above a native overlap', async ({ base, state }) => {
    let nativeId: number | null = null
    try {
      const opened = await openFileBrowserFromLauncher(base, state.spawnedShellWindowIds)
      const fileBrowserId = opened.windowId
      await waitForShellUiFocus(base, fileBrowserId)

      const fileBrowserReady = await waitFor(
        'wait for file browser titlebar and output geometry',
        async () => {
          const snapshots = await getSnapshots(base)
          const fileBrowserWindow = shellWindowById(snapshots.shell, fileBrowserId)
          const fileBrowserTitlebar = windowControls(snapshots.shell, fileBrowserId)?.titlebar
          const output = snapshots.compositor.outputs.find((entry) => entry.name === fileBrowserWindow?.output_name) ?? null
          return fileBrowserWindow && fileBrowserTitlebar && output
            ? { fileBrowserWindow, fileBrowserTitlebar, output }
            : null
        },
        5000,
        50,
      )
      const safeFileBrowserLeft = fileBrowserReady.output.x + 180
      const safeFileBrowserTop = fileBrowserReady.output.y + 220
      const fileBrowserDragStart = rectCenter(fileBrowserReady.fileBrowserTitlebar)
      await dragBetweenPoints(
        base,
        fileBrowserDragStart.x,
        fileBrowserDragStart.y,
        Math.round(fileBrowserDragStart.x + (safeFileBrowserLeft - fileBrowserReady.fileBrowserWindow.x)),
        Math.round(fileBrowserDragStart.y + (safeFileBrowserTop - fileBrowserReady.fileBrowserWindow.y)),
        18,
      )
      await waitFor(
        'wait for file browser moved into fully visible workspace area',
        async () => {
          const snapshots = await getSnapshots(base)
          const fileBrowserWindow = compositorWindowById(snapshots.compositor, fileBrowserId)
          const workspace = snapshots.compositor.workspace
          if (!fileBrowserWindow || !workspace) return null
          const right = fileBrowserWindow.x + fileBrowserWindow.width
          const bottom = fileBrowserWindow.y + fileBrowserWindow.height
          if (fileBrowserWindow.x < workspace.x + 24) return null
          if (fileBrowserWindow.y < workspace.y + 24) return null
          if (right > workspace.x + workspace.width - 24) return null
          if (bottom > workspace.y + workspace.height - 24) return null
          return { fileBrowserWindow, workspace }
        },
        5000,
        50,
      )

      const nativeTitle = `Derp Native Overlap ${Date.now()}`
      const spawnedNative = await spawnNativeWindow(base, state.knownWindowIds, {
        title: nativeTitle,
        token: `native-overlap-${Date.now()}`,
        strip: 'green',
      })
      nativeId = spawnedNative.window.window_id
      await waitForNativeFocus(base, nativeId)
      const nativeReady = await waitFor(
        'wait for native overlap titlebar',
        async () => {
          const snapshots = await getSnapshots(base)
          const fileBrowserWindow = shellWindowById(snapshots.shell, fileBrowserId)
          const nativeWindow = compositorWindowById(snapshots.compositor, nativeId!)
          const nativeTitlebar = windowControls(snapshots.shell, nativeId!)?.titlebar
          return fileBrowserWindow && nativeWindow && nativeTitlebar
            ? { compositor: snapshots.compositor, shell: snapshots.shell, nativeWindow, fileBrowserWindow, nativeTitlebar }
            : null
        },
        5000,
        100,
      )

      const desiredNativeLeft =
        nativeReady.fileBrowserWindow.x + Math.max(180, Math.round(nativeReady.fileBrowserWindow.width * 0.3))
      const desiredNativeTop =
        nativeReady.fileBrowserWindow.y + Math.max(72, Math.round(nativeReady.fileBrowserWindow.height * 0.14))
      const nativeDragStart = rectCenter(nativeReady.nativeTitlebar)
      await dragBetweenPoints(
        base,
        nativeDragStart.x,
        nativeDragStart.y,
        Math.round(nativeDragStart.x + (desiredNativeLeft - nativeReady.nativeWindow.x)),
        Math.round(nativeDragStart.y + (desiredNativeTop - nativeReady.nativeWindow.y)),
        18,
      )

      const overlapReady = await waitFor(
        'wait for native overlap with left edge exposed on file browser',
        async () => {
          const snapshots = await getSnapshots(base)
          const fileBrowserWindow = shellWindowById(snapshots.shell, fileBrowserId)
          const fileBrowserTitlebar = windowControls(snapshots.shell, fileBrowserId)?.titlebar
          const nativeWindow = compositorWindowById(snapshots.compositor, nativeId!)
          const nativeTitlebar =
            windowControls(snapshots.shell, nativeId!)?.titlebar ??
            compositorFrameTitlebar(snapshots.compositor, nativeId!)
          const output = snapshots.compositor.outputs.find((entry) => entry.name === fileBrowserWindow?.output_name) ?? null
          if (!fileBrowserWindow || !fileBrowserTitlebar || !nativeWindow || !nativeTitlebar || !output) return null
          const overlapLeft = Math.max(fileBrowserWindow.x, nativeWindow.x)
          const overlapTop = Math.max(fileBrowserWindow.y, nativeWindow.y)
          const overlapRight = Math.min(
            fileBrowserWindow.x + fileBrowserWindow.width,
            nativeWindow.x + nativeWindow.width,
          )
          const overlapBottom = Math.min(
            fileBrowserWindow.y + fileBrowserWindow.height,
            nativeWindow.y + nativeWindow.height,
          )
          if (overlapRight - overlapLeft < 160 || overlapBottom - overlapTop < 120) return null
          const fileBrowserStart = {
            x: Math.round(fileBrowserTitlebar.global_x + 36),
            y: Math.round(fileBrowserTitlebar.global_y + fileBrowserTitlebar.height / 2),
          }
          if (fileBrowserStart.x >= nativeWindow.x - 12) return null
          if (pointInRect(nativeTitlebar, fileBrowserStart)) return null
          return {
            compositor: snapshots.compositor,
            shell: snapshots.shell,
            fileBrowserWindow,
            fileBrowserTitlebar,
            nativeWindow,
            nativeTitlebar,
            output,
            fileBrowserStart,
          }
        },
        5000,
        50,
      )

      await movePoint(base, overlapReady.fileBrowserStart.x, overlapReady.fileBrowserStart.y)
      await pointerButton(base, BTN_LEFT, 'press')
      await movePoint(base, overlapReady.fileBrowserStart.x + 18, overlapReady.fileBrowserStart.y + 16)
      const beforeDragSnapshots = await getSnapshots(base)
      const beforeDragControls = windowControls(beforeDragSnapshots.shell, fileBrowserId)

      const maxVisibleDx =
        overlapReady.output.x +
        overlapReady.output.width -
        (overlapReady.fileBrowserWindow.x + overlapReady.fileBrowserWindow.width) -
        12
      await movePoint(
        base,
        overlapReady.fileBrowserStart.x + Math.max(48, Math.min(260, maxVisibleDx)),
        overlapReady.fileBrowserStart.y + 48,
      )

      const duringDrag = await waitFor(
        'wait for focused file browser live drag above native overlap without a compositor proxy',
        async () => {
          const snapshots = await getSnapshots(base)
          if (snapshots.compositor.focused_shell_ui_window_id !== fileBrowserId) return null
          if (snapshots.compositor.shell_move_window_id !== fileBrowserId) return null
          if (snapshots.compositor.shell_move_proxy_window_id !== null) return null
          const controls = windowControls(snapshots.shell, fileBrowserId)
          const fileBrowserWindow = compositorWindowById(snapshots.compositor, fileBrowserId)
          if (!controls || controls.hidden || !controls.titlebar || !fileBrowserWindow) return null
          const frameDimmed = (controls.frame_opacity ?? 1) <= 0.8 || (fileBrowserWindow.render_alpha ?? 1) <= 0.8
          if (!frameDimmed) return null
          const nativeWindow = compositorWindowById(snapshots.compositor, nativeId!)
          if (!nativeWindow) return null
          const overlapLeft = Math.max(fileBrowserWindow.x, nativeWindow.x)
          const overlapTop = Math.max(fileBrowserWindow.y, nativeWindow.y)
          const overlapRight = Math.min(
            fileBrowserWindow.x + fileBrowserWindow.width,
            nativeWindow.x + nativeWindow.width,
          )
          const overlapBottom = Math.min(
            fileBrowserWindow.y + fileBrowserWindow.height,
            nativeWindow.y + nativeWindow.height,
          )
          if (overlapRight - overlapLeft < 24 || overlapBottom - overlapTop < 24) return null
          return {
            compositor: snapshots.compositor,
            shell: snapshots.shell,
            controls,
            fileBrowserWindow,
            nativeWindow,
          }
        },
        5000,
        20,
      )

      await pointerButton(base, BTN_LEFT, 'release')

      const settled = await waitFor(
        'wait for file browser live drag release after unfocused drag',
        async () => {
          const snapshots = await getSnapshots(base)
          if (snapshots.compositor.shell_move_window_id !== null) return null
          if (snapshots.compositor.shell_move_proxy_window_id !== null) return null
          const controls = windowControls(snapshots.shell, fileBrowserId)
          if (!controls || controls.hidden) return null
          return {
            compositor: snapshots.compositor,
            shell: snapshots.shell,
            controls,
          }
        },
        5000,
        20,
      )

      await writeJsonArtifact('shell-drag-unfocused-file-browser-live.json', {
        fileBrowserId,
        nativeId,
        beforeDrag: {
          hidden: beforeDragControls?.hidden ?? null,
          dragging: beforeDragControls?.dragging ?? null,
          moveWindowId: beforeDragSnapshots.compositor.shell_move_window_id,
          moveProxyWindowId: beforeDragSnapshots.compositor.shell_move_proxy_window_id,
        },
        duringDrag: {
          focusedShellUiWindowId: duringDrag.compositor.focused_shell_ui_window_id,
          titlebar: duringDrag.controls.titlebar ?? null,
          frameOpacity: duringDrag.controls.frame_opacity ?? null,
          fileBrowserWindow: duringDrag.fileBrowserWindow,
          nativeWindow: duringDrag.nativeWindow,
        },
        settled: {
          hidden: settled.controls.hidden,
          moveWindowId: settled.compositor.shell_move_window_id,
          moveProxyWindowId: settled.compositor.shell_move_proxy_window_id,
        },
      })
    } finally {
      if (nativeId !== null) {
        await cleanupNativeWindows(base, new Set([nativeId]))
      }
    }
  })

  test('shell drag stays live when a taskbar-clipped frame becomes fully visible again', async ({ base, state }) => {
    const opened = await openShellTestWindow(base, state)
    const windowId = opened.window.window_id
    await waitForShellUiFocus(base, windowId)

    const initial = await waitFor(
      'wait for shell test window output and taskbar geometry',
      async () => {
        const snapshots = await getSnapshots(base)
        const window = compositorWindowById(snapshots.compositor, windowId)
        const titlebar = windowControls(snapshots.shell, windowId)?.titlebar
        const output = snapshots.compositor.outputs.find((entry) => entry.name === window?.output_name) ?? null
        const taskbar = window ? taskbarForMonitor(snapshots.shell, window.output_name) : null
        return window && titlebar && output && taskbar?.rect
          ? { compositor: snapshots.compositor, shell: snapshots.shell, window, titlebar, output, taskbar: taskbar.rect }
          : null
      },
      5000,
      40,
    )

    const initialTitlebarCenter = rectCenter(initial.titlebar)
    const clippedDy = Math.max(
      240,
      Math.round(initial.taskbar.global_y + 36 - (initial.window.y + initial.window.height)),
    )
    const clippedTarget = {
      x: Math.round(initialTitlebarCenter.x),
      y: Math.round(initialTitlebarCenter.y + clippedDy),
    }

    await dragBetweenPoints(
      base,
      initialTitlebarCenter.x,
      initialTitlebarCenter.y,
      clippedTarget.x,
      clippedTarget.y,
      18,
    )

    const positioned = await waitFor(
      'wait for shell test window clipped by taskbar',
      async () => {
        const snapshots = await getSnapshots(base)
        const window = compositorWindowById(snapshots.compositor, windowId)
        const titlebar = windowControls(snapshots.shell, windowId)?.titlebar
        const output = snapshots.compositor.outputs.find((entry) => entry.name === window?.output_name) ?? null
        const taskbar = window ? taskbarForMonitor(snapshots.shell, window.output_name) : null
        if (
          !window ||
          !titlebar ||
          !output ||
          !taskbar?.rect ||
          snapshots.compositor.shell_move_window_id !== null ||
          snapshots.compositor.shell_move_proxy_window_id !== null
        ) {
          return null
        }
        if (window.y + window.height <= taskbar.rect.global_y + 24) return null
        return { compositor: snapshots.compositor, shell: snapshots.shell, window, titlebar, output, taskbar: taskbar.rect }
      },
      5000,
      20,
    )

    const dragStart = rectCenter(positioned.titlebar)
    await movePoint(base, dragStart.x, dragStart.y)
    await pointerButton(base, BTN_LEFT, 'press')
    await movePoint(base, dragStart.x - 18, dragStart.y - 16)

    const clippedDuringDrag = await waitFor(
      'wait for clipped shell drag to stay live without proxy',
      async () => {
        const snapshots = await getSnapshots(base)
        const window = compositorWindowById(snapshots.compositor, windowId)
        const controls = windowControls(snapshots.shell, windowId)
        const output = snapshots.compositor.outputs.find((entry) => entry.name === window?.output_name) ?? null
        const taskbar = window ? taskbarForMonitor(snapshots.shell, window.output_name) : null
        if (!window || !controls || !output || !taskbar?.rect) return null
        if (snapshots.compositor.shell_move_window_id !== windowId) return null
        if (snapshots.compositor.shell_move_proxy_window_id !== null) return null
        if (controls.hidden) return null
        if (window.y + window.height <= taskbar.rect.global_y + 8) return null
        return { compositor: snapshots.compositor, shell: snapshots.shell, window, controls, output, taskbar: taskbar.rect }
      },
      5000,
      20,
    )

    await movePoint(base, dragStart.x, dragStart.y - 120)

    const fullyVisibleDuringDrag = await waitFor(
      'wait for shell drag to stay live after the clipped frame becomes fully visible',
      async () => {
        const snapshots = await getSnapshots(base)
        const window = compositorWindowById(snapshots.compositor, windowId)
        const controls = windowControls(snapshots.shell, windowId)
        const output = snapshots.compositor.outputs.find((entry) => entry.name === window?.output_name) ?? null
        const taskbar = window ? taskbarForMonitor(snapshots.shell, window.output_name) : null
        if (!window || !controls || !output || !taskbar?.rect) return null
        if (snapshots.compositor.shell_move_window_id !== windowId) return null
        if (snapshots.compositor.shell_move_proxy_window_id !== null) return null
        if (controls.hidden) return null
        if ((controls.frame_opacity ?? 0) > 0.8) return null
        if ((controls.content_opacity ?? 0) > 0.8) return null
        if (window.y + window.height > taskbar.rect.global_y + 1) return null
        return {
          compositor: snapshots.compositor,
          shell: snapshots.shell,
          window,
          controls,
          output,
          taskbar: taskbar.rect,
        }
      },
      5000,
      20,
    )

    await pointerButton(base, BTN_LEFT, 'release')

    const settled = await waitFor(
      'wait for clipped shell drag release',
      async () => {
        const snapshots = await getSnapshots(base)
        const controls = windowControls(snapshots.shell, windowId)
        if (snapshots.compositor.shell_move_window_id !== null) return null
        if (snapshots.compositor.shell_move_proxy_window_id !== null) return null
        if (!controls || controls.hidden) return null
        return { compositor: snapshots.compositor, shell: snapshots.shell, controls }
      },
      5000,
      20,
    )

    await writeJsonArtifact('shell-drag-clipped-proxy-gating.json', {
      windowId,
      clippedStartTarget: clippedTarget,
      positioned: {
        x: positioned.window.x,
        y: positioned.window.y,
        width: positioned.window.width,
        height: positioned.window.height,
        output: positioned.window.output_name,
        taskbarTop: positioned.taskbar.global_y,
      },
      clippedDuringDrag: {
        x: clippedDuringDrag.window.x,
        y: clippedDuringDrag.window.y,
        width: clippedDuringDrag.window.width,
        height: clippedDuringDrag.window.height,
        hidden: clippedDuringDrag.controls.hidden,
        frameOpacity: clippedDuringDrag.controls.frame_opacity ?? null,
        contentOpacity: clippedDuringDrag.controls.content_opacity ?? null,
        moveWindowId: clippedDuringDrag.compositor.shell_move_window_id,
        moveProxyWindowId: clippedDuringDrag.compositor.shell_move_proxy_window_id,
      },
      fullyVisibleDuringDrag: {
        x: fullyVisibleDuringDrag.window.x,
        y: fullyVisibleDuringDrag.window.y,
        width: fullyVisibleDuringDrag.window.width,
        height: fullyVisibleDuringDrag.window.height,
        hidden: fullyVisibleDuringDrag.controls.hidden,
        frameOpacity: fullyVisibleDuringDrag.controls.frame_opacity ?? null,
        contentOpacity: fullyVisibleDuringDrag.controls.content_opacity ?? null,
        moveWindowId: fullyVisibleDuringDrag.compositor.shell_move_window_id,
        moveProxyWindowId: fullyVisibleDuringDrag.compositor.shell_move_proxy_window_id,
      },
      settled: {
        hidden: settled.controls.hidden,
        moveWindowId: settled.compositor.shell_move_window_id,
        moveProxyWindowId: settled.compositor.shell_move_proxy_window_id,
      },
    })
  })

  test('shell-hosted windows open directly into auto layout geometry', async ({ base, state }) => {
    await openSettings(base, 'click')
    try {
      await selectSettingsTilingLayout(base, 'grid')
      let shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      await closeTaskbarWindow(base, shell, SHELL_UI_SETTINGS_WINDOW_ID)
      await waitForWindowGone(base, SHELL_UI_SETTINGS_WINDOW_ID)
      await resetPerfCounters(base)
      const beforeOpen = await getSnapshots(base)

      const opened = await openShellTestWindow(base, state)
      const windowId = opened.window.window_id
      const initialWindow = compositorWindowById(opened.compositor, windowId)
      assert(initialWindow, 'missing initial shell-hosted compositor window')
      const settled = await waitFor(
        'wait for grid-opened shell window geometry',
        async () => {
          const { compositor, shell } = await getSnapshots(base)
          const window = compositorWindowById(compositor, windowId)
          const output = compositor.outputs.find((entry) => entry.name === window?.output_name) ?? null
          const taskbar = window ? taskbarForMonitor(shell, window.output_name) : null
          if (!window || !output || !taskbar?.rect) return null
          const expected = expectedGridAutoLayoutClientRect(
            output,
            taskbar.rect,
            autoLayoutManagedWindowsOnOutput(beforeOpen.compositor, output.name),
            windowId,
          )
          if (Math.abs(window.x - expected.x) > 24) return null
          if (Math.abs(window.y - expected.y) > 24) return null
          if (Math.abs(window.width - expected.width) > 24) return null
          if (Math.abs(window.height - expected.height) > 24) return null
          return { compositor, shell, window, expected }
        },
        2000,
        40,
      )
      const perf = await getPerfCounters(base)
      assert(perf.shell_updates.window_mapped_messages >= 1, 'shell-hosted open should emit a mapped message')
      assert(
        initialWindow.x === settled.window.x &&
          initialWindow.y === settled.window.y &&
          initialWindow.width === settled.window.width &&
          initialWindow.height === settled.window.height,
        'shell-hosted auto-layout open geometry should match the first visible compositor snapshot',
      )
      const followup = await getSnapshots(base)
      const followupWindow = compositorWindowById(followup.compositor, windowId)
      assert(followupWindow, 'missing follow-up shell-hosted compositor window')
      assert(
        followupWindow.x === settled.window.x &&
          followupWindow.y === settled.window.y &&
          followupWindow.width === settled.window.width &&
          followupWindow.height === settled.window.height,
        'shell-hosted auto-layout open geometry should stay stable after mapping',
      )
      await writeJsonArtifact('shell-hosted-grid-open.json', {
        windowId,
        perf,
        existingWindowIds: autoLayoutManagedWindowsOnOutput(
          beforeOpen.compositor,
          settled.window.output_name,
        ).map((window) => window.window_id),
        expected: settled.expected,
        initial: {
          x: initialWindow.x,
          y: initialWindow.y,
          width: initialWindow.width,
          height: initialWindow.height,
          output: initialWindow.output_name,
        },
        actual: {
          x: settled.window.x,
          y: settled.window.y,
          width: settled.window.width,
          height: settled.window.height,
          output: settled.window.output_name,
        },
        followup: {
          x: followupWindow.x,
          y: followupWindow.y,
          width: followupWindow.width,
          height: followupWindow.height,
          output: followupWindow.output_name,
        },
      })
    } finally {
      try {
        await openSettings(base, 'click')
        await selectSettingsTilingLayout(base, 'manual-snap')
      } finally {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        if (taskbarEntry(shell, SHELL_UI_SETTINGS_WINDOW_ID)?.close) {
          await closeTaskbarWindow(base, shell, SHELL_UI_SETTINGS_WINDOW_ID)
          await waitForWindowGone(base, SHELL_UI_SETTINGS_WINDOW_ID)
        }
      }
    }
  })

  test('taskbar context menus switch cleanly without disturbing shell focus', async ({ base }) => {
    const { window: settingsWindow } = await openSettings(base, 'click')
    assert(settingsWindow, 'missing settings compositor window')

    const powerOpen = await openPowerMenu(base)
    assert(powerOpen.power_menu_open, 'power menu should be open')
    assert(!powerOpen.programs_menu_open, 'programs menu should stay closed while power menu is open')
    await waitForCompositorShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const powerHtml = await getShellHtml(base, '[aria-label="Power"]')
    assert(powerHtml.includes('Save workspace'), 'power menu missing save workspace action')
    assert(powerHtml.includes('Restore workspace'), 'power menu missing restore workspace action')
    assert(powerHtml.includes('Suspend'), 'power menu missing suspend action')
    assert(powerHtml.includes('Restart'), 'power menu missing restart action')
    assert(powerHtml.includes('Shut down'), 'power menu missing shutdown action')

    const programsOpen = await openProgramsMenu(base, 'click')
    assert(programsOpen.programs_menu_open, 'programs menu should be open')
    assert(!programsOpen.power_menu_open, 'power menu should close when programs menu opens')
    assert(programsOpen.settings_window_visible, 'settings should stay visible when switching power menu to programs menu')
    assert(taskbarEntry(programsOpen, SHELL_UI_SETTINGS_WINDOW_ID)?.activate, 'settings taskbar row should stay visible when programs menu opens')
    const programsHtml = await getShellHtml(base, '[aria-label="Application search"]')
    assert(programsHtml.includes('Search apps, keywords, and commands'), 'programs menu missing search placeholder')

    await clickPoint(
      base,
      settingsWindow.x + settingsWindow.width / 2,
      settingsWindow.y + Math.min(72, Math.max(24, Math.floor(settingsWindow.height / 4))),
    )
    await waitForProgramsMenuClosed(base)
    const programsClosed = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assert(!programsClosed.power_menu_open, 'power menu should remain closed after dismissing programs menu')
    assert(programsClosed.settings_window_visible, 'settings should stay visible after dismissing programs menu')
    assert(taskbarEntry(programsClosed, SHELL_UI_SETTINGS_WINDOW_ID)?.activate, 'settings taskbar row should stay visible after dismissing programs menu')

    await openPowerMenu(base)
    const powerReopened = await waitForPowerMenuOpen(base)

    await clickPoint(
      base,
      settingsWindow.x + settingsWindow.width / 2,
      settingsWindow.y + Math.min(72, Math.max(24, Math.floor(settingsWindow.height / 4))),
    )
    await waitForPowerMenuClosed(base)
    const powerClosed = await getJson<ShellSnapshot>(base, '/test/state/shell')

    const shellAfterMenus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assert(taskbarEntry(shellAfterMenus, SHELL_UI_SETTINGS_WINDOW_ID)?.activate, 'missing settings taskbar row after menus')
    const compositorAfterMenus = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    if (compositorAfterMenus.focused_shell_ui_window_id !== SHELL_UI_SETTINGS_WINDOW_ID) {
      await activateTaskbarWindow(base, shellAfterMenus, SHELL_UI_SETTINGS_WINDOW_ID)
    }
    await waitFor(
      'wait for compositor shell ui on settings after menus',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        return compositor.focused_shell_ui_window_id === SHELL_UI_SETTINGS_WINDOW_ID ? compositor : null
      },
      2000,
      50,
    )

    await writeJsonArtifact('taskbar-context-menus.json', {
      powerOpen,
      programsOpen,
      programsClosed,
      powerReopened,
      powerClosed,
    })
    await writeTextArtifact('taskbar-power-menu.html', powerHtml)
    await writeTextArtifact('taskbar-programs-menu.html', programsHtml)
  })

  test('tray volume panel keeps nested selectors open and exposes mixer controls', async ({ base }) => {
    const settingsOpen = await openSettings(base, 'click')
    const settingsWindow = compositorWindowById(settingsOpen.compositor, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(settingsWindow, 'missing settings compositor window for tray volume test')

    const opened = await openVolumeMenu(base)
    assert(opened.volume_menu_open, 'volume menu should be open')
    assert(opened.controls?.volume_menu_panel, 'missing volume menu panel rect')
    assertTopWindow(opened, SHELL_UI_SETTINGS_WINDOW_ID, 'volume menu should not change focused shell window')
    const overlayOpen = await waitFor(
      'wait for tray volume compositor overlay',
      async () => {
        const snapshots = await getSnapshots(base)
        const overlay = snapshots.compositor.shell_context_menu_global
        if (!snapshots.shell.volume_menu_open || !overlay) return null
        if (overlay.width < 200) return null
        return snapshots
      },
      5000,
      100,
    )
    assert(overlayOpen.compositor.shell_context_menu_global, 'missing tray volume compositor overlay rect')
    const overlayRect = overlayOpen.compositor.shell_context_menu_global
    const overlayStable = await waitFor(
      'wait for stable tray volume overlay snapshot',
      async () => {
        const snapshots = await getSnapshots(base)
        const overlay = snapshots.compositor.shell_context_menu_global
        if (!snapshots.shell.volume_menu_open || !overlay) return null
        if (
          overlay.x !== overlayRect.x ||
          overlay.y !== overlayRect.y ||
          overlay.width !== overlayRect.width ||
          overlay.height !== overlayRect.height
        ) {
          return null
        }
        return snapshots
      },
      1000,
      100,
    )
    assert(overlayStable.compositor.shell_context_menu_global, 'tray volume overlay should stay stable across idle snapshots')

    const volumeReady = await waitFor(
      'wait for volume panel content',
      async () => {
        const [html, shell] = await Promise.all([
          getShellHtml(base, '[data-shell-volume-menu-panel]'),
          getJson<ShellSnapshot>(base, '/test/state/shell'),
        ])
        if (!shell.volume_menu_open) return null
        if (html.includes('Needs cef_host control server to read PipeWire audio state.')) {
          return { html, shell, degraded: true as const }
        }
        if (!html.includes('Output') || !html.includes('Input')) return null
        if (!shell.controls.volume_input_select || !shell.controls.volume_output_select) return null
        return { html, shell, degraded: false as const }
      },
      5000,
      100,
    )
    const volumeHtml = volumeReady.html
    if (volumeReady.degraded) {
      assert(volumeHtml.includes('Needs cef_host control server to read PipeWire audio state.'), 'volume panel should expose the degraded audio-state warning')
      await writeTextArtifact('tray-volume-menu.html', volumeHtml)
      await writeJsonArtifact('tray-volume-shell.json', volumeReady.shell)
      await writeJsonArtifact('tray-volume-overlay.json', overlayOpen)
      return
    }
    assert(volumeHtml.includes('Output'), 'volume panel missing output section')
    assert(volumeHtml.includes('Input'), 'volume panel missing input section')
    assert(volumeReady.shell.controls.volume_input_select, 'missing volume input selector')
    const withOutputSelect = volumeReady.shell
    await clickRect(base, withOutputSelect.controls.volume_output_select!)
    const outputExpanded = await waitFor(
      'wait for volume output selector options',
      async () => {
        const snapshots = await getSnapshots(base)
        if (!snapshots.shell.volume_menu_open) return null
        if (!snapshots.shell.controls.volume_output_option_0) return null
        return compositorFloatingLayerCount(snapshots.compositor) >= 2 ? snapshots : null
      },
      5000,
      100,
    )
    const floatingLayers = compositorFloatingLayers(outputExpanded.compositor)
    assert(floatingLayers.length >= 2, `expected nested floating layers for volume selector, got ${floatingLayers.length}`)
    assert(floatingLayers.at(-1)!.z > floatingLayers[0]!.z, 'nested selector should render above the parent volume menu')
    const topLayer = floatingLayers.at(-1)!
    const outputOptionRect =
      outputExpanded.shell.controls.volume_output_option_0 ?? outputExpanded.shell.controls.volume_output_option_1
    assert(outputOptionRect, 'missing projected output option rect')
    assert(
      compositorFloatingLayerContainsPoint(
        topLayer,
        {
          x: outputOptionRect.global_x + outputOptionRect.width / 2,
          y: outputOptionRect.global_y + outputOptionRect.height / 2,
        },
      ),
      'topmost floating layer should contain the expanded output selector options',
    )
    assertTopWindow(outputExpanded.shell, SHELL_UI_SETTINGS_WINDOW_ID, 'output selector should not disturb shell focus')
    await clickRect(
      base,
      outputExpanded.shell.controls.volume_output_option_1 ?? outputExpanded.shell.controls.volume_output_option_0!,
    )
    const afterOutputPick = await waitFor(
      'wait for output picker settle',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return shell.volume_menu_open ? shell : null
      },
      5000,
      100,
    )
    assert(afterOutputPick.controls.volume_menu_panel, 'volume panel should stay open after output selection')
    assert(afterOutputPick.controls.volume_input_select, 'missing input selector after output selection')
    await clickRect(base, afterOutputPick.controls.volume_input_select)
    const inputExpanded = await waitFor(
      'wait for input selector options',
      async () => {
        const snapshots = await getSnapshots(base)
        if (!snapshots.shell.volume_menu_open) return null
        if (!snapshots.shell.controls.volume_input_option_0) return null
        return compositorFloatingLayerCount(snapshots.compositor) >= 2 ? snapshots : null
      },
      5000,
      100,
    )
    const inputLayers = compositorFloatingLayers(inputExpanded.compositor)
    assert(inputLayers.length >= 2, 'input selector should keep parent menu plus one nested layer')
    const inputTopLayer = inputLayers.at(-1)!
    const inputOptionRect = inputExpanded.shell.controls.volume_input_option_0 ?? inputExpanded.shell.controls.volume_input_option_1
    assert(inputOptionRect, 'missing projected input option rect')
    assert(
      compositorFloatingLayerContainsPoint(
        inputTopLayer,
        {
          x: inputOptionRect.global_x + inputOptionRect.width / 2,
          y: inputOptionRect.global_y + inputOptionRect.height / 2,
        },
      ),
      'topmost floating layer should switch to the input selector after opening it',
    )

    const outputSlider = afterOutputPick.controls.volume_output_slider
    assert(outputSlider, 'missing default output volume slider')
    await clickPoint(
      base,
      outputSlider.x + Math.max(8, Math.floor(outputSlider.width * 0.8)),
      outputSlider.y + Math.floor(outputSlider.height / 2),
    )
    const audioAfterOutputSlide = await getJson(base, '/audio_state')

    const playbackSlider = afterOutputPick.controls.volume_playback_first_slider
    let playbackMixerObserved = false
    if (playbackSlider) {
      await clickPoint(
        base,
        playbackSlider.x + Math.max(8, Math.floor(playbackSlider.width * 0.7)),
        playbackSlider.y + Math.floor(playbackSlider.height / 2),
      )
      playbackMixerObserved = true
    } else {
      const mixerHtml = await getShellHtml(base, '[data-shell-volume-playback-list]')
      playbackMixerObserved = mixerHtml.length > 0
    }
    assert(playbackMixerObserved || volumeHtml.includes('No active playback streams.'), 'playback rows should render or show an empty state')

    await clickPoint(
      base,
      settingsWindow.x + Math.floor(settingsWindow.width / 2),
      settingsWindow.y + Math.min(72, Math.max(24, Math.floor(settingsWindow.height / 4))),
    )
    const closed = await waitForVolumeMenuClosed(base)
    assertTopWindow(closed, SHELL_UI_SETTINGS_WINDOW_ID, 'settings should stay frontmost after volume menu dismiss')
    const dismissedLayers = await waitFor(
      'wait for all floating layers dismissed after outside click',
      async () => {
        const snapshots = await getSnapshots(base)
        return compositorFloatingLayerCount(snapshots.compositor) === 0 ? snapshots : null
      },
      5000,
      100,
    )
    assert(compositorFloatingLayerCount(dismissedLayers.compositor) === 0, 'outside click should dismiss all nested floating layers')

    await writeTextArtifact('tray-volume-menu.html', volumeHtml)
    await writeJsonArtifact('tray-volume-audio-state.json', audioAfterOutputSlide)
    await writeJsonArtifact('tray-volume-shell.json', afterOutputPick)
    await writeJsonArtifact('tray-volume-overlay.json', overlayOpen)
  })

  test('taskbar window row hover mounts tooltip dom above menu layer host', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const shell = await waitForTaskbarEntry(base, redId)
    const row = taskbarEntry(shell, redId)
    assert(row?.activate, 'taskbar activate rect required')
    const c = rectCenter(row.activate)
    await movePoint(base, c.x, c.y)
    await waitFor(
      'taskbar row tooltip mounts',
      async () => {
        const html = await getShellHtml(base, '[data-shell-taskbar-row-tooltip]')
        return html.length > 0 && html.includes(RED_NATIVE_TITLE) ? html : null
      },
      3000,
      40,
    )
    const tooltipOverlay = await waitFor(
      'taskbar row tooltip enters compositor floating exclusions',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const layers = compositor.shell_floating_layers ?? []
        const match = layers.find((layer) => layer.global.width >= 80 && layer.global.height >= 16)
        return match ? { compositor, layer: match } : null
      },
      3000,
      40,
    )
    const { compositor } = await getSnapshots(base)
    const output = compositor.outputs[0]
    assert(output, 'expected at least one output')
    await movePoint(base, output.x + Math.floor(output.width / 2), output.y + 48)
    await waitFor(
      'taskbar row tooltip clears after pointer leave',
      async () => {
        const html = await getShellHtml(base, '[data-shell-taskbar-row-tooltip]')
        return html.length === 0 ? true : null
      },
      3000,
      40,
    )
    await writeJsonArtifact('taskbar-row-tooltip-floating.json', tooltipOverlay)
    await cleanupNativeWindows(base, new Set([redId, green.window.window_id]))
  })

  test('taskbar exclusion covers programs gutter and right edge', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const snapshots = await getSnapshots(base)
    const toggle = assertRectMinSize(
      'taskbar programs toggle',
      snapshots.shell.controls?.taskbar_programs_toggle,
      8,
      8,
    )
    const monitorName =
      snapshots.shell.taskbars.find((taskbar) => pointInRect(taskbar.rect, rectCenter(toggle)))?.monitor ??
      snapshots.shell.taskbars[0]?.monitor ??
      null
    assert(monitorName, 'missing taskbar monitor for programs toggle')
    const taskbar = taskbarForMonitor(snapshots.shell, monitorName)
    assert(taskbar?.rect, `missing taskbar rect for ${monitorName}`)
    const centerY = Math.round(taskbar.rect.global_y + taskbar.rect.height / 2)
    const leftEdgePoint = { x: taskbar.rect.global_x + 2, y: centerY }
    const programsGapPoint = { x: toggle.global_x + toggle.width + 2, y: centerY }
    const rightEdgePoint = { x: taskbar.rect.global_x + taskbar.rect.width - 2, y: centerY }
    assert(pointInRect(taskbar.rect, leftEdgePoint), 'left edge sample should stay inside taskbar')
    assert(pointInRect(taskbar.rect, programsGapPoint), 'programs gutter sample should stay inside taskbar')
    assert(pointInRect(taskbar.rect, rightEdgePoint), 'right edge sample should stay inside taskbar')
    assert(
      pointCoveredByShellExclusion(snapshots.compositor, leftEdgePoint),
      `taskbar exclusion should cover left edge ${leftEdgePoint.x},${leftEdgePoint.y}`,
    )
    assert(
      pointCoveredByShellExclusion(snapshots.compositor, programsGapPoint),
      `taskbar exclusion should cover programs gutter ${programsGapPoint.x},${programsGapPoint.y}`,
    )
    assert(
      pointCoveredByShellExclusion(snapshots.compositor, rightEdgePoint),
      `taskbar exclusion should cover right edge ${rightEdgePoint.x},${rightEdgePoint.y}`,
    )
    await writeJsonArtifact('taskbar-exclusion-full-bar.json', {
      monitorName,
      taskbar: taskbar.rect,
      toggle,
      leftEdgePoint,
      programsGapPoint,
      rightEdgePoint,
      compositor: snapshots.compositor,
      shell: snapshots.shell,
    })
    await cleanupNativeWindows(base, new Set([red.window.window_id, green.window.window_id]))
  })

  test('tray volume panel stays on the compositor overlay while native windows exist', async ({ base, state }) => {
    await ensureNativePair(base, state)
    const opened = await openVolumeMenu(base)
    assert(opened.volume_menu_open, 'volume menu should open with native windows present')
    const overlayOpen = await waitFor(
      'wait for tray volume overlay with native windows',
      async () => {
        const snapshots = await getSnapshots(base)
        if (!snapshots.shell.volume_menu_open) return null
        if (!snapshots.compositor.shell_context_menu_global) return null
        const nativeCount = snapshots.compositor.windows.filter((window) => !window.shell_hosted).length
        return nativeCount >= 2 ? snapshots : null
      },
      5000,
      100,
    )
    assert(overlayOpen.compositor.shell_context_menu_global, 'missing tray volume overlay rect with native windows')
    assert(overlayOpen.compositor.shell_context_menu_global.width >= 200, 'tray volume overlay with native windows should be wide enough')
    const nativeVolumeHtml = await getShellHtml(base, '[data-shell-volume-menu-panel]')
    if (nativeVolumeHtml.includes('Needs cef_host control server to read PipeWire audio state.')) {
      assert(nativeVolumeHtml.includes('Needs cef_host control server to read PipeWire audio state.'), 'native-window tray volume overlay should expose the degraded audio-state warning')
      assert(overlayOpen.shell.controls?.taskbar_volume_toggle, 'missing taskbar volume toggle while closing degraded native overlay test')
      await clickRect(base, overlayOpen.shell.controls.taskbar_volume_toggle)
      await waitForVolumeMenuClosed(base)
      await writeTextArtifact('tray-volume-native-overlay.html', nativeVolumeHtml)
      await writeJsonArtifact('tray-volume-native-overlay.json', overlayOpen)
      return
    }
    assert(overlayOpen.shell.controls?.volume_output_select, 'missing projected output selector rect')
    await clickRect(base, overlayOpen.shell.controls.volume_output_select)
    const outputExpanded = await waitFor(
      'wait for tray volume output selector with native windows',
      async () => {
        const snapshots = await getSnapshots(base)
        if (!snapshots.shell.volume_menu_open) return null
        if (!snapshots.compositor.shell_context_menu_global) return null
        return snapshots.shell.controls?.volume_output_option_0 ? snapshots : null
      },
      5000,
      100,
    )
    assert(outputExpanded.compositor.shell_context_menu_global, 'missing tray volume overlay rect after expanding selector')
    assert(outputExpanded.compositor.shell_context_menu_global.width >= 200, 'expanded tray volume overlay should stay wide enough')
    assert(outputExpanded.shell.controls?.taskbar_volume_toggle, 'missing taskbar volume toggle while closing native overlay test')
    await clickRect(base, outputExpanded.shell.controls.taskbar_volume_toggle)
    await waitForVolumeMenuClosed(base)
    await writeJsonArtifact('tray-volume-native-overlay.json', outputExpanded)
  })

  test('native windows do not cover focused shell windows during taskbar menu churn', async ({ base, state }) => {
    const { red, green } = await ensureNativePair(base, state)
    const redId = red.window.window_id
    const greenId = green.window.window_id
    const settingsOpen = await openSettings(base, 'click')
    const redWindow = compositorWindowById(settingsOpen.compositor, redId)
    const greenWindow = compositorWindowById(settingsOpen.compositor, greenId)
    const settingsWindow = compositorWindowById(settingsOpen.compositor, SHELL_UI_SETTINGS_WINDOW_ID)
    assert(redWindow, 'missing red compositor window')
    assert(greenWindow, 'missing green compositor window')
    assert(settingsWindow, 'missing settings compositor window')

    const shellBeforeRedFocus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeRedFocus, redId)
    await waitForNativeFocus(base, redId)

    const shellBeforeSettingsFocus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeSettingsFocus, SHELL_UI_SETTINGS_WINDOW_ID)
    await waitForCompositorShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsFocused = await getSnapshots(base)

    const contentPoints = [
      {
        x: settingsWindow.x + Math.min(80, Math.max(24, Math.floor(settingsWindow.width / 5))),
        y: settingsWindow.y + Math.min(92, Math.max(36, Math.floor(settingsWindow.height / 4))),
      },
      {
        x: settingsWindow.x + Math.max(48, Math.floor(settingsWindow.width / 2)),
        y: settingsWindow.y + Math.max(64, Math.floor(settingsWindow.height / 2)),
      },
    ]
    const menuDismissPoint = {
      x: settingsWindow.x + 18,
      y: settingsWindow.y + Math.min(96, Math.max(40, Math.floor(settingsWindow.height / 4))),
    }

    for (const point of contentPoints) {
      await clickPoint(base, point.x, point.y)
      await waitForCompositorShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    }

    await openPowerMenu(base)
    await waitForCompositorShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const powerOpen = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assert(powerOpen.power_menu_open, 'power menu should open during native taskbar churn')
    const programsOpen = await openProgramsMenu(base, 'click')
    assert(programsOpen.programs_menu_open, 'programs menu should open during native taskbar churn')

    await clickPoint(base, menuDismissPoint.x, menuDismissPoint.y)
    await waitForProgramsMenuClosed(base)
    const shellAfterProgramDismiss = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const compositorAfterProgramDismiss = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    if (
      taskbarEntry(shellAfterProgramDismiss, SHELL_UI_SETTINGS_WINDOW_ID)?.activate &&
      compositorAfterProgramDismiss.focused_shell_ui_window_id !== SHELL_UI_SETTINGS_WINDOW_ID
    ) {
      await activateTaskbarWindow(base, shellAfterProgramDismiss, SHELL_UI_SETTINGS_WINDOW_ID)
    } else if (!taskbarEntry(shellAfterProgramDismiss, SHELL_UI_SETTINGS_WINDOW_ID)?.activate) {
      assert(shellAfterProgramDismiss.controls?.taskbar_settings_toggle, 'missing settings taskbar toggle after programs menu dismiss')
      await clickRect(base, shellAfterProgramDismiss.controls.taskbar_settings_toggle)
    }
    await waitForCompositorShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const programsClosed = await getJson<ShellSnapshot>(base, '/test/state/shell')

    const shellBeforeGreenFocus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeGreenFocus, greenId)
    await waitForNativeFocus(base, greenId)
    const shellBeforeRefocus = await getJson<ShellSnapshot>(base, '/test/state/shell')
    await activateTaskbarWindow(base, shellBeforeRefocus, SHELL_UI_SETTINGS_WINDOW_ID)
    await waitForCompositorShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const settingsRefocused = await getSnapshots(base)

    await clickPoint(base, contentPoints[1].x, contentPoints[1].y)
    await waitForCompositorShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID)
    const finalFocus = await getSnapshots(base)

    await writeJsonArtifact('shell-chrome-native-menu-focus.json', {
      settingsFocused: settingsFocused.shell,
      programsOpen,
      programsClosed,
      settingsRefocused: settingsRefocused.shell,
      finalFocus: finalFocus.shell,
    })
  })
})
