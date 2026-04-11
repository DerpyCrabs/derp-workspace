#!/usr/bin/env bash
# GDM/session entry: DRM compositor with in-process CEF Solid shell. Install to /usr/local/bin/derp-session (755).
# Default: `shell/dist` via file://. HMR: DERP_CEF_SHELL_DOCUMENT_URL=http(s)… in derp-session.local.env;
# for URLs targeting this host, Vite is started automatically when the port is free. Re-read each compositor start.
# Install desktop: sudo install -Dm644 resources/derp-wayland.desktop /usr/share/wayland-sessions/derp-wayland.desktop
#
# Logging: compositor stdout/stderr go to DERP_COMPOSITOR_LOG (default below).
# The compositor binary uses RUST_LOG from the environment; unset defaults to `warn` only (see derp_session_merge_rust_log + compositor main).
# Unless DERP_COMPOSITOR_LOG_APPEND=1: the log is truncated at each compositor start (GDM login and each
# supervisor respawn after exit 42). Override path with DERP_COMPOSITOR_LOG=...
#
# dma-buf / Chromium debug: set DERP_SESSION_DMABUF_LOGS=1 (or derp-session.local.env) to export
# CEF_HOST_DMABUF_TRACE / CEF_HOST_CHROMIUM_VERBOSE (Chromium env names) and derp_shell_dmabuf=debug on RUST_LOG.
#
# Optional machine overrides: `scripts/derp-session.local.env` (gitignored; see
# `scripts/derp-session.local.env.example`). Sourced before every compositor start (SIGUSR2 respawn too).
set -euo pipefail

if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
  echo 'derp-session: XDG_RUNTIME_DIR is unset (not a proper graphical login?)' >&2
  exit 1
fi

export XDG_SESSION_TYPE="${XDG_SESSION_TYPE:-wayland}"
export XDG_CURRENT_DESKTOP="${XDG_CURRENT_DESKTOP:-Derp:wlroots}"
export XDG_SESSION_DESKTOP="${XDG_SESSION_DESKTOP:-derp}"
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
INDEX="${ROOT}/shell/dist/index.html"
SOCKET="${DERP_WAYLAND_SOCKET:-wayland-d$UID}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-$SOCKET}"

URL=""

# If Solid wasn’t built after clone, build it now (same as install-system.sh).
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
    export RUST_LOG="warn"
  fi
  if [[ "${DERP_PERF_SESSION:-0}" == "1" ]]; then
    if [[ "${RUST_LOG}" != *derp_shell_sync=* ]]; then
      export RUST_LOG="${RUST_LOG},derp_shell_sync=trace"
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

DERP_SESSION_GSETTINGS_BUTTON_LAYOUT_OLD=""
DERP_SESSION_GSETTINGS_BUTTON_LAYOUT_SET=0
DERP_SESSION_GSETTINGS_GTK_DECORATION_LAYOUT_OLD=""
DERP_SESSION_GSETTINGS_GTK_DECORATION_LAYOUT_SET=0
DERP_SESSION_CSD_POLICY_APPLIED=0

derp_session_gsettings_get() {
  gsettings get "$1" "$2" 2>/dev/null
}

derp_session_gsettings_set() {
  gsettings set "$1" "$2" "$3" >/dev/null 2>&1
}

derp_session_apply_csd_button_policy() {
  export QT_WAYLAND_DISABLE_WINDOWDECORATION="${QT_WAYLAND_DISABLE_WINDOWDECORATION:-1}"
  [[ "${DERP_SESSION_HIDE_CSD_BUTTONS:-1}" == "1" ]] || return 0
  [[ "$DERP_SESSION_CSD_POLICY_APPLIED" == "0" ]] || return 0
  command -v gsettings >/dev/null 2>&1 || return 0
  local value=""
  if value="$(derp_session_gsettings_get org.gnome.desktop.wm.preferences button-layout)"; then
    DERP_SESSION_GSETTINGS_BUTTON_LAYOUT_OLD="$value"
    if derp_session_gsettings_set org.gnome.desktop.wm.preferences button-layout "''"; then
      DERP_SESSION_GSETTINGS_BUTTON_LAYOUT_SET=1
    fi
  fi
  if value="$(derp_session_gsettings_get org.gnome.desktop.interface gtk-decoration-layout)"; then
    DERP_SESSION_GSETTINGS_GTK_DECORATION_LAYOUT_OLD="$value"
    if derp_session_gsettings_set org.gnome.desktop.interface gtk-decoration-layout "''"; then
      DERP_SESSION_GSETTINGS_GTK_DECORATION_LAYOUT_SET=1
    fi
  fi
  DERP_SESSION_CSD_POLICY_APPLIED=1
}

derp_session_restore_csd_button_policy() {
  command -v gsettings >/dev/null 2>&1 || return 0
  if [[ "$DERP_SESSION_GSETTINGS_GTK_DECORATION_LAYOUT_SET" == "1" ]]; then
    derp_session_gsettings_set \
      org.gnome.desktop.interface \
      gtk-decoration-layout \
      "$DERP_SESSION_GSETTINGS_GTK_DECORATION_LAYOUT_OLD" || true
  fi
  if [[ "$DERP_SESSION_GSETTINGS_BUTTON_LAYOUT_SET" == "1" ]]; then
    derp_session_gsettings_set \
      org.gnome.desktop.wm.preferences \
      button-layout \
      "$DERP_SESSION_GSETTINGS_BUTTON_LAYOUT_OLD" || true
  fi
}

resolve_cef_dir() {
  local bin rp
  bin="${COMPOSITOR_BIN:-$ROOT/target/debug/compositor}"
  [[ -x "$bin" ]] || return 1
  rp="$(readelf -d "$bin" 2>/dev/null | awk -F'[][]' '/RUNPATH/ { print $2; exit }')"
  [[ -n "$rp" && -f "$rp/libcef.so" ]] || return 1
  printf '%s' "$rp"
}

derp_session_resolve_shell_document_url() {
  URL=""
  if [[ -n "${DERP_CEF_SHELL_DOCUMENT_URL:-}" ]]; then
    URL="${DERP_CEF_SHELL_DOCUMENT_URL}"
    return 0
  fi
  if [[ "${DERP_SESSION_SHELL:-1}" != "1" || ! -x "$COMPOSITOR_BIN" ]]; then
    return 0
  fi
  ensure_shell_dist
  [[ -f "$INDEX" ]] || return 0
  URL="file://${INDEX}"
}

derp_session_http_document_host_port() {
  local u="$1" r h p=5173
  case "$u" in
    http://*) r="${u#http://}" ;;
    https://*) r="${u#https://}" ;;
    *) return 1 ;;
  esac
  r="${r%%/*}"
  r="${r%%\?*}"
  if [[ "$r" == *:* ]]; then
    h="${r%%:*}"
    p="${r##*:}"
    p="${p%\]*}"
  else
    h="$r"
  fi
  [[ -z "$h" ]] && return 1
  printf '%s %s' "$h" "$p"
}

derp_session_http_host_is_this_machine() {
  local h="$1"
  [[ "$h" == localhost || "$h" == 127.0.0.1 || "$h" == ::1 ]] && return 0
  local hn s
  hn="$(hostname -f 2>/dev/null)" || true
  [[ -n "$hn" && "$h" == "$hn" ]] && return 0
  s="$(hostname -s 2>/dev/null)" || true
  [[ -n "$s" && "$h" == "$s" ]] && return 0
  local ip
  for ip in $(hostname -I 2>/dev/null); do
    [[ "$h" == "$ip" ]] && return 0
  done
  return 1
}

derp_session_tcp_listening() {
  local port="$1"
  command -v ss >/dev/null 2>&1 || return 1
  if ss -ltn 2>/dev/null | grep -qE "LISTEN[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+.*:${port}([[:space:]]|$)"; then
    return 0
  fi
  return 1
}

