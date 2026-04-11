use std::collections::{BTreeSet, HashMap};
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WifiDeviceState {
    pub device: String,
    pub state: String,
    pub connection: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WifiAccessPoint {
    pub ssid: String,
    pub signal_percent: u16,
    pub security: String,
    pub bars: String,
    pub in_use: bool,
    pub is_saved: bool,
    pub requires_password: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WifiStatePayload {
    pub backend: &'static str,
    pub wifi_enabled: bool,
    pub devices: Vec<WifiDeviceState>,
    pub access_points: Vec<WifiAccessPoint>,
}

pub fn read_wifi_state_json() -> Result<String, String> {
    ensure_nmcli()?;
    let wifi_enabled = read_wifi_radio_enabled()?;
    let devices = read_wifi_devices()?;
    let access_points = if wifi_enabled {
        let saved_ssids = read_saved_wifi_ssids()?;
        read_wifi_access_points(&saved_ssids)?
    } else {
        Vec::new()
    };
    serde_json::to_string(&WifiStatePayload {
        backend: "networkmanager",
        wifi_enabled,
        devices,
        access_points,
    })
    .map_err(|e| e.to_string())
}

pub fn scan_wifi() -> Result<(), String> {
    ensure_nmcli()?;
    run_nmcli_status(["--wait", "10", "device", "wifi", "rescan"])
}

pub fn set_wifi_radio(enabled: bool) -> Result<(), String> {
    ensure_nmcli()?;
    run_nmcli_status(["radio", "wifi", if enabled { "on" } else { "off" }])
}

pub fn connect_wifi(ssid: &str, password: Option<&str>) -> Result<(), String> {
    ensure_nmcli()?;
    let ssid = ssid.trim();
    if ssid.is_empty() {
        return Err("wifi_connect: missing ssid".into());
    }
    let device = read_primary_wifi_device()?;
    let mut args = vec![
        "--wait".to_string(),
        "20".to_string(),
        "device".to_string(),
        "wifi".to_string(),
        "connect".to_string(),
        ssid.to_string(),
        "ifname".to_string(),
        device,
    ];
    let password = password.unwrap_or("").trim();
    if !password.is_empty() {
        args.push("password".to_string());
        args.push(password.to_string());
    }
    run_nmcli_status_vec(&args)
}

pub fn disconnect_wifi(device: Option<&str>) -> Result<(), String> {
    ensure_nmcli()?;
    let device = match device.map(str::trim).filter(|value| !value.is_empty()) {
        Some(device) => device.to_string(),
        None => read_primary_wifi_device()?,
    };
    run_nmcli_status_vec(&[
        "--wait".to_string(),
        "10".to_string(),
        "device".to_string(),
        "disconnect".to_string(),
        device,
    ])
}

fn ensure_nmcli() -> Result<(), String> {
    Command::new("nmcli")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map(|_| ())
        .map_err(|e| format!("nmcli: {e}"))
}

fn read_wifi_radio_enabled() -> Result<bool, String> {
    let raw = run_nmcli_capture(&["-t", "-e", "yes", "-f", "WIFI", "general", "status"])?;
    let value = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    Ok(value.eq_ignore_ascii_case("enabled"))
}

fn read_wifi_devices() -> Result<Vec<WifiDeviceState>, String> {
    let raw = run_nmcli_capture(&[
        "-t",
        "-e",
        "yes",
        "-f",
        "DEVICE,TYPE,STATE,CONNECTION",
        "device",
        "status",
    ])?;
    let mut devices = Vec::new();
    for line in raw.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let parts = split_nmcli_fields(line);
        if parts.len() < 4 || parts[1] != "wifi" {
            continue;
        }
        devices.push(WifiDeviceState {
            device: parts[0].trim().to_string(),
            state: parts[2].trim().to_string(),
            connection: parts[3].trim().to_string(),
        });
    }
    devices.sort_by(|a, b| {
        wifi_device_rank(&a.state)
            .cmp(&wifi_device_rank(&b.state))
            .then_with(|| {
                a.device
                    .to_ascii_lowercase()
                    .cmp(&b.device.to_ascii_lowercase())
            })
    });
    Ok(devices)
}

fn read_primary_wifi_device() -> Result<String, String> {
    read_wifi_devices()?
        .into_iter()
        .map(|row| row.device)
        .find(|value| !value.is_empty())
        .ok_or_else(|| "wifi: no Wi-Fi device found".to_string())
}

fn read_saved_wifi_ssids() -> Result<BTreeSet<String>, String> {
    let raw = run_nmcli_capture(&["-t", "-e", "yes", "-f", "NAME,TYPE", "connection", "show"])?;
    let mut out = BTreeSet::new();
    for line in raw.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let parts = split_nmcli_fields(line);
        if parts.len() < 2 || parts[1] != "802-11-wireless" {
            continue;
        }
        let name = parts[0].trim();
        if !name.is_empty() {
            out.insert(name.to_string());
        }
    }
    Ok(out)
}

