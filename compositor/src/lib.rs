#![allow(irrefutable_let_patterns)]

#![cfg(unix)]

pub mod chrome_bridge;
pub mod cef;
pub mod layout;
pub mod window_registry;

mod calloop_xwm;
mod cursor_fallback;
mod display_config;
pub mod derp_space;
mod derp_space_render;
mod exclusion_clip;
mod desktop_stack;
pub mod drm;
mod pointer_render;
mod grabs;
mod handlers;
mod input;
mod shell_encode;
mod shell_ipc;
mod shell_letterbox;
mod shell_overlay;
mod shell_render;
mod tile_preview_render;
pub mod sidecar;
pub mod state;
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
