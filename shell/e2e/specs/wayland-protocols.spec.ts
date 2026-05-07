import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  artifactDir,
  assert,
  defineGroup,
  getJson,
  movePoint,
  nativeBin,
  shellQuote,
  spawnCommand,
  waitFor,
  waitForWindowGone,
  writeJsonArtifact,
  type CompositorSnapshot,
} from '../lib/runtime.ts'
import { closeWindow, postJson, runKeybind } from '../lib/setup.ts'

export default defineGroup(import.meta.url, ({ test }) => {
  test('advertises linux-drm-syncobj-v1 to Wayland clients', async ({ base }) => {
    const outputPath = path.join(artifactDir(), `drm-syncobj-globals-${Date.now()}.txt`)
    const command = [
      shellQuote(nativeBin()),
      '--require-global',
      'wp_linux_drm_syncobj_manager_v1',
      '--list-globals',
      '>',
      shellQuote(outputPath),
      '2>&1;',
      'printf',
      shellQuote('\\nexit:%s\\n'),
      '$?',
      '>>',
      shellQuote(outputPath),
    ].join(' ')
    await spawnCommand(base, `sh -lc ${shellQuote(command)}`)
    const output = await waitFor(
      'wait for linux-drm-syncobj-v1 registry probe',
      async () => {
        try {
          const text = await readFile(outputPath, 'utf8')
          return text.includes('\nexit:') ? text : null
        } catch {
          return null
        }
      },
      5000,
      100,
    )
    assert(output.includes('wp_linux_drm_syncobj_manager_v1 1'), output)
    assert(output.includes('\nexit:0\n'), output)
  })

  test('advertises presentation content-type and tearing-control globals', async ({ base }) => {
    const outputPath = path.join(artifactDir(), `wayland-protocol-globals-${Date.now()}.txt`)
    const command = [
      shellQuote(nativeBin()),
      '--require-global',
      'wp_presentation',
      '--require-global',
      'wp_content_type_manager_v1',
      '--require-global',
      'wp_tearing_control_manager_v1',
      '--list-globals',
      '>',
      shellQuote(outputPath),
      '2>&1;',
      'printf',
      shellQuote('\\nexit:%s\\n'),
      '$?',
      '>>',
      shellQuote(outputPath),
    ].join(' ')
    await spawnCommand(base, `sh -lc ${shellQuote(command)}`)
    const output = await waitFor(
      'wait for wayland protocol registry probe',
      async () => {
        try {
          const text = await readFile(outputPath, 'utf8')
          return text.includes('\nexit:') ? text : null
        } catch {
          return null
        }
      },
      5000,
      100,
    )
    assert(output.includes('wp_presentation 2'), output)
    assert(output.includes('wp_content_type_manager_v1 1'), output)
    assert(output.includes('wp_tearing_control_manager_v1 1'), output)
    assert(output.includes('\nexit:0\n'), output)
  })

  test('native presentation content type and tearing hints are committed', async ({ base, state }) => {
    const title = `Derp Wayland Protocol Probe ${Date.now()}`
    const command = [
      shellQuote(nativeBin()),
      '--title',
      shellQuote(title),
      '--token',
      'wayland-protocols',
      '--width',
      '420',
      '--height',
      '260',
      '--presentation-smoke',
      '--content-type',
      'game',
      '--tearing-hint',
      'async',
      '--burst-frames',
      '180',
    ].join(' ')
    let windowId: number | null = null
    try {
      await spawnCommand(base, command)
      const spawned = await waitFor(
        'wait for protocol probe window state',
        async () => {
          const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          const window = compositor.windows.find(
            (entry) => !entry.shell_hosted && !state.knownWindowIds.has(entry.window_id) && entry.title.includes(title),
          )
          if (!window) return null
          if (window.content_type !== 'game') return null
          if (window.tearing_hint !== 'async') return null
          if (!window.title.includes('presented=')) return null
          return { compositor, window }
        },
        5000,
        100,
      )
      windowId = spawned.window.window_id
      state.knownWindowIds.add(windowId)
      await runKeybind(base, 'toggle_fullscreen', windowId)
      const flip = await waitFor(
        'wait for async flip diagnostic',
        async () => {
          const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          const window = compositor.windows.find((entry) => entry.window_id === windowId)
          if (!window?.fullscreen) return null
          const output = compositor.outputs.find((entry) => entry.name === window.output_name)
          if (!output) return null
          if (output.last_flip_mode === 'async') return { compositor, window, output }
          if (output.last_flip_fallback_reason) return { compositor, window, output }
          return null
        },
        5000,
        100,
      )
      await writeJsonArtifact('wayland-protocols-presentation-content-tearing.json', {
        command,
        window: flip.window,
        output: flip.output,
      })
    } finally {
      if (windowId !== null) {
        await closeWindow(base, windowId)
        await waitForWindowGone(base, windowId, 5000)
      }
    }
  })

  test('native cursor-shape pointer uses selected XCursor theme', async ({ base, state }) => {
    const beforeSettings = await getJson<{ theme: string; size: number }>(base, '/settings_cursor')
    const nextSettings = {
      theme: beforeSettings.theme || 'default',
      size: Math.max(24, Math.min(48, beforeSettings.size || 24)),
    }
    await postJson(base, '/settings_cursor', nextSettings)
    const title = `Derp Cursor Shape Probe ${Date.now()}`
    const command = [
      shellQuote(nativeBin()),
      '--title',
      shellQuote(title),
      '--token',
      'cursor-shape-pointer',
      '--width',
      '360',
      '--height',
      '240',
      '--cursor-shape-pointer',
    ].join(' ')
    let windowId: number | null = null
    try {
      await spawnCommand(base, command)
      const spawned = await waitFor(
        'wait for cursor shape probe',
        async () => {
          const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          const window = compositor.windows.find(
            (entry) => !entry.shell_hosted && !state.knownWindowIds.has(entry.window_id) && entry.title.includes(title),
          )
          return window ? { compositor, window } : null
        },
        5000,
        100,
      )
      windowId = spawned.window.window_id
      state.knownWindowIds.add(spawned.window.window_id)
      await movePoint(
        base,
        spawned.window.x + Math.floor(spawned.window.width / 2),
        spawned.window.y + Math.floor(spawned.window.height / 2),
      )
      const shaped = await waitFor(
        'wait for pointer cursor shape',
        async () => {
          const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          return compositor.cursor_shape === 'pointer' && compositor.cursor_name ? compositor : null
        },
        3000,
        100,
      )
      await writeJsonArtifact('cursor-shape-pointer.json', {
        windowId: spawned.window.window_id,
        settings: nextSettings,
        cursorTheme: shaped.cursor_theme,
        cursorSize: shaped.cursor_size,
        cursorShape: shaped.cursor_shape,
        cursorName: shaped.cursor_name,
        cursorSourcePath: shaped.cursor_source_path,
      })
    } finally {
      if (windowId !== null) {
        await closeWindow(base, windowId)
        await waitForWindowGone(base, windowId, 5000)
      }
      await postJson(base, '/settings_cursor', beforeSettings)
    }
  })

})
