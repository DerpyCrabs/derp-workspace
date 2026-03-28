# derp-workspace — Wayland compositor + CEF shell

## What this is

This repository is building a **custom Wayland compositor** in **Rust** on top of **[Smithay](https://github.com/Smithay/smithay)**. The long-term UI stack is **web-first**: **SolidJS**, **HTML**, and **CSS** run inside **[CEF](https://bitbucket.org/chromiumembedded/cef)** (Chromium Embedded Framework). That shell does not replace the compositor; it **drives it over a dedicated IPC layer**.

Rough split of responsibilities:

- **Compositor (Rust + Smithay):** protocol support, surfaces and buffers, input routing, focus, window management primitives, optional GPU presentation, and enforcement of security/performance boundaries.
- **Shell (SolidJS in CEF):** window chrome, controls, panels, docks, notifications, settings, and **first-party “internal” apps** — anything that benefits from fast UI iteration in familiar web tooling.
- **IPC:** stable, versioned messages between the two processes (today there is a small stub in `compositor/src/chrome_bridge.rs`: commands like geometry/fullscreen/close and events like window/focus changes).

**Native Wayland applications** remain first-class: they connect as ordinary clients. The compositor exposes enough structure (stable window/surface ids, geometry, stacking) so the **SolidJS shell can position native surfaces and draw HTML+CSS “decorations”** around them — title bars, shadows, tab strips, or full custom frames — without those apps needing to know about CEF.

The tree includes a **minimal Smithay compositor** (winit/nested and headless, tests, CI), a **Phase‑3 slice** for shell pixels (`shell_wire` + Unix socket + compositor overlay), a **SolidJS** app in [`shell/`](shell/), and the **`cef_host`** binary (CEF windowless / OSR → that IPC). **Shell → compositor** control messages include move (existing), **list windows**, **set geometry**, **close**, **fullscreen**, and **quit session** (`SHELL_PIXEL_PROTOCOL_VERSION` **5**); the Solid shell exposes these via HTTP control → shell socket where applicable.

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
| `compositor/` | Smithay compositor, `chrome_bridge` stub, winit + **DRM/KMS** + headless entrypoints, shell IPC |
| `resources/derp-wayland.desktop` | GDM session entry (`wayland-sessions`) |
| `scripts/derp-session.sh` | Session wrapper: `--backend drm`, optional CEF + `shell/dist` |
| `scripts/install-system.sh` | One-shot: pull, release build, npm `shell/dist`, install to `/usr/local` + GDM `.desktop` |
| `shell_wire/` | Length‑prefixed messages: BGRA frames, spawn, shell IPC move/geometry/close/fullscreen/quit/list, compositor→shell output geometry, window events, pointer (`SHELL_PIXEL_PROTOCOL_VERSION`, currently **5**) |
| `cef_host/` | CEF OSR process: loads a URL, pushes frames to the compositor socket |
| `shell/` | Vite + SolidJS UI built to `shell/dist/` for CEF `file://` loading |
| `MANUAL_CHECKLIST.md` | Manual QA for nested and headless runs |

### GDM / DRM login session

1. **One-command install (repo anywhere, e.g. `~/derp-workspace`):** `bash scripts/install-system.sh` — `git pull` (unless `--no-git` / `INSTALL_SKIP_GIT=1`), `cargo build --release -p compositor -p cef_host`, `npm` build for `shell/dist`, then installs into `/usr/local` and symlinks `derp-session` to this clone so the Solid/CEF wrapper finds `shell/dist`.
2. **Manual install:** `cargo build --release -p compositor -p cef_host`; then `sudo install -Dm755 target/release/compositor /usr/local/bin/` and `sudo install -Dm755 target/release/cef_host /usr/local/bin/`; `sudo ln -sf "$(pwd)/scripts/derp-session.sh" /usr/local/bin/derp-session`; `sudo install -Dm644 resources/derp-wayland.desktop /usr/share/wayland-sessions/derp-wayland.desktop`.
3. **GDM:** Pick **Derp Compositor**. The wrapper runs `compositor --backend drm` under your `XDG_RUNTIME_DIR` (requires **libseat** / logind session). Override the GPU node with **`DERP_DRM_DEVICE`** (e.g. `/dev/dri/card0`) if detection fails.
4. **Stack:** KMS + GBM + EGL GLES + libinput; Mesa on Intel/AMD is the expected path. See DRM limitations in code comments if a driver misbehaves.

### Phase 3 dev setup (nested compositor + shell)

1. **CEF / libcef.so:** The `cef-dll-sys` crate builds **`libcef_dll_wrapper` against a specific `libcef.so`**. At runtime you **must** load that same `libcef.so` (the one under `target/**/libcef.so` after `cargo build -p cef_host`). The **`cef_host` binary embeds a `RUNPATH`** to that directory so a plain `target/debug/cef_host` usually finds `libcef.so` even with no `LD_LIBRARY_PATH`; putting **another** `libcef.so` first on `LD_LIBRARY_PATH` (or an old **`CEF_PATH`**-derived path) still overrides and triggers **`CefApp_0_CToCpp called with invalid version -1`** (API hash mismatch).
   - Easiest: use **`bash scripts/run-nested.sh`** (nested compositor + shell) or **`bash scripts/run-cef-host.sh -- --url file://…`** so the toolchain CEF directory is chosen automatically. **`scripts/run-nested.sh` prefers the Cargo-built CEF** over a conflicting `CEF_PATH`.
   - Manual: `export CEF_PATH=<same dir as readelf RUNPATH on target/debug/cef_host>` (resources + `libcef.so`). You usually **do not** need `LD_LIBRARY_PATH` if you did not override it with another `libcef` tree.
2. **Solid bundle:** From repo root, `cd shell && npm install && npm run build` (output in `shell/dist/`).
3. **One-shot nested + Solid:** from a real session (`XDG_RUNTIME_DIR` set), run **`bash scripts/run-nested.sh`**. It **`cargo build`s compositor + `cef_host`**, **`npm run build`s `shell/`**, then starts the nested compositor and `cef_host`. Set **`NESTED_SKIP_BUILD=1`** to skip rebuilds, or **`NESTED_NO_SHELL=1`** for compositor-only.
4. **Compositor without the script:** `cargo run -p compositor` still listens for shell IPC on **`derp-shell.sock`** by default. To allow the Solid “run native app” control path, set **`DERP_ALLOW_SHELL_SPAWN=1`** (see above).
5. **CEF host alone:** `bash scripts/run-cef-host.sh -- --url "file://$(realpath shell/dist/index.html)"`

`cef_host` follows **tauri-apps/cef-rs** `cefsimple` multiprocess wiring: **`api_hash`**, **`execute_process` with no `App`** (subprocesses must not construct `CefApp`), then **`Cli::parse`** and **`initialize` with `App`** only in the browser process. If you passed `App` into `execute_process`, subprocesses could hit **`CefApp_… invalid version -1`**. Ozone defaults to Wayland/X11 when `WAYLAND_DISPLAY`/`DISPLAY` are set; headless is used only when both are unset.

The compositor draws Wayland clients first, then **overlays** the latest shell frame when one has been received.

**Shell pointer input:** The overlay is not a Wayland surface, so the compositor **forwards** pointer move/button events over the same Unix socket (`MSG_COMPOSITOR_POINTER_MOVE` / `MSG_COMPOSITOR_POINTER_BUTTON` in [`shell_wire`]) for `cef_host` to inject via CEF OSR. `cef_host` uses a **`try_clone` read thread** so frame writes stay on a blocking socket.

**Shell → native spawn:** `cef_host` serves `POST http://127.0.0.1:<port>/spawn` (loopback only) and forwards JSON `{"command":"…"}` as a `shell_wire` spawn message. The Solid shell uses an inline **command field** (not `window.prompt`): windowless CEF has no parent window for native JS dialogs. The compositor runs `sh -c` with **`WAYLAND_DISPLAY` set to the nested socket** only when **`DERP_ALLOW_SHELL_SPAWN=1`** (set automatically by **`scripts/run-nested.sh`**). The Solid app uses **`window.__DERP_SPAWN_URL`** (injected on load) for the **“Run native app in compositor”** button.

### Known limitations (nested clients & GPU)

**Warnings from `wayland.c` (e.g. in foot):** If you run a terminal such as **`foot`** against the nested socket, you may see messages like “compositor does not implement the primary selection interface”, “does not implement XDG activation”, “does not implement fractional scaling”, “does not implement server-side cursors”, “does not implement the xdg-toplevel-icon protocol”, “text input interface not implemented”, or “no decoration manager available”. Those come from the **client**, not from the compositor’s Rust code. They mean the compositor does not yet advertise those **optional** Wayland protocols (some of these are implemented in recent `compositor` builds; **`cargo build -p compositor`** so foot sees the current globals). Remaining warnings go away as more protocols are added (see roadmap **Phase 5**).

**`Connection reset by peer`:** Usually the nested **`WAYLAND_DISPLAY` socket closed** (you closed the compositor window, the process exited, or the client was killed). It is not specific to foot.

**Performance / `llvmpipe`:** Startup logs may show **OpenGL ES** using **`llvmpipe`** (software rasterization). That makes nested compositing very slow. Common causes: **nested EGL** on a **proprietary NVIDIA** stack with Mesa’s LLVMpipe fallback, or **EGL_BAD_ALLOC** / “failed to create dri2 screen” during device enumeration. Mitigations to try: run the parent session on **Mesa** where possible, use **integrated graphics** for the nested window, or adjust driver and compositor settings so the winit EGL context binds to a real GPU. Check logs for `GL Renderer:` after `renderer_gles2` initializes.

**EGL `BAD_SURFACE` / blank nested window:** In nested mode the winit backend must **swap the EGL surface after each `bind()`**. Omitting `eglSwapBuffers` when the damage tracker skips drawing can leave the display in a bad state on some stacks, followed by **`Connection reset by peer`** for clients. Use a current `compositor` build; if you still see `BAD_SURFACE`, treat it like the `llvmpipe`/NVIDIA EGL issues above.

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
