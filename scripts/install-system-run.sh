#!/usr/bin/env bash
# Build and install (no git). Invoked by install-system.sh after git pull so this file
# on disk is always what runs for cargo/npm/install — even when install-system.sh changed.
#
# You normally run scripts/install-system.sh; use this only if you already synced the repo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_PREFIX="${INSTALL_PREFIX:-/usr/local}"

SHELL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-git) ;;
    --shell-only) SHELL_ONLY=1 ;;
    -h|--help)
      echo "Run: bash $REPO_ROOT/scripts/install-system.sh [--no-git]"
      sed -n '1,26p' "$REPO_ROOT/scripts/install-system.sh"
      echo ""
      echo "install-system-run.sh only:"
      echo "  --shell-only     npm build shell/dist only; skip cargo and sudo install"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try install-system.sh --help)" >&2
      exit 1
      ;;
  esac
done

cd "$REPO_ROOT"

ensure_runtime_packages() {
  local missing=() packages=()
  command -v xterm >/dev/null 2>&1 || missing+=(xterm)
  command -v xclip >/dev/null 2>&1 || missing+=(xclip)
  command -v wl-copy >/dev/null 2>&1 || missing+=(wl-copy)
  command -v wl-paste >/dev/null 2>&1 || missing+=(wl-paste)
  [[ ${#missing[@]} -eq 0 ]] && return
  if command -v apt-get >/dev/null 2>&1; then
    for cmd in "${missing[@]}"; do
      case "$cmd" in
        xterm) packages+=(xterm) ;;
        xclip) packages+=(xclip) ;;
        wl-copy|wl-paste) packages+=(wl-clipboard) ;;
      esac
    done
    mapfile -t packages < <(printf '%s\n' "${packages[@]}" | awk '!seen[$0]++')
    echo "=== install runtime packages (${packages[*]}) ==="
    sudo apt-get update
    sudo apt-get install -y "${packages[@]}"
    return
  fi
  if command -v pacman >/dev/null 2>&1; then
    for cmd in "${missing[@]}"; do
      case "$cmd" in
        xterm) packages+=(xterm) ;;
        xclip) packages+=(xclip) ;;
        wl-copy|wl-paste) packages+=(wl-clipboard) ;;
      esac
    done
    mapfile -t packages < <(printf '%s\n' "${packages[@]}" | awk '!seen[$0]++')
    echo "=== install runtime packages (${packages[*]}) ==="
    sudo pacman -Sy --noconfirm "${packages[@]}"
    return
  fi
  echo "install-system: missing runtime commands: ${missing[*]}" >&2
  echo "install-system: install xterm, xclip, and wl-clipboard on the remote host, then re-run." >&2
  exit 1
}

ensure_runtime_packages

if [[ "$SHELL_ONLY" -eq 0 ]]; then
  echo "=== cargo build --release (compositor + derpctl + derp-test-client) ==="
  cargo build --release -p compositor -p derp-test-client
else
  echo "=== (--shell-only) skip cargo ==="
fi

SHELL_INDEX="shell/dist/index.html"
if [[ -f shell/package.json ]]; then
  echo "=== npm shell → dist/ ==="
  if ! command -v npm >/dev/null 2>&1; then
    echo "install-system: npm not found; install Node.js, then re-run this script." >&2
    exit 1
  fi
  (cd shell && {
    bash ../scripts/ensure-shell-node-modules.sh .
    npm run build
  })
  if [[ ! -f "$SHELL_INDEX" ]]; then
    echo "install-system: npm run build did not produce $REPO_ROOT/$SHELL_INDEX — fix shell/ and re-run." >&2
    exit 1
  fi
  echo "=== Solid bundle ok: $SHELL_INDEX ==="
else
  echo "No shell/package.json; skipping Solid build (GDM session will not load CEF until shell/ exists)." >&2
fi

if [[ "$SHELL_ONLY" -eq 1 ]]; then
  echo ""
  echo "Done (--shell-only). Re-run full install-system-run.sh for compositor binary and /usr/local symlinks."
  exit 0
fi

BIN_DIR="$INSTALL_PREFIX/bin"
SESSION_DIR="$INSTALL_PREFIX/share/wayland-sessions"
DESKTOP_SRC="$REPO_ROOT/resources/derp-wayland.desktop"
DESKTOP_DST="$SESSION_DIR/derp-wayland.desktop"
PORTAL_CONFIG_SRC="$REPO_ROOT/resources/derp-portals.conf"
PORTAL_CONFIG_DIR="$INSTALL_PREFIX/share/xdg-desktop-portal"
PORTAL_CONFIG_DST="$PORTAL_CONFIG_DIR/derp-portals.conf"
XDPW_CONFIG_TEMPLATE_SRC="$REPO_ROOT/resources/derp-xdg-desktop-portal-wlr.conf.in"
XDPW_CONFIG_DIR="/etc/xdg/xdg-desktop-portal-wlr"
XDPW_CONFIG_DST="$XDPW_CONFIG_DIR/Derp"
USER_XDPW_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/xdg-desktop-portal-wlr"
USER_XDPW_CONFIG_DST="$USER_XDPW_CONFIG_DIR/Derp"
SCREENCAST_PICKER_SRC="$REPO_ROOT/scripts/derp-screencast-picker.sh"
SCREENCAST_PICKER_DST="$BIN_DIR/derp-screencast-picker"

if [[ ! -f "$DESKTOP_SRC" ]]; then
  echo "Missing $DESKTOP_SRC" >&2
  exit 1
fi
if [[ ! -f "$PORTAL_CONFIG_SRC" ]]; then
  echo "Missing $PORTAL_CONFIG_SRC" >&2
  exit 1
fi
if [[ ! -f "$XDPW_CONFIG_TEMPLATE_SRC" ]]; then
  echo "Missing $XDPW_CONFIG_TEMPLATE_SRC" >&2
  exit 1
fi
if [[ ! -f "$SCREENCAST_PICKER_SRC" ]]; then
  echo "Missing $SCREENCAST_PICKER_SRC" >&2
  exit 1
fi

# Desktop Exec= must match where we put derp-session (symlink target is this script's sibling).
if ! grep -q '^Exec=/usr/local/bin/derp-session$' "$DESKTOP_SRC" 2>/dev/null && [[ "$INSTALL_PREFIX" != "/usr/local" ]]; then
  echo "Note: resources/derp-wayland.desktop uses Exec=/usr/local/bin/derp-session." >&2
  echo "      Install prefix is $INSTALL_PREFIX — update the .desktop Exec= line or use INSTALL_PREFIX=/usr/local." >&2
fi

echo "=== install to $INSTALL_PREFIX (sudo) ==="
rendered_xdpw_config="$(mktemp)"
sed "s|@DERP_SCREENCAST_PICKER@|$SCREENCAST_PICKER_DST|g" "$XDPW_CONFIG_TEMPLATE_SRC" >"$rendered_xdpw_config"
sudo install -d "$BIN_DIR" "$SESSION_DIR" "$PORTAL_CONFIG_DIR" "$XDPW_CONFIG_DIR"
sudo install -Dm755 "$REPO_ROOT/target/release/compositor" "$BIN_DIR/compositor"
sudo install -Dm755 "$REPO_ROOT/target/release/derpctl" "$BIN_DIR/derpctl"
sudo install -Dm644 "$DESKTOP_SRC" "$DESKTOP_DST"
sudo install -Dm644 "$PORTAL_CONFIG_SRC" "$PORTAL_CONFIG_DST"
sudo install -Dm644 "$rendered_xdpw_config" "$XDPW_CONFIG_DST"
sudo install -Dm755 "$SCREENCAST_PICKER_SRC" "$SCREENCAST_PICKER_DST"
install -d "$USER_XDPW_CONFIG_DIR"
install -Dm644 "$rendered_xdpw_config" "$USER_XDPW_CONFIG_DST"
rm -f "$rendered_xdpw_config"
chmod +x "$REPO_ROOT/scripts/derp-session.sh" 2>/dev/null || true
sudo ln -sf "$REPO_ROOT/scripts/derp-session.sh" "$BIN_DIR/derp-session"
uid="$(id -u)"
if [[ -S "/run/user/$uid/bus" ]] && command -v systemctl >/dev/null 2>&1; then
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$uid/bus}"
  systemctl --user restart xdg-desktop-portal-wlr.service xdg-desktop-portal.service >/dev/null 2>&1 || true
fi

echo ""
echo "Done. Log out and choose «Derp Compositor» in GDM."
echo "Repo (shell/dist + derp-session): $REPO_ROOT"
if [[ -f "$SHELL_INDEX" ]]; then
  echo "CEF shell: $REPO_ROOT/$SHELL_INDEX (derp-session passes --cef-shell-url to compositor)."
else
  echo "CEF shell: not built — add shell/ and re-run this script, or run nested without Solid."
fi
echo "Portal config: $PORTAL_CONFIG_DST"
echo "Portal chooser: $XDPW_CONFIG_DST -> $SCREENCAST_PICKER_DST"
echo "User portal chooser: $USER_XDPW_CONFIG_DST"
echo "Session log (default): ~/.local/state/derp/compositor.log — truncated each compositor start (and SIGUSR2 respawn) unless DERP_COMPOSITOR_LOG_APPEND=1."
echo "dma-buf / Chromium verbose logs: off by default; set DERP_SESSION_DMABUF_LOGS=1 in scripts/derp-session.local.env when debugging import/EGL."
echo "Compositor logs warnings with default RUST_LOG=warn."
echo "CEF Solid OSR: dma-buf only (in compositor; derp-session does not set toggle env vars)."
echo "Optional overrides only: scripts/derp-session.local.env (see derp-session.local.env.example). Default session is dma-buf OSR without this file."
