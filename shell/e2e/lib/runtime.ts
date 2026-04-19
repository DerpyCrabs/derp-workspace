import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BTN_LEFT = 0x110
export const BTN_RIGHT = 0x111
export const NATIVE_APP_ID = 'derp.e2e.native'
export const X11_XTERM_APP_ID = 'derp-x11-xterm'
export const SHELL_TEST_APP_ID = 'derp.test-shell'
export const SHELL_UI_DEBUG_WINDOW_ID = 9001
export const SHELL_UI_SETTINGS_WINDOW_ID = 9002
export const RED_NATIVE_TITLE = 'Derp Native Red'
export const GREEN_NATIVE_TITLE = 'Derp Native Green'
export const CRASH_NATIVE_TITLE = 'Derp Native Crash Probe'
export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bgCyan: '\x1b[46m',
  black: '\x1b[30m',
} as const
export const KEY = {
  backspace: 14,
  enter: 28,
  escape: 1,
  space: 57,
  home: 102,
  left: 105,
  right: 106,
  end: 107,
  down: 108,
  a: 30,
  b: 48,
  c: 46,
  d: 32,
  e: 18,
  f: 33,
  g: 34,
  h: 35,
  i: 23,
  j: 36,
  k: 37,
  l: 38,
  m: 50,
  n: 49,
  o: 24,
  p: 25,
  q: 16,
  r: 19,
  s: 31,
  t: 20,
  u: 22,
  v: 47,
  w: 17,
  x: 45,
  up: 103,
  y: 21,
  z: 44,
} as const

export interface Rect {
  x: number
  y: number
  width: number
  height: number
  global_x: number
  global_y: number
}

export interface OutputSnapshot {
  name: string
  x: number
  y: number
  width: number
  height: number
  scale?: number
  transform?: string
  refresh_milli_hz?: number
}

export interface WindowSnapshot {
  window_id: number
  title: string
  app_id: string
  xwayland_scale?: number | null
  output_name: string
  x: number
  y: number
  width: number
  height: number
  minimized: boolean
  maximized: boolean
  fullscreen: boolean
  shell_hosted: boolean
  stack_z?: number
  surface_id?: number
  client_side_decoration?: boolean
  wayland_client_pid?: number | null
}

export interface CompositorWorkspaceRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CompositorFloatingLayerSnapshot {
  id: number
  z: number
  global: CompositorWorkspaceRect
}

export interface CompositorShellUiWindowSnapshot {
  id: number
  z: number
  global: CompositorWorkspaceRect
  buffer: CompositorWorkspaceRect
}

export interface CompositorWindowRectsSnapshot {
  window_id: number
  rects: CompositorWorkspaceRect[]
}

export interface CompositorOutputWindowStackSnapshot {
  output_name: string
  window_ids: number[]
}

export interface CompositorSnapshot {
  windows: WindowSnapshot[]
  outputs: OutputSnapshot[]
  focused_window_id: number | null
  focused_shell_ui_window_id: number | null
  session_power_action?: string | null
  session_power_requested_at_ms?: number | null
  window_stack_order?: number[]
  ordered_window_ids_by_output?: CompositorOutputWindowStackSnapshot[]
  shell_ui_windows_generation?: number
  shell_ui_windows?: CompositorShellUiWindowSnapshot[]
  shell_exclusion_global?: CompositorWorkspaceRect[]
  shell_exclusion_decor?: CompositorWindowRectsSnapshot[]
  pending_deferred_window_ids?: number[]
  orphaned_wayland_surface_protocol_ids?: number[]
  pointer?: { x: number; y: number }
  workspace?: CompositorWorkspaceRect | null
  shell_context_menu_global?: CompositorWorkspaceRect | null
  shell_floating_layers?: CompositorFloatingLayerSnapshot[]
  [key: string]: unknown
}

export interface ShellTaskbar {
  monitor: string
  rect: Rect
}

export interface ShellTaskbarWindow {
  group_id?: string
  window_id: number
  tab_count?: number
  activate?: Rect | null
  close?: Rect | null
}

export interface ShellTabButton {
  window_id: number
  rect?: Rect | null
  close?: Rect | null
  active: boolean
  pinned?: boolean
  split_left?: boolean
}

export interface ShellTabGroup {
  group_id: string
  visible_window_id: number
  split_left_window_id?: number | null
  split_left_pane_fraction?: number | null
  hidden_window_ids: number[]
  member_window_ids: number[]
  visible_window_ids?: number[]
  split_left_rect?: Rect | null
  split_right_rect?: Rect | null
  split_divider_rect?: Rect | null
  tabs: ShellTabButton[]
  drop_slots?: { insert_index: number; rect?: Rect | null }[]
}

export interface ShellWindowControls {
  window_id: number
  titlebar?: Rect | null
  maximize?: Rect | null
  snap_picker?: Rect | null
}

export interface AssistSpanSnapshot {
  gridCols: number
  gridRows: number
  gc0: number
  gc1: number
  gr0: number
  gr1: number
}

export interface ShellControls {
  taskbar_programs_toggle?: Rect | null
  taskbar_settings_toggle?: Rect | null
  taskbar_debug_toggle?: Rect | null
  taskbar_volume_toggle?: Rect | null
  taskbar_power_toggle?: Rect | null
  volume_menu_panel?: Rect | null
  volume_output_select?: Rect | null
  volume_input_select?: Rect | null
  volume_output_slider?: Rect | null
  volume_playback_first_slider?: Rect | null
  programs_menu_search?: Rect | null
  programs_menu_first_item?: Rect | null
  programs_menu_panel?: Rect | null
  programs_menu_list?: Rect | null
  tab_menu_pin?: Rect | null
  tab_menu_unpin?: Rect | null
  tab_menu_use_split_left?: Rect | null
  tab_menu_exit_split?: Rect | null
  settings_tab_user?: Rect | null
  settings_tab_displays?: Rect | null
  settings_tab_tiling?: Rect | null
  settings_tab_keyboard?: Rect | null
  settings_session_autosave_enable?: Rect | null
  settings_session_autosave_disable?: Rect | null
  power_menu_save_session?: Rect | null
  power_menu_restore_session?: Rect | null
  power_menu_restart?: Rect | null
  power_menu_shutdown?: Rect | null
  debug_reload_button?: Rect | null
  debug_copy_snapshot_button?: Rect | null
  debug_crosshair_toggle?: Rect | null
  snap_strip_trigger?: Rect | null
  snap_picker_root?: Rect | null
  snap_picker_first_cell?: Rect | null
  snap_picker_top_center_cell?: Rect | null
  snap_picker_hgutter_col0?: Rect | null
  snap_picker_right_two_thirds?: Rect | null
  snap_picker_top_two_thirds_left?: Rect | null
  [key: string]: Rect | null | undefined
}

export interface ProgramsMenuListScroll {
  scroll_top: number
  scroll_height: number
  client_height: number
}

export interface FileBrowserSnapshotRow {
  path: string
  name: string
  kind: string | null
  selected: boolean
  rect?: Rect | null
}

export interface FileBrowserSnapshotBreadcrumb {
  path: string
  label: string
  rect?: Rect | null
}

export interface FileBrowserSnapshotAction {
  id: string
  label: string
  rect?: Rect | null
}

export interface FileBrowserSnapshot {
  active_path: string | null
  rows: FileBrowserSnapshotRow[]
  breadcrumbs: FileBrowserSnapshotBreadcrumb[]
  viewer_editor_title: string | null
  primary_actions: FileBrowserSnapshotAction[]
}

export interface FileBrowserContextMenuActionSnapshot {
  id: string
  label: string
  rect: Rect | null
}

export interface FileBrowserWindowSnapshot extends FileBrowserSnapshot {
  window_id: number
}

