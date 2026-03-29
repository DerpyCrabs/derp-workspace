//! Shell / CEF OSR: pixel format invariants for GLES import.
//!
//! The live path is **dma-buf** from CEF (`MSG_FRAME_DMABUF_COMMIT`). **`SHELL_OSR_MEMORY_FOURCC`**
//! (`Argb8888` / AR24) is shared with cursor / memory-buffer import paths; `Bgra8888` (BA24) is not
//! reliably importable on GLES/llvmpipe.

use smithay::backend::allocator::Fourcc;

/// Memory buffer DRM fourcc for cursor/shell-adjacent GLES import (ARGB byte order).
pub const SHELL_OSR_MEMORY_FOURCC: Fourcc = Fourcc::Argb8888;

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
    }
}
