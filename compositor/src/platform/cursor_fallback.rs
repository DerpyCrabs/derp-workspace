use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;
use smithay::{
    backend::renderer::element::memory::MemoryRenderBuffer,
    input::pointer::CursorIcon,
    utils::{Rectangle, Size, Transform},
};

use crate::{
    render::shell_overlay::SHELL_OSR_MEMORY_FOURCC, session::settings_config::CursorSettingsFile,
};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CursorCacheKey {
    icon: CursorIconKey,
    scale_milli: u32,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum CursorIconKey {
    Default,
    ContextMenu,
    Help,
    Pointer,
    Progress,
    Wait,
    Cell,
    Crosshair,
    Text,
    VerticalText,
    Alias,
    Copy,
    Move,
    NoDrop,
    NotAllowed,
    Grab,
    Grabbing,
    EResize,
    NResize,
    NeResize,
    NwResize,
    SResize,
    SeResize,
    SwResize,
    WResize,
    EwResize,
    NsResize,
    NeswResize,
    NwseResize,
    ColResize,
    RowResize,
    AllScroll,
    ZoomIn,
    ZoomOut,
    DndAsk,
    AllResize,
}

pub struct CursorImageBuffer {
    pub buffer: MemoryRenderBuffer,
    pub hotspot_physical: (i32, i32),
    pub name: String,
    pub source_path: Option<PathBuf>,
}

struct CursorThemeState {
    settings: CursorSettingsFile,
    theme: xcursor::CursorTheme,
    cache: HashMap<CursorCacheKey, CursorImageBuffer>,
}

pub struct CursorThemeManager {
    inner: Mutex<CursorThemeState>,
}

#[derive(Serialize)]
struct CursorThemeList {
    items: Vec<String>,
}

impl CursorIconKey {
    pub fn from_icon(icon: &CursorIcon) -> Self {
        match icon {
            CursorIcon::Default => Self::Default,
            CursorIcon::ContextMenu => Self::ContextMenu,
            CursorIcon::Help => Self::Help,
            CursorIcon::Pointer => Self::Pointer,
            CursorIcon::Progress => Self::Progress,
            CursorIcon::Wait => Self::Wait,
            CursorIcon::Cell => Self::Cell,
            CursorIcon::Crosshair => Self::Crosshair,
            CursorIcon::Text => Self::Text,
            CursorIcon::VerticalText => Self::VerticalText,
            CursorIcon::Alias => Self::Alias,
            CursorIcon::Copy => Self::Copy,
            CursorIcon::Move => Self::Move,
            CursorIcon::NoDrop => Self::NoDrop,
            CursorIcon::NotAllowed => Self::NotAllowed,
            CursorIcon::Grab => Self::Grab,
            CursorIcon::Grabbing => Self::Grabbing,
            CursorIcon::EResize => Self::EResize,
            CursorIcon::NResize => Self::NResize,
            CursorIcon::NeResize => Self::NeResize,
            CursorIcon::NwResize => Self::NwResize,
            CursorIcon::SResize => Self::SResize,
            CursorIcon::SeResize => Self::SeResize,
            CursorIcon::SwResize => Self::SwResize,
            CursorIcon::WResize => Self::WResize,
            CursorIcon::EwResize => Self::EwResize,
            CursorIcon::NsResize => Self::NsResize,
            CursorIcon::NeswResize => Self::NeswResize,
            CursorIcon::NwseResize => Self::NwseResize,
            CursorIcon::ColResize => Self::ColResize,
            CursorIcon::RowResize => Self::RowResize,
            CursorIcon::AllScroll => Self::AllScroll,
            CursorIcon::ZoomIn => Self::ZoomIn,
            CursorIcon::ZoomOut => Self::ZoomOut,
            CursorIcon::DndAsk => Self::DndAsk,
            CursorIcon::AllResize => Self::AllResize,
            _ => Self::Default,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::ContextMenu => "context-menu",
            Self::Help => "help",
            Self::Pointer => "pointer",
            Self::Progress => "progress",
            Self::Wait => "wait",
            Self::Cell => "cell",
            Self::Crosshair => "crosshair",
            Self::Text => "text",
            Self::VerticalText => "vertical-text",
            Self::Alias => "alias",
            Self::Copy => "copy",
            Self::Move => "move",
            Self::NoDrop => "no-drop",
            Self::NotAllowed => "not-allowed",
            Self::Grab => "grab",
            Self::Grabbing => "grabbing",
            Self::EResize => "e-resize",
            Self::NResize => "n-resize",
            Self::NeResize => "ne-resize",
            Self::NwResize => "nw-resize",
            Self::SResize => "s-resize",
            Self::SeResize => "se-resize",
            Self::SwResize => "sw-resize",
            Self::WResize => "w-resize",
            Self::EwResize => "ew-resize",
            Self::NsResize => "ns-resize",
            Self::NeswResize => "nesw-resize",
            Self::NwseResize => "nwse-resize",
            Self::ColResize => "col-resize",
            Self::RowResize => "row-resize",
            Self::AllScroll => "all-scroll",
            Self::ZoomIn => "zoom-in",
            Self::ZoomOut => "zoom-out",
            Self::DndAsk => "dnd-ask",
            Self::AllResize => "all-resize",
        }
    }
}

pub fn cursor_icon_names(icon: CursorIconKey) -> &'static [&'static str] {
    match icon {
        CursorIconKey::Default => &["left_ptr", "default", "arrow"],
        CursorIconKey::ContextMenu => &["context-menu", "left_ptr"],
        CursorIconKey::Help => &["help", "question_arrow", "left_ptr"],
        CursorIconKey::Pointer => &["pointer", "hand2", "hand1", "pointing_hand", "left_ptr"],
        CursorIconKey::Progress => &["progress", "left_ptr_watch", "watch", "left_ptr"],
        CursorIconKey::Wait => &["wait", "watch", "left_ptr_watch"],
        CursorIconKey::Cell => &["cell", "crosshair"],
        CursorIconKey::Crosshair => &["crosshair", "tcross"],
        CursorIconKey::Text => &["text", "xterm", "ibeam"],
        CursorIconKey::VerticalText => &["vertical-text", "vertical_text", "xterm"],
        CursorIconKey::Alias => &["alias", "dnd-link", "link", "left_ptr"],
        CursorIconKey::Copy => &["copy", "dnd-copy", "left_ptr"],
        CursorIconKey::Move => &["move", "fleur", "all-scroll"],
        CursorIconKey::NoDrop => &["no-drop", "dnd-no-drop", "not-allowed"],
        CursorIconKey::NotAllowed => &["not-allowed", "crossed_circle", "no-drop"],
        CursorIconKey::Grab => &["grab", "openhand", "hand1"],
        CursorIconKey::Grabbing => &["grabbing", "closedhand", "dnd-move", "move"],
        CursorIconKey::EResize => &["e-resize", "right_side", "ew-resize"],
        CursorIconKey::NResize => &["n-resize", "top_side", "ns-resize"],
        CursorIconKey::NeResize => &["ne-resize", "top_right_corner", "nesw-resize"],
        CursorIconKey::NwResize => &["nw-resize", "top_left_corner", "nwse-resize"],
        CursorIconKey::SResize => &["s-resize", "bottom_side", "ns-resize"],
        CursorIconKey::SeResize => &["se-resize", "bottom_right_corner", "nwse-resize"],
        CursorIconKey::SwResize => &["sw-resize", "bottom_left_corner", "nesw-resize"],
        CursorIconKey::WResize => &["w-resize", "left_side", "ew-resize"],
        CursorIconKey::EwResize => &["ew-resize", "h_double_arrow", "sb_h_double_arrow"],
        CursorIconKey::NsResize => &["ns-resize", "v_double_arrow", "sb_v_double_arrow"],
        CursorIconKey::NeswResize => &["nesw-resize", "fd_double_arrow", "size_bdiag"],
        CursorIconKey::NwseResize => &["nwse-resize", "bd_double_arrow", "size_fdiag"],
        CursorIconKey::ColResize => &["col-resize", "split_h", "ew-resize"],
        CursorIconKey::RowResize => &["row-resize", "split_v", "ns-resize"],
        CursorIconKey::AllScroll => &["all-scroll", "all_scroll", "fleur"],
        CursorIconKey::ZoomIn => &["zoom-in", "zoom_in", "left_ptr"],
        CursorIconKey::ZoomOut => &["zoom-out", "zoom_out", "left_ptr"],
        CursorIconKey::DndAsk => &["dnd-ask", "dnd-link", "help", "left_ptr"],
        CursorIconKey::AllResize => &["all-resize", "all_scroll", "fleur"],
    }
}

