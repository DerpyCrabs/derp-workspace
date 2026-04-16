use tracing::info;

static SOLID_SHELL_FIRST_DMABUF_LOG: std::sync::Once = std::sync::Once::new();

pub(crate) fn log_first_shell_dmabuf(
    width: u32,
    height: u32,
    drm_format: u32,
    modifier: u64,
    plane_count: usize,
) {
    SOLID_SHELL_FIRST_DMABUF_LOG.call_once(|| {
        info!(
            target: "derp_shell_osr",
            width,
            height,
            drm_format,
            modifier,
            plane_count,
            "solid shell OSR: dma-buf path active (first frame accepted)"
        );
    });
}
