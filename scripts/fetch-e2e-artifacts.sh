#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/remote-common.sh"
remote_common_init "fetch-e2e-artifacts"

require_remote_sync_tools

DEFAULT_LOCAL_DIR="$REPO_ROOT/.artifacts/e2e"
LOCAL_DIR="${1:-$DEFAULT_LOCAL_DIR}"
if [[ "$LOCAL_DIR" == "$DEFAULT_LOCAL_DIR" ]]; then
  rm -rf "$LOCAL_DIR"
fi
mkdir -p "$LOCAL_DIR"

echo "=== fetch remote e2e artifacts -> $LOCAL_DIR ==="
ssh_base bash -s <<'EOF' | tar xzf - -C "$LOCAL_DIR"
set -euo pipefail
ARTIFACT_DIR="${DERP_E2E_ARTIFACT_DIR:-$HOME/.local/state/derp/e2e/artifacts}"
[[ -d "$ARTIFACT_DIR" ]] || {
  echo "missing remote artifact dir: $ARTIFACT_DIR" >&2
  exit 1
}
cd "$ARTIFACT_DIR"
tar czf - .
EOF
