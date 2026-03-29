//! Small, CEF-free helpers shared with the `cef_host` binary (unit-testable without loading Chromium).
//!
//! [`osr_view_state`] holds DIP vs OSR buffer sizes and the buffer→view mapping used with compositor pointer IPC.

#[cfg(unix)]
pub mod frame_sink;
pub mod ipc_coalesce;
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

/// Whether an embedder might choose **Ozone headless** for OSR.
///
/// The **`cef_host`** binary on **Linux** does **not** use this: it always appends
/// **`--ozone-platform=wayland`** (see `main.rs`). This helper remains for tests and custom integrations.
///
/// On **Linux**, the default is **headless** whenever **`CEF_HOST_OZONE_HEADLESS`** is unset.
/// **`CEF_HOST_USE_WAYLAND_PLATFORM=1`** forces non-headless. Non-Linux: headless only if
/// **`WAYLAND_DISPLAY`** is unset.
pub fn ozone_platform_headless_for_osr() -> bool {
    if std::env::var("CEF_HOST_USE_WAYLAND_PLATFORM").as_deref() == Ok("1") {
        return false;
    }
    if std::env::var("CEF_HOST_OZONE_HEADLESS").as_deref() == Ok("1") {
        return true;
    }
    if std::env::var("CEF_HOST_OZONE_HEADLESS").as_deref() == Ok("0") {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        true
    }
    #[cfg(not(target_os = "linux"))]
    {
        std::env::var_os("WAYLAND_DISPLAY").is_none()
    }
}

/// ANGLE backend for `use-angle`. Linux OSR shared textures need **gl-egl** per CEF #3953 (`vulkan` prevents the dma-buf path).
pub fn angle_backend_for_osr() -> String {
    std::env::var("CEF_HOST_ANGLE_BACKEND").unwrap_or_else(|_| "gl-egl".into())
}

/// Ozone platform when not using headless OSR (Linux).
///
/// Prefer **`wayland`** whenever **`WAYLAND_DISPLAY`** is set (typical Wayland session, often with
/// **`DISPLAY`** from XWayland). Chromium’s **x11** Ozone + dma-buf path expects a native GBM stack;
/// on XWayland-only **`DISPLAY`** that yields *“gbm device is missing”* and no OSR frames.
///
/// Use **`x11`** only for a classic X session (**`DISPLAY`** set, no **`WAYLAND_DISPLAY`**). CEF #3953
/// dma-buf OSR still wants **`gl-egl`** (not **`vulkan`**). Override with **`CEF_HOST_OZONE_PLATFORM`**.
#[cfg(target_os = "linux")]
pub fn ozone_platform_for_osr() -> String {
    if let Ok(v) = std::env::var("CEF_HOST_OZONE_PLATFORM") {
        return v;
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        "wayland".into()
    } else if std::env::var_os("DISPLAY").is_some() {
        "x11".into()
    } else {
        "x11".into()
    }
}

#[cfg(not(target_os = "linux"))]
pub fn ozone_platform_for_osr() -> String {
    std::env::var("CEF_HOST_OZONE_PLATFORM").unwrap_or_else(|_| "headless".into())
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
    fn ozone_headless_when_no_wayland_display() {
        let _g = env_lock();
        std::env::remove_var("CEF_HOST_USE_WAYLAND_PLATFORM");
        std::env::remove_var("CEF_HOST_OZONE_HEADLESS");
        std::env::remove_var("WAYLAND_DISPLAY");
        assert!(ozone_platform_headless_for_osr());
    }

    #[test]
    fn ozone_headless_default_linux_even_when_wayland_display_set() {
        let _g = env_lock();
        std::env::remove_var("CEF_HOST_USE_WAYLAND_PLATFORM");
        std::env::remove_var("CEF_HOST_OZONE_HEADLESS");
        std::env::set_var("WAYLAND_DISPLAY", "wayland-test");
        #[cfg(target_os = "linux")]
        assert!(ozone_platform_headless_for_osr());
        #[cfg(not(target_os = "linux"))]
        assert!(!ozone_platform_headless_for_osr());
        std::env::remove_var("WAYLAND_DISPLAY");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn ozone_headless_explicit_off_still_allows_platform_ozone() {
        let _g = env_lock();
        std::env::remove_var("CEF_HOST_USE_WAYLAND_PLATFORM");
        std::env::set_var("CEF_HOST_OZONE_HEADLESS", "0");
        std::env::set_var("WAYLAND_DISPLAY", "wayland-test");
        assert!(!ozone_platform_headless_for_osr());
        std::env::remove_var("CEF_HOST_OZONE_HEADLESS");
        std::env::remove_var("WAYLAND_DISPLAY");
    }

    #[test]
    fn ozone_nested_forces_headless_even_with_wayland() {
        let _g = env_lock();
        std::env::remove_var("CEF_HOST_USE_WAYLAND_PLATFORM");
        std::env::set_var("CEF_HOST_OZONE_HEADLESS", "1");
        std::env::set_var("WAYLAND_DISPLAY", "wayland-parent");
        assert!(ozone_platform_headless_for_osr());
        std::env::remove_var("CEF_HOST_OZONE_HEADLESS");
        std::env::remove_var("WAYLAND_DISPLAY");
    }

    #[test]
    fn ozone_use_wayland_platform_skips_headless() {
        let _g = env_lock();
        std::env::set_var("CEF_HOST_USE_WAYLAND_PLATFORM", "1");
        std::env::set_var("CEF_HOST_OZONE_HEADLESS", "1");
        std::env::set_var("WAYLAND_DISPLAY", "wayland-parent");
        assert!(!ozone_platform_headless_for_osr());
        std::env::remove_var("CEF_HOST_USE_WAYLAND_PLATFORM");
        std::env::remove_var("CEF_HOST_OZONE_HEADLESS");
        std::env::remove_var("WAYLAND_DISPLAY");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn ozone_platform_for_osr_wayland_when_xwayland_also_sets_display() {
        let _g = env_lock();
        std::env::remove_var("CEF_HOST_OZONE_PLATFORM");
        std::env::set_var("DISPLAY", ":0");
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");
        assert_eq!(super::ozone_platform_for_osr(), "wayland");
        std::env::remove_var("DISPLAY");
        std::env::remove_var("WAYLAND_DISPLAY");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn ozone_platform_for_osr_x11_when_display_only() {
        let _g = env_lock();
        std::env::remove_var("CEF_HOST_OZONE_PLATFORM");
        std::env::set_var("DISPLAY", ":0");
        std::env::remove_var("WAYLAND_DISPLAY");
        assert_eq!(super::ozone_platform_for_osr(), "x11");
        std::env::remove_var("DISPLAY");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn ozone_platform_for_osr_wayland_when_only_wayland() {
        let _g = env_lock();
        std::env::remove_var("CEF_HOST_OZONE_PLATFORM");
        std::env::remove_var("DISPLAY");
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");
        assert_eq!(super::ozone_platform_for_osr(), "wayland");
        std::env::remove_var("WAYLAND_DISPLAY");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn ozone_platform_for_osr_env_overrides() {
        let _g = env_lock();
        std::env::set_var("CEF_HOST_OZONE_PLATFORM", "headless");
        std::env::set_var("DISPLAY", ":0");
        assert_eq!(super::ozone_platform_for_osr(), "headless");
        std::env::remove_var("CEF_HOST_OZONE_PLATFORM");
        std::env::remove_var("DISPLAY");
    }
}
