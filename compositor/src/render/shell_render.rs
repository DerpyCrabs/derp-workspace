//! Full-screen Solid / CEF **dma-buf** OSR plane for DRM and winit [`OutputDamageTracker::render_output`] paths.

use std::sync::{Mutex, OnceLock};

use smithay::{
    backend::allocator::{Buffer, Fourcc},
    backend::renderer::{
        gles::{GlesError, GlesRenderer},
        utils::CommitCounter,
        Bind, Frame, ImportDma, Offscreen, Renderer,
    },
    output::Output,
    utils::{Buffer as BufferCoord, Logical, Physical, Point, Rectangle, Scale, Size, Transform},
};

use crate::desktop::desktop_stack::ShellDmaElement;
use crate::{state::SHELL_DRAG_WINDOW_ALPHA, CompositorState};

const SHELL_DMABUF_EGL_SAMPLE_LEN: usize = 32;

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ShellMainCacheKey {
    pub output_geo: Rectangle<i32, Logical>,
    pub output_scale_bits: u64,
    pub canvas_origin: (i32, i32),
    pub canvas_size: (u32, u32),
    pub view_px: (u32, u32),
}

pub(crate) struct CachedShellElement<K> {
    pub key: K,
    pub commit: CommitCounter,
    pub element: Option<ShellDmaElement>,
}

#[derive(Default)]
pub(crate) struct ShellOutputRenderElements {
    pub dmabuf: Option<ShellDmaElement>,
    pub move_proxy: Vec<ShellDmaElement>,
    pub force_full_damage: bool,
}

#[derive(Clone)]
pub(crate) struct ShellMoveProxyLayer {
    pub target_global_rect: Rectangle<i32, Logical>,
    pub buffer_origin: Point<i32, BufferCoord>,
    pub buffer_size: Size<i32, BufferCoord>,
}

#[derive(Default)]
struct CacheStats {
    hits: u64,
    misses: u64,
    forced_full_damage_misses: u64,
    last_logged_total: u64,
}

fn shell_cache_stats() -> &'static Mutex<CacheStats> {
    static STATS: OnceLock<Mutex<CacheStats>> = OnceLock::new();
    STATS.get_or_init(|| Mutex::new(CacheStats::default()))
}

fn note_shell_cache_result(hit: bool, force_full_damage: bool) {
    let Ok(mut stats) = shell_cache_stats().lock() else {
        return;
    };
    if hit {
        stats.hits += 1;
    } else {
        stats.misses += 1;
        if force_full_damage {
            stats.forced_full_damage_misses += 1;
        }
    }
    let total = stats.hits + stats.misses;
    if total.saturating_sub(stats.last_logged_total) < 256 {
        return;
    }
    stats.last_logged_total = total;
    let hit_rate = if total == 0 {
        0.0
    } else {
        stats.hits as f64 / total as f64
    };
    tracing::debug!(
        target: "derp_render_cache",
        cache = "shell",
        hits = stats.hits,
        misses = stats.misses,
        forced_full_damage_misses = stats.forced_full_damage_misses,
        hit_rate,
        "render cache stats"
    );
}

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

pub(crate) fn shell_dmabuf_buffer_src_for_output(
    state: &CompositorState,
    output: &Output,
    buf_w: u32,
    buf_h: u32,
) -> Option<Rectangle<f64, BufferCoord>> {
    let output_geo = state.space.output_geometry(output)?;
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
    Some(Rectangle::new(
        Point::<f64, BufferCoord>::from((bx0, by0)),
        Size::<f64, BufferCoord>::from((bww, bhh)),
    ))
}

