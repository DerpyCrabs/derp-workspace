#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/remote-common.sh"
remote_common_init "remote-harness"

require_remote_sync_tools
remote_test_lock_acquire

FETCH=1
remote_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-fetch)
      FETCH=0
      shift
      ;;
    --help|-h)
      remote_args+=(--help)
      shift
      ;;
    --)
      shift
      remote_args+=("$@")
      break
      ;;
    *)
      remote_args+=("$1")
      shift
      ;;
  esac
done

quoted_args=()
for arg in "${remote_args[@]}"; do
  quoted_args+=("$(printf '%q' "$arg")")
done
remote_args_str="${quoted_args[*]:-}"

echo "=== remote mkdir ==="
ssh_base mkdir -p "$REMOTE_REPO"

echo "=== tar (gzip) $REPO_ROOT/ -> ${REMOTE_HOST}:$REMOTE_REPO/ ==="
run_tar_sync

echo "=== remote ensure shell node modules ==="
ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")/shell
bash ../scripts/ensure-shell-node-modules.sh .
EOF

echo "=== remote harness ==="
ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
export DERP_E2E_NATIVE_BIN=${DERP_E2E_NATIVE_BIN:-$(printf '%q' "$REMOTE_REPO/target/release/derp-test-client")}
exec node shell/e2e/harness.mjs ${remote_args_str}
EOF

if [[ "$FETCH" -eq 1 ]]; then
  "$SCRIPT_DIR/fetch-e2e-artifacts.sh"
fi
