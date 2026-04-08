# derp-workspace — post-MVP roadmap

> Wayland desktop with a SolidJS shell in CEF OSR. MVP (tiling, per-monitor taskbar, keybinds, layouts) is done; this document tracks polish and next features.

## Baseline (after MVP)

- Smithay compositor: DRM, libseat, EGL/GBM, XWayland, tile preview, exclusion zones
- CEF OSR shell wire: dma-buf shell surface, window chrome, taskbars, menus, tiling UX
- Multi-monitor `display.json`, fractional scale, per-monitor layouts and taskbars

---

## 1) JS shell windows (general-purpose, native-like)

Treat arbitrary shell UI (not only full-screen chrome) as **stackable, focusable regions** the compositor understands like other windows: decorations policy, raise/lower, keyboard focus routing, and optional drag/resize from the compositor side where appropriate.

- [ ] **1.1** Define product semantics: what counts as a “shell window” (settings, launcher overlay, future tools), max stacking order vs Wayland toplevels, and whether min/max/close are meaningful or hidden.
- [ ] **1.2** Compositor: represent shell sub-surfaces or logical “shell_window” ids with geometry, z-order, and focus; extend wire with map/unmap/focus/set_geometry for shell-only rects (or reuse existing chrome partition model if it already has stable ids).
- [ ] **1.3** Input: compositor delivers pointer/keyboard to the focused shell window region; shell dispatches to the right Solid subtree (hit-testing in JS must stay consistent with compositor focus).
- [ ] **1.4** Shell: window container components (title strip, shadow, drag handle) aligned with SSD rules where desired; reuse patterns from existing window chrome where possible.
- [ ] **1.5** Stacking and animations: predictable order when mixing native clients and shell windows; document edge cases (fullscreen shell vs client).

---

## 2) Remove debug-only UI

Strip demo and measurement scaffolding from the main shell surface so daily use is clean.

- [ ] **2.1** Remove the **local draggable DOM demo** (window-level pointer listeners used for the box) from `App.tsx` and any related CSS/state.
- [ ] **2.2** Remove the **desktop right-click demo context menu** (`ctxMenuKind === 'demo'`, `onContextMenu` that seeds demo items); keep programs/power/real menus only.
- [ ] **2.3** Remove the **debug ruler** (horizontal/vertical ticks, `RULER_GUTTER_*`, `shell-ruler-*` in `index.css`) and any layout gaps left only for the ruler.
- [ ] **2.4** Grep for `demo`, `disarmDragDemo`, ruler tokens, and dead wire branches; run shell build and smoke on remote.

---

## 3) Programs menu — input handling improvements

Programs menu uses the same atlas/wire path as other context menus but has more interaction (scroll, search, nested structure if any). Harden it for CEF OSR.

- [ ] **3.1** Audit focus: ensure opening/closing does not leave a stale `ctxMenuKind` or capture state; align with changes after removing demo menu.
- [ ] **3.2** Pointer: reliable hover, click, and scroll wheel inside the menu bounds; verify coordinates match compositor hit region after DPI/scale changes.
- [ ] **3.3** Keyboard: arrow keys, Enter, Escape, type-ahead if present; compositor must route keys to shell while menu is open.
- [ ] **3.4** Boundary cases: rapid open/close, clicking taskbar while open, multi-monitor placement via existing `fitContextMenuGlobalPosition` logic.

---

## 4) Abstract `<Select>` from context menu implementation

Today menus render via atlas + compositor bridge. A reusable **Select** (dropdown) should share positioning, item model, keyboard model, and wire upload with **one** implementation.

- [ ] **4.1** Extract shared primitives from `contextMenu.tsx` (and wire helpers in `App.tsx`): item list type, position/fit, open/close lifecycle, atlas size negotiation.
- [ ] **4.2** Add a thin `Select` API for Solid (value, onChange, options) that composes those primitives without copy-pasting atlas math.
- [ ] **4.3** Migrate at least one consumer (e.g. layout picker or debug stub) to prove the abstraction; delete duplicated logic.
- [ ] **4.4** Document wire contract briefly in code near the shared module (single source of truth for buffer rects).

---

## 5) Settings window (replaces debug menu as primary config UI)

Fold **monitor**, **layout**, and general **session** options into a dedicated settings shell surface (see §1). Debug panel either goes away or shrinks (see §6).

- [ ] **5.1** UX: single settings entry point (taskbar or keybind); sections — Displays, Tiling/layout, Keyboard, Appearance (link §7 for wallpaper), Misc.
- [ ] **5.2** Port fields from the current debug panel: transforms, scale where editable, primary output, per-monitor layout type/params, any toggles that today live only in debug.
- [ ] **5.3** Persistence: read/write `display.json`, tiling config, and future keys through the same paths the shell already uses; validate and show errors in-UI.
- [ ] **5.4** Remove or gate the old debug menu once parity is reached; keep a developer-only path if still needed (env flag or compile-time).

---

## 6) Debug menu — smaller and more useful

Keep a **compact** tool for developers without cluttering the main UI.

- [ ] **6.1** Inventory what is still needed after settings exist (wire stats, last errors, quick reload, FPS, shell/compositor version).
- [ ] **6.2** Collapsed by default: tray icon, small button, or key chord; minimal footprint UI (one column, small typography).
- [ ] **6.3** Remove duplicated settings controls from debug; link “Open settings” instead.
- [ ] **6.4** Optional: copy logs / export snapshot for remote debugging.

---

## 7) Desktop background — compositor rendering

Wallpaper should be **painted by the compositor** behind all surfaces, not drawn as a giant DOM layer in the JS shell (performance, correctness across monitors, and independence from shell crashes).

- [ ] **7.1** Settings model: per-output or global image path/color, fit mode (fill, fit, tile), and optional solid fallback; persist next to other derp config.
- [ ] **7.2** Shell sends background config updates over wire; compositor owns textures/shaders for clearing or layering the backdrop.
- [ ] **7.3** Compositor: load image (appropriate limits), handle hot reload, respect output geometry and transform; avoid blocking the render thread (async decode + GPU upload).
- [ ] **7.4** Remove JS shell wallpaper/backdrop if any; ensure CEF layer is transparent or only draws chrome where needed so the compositor background shows through.
- [ ] **7.5** Test multi-head and fractional scale; verify no visible seam at monitor edges for spanning modes.

---