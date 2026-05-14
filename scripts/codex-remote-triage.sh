#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START_DIR="$(pwd -P)"
SCRIPT_REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

repo_from_cwd=""
if command -v git >/dev/null 2>&1; then
  repo_from_cwd="$(git -C "$START_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
fi

if [[ -n "$repo_from_cwd" && -f "$repo_from_cwd/scripts/remote-verify.sh" && -f "$repo_from_cwd/scripts/e2e-remote.sh" ]]; then
  REPO_ROOT="$(cd "$repo_from_cwd" && pwd -P)"
else
  REPO_ROOT="$SCRIPT_REPO_ROOT"
fi

MODEL="${DERP_CODEX_TRIAGE_MODEL:-gpt-5.3-codex-spark}"
FALLBACK_MODELS="${DERP_CODEX_TRIAGE_FALLBACK_MODELS:-gpt-5.2}"
CODEX_BIN="${DERP_CODEX_TRIAGE_CODEX_BIN:-codex}"
OUT_DIR="${DERP_CODEX_TRIAGE_OUT_DIR:-$REPO_ROOT/.artifacts/remote-triage}"
CLEAN_ENV="${DERP_CODEX_TRIAGE_CLEAN_ENV:-0}"
RUN_UPDATE="${DERP_CODEX_TRIAGE_UPDATE:-1}"
RUN_VERIFY="${DERP_CODEX_TRIAGE_VERIFY:-1}"
RUN_E2E="${DERP_CODEX_TRIAGE_E2E:-1}"
FETCH_LINES="${DERP_CODEX_TRIAGE_LOG_LINES:-2000}"
EXTRA_PROMPT="${DERP_CODEX_TRIAGE_PROMPT:-}"
LOAD_USER_CONFIG="${DERP_CODEX_TRIAGE_LOAD_USER_CONFIG:-0}"
LOAD_RULES="${DERP_CODEX_TRIAGE_LOAD_RULES:-0}"
PERSIST_SESSION="${DERP_CODEX_TRIAGE_PERSIST_SESSION:-0}"
STREAM="${DERP_CODEX_TRIAGE_STREAM:-0}"
DRY_RUN=0

pass_env=()
env_assignments=()
env_files=()
e2e_args=()
codex_config=()
extra_prompt_args=()
e2e_arg_count=0
extra_prompt_arg_count=0

usage() {
  cat <<'EOF'
Usage: scripts/codex-remote-triage.sh [options] [-- extra prompt]

Options:
  --model MODEL                  Codex model, default DERP_CODEX_TRIAGE_MODEL or gpt-5.3-codex-spark
  --codex-bin PATH               Codex executable, default DERP_CODEX_TRIAGE_CODEX_BIN or codex
  --repo DIR                     Repository root for codex --cd
  --out-dir DIR                  Output directory, default .artifacts/remote-triage
  --clean-env                    Run codex with env -i and only selected variables
  --env NAME                     Pass current NAME to codex in clean env mode
  --env NAME=VALUE               Set NAME=VALUE for codex
  --pass-env NAMES               Comma or space separated variable names to pass in clean env mode
  --env-file FILE                Source FILE and pass variables assigned by it
  --config KEY=VALUE             Forward one codex -c config override
  --no-update                    Skip remote-update-and-restart.sh
  --no-verify                    Skip remote-verify.sh
  --no-e2e                       Skip e2e-remote.sh
  --e2e-arg ARG                  Pass ARG to e2e-remote.sh
  --log-lines N                  Lines for fetch-logs.sh, default 2000
  --stream                       Stream nested codex output instead of only saving the log
  --dry-run                      Print command and generated prompt path
  -h, --help                     Show this help

Environment:
  DERP_CODEX_TRIAGE_ENV          Comma or space separated variable names for clean env mode
  DERP_CODEX_TRIAGE_CLEAN_ENV    1 to use env -i
  DERP_CODEX_TRIAGE_LOAD_RULES   1 to let codex load AGENTS/rules in addition to the prompt
  DERP_CODEX_TRIAGE_LOAD_USER_CONFIG
                                  1 to let codex load user config/plugins
  DERP_CODEX_TRIAGE_PERSIST_SESSION
                                  1 to keep the nested codex session
  DERP_CODEX_TRIAGE_STREAM       1 to stream nested codex output
  DERP_CODEX_TRIAGE_PROMPT       Extra instructions appended to the worker prompt
EOF
}

add_pass_env_names() {
  local raw="$1"
  local name
  raw="${raw//,/ }"
  for name in $raw; do
    [[ -n "$name" ]] && pass_env+=("$name")
  done
}

add_unique_env_value() {
  local value="$1"
  local existing
  for existing in ${cmd_env_values+"${cmd_env_values[@]}"}; do
    if [[ "$existing" == "$value" ]]; then
      return
    fi
  done
  cmd_env_values+=("$value")
}

