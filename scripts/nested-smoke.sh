#!/usr/bin/env bash
set -euo pipefail

# Launch Weston (headless), then run this compositor in --headless mode for a few seconds.
# Requires: weston, compositor built (release or debug).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_BIN="$ROOT/target/release/compositor"
DEBUG_BIN="$ROOT/target/debug/compositor"

if [[ -n "${COMPOSITOR_BIN:-}" ]]; then
  BIN="$COMPOSITOR_BIN"
elif [[ -x "$RELEASE_BIN" ]]; then
  BIN="$RELEASE_BIN"
elif [[ -x "$DEBUG_BIN" ]]; then
  BIN="$DEBUG_BIN"
else
  echo "Compositor binary missing. Build with one of:" >&2
  echo "  cargo build --release -p compositor" >&2
  echo "  cargo build -p compositor" >&2
  exit 1
fi

RUNTIME="$(mktemp -d)"
WESTON_ERR="$(mktemp)"
WESTON_PID=""

cleanup() {
  rm -f "${WESTON_ERR:-}"
  if [[ -n "${WESTON_PID:-}" ]]; then
    kill "$WESTON_PID" 2>/dev/null || true
  fi
  rm -rf "${RUNTIME:-}"
}
trap cleanup EXIT

export XDG_RUNTIME_DIR="$RUNTIME"

if ! command -v weston >/dev/null 2>&1; then
  echo "weston is not installed (needed for nested-smoke)." >&2
  exit 1
fi

wait_weston_socket() {
  local i
  for i in $(seq 1 50); do
    if [[ -S "$RUNTIME/weston-smoke" ]]; then
      return 0
    fi
    if ! kill -0 "${WESTON_PID:-0}" 2>/dev/null; then
      return 1
    fi
    sleep 0.1
  done
  return 1
}

# Try explicit headless backend first (common on distro packages), then Weston's default.
weston --socket=weston-smoke --backend=headless-backend.so 2>>"$WESTON_ERR" &
WESTON_PID=$!

if ! wait_weston_socket; then
  kill "$WESTON_PID" 2>/dev/null || true
  weston --socket=weston-smoke 2>>"$WESTON_ERR" &
  WESTON_PID=$!
  if ! wait_weston_socket; then
    echo "Weston did not create $RUNTIME/weston-smoke. Weston stderr:" >&2
    cat "$WESTON_ERR" >&2 || true
    echo "Tip: install weston + headless module, or run:" >&2
    echo "  weston --socket=test --backend=headless-backend.so" >&2
    exit 1
  fi
fi

export WAYLAND_DISPLAY=weston-smoke

timeout 5s "$BIN" --headless --socket derp-smoke --run-for-ms 4000
echo "nested-smoke OK"
