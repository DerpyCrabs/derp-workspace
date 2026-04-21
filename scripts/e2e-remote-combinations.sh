#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/remote-common.sh"
remote_common_init "e2e-remote-combinations"

require_remote_sync_tools
remote_test_lock_acquire

usage() {
  cat <<'EOF'
Usage: scripts/e2e-remote-combinations.sh [options] [spec selectors...]

Runs all non-empty combinations of the selected e2e spec files on the remote machine
after a single sync/build step. Each combination gets its own timeout budget and
artifact directory.

Options:
  --min-size N              Smallest combination size to run. Default: 1
  --max-size N              Largest combination size to run. Default: all selected specs
  --base-timeout-sec N      Base timeout added to every combination. Default: 7
  --per-file-timeout-sec N  Extra timeout per spec file in the combination. Default: 6
  --fail-fast               Stop after the first failing or timed out combination
  --dry-run                 Print the planned combinations without running them
  --help                    Show this help

Selectors match the same variants as shell/e2e/run.ts, for example:
  tab-groups
  tab-groups.spec.ts
  shell/e2e/specs/tab-groups.spec.ts
EOF
}

normalize_selector() {
  local value="$1"
  value="${value//\\//}"
  value="${value#./}"
  value="${value#shell/e2e/specs/}"
  value="${value#e2e/specs/}"
  value="${value#specs/}"
  printf '%s' "${value,,}"
}

selector_matches_spec() {
  local selector normalized spec without_spec without_ts
  selector="$(normalize_selector "$1")"
  spec="$(normalize_selector "$2")"
  without_spec="${spec%.spec.ts}"
  without_ts="${spec%.ts}"
  [[ "$selector" == "$spec" || "$selector" == "$without_spec" || "$selector" == "$without_ts" ]]
}

