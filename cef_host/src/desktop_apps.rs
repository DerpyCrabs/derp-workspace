//! Scan XDG `applications` directories and parse `.desktop` entries for the shell Programs menu.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize)]
pub struct DesktopApp {
    pub name: String,
    pub exec: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub terminal: bool,
    /// `file://` URL of the `.desktop` path (for disambiguation / debugging).
    pub desktop_id: String,
}

/// Key-value pairs from the `[Desktop Entry]` group.
#[derive(Default)]
struct DesktopEntryRaw {
    type_: Option<String>,
    hidden: bool,
    no_display: bool,
    name: Option<String>,
    generic_name: Option<String>,
    /// Locale -> value for Name
    name_locale: HashMap<String, String>,
    exec: Option<String>,
    icon: Option<String>,
    terminal: bool,
}

pub fn list_applications_json() -> Result<String, String> {
    let apps = scan_applications()?;
    serde_json::to_string(&serde_json::json!({ "apps": apps })).map_err(|e| e.to_string())
}

pub fn scan_applications() -> Result<Vec<DesktopApp>, String> {
    let mut out: Vec<DesktopApp> = Vec::new();
    for dir in application_dirs() {
        if !dir.is_dir() {
            continue;
        }
        let entries = fs::read_dir(&dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
        for ent in entries.flatten() {
            let path = ent.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|s| s.to_str()) != Some("desktop") {
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
            let desktop_id = path_to_file_url(&path);
            out.push(DesktopApp {
                name,
                exec: exec.to_string(),
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

    let data_dirs = std::env::var_os("XDG_DATA_DIRS").unwrap_or_else(|| {
        std::ffi::OsString::from("/usr/local/share:/usr/share")
    });
    for part in std::env::split_paths(&data_dirs) {
        if part.as_os_str().is_empty() {
            continue;
        }
        dirs.push(part.join("applications"));
    }

    dirs
}

fn path_to_file_url(path: &Path) -> String {
    let s = path.to_string_lossy();
    let encoded = percent_encode_path(&s);
    format!("file://{encoded}")
}

/// Minimal percent-encoding for path in file: URL (space and non-ASCII).
fn percent_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(b as char);
            }
            _ => {
                use std::fmt::Write;
                let _ = write!(&mut out, "%{b:02X}");
            }
        }
    }
    out
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
            e.name_locale
                .insert(loc.to_string(), val.to_string());
        } else if key == "GenericName" {
            e.generic_name = Some(val.to_string());
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
    matches!(
        s.to_ascii_lowercase().as_str(),
        "true" | "1" | "yes" | "on"
    )
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
    if let Some(n) = &e.name {
        if !n.is_empty() {
            return Some(n.clone());
        }
    }
    // Locale fallbacks: LANG like en_US.UTF-8 -> try Name[en_US], Name[en]
    if let Ok(lang) = std::env::var("LANG") {
        let base = lang.split('.').next().unwrap_or(&lang);
        if let Some(v) = e.name_locale.get(base) {
            if !v.is_empty() {
                return Some(v.clone());
            }
        }
        if let Some((short, _)) = base.split_once('_') {
            if let Some(v) = e.name_locale.get(short) {
                if !v.is_empty() {
                    return Some(v.clone());
                }
            }
        }
    }
    if let Some((_k, v)) = e.name_locale.iter().find(|(_, v)| !v.is_empty()) {
        return Some(v.clone());
    }
    e.generic_name
        .clone()
        .filter(|s| !s.is_empty())
}

fn strip_exec_field_codes(exec: &str) -> String {
    // Handle quoting poorly by still scanning for % — most entries are unquoted.
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
                // Desktop Entry Exec field codes (and deprecated w/W)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_exec_removes_field_codes() {
        assert_eq!(
            strip_exec_field_codes("/usr/bin/foot %F"),
            "/usr/bin/foot"
        );
        assert_eq!(
            strip_exec_field_codes("firefox %u"),
            "firefox"
        );
        assert_eq!(
            strip_exec_field_codes("env QTWEBENGINE_DISABLE_SANDBOX=1 /usr/bin/foo %u"),
            "env QTWEBENGINE_DISABLE_SANDBOX=1 /usr/bin/foo"
        );
        assert_eq!(strip_exec_field_codes("echo 100%% done"), "echo 100% done");
    }

    #[test]
    fn parse_minimal_desktop() {
        let s = r#"[Desktop Entry]
Type=Application
Name=Test App
Exec=/usr/bin/foo %u
"#;
        let e = parse_desktop_contents(s).expect("parsed");
        assert!(include_entry(&e));
        assert_eq!(pick_display_name(&e).as_deref(), Some("Test App"));
        let ex = strip_exec_field_codes(e.exec.as_ref().unwrap());
        assert_eq!(ex, "/usr/bin/foo");
    }

    #[test]
    fn hidden_skipped_by_include() {
        let s = r#"[Desktop Entry]
Name=X
Exec=/bin/true
Hidden=true
"#;
        let e = parse_desktop_contents(s).expect("parsed");
        assert!(!include_entry(&e));
    }

    #[test]
    fn non_application_type_excluded() {
        let s = r#"[Desktop Entry]
Type=Link
Name=Link
Exec=/bin/true
"#;
        let e = parse_desktop_contents(s).expect("parsed");
        assert!(!include_entry(&e));
    }

    #[test]
    fn list_applications_json_smoke() {
        let s = list_applications_json().expect("serializes");
        assert!(s.starts_with('{') && s.contains("\"apps\""));
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert!(v.get("apps").and_then(|a| a.as_array()).is_some());
    }
}
