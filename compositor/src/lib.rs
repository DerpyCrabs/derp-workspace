#![allow(irrefutable_let_patterns)]
#![cfg(unix)]

pub mod cef;
pub mod chrome_bridge;
pub mod layout;
pub mod window_registry;

mod backdrop_render;
mod calloop_xwm;
mod cursor_fallback;
pub mod derp_space;
mod derp_space_render;
mod desktop_background;
mod desktop_stack;
mod display_config;
pub mod drm;
mod exclusion_clip;
mod grabs;
mod handlers;
mod input;
mod pointer_render;
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