specs_from_index() {
  local index_file="$REPO_ROOT/shell/e2e/specs/index.ts"
  local line
  while IFS= read -r line; do
    if [[ "$line" =~ \./([A-Za-z0-9._-]+\.spec\.ts) ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
    fi
  done < "$index_file"
}

min_size=1
max_size=0
base_timeout_sec="${DERP_E2E_COMBO_BASE_TIMEOUT_SEC:-7}"
per_file_timeout_sec="${DERP_E2E_COMBO_PER_FILE_TIMEOUT_SEC:-6}"
fail_fast=0
dry_run=0
selectors=()

while (($# > 0)); do
  case "$1" in
    --min-size)
      min_size="$2"
      shift 2
      ;;
    --max-size)
      max_size="$2"
      shift 2
      ;;
    --base-timeout-sec)
      base_timeout_sec="$2"
      shift 2
      ;;
    --per-file-timeout-sec)
      per_file_timeout_sec="$2"
      shift 2
      ;;
    --fail-fast)
      fail_fast=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      while (($# > 0)); do
        selectors+=("$1")
        shift
      done
      ;;
    *)
      selectors+=("$1")
      shift
      ;;
  esac
done

if ! [[ "$min_size" =~ ^[0-9]+$ && "$max_size" =~ ^[0-9]*$ && "$base_timeout_sec" =~ ^[0-9]+$ && "$per_file_timeout_sec" =~ ^[0-9]+$ ]]; then
  echo "e2e-remote-combinations: numeric options must be non-negative integers" >&2
  exit 1
fi

mapfile -t ordered_specs < <(specs_from_index)
if ((${#ordered_specs[@]} == 0)); then
  echo "e2e-remote-combinations: failed to read spec list from shell/e2e/specs/index.ts" >&2
  exit 1
fi

selected_specs=()
if ((${#selectors[@]} == 0)); then
  selected_specs=("${ordered_specs[@]}")
else
  unmatched=()
  for selector in "${selectors[@]}"; do
    matched=0
    for spec in "${ordered_specs[@]}"; do
      if selector_matches_spec "$selector" "$spec"; then
        if ((${#selected_specs[@]} == 0)); then
          selected_specs+=("$spec")
        else
          seen=0
          for chosen in "${selected_specs[@]}"; do
            if [[ "$chosen" == "$spec" ]]; then
              seen=1
              break
            fi
          done
          ((seen == 0)) && selected_specs+=("$spec")
        fi
        matched=1
      fi
    done
    ((matched == 0)) && unmatched+=("$selector")
  done
  if ((${#unmatched[@]} > 0)); then
    echo "e2e-remote-combinations: unknown selector(s): ${unmatched[*]}" >&2
    echo "available: ${ordered_specs[*]}" >&2
    exit 1
  fi
fi

spec_count="${#selected_specs[@]}"
if ((spec_count == 0)); then
  echo "e2e-remote-combinations: no spec files selected" >&2
  exit 1
fi

if ((max_size == 0)); then
  max_size="$spec_count"
fi

if ((min_size < 1 || max_size < 1 || min_size > max_size || max_size > spec_count)); then
  echo "e2e-remote-combinations: invalid size range min=$min_size max=$max_size for $spec_count selected specs" >&2
  exit 1
fi

slugify_combo() {
  local value="$1"
  value="${value//.spec.ts/}"
  value="${value//,/\+}"
  value="${value//\//-}"
  value="${value//[^a-zA-Z0-9._+-]/-}"
  printf '%s' "$value"
}

combo_lines=()
combo_index=0
current_combo=()

append_current_combo() {
  local size csv label
  size="${#current_combo[@]}"
  if ((size < min_size || size > max_size)); then
    return
  fi
  combo_index=$((combo_index + 1))
  csv="$(IFS=,; printf '%s' "${current_combo[*]}")"
  label="$(slugify_combo "$csv")"
  combo_lines+=("$(printf '%03d\t%d\t%s\t%s' "$combo_index" "$size" "$label" "$csv")")
}

build_combinations() {
  local start="$1"
  local i
  if ((${#current_combo[@]} >= min_size)); then
    append_current_combo
  fi
  if ((${#current_combo[@]} == max_size)); then
    return
  fi
  for ((i = start; i < spec_count; i++)); do
    current_combo+=("${selected_specs[i]}")
    build_combinations "$((i + 1))"
    current_combo=("${current_combo[@]:0:${#current_combo[@]}-1}")
  done
}

build_combinations 0

combo_count="${#combo_lines[@]}"
if ((combo_count == 0)); then
  echo "e2e-remote-combinations: no combinations generated" >&2
  exit 1
fi

echo "=== combination plan ==="
echo "selected specs: ${selected_specs[*]}"
echo "combination sizes: $min_size..$max_size"
echo "combination count: $combo_count"
echo "timeouts: ${base_timeout_sec}s base + ${per_file_timeout_sec}s per file"

if ((dry_run == 1)); then
  printf '%s\n' "${combo_lines[@]}" | while IFS=$'\t' read -r combo_id combo_size combo_label selectors_csv; do
    timeout_sec=$((base_timeout_sec + per_file_timeout_sec * combo_size))
    printf '[%s/%03d] %2s files  timeout=%2ss  %s\n' "$combo_id" "$combo_count" "$combo_size" "$timeout_sec" "$selectors_csv"
  done
  exit 0
fi

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

run_stamp="$(date +%Y%m%d-%H%M%S)"
combo_blob="$(printf '%s\n' "${combo_lines[@]}")"
remote_root_default="$REMOTE_REPO/.artifacts/e2e-combinations/$run_stamp"
local_root="$REPO_ROOT/.artifacts/e2e-combinations/$run_stamp"
remote_status=0

echo "=== remote mkdir ==="
ssh_base mkdir -p "$REMOTE_REPO"

echo "=== tar (gzip) $REPO_ROOT/ -> ${REMOTE_HOST}:$REMOTE_REPO/ ==="
run_tar_sync

echo "=== remote cargo build --release -p compositor -p derp-test-client ==="
ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
cargo build --release -p compositor -p derp-test-client
if [[ -f shell/package.json ]]; then
  cd shell
  bash ../scripts/ensure-shell-node-modules.sh .
  npm run build
fi
EOF

echo "=== remote combination matrix ==="
ssh_base bash -s <<EOF || remote_status=$?
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
$(printf '%s\n' "${remote_env[@]}")
if ! command -v timeout >/dev/null 2>&1; then
  echo "remote e2e combination runner requires 'timeout'" >&2
  exit 2
fi
combo_root="\${DERP_E2E_ARTIFACT_DIR:-$(printf '%q' "$remote_root_default")}"
mkdir -p "\$combo_root"
summary_tsv="\$combo_root/summary.tsv"
summary_txt="\$combo_root/summary.txt"
printf 'combo_id\tsize\ttimeout_sec\tstatus\telapsed_sec\tselectors\tartifact_dir\n' > "\$summary_tsv"
pass_count=0
fail_count=0
timeout_count=0
total_count=$(printf '%q' "$combo_count")
base_timeout=$(printf '%q' "$base_timeout_sec")
per_file_timeout=$(printf '%q' "$per_file_timeout_sec")
stop_on_failure=$(printf '%q' "$fail_fast")
while IFS=\$'\\t' read -r combo_id combo_size combo_label selectors_csv; do
  [[ -z "\$combo_id" ]] && continue
  timeout_sec=\$((base_timeout + per_file_timeout * combo_size))
  artifact_dir="\$combo_root/\${combo_id}-\${combo_label}"
  mkdir -p "\$artifact_dir"
  start_sec=\$(date +%s)
  set +e
  DERP_E2E_ARTIFACT_DIR="\$artifact_dir" timeout --foreground --kill-after=10s "\${timeout_sec}s" node shell/e2e/run.mjs "\$selectors_csv" > "\$artifact_dir/run.log" 2>&1
  exit_code=\$?
  set -e
  elapsed_sec=\$((\$(date +%s) - start_sec))
  status=pass
  if ((exit_code == 124 || exit_code == 137)); then
    status=timeout
    timeout_count=\$((timeout_count + 1))
  elif ((exit_code != 0)); then
    status=fail
    fail_count=\$((fail_count + 1))
  else
    pass_count=\$((pass_count + 1))
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "\$combo_id" "\$combo_size" "\$timeout_sec" "\$status" "\$elapsed_sec" "\$selectors_csv" "\$artifact_dir" >> "\$summary_tsv"
  printf '[%s/%03d] %-7s %2ss <= %2ss  %s\n' "\$combo_id" "\$total_count" "\$status" "\$elapsed_sec" "\$timeout_sec" "\$selectors_csv"
  if [[ "\$status" != pass && "\$stop_on_failure" == 1 ]]; then
    break
  fi
done <<'DERP_COMBOS'
$combo_blob
DERP_COMBOS
{
  printf 'combo_root=%s\n' "\$combo_root"
  printf 'pass=%s\n' "\$pass_count"
  printf 'fail=%s\n' "\$fail_count"
  printf 'timeout=%s\n' "\$timeout_count"
  printf 'total=%s\n' "\$((pass_count + fail_count + timeout_count))"
} > "\$summary_txt"
cat "\$summary_txt"
if ((fail_count > 0 || timeout_count > 0)); then
  exit 1
fi
EOF

mkdir -p "$local_root"
ssh -T "${REMOTE_USER}@${REMOTE_HOST}" "bash -lc $(printf '%q' "cat $(printf '%q' "${DERP_E2E_ARTIFACT_DIR:-$remote_root_default}/summary.tsv")")" > "$local_root/summary.tsv"
ssh -T "${REMOTE_USER}@${REMOTE_HOST}" "bash -lc $(printf '%q' "cat $(printf '%q' "${DERP_E2E_ARTIFACT_DIR:-$remote_root_default}/summary.txt")")" > "$local_root/summary.txt"

echo "=== local summary ==="
echo "$local_root"
if [[ -f "$local_root/summary.txt" ]]; then
  cat "$local_root/summary.txt"
fi

exit "$remote_status"
