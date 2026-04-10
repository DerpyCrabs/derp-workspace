#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/remote-common.sh"
remote_common_init "remote-verify"

verify_args=""
for a in "$@"; do
  verify_args+=$(printf '%q' "$a")" "
done

require_remote_sync_tools

echo "=== remote mkdir ==="
ssh_base mkdir -p "$REMOTE_REPO"

echo "=== tar (gzip) $REPO_ROOT/ -> ${REMOTE_HOST}:$REMOTE_REPO/ ==="
run_tar_sync

echo "=== remote scripts/verify.sh ==="
ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
cd shell
npm ci
cd ..
exec bash scripts/verify.sh ${verify_args}
EOF
