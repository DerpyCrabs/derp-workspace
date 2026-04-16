#![allow(irrefutable_let_patterns)]
#![cfg(unix)]

mod api;
pub use api::chrome_bridge;
pub use api::derp_space;
pub use api::layout;
pub use api::sidecar;
pub use api::window_registry;

pub mod cef;
mod controls;
mod desktop;
mod e2e;
mod grabs;
mod handlers;
mod input;
mod platform;
mod render;
mod session;
mod shell;
mod tray;
pub mod state;

pub use derp_space::DerpSpaceElem;
pub use state::{ClientState, CompositorInitOptions, CompositorState, SocketConfig};
pub use platform::drm;
pub use platform::xwayland;

use smithay::reexports::wayland_server::DisplayHandle;

pub struct CalloopData {
    pub state: CompositorState,
    pub display_handle: DisplayHandle,
    pub command_child: Option<std::process::Child>,
    pub pending_sidecar_cmd: Option<String>,
    pub drm: Option<crate::drm::DrmSession>,
}
