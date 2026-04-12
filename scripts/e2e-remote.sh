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

remote_args=()
for arg in "$@"; do
  remote_args+=("$(printf '%q' "$arg")")
done
remote_args_str="${remote_args[*]:-}"

DERP_E2E_REMOTE_SNAPSHOT="$SCRIPT_DIR/.derp-e2e-remote-snapshot"

e2e_remote_list_sync_paths() {
  (
    cd "$REPO_ROOT" || exit 1
    for d in compositor shell_wire e2e-test-client resources; do
      [[ -d "$d" ]] || continue
      find "$d" -type f 2>/dev/null || true
    done
    if [[ -d shell ]]; then
      find shell -type f 2>/dev/null | LC_ALL=C awk '!/^shell\/(node_modules|dist)\//'
    fi
    if [[ -d scripts ]]; then
      find scripts -type f 2>/dev/null | LC_ALL=C awk '!/^scripts\/\.derp-(e2e-remote|remote-update)-snapshot$/'
    fi
    for f in Cargo.toml Cargo.lock; do
      [[ -f "$f" ]] && printf '%s\n' "$f"
    done
  ) | LC_ALL=C sort -u
}

e2e_remote_list_native_build_paths() {
  (
    cd "$REPO_ROOT" || exit 1
    for d in compositor shell_wire e2e-test-client; do
      [[ -d "$d" ]] || continue
      find "$d" -type f 2>/dev/null || true
    done
    for f in Cargo.toml Cargo.lock; do
      [[ -f "$f" ]] && printf '%s\n' "$f"
    done
  ) | LC_ALL=C sort -u
}

e2e_remote_digest_sync() {
  remote_repo_hash_path_list e2e_remote_list_sync_paths
}

e2e_remote_digest_native_build() {
  remote_repo_hash_path_list e2e_remote_list_native_build_paths
}

cur_sync_digest="$(e2e_remote_digest_sync)"
cur_build_digest="$(e2e_remote_digest_native_build)"
snap_sync_digest=""
snap_build_digest=""
if [[ -f "$DERP_E2E_REMOTE_SNAPSHOT" ]]; then
  snap_sync_digest="$(sed -n '1p' "$DERP_E2E_REMOTE_SNAPSHOT")"
  snap_build_digest="$(sed -n '2p' "$DERP_E2E_REMOTE_SNAPSHOT")"
fi

SKIP_SYNC=0
SKIP_BUILD=0
if [[ -f "$DERP_E2E_REMOTE_SNAPSHOT" && "$cur_sync_digest" == "$snap_sync_digest" ]]; then
  SKIP_SYNC=1
  SKIP_BUILD=1
elif [[ -f "$DERP_E2E_REMOTE_SNAPSHOT" && "$cur_build_digest" == "$snap_build_digest" ]]; then
  SKIP_BUILD=1
fi

echo "=== remote mkdir ==="
ssh_base mkdir -p "$REMOTE_REPO"

if [[ "$SKIP_SYNC" -eq 1 ]]; then
  echo "=== skip tar sync (same tree as last successful remote e2e run) ==="
else
  echo "=== tar (gzip) $REPO_ROOT/ -> ${REMOTE_HOST}:$REMOTE_REPO/ ==="
  run_tar_sync
fi

if [[ "$SKIP_BUILD" -eq 1 ]]; then
  echo "=== skip remote cargo build --release -p derp-test-client ==="
else
  echo "=== remote cargo build --release -p derp-test-client ==="
  ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
exec cargo build --release -p derp-test-client
EOF
fi

echo "=== remote shell/e2e/run.mjs ==="
ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
$(printf '%s\n' "${remote_env[@]}")
exec node shell/e2e/run.mjs ${remote_args_str}
EOF

printf '%s\n%s\n' "$cur_sync_digest" "$cur_build_digest" >"$DERP_E2E_REMOTE_SNAPSHOT"
