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

if [[ "$SHELL_ONLY" -eq 0 ]]; then
  echo "=== cargo build --release (compositor) ==="
  cargo build --release -p compositor
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
    if [[ -f package-lock.json ]]; then
      npm ci || npm install
    else
      npm install
    fi
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

if [[ ! -f "$DESKTOP_SRC" ]]; then
  echo "Missing $DESKTOP_SRC" >&2
  exit 1
fi

# Desktop Exec= must match where we put derp-session (symlink target is this script's sibling).
if ! grep -q '^Exec=/usr/local/bin/derp-session$' "$DESKTOP_SRC" 2>/dev/null && [[ "$INSTALL_PREFIX" != "/usr/local" ]]; then
  echo "Note: resources/derp-wayland.desktop uses Exec=/usr/local/bin/derp-session." >&2
  echo "      Install prefix is $INSTALL_PREFIX — update the .desktop Exec= line or use INSTALL_PREFIX=/usr/local." >&2
fi

echo "=== install to $INSTALL_PREFIX (sudo) ==="
sudo install -d "$BIN_DIR" "$SESSION_DIR"
sudo install -Dm755 "$REPO_ROOT/target/release/compositor" "$BIN_DIR/compositor"
sudo install -Dm644 "$DESKTOP_SRC" "$DESKTOP_DST"
chmod +x "$REPO_ROOT/scripts/derp-session.sh" 2>/dev/null || true
sudo ln -sf "$REPO_ROOT/scripts/derp-session.sh" "$BIN_DIR/derp-session"

echo ""
echo "Done. Log out and choose «Derp Compositor» in GDM."
echo "Repo (shell/dist + derp-session): $REPO_ROOT"
if [[ -f "$SHELL_INDEX" ]]; then
  echo "CEF shell: $REPO_ROOT/$SHELL_INDEX (derp-session passes --cef-shell-url to compositor)."
else
  echo "CEF shell: not built — add shell/ and re-run this script, or run nested without Solid."
fi
echo "Session log (default): ~/.local/state/derp/compositor.log — truncated each compositor start (and SIGUSR2 respawn) unless DERP_COMPOSITOR_LOG_APPEND=1."
echo "dma-buf / Chromium verbose logs: off by default; set DERP_SESSION_DMABUF_LOGS=1 in scripts/derp-session.local.env when debugging import/EGL."
echo "CEF Solid OSR: dma-buf only (in compositor; derp-session does not set toggle env vars)."
echo "Optional overrides only: scripts/derp-session.local.env (see derp-session.local.env.example). Default session is dma-buf OSR without this file."