derp_session_ensure_vite_dev_server() {
  local doc_url="$1" hp h p
  [[ "${DERP_SESSION_VITE_AUTOSTART:-1}" == "1" ]] || return 0
  case "$doc_url" in
    http://*|https://*) ;;
    *) return 0 ;;
  esac
  hp="$(derp_session_http_document_host_port "$doc_url")" || return 0
  h="${hp% *}"
  p="${hp##* }"
  derp_session_http_host_is_this_machine "$h" || return 0
  if derp_session_tcp_listening "$p"; then
    return 0
  fi
  [[ -f "$ROOT/shell/package.json" ]] || {
    echo "derp-session: $doc_url needs Vite but $ROOT/shell/package.json is missing" >&2
    return 0
  }
  command -v npm >/dev/null 2>&1 || {
    echo "derp-session: $doc_url needs Vite but npm is not in PATH" >&2
    return 0
  }
  if [[ ! -d "$ROOT/shell/node_modules" ]]; then
    (cd "$ROOT/shell" && npm install) || {
      echo "derp-session: npm install in shell failed" >&2
      return 0
    }
  fi
  (
    cd "$ROOT/shell" || exit 1
    export VITE_DEV_HOST="$h"
    export VITE_HMR_HOST="$h"
    export VITE_DEV_PORT="$p"
    export VITE_HMR_PORT="$p"
    exec npm run dev -- --port "$p" --strictPort
  ) &
  disown "$!" 2>/dev/null || true
  local i=0
  while [[ $i -lt 150 ]]; do
    derp_session_tcp_listening "$p" && return 0
    sleep 0.05
    i=$((i + 1))
  done
  echo "derp-session: Vite did not listen on :$p" >&2
}

derp_session_build_args() {
  derp_session_source_local_env
  export DERP_ALLOW_SHELL_SPAWN="${DERP_ALLOW_SHELL_SPAWN:-1}"
  export DERP_SHELL_WATCHDOG_SEC="${DERP_SHELL_WATCHDOG_SEC:-5}"
  derp_session_merge_rust_log
  derp_session_apply_csd_button_policy
  derp_session_resolve_shell_document_url
  if [[ -n "$URL" ]]; then
    derp_session_ensure_vite_dev_server "$URL"
  fi

  ARGS=( --socket "$SOCKET" )
  if [[ -n "$URL" ]]; then
    local CEF_DIR=""
    CEF_DIR="$(resolve_cef_dir)" || CEF_DIR="${CEF_PATH:-}"
    if [[ -n "$CEF_DIR" && -f "$CEF_DIR/libcef.so" ]]; then
      export CEF_PATH="$CEF_DIR"
      if [[ "${DERP_PERF_SESSION:-0}" == "1" ]]; then
        export CEF_HOST_PERF=1
      fi
      ARGS+=( --cef-shell-url "$URL" )
    fi
  fi
}

derp_session_import_activation_env() {
  local vars=(
    XDG_RUNTIME_DIR
    XDG_SESSION_TYPE
    XDG_CURRENT_DESKTOP
    XDG_SESSION_DESKTOP
    WAYLAND_DISPLAY
    DBUS_SESSION_BUS_ADDRESS
  )
  if [[ -n "${DISPLAY:-}" ]]; then
    vars+=(DISPLAY)
  fi
  if command -v dbus-update-activation-environment >/dev/null 2>&1; then
    dbus-update-activation-environment --systemd "${vars[@]}" >/dev/null 2>&1 || true
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user import-environment "${vars[@]}" >/dev/null 2>&1 || true
  fi
}

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
derp_session_import_activation_env
derp_session_log_fresh_start

trap derp_session_restore_csd_button_policy EXIT

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
  "$COMPOSITOR_BIN" "${ARGS[@]}" "$@"
  exit $?
fi
