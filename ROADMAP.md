# derp-workspace MVP Roadmap

> Wayland desktop environment with a SolidJS shell running in CEF OSR.
> Goal: extensible DE with proven tiling/windowing from [derp-media-server](https://github.com/DerpyCrabs/derp-media-server),
> multi-monitor, fractional scaling, native window support.
>
> Implementation steps: [MVP_STEPS.md](./MVP_STEPS.md)

## Current state

### Working
- Smithay compositor: DRM backend, libseat session, EGL/GBM rendering
- CEF OSR integration: dma-buf accelerated paint, shell_wire binary protocol
- SolidJS shell: window chrome (SSD titlebar/borders/resize), taskbar, programs menu, power menu, context menus
- Window management: move, resize, minimize, maximize, close, fullscreen via shell wire
- Basic snap tiling: half/quarter screen by edge detection during drag (tileSnap.ts)
- Multi-monitor: output layout config (display.json), per-connector EDID matching, position/transform editing in debug panel
- Fractional scaling: global 100%/150%/200% (single scale for all heads)
- XWayland support
- Display config persistence (display.json with atomic writes)
- Exclusion zones for SSD decorations
- Tile preview overlay (compositor-side semi-transparent quad)
- Remote deploy and restart workflow (scripts/)

### Missing for MVP
- Per-monitor taskbar showing only that monitor's windows
- Real tiling engine (occupancy-aware zones, assist grid, linked resize) — logic exists in derp-media-server but not ported
- Per-monitor tiling layout configuration
- Keyboard shortcuts for tiling, window management, and app launch
- Shell chrome on every monitor (currently only primary gets panel + taskbar)
- Stable daily-driver experience (crash recovery, edge cases in multi-head hot-plug)

---

## MVP definition

**The MVP lets me:**
1. Boot into the compositor session on a 3-monitor setup
2. Set 150% scaling on all monitors
3. Set side monitors as portrait (transform 1 or 3), center as landscape (transform 0)
4. See a taskbar on each monitor listing only the windows on that monitor
5. Tile windows on each monitor independently with different layouts
6. Launch apps from Programs menu or keyboard shortcut
7. Use the session for daily work without needing to fall back to another DE

---

## Milestones

### M0 — Foundation fixes (prerequisites)
_Make the existing system reliable enough to build on._

- [ ] **M0.1** Audit and harden multi-head hot-plug
  - Compositor must not crash when a monitor is connected/disconnected while running
  - Shell must gracefully handle output_layout messages with changed screen set
  - Windows on removed monitors should migrate to nearest remaining monitor

- [ ] **M0.2** Fix display config round-trip for transforms
  - Verify that setting portrait (transform 1/3) on side monitors via the shell UI persists correctly in display.json and restores on restart
  - Ensure logical width/height in output_layout swap correctly for rotated heads (Smithay does this, but verify shell receives swapped w/h)

- [ ] **M0.3** Stabilize 150% fractional scaling end-to-end
  - Confirm Wayland clients get fractional_scale_v1 and render at correct resolution
  - Verify CEF OSR dma-buf size matches physical resolution at 150%
  - Test that window placement math is consistent between shell (logical coords) and compositor (logical → physical)

### M1 — Per-monitor taskbar
_Each monitor gets its own taskbar showing only windows on that monitor._

- [ ] **M1.1** Compositor: associate each window with an output
  - Track which output each toplevel "belongs to" based on its center point or majority overlap
  - Send `window_mapped`/`window_geometry` events with an `output_name` field
  - On window move across monitor boundary, re-associate and notify shell

- [ ] **M1.2** Shell: per-monitor layout model
  - Replace the single `workspacePartition` (primary + secondary) with a model where every monitor gets a taskbar
  - Each monitor region in the shell renders its own `<Taskbar>` filtered to that monitor's windows
  - The "primary" monitor still hosts the debug panel and programs menu anchor, but all monitors get a taskbar

- [ ] **M1.3** Shell: exclusion zones per monitor
  - Current exclusion zone sync sends rects for one taskbar; extend to send per-monitor taskbar rects
  - Compositor uses exclusion zones for window placement (avoid placing new windows under taskbars)

- [ ] **M1.4** Wire protocol: per-monitor window association
  - Add `output_name` to `window_mapped`, `window_geometry`, `window_list` messages
  - Or add a dedicated `window_output_changed { window_id, output_name }` message
  - Shell handles re-assignment when compositor notifies

### M2 — Tiling engine (port from derp-media-server)
_Bring the proven tiling system from derp-media-server into the compositor shell._

- [ ] **M2.1** Port core tiling math to shell
  - Adapt `workspace-geometry.ts` snap zone model: SnapZone enum, `snapZoneToBoundsWithOccupied`, occupancy-aware geometry
  - Adapt to use monitor work area (logical coords, accounting for taskbar/titlebar reserve) instead of workspace canvas
  - Unit test the ported math with representative monitor configs (3-head, mixed portrait/landscape)

- [ ] **M2.2** Port assist grid
  - Bring `workspace-assist-grid.ts` grid shapes (3x2, 3x3, 2x2) and span-to-bounds math
  - Integrate with drag flow: while dragging a window near monitor edges, show assist grid overlay
  - Use existing `set_tile_preview` wire op for compositor-side preview quad

- [ ] **M2.3** Port snapped multi-window resize
  - Adapt `computeSnappedResizeWindows` — when resizing a tiled window edge, propagate delta to adjacent tiled windows sharing that edge
  - Shell sends `set_geometry` for all affected windows in one batch
  - Respect per-window min-size hints from compositor

- [ ] **M2.4** Live snap preview during drag
  - Port `workspace-snap-live.ts` dynamic split lines from existing tiled window edges
  - Merge nearby lines, fall back to equal splits
  - Preview bounds update in real-time as pointer moves

- [ ] **M2.5** Per-monitor tiling state
  - Each monitor maintains independent tiling state (which zones are occupied, by which windows)
  - Moving a window from one monitor to another removes it from source monitor's tiling state and optionally tiles it on destination
  - Tiling layout choice (e.g., "master + stack" vs "grid" vs "manual snap") is per-monitor

### M3 — Tiling layouts per monitor
_Different tiling strategies on different monitors._

- [ ] **M3.1** Define layout types
  - `manual-snap`: current FancyZones-style behavior — user drags to edges/corners to snap, assist grid for finer control
  - `master-stack`: one master pane (configurable ratio), remaining windows stacked vertically
  - `columns`: equal-width columns, one window per column
  - `grid`: auto-arranged grid based on window count
  - Each type implements: `computeLayout(windows, monitorWorkArea) → Map<windowId, Rect>`, `addWindow`, `removeWindow`, `resizeEdge`

- [ ] **M3.2** Shell: layout config store
  - Per-monitor layout type + parameters stored as JSON in config (alongside display.json or in a separate tiling.json)
  - Shell reads config on output_layout, applies layout to existing windows
  - Debug panel shows per-monitor layout selector

- [ ] **M3.3** Automatic re-layout on window events
  - When a window is mapped on a monitor with auto-layout (master-stack, columns, grid): compute and apply geometry for all windows on that monitor
  - When a window is unmapped/minimized: re-layout remaining windows
  - When a window is moved to another monitor: re-layout both source and destination monitors

- [ ] **M3.4** Layout persistence
  - Save per-monitor tiling layout type and parameters
  - On session restore, apply saved layouts after windows are remapped

### M4 — Keyboard shortcuts
_Keyboard-driven workflow for power users._

- [ ] **M4.1** Compositor: key binding infrastructure
  - Intercept configured key combos in input.rs before forwarding to focused client
  - Send `shell_keybind { action }` event to shell via wire
  - Default bindings (configurable):
    - `Super+Enter`: launch terminal
    - `Super+D`: toggle programs menu
    - `Super+Q`: close focused window
    - `Super+Left/Right/Up/Down`: tile focused window to half/quarter
    - `Super+Shift+Left/Right`: move focused window to adjacent monitor
    - `Super+1..9`: focus/activate Nth window on current monitor
    - `Super+F`: toggle fullscreen
    - `Super+M`: toggle maximize

- [ ] **M4.2** Shell: handle keybind events
  - Map `shell_keybind` actions to existing shell functions (move, tile, spawn, menu toggle)
  - Tiling shortcuts use the per-monitor tiling engine from M2/M3

- [ ] **M4.3** Key binding configuration
  - JSON config file for key bindings
  - Compositor reads on startup; shell can trigger reload

### M5 — Polish and daily-driver readiness
_Smooth out rough edges for daily use._

- [ ] **M5.1** Window placement heuristics
  - New windows open centered on the monitor where the pointer is (or the focused monitor)
  - Cascade offset if another window is already at that position
  - Respect auto-tiling layout if the target monitor has one

- [ ] **M5.2** Focus follows monitor
  - When pointer moves to a different monitor, that monitor's most-recently-focused window gains focus
  - Or optionally: click-to-focus per monitor

- [ ] **M5.3** Session restore basics
  - On compositor restart (SIGUSR2 / exit 42 loop), shell re-syncs window list and reapplies tiling
  - No full session persistence of app state — just window positions and tiling

- [ ] **M5.4** Crash resilience
  - Compositor catches panics in non-critical paths, logs, continues
  - Shell handles disconnected wire gracefully (reconnect on compositor restart)
  - XWayland crash doesn't take down the session

- [ ] **M5.5** Notifications and system tray (stretch)
  - Basic notification popups (via wlr-layer-shell or shell-side rendering)
  - System tray protocol support (minimal: network, volume icons)

---

## Architecture notes

### How tiling works end-to-end

```
1. User drags window near monitor edge (shell pointer event)
2. Shell tileSnap / assist grid computes snap zone
3. Shell sends set_tile_preview → compositor shows preview quad
4. User releases → shell sends set_geometry for snapped bounds
5. Shell updates per-monitor tiling state (occupied zones)
6. If auto-layout: shell recomputes all window positions, sends set_geometry batch
```

The compositor is intentionally "dumb" about tiling — it just places windows where the shell tells it to. All tiling intelligence lives in the SolidJS shell. This mirrors derp-media-server where the browser handles all layout logic.

### Per-monitor taskbar rendering

The CEF OSR surface spans the entire output canvas (union of all monitors). The shell renders a `<Taskbar>` absolutely positioned at the bottom of each monitor's logical rect. The compositor already has the output_layout data to know where each monitor is — it sends this to the shell via `output_layout` events.

### Config files

| File | Contents |
|------|----------|
| `display.json` | Monitor positions, transforms, scale, shell chrome primary |
| `tiling.json` (new) | Per-monitor layout type + parameters |
| `keybinds.json` (new) | Key binding overrides |

All under `$XDG_CONFIG_HOME/derp-workspace/` (or `DERP_DISPLAY_CONFIG` override).

---

## Priority order

| Priority | Milestone | Effort est. | Rationale |
|----------|-----------|-------------|-----------|
| **P0** | M0 Foundation fixes | 1 week | Can't build reliably without this |
| **P1** | M1 Per-monitor taskbar | 1-2 weeks | Most visible gap — makes multi-monitor feel broken without it |
| **P1** | M4.1-4.2 Basic keybinds | 1 week | Essential for daily use; unblocks keyboard-driven workflow |
| **P2** | M2 Tiling engine port | 2-3 weeks | Core value prop; derp-media-server code is proven, porting is mostly adaptation |
| **P2** | M3 Per-monitor layouts | 1-2 weeks | Builds on M2; the "different layouts per monitor" part |
| **P3** | M5 Polish | 2-3 weeks | Incremental; can ship MVP before all of M5 |
| **P3** | M4.3 Key binding config | 0.5 week | Nice to have; hardcoded defaults work for MVP |

**Total estimated: 8-12 weeks to MVP**

---

## Open questions

1. **Per-monitor scale?** Currently scaling is global (same scale for all heads). The MVP spec says "150% on all monitors" so global is fine. Per-monitor scale is significantly harder (CEF OSR runs at one DPI; would need multiple browser instances or CSS zoom tricks). Defer post-MVP.

2. **Tiling config UI?** For MVP, editing tiling.json by hand is acceptable. A visual layout picker in the shell (like derp-media-server's WorkspaceTilingPicker) can come later.

3. **Tab groups in the DE?** derp-media-server has tab groups (multiple logical panes in one chrome frame). Interesting for the DE (e.g., tabbed terminals) but not MVP. Could be a post-MVP feature where the shell provides a tab container that hosts multiple native windows.

4. **Wayland protocols for shell?** Currently the shell is purely CEF OSR with a custom wire protocol. Consider whether some shell elements (notifications, system tray) should use standard Wayland protocols (wlr-layer-shell, ext-idle-notify) or stay in the custom shell. Custom is simpler and more flexible for now.

5. **App launcher beyond Programs menu?** A rofi/wofi-style overlay launcher triggered by Super+D would be more ergonomic than the current dropdown. Could be a SolidJS component in the shell or a separate Wayland client.
