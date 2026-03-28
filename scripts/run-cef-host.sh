#!/usr/bin/env bash
# Run cef_host like tauri-apps/cef-rs: CEF_PATH points at the CEF *bundle* (resources, locales);
# libcef.so is found via the binary's embedded RUNPATH (do not prepend another tree on
# LD_LIBRARY_PATH — on Linux that can override RUNPATH and mismatch the wrapper).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${CEF_HOST_BIN:-$ROOT/target/debug/cef_host}"

pick_libcef_dir() {
  local lib
  if lib="$(find "$ROOT/target" -name 'libcef.so' -type f -printf '%T@ %p\n' 2>/dev/null | sort -g | tail -n1 | cut -d' ' -f2-)" && [[ -n "$lib" ]]; then
    dirname "$lib"
    return 0
  fi
  lib="$(find "$ROOT/target" -name 'libcef.so' -type f -print -quit 2>/dev/null || true)"
  [[ -n "$lib" ]] && dirname "$lib"
}

cef_dir_from_runpath() {
  local bin="$1"
  [[ -x "$bin" ]] || return 1
  readelf -d "$bin" 2>/dev/null | awk -F'[][]' '/RUNPATH/ { print $2; exit }'
}

if [[ ! -x "$BIN" ]]; then
  echo "Build: (cd $ROOT && cargo build -p cef_host)" >&2
  exit 1
fi

CEF_DIR=""
if rp="$(cef_dir_from_runpath "$BIN")" && [[ -n "$rp" && -f "$rp/libcef.so" ]]; then
  CEF_DIR="$rp"
else
  CEF_DIR="$(pick_libcef_dir || true)"
fi

if [[ -z "$CEF_DIR" || ! -f "$CEF_DIR/libcef.so" ]]; then
  echo "No CEF bundle found — run: (cd $ROOT && cargo build -p cef_host)" >&2
  exit 1
fi

export CEF_PATH="$CEF_DIR"

exec "$BIN" "$@"
