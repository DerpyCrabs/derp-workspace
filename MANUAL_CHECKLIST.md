# Manual regression checklist

Run before a release or after large Wayland/Smithay changes.

## Headless (no window)

1. Build: `cargo build -p compositor`
2. `XDG_RUNTIME_DIR=$(mktemp -d) ./target/debug/compositor --headless --socket manual-test --run-for-ms 5000`
3. In another terminal with the same `XDG_RUNTIME_DIR` and `WAYLAND_DISPLAY=manual-test`, run `wayland-info` or any trivial Wayland client; confirm it connects.

## Nested (winit window)

1. From a running Wayland session (real `XDG_RUNTIME_DIR`, e.g. `/run/user/$UID`): `bash scripts/run-nested.sh`
2. Connect clients to the printed `WAYLAND_DISPLAY` name (not the session’s default socket). Example: `WAYLAND_DISPLAY=derp-nested-123 foot`

The script keeps your session `XDG_RUNTIME_DIR` so winit can still open a window on the parent compositor. Replacing it with `/tmp` breaks nested startup.
3. Confirm: pointer moves, click raises a window, keyboard focus follows click.
4. Close the compositor window; process exits cleanly.

## Optional nested smoke (Weston + headless compositor)

Requires Weston installed locally.

```bash
cargo build --release -p compositor
bash scripts/nested-smoke.sh
```

## Logs

- `RUST_LOG=debug` for compositor when debugging focus or client disconnects.
