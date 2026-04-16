use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{SystemTime, UNIX_EPOCH};

use image::{DynamicImage, ImageEncoder};
use jxl_oxide::integration::JxlDecoder;

const MAX_IMAGE_BYTES: u64 = 48 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 8192;
const PREVIEW_JPEG_MAX_EDGE: u32 = 480;
const PREVIEW_JPEG_QUALITY: u8 = 82;
const PREVIEW_CACHE_VERSION: u32 = 1;

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
    let n = (w as usize).checked_mul(h as usize)?.checked_mul(4)?;
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
            let dec = JxlDecoder::new(Cursor::new(bytes))
                .map_err(|e| format!("decode {}: {e0}; jxl init: {e}", path_for_err.display()))?;
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

fn wallpaper_preview_cache_root() -> PathBuf {
    if let Some(base) = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && !p.as_os_str().is_empty())
    {
        return base.join("derp").join("wallpaper-preview");
    }
    if let Some(home) = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && !p.as_os_str().is_empty())
    {
        return home.join(".cache").join("derp").join("wallpaper-preview");
    }
    std::env::temp_dir().join("derp-wallpaper-preview")
}

fn wallpaper_preview_cache_key(path: &Path, meta: &std::fs::Metadata) -> u64 {
    let mut hasher = DefaultHasher::new();
    PREVIEW_CACHE_VERSION.hash(&mut hasher);
    PREVIEW_JPEG_MAX_EDGE.hash(&mut hasher);
    PREVIEW_JPEG_QUALITY.hash(&mut hasher);
    path.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    meta.modified()
        .ok()
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map(|v| v.as_nanos())
        .unwrap_or(0)
        .hash(&mut hasher);
    hasher.finish()
}

fn wallpaper_preview_cache_path(
    cache_root: &Path,
    path: &Path,
    meta: &std::fs::Metadata,
) -> PathBuf {
    cache_root.join(format!(
        "{:016x}.jpg",
        wallpaper_preview_cache_key(path, meta)
    ))
}

fn read_wallpaper_preview_cache(
    cache_root: &Path,
    path: &Path,
    meta: &std::fs::Metadata,
) -> Option<Vec<u8>> {
    let cache_path = wallpaper_preview_cache_path(cache_root, path, meta);
    std::fs::read(cache_path)
        .ok()
        .filter(|bytes| !bytes.is_empty())
}

fn write_wallpaper_preview_cache(
    cache_root: &Path,
    path: &Path,
    meta: &std::fs::Metadata,
    jpeg: &[u8],
) -> Result<(), String> {
    std::fs::create_dir_all(cache_root)
        .map_err(|e| format!("mkdir {}: {e}", cache_root.display()))?;
    let cache_path = wallpaper_preview_cache_path(cache_root, path, meta);
    let tmp_name = format!(
        ".{:016x}.{}.tmp",
        wallpaper_preview_cache_key(path, meta),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|v| v.as_nanos())
            .unwrap_or(0)
    );
    let tmp_path = cache_root.join(tmp_name);
    std::fs::write(&tmp_path, jpeg).map_err(|e| format!("write {}: {e}", tmp_path.display()))?;
    match std::fs::rename(&tmp_path, &cache_path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&cache_path);
            std::fs::rename(&tmp_path, &cache_path)
                .map_err(|e2| format!("rename {}: {e}; replace: {e2}", cache_path.display()))?;
            Ok(())
        }
    }
}

pub fn encode_wallpaper_preview_jpeg(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!("image too large: {} bytes", meta.len()));
    }
    let cache_root = wallpaper_preview_cache_root();
    if let Some(jpeg) = read_wallpaper_preview_cache(&cache_root, path, &meta) {
        return Ok(jpeg);
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
    let _ = write_wallpaper_preview_cache(&cache_root, path, &meta, &out);
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
    let Some(path) = crate::controls::display_config::display_config_path() else {
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
    let cfg_file: crate::controls::display_config::DisplayConfigFile = match serde_json::from_str(&raw) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(label: &str) -> PathBuf {
        let base = std::env::temp_dir();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|v| v.as_nanos())
            .unwrap_or(0);
        let dir = base.join(format!("derp-{label}-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn wallpaper_preview_cache_reuses_matching_entry() {
        let root = unique_temp_dir("wallpaper-cache-hit");
        let source = root.join("source.png");
        let meta = std::fs::write(&source, b"abc")
            .and_then(|_| std::fs::metadata(&source))
            .unwrap();
        let jpeg = vec![1, 2, 3, 4];
        write_wallpaper_preview_cache(&root, &source, &meta, &jpeg).unwrap();
        assert_eq!(
            read_wallpaper_preview_cache(&root, &source, &meta),
            Some(jpeg)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn wallpaper_preview_cache_invalidates_when_source_changes() {
        let root = unique_temp_dir("wallpaper-cache-miss");
        let source = root.join("source.png");
        std::fs::write(&source, b"abc").unwrap();
        let meta1 = std::fs::metadata(&source).unwrap();
        write_wallpaper_preview_cache(&root, &source, &meta1, &[1, 2, 3]).unwrap();
        std::fs::write(&source, b"abcdef").unwrap();
        let meta2 = std::fs::metadata(&source).unwrap();
        assert_ne!(
            wallpaper_preview_cache_path(&root, &source, &meta1),
            wallpaper_preview_cache_path(&root, &source, &meta2)
        );
        assert_eq!(read_wallpaper_preview_cache(&root, &source, &meta2), None);
        let _ = std::fs::remove_dir_all(root);
    }
}
