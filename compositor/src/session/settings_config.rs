use std::collections::{BTreeMap, HashSet};
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HotkeyActionFile {
    #[default]
    Builtin,
    Launch,
    Scratchpad,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct HotkeyBindingFile {
    pub id: String,
    pub enabled: bool,
    pub chord: String,
    pub action: HotkeyActionFile,
    pub builtin: String,
    pub command: String,
    pub desktop_id: String,
    pub app_name: String,
    pub scratchpad_id: String,
}

impl Default for HotkeyBindingFile {
    fn default() -> Self {
        Self {
            id: String::new(),
            enabled: true,
            chord: String::new(),
            action: HotkeyActionFile::Builtin,
            builtin: String::new(),
            command: String::new(),
            desktop_id: String::new(),
            app_name: String::new(),
            scratchpad_id: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct HotkeySettingsFile {
    pub bindings: Vec<HotkeyBindingFile>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct FilesSettingsFile {
    pub view_modes: BTreeMap<String, String>,
    pub favorites: Vec<String>,
    pub custom_icons: BTreeMap<String, String>,
    pub default_open_target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct NotificationsSettingsFile {
    pub enabled: bool,
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

impl Default for FilesSettingsFile {
    fn default() -> Self {
        Self {
            view_modes: BTreeMap::new(),
            favorites: Vec::new(),
            custom_icons: BTreeMap::new(),
            default_open_target: "window".into(),
        }
    }
}

impl Default for NotificationsSettingsFile {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScratchpadRuleFieldFile {
    #[default]
    AppId,
    Title,
    X11Class,
    X11Instance,
    Kind,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScratchpadRuleOpFile {
    #[default]
    Equals,
    Contains,
    StartsWith,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ScratchpadRuleFile {
    pub field: ScratchpadRuleFieldFile,
    pub op: ScratchpadRuleOpFile,
    pub value: String,
}

impl Default for ScratchpadRuleFile {
    fn default() -> Self {
        Self {
            field: ScratchpadRuleFieldFile::AppId,
            op: ScratchpadRuleOpFile::Equals,
            value: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ScratchpadPlacementFile {
    pub monitor: String,
    pub width_percent: u32,
    pub height_percent: u32,
}

impl Default for ScratchpadPlacementFile {
    fn default() -> Self {
        Self {
            monitor: "focused".into(),
            width_percent: 80,
            height_percent: 70,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ScratchpadFile {
    pub id: String,
    pub name: String,
    pub hotkey: String,
    pub default_visible: bool,
    pub placement: ScratchpadPlacementFile,
    pub rules: Vec<ScratchpadRuleFile>,
}

impl Default for ScratchpadFile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            hotkey: String::new(),
            default_visible: false,
            placement: ScratchpadPlacementFile::default(),
            rules: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ScratchpadSettingsFile {
    pub items: Vec<ScratchpadFile>,
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

impl Default for HotkeySettingsFile {
    fn default() -> Self {
        Self {
            bindings: default_hotkey_bindings(),
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
    pub hotkeys: HotkeySettingsFile,
    pub default_applications: DefaultApplicationsFile,
    pub files: FilesSettingsFile,
    pub notifications: NotificationsSettingsFile,
    pub scratchpads: ScratchpadSettingsFile,
}

impl Default for SettingsFile {
    fn default() -> Self {
        Self {
            version: 1,
            theme: ThemeSettingsFile::default(),
            keyboard: KeyboardSettingsFile::default(),
            hotkeys: HotkeySettingsFile::default(),
            default_applications: DefaultApplicationsFile::default(),
            files: FilesSettingsFile::default(),
            notifications: NotificationsSettingsFile::default(),
            scratchpads: ScratchpadSettingsFile::default(),
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

fn hotkey_binding(
    id: &str,
    chord: &str,
    action: HotkeyActionFile,
    builtin: &str,
    command: &str,
) -> HotkeyBindingFile {
    HotkeyBindingFile {
        id: id.into(),
        enabled: true,
        chord: chord.into(),
        action,
        builtin: builtin.into(),
        command: command.into(),
        desktop_id: String::new(),
        app_name: String::new(),
        scratchpad_id: String::new(),
    }
}

fn default_hotkey_bindings() -> Vec<HotkeyBindingFile> {
    use HotkeyActionFile::{Builtin, Launch};
    vec![
        hotkey_binding(
            "cycle-keyboard-layout",
            "Super+Space",
            Builtin,
            "cycle_keyboard_layout",
            "",
        ),
        hotkey_binding("open-settings", "Super+Comma", Builtin, "open_settings", ""),
        hotkey_binding("launch-terminal", "Super+Return", Launch, "", "foot"),
        hotkey_binding("close-focused", "Super+Q", Builtin, "close_focused", ""),
        hotkey_binding(
            "toggle-programs-menu",
            "Super+D",
            Builtin,
            "toggle_programs_menu",
            "",
        ),
        hotkey_binding(
            "toggle-fullscreen",
            "Super+F",
            Builtin,
            "toggle_fullscreen",
            "",
        ),
        hotkey_binding("toggle-maximize", "Super+M", Builtin, "toggle_maximize", ""),
        hotkey_binding(
            "tab-previous",
            "Super+BracketLeft",
            Builtin,
            "tab_previous",
            "",
        ),
        hotkey_binding("tab-next", "Super+BracketRight", Builtin, "tab_next", ""),
        hotkey_binding("tile-left", "Super+Left", Builtin, "tile_left", ""),
        hotkey_binding("tile-right", "Super+Right", Builtin, "tile_right", ""),
        hotkey_binding("tile-up", "Super+Up", Builtin, "tile_up", ""),
        hotkey_binding("tile-down", "Super+Down", Builtin, "tile_down", ""),
        hotkey_binding(
            "move-monitor-left",
            "Super+Shift+Left",
            Builtin,
            "move_monitor_left",
            "",
        ),
        hotkey_binding(
            "move-monitor-right",
            "Super+Shift+Right",
            Builtin,
            "move_monitor_right",
            "",
        ),
        hotkey_binding(
            "screenshot-current-output",
            "Super+Ctrl+S",
            Builtin,
            "screenshot_current_output",
            "",
        ),
        hotkey_binding(
            "screenshot-region",
            "Super+Shift+S",
            Builtin,
            "screenshot_region",
            "",
        ),
    ]
}

fn sanitize_hotkey_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 80 {
        return None;
    }
    if trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    {
        return Some(trimmed.to_string());
    }
    None
}

fn sanitize_hotkey_text(value: &str, max_len: usize) -> String {
    value
        .trim()
        .chars()
        .filter(|ch| !ch.is_control())
        .take(max_len)
        .collect()
}

fn normalize_hotkey_key_token(value: &str) -> Option<String> {
    let t = value.trim().to_ascii_lowercase();
    match t.as_str() {
        "`" | "grave" | "backquote" => Some("Grave".into()),
        "space" => Some("Space".into()),
        "return" | "enter" => Some("Return".into()),
        "tab" => Some("Tab".into()),
        "left" => Some("Left".into()),
        "right" => Some("Right".into()),
        "up" => Some("Up".into()),
        "down" => Some("Down".into()),
        "," | "comma" => Some("Comma".into()),
        "." | "period" => Some("Period".into()),
        "/" | "slash" => Some("Slash".into()),
        ";" | "semicolon" => Some("Semicolon".into()),
        "'" | "apostrophe" => Some("Apostrophe".into()),
        "[" | "bracketleft" => Some("BracketLeft".into()),
        "]" | "bracketright" => Some("BracketRight".into()),
        _ if t.len() == 1 => {
            let ch = t.as_bytes()[0];
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
                Some(t.to_ascii_uppercase())
            } else {
                None
            }
        }
        _ => None,
    }
}

pub fn normalize_hotkey_chord(value: &str) -> Option<String> {
    let parts = value
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 2 {
        return None;
    }
    let mut has_super = false;
    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut key: Option<String> = None;
    for part in parts {
        match part.to_ascii_lowercase().as_str() {
            "super" | "win" | "meta" | "mod4" => has_super = true,
            "ctrl" | "control" => ctrl = true,
            "alt" => alt = true,
            "shift" => shift = true,
            _ => {
                if key.is_some() {
                    return None;
                }
                key = normalize_hotkey_key_token(part);
            }
        }
    }
    if !has_super {
        return None;
    }
    let key = key?;
    let mut out = vec!["Super".to_string()];
    if ctrl {
        out.push("Ctrl".into());
    }
    if alt {
        out.push("Alt".into());
    }
    if shift {
        out.push("Shift".into());
    }
    out.push(key);
    Some(out.join("+"))
}

fn valid_builtin_hotkey_action(value: &str) -> bool {
    matches!(
        value,
        "cycle_keyboard_layout"
            | "open_settings"
            | "close_focused"
            | "toggle_programs_menu"
            | "toggle_fullscreen"
            | "toggle_maximize"
            | "tab_previous"
            | "tab_next"
            | "tile_left"
            | "tile_right"
            | "tile_up"
            | "tile_down"
            | "move_monitor_left"
            | "move_monitor_right"
            | "screenshot_current_output"
            | "screenshot_region"
            | "launch_terminal"
    )
}

fn sanitize_hotkey_binding(item: HotkeyBindingFile) -> Option<HotkeyBindingFile> {
    let id = sanitize_hotkey_id(&item.id)?;
    let chord = normalize_hotkey_chord(&item.chord)?;
    let builtin = sanitize_hotkey_text(&item.builtin, 96);
    let command = sanitize_hotkey_text(&item.command, shell_wire::MAX_SPAWN_COMMAND_BYTES as usize);
    let desktop_id = sanitize_hotkey_text(&item.desktop_id, 256);
    let app_name = sanitize_hotkey_text(&item.app_name, 256);
    let scratchpad_id = sanitize_hotkey_text(&item.scratchpad_id, 80);
    match item.action {
        HotkeyActionFile::Builtin => {
            if !valid_builtin_hotkey_action(&builtin) {
                return None;
            }
        }
        HotkeyActionFile::Launch => {
            if command.is_empty() {
                return None;
            }
        }
        HotkeyActionFile::Scratchpad => {
            if scratchpad_id.is_empty() {
                return None;
            }
        }
    }
    Some(HotkeyBindingFile {
        id,
        enabled: item.enabled,
        chord,
        action: item.action,
        builtin,
        command,
        desktop_id,
        app_name,
        scratchpad_id,
    })
}

pub fn sanitize_hotkey_settings(settings: HotkeySettingsFile) -> HotkeySettingsFile {
    let mut bindings = Vec::new();
    let mut ids = HashSet::new();
    let mut active_chords = HashSet::new();
    for item in settings.bindings {
        let Some(binding) = sanitize_hotkey_binding(item) else {
            continue;
        };
        if !ids.insert(binding.id.clone()) {
            continue;
        }
        if binding.enabled && !active_chords.insert(binding.chord.clone()) {
            continue;
        }
        bindings.push(binding);
        if bindings.len() >= 128 {
            break;
        }
    }
    HotkeySettingsFile { bindings }
}

pub fn sanitize_hotkey_settings_for_write(
    settings: HotkeySettingsFile,
) -> Result<HotkeySettingsFile, String> {
    let mut bindings = Vec::new();
    let mut ids = HashSet::new();
    let mut active_chords = HashSet::new();
    for item in settings.bindings {
        let raw_id = item.id.clone();
        let raw_chord = item.chord.clone();
        let Some(binding) = sanitize_hotkey_binding(item) else {
            return Err(format!("invalid hotkey binding {raw_id}"));
        };
        if !ids.insert(binding.id.clone()) {
            return Err(format!("duplicate hotkey id {}", binding.id));
        }
        if binding.enabled && !active_chords.insert(binding.chord.clone()) {
            return Err(format!("duplicate hotkey chord {}", raw_chord.trim()));
        }
        bindings.push(binding);
        if bindings.len() > 128 {
            return Err("too many hotkey bindings".into());
        }
    }
    Ok(HotkeySettingsFile { bindings })
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

fn sanitize_settings_path_key(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 4096 {
        return None;
    }
    if trimmed.chars().any(|ch| ch.is_control()) {
        return None;
    }
    Some(trimmed.replace('\\', "/"))
}

fn sanitize_files_view_mode(value: &str) -> Option<String> {
    match value.trim() {
        "list" => Some("list".into()),
        "grid" => Some("grid".into()),
        _ => None,
    }
}

fn sanitize_files_icon_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return None;
    }
    if trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Some(trimmed.to_string());
    }
    None
}

fn sanitize_default_open_target(value: &str) -> String {
    match value.trim() {
        "window" | "tab" | "split" | "ask" => value.trim().to_string(),
        _ => FilesSettingsFile::default().default_open_target,
    }
}

pub fn sanitize_files_settings(settings: FilesSettingsFile) -> FilesSettingsFile {
    let mut view_modes = BTreeMap::new();
    for (path, mode) in settings.view_modes {
        let Some(path) = sanitize_settings_path_key(&path) else {
            continue;
        };
        let Some(mode) = sanitize_files_view_mode(&mode) else {
            continue;
        };
        view_modes.insert(path, mode);
        if view_modes.len() >= 512 {
            break;
        }
    }
    let mut favorites = Vec::new();
    for path in settings.favorites {
        let Some(path) = sanitize_settings_path_key(&path) else {
            continue;
        };
        if !favorites.contains(&path) {
            favorites.push(path);
        }
        if favorites.len() >= 512 {
            break;
        }
    }
    let mut custom_icons = BTreeMap::new();
    for (path, icon) in settings.custom_icons {
        let Some(path) = sanitize_settings_path_key(&path) else {
            continue;
        };
        let Some(icon) = sanitize_files_icon_name(&icon) else {
            continue;
        };
        custom_icons.insert(path, icon);
        if custom_icons.len() >= 512 {
            break;
        }
    }
    FilesSettingsFile {
        view_modes,
        favorites,
        custom_icons,
        default_open_target: sanitize_default_open_target(&settings.default_open_target),
    }
}

pub fn sanitize_notifications_settings(
    settings: NotificationsSettingsFile,
) -> NotificationsSettingsFile {
    NotificationsSettingsFile {
        enabled: settings.enabled,
    }
}

fn sanitize_scratchpad_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 48 {
        return None;
    }
    if trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    {
        return Some(trimmed.to_string());
    }
    None
}

fn sanitize_scratchpad_text(value: &str, max_len: usize) -> String {
    value
        .trim()
        .chars()
        .filter(|ch| !ch.is_control())
        .take(max_len)
        .collect()
}

pub fn sanitize_scratchpad_settings(settings: ScratchpadSettingsFile) -> ScratchpadSettingsFile {
    let mut items = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for item in settings.items {
        let Some(id) = sanitize_scratchpad_id(&item.id) else {
            continue;
        };
        if !ids.insert(id.clone()) {
            continue;
        }
        let name = sanitize_scratchpad_text(&item.name, 80);
        let hotkey = sanitize_scratchpad_text(&item.hotkey, 80);
        let monitor = match item.placement.monitor.trim() {
            "" => "focused".to_string(),
            "focused" | "pointer" | "primary" => item.placement.monitor.trim().to_string(),
            value => sanitize_scratchpad_text(value, 80),
        };
        let mut rules = Vec::new();
        for rule in item.rules {
            let value = sanitize_scratchpad_text(&rule.value, 256);
            if value.is_empty() {
                continue;
            }
            rules.push(ScratchpadRuleFile {
                field: rule.field,
                op: rule.op,
                value,
            });
            if rules.len() >= 16 {
                break;
            }
        }
        if rules.is_empty() {
            continue;
        }
        items.push(ScratchpadFile {
            id,
            name: if name.is_empty() {
                "Scratchpad".into()
            } else {
                name
            },
            hotkey,
            default_visible: item.default_visible,
            placement: ScratchpadPlacementFile {
                monitor,
                width_percent: item.placement.width_percent.clamp(20, 100),
                height_percent: item.placement.height_percent.clamp(20, 100),
            },
            rules,
        });
        if items.len() >= 32 {
            break;
        }
    }
    ScratchpadSettingsFile { items }
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
            cfg.hotkeys = sanitize_hotkey_settings(cfg.hotkeys);
            cfg.default_applications =
                sanitize_default_applications_settings(cfg.default_applications);
            cfg.files = sanitize_files_settings(cfg.files);
            cfg.notifications = sanitize_notifications_settings(cfg.notifications);
            cfg.scratchpads = sanitize_scratchpad_settings(cfg.scratchpads);
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

pub fn read_scratchpad_settings() -> ScratchpadSettingsFile {
    let Some(path) = settings_config_path() else {
        return ScratchpadSettingsFile::default();
    };
    read_settings_file_from_path(&path).scratchpads
}

pub fn read_hotkey_settings() -> HotkeySettingsFile {
    let Some(path) = settings_config_path() else {
        return HotkeySettingsFile::default();
    };
    read_settings_file_from_path(&path).hotkeys
}

pub fn read_hotkey_settings_json() -> Result<String, String> {
    serde_json::to_string(&read_hotkey_settings()).map_err(|e| e.to_string())
}

pub fn write_hotkey_settings(settings: HotkeySettingsFile) -> Result<(), String> {
    let Some(path) = settings_config_path() else {
        return Err("missing config dir".into());
    };
    ensure_parent_dir(&path)?;
    let mut cfg = read_settings_file_from_path(&path);
    let hotkeys = sanitize_hotkey_settings_for_write(settings)?;
    if cfg.version == 1 && cfg.hotkeys == hotkeys {
        return Ok(());
    }
    cfg.version = 1;
    cfg.hotkeys = hotkeys;
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

pub fn read_notifications_settings() -> NotificationsSettingsFile {
    let Some(path) = settings_config_path() else {
        return NotificationsSettingsFile::default();
    };
    read_settings_file_from_path(&path).notifications
}

pub fn write_notifications_settings(settings: NotificationsSettingsFile) -> Result<(), String> {
    let Some(path) = settings_config_path() else {
        return Err("missing config dir".into());
    };
    ensure_parent_dir(&path)?;
    let mut cfg = read_settings_file_from_path(&path);
    let notifications = sanitize_notifications_settings(settings);
    if cfg.version == 1 && cfg.notifications == notifications {
        return Ok(());
    }
    cfg.version = 1;
    cfg.notifications = notifications;
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

pub fn read_scratchpad_settings_json() -> Result<String, String> {
    serde_json::to_string(&read_scratchpad_settings()).map_err(|e| e.to_string())
}

pub fn write_scratchpad_settings(settings: ScratchpadSettingsFile) -> Result<(), String> {
    let Some(path) = settings_config_path() else {
        return Err("missing config dir".into());
    };
    ensure_parent_dir(&path)?;
    let mut cfg = read_settings_file_from_path(&path);
    let scratchpads = sanitize_scratchpad_settings(settings);
    if cfg.version == 1 && cfg.scratchpads == scratchpads {
        return Ok(());
    }
    cfg.version = 1;
    cfg.scratchpads = scratchpads;
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

pub fn read_files_settings() -> FilesSettingsFile {
    let Some(path) = settings_config_path() else {
        return FilesSettingsFile::default();
    };
    read_settings_file_from_path(&path).files
}

pub fn read_files_settings_json() -> Result<String, String> {
    serde_json::to_string(&read_files_settings()).map_err(|e| e.to_string())
}

pub fn write_files_settings(files: FilesSettingsFile) -> Result<(), String> {
    let Some(path) = settings_config_path() else {
        return Err("missing config dir".into());
    };
    ensure_parent_dir(&path)?;
    let mut cfg = read_settings_file_from_path(&path);
    let files = sanitize_files_settings(files);
    if cfg.version == 1 && cfg.files == files {
        return Ok(());
    }
    cfg.version = 1;
    cfg.files = files;
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
        normalize_hotkey_chord, read_hotkey_settings, read_keyboard_settings, read_theme_settings,
        sanitize_hotkey_settings_for_write, sanitize_keyboard_settings, sanitize_theme_settings,
        settings_config_path, write_hotkey_settings, write_keyboard_settings, write_theme_settings,
        HotkeyActionFile, HotkeyBindingFile, HotkeySettingsFile, KeyboardLayoutEntryFile,
        KeyboardSettingsFile, ThemeSettingsFile,
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

    #[test]
    fn normalizes_hotkey_chords() {
        assert_eq!(
            normalize_hotkey_chord("win + shift + enter"),
            Some("Super+Shift+Return".into())
        );
        assert_eq!(
            normalize_hotkey_chord("Super+Ctrl+s"),
            Some("Super+Ctrl+S".into())
        );
        assert_eq!(normalize_hotkey_chord("Ctrl+S"), None);
    }

    #[test]
    fn hotkeys_reject_duplicate_active_chords() {
        let err = sanitize_hotkey_settings_for_write(HotkeySettingsFile {
            bindings: vec![
                HotkeyBindingFile {
                    id: "one".into(),
                    chord: "Super+B".into(),
                    action: HotkeyActionFile::Launch,
                    command: "foot".into(),
                    ..HotkeyBindingFile::default()
                },
                HotkeyBindingFile {
                    id: "two".into(),
                    chord: "Win+b".into(),
                    action: HotkeyActionFile::Builtin,
                    builtin: "open_settings".into(),
                    ..HotkeyBindingFile::default()
                },
            ],
        })
        .unwrap_err();
        assert!(err.contains("duplicate hotkey chord"));
    }

    #[test]
    fn read_and_write_hotkey_settings_round_trip() {
        let _guard = env_lock().lock().unwrap();
        let mut path = std::env::temp_dir();
        path.push(format!(
            "derp-settings-config-hotkey-test-{}-{}.json",
            std::process::id(),
            std::thread::current().name().unwrap_or("main")
        ));
        let _ = std::fs::remove_file(&path);
        std::env::set_var("DERP_SETTINGS_CONFIG", &path);

        write_hotkey_settings(HotkeySettingsFile {
            bindings: vec![HotkeyBindingFile {
                id: "browser".into(),
                chord: "win+shift+b".into(),
                action: HotkeyActionFile::Launch,
                command: "firefox".into(),
                desktop_id: "firefox.desktop".into(),
                app_name: "Firefox".into(),
                ..HotkeyBindingFile::default()
            }],
        })
        .unwrap();

        assert_eq!(
            read_hotkey_settings(),
            HotkeySettingsFile {
                bindings: vec![HotkeyBindingFile {
                    id: "browser".into(),
                    chord: "Super+Shift+B".into(),
                    action: HotkeyActionFile::Launch,
                    command: "firefox".into(),
                    desktop_id: "firefox.desktop".into(),
                    app_name: "Firefox".into(),
                    ..HotkeyBindingFile::default()
                }],
            }
        );

        let _ = std::fs::remove_file(&path);
        std::env::remove_var("DERP_SETTINGS_CONFIG");
    }
}
