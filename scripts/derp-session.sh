#!/usr/bin/env bash
# GDM/session entry: DRM compositor (+ optional cef_host shell). Install to /usr/local/bin/derp-session (755).
# Requires: built `compositor` and (for overlay) `cef_host`, `shell/dist` (Solid loads via file://).
# Install desktop: sudo install -Dm644 resources/derp-wayland.desktop /usr/share/wayland-sessions/derp-wayland.desktop
#
# Logging: compositor + `--command` (cef_host) stdout/stderr go to DERP_COMPOSITOR_LOG (default below).
# Unless DERP_COMPOSITOR_LOG_APPEND=1: the log is truncated at each compositor start (GDM login and each
# supervisor respawn after exit 42). Override path with DERP_COMPOSITOR_LOG=...
#
# dma-buf / Chromium debug: set DERP_SESSION_DMABUF_LOGS=1 (or use derp-session.local.env) to export
# CEF_HOST_DMABUF_TRACE=1, CEF_HOST_CHROMIUM_VERBOSE=1, and derp_shell_dmabuf=debug on RUST_LOG.
#
# Optional machine overrides: `scripts/derp-session.local.env` (gitignored; see
# `derp-session.local.env.example`). Sourced before every compositor start (SIGUSR2 respawn too).
set -euo pipefail

if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
  echo 'derp-session: XDG_RUNTIME_DIR is unset (not a proper graphical login?)' >&2
  exit 1
fi

export XDG_SESSION_TYPE="${XDG_SESSION_TYPE:-wayland}"
export LIBSEAT_BACKEND="${LIBSEAT_BACKEND:-logind}"

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
SOCKET="${DERP_WAYLAND_SOCKET:-wayland-d$UID}"

URL=""

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

derp_session_source_local_env() {
  local f="$ROOT/scripts/derp-session.local.env"
  [[ -f "$f" ]] || return 0
  set +u
  # shellcheck source=/dev/null
  source "$f"
  set -u
}

derp_session_merge_rust_log() {
  if [[ -z "${RUST_LOG:-}" ]]; then
    export RUST_LOG="warn,derp_input=debug,derp_shell_osr=info"
  elif [[ "${RUST_LOG}" != *derp_input=* ]]; then
    export RUST_LOG="${RUST_LOG},derp_input=debug"
  fi
  if [[ "${RUST_LOG}" != *derp_shell_osr=* ]]; then
    export RUST_LOG="${RUST_LOG},derp_shell_osr=info"
  fi
  if [[ "${DERP_PERF_SESSION:-0}" == "1" ]]; then
    if [[ "${RUST_LOG}" != *shell_ipc=* ]]; then
      export RUST_LOG="${RUST_LOG},shell_ipc=trace"
    fi
  fi
  if [[ "${DERP_SESSION_DMABUF_LOGS:-0}" == "1" ]]; then
    export CEF_HOST_DMABUF_TRACE="${CEF_HOST_DMABUF_TRACE:-1}"
    export CEF_HOST_CHROMIUM_VERBOSE="${CEF_HOST_CHROMIUM_VERBOSE:-1}"
    if [[ "${RUST_LOG}" != *derp_shell_dmabuf=* ]]; then
      export RUST_LOG="${RUST_LOG},derp_shell_dmabuf=debug"
    fi
  fi
}

resolve_cef_dir() {
  local bin rp
  bin="${CEF_HOST_BIN:-$ROOT/target/debug/cef_host}"
  [[ -x "$bin" ]] || return 1
  rp="$(readelf -d "$bin" 2>/dev/null | awk -F'[][]' '/RUNPATH/ { print $2; exit }')"
  [[ -n "$rp" && -f "$rp/libcef.so" ]] || return 1
  printf '%s' "$rp"
}

