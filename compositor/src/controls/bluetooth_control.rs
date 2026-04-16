use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BluetoothControllerState {
    pub address: String,
    pub name: String,
    pub alias: String,
    pub powered: bool,
    pub pairable: bool,
    pub discoverable: bool,
    pub discovering: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BluetoothDeviceState {
    pub address: String,
    pub name: String,
    pub paired: bool,
    pub bonded: bool,
    pub trusted: bool,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BluetoothStatePayload {
    pub backend: &'static str,
    pub soft_blocked: bool,
    pub hard_blocked: bool,
    pub controller: Option<BluetoothControllerState>,
    pub devices: Vec<BluetoothDeviceState>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct BluetoothDeviceInfo {
    paired: bool,
    bonded: bool,
    trusted: bool,
    connected: bool,
}

pub fn read_bluetooth_state_json() -> Result<String, String> {
    ensure_bluetoothctl()?;
    let controllers_raw = run_bluetoothctl_capture(&["list"])?;
    let has_controller = parse_controller_list(&controllers_raw);
    let controller = if has_controller {
        let raw = run_bluetoothctl_capture(&["show"])?;
        parse_controller_show(&raw)
    } else {
        None
    };
    let (soft_blocked, hard_blocked) = read_rfkill_state();
    let devices = if controller.is_some() {
        read_bluetooth_devices()?
    } else {
        Vec::new()
    };
    serde_json::to_string(&BluetoothStatePayload {
        backend: "bluez",
        soft_blocked,
        hard_blocked,
        controller,
        devices,
    })
    .map_err(|e| e.to_string())
}

pub fn scan_bluetooth() -> Result<(), String> {
    ensure_bluetoothctl()?;
    let _ = run_bluetoothctl_capture(&["--timeout", "5", "scan", "on"])?;
    let _ = run_bluetoothctl_status(["scan", "off"]);
    Ok(())
}

pub fn set_bluetooth_power(enabled: bool) -> Result<(), String> {
    ensure_bluetoothctl()?;
    run_bluetoothctl_status(["power", if enabled { "on" } else { "off" }])
}

pub fn set_bluetooth_pairable(enabled: bool) -> Result<(), String> {
    ensure_bluetoothctl()?;
    run_bluetoothctl_status(["pairable", if enabled { "on" } else { "off" }])
}

pub fn set_bluetooth_discoverable(enabled: bool) -> Result<(), String> {
    ensure_bluetoothctl()?;
    run_bluetoothctl_status(["discoverable", if enabled { "on" } else { "off" }])
}

pub fn pair_and_connect_bluetooth_device(address: &str) -> Result<(), String> {
    ensure_bluetoothctl()?;
    let address = validate_device_address(address)?;
    let before = read_bluetooth_device_info(&address)?;
    if !before.paired {
        let output = run_bluetoothctl_script(
            &[
                "agent on".to_string(),
                "default-agent".to_string(),
                format!("pair {address}"),
            ],
            Some(45),
        )?;
        let after_pair = read_bluetooth_device_info(&address)?;
        if !after_pair.paired {
            let detail = summarize_bluetoothctl_output(&output);
            return Err(format!(
                "bluetooth pairing did not complete for {address}: {detail}"
            ));
        }
    }
    let after_pair = read_bluetooth_device_info(&address)?;
    if !after_pair.trusted {
        run_bluetoothctl_status(["trust", &address])?;
    }
    if !after_pair.connected {
        run_bluetoothctl_status(["connect", &address])?;
    }
    let after_connect = read_bluetooth_device_info(&address)?;
    if !after_connect.connected {
        return Err(format!("bluetooth connect did not complete for {address}"));
    }
    Ok(())
}

pub fn set_bluetooth_trust(address: &str, trusted: bool) -> Result<(), String> {
    ensure_bluetoothctl()?;
    let address = validate_device_address(address)?;
    if trusted {
        run_bluetoothctl_status(["trust", &address])
    } else {
        run_bluetoothctl_status(["untrust", &address])
    }
}

pub fn connect_bluetooth_device(address: &str) -> Result<(), String> {
    ensure_bluetoothctl()?;
    let address = validate_device_address(address)?;
    run_bluetoothctl_status(["connect", &address])
}

pub fn disconnect_bluetooth_device(address: &str) -> Result<(), String> {
    ensure_bluetoothctl()?;
    let address = validate_device_address(address)?;
    run_bluetoothctl_status(["disconnect", &address])
}

pub fn forget_bluetooth_device(address: &str) -> Result<(), String> {
    ensure_bluetoothctl()?;
    let address = validate_device_address(address)?;
    run_bluetoothctl_status(["remove", &address])
}

fn validate_device_address(address: &str) -> Result<String, String> {
    let address = address.trim();
    if address.is_empty() {
        return Err("bluetooth: missing device address".into());
    }
    Ok(address.to_string())
}

fn ensure_bluetoothctl() -> Result<(), String> {
    Command::new("bluetoothctl")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map(|_| ())
        .map_err(|e| format!("bluetoothctl: {e}"))
}

fn read_bluetooth_devices() -> Result<Vec<BluetoothDeviceState>, String> {
    let mut devices = parse_device_list(&run_bluetoothctl_capture(&["devices"])?)
        .into_iter()
        .map(|row| {
            (
                row.address.clone(),
                BluetoothDeviceState {
                    address: row.address,
                    name: row.name,
                    paired: false,
                    bonded: false,
                    trusted: false,
                    connected: false,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    apply_device_set(
        &mut devices,
        parse_device_set(&run_bluetoothctl_capture(&["devices", "Paired"])?),
        |row| row.paired = true,
    );
    apply_device_set(
        &mut devices,
        parse_device_set(&run_bluetoothctl_capture(&["devices", "Bonded"])?),
        |row| row.bonded = true,
    );
    apply_device_set(
        &mut devices,
        parse_device_set(&run_bluetoothctl_capture(&["devices", "Trusted"])?),
        |row| row.trusted = true,
    );
    apply_device_set(
        &mut devices,
        parse_device_set(&run_bluetoothctl_capture(&["devices", "Connected"])?),
        |row| row.connected = true,
    );
    let mut out = devices.into_values().collect::<Vec<_>>();
    out.sort_by(|a, b| {
        b.connected
            .cmp(&a.connected)
            .then_with(|| b.paired.cmp(&a.paired))
            .then_with(|| b.trusted.cmp(&a.trusted))
            .then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            })
            .then_with(|| a.address.cmp(&b.address))
    });
    Ok(out)
}

fn read_bluetooth_device_info(address: &str) -> Result<BluetoothDeviceInfo, String> {
    let raw = run_bluetoothctl_capture(&["info", address])?;
    Ok(parse_bluetooth_device_info(&raw))
}

fn apply_device_set(
    devices: &mut BTreeMap<String, BluetoothDeviceState>,
    addresses: BTreeSet<String>,
    apply: impl Fn(&mut BluetoothDeviceState),
) {
    for address in addresses {
        if let Some(row) = devices.get_mut(&address) {
            apply(row);
        } else {
            let mut row = BluetoothDeviceState {
                address: address.clone(),
                name: address.clone(),
                paired: false,
                bonded: false,
                trusted: false,
                connected: false,
            };
            apply(&mut row);
            devices.insert(address, row);
        }
    }
}

fn parse_controller_list(raw: &str) -> bool {
    strip_ansi(raw)
        .lines()
        .any(|line| line.trim_start().starts_with("Controller "))
}

fn parse_controller_show(raw: &str) -> Option<BluetoothControllerState> {
    let raw = strip_ansi(raw);
    let mut address = String::new();
    let mut name = String::new();
    let mut alias = String::new();
    let mut powered = false;
    let mut pairable = false;
    let mut discoverable = false;
    let mut discovering = false;
    for (index, line) in raw.lines().enumerate() {
        let line = line.trim_end();
        if index == 0 {
            if let Some(rest) = line.strip_prefix("Controller ") {
                let rest = rest.trim();
                let (parsed_address, parsed_name) = split_address_and_name(rest);
                address = parsed_address.to_string();
                name = parsed_name.to_string();
            }
            continue;
        }
        let trimmed = line.trim();
        if let Some((key, value)) = trimmed.split_once(':') {
            let value = value.trim();
            match key.trim() {
                "Name" if name.is_empty() => name = value.to_string(),
                "Alias" => alias = value.to_string(),
                "Powered" => powered = parse_yes_no(value),
                "Pairable" => pairable = parse_yes_no(value),
                "Discoverable" => discoverable = parse_yes_no(value),
                "Discovering" => discovering = parse_yes_no(value),
                _ => {}
            }
        }
    }
    if address.is_empty() {
        return None;
    }
    if name.is_empty() {
        name = alias.clone();
    }
    if alias.is_empty() {
        alias = name.clone();
    }
    Some(BluetoothControllerState {
        address,
        name,
        alias,
        powered,
        pairable,
        discoverable,
        discovering,
    })
}

fn parse_device_list(raw: &str) -> Vec<BluetoothDeviceState> {
    strip_ansi(raw)
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix("Device ")?;
            let (address, name) = split_address_and_name(rest);
            if address.is_empty() {
                return None;
            }
            Some(BluetoothDeviceState {
                address: address.to_string(),
                name: if name.is_empty() {
                    address.to_string()
                } else {
                    name.to_string()
                },
                paired: false,
                bonded: false,
                trusted: false,
                connected: false,
            })
        })
        .collect()
}

fn parse_device_set(raw: &str) -> BTreeSet<String> {
    parse_device_list(raw)
        .into_iter()
        .map(|row| row.address)
        .collect()
}

fn parse_bluetooth_device_info(raw: &str) -> BluetoothDeviceInfo {
    let raw = strip_ansi(raw);
    let mut info = BluetoothDeviceInfo::default();
    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some((key, value)) = trimmed.split_once(':') {
            let value = value.trim();
            match key.trim() {
                "Paired" => info.paired = parse_yes_no(value),
                "Bonded" => info.bonded = parse_yes_no(value),
                "Trusted" => info.trusted = parse_yes_no(value),
                "Connected" => info.connected = parse_yes_no(value),
                _ => {}
            }
        }
    }
    info
}

fn summarize_bluetoothctl_output(raw: &str) -> String {
    let cleaned = strip_ansi(raw);
    let lines = cleaned
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("[bluetoothctl]>"))
        .filter(|line| {
            !line.starts_with("[NEW]")
                && !line.starts_with("[CHG]")
                && !line.starts_with("Waiting to connect to bluetoothd")
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return "no useful bluetoothctl output".to_string();
    }
    lines.join(" | ")
}

fn read_rfkill_state() -> (bool, bool) {
    let out = Command::new("rfkill")
        .args(["list", "bluetooth"])
        .stdin(Stdio::null())
        .output();
    let Ok(out) = out else {
        return (false, false);
    };
    let raw = strip_ansi(&String::from_utf8_lossy(&out.stdout));
    let mut soft_blocked = false;
    let mut hard_blocked = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("Soft blocked:") {
            soft_blocked |= parse_yes_no(value.trim());
        } else if let Some(value) = trimmed.strip_prefix("Hard blocked:") {
            hard_blocked |= parse_yes_no(value.trim());
        }
    }
    (soft_blocked, hard_blocked)
}

fn parse_yes_no(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "yes" | "on" | "true" | "enabled"
    )
}