pub(crate) fn shell_dmabuf_dirty_buffer_to_physical(
    buffer_src: Rectangle<f64, BufferCoord>,
    output_geo: Rectangle<i32, Logical>,
    output_scale: Scale<f64>,
    dirty: &[Rectangle<i32, BufferCoord>],
) -> Vec<Rectangle<i32, Physical>> {
    let bx0 = buffer_src.loc.x;
    let by0 = buffer_src.loc.y;
    let bww = buffer_src.size.w.max(f64::EPSILON);
    let bhh = buffer_src.size.h.max(f64::EPSILON);
    let phys = output_geo.size.to_f64().to_physical(output_scale);
    let ow_phys = phys.w;
    let oh_phys = phys.h.max(f64::EPSILON);
    let mut out = Vec::new();
    for r in dirty {
        let dx = r.loc.x as f64;
        let dy = r.loc.y as f64;
        let dw = r.size.w as f64;
        let dh = r.size.h as f64;
        if dw <= 0.0 || dh <= 0.0 {
            continue;
        }
        let rx0 = dx.max(bx0).min(bx0 + bww);
        let ry0 = dy.max(by0).min(by0 + bhh);
        let rx1 = (dx + dw).max(bx0).min(bx0 + bww);
        let ry1 = (dy + dh).max(by0).min(by0 + bhh);
        if rx1 <= rx0 || ry1 <= ry0 {
            continue;
        }
        let ox0 = (rx0 - bx0) / bww * ow_phys;
        let oy0 = (ry0 - by0) / bhh * oh_phys;
        let ox1 = (rx1 - bx0) / bww * ow_phys;
        let oy1 = (ry1 - by0) / bhh * oh_phys;
        let x0 = ox0.floor() as i32;
        let y0 = oy0.floor() as i32;
        let x1 = ox1.ceil() as i32;
        let y1 = oy1.ceil() as i32;
        let pw = (x1 - x0).max(0);
        let ph = (y1 - y0).max(0);
        if pw == 0 || ph == 0 {
            continue;
        }
        let rect = Rectangle::new(
            Point::<i32, Physical>::from((x0, y0)),
            Size::<i32, Physical>::from((pw, ph)),
        );
        let full = Rectangle::new(
            Point::<i32, Physical>::from((0, 0)),
            Size::<i32, Physical>::from((ow_phys.ceil() as i32, oh_phys.ceil() as i32)),
        );
        if let Some(inter) = rect.intersection(full) {
            out.push(inter);
        }
    }
    out
}

