Project implements wayland compositor with the js shell running in CEF OSR. JS shell controls everything it can.
Shell is written in solid js, mind the reactivity and performance.
All testing is on the remote machine, instead of asking user to do something add logs, update remote and fetch logs to debug.

Rules:
- don't add comments
- google solutions before trying hacks
- user can't change environment so you need to change scripts
- for shell styling use inline tailwind classes only, don't extract style constants or reintroduce custom shell css classes
- keep tailwind/style lint clean when editing shell ui files
- after changes do ./scripts/remote-update-and-restart.sh
- use ./scripts/remote-verify.sh to tar-sync sources to the remote machine and run verification there
- if you need logs use ./scripts/fetch-logs.sh
- debug everything yourself on remote machine (but if you add logs use warn and delete after debugging)