export interface ShellSnapshot {
  windows: WindowSnapshot[]
  taskbars: ShellTaskbar[]
  taskbar_windows: ShellTaskbarWindow[]
  tab_groups?: ShellTabGroup[]
  window_controls?: ShellWindowControls[]
  controls: ShellControls
  settings_window_visible: boolean
  debug_window_visible: boolean
  programs_menu_open: boolean
  power_menu_open: boolean
  volume_menu_open?: boolean
  menu_layer_host_connected?: boolean
  menu_layer_host_z_index?: number | null
  menu_portal_hit_test?: {
    hit_ok: boolean
    tray_flap_above_toggle: boolean | null
  } | null
  overlay_menu_dom?: {
    host_connected: boolean
    volume_panel_dom: boolean
    power_menu_dom: boolean
    programs_menu_dom: boolean
  } | null
  programs_menu_query: string
  programs_menu_list_scroll?: ProgramsMenuListScroll | null
  crosshair_cursor: boolean
  snap_picker_open?: boolean
  snap_picker_window_id?: number | null
  snap_picker_source?: string | null
  snap_picker_monitor?: string | null
  snap_preview_visible?: boolean
  snap_preview_rect?: Rect | null
  snap_hover_span?: AssistSpanSnapshot | null
  window_stack_order?: number[]
  focused_window_id?: number | null
  file_browser?: FileBrowserSnapshot | null
  file_browser_windows?: FileBrowserWindowSnapshot[]
  file_browser_context_menu?: FileBrowserContextMenuActionSnapshot[]
  session_snapshot?: Record<string, unknown> | null
  session_snapshot_error?: string | null
  session_restore_active?: boolean
  tab_drag_target?: {
    window_id: number
    group_id: string
    insert_index: number
  } | null
  [key: string]: unknown
}

export interface PerfBeginFrameSnapshot {
  compositor_schedules: number
  compositor_schedules_idle: number
  compositor_schedules_active: number
  compositor_schedules_forced: number
  cef_send_external_begin_frame: number
  drm_render_ticks: number
}

export interface PerfShellUpdateSnapshot {
  batch_count: number
  message_count: number
  window_list_messages: number
  window_mapped_messages: number
  window_geometry_messages: number
  window_metadata_messages: number
  window_state_messages: number
  focus_changed_messages: number
}

export interface PerfShellSyncSnapshot {
  full_window_list_replies: number
  snapshot_notifies: number
  snapshot_reads: number
}

export interface PerfCounterSnapshot {
  begin_frame: PerfBeginFrameSnapshot
  shell_updates: PerfShellUpdateSnapshot
  shell_sync: PerfShellSyncSnapshot
}

export interface FileBrowserFixturePaths {
  root_path: string
  empty_dir: string
  hidden_dir: string
  nested_dir: string
  hidden_file: string
  hidden_dir_file: string
  writable_text: string
  read_only_text: string
  nested_text: string
  image_file: string
  image_file_green: string
  pdf_file: string
  video_file: string
  unsupported_file: string
}

export interface DesktopAppEntry {
  name?: string
  exec?: string
  executable?: string
  generic_name?: string
  full_name?: string
  [key: string]: unknown
}

export interface NativeSpawnResult {
  snapshot: CompositorSnapshot
  window: WindowSnapshot
  command: string
}

export interface E2eState {
  base: string
  knownWindowIds: Set<number>
  spawnedNativeWindowIds: Set<number>
  nativeLaunchByWindowId: Map<number, string>
  desktopApps: DesktopAppEntry[]
  redSpawn: NativeSpawnResult | null
  greenSpawn: NativeSpawnResult | null
  crashProbe: NativeSpawnResult | null
  spawnedShellWindowIds: Set<number>
  launcherWindowId: number | null
  screenshot: { path?: string; [key: string]: unknown } | null
  multiMonitorNativeMove: { window_id: number; target_output: string } | null
  multiMonitorShellMove: { window_id: number; target_output: string } | null
  tiledOutput: string | null
}

export interface TestContext {
  base: string
  state: E2eState
}

export interface TestEntry {
  name: string
  run: (context: TestContext) => Promise<void>
}

export interface TestGroup {
  name: string
  tests: TestEntry[]
}

export type TimingEvent = {
  kind: 'wait' | 'step' | 'mark'
  label: string
  elapsedMs: number
  totalMs?: number
  attempts?: number
  status?: 'passed' | 'timed_out' | 'errored'
}

type TestTimingResult = {
  groupName: string
  name: string
  status: 'passed' | 'failed' | 'skipped'
  elapsedMs: number
  timings: TimingEvent[]
}

let activeTimingSink: TimingEvent[] | null = null
let timingLogsEnabled = true

function setActiveTimingSink(next: TimingEvent[] | null): void {
  activeTimingSink = next
}

function recordTimingEvent(event: TimingEvent): void {
  activeTimingSink?.push(event)
}

export function setTimingLogsEnabled(enabled: boolean): void {
  timingLogsEnabled = enabled
}

class Reporter {
  private readonly startedAt = Date.now()
  private readonly results: TestTimingResult[] = []
  private readonly startedGroups: string[] = []
  private readonly finishedGroups = new Set<string>()
  private readonly groupStartedAt = new Map<string, number>()
  private readonly testCounts = new Map<string, number>()
  private readonly groups: string[]

  constructor(groups: string[]) {
    this.groups = groups
  }

  startGroup(name: string): void {
    if (this.startedGroups.includes(name)) return
    this.startedGroups.push(name)
    this.groupStartedAt.set(name, Date.now())
    process.stdout.write(this.startedGroups.length === 1 ? '' : '\n')
    const index = this.startedGroups.length
    const label = this.groups.length ? `[${index}/${this.groups.length}]` : `[${index}]`
    process.stdout.write(`${color(' FILE ', ANSI.bold, ANSI.black, ANSI.bgCyan)} ${color(label, ANSI.cyan)} ${name}\n`)
  }

  finishGroup(name: string): void {
    if (this.finishedGroups.has(name)) return
    this.finishedGroups.add(name)
    const startedAt = this.groupStartedAt.get(name)
    if (startedAt == null) return
    const elapsedMs = Date.now() - startedAt
    process.stdout.write(`${color('   File ', ANSI.dim)} ${name} ${color(formatMs(elapsedMs), ANSI.dim)}\n`)
  }

  async run<T>(groupName: string, name: string, fn: () => Promise<T>): Promise<T | null> {
    const index = (this.testCounts.get(groupName) || 0) + 1
    this.testCounts.set(groupName, index)
    process.stdout.write(`  ${color(' RUN ', ANSI.bold, ANSI.black, ANSI.bgCyan)} ${color(`[${index}]`, ANSI.cyan)} ${name}\n`)
    const testStartedAt = Date.now()
    const timings: TimingEvent[] = []
    setActiveTimingSink(timings)
    try {
      const value = await fn()
      const elapsedMs = Date.now() - testStartedAt
      this.results.push({ groupName, name, status: 'passed', elapsedMs, timings })
      process.stdout.write(`  ${color(' PASS ', ANSI.bold, ANSI.green)} ${name} ${color(formatMs(elapsedMs), ANSI.dim)}\n`)
      this.printSlowTimings(timings)
      return value
    } catch (error) {
      const elapsedMs = Date.now() - testStartedAt
      if (error instanceof SkipError) {
        this.results.push({ groupName, name, status: 'skipped', elapsedMs, timings })
        process.stdout.write(
          `  ${color(' SKIP ', ANSI.bold, ANSI.yellow)} ${name} ${color(error.message, ANSI.dim)} ${color(formatMs(elapsedMs), ANSI.dim)}\n`,
        )
        this.printSlowTimings(timings)
        return null
      }
      this.results.push({ groupName, name, status: 'failed', elapsedMs, timings })
      process.stdout.write(`  ${color(' FAIL ', ANSI.bold, ANSI.red)} ${name} ${color(formatMs(elapsedMs), ANSI.dim)}\n`)
      this.printSlowTimings(timings)
      throw error
    } finally {
      setActiveTimingSink(null)
    }
  }

