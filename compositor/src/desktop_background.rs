use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};

use image::{DynamicImage, ImageEncoder};
use jxl_oxide::integration::JxlDecoder;

const MAX_IMAGE_BYTES: u64 = 48 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 8192;
const PREVIEW_JPEG_MAX_EDGE: u32 = 480;
const PREVIEW_JPEG_QUALITY: u8 = 82;

pub struct DesktopWallpaperCpu {
    pub bgra: Vec<u8>,
    pub w: i32,
    pub h: i32,
}

pub struct WallpaperLoaderChannels {
    pub req_tx: Sender<PathBuf>,
    pub done_rx: Receiver<Result<(PathBuf, DesktopWallpaperCpu), String>>,
}

pub fn spawn_wallpaper_loader_thread() -> WallpaperLoaderChannels {
    let (done_tx, done_rx) = mpsc::channel::<Result<(PathBuf, DesktopWallpaperCpu), String>>();
    let (req_tx, req_rx) = mpsc::channel::<PathBuf>();
    let _ = std::thread::Builder::new()
        .name("derp-wallpaper".into())
        .spawn(move || {
            while let Ok(path) = req_rx.recv() {
                let path_key = path.clone();
                let r = decode_image_file(&path).map(|cpu| (path_key, cpu));
                let _ = done_tx.send(r);
            }
        });
    WallpaperLoaderChannels { req_tx, done_rx }
}

pub fn normalize_filesystem_path(raw: &str) -> PathBuf {
    let s = raw.trim();
    PathBuf::from(s.strip_prefix("file://").unwrap_or(s))
}

pub(crate) fn rgba_to_argb8888_bytes(rgba: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let n = (w as usize)
        .checked_mul(h as usize)?
        .checked_mul(4)?;
    if rgba.len() < n {
        return None;
    }
    let mut out = Vec::with_capacity(n);
    for px in rgba[..n].chunks_exact(4) {
        let r = px[0];
        let g = px[1];
        let b = px[2];
        let a = px[3];
        out.extend_from_slice(&[b, g, r, a]);
    }
    Some(out)
}

fn decode_bytes_to_dynamic(bytes: &[u8], path_for_err: &Path) -> Result<DynamicImage, String> {
    match image::load_from_memory(bytes) {
        Ok(img) => Ok(img),
        Err(e0) => {
            let dec = JxlDecoder::new(Cursor::new(bytes)).map_err(|e| {
                format!("decode {}: {e0}; jxl init: {e}", path_for_err.display())
            })?;
            DynamicImage::from_decoder(dec)
                .map_err(|e| format!("decode {}: {e0}; jxl: {e}", path_for_err.display()))
        }
    }
}

fn rgba8_capped(rgba: image::RgbaImage, max_edge: u32) -> image::RgbaImage {
    let (w, h) = rgba.dimensions();
    if w > max_edge || h > max_edge {
        let scale = max_edge as f64 / (w.max(h) as f64);
        let rw = ((w as f64) * scale).round().max(1.0) as u32;
        let rh = ((h as f64) * scale).round().max(1.0) as u32;
        return image::imageops::resize(&rgba, rw, rh, image::imageops::FilterType::Triangle);
    }
    rgba
}

pub fn encode_wallpaper_preview_jpeg(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!("image too large: {} bytes", meta.len()));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let img = decode_bytes_to_dynamic(&bytes, path)?;
    let rgba = rgba8_capped(img.to_rgba8(), PREVIEW_JPEG_MAX_EDGE);
    let rgb = DynamicImage::from(rgba).to_rgb8();
    let (w, h) = rgb.dimensions();
    let raw = rgb.as_raw();
    let mut out = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, PREVIEW_JPEG_QUALITY);
    enc.write_image(raw, w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("jpeg enc: {e}"))?;
    Ok(out)
}

fn decode_image_file(path: &Path) -> Result<DesktopWallpaperCpu, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!("image too large: {} bytes", meta.len()));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let img = decode_bytes_to_dynamic(&bytes, path)?;
    let rgba = rgba8_capped(img.to_rgba8(), MAX_IMAGE_DIMENSION);
    let (w, h) = rgba.dimensions();
    let raw = rgba.as_raw();
    let bgra = rgba_to_argb8888_bytes(raw, w, h).ok_or_else(|| "pixel convert".to_string())?;
    Ok(DesktopWallpaperCpu {
        bgra,
        w: w as i32,
        h: h as i32,
    })
}

pub fn load_from_display_file_into(state: &mut crate::state::CompositorState) {
    let Some(path) = crate::display_config::display_config_path() else {
        return;
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            tracing::warn!(target: "derp_wallpaper", ?e, "read display config");
            return;
        }
    };
    let cfg_file: crate::display_config::DisplayConfigFile = match serde_json::from_str(&raw) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(target: "derp_wallpaper", ?e, "parse display config");
            return;
        }
    };
    if cfg_file.version != 1 {
        return;
    }
    state.apply_desktop_background_from_display_file(&cfg_file);
}
