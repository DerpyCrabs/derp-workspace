#!/usr/bin/env bash
# GDM/session entry: DRM compositor (+ optional cef_host shell). Install to /usr/local/bin/derp-session (755).
# Requires: built `compositor` and (for overlay) `cef_host`, `shell/dist`, python3 for loopback HTTP.
# Install desktop: sudo install -Dm644 resources/derp-wayland.desktop /usr/share/wayland-sessions/derp-wayland.desktop
#
# Logging: compositor + `--command` (cef_host) stdout/stderr append to DERP_COMPOSITOR_LOG (default below).
# Override with DERP_COMPOSITOR_LOG=/path/to/file. Inspect after a gray screen: tail -f that file from a TTY/SSH.
set -euo pipefail

if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
  echo 'derp-session: XDG_RUNTIME_DIR is unset (not a proper graphical login?)' >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSITOR_BIN="${COMPOSITOR_BIN:-/usr/local/bin/compositor}"
CEF_HOST_BIN="${CEF_HOST_BIN:-/usr/local/bin/cef_host}"
LAUNCHER="${DERP_CEF_LAUNCHER:-$ROOT/scripts/launch-cef-to-compositor.sh}"
INDEX="${ROOT}/shell/dist/index.html"
DIST="${ROOT}/shell/dist"
SOCKET="${DERP_WAYLAND_SOCKET:-wayland-d$UID}"

SHELL_HTTP_PID=""
cleanup_shell_http() {
  if [[ -n "${SHELL_HTTP_PID:-}" ]] && kill -0 "$SHELL_HTTP_PID" 2>/dev/null; then
    kill "$SHELL_HTTP_PID" 2>/dev/null || true
    wait "$SHELL_HTTP_PID" 2>/dev/null || true
  fi
}
trap cleanup_shell_http EXIT INT TERM HUP

ARGS=( --backend drm --socket "$SOCKET" )

if [[ "${DERP_SESSION_SHELL:-1}" == "1" && -f "$INDEX" && -x "$CEF_HOST_BIN" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    SHELL_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
    ( cd "$DIST" && python3 -m http.server "$SHELL_PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) &
    SHELL_HTTP_PID=$!
    sleep 0.2
    URL="http://127.0.0.1:${SHELL_PORT}/index.html"
    resolve_cef_dir() {
      local bin rp
      bin="${CEF_HOST_BIN:-$ROOT/target/debug/cef_host}"
      [[ -x "$bin" ]] || return 1
      rp="$(readelf -d "$bin" 2>/dev/null | awk -F'[][]' '/RUNPATH/ { print $2; exit }')"
      [[ -n "$rp" && -f "$rp/libcef.so" ]] || return 1
      printf '%s' "$rp"
    }
    CEF_DIR=""
    CEF_DIR="$(resolve_cef_dir)" || CEF_DIR="${CEF_PATH:-}"
    if [[ -n "$CEF_DIR" && -f "$CEF_DIR/libcef.so" ]]; then
      CMD="$(printf 'env CEF_PATH=%q CEF_SHELL_URL=%q CEF_HOST_BIN=%q %q' "$CEF_DIR" "$URL" "$CEF_HOST_BIN" "$LAUNCHER")"
      ARGS+=( --command "$CMD" )
    fi
  fi
fi

export DERP_ALLOW_SHELL_SPAWN="${DERP_ALLOW_SHELL_SPAWN:-1}"
export DERP_SHELL_WATCHDOG_SEC="${DERP_SHELL_WATCHDOG_SEC:-5}"

STATE_BASE="${XDG_STATE_HOME:-$HOME/.local/state}"
DERP_COMPOSITOR_LOG="${DERP_COMPOSITOR_LOG:-$STATE_BASE/derp/compositor.log}"
mkdir -p "$(dirname "$DERP_COMPOSITOR_LOG")"
printf '%s\n' "===== derp-session start $(date -Is) uid=$UID WAYLAND_SOCKET=$SOCKET =====" >>"$DERP_COMPOSITOR_LOG"

exec >>"$DERP_COMPOSITOR_LOG" 2>&1
exec "$COMPOSITOR_BIN" "${ARGS[@]}" "$@"