fn rgba_strip_to_shell_bgra(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let n = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if rgba.len() < n {
        return None;
    }
    let mut out = Vec::with_capacity(n);
    for px in rgba[..n].chunks_exact(4) {
        out.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
    }
    Some(out)
}

fn pick_image(
    images: &[xcursor::parser::Image],
    target_size: u32,
) -> Option<&xcursor::parser::Image> {
    images.iter().min_by_key(|img| {
        let nominal = img.size.max(img.width.max(img.height));
        (nominal as i64 - target_size as i64).abs()
    })
}

fn image_to_buffer(
    img: &xcursor::parser::Image,
    name: &str,
    source_path: Option<PathBuf>,
) -> Option<CursorImageBuffer> {
    let w = img.width as i32;
    let h = img.height as i32;
    if w <= 0 || h <= 0 {
        return None;
    }
    let bgra = rgba_strip_to_shell_bgra(img.width, img.height, &img.pixels_rgba)?;
    let mut buf =
        MemoryRenderBuffer::new(SHELL_OSR_MEMORY_FOURCC, (w, h), 1, Transform::Normal, None);
    {
        let mut ctx = buf.render();
        ctx.draw(|mem| {
            mem[..bgra.len()].copy_from_slice(&bgra);
            Result::<_, ()>::Ok(vec![Rectangle::from_size(Size::from((w, h)))])
        })
        .ok()?;
    }
    Some(CursorImageBuffer {
        buffer: buf,
        hotspot_physical: (
            img.xhot.min(img.width.saturating_sub(1)) as i32,
            img.yhot.min(img.height.saturating_sub(1)) as i32,
        ),
        name: name.to_string(),
        source_path,
    })
}