fn log_shell_dmabuf_import_context(
    dmabuf: &smithay::backend::allocator::dmabuf::Dmabuf,
    renderer: &GlesRenderer,
) {
    let fmt = dmabuf.format();
    let sz = dmabuf.size();
    let in_render = renderer
        .egl_context()
        .dmabuf_render_formats()
        .contains(&fmt);
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

fn build_main_shell_dmabuf_element(
    state: &CompositorState,
    renderer: &mut GlesRenderer,
    output_geo: Rectangle<i32, Logical>,
    output: &Output,
    buf_w: u32,
    buf_h: u32,
) -> Result<Option<ShellDmaElement>, GlesError> {
    let Some(ref dmabuf) = state.shell_dmabuf else {
        return Ok(None);
    };
    let Some(buffer_src) = shell_dmabuf_buffer_src_for_output(state, output, buf_w, buf_h) else {
        return Ok(None);
    };

    let shell_loc_phys = Point::<f64, Physical>::from((0.0_f64, 0.0_f64));
    let shell_size_logical = output_geo.size;
    let output_scale = Scale::from(output.current_scale().fractional_scale());

    let damage_phys = if state.shell_dmabuf_dirty_force_full {
        None
    } else if state.shell_dmabuf_dirty_buffer.is_empty() {
        None
    } else {
        let mapped = shell_dmabuf_dirty_buffer_to_physical(
            buffer_src,
            Rectangle::new(output_geo.loc, output_geo.size),
            output_scale,
            &state.shell_dmabuf_dirty_buffer,
        );
        if mapped.is_empty() {
            None
        } else {
            Some(mapped)
        }
    };

    log_shell_dmabuf_import_context(dmabuf, renderer);

    match crate::desktop::desktop_stack::shell_dmabuf_overlay_element(
        renderer,
        dmabuf,
        state.shell_dmabuf_overlay_id.clone(),
        shell_loc_phys,
        shell_size_logical,
        buffer_src,
        state.shell_dmabuf_commit,
        damage_phys,
    ) {
        Ok(el) => Ok(Some(el)),
        Err(e) => {
            let fmt = dmabuf.format();
            let sz = dmabuf.size();
            let in_render = renderer
                .egl_context()
                .dmabuf_render_formats()
                .contains(&fmt);
            let in_texture = renderer.dmabuf_formats().contains(&fmt);
            let render_n = renderer
                .egl_context()
                .dmabuf_render_formats()
                .iter()
                .count();
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

fn shell_move_proxy_target_texture_global_rect(
    source_global_rect: Rectangle<i32, Logical>,
    texture_global_rect: Rectangle<i32, Logical>,
    target_global_rect: Rectangle<i32, Logical>,
) -> Rectangle<i32, Logical> {
    Rectangle::new(
        Point::from((
            texture_global_rect.loc.x.saturating_add(
                target_global_rect
                    .loc
                    .x
                    .saturating_sub(source_global_rect.loc.x),
            ),
            texture_global_rect.loc.y.saturating_add(
                target_global_rect
                    .loc
                    .y
                    .saturating_sub(source_global_rect.loc.y),
            ),
        )),
        texture_global_rect.size,
    )
}

fn shell_move_proxy_sample_origin(
    size: Size<i32, BufferCoord>,
    right_edge: bool,
) -> Point<i32, BufferCoord> {
    let margin_x = (size.w.saturating_sub(1)).min(4);
    let margin_y = (size.h.saturating_sub(1)).min(2);
    Point::from((
        if right_edge {
            size.w.saturating_sub(1).saturating_sub(margin_x)
        } else {
            margin_x
        },
        margin_y,
    ))
}

fn shell_move_proxy_titlebar_fill_layer(
    target_global_rect: Rectangle<i32, Logical>,
    titlebar_h: i32,
    texture_size: Size<i32, BufferCoord>,
) -> Option<ShellMoveProxyLayer> {
    if titlebar_h <= 0
        || target_global_rect.size.w <= 0
        || texture_size.w <= 0
        || texture_size.h <= 0
    {
        return None;
    }
    Some(ShellMoveProxyLayer {
        target_global_rect: Rectangle::new(
            target_global_rect.loc,
            Size::from((target_global_rect.size.w, titlebar_h)),
        ),
        buffer_origin: Point::from((0, 0)),
        buffer_size: Size::from((texture_size.w, texture_size.h.min(2).max(1))),
    })
}

pub(crate) fn shell_move_proxy_layers(state: &CompositorState) -> Vec<ShellMoveProxyLayer> {
    let Some(proxy) = state.shell_move_proxy.as_ref() else {
        return Vec::new();
    };
    if proxy.texture.is_none() {
        return Vec::new();
    }
    if state.shell_move_window_id != Some(proxy.window_id) && proxy.release_state.is_none() {
        return Vec::new();
    }
    let Some(source_global_rect) = proxy.source_global_rect else {
        return Vec::new();
    };
    let Some(texture_global_rect) = proxy.texture_global_rect else {
        return Vec::new();
    };
    let Some(source_buffer_rect) = proxy.source_buffer_rect else {
        return Vec::new();
    };
    let Some(target_global_rect) = state.shell_move_proxy_target_global_rect() else {
        return Vec::new();
    };
    let texture_size = source_buffer_rect.size;
    let texture_target_global_rect = shell_move_proxy_target_texture_global_rect(
        source_global_rect,
        texture_global_rect,
        target_global_rect,
    );
    if state.window_registry.is_shell_hosted(proxy.window_id) {
        return vec![ShellMoveProxyLayer {
            target_global_rect: texture_target_global_rect,
            buffer_origin: Point::from((0, 0)),
            buffer_size: texture_size,
        }];
    }

    let left_w = proxy
        .source_client_rect
        .loc
        .x
        .saturating_sub(source_global_rect.loc.x)
        .max(0);
    let titlebar_h = proxy
        .source_client_rect
        .loc
        .y
        .saturating_sub(source_global_rect.loc.y)
        .max(1);
    let right_w = source_global_rect
        .loc
        .x
        .saturating_add(source_global_rect.size.w)
        .saturating_sub(
            proxy
                .source_client_rect
                .loc
                .x
                .saturating_add(proxy.source_client_rect.size.w),
        )
        .max(0);
    let bottom_h = source_global_rect
        .loc
        .y
        .saturating_add(source_global_rect.size.h)
        .saturating_sub(
            proxy
                .source_client_rect
                .loc
                .y
                .saturating_add(proxy.source_client_rect.size.h),
        )
        .max(0);
    let border_h = source_global_rect
        .size
        .h
        .saturating_sub(titlebar_h)
        .saturating_sub(bottom_h)
        .max(0);
    let left_sample_origin = shell_move_proxy_sample_origin(texture_size, false);
    let right_sample_origin = shell_move_proxy_sample_origin(texture_size, true);
    let sample_size = Size::from((1, 1));
    let mut layers = Vec::new();
    if let Some(titlebar_fill) =
        shell_move_proxy_titlebar_fill_layer(target_global_rect, titlebar_h, texture_size)
    {
        layers.push(titlebar_fill);
    }
    layers.push(ShellMoveProxyLayer {
        target_global_rect: texture_target_global_rect,
        buffer_origin: Point::from((0, 0)),
        buffer_size: texture_size,
    });
    if left_w > 0 && border_h > 0 {
        layers.push(ShellMoveProxyLayer {
            target_global_rect: Rectangle::new(
                Point::from((
                    target_global_rect.loc.x,
                    target_global_rect.loc.y.saturating_add(titlebar_h),
                )),
                Size::from((left_w, border_h)),
            ),
            buffer_origin: left_sample_origin,
            buffer_size: sample_size,
        });
    }
    if right_w > 0 && border_h > 0 {
        layers.push(ShellMoveProxyLayer {
            target_global_rect: Rectangle::new(
                Point::from((
                    target_global_rect
                        .loc
                        .x
                        .saturating_add(target_global_rect.size.w.saturating_sub(right_w)),
                    target_global_rect.loc.y.saturating_add(titlebar_h),
                )),
                Size::from((right_w, border_h)),
            ),
            buffer_origin: right_sample_origin,
            buffer_size: sample_size,
        });
    }
    if bottom_h > 0 {
        layers.push(ShellMoveProxyLayer {
            target_global_rect: Rectangle::new(
                Point::from((
                    target_global_rect.loc.x,
                    target_global_rect
                        .loc
                        .y
                        .saturating_add(target_global_rect.size.h.saturating_sub(bottom_h)),
                )),
                Size::from((target_global_rect.size.w, bottom_h)),
            ),
            buffer_origin: left_sample_origin,
            buffer_size: sample_size,
        });
    }
    layers
}

pub(crate) fn shell_move_proxy_visible_rects_for_output(
    state: &CompositorState,
    output: &Output,
) -> Vec<Rectangle<i32, Logical>> {
    let Some(proxy) = state.shell_move_proxy.as_ref() else {
        return Vec::new();
    };
    if proxy.texture.is_none() {
        return Vec::new();
    }
    let Some(output_geo) = state.space.output_geometry(output) else {
        return Vec::new();
    };
    let clip_holes =
        state.shell_exclusion_clip_rects_logical(output, Some(proxy.window_id), false, None);
    let mut out = Vec::new();
    for layer in shell_move_proxy_layers(state) {
        let Some(visible) = layer.target_global_rect.intersection(output_geo) else {
            continue;
        };
        for piece in
            crate::desktop::exclusion_clip::subtract_holes_from_rect_log(visible, &clip_holes)
        {
            if piece.size.w > 0 && piece.size.h > 0 {
                out.push(piece);
            }
        }
    }
    out
}

fn capture_shell_move_proxy_texture(
    state: &mut CompositorState,
    renderer: &mut GlesRenderer,
) -> Result<(), GlesError> {
    let Some((pending_capture, has_texture, texture_global_rect, source_buffer_rect)) =
        state.shell_move_proxy.as_ref().map(|proxy| {
            (
                proxy.pending_capture,
                proxy.texture.is_some(),
                proxy.texture_global_rect,
                proxy.source_buffer_rect,
            )
        })
    else {
        return Ok(());
    };
    if !pending_capture || has_texture {
        return Ok(());
    }
    let Some(dmabuf) = state.shell_dmabuf.as_ref() else {
        return Ok(());
    };
    let Some(texture_global_rect) = texture_global_rect else {
        return Ok(());
    };
    let Some(source_buffer_rect) = source_buffer_rect else {
        return Ok(());
    };
    if source_buffer_rect.size.w <= 0 || source_buffer_rect.size.h <= 0 {
        state.shell_move_proxy = None;
        return Ok(());
    }

    let imported = renderer.import_dmabuf(dmabuf, None)?;
    let mut frozen = renderer.create_buffer(Fourcc::Abgr8888, source_buffer_rect.size)?;
    let target_size =
        Size::<i32, Physical>::from((source_buffer_rect.size.w, source_buffer_rect.size.h));
    {
        let mut target = renderer.bind(&mut frozen)?;
        let damage = [Rectangle::from_size(target_size)];
        let mut frame = renderer.render(&mut target, target_size, Transform::Normal)?;
        frame.clear([0.0, 0.0, 0.0, 0.0].into(), &damage)?;
        let Some(src) = shell_move_proxy_map_rect_to_buffer(
            texture_global_rect,
            source_buffer_rect.loc,
            source_buffer_rect.size,
            texture_global_rect,
        ) else {
            let _ = frame.finish()?;
            return Ok(());
        };
        let dst = Rectangle::from_size(target_size);
        let rect_damage = [dst];
        Frame::render_texture_from_to(
            &mut frame,
            &imported,
            src,
            dst,
            &rect_damage,
            &[],
            Transform::Normal,
            1.0,
        )?;
        let _ = frame.finish()?;
    }

    let Some(proxy) = state.shell_move_proxy.as_mut() else {
        return Ok(());
    };
    proxy.texture = Some(frozen);
    proxy.request_opaque_source = false;
    proxy.pending_capture = false;
    proxy.commit.increment();
    state.shell_send_interaction_state();
    Ok(())
}

fn build_shell_move_proxy_elements(
    state: &CompositorState,
    renderer: &mut GlesRenderer,
    output: &Output,
) -> Vec<ShellDmaElement> {
    let Some(proxy) = state.shell_move_proxy.as_ref() else {
        return Vec::new();
    };
    let Some(texture) = proxy.texture.clone() else {
        return Vec::new();
    };
    let Some(output_geo) = state.space.output_geometry(output) else {
        return Vec::new();
    };
    let clip_holes =
        state.shell_exclusion_clip_rects_logical(output, Some(proxy.window_id), false, None);
    let scale = output.current_scale().fractional_scale();
    let mut out = Vec::new();
    for layer in shell_move_proxy_layers(state) {
        let Some(visible) = layer.target_global_rect.intersection(output_geo) else {
            continue;
        };
        for piece in
            crate::desktop::exclusion_clip::subtract_holes_from_rect_log(visible, &clip_holes)
        {
            if piece.size.w <= 0 || piece.size.h <= 0 {
                continue;
            }
            let Some(buffer_src) = shell_move_proxy_map_rect_to_buffer(
                layer.target_global_rect,
                layer.buffer_origin,
                layer.buffer_size,
                piece,
            ) else {
                continue;
            };
            let output_local = piece.loc - output_geo.loc;
            out.push(
                ShellDmaElement::wallpaper_quad(
                    proxy.texture_id.clone(),
                    renderer.context_id(),
                    Point::<f64, Physical>::from((
                        (output_local.x as f64 * scale).round(),
                        (output_local.y as f64 * scale).round(),
                    )),
                    piece.size,
                    texture.clone(),
                    buffer_src,
                    proxy.commit,
                )
                .with_alpha(SHELL_DRAG_WINDOW_ALPHA),
            );
        }
    }
    out
}

fn shell_move_proxy_map_rect_to_buffer(
    outer_logical_rect: Rectangle<i32, Logical>,
    buffer_origin: Point<i32, BufferCoord>,
    buffer_size: Size<i32, BufferCoord>,
    rect: Rectangle<i32, Logical>,
) -> Option<Rectangle<f64, BufferCoord>> {
    let rect = rect.intersection(outer_logical_rect)?;
    if rect.size.w <= 0 || rect.size.h <= 0 {
        return None;
    }
    let logical_w = outer_logical_rect.size.w.max(1) as f64;
    let logical_h = outer_logical_rect.size.h.max(1) as f64;
    let buffer_w = buffer_size.w.max(1) as f64;
    let buffer_h = buffer_size.h.max(1) as f64;
    let rel_x = rect.loc.x.saturating_sub(outer_logical_rect.loc.x) as f64;
    let rel_y = rect.loc.y.saturating_sub(outer_logical_rect.loc.y) as f64;
    Some(Rectangle::new(
        Point::from((
            buffer_origin.x as f64 + rel_x * buffer_w / logical_w,
            buffer_origin.y as f64 + rel_y * buffer_h / logical_h,
        )),
        Size::from((
            rect.size.w.max(1) as f64 * buffer_w / logical_w,
            rect.size.h.max(1) as f64 * buffer_h / logical_h,
        )),
    ))
}

fn cache_shell_element<K: Clone + PartialEq>(
    slot: &mut Option<CachedShellElement<K>>,
    key: K,
    commit: CommitCounter,
    build: impl FnOnce() -> Result<Option<ShellDmaElement>, GlesError>,
) -> Result<(Option<ShellDmaElement>, bool), GlesError> {
    if let Some(cached) = slot.as_ref() {
        if cached.key == key && cached.commit == commit {
            note_shell_cache_result(true, false);
            return Ok((cached.element.clone(), false));
        }
    }
    let force_full_damage = slot.as_ref().is_some_and(|cached| cached.key != key);
    let element = build()?;
    *slot = Some(CachedShellElement {
        key,
        commit,
        element: element.clone(),
    });
    note_shell_cache_result(false, force_full_damage);
    Ok((element, force_full_damage))
}

pub fn compositor_shell_render_elements(
    state: &mut CompositorState,
    renderer: &mut GlesRenderer,
    output: &Output,
) -> Result<ShellOutputRenderElements, GlesError> {
    let output_name = output.name();
    let mut cache = state
        .shell_render_cache_by_output
        .remove(&output_name)
        .unwrap_or_default();
    let mut render = ShellOutputRenderElements::default();
    let output_geo = state.space.output_geometry(output);
    let output_scale = output.current_scale().fractional_scale();

    capture_shell_move_proxy_texture(state, renderer)?;
    render.move_proxy = build_shell_move_proxy_elements(state, renderer, output);

    if state.shell_has_frame && state.shell_frame_is_dmabuf {
        if let (Some(output_geo), Some((buf_w, buf_h))) = (output_geo, state.shell_view_px) {
            let key = ShellMainCacheKey {
                output_geo,
                output_scale_bits: output_scale.to_bits(),
                canvas_origin: state.shell_canvas_logical_origin,
                canvas_size: state.shell_canvas_logical_size,
                view_px: (buf_w, buf_h),
            };
            let (element, force_full_damage) =
                cache_shell_element(&mut cache.main, key, state.shell_dmabuf_commit, || {
                    build_main_shell_dmabuf_element(
                        state, renderer, output_geo, output, buf_w, buf_h,
                    )
                })?;
            render.dmabuf = element;
            render.force_full_damage |= force_full_damage;
        } else if cache
            .main
            .as_ref()
            .is_some_and(|cached| cached.element.is_some())
        {
            render.force_full_damage = true;
            cache.main = None;
        } else {
            cache.main = None;
        }
    } else if cache
        .main
        .as_ref()
        .is_some_and(|cached| cached.element.is_some())
    {
        render.force_full_damage = true;
        cache.main = None;
    } else {
        cache.main = None;
    }

    state
        .shell_render_cache_by_output
        .insert(output_name, cache);
    Ok(render)
}

#[cfg(test)]
mod shell_move_proxy_tests {
    use super::{
        shell_move_proxy_map_rect_to_buffer, shell_move_proxy_target_texture_global_rect,
        shell_move_proxy_titlebar_fill_layer, BufferCoord, Logical, Point, Rectangle, Size,
    };

    fn logical_rect(x: i32, y: i32, w: i32, h: i32) -> Rectangle<i32, Logical> {
        Rectangle::new(Point::from((x, y)), Size::from((w, h)))
    }

    #[test]
    fn clipped_left_capture_stays_clipped_in_target_space() {
        let source_global_rect = logical_rect(60, 50, 300, 350);
        let texture_global_rect = logical_rect(100, 50, 240, 26);
        let target_global_rect = logical_rect(-20, 200, 300, 350);

        let mapped = shell_move_proxy_target_texture_global_rect(
            source_global_rect,
            texture_global_rect,
            target_global_rect,
        );

        assert_eq!(mapped, logical_rect(20, 200, 240, 26));

        let src = shell_move_proxy_map_rect_to_buffer(
            mapped,
            Point::<i32, BufferCoord>::from((0, 0)),
            Size::<i32, BufferCoord>::from((240, 26)),
            logical_rect(20, 200, 96, 26),
        )
        .unwrap();

        assert_eq!(src.loc.x, 0.0);
        assert_eq!(src.loc.y, 0.0);
        assert_eq!(src.size.w, 96.0);
        assert_eq!(src.size.h, 26.0);
    }

    #[test]
    fn clipped_right_capture_maps_without_horizontal_stretch() {
        let source_global_rect = logical_rect(60, 50, 300, 350);
        let texture_global_rect = logical_rect(60, 50, 240, 26);
        let target_global_rect = logical_rect(180, 200, 300, 350);

        let mapped = shell_move_proxy_target_texture_global_rect(
            source_global_rect,
            texture_global_rect,
            target_global_rect,
        );

        assert_eq!(mapped, logical_rect(180, 200, 240, 26));

        let src = shell_move_proxy_map_rect_to_buffer(
            mapped,
            Point::<i32, BufferCoord>::from((0, 0)),
            Size::<i32, BufferCoord>::from((240, 26)),
            logical_rect(324, 200, 96, 26),
        )
        .unwrap();

        assert_eq!(src.loc.x, 144.0);
        assert_eq!(src.loc.y, 0.0);
        assert_eq!(src.size.w, 96.0);
        assert_eq!(src.size.h, 26.0);
    }

    #[test]
    fn titlebar_fill_layer_spans_full_target_width() {
        let target_global_rect = logical_rect(-20, 200, 300, 350);
        let fill = shell_move_proxy_titlebar_fill_layer(
            target_global_rect,
            26,
            Size::<i32, BufferCoord>::from((240, 26)),
        )
        .unwrap();

        assert_eq!(fill.target_global_rect, logical_rect(-20, 200, 300, 26));
        assert_eq!(fill.buffer_origin, Point::<i32, BufferCoord>::from((0, 0)));
        assert_eq!(fill.buffer_size, Size::<i32, BufferCoord>::from((240, 2)));

        let src = shell_move_proxy_map_rect_to_buffer(
            fill.target_global_rect,
            fill.buffer_origin,
            fill.buffer_size,
            logical_rect(-20, 200, 60, 26),
        )
        .unwrap();

        assert_eq!(src.loc.x, 0.0);
        assert_eq!(src.loc.y, 0.0);
        assert_eq!(src.size.w, 48.0);
        assert_eq!(src.size.h, 2.0);
    }
}
