use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionStateFile {
    #[serde(default = "default_session_state_version")]
    pub version: u32,
    #[serde(default = "default_shell_session_value")]
    pub shell: Value,
}

fn default_session_state_version() -> u32 {
    1
}

fn default_shell_session_value() -> Value {
    Value::Object(Map::new())
}

impl Default for SessionStateFile {
    fn default() -> Self {
        Self {
            version: default_session_state_version(),
            shell: default_shell_session_value(),
        }
    }
}

fn sanitize_session_state(mut value: SessionStateFile) -> SessionStateFile {
    if value.version == 0 {
        value.version = default_session_state_version();
    }
    if !value.shell.is_object() {
        value.shell = default_shell_session_value();
    }
    value
}

pub fn session_state_path() -> Option<std::path::PathBuf> {
    crate::session::json_state::state_file_path("session-state.json")
}

pub fn read_session_state() -> SessionStateFile {
    let Some(path) = session_state_path() else {
        return SessionStateFile::default();
    };
    sanitize_session_state(crate::session::json_state::read_json_file(
        &path,
        "read session state",
    ))
}

pub fn read_session_state_json() -> Result<String, String> {
    serde_json::to_string(&read_session_state()).map_err(|e| e.to_string())
}

pub fn write_session_state(state: SessionStateFile) -> Result<(), String> {
    let Some(path) = session_state_path() else {
        return Err("session state path unavailable".into());
    };
    crate::session::json_state::write_json_file(
        &path,
        &sanitize_session_state(state),
        "write session state",
    )
}

pub fn write_session_state_json(value: Value) -> Result<String, String> {
    let state = sanitize_session_state(
        serde_json::from_value::<SessionStateFile>(value).map_err(|e| e.to_string())?,
    );
    write_session_state(state.clone())?;
    serde_json::to_string(&state).map_err(|e| e.to_string())
}

pub fn merge_shell_hosted_into_session_value(root: &mut Value, by_window: &HashMap<u32, Value>) {
    if by_window.is_empty() {
        return;
    }
    let Some(shell) = root.get_mut("shell") else {
        return;
    };
    merge_shell_hosted_file_browser_into_shell_snapshot(shell, by_window);
}

fn merge_shell_hosted_file_browser_into_shell_snapshot(
    shell_snapshot: &mut Value,
    by_window: &HashMap<u32, Value>,
) {
    let Some(arr) = shell_snapshot
        .get_mut("shellWindows")
        .and_then(|x| x.as_array_mut())
    else {
        return;
    };
    for win in arr.iter_mut() {
        let Some(obj) = win.as_object_mut() else {
            continue;
        };
        let wid = obj
            .get("windowId")
            .and_then(|x| x.as_u64())
            .map(|u| u as u32);
        let kind = obj.get("kind").and_then(|x| x.as_str());
        if let (Some(wid), Some("file_browser")) = (wid, kind) {
            if let Some(st) = by_window.get(&wid) {
                obj.insert("state".to_string(), st.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{read_session_state, session_state_path, write_session_state, SessionStateFile};
    use serde_json::json;

    #[test]
    fn reads_and_writes_session_state() {
        let _guard = crate::session::json_state::test_state_dir_lock()
            .lock()
            .unwrap();
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "derp-session-state-test-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("main")
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("DERP_STATE_DIR", &dir);

        write_session_state(SessionStateFile {
            version: 1,
            shell: json!({
                "nativeWindows": [],
                "shellWindows": [{"windowId": 9002}]
            }),
        })
        .unwrap();

        let path = session_state_path().unwrap();
        assert!(path.exists());
        assert_eq!(
            read_session_state(),
            SessionStateFile {
                version: 1,
                shell: json!({
                    "nativeWindows": [],
                    "shellWindows": [{"windowId": 9002}]
                }),
            }
        );

        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("DERP_STATE_DIR");
    }

    #[test]
    fn sanitizes_non_object_shell_payload() {
        let _guard = crate::session::json_state::test_state_dir_lock()
            .lock()
            .unwrap();
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "derp-session-state-sanitize-test-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("main")
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("DERP_STATE_DIR", &dir);

        let path = session_state_path().unwrap();
        crate::session::json_state::write_json_file(
            &path,
            &serde_json::json!({"version": 0, "shell": "bad"}),
            "seed bad session state",
        )
        .unwrap();

        let loaded = read_session_state();
        assert_eq!(loaded.version, 1);
        assert_eq!(loaded.shell, serde_json::json!({}));

        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("DERP_STATE_DIR");
    }
}
