#!/usr/bin/env bash
# One-shot: sync repo (optional), build release compositor + cef_host + Solid shell,
# install into /usr/local and register the GDM Wayland session.
#
# After an optional `git pull`, execution continues via install-system-run.sh so any updates
# to these scripts on disk are used for the build/install phase.
#
# Run from anywhere:
#   bash /path/to/derp-workspace/scripts/install-system.sh
#
# Env:
#   INSTALL_SKIP_GIT=1     — skip `git pull`
#   INSTALL_PREFIX=/usr/local — install root (default /usr/local)
#
# Solid OSR: dma-buf only in cef_host + compositor (no CEF_HOST_USE_GPU / CEF_HOST_OSR_DMABUF env).
#
# Rendering / OSR debug (optional):
#   Export DERP_PERF_SESSION=1 before GDM login (e.g. ~/.config/environment.d/derp-perf.conf with
#   DERP_PERF_SESSION=1) so scripts/derp-session.sh appends derp_shell_sync=trace to RUST_LOG and sets
#   CEF_HOST_PERF=1 for cef_host. Logs: DERP_COMPOSITOR_LOG (default ~/.local/state/derp/compositor.log).
#   Deploy to a test host: bash scripts/remote-update-and-restart.sh
#   Fetch logs: bash scripts/list-derp-logs.sh -n 2000  (uses scripts/remote-install.env)
#
# GDM session (`scripts/derp-session.sh`) exports DERP_SHELL_WATCHDOG_SEC=5 by default so a stuck
# `cef_host` does not leave the session hung; set DERP_SHELL_WATCHDOG_SEC=0 before login to disable.
#
# `derp-session` will run `npm install && npm run build` in shell/ if `shell/dist/index.html` is missing
# (requires Node on the login machine). Prefer a successful install here so GDM start is fast.
#
# Session logging: each compositor start truncates DERP_COMPOSITOR_LOG (incl. reload after exit 42)
# unless DERP_COMPOSITOR_LOG_APPEND=1; then compositor + cef_host stdout/stderr append. Default file:
# ~/.local/state/derp/compositor.log — inspect via `scripts/list-derp-logs.sh`. `derp-session` sets
# Optional: DERP_SESSION_DMABUF_LOGS=1 in derp-session.local.env for derp_shell_dmabuf=debug,
# CEF_HOST_DMABUF_TRACE, CEF_HOST_CHROMIUM_VERBOSE (see scripts/derp-session.sh).
#
# Flags:
#   --no-git               — same as INSTALL_SKIP_GIT=1
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_PREFIX="${INSTALL_PREFIX:-/usr/local}"
SKIP_GIT="${INSTALL_SKIP_GIT:-0}"
RUN_SCRIPT="$REPO_ROOT/scripts/install-system-run.sh"

for arg in "$@"; do
  case "$arg" in
    --no-git) SKIP_GIT=1 ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

cd "$REPO_ROOT"

if [[ "$SKIP_GIT" != "1" ]] && [[ -d .git ]] && git rev-parse --git-dir >/dev/null 2>&1; then
  echo "=== git pull (ff-only) ==="
  git pull --ff-only
fi

if [[ ! -f "$RUN_SCRIPT" ]]; then
  echo "Missing $RUN_SCRIPT (needed after git pull)" >&2
  exit 1
fi

# Re-exec the runner from disk so pulls that change install-system-run.sh / build steps apply.
exec env INSTALL_SKIP_GIT=1 bash "$RUN_SCRIPT" "$@"
