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
  disableSessionRestoreForE2e,
  discoverReadyBase,
  ensureArtifactDir,
  nativeBin,
  primeState,
  setTimingLogsEnabled,
  testLabel,
  writeJsonArtifact,
  writeTextArtifact,
} from './lib/runtime.ts'
import { allGroups, defaultGroups, sessionRestoreGroups } from './specs/index.ts'

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

function selectGroups(selectors: string[], fallbackGroups = defaultGroups) {
  if (selectors.length === 0) {
    return { selected: fallbackGroups, unmatched: [] as string[] }
  }
  const selected = allGroups.filter((group) => {
    const variants = selectorVariants(group.name)
    return selectors.some((selector) => variants.has(normalizeSelector(selector)))
  })
  const matchedSelectors = new Set(
    selectors.filter((selector) =>
      allGroups.some((group) => {
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

function filterShellRestartTests(groups: typeof allGroups, enabled: boolean) {
  if (enabled) return groups
  return groups
    .map((group) => ({
      ...group,
      tests: group.tests.filter((entry) => !entry.shellRestart),
    }))
    .filter((group) => group.tests.length > 0)
}

function parseArgs(argv: string[]) {
  const selectors: string[] = []
  let showTimeLogs = true
  let sessionRestore = false
  for (const value of argv) {
    if (value === '--no-time-logs') {
      showTimeLogs = false
      continue
    }
    if (value === '--session-restore') {
      sessionRestore = true
      continue
    }
    selectors.push(value)
  }
  return { selectors, showTimeLogs, sessionRestore }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  setTimingLogsEnabled(args.showTimeLogs)
  const selectors = args.selectors.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean)
  const { selected: rawSelected, unmatched } = selectGroups(selectors, args.sessionRestore ? allGroups : defaultGroups)
  const selected = filterShellRestartTests(rawSelected, args.sessionRestore)
  if (unmatched.length > 0) {
    throw new Error(`unknown e2e spec selector(s): ${unmatched.join(', ')}; available: ${allGroups.map((group) => group.name).join(', ')}`)
  }
  const sessionRestoreGroupNames = new Set(sessionRestoreGroups.map((group) => group.name))
  const selectedSessionRestoreGroups = selected.filter((group) => sessionRestoreGroupNames.has(group.name))
  if (!args.sessionRestore && selectedSessionRestoreGroups.length > 0) {
    throw new Error(
      `session restore e2e groups are disabled by default; pass --session-restore to run: ${selectedSessionRestoreGroups.map((group) => group.name).join(', ')}`,
    )
  }
  if (selected.length === 0) {
    throw new Error(`no e2e spec files selected; available: ${allGroups.map((group) => group.name).join(', ')}`)
  }
  await ensureArtifactDir()
  let base = await discoverReadyBase()
  const runStart = Date.now()
  const reporter = createReporter(selected.map((group) => group.name))
  const state = createState(base)
  if (!args.sessionRestore) {
    base = await disableSessionRestoreForE2e(base, state)
    state.base = base
  }
  let currentGroupName = selected[0]?.name ?? 'suite'
  let currentTestName = 'bootstrap'

  try {
    for (const group of selected) {
      currentGroupName = group.name
      reporter.startGroup(group.name)
      try {
        for (const entry of group.tests) {
          currentTestName = entry.name
          await primeState(state.base, state, { sessionRestore: args.sessionRestore })
          await reporter.run(group.name, entry.name, () => entry.run({ base: state.base, state }))
        }
      } finally {
        reporter.finishGroup(group.name)
      }
    }

    const summary = {
      ok: true,
      base: state.base,
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
    await captureFailureArtifacts(state.base, label)
    await writeTextArtifact(
      `${label}-error.txt`,
      error instanceof Error ? `${error.stack || error.message}\n` : `${String(error)}\n`,
    )
    throw error
  } finally {
    await cleanupShellWindows(state.base, [
      SHELL_UI_DEBUG_WINDOW_ID,
      SHELL_UI_SETTINGS_WINDOW_ID,
      ...state.spawnedShellWindowIds,
    ])
    await cleanupNativeWindows(state.base, state.spawnedNativeWindowIds)
    reporter.printSummary()
  }
}

await main()
