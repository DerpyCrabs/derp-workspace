#!/usr/bin/env bash
# Archive this repo over SSH to a remote host (tar|ssh, no rsync on the host), run install-system-run.sh there,
# then signal the running compositor with SIGUSR2 for in-place restart.
#
# Requires on the remote: derp-session from this tree (default: respawn when compositor exits 42).
# Compositor must handle SIGUSR2 and exit 42 after teardown. See scripts/remote-install.sample.md.
#
# Session tuning without GDM edits: optional `scripts/derp-session.local.env` in the repo;
# derp-session re-sources it on every compositor start, including each SIGUSR2 reload.
#
# Config: scripts/remote-install.env (same as remote-install.sh) or env REMOTE_USER,
# REMOTE_HOST, REMOTE_REPO.
#
# Usage:
#   bash scripts/remote-update-and-restart.sh [--no-restart] [--dry-run] [-- INSTALL_RUN_ARGS...]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=/dev/null
[[ -f "$SCRIPT_DIR/remote-install.env" ]] && source "$SCRIPT_DIR/remote-install.env"

REMOTE_USER="${REMOTE_USER:-$USER}"
REMOTE_HOST="${REMOTE_HOST:?remote-update-and-restart: set REMOTE_HOST (see scripts/remote-install.sample.md)}"
REMOTE_REPO="${REMOTE_REPO:-/home/${REMOTE_USER}/derp-workspace}"

NO_RESTART=0
DRY_RUN=0
forward=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-restart) NO_RESTART=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '1,18p' "$0"
      exit 0
      ;;
    --)
      shift
      forward+=("$@")
      break
      ;;
    *) forward+=("$1"); shift ;;
  esac
done

remote_install_args=""
for a in "${forward[@]}"; do
  remote_install_args+=$(printf '%q' "$a")" "
done

SSH_TTY=()
if [[ -t 0 ]] && [[ -t 1 ]]; then
  SSH_TTY=(-t)
fi

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

run_install() {
  ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
exec bash scripts/install-system-run.sh ${remote_install_args}
EOF
}

signal_compositor_restart() {
  ssh_base bash -s <<'REMOTE'
set -euo pipefail
mapfile -t pids < <(pgrep -u "$(id -un)" -x compositor || true)
if [[ ${#pids[@]} -eq 0 ]]; then
  echo "remote-update-and-restart: no compositor process for user $(id -un); skipping SIGUSR2." >&2
  echo "remote-update-and-restart: log into Derp session first; derp-session defaults to respawn-on-exit-42 (see remote-install.sample.md)." >&2
  exit 0
fi
if [[ ${#pids[@]} -gt 1 ]]; then
  echo "remote-update-and-restart: warning: multiple compositor PIDs (${pids[*]}); sending SIGUSR2 to each." >&2
fi
for pid in "${pids[@]}"; do
  kill -USR2 "$pid"
done
REMOTE
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Would: ssh ${REMOTE_USER}@${REMOTE_HOST} mkdir -p $(printf '%q' "$REMOTE_REPO")"
  echo "Would: ( cd $(printf '%q' "$REPO_ROOT") && tar czf - --exclude=target --exclude=shell/node_modules --exclude=.git . ) | ssh … tar xzf - in $(printf '%q' "$REMOTE_REPO")"
  echo "Would: ssh … cd $REMOTE_REPO && bash scripts/install-system-run.sh $remote_install_args"
  if [[ "$NO_RESTART" -eq 0 ]]; then
    echo "Would: ssh … pkill-style SIGUSR2 to compositor"
  fi
  exit 0
fi

for cmd in ssh tar; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "remote-update-and-restart: $cmd not found" >&2
    exit 1
  fi
done

echo "=== remote mkdir ==="
ssh_base mkdir -p "$REMOTE_REPO"

echo "=== tar (gzip) $REPO_ROOT/ -> ${REMOTE_HOST}:$REMOTE_REPO/ ==="
run_tar_sync

echo "=== remote install-system-run.sh ==="
run_install

if [[ "$NO_RESTART" -eq 0 ]]; then
  echo "=== SIGUSR2 compositor (in-place restart) ==="
  signal_compositor_restart
fi

echo "Done."
echo ""
printf '%s\n' \
  "remote-update-and-restart: SIGUSR2 reloads the compositor process only." \
  "If scripts/derp-session.sh changed, or you added scripts/derp-session.local.env / CEF_* overrides," \
  "log out of GDM and back in once (the derp-session supervisor is the old bash until then)."
