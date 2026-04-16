Project implements wayland compositor with the js shell running in CEF OSR. JS shell controls everything it can.
Shell is written in solid js, mind the reactivity and performance.
The current goal is to port most of the features from https://github.com/DerpyCrabs/derp-media-server
by migrating tests and extending UX with support for multi-monitor configurations and native wayland windows in addition to js windows.
All testing is on the remote machine, instead of asking user to do something add logs, update remote and fetch logs to debug.

Rules:
- don't add comments
- google solutions before trying hacks
- user can't change environment so you need to change scripts
- for shell styling use inline tailwind classes only, don't extract style constants or reintroduce custom shell css classes
- keep tailwind/style lint clean when editing shell ui files
- after changes do ./scripts/remote-update-and-restart.sh
- use ./scripts/remote-verify.sh and ./scripts/e2e-remote.sh to tar-sync sources to the remote machine and run verification there
- for compositor, native window lifecycle, or e2e harness changes add or update a remote e2e test and keep fetched local artifacts under .artifacts/e2e
- if you need logs use ./scripts/fetch-logs.sh
- debug everything yourself on remote machine (but if you add logs use warn and delete after debugging)
- if you see that test is flaky or broken - check that it wasn't broken by you and always fix it even if you have unrelated task
- tests should use real user interactions where possible, if they don't work it can indicate bugs and needs to be fixed, not replaced with some test only api
- flaky tests can be bugs in existing code, make sure that test is really flaky and not uncovering some bug. Tests should never be run in parallel
- always run full e2e-remote.sh if you think you are done with the task

Architecture:
1) compositor owns windows, screens and other state. It shares it using SharedMemory with CEF
2) CEF hosts shell, passes state to it and implements required APIs
3) shell draws decorations and windows according to state

Restrictions:
1) there should be no "cache", copy or editing of state in shell, only commands to change it in compositor
2) all window interactions, tiling, tabs, window opening is done in compositor
3) tests shouldn't have any delays, timeouts, retries