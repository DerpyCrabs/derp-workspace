#![allow(irrefutable_let_patterns)]

pub mod chrome_bridge;
pub mod headless;
pub mod layout;
pub mod window_registry;

#[cfg(test)]
mod renderer_smoke;

#[cfg(all(test, feature = "gpu-tests"))]
mod gpu_tests;

mod cursor_fallback;
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
mod shell_shm;
pub mod sidecar;
pub mod state;

pub use state::{ClientState, CompositorInitOptions, CompositorState, SocketConfig};

use smithay::reexports::wayland_server::DisplayHandle;

#[cfg(feature = "winit-backend")]
pub mod winit;

pub struct CalloopData {
    pub state: CompositorState,
    pub display_handle: DisplayHandle,
    /// Populated when the binary is run with `--command` (e.g. `cef_host`). Killed when the
    /// nested compositor window closes or the event loop exits.
    pub command_child: Option<std::process::Child>,
    /// Set when using `--backend drm` (KMS session).
    pub drm: Option<crate::drm::DrmSession>,
}
