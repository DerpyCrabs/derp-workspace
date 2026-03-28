# AGENTS.md — context for AI assistants and maintainers

This file records **operational and implementation details** that are easy to forget across sessions. For product overview and roadmap, see [README.md](README.md).

---

## Install and session flow

- **`scripts/install-system.sh`** — Wrapper: may `git pull`, then **`exec env INSTALL_SKIP_GIT=1 bash scripts/install-system-run.sh`** so the **body** of the install always runs from the **updated** `install-system-run.sh` on disk after a pull.
- **`scripts/install-system-run.sh`** — Build (release compositor, cef_host), npm shell build, install to `/usr/local`, Wayland session desktop.
- **`scripts/derp-session.sh`** — GDM entry: resolves repo root via `readlink -f` on the script path (symlink-safe), starts DRM compositor, optional `cef_host` via `--command`. Compositor and `--command` stdout/stderr **append** to `DERP_COMPOSITOR_LOG` (default `~/.local/state/derp/compositor.log`).

Full detail for every shell helper is in **[Scripts reference](#scripts-reference)** below.

---

## Scripts reference

All live under **`scripts/`**. Several SSH helpers share **`scripts/remote-install.env`** (gitignored; copy from **`remote-install.env.example`**) — see **`remote-install.sample.md`** for workflow notes.

| Script | Role |
|--------|------|
| **`install-system.sh`** | One-shot deploy: optional `git pull`, then **`exec`** into **`install-system-run.sh`** so post-pull script changes apply without re-copying a stale installer. Env: **`INSTALL_SKIP_GIT`**, **`INSTALL_PREFIX`** (default `/usr/local`); flags **`--no-git`**. Comments at top list **`DERP_PERF_SESSION`**, watchdog, logging paths. |
| **`install-system-run.sh`** | **No git** — `cargo build --release -p compositor -p cef_host`, `shell/` npm build, **`sudo install`** binaries + **`resources/derp-wayland.desktop`**, symlink **`/usr/local/bin/derp-session`** → repo’s **`derp-session.sh`**. Invoked locally or remotely after rsync. |
| **`derp-session.sh`** | **GDM `Exec=`** session: DRM compositor, optional **`--command`** chain (Python **`http.server`** on **`shell/dist`** → **`launch-cef-to-compositor.sh`** → **`cef_host`**). Resolves **`ROOT`** via canonical path (symlink-safe). Env defaults: **`DERP_ALLOW_SHELL_SPAWN=1`**, **`DERP_SHELL_WATCHDOG_SEC=5`**, **`RUST_LOG`** merges **`derp_input=debug`**; **`DERP_PERF_SESSION=1`** adds **`shell_ipc=trace`** + **`CEF_HOST_PERF`**. Session output **redirects** to **`DERP_COMPOSITOR_LOG`**. Supervisor loop: **`DERP_COMPOSITOR_RESPAWN=1`** (default) respawns unless exit code **42** (SIGUSR2 reload). Override binaries: **`COMPOSITOR_BIN`**, **`CEF_HOST_BIN`**, socket **`DERP_WAYLAND_SOCKET`**, disable overlay **`DERP_SESSION_SHELL=0`**. |
| **`launch-cef-to-compositor.sh`** | Thin **`exec`** stub: requires **`CEF_PATH`**, **`CEF_SHELL_URL`**, **`CEF_HOST_BIN`** (set by **`derp-session`** / **`run-nested`**); runs **`cef_host --url`**. |
| **`list-derp-logs.sh`** | **SSH** to **`REMOTE_HOST`** (same env as **`remote-install.sh`**), **`cd REMOTE_REPO`**, runs embedded tail of **`~/.local/state/derp/compositor.log`** (or host’s **`DERP_COMPOSITOR_LOG`**). Flags: **`-n N`**, **`-f` / `--follow`**. Can run locally on the session machine via **`LIST_DERP_LOGS_INTERNAL=1`** (used by the SSH stub). |
| **`nested-smoke.sh`** | CI/dev smoke: temp **`XDG_RUNTIME_DIR`**, starts **Weston** (headless backend if available), runs compositor **`--headless --run-for-ms`** under **`timeout`**. Needs **`weston`** + built **`compositor`**. |
| **`remote-install.sh`** | **SSH** remote **`cd REMOTE_REPO`**; by default **`git stash push`** of dirty **`scripts/derp-session.sh`** before **`install-system.sh`** (disable with **`STASH_DERP_SESSION=0`** or **`--no-stash`**); forwards args to **`install-system.sh`** after **`--`**. |
| **`remote-update-and-restart.sh`** | Local **`rsync`** repo → remote (excludes **`target/`**, **`shell/node_modules/`**, **`.git/`**), remote **`install-system-run.sh`**, then **SIGUSR2** all user **`compositor`** PIDs (in-place reload → exit **42** + respawn). Flags: **`--no-restart`**, **`--dry-run`**, pass-through args after **`--`**. |
| **`run-cef-host.sh`** | Dev helper: finds **`libcef.so`** via **`cef_host`** RUNPATH or **`target/`**, sets **`CEF_PATH`**, **`exec cef_host`** with extra argv. Avoid stacking **`LD_LIBRARY_PATH`** that overrides RUNPATH. |
| **`run-nested.sh`** | Nested **winit** compositor in current session: unique **`WAYLAND_DISPLAY`** (default **`derp-nested-$$`**); optional cargo/npm build unless **`NESTED_SKIP_BUILD=1`**; Solid via loopback HTTP + **`--command`** like **`derp-session`**. **`NESTED_NO_SHELL=1`** skips CEF. Exports **`DERP_ALLOW_SHELL_SPAWN=1`**. Uses **`COMPOSITOR_BIN`** (default debug). |

---

## Input logging — **no `DERP_INPUT_DEBUG`**

Users cannot rely on ad-hoc env toggles for input tracing. The codebase **does not** use `DERP_INPUT_DEBUG` / `DERP_INPUT_TRACE`.

**How input debug is enabled:**

1. **`derp-session.sh`** — If `RUST_LOG` is empty, sets `warn,derp_input=debug`. If `RUST_LOG` is set but does not contain `derp_input=`, **appends** `,derp_input=debug`.
2. **`compositor/src/main.rs`** — If `tracing_subscriber::EnvFilter::try_from_default_env()` fails (typically **unset** `RUST_LOG`), falls back to **`warn,derp_input=debug`**.

**Caveat:** If someone runs the compositor **outside** `derp-session` with `RUST_LOG=info` (or similar) **without** `derp_input`, the binary does **not** merge filters — only the default-when-unset path applies. Session launches are covered; raw `cargo run` with a custom `RUST_LOG` is not auto-patched.

**Tracing target:** `derp_input` — high-frequency **relative/absolute pointer motion** and **touch motion** log at **`trace`** (use `derp_input=trace` to see them); buttons, touch down/up, scroll, etc. remain **`debug`**. This avoids filling `compositor.log` with hundreds of lines per second during normal mouse movement (which was causing noticeable I/O lag when the session tee is enabled).

---

## Input and cursor (compositor)

Relevant modules:

- **`compositor/src/input.rs`** — `InputEvent::PointerMotion` (relative libinput) with clamp to output; shared path for pointer updates. **Touch → pointer emulation** (`TouchDown` / `Motion` / `Up` / `Cancel`), first finger only; coordinates from **window pixels** when appropriate vs. transformed absolute for DRM.
- **`compositor/src/state.rs`** — `touch_abs_is_window_pixels`, touch emulation slot, cursor image state, **`cursor_fallback_buffer`** (small solid buffer for named-cursor fallback).
- **`compositor/src/winit.rs`** — Sets `touch_abs_is_window_pixels` after output mapping; includes pointer elements in the render path.
- **`compositor/src/drm.rs`** — Same pointer composition path for KMS.
- **`compositor/src/pointer_render.rs`**, **`desktop_stack.rs`** — `DesktopStack` carries Wayland `Pointer` + optional `CursorFb` (`SolidColorRenderElement`). **`wp_cursor_shape` `Named`** uses the **solid fallback** (KMS had nothing to composite for themed shapes without a client buffer). **`Surface`** uses the surface tree; **`Hidden`** draws nothing.

Touch vs. pointer coordinate rules matter for **nested winit** vs **DRM**; keep `touch_abs_is_window_pixels` in sync with the backend.

---

## Known environment / device notes

- Some panels (e.g. **MEGAHUNT Micro MH32**) produce **“Touch jump detected and discarded”** in libinput logs — kernel/driver class behavior; if motion is still wrong, may need quirks, device-specific handling, or care around **`PointerMotionAbsolute`** (not fully special-cased here).
- DRM setups may show **unprivileged master**, missing **`EGL_WL_bind_wayland_display`**, or occasional **`drm_atomic` restore** messages — often driver/session/environment rather than application logic.

---

## Shell / CEF OSR vs native surfaces

The Solid UI is **windowless OSR** today: BGRA frames over `shell_wire` shm into a `MemoryRenderBuffer`, with optional **partial damage** when CEF supplies dirty rects (`MSG_FRAME_SHM_COMMIT`).

**`shell_wire`:** messages are `[u32 body_len][body]` with **`body` = `msg_type` + payload** — there is **no** separate protocol-version field. Any on-wire layout change is a breaking change: deploy **`compositor` and `cef_host` from the same tree/build** (`install-system-run.sh`); mismatched binaries will mis-decode or reject payloads.

If profiling shows this path is still CPU-bound at target resolution, the strategic forks are: **(1)** CEF as a real **Wayland client** (`CEF_HOST_USE_WAYLAND_PLATFORM`, rework pointer + `shell_uplink` + transparency/letterbox), or **(2)** **dmabuf/zero-copy** from CEF/ANGLE if a future build can export shareable buffers and the compositor gains an import path. Prefer measuring with **`DERP_PERF_SESSION=1`** (see `install-system.sh`) before large migrations.

---

## Conventions for future changes

- Prefer **extending** existing input and `DesktopStack` paths over parallel one-off handlers.
- Keep **install** behavior split: thin `install-system.sh` + `install-system-run.sh` so post-pull script updates apply without asking users to re-copy installers manually.
- When changing **`shell_wire`** framing, treat it as breaking IPC (see **Shell / CEF** → `shell_wire`); keep **`compositor`** and **`cef_host`** in sync.
- When debugging **gray screen / input / cursor**, start from **`compositor.log`** and **`derp_input`** lines, then libinput/kernel messages if coordinates look wrong.