# Solid UI is a static Vite build (`base: './'`, no crossorigin on module scripts) — load from disk.
resolve_shell_document_url_if_needed() {
  URL=""
  [[ "${DERP_SESSION_SHELL:-1}" == "1" && -f "$INDEX" && -x "$CEF_HOST_BIN" ]] || return 0
  URL="file://${INDEX}"
}

# Rebuild compositor argv from current env + optional `derp-session.local.env` (for remote-update + SIGUSR2).
derp_session_build_args() {
  derp_session_source_local_env
  export DERP_ALLOW_SHELL_SPAWN="${DERP_ALLOW_SHELL_SPAWN:-1}"
  export DERP_SHELL_WATCHDOG_SEC="${DERP_SHELL_WATCHDOG_SEC:-5}"
  derp_session_merge_rust_log

  ARGS=( --socket "$SOCKET" )
  if [[ -n "$URL" ]]; then
    local CEF_DIR="" cmd
    CEF_DIR="$(resolve_cef_dir)" || CEF_DIR="${CEF_PATH:-}"
    if [[ -n "$CEF_DIR" && -f "$CEF_DIR/libcef.so" ]]; then
      # cef_host forces --ozone-platform=wayland --use-angle=gl-egl; dma-buf OSR uses in-process GPU (see cef_host).
      if [[ "${DERP_PERF_SESSION:-0}" == "1" ]]; then
        cmd="$(printf 'env CEF_HOST_PERF=1 CEF_PATH=%q CEF_SHELL_URL=%q CEF_HOST_BIN=%q %q' "$CEF_DIR" "$URL" "$CEF_HOST_BIN" "$LAUNCHER")"
      else
        cmd="$(printf 'env CEF_PATH=%q CEF_SHELL_URL=%q CEF_HOST_BIN=%q %q' "$CEF_DIR" "$URL" "$CEF_HOST_BIN" "$LAUNCHER")"
      fi
      ARGS+=( --command "$cmd" )
    fi
  fi
}

resolve_shell_document_url_if_needed

STATE_BASE="${XDG_STATE_HOME:-$HOME/.local/state}"
DERP_COMPOSITOR_LOG="${DERP_COMPOSITOR_LOG:-$STATE_BASE/derp/compositor.log}"
mkdir -p "$(dirname "$DERP_COMPOSITOR_LOG")"

derp_session_log_banner() {
  printf '%s\n' "===== derp-session start $(date -Is) uid=$UID WAYLAND_SOCKET=$SOCKET ====="
}

derp_session_log_fresh_start() {
  if [[ "${DERP_COMPOSITOR_LOG_APPEND:-0}" != "1" ]]; then
    : >"$DERP_COMPOSITOR_LOG"
  fi
  derp_session_log_banner >>"$DERP_COMPOSITOR_LOG"
}

derp_session_build_args
derp_session_log_fresh_start

exec >>"$DERP_COMPOSITOR_LOG" 2>&1
# Default: keep a supervisor loop so SIGUSR2 → exit 42 can reload a newly installed
# /usr/local/bin/compositor without ending the GDM session (scripts/remote-update-and-restart.sh).
# Set DERP_COMPOSITOR_RESPAWN=0 for legacy single-exec behavior.
if [[ "${DERP_COMPOSITOR_RESPAWN:-1}" != "0" ]]; then
  while true; do
    derp_session_build_args
    if "$COMPOSITOR_BIN" "${ARGS[@]}" "$@"; then
      ec=0
    else
      ec=$?
    fi
    if [[ "$ec" -eq 42 ]]; then
      if [[ "${DERP_COMPOSITOR_LOG_APPEND:-0}" != "1" ]]; then
        : >"$DERP_COMPOSITOR_LOG"
      fi
      printf '%s\n' "derp-session: compositor exited 42 (SIGUSR2 reload), respawning $(date -Is)..."
      derp_session_build_args
      derp_session_log_banner
      continue
    fi
    exit "$ec"
  done
else
  exec "$COMPOSITOR_BIN" "${ARGS[@]}" "$@"
fi
