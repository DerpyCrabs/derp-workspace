#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export DERP_E2E_SYNTHETIC_LOAD="${DERP_E2E_SYNTHETIC_LOAD:-1}"

exec bash "$SCRIPT_DIR/e2e-remote.sh" perf-smoke "$@"
