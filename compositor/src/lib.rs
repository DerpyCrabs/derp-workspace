#![allow(irrefutable_let_patterns)]
#![cfg(unix)]

pub mod cef;
pub mod chrome_bridge;
pub mod layout;
pub mod window_registry;

mod audio_control;
mod backdrop_render;
mod bluetooth_control;
mod calloop_xwm;
mod capture;
mod capture_ext;
mod cursor_fallback;
pub mod derp_space;
mod derp_space_render;
mod desktop_app_usage;
mod desktop_background;
mod desktop_stack;
mod e2e;
mod display_config;
pub mod drm;
mod exclusion_clip;
mod gdm_settings;
mod grabs;
mod handlers;
mod input;
mod json_state;
mod pointer_render;
mod screenshot;
mod screenshot_overlay_render;
mod settings_config;
mod shell_backed;
mod shell_encode;
mod shell_ipc;
mod shell_letterbox;
mod shell_overlay;
mod shell_render;
pub mod sidecar;
pub mod state;
mod tile_preview_render;
mod volume;
mod wayland_listener;
mod wifi_control;
pub mod xwayland;

pub use derp_space::DerpSpaceElem;
pub use state::{ClientState, CompositorInitOptions, CompositorState, SocketConfig};

use smithay::reexports::wayland_server::DisplayHandle;

pub struct CalloopData {
    pub state: CompositorState,
    pub display_handle: DisplayHandle,
    pub command_child: Option<std::process::Child>,
    pub pending_sidecar_cmd: Option<String>,
    pub drm: Option<crate::drm::DrmSession>,
}
