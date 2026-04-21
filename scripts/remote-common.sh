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

remote_repo_should_sync_path() {
  local rel="$1"
  case "$rel" in
    target|target/*|*/target|*/target/*) return 1 ;;
    shell/node_modules|shell/node_modules/*) return 1 ;;
    shell/dist|shell/dist/*) return 1 ;;
    .git|.git/*) return 1 ;;
    .artifacts|.artifacts/*) return 1 ;;
    tmp/e2e-artifacts|tmp/e2e-artifacts/*) return 1 ;;
    scripts/remote-install.env) return 1 ;;
    scripts/remote-install.local.md) return 1 ;;
    scripts/derp-session.local.env) return 1 ;;
    scripts/.derp-remote-update-snapshot) return 1 ;;
    scripts/.derp-e2e-remote-snapshot) return 1 ;;
  esac
  return 0
}

remote_tar_exclude_args() {
  printf '%s\0' \
    --exclude=target \
    --exclude='*/target' \
    --exclude=shell/node_modules \
    --exclude=shell/dist \
    --exclude=.git \
    --exclude=.artifacts \
    --exclude=tmp/e2e-artifacts \
    --exclude=scripts/remote-install.env \
    --exclude=scripts/remote-install.local.md \
    --exclude=scripts/derp-session.local.env \
    --exclude=scripts/.derp-remote-update-snapshot \
    --exclude=scripts/.derp-e2e-remote-snapshot
}

run_tar_sync() {
  local remote_sh remote_cmd
  local tar_excludes=()
  while IFS= read -r -d '' arg; do
    tar_excludes+=("$arg")
  done < <(remote_tar_exclude_args)
  remote_sh=$(printf 'set -euo pipefail; mkdir -p %q && cd %q && backup="" && if [[ -f scripts/derp-session.local.env ]]; then backup=$(mktemp) && cp -a scripts/derp-session.local.env "$backup"; fi && rm -rf compositor shell_wire e2e-test-client resources scripts && if [[ -d shell ]]; then find shell -mindepth 1 -maxdepth 1 ! -name node_modules ! -name dist -exec rm -rf {} +; fi && tar xzf - && if [[ -n "$backup" ]] && [[ -f "$backup" ]]; then mkdir -p scripts && cp -a "$backup" scripts/derp-session.local.env && rm -f "$backup"; fi' "$REMOTE_REPO" "$REMOTE_REPO")
  remote_cmd=$(printf 'exec /usr/bin/env bash -c %q' "$remote_sh")
  (
    cd "$REPO_ROOT"
    tar czf - "${tar_excludes[@]}" .
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
      remote_repo_should_sync_path "$rel" || continue
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

remote_test_lock_acquire() {
  local lock_path="${TMPDIR:-/tmp}/derp-remote-test.lock"
  local lock_dir="${lock_path}.d"
  local lock_pid_path="${lock_dir}/pid"
  local timeout="${DERP_REMOTE_TEST_LOCK_TIMEOUT_SEC:-0}"
  if command -v flock >/dev/null 2>&1; then
    exec {REMOTE_TEST_LOCK_FD}>"$lock_path"
    if [[ "$timeout" =~ ^[0-9]+$ ]] && ((timeout > 0)); then
      if ! flock -w "$timeout" "$REMOTE_TEST_LOCK_FD"; then
        echo "${REMOTE_COMMON_SCRIPT_NAME}: another remote test, verify, or harness run is already active" >&2
        exit 1
      fi
      return
    fi
    if ! flock -n "$REMOTE_TEST_LOCK_FD"; then
      echo "${REMOTE_COMMON_SCRIPT_NAME}: another remote test, verify, or harness run is already active" >&2
      exit 1
    fi
    return
  fi
  if [[ -f "$lock_pid_path" ]]; then
    local lock_pid
    lock_pid="$(cat "$lock_pid_path" 2>/dev/null || true)"
    if [[ "$lock_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
      rm -f "$lock_pid_path"
      rmdir "$lock_dir" 2>/dev/null || true
    fi
  elif [[ -d "$lock_dir" ]]; then
    rmdir "$lock_dir" 2>/dev/null || true
  fi
  if ! mkdir "$lock_dir" 2>/dev/null; then
    echo "${REMOTE_COMMON_SCRIPT_NAME}: another remote test, verify, or harness run is already active" >&2
    exit 1
  fi
  printf '%s\n' "$$" >"$lock_pid_path"
  trap "rm -f '$lock_pid_path'; rmdir '$lock_dir'" EXIT
}
