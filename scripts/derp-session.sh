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

# GDM runs `/usr/local/bin/derp-session` — a symlink to `…/scripts/derp-session.sh`. Without
# resolving it, `dirname` is `/usr/local/bin` and ROOT becomes `/usr/local` (no `shell/dist`).
_session="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1; then
  _canonical="$(readlink -f "$_session" 2>/dev/null || true)"
  [[ -n "$_canonical" ]] && _session="$_canonical"
fi
ROOT="$(cd "$(dirname "$_session")/.." && pwd)"
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

# If Solid wasn’t built after clone, build it now so `cef_host` can start (same as install-system.sh).
ensure_shell_dist() {
  [[ "${DERP_SESSION_SHELL:-1}" == "1" ]] || return 0
  [[ -f "$INDEX" ]] && return 0
  [[ -f "$ROOT/shell/package.json" ]] || return 0
  command -v npm >/dev/null 2>&1 || {
    echo "derp-session: missing $INDEX and npm not in PATH — run: bash $ROOT/scripts/install-system.sh" >&2
    return 0
  }
  echo "derp-session: missing $INDEX; running npm install && npm run build in $ROOT/shell ..." >&2
  (cd "$ROOT/shell" && ([[ -d node_modules ]] || npm install) && npm run build) || {
    echo "derp-session: Solid build failed — run: bash $ROOT/scripts/install-system.sh (needs Node.js)." >&2
    return 0
  }
}
ensure_shell_dist

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
      if [[ "${DERP_PERF_SESSION:-0}" == "1" ]]; then
        CMD="$(printf 'env CEF_HOST_PERF=1 CEF_HOST_USE_GPU=%q CEF_PATH=%q CEF_SHELL_URL=%q CEF_HOST_BIN=%q %q' "${CEF_HOST_USE_GPU:-1}" "$CEF_DIR" "$URL" "$CEF_HOST_BIN" "$LAUNCHER")"
      else
        CMD="$(printf 'env CEF_HOST_USE_GPU=%q CEF_PATH=%q CEF_SHELL_URL=%q CEF_HOST_BIN=%q %q' "${CEF_HOST_USE_GPU:-1}" "$CEF_DIR" "$URL" "$CEF_HOST_BIN" "$LAUNCHER")"
      fi
      ARGS+=( --command "$CMD" )
    fi
  fi
fi

export DERP_ALLOW_SHELL_SPAWN="${DERP_ALLOW_SHELL_SPAWN:-1}"
export DERP_SHELL_WATCHDOG_SEC="${DERP_SHELL_WATCHDOG_SEC:-5}"

# tracing target `derp_input` (pointer/touch): always on for this session; override with RUST_LOG if needed.
if [[ -z "${RUST_LOG:-}" ]]; then
  export RUST_LOG="warn,derp_input=debug"
elif [[ "${RUST_LOG}" != *derp_input=* ]]; then
  export RUST_LOG="${RUST_LOG},derp_input=debug"
fi
# DERP_PERF_SESSION=1: compositor `shell_ipc=trace` + CEF_HOST_PERF (see install-system.sh).
if [[ "${DERP_PERF_SESSION:-0}" == "1" ]]; then
  if [[ "${RUST_LOG}" != *shell_ipc=* ]]; then
    export RUST_LOG="${RUST_LOG},shell_ipc=trace"
  fi
fi

STATE_BASE="${XDG_STATE_HOME:-$HOME/.local/state}"
DERP_COMPOSITOR_LOG="${DERP_COMPOSITOR_LOG:-$STATE_BASE/derp/compositor.log}"
mkdir -p "$(dirname "$DERP_COMPOSITOR_LOG")"
printf '%s\n' "===== derp-session start $(date -Is) uid=$UID WAYLAND_SOCKET=$SOCKET RUST_LOG=${RUST_LOG} =====" >>"$DERP_COMPOSITOR_LOG"

exec >>"$DERP_COMPOSITOR_LOG" 2>&1
# Default: keep a supervisor loop so SIGUSR2 → exit 42 can reload a newly installed
# /usr/local/bin/compositor without ending the GDM session (scripts/remote-update-and-restart.sh).
# Set DERP_COMPOSITOR_RESPAWN=0 for legacy single-exec behavior.
if [[ "${DERP_COMPOSITOR_RESPAWN:-1}" != "0" ]]; then
  while true; do
    if "$COMPOSITOR_BIN" "${ARGS[@]}" "$@"; then
      ec=0
    else
      ec=$?
    fi
    if [[ "$ec" -eq 42 ]]; then
      printf '%s\n' "derp-session: compositor exited 42 (SIGUSR2 reload), respawning..."
      continue
    fi
    exit "$ec"
  done
else
  exec "$COMPOSITOR_BIN" "${ARGS[@]}" "$@"
fi