fn build_vector_fallback(name: &str) -> CursorImageBuffer {
    const W: i32 = 24;
    const H: i32 = 24;
    let mut buf =
        MemoryRenderBuffer::new(SHELL_OSR_MEMORY_FOURCC, (W, H), 1, Transform::Normal, None);
    {
        let mut ctx = buf.render();
        ctx.draw(|mem| {
            mem.fill(0);
            let outline = [24u8, 24u8, 28u8, 255u8];
            let fill = [0xf8u8, 0xf8u8, 0xfcu8, 255u8];
            for y in 0..17 {
                let i = ((y * W) * 4) as usize;
                mem[i..i + 4].copy_from_slice(&outline);
                if (1..=15).contains(&y) {
                    let i2 = ((y * W + 1) * 4) as usize;
                    mem[i2..i2 + 4].copy_from_slice(&fill);
                }
            }
            for x in 1..12 {
                let y = x;
                if y >= H {
                    break;
                }
                let i = ((y * W + x) * 4) as usize;
                mem[i..i + 4].copy_from_slice(&outline);
                if x >= 2 && y + 1 < H {
                    let i2 = (((y + 1) * W + x) * 4) as usize;
                    mem[i2..i2 + 4].copy_from_slice(&fill);
                }
            }
            Result::<_, ()>::Ok(vec![Rectangle::from_size(Size::from((W, H)))])
        })
        .expect("builtin cursor fallback");
    }
    CursorImageBuffer {
        buffer: buf,
        hotspot_physical: (0, 0),
        name: name.to_string(),
        source_path: None,
    }
}

fn load_icon_buffer(
    theme: &xcursor::CursorTheme,
    icon: CursorIconKey,
    target_size: u32,
) -> CursorImageBuffer {
    for name in cursor_icon_names(icon) {
        let Some(path) = theme.load_icon(name) else {
            continue;
        };
        let Ok(data) = std::fs::read(&path) else {
            continue;
        };
        let Some(images) = xcursor::parser::parse_xcursor(&data) else {
            continue;
        };
        let Some(img) = pick_image(&images, target_size) else {
            continue;
        };
        if let Some(buf) = image_to_buffer(img, name, Some(path)) {
            return buf;
        }
    }
    if icon != CursorIconKey::Default {
        return load_icon_buffer(theme, CursorIconKey::Default, target_size);
    }
    tracing::warn!("cursor_theme: no Xcursor default icon; using builtin arrow");
    build_vector_fallback("builtin")
}

impl CursorThemeManager {
    pub fn new(settings: CursorSettingsFile) -> Self {
        let theme = xcursor::CursorTheme::load(&settings.theme);
        Self {
            inner: Mutex::new(CursorThemeState {
                settings,
                theme,
                cache: HashMap::new(),
            }),
        }
    }

    pub fn settings(&self) -> CursorSettingsFile {
        self.inner
            .lock()
            .map(|inner| inner.settings.clone())
            .unwrap_or_default()
    }

    pub fn apply_settings(&self, settings: CursorSettingsFile) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.settings == settings {
                return;
            }
            inner.theme = xcursor::CursorTheme::load(&settings.theme);
            inner.settings = settings;
            inner.cache.clear();
        }
    }

    pub fn with_cursor<R>(
        &self,
        icon: &CursorIcon,
        scale: f64,
        f: impl FnOnce(&CursorImageBuffer, &CursorSettingsFile, CursorIconKey) -> R,
    ) -> Option<R> {
        let icon = CursorIconKey::from_icon(icon);
        let scale_milli = ((scale.max(0.25) * 1000.0).round() as u32).max(1);
        let mut inner = self.inner.lock().ok()?;
        let key = CursorCacheKey { icon, scale_milli };
        if !inner.cache.contains_key(&key) {
            let target = ((inner.settings.size as f64) * scale.max(0.25))
                .round()
                .max(1.0) as u32;
            let buf = load_icon_buffer(&inner.theme, icon, target);
            inner.cache.insert(key.clone(), buf);
        }
        let buf = inner.cache.get(&key)?;
        Some(f(buf, &inner.settings, icon))
    }
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir())
}

pub fn cursor_theme_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = user_home_dir() {
        dirs.push(home.join(".icons"));
        dirs.push(home.join(".local").join("share").join("icons"));
    }
    dirs.push(PathBuf::from("/usr/share/icons"));
    dirs.push(PathBuf::from("/usr/local/share/icons"));
    dirs
}

fn cursor_theme_name_from_dir(dir: &Path) -> Option<String> {
    let name = dir.file_name()?.to_string_lossy();
    if name.is_empty() || name.starts_with('.') {
        return None;
    }
    let has_cursors = dir.join("cursors").is_dir();
    let has_index = dir.join("index.theme").is_file();
    (has_cursors || has_index).then(|| name.to_string())
}

pub fn discover_cursor_themes_from_dirs(dirs: &[PathBuf]) -> Vec<String> {
    let mut names = BTreeSet::new();
    for root in dirs {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(name) = cursor_theme_name_from_dir(&path) {
                names.insert(name);
            }
        }
    }
    if names.is_empty() {
        names.insert("default".to_string());
    }
    names.into_iter().collect()
}

pub fn cursor_themes_json() -> Result<String, String> {
    serde_json::to_string(&CursorThemeList {
        items: discover_cursor_themes_from_dirs(&cursor_theme_search_dirs()),
    })
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        cursor_icon_names, discover_cursor_themes_from_dirs, CursorIconKey, CursorSettingsFile,
        CursorThemeManager,
    };

    #[test]
    fn cursor_icon_names_include_pointer_hand_fallbacks() {
        assert!(cursor_icon_names(CursorIconKey::Pointer).contains(&"pointer"));
        assert!(cursor_icon_names(CursorIconKey::Pointer).contains(&"hand2"));
        assert!(cursor_icon_names(CursorIconKey::Text).contains(&"xterm"));
    }

    #[test]
    fn discovers_cursor_theme_dirs() {
        let root =
            std::env::temp_dir().join(format!("derp-cursor-theme-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("ThemeA").join("cursors")).unwrap();
        std::fs::create_dir_all(root.join("ThemeB")).unwrap();
        std::fs::write(root.join("ThemeB").join("index.theme"), "[Icon Theme]\n").unwrap();
        std::fs::create_dir_all(root.join(".hidden").join("cursors")).unwrap();
        let names = discover_cursor_themes_from_dirs(&[root.clone()]);
        assert_eq!(names, vec!["ThemeA".to_string(), "ThemeB".to_string()]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn manager_applies_settings_without_recreating_shell_state() {
        let manager = CursorThemeManager::new(CursorSettingsFile {
            theme: "default".into(),
            size: 24,
        });
        manager.apply_settings(CursorSettingsFile {
            theme: "Adwaita".into(),
            size: 32,
        });
        assert_eq!(
            manager.settings(),
            CursorSettingsFile {
                theme: "Adwaita".into(),
                size: 32,
            }
        );
    }
}
