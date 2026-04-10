//! Scan XDG `applications` directories and parse `.desktop` entries for the shell Programs menu.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone, Debug, Serialize)]
pub struct DesktopApp {
    pub name: String,
    pub exec: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generic_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_name: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub keywords: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub terminal: bool,
    pub desktop_id: String,
}

struct DesktopAppsCache {
    state: Arc<Mutex<DesktopAppsCacheState>>,
    _watcher: Option<RecommendedWatcher>,
}

#[derive(Default)]
struct DesktopAppsCacheState {
    json: Option<String>,
    dirty: bool,
}

static DESKTOP_APPS_CACHE: OnceLock<DesktopAppsCache> = OnceLock::new();

#[derive(Default)]
struct DesktopEntryRaw {
    type_: Option<String>,
    hidden: bool,
    no_display: bool,
    name: Option<String>,
    name_locale: HashMap<String, String>,
    generic_name: Option<String>,
    generic_name_locale: HashMap<String, String>,
    full_name: Option<String>,
    full_name_locale: HashMap<String, String>,
    keywords: Vec<String>,
    keywords_locale: HashMap<String, Vec<String>>,
    exec: Option<String>,
    icon: Option<String>,
    terminal: bool,
}

pub fn list_applications_json() -> Result<String, String> {
    applications_cache().list_json()
}

pub fn warm_applications_cache() {
    if let Err(e) = applications_cache().list_json() {
        tracing::warn!("desktop apps cache warm failed: {e}");
    }
}

pub fn scan_applications() -> Result<Vec<DesktopApp>, String> {
    let mut out: Vec<DesktopApp> = Vec::new();
    let mut masked_ids = HashSet::new();
    for dir in application_dirs() {
        if !dir.is_dir() {
            continue;
        }
        for path in desktop_files_in_dir(&dir)? {
            let Some(desktop_id) = desktop_id_for_path(&dir, &path) else {
                continue;
            };
            if !masked_ids.insert(desktop_id.clone()) {
                continue;
            }
            let raw = match parse_desktop_file_path(&path) {
                Ok(Some(r)) => r,
                Ok(None) => continue,
                Err(_) => continue,
            };
            if !include_entry(&raw) {
                continue;
            }
            let Some(exec_line) = raw.exec.clone() else {
                continue;
            };
            let exec = strip_exec_field_codes(&exec_line);
            let exec = exec.trim();
            if exec.is_empty() {
                continue;
            }
            if exec.len() > shell_wire::MAX_SPAWN_COMMAND_BYTES as usize {
                continue;
            }
            let Some(name) = pick_display_name(&raw) else {
                continue;
            };
            out.push(DesktopApp {
                name,
                exec: exec.to_string(),
                executable: extract_search_executable(&exec_line),
                generic_name: pick_generic_name(&raw),
                full_name: pick_full_name(&raw),
                keywords: pick_keywords(&raw),
                icon: raw.icon.clone().filter(|s| !s.is_empty()),
                terminal: raw.terminal,
                desktop_id,
            });
        }
    }

    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.desktop_id.cmp(&b.desktop_id))
    });

    Ok(out)
}

fn applications_cache() -> &'static DesktopAppsCache {
    DESKTOP_APPS_CACHE.get_or_init(DesktopAppsCache::new)
}

fn lock_cache_state(
    state: &Mutex<DesktopAppsCacheState>,
) -> std::sync::MutexGuard<'_, DesktopAppsCacheState> {
    state.lock().unwrap_or_else(|poison| poison.into_inner())
}

impl DesktopAppsCache {
    fn new() -> Self {
        let state = Arc::new(Mutex::new(DesktopAppsCacheState {
            json: None,
            dirty: true,
        }));
        let mut watcher = match notify::recommended_watcher({
            let state = state.clone();
            move |event: notify::Result<notify::Event>| {
                if let Err(e) = event {
                    tracing::warn!("desktop apps watch failed: {e}");
                }
                lock_cache_state(&state).dirty = true;
            }
        }) {
            Ok(watcher) => Some(watcher),
            Err(e) => {
                tracing::warn!("desktop apps watcher init failed: {e}");
                None
            }
        };
        if let Some(watcher) = watcher.as_mut() {
            for dir in application_dirs() {
                if !dir.is_dir() {
                    continue;
                }
                if let Err(e) = watcher.watch(&dir, RecursiveMode::Recursive) {
                    tracing::warn!("desktop apps watch failed for {}: {e}", dir.display());
                }
            }
        }
        Self {
            state,
            _watcher: watcher,
        }
    }

