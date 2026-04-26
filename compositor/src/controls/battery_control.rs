use serde::Serialize;
use zbus::blocking::{Connection, Proxy};

const UPOWER_DEST: &str = "org.freedesktop.UPower";
const UPOWER_DISPLAY_DEVICE_PATH: &str = "/org/freedesktop/UPower/devices/DisplayDevice";
const UPOWER_DEVICE_IFACE: &str = "org.freedesktop.UPower.Device";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BatteryStatePayload {
    pub backend: &'static str,
    pub is_present: bool,
    pub percentage: u16,
    pub state: String,
    pub time_to_empty_seconds: u64,
    pub time_to_full_seconds: u64,
    pub icon_name: String,
}

pub fn read_battery_state_json() -> Result<String, String> {
    let conn = Connection::system().map_err(|e| format!("upower system bus: {e}"))?;
    let proxy = Proxy::new(
        &conn,
        UPOWER_DEST,
        UPOWER_DISPLAY_DEVICE_PATH,
        UPOWER_DEVICE_IFACE,
    )
    .map_err(|e| format!("upower display device proxy: {e}"))?;

    let is_present = proxy
        .get_property::<bool>("IsPresent")
        .map_err(|e| format!("upower IsPresent: {e}"))?;
    let percentage = proxy
        .get_property::<f64>("Percentage")
        .map(|value| sanitize_percentage(value))
        .map_err(|e| format!("upower Percentage: {e}"))?;
    let state = proxy
        .get_property::<u32>("State")
        .map(upower_state_label)
        .map(str::to_string)
        .map_err(|e| format!("upower State: {e}"))?;
    let time_to_empty_seconds = proxy
        .get_property::<i64>("TimeToEmpty")
        .map(sanitize_seconds)
        .map_err(|e| format!("upower TimeToEmpty: {e}"))?;
    let time_to_full_seconds = proxy
        .get_property::<i64>("TimeToFull")
        .map(sanitize_seconds)
        .map_err(|e| format!("upower TimeToFull: {e}"))?;
    let icon_name = proxy
        .get_property::<String>("IconName")
        .map_err(|e| format!("upower IconName: {e}"))?;

    serde_json::to_string(&BatteryStatePayload {
        backend: "upower",
        is_present,
        percentage,
        state,
        time_to_empty_seconds,
        time_to_full_seconds,
        icon_name,
    })
    .map_err(|e| e.to_string())
}

fn sanitize_percentage(value: f64) -> u16 {
    if !value.is_finite() {
        return 0;
    }
    value.round().clamp(0.0, 100.0) as u16
}

fn sanitize_seconds(value: i64) -> u64 {
    value.max(0) as u64
}

fn upower_state_label(value: u32) -> &'static str {
    match value {
        1 => "charging",
        2 => "discharging",
        3 => "empty",
        4 => "fully-charged",
        5 => "pending-charge",
        6 => "pending-discharge",
        _ => "unknown",
    }
}
