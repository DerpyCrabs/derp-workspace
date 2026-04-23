#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/scripts"

case "$(uname -s)" in
  Linux*) ;;
  *) exec bash "$SCRIPT_DIR/remote-verify.sh" "$@" ;;
esac

cd "$REPO_ROOT"
cargo test

cd "$REPO_ROOT/shell"
rm -rf node_modules/.vite node_modules/.vitest
npm run check
npm run e2e:guard
npm run test
