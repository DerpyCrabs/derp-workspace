#!/usr/bin/env bash
set -euo pipefail

SHELL_DIR="${1:-shell}"

if ! command -v npm >/dev/null 2>&1; then
  echo "ensure-shell-node-modules: npm not found" >&2
  exit 1
fi

cd "$SHELL_DIR"

have_valid_shell_node_modules() {
  if [[ -f node_modules/.package-lock.json ]]; then
    [[ ! -f package-lock.json || ! package-lock.json -nt node_modules/.package-lock.json ]] || return 1
    [[ ! -f package.json || ! package.json -nt node_modules/.package-lock.json ]] || return 1
  else
    [[ ! -f package-lock.json && ! -f package.json ]] || return 1
  fi
  [[ -x node_modules/.bin/tsc ]] \
    && [[ -f node_modules/typescript/lib/lib.es2023.d.ts ]] \
    && [[ -f node_modules/typescript/lib/lib.dom.d.ts ]] \
    && [[ -f node_modules/vite/client.d.ts ]] \
    && [[ -f node_modules/@types/node/package.json ]]
}

install_shell_node_modules() {
  rm -rf node_modules
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
}

if ! have_valid_shell_node_modules; then
  install_shell_node_modules
fi

if ! have_valid_shell_node_modules; then
  npm cache clean --force >/dev/null 2>&1 || true
  rm -rf node_modules
  npm install
fi

if ! have_valid_shell_node_modules; then
  echo "ensure-shell-node-modules: shell/node_modules is missing required TypeScript or Vite files after reinstall" >&2
  exit 1
fi
