/** Keep in sync with compositor `SHELL_TITLEBAR_HEIGHT` / `SHELL_BORDER_THICKNESS`. */
export const CHROME_TITLEBAR_PX = 28
export const CHROME_BORDER_PX = 4
/** Reserved width for the three titlebar controls (minimize, maximize, close); compositor does not mirror this. */
export const CHROME_TITLEBAR_CONTROLS_PX = 120

/** Match [`shell_wire::RESIZE_EDGE_*`] / Wayland `resize_edge` (bitmask). */
export const SHELL_RESIZE_TOP = 1
export const SHELL_RESIZE_BOTTOM = 2
export const SHELL_RESIZE_LEFT = 4
export const SHELL_RESIZE_RIGHT = 8

/** Hit slop for resize handles (CSS px). */
export const CHROME_RESIZE_HANDLE_PX = 10

/** Bottom reserve for taskbar (matches Taskbar h-11 and primary chrome fill bottom padding). */
export const CHROME_TASKBAR_RESERVE_PX = 44

/** `layout_state` tail on [`MSG_SHELL_SET_GEOMETRY`]: normal floating geometry. */
export const SHELL_LAYOUT_FLOATING = 0
/** `layout_state`: tiled maximize (xdg maximized + shell-chosen bounds). */
export const SHELL_LAYOUT_MAXIMIZED = 1
