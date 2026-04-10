use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct DesktopAppUsageFile {
    pub version: u32,
    pub counts: BTreeMap<String, u64>,
}

pub fn sanitize_desktop_app_usage(mut usage: DesktopAppUsageFile) -> DesktopAppUsageFile {
    usage.version = 1;
    usage.counts.retain(|key, count| !key.trim().is_empty() && *count > 0);
    usage
}

pub fn desktop_app_usage_path() -> Option<std::path::PathBuf> {
    crate::json_state::state_file_path("desktop-app-usage.json")
}

pub fn read_desktop_app_usage() -> DesktopAppUsageFile {
    let Some(path) = desktop_app_usage_path() else {
        return sanitize_desktop_app_usage(DesktopAppUsageFile::default());
    };
    sanitize_desktop_app_usage(crate::json_state::read_json_file(&path, "read desktop app usage"))
}

pub fn read_desktop_app_usage_json() -> Result<String, String> {
    serde_json::to_string(&read_desktop_app_usage().counts).map_err(|e| e.to_string())
}

pub fn increment_desktop_app_usage(key: String) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("missing key".into());
    }
    let Some(path) = desktop_app_usage_path() else {
        return Err("missing state dir".into());
    };
    let mut usage = read_desktop_app_usage();
    usage.version = 1;
    *usage.counts.entry(trimmed.to_string()).or_insert(0) += 1;
    crate::json_state::write_json_file(&path, &usage, "write desktop app usage")
}

#[cfg(test)]
mod tests {
    use super::{
        DesktopAppUsageFile, desktop_app_usage_path, increment_desktop_app_usage,
        read_desktop_app_usage, sanitize_desktop_app_usage,
    };
    use std::collections::BTreeMap;

    #[test]
    fn sanitize_desktop_app_usage_drops_invalid_entries() {
        let mut counts = BTreeMap::new();
        counts.insert(String::new(), 4);
        counts.insert("firefox.desktop".into(), 2);
        assert_eq!(
            sanitize_desktop_app_usage(DesktopAppUsageFile { version: 0, counts }),
            DesktopAppUsageFile {
                version: 1,
                counts: BTreeMap::from([("firefox.desktop".into(), 2)]),
            }
        );
    }

    #[test]
    fn increments_usage_in_its_own_state_file() {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "derp-desktop-app-usage-test-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("main")
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("DERP_STATE_DIR", &dir);

        increment_desktop_app_usage("firefox.desktop".into()).unwrap();
        increment_desktop_app_usage("firefox.desktop".into()).unwrap();

        assert_eq!(
            read_desktop_app_usage(),
            DesktopAppUsageFile {
                version: 1,
                counts: BTreeMap::from([("firefox.desktop".into(), 2)]),
            }
        );

        let path = desktop_app_usage_path().unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"counts\""));
        assert!(raw.contains("\"firefox.desktop\": 2"));

        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("DERP_STATE_DIR");
    }
}
