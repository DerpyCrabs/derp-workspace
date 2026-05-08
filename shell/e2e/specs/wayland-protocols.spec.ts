import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  artifactDir,
  assert,
  captureScreenshotRect,
  copyArtifactFile,
  defineGroup,
  getJson,
  movePoint,
  nativeBin,
  readPngRgba,
  shellQuote,
  SkipError,
  spawnCommand,
  syncTest,
  waitFor,
  waitForWindowGone,
  writeJsonArtifact,
  type CompositorSnapshot,
} from '../lib/runtime.ts'
import { closeWindow, openShellTestWindow, postJson, runKeybind, spawnNativeWindow } from '../lib/setup.ts'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const derpctlBin = process.env.DERP_E2E_DERPCTL_BIN || path.join(repoRoot, 'target', 'release', 'derpctl')

type ExplicitSyncDmabufStatus = {
  configured: boolean
  frame_a_committed: boolean
  frame_b_committed: boolean
  acquire_b_signaled: boolean
  release_a_observed: boolean
  release_b_observed: boolean
  stress_total?: number
  stress_committed?: number
  stress_release_observed?: number
  stress_release_failed?: boolean
}

async function readStatusJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

async function signalExplicitSyncControl(socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => socket.end())
    socket.once('end', resolve)
    socket.once('close', resolve)
    socket.once('error', reject)
  })
}

async function derpctl(args: string[]): Promise<void> {
  const { stdout } = await execFileAsync(derpctlBin, args, { cwd: repoRoot })
  const reply = JSON.parse(stdout.trim()) as { ok: boolean; error?: { message?: string } }
  assert(reply.ok, `derpctl ${args.join(' ')} failed: ${reply.error?.message ?? stdout}`)
}

async function dominantInteriorColor(base: string, window: { x: number; y: number; width: number; height: number }) {
  const rect = {
    x: window.x + Math.floor(window.width / 4),
    y: window.y + Math.floor(window.height / 4),
    width: Math.max(8, Math.floor(window.width / 2)),
    height: Math.max(8, Math.floor(window.height / 2)),
  }
  const screenshot = await captureScreenshotRect(base, rect)
  const png = await readPngRgba(screenshot.path)
  let red = 0
  let green = 0
  for (let index = 0; index < png.data.length; index += 4) {
    const r = png.data[index] ?? 0
    const g = png.data[index + 1] ?? 0
    const b = png.data[index + 2] ?? 0
    if (r > 160 && g < 100 && b < 100) red += 1
    if (g > 140 && r < 100 && b < 120) green += 1
  }
  return {
    path: screenshot.path,
    red,
    green,
    total: png.width * png.height,
  }
}

function outputOverlapArea(
  window: { x: number; y: number; width: number; height: number },
  output: { x: number; y: number; width: number; height: number },
) {
  const x0 = Math.max(window.x, output.x)
  const y0 = Math.max(window.y, output.y)
  const x1 = Math.min(window.x + window.width, output.x + output.width)
  const y1 = Math.min(window.y + window.height, output.y + output.height)
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
}

function overlappedOutputs(compositor: CompositorSnapshot, window: { x: number; y: number; width: number; height: number }) {
  return compositor.outputs.filter((output) => outputOverlapArea(window, output) > 16 * 16)
}

