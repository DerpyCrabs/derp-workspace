use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ThemeSettingsFile {
    pub palette: String,
    pub mode: String,
}

impl Default for ThemeSettingsFile {
    fn default() -> Self {
        Self {
            palette: "default".into(),
            mode: "system".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SettingsFile {
    pub version: u32,
    pub theme: ThemeSettingsFile,
}

impl Default for SettingsFile {
    fn default() -> Self {
        Self {
            version: 1,
            theme: ThemeSettingsFile::default(),
        }
    }
}

fn is_valid_theme_palette(value: &str) -> bool {
    matches!(value, "default" | "caffeine" | "cosmic-night")
}

fn is_valid_theme_mode(value: &str) -> bool {
    matches!(value, "light" | "dark" | "system")
}

pub fn sanitize_theme_settings(theme: ThemeSettingsFile) -> ThemeSettingsFile {
    ThemeSettingsFile {
        palette: if is_valid_theme_palette(&theme.palette) {
            theme.palette
        } else {
            ThemeSettingsFile::default().palette
        },
        mode: if is_valid_theme_mode(&theme.mode) {
            theme.mode
        } else {
            ThemeSettingsFile::default().mode
        },
    }
}

pub fn settings_config_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("DERP_SETTINGS_CONFIG") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let mut p = dirs::config_dir()?;
    p.push("derp-workspace");
    p.push("settings.json");
    Some(p)
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())
}

fn read_settings_file_from_path(path: &Path) -> SettingsFile {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return SettingsFile::default(),
        Err(e) => {
            tracing::warn!(
                target: "derp_settings_config",
                ?e,
                path = %path.display(),
                "read settings config"
            );
            return SettingsFile::default();
        }
    };
    match serde_json::from_str::<SettingsFile>(&raw) {
        Ok(mut cfg) => {
            cfg.theme = sanitize_theme_settings(cfg.theme);
            if cfg.version == 0 {
                cfg.version = 1;
            }
            cfg
        }
        Err(e) => {
            tracing::warn!(
                target: "derp_settings_config",
                ?e,
                path = %path.display(),
                "parse settings config"
            );
            SettingsFile::default()
        }
    }
}

pub fn read_theme_settings() -> ThemeSettingsFile {
    let Some(path) = settings_config_path() else {
        return ThemeSettingsFile::default();
    };
    read_settings_file_from_path(&path).theme
}

pub fn read_theme_settings_json() -> Result<String, String> {
    serde_json::to_string(&read_theme_settings()).map_err(|e| e.to_string())
}

pub fn write_theme_settings(theme: ThemeSettingsFile) -> Result<(), String> {
    let Some(path) = settings_config_path() else {
        return Err("missing config dir".into());
    };
    ensure_parent_dir(&path)?;
    let mut cfg = read_settings_file_from_path(&path);
    cfg.version = 1;
    cfg.theme = sanitize_theme_settings(theme);
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{json}\n")).map_err(|e| {
        tracing::warn!(
            target: "derp_settings_config",
            ?e,
            path = %path.display(),
            "write settings config"
        );
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::{
        read_theme_settings, sanitize_theme_settings, settings_config_path, write_theme_settings,
        ThemeSettingsFile,
    };

    #[test]
    fn sanitize_theme_settings_fills_invalid_values() {
        assert_eq!(
            sanitize_theme_settings(ThemeSettingsFile {
                palette: "weird".into(),
                mode: "wrong".into(),
            }),
            ThemeSettingsFile::default()
        );
    }

    #[test]
    fn read_and_write_theme_settings_round_trip() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "derp-settings-config-test-{}-{}.json",
            std::process::id(),
            std::thread::current().name().unwrap_or("main")
        ));
        let _ = std::fs::remove_file(&path);
        std::env::set_var("DERP_SETTINGS_CONFIG", &path);

        write_theme_settings(ThemeSettingsFile {
            palette: "caffeine".into(),
            mode: "dark".into(),
        })
        .unwrap();

        assert_eq!(
            read_theme_settings(),
            ThemeSettingsFile {
                palette: "caffeine".into(),
                mode: "dark".into(),
            }
        );

        let path = settings_config_path().unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"theme\""));
        assert!(raw.contains("\"palette\": \"caffeine\""));

        let _ = std::fs::remove_file(&path);
        std::env::remove_var("DERP_SETTINGS_CONFIG");
    }
}
