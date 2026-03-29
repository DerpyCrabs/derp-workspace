
#[cfg(unix)]
pub mod frame_sink;
pub mod ipc_coalesce;
pub mod osr_view_state;

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
            return root.join(format!("cef-host-{pid}"));
        }
    }
    let cache_root = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")));
    if let Some(base) = cache_root {
        if base.is_absolute() {
            return base.join("derp").join(format!("cef-host-{pid}"));
        }
    }
    std::env::temp_dir().join(format!("cef-host-{pid}"))
}

pub fn angle_backend_for_osr() -> &'static str {
    "gl-egl"
}