fn split_address_and_name(rest: &str) -> (&str, &str) {
    let rest = rest.trim();
    if rest.is_empty() {
        return ("", "");
    }
    match rest.split_once(' ') {
        Some((address, tail)) => {
            let tail = tail.trim();
            let name = if tail.starts_with('(') {
                ""
            } else {
                tail.split(" (").next().unwrap_or("").trim()
            };
            (address.trim(), name)
        }
        None => (rest, ""),
    }
}

fn strip_ansi(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek().copied() == Some('[') {
                let _ = chars.next();
                while let Some(next) = chars.next() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
                continue;
            }
        }
        out.push(ch);
    }
    out
}

fn run_bluetoothctl_capture(args: &[&str]) -> Result<String, String> {
    let out = Command::new("bluetoothctl")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("bluetoothctl: {e}"))?;
    if !out.status.success() {
        return Err(bluetoothctl_failure_detail(&out));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn run_bluetoothctl_status<const N: usize>(args: [&str; N]) -> Result<(), String> {
    let out = Command::new("bluetoothctl")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .output()
        .map_err(|e| format!("bluetoothctl: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(bluetoothctl_failure_detail(&out))
}

fn run_bluetoothctl_script(lines: &[String], timeout_secs: Option<u64>) -> Result<String, String> {
    let mut command = Command::new("bluetoothctl");
    if let Some(timeout_secs) = timeout_secs {
        command.args(["--timeout", &timeout_secs.to_string()]);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("bluetoothctl: {e}"))?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "bluetoothctl: missing stdin".to_string())?;
        for line in lines {
            stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .map_err(|e| format!("bluetoothctl stdin: {e}"))?;
        }
        stdin
            .write_all(b"quit\n")
            .map_err(|e| format!("bluetoothctl stdin: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("bluetoothctl: {e}"))?;
    if !out.status.success() {
        return Err(bluetoothctl_failure_detail(&out));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn bluetoothctl_failure_detail(out: &std::process::Output) -> String {
    let stderr = strip_ansi(&String::from_utf8_lossy(&out.stderr))
        .trim()
        .to_string();
    let stdout = strip_ansi(&String::from_utf8_lossy(&out.stdout))
        .trim()
        .to_string();
    if !stderr.is_empty() {
        return format!("bluetoothctl failed: {stderr}");
    }
    if !stdout.is_empty() {
        return format!("bluetoothctl failed: {stdout}");
    }
    format!("bluetoothctl failed: {}", out.status)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_bluetooth_device_info, parse_controller_list, parse_controller_show,
        parse_device_list, parse_device_set, split_address_and_name, strip_ansi,
        summarize_bluetoothctl_output,
    };

    #[test]
    fn split_address_and_name_handles_parenthesized_suffix() {
        assert_eq!(
            split_address_and_name("08:B4:D2:C7:FB:EA lunarempire (public)"),
            ("08:B4:D2:C7:FB:EA", "lunarempire")
        );
    }

    #[test]
    fn parse_controller_list_detects_controller() {
        assert!(parse_controller_list(
            "Controller 08:B4:D2:C7:FB:EA lunarempire [default]\n"
        ));
        assert!(!parse_controller_list(""));
    }

    #[test]
    fn parse_controller_show_reads_flags() {
        let controller = parse_controller_show(
            "Controller 08:B4:D2:C7:FB:EA (public)\n\tName: lunarempire\n\tAlias: desk\n\tPowered: yes\n\tDiscoverable: no\n\tPairable: yes\n\tDiscovering: no\n",
        )
        .unwrap();
        assert_eq!(controller.address, "08:B4:D2:C7:FB:EA");
        assert_eq!(controller.name, "lunarempire");
        assert_eq!(controller.alias, "desk");
        assert!(controller.powered);
        assert!(controller.pairable);
        assert!(!controller.discoverable);
        assert!(!controller.discovering);
    }

    #[test]
    fn parse_device_list_reads_names() {
        let rows = parse_device_list(
            "Device 40:ED:98:1D:2A:45 FIIO BTR17\nDevice D8:8C:5C:B7:E8:3B Slimboard\n",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].address, "40:ED:98:1D:2A:45");
        assert_eq!(rows[0].name, "FIIO BTR17");
    }

    #[test]
    fn parse_device_set_extracts_addresses() {
        let rows = parse_device_set("Device 40:ED:98:1D:2A:45 FIIO BTR17\n");
        assert!(rows.contains("40:ED:98:1D:2A:45"));
    }

    #[test]
    fn parse_bluetooth_device_info_reads_flags() {
        let info = parse_bluetooth_device_info(
            "Device 19:91:0B:11:61:1D (public)\n\tPaired: yes\n\tBonded: no\n\tTrusted: yes\n\tConnected: no\n",
        );
        assert!(info.paired);
        assert!(!info.bonded);
        assert!(info.trusted);
        assert!(!info.connected);
    }

    #[test]
    fn summarize_bluetoothctl_output_filters_noise() {
        let summary = summarize_bluetoothctl_output(
            "Waiting to connect to bluetoothd...\n[bluetoothctl]> pair 19:91:0B:11:61:1D\nAttempting to pair with 19:91:0B:11:61:1D\nFailed to pair: org.bluez.Error.AuthenticationFailed\n",
        );
        assert_eq!(
            summary,
            "Attempting to pair with 19:91:0B:11:61:1D | Failed to pair: org.bluez.Error.AuthenticationFailed"
        );
    }

    #[test]
    fn strip_ansi_removes_color_codes() {
        assert_eq!(strip_ansi("\u{1b}[1;39mhello\u{1b}[0m"), "hello");
    }
}
