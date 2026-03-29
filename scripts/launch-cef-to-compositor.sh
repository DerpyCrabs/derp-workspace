set -euo pipefail

: "${CEF_PATH:?}"
: "${CEF_SHELL_URL:?}"
: "${CEF_HOST_BIN:?}"

exec "$CEF_HOST_BIN" "$CEF_SHELL_URL"
