#!/usr/bin/env bash
# Show compositor / derp-session logs from the machine that runs the GDM session.
#
# Default: SSH to REMOTE_HOST (same config as scripts/remote-install.sh) and tail the log there.
#
# Config: scripts/remote-install.env (gitignored; copy from remote-install.env.example)
#         or env: REMOTE_USER, REMOTE_HOST, REMOTE_REPO
#
# On the remote, reads ~/.local/state/derp/compositor.log (override with DERP_COMPOSITOR_LOG on that host).
#
# Input tracing (remote session must be restarted after changing):
#   DERP_INPUT_DEBUG=1  in derp-session / environment → RUST_LOG derp_input=debug
#   DERP_INPUT_TRACE=1  → derp_input=trace
#
# Usage:
#   bash scripts/list-derp-logs.sh [-n N] [-f|--follow]
#   bash scripts/list-derp-logs.sh --local [-n N] [-f|--follow]    # no SSH; this machine only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LOCAL_MODE=0
LINES=120
FOLLOW=0

usage() {
  echo "Usage: $0 [--local] [-n N] [-f|--follow] [-h|--help]"
  echo "  Default: SSH (remote-install.env: REMOTE_USER, REMOTE_HOST, REMOTE_REPO) and tail logs on the remote."
  echo "  --local  Tail logs on this machine only."
  echo "  -n N     Last N lines (default $LINES)."
  echo "  -f       tail -f (ssh uses -t when this terminal is interactive)."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) LOCAL_MODE=1; shift ;;
    -n)
      LINES="${2:?}"
      shift 2
      ;;
    -f|--follow) FOLLOW=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

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
  echo "--- last $LINES lines of $(basename "$DEFAULT_LOG") ($(wc -c <"$DEFAULT_LOG") bytes) ---"
  if [[ "$FOLLOW" == 1 ]]; then
    exec tail -n "$LINES" -f "$DEFAULT_LOG"
  else
    tail -n "$LINES" "$DEFAULT_LOG"
  fi
}

if [[ "$LOCAL_MODE" == 1 ]]; then
  list_logs_body
  exit 0
fi

# shellcheck source=/dev/null
[[ -f "$SCRIPT_DIR/remote-install.env" ]] && source "$SCRIPT_DIR/remote-install.env"

REMOTE_USER="${REMOTE_USER:-$USER}"
REMOTE_HOST="${REMOTE_HOST:?list-derp-logs: set REMOTE_HOST (see scripts/remote-install.sample.md or scripts/remote-install.env)}"
REMOTE_REPO="${REMOTE_REPO:-/home/${REMOTE_USER}/derp-workspace}"

SSH_TTY=()
if [[ -t 0 ]] && [[ -t 1 ]]; then
  SSH_TTY=(-t)
fi

follow_arg=""
[[ "$FOLLOW" == 1 ]] && follow_arg="--follow"

# shellcheck disable=SC2086
exec ssh "${SSH_TTY[@]}" "${REMOTE_USER}@${REMOTE_HOST}" bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
exec bash scripts/list-derp-logs.sh --local -n $(printf '%q' "$LINES") ${follow_arg}
EOF
