#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_SRC="$REPO_ROOT/.githooks/pre-commit"
HOOK_DST="$REPO_ROOT/.git/hooks/pre-commit"

if [[ ! -d "$REPO_ROOT/.git/hooks" ]]; then
  echo "install-git-hooks: $REPO_ROOT/.git/hooks not found" >&2
  exit 1
fi

install -Dm755 "$HOOK_SRC" "$HOOK_DST"
echo "Installed $HOOK_DST"
