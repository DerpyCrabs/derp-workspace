#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/remote-common.sh"
remote_common_init "e2e-remote"

require_remote_sync_tools

remote_env=()
for name in DERP_E2E_BASE DERP_SHELL_HTTP_URL_FILE DERP_E2E_ARTIFACT_DIR DERP_E2E_NATIVE_BIN DERP_E2E_SPAWN_COMMAND; do
  value="${!name:-}"
  if [[ -n "$value" ]]; then
    remote_env+=("export ${name}=$(printf '%q' "$value")")
  fi
done
if [[ -z "${DERP_E2E_NATIVE_BIN:-}" ]]; then
  remote_env+=("export DERP_E2E_NATIVE_BIN=$(printf '%q' "$REMOTE_REPO/target/release/derp-test-client")")
fi

echo "=== remote mkdir ==="
ssh_base mkdir -p "$REMOTE_REPO"

echo "=== tar (gzip) $REPO_ROOT/ -> ${REMOTE_HOST}:$REMOTE_REPO/ ==="
run_tar_sync

echo "=== remote cargo build --release -p derp-test-client ==="
ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
exec cargo build --release -p derp-test-client
EOF

echo "=== remote shell/e2e/run.mjs ==="
ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
$(printf '%s\n' "${remote_env[@]}")
exec node shell/e2e/run.mjs
EOF
