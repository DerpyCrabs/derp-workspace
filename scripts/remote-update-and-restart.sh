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
# REMOTE_HOST, REMOTE_REPO. quick_shell / sync_only skip remote npm by default (HMR / external Vite).
# Set DERP_REMOTE_BUILD_SHELL=1 to run install-system-run.sh --shell-only on quick_shell (file:// dist on remote).
#
# Auto mode compares the working tree to scripts/.derp-remote-update-snapshot (gitignored), not git:
# uncommitted edits and multiple pushes between commits are detected from file contents.
#
# Usage:
#   bash scripts/remote-update-and-restart.sh [--no-restart] [--dry-run] [--full] [--quick-shell] [-- INSTALL_RUN_ARGS...]
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
UPDATE_MODE=auto
forward=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-restart) NO_RESTART=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --full) UPDATE_MODE=full; shift ;;
    --quick-shell) UPDATE_MODE=quick_shell; shift ;;
    -h|--help)
      sed -n '1,24p' "$0"
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

DERP_REMOTE_SNAPSHOT="$SCRIPT_DIR/.derp-remote-update-snapshot"

derp_remote_list_full_paths() {
  (
    cd "$REPO_ROOT" || exit 1
    for d in compositor shell_wire resources; do
      [[ -d "$d" ]] || continue
      find "$d" -type f 2>/dev/null || true
    done
    for f in Cargo.toml Cargo.lock scripts/derp-session.sh scripts/install-system-run.sh; do
      [[ -f "$f" ]] && printf '%s\n' "$f"
    done
  ) | LC_ALL=C sort -u
}

derp_remote_list_shell_paths() {
  (
    cd "$REPO_ROOT" || exit 1
    [[ -d shell ]] || exit 0
    find shell -type f 2>/dev/null | LC_ALL=C grep -v '^shell/node_modules/' || true
  ) | LC_ALL=C sort -u
}