fn read_wifi_access_points(saved_ssids: &BTreeSet<String>) -> Result<Vec<WifiAccessPoint>, String> {
    let raw = run_nmcli_capture(&[
        "-t",
        "-e",
        "yes",
        "-f",
        "IN-USE,SSID,SIGNAL,SECURITY,BARS,ACTIVE",
        "device",
        "wifi",
        "list",
        "--rescan",
        "no",
    ])?;
    let mut deduped = HashMap::<String, WifiAccessPoint>::new();
    for line in raw.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let parts = split_nmcli_fields(line);
        if parts.len() < 6 {
            continue;
        }
        let ssid = parts[1].trim().to_string();
        if ssid.is_empty() {
            continue;
        }
        let candidate = WifiAccessPoint {
            ssid: ssid.clone(),
            signal_percent: parts[2]
                .trim()
                .parse::<u16>()
                .ok()
                .map(|value| value.min(100))
                .unwrap_or(0),
            security: parts[3].trim().to_string(),
            bars: parts[4].trim().to_string(),
            in_use: parts[0].trim() == "*" || parts[5].trim().eq_ignore_ascii_case("yes"),
            is_saved: saved_ssids.contains(&ssid),
            requires_password: wifi_security_requires_password(parts[3].trim()),
        };
        match deduped.get_mut(&ssid) {
            Some(existing) if should_replace_access_point(existing, &candidate) => {
                *existing = candidate
            }
            None => {
                deduped.insert(ssid, candidate);
            }
            _ => {}
        }
    }
    let mut access_points = deduped.into_values().collect::<Vec<_>>();
    access_points.sort_by(|a, b| {
        b.in_use
            .cmp(&a.in_use)
            .then_with(|| b.is_saved.cmp(&a.is_saved))
            .then_with(|| b.signal_percent.cmp(&a.signal_percent))
            .then_with(|| {
                a.ssid
                    .to_ascii_lowercase()
                    .cmp(&b.ssid.to_ascii_lowercase())
            })
    });
    Ok(access_points)
}

fn should_replace_access_point(existing: &WifiAccessPoint, candidate: &WifiAccessPoint) -> bool {
    candidate
        .in_use
        .cmp(&existing.in_use)
        .then_with(|| candidate.is_saved.cmp(&existing.is_saved))
        .then_with(|| candidate.signal_percent.cmp(&existing.signal_percent))
        .then_with(|| {
            existing
                .security
                .is_empty()
                .cmp(&candidate.security.is_empty())
        })
        .is_gt()
}

fn wifi_security_requires_password(security: &str) -> bool {
    let upper = security.trim().to_ascii_uppercase();
    upper.contains("WEP")
        || upper.contains("WPA")
        || upper.contains("SAE")
        || upper.contains("802.1X")
}

fn wifi_device_rank(state: &str) -> (u8, String) {
    let normalized = state.trim().to_ascii_lowercase();
    let rank = if normalized.contains("connected") {
        0
    } else if normalized.contains("connecting") {
        1
    } else {
        2
    };
    (rank, normalized)
}

fn run_nmcli_capture(args: &[&str]) -> Result<String, String> {
    let out = Command::new("nmcli")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("nmcli: {e}"))?;
    if !out.status.success() {
        return Err(nmcli_failure_detail(&out));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn run_nmcli_status<const N: usize>(args: [&str; N]) -> Result<(), String> {
    let args = args
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    run_nmcli_status_vec(&args)
}

fn run_nmcli_status_vec(args: &[String]) -> Result<(), String> {
    let out = Command::new("nmcli")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .output()
        .map_err(|e| format!("nmcli: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(nmcli_failure_detail(&out))
}

fn nmcli_failure_detail(out: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !stderr.is_empty() {
        return format!("nmcli failed: {stderr}");
    }
    if !stdout.is_empty() {
        return format!("nmcli failed: {stdout}");
    }
    format!("nmcli failed: {}", out.status)
}

fn split_nmcli_fields(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for ch in line.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == ':' {
            fields.push(current);
            current = String::new();
            continue;
        }
        current.push(ch);
    }
    if escaped {
        current.push('\\');
    }
    fields.push(current);
    fields
}

#[cfg(test)]
mod tests {
    use super::{
        should_replace_access_point, split_nmcli_fields, wifi_device_rank,
        wifi_security_requires_password, WifiAccessPoint,
    };

    #[test]
    fn split_nmcli_fields_unescapes_colons() {
        assert_eq!(
            split_nmcli_fields(r#"*:Cafe\:Guest:61:WPA2:▂▄▆_:yes"#),
            vec!["*", "Cafe:Guest", "61", "WPA2", "▂▄▆_", "yes"]
        );
    }

    #[test]
    fn wifi_security_requires_password_matches_wpa_and_open() {
        assert!(wifi_security_requires_password("WPA2 WPA3"));
        assert!(wifi_security_requires_password("WEP"));
        assert!(!wifi_security_requires_password(""));
        assert!(!wifi_security_requires_password("OWE"));
    }

    #[test]
    fn should_replace_access_point_prefers_connected_then_signal() {
        let existing = WifiAccessPoint {
            ssid: "Cafe".into(),
            signal_percent: 80,
            security: "WPA2".into(),
            bars: "▂▄▆█".into(),
            in_use: false,
            is_saved: false,
            requires_password: true,
        };
        let connected = WifiAccessPoint {
            ssid: "Cafe".into(),
            signal_percent: 50,
            security: "WPA2".into(),
            bars: "▂▄__".into(),
            in_use: true,
            is_saved: false,
            requires_password: true,
        };
        assert!(should_replace_access_point(&existing, &connected));
    }

    #[test]
    fn wifi_device_rank_sorts_connected_first() {
        assert!(wifi_device_rank("connected") < wifi_device_rank("disconnected"));
    }
}
