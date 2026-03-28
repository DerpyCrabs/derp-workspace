#!/usr/bin/env bash
# Spawned by the compositor --command after the shell IPC socket exists.
# Environment (set by derp-session via env): CEF_PATH, CEF_SHELL_URL, CEF_HOST_BIN,
# CEF_HOST_USE_GPU; DERP_PERF_SESSION also adds CEF_HOST_PERF=1 for on_paint timing on stderr.
set -euo pipefail

: "${CEF_PATH:?}"
: "${CEF_SHELL_URL:?}"
: "${CEF_HOST_BIN:?}"

export CEF_HOST_USE_GPU="${CEF_HOST_USE_GPU:-1}"

exec "$CEF_HOST_BIN" --url "$CEF_SHELL_URL"
