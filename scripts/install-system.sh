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
# GDM session (`scripts/derp-session.sh`) exports DERP_SHELL_WATCHDOG_SEC=5 by default so a stuck
# `cef_host` does not leave the session hung; set DERP_SHELL_WATCHDOG_SEC=0 before login to disable.
#
# `derp-session` will run `npm install && npm run build` in shell/ if `shell/dist/index.html` is missing
# (requires Node on the login machine). Prefer a successful install here so GDM start is fast.
#
# Session logging: `derp-session` appends compositor + cef_host stdout/stderr to DERP_COMPOSITOR_LOG
# (default ~/.local/state/derp/compositor.log). Set DERP_COMPOSITOR_LOG to override or inspect that
# file from a TTY/SSH/live mount when debugging a gray screen (tracing, CEF_HOST_*, shell IPC).
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
      sed -n '1,28p' "$0"
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
