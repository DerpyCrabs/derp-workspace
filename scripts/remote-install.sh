#!/usr/bin/env bash
# Run scripts/install-system.sh on another host over SSH.
#
# Config: scripts/remote-install.env (gitignored; copy from remote-install.env.example)
#         or env: REMOTE_USER, REMOTE_HOST, REMOTE_REPO, STASH_DERP_SESSION
#
# Usage:
#   bash scripts/remote-install.sh [--no-stash] [-- INSTALL_SYSTEM_ARGS...]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[[ -f "$SCRIPT_DIR/remote-install.env" ]] && source "$SCRIPT_DIR/remote-install.env"

REMOTE_USER="${REMOTE_USER:-$USER}"
REMOTE_HOST="${REMOTE_HOST:?remote-install: set REMOTE_HOST (see scripts/remote-install.sample.md or remote-install.env)}"
REMOTE_REPO="${REMOTE_REPO:-/home/${REMOTE_USER}/derp-workspace}"
STASH_FLAG="${STASH_DERP_SESSION:-1}"

forward=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-stash) STASH_FLAG=0; shift ;;
    --)
      shift
      forward+=("$@")
      break
      ;;
    *) forward+=("$1"); shift ;;
  esac
done

remote_args=""
for a in "${forward[@]}"; do
  remote_args+=$(printf '%q' "$a")" "
done

SSH_TTY=()
if [[ -t 0 ]] && [[ -t 1 ]]; then
  SSH_TTY=(-t)
fi

# shellcheck disable=SC2086
exec ssh "${SSH_TTY[@]}" "${REMOTE_USER}@${REMOTE_HOST}" bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
if [[ ${STASH_FLAG} -eq 1 ]] && git rev-parse --git-dir >/dev/null 2>&1; then
  if ! git diff --quiet -- scripts/derp-session.sh 2>/dev/null; then
    git stash push -m "remote-install: derp-session" -- scripts/derp-session.sh
  fi
fi
exec bash scripts/install-system.sh ${remote_args}
EOF
