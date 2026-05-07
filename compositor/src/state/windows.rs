use super::*;

pub const DEFAULT_XDG_TOPLEVEL_OFFSET_X: i32 = 200;
pub const DEFAULT_XDG_TOPLEVEL_OFFSET_Y: i32 = 200;
pub const DEFAULT_XDG_TOPLEVEL_WIDTH: i32 = 800;
pub const DEFAULT_XDG_TOPLEVEL_HEIGHT: i32 = 600;
pub const DEFAULT_XDG_TOPLEVEL_STAGGER_X: i32 = 32;
pub const DEFAULT_XDG_TOPLEVEL_STAGGER_Y: i32 = 24;
pub const DEFAULT_XDG_TOPLEVEL_STAGGER_STEPS: i32 = 6;
pub const GNOME_AUTO_MAXIMIZE_THRESHOLD_PERCENT: i32 = 90;
/// Border thickness around client for chrome hit-testing; keep in sync with `shell` `CHROME_BORDER_PX`.
pub const SHELL_BORDER_THICKNESS: i32 = 4;
/// Top border inset above client (shell tabs flush to frame top when 0); keep in sync with `CHROME_BORDER_TOP_PX`.
pub const SHELL_BORDER_TOP_THICKNESS: i32 = 0;
pub const SHELL_DRAG_WINDOW_ALPHA: f32 = 0.76;
/// Wayland `app_id` for the embedded Solid CEF toplevel — must not appear in the shell HUD list.
pub const DERP_SOLID_SHELL_APP_ID: &str = "com.derp.solid-shell";
/// Window title set by `cef_host` (`WindowInfo::window_name`); used with [`DERP_SOLID_SHELL_APP_ID`].
pub const DERP_SOLID_SHELL_TITLE: &str = "derp-shell";

/// Solid’s own Chromium toplevel is composed below the HUD; shell IPC must not treat it like a managed app window.
#[inline]
pub(crate) fn window_is_solid_shell_host(title: &str, app_id: &str) -> bool {
    title == DERP_SOLID_SHELL_TITLE || app_id == DERP_SOLID_SHELL_APP_ID
}

/// Current maximize/fullscreen flags from the compositor’s xdg pending/current state.
pub(crate) fn transform_from_wire(t: u32) -> Transform {
    match t {
        1 => Transform::_90,
        2 => Transform::_180,
        3 => Transform::_270,
        4 => Transform::Flipped,
        5 => Transform::Flipped90,
        6 => Transform::Flipped180,
        7 => Transform::Flipped270,
        _ => Transform::Normal,
    }
}

pub(crate) fn transform_to_wire(t: Transform) -> u32 {
    match t {
        Transform::Normal => 0,
        Transform::_90 => 1,
        Transform::_180 => 2,
        Transform::_270 => 3,
        Transform::Flipped => 4,
        Transform::Flipped90 => 5,
        Transform::Flipped180 => 6,
        Transform::Flipped270 => 7,
    }
}

