# Shell overlay contract

Use `useShellFloating().openOverlay(...)` for new context menus, dropdowns, tooltips, and floating selects.

Inputs:

- `id`: stable overlay id.
- `kind`: `context_menu`, `dropdown`, `tooltip`, or `select`.
- `ownerWindowId`: window that opened the overlay when known.
- `parentId`: parent overlay for submenus or nested selects.
- `anchor`: global point or rect.
- `placement`: `point`, `below-start`, `below-end`, `above-start`, or `above-end`.
- `size`: expected logical size when known.

Rules:

- Shell renders overlay content.
- Floating registry owns outside-click and escape close.
- Shared shell exclusion state tells compositor the input rects.
- Behavior tests open overlays with real pointer or keyboard input, then assert shell/compositor snapshots.

Kobalte is compatible with Solid and current dependency versions, but do not bypass compositor overlay registration. If Kobalte is used for menu/dropdown focus behavior, wrap its content with the shell overlay API so native-window hit testing still works.
