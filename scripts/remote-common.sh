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
  local remote_sh remote_cmd
  remote_sh=$(printf 'set -euo pipefail; mkdir -p %q && cd %q && backup="" && if [[ -f scripts/derp-session.local.env ]]; then backup=$(mktemp) && cp -a scripts/derp-session.local.env "$backup"; fi && rm -rf compositor shell_wire e2e-test-client resources scripts && if [[ -d shell ]]; then find shell -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +; fi && tar xzf - && if [[ -n "$backup" ]] && [[ -f "$backup" ]]; then mkdir -p scripts && cp -a "$backup" scripts/derp-session.local.env && rm -f "$backup"; fi' "$REMOTE_REPO" "$REMOTE_REPO")
  remote_cmd=$(printf 'exec /usr/bin/env bash -c %q' "$remote_sh")
  (
    cd "$REPO_ROOT"
    tar czf - --exclude=target --exclude=shell/node_modules --exclude=shell/dist --exclude=.git --exclude=.artifacts .
  ) | ssh "${REMOTE_USER}@${REMOTE_HOST}" "$remote_cmd" >/dev/null
}

remote_repo_hash_path_list() {
  local tmp out
  tmp=$(mktemp)
  "$@" >"$tmp"
  if [[ ! -s "$tmp" ]]; then
    rm -f "$tmp"
    printf 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    return
  fi
  out=$( (
    cd "$REPO_ROOT" || exit 1
    while IFS= read -r rel; do
      [[ -z "$rel" ]] && continue
      [[ -f "$rel" ]] || continue
      sha256sum "$rel"
    done <"$tmp"
  ) | sha256sum | awk '{print $1}' )
  rm -f "$tmp"
  printf '%s' "$out"
}

require_remote_sync_tools() {
  local cmd
  for cmd in ssh tar sha256sum awk; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "${REMOTE_COMMON_SCRIPT_NAME}: $cmd not found" >&2
      exit 1
    fi
  done
}
