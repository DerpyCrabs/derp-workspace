pub(crate) mod begin_frame_diag;
mod bridge;
mod compositor_downlink;
pub mod compositor_tx;
mod control_server;
mod desktop_apps;
mod e2e_bridge;
mod file_browser_fixtures;
mod frame_sink;
mod gnome_background;
mod gnome_wallpaper_list;
mod osr_view_state;
mod runner;
mod shell_uplink;
mod uplink;

pub use bridge::ShellToCefLink;
pub use frame_sink::DirectDmabufSink;
pub use osr_view_state::{OsrViewState, OSR_BOOTSTRAP_LOGICAL_HEIGHT, OSR_BOOTSTRAP_LOGICAL_WIDTH};
pub use runner::{maybe_run_cef_subprocess_only, spawn_cef_ui_thread};
pub use shell_uplink::DerpRenderProcessHandler;

use std::path::PathBuf;

pub fn runtime_dir() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

pub fn cef_user_data_dir() -> PathBuf {
    let pid = std::process::id();
    if let Ok(root) = std::env::var("DERP_CEF_USER_DATA") {
        let root = PathBuf::from(root);
        if root.is_absolute() && !root.as_os_str().is_empty() {
            return root.join(format!("cef-embedded-{pid}"));
        }
    }
    let cache_root = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")));
    if let Some(base) = cache_root {
        if base.is_absolute() {
            return base.join("derp").join(format!("cef-embedded-{pid}"));
        }
    }
    std::env::temp_dir().join(format!("cef-embedded-{pid}"))
}

pub fn angle_backend_for_osr() -> &'static str {
    "gl-egl"
}