    fn list_json(&self) -> Result<String, String> {
        let mut state = lock_cache_state(&self.state);
        if !state.dirty {
            if let Some(json) = state.json.as_ref() {
                return Ok(json.clone());
            }
        }
        let apps = scan_applications()?;
        let json = serde_json::to_string(&serde_json::json!({ "apps": apps }))
            .map_err(|e| e.to_string())?;
        state.json = Some(json.clone());
        state.dirty = false;
        Ok(json)
    }
}

fn application_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    let data_home = std::env::var_os("XDG_DATA_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|h| {
                let mut p = PathBuf::from(h);
                p.push(".local/share/applications");
                p
            })
        });
    if let Some(p) = data_home {
        dirs.push(p);
    }

    let data_dirs = std::env::var_os("XDG_DATA_DIRS")
        .unwrap_or_else(|| std::ffi::OsString::from("/usr/local/share:/usr/share"));
    for part in std::env::split_paths(&data_dirs) {
        if part.as_os_str().is_empty() {
            continue;
        }
        dirs.push(part.join("applications"));
    }

    dirs
}

fn desktop_files_in_dir(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    walk_desktop_files(dir, dir, &mut out)?;
    out.sort();
    Ok(out)
}

fn walk_desktop_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let mut children = fs::read_dir(dir)
        .map_err(|e| format!("read_dir {}: {e}", dir.display()))?
        .flatten()
        .map(|ent| ent.path())
        .collect::<Vec<_>>();
    children.sort();
    for path in children {
        if path.is_dir() {
            walk_desktop_files(root, &path, out)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("desktop") {
            continue;
        }
        if path.strip_prefix(root).is_ok() {
            out.push(path);
        }
    }
    Ok(())
}

fn desktop_id_for_path(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let rel = rel.to_string_lossy();
    if rel.is_empty() {
        return None;
    }
    Some(rel.replace(['\\', '/'], "-"))
}

fn parse_desktop_file_path(path: &Path) -> Result<Option<DesktopEntryRaw>, std::io::Error> {
    let s = fs::read_to_string(path)?;
    Ok(parse_desktop_contents(&s))
}

fn parse_desktop_contents(raw: &str) -> Option<DesktopEntryRaw> {
    let mut in_desktop_entry = false;
    let mut e = DesktopEntryRaw::default();

    for line in raw.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            let sec = line[1..line.len() - 1].trim();
            in_desktop_entry = sec.eq_ignore_ascii_case("desktop entry");
            continue;
        }
        if !in_desktop_entry {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let key = k.trim();
        let val = v.trim();
        if key == "Type" {
            e.type_ = Some(val.to_string());
        } else if key == "Hidden" {
            e.hidden = parse_bool(val);
        } else if key == "NoDisplay" {
            e.no_display = parse_bool(val);
        } else if key == "Name" {
            e.name = Some(val.to_string());
        } else if let Some(loc) = key.strip_prefix("Name[").and_then(|s| s.strip_suffix(']')) {
            e.name_locale.insert(loc.to_string(), val.to_string());
        } else if key == "GenericName" {
            e.generic_name = Some(val.to_string());
        } else if let Some(loc) = key
            .strip_prefix("GenericName[")
            .and_then(|s| s.strip_suffix(']'))
        {
            e.generic_name_locale.insert(loc.to_string(), val.to_string());
        } else if key == "X-GNOME-FullName" {
            e.full_name = Some(val.to_string());
        } else if let Some(loc) = key
            .strip_prefix("X-GNOME-FullName[")
            .and_then(|s| s.strip_suffix(']'))
        {
            e.full_name_locale.insert(loc.to_string(), val.to_string());
        } else if key == "Keywords" {
            e.keywords = split_keywords(val);
        } else if let Some(loc) = key.strip_prefix("Keywords[").and_then(|s| s.strip_suffix(']')) {
            e.keywords_locale.insert(loc.to_string(), split_keywords(val));
        } else if key == "Exec" {
            e.exec = Some(val.to_string());
        } else if key == "Icon" {
            e.icon = Some(val.to_string());
        } else if key == "Terminal" {
            e.terminal = parse_bool(val);
        }
    }

    Some(e)
}

