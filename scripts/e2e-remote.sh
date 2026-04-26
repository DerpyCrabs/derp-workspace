#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/remote-common.sh"
remote_common_init "e2e-remote"

require_remote_sync_tools
remote_test_lock_acquire

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
SESSION_RESTORE=0
for arg in "$@"; do
  if [[ "$arg" == "--session-restore" ]]; then
    SESSION_RESTORE=1
  fi
  remote_args+=("$(printf '%q' "$arg")")
done
remote_args_str="${remote_args[*]:-}"

DERP_E2E_REMOTE_SNAPSHOT="$SCRIPT_DIR/.derp-e2e-remote-snapshot"
DERP_E2E_SOFTWARE_SESSION="${DERP_E2E_SOFTWARE_RENDERING:-0}"

e2e_remote_restore_session_env() {
  [[ "$DERP_E2E_SOFTWARE_SESSION" == "1" ]] || return 0
  ssh_base bash -s <<EOF >/dev/null 2>&1 || true
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
env_file="scripts/derp-session.local.env"
backup_file="scripts/.derp-session.local.env.e2e-backup"
if [[ -f "\$backup_file" ]]; then
  {
    printf 'unset DERP_CEF_SOFTWARE_RENDERING\\n'
    printf 'unset DERP_SOFTWARE_RENDERING\\n'
    cat "\$backup_file"
  } >"\$env_file"
else
  {
    printf 'unset DERP_CEF_SOFTWARE_RENDERING\\n'
    printf 'unset DERP_SOFTWARE_RENDERING\\n'
  } >"\$env_file"
fi
mapfile -t pids < <(pgrep -u "\$(id -un)" -x compositor || true)
roots=()
for pid in "\${pids[@]}"; do
  ppid=\$(ps -o ppid= -p "\$pid" | tr -d ' ')
  if ! printf '%s\n' "\${pids[@]}" | grep -qx "\$ppid"; then
    roots+=("\$pid")
  fi
done
for pid in "\${roots[@]}"; do
  kill -USR2 "\$pid" || true
done
deadline=\$((SECONDS + 20))
for old in "\${roots[@]}"; do
  while kill -0 "\$old" 2>/dev/null && (( SECONDS < deadline )); do
    sleep 0.1
  done
done
while (( SECONDS < deadline )); do
  mapfile -t next_pids < <(pgrep -u "\$(id -un)" -x compositor || true)
  next_roots=()
  for pid in "\${next_pids[@]}"; do
    ppid=\$(ps -o ppid= -p "\$pid" | tr -d ' ')
    if ! printf '%s\n' "\${next_pids[@]}" | grep -qx "\$ppid"; then
      next_roots+=("\$pid")
    fi
  done
  if [[ \${#next_roots[@]} -gt 0 ]]; then
    break
  fi
  sleep 0.1
done
if [[ -f "\$backup_file" ]]; then
  mv "\$backup_file" "\$env_file"
else
  rm -f "\$env_file"
fi
EOF
}

if [[ "$DERP_E2E_SOFTWARE_SESSION" == "1" ]]; then
  trap e2e_remote_restore_session_env EXIT
fi

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
  echo "=== skip remote cargo build --release -p compositor -p derp-test-client ==="
else
  echo "=== remote cargo build --release -p compositor -p derp-test-client ==="
  ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
exec cargo build --release -p compositor -p derp-test-client
EOF
fi

if [[ "$SKIP_SYNC" -eq 0 ]]; then
  echo "=== install compositor + derp-test-client to /usr/local (e2e) ==="
  ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
sudo install -Dm755 target/release/compositor /usr/local/bin/compositor
sudo install -Dm755 target/release/derpctl /usr/local/bin/derpctl
sudo install -Dm755 target/release/derp-test-client /usr/local/bin/derp-test-client
EOF
fi

if [[ "$SKIP_SYNC" -eq 1 ]]; then
  echo "=== skip remote npm shell -> dist/ ==="
else
  echo "=== remote npm shell -> dist/ ==="
  ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
if [[ -f shell/package.json ]]; then
  cd shell
  bash ../scripts/ensure-shell-node-modules.sh .
  exec npm run build
fi
EOF
fi

if [[ "$DERP_E2E_SOFTWARE_SESSION" == "1" ]]; then
  echo "=== enable remote CEF software rendering for e2e ==="
  ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
mkdir -p scripts
env_file="scripts/derp-session.local.env"
backup_file="scripts/.derp-session.local.env.e2e-backup"
rm -f "\$backup_file"
if [[ -f "\$env_file" ]]; then
  cp -a "\$env_file" "\$backup_file"
fi
{
  [[ -f "\$env_file" ]] && cat "\$env_file"
  printf '\\nexport DERP_CEF_SOFTWARE_RENDERING=1\\n'
  printf 'export DERP_SOFTWARE_RENDERING=1\\n'
} >"\$env_file.tmp"
mv "\$env_file.tmp" "\$env_file"
EOF
fi

echo "=== SIGUSR2 compositor (before e2e) ==="
if [[ "$SESSION_RESTORE" -eq 0 ]]; then
  echo "=== disable saved session restore for e2e ==="
  ssh_base bash -s <<'REMOTE'
set -euo pipefail
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/derp"
mkdir -p "$state_dir"
printf '{"version":1,"shell":{}}\n' >"$state_dir/session-state.json"
REMOTE
fi
ssh_base bash -s <<'REMOTE'
set -euo pipefail
artifact_dir="${DERP_E2E_ARTIFACT_DIR:-$HOME/.local/state/derp/e2e/artifacts}"
rm -rf "$artifact_dir"
mkdir -p "$artifact_dir"
mapfile -t pids < <(pgrep -u "$(id -un)" -x compositor || true)
if [[ ${#pids[@]} -eq 0 ]]; then
  echo "e2e-remote: no compositor process for user $(id -un); skipping SIGUSR2." >&2
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
  echo "e2e-remote: no root compositor among PIDs (${pids[*]}); skipping SIGUSR2." >&2
  exit 0
fi
for pid in "${roots[@]}"; do
  kill -USR2 "$pid"
done
REMOTE

echo "=== remote shell/e2e/run.mjs ==="
ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
$(printf '%s\n' "${remote_env[@]}")
exec node shell/e2e/run.mjs ${remote_args_str}
EOF

printf '%s\n%s\n' "$cur_sync_digest" "$cur_build_digest" >"$DERP_E2E_REMOTE_SNAPSHOT"
