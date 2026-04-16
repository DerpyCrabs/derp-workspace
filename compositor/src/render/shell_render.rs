//! Full-screen Solid / CEF **dma-buf** OSR plane for DRM and winit [`OutputDamageTracker::render_output`] paths.

use std::sync::{Mutex, OnceLock};

use smithay::{
    backend::allocator::Buffer,
    backend::renderer::{
        element::Id,
        gles::{GlesError, GlesRenderer},
        utils::CommitCounter,
        ImportDma,
    },
    output::Output,
    utils::{Buffer as BufferCoord, Logical, Physical, Point, Rectangle, Scale, Size},
};

use crate::desktop::desktop_stack::ShellDmaElement;
use crate::CompositorState;

const SHELL_DMABUF_EGL_SAMPLE_LEN: usize = 32;

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ShellMainCacheKey {
    pub output_geo: Rectangle<i32, Logical>,
    pub output_scale_bits: u64,
    pub canvas_origin: (i32, i32),
    pub canvas_size: (u32, u32),
    pub view_px: (u32, u32),
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ShellOverlayCacheKey {
    pub output_geo: Rectangle<i32, Logical>,
    pub output_scale_bits: u64,
    pub global_rect: Rectangle<i32, Logical>,
    pub buffer_rect: Rectangle<i32, BufferCoord>,
}

pub(crate) struct CachedShellElement<K> {
    pub key: K,
    pub commit: CommitCounter,
    pub element: Option<ShellDmaElement>,
}

#[derive(Default)]
pub(crate) struct ShellOutputRenderElements {
    pub floating: Vec<ShellDmaElement>,
    pub context_menu: Option<ShellDmaElement>,
    pub dmabuf: Option<ShellDmaElement>,
    pub force_full_damage: bool,
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

fn shell_overlay_element_for_placement(
    state: &CompositorState,
    renderer: &mut GlesRenderer,
    output_geo: Rectangle<i32, Logical>,
    output_scale: f64,
    placement: &crate::state::ShellContextMenuPlacement,
    overlay_id: &Id,
    error_label: &'static str,
) -> Result<Option<ShellDmaElement>, GlesError> {
    let Some(ref dmabuf) = state.shell_dmabuf else {
        return Ok(None);
    };
    let menu_g = placement.global_rect;
    let Some(inter) = menu_g.intersection(Rectangle::new(output_geo.loc, output_geo.size)) else {
        return Ok(None);
    };
    if inter.size.w <= 0 || inter.size.h <= 0 {
        return Ok(None);
    }

    let bx = placement.buffer_rect.loc.x as f64;
    let by = placement.buffer_rect.loc.y as f64;
    let bw = placement.buffer_rect.size.w.max(1) as f64;
    let bh = placement.buffer_rect.size.h.max(1) as f64;
    let gx = menu_g.loc.x as f64;
    let gy = menu_g.loc.y as f64;
    let gw = menu_g.size.w.max(1) as f64;
    let gh = menu_g.size.h.max(1) as f64;

    let ix0 = inter.loc.x as f64;
    let iy0 = inter.loc.y as f64;
    let ix1 = ix0 + inter.size.w as f64;
    let iy1 = iy0 + inter.size.h as f64;

    let u0 = ((ix0 - gx) / gw).clamp(0.0, 1.0);
    let v0 = ((iy0 - gy) / gh).clamp(0.0, 1.0);
    let u1 = ((ix1 - gx) / gw).clamp(0.0, 1.0);
    let v1 = ((iy1 - gy) / gh).clamp(0.0, 1.0);

    let bsrc_x0 = bx + u0 * bw;
    let bsrc_y0 = by + v0 * bh;
    let bsrc_w = (u1 - u0) * bw;
    let bsrc_h = (v1 - v0) * bh;
    if bsrc_w < 0.5 || bsrc_h < 0.5 {
        return Ok(None);
    }

    let buffer_src = Rectangle::new(
        Point::<f64, BufferCoord>::from((bsrc_x0, bsrc_y0)),
        Size::<f64, BufferCoord>::from((bsrc_w, bsrc_h)),
    );

    let output_scale = Scale::from(output_scale);
    let d = inter.loc - output_geo.loc;
    let shell_loc_phys =
        Point::<f64, Physical>::from((d.x as f64 * output_scale.x, d.y as f64 * output_scale.x));
    let shell_size_logical = inter.size;

    let damage_phys = if state.shell_dmabuf_dirty_force_full {
        None
    } else if state.shell_dmabuf_dirty_buffer.is_empty() {
        None
    } else {
        let mapped = shell_dmabuf_dirty_buffer_to_physical(
            buffer_src,
            Rectangle::new(inter.loc, inter.size),
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
        overlay_id.clone(),
        shell_loc_phys,
        shell_size_logical,
        buffer_src,
        state.shell_dmabuf_commit,
        damage_phys,
    ) {
        Ok(el) => Ok(Some(el)),
        Err(e) => {
            tracing::warn!(
                target: "derp_shell_dmabuf",
                ?e,
                %error_label,
                "shell floating dma-buf layer import failed"
            );
            Ok(None)
        }
    }
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

    if let (Some(output_geo), Some(placement)) = (output_geo, state.shell_context_menu.clone()) {
        let key = ShellOverlayCacheKey {
            output_geo,
            output_scale_bits: output_scale.to_bits(),
            global_rect: placement.global_rect,
            buffer_rect: placement.buffer_rect,
        };
        let (element, force_full_damage) = cache_shell_element(
            &mut cache.context_menu,
            key,
            state.shell_dmabuf_commit,
            || {
                shell_overlay_element_for_placement(
                    state,
                    renderer,
                    output_geo,
                    output_scale,
                    &placement,
                    &state.shell_context_menu_overlay_id,
                    "context menu dma-buf layer import failed",
                )
            },
        )?;
        render.context_menu = element;
        render.force_full_damage |= force_full_damage;
    } else if cache
        .context_menu
        .as_ref()
        .is_some_and(|cached| cached.element.is_some())
    {
        render.force_full_damage = true;
        cache.context_menu = None;
    } else {
        cache.context_menu = None;
    }

    let current_floating = state.shell_floating_layers.clone();
    let current_ids: Vec<u32> = current_floating.iter().map(|layer| layer.id).collect();
    if cache.floating_order != current_ids
        && (cache
            .floating
            .iter()
            .any(|(_, cached)| cached.element.is_some())
            || !current_ids.is_empty())
    {
        render.force_full_damage = true;
    }
    cache.floating_order = current_ids.clone();
    cache
        .floating
        .retain(|id, _| current_ids.iter().any(|current| current == id));

    if let Some(output_geo) = output_geo {
        for layer in current_floating {
            let placement = crate::state::ShellContextMenuPlacement {
                buffer_rect: layer.buffer_rect,
                global_rect: layer.global_rect,
            };
            let key = ShellOverlayCacheKey {
                output_geo,
                output_scale_bits: output_scale.to_bits(),
                global_rect: placement.global_rect,
                buffer_rect: placement.buffer_rect,
            };
            let mut slot = cache.floating.remove(&layer.id);
            let (element, force_full_damage) =
                cache_shell_element(&mut slot, key, state.shell_dmabuf_commit, || {
                    shell_overlay_element_for_placement(
                        state,
                        renderer,
                        output_geo,
                        output_scale,
                        &placement,
                        &layer.overlay_id,
                        "floating layer dma-buf import failed",
                    )
                })?;
            if let Some(slot) = slot {
                cache.floating.insert(layer.id, slot);
            }
            if let Some(element) = element {
                render.floating.push(element);
            }
            render.force_full_damage |= force_full_damage;
        }
    } else if cache
        .floating
        .values()
        .any(|cached| cached.element.is_some())
    {
        render.force_full_damage = true;
        cache.floating.clear();
        cache.floating_order.clear();
    } else {
        cache.floating.clear();
        cache.floating_order.clear();
    }

    state
        .shell_render_cache_by_output
        .insert(output_name, cache);
    Ok(render)
}
