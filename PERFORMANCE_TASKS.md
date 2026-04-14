# Performance Tasks

These tasks are based on a static read of the current code. Each item is scoped to be realistic for one AI session and precise enough to implement, verify, and land independently.

For each task:

1. Run `bash scripts/verify.sh`
2. Run `bash scripts/remote-update-and-restart.sh`
3. Run `bash scripts/remote-verify.sh`
4. If compositor rendering, shell OSR, window lifecycle, or e2e behavior changed, add or update a remote e2e test and run `bash scripts/e2e-remote.sh`

## Task 1: Reduce Idle CEF BeginFrame Traffic

Goal: stop driving the shell near 60 Hz when nothing is changing.

Primary files:

- `compositor/src/drm.rs`
- `compositor/src/cef/begin_frame_diag.rs`
- possibly `compositor/src/state.rs`

Work:

- Replace the fixed `16ms` idle begin-frame pacing with adaptive pacing.
- Keep fast begin-frames during pointer motion, resize, drag, shell animation, or explicit shell invalidation.
- Drop to a much slower cadence when the compositor has not advanced and the shell has no active interaction.
- Add debug logging counters so it is easy to confirm the idle rate actually fell.

Done when:

- Idle desktop CPU use is lower.
- Debug logs show fewer `schedule_external_begin_frame` calls while idle.
- Pointer motion and resize still feel smooth.

## Task 2: Stop Rebuilding Full Window Lists For Common Updates

Goal: avoid `WindowList` rebuilds for changes that already have delta events.

Primary files:

- `compositor/src/state.rs`
- `compositor/src/shell_encode.rs`
- `compositor/src/handlers/mod.rs`
- `compositor/src/input.rs`
- `compositor/src/shell_backed.rs`

Work:

- Audit every `shell_reply_window_list()` call site.
- Keep full list replies only for initial sync, desync recovery, or cases where delta correctness is hard to guarantee.
- For map, unmap, metadata, focus, minimize, maximize, fullscreen, and geometry updates, prefer the existing delta messages.
- Add a narrow recovery path if shell state needs a forced full resync.

Done when:

- Normal window interactions do not trigger repeated full `WindowList` replies.
- Initial sync and recovery still work.
- Existing shell behavior stays correct across map, unmap, focus, and minimize flows.

## Task 3: Cache Capture Source Lookups

Goal: remove repeated full scans of windows, space elements, and outputs in capture bookkeeping.

Primary files:

- `compositor/src/capture.rs`
- `compositor/src/state.rs`
- `compositor/src/window_registry.rs`

Work:

- Add a cache keyed by `window_id` for capture descriptors or the expensive parts of them.
- Stop calling `space.elements().find(...)` and `space.outputs().find(...)` for every window on every capture sync.
- Update the cache from existing window geometry and output change paths.
- Keep a safe fallback path for cache misses.

Done when:

- `capture_sync_toplevel_handles()` no longer does repeated O(n^2)-style scans across windows and space elements.
- Screencast and capture source lists still show the correct geometry, title, app id, and output.

## Task 4: Replace JS `CustomEvent` Fanout With One Batched Entry Point

Goal: remove repeated JSON -> JS source string -> DOM event overhead for compositor-to-shell updates.

Primary files:

- `compositor/src/cef/compositor_downlink.rs`
- `compositor/src/cef/bridge.rs`
- `shell/src/App.tsx`
- possibly a new `shell/src/compositorEvents.ts`

Work:

- Add one JS entry point that accepts an array of compositor updates directly.
- In Rust, emit one batch call instead of dispatching one `CustomEvent` per detail.
- On the shell side, process the batch in one reducer-style pass.
- Keep a fallback or debug path if the direct bridge is unavailable.

Done when:

- A batch of compositor updates reaches the shell without N DOM `CustomEvent` dispatches.
- Window and layout updates still apply in order.
- The shell still recovers cleanly after HMR or compositor resync.

## Task 5: Extract Shell State Reduction Out Of `App.tsx`

Goal: reduce broad recomputation and make later performance work tractable.

Primary files:

- `shell/src/App.tsx`
- new `shell/src/compositorModel.ts`
- new `shell/src/workspaceSelectors.ts`

Work:

- Move compositor event application into a dedicated reducer/store module.
- Move expensive derived selectors like grouped windows, windows-by-monitor, and taskbar rows into dedicated memoized helpers.
- Keep `App.tsx` focused on wiring and view composition.
- Do not change behavior in this task beyond the refactor needed to keep outputs stable.

Done when:

- `App.tsx` is materially smaller.
- The shell still passes existing tests.
- Later tasks can optimize state updates without touching the full app component.

## Task 6: Make Window State Updates Incremental In The Shell

Goal: avoid cloning and re-deriving broad shell state on every single window update.

