use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Serialize};

pub fn state_dir() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("DERP_STATE_DIR") {
        if !path.is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    let mut path = dirs::config_dir()?;
    path.push("derp-workspace");
    path.push("state");
    Some(path)
}

pub fn state_file_path(file_name: &str) -> Option<PathBuf> {
    let mut path = state_dir()?;
    path.push(file_name);
    Some(path)
}

pub fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())
}

pub fn read_json_file<T: DeserializeOwned + Default>(path: &Path, action: &str) -> T {
    let raw = match std::fs::read_to_string(path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return T::default(),
        Err(e) => {
            tracing::warn!(target: "derp_json_state", ?e, path = %path.display(), action, "read json state");
            return T::default();
        }
    };
    match serde_json::from_str::<T>(&raw) {
        Ok(value) => value,
        Err(e) => {
            tracing::warn!(target: "derp_json_state", ?e, path = %path.display(), action, "parse json state");
            T::default()
        }
    }
}

pub fn write_json_file<T: Serialize>(path: &Path, value: &T, action: &str) -> Result<(), String> {
    ensure_parent_dir(path)?;
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, format!("{json}\n")).map_err(|e| {
        tracing::warn!(target: "derp_json_state", ?e, path = %path.display(), action, "write json state");
        e.to_string()
    })
}

#[cfg(test)]
pub(crate) fn test_state_dir_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

#[cfg(test)]
mod tests {
    use super::{read_json_file, state_file_path, test_state_dir_lock, write_json_file};

    #[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq, Default)]
    struct TestValue {
        value: String,
    }

    #[test]
    fn reads_and_writes_json_state_files() {
        let _guard = test_state_dir_lock().lock().unwrap();
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "derp-json-state-test-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("main")
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("DERP_STATE_DIR", &dir);

        let path = state_file_path("sample.json").unwrap();
        write_json_file(
            &path,
            &TestValue { value: "ok".into() },
            "write test json state",
        )
        .unwrap();

        assert_eq!(
            read_json_file::<TestValue>(&path, "read test json state"),
            TestValue { value: "ok".into() }
        );

        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("DERP_STATE_DIR");
    }
}
