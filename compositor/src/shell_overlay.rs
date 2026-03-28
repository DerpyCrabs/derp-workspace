//! Shell / CEF OSR overlay: pixel format invariants for GLES import.
//!
//! CEF delivers BGRA samples; we store them in a [`smithay`] memory buffer. The buffer **DRM
//! fourcc** must be `Argb8888` (AR24): `Bgra8888` (BA24) is not imported by the GLES path on
//! llvmpipe, which produced `UnsupportedPixelFormat(BA24)` and a blank overlay.

use smithay::backend::allocator::Fourcc;
use smithay::backend::renderer::element::memory::MemoryRenderBuffer;
use smithay::utils::Transform;

/// [`MemoryRenderBuffer`] format for shell frames (`apply_shell_frame_bgra` copies BGRA bytes).
pub const SHELL_OSR_MEMORY_FOURCC: Fourcc = Fourcc::Argb8888;

pub(crate) fn new_shell_memory_buffer() -> MemoryRenderBuffer {
    MemoryRenderBuffer::new(SHELL_OSR_MEMORY_FOURCC, (4, 4), 1, Transform::Normal, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use smithay::backend::renderer::element::memory::MemoryBuffer;

    #[test]
    fn shell_osr_fourcc_is_argb8888_not_bgra8888() {
        assert_eq!(
            SHELL_OSR_MEMORY_FOURCC,
            Fourcc::Argb8888,
            "Bgra8888 (BA24) is not reliably importable for the shell overlay on GLES/llvmpipe"
        );
        assert_ne!(SHELL_OSR_MEMORY_FOURCC, Fourcc::Bgra8888);
        assert_eq!(
            MemoryBuffer::new(SHELL_OSR_MEMORY_FOURCC, (1, 1)).format(),
            Fourcc::Argb8888
        );
        let _ = new_shell_memory_buffer();
    }
}
