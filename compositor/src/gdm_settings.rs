use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GdmAutologinSettings {
    pub current_user: String,
    pub enabled: bool,
    pub configured_user: Option<String>,
    pub config_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GdmAutologinUpdate {
    pub enabled: bool,
}

fn gdm_config_candidates() -> [&'static str; 2] {
    ["/etc/gdm/custom.conf", "/etc/gdm3/custom.conf"]
}

fn default_gdm_config_path() -> &'static str {
    gdm_config_candidates()[0]
}

fn select_gdm_config_path() -> PathBuf {
    for candidate in gdm_config_candidates() {
        let path = PathBuf::from(candidate);
        if path.exists() {
            return path;
        }
    }
    PathBuf::from(default_gdm_config_path())
}

fn current_user_name() -> String {
    if let Ok(value) = std::env::var("USER") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(value) = std::env::var("LOGNAME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    unsafe {
        let uid = libc::geteuid();
        let pwd = libc::getpwuid(uid);
        if !pwd.is_null() {
            let name = std::ffi::CStr::from_ptr((*pwd).pw_name);
            if let Ok(value) = name.to_str() {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    "unknown".to_string()
}

fn parse_gdm_autologin(raw: &str) -> (bool, Option<String>) {
    let mut in_daemon = false;
    let mut enabled = false;
    let mut configured_user = None;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_daemon = trimmed[1..trimmed.len() - 1].trim().eq_ignore_ascii_case("daemon");
            continue;
        }
        if !in_daemon || trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if key.eq_ignore_ascii_case("AutomaticLoginEnable") {
            enabled = value.eq_ignore_ascii_case("true") || value == "1" || value.eq_ignore_ascii_case("yes");
        } else if key.eq_ignore_ascii_case("AutomaticLogin") {
            let value = value.trim_matches('"').trim();
            if !value.is_empty() {
                configured_user = Some(value.to_string());
            }
        }
    }
    (enabled, configured_user)
}

fn rewrite_gdm_daemon_section(raw: &str, enabled: bool, user: &str) -> String {
    let mut lines = raw.lines().map(|line| line.to_string()).collect::<Vec<_>>();
    let mut daemon_header = None;
    let mut daemon_end = lines.len();
    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let section = trimmed[1..trimmed.len() - 1].trim();
            if section.eq_ignore_ascii_case("daemon") {
                daemon_header = Some(idx);
                daemon_end = lines.len();
                for (next_idx, next_line) in lines.iter().enumerate().skip(idx + 1) {
                    let next_trimmed = next_line.trim();
                    if next_trimmed.starts_with('[') && next_trimmed.ends_with(']') {
                        daemon_end = next_idx;
                        break;
                    }
                }
                break;
            }
        }
    }
    match daemon_header {
        Some(header_idx) => {
            let mut retained = Vec::new();
            for line in lines[header_idx + 1..daemon_end].iter() {
                let trimmed = line.trim();
                if let Some((key, _)) = trimmed.split_once('=') {
                    let key = key.trim();
                    if key.eq_ignore_ascii_case("AutomaticLoginEnable")
                        || key.eq_ignore_ascii_case("AutomaticLogin")
                    {
                        continue;
                    }
                }
                retained.push(line.clone());
            }
            let mut replacement = vec![lines[header_idx].clone()];
            if enabled {
                replacement.push("AutomaticLoginEnable=True".to_string());
                replacement.push(format!("AutomaticLogin={user}"));
            } else {
                replacement.push("AutomaticLoginEnable=False".to_string());
            }
            replacement.extend(retained);
            lines.splice(header_idx..daemon_end, replacement);
        }
        None => {
            if !lines.is_empty() && !lines.last().map(|line| line.trim().is_empty()).unwrap_or(false) {
                lines.push(String::new());
            }
            lines.push("[daemon]".to_string());
            if enabled {
                lines.push("AutomaticLoginEnable=True".to_string());
                lines.push(format!("AutomaticLogin={user}"));
            } else {
                lines.push("AutomaticLoginEnable=False".to_string());
            }
        }
    }
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn write_root_owned_file(path: &Path, content: &str) -> Result<(), String> {
    if unsafe { libc::geteuid() } == 0 {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        return std::fs::write(path, content).map_err(|e| e.to_string());
    }
    let mut child = Command::new("sudo")
        .arg("-n")
        .arg("tee")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("sudo tee {}: {e}", path.display()))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(content.as_bytes())
            .map_err(|e| format!("sudo tee stdin {}: {e}", path.display()))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("sudo tee wait {}: {e}", path.display()))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        return Err(format!("failed to write {}", path.display()));
    }
    Err(format!("failed to write {}: {stderr}", path.display()))
}

pub fn read_gdm_autologin_settings() -> Result<GdmAutologinSettings, String> {
    let path = select_gdm_config_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let (enabled, configured_user) = parse_gdm_autologin(&raw);
    Ok(GdmAutologinSettings {
        current_user: current_user_name(),
        enabled,
        configured_user,
        config_path: path.display().to_string(),
    })
}

pub fn read_gdm_autologin_settings_json() -> Result<String, String> {
    serde_json::to_string(&read_gdm_autologin_settings()?).map_err(|e| e.to_string())
}

pub fn write_gdm_autologin_settings(update: GdmAutologinUpdate) -> Result<GdmAutologinSettings, String> {
    let path = select_gdm_config_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let current_user = current_user_name();
    let next = rewrite_gdm_daemon_section(&raw, update.enabled, &current_user);
    write_root_owned_file(&path, &next)?;
    read_gdm_autologin_settings()
}

#[cfg(test)]
mod tests {
    use super::{parse_gdm_autologin, rewrite_gdm_daemon_section};

    #[test]
    fn parse_gdm_autologin_reads_daemon_values() {
        let raw = "[daemon]\nAutomaticLoginEnable=True\nAutomaticLogin=alice\n";
        assert_eq!(
            parse_gdm_autologin(raw),
            (true, Some("alice".to_string()))
        );
    }

    #[test]
    fn rewrite_gdm_autologin_updates_existing_daemon_section() {
        let raw = "[daemon]\nWaylandEnable=true\nAutomaticLoginEnable=False\n\n[security]\n";
        let next = rewrite_gdm_daemon_section(raw, true, "alice");
        assert!(next.contains("[daemon]"));
        assert!(next.contains("WaylandEnable=true"));
        assert!(next.contains("AutomaticLoginEnable=True"));
        assert!(next.contains("AutomaticLogin=alice"));
        assert!(next.contains("[security]"));
    }

    #[test]
    fn rewrite_gdm_autologin_creates_daemon_section_when_missing() {
        let raw = "[security]\nDisallowTCP=true\n";
        let next = rewrite_gdm_daemon_section(raw, false, "alice");
        assert!(next.contains("[security]"));
        assert!(next.contains("[daemon]"));
        assert!(next.contains("AutomaticLoginEnable=False"));
        assert!(!next.contains("AutomaticLogin=alice"));
    }
}
