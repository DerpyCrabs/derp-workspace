use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use smithay::backend::drm::DrmDevice;
use smithay::reexports::drm::control::{connector, Device as ControlDevice};

use crate::drm::{DrmHead, DrmSession};
use crate::state::{transform_to_wire, CompositorState, ShellTaskbarSide};
use smithay::input::keyboard::XkbConfig;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MonitorRef {
    pub connector: String,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monitor_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScreenEntry {
    pub connector: String,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monitor_id: Option<String>,
    pub x: i32,
    pub y: i32,
    #[serde(default)]
    pub transform: u32,
    #[serde(default)]
    pub vrr_enabled: bool,
    #[serde(default)]
    pub taskbar_side: ShellTaskbarSide,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct KeyboardXkbFile {
    #[serde(default)]
    pub rules: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub layout: String,
    #[serde(default)]
    pub variant: String,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct DesktopBackgroundConfig {
    pub mode: String,
    pub solid_rgba: [f32; 4],
    pub image_path: String,
    pub fit: String,
}

impl Default for DesktopBackgroundConfig {
    fn default() -> Self {
        Self {
            mode: "solid".into(),
            solid_rgba: [0.1, 0.1, 0.1, 1.0],
            image_path: String::new(),
            fit: "fill".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DisplayConfigFile {
    pub version: u32,
    pub ui_scale: f64,
    #[serde(default)]
    pub taskbar_auto_hide: bool,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_chrome_primary: Option<MonitorRef>,
    #[serde(default)]
    pub screens: Vec<ScreenEntry>,
    #[serde(default)]
    pub keyboard: KeyboardXkbFile,
    #[serde(default)]
    pub desktop_background: DesktopBackgroundConfig,
    #[serde(default)]
    pub desktop_background_outputs: HashMap<String, DesktopBackgroundConfig>,
}

struct LiveHead {
    name: String,
    monitor_id: Option<String>,
}

pub fn apply_keyboard_from_display_file(state: &mut CompositorState) {
    let Some(kb) = read_keyboard_from_display_file() else {
        return;
    };
    apply_keyboard_from_section(state, &kb);
}

pub(crate) fn apply_keyboard_from_section(state: &mut CompositorState, kb: &KeyboardXkbFile) {
    if kb.layout.trim().is_empty() {
        return;
    }
    let xkb_cfg = XkbConfig {
        rules: kb.rules.as_str(),
        model: kb.model.as_str(),
        layout: kb.layout.as_str(),
        variant: kb.variant.as_str(),
        options: kb.options.clone(),
    };
    let Some(handle) = state.seat.get_keyboard() else {
        return;
    };
    match handle.set_xkb_config(state, xkb_cfg) {
        Ok(()) => {
            state.keyboard_clear_per_window_layout_map();
            tracing::warn!(
                target: "derp_display_config",
                layout = %kb.layout,
                "applied keyboard layouts from display.json"
            );
        }
        Err(e) => tracing::warn!(
            target: "derp_display_config",
            ?e,
            layout = %kb.layout,
            "set_xkb_config from display.json keyboard"
        ),
    }
}

pub fn display_config_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("DERP_DISPLAY_CONFIG") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let mut p = dirs::config_dir()?;
    p.push("derp-workspace");
    p.push("display.json");
    Some(p)
}

pub fn read_keyboard_from_display_file() -> Option<KeyboardXkbFile> {
    let path = display_config_path()?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!(
                target: "derp_display_config",
                ?e,
                path = %path.display(),
                "read display config for keyboard"
            );
            return None;
        }
    };
    let cfg: DisplayConfigFile = match serde_json::from_str(&raw) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                target: "derp_display_config",
                ?e,
                "parse display config for keyboard"
            );
            return None;
        }
    };
    if cfg.version != 1 {
        return None;
    }
    Some(cfg.keyboard)
}

fn drm_connector_connected<D: ControlDevice>(drm: &D, conn: connector::Handle) -> bool {
    drm.get_connector(conn, false)
        .map(|info| info.state() == connector::State::Connected)
        .unwrap_or(false)
}

