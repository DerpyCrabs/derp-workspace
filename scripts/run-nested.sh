#!/usr/bin/env bash
set -euo pipefail

# Run this compositor nested inside your current Wayland (or X11) session.
#
# We only force a unique Wayland socket *name* under your real XDG_RUNTIME_DIR.
# Do NOT replace XDG_RUNTIME_DIR with /tmp: winit connects to the *parent*
# compositor using (XDG_RUNTIME_DIR + WAYLAND_DISPLAY). If that dir is wrong,
# nested startup fails with errors about failing to connect / open display.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCKET="${WAYLAND_DISPLAY_NESTED:-derp-nested-$$}"
BINARY="${COMPOSITOR_BIN:-$ROOT/target/debug/compositor}"

if [[ ! -x "$BINARY" ]]; then
  echo "Build first: (cd $ROOT && cargo build -p compositor)" >&2
  exit 1
fi

if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
  echo 'XDG_RUNTIME_DIR is unset; nested Wayland usually needs it (e.g. /run/user/$UID).' >&2
  exit 1
fi

echo "Using XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR (must stay the session path so winit reaches the parent compositor)"
echo "This compositor will listen on WAYLAND_DISPLAY=$SOCKET for your clients"
exec "$BINARY" --socket "$SOCKET" "$@"
