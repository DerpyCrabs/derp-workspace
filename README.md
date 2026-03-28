# derp-workspace — Wayland compositor + CEF shell

## What this is

This repository is building a **custom Wayland compositor** in **Rust** on top of **[Smithay](https://github.com/Smithay/smithay)**. The long-term UI stack is **web-first**: **SolidJS**, **HTML**, and **CSS** run inside **[CEF](https://bitbucket.org/chromiumembedded/cef)** (Chromium Embedded Framework). That shell does not replace the compositor; it **drives it over a dedicated IPC layer**.

Rough split of responsibilities:

- **Compositor (Rust + Smithay):** protocol support, surfaces and buffers, input routing, focus, window management primitives, optional GPU presentation, and enforcement of security/performance boundaries.
- **Shell (SolidJS in CEF):** window chrome, controls, panels, docks, notifications, settings, and **first-party “internal” apps** — anything that benefits from fast UI iteration in familiar web tooling.
- **IPC:** stable, versioned messages between the two processes (today there is a small stub in `compositor/src/chrome_bridge.rs`: commands like geometry/fullscreen/close and events like window/focus changes).

**Native Wayland applications** remain first-class: they connect as ordinary clients. The compositor exposes enough structure (stable window/surface ids, geometry, stacking) so the **SolidJS shell can position native surfaces and draw HTML+CSS “decorations”** around them — title bars, shadows, tab strips, or full custom frames — without those apps needing to know about CEF.

Today the tree is a **minimal Smithay compositor** (winit/nested and headless modes, tests, CI); CEF and SolidJS are **planned**, not yet wired.

---

## Design goals

1. **Single source of truth for chrome** — one toolkit (web) for frames, panels, and in-house tools; native apps get a consistent look via compositor-assisted decoration.
2. **Process isolation** — shell crashes or heavy JS must not take down the display server; IPC is the seam.
3. **Interop** — standard Wayland clients work; internal tools can be thin web views with full IPC access.
4. **Evolvable protocol** — IPC carries an explicit `protocol_version` (see `CHROME_BRIDGE_PROTOCOL_VERSION`) so the Rust side and the CEF side can roll out changes safely.

---

## Architecture (target)

```text
┌─────────────────────────────────────────────────────────┐
│  CEF process: SolidJS + HTML/CSS (shell + internal apps) │
│  - panels, chrome, decorations (DOM over native hints)   │
└───────────────────────────┬─────────────────────────────┘
                            │ IPC (JSON/Cap’n Proto/TBD)
┌───────────────────────────▼─────────────────────────────┐
│  Compositor (Rust + Smithay)                             │
│  - wl_compositor, shells, input, layers                 │
│  - native surfaces + optional “decoration” compositing   │
└───────────────────────────┬─────────────────────────────┘
                            │ Wayland
┌───────────────────────────▼─────────────────────────────┐
│  Native apps + internal web views (as Wayland clients)   │
└─────────────────────────────────────────────────────────┘
```

**Decorating native apps** implies the compositor either:

- treats “toplevel + decoration region” as a **tree of surfaces** (client content inset, shell-owned overlay surfaces), or  
- composites into an internal scene graph where **shell textures** (from shared memory or GPU) sit beside **client buffers** under one logical window id.

Exact choice is implementation detail; the product requirement is: **SolidJS drives layout and styling; Rust enforces clipping, input, and protocol correctness.**

---

## Roadmap

Phases are ordered for incremental risk: get Wayland and rendering solid, then IPC, then CEF, then polish.

### Phase 0 — Baseline (current direction)

- Smithay-based compositor with headless and nested (winit) backends.
- Core state: clients, surfaces, basic focus and stacking.
- Stub **`ChromeBridge`** trait: command/event shapes for future IPC (`chrome_bridge.rs`).
- CI, manual checklist (`MANUAL_CHECKLIST.md`).

### Phase 1 — Window model & shell hooks

- Stable **window/surface identity** exposed to the bridge (map internal state ↔ Wayland objects).
- Events: map/unmap, title/app-id, geometry, focus, workspace/tag hooks (as needed).
- Commands: move/resize, raise/lower, fullscreen, close, optional workspace assignment.
- Unit/integration tests for bridge semantics **without** CEF.

### Phase 2 — IPC transport & schema

- Choose wire format (e.g. length-prefixed JSON with schema version, or protobuf/Cap’n Proto).
- Unix socket or stdio pair between compositor and shell process.
- **Back-pressure and batching** for high-frequency geometry updates.
- **Security model:** single trusted local connection; validate all inputs; never execute shell content inside the compositor.

### Phase 3 — CEF host process

- Separate binary that **embeds CEF**, loads the SolidJS bundle, and speaks IPC to the compositor.
- **Off-screen rendering** or shared-texture path (platform-specific) so the compositor can place shell pixels in the scene.
- Lifecycle: shell restart without losing the session (compositor holds truth; shell reconciles on reconnect).

### Phase 4 — SolidJS shell UX

- Window chrome, panel layer, internal apps (settings, launcher, etc.).
- **Decoration contract for native apps:** data model for margins, hit-testing (where clicks go to chrome vs client), and theme CSS variables mirrored from compositor state if needed.

### Phase 5 — Native app decoration hardening

- **Pointer and keyboard routing** with clear regions (server-side decoration patterns, possibly inspired by xdg-shell and related protocols).
- HiDPI, fractional scale, and **resize/edges** that stay coherent when solid chrome and client buffers disagree during transitions.
- Optional protocol extensions only if core wl/xdg flows are insufficient (prefer standard flows).

### Phase 6 — Hardening & distribution

- Sandboxing story for CEF; crash recovery; performance profiling (frame latency, IPC overhead).
- Packaging (e.g. OCI image, distro packages) and documentation for contributors.

---

## Repository layout

| Path | Role |
|------|------|
| `compositor/` | Rust workspace member: Smithay compositor, `chrome_bridge` stub, winit/headless entrypoints |
| `MANUAL_CHECKLIST.md` | Manual QA for nested and headless runs |

---

## Contributing mindset

Prefer **small, reviewable changes** that keep headless tests green. When extending IPC, bump **`CHROME_BRIDGE_PROTOCOL_VERSION`** (or equivalent) and document compatibility rules in code reviews.

---

*Last updated: 2026-03-28*