fn parse_bool(s: &str) -> bool {
    matches!(s.to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on")
}

fn include_entry(e: &DesktopEntryRaw) -> bool {
    if e.hidden || e.no_display {
        return false;
    }
    match e.type_.as_deref() {
        None => true,
        Some(t) if t.eq_ignore_ascii_case("application") => true,
        _ => false,
    }
}

fn pick_display_name(e: &DesktopEntryRaw) -> Option<String> {
    pick_localized_string(&e.name, &e.name_locale).or_else(|| pick_generic_name(e))
}

fn pick_generic_name(e: &DesktopEntryRaw) -> Option<String> {
    pick_localized_string(&e.generic_name, &e.generic_name_locale)
}

fn pick_full_name(e: &DesktopEntryRaw) -> Option<String> {
    pick_localized_string(&e.full_name, &e.full_name_locale)
}

fn pick_keywords(e: &DesktopEntryRaw) -> Vec<String> {
    pick_localized_list(&e.keywords, &e.keywords_locale)
}

fn locale_candidates() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(lang) = std::env::var("LANG") {
        let base = lang.split('.').next().unwrap_or(&lang);
        if !base.is_empty() {
            out.push(base.to_string());
            if let Some((short, _)) = base.split_once('_') {
                if !short.is_empty() && short != base {
                    out.push(short.to_string());
                }
            }
        }
    }
    out
}

fn pick_localized_string(
    primary: &Option<String>,
    localized: &HashMap<String, String>,
) -> Option<String> {
    if let Some(v) = primary {
        if !v.is_empty() {
            return Some(v.clone());
        }
    }
    for lang in locale_candidates() {
        if let Some(v) = localized.get(&lang) {
            if !v.is_empty() {
                return Some(v.clone());
            }
        }
    }
    localized
        .values()
        .find(|v| !v.is_empty())
        .map(|v| v.clone())
}

fn pick_localized_list(primary: &[String], localized: &HashMap<String, Vec<String>>) -> Vec<String> {
    if !primary.is_empty() {
        return primary.to_vec();
    }
    for lang in locale_candidates() {
        if let Some(values) = localized.get(&lang) {
            let values = values
                .iter()
                .filter(|v| !v.is_empty())
                .cloned()
                .collect::<Vec<_>>();
            if !values.is_empty() {
                return values;
            }
        }
    }
    localized
        .values()
        .find(|values| values.iter().any(|v| !v.is_empty()))
        .map(|values| {
            values
                .iter()
                .filter(|v| !v.is_empty())
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn split_keywords(value: &str) -> Vec<String> {
    value
        .split(';')
        .map(str::trim)
        .filter(|keyword| !keyword.is_empty())
        .map(str::to_string)
        .collect()
}

fn extract_search_executable(exec: &str) -> Option<String> {
    let first = shell_words(exec).into_iter().next()?;
    let basename = Path::new(&first)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(first.as_str())
        .to_string();
    if basename.is_empty() {
        return None;
    }
    if matches!(
        basename.as_str(),
        "bash"
            | "env"
            | "flatpak"
            | "snap"
            | "gjs"
            | "pkexec"
            | "python"
            | "python2"
            | "python3"
            | "sh"
            | "wine"
            | "wine64"
    ) {
        return None;
    }
    Some(basename)
}

fn shell_words(exec: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut chars = exec.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
                continue;
            }
            if ch == '\\' {
                if let Some(next) = chars.next() {
                    buf.push(next);
                }
                continue;
            }
            buf.push(ch);
            continue;
        }
        match ch {
            '"' | '\'' => {
                quote = Some(ch);
            }
            '\\' => {
                if let Some(next) = chars.next() {
                    buf.push(next);
                }
            }
            c if c.is_whitespace() => {
                if !buf.is_empty() {
                    out.push(std::mem::take(&mut buf));
                }
            }
            _ => buf.push(ch),
        }
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

fn strip_exec_field_codes(exec: &str) -> String {
    let mut out = String::with_capacity(exec.len());
    let bytes = exec.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 1 < bytes.len() {
            let next = bytes[i + 1];
            if next == b'%' {
                out.push('%');
                i += 2;
                continue;
            }
            if next.is_ascii_alphabetic() {
                match next {
                    b'f' | b'F' | b'u' | b'U' | b'd' | b'D' | b'n' | b'N' | b'i' | b'c' | b'k'
                    | b'v' | b'm' | b'w' | b'W' => {
                        i += 2;
                        continue;
                    }
                    _ => {}
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out.trim().to_string()
}
