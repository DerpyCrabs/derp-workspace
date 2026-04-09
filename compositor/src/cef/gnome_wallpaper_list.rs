use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const BG_DIR: &str = "/usr/share/backgrounds";
const PROP_DIR: &str = "/usr/share/gnome-background-properties";

#[derive(Serialize)]
pub struct GnomeWallpaperItem {
    pub file_uri: String,
    pub label: String,
}

fn path_to_file_uri(abs: &Path) -> String {
    let s = abs.to_string_lossy();
    format!("file://{}", s)
}

fn first_tag_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open_prefix = format!("<{tag}");
    let close = format!("</{tag}>");
    let i = xml.find(&open_prefix)?;
    let after = &xml[i + open_prefix.len()..];
    let body_start = after.find('>')? + 1;
    let inner = &after[body_start..];
    let k = inner.find(&close)?;
    let text = inner[..k].trim();
    if text.is_empty() || text.contains('<') {
        return None;
    }
    Some(text)
}

fn all_filename_values(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    let open_pat = "<filename";
    let close_pat = "</filename>";
    while let Some(i) = rest.find(open_pat) {
        let after_tag = &rest[i + open_pat.len()..];
        let body_start = match after_tag.find('>') {
            Some(j) => j + 1,
            None => break,
        };
        let inner = &after_tag[body_start..];
        let Some(k) = inner.find(close_pat) else {
            break;
        };
        let raw = inner[..k].trim();
        if !raw.is_empty() && !raw.contains('<') {
            out.push(raw.to_string());
        }
        rest = &inner[k + close_pat.len()..];
    }
    out
}

fn parse_wallpaper_xml_into(xml: &str, items: &mut Vec<(String, String)>) {
    let mut rest = xml;
    let open = "<wallpaper";
    let close = "</wallpaper>";
    while let Some(i) = rest.find(open) {
        let after = &rest[i + open.len()..];
        let Some(j) = after.find(close) else {
            break;
        };
        let block = &after[..j];
        let name = first_tag_text(block, "name")
            .map(str::trim)
            .filter(|s| !s.is_empty());
        for path_raw in all_filename_values(block) {
            let path = path_raw.trim();
            if path.starts_with('/') {
                let label = name
                    .map(str::to_string)
                    .unwrap_or_else(|| Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(path).to_string());
                items.push((path.to_string(), label));
            }
        }
        rest = &after[j + close.len()..];
    }
}

fn read_xml_wallpapers(items: &mut Vec<(String, String)>) {
    let Ok(rd) = std::fs::read_dir(PROP_DIR) else {
        return;
    };
    for ent in rd.flatten() {
        let p = ent.path();
        if p.extension().and_then(|x| x.to_str()).map(|e| e.eq_ignore_ascii_case("xml")) != Some(true) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        parse_wallpaper_xml_into(&text, items);
    }
}

fn image_extension_ok(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "jxl"
    )
}

fn scan_backgrounds_dir(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if depth > 14 || !dir.is_dir() {
        return Ok(());
    }
    for ent in std::fs::read_dir(dir)? {
        let ent = ent?;
        let p = ent.path();
        let ft = ent.file_type()?;
        if ft.is_dir() {
            scan_backgrounds_dir(&p, depth + 1, out)?;
        } else if ft.is_file() {
            if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                if image_extension_ok(ext) {
                    out.push(p);
                }
            }
        }
    }
    Ok(())
}

fn dedup_sort(items: Vec<(String, String)>) -> Vec<GnomeWallpaperItem> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut v: Vec<GnomeWallpaperItem> = items
        .into_iter()
        .filter_map(|(path, label)| {
            let pb = PathBuf::from(&path);
            if !pb.is_file() {
                return None;
            }
            let canon = pb.canonicalize().unwrap_or(pb);
            let key = canon.to_string_lossy().to_string();
            if !seen.insert(key.clone()) {
                return None;
            }
            Some(GnomeWallpaperItem {
                file_uri: path_to_file_uri(&canon),
                label,
            })
        })
        .collect();
    v.sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.file_uri.cmp(&b.file_uri)));
    v
}

pub fn list_gnome_wallpapers_json() -> Result<String, String> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    read_xml_wallpapers(&mut pairs);
    let mut paths: Vec<PathBuf> = Vec::new();
    let bg = Path::new(BG_DIR);
    if bg.is_dir() {
        let _ = scan_backgrounds_dir(bg, 0, &mut paths);
    }
    for p in paths {
        let Ok(c) = p.canonicalize() else {
            continue;
        };
        let s = c.to_string_lossy().to_string();
        let label = c
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&s)
            .to_string();
        pairs.push((s, label));
    }
    let items = dedup_sort(pairs);
    serde_json::to_string(&serde_json::json!({ "items": items })).map_err(|e| e.to_string())
}