derp_remote_hash_path_list() {
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

derp_remote_digest_full() {
  derp_remote_hash_path_list derp_remote_list_full_paths
}

derp_remote_digest_shell() {
  derp_remote_hash_path_list derp_remote_list_shell_paths
}

derp_remote_read_snapshot() {
  SNAP_FULL=""
  SNAP_SHELL=""
  [[ -f "$DERP_REMOTE_SNAPSHOT" ]] || return 0
  SNAP_FULL="$(sed -n '1p' "$DERP_REMOTE_SNAPSHOT")"
  SNAP_SHELL="$(sed -n '2p' "$DERP_REMOTE_SNAPSHOT")"
}

derp_remote_write_snapshot() {
  printf '%s\n%s\n' "$1" "$2" >"$DERP_REMOTE_SNAPSHOT"
}

derp_remote_classify_update() {
  if [[ "$UPDATE_MODE" == full ]]; then
    printf '%s' full
    return
  fi
  if [[ "$UPDATE_MODE" == quick_shell ]]; then
    printf '%s' quick_shell
    return
  fi
  local cur_full cur_shell
  cur_full="$(derp_remote_digest_full)"
  cur_shell="$(derp_remote_digest_shell)"
  derp_remote_read_snapshot
  if [[ ! -f "$DERP_REMOTE_SNAPSHOT" ]]; then
    printf '%s' full
    return
  fi
  if [[ "$cur_full" != "$SNAP_FULL" ]]; then
    printf '%s' full
    return
  fi
  if [[ "$cur_shell" != "$SNAP_SHELL" ]]; then
    printf '%s' quick_shell
    return
  fi
  printf '%s' sync_only
}

UPDATE_CLASS="$(derp_remote_classify_update)"
QUICK_SHELL=0
[[ "$UPDATE_CLASS" == quick_shell ]] && QUICK_SHELL=1
SYNC_ONLY=0
[[ "$UPDATE_CLASS" == sync_only ]] && SYNC_ONLY=1

SKIP_REMOTE_INSTALL=0
if [[ "$SYNC_ONLY" -eq 1 ]]; then
  SKIP_REMOTE_INSTALL=1
elif [[ "$QUICK_SHELL" -eq 1 ]]; then
  if [[ "${DERP_REMOTE_BUILD_SHELL:-0}" == "1" ]]; then
    SKIP_REMOTE_INSTALL=0
  else
    SKIP_REMOTE_INSTALL=1
  fi
fi

remote_install_parts=()
if [[ "$SKIP_REMOTE_INSTALL" -eq 0 ]]; then
  if [[ "$QUICK_SHELL" -eq 1 ]]; then
    remote_install_parts+=(--shell-only)
  fi
  remote_install_parts+=("${forward[@]}")
fi

remote_install_args=""
for a in "${remote_install_parts[@]}"; do
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
roots=()
for pid in "${pids[@]}"; do
  ppid=$(ps -o ppid= -p "$pid" | tr -d ' ')
  if ! printf '%s\n' "${pids[@]}" | grep -qx "$ppid"; then
    roots+=("$pid")
  fi
done
if [[ ${#roots[@]} -eq 0 ]]; then
  echo "remote-update-and-restart: no root compositor among PIDs (${pids[*]}); skipping SIGUSR2." >&2
  exit 0
fi
if [[ ${#pids[@]} -gt ${#roots[@]} ]]; then
  echo "remote-update-and-restart: note: signaling ${#roots[@]} root compositor PID(s) (${roots[*]}), not ${#pids[@]} total (CEF/Chromium children share the same process name)." >&2
fi
if [[ ${#roots[@]} -gt 1 ]]; then
  echo "remote-update-and-restart: warning: multiple root compositor PIDs (${roots[*]}); sending SIGUSR2 to each." >&2
fi
for pid in "${roots[@]}"; do
  kill -USR2 "$pid"
done
REMOTE
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Update class: $UPDATE_CLASS (QUICK_SHELL=$QUICK_SHELL SYNC_ONLY=$SYNC_ONLY SKIP_REMOTE_INSTALL=$SKIP_REMOTE_INSTALL)"
  echo "Snapshot: $DERP_REMOTE_SNAPSHOT (content digests vs working tree, not git)"
  echo "Would: ssh ${REMOTE_USER}@${REMOTE_HOST} mkdir -p $(printf '%q' "$REMOTE_REPO")"
  echo "Would: ( cd $(printf '%q' "$REPO_ROOT") && tar czf - --exclude=target --exclude=shell/node_modules --exclude=.git . ) | ssh … tar xzf - in $(printf '%q' "$REMOTE_REPO")"
  if [[ "$SKIP_REMOTE_INSTALL" -eq 1 ]]; then
    if [[ "$SYNC_ONLY" -eq 1 ]]; then
      echo "Would: skip remote install-system-run.sh (sync_only)"
    else
      echo "Would: skip remote install-system-run.sh (quick_shell default; DERP_REMOTE_BUILD_SHELL=1 for npm build on remote)"
    fi
  else
    echo "Would: ssh … cd $REMOTE_REPO && bash scripts/install-system-run.sh $remote_install_args"
  fi
  if [[ "$NO_RESTART" -eq 0 && "$UPDATE_CLASS" == full ]]; then
    echo "Would: ssh … SIGUSR2 to compositor"
  elif [[ "$NO_RESTART" -eq 0 ]]; then
    echo "Would: skip SIGUSR2 (quick_shell or sync_only)"
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

if [[ "$SKIP_REMOTE_INSTALL" -eq 1 ]]; then
  if [[ "$SYNC_ONLY" -eq 1 ]]; then
    echo "=== skip remote install (sync_only: same tree as snapshot after last successful run) ==="
  else
    echo "=== skip remote install (quick_shell: tar only; DERP_REMOTE_BUILD_SHELL=1 for remote npm run build) ==="
  fi
else
  echo "=== remote install-system-run.sh ==="
  run_install
fi

if [[ "$NO_RESTART" -eq 0 && "$UPDATE_CLASS" == full ]]; then
  echo "=== SIGUSR2 compositor (in-place restart) ==="
  signal_compositor_restart
fi

derp_remote_write_snapshot "$(derp_remote_digest_full)" "$(derp_remote_digest_shell)"

echo "Done."
echo ""
printf '%s\n' \
  "remote-update-and-restart: SIGUSR2 reloads the compositor process only." \
  "If scripts/derp-session.sh changed, or you added scripts/derp-session.local.env / CEF_* overrides," \
  "log out of GDM and back in once (the derp-session supervisor is the old bash until then)."
