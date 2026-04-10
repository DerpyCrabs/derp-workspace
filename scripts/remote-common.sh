#!/usr/bin/env bash

remote_common_init() {
  local script_name="$1"
  REMOTE_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "$REMOTE_COMMON_DIR/.." && pwd)"
  [[ -f "$REMOTE_COMMON_DIR/remote-install.env" ]] && source "$REMOTE_COMMON_DIR/remote-install.env"

  REMOTE_USER="${REMOTE_USER:-$USER}"
  REMOTE_HOST="${REMOTE_HOST:?${script_name}: set REMOTE_HOST (see scripts/remote-install.env.example)}"
  REMOTE_REPO="${REMOTE_REPO:-/home/${REMOTE_USER}/derp-workspace}"
  REMOTE_COMMON_SCRIPT_NAME="$script_name"

  SSH_TTY=()
  if [[ -t 0 ]] && [[ -t 1 ]]; then
    SSH_TTY=(-t)
  fi
}

ssh_base() {
  ssh "${SSH_TTY[@]}" "${REMOTE_USER}@${REMOTE_HOST}" "$@"
}

run_tar_sync() {
  local remote_sh
  remote_sh=$(printf 'set -euo pipefail; mkdir -p %q && cd %q && tar xzf -' "$REMOTE_REPO" "$REMOTE_REPO")
  (
    cd "$REPO_ROOT"
    tar czf - --exclude=target --exclude=shell/node_modules --exclude=.git .
  ) | ssh "${REMOTE_USER}@${REMOTE_HOST}" bash -c "$remote_sh"
}

require_remote_sync_tools() {
  local cmd
  for cmd in ssh tar; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "${REMOTE_COMMON_SCRIPT_NAME}: $cmd not found" >&2
      exit 1
    fi
  done
}
