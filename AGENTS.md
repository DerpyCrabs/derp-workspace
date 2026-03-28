# AGENTS.md — context for AI assistants and maintainers

This file records **operational and implementation details** that are easy to forget across sessions. For product overview and roadmap, see [README.md](README.md).

---

## Install and session flow

- **`scripts/install-system.sh`** — Wrapper: may `git pull`, then **`exec env INSTALL_SKIP_GIT=1 bash scripts/install-system-run.sh`** so the **body** of the install always runs from the **updated** `install-system-run.sh` on disk after a pull.
- **`scripts/install-system-run.sh`** — Build (release compositor, cef_host), npm shell build, install to `/usr/local`, Wayland session desktop.
- **`scripts/derp-session.sh`** — GDM entry: resolves repo root via `readlink -f` on the script path (symlink-safe), starts DRM compositor, optional `cef_host` via `--command`. Logs are **tee’d** into `DERP_COMPOSITOR_LOG` (default `~/.local/state/derp/compositor.log`).

---

## Input logging — **no `DERP_INPUT_DEBUG`**

Users cannot rely on ad-hoc env toggles for input tracing. The codebase **does not** use `DERP_INPUT_DEBUG` / `DERP_INPUT_TRACE`.

**How input debug is enabled:**

1. **`derp-session.sh`** — If `RUST_LOG` is empty, sets `warn,derp_input=debug`. If `RUST_LOG` is set but does not contain `derp_input=`, **appends** `,derp_input=debug`.
2. **`compositor/src/main.rs`** — If `tracing_subscriber::EnvFilter::try_from_default_env()` fails (typically **unset** `RUST_LOG`), falls back to **`warn,derp_input=debug`**.

**Caveat:** If someone runs the compositor **outside** `derp-session` with `RUST_LOG=info` (or similar) **without** `derp_input`, the binary does **not** merge filters — only the default-when-unset path applies. Session launches are covered; raw `cargo run` with a custom `RUST_LOG` is not auto-patched.

**Tracing target:** `derp_input` — pointer motion, buttons, touch emulation, scroll axes; unhandled libinput variants at `trace` to reduce noise.

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

## Remote logs

- **`scripts/list-derp-logs.sh`** — **SSH**s like **`scripts/remote-install.sh`**, using **`scripts/remote-install.env`** (`REMOTE_USER`, `REMOTE_HOST`, `REMOTE_REPO`), then tails `~/.local/state/derp/compositor.log` on that host. Options: `-n`, `-f` / `--follow`.

---

## Known environment / device notes

- Some panels (e.g. **MEGAHUNT Micro MH32**) produce **“Touch jump detected and discarded”** in libinput logs — kernel/driver class behavior; if motion is still wrong, may need quirks, device-specific handling, or care around **`PointerMotionAbsolute`** (not fully special-cased here).
- DRM setups may show **unprivileged master**, missing **`EGL_WL_bind_wayland_display`**, or occasional **`drm_atomic` restore** messages — often driver/session/environment rather than application logic.

---

## Conventions for future changes

- Prefer **extending** existing input and `DesktopStack` paths over parallel one-off handlers.
- Keep **install** behavior split: thin `install-system.sh` + `install-system-run.sh` so post-pull script updates apply without asking users to re-copy installers manually.
- When debugging **gray screen / input / cursor**, start from **`compositor.log`** and **`derp_input`** lines, then libinput/kernel messages if coordinates look wrong.