fn read_connector_edid<D: ControlDevice>(drm: &D, conn: connector::Handle) -> Option<Vec<u8>> {
    let props = drm.get_properties(conn).ok()?;
    for (prop_id, raw_val) in props.iter() {
        let info = drm.get_property(*prop_id).ok()?;
        let name = info.name().to_str().ok()?;
        if name != "EDID" {
            continue;
        }
        let val_type = info.value_type();
        let val = val_type.convert_value(*raw_val);
        let blob_id = val.as_blob()?;
        return drm.get_property_blob(blob_id).ok();
    }
    None
}

pub fn monitor_id_from_edid(edid: &[u8]) -> Option<String> {
    if edid.len() < 16 {
        return None;
    }
    let prod = u16::from_le_bytes([edid[10], edid[11]]);
    let serial = u32::from_le_bytes([edid[12], edid[13], edid[14], edid[15]]);
    Some(format!(
        "m{:02x}{:02x}-{:04x}-{:08x}",
        edid[8], edid[9], prod, serial
    ))
}

fn live_heads_from_drm(drm: &DrmDevice, heads: &[DrmHead]) -> Vec<LiveHead> {
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(heads.len());
    for h in heads {
        let edid = read_connector_edid(drm, h.connector);
        let mut monitor_id = edid.as_deref().and_then(monitor_id_from_edid);
        if let Some(ref id) = monitor_id {
            if seen_ids.contains(id) {
                tracing::warn!(
                    target: "derp_display_config",
                    monitor_id = %id,
                    connector = %h.connector_name,
                    "duplicate EDID monitor_id on live heads"
                );
                monitor_id = None;
            } else {
                seen_ids.insert(id.clone());
            }
        }
        out.push(LiveHead {
            name: h.connector_name.clone(),
            monitor_id,
        });
    }
    out
}

fn resolve_entry(name: &str, monitor_id: Option<&String>, live: &[LiveHead]) -> Option<String> {
    if let Some(h) = live.iter().find(|h| h.name == name) {
        return Some(h.name.clone());
    }
    if let Some(mid) = monitor_id {
        if let Some(h) = live
            .iter()
            .find(|h| h.monitor_id.as_ref().map(|s| s.as_str()) == Some(mid.as_str()))
        {
            return Some(h.name.clone());
        }
    }
    None
}

fn resolve_monitor_ref(pref: &MonitorRef, live: &[LiveHead]) -> Option<String> {
    resolve_entry(&pref.connector, pref.monitor_id.as_ref(), live)
}

pub fn apply_stored_from_heads(
    state: &mut CompositorState,
    drm: &DrmDevice,
    heads: &[DrmHead],
) -> bool {
    let Some(path) = display_config_path() else {
        return false;
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
        Err(e) => {
            tracing::warn!(target: "derp_display_config", ?e, path = %path.display(), "read display config");
            return false;
        }
    };
    let cfg: DisplayConfigFile = match serde_json::from_str(&raw) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(target: "derp_display_config", ?e, "parse display config");
            return false;
        }
    };
    if cfg.version != 1 {
        tracing::warn!(
            target: "derp_display_config",
            version = cfg.version,
            "unsupported display config version"
        );
        return false;
    }

    state.apply_desktop_background_from_display_file(&cfg);

    state.display_config_save_suppressed = true;

    let live = live_heads_from_drm(drm, heads);

    let scale = cfg.ui_scale;
    if (scale - 1.0).abs() <= f64::EPSILON
        || (scale - 1.5).abs() <= f64::EPSILON
        || (scale - 2.0).abs() <= f64::EPSILON
    {
        state.set_shell_ui_scale(scale);
    }
    state.taskbar_auto_hide = cfg.taskbar_auto_hide;
    state.taskbar_side_by_output_name.clear();
    for s in &cfg.screens {
        if let Some(n) = resolve_entry(&s.connector, s.monitor_id.as_ref(), &live) {
            if s.taskbar_side != ShellTaskbarSide::Bottom {
                state.taskbar_side_by_output_name.insert(n, s.taskbar_side);
            }
        }
    }

    let mut by_name: HashMap<String, (i32, i32, u32)> = HashMap::new();
    for s in &cfg.screens {
        if let Some(n) = resolve_entry(&s.connector, s.monitor_id.as_ref(), &live) {
            by_name.insert(n, (s.x, s.y, s.transform));
        }
    }
    let live_name_set: HashSet<String> = live.iter().map(|h| h.name.clone()).collect();
    let layout_name_set: HashSet<String> = by_name.keys().cloned().collect();
    let apply_layout = !by_name.is_empty() && layout_name_set == live_name_set;
    tracing::warn!(
        target: "derp_hotplug_shell",
        apply_layout,
        live = ?live_name_set,
        layout = ?layout_name_set,
        "apply_stored_from_heads layout gate"
    );
    if apply_layout {
        let screens: Vec<serde_json::Value> = by_name
            .into_iter()
            .map(|(name, (x, y, transform))| {
                serde_json::json!({
                    "name": name,
                    "x": x,
                    "y": y,
                    "transform": transform,
                })
            })
            .collect();
        let json = serde_json::json!({ "screens": screens }).to_string();
        state.apply_shell_output_layout_json(&json);
    }

    match &cfg.shell_chrome_primary {
        None => {
            state.set_shell_primary_output_name(String::new());
        }
        Some(pref) => {
            let name = resolve_monitor_ref(pref, &live).unwrap_or_default();
            tracing::warn!(
                target: "derp_hotplug_shell",
                pref_connector = %pref.connector,
                resolved_primary = %name,
                "apply_stored_from_heads primary"
            );
            state.set_shell_primary_output_name(name);
        }
    }

    state.display_config_save_suppressed = false;
    state.resync_embedded_shell_host_after_ipc_connect();
    true
}

