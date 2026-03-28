# Remote install (SSH)

Run `install-system.sh` on another Linux host from this clone **without committing hostnames or SSH details**.

## Quick start

1. **Local-only config (not tracked by git)**  
   ```bash
   cp scripts/remote-install.env.example scripts/remote-install.env
   ```
   Edit `REMOTE_HOST`, `REMOTE_USER`, and `REMOTE_REPO` (absolute path on the **remote** machine).

2. **Optional:** copy `scripts/remote-install.local.md` from the same idea as this file — keep your real notes there; that filename is gitignored.

3. **Run**
   ```bash
   bash scripts/remote-install.sh
   ```
   Forward flags to `install-system.sh`, e.g.:
   ```bash
   bash scripts/remote-install.sh --no-git
   ```

4. **TTY / sudo:** use a real terminal so `ssh` can allocate a TTY (`ssh -t` is used automatically when stdin/stdout are TTYs). If `sudo` needs a password, a non-TTY SSH session will fail unless you use passwordless sudo for the install paths.

## If `git pull` fails on the remote

Uncommitted changes under `scripts/derp-session.sh` often block fast-forward pulls. By default `remote-install.sh` stashes that file when it is dirty, then runs `install-system.sh` (which pulls unless you pass `--no-git`). To skip stashing:

```bash
STASH_DERP_SESSION=0 bash scripts/remote-install.sh
```

or temporarily set `STASH_DERP_SESSION=0` in `remote-install.env`.

## Overrides without `remote-install.env`

```bash
REMOTE_HOST=192.0.2.1 REMOTE_USER=alice REMOTE_REPO=/home/alice/derp-workspace \
  bash scripts/remote-install.sh --no-git
```

## Push working tree + install + reload compositor (`remote-update-and-restart.sh`)

Use this when you want **uncommitted local changes** on the remote **without** relying on `git push` / `git pull`. It **rsyncs** the repo (excludes `target/`, `shell/node_modules/`, `.git/`), runs **`install-system-run.sh`** on the remote (same build + `sudo install` as install), then sends **`SIGUSR2`** to your user’s `compositor` process for an **in-place** reload.

```bash
bash scripts/remote-update-and-restart.sh
```

- **`--no-restart`** — rsync and install only (no `SIGUSR2`).
- **`--dry-run`** — print the operations without running them.
- Forward extra args to `install-system-run.sh` after `--`, same idea as `remote-install.sh`.

**In-place reload** needs both:

1. **Compositor + session from this tree:** the compositor exits with code **42** after a graceful `SIGUSR2` stop; **`derp-session`** must be started with **`DERP_COMPOSITOR_RESPAWN=1`** so it respawns the compositor when it sees exit 42 (pick up the newly installed `/usr/local/bin/compositor`). Without that env, a stop would end the Wayland session as before.

2. **Session env (example):** one way on the target user account is a systemd user drop-in for the session, or an `environment.d` snippet GDM picks up, e.g. `/etc/environment.d/derp-respawn.conf`:

   ```
   DERP_COMPOSITOR_RESPAWN=1
   ```

   Use whatever matches your distro’s GDM documentation; the requirement is that **`derp-session`** sees the variable when the “Derp Compositor” session starts.

**Fully non-interactive SSH** (no sudo password prompt): configure **`sudoers`** on the remote so `install-system-run.sh` can run its **`sudo`** steps without a TTY. That script uses **`install`** and **`ln`** (see `scripts/install-system-run.sh`). Example (adjust user and binary paths to match the host, e.g. `command -v install` / `command -v ln`):

```
alice ALL=(root) NOPASSWD: /usr/bin/install, /usr/bin/ln
```

## See also

- `scripts/install-system.sh` — what actually builds and installs on the remote.
- `scripts/remote-update-and-restart.sh` — rsync + remote `install-system-run.sh` + compositor `SIGUSR2` reload.
- `scripts/list-derp-logs.sh` — same `remote-install.env`; SSH to the host and tail `~/.local/state/derp/compositor.log` (DERP session log).
- `README.md` — GDM session and DRM notes.