  private printSlowTimings(timings: TimingEvent[]): void {
    if (!timingLogsEnabled) return
    const slow = [...timings]
      .filter((timing) => timing.elapsedMs >= 250)
      .sort((a, b) => b.elapsedMs - a.elapsedMs)
      .slice(0, 5)
    for (const timing of slow) {
      const attempts = timing.attempts && timing.attempts > 1 ? ` attempts ${timing.attempts}` : ''
      const status = timing.kind === 'wait' && timing.status ? ` ${timing.status}` : ''
      process.stdout.write(
        `${color('   Time ', ANSI.dim)} ${timing.kind}${status} :: ${timing.label} ${color(`${formatMs(timing.elapsedMs)}${attempts}`, ANSI.dim)}\n`,
      )
    }
  }

  timingSummary() {
    const tests = this.results.map((result) => ({
      group_name: result.groupName,
      test_name: result.name,
      status: result.status,
      elapsed_ms: result.elapsedMs,
      timings: result.timings,
      slowest_timing:
        [...result.timings].sort((a, b) => b.elapsedMs - a.elapsedMs)[0] ?? null,
    }))
    const slowest = tests
      .flatMap((test) =>
        test.timings.map((timing) => ({
          group_name: test.group_name,
          test_name: test.test_name,
          ...timing,
        })),
      )
      .sort((a, b) => b.elapsedMs - a.elapsedMs)
      .slice(0, 20)
    return { tests, slowest }
  }

  printSummary(): void {
    const fileStats = new Map(this.groups.map((groupName) => [groupName, { failed: false, ran: false }]))
    for (const result of this.results) {
      const stats = fileStats.get(result.groupName) || { failed: false, ran: false }
      stats.ran = true
      if (result.status === 'failed') stats.failed = true
      fileStats.set(result.groupName, stats)
    }
    const passedFiles = [...fileStats.values()].filter((stats) => stats.ran && !stats.failed).length
    const failedFiles = [...fileStats.values()].filter((stats) => stats.failed).length
    const passed = this.results.filter((result) => result.status === 'passed').length
    const failed = this.results.filter((result) => result.status === 'failed').length
    const skipped = this.results.filter((result) => result.status === 'skipped').length
    const elapsedMs = Date.now() - this.startedAt
    process.stdout.write('\n')
    process.stdout.write(
      `${color(' Test Files ', ANSI.dim)} ${color(`${passedFiles}/${this.groups.length || 1} passed`, ANSI.bold, failedFiles === 0 ? ANSI.green : ANSI.red)}\n`,
    )
    process.stdout.write(
      `${color('      Tests ', ANSI.dim)} ${color(`${passed} passed`, ANSI.bold, ANSI.green)}${skipped ? ` ${color(`${skipped} skipped`, ANSI.bold, ANSI.yellow)}` : ''}${failed ? ` ${color(`${failed} failed`, ANSI.bold, ANSI.red)}` : ''}\n`,
    )
    process.stdout.write(`${color('   Duration ', ANSI.dim)} ${color(formatMs(elapsedMs), ANSI.bold)}\n`)
  }
}

export class SkipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkipError'
  }
}

export function defineGroup(importMetaUrl: string, register: (api: { test: (name: string, run: (context: TestContext) => Promise<void>) => void }) => void): TestGroup {
  const tests: TestEntry[] = []
  register({
    test(name, run) {
      tests.push({ name, run })
    },
  })
  return {
    name: path.basename(fileURLToPath(importMetaUrl)),
    tests,
  }
}

export function color(text: string, ...codes: string[]): string {
  return `${codes.join('')}${text}${ANSI.reset}`
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function testLabel(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function createReporter(groups: string[]): Reporter {
  return new Reporter(groups)
}

export function printNote(message: string): void {
  process.stdout.write(`${color('    Note ', ANSI.dim)} ${message}\n`)
}

export type TimingMarks = {
  mark: (label: string) => void
  step: <T>(label: string, fn: () => Promise<T>) => Promise<T>
}

export function createTimingMarks(name: string): TimingMarks {
  const startedAt = Date.now()
  let lastAt = startedAt
  const mark = (label: string) => {
    const now = Date.now()
    const deltaMs = now - lastAt
    const totalMs = now - startedAt
    lastAt = now
    if (timingLogsEnabled) {
      process.stdout.write(
        `${color('   Time ', ANSI.dim)} ${name} :: ${label} ${color(`+${formatMs(deltaMs)} total ${formatMs(totalMs)}`, ANSI.dim)}\n`,
      )
    }
    recordTimingEvent({
      kind: 'mark',
      label: `${name} :: ${label}`,
      elapsedMs: deltaMs,
      totalMs,
    })
  }
  const step = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const stepStartedAt = Date.now()
    const value = await fn()
    const elapsedMs = Date.now() - stepStartedAt
    recordTimingEvent({
      kind: 'step',
      label: `${name} :: ${label}`,
      elapsedMs,
      totalMs: Date.now() - startedAt,
      status: 'passed',
    })
    mark(label)
    return value
  }
  return { mark, step }
}

export function createState(base: string): E2eState {
  return {
    base,
    knownWindowIds: new Set(),
    spawnedNativeWindowIds: new Set(),
    nativeLaunchByWindowId: new Map(),
    desktopApps: [],
    redSpawn: null,
    greenSpawn: null,
    crashProbe: null,
    spawnedShellWindowIds: new Set(),
    launcherWindowId: null,
    screenshot: null,
    multiMonitorNativeMove: null,
    multiMonitorShellMove: null,
    tiledOutput: null,
  }
}

function syncTrackedNativeWindow(
  compositor: CompositorSnapshot,
  current: NativeSpawnResult | null,
  title: string,
): NativeSpawnResult | null {
  if (!current) return null
  const window = compositorWindowById(compositor, current.window.window_id)
  if (!window || window.title !== title || window.app_id !== NATIVE_APP_ID || window.shell_hosted) {
    return null
  }
  return { snapshot: compositor, window, command: current.command }
}

export async function normalizeTransientShellState(base: string): Promise<ShellSnapshot> {
  let { shell, compositor } = await getSnapshots(base)
  const transientShellStateCleared = (shellSnapshot: ShellSnapshot, compositorSnapshot: CompositorSnapshot) =>
    !shellSnapshot.programs_menu_open &&
    !shellSnapshot.power_menu_open &&
    !shellSnapshot.snap_picker_open &&
    compositorSnapshot.shell_pointer_grab_window_id == null &&
    compositorSnapshot.shell_move_window_id == null &&
    compositorSnapshot.shell_resize_window_id == null
  for (let attempt = 0; attempt < 6; attempt++) {
    if (transientShellStateCleared(shell, compositor)) {
      return shell
    }
    await tapKey(base, KEY.escape)
    try {
      await pointerButton(base, BTN_LEFT, 'release')
    } catch {}
    try {
      await pointerButton(base, BTN_RIGHT, 'release')
    } catch {}
    try {
      const cleared = await waitFor(
        'wait for transient shell state to clear',
        async () => {
          const next = await getSnapshots(base)
          return transientShellStateCleared(next.shell, next.compositor) ? next : null
        },
        1500,
        50,
      )
      shell = cleared.shell
      compositor = cleared.compositor
    } catch {
      ;({ shell, compositor } = await getSnapshots(base))
    }
  }
  if (!transientShellStateCleared(shell, compositor)) {
    throw new Error('failed to clear transient shell state')
  }
  return shell
}

export async function normalizePersistentShellState(base: string): Promise<ShellSnapshot> {
  let shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const persistentShellWindowIds = new Set<number>([
    SHELL_UI_DEBUG_WINDOW_ID,
    SHELL_UI_SETTINGS_WINDOW_ID,
    ...shell.windows
      .filter(
        (window) =>
          window.shell_hosted &&
          !window.minimized &&
          window.window_id !== SHELL_UI_DEBUG_WINDOW_ID &&
          window.window_id !== SHELL_UI_SETTINGS_WINDOW_ID,
      )
      .map((window) => window.window_id),
  ])
  for (const windowId of persistentShellWindowIds) {
    shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    const shellWindow = shellWindowById(shell, windowId)
    if (!shellWindow || shellWindow.minimized) continue
    if (taskbarEntry(shell, windowId)?.close) {
      await closeTaskbarWindow(base, shell, windowId)
    } else {
      await closeWindow(base, windowId)
    }
    await waitForWindowGone(base, windowId, 2000)
  }
  return getJson<ShellSnapshot>(base, '/test/state/shell')
}

export async function ensureDesktopApps(base: string, state: E2eState): Promise<DesktopAppEntry[]> {
  if (state.desktopApps.length > 0) return state.desktopApps
  const desktopApplications = await getJson<{ apps?: DesktopAppEntry[] }>(base, '/desktop_applications')
  state.desktopApps = Array.isArray(desktopApplications?.apps) ? desktopApplications.apps : []
  return state.desktopApps
}

function syncTrackedWindows(state: E2eState, compositor: CompositorSnapshot): void {
  state.knownWindowIds = new Set(compositor.windows.map((window) => window.window_id))
  state.redSpawn = syncTrackedNativeWindow(compositor, state.redSpawn, RED_NATIVE_TITLE)
  state.greenSpawn = syncTrackedNativeWindow(compositor, state.greenSpawn, GREEN_NATIVE_TITLE)
  state.crashProbe = syncTrackedNativeWindow(compositor, state.crashProbe, CRASH_NATIVE_TITLE)
  if (state.launcherWindowId !== null && !compositorWindowById(compositor, state.launcherWindowId)) {
    state.launcherWindowId = null
  }
}

export async function primeState(base: string, state: E2eState): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot }> {
  await cleanupNativeWindows(base, state.spawnedNativeWindowIds)
  await cleanupShellWindows(base, [...state.spawnedShellWindowIds])
  state.spawnedShellWindowIds.clear()
  let recovered = false
  let shell: ShellSnapshot
  for (;;) {
    await normalizeTransientShellState(base)
    shell = await normalizePersistentShellState(base)
    try {
      await openSettings(base, 'click')
      await cleanupShellWindows(base, [SHELL_UI_SETTINGS_WINDOW_ID])
      shell = await normalizePersistentShellState(base)
      break
    } catch (error) {
      if (recovered) {
        throw new Error(
          `primeState: failed to normalize settings window after session restart: ${
            error instanceof Error ? error.stack || error.message : String(error)
          }`,
        )
      }
      await restartSession(state)
      base = state.base
      recovered = true
    }
  }
  const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
  syncTrackedWindows(state, compositor)
  for (const windowId of [...state.nativeLaunchByWindowId.keys()]) {
    if (!state.knownWindowIds.has(windowId)) {
      state.nativeLaunchByWindowId.delete(windowId)
    }
  }
  await ensureDesktopApps(base, state)
  return { compositor, shell }
}

