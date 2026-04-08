# MVP Implementation Steps

Each step is a self-contained prompt-sized task. Complete all steps → MVP is ready.
Reference: [ROADMAP.md](./ROADMAP.md) | [derp-media-server](https://github.com/DerpyCrabs/derp-media-server)

---

## Phase 1: Per-monitor window tracking (compositor side)

### Step 1 — Add `output_name` to WindowInfo and compute window-to-output association

**Goal:** The compositor knows which output each window belongs to.

**Files to modify:**
- `compositor/src/chrome_bridge.rs` — add `output_name: String` to `WindowInfo`
- `compositor/src/state.rs` — add helper `fn output_for_window_position(x, y, w, h) -> Option<String>` that returns the output name where the window's center point falls; call it when building `WindowInfo` snapshots in the window registry

**What to do:**
1. Add `output_name: String` field to `WindowInfo` struct (empty string = unknown)
2. Implement `output_for_window_position` on `CompositorState` — iterate `self.space.outputs()`, get geometry via `self.space.output_geometry(output)`, check if window center point `(x + w/2, y + h/2)` is inside the output rect. Return the output `name()`. Fall back to first output if none matches
3. In every place where `WindowInfo` is constructed (search for `WindowInfo {` in state.rs and handlers/xdg_shell.rs), fill `output_name` from the new helper
4. The `LoggingChromeBridge` tests still compile (output_name is just another field)

**Verify:** `cargo check -p compositor` passes. No runtime changes yet — field is populated but not sent to shell.

---

### Step 2 — Send output_name through wire protocol to shell

**Goal:** Shell receives `output_name` for every window event.

**Files to modify:**
- `shell_wire/src/lib.rs` — add `output_name: String` to `WindowMapped`, `WindowGeometry`, `WindowList` entry, `WindowState` in `DecodedCompositorToShellMessage`. Update encode/decode for those message types to include a length-prefixed UTF-8 string for output_name
- `compositor/src/shell_encode.rs` — pass `info.output_name` into the new wire fields
- `compositor/src/cef/compositor_downlink.rs` — add `"output_name": ...` to the JSON dispatched for `window_mapped`, `window_geometry`, `window_list`, `window_state` events

**What to do:**
1. In `shell_wire`, for `WindowMapped` encoding: after existing fields, write `output_name` as `[u32 len][utf8 bytes]` (same pattern as `title`/`app_id`). Decode symmetrically. Same for `WindowGeometry` and each window in `WindowList`
2. In `shell_encode.rs`, map `info.output_name.clone()` into the new fields
3. In `compositor_downlink.rs`, add `"output_name": output_name` to each relevant JSON dispatch
4. The `WindowState` message is small (just window_id + minimized); adding output_name there is optional — skip if it complicates things, the shell can track it from the last geometry event

**Verify:** `cargo check` for both crates. Shell will start receiving `output_name` in its `derp-shell` events.

---

## Phase 2: Per-monitor taskbar (shell side)

### Step 3 — Shell: track output_name per window and group windows by monitor

**Goal:** Shell knows which monitor each window is on.

**Files to modify:**
- `shell/src/App.tsx`

**What to do:**
1. Add `output_name: string` to the `DerpWindow` type
2. In `buildWindowsMapFromList`, extract `output_name` from each row (default `''`)
3. In `applyDetail` for `window_mapped` and `window_geometry`, read `detail.output_name` (may be undefined in legacy events — default to `''`)
4. Add a `createMemo` called `windowsByMonitor` that returns `Map<string, DerpWindow[]>` — group `windowsList()` by `output_name`. Windows with empty output_name go to the primary monitor's name (or first screen name)
5. Update `taskbarWindows` memo to include `output_name` in each row

**Verify:** Shell compiles (`npm run build` in shell/). No visual change yet — taskbar still only on primary.

---

### Step 4 — Shell: render a taskbar on every monitor

**Goal:** Each monitor shows its own taskbar at the bottom, listing only its windows.

**Files to modify:**
- `shell/src/App.tsx`
- `shell/src/Taskbar.tsx`

**What to do:**
1. In `App.tsx`, the current code renders one `<Taskbar>` inside `<Show when={workspacePartition().primary}>`. Change this to render a `<For each={screenDraft.rows}>` that places a `<Taskbar>` positioned at the bottom of each screen's rect
2. Each per-monitor taskbar is absolutely positioned: `left: screen.x`, `top: screen.y + screen.height - TASKBAR_HEIGHT`, `width: screen.width`. Use the same height as current taskbar (h-11 = 44px)
3. Each taskbar gets `windows` filtered from `windowsByMonitor().get(screen.name)` (from step 3)
4. Programs menu button + Power button only appear on the primary monitor's taskbar. Add an `isPrimary` prop to `Taskbar` — when false, hide those buttons. In `Taskbar.tsx`, wrap Programs and Power buttons in `<Show when={props.isPrimary}>`
5. Debug button can stay on primary only too
6. Remove the old single-taskbar render from the primary `<Show>` block

**Verify:** Build shell. Deploy and test — each monitor should show a taskbar. Windows should appear in the taskbar of the monitor they're on.

---

### Step 5 — Shell: exclusion zones for all per-monitor taskbars

**Goal:** Compositor knows about all taskbar rects so new windows don't open under them.

**Files to modify:**
- `shell/src/App.tsx`

**What to do:**
1. In `syncExclusionZonesNow`, currently it finds `[data-shell-taskbar]` (one element). Change to `querySelectorAll('[data-shell-taskbar]')` and loop over all of them, adding each taskbar rect
2. Give each per-monitor taskbar a unique `data-shell-taskbar-monitor={screen.name}` attribute so they can be identified
3. The debug panel rect (`[data-shell-panel]`) still only exists on primary — keep that as-is
4. Verify the total rects count stays under `SHELL_EXCLUSION_ZONES_SENT_MAX`

**Verify:** Build and deploy. Open debug panel — exclusion zones list should show a taskbar entry for each monitor.

---

## Phase 3: Keyboard shortcuts

### Step 6 — Compositor: intercept Super+key combos and send keybind events

**Goal:** Super+Enter, Super+Q, Super+arrows, Super+Shift+arrows, Super+F, Super+M are intercepted by the compositor and sent to the shell as keybind events.

**Files to modify:**
- `shell_wire/src/lib.rs` — add `MSG_COMPOSITOR_KEYBIND` message type (new const, e.g. `51`). Body: `[u32 msg_type][u32 action_len][utf8 action_string]`. Add to `DecodedCompositorToShellMessage` enum: `Keybind { action: String }`
- `compositor/src/input.rs` — in the keyboard handler, when `programs_menu_super_armed && !is_super` (i.e., Super is held and another key is pressed), match the raw_sym to known bindings and send keybind event instead of forwarding
- `compositor/src/state.rs` — add `fn shell_send_keybind(&mut self, action: &str)` that encodes and sends via the CEF channel (same pattern as `programs_menu_toggle_from_super`)

**Keybind table (hardcoded for MVP):**
| Keys | Action string |
|------|--------------|
| Super+Enter | `"launch_terminal"` |
| Super+Q | `"close_focused"` |
| Super+D | `"toggle_programs_menu"` |
| Super+F | `"toggle_fullscreen"` |
| Super+M | `"toggle_maximize"` |
| Super+Left | `"tile_left"` |
| Super+Right | `"tile_right"` |
| Super+Up | `"tile_up"` |
| Super+Down | `"tile_down"` |
| Super+Shift+Left | `"move_monitor_left"` |
| Super+Shift+Right | `"move_monitor_right"` |

**What to do:**
1. Add wire message constant and encoding/decoding in shell_wire
2. In `input.rs`, inside the `if state.programs_menu_super_armed && !is_super` block (line ~418), before setting `programs_menu_super_chord = true`, check `raw_sym` against the table. If matched: call `state.shell_send_keybind(action)`, set chord=true, return `FilterResult::Intercept(())`
3. For shift detection: check `mods.shift` to distinguish Super+Left from Super+Shift+Left
4. `shell_send_keybind` creates a `DecodedCompositorToShellMessage::Keybind` and sends it via the same CEF compositor_downlink path as other messages

**Verify:** `cargo check`. No shell handling yet — keybinds are sent but ignored.

---

### Step 7 — Compositor: send keybind via CEF downlink to shell

**Goal:** Keybind events reach the shell as `derp-shell` CustomEvents.

**Files to modify:**
- `compositor/src/cef/compositor_downlink.rs` — add match arm for `Keybind { action }` → dispatch `{ "type": "keybind", "action": action }`
- `compositor/src/shell_encode.rs` — add match arm for `Keybind` (if going through ChromeEvent path; otherwise may go direct)

**What to do:**
1. If keybinds go through `ChromeEvent` enum: add `Keybind { action: String }` variant to `ChromeEvent` in `chrome_bridge.rs`, map in `shell_encode.rs`, handle in `compositor_downlink.rs`
2. If keybinds bypass `ChromeEvent` and send directly via the CEF channel: just add the downlink dispatch. The simpler approach is to add to `ChromeEvent` for consistency
3. In `compositor_downlink.rs`, the `Keybind` arm dispatches: `json!({ "type": "keybind", "action": action })`

**Verify:** `cargo check`. Shell will now receive `{ type: "keybind", action: "..." }` events.

---

### Step 8 — Shell: handle keybind events for basic actions

**Goal:** Super+Enter launches terminal, Super+Q closes focused window, Super+D opens programs menu, Super+F/M toggle fullscreen/maximize.

**Files to modify:**
- `shell/src/App.tsx`

**What to do:**
1. Add `'keybind'` to the `DerpShellDetail` union type: `| { type: 'keybind'; action: string }`
2. In the `onDerpShell` handler, add a case for `d.type === 'keybind'`:
   - `launch_terminal`: call `spawnInCompositor('foot')` (or configurable terminal)
   - `close_focused`: `shellWireSend('close', focusedWindowId())`
   - `toggle_programs_menu`: call `toggleProgramsMenuMeta()`
   - `toggle_fullscreen`: `shellWireSend('set_fullscreen', focusedWindowId(), w.fullscreen ? 0 : 1)` — look up focused window state
   - `toggle_maximize`: same pattern with `set_maximized`
3. For now, ignore tiling and monitor-move actions — those come in later steps

**Verify:** Build shell, deploy. Super+Enter should open foot. Super+Q should close focused window. Super+D should toggle programs menu.

---

### Step 9 — Shell: keybind tiling actions (Super+arrows)

**Goal:** Super+Left/Right snaps focused window to left/right half. Super+Up maximizes. Super+Down restores.

**Files to modify:**
- `shell/src/App.tsx`

**What to do:**
1. In the keybind handler from step 8, add cases for `tile_left`, `tile_right`, `tile_up`, `tile_down`
2. For `tile_left`/`tile_right`: find the focused window, find its monitor (from `output_name` or use `pickScreenForWindow`), compute the half-rect using `monitorWorkAreaGlobal` from `tileSnap.ts`, send `set_geometry` via wire. Track it as shell-tiled (`shellTiled.add`, save `tileRestore`)
3. For `tile_up`: maximize the focused window (reuse existing maximize logic from the `onMaximize` handler)
4. For `tile_down`: if maximized → restore from `floatBeforeMaximize`; if tiled → restore from `tileRestore`; otherwise do nothing
5. After tiling, call `scheduleExclusionZonesSync()` and `bumpSnapChrome()`

**Verify:** Build and deploy. Super+Left should tile focused window to left half of its monitor.

---

### Step 10 — Shell: move window to adjacent monitor (Super+Shift+arrows)

**Goal:** Super+Shift+Left/Right moves focused window to the monitor on its left/right.

**Files to modify:**
- `shell/src/App.tsx`
- `shell/src/shellCoords.ts` (optional — add helper)

**What to do:**
1. Add a helper function `findAdjacentMonitor(currentScreen, allScreens, direction: 'left' | 'right')` that finds the screen to the left/right of the current one. Sort screens by `x` position, find current, return prev/next
2. In the keybind handler, for `move_monitor_left`/`move_monitor_right`:
   - Find focused window and its current monitor
   - Find adjacent monitor in that direction
   - Compute new position: center the window on the target monitor, same relative y. If the window was tiled, tile it in the same zone on the new monitor. If floating, just move it
   - Send `set_geometry` with new position
   - The compositor will emit `window_geometry` with the new `output_name` automatically (from step 1)
3. After moving, call `scheduleExclusionZonesSync()`

**Verify:** Build and deploy. Super+Shift+Right moves focused window to the monitor on the right.

---

## Phase 4: Tiling engine

### Step 11 — Port snap zone types and occupancy-aware bounds

**Goal:** Shell has a rich snap zone model (halves, quarters, thirds, 2x3 grid) adapted from derp-media-server.

**Files to create:**
- `shell/src/tileZones.ts`

**Reference:** [derp-media-server workspace-geometry.ts](https://github.com/DerpyCrabs/derp-media-server/blob/master/lib/workspace-geometry.ts)

**What to do:**
1. Define `SnapZone` type — discriminated union with zones: `left-half`, `right-half`, `top-left`, `top-right`, `bottom-left`, `bottom-right`, plus thirds: `left-third`, `center-third`, `right-third`, and 2x3 cells: `top-left-third`, `top-center-third`, `top-right-third`, `bottom-left-third`, `bottom-center-third`, `bottom-right-third`
2. Implement `snapZoneToBounds(zone: SnapZone, workArea: Rect) → Rect` — pure math, maps zone to rectangle within the work area
3. Implement `snapZoneToBoundsWithOccupied(zone: SnapZone, workArea: Rect, occupiedZones: { zone: SnapZone, bounds: Rect }[]) → Rect` — like the derp-media-server version, shrinks the result when neighbors occupy adjacent zones
4. Define zone adjacency: `LEFT_SIDE_ZONES`, `RIGHT_SIDE_ZONES`, `TOP_ZONES`, `BOTTOM_ZONES` sets for occupancy-aware shrinking
5. All functions are pure — no DOM, no signals, no imports from App.tsx

**Verify:** `npm run build` in shell/ passes. Functions are importable.

---

### Step 12 — Integrate snap zones into drag flow, replacing edge-only detection

**Goal:** While dragging a window, the shell uses the new zone model to compute snap previews instead of just half/quarter edge detection.

**Files to modify:**
- `shell/src/App.tsx`
- `shell/src/tileSnap.ts` (extend or replace `hitTestSnapRectGlobal`)

**What to do:**
1. Replace `hitTestSnapRectGlobal` (which only does half/quarter by edge proximity) with a new `hitTestSnapZoneGlobal` that:
   - Checks corners first (quarter zones) — pointer within `edgePx` of two edges
   - Checks edges (half zones) — pointer within `edgePx` of one edge
   - Checks center region (optional: no snap, or "maximize" zone)
   - Returns `{ zone: SnapZone, rect: Rect } | null`
2. In `applyShellWindowMove` in App.tsx, use the new function. Pass the result zone to `set_tile_preview` for the compositor preview quad
3. In `endShellWindowMove`, when snapping: store the zone in `shellTiled` set (change from `Set<number>` to `Map<number, SnapZone>` to track which zone each window is in)
4. When computing snap bounds at drop time, use `snapZoneToBoundsWithOccupied` with the other tiled windows on this monitor as occupied zones

**Verify:** Build and deploy. Dragging windows to edges should snap with occupancy-aware bounds. If another window is tiled to the left half, dragging to right half should fill the remaining space.

---

### Step 13 — Port assist grid for fine-grained zone selection

**Goal:** When dragging near the top edge of a monitor, an assist grid overlay appears allowing selection of third/sixth zones.

**Files to create:**
- `shell/src/assistGrid.ts`

**Files to modify:**
- `shell/src/App.tsx` (render overlay + wire into drag flow)

**Reference:** [derp-media-server workspace-assist-grid.ts](https://github.com/DerpyCrabs/derp-media-server/blob/master/lib/workspace-assist-grid.ts)

**What to do:**
1. In `assistGrid.ts`, define grid shapes: `2x2`, `3x2`, `2x3`, `3x3`. Each shape maps `(column, row)` to a `SnapZone`
2. Implement `assistGridCellFromPointer(px, py, gridShape, workArea) → { zone: SnapZone, previewRect: Rect } | null` — divides work area into grid cells, returns the zone the pointer is in
3. In App.tsx, when the pointer is near the top edge during a drag (within `TILE_SNAP_EDGE_PX`), switch to assist grid mode:
   - Show a semi-transparent grid overlay (positioned absolutely in the monitor rect, rendered as `<div>` cells with `pointer-events-none`)
   - Highlight the cell under the pointer
   - The snap zone comes from assist grid instead of edge detection
4. The grid shape defaults to `3x2` (matches derp-media-server default). Can be configurable later
5. Send `set_tile_preview` with the assist grid cell bounds

**Verify:** Build and deploy. Drag a window to top edge of monitor — grid overlay appears. Hovering over grid cells highlights them and shows a preview.

---

### Step 14 — Per-monitor tiling state tracking

**Goal:** Shell maintains per-monitor state: which snap zones are occupied by which windows.

**Files to create:**
- `shell/src/tileState.ts`

**Files to modify:**
- `shell/src/App.tsx`

**What to do:**
1. In `tileState.ts`, create a class/object `MonitorTileState`:
   - `tiledWindows: Map<number, { zone: SnapZone, bounds: Rect }>` — window_id → zone + bounds
   - `tileWindow(windowId, zone, workArea, otherOccupied) → Rect` — computes occupancy-aware bounds and stores
   - `untileWindow(windowId)` — removes from map
   - `getOccupiedZones() → { zone, bounds }[]` — for computing new snap bounds
2. Create `PerMonitorTileStates` — a `Map<string, MonitorTileState>` keyed by `output_name`
3. In App.tsx, replace the module-level `shellTiled: Set<number>` and `tileRestore: Map<...>` with a single `PerMonitorTileStates` instance
4. When a window is tiled (end of drag snap or keyboard tile), call `tileState.tileWindow(...)` for the correct monitor
5. When a window is untiled (drag starts on a tiled window, or close), call `untileWindow(...)`
6. When a window moves to another monitor (output_name changes), untile from source, optionally tile on destination

**Verify:** Build and deploy. Tiling state is tracked per-monitor. Occupancy-aware bounds work across monitors independently.

---

### Step 15 — Snapped multi-window resize: propagate edge to neighbors

**Goal:** When resizing a tiled window's edge, adjacent tiled windows sharing that edge resize together.

**Files to modify:**
- `shell/src/tileState.ts` (add neighbor detection)
- `shell/src/App.tsx` (modify resize flow)

**Reference:** [derp-media-server workspace-session-store.ts computeSnappedResizeWindows](https://github.com/DerpyCrabs/derp-media-server/blob/master/lib/workspace-session-store.ts)

**What to do:**
1. In `tileState.ts`, add `findEdgeNeighbors(windowId, edge: 'left'|'right'|'top'|'bottom', tolerance: number) → number[]` — finds other tiled windows on the same monitor whose opposite edge aligns with the given window's edge (within tolerance px)
2. In App.tsx `endShellWindowResize` (or during resize), if the resized window is tiled:
   - Determine which edge was resized from the resize edges bitmask
   - Find neighbors on that edge
   - Compute new bounds for all affected windows: the resized window grows/shrinks, neighbors grow/shrink inversely
   - Send `set_geometry` for all affected windows in a batch
3. Update tileState bounds for all affected windows
4. Respect a minimum size (e.g., 200px width, 150px height) — don't let resize push a neighbor below min

**Verify:** Build and deploy. Tile two windows side by side. Resize the shared edge — both windows resize together.

---

## Phase 5: Per-monitor layout types

### Step 16 — Define layout interface + implement manual-snap and master-stack

**Goal:** Two layout types exist: manual-snap (current FancyZones behavior) and master-stack (automatic).

**Files to create:**
- `shell/src/layouts.ts`

**What to do:**
1. Define `TilingLayout` interface:
   ```
   type LayoutType = 'manual-snap' | 'master-stack' | 'columns' | 'grid'
   interface TilingLayout {
     type: LayoutType
     computeLayout(windowIds: number[], workArea: Rect, params: LayoutParams): Map<number, Rect>
     addWindow(windowId: number, currentLayout: Map<number, Rect>, workArea: Rect, params: LayoutParams): Map<number, Rect>
     removeWindow(windowId: number, currentLayout: Map<number, Rect>, workArea: Rect, params: LayoutParams): Map<number, Rect>
   }
   ```
2. Implement `ManualSnapLayout` — returns empty map (layout is user-driven via drag/keyboard snap, not automatic)
3. Implement `MasterStackLayout`:
   - First window gets the left portion (ratio configurable, default 0.55)
   - Remaining windows split the right portion vertically equally
   - `addWindow`: recompute all positions
   - `removeWindow`: recompute, promote second window to master if master was removed
4. `LayoutParams`: `{ masterRatio?: number }` — extensible per layout type

**Verify:** `npm run build`. Pure functions, no side effects.

---

### Step 17 — Implement columns and grid layouts

**Goal:** Two more automatic layout types.

**Files to modify:**
- `shell/src/layouts.ts`

**What to do:**
1. Implement `ColumnsLayout`:
   - Each window gets an equal-width column spanning the full work area height
   - 1 window = full width, 2 = 50/50, 3 = 33/33/33, etc.
   - Max columns configurable (default unlimited); if more windows than max, last column stacks vertically
2. Implement `GridLayout`:
   - Auto-arrange in a grid: compute rows and columns to be as square as possible
   - `n` windows → `cols = ceil(sqrt(n))`, `rows = ceil(n/cols)`
   - Each cell is `workArea.w / cols × workArea.h / rows`
   - Last row may have fewer cells (centered or left-aligned)
3. Export a `createLayout(type: LayoutType): TilingLayout` factory function

**Verify:** `npm run build`.

---

### Step 18 — Layout config store and per-monitor layout selection

**Goal:** Each monitor has a configurable layout type. Config persists in tiling.json.

**Files to create:**
- `shell/src/tilingConfig.ts`

**Files to modify:**
- `shell/src/App.tsx`

**What to do:**
1. In `tilingConfig.ts`:
   - Define config schema: `{ monitors: { [outputName: string]: { layout: LayoutType, params?: LayoutParams } } }`
   - Read config from `localStorage` key `derp-tiling-config` (simple for now; config file comes from compositor later)
   - Export `getMonitorLayout(outputName) → { layout: TilingLayout, params: LayoutParams }` with fallback to `manual-snap`
   - Export `setMonitorLayout(outputName, layoutType, params?)` that saves to localStorage
2. In App.tsx:
   - When `output_layout` event arrives, read tiling config for each monitor
   - In the debug panel, for each monitor row, add a dropdown to select layout type (manual-snap / master-stack / columns / grid). On change, call `setMonitorLayout` and re-layout
3. The layout type doesn't take effect yet (that's step 19) — this step just stores and displays the config

**Verify:** Build and deploy. Debug panel shows layout selector per monitor. Selection persists across refresh.

---

### Step 19 — Auto re-layout on window events

**Goal:** Monitors with automatic layouts (master-stack, columns, grid) recompute window positions when windows are added/removed.

**Files to modify:**
- `shell/src/App.tsx`
- `shell/src/tileState.ts`

**What to do:**
1. Add a function `applyAutoLayout(monitorName: string)`:
   - Get the monitor's layout from tiling config
   - If `manual-snap`, do nothing (user-driven)
   - Otherwise, get all non-minimized windows on this monitor (from `windowsByMonitor`)
   - Call `layout.computeLayout(windowIds, workArea, params)` to get new positions
   - Send `set_geometry` for each window
   - Update per-monitor tileState
2. Call `applyAutoLayout` when:
   - A new window is mapped (in `window_mapped` handler), after determining its monitor
   - A window is unmapped or minimized
   - A window's `output_name` changes (moved to another monitor) — re-layout both source and destination
   - Layout type is changed in config (from debug panel)
3. For `manual-snap` monitors, existing behavior is unchanged
4. For automatic layout monitors, disable drag-to-snap (or allow it to override temporarily)

**Verify:** Build and deploy. Set a monitor to master-stack layout. Open two windows — first takes left 55%, second takes right 45%. Open a third — right side splits into two stacked panes.

---

## Phase 6: Polish for daily use

### Step 20 — Smart window placement on the pointer's monitor

**Goal:** New windows open on the monitor where the pointer currently is, not at (0,0) or random.

**Files to modify:**
- `compositor/src/state.rs` (or `compositor/src/handlers/xdg_shell.rs`)

**What to do:**
1. In the xdg toplevel `initial_configure` / `new_toplevel` handler, before placing the window:
   - Get the current pointer position from `self.seat.get_pointer().current_location()`
   - Find which output the pointer is on
   - If the window has no explicit position request, center it on that output's work area (accounting for titlebar and taskbar reserve)
   - Add a cascade offset: check if another window is already at that exact position; if so, offset by (30, 30) pixels
2. If the monitor has an auto-layout (shell will handle it), just place the window roughly — the shell will immediately reposition via `set_geometry`
3. Keep existing behavior for windows that request a specific position

**Verify:** `cargo check`, deploy. Open a new terminal — it appears on the monitor where the pointer is, centered.

---

### Step 21 — Migrate windows when a monitor is disconnected

**Goal:** Windows on a removed monitor move to the nearest remaining monitor.

**Files to modify:**
- `compositor/src/state.rs` (or wherever output removal is handled)

**What to do:**
1. Find where the compositor handles output removal (DRM connector disconnect in `drm.rs` or the session handler)
2. Before removing the output from the space, collect all windows whose `output_name` matches the removed output
3. Find the "nearest" remaining output — prefer one adjacent in x, then fall back to primary
4. Move each window to the center of the target output (or let the shell re-tile it)
5. Emit `window_geometry` events with updated positions so the shell knows
6. The shell's per-monitor tiling state will clean up automatically because the windows' `output_name` changes

**Verify:** Difficult to test without hot-plug hardware. Code review for correctness. Ensure no panics if the last output is removed (unlikely but handle gracefully).

---

### Step 22 — Crash resilience: catch panics and handle wire disconnect

**Goal:** Non-critical panics don't crash the session. Shell recovers from compositor restart.

**Files to modify:**
- `compositor/src/main.rs`
- `compositor/src/state.rs`
- `shell/src/App.tsx`

**What to do:**
1. In `compositor/main.rs`, wrap the main event loop tick in `std::panic::catch_unwind`. If a panic is caught, log it and continue the loop instead of crashing. Be selective — only catch panics in the render/dispatch path, not during initialization
2. In the shell, the `derp-shell` event listener already handles missing wire gracefully. But add: when `__derpShellWireSend` becomes unavailable after being available (compositor crashed and restarted), re-run the `tryRequestCompositorSync` loop to re-establish state
3. Add a periodic health check: if no `pong` received for 10 seconds after a `ping`, log a warning. The shell already has ping/pong logic in the wire
4. For XWayland: ensure the XWayland crash handler (if any) doesn't propagate the crash to the compositor. The compositor should log it and continue

**Verify:** Build both. Intentionally kill and restart the compositor (SIGUSR2 path already exists). Shell should re-sync windows after restart.

---

### Step 23 — Keyboard layout switch and indicator

**Goal:** User can cycle or pick keyboard layouts with a shortcut; the shell shows the active layout (e.g. in the taskbar or status area).

**Files to modify:**
- Compositor: seat / keyboard handling (xkb group or layout index), optional wire event for layout name
- `shell_wire` / `shell_encode` / CEF downlink — if layout is pushed from compositor to shell
- `shell/src/App.tsx` (or a small status component) — bind shortcut if handled in shell, render indicator

**What to do:**
1. Wire up layout cycling at the compositor: Super+Space or another agreed shortcut; use xkb state to switch group/layout and apply to the focused keyboard resource
2. Track the human-readable layout label (locale short name or xkb layout id) after each change
3. Send layout updates to the shell over the existing wire (new message or extend an existing status channel) so the indicator stays in sync when layout changes from any path
4. In the shell, show a compact label (e.g. `US`, `RU`) next to clock or on primary taskbar; refresh on wire events

**Verify:** Deploy, switch layouts with the shortcut — focused text field reflects the new layout; indicator updates immediately.

---

### Step 24 — Volume controls

**Goal:** Raise, lower, and mute system volume from the keyboard (and optionally from the shell UI), without leaving the compositor session.

**Files to modify:**
- Compositor or a small helper: key bindings mapped to volume steps / mute (PipeWire `wpctl`, `wireplumber`, or session-specific audio API the project already uses)
- `shell/src/...` — optional on-screen volume overlay or taskbar mic/speaker affordance if desired for MVP

**What to do:**
1. Define shortcuts (e.g. dedicated volume keys, or Super + audio key chords) and implement them where other global shortcuts live
2. Integrate with the stack actually used on the test image (PipeWire suggested); keep behavior idempotent when audio daemon is absent (log once, no panic)
3. Optionally mirror current volume/mute state to the shell for an indicator; otherwise rely on OS audio feedback if available
4. If adding a shell HUD: brief non-blocking overlay on change; dismiss after timeout

**Verify:** On remote machine, keys change volume and mute state reliably; no regressions to focus or other shortcuts.

---

### Step 25 — Keyboard layout per window

**Goal:** Each window remembers its last-used keyboard layout; focusing a window restores that layout; new windows inherit a sensible default (e.g. primary layout or last global).

**Files to modify:**
- `compositor/src/state.rs` (or keyboard focus handler) — map `window_id` / toplevel to saved layout index or group
- Focus enter: restore stored layout for that surface; focus leave: persist current layout for the window being left
- Optional: shell notification only if compositor pushes layout changes (Step 23) — ensure per-window restore still updates the indicator

**What to do:**
1. On keyboard focus change, before updating xkb for the new client, save the current layout group for the previously focused toplevel (if any)
2. When focus enters a toplevel, look up saved layout; if present, apply it to the seat keyboard state; if absent, use session default
3. Clear or don't persist layout for surfaces that unmap (avoid stale map growth)
4. Document interaction with global layout shortcut: shortcut updates layout for the focused window and overwrites that window's stored value

**Verify:** Open two windows, set different layouts in each, alt-tab between them — each restores its layout; indicator matches focused window.

---

## Checklist

When all steps are complete, verify the full MVP workflow:

- [ ] Boot into compositor session on 3-monitor setup
- [ ] Set 150% scaling (via debug panel or display.json)
- [ ] Set side monitors as portrait (transform 1 or 3), center as landscape
- [ ] Each monitor shows its own taskbar with only its windows
- [ ] Super+Enter opens terminal on current monitor
- [ ] Super+Left/Right tiles window to half on current monitor
- [ ] Super+Shift+Left/Right moves window to adjacent monitor
- [ ] Super+Q closes focused window
- [ ] Super+D opens programs menu
- [ ] Different tiling layouts can be set per monitor (debug panel dropdown)
- [ ] Master-stack layout auto-tiles new windows
- [ ] Tiled window edges resize together
- [ ] Windows open on the monitor where the pointer is
- [ ] Moving pointer between monitors focuses last active window on target monitor
- [ ] Compositor survives non-critical panics
- [ ] Keyboard layout can be switched with a shortcut; shell shows active layout
- [ ] Volume up/down/mute work from keyboard (or shell) in session
- [ ] Focused window restores its saved keyboard layout; switching windows switches layout accordingly
