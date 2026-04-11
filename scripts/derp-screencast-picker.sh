#!/usr/bin/env bash
set -euo pipefail

url_file="${DERP_SHELL_HTTP_URL_FILE:-${XDG_RUNTIME_DIR:-/tmp}/derp-shell-http-url}"
[[ -r "$url_file" ]] || exit 1

base="$(tr -d '\r\n' <"$url_file")"
[[ "$base" == http://127.0.0.1:* ]] || exit 1

exec curl -fsS --max-time 95 -X POST -H 'Content-Type: application/json' -d '{}' \
  "$base/portal_screencast_pick"