export function stateHome(): string {
  if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME
  const home = process.env.HOME
  if (!home) throw new Error('HOME is unset')
  return path.join(home, '.local', 'state')
}

export function runtimeDir(): string {
  return process.env.XDG_RUNTIME_DIR || '/tmp'
}

export function artifactDir(): string {
  return process.env.DERP_E2E_ARTIFACT_DIR || path.join(stateHome(), 'derp', 'e2e', 'artifacts')
}

export async function ensureArtifactDir(): Promise<string> {
  const dir = artifactDir()
  await mkdir(dir, { recursive: true })
  return dir
}

export function artifactPath(name: string): string {
  return path.join(artifactDir(), `${Date.now()}-${name}`)
}

export async function discoverBase(): Promise<string> {
  if (process.env.DERP_E2E_BASE) return process.env.DERP_E2E_BASE.replace(/\/$/, '')
  const urlFile = process.env.DERP_SHELL_HTTP_URL_FILE || path.join(runtimeDir(), 'derp-shell-http-url')
  const base = (await readFile(urlFile, 'utf8')).trim()
  if (!base.startsWith('http://127.0.0.1:')) {
    throw new Error(`unexpected shell HTTP base in ${urlFile}: ${base}`)
  }
  return base.replace(/\/$/, '')
}

export async function discoverReadyBase(timeoutMs = 30000): Promise<string> {
  return waitFor(
    'wait for shell http base',
    async () => {
      const base = await discoverBase()
      try {
        await Promise.all([getJson<CompositorSnapshot>(base, '/test/state/compositor'), getJson<ShellSnapshot>(base, '/test/state/shell')])
        return base
      } catch {
        return null
      }
    },
    timeoutMs,
    250,
  )
}

export async function restartSession(state: E2eState, timeoutMs = 45000): Promise<string> {
  const currentBase = state.base
  const compositor = await getJson<CompositorSnapshot>(currentBase, '/test/state/compositor')
  const shell = await getJson<ShellSnapshot>(currentBase, '/test/state/shell')
  const liveLaunchKeys = new Map<string, string>()
  for (const window of compositor.windows) {
    const command = state.nativeLaunchByWindowId.get(window.window_id)
    if (!command) continue
    liveLaunchKeys.set(
      JSON.stringify({
        title: window.title,
        appId: window.app_id,
        outputName: window.output_name,
        x: window.x,
        y: window.y,
        width: window.width,
        height: window.height,
      }),
      command,
    )
  }
  const shellSessionSnapshot =
    shell.session_snapshot && !shell.session_snapshot_error ? structuredClone(shell.session_snapshot) : null
  const nativeWindows = Array.isArray(shellSessionSnapshot?.nativeWindows) ? shellSessionSnapshot.nativeWindows : null
  if (nativeWindows) {
    for (const entry of nativeWindows) {
      if (!entry || typeof entry !== 'object') continue
      const row = entry as Record<string, unknown>
      if (row.launch && typeof row.launch === 'object') continue
      const bounds = row.bounds && typeof row.bounds === 'object' ? (row.bounds as Record<string, unknown>) : {}
      const command = liveLaunchKeys.get(
        JSON.stringify({
          title: row.title,
          appId: row.appId,
          outputName: row.outputName,
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        }),
      )
      if (!command) continue
      row.launch = {
        command,
        desktopId: null,
        appName: null,
      }
    }
  }
  const body =
    shellSessionSnapshot
      ? {
          version: 1,
          shell: shellSessionSnapshot,
        }
      : {}
  await postJson(currentBase, '/session_reload', body)
  await waitFor(
    'wait for shell http restart',
    async () => {
      try {
        await getJson<CompositorSnapshot>(currentBase, '/test/state/compositor')
        return null
      } catch {
        return true
      }
    },
    15000,
    250,
  )
  const nextBase = await discoverReadyBase(timeoutMs)
  state.base = nextBase
  state.knownWindowIds = new Set()
  return nextBase
}

export async function getJson<T = any>(base: string, requestPath: string): Promise<T> {
  const res = await fetch(`${base}${requestPath}`)
  const text = await res.text()
  if (!res.ok) throw new Error(`GET ${requestPath} failed (${res.status}): ${text}`)
  return JSON.parse(text) as T
}

export async function getText(base: string, requestPath: string): Promise<string> {
  const res = await fetch(`${base}${requestPath}`)
  const text = await res.text()
  if (!res.ok) throw new Error(`GET ${requestPath} failed (${res.status}): ${text}`)
  return text
}

export async function getPerfCounters(base: string): Promise<PerfCounterSnapshot> {
  return getJson<PerfCounterSnapshot>(base, '/test/perf')
}

export async function postJson<T = any>(base: string, requestPath: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${requestPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`POST ${requestPath} failed (${res.status}): ${text}`)
  if (!text) return null as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as T
  }
}