add_env_file() {
  local file="$1"
  local line trimmed name
  file="$(cd "$(dirname "$file")" && pwd -P)/$(basename "$file")"
  env_files+=("$file")
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="${line#"${line%%[![:space:]]*}"}"
    trimmed="${trimmed#export }"
    if [[ "$trimmed" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]]; then
      name="${BASH_REMATCH[1]}"
      pass_env+=("$name")
    fi
  done <"$file"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      MODEL="${2:?}"
      shift 2
      ;;
    --codex-bin)
      CODEX_BIN="${2:?}"
      shift 2
      ;;
    --repo)
      REPO_ROOT="$(cd "${2:?}" && pwd -P)"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:?}"
      shift 2
      ;;
    --clean-env)
      CLEAN_ENV=1
      shift
      ;;
    --env)
      value="${2:?}"
      if [[ "$value" == *=* ]]; then
        env_assignments+=("$value")
      else
        pass_env+=("$value")
      fi
      shift 2
      ;;
    --pass-env)
      add_pass_env_names "${2:?}"
      shift 2
      ;;
    --env-file)
      add_env_file "${2:?}"
      shift 2
      ;;
    --config|-c)
      codex_config+=("-c" "${2:?}")
      shift 2
      ;;
    --no-update)
      RUN_UPDATE=0
      shift
      ;;
    --no-verify)
      RUN_VERIFY=0
      shift
      ;;
    --no-e2e)
      RUN_E2E=0
      shift
      ;;
    --e2e-arg)
      e2e_args+=("${2:?}")
      e2e_arg_count=$((e2e_arg_count + 1))
      shift 2
      ;;
    --log-lines)
      FETCH_LINES="${2:?}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --stream)
      STREAM=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      extra_prompt_args+=("$@")
      extra_prompt_arg_count=$#
      break
      ;;
    *)
      echo "codex-remote-triage: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$REPO_ROOT/scripts/remote-verify.sh" || ! -f "$REPO_ROOT/scripts/e2e-remote.sh" ]]; then
  echo "codex-remote-triage: $REPO_ROOT does not look like derp-workspace" >&2
  exit 1
fi

if [[ -n "${DERP_CODEX_TRIAGE_ENV:-}" ]]; then
  add_pass_env_names "$DERP_CODEX_TRIAGE_ENV"
fi

for file in ${env_files+"${env_files[@]}"}; do
  set -a
  source "$file"
  set +a
done

mkdir -p "$OUT_DIR"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
PROMPT_FILE="$OUT_DIR/$RUN_ID.prompt.md"
LOG_FILE="$OUT_DIR/$RUN_ID.log"
MESSAGE_FILE="$OUT_DIR/$RUN_ID.md"
LATEST_FILE="$OUT_DIR/latest.md"

e2e_args_text=""
if [[ "$e2e_arg_count" -gt 0 ]]; then
  for arg in "${e2e_args[@]}"; do
    e2e_args_text+=" $(printf '%q' "$arg")"
  done
fi

extra_prompt_text="$EXTRA_PROMPT"
if [[ "$extra_prompt_arg_count" -gt 0 ]]; then
  if [[ -n "$extra_prompt_text" ]]; then
    extra_prompt_text+=$'\n'
  fi
  extra_prompt_text+="${extra_prompt_args[*]}"
fi

cat >"$PROMPT_FILE" <<EOF
You are a fast Codex remote verification triage worker for derp-workspace.

Repository root: $REPO_ROOT
Started from: $START_DIR
Run id: $RUN_ID

Do not edit files or create commits. Run commands sequentially. Do not ask the user to run anything. If a remote command fails, fetch the relevant logs and inspect local artifacts before writing your final answer.

Project rules to follow:
- All verification happens on the remote machine.
- Use ./scripts/remote-update-and-restart.sh after changes when enabled.
- Use ./scripts/remote-verify.sh and ./scripts/e2e-remote.sh to tar-sync sources and verify remotely.
- Use ./scripts/fetch-logs.sh when there is a failure.
- If compositor crashes or remote update leaves no compositor running, restart gdm on the remote and continue triage.
- Tests must not run in parallel.

Enabled commands:
- remote update: $RUN_UPDATE
- remote verify: $RUN_VERIFY
- remote e2e: $RUN_E2E

Workflow:
1. cd "$REPO_ROOT"
2. If remote update is enabled, run ./scripts/remote-update-and-restart.sh
3. If remote verify is enabled, run ./scripts/remote-verify.sh
4. If remote e2e is enabled, run ./scripts/e2e-remote.sh$e2e_args_text
5. If any command fails, run ./scripts/fetch-logs.sh -n $FETCH_LINES and inspect .artifacts/e2e plus any newly fetched artifacts or logs.
6. If e2e artifacts are missing but the failure mentions remote artifacts, run the existing project artifact fetch script if applicable.

