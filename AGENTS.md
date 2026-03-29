Project implements wayland compositor with the js shell running in CEF OSR. JS shell controls everything it can.
Shell is written in solid js, mind the reactivity and performance.
All testing is on the remote machine, instead of asking user to do something add logs, update remote and fetch logs to debug.

Rules:
- don't add comments
- google solutions before trying hacks
- user can't change environment so you need to change scripts
- after changes do ./scripts/remote-update-and-restart.sh
- if you need logs use ./scripts/fetch-logs.sh
