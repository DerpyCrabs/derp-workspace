# derp-workspace — Wayland compositor + CEF shell

## What this is

This repository is building a **custom Wayland compositor** in **Rust** on top of **[Smithay](https://github.com/Smithay/smithay)**. The long-term UI stack is **web-first**: **SolidJS**, **HTML**, and **CSS** run inside **[CEF](https://bitbucket.org/chromiumembedded/cef)** (Chromium Embedded Framework). That shell does not replace the compositor; it **drives it over a dedicated IPC layer**.

Rough split of responsibilities:

- **Compositor (Rust + Smithay):** protocol support, surfaces and buffers, input routing, focus, window management primitives, optional GPU presentation, and enforcement of security/performance boundaries.
- **Shell (SolidJS in CEF):** window chrome, controls, panels, docks, notifications, settings, and **first-party “internal” apps** — anything that benefits from fast UI iteration in familiar web tooling.
- **IPC:** stable, versioned messages between the two processes (today there is a small stub in `compositor/src/chrome_bridge.rs`: commands like geometry/fullscreen/close and events like window/focus changes).

**Native Wayland applications** remain first-class: they connect as ordinary clients. The compositor exposes enough structure (stable window/surface ids, geometry, stacking) so the **SolidJS shell can position native surfaces and draw HTML+CSS “decorations”** around them — title bars, shadows, tab strips, or full custom frames — without those apps needing to know about CEF.

The tree includes a **minimal Smithay compositor** (winit/nested and headless, tests, CI), a **Phase‑3 slice** for shell pixels (`shell_wire` + Unix socket + compositor overlay), a **SolidJS** app in [`shell/`](shell/), and the **`cef_host`** binary (CEF windowless / OSR → that IPC). Window‑chrome commands on the wire are still future work.

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
| `compositor/` | Smithay compositor, `chrome_bridge` stub, winit/headless entrypoints, shell IPC listener (winit) |
| `shell_wire/` | Shared length‑prefixed BGRA frame codec (`SHELL_PIXEL_PROTOCOL_VERSION`) |
| `cef_host/` | CEF OSR process: loads a URL, pushes frames to the compositor socket |
| `shell/` | Vite + SolidJS UI built to `shell/dist/` for CEF `file://` loading |
| `MANUAL_CHECKLIST.md` | Manual QA for nested and headless runs |

### Phase 3 dev setup (nested compositor + shell)

1. **CEF / libcef.so:** The `cef-dll-sys` crate builds **`libcef_dll_wrapper` against a specific `libcef.so`**. At runtime you **must** load that same `libcef.so` (the one under `target/**/libcef.so` after `cargo build -p cef_host`). The **`cef_host` binary embeds a `RUNPATH`** to that directory so a plain `target/debug/cef_host` usually finds `libcef.so` even with no `LD_LIBRARY_PATH`; putting **another** `libcef.so` first on `LD_LIBRARY_PATH` (or an old **`CEF_PATH`**-derived path) still overrides and triggers **`CefApp_0_CToCpp called with invalid version -1`** (API hash mismatch).
   - Easiest: use **`bash scripts/run-nested.sh`** (nested compositor + shell) or **`bash scripts/run-cef-host.sh -- --url file://…`** so the toolchain CEF directory is chosen automatically. **`scripts/run-nested.sh` prefers the Cargo-built CEF** over a conflicting `CEF_PATH`.
   - Manual: `export CEF_PATH=<same dir as readelf RUNPATH on target/debug/cef_host>` (resources + `libcef.so`). You usually **do not** need `LD_LIBRARY_PATH` if you did not override it with another `libcef` tree.
2. **Solid bundle:** From repo root, `cd shell && npm install && npm run build` (output in `shell/dist/`).
3. **One-shot nested + Solid:** from a real session (`XDG_RUNTIME_DIR` set), run **`bash scripts/run-nested.sh`**. It **`cargo build`s compositor + `cef_host`**, **`npm run build`s `shell/`**, then starts the nested compositor and `cef_host`. Set **`NESTED_SKIP_BUILD=1`** to skip rebuilds, or **`NESTED_NO_SHELL=1`** for compositor-only.
4. **Compositor without the script:** `cargo run -p compositor` still listens for shell IPC on **`derp-shell.sock`** by default.
5. **CEF host alone:** `bash scripts/run-cef-host.sh -- --url "file://$(realpath shell/dist/index.html)"`

`cef_host` follows **tauri-apps/cef-rs** `cefsimple` multiprocess wiring: **`api_hash`**, **`execute_process` with no `App`** (subprocesses must not construct `CefApp`), then **`Cli::parse`** and **`initialize` with `App`** only in the browser process. If you passed `App` into `execute_process`, subprocesses could hit **`CefApp_… invalid version -1`**. Ozone defaults to Wayland/X11 when `WAYLAND_DISPLAY`/`DISPLAY` are set; headless is used only when both are unset.

The compositor draws Wayland clients first, then **overlays** the latest shell frame when one has been received.

---

## Contributing mindset

Prefer **small, reviewable changes** that keep headless tests green. When extending IPC, bump **`CHROME_BRIDGE_PROTOCOL_VERSION`** (or equivalent) and document compatibility rules in code reviews.

**CEF / `cef_host`:** Default `cargo test` does not run Chromium (no `libcef.so` in clean CI, large downloads). **SolidJS E2E (opt-in):** after `cargo build -p cef_host` and `(cd shell && npm run build)`, run  
`RUN_SOLID_SHELL_E2E=1 cargo test -p compositor solid_shell_overlay_drawn -- --ignored`  
(Linux; headless compositor + `cef_host`; asserts the shell frame is not blank via `DERP_SHELL_E2E_STATUS`).

There is an **opt-in** regression test that `execute_process` runs before CLI parsing (subprocess argv must not hit clap’s `--url` requirement):

`RUN_CEF_INTEGRATION=1 cargo test -p cef_host --test subprocess_argv -- --ignored`

A mismatched **`libcef.so` vs `libcef_dll_wrapper`** still has to be caught by using the toolchain tree or that integration run with a real build.

---

*Last updated: 2026-03-28*