Final answer format:
Status: PASS or FAIL
Commands run:
Failure point:
Evidence:
Likely cause:
Relevant local artifacts:
Suggested next fix:

$extra_prompt_text
EOF

cmd_prefix=()
if [[ "$CLEAN_ENV" == "1" ]]; then
  cmd_prefix=(env -i)
  default_env=(HOME PATH USER USERNAME LOGNAME SHELL TERM TMPDIR TMP TEMP SSH_AUTH_SOCK CODEX_HOME OPENAI_API_KEY)
  cmd_env_values=()
  for name in "${default_env[@]}" ${pass_env+"${pass_env[@]}"}; do
    if [[ -n "${!name+x}" ]]; then
      add_unique_env_value "$name=${!name}"
    fi
  done
  for value in ${cmd_env_values+"${cmd_env_values[@]}"}; do
    cmd_prefix+=("$value")
  done
else
  cmd_prefix=(env)
fi

build_cmd() {
  local model="$1"
  local message_file="$2"
  cmd=("${cmd_prefix[@]}")
  for assignment in ${env_assignments+"${env_assignments[@]}"}; do
    cmd+=("$assignment")
  done
  cmd+=("$CODEX_BIN" --ask-for-approval never exec --model "$model" --cd "$REPO_ROOT" --sandbox danger-full-access --color never --output-last-message "$message_file")
  if [[ "$LOAD_USER_CONFIG" != "1" ]]; then
    cmd+=(--ignore-user-config)
  fi
  if [[ "$LOAD_RULES" != "1" ]]; then
    cmd+=(--ignore-rules)
  fi
  if [[ "$PERSIST_SESSION" != "1" ]]; then
    cmd+=(--ephemeral)
  fi
  for config_arg in ${codex_config+"${codex_config[@]}"}; do
    cmd+=("$config_arg")
  done
  cmd+=("-")
}

build_cmd "$MODEL" "$MESSAGE_FILE"

if [[ "$DRY_RUN" == "1" ]]; then
  printf 'repo=%s\n' "$REPO_ROOT"
  printf 'prompt=%s\n' "$PROMPT_FILE"
  printf 'log=%s\n' "$LOG_FILE"
  printf 'message=%s\n' "$MESSAGE_FILE"
  printf 'command:'
  printf ' %q' "${cmd[@]}"
  printf '\n'
  exit 0
fi

status=0
if [[ "$STREAM" == "1" ]]; then
  "${cmd[@]}" <"$PROMPT_FILE" 2>&1 | tee "$LOG_FILE" || status=$?
else
  "${cmd[@]}" <"$PROMPT_FILE" >"$LOG_FILE" 2>&1 || status=$?
fi

if [[ ! -f "$MESSAGE_FILE" ]] && grep -qi "usage limit" "$LOG_FILE" && [[ -n "$FALLBACK_MODELS" ]]; then
  fallback_raw="${FALLBACK_MODELS//,/ }"
  for fallback_model in $fallback_raw; do
    [[ -n "$fallback_model" && "$fallback_model" != "$MODEL" ]] || continue
    fallback_safe="${fallback_model//[^A-Za-z0-9_.-]/_}"
    fallback_log_file="$OUT_DIR/$RUN_ID.$fallback_safe.log"
    fallback_message_file="$OUT_DIR/$RUN_ID.$fallback_safe.md"
    build_cmd "$fallback_model" "$fallback_message_file"
    status=0
    if [[ "$STREAM" == "1" ]]; then
      "${cmd[@]}" <"$PROMPT_FILE" 2>&1 | tee "$fallback_log_file" || status=$?
    else
      "${cmd[@]}" <"$PROMPT_FILE" >"$fallback_log_file" 2>&1 || status=$?
    fi
    LOG_FILE="$fallback_log_file"
    if [[ -f "$fallback_message_file" ]]; then
      cp "$fallback_message_file" "$MESSAGE_FILE"
      break
    fi
  done
fi

if [[ -f "$MESSAGE_FILE" ]]; then
  cp "$MESSAGE_FILE" "$LATEST_FILE"
else
  {
    echo "Status: FAIL"
    echo "Commands run:"
    echo "Failure point: codex exec did not produce a final message"
    echo "Evidence: $LOG_FILE"
    echo "Likely cause:"
    echo "Relevant local artifacts:"
    echo "Suggested next fix:"
  } >"$LATEST_FILE"
fi

echo "codex-remote-triage: report $LATEST_FILE"
echo "codex-remote-triage: log $LOG_FILE"
cat "$LATEST_FILE"
exit "$status"