pub fn stored_vrr_by_head_name(drm: &DrmDevice, heads: &[DrmHead]) -> HashMap<String, bool> {
    let Some(path) = display_config_path() else {
        return HashMap::new();
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return HashMap::new(),
        Err(e) => {
            tracing::warn!(target: "derp_display_config", ?e, path = %path.display(), "read display config for vrr");
            return HashMap::new();
        }
    };
    let cfg: DisplayConfigFile = match serde_json::from_str(&raw) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(target: "derp_display_config", ?e, "parse display config for vrr");
            return HashMap::new();
        }
    };
    if cfg.version != 1 {
        return HashMap::new();
    }
    let live = live_heads_from_drm(drm, heads);
    cfg.screens
        .iter()
        .filter_map(|s| {
            resolve_entry(&s.connector, s.monitor_id.as_ref(), &live)
                .map(|name| (name, s.vrr_enabled))
        })
        .collect()
}

fn write_atomic(path: &Path, src: &DisplayConfigFile) -> std::io::Result<()> {
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
    if let Some(p) = parent {
        std::fs::create_dir_all(p)?;
    }
    let mut tmp = path.to_path_buf();
    let file_name = path
        .file_name()
        .map(|s| s.to_owned())
        .unwrap_or_else(|| std::ffi::OsString::from("display.json"));
    tmp.set_file_name({
        let mut s = file_name;
        s.push(".tmp");
        s
    });
    let data = serde_json::to_vec_pretty(src)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&data)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn save_from_drm_session(state: &CompositorState, session: &DrmSession) {
    let Some(path) = display_config_path() else {
        return;
    };
    let screens: Vec<ScreenEntry> = session
        .heads
        .iter()
        .filter(|h| drm_connector_connected(&session.drm, h.connector))
        .filter_map(|h| {
            let out = &h.output;
            let g = state.space.output_geometry(out)?;
            let edid = read_connector_edid(&session.drm, h.connector);
            let monitor_id = edid.as_deref().and_then(monitor_id_from_edid);
            Some(ScreenEntry {
                connector: h.connector_name.clone(),
                monitor_id,
                x: g.loc.x,
                y: g.loc.y,
                transform: transform_to_wire(out.current_transform()),
                vrr_enabled: h.vrr_supported && h.vrr_enabled,
                taskbar_side: state.taskbar_side_for_output_name(h.connector_name.as_str()),
            })
        })
        .collect();

    let shell_chrome_primary = match state.shell_primary_output_name.as_ref() {
        None => None,
        Some(name) => session
            .heads
            .iter()
            .find(|h| h.connector_name == *name)
            .filter(|h| drm_connector_connected(&session.drm, h.connector))
            .map(|h| {
                let monitor_id = read_connector_edid(&session.drm, h.connector)
                    .as_deref()
                    .and_then(monitor_id_from_edid);
                MonitorRef {
                    connector: h.connector_name.clone(),
                    monitor_id,
                }
            }),
    };

    let prev_file = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<DisplayConfigFile>(&raw).ok());
    let keyboard = prev_file
        .as_ref()
        .map(|c| c.keyboard.clone())
        .unwrap_or_default();
    let file = DisplayConfigFile {
        version: 1,
        ui_scale: state.shell_ui_scale,
        taskbar_auto_hide: state.taskbar_auto_hide,
        shell_chrome_primary,
        screens,
        keyboard,
        desktop_background: state.desktop_background_config.clone(),
        desktop_background_outputs: state.desktop_background_by_output_name.clone(),
    };

    if prev_file.as_ref().is_some_and(|prev| prev == &file) {
        return;
    }

    if let Err(e) = write_atomic(&path, &file) {
        tracing::warn!(target: "derp_display_config", ?e, path = %path.display(), "write display config");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitor_id_from_edid_uses_vendor_product_and_serial() {
        let mut edid = [0u8; 16];
        edid[8] = 0x34;
        edid[9] = 0x12;
        edid[10] = 0xcd;
        edid[11] = 0xab;
        edid[12] = 0x78;
        edid[13] = 0x56;
        edid[14] = 0x34;
        edid[15] = 0x12;

        assert_eq!(
            monitor_id_from_edid(&edid),
            Some("m3412-abcd-12345678".to_string())
        );
    }

    #[test]
    fn resolve_entry_matches_connector_before_monitor_id() {
        let live = vec![
            LiveHead {
                name: "DP-1".into(),
                monitor_id: Some("primary".into()),
            },
            LiveHead {
                name: "HDMI-A-1".into(),
                monitor_id: Some("backup".into()),
            },
        ];

        assert_eq!(
            resolve_entry("HDMI-A-1", Some(&"primary".to_string()), &live),
            Some("HDMI-A-1".to_string())
        );
        assert_eq!(
            resolve_entry("missing", Some(&"primary".to_string()), &live),
            Some("DP-1".to_string())
        );
    }

    #[test]
    fn display_config_deserialization_fills_nested_defaults() {
        let cfg: DisplayConfigFile = serde_json::from_value(serde_json::json!({
            "version": 1,
            "ui_scale": 1.5,
            "screens": []
        }))
        .unwrap();

        assert_eq!(cfg.keyboard.layout, "");
        assert_eq!(cfg.desktop_background.mode, "solid");
        assert_eq!(cfg.desktop_background.fit, "fill");
        assert!(cfg.desktop_background_outputs.is_empty());
        assert!(cfg.shell_chrome_primary.is_none());
        assert!(!cfg.taskbar_auto_hide);
    }

    #[test]
    fn display_config_deserializes_taskbar_side() {
        let cfg: DisplayConfigFile = serde_json::from_value(serde_json::json!({
            "version": 1,
            "ui_scale": 1.5,
            "taskbar_auto_hide": true,
            "screens": [
                {
                    "connector": "DP-1",
                    "x": 0,
                    "y": 0,
                    "taskbar_side": "left"
                }
            ]
        }))
        .unwrap();

        assert!(cfg.taskbar_auto_hide);
        assert_eq!(cfg.screens[0].taskbar_side, ShellTaskbarSide::Left);
    }

    #[test]
    fn display_config_serializes_taskbar_settings() {
        let cfg = DisplayConfigFile {
            version: 1,
            ui_scale: 1.0,
            taskbar_auto_hide: true,
            shell_chrome_primary: None,
            screens: vec![ScreenEntry {
                connector: "DP-1".into(),
                monitor_id: None,
                x: 0,
                y: 0,
                transform: 0,
                vrr_enabled: false,
                taskbar_side: ShellTaskbarSide::Right,
            }],
            keyboard: KeyboardXkbFile::default(),
            desktop_background: DesktopBackgroundConfig::default(),
            desktop_background_outputs: HashMap::new(),
        };
        let value = serde_json::to_value(&cfg).unwrap();

        assert_eq!(value["taskbar_auto_hide"], true);
        assert_eq!(value["screens"][0]["taskbar_side"], "right");
    }
}
