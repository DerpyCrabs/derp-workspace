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

## See also

- `scripts/install-system.sh` — what actually builds and installs on the remote.
- `README.md` — GDM session and DRM notes.
