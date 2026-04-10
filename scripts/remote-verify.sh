#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/remote-common.sh"
remote_common_init "remote-verify"

verify_args=""
for a in "$@"; do
  verify_args+=$(printf '%q' "$a")" "
done

require_remote_sync_tools

echo "=== remote mkdir ==="
ssh_base mkdir -p "$REMOTE_REPO"

echo "=== tar (gzip) $REPO_ROOT/ -> ${REMOTE_HOST}:$REMOTE_REPO/ ==="
run_tar_sync

echo "=== remote scripts/verify.sh ==="
ssh_base bash -s <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_REPO")
cd shell
npm ci
cd ..
exec bash scripts/verify.sh ${verify_args}
EOF

echo "=== remote portal runtime ==="
ssh_base bash -s <<'EOF'
set -euo pipefail
command -v pipewire >/dev/null 2>&1 || {
  echo "remote-verify: missing runtime command: pipewire" >&2
  exit 1
}
(
  command -v xdg-desktop-portal >/dev/null 2>&1 \
    || [[ -x /usr/lib/xdg-desktop-portal ]] \
    || [[ -x /usr/libexec/xdg-desktop-portal ]]
) || {
  echo "remote-verify: missing xdg-desktop-portal runtime" >&2
  exit 1
}
(
  command -v xdg-desktop-portal-wlr >/dev/null 2>&1 \
    || [[ -x /usr/lib/xdg-desktop-portal-wlr ]] \
    || [[ -x /usr/libexec/xdg-desktop-portal-wlr ]]
) || {
  echo "remote-verify: missing xdg-desktop-portal-wlr runtime" >&2
  exit 1
}
(
  command -v xdg-desktop-portal-gtk >/dev/null 2>&1 \
    || [[ -x /usr/lib/xdg-desktop-portal-gtk ]] \
    || [[ -x /usr/libexec/xdg-desktop-portal-gtk ]]
) || {
  echo "remote-verify: missing xdg-desktop-portal-gtk runtime" >&2
  exit 1
}
if [[ ! -f /usr/local/share/xdg-desktop-portal/derp-portals.conf ]]; then
  echo "remote-verify: missing installed portal config: /usr/local/share/xdg-desktop-portal/derp-portals.conf" >&2
  exit 1
fi
uid="$(id -u)"
if [[ -S "/run/user/$uid/bus" ]] && command -v busctl >/dev/null 2>&1; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus"
  busctl --user introspect org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop org.freedesktop.portal.ScreenCast >/dev/null
fi
EOF