export async function resetPerfCounters(base: string): Promise<void> {
  await postJson(base, '/test/perf/reset', {})
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function rectCenter(rect: Rect): { x: number; y: number } {
  return {
    x: rect.global_x + rect.width / 2,
    y: rect.global_y + rect.height / 2,
  }
}

export function pointInRect(rect: Rect | null | undefined, point: { x: number; y: number }): boolean {
  if (!rect) return false
  return (
    point.x >= rect.global_x &&
    point.x <= rect.global_x + rect.width &&
    point.y >= rect.global_y &&
    point.y <= rect.global_y + rect.height
  )
}

export function approxEqual(actual: number, expected: number, tolerance: number, label: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected} +/- ${tolerance}, got ${actual}`)
  }
}

function waitIntervalMs(intervalMs: number, attempts: number): number {
  if (intervalMs <= 16) return intervalMs
  if (attempts <= 1) return Math.min(intervalMs, 16)
  if (attempts === 2) return Math.min(intervalMs, 32)
  if (attempts === 3) return Math.min(intervalMs, 64)
  return intervalMs
}

export async function waitFor<T>(description: string, fn: () => Promise<T | null>, timeoutMs = 5000, intervalMs = 100): Promise<T> {
  const started = Date.now()
  let lastError: unknown = null
  let attempts = 0
  while (Date.now() - started < timeoutMs) {
    attempts += 1
    try {
      const value = await fn()
      if (value) {
        recordTimingEvent({
          kind: 'wait',
          label: description,
          elapsedMs: Date.now() - started,
          attempts,
          status: 'passed',
        })
        return value
      }
    } catch (error) {
      lastError = error
    }
    const remainingMs = timeoutMs - (Date.now() - started)
    if (remainingMs <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(remainingMs, waitIntervalMs(intervalMs, attempts))))
  }
  recordTimingEvent({
    kind: 'wait',
    label: description,
    elapsedMs: Date.now() - started,
    attempts,
    status: lastError ? 'errored' : 'timed_out',
  })
  if (lastError) {
    throw new Error(`${description}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }
  throw new Error(`${description}: timed out after ${timeoutMs}ms`)
}

export async function writeJsonArtifact(name: string, value: unknown): Promise<string> {
  const filePath = artifactPath(name)
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
  return filePath
}

export async function writeTextArtifact(name: string, value: string): Promise<string> {
  const filePath = artifactPath(name)
  await writeFile(filePath, value)
  return filePath
}

export async function captureFailureArtifacts(base: string, label: string): Promise<void> {
  try {
    const [compositor, shell, html] = await Promise.all([
      getJson<CompositorSnapshot>(base, '/test/state/compositor'),
      getJson<ShellSnapshot>(base, '/test/state/shell'),
      getText(base, '/test/state/html'),
    ])
    await writeJsonArtifact(`${label}-compositor.json`, compositor)
    await writeJsonArtifact(`${label}-shell.json`, shell)
    await writeTextArtifact(`${label}-shell.html`, html)
  } catch (error) {
    await writeTextArtifact(
      `${label}-artifact-error.txt`,
      error instanceof Error ? `${error.stack || error.message}\n` : `${String(error)}\n`,
    )
  }
}

export async function clickRect(base: string, rect: Rect): Promise<void> {
  const point = rectCenter(rect)
  await clickPoint(base, point.x, point.y)
}

export async function rightClickPoint(base: string, x: number, y: number): Promise<void> {
  await postJson(base, '/test/input/click', { x, y, button: BTN_RIGHT })
}

export async function rightClickRect(base: string, rect: Rect): Promise<void> {
  const point = rectCenter(rect)
  await rightClickPoint(base, point.x, point.y)
}

export function assertRectMinSize(
  label: string,
  rect: Rect | null | undefined,
  minWidth: number,
  minHeight = minWidth,
): Rect {
  assert(rect, `${label}: missing rect`)
  if (rect.width < minWidth || rect.height < minHeight) {
    throw new Error(
      `${label}: suspiciously small target ${rect.width}x${rect.height} at ${rect.global_x},${rect.global_y}; expected at least ${minWidth}x${minHeight}`,
    )
  }
  return rect
}

export async function clickPoint(base: string, x: number, y: number): Promise<void> {
  await postJson(base, '/test/input/click', { x, y, button: BTN_LEFT })
}

export async function movePoint(base: string, x: number, y: number): Promise<void> {
  await postJson(base, '/test/input/pointer_move', { x, y })
}

export async function pointerWheel(base: string, deltaX: number, deltaY: number): Promise<void> {
  await postJson(base, '/test/input/pointer_wheel', { delta_x: deltaX, delta_y: deltaY })
}

export async function pointerButton(base: string, button: number, action: 'press' | 'release'): Promise<void> {
  await postJson(base, '/test/input/pointer_button', { button, action })
}

export async function dragBetweenPoints(base: string, x0: number, y0: number, x1: number, y1: number, steps = 12): Promise<void> {
  await postJson(base, '/test/input/drag', { x0, y0, x1, y1, button: BTN_LEFT, steps })
}

export async function dragRectToRect(base: string, from: Rect, to: Rect, steps = 16): Promise<void> {
  const start = rectCenter(from)
  const end = rectCenter(to)
  await dragBetweenPoints(base, start.x, start.y, end.x, end.y, steps)
}

export async function tapKey(base: string, keycode: number): Promise<void> {
  await postJson(base, '/test/input/key', { keycode, action: 'tap' })
}

export async function typeText(base: string, text: string): Promise<void> {
  const keycodes: number[] = []
  for (const char of text.toLowerCase()) {
    const keycode = KEY[char as keyof typeof KEY]
    if (keycode === undefined) throw new Error(`unsupported text input character: ${char}`)
    keycodes.push(keycode)
  }
  if (keycodes.length === 0) {
    return
  }
  await postJson(base, '/test/input/keys', { keycodes, action: 'tap' })
}

export async function runKeybind(base: string, action: string): Promise<void> {
  await postJson(base, '/test/keybind', { action })
}

export function findWindow(snapshot: { windows: WindowSnapshot[] }, predicate: (window: WindowSnapshot) => boolean): WindowSnapshot | null {
  return snapshot.windows.find((window) => predicate(window)) || null
}

export function compositorWindowById(snapshot: { windows: WindowSnapshot[] }, windowId: number): WindowSnapshot | null {
  return findWindow(snapshot, (window) => window.window_id === windowId)
}

export function shellWindowById(snapshot: { windows: WindowSnapshot[] }, windowId: number): WindowSnapshot | null {
  return findWindow(snapshot, (window) => window.window_id === windowId)
}

export function taskbarEntry(shellSnapshot: ShellSnapshot, windowId: number): ShellTaskbarWindow | null {
  return shellSnapshot.taskbar_windows.find((entry) => entry.window_id === windowId) || null
}

export function tabGroupByWindow(shellSnapshot: ShellSnapshot, windowId: number): ShellTabGroup | null {
  return shellSnapshot.tab_groups?.find((group) => group.member_window_ids.includes(windowId)) || null
}

export function tabGroupById(shellSnapshot: ShellSnapshot, groupId: string): ShellTabGroup | null {
  return shellSnapshot.tab_groups?.find((group) => group.group_id === groupId) || null
}

export function windowControls(shellSnapshot: ShellSnapshot, windowId: number): ShellWindowControls | null {
  return shellSnapshot.window_controls?.find((entry) => entry.window_id === windowId) || null
}

export function taskbarForMonitor(shellSnapshot: ShellSnapshot, monitorName: string): ShellTaskbar | null {
  return shellSnapshot.taskbars.find((taskbar) => taskbar.monitor === monitorName) || null
}

export function outputForWindow(snapshot: CompositorSnapshot, window: WindowSnapshot): OutputSnapshot | null {
  return snapshot.outputs.find((output) => output.name === window.output_name) || null
}

