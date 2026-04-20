# E2E testing contract

New e2e specs should import helpers by role:

- `shell/e2e/lib/user.ts` for pointer, keyboard, wheel, drag, typing.
- `shell/e2e/lib/setup.ts` for fixtures, spawning, cleanup, and keybind-only setup.
- `shell/e2e/lib/oracle.ts` for snapshots, waits, assertions, artifacts.

Behavior tests should drive the compositor as a user would. Use direct `/test/keybind`, `/test/window/*`, fixture endpoints, and shell-window open endpoints only for setup or cleanup.

All user input helpers synchronize through `/test/sync` after input. Prefer one user action, one oracle assertion. If a wait is needed, wait for a compositor or shell state predicate, not elapsed time.
