use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use smithay::{
    backend::renderer::{
        element::{
            solid::{SolidColorBuffer, SolidColorRenderElement},
            Id, Kind,
        },
        utils::CommitCounter,
        Color32F,
    },
    output::Output,
    utils::{Buffer, Logical, Physical, Point, Rectangle, Size},
};

use crate::desktop_stack::ShellDmaElement;
use crate::display_config::DesktopBackgroundConfig;
use crate::state::{BackdropWallpaperIdCache, CompositorState};

#[derive(Clone)]
pub(crate) struct BackdropLayers {
    pub solids: Vec<SolidColorRenderElement>,
    pub textures: Vec<ShellDmaElement>,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct BackdropCacheKey {
    pub output_geo: Rectangle<i32, Logical>,
    pub scale_bits: u64,
    pub mode: String,
    pub fit: String,
    pub solid_rgba_bits: [u32; 4],
    pub wallpaper_path: Option<PathBuf>,
    pub wallpaper_commit: Option<CommitCounter>,
    pub workspace_bounds: Option<Rectangle<i32, Logical>>,
    pub texture_size: Option<(i32, i32)>,
}

#[derive(Default)]
struct CacheStats {
    hits: u64,
    misses: u64,
    forced_full_damage_misses: u64,
    last_logged_total: u64,
}

fn backdrop_cache_stats() -> &'static Mutex<CacheStats> {
    static STATS: OnceLock<Mutex<CacheStats>> = OnceLock::new();
    STATS.get_or_init(|| Mutex::new(CacheStats::default()))
}

fn note_backdrop_cache_result(hit: bool, force_full_damage: bool) {
    let Ok(mut stats) = backdrop_cache_stats().lock() else {
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
        cache = "backdrop",
        hits = stats.hits,
        misses = stats.misses,
        forced_full_damage_misses = stats.forced_full_damage_misses,
        hit_rate,
        "render cache stats"
    );
}

fn fit_norm(fit: &str) -> &'static str {
    let s = fit.trim().to_ascii_lowercase();
    match s.as_str() {
        "zoom" | "fill" => "fill",
        "scaled" | "fit" => "fit",
        "wallpaper" | "tile" => "tile",
        "centered" | "center" => "center",
        "stretched" | "stretch" => "stretch",
        "spanned" => "spanned",
        _ => "fill",
    }
}

fn wallpaper_path_for_cfg(cfg: &DesktopBackgroundConfig) -> Option<PathBuf> {
    if cfg.mode != "image" || cfg.image_path.trim().is_empty() {
        return None;
    }
    let p = crate::desktop_background::normalize_filesystem_path(&cfg.image_path);
    if p.as_os_str().is_empty() {
        None
    } else {
        Some(p)
    }
}

fn backdrop_wallpaper_element_id(
    state: &mut CompositorState,
    output_name: &str,
    layout_key: &str,
    idx: usize,
) -> Id {
    let e = state
        .backdrop_wallpaper_id_cache
        .entry(output_name.to_string())
        .or_insert_with(|| BackdropWallpaperIdCache {
            key: String::new(),
            ids: Vec::new(),
        });
    if e.key != layout_key {
        e.key = layout_key.to_string();
        e.ids.clear();
    }
    while e.ids.len() <= idx {
        e.ids.push(Id::new());
    }
    e.ids[idx].clone()
}

fn push_fill_cover(
    textures: &mut Vec<ShellDmaElement>,
    output_geo: Rectangle<i32, Logical>,
    tw: f64,
    th: f64,
    texture: smithay::backend::renderer::gles::GlesTexture,
    ctx_id: smithay::backend::renderer::ContextId<smithay::backend::renderer::gles::GlesTexture>,
    commit: smithay::backend::renderer::utils::CommitCounter,
    out_w: i32,
    out_h: i32,
    elem_id: Id,
) {
    let ow = out_w as f64;
    let oh = out_h as f64;
    let scale = (ow / tw).max(oh / th);
    let src_w = ow / scale;
    let src_h = oh / scale;
    let sx0 = ((tw - src_w) * 0.5).max(0.0);
    let sy0 = ((th - src_h) * 0.5).max(0.0);
    textures.push(ShellDmaElement::wallpaper_quad(
        elem_id,
        ctx_id,
        Point::<f64, Physical>::from((0.0, 0.0)),
        output_geo.size,
        texture,
        Rectangle::new(
            Point::<f64, Buffer>::from((sx0, sy0)),
            Size::<f64, Buffer>::from((src_w, src_h)),
        ),
        commit,
    ));
}

fn push_solid_backdrop(
    solids: &mut Vec<SolidColorRenderElement>,
    size: Size<i32, Logical>,
    base_color: Color32F,
    scale_f: f64,
) {
    let solid = SolidColorBuffer::new(size, base_color);
    solids.push(SolidColorRenderElement::from_buffer(
        &solid,
        Point::<i32, Physical>::from((0, 0)),
        scale_f,
        1.0,
        Kind::Unspecified,
    ));
}

