import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  artifactDir,
  assert,
  captureScreenshotRect,
  comparePngFixture,
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
import { closeWindow, postJson } from '../lib/setup.ts'

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

  test('google chrome wayland animation presents successive frames', async ({ base, state }) => {
    const title = `Derp Chrome Frame Probe ${Date.now()}`
    const profileDir = `/tmp/derp-chrome-frame-probe-${Date.now()}`
    const html = [
      '<!doctype html><meta charset="utf-8">',
      `<title>${title}</title>`,
      '<style>',
      'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111820}',
      '#probe{position:absolute;left:80px;top:90px;width:340px;height:240px;background:#e64141;animation:probe .22s steps(2,end) infinite}',
      '@keyframes probe{from{background:#e64141;transform:translateX(0)}to{background:#2d75ff;transform:translateX(150px)}}',
      '</style><div id="probe"></div>',
    ].join('')
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    const command = [
      'sh',
      '-lc',
      shellQuote(
        [
          'bin="$(command -v google-chrome-unstable || command -v google-chrome || command -v chromium || command -v chromium-browser || true)"',
          'test -n "$bin"',
          `rm -rf ${shellQuote(profileDir)}`,
          [
            'exec "$bin"',
            '--ozone-platform=wayland',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-search-engine-choice-screen',
            '--password-store=basic',
            '--disable-sync',
            `--user-data-dir=${shellQuote(profileDir)}`,
            `--app=${shellQuote(dataUrl)}`,
          ].join(' '),
        ].join('; '),
      ),
    ].join(' ')
    await spawnCommand(base, command)
    const spawned = await waitFor(
      'wait for chrome frame probe',
      async () => {
        const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
        const window = compositor.windows.find(
          (entry) => !entry.shell_hosted && !state.knownWindowIds.has(entry.window_id) && entry.title.includes(title),
        )
        return window ? { compositor, window } : null
      },
      8000,
      100,
    )
    state.knownWindowIds.add(spawned.window.window_id)
    const rect = {
      x: spawned.window.x + 96,
      y: spawned.window.y + 112,
      width: Math.min(460, Math.max(120, spawned.window.width - 192)),
      height: Math.min(280, Math.max(120, spawned.window.height - 224)),
    }
    const before = await captureScreenshotRect(base, rect)
    const animated = await waitFor(
      'wait for chrome animation pixels to change',
      async () => {
        const next = await captureScreenshotRect(base, rect)
        const comparison = await comparePngFixture(next.path, before.path, {
          maxDifferentPixels: rect.width * rect.height,
          maxChannelDelta: 0,
        })
        return comparison.differentPixels > 1000 ? { path: next.path, comparison } : null
      },
      5000,
      100,
    )
    await writeJsonArtifact('chrome-wayland-frame-probe.json', {
      windowId: spawned.window.window_id,
      title,
      rect,
      before: before.path,
      after: animated.path,
      comparison: animated.comparison,
    })
    await closeWindow(base, spawned.window.window_id)
    await waitForWindowGone(base, spawned.window.window_id, 5000)
  })
})
