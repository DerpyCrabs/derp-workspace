/** Keep in sync with compositor `SHELL_TITLEBAR_HEIGHT` / `SHELL_BORDER_THICKNESS`. */
export const CHROME_TITLEBAR_PX = 28
export const CHROME_BORDER_PX = 4
/** Keep in sync with compositor `SHELL_TITLEBAR_CONTROLS_INSET` (minimize + close). */
export const CHROME_TITLEBAR_CONTROLS_PX = 80

/** Match [`shell_wire::RESIZE_EDGE_*`] / Wayland `resize_edge` (bitmask). */
export const SHELL_RESIZE_TOP = 1
export const SHELL_RESIZE_BOTTOM = 2
export const SHELL_RESIZE_LEFT = 4
export const SHELL_RESIZE_RIGHT = 8

/** Hit slop for resize handles (CSS px). */
export const CHROME_RESIZE_HANDLE_PX = 10
