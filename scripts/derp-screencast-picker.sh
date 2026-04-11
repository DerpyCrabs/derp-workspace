#!/usr/bin/env bash
set -euo pipefail

url_file="${DERP_SHELL_HTTP_URL_FILE:-${XDG_RUNTIME_DIR:-/tmp}/derp-shell-http-url}"
[[ -r "$url_file" ]] || exit 1

base="$(tr -d '\r\n' <"$url_file")"
[[ "$base" == http://127.0.0.1:* ]] || exit 1

types_json='{}'
if command -v journalctl >/dev/null 2>&1; then
  types="$(
    journalctl --user -u xdg-desktop-portal-wlr.service --since '-30 seconds' --no-pager 2>/dev/null \
      | awk '/option types:/ { value=$NF } END { if (value ~ /^[0-9]+$/) print value }'
  )"
  if [[ "$types" =~ ^[0-9]+$ ]] && (( types > 0 )); then
    types_json="{\"types\":$types}"
  fi
fi

exec curl -fsS --max-time 95 -X POST -H 'Content-Type: application/json' -d "$types_json" \
  "$base/portal_screencast_pick"
