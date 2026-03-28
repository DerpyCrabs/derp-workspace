//! GPU / full-stack tests gated behind `--features gpu-tests`.
//! Intended for manual runs: `cargo test -p compositor --features gpu-tests -- --ignored`

#[cfg(all(test, feature = "gpu-tests"))]
mod tests {
    #[test]
    #[ignore = "Requires active display and DRM/EGL; placeholder for future automation"]
    fn winit_compositor_smoke() {}
}
