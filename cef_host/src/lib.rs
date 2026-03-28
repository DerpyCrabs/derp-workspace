//! Small, CEF-free helpers shared with the `cef_host` binary (unit-testable without loading Chromium).
//!
//! [`osr_view_state`] holds DIP vs OSR buffer sizes and the buffer→view mapping used with compositor pointer IPC.

pub mod osr_view_state;

use std::path::PathBuf;

/// Session runtime directory for Wayland sockets and (by default) per-process CEF profile roots.
pub fn runtime_dir() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

/// Per-process Chromium user-data/cache under [`runtime_dir()`], unless `CEF_HOST_CACHE_DIR` is set.
///
/// A shared directory (e.g. fixed `~/.cache/cef_host`) triggers Chromium singleton-lock failures
/// when another `cef_host` is running or a stale lock remains after `SIGKILL`.
pub fn cef_user_data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("CEF_HOST_CACHE_DIR") {
        return PathBuf::from(p);
    }
    let pid = std::process::id();
    let base = runtime_dir();
    if !base.is_absolute() {
        return std::env::temp_dir().join(format!("cef-host-{pid}"));
    }
    base.join(format!("cef-host-{pid}"))
}

/// Headless Ozone for OSR unless `CEF_HOST_USE_WAYLAND_PLATFORM=1`.
pub fn ozone_platform_headless_for_osr() -> bool {
    std::env::var("CEF_HOST_USE_WAYLAND_PLATFORM").as_deref() != Ok("1")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    static ENV_GUARD: OnceLock<Mutex<()>> = OnceLock::new();

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_GUARD.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    #[test]
    fn cef_user_data_dir_respects_explicit_cache_env() {
        let _g = env_lock();
        let tmp = tempfile::tempdir().unwrap();
        let want = tmp.path().join("profile");
        std::env::set_var("CEF_HOST_CACHE_DIR", &want);
        assert_eq!(cef_user_data_dir(), want);
        std::env::remove_var("CEF_HOST_CACHE_DIR");
    }

    #[test]
    fn cef_user_data_dir_default_uses_runtime_and_pid() {
        let _g = env_lock();
        std::env::remove_var("CEF_HOST_CACHE_DIR");
        let rt = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_RUNTIME_DIR", rt.path());
        let pid = std::process::id();
        let path = cef_user_data_dir();
        assert_eq!(
            path,
            rt.path().join(format!("cef-host-{pid}")),
            "expected isolated dir per pid so Chromium singleton locks do not collide"
        );
    }

    #[test]
    fn cef_user_data_dir_falls_back_to_temp_when_runtime_relative() {
        let _g = env_lock();
        std::env::remove_var("CEF_HOST_CACHE_DIR");
        std::env::set_var("XDG_RUNTIME_DIR", "relative-not-exists");
        let pid = std::process::id();
        let path = cef_user_data_dir();
        assert!(
            path.ends_with(format!("cef-host-{pid}")),
            "unexpected path {path:?}"
        );
        assert!(
            path.starts_with(std::env::temp_dir()),
            "expected temp fallback for non-absolute XDG_RUNTIME_DIR, got {path:?}"
        );
    }

    #[test]
    fn ozone_defaults_to_headless_platform() {
        let _g = env_lock();
        std::env::remove_var("CEF_HOST_USE_WAYLAND_PLATFORM");
        assert!(ozone_platform_headless_for_osr());
        std::env::set_var("CEF_HOST_USE_WAYLAND_PLATFORM", "1");
        assert!(!ozone_platform_headless_for_osr());
        std::env::remove_var("CEF_HOST_USE_WAYLAND_PLATFORM");
    }
}
