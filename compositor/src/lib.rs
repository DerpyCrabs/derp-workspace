#![allow(irrefutable_let_patterns)]

pub mod chrome_bridge;
pub mod headless;
pub mod layout;
pub mod window_registry;

#[cfg(test)]
mod renderer_smoke;

#[cfg(all(test, feature = "gpu-tests"))]
mod gpu_tests;

mod grabs;
mod handlers;
mod input;
pub mod state;

pub use state::{ClientState, CompositorInitOptions, CompositorState, SocketConfig};

use smithay::reexports::wayland_server::DisplayHandle;

#[cfg(feature = "winit-backend")]
pub mod winit;

pub struct CalloopData {
    pub state: CompositorState,
    pub display_handle: DisplayHandle,
}
