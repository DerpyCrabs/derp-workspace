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
  primeState,
  testLabel,
  writeJsonArtifact,
  writeTextArtifact,
} from './lib/runtime.ts'
import { groups } from './specs/index.ts'

function normalizeSelector(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^shell\/e2e\/specs\//, '')
    .replace(/^e2e\/specs\//, '')
    .replace(/^specs\//, '')
    .toLowerCase()
}

function selectorVariants(groupName: string): Set<string> {
  const normalized = normalizeSelector(groupName)
  const withoutSpec = normalized.replace(/\.spec\.ts$/, '')
  const withoutTs = normalized.replace(/\.ts$/, '')
  return new Set([normalized, withoutSpec, withoutTs])
}

function selectGroups(selectors: string[]) {
  if (selectors.length === 0) {
    return { selected: groups, unmatched: [] as string[] }
  }
  const selected = groups.filter((group) => {
    const variants = selectorVariants(group.name)
    return selectors.some((selector) => variants.has(normalizeSelector(selector)))
  })
  const matchedSelectors = new Set(
    selectors.filter((selector) =>
      groups.some((group) => {
        const variants = selectorVariants(group.name)
        return variants.has(normalizeSelector(selector))
      }),
    ),
  )
  return {
    selected,
    unmatched: selectors.filter((selector) => !matchedSelectors.has(selector)),
  }
}

async function main(): Promise<void> {
  const selectors = process.argv.slice(2).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean)
  const { selected, unmatched } = selectGroups(selectors)
  if (unmatched.length > 0) {
    throw new Error(`unknown e2e spec selector(s): ${unmatched.join(', ')}; available: ${groups.map((group) => group.name).join(', ')}`)
  }
  if (selected.length === 0) {
    throw new Error(`no e2e spec files selected; available: ${groups.map((group) => group.name).join(', ')}`)
  }
  await ensureArtifactDir()
  const base = await discoverReadyBase()
  const runStart = Date.now()
  const reporter = createReporter(selected.map((group) => group.name))
  const state = createState(base)
  let currentGroupName = selected[0]?.name ?? 'suite'
  let currentTestName = 'bootstrap'

  try {
    for (const group of selected) {
      currentGroupName = group.name
      reporter.startGroup(group.name)
      for (const entry of group.tests) {
        currentTestName = entry.name
        await primeState(base, state)
        await reporter.run(group.name, entry.name, () => entry.run({ base, state }))
      }
    }

    const summary = {
      ok: true,
      base,
      native_bin: nativeBin(),
      duration_ms: Date.now() - runStart,
      timings: reporter.timingSummary(),
      settings_window_id: SHELL_UI_SETTINGS_WINDOW_ID,
      debug_window_id: SHELL_UI_DEBUG_WINDOW_ID,
      red_window_id: state.redSpawn?.window.window_id ?? null,
      green_window_id: state.greenSpawn?.window.window_id ?? null,
      launcher_window_id: state.launcherWindowId,
      crash_probe_window_id: state.crashProbe?.window.window_id ?? null,
      shell_test_window_ids: [...state.spawnedShellWindowIds],
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
    await cleanupShellWindows(base, [
      SHELL_UI_DEBUG_WINDOW_ID,
      SHELL_UI_SETTINGS_WINDOW_ID,
      ...state.spawnedShellWindowIds,
    ])
    await cleanupNativeWindows(base, state.spawnedNativeWindowIds)
    reporter.printSummary()
  }
}

await main()
