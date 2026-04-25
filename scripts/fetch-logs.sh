#!/usr/bin/env bash
# Show compositor / derp-session logs from the machine that runs the GDM session.
#
# Always SSHs to REMOTE_HOST (same config as scripts/remote-install.sh) and tails the log there.
#
# Config: scripts/remote-install.env (gitignored; copy from remote-install.env.example)
#         or env: REMOTE_USER, REMOTE_HOST, REMOTE_REPO
#
# On the remote, reads ~/.local/state/derp/compositor.log (override with DERP_COMPOSITOR_LOG on that host).
#
# Default session RUST_LOG: warn. dma-buf when DERP_SESSION_DMABUF_LOGS=1. See derp-session.sh.
# Manually before login, e.g. RUST_LOG=warn,derp_input=debug,derp_shell_osr=debug,derp_cef_begin_frame=debug
#
# Usage:
#   bash scripts/fetch-logs.sh [-n N] [-f|--follow] [-H|--head] [-h|--help]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LINES=120
FOLLOW=0
HEAD=0

usage() {
  echo "Usage: $0 [-n N] [-f|--follow] [-H|--head] [-h|--help]"
  echo "  SSH (remote-install.env: REMOTE_USER, REMOTE_HOST, REMOTE_REPO) and tail logs on the remote."
  echo "  -n N       Line count: last N with tail (default), or first N when -H/--head is set."
  echo "  -H|--head  First N lines (head) instead of last N (tail). Not used with -f."
  echo "  -f         tail -f (ssh uses -t when this terminal is interactive)."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n)
      LINES="${2:?}"
      shift 2
      ;;
    -f|--follow) FOLLOW=1; shift ;;
    -H|--head) HEAD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$HEAD" == 1 ]] && [[ "$FOLLOW" == 1 ]]; then
  echo "$0: --head is incompatible with -f/--follow" >&2
  exit 1
fi

list_logs_body() {
  STATE_BASE="${XDG_STATE_HOME:-$HOME/.local/state}"
  DEFAULT_LOG="${DERP_COMPOSITOR_LOG:-$STATE_BASE/derp/compositor.log}"
  DERP_DIR="$STATE_BASE/derp"

  echo "DERP_COMPOSITOR_LOG (default) = $DEFAULT_LOG"
  echo "State dir = $DERP_DIR"
  if [[ -d "$DERP_DIR" ]]; then
    echo "--- ls -la $DERP_DIR ---"
    ls -la "$DERP_DIR"
  else
    echo "(directory missing — session may not have run yet)"
  fi

  if [[ ! -f "$DEFAULT_LOG" ]]; then
    echo ""
    echo "Log file not found: $DEFAULT_LOG"
    exit 0
  fi

  echo ""
  if [[ "$HEAD" == 1 ]]; then
    echo "--- first $LINES lines of $(basename "$DEFAULT_LOG") ($(wc -c <"$DEFAULT_LOG") bytes) ---"
    head -n "$LINES" "$DEFAULT_LOG"
  else
    echo "--- last $LINES lines of $(basename "$DEFAULT_LOG") ($(wc -c <"$DEFAULT_LOG") bytes) ---"
    if [[ "$FOLLOW" == 1 ]]; then
      exec tail -n "$LINES" -f "$DEFAULT_LOG"
    else
      tail -n "$LINES" "$DEFAULT_LOG"
    fi
  fi
}

# Set by the SSH stub below so we only read files on the remote host, not recurse into SSH again.
if [[ -n "${LIST_DERP_LOGS_INTERNAL:-}" ]]; then
  list_logs_body
  exit 0
fi

# shellcheck source=/dev/null
[[ -f "$SCRIPT_DIR/remote-install.env" ]] && source "$SCRIPT_DIR/remote-install.env"

REMOTE_USER="${REMOTE_USER:-$USER}"
REMOTE_HOST="${REMOTE_HOST:?fetch-logs: set REMOTE_HOST (see scripts/remote-install.sample.md or scripts/remote-install.env)}"
REMOTE_REPO="${REMOTE_REPO:-/home/${REMOTE_USER}/derp-workspace}"

SSH_TTY=()
if [[ -t 0 ]] && [[ -t 1 ]]; then
  SSH_TTY=(-t)
fi

follow_arg=""
[[ "$FOLLOW" == 1 ]] && follow_arg="--follow"
head_arg=""
[[ "$HEAD" == 1 ]] && head_arg="--head"

# shellcheck disable=SC2086
exec ssh "${SSH_TTY[@]}" "${REMOTE_USER}@${REMOTE_HOST}" bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
export LIST_DERP_LOGS_INTERNAL=1
exec bash scripts/fetch-logs.sh -n $(printf '%q' "$LINES") ${head_arg} ${follow_arg}
EOF