export function shellWindowStack(shellSnapshot: ShellSnapshot): number[] {
  if (Array.isArray(shellSnapshot.window_stack_order) && shellSnapshot.window_stack_order.length > 0) {
    return shellSnapshot.window_stack_order
  }
  return [...shellSnapshot.windows]
    .sort((a, b) => (b.stack_z || 0) - (a.stack_z || 0) || b.window_id - a.window_id)
    .map((window) => window.window_id)
}

export function compositorWindowStack(compositorSnapshot: CompositorSnapshot): number[] {
  if (Array.isArray(compositorSnapshot.window_stack_order) && compositorSnapshot.window_stack_order.length > 0) {
    return compositorSnapshot.window_stack_order
  }
  return [...compositorSnapshot.windows]
    .sort((a, b) => (b.stack_z || 0) - (a.stack_z || 0) || b.window_id - a.window_id)
    .map((window) => window.window_id)
}

export function topShellWindowId(shellSnapshot: ShellSnapshot): number | null {
  return shellWindowStack(shellSnapshot)[0] ?? null
}

export function assertTopWindow(shellSnapshot: ShellSnapshot, windowId: number, label: string): void {
  const top = topShellWindowId(shellSnapshot)
  if (top !== windowId) {
    throw new Error(`${label}: expected top window ${windowId}, got ${top}`)
  }
}

export function assertTaskbarRowOnMonitor(shellSnapshot: ShellSnapshot, windowId: number, monitorName: string): void {
  const row = taskbarEntry(shellSnapshot, windowId)
  const taskbar = taskbarForMonitor(shellSnapshot, monitorName)
  assert(row?.activate, `missing taskbar activate rect for window ${windowId}`)
  assert(taskbar?.rect, `missing taskbar rect for monitor ${monitorName}`)
  const center = rectCenter(row.activate)
  if (!pointInRect(taskbar.rect, center)) {
    throw new Error(`window ${windowId} taskbar row is not on monitor ${monitorName}`)
  }
}

export function assertWindowTiled(window: WindowSnapshot, output: OutputSnapshot | null, taskbarRect: Rect | null | undefined, side: 'left' | 'right'): void {
  assert(output, `missing output for window ${window.window_id}`)
  assert(taskbarRect, `missing taskbar for output ${window.output_name}`)
  const workX = output.x
  const workWidth = output.width
  const workBottom = taskbarRect.global_y
  const expectedHalfWidth = Math.floor(workWidth / 2)
  const expectedX = side === 'left' ? workX : workX + expectedHalfWidth
  approxEqual(window.x, expectedX, 8, `${side} window x`)
  approxEqual(window.width, expectedHalfWidth, 12, `${side} window width`)
  assert(window.y >= output.y && window.y <= output.y + 80, `${side} window y: expected top inset within 80px, got ${window.y}`)
  approxEqual(window.y + window.height, workBottom, 12, `${side} window bottom`)
}

export async function getSnapshots(base: string): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot }> {
  const [compositor, shell] = await Promise.all([
    getJson<CompositorSnapshot>(base, '/test/state/compositor'),
    getJson<ShellSnapshot>(base, '/test/state/shell'),
  ])
  return { compositor, shell }
}

export async function getShellHtml(base: string, selector?: string): Promise<string> {
  const suffix = selector ? `?selector=${encodeURIComponent(selector)}` : ''
  return getText(base, `/test/state/html${suffix}`)
}

export async function activateTaskbarWindow(base: string, shellSnapshot: ShellSnapshot, windowId: number): Promise<void> {
  const row = taskbarEntry(shellSnapshot, windowId)
  assert(row?.activate, `missing taskbar activate control for window ${windowId}`)
  await clickRect(base, row.activate)
}

export async function closeTaskbarWindow(base: string, shellSnapshot: ShellSnapshot, windowId: number): Promise<void> {
  let shell = shellSnapshot
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = taskbarEntry(shell, windowId)
    assert(row?.close, `missing taskbar close control for window ${windowId}`)
    await clickRect(base, row.close)
    try {
      await waitForWindowGone(base, windowId, 600)
      return
    } catch {}
    shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  }
}

export async function closeWindow(base: string, windowId: number): Promise<void> {
  await postJson(base, '/test/window/close', { window_id: windowId })
}

export async function crashWindow(base: string, windowId: number): Promise<void> {
  await postJson(base, '/test/window/crash', { window_id: windowId })
}

export async function waitForWindowGone(base: string, windowId: number, timeoutMs = 6000): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot }> {
  return waitFor(
    `wait for window ${windowId} gone`,
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const compositorHas = compositor.windows.some((window) => window.window_id === windowId)
      const shellHas = shell.windows.some((window) => window.window_id === windowId) || shell.taskbar_windows.some((entry) => entry.window_id === windowId)
      return compositorHas || shellHas ? null : { compositor, shell }
    },
    timeoutMs,
    125,
  )
}

export async function waitForWindowMinimized(base: string, windowId: number, timeoutMs = 5000): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot }> {
  return waitFor(
    `wait for window ${windowId} minimized`,
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const compositorWindow = compositorWindowById(compositor, windowId)
      const shellWindow = shellWindowById(shell, windowId)
      if (!compositorWindow || !shellWindow) return null
      return compositorWindow.minimized && shellWindow.minimized ? { compositor, shell } : null
    },
    timeoutMs,
    125,
  )
}

export async function waitForWindowRaised(
  base: string,
  windowId: number,
  timeoutMs = 5000,
): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot; window: WindowSnapshot }> {
  return waitFor(
    `wait for window ${windowId} raised`,
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const compositorWindow = compositorWindowById(compositor, windowId)
      const shellWindow = shellWindowById(shell, windowId)
      if (!compositorWindow || !shellWindow || shellWindow.minimized || compositorWindow.minimized) return null
      try {
        assertTopWindow(shell, windowId, `window ${windowId} raised`)
      } catch {
        return null
      }
      return { compositor, shell, window: shellWindow }
    },
    timeoutMs,
    100,
  )
}

export async function waitForNativeFocus(base: string, windowId: number, timeoutMs = 5000): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot }> {
  return waitFor(
    `wait for native focus ${windowId}`,
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      if (compositor.focused_window_id !== windowId) return null
      assertTopWindow(shell, windowId, `native focus ${windowId}`)
      return { compositor, shell }
    },
    timeoutMs,
    100,
  )
}

export async function waitForShellUiFocus(base: string, windowId: number, timeoutMs = 5000): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot }> {
  return waitFor(
    `wait for shell ui focus ${windowId}`,
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      if (compositor.focused_shell_ui_window_id !== windowId) return null
      assertTopWindow(shell, windowId, `shell focus ${windowId}`)
      return { compositor, shell }
    },
    timeoutMs,
    100,
  )
}

export async function waitForSettingsVisible(base: string, timeoutMs = 5000): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot; window: WindowSnapshot }> {
  return waitFor(
    'wait for settings window',
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const window = shellWindowById(shell, SHELL_UI_SETTINGS_WINDOW_ID)
      if (!shell.settings_window_visible || !window || window.minimized) return null
      return { compositor, shell, window }
    },
    timeoutMs,
    100,
  )
}

export async function waitForDebugVisible(base: string, timeoutMs = 5000): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot; window: WindowSnapshot }> {
  return waitFor(
    'wait for debug window',
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const window = shellWindowById(shell, SHELL_UI_DEBUG_WINDOW_ID)
      if (!shell.debug_window_visible || !window || window.minimized) return null
      return { compositor, shell, window }
    },
    timeoutMs,
    100,
  )
}

export async function waitForProgramsMenuOpen(base: string, timeoutMs = 5000): Promise<ShellSnapshot> {
  return waitFor(
    'wait for programs menu open',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return shell.programs_menu_open && shell.controls?.programs_menu_search ? shell : null
    },
    timeoutMs,
    100,
  )
}

