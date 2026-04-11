import {
  ANSI,
  SHELL_UI_DEBUG_WINDOW_ID,
  SHELL_UI_SETTINGS_WINDOW_ID,
  captureFailureArtifacts,
  cleanupNativeWindows,
  cleanupShellWindows,
  color,
  createReporter,
  createState,
  discoverReadyBase,
  ensureArtifactDir,
  nativeBin,
  testLabel,
  writeJsonArtifact,
  writeTextArtifact,
} from './lib/runtime.ts'
import { groups } from './specs/index.ts'

async function main(): Promise<void> {
  await ensureArtifactDir()
  const base = await discoverReadyBase()
  const runStart = Date.now()
  const reporter = createReporter(groups.map((group) => group.name))
  const state = createState(base)
  let currentGroupName = groups[0]?.name ?? 'suite'
  let currentTestName = 'bootstrap'

  try {
    for (const group of groups) {
      currentGroupName = group.name
      reporter.startGroup(group.name)
      for (const entry of group.tests) {
        currentTestName = entry.name
        await reporter.run(group.name, entry.name, () => entry.run({ base, state }))
      }
    }

    const summary = {
      ok: true,
      base,
      native_bin: nativeBin(),
      duration_ms: Date.now() - runStart,
      settings_window_id: SHELL_UI_SETTINGS_WINDOW_ID,
      debug_window_id: SHELL_UI_DEBUG_WINDOW_ID,
      red_window_id: state.redSpawn?.window.window_id ?? null,
      green_window_id: state.greenSpawn?.window.window_id ?? null,
      launcher_window_id: state.launcherWindowId,
      crash_probe_window_id: state.crashProbe?.window.window_id ?? null,
      tiled_output: state.tiledOutput,
      multi_monitor_native_move: state.multiMonitorNativeMove,
      multi_monitor_shell_move: state.multiMonitorShellMove,
      screenshot: state.screenshot,
    }
    const summaryPath = await writeJsonArtifact('summary.json', summary)
    process.stdout.write(`${color('    Output ', ANSI.dim)} ${summaryPath}\n`)
    if (state.screenshot?.path) {
      process.stdout.write(`${color(' Screenshot ', ANSI.dim)} ${state.screenshot.path}\n`)
    }
  } catch (error) {
    const label = `failure-${Date.now()}-${testLabel(`${currentGroupName}-${currentTestName}`)}`
    await captureFailureArtifacts(base, label)
    await writeTextArtifact(
      `${label}-error.txt`,
      error instanceof Error ? `${error.stack || error.message}\n` : `${String(error)}\n`,
    )
    throw error
  } finally {
    await cleanupShellWindows(base, [SHELL_UI_DEBUG_WINDOW_ID, SHELL_UI_SETTINGS_WINDOW_ID])
    await cleanupNativeWindows(base, state.spawnedNativeWindowIds)
    reporter.printSummary()
  }
}

await main()
