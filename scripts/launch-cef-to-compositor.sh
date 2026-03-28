#!/usr/bin/env bash
# Spawned by the compositor --command after the shell IPC socket exists.
# Environment (set by run-nested.sh via env): CEF_PATH, CEF_SHELL_URL, CEF_HOST_BIN
set -euo pipefail

: "${CEF_PATH:?}"
: "${CEF_SHELL_URL:?}"
: "${CEF_HOST_BIN:?}"

exec "$CEF_HOST_BIN" --url "$CEF_SHELL_URL"