export async function waitForProgramsMenuClosed(base: string, timeoutMs = 5000): Promise<ShellSnapshot> {
  return waitFor(
    'wait for programs menu closed',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return shell.programs_menu_open ? null : shell
    },
    timeoutMs,
    100,
  )
}

export async function waitForPowerMenuOpen(base: string, timeoutMs = 5000): Promise<ShellSnapshot> {
  return waitFor(
    'wait for power menu open',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return shell.power_menu_open && shell.controls?.power_menu_save_session ? shell : null
    },
    timeoutMs,
    100,
  )
}

export async function waitForPowerMenuClosed(base: string, timeoutMs = 5000): Promise<ShellSnapshot> {
  return waitFor(
    'wait for power menu closed',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return shell.power_menu_open ? null : shell
    },
    timeoutMs,
    100,
  )
}

export async function waitForVolumeMenuOpen(base: string, timeoutMs = 5000): Promise<ShellSnapshot> {
  return waitFor(
    'wait for volume menu open',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return shell.volume_menu_open && shell.controls?.volume_menu_panel ? shell : null
    },
    timeoutMs,
    100,
  )
}

export async function waitForVolumeMenuClosed(base: string, timeoutMs = 5000): Promise<ShellSnapshot> {
  return waitFor(
    'wait for volume menu closed',
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return shell.volume_menu_open ? null : shell
    },
    timeoutMs,
    100,
  )
}

export async function openSettings(base: string, method: 'click' | 'keybind' = 'click'): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot; window: WindowSnapshot }> {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  if (shell.settings_window_visible && shellWindowById(shell, SHELL_UI_SETTINGS_WINDOW_ID)?.minimized !== true) {
    try {
      await waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID, 150)
    } catch {
      await activateTaskbarWindow(base, shell, SHELL_UI_SETTINGS_WINDOW_ID)
      return waitForWindowRaised(base, SHELL_UI_SETTINGS_WINDOW_ID)
    }
    return waitForSettingsVisible(base)
  }
  if (method === 'keybind') {
    await runKeybind(base, 'open_settings')
  } else {
    assert(shell.controls?.taskbar_settings_toggle, 'missing taskbar settings toggle')
    await clickRect(base, shell.controls.taskbar_settings_toggle)
  }
  return waitForWindowRaised(base, SHELL_UI_SETTINGS_WINDOW_ID)
}

export async function openDebug(base: string): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot; window: WindowSnapshot }> {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  if (shell.debug_window_visible && shellWindowById(shell, SHELL_UI_DEBUG_WINDOW_ID)?.minimized !== true) {
    try {
      await waitForShellUiFocus(base, SHELL_UI_DEBUG_WINDOW_ID, 150)
    } catch {
      await activateTaskbarWindow(base, shell, SHELL_UI_DEBUG_WINDOW_ID)
      return waitForWindowRaised(base, SHELL_UI_DEBUG_WINDOW_ID)
    }
    return waitForDebugVisible(base)
  }
  assert(shell.controls?.taskbar_debug_toggle, 'missing taskbar debug toggle')
  await clickRect(base, shell.controls.taskbar_debug_toggle)
  return waitForWindowRaised(base, SHELL_UI_DEBUG_WINDOW_ID)
}

export async function openShellTestWindow(
  base: string,
  state: E2eState,
): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot; window: WindowSnapshot }> {
  const before = await getSnapshots(base)
  const visibleShellTestWindowIds = new Set(
    before.shell.windows
      .filter((entry) => entry.shell_hosted && entry.app_id === SHELL_TEST_APP_ID && !entry.minimized)
      .map((entry) => entry.window_id),
  )
  await postJson(base, '/test/shell_window/open', {})
  const result = await waitFor(
    'wait for shell test window',
    async () => {
      const { compositor, shell } = await getSnapshots(base)
      const window = shell.windows.find(
        (entry) =>
          entry.shell_hosted &&
          entry.app_id === SHELL_TEST_APP_ID &&
          !entry.minimized &&
          !visibleShellTestWindowIds.has(entry.window_id),
      )
      return window ? { compositor, shell, window } : null
    },
    8000,
    125,
  )
  state.spawnedShellWindowIds.add(result.window.window_id)
  state.knownWindowIds.add(result.window.window_id)
  return result
}

export async function prepareFileBrowserFixtures(base: string): Promise<FileBrowserFixturePaths> {
  return postJson<FileBrowserFixturePaths>(base, '/test/file_browser_fixtures/prepare', {})
}

export async function resetFileBrowserFixtures(base: string): Promise<FileBrowserFixturePaths> {
  return postJson<FileBrowserFixturePaths>(base, '/test/file_browser_fixtures/reset', {})
}

export async function openProgramsMenu(base: string, method: 'click' | 'keybind' = 'click'): Promise<ShellSnapshot> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    if (shell.programs_menu_open) return waitForProgramsMenuOpen(base)
    const useKeybind = method === 'keybind' || attempt > 0
    if (useKeybind) {
      await runKeybind(base, 'toggle_programs_menu')
    } else {
      assert(shell.controls?.taskbar_programs_toggle, 'missing taskbar programs toggle')
      if (!shell.shell_keyboard_layout) {
        const center = rectCenter(shell.controls.taskbar_programs_toggle)
        await movePoint(base, center.x, center.y)
      }
      await clickRect(base, shell.controls.taskbar_programs_toggle)
    }
    try {
      return await waitForProgramsMenuOpen(base, 3000)
    } catch (error) {
      lastError = error
      if (attempt === 1) {
        try {
          await openSettings(base, 'click')
          await cleanupShellWindows(base, [SHELL_UI_SETTINGS_WINDOW_ID])
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  throw lastError
}

export async function openPowerMenu(base: string): Promise<ShellSnapshot> {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  if (shell.power_menu_open) return waitForPowerMenuOpen(base)
  assert(shell.controls?.taskbar_power_toggle, 'missing taskbar power toggle')
  await clickRect(base, shell.controls.taskbar_power_toggle)
  return waitForPowerMenuOpen(base)
}

export async function openVolumeMenu(base: string): Promise<ShellSnapshot> {
  const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
  if (shell.volume_menu_open) return waitForVolumeMenuOpen(base)
  assert(shell.controls?.taskbar_volume_toggle, 'missing taskbar volume toggle')
  await clickRect(base, shell.controls.taskbar_volume_toggle)
  return waitForVolumeMenuOpen(base)
}

export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`
}

export function nativeBin(): string {
  return process.env.DERP_E2E_NATIVE_BIN || 'target/release/derp-test-client'
}

export function buildNativeSpawnCommand({
  title,
  token,
  strip,
  width = 480,
  height = 320,
  dropBufferAfterDraw = false,
}: {
  title: string
  token: string
  strip: string
  width?: number
  height?: number
  dropBufferAfterDraw?: boolean
}): string {
  const parts = [
    nativeBin(),
    '--title',
    shellQuote(title),
    '--app-id',
    NATIVE_APP_ID,
    '--token',
    shellQuote(token),
    '--strip',
    shellQuote(strip),
    '--width',
    String(width),
    '--height',
    String(height),
  ]
  if (dropBufferAfterDraw) parts.push('--drop-buffer-after-draw')
  return parts.join(' ')
}

export async function spawnCommand(base: string, command: string): Promise<void> {
  await postJson(base, '/spawn', { command })
}

export async function spawnNativeWindow(
  base: string,
  knownWindowIds: Set<number>,
  {
    title,
    token,
    strip,
    width,
    height,
    dropBufferAfterDraw,
  }: { title: string; token: string; strip: string; width?: number; height?: number; dropBufferAfterDraw?: boolean },
): Promise<NativeSpawnResult> {
  const command = buildNativeSpawnCommand({ title, token, strip, width, height, dropBufferAfterDraw })
  await spawnCommand(base, command)
  return waitForSpawnedWindow(base, knownWindowIds, { title, appId: NATIVE_APP_ID, command })
}

export async function waitForSpawnedWindow(
  base: string,
  knownWindowIds: Set<number>,
  {
    title,
    appId,
    command,
    timeoutMs = 10000,
  }: { title: string; appId: string; command: string; timeoutMs?: number },
): Promise<NativeSpawnResult> {
  const result = await waitFor(
    `wait for ${title}`,
    async () => {
      const snapshot = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
      const window = findWindow(
        snapshot,
        (entry) =>
          !entry.shell_hosted &&
          !knownWindowIds.has(entry.window_id) &&
          entry.app_id === appId &&
          entry.title === title,
      )
      if (!window) return null
      return { snapshot, window, command }
    },
    timeoutMs,
    125,
  )
  knownWindowIds.add(result.window.window_id)
  return result
}

export async function spawnXtermCommandWindow(
  base: string,
  knownWindowIds: Set<number>,
  { title, command }: { title: string; command: string },
): Promise<NativeSpawnResult> {
  const fullCommand = ['xterm', '-T', shellQuote(title), '-class', shellQuote(X11_XTERM_APP_ID), '-e', 'sh', '-lc', shellQuote(command)].join(' ')
  await spawnCommand(base, fullCommand)
  return waitForSpawnedWindow(base, knownWindowIds, {
    title,
    appId: X11_XTERM_APP_ID,
    command: fullCommand,
  })
}

export async function spawnXtermWindow(base: string, knownWindowIds: Set<number>, title: string): Promise<NativeSpawnResult> {
  return spawnXtermCommandWindow(base, knownWindowIds, {
    title,
    command: 'exec sh -lc "while :; do sleep 60; done"',
  })
}

export async function ensureXtermWindow(base: string, state: E2eState, title: string): Promise<NativeSpawnResult> {
  syncTrackedWindows(state, await getJson<CompositorSnapshot>(base, '/test/state/compositor'))
  const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
  const matches = compositor.windows
    .filter((window) => !window.shell_hosted && window.title === title && window.app_id === X11_XTERM_APP_ID)
    .sort((a, b) => b.window_id - a.window_id)
  for (const existing of matches) {
    await closeWindowBestEffort(base, existing.window_id)
  }
  return spawnXtermWindow(base, state.knownWindowIds, title)
}

export async function waitForTaskbarEntry(base: string, windowId: number, timeoutMs = 8000): Promise<ShellSnapshot> {
  return waitFor(
    `wait for taskbar row ${windowId}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return taskbarEntry(shell, windowId) ? shell : null
    },
    timeoutMs,
    125,
  )
}

async function closeWindowBestEffort(base: string, windowId: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await closeWindow(base, windowId)
      await waitForWindowGone(base, windowId, 1200)
      return true
    } catch {}
    try {
      await crashWindow(base, windowId)
      await waitForWindowGone(base, windowId, 4000)
      return true
    } catch {}
  }
  return false
}

async function reuseNativeWindow(base: string, state: E2eState, title: string): Promise<NativeSpawnResult | null> {
  const compositor = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
  const matches = compositor.windows
    .filter((window) => !window.shell_hosted && window.app_id === NATIVE_APP_ID && window.title === title)
    .sort((a, b) => b.window_id - a.window_id)
  if (matches.length === 0) return null
  const keep = matches[0]
  for (const extra of matches.slice(1)) {
    await closeWindowBestEffort(base, extra.window_id)
  }
  state.knownWindowIds.add(keep.window_id)
  await waitForTaskbarEntry(base, keep.window_id)
  const snapshot = await getJson<CompositorSnapshot>(base, '/test/state/compositor')
  const window = compositorWindowById(snapshot, keep.window_id)
  if (!window) return null
  return { snapshot, window, command: 'existing' }
}

export async function ensureNativeWindow(
  base: string,
  state: E2eState,
  key: 'redSpawn' | 'greenSpawn' | 'crashProbe',
  options: { title: string; token: string; strip: string; width?: number; height?: number },
): Promise<NativeSpawnResult> {
  syncTrackedWindows(state, await getJson<CompositorSnapshot>(base, '/test/state/compositor'))
  const existing = state[key]
  if (existing) {
    state.spawnedNativeWindowIds.add(existing.window.window_id)
    await waitForTaskbarEntry(base, existing.window.window_id)
    return existing
  }
  const reused = await reuseNativeWindow(base, state, options.title)
  if (reused) {
    state[key] = reused
    state.spawnedNativeWindowIds.add(reused.window.window_id)
    return reused
  }
  const spawned = await spawnNativeWindow(base, state.knownWindowIds, options)
  state[key] = spawned
  state.spawnedNativeWindowIds.add(spawned.window.window_id)
  await waitForTaskbarEntry(base, spawned.window.window_id)
  return spawned
}

export async function ensureNativePair(base: string, state: E2eState): Promise<{ red: NativeSpawnResult; green: NativeSpawnResult }> {
  const red = await ensureNativeWindow(base, state, 'redSpawn', {
    title: RED_NATIVE_TITLE,
    token: 'native-red',
    strip: 'red',
  })
  const green = await ensureNativeWindow(base, state, 'greenSpawn', {
    title: GREEN_NATIVE_TITLE,
    token: 'native-green',
    strip: 'green',
  })
  return { red, green }
}

export function pickMonitorMove(outputs: OutputSnapshot[], currentOutputName: string): { action: 'move_monitor_left' | 'move_monitor_right'; target: OutputSnapshot } | null {
  const ordered = [...outputs].sort((a, b) => a.x - b.x || a.y - b.y || a.name.localeCompare(b.name))
  const index = ordered.findIndex((output) => output.name === currentOutputName)
  if (index < 0) return null
  if (index + 1 < ordered.length) {
    return { action: 'move_monitor_right', target: ordered[index + 1] }
  }
  if (index > 0) {
    return { action: 'move_monitor_left', target: ordered[index - 1] }
  }
  return null
}

export function findLauncherCandidate(apps: DesktopAppEntry[]): { query: string; app: DesktopAppEntry } | null {
  const candidates = [
    { token: 'foot', re: /(^|[^a-z])foot([^a-z]|$)/i },
    { token: 'kitty', re: /(^|[^a-z])kitty([^a-z]|$)/i },
    { token: 'wezterm', re: /wezterm/i },
    { token: 'alacritty', re: /alacritty/i },
    { token: 'konsole', re: /konsole/i },
    { token: 'terminal', re: /terminal/i },
  ]
  for (const candidate of candidates) {
    const app = apps.find((entry) =>
      [entry.name, entry.exec, entry.executable, entry.generic_name, entry.full_name]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .some((value) => candidate.re.test(value)),
    )
    if (app) return { query: candidate.token, app }
  }
  return null
}

export async function cleanupNativeWindows(base: string, windowIds: Set<number>): Promise<void> {
  for (const windowId of [...windowIds]) {
    try {
      const { compositor } = await getSnapshots(base)
      if (!compositorWindowById(compositor, windowId)) {
        windowIds.delete(windowId)
        continue
      }
    } catch {}
    try {
      await crashWindow(base, windowId)
      await waitForWindowGone(base, windowId, 4000)
      windowIds.delete(windowId)
      continue
    } catch {}
    try {
      if (await closeWindowBestEffort(base, windowId)) {
        windowIds.delete(windowId)
        continue
      }
    } catch {}
  }
}

export async function cleanupShellWindows(base: string, windowIds: number[]): Promise<void> {
  for (const windowId of windowIds) {
    try {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const shellWindow = shellWindowById(shell, windowId)
      if (!shellWindow) continue
      if (taskbarEntry(shell, windowId)?.close) {
        await closeTaskbarWindow(base, shell, windowId)
        await waitForWindowGone(base, windowId, 4000)
      }
    } catch {}
  }
}
