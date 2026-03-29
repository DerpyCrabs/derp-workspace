
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
    let base = runtime_dir();
    if !base.is_absolute() {
        return std::env::temp_dir().join(format!("cef-host-{pid}"));
    }
    base.join(format!("cef-host-{pid}"))
}

pub fn angle_backend_for_osr() -> &'static str {
    "gl-egl"
}
