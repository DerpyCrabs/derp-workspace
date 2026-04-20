use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ThemeSettingsFile {
    pub palette: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct KeyboardLayoutEntryFile {
    pub layout: String,
    pub variant: String,
}

impl Default for KeyboardLayoutEntryFile {
    fn default() -> Self {
        Self {
            layout: String::new(),
            variant: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct KeyboardSettingsFile {
    pub layouts: Vec<KeyboardLayoutEntryFile>,
    pub repeat_rate: u32,
    pub repeat_delay_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct DefaultApplicationsFile {
    pub image: String,
    pub video: String,
    pub text: String,
    pub pdf: String,
    pub other: String,
}

impl Default for DefaultApplicationsFile {
    fn default() -> Self {
        Self {
            image: "shell:image_viewer".into(),
            video: "shell:video_viewer".into(),
            text: "shell:text_editor".into(),
            pdf: "shell:pdf_viewer".into(),
            other: "xdg-open".into(),
        }
    }
}

impl Default for KeyboardSettingsFile {
    fn default() -> Self {
        Self {
            layouts: Vec::new(),
            repeat_rate: 25,
            repeat_delay_ms: 200,
        }
    }
}

impl Default for ThemeSettingsFile {
    fn default() -> Self {
        Self {
            palette: "default".into(),
            mode: "system".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct SettingsFile {
    pub version: u32,
    pub theme: ThemeSettingsFile,
    pub keyboard: KeyboardSettingsFile,
    pub default_applications: DefaultApplicationsFile,
}

impl Default for SettingsFile {
    fn default() -> Self {
        Self {
            version: 1,
            theme: ThemeSettingsFile::default(),
            keyboard: KeyboardSettingsFile::default(),
            default_applications: DefaultApplicationsFile::default(),
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

fn sanitize_keyboard_token(value: &str, allow_empty: bool) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return allow_empty.then(String::new);
    }
    if trimmed.len() > 32 {
        return None;
    }
    if trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '+'))
    {
        return Some(trimmed.to_string());
    }
    None
}

pub fn sanitize_keyboard_settings(keyboard: KeyboardSettingsFile) -> KeyboardSettingsFile {
    let mut layouts = Vec::with_capacity(keyboard.layouts.len());
    for entry in keyboard.layouts {
        let Some(layout) = sanitize_keyboard_token(&entry.layout, false) else {
            continue;
        };
        let Some(variant) = sanitize_keyboard_token(&entry.variant, true) else {
            continue;
        };
        layouts.push(KeyboardLayoutEntryFile { layout, variant });
        if layouts.len() >= 8 {
            break;
        }
    }
    KeyboardSettingsFile {
        layouts,
        repeat_rate: keyboard.repeat_rate.clamp(1, 60),
        repeat_delay_ms: keyboard.repeat_delay_ms.clamp(100, 1000),
    }
}

fn sanitize_default_app_token(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed == "xdg-open" {
        return trimmed.to_string();
    }
    if let Some(rest) = trimmed.strip_prefix("shell:") {
        if matches!(
            rest,
            "image_viewer" | "video_viewer" | "text_editor" | "pdf_viewer"
        ) {
            return trimmed.to_string();
        }
    }
    if let Some(rest) = trimmed.strip_prefix("desktop:") {
        if !rest.is_empty()
            && rest.len() <= 256
            && rest
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '+'))
        {
            return trimmed.to_string();
        }
    }
    fallback.to_string()
}

pub fn sanitize_default_applications_settings(
    settings: DefaultApplicationsFile,
) -> DefaultApplicationsFile {
    let defaults = DefaultApplicationsFile::default();
    DefaultApplicationsFile {
        image: sanitize_default_app_token(&settings.image, &defaults.image),
        video: sanitize_default_app_token(&settings.video, &defaults.video),
        text: sanitize_default_app_token(&settings.text, &defaults.text),
        pdf: sanitize_default_app_token(&settings.pdf, &defaults.pdf),
        other: sanitize_default_app_token(&settings.other, &defaults.other),
    }
}

fn keyboard_settings_from_display_defaults() -> KeyboardSettingsFile {
    let mut out = KeyboardSettingsFile::default();
    let Some(kb) = crate::controls::display_config::read_keyboard_from_display_file() else {
        return out;
    };
    let layouts = kb
        .layout
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let variants = kb.variant.split(',').map(str::trim).collect::<Vec<_>>();
    if layouts.is_empty() {
        return out;
    }
    out.layouts = layouts
        .into_iter()
        .enumerate()
        .filter_map(|(idx, layout)| {
            let variant = variants.get(idx).copied().unwrap_or_default();
            Some(KeyboardLayoutEntryFile {
                layout: sanitize_keyboard_token(layout, false)?,
                variant: sanitize_keyboard_token(variant, true)?,
            })
        })
        .collect();
    out
}

pub fn read_keyboard_settings() -> KeyboardSettingsFile {
    let Some(path) = settings_config_path() else {
        return keyboard_settings_from_display_defaults();
    };
    let mut keyboard = read_settings_file_from_path(&path).keyboard;
    if keyboard.layouts.is_empty() {
        keyboard.layouts = keyboard_settings_from_display_defaults().layouts;
    }
    if keyboard.repeat_rate == 0 {
        keyboard.repeat_rate = KeyboardSettingsFile::default().repeat_rate;
    }
    if keyboard.repeat_delay_ms == 0 {
        keyboard.repeat_delay_ms = KeyboardSettingsFile::default().repeat_delay_ms;
    }
    sanitize_keyboard_settings(keyboard)
}

pub fn read_keyboard_settings_json() -> Result<String, String> {
    serde_json::to_string(&read_keyboard_settings()).map_err(|e| e.to_string())
}

pub fn write_keyboard_settings(keyboard: KeyboardSettingsFile) -> Result<(), String> {
    let Some(path) = settings_config_path() else {
        return Err("missing config dir".into());
    };
    ensure_parent_dir(&path)?;
    let mut cfg = read_settings_file_from_path(&path);
    let keyboard = sanitize_keyboard_settings(keyboard);
    if cfg.version == 1 && cfg.keyboard == keyboard {
        return Ok(());
    }
    cfg.version = 1;
    cfg.keyboard = keyboard;
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
            cfg.keyboard = sanitize_keyboard_settings(cfg.keyboard);
            cfg.default_applications =
                sanitize_default_applications_settings(cfg.default_applications);
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
    let theme = sanitize_theme_settings(theme);
    if cfg.version == 1 && cfg.theme == theme {
        return Ok(());
    }
    cfg.version = 1;
    cfg.theme = theme;
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

pub fn read_default_applications_settings() -> DefaultApplicationsFile {
    let Some(path) = settings_config_path() else {
        return DefaultApplicationsFile::default();
    };
    read_settings_file_from_path(&path).default_applications
}

pub fn read_default_applications_settings_json() -> Result<String, String> {
    serde_json::to_string(&read_default_applications_settings()).map_err(|e| e.to_string())
}

pub fn write_default_applications_settings(
    default_applications: DefaultApplicationsFile,
) -> Result<(), String> {
    let Some(path) = settings_config_path() else {
        return Err("missing config dir".into());
    };
    ensure_parent_dir(&path)?;
    let mut cfg = read_settings_file_from_path(&path);
    let default_applications = sanitize_default_applications_settings(default_applications);
    if cfg.version == 1 && cfg.default_applications == default_applications {
        return Ok(());
    }
    cfg.version = 1;
    cfg.default_applications = default_applications;
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
    use std::sync::{Mutex, OnceLock};

    use super::{
        read_keyboard_settings, read_theme_settings, sanitize_keyboard_settings,
        sanitize_theme_settings, settings_config_path, write_keyboard_settings,
        write_theme_settings, KeyboardLayoutEntryFile, KeyboardSettingsFile, ThemeSettingsFile,
    };

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

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
        let _guard = env_lock().lock().unwrap();
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

    #[test]
    fn sanitize_keyboard_settings_filters_bad_rows_and_clamps_repeat() {
        assert_eq!(
            sanitize_keyboard_settings(KeyboardSettingsFile {
                layouts: vec![
                    KeyboardLayoutEntryFile {
                        layout: "us".into(),
                        variant: String::new(),
                    },
                    KeyboardLayoutEntryFile {
                        layout: "bad layout".into(),
                        variant: String::new(),
                    },
                    KeyboardLayoutEntryFile {
                        layout: "de".into(),
                        variant: "nodeadkeys".into(),
                    },
                ],
                repeat_rate: 0,
                repeat_delay_ms: 5000,
            }),
            KeyboardSettingsFile {
                layouts: vec![
                    KeyboardLayoutEntryFile {
                        layout: "us".into(),
                        variant: String::new(),
                    },
                    KeyboardLayoutEntryFile {
                        layout: "de".into(),
                        variant: "nodeadkeys".into(),
                    },
                ],
                repeat_rate: 1,
                repeat_delay_ms: 1000,
            }
        );
    }

    #[test]
    fn read_and_write_keyboard_settings_round_trip() {
        let _guard = env_lock().lock().unwrap();
        let mut path = std::env::temp_dir();
        path.push(format!(
            "derp-settings-config-keyboard-test-{}-{}.json",
            std::process::id(),
            std::thread::current().name().unwrap_or("main")
        ));
        let _ = std::fs::remove_file(&path);
        std::env::set_var("DERP_SETTINGS_CONFIG", &path);

        write_keyboard_settings(KeyboardSettingsFile {
            layouts: vec![
                KeyboardLayoutEntryFile {
                    layout: "us".into(),
                    variant: String::new(),
                },
                KeyboardLayoutEntryFile {
                    layout: "de".into(),
                    variant: "nodeadkeys".into(),
                },
            ],
            repeat_rate: 30,
            repeat_delay_ms: 250,
        })
        .unwrap();

        assert_eq!(
            read_keyboard_settings(),
            KeyboardSettingsFile {
                layouts: vec![
                    KeyboardLayoutEntryFile {
                        layout: "us".into(),
                        variant: String::new(),
                    },
                    KeyboardLayoutEntryFile {
                        layout: "de".into(),
                        variant: "nodeadkeys".into(),
                    },
                ],
                repeat_rate: 30,
                repeat_delay_ms: 250,
            }
        );

        let path = settings_config_path().unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"keyboard\""));
        assert!(raw.contains("\"repeat_rate\": 30"));
        assert!(raw.contains("\"repeat_delay_ms\": 250"));

        let _ = std::fs::remove_file(&path);
        std::env::remove_var("DERP_SETTINGS_CONFIG");
    }
}