Primary files:

- `shell/src/app/appWindowState.ts`
- `shell/src/App.tsx`
- possibly `shell/src/workspaceState.ts`

Work:

- Replace the current full-`Map` replacement style with more targeted incremental updates where possible.
- Preserve stable object identity for unaffected windows.
- Update grouped-window and taskbar selectors to take advantage of incremental state.
- Add focused tests for mapped, unmapped, geometry, metadata, and minimized updates.

Done when:

- A geometry update for one window does not force avoidable churn across unrelated windows.
- Tests cover the incremental update paths.

## Task 7: Stop Measuring All Shell UI Windows Every Flush

Goal: reduce layout reads and JSON payload churn for shell-hosted overlays and panels.

Primary files:

- `shell/src/shellUiWindows.ts`
- `shell/src/App.tsx`
- `shell/src/shellFloatingPlacement.ts`

Work:

- Track dirty shell UI entries instead of remeasuring the full registry every time.
- Re-measure on actual causes: resize, visibility change, mount, unmount, or explicit invalidation.
- Keep the dedupe logic, but make it operate on cached measurements.
- Keep the compositor payload format unchanged unless a smaller delta format is easy to add safely.

Done when:

- The steady-state shell does fewer `getBoundingClientRect()` reads.
- Shell-hosted window geometry still reaches the compositor correctly.
- No regressions in settings, debug HUD, screenshot UI, or floating layers.

## Task 8: Cache Desktop App Matching For Taskbar Rows

Goal: avoid repeated normalization and fuzzy matching work for every taskbar recomputation.

Primary files:

- `shell/src/desktopApplicationsState.ts`
- `shell/src/desktopAppSearch.ts`
- `shell/src/App.tsx`

Work:

- Precompute normalized fields and token sets once when desktop apps are loaded.
- Add fast lookup indexes for common exact matches like `desktop_id`, executable, and icon.
- Cache match results by visible window signature such as `(app_id, title)`.
- Keep current behavior for unmatched or ambiguous cases.

Done when:

- Taskbar recomputation does less per-window string processing.
- Programs and taskbar icons still resolve correctly.

## Task 9: Cache Static Backdrop And Shell Render Elements Per Output

Goal: reduce per-frame render element construction for mostly static content.

Primary files:

- `compositor/src/drm.rs`
- `compositor/src/backdrop_render.rs`
- `compositor/src/shell_render.rs`
- possibly `compositor/src/state.rs`

Work:

- Cache backdrop element sets per output until wallpaper, fit mode, output geometry, or scale changes.
- Cache shell overlay placement conversions when the shell dma-buf commit and placement are unchanged.
- Keep damage behavior correct when dirty rects or output scale change.
- Add debug logging or counters to show cache hit rate.

Done when:

- Stable desktop frames do less render element rebuilding.
- Wallpaper, context menus, and floating layers still update immediately when changed.

## Task 10: Reduce Global DOM Queries In E2E Snapshot Helpers

Goal: keep test-only snapshot generation from perturbing runtime behavior and make it cheaper when used.

Primary files:

- `shell/src/App.tsx`

Work:

- Isolate the E2E snapshot and HTML export helpers from the main render/update paths.
- Remove repeated broad `querySelectorAll()` work from hot reactive paths.
- Make snapshot collection run only on explicit E2E requests.

Done when:

- E2E snapshot logic does not participate in normal interactive updates.
- Snapshot responses still include the same useful data.

## Task 11: Add A Real Perf Smoke Test For Idle And Window Churn

Goal: make future performance work measurable and guard against regressions.

Primary files:

- `shell/e2e/specs/`
- `scripts/`
- possibly `compositor/src/cef/begin_frame_diag.rs`

Work:

- Add a remote perf-oriented smoke test that covers idle shell, opening several windows, moving one window, and minimizing/restoring.
- Collect a small set of counters or logs such as begin-frame counts, full window list replies, or shell update batches.
- Fail only on clear regressions, not tight timing thresholds.

Done when:

- There is a repeatable remote test that reports useful perf counters.
- Future perf tasks can prove they improved or preserved the measured behavior.

## Task 12: Native Shell Rendering Feasibility Slice

Goal: derisk the largest refactor by moving one always-visible shell primitive out of CEF.

Primary files:

- `compositor/src/`
- `shell/src/`

Work:

- Pick one low-risk primitive such as the taskbar background strip, simple snap overlay, or another always-visible non-interactive shell layer.
- Render it natively in the compositor while keeping the interactive shell in CEF.
- Measure whether this meaningfully reduces shell invalidation and frame work.
- Document whether continuing this direction looks worth it.

Done when:

- One visible shell primitive is compositor-native.
- The result is measured and documented.
- There is a clear yes/no recommendation on whether to continue this architectural direction.