fn build_desktop_backdrop_layers_uncached(
    state: &mut CompositorState,
    output_name: &str,
    output_geo: Rectangle<i32, Logical>,
    scale_f: f64,
    cfg: &DesktopBackgroundConfig,
    wallpaper: Option<(
        PathBuf,
        CommitCounter,
        smithay::backend::renderer::gles::GlesTexture,
        smithay::backend::renderer::ContextId<smithay::backend::renderer::gles::GlesTexture>,
        i32,
        i32,
    )>,
) -> BackdropLayers {
    let mut solids: Vec<SolidColorRenderElement> = Vec::new();
    let mut textures: Vec<ShellDmaElement> = Vec::new();
    let out_w = output_geo.size.w.max(1);
    let out_h = output_geo.size.h.max(1);
    let ow = out_w as f64;
    let oh = out_h as f64;
    let rgba = cfg.solid_rgba;
    let base_color = Color32F::new(rgba[0], rgba[1], rgba[2], rgba[3]);

    let Some((path, commit, texture, ctx_id, tex_w, tex_h)) = wallpaper else {
        push_solid_backdrop(&mut solids, output_geo.size, base_color, scale_f);
        return BackdropLayers { solids, textures };
    };
    let tw = tex_w.max(1) as f64;
    let th = tex_h.max(1) as f64;
    let fit = fit_norm(&cfg.fit);
    let ws_s = state
        .workspace_logical_bounds()
        .map(|r| format!("{}x{}+{}+{}", r.size.w, r.size.h, r.loc.x, r.loc.y))
        .unwrap_or_else(|| "-".into());
    let layout_root = format!(
        "v1|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        path.to_string_lossy(),
        fit,
        scale_f.to_bits(),
        out_w,
        out_h,
        output_geo.loc.x,
        output_geo.loc.y,
        tw as i64,
        th as i64,
        ws_s,
    );

    match fit {
        "fit" => {
            push_solid_backdrop(&mut solids, output_geo.size, base_color, scale_f);
            let scale = (ow / tw).min(oh / th);
            let dw = (tw * scale).round().max(1.0) as i32;
            let dh = (th * scale).round().max(1.0) as i32;
            let ox = (out_w - dw) / 2;
            let oy = (out_h - dh) / 2;
            let ox_p = (ox as f64 * scale_f).round();
            let oy_p = (oy as f64 * scale_f).round();
            let lk = format!("{layout_root}|fit");
            textures.push(ShellDmaElement::wallpaper_quad(
                backdrop_wallpaper_element_id(state, &output_name, &lk, 0),
                ctx_id.clone(),
                Point::<f64, Physical>::from((ox_p, oy_p)),
                Size::from((dw, dh)),
                texture,
                Rectangle::new(
                    Point::<f64, Buffer>::from((0.0, 0.0)),
                    Size::<f64, Buffer>::from((tw, th)),
                ),
                commit,
            ));
        }
        "tile" => {
            let tile_w = ((tw / scale_f).round().max(1.0)) as i32;
            let tile_h = ((th / scale_f).round().max(1.0)) as i32;
            let nx = ((out_w + tile_w - 1) / tile_w).min(48);
            let ny = ((out_h + tile_h - 1) / tile_h).min(48);
            let src = Rectangle::new(
                Point::<f64, Buffer>::from((0.0, 0.0)),
                Size::<f64, Buffer>::from((tw, th)),
            );
            let lk_tile = format!("{layout_root}|tile|{nx}|{ny}");
            let mut tidx = 0usize;
            for j in 0..ny {
                for i in 0..nx {
                    let ox = i * tile_w;
                    let oy = j * tile_h;
                    let ox_p = (ox as f64 * scale_f).round();
                    let oy_p = (oy as f64 * scale_f).round();
                    textures.push(ShellDmaElement::wallpaper_quad(
                        backdrop_wallpaper_element_id(state, &output_name, &lk_tile, tidx),
                        ctx_id.clone(),
                        Point::<f64, Physical>::from((ox_p, oy_p)),
                        Size::from((tile_w, tile_h)),
                        texture.clone(),
                        src,
                        commit,
                    ));
                    tidx += 1;
                }
            }
        }
        "center" => {
            push_solid_backdrop(&mut solids, output_geo.size, base_color, scale_f);
            let scale = (ow / tw).min(oh / th).min(1.0);
            let dw = (tw * scale).round().max(1.0) as i32;
            let dh = (th * scale).round().max(1.0) as i32;
            let ox = (out_w - dw) / 2;
            let oy = (out_h - dh) / 2;
            let ox_p = (ox as f64 * scale_f).round();
            let oy_p = (oy as f64 * scale_f).round();
            let lk = format!("{layout_root}|center");
            textures.push(ShellDmaElement::wallpaper_quad(
                backdrop_wallpaper_element_id(state, &output_name, &lk, 0),
                ctx_id.clone(),
                Point::<f64, Physical>::from((ox_p, oy_p)),
                Size::from((dw, dh)),
                texture,
                Rectangle::new(
                    Point::<f64, Buffer>::from((0.0, 0.0)),
                    Size::<f64, Buffer>::from((tw, th)),
                ),
                commit,
            ));
        }
        "stretch" => {
            let lk = format!("{layout_root}|stretch");
            textures.push(ShellDmaElement::wallpaper_quad(
                backdrop_wallpaper_element_id(state, &output_name, &lk, 0),
                ctx_id.clone(),
                Point::<f64, Physical>::from((0.0, 0.0)),
                output_geo.size,
                texture,
                Rectangle::new(
                    Point::<f64, Buffer>::from((0.0, 0.0)),
                    Size::<f64, Buffer>::from((tw, th)),
                ),
                commit,
            ));
        }
        "spanned" => {
            if let Some(ws) = state.workspace_logical_bounds() {
                let bw = ws.size.w as f64;
                let bh = ws.size.h as f64;
                let s = (bw / tw).max(bh / th);
                let img_w = tw * s;
                let img_h = th * s;
                let off_x = (bw - img_w) * 0.5;
                let off_y = (bh - img_h) * 0.5;
                let g0x = ws.loc.x as f64 + off_x;
                let g0y = ws.loc.y as f64 + off_y;
                let ox = output_geo.loc.x as f64;
                let oy = output_geo.loc.y as f64;
                let src_x0 = (ox - g0x) / s;
                let src_y0 = (oy - g0y) / s;
                let src_w = ow / s;
                let src_h = oh / s;
                let lk = format!("{layout_root}|spanned");
                textures.push(ShellDmaElement::wallpaper_quad(
                    backdrop_wallpaper_element_id(state, &output_name, &lk, 0),
                    ctx_id.clone(),
                    Point::<f64, Physical>::from((0.0, 0.0)),
                    output_geo.size,
                    texture,
                    Rectangle::new(
                        Point::<f64, Buffer>::from((src_x0, src_y0)),
                        Size::<f64, Buffer>::from((src_w, src_h)),
                    ),
                    commit,
                ));
            } else {
                let lk = format!("{layout_root}|spanned_fb");
                let eid = backdrop_wallpaper_element_id(state, &output_name, &lk, 0);
                push_fill_cover(
                    &mut textures,
                    output_geo,
                    tw,
                    th,
                    texture,
                    ctx_id,
                    commit,
                    out_w,
                    out_h,
                    eid,
                );
            }
        }
        _ => {
            let lk = format!("{layout_root}|fill");
            let eid = backdrop_wallpaper_element_id(state, &output_name, &lk, 0);
            push_fill_cover(
                &mut textures,
                output_geo,
                tw,
                th,
                texture,
                ctx_id,
                commit,
                out_w,
                out_h,
                eid,
            );
        }
    }

    BackdropLayers { solids, textures }
}

