//! Full-screen Solid / CEF **dma-buf** OSR plane for DRM and winit [`OutputDamageTracker::render_output`] paths.

use smithay::{
    backend::allocator::Buffer,
    backend::renderer::{
        gles::{GlesError, GlesRenderer},
        ImportDma,
    },
    output::Output,
    utils::{Buffer as BufferCoord, Physical, Point, Rectangle, Size},
};

use crate::desktop_stack::ShellDmaElement;
use crate::CompositorState;

/// Log a bounded sample of what EGL can import (for correlating with `in_*_formats=false`).
const SHELL_DMABUF_EGL_SAMPLE_LEN: usize = 32;

fn sample_egl_dmabuf_pairs(renderer: &GlesRenderer) -> (Vec<(u32, u64)>, Vec<(u32, u64)>) {
    let rf = renderer.egl_context().dmabuf_render_formats();
    let tf = renderer.dmabuf_formats();
    let render_sample: Vec<(u32, u64)> = rf
        .iter()
        .take(SHELL_DMABUF_EGL_SAMPLE_LEN)
        .map(|f| (f.code as u32, u64::from(f.modifier)))
        .collect();
    let texture_sample: Vec<(u32, u64)> = tf
        .iter()
        .take(SHELL_DMABUF_EGL_SAMPLE_LEN)
        .map(|f| (f.code as u32, u64::from(f.modifier)))
        .collect();
    (render_sample, texture_sample)
}

fn log_shell_dmabuf_import_context(dmabuf: &smithay::backend::allocator::dmabuf::Dmabuf, renderer: &GlesRenderer) {
    let fmt = dmabuf.format();
    let sz = dmabuf.size();
    let in_render = renderer.egl_context().dmabuf_render_formats().contains(&fmt);
    let in_texture = renderer.dmabuf_formats().contains(&fmt);
    let strides: Vec<u32> = dmabuf.strides().collect();
    let offsets: Vec<u32> = dmabuf.offsets().collect();
    tracing::debug!(
        target: "derp_shell_dmabuf",
        w = sz.w,
        h = sz.h,
        fourcc = ?fmt.code,
        drm_fourcc_hex = fmt.code as u32,
        modifier = ?fmt.modifier,
        modifier_u64 = u64::from(fmt.modifier),
        planes = dmabuf.num_planes(),
        strides = ?strides,
        offsets = ?offsets,
        y_inverted = dmabuf.y_inverted(),
        has_modifier = dmabuf.has_modifier(),
        in_egl_render_formats = in_render,
        in_egl_texture_import_formats = in_texture,
        "shell dma-buf → GLES import (see RUST_LOG=derp_shell_dmabuf=debug,trace)"
    );
}

/// Build a letterboxed dma-buf shell layer (below toplevels, above background). Returns `None` when no frame.
pub fn compositor_shell_dmabuf_element(
    state: &CompositorState,
    renderer: &mut GlesRenderer,
    output: &Output,
) -> Result<Option<ShellDmaElement>, GlesError> {
    if !state.shell_has_frame || !state.shell_frame_is_dmabuf {
        return Ok(None);
    }
    let Some(ref dmabuf) = state.shell_dmabuf else {
        return Ok(None);
    };
    let Some(output_geo) = state.space.output_geometry(output) else {
        return Ok(None);
    };
    let (buf_w, buf_h) = match state.shell_view_px {
        Some(p) => p,
        None => return Ok(None),
    };
    let (cox, coy) = state.shell_canvas_logical_origin;
    let (clw_u, clh_u) = state.shell_canvas_logical_size;
    let clwf = clw_u.max(1) as f64;
    let clhf = clh_u.max(1) as f64;
    let bw = buf_w.max(1) as f64;
    let bh = buf_h.max(1) as f64;
    let rel_x = (output_geo.loc.x - cox) as f64;
    let rel_y = (output_geo.loc.y - coy) as f64;
    let scale_x = bw / clwf;
    let scale_y = bh / clhf;
    let ow = output_geo.size.w.max(1) as f64;
    let oh = output_geo.size.h.max(1) as f64;
    let mut bx0 = rel_x * scale_x;
    let mut by0 = rel_y * scale_y;
    let mut bww = ow * scale_x;
    let mut bhh = oh * scale_y;
    bx0 = bx0.clamp(0.0, bw);
    by0 = by0.clamp(0.0, bh);
    bww = bww.clamp(0.0, (bw - bx0).max(0.0));
    bhh = bhh.clamp(0.0, (bh - by0).max(0.0));
    let buffer_src = Rectangle::new(
        Point::<f64, BufferCoord>::from((bx0, by0)),
        Size::<f64, BufferCoord>::from((bww, bhh)),
    );

    let shell_loc_phys = Point::<f64, Physical>::from((0.0_f64, 0.0_f64));
    let shell_size_logical = output_geo.size;

    log_shell_dmabuf_import_context(dmabuf, renderer);

    match crate::desktop_stack::shell_dmabuf_overlay_element(
        renderer,
        dmabuf,
        state.shell_dmabuf_overlay_id.clone(),
        shell_loc_phys,
        shell_size_logical,
        buffer_src,
    ) {
        Ok(el) => Ok(Some(el)),
        Err(e) => {
            let fmt = dmabuf.format();
            let sz = dmabuf.size();
            let in_render = renderer.egl_context().dmabuf_render_formats().contains(&fmt);
            let in_texture = renderer.dmabuf_formats().contains(&fmt);
            let render_n = renderer.egl_context().dmabuf_render_formats().iter().count();
            let texture_n = renderer.dmabuf_formats().iter().count();
            let (sample_render, sample_texture) = sample_egl_dmabuf_pairs(renderer);
            tracing::warn!(
                target: "derp_shell_dmabuf",
                ?e,
                w = sz.w,
                h = sz.h,
                fourcc = ?fmt.code,
                drm_fourcc_hex = fmt.code as u32,
                modifier = ?fmt.modifier,
                modifier_u64 = u64::from(fmt.modifier),
                planes = dmabuf.num_planes(),
                strides = ?dmabuf.strides().collect::<Vec<_>>(),
                offsets = ?dmabuf.offsets().collect::<Vec<_>>(),
                in_egl_render_formats = in_render,
                in_egl_texture_import_formats = in_texture,
                egl_render_format_count = render_n,
                egl_texture_import_format_count = texture_n,
                sample_egl_render_formats = ?sample_render,
                sample_egl_texture_import_formats = ?sample_texture,
                "shell dma-buf EGL import failed (CEF_HOST_DMABUF_TRACE / CEF_HOST_CHROMIUM_VERBOSE on cef_host; if compositor is unprivileged DRM master, EGL tables are often sparse — check derp_drm + Smithay WARN)"
            );
            tracing::trace!(
                target: "derp_shell_dmabuf",
                render_format_count = render_n,
                texture_format_count = texture_n,
                "EGL dma-buf format table sizes"
            );
            Err(e)
        }
    }
}
