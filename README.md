# derp-workspace

**Warning:** This app is fully vibecoded—experimental, uneven quality, and not something to trust for production or security-sensitive use. Expect rough edges, missing polish, and behavior that can change without notice.

## What it is

A **Wayland compositor** (Rust, Smithay) that embeds the desktop **shell inside Chromium (CEF) off-screen rendering**. The UI is **SolidJS** in the browser; it talks to the compositor over a **binary wire protocol** (`shell_wire`) and JSON bridging, so the “desktop” (panels, chrome, tiling UX) is largely driven from JS while input, DRM/KMS, and Wayland clients stay in native code.

## What’s unusual

- **Compositor + embedded browser as one session**: dma-buf–accelerated CEF OSR for the shell, not a separate panel process talking only over standard protocols.
- **JS-first shell control**: window chrome, taskbar, menus, and related UX orchestrate the compositor through the custom protocol rather than a traditional widget toolkit.
- **Aimed at a tiling / multi-monitor DE** similar in spirit to ideas ported from [derp-media-server](https://github.com/DerpyCrabs/derp-media-server), but still maturing.

## Features (current direction)

- DRM/EGL/GBM compositing, libseat session, **XWayland**
- **Fractional scaling** (global 100% / 150% / 200%), **multi-monitor** layout and `display.json` persistence
- SolidJS shell: window chrome (SSD), taskbar, programs/power menus, context menus
- Window actions via wire: move, resize, minimize, maximize, close, fullscreen
- Basic **snap tiling**, tile preview overlay, exclusion zones for decorations
- **Remote deploy**: rsync + install + in-place compositor reload (`SIGUSR2`) from your dev machine

## Deploy

**Target:** Linux with DRM/KMS, typical dev headers for Smithay/CEF builds, and Node for the shell build. Session integration uses **GDM** and `scripts/derp-session.sh` (installed as `derp-session`).

**On the compositor machine** (from a clone of this repo):

```bash
bash scripts/install-system.sh
```

Optional: `INSTALL_SKIP_GIT=1` or `--no-git` if you do not want `git pull`. Installs under `/usr/local` and registers the Wayland session **Derp Compositor** in GDM (`resources/derp-wayland.desktop`). If you use a non-default `INSTALL_PREFIX`, align the `.desktop` `Exec=` path with your install.

**From another machine** (SSH): copy `scripts/remote-install.env.example` to `scripts/remote-install.env`, set `REMOTE_HOST`, `REMOTE_USER`, and `REMOTE_REPO`, then:

```bash
bash scripts/remote-install.sh
```

**Iterating without pushing git:** sync working tree, build/install, and reload compositor:

```bash
bash scripts/remote-update-and-restart.sh
```

Logs and SSH details: [scripts/remote-install.sample.md](./scripts/remote-install.sample.md).

## Repo layout

| Path | Role |
|------|------|
| `compositor/` | Smithay compositor, CEF integration |
| `shell_wire/` | Binary encode/decode for compositor ↔ shell |
| `shell/` | SolidJS + Vite UI |
| `scripts/` | Install, session launcher, remote update |
