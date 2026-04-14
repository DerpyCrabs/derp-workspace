use std::collections::BTreeMap;
use std::process::{Command, Stdio};

use serde::Serialize;

const MAX_UI_VOLUME_PERCENT: u16 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioNodeKind {
    Sink,
    Source,
    PlaybackStream,
    CaptureStream,
}

#[derive(Debug, Clone)]
struct AudioNodeInventory {
    id: u32,
    kind: AudioNodeKind,
    name: String,
    nick: String,
    description: String,
    media_name: String,
    app_name: String,
    binary_name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AudioDeviceState {
    pub id: u32,
    pub label: String,
    pub subtitle: String,
    pub name: String,
    pub volume_percent: u16,
    pub volume_known: bool,
    pub muted: bool,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AudioStreamState {
    pub id: u32,
    pub label: String,
    pub subtitle: String,
    pub name: String,
    pub app_name: String,
    pub volume_percent: u16,
    pub volume_known: bool,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AudioStatePayload {
    pub backend: &'static str,
    pub sinks: Vec<AudioDeviceState>,
    pub sources: Vec<AudioDeviceState>,
    pub playback_streams: Vec<AudioStreamState>,
    pub capture_streams: Vec<AudioStreamState>,
}

pub fn read_audio_state_json() -> Result<String, String> {
    let nodes = read_audio_inventory()?;
    let (default_sink_id, default_source_id) = read_default_audio_ids()?;
    let mut sinks = Vec::new();
    let mut sources = Vec::new();
    let mut playback_streams = Vec::new();
    let mut capture_streams = Vec::new();
    for node in nodes {
        let (volume_percent, muted, volume_known) = read_node_volume(node.id);
        match node.kind {
            AudioNodeKind::Sink => sinks.push(AudioDeviceState {
                id: node.id,
                label: endpoint_label(&node),
                subtitle: endpoint_subtitle(&node),
                name: node.name.clone(),
                volume_percent,
                volume_known,
                muted,
                is_default: Some(node.id) == default_sink_id,
            }),
            AudioNodeKind::Source => sources.push(AudioDeviceState {
                id: node.id,
                label: endpoint_label(&node),
                subtitle: endpoint_subtitle(&node),
                name: node.name.clone(),
                volume_percent,
                volume_known,
                muted,
                is_default: Some(node.id) == default_source_id,
            }),
            AudioNodeKind::PlaybackStream => playback_streams.push(AudioStreamState {
                id: node.id,
                label: stream_label(&node),
                subtitle: stream_subtitle(&node),
                name: node.name.clone(),
                app_name: node.app_name.clone(),
                volume_percent,
                volume_known,
                muted,
            }),
            AudioNodeKind::CaptureStream => capture_streams.push(AudioStreamState {
                id: node.id,
                label: stream_label(&node),
                subtitle: stream_subtitle(&node),
                name: node.name.clone(),
                app_name: node.app_name.clone(),
                volume_percent,
                volume_known,
                muted,
            }),
        }
    }
    sinks.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| {
                a.label
                    .to_ascii_lowercase()
                    .cmp(&b.label.to_ascii_lowercase())
            })
            .then_with(|| a.id.cmp(&b.id))
    });
    sources.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| {
                a.label
                    .to_ascii_lowercase()
                    .cmp(&b.label.to_ascii_lowercase())
            })
            .then_with(|| a.id.cmp(&b.id))
    });
    playback_streams.sort_by(|a, b| {
        a.label
            .to_ascii_lowercase()
            .cmp(&b.label.to_ascii_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    capture_streams.sort_by(|a, b| {
        a.label
            .to_ascii_lowercase()
            .cmp(&b.label.to_ascii_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    serde_json::to_string(&AudioStatePayload {
        backend: "pipewire",
        sinks,
        sources,
        playback_streams,
        capture_streams,
    })
    .map_err(|e| e.to_string())
}

pub fn set_default_audio_device(id: u32) -> Result<(), String> {
    if id == 0 {
        return Err("audio_default: missing id".into());
    }
    run_wpctl_status(["set-default", &id.to_string()])
}

pub fn set_audio_volume_percent(id: u32, volume_percent: u32) -> Result<(), String> {
    if id == 0 {
        return Err("audio_volume: missing id".into());
    }
    let pct = volume_percent.min(MAX_UI_VOLUME_PERCENT as u32);
    run_wpctl_status(["set-volume", &id.to_string(), &format!("{pct}%")])
}

pub fn set_audio_mute(id: u32, muted: bool) -> Result<(), String> {
    if id == 0 {
        return Err("audio_mute: missing id".into());
    }
    run_wpctl_status(["set-mute", &id.to_string(), if muted { "1" } else { "0" }])
}

fn read_audio_inventory() -> Result<Vec<AudioNodeInventory>, String> {
    let raw = run_capture("pw-dump", &[])?;
    parse_pw_dump_inventory(&raw)
}

fn read_default_audio_ids() -> Result<(Option<u32>, Option<u32>), String> {
    let raw = run_capture("wpctl", &["status", "--name"])?;
    Ok(parse_wpctl_status_default_ids(&raw))
}

fn read_node_volume(id: u32) -> (u16, bool, bool) {
    let id_s = id.to_string();
    let out = Command::new("wpctl")
        .args(["get-volume", id_s.as_str()])
        .stdin(Stdio::null())
        .output();
    let Ok(out) = out else {
        return (0, false, false);
    };
    if !out.status.success() {
        return (0, false, false);
    }
    let Some((linear_percent_x100, muted)) =
        parse_wpctl_get_volume(&String::from_utf8_lossy(&out.stdout))
    else {
        return (0, false, false);
    };
    let percent = percent_from_linear_x100(linear_percent_x100);
    (percent, muted, true)
}

fn percent_from_linear_x100(linear_percent_x100: u16) -> u16 {
    let percent = ((linear_percent_x100 as u32 + 50) / 100).min(MAX_UI_VOLUME_PERCENT as u32);
    percent.try_into().unwrap_or(MAX_UI_VOLUME_PERCENT)
}

fn run_capture(command: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("{command}: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("{}", out.status)
        };
        return Err(format!("{command} failed: {detail}"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn run_wpctl_status<const N: usize>(args: [&str; N]) -> Result<(), String> {
    let out = Command::new("wpctl")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .output()
        .map_err(|e| format!("wpctl: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if detail.is_empty() {
        return Err(format!("wpctl failed: {}", out.status));
    }
    Err(format!("wpctl failed: {detail}"))
}

fn parse_pw_dump_inventory(raw: &str) -> Result<Vec<AudioNodeInventory>, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("pw-dump: {e}"))?;
    let rows = value
        .as_array()
        .ok_or_else(|| "pw-dump: expected top-level array".to_string())?;
    let mut out = BTreeMap::<u32, AudioNodeInventory>::new();
    for row in rows {
        let Some(id) = row
            .get("id")
            .and_then(|v| v.as_u64())
            .and_then(|v| u32::try_from(v).ok())
        else {
            continue;
        };
        if id == 0 {
            continue;
        }
        let props = row
            .get("info")
            .and_then(|v| v.get("props"))
            .and_then(|v| v.as_object())
            .or_else(|| row.get("properties").and_then(|v| v.as_object()));
        let Some(props) = props else {
            continue;
        };
        let Some(kind) = audio_node_kind_from_props(props) else {
            continue;
        };
        let name = prop_string(props, "node.name");
        if kind == AudioNodeKind::Source && name.contains(".monitor") {
            continue;
        }
        out.insert(
            id,
            AudioNodeInventory {
                id,
                kind,
                name,
                nick: prop_string(props, "node.nick"),
                description: prop_string(props, "node.description"),
                media_name: prop_string(props, "media.name"),
                app_name: prop_string(props, "application.name"),
                binary_name: prop_string(props, "application.process.binary"),
            },
        );
    }
    Ok(out.into_values().collect())
}

fn audio_node_kind_from_props(
    props: &serde_json::Map<String, serde_json::Value>,
) -> Option<AudioNodeKind> {
    let media_class = props.get("media.class").and_then(|v| v.as_str())?;
    if media_class.starts_with("Audio/Sink") {
        return Some(AudioNodeKind::Sink);
    }
    if media_class.starts_with("Audio/Source") {
        return Some(AudioNodeKind::Source);
    }
    if media_class.starts_with("Stream/Output/Audio") {
        return Some(AudioNodeKind::PlaybackStream);
    }
    if media_class.starts_with("Stream/Input/Audio") {
        return Some(AudioNodeKind::CaptureStream);
    }
    None
}

fn prop_string(props: &serde_json::Map<String, serde_json::Value>, key: &str) -> String {
    props
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn parse_wpctl_status_default_ids(raw: &str) -> (Option<u32>, Option<u32>) {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Section {
        None,
        Sinks,
        Sources,
    }

    let mut in_audio = false;
    let mut section = Section::None;
    let mut default_sink_id = None;
    let mut default_source_id = None;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed == "Audio" {
            in_audio = true;
            section = Section::None;
            continue;
        }
        if in_audio
            && !trimmed.is_empty()
            && !line.starts_with(' ')
            && !line.starts_with('│')
            && !line.starts_with('├')
            && !line.starts_with('└')
        {
            break;
        }
        if !in_audio {
            continue;
        }
        if trimmed.ends_with("Sinks:") {
            section = Section::Sinks;
            continue;
        }
        if trimmed.ends_with("Sources:") {
            section = Section::Sources;
            continue;
        }
        let Some((id, is_default)) = parse_wpctl_status_entry_id(line) else {
            continue;
        };
        match section {
            Section::Sinks if is_default => default_sink_id = Some(id),
            Section::Sources if is_default => default_source_id = Some(id),
            _ => {}
        }
    }
    (default_sink_id, default_source_id)
}

fn parse_wpctl_status_entry_id(line: &str) -> Option<(u32, bool)> {
    let bytes = line.as_bytes();
    let mut idx = 0usize;
    while idx < bytes.len() {
        if !bytes[idx].is_ascii_digit() {
            idx += 1;
            continue;
        }
        let start = idx;
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        if idx + 1 < bytes.len() && bytes[idx] == b'.' && bytes[idx + 1] == b' ' {
            let id = line[start..idx].parse::<u32>().ok()?;
            return Some((id, line[..start].contains('*')));
        }
    }
    None
}

fn parse_wpctl_get_volume(s: &str) -> Option<(u16, bool)> {
    let line = s.lines().next()?.trim();
    let muted = line.contains("[MUTED]");
    let rest = line.strip_prefix("Volume:")?.trim();
    let num = rest.split_whitespace().next()?;
    let v: f32 = num.parse().ok()?;
    let lin = (v * 10000.0_f32).round() as i64;
    let lin = lin.clamp(0, 65535) as u16;
    Some((lin, muted))
}

fn endpoint_label(node: &AudioNodeInventory) -> String {
    first_non_empty(
        [
            node.description.as_str(),
            node.nick.as_str(),
            node.media_name.as_str(),
            node.name.as_str(),
        ],
        format!("Audio {}", node.id),
    )
}

fn stream_label(node: &AudioNodeInventory) -> String {
    first_non_empty(
        [
            node.media_name.as_str(),
            node.app_name.as_str(),
            node.description.as_str(),
            node.name.as_str(),
        ],
        format!("Stream {}", node.id),
    )
}

fn endpoint_subtitle(node: &AudioNodeInventory) -> String {
    let label = endpoint_label(node);
    join_distinct_parts([node.name.as_str(), node.media_name.as_str()], &label)
}

fn stream_subtitle(node: &AudioNodeInventory) -> String {
    let label = stream_label(node);
    join_distinct_parts(
        [
            node.app_name.as_str(),
            node.binary_name.as_str(),
            node.name.as_str(),
        ],
        &label,
    )
}

fn first_non_empty<const N: usize>(values: [&str; N], fallback: String) -> String {
    for value in values {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    fallback
}

fn join_distinct_parts<const N: usize>(values: [&str; N], label: &str) -> String {
    let mut parts = Vec::<String>::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.eq_ignore_ascii_case(label) {
            continue;
        }
        if parts
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(trimmed))
        {
            continue;
        }
        parts.push(trimmed.to_string());
    }
    parts.join(" | ")
}

#[cfg(test)]
mod tests {
    use super::{
        parse_pw_dump_inventory, parse_wpctl_get_volume, parse_wpctl_status_default_ids,
        percent_from_linear_x100, AudioNodeKind,
    };

    #[test]
    fn parse_wpctl_status_default_ids_reads_sink_and_source() {
        let raw = r#"PipeWire 'pipewire-0' [1.6.3]
Audio
 ├─ Devices:
 │      43. alsa_card.usb-test [alsa]
 │
 ├─ Sinks:
 │      51. alsa_output.usb-test.analog-stereo [vol: 0.40]
 │  *   69. alsa_output.pci-test.hdmi-stereo [vol: 0.55]
 │
 ├─ Sources:
 │  *   52. alsa_input.usb-test.analog-stereo [vol: 1.00]
 │
 └─ Streams:
Video
"#;
        assert_eq!(parse_wpctl_status_default_ids(raw), (Some(69), Some(52)));
    }

    #[test]
    fn parse_pw_dump_inventory_collects_audio_nodes() {
        let raw = r#"[
  {
    "id": 51,
    "type": "PipeWire:Interface:Node",
    "info": {
      "props": {
        "media.class": "Audio/Sink",
        "node.name": "alsa_output.pci-test.hdmi-stereo",
        "node.nick": "HDMI",
        "node.description": "Intel HDMI"
      }
    }
  },
  {
    "id": 52,
    "type": "PipeWire:Interface:Node",
    "info": {
      "props": {
        "media.class": "Audio/Source",
        "node.name": "alsa_input.usb-test.analog-stereo",
        "node.description": "USB Mic"
      }
    }
  },
  {
    "id": 53,
    "type": "PipeWire:Interface:Node",
    "info": {
      "props": {
        "media.class": "Audio/Source",
        "node.name": "alsa_output.pci-test.hdmi-stereo.monitor",
        "node.description": "Monitor of HDMI"
      }
    }
  },
  {
    "id": 77,
    "type": "PipeWire:Interface:Node",
    "info": {
      "props": {
        "media.class": "Stream/Output/Audio",
        "node.name": "firefox.output",
        "application.name": "Firefox",
        "media.name": "YouTube"
      }
    }
  },
  {
    "id": 78,
    "type": "PipeWire:Interface:Node",
    "info": {
      "props": {
        "media.class": "Stream/Input/Audio",
        "node.name": "obs.input",
        "application.name": "OBS",
        "media.name": "Mic Capture"
      }
    }
  }
]"#;
        let nodes = parse_pw_dump_inventory(raw).unwrap();
        assert_eq!(nodes.len(), 4);
        assert_eq!(nodes[0].kind, AudioNodeKind::Sink);
        assert_eq!(nodes[1].kind, AudioNodeKind::Source);
        assert_eq!(nodes[2].kind, AudioNodeKind::PlaybackStream);
        assert_eq!(nodes[3].kind, AudioNodeKind::CaptureStream);
    }

    #[test]
    fn parse_wpctl_get_volume_handles_muted_output() {
        assert_eq!(
            parse_wpctl_get_volume("Volume: 0.40 [MUTED]\n"),
            Some((4000, true))
        );
    }

    #[test]
    fn percent_from_linear_x100_clamps_amplified_values() {
        assert_eq!(percent_from_linear_x100(10200), 100);
        assert_eq!(percent_from_linear_x100(8000), 80);
    }
}