pub(crate) fn desktop_backdrop_layers(
    state: &mut CompositorState,
    output: &Output,
    scale_f: f64,
) -> (BackdropLayers, bool) {
    let Some(output_geo) = state.space.output_geometry(output) else {
        note_backdrop_cache_result(false, false);
        return (
            BackdropLayers {
                solids: Vec::new(),
                textures: Vec::new(),
            },
            false,
        );
    };
    let output_name = output.name();
    let cfg = state.desktop_background_for_output(output).clone();
    let wallpaper = wallpaper_path_for_cfg(&cfg).and_then(|path| {
        state
            .desktop_wallpaper_gpu_by_path
            .get(&path)
            .map(|entry| {
                (
                    path,
                    entry.commit,
                    entry.gpu.texture.clone(),
                    entry.gpu.context_id.clone(),
                    entry.gpu.tex_w,
                    entry.gpu.tex_h,
                )
            })
    });
    let key = BackdropCacheKey {
        output_geo,
        scale_bits: scale_f.to_bits(),
        mode: cfg.mode.clone(),
        fit: fit_norm(&cfg.fit).to_string(),
        solid_rgba_bits: cfg.solid_rgba.map(f32::to_bits),
        wallpaper_path: wallpaper.as_ref().map(|(path, ..)| path.clone()),
        wallpaper_commit: wallpaper.as_ref().map(|(_, commit, ..)| *commit),
        workspace_bounds: state.workspace_logical_bounds(),
        texture_size: wallpaper
            .as_ref()
            .map(|(_, _, _, _, tex_w, tex_h)| (*tex_w, *tex_h)),
    };
    if let Some(cached) = state.backdrop_layers_by_output.get(&output_name) {
        if cached.key == key {
            note_backdrop_cache_result(true, false);
            return (cached.layers.clone(), false);
        }
    }
    let force_full_damage = state.backdrop_layers_by_output.contains_key(&output_name);
    let layers =
        build_desktop_backdrop_layers_uncached(state, &output_name, output_geo, scale_f, &cfg, wallpaper);
    state
        .backdrop_layers_by_output
        .insert(output_name, crate::state::CachedBackdropLayers {
            key,
            layers: layers.clone(),
        });
    note_backdrop_cache_result(false, force_full_damage);
    (layers, force_full_damage)
}
