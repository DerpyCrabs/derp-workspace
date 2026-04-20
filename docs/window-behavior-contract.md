# Window behavior contract

Native and shell-hosted windows share one behavior surface:

- focus
- close
- minimize and restore
- maximize and restore
- fullscreen
- move
- resize
- taskbar activation
- output move

Compositor code should call `window_op_*` methods instead of branching on window kind at call sites. Native windows adapt through Wayland/X11 configure and close paths. Shell-hosted windows adapt through the hosted window registry and shell geometry messages.

New e2e behavior tests should use `shell/e2e/specs/window-parity.spec.ts` as template: create one native and one shell-hosted window, then run the same user-driven contract body for both.
