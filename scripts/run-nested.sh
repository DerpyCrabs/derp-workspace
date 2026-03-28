#!/usr/bin/env bash
set -euo pipefail

# Run this compositor nested inside your current Wayland (or X11) session.
#
# We only force a unique Wayland socket *name* under your real XDG_RUNTIME_DIR.
# Do NOT replace XDG_RUNTIME_DIR with /tmp: winit connects to the *parent*
# compositor using (XDG_RUNTIME_DIR + WAYLAND_DISPLAY). If that dir is wrong,
# nested startup fails with errors about failing to connect / open display.
#
# By default this script also:
#   - rebuilds Rust (compositor + cef_host), npm shell, unless NESTED_SKIP_BUILD=1
#   - spawns cef_host for the SolidJS overlay unless NESTED_NO_SHELL=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCKET="${WAYLAND_DISPLAY_NESTED:-derp-nested-$$}"
BINARY="${COMPOSITOR_BIN:-$ROOT/target/debug/compositor}"
LAUNCHER="${ROOT}/scripts/launch-cef-to-compositor.sh"
INDEX="${ROOT}/shell/dist/index.html"
DIST="${ROOT}/shell/dist"

SHELL_HTTP_PID=""
cleanup_shell_http() {
  if [[ -n "${SHELL_HTTP_PID:-}" ]] && kill -0 "$SHELL_HTTP_PID" 2>/dev/null; then
    kill "$SHELL_HTTP_PID" 2>/dev/null || true
    wait "$SHELL_HTTP_PID" 2>/dev/null || true
  fi
}

if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
  echo 'XDG_RUNTIME_DIR is unset; nested Wayland usually needs it (e.g. /run/user/$UID).' >&2
  exit 1
fi

if [[ ! -x "$LAUNCHER" ]]; then
  echo "Missing or non-executable: $LAUNCHER" >&2
  exit 1
fi

build_deps() {
  echo "=== nested: cargo build (compositor + cef_host) ==="
  (cd "$ROOT" && cargo build -p compositor -p cef_host)
  if [[ -f "$ROOT/shell/package.json" ]]; then
    echo "=== nested: npm shell → dist/ ==="
    (cd "$ROOT/shell" && {
      if [[ -f package-lock.json ]] && command -v npm >/dev/null 2>&1; then
        npm ci || npm install
      elif command -v npm >/dev/null 2>&1; then
        npm install
      else
        echo "npm not found; install Node or build shell/dist yourself." >&2
        exit 1
      fi
      npm run build
    })
  fi
}

if [[ "${NESTED_SKIP_BUILD:-}" != "1" ]]; then
  build_deps
else
  echo "NESTED_SKIP_BUILD=1: skipping cargo/npm (you must have fresh binaries + shell/dist)."
fi

if [[ ! -x "$BINARY" ]]; then
  echo "Missing compositor binary: $BINARY" >&2
  exit 1
fi

# Fallback: newest libcef.so under target/ (can disagree with linked wrapper if several hashes exist).
discover_toolchain_cef_dir() {
  local lib
  if lib="$(find "$ROOT/target" -name 'libcef.so' -type f -printf '%T@ %p\n' 2>/dev/null | sort -g | tail -n1 | cut -d' ' -f2-)" && [[ -n "$lib" ]]; then
    dirname "$lib"
    return 0
  fi
  lib="$(find "$ROOT/target" -name 'libcef.so' -type f -print -quit 2>/dev/null || true)"
  [[ -n "$lib" ]] || return 1
  dirname "$lib"
}

cef_dir_from_host_runpath() {
  local bin="$1"
  [[ -x "$bin" ]] || return 1
  readelf -d "$bin" 2>/dev/null | awk -F'[][]' '/RUNPATH/ { print $2; exit }'
}

resolve_cef_dir() {
  local user bin rp fallback
  user="${CEF_PATH:-}"
  bin="${CEF_HOST_BIN:-$ROOT/target/debug/cef_host}"
  if [[ -x "$bin" ]]; then
    rp="$(cef_dir_from_host_runpath "$bin" || true)"
    if [[ -n "$rp" && -f "$rp/libcef.so" ]]; then
      if [[ -n "$user" && "$(readlink -f "$user" 2>/dev/null)" != "$(readlink -f "$rp" 2>/dev/null)" ]]; then
        echo "cef: using RUNPATH bundle $rp (not CEF_PATH=$user; must match libcef_dll_wrapper)." >&2
      fi
      printf '%s' "$rp"
      return 0
    fi
  fi
  fallback="$(discover_toolchain_cef_dir || true)"
  if [[ -n "$fallback" ]]; then
    if [[ -n "$user" && "$(readlink -f "$user" 2>/dev/null)" != "$(readlink -f "$fallback" 2>/dev/null)" ]]; then
      echo "cef: using toolchain CEF at $fallback (ignoring CEF_PATH=$user; must match libcef_dll_wrapper)." >&2
    fi
    printf '%s' "$fallback"
    return 0
  fi
  if [[ -n "$user" ]]; then
    printf '%s' "$user"
    return 0
  fi
  return 1
}

ARGS=( --socket "$SOCKET" )

if [[ "${NESTED_NO_SHELL:-}" != "1" ]]; then
  if [[ ! -f "$INDEX" ]]; then
    echo "shell/dist missing after build ($INDEX). Fix shell/npm errors above." >&2
    exit 1
  fi

  CEF_DIR=""
  if ! CEF_DIR="$(resolve_cef_dir)"; then
    CEF_DIR=""
  fi
  CEF_BIN="${CEF_HOST_BIN:-$ROOT/target/debug/cef_host}"

  if [[ -n "${CEF_DIR:-}" && -f "$INDEX" && -x "$CEF_BIN" && -f "$CEF_DIR/libcef.so" ]]; then
    # Solid/Vite output uses `type="module"`; Chromium will not run it from file:// — you only see
    # the flat CEF background (black/white “empty” window). Serve dist/ on loopback instead.
    if ! command -v python3 >/dev/null 2>&1; then
      echo "python3 not found; install it to serve shell/dist for CEF (or set NESTED_NO_SHELL=1)." >&2
      exit 1
    fi
    SHELL_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
    ( cd "$DIST" && python3 -m http.server "$SHELL_PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) &
    SHELL_HTTP_PID=$!
    sleep 0.2
    URL="http://127.0.0.1:${SHELL_PORT}/index.html"
    trap cleanup_shell_http EXIT INT TERM
    CMD="$(printf 'env CEF_PATH=%q CEF_SHELL_URL=%q CEF_HOST_BIN=%q %q' \
      "$CEF_DIR" "$URL" "$CEF_BIN" "$LAUNCHER")"
    ARGS+=( --command "$CMD" )
    echo "Also starting cef_host → shell IPC (CEF_PATH=$CEF_DIR)"
    echo "  Solid page: $URL (http.server pid $SHELL_HTTP_PID → $DIST)"
  else
    echo "Note: SolidJS overlay not started (no libcef under target/? run build without NESTED_SKIP_BUILD)." >&2
    echo "  Or set NESTED_NO_SHELL=1 to silence this." >&2
  fi
fi

echo "Using XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR (must stay the session path so winit reaches the parent compositor)"
echo "This compositor will listen on WAYLAND_DISPLAY=$SOCKET for your clients"

"$BINARY" "${ARGS[@]}" "$@"
code=$?
cleanup_shell_http
trap - EXIT INT TERM
exit "$code"
