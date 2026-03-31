#!/usr/bin/env bash
# SIGTERM (or SIGKILL with --force) the root Derp compositor on REMOTE_HOST.
# Ignores CEF/Chromium children that share the executable name "compositor".
#
# Config: scripts/remote-install.env (same as remote-update-and-restart.sh)
#
# Usage:
#   bash scripts/kill-remote-compositor.sh [--force]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[[ -f "$SCRIPT_DIR/remote-install.env" ]] && source "$SCRIPT_DIR/remote-install.env"

REMOTE_USER="${REMOTE_USER:-$USER}"
REMOTE_HOST="${REMOTE_HOST:?kill-remote-compositor: set REMOTE_HOST in scripts/remote-install.env}"

SIGNAL="-TERM"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|-9) SIGNAL="-KILL"; shift ;;
    -h|--help)
      sed -n '1,12p' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

ssh "${REMOTE_USER}@${REMOTE_HOST}" bash -s -- "$SIGNAL" <<'REMOTE'
set -euo pipefail
SIGNAL="$1"
mapfile -t pids < <(pgrep -u "$(id -un)" -x compositor || true)
if [[ ${#pids[@]} -eq 0 ]]; then
  echo "kill-remote-compositor: no compositor process for user $(id -un); nothing to do." >&2
  exit 0
fi
roots=()
for pid in "${pids[@]}"; do
  ppid=$(ps -o ppid= -p "$pid" | tr -d ' ')
  if ! printf '%s\n' "${pids[@]}" | grep -qx "$ppid"; then
    roots+=("$pid")
  fi
done
if [[ ${#roots[@]} -eq 0 ]]; then
  echo "kill-remote-compositor: no root compositor among PIDs (${pids[*]})." >&2
  exit 1
fi
if [[ ${#pids[@]} -gt ${#roots[@]} ]]; then
  echo "kill-remote-compositor: signaling ${#roots[@]} root PID(s) (${roots[*]}), not ${#pids[@]} total." >&2
fi
for pid in "${roots[@]}"; do
  kill "$SIGNAL" "$pid" || true
done
REMOTE