function assertAvoidsTopReserve(
  label: string,
  output: { x: number; y: number; width: number; height: number },
  window: { x: number; y: number; width: number; height: number },
  reserve: number,
) {
  assert(window.y >= output.y + reserve, `${label} y ${window.y} overlaps reserve ending at ${output.y + reserve}`)
  assert(
    window.height <= output.height - reserve,
    `${label} height ${window.height} exceeds output height ${output.height} minus reserve ${reserve}`,
  )
}

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

  test('layer-shell exclusive zone reserves compositor work areas', async ({ base, state }) => {
    const zone = 64
    const stamp = Date.now()
    const panelToken = `layer-exclusive-panel-${stamp}`
    await spawnCommand(
      base,
      `${shellQuote(nativeBin())} --layer-panel --exclusive-zone ${zone} --token ${shellQuote(panelToken)}`,
    )
    try {
      const native = await spawnNativeWindow(base, state.knownWindowIds, {
        title: `Derp Layer Exclusive Native ${stamp}`,
        token: `layer-exclusive-native-${stamp}`,
        strip: 'red',
      })
      state.spawnedNativeWindowIds.add(native.window.window_id)
      await derpctl(['window', 'maximize', String(native.window.window_id), '--enabled', 'true'])
      const nativeMaximized = await waitFor(
        'wait for native maximize to avoid layer panel',
        async () => {
          const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          const window = compositor.windows.find((entry) => entry.window_id === native.window.window_id)
          const output = compositor.outputs.find((entry) => entry.name === window?.output_name)
          return window?.maximized && output && window.y >= output.y + zone ? { compositor, window, output } : null
        },
        5000,
        100,
      )
      assertAvoidsTopReserve('native maximized', nativeMaximized.output, nativeMaximized.window, zone)
      await derpctl(['window', 'maximize', String(native.window.window_id), '--enabled', 'false'])
      await derpctl(['window', 'focus', String(native.window.window_id)])
      await runKeybind(base, 'tile_left')
      const nativeTiled = await waitFor(
        'wait for native tile to avoid layer panel',
        async () => {
          const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          const window = compositor.windows.find((entry) => entry.window_id === native.window.window_id)
          const output = compositor.outputs.find((entry) => entry.name === window?.output_name)
          return window && output && !window.maximized && window.y >= output.y + zone ? { compositor, window, output } : null
        },
        5000,
        100,
      )
      assertAvoidsTopReserve('native tiled', nativeTiled.output, nativeTiled.window, zone)

      const shellHosted = await openShellTestWindow(base, state)
      await derpctl(['window', 'maximize', String(shellHosted.window.window_id), '--enabled', 'true'])
      const shellMaximized = await waitFor(
        'wait for shell-hosted maximize to avoid layer panel',
        async () => {
          const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          const window = compositor.windows.find((entry) => entry.window_id === shellHosted.window.window_id)
          const output = compositor.outputs.find((entry) => entry.name === window?.output_name)
          return window?.maximized && output && window.y >= output.y + zone ? { compositor, window, output } : null
        },
        5000,
        100,
      )
      assertAvoidsTopReserve('shell-hosted maximized', shellMaximized.output, shellMaximized.window, zone)
      await derpctl(['window', 'maximize', String(shellHosted.window.window_id), '--enabled', 'false'])
      await derpctl(['window', 'focus', String(shellHosted.window.window_id)])
      await runKeybind(base, 'tile_right')
      const shellTiled = await waitFor(
        'wait for shell-hosted tile to avoid layer panel',
        async () => {
          const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          const window = compositor.windows.find((entry) => entry.window_id === shellHosted.window.window_id)
          const output = compositor.outputs.find((entry) => entry.name === window?.output_name)
          return window && output && !window.maximized && window.y >= output.y + zone ? { compositor, window, output } : null
        },
        5000,
        100,
      )
      assertAvoidsTopReserve('shell-hosted tiled', shellTiled.output, shellTiled.window, zone)
      await writeJsonArtifact('layer-shell-exclusive-zone-work-area.json', {
        zone,
        nativeMaximized: nativeMaximized.window,
        nativeTiled: nativeTiled.window,
        shellMaximized: shellMaximized.window,
        shellTiled: shellTiled.window,
      })
    } finally {
      await spawnCommand(base, `pkill -f ${shellQuote(panelToken)} || true`)
    }
  })

  test('linux-drm-syncobj-v1 protocol errors are enforced', async ({ base }) => {
    const modes = [
      'no-buffer',
      'no-acquire',
      'no-release',
      'unsupported-buffer',
      'conflicting-points',
    ]
    const results: Record<string, string> = {}
    for (const mode of modes) {
      const outputPath = path.join(artifactDir(), `drm-syncobj-error-${mode}-${Date.now()}.txt`)
      const command = [
        shellQuote(nativeBin()),
        '--explicit-sync-error',
        shellQuote(mode),
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
        `wait for linux-drm-syncobj-v1 ${mode} probe`,
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
      results[mode] = output
      assert(!output.includes('\nexit:0\n'), `${mode} unexpectedly succeeded:\n${output}`)
      assert(
        output.includes('wp_linux_drm_syncobj_surface_v1') ||
          output.includes('wp_linux_drm_syncobj_manager_v1') ||
          output.includes('Protocol error'),
        `${mode} did not report an explicit sync protocol error:\n${output}`,
      )
    }
    await writeJsonArtifact('drm-syncobj-protocol-errors.json', results)
  })

  test('linux-drm-syncobj-v1 waits on dma-buf acquire and signals release', async ({ base, state }) => {
    const title = `Derp Explicit Sync Dmabuf ${Date.now()}`
    const statusPath = path.join(artifactDir(), `drm-syncobj-dmabuf-status-${Date.now()}.json`)
    const socketPath = path.join(artifactDir(), `drm-syncobj-dmabuf-control-${Date.now()}.sock`)
    const command = [
      shellQuote(nativeBin()),
      '--explicit-sync-dmabuf',
      '--title',
      shellQuote(title),
      '--token',
      'explicit-sync-dmabuf',
      '--width',
      '360',
      '--height',
      '240',
      '--status-json',
      shellQuote(statusPath),
      '--control-socket',
      shellQuote(socketPath),
    ].join(' ')
    let windowId: number | null = null
    try {
      await spawnCommand(base, command)
      const pending = await waitFor(
        'wait for explicit sync dma-buf pending frame',
        async () => {
          const [status, compositor] = await Promise.all([
            readStatusJson<ExplicitSyncDmabufStatus>(statusPath),
            getJson<CompositorSnapshot>(base, '/test/state/compositor'),
          ])
          const window = compositor.windows.find(
            (entry) => !entry.shell_hosted && !state.knownWindowIds.has(entry.window_id) && entry.title.includes(title),
          )
          if (!status?.frame_b_committed || !window) return null
          return { status, compositor, window }
        },
        5000,
        100,
      )
      windowId = pending.window.window_id
      state.knownWindowIds.add(windowId)
      const red = await waitFor(
        'wait for acquire-blocked dma-buf to keep frame A visible',
        async () => {
          const color = await dominantInteriorColor(base, pending.window)
          return color.red > color.total * 0.7 && color.green < color.total * 0.1 ? color : null
        },
        5000,
        100,
      )
      const beforeSignal = await readStatusJson<ExplicitSyncDmabufStatus>(statusPath)
      assert(beforeSignal?.release_b_observed === false, 'frame B release must not signal before acquire is signaled')
      await signalExplicitSyncControl(socketPath)
      const released = await waitFor(
        'wait for explicit sync dma-buf frame B release',
        async () => {
          const status = await readStatusJson<ExplicitSyncDmabufStatus>(statusPath)
          if (!status?.acquire_b_signaled || !status.release_b_observed) return null
          return status
        },
        5000,
        100,
      )
      const green = await waitFor(
        'wait for acquired dma-buf frame B to become visible',
        async () => {
          const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          const window = compositor.windows.find((entry) => entry.window_id === windowId)
          if (!window) return null
          const color = await dominantInteriorColor(base, window)
          return color.green > color.total * 0.7 && color.red < color.total * 0.1 ? { color, compositor, window } : null
        },
        5000,
        100,
      )
      await writeJsonArtifact('drm-syncobj-dmabuf-acquire-release.json', {
        command,
        statusPath,
        socketPath,
        pending: pending.status,
        released,
        explicitSync: green.compositor.explicit_sync,
        redScreenshot: await copyArtifactFile('drm-syncobj-dmabuf-frame-a.png', red.path),
        greenScreenshot: await copyArtifactFile('drm-syncobj-dmabuf-frame-b.png', green.color.path),
      })
    } finally {
      if (windowId !== null) {
        await closeWindow(base, windowId)
        await waitForWindowGone(base, windowId, 5000)
      }
    }
  })

  test('linux-drm-syncobj-v1 survives rapid same-buffer dma-buf churn', async ({ base, state }) => {
    const title = `Derp Explicit Sync Stress ${Date.now()}`
    const statusPath = path.join(artifactDir(), `drm-syncobj-stress-status-${Date.now()}.json`)
    const stressFrames = 96
    const command = [
      shellQuote(nativeBin()),
      '--explicit-sync-dmabuf',
      '--explicit-sync-dmabuf-stress-frames',
      String(stressFrames),
      '--title',
      shellQuote(title),
      '--token',
      'explicit-sync-stress',
      '--width',
      '640',
      '--height',
      '360',
      '--status-json',
      shellQuote(statusPath),
    ].join(' ')
    let windowId: number | null = null
    try {
      await spawnCommand(base, command)
      const settled = await waitFor(
        'wait for explicit sync dma-buf stress releases',
        async () => {
          const [status, compositor] = await Promise.all([
            readStatusJson<ExplicitSyncDmabufStatus>(statusPath),
            getJson<CompositorSnapshot>(base, '/test/state/compositor'),
          ])
          const window = compositor.windows.find(
            (entry) => !entry.shell_hosted && !state.knownWindowIds.has(entry.window_id) && entry.title.includes(title),
          )
          if (!status || !window) return null
          if (status.stress_committed !== stressFrames) return null
          if (status.stress_release_failed) return null
          if (status.stress_release_observed !== stressFrames) return null
          if ((compositor.explicit_sync?.tracked_commits ?? 0) > 1) return null
          if ((compositor.explicit_sync?.pending_releases ?? 0) > 1) return null
          return { status, compositor, window }
        },
        10000,
        100,
      )
      windowId = settled.window.window_id
      state.knownWindowIds.add(windowId)
      const color = await dominantInteriorColor(base, settled.window)
      assert(color.total > 0, 'stress screenshot should have pixels')
      await writeJsonArtifact('drm-syncobj-dmabuf-stress.json', {
        command,
        statusPath,
        stressFrames,
        status: settled.status,
        explicitSync: settled.compositor.explicit_sync,
        screenshot: await copyArtifactFile('drm-syncobj-dmabuf-stress.png', color.path),
        color,
      })
    } finally {
      if (windowId !== null) {
        await closeWindow(base, windowId)
        await waitForWindowGone(base, windowId, 5000)
      }
    }
  })

  test('linux-drm-syncobj-v1 waits for multi-output same-buffer dma-buf churn', async ({ base, state }) => {
    const initial = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
    const outputs = [...initial.outputs].sort((a, b) => a.x - b.x || a.y - b.y || a.name.localeCompare(b.name))
    if (outputs.length < 2) {
      throw new SkipError('requires at least two outputs')
    }
    const [left, right] = outputs
    assert(left && right, 'missing adjacent outputs')
    const title = `Derp Explicit Sync Multiout ${Date.now()}`
    const statusPath = path.join(artifactDir(), `drm-syncobj-multiout-status-${Date.now()}.json`)
    const socketPath = path.join(artifactDir(), `drm-syncobj-multiout-control-${Date.now()}.sock`)
    const stressFrames = 96
    const width = Math.min(left.width + Math.floor(right.width / 2), left.width + 720)
    const height = Math.min(420, Math.max(240, Math.floor(Math.min(left.height, right.height) / 2)))
    const target = {
      x: right.x - Math.floor(width / 2),
      y: Math.max(0, Math.min(left.y, right.y) + Math.floor((Math.min(left.height, right.height) - height) / 2)),
      width,
      height,
    }
    const command = [
      shellQuote(nativeBin()),
      '--explicit-sync-dmabuf',
      '--explicit-sync-dmabuf-stress-frames',
      String(stressFrames),
      '--explicit-sync-dmabuf-wait-control',
      '--title',
      shellQuote(title),
      '--token',
      'explicit-sync-multiout',
      '--width',
      String(width),
      '--height',
      String(height),
      '--status-json',
      shellQuote(statusPath),
      '--control-socket',
      shellQuote(socketPath),
    ].join(' ')
    let windowId: number | null = null
    try {
      await spawnCommand(base, command)
      const ready = await waitFor(
        'wait for multi-output explicit sync dma-buf window',
        async () => {
          const [status, compositor] = await Promise.all([
            readStatusJson<ExplicitSyncDmabufStatus>(statusPath),
            getJson<CompositorSnapshot>(base, '/test/state/compositor'),
          ])
          const window = compositor.windows.find(
            (entry) => !entry.shell_hosted && !state.knownWindowIds.has(entry.window_id) && entry.title.includes(title),
          )
          if (!status?.configured || !status.frame_a_committed || !window) return null
          return { status, compositor, window }
        },
        5000,
        100,
      )
      windowId = ready.window.window_id
      state.knownWindowIds.add(windowId)
      await derpctl([
        'window',
        'move',
        String(windowId),
        '--x',
        String(target.x),
        '--y',
        String(target.y),
        '--width',
        String(target.width),
        '--height',
        String(target.height),
      ])
      await syncTest(base)
      const placed = await waitFor(
        'wait for explicit sync dma-buf window to span outputs',
        async () => {
          const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
          const window = compositor.windows.find((entry) => entry.window_id === windowId)
          if (!window) return null
          const overlaps = overlappedOutputs(compositor, window)
          return overlaps.length >= 2 ? { compositor, window, overlaps } : null
        },
        5000,
        100,
      )
      await signalExplicitSyncControl(socketPath)
      const settled = await waitFor(
        'wait for multi-output explicit sync dma-buf stress releases',
        async () => {
          const [status, compositor] = await Promise.all([
            readStatusJson<ExplicitSyncDmabufStatus>(statusPath),
            getJson<CompositorSnapshot>(base, '/test/state/compositor'),
          ])
          const window = compositor.windows.find((entry) => entry.window_id === windowId)
          if (!status || !window) return null
          if (status.stress_committed !== stressFrames) return null
          if (status.stress_release_failed) return null
          if (status.stress_release_observed !== stressFrames) return null
          const overlaps = overlappedOutputs(compositor, window)
          if (overlaps.length < 2) return null
          if ((compositor.explicit_sync?.tracked_commits ?? 0) > 1) return null
          if ((compositor.explicit_sync?.pending_releases ?? 0) > 1) return null
          return { status, compositor, window, overlaps }
        },
        10000,
        100,
      )
      const color = await dominantInteriorColor(base, settled.window)
      assert(color.total > 0, 'multi-output stress screenshot should have pixels')
      await writeJsonArtifact('drm-syncobj-dmabuf-multiout-stress.json', {
        command,
        statusPath,
        socketPath,
        stressFrames,
        requested: { width, height, target },
        ready: ready.status,
        placed: {
          window: placed.window,
          overlaps: placed.overlaps.map((output) => ({
            name: output.name,
            area: outputOverlapArea(placed.window, output),
          })),
        },
        window: settled.window,
        overlaps: settled.overlaps.map((output) => ({
          name: output.name,
          area: outputOverlapArea(settled.window, output),
        })),
        status: settled.status,
        explicitSync: settled.compositor.explicit_sync,
        screenshot: await copyArtifactFile('drm-syncobj-dmabuf-multiout-stress.png', color.path),
        color,
      })
    } finally {
      if (windowId !== null) {
        await closeWindow(base, windowId)
        await waitForWindowGone(base, windowId, 5000)
      }
    }
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
