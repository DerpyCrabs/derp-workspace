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
    crate::json_state::state_file_path("session-state.json")
}

pub fn read_session_state() -> SessionStateFile {
    let Some(path) = session_state_path() else {
        return SessionStateFile::default();
    };
    sanitize_session_state(crate::json_state::read_json_file(&path, "read session state"))
}

pub fn read_session_state_json() -> Result<String, String> {
    serde_json::to_string(&read_session_state()).map_err(|e| e.to_string())
}

pub fn write_session_state(state: SessionStateFile) -> Result<(), String> {
    let Some(path) = session_state_path() else {
        return Err("session state path unavailable".into());
    };
    crate::json_state::write_json_file(
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

#[cfg(test)]
mod tests {
    use super::{read_session_state, session_state_path, write_session_state, SessionStateFile};
    use serde_json::json;

    #[test]
    fn reads_and_writes_session_state() {
        let _guard = crate::json_state::test_state_dir_lock().lock().unwrap();
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
        let _guard = crate::json_state::test_state_dir_lock().lock().unwrap();
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "derp-session-state-sanitize-test-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("main")
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("DERP_STATE_DIR", &dir);

        let path = session_state_path().unwrap();
        crate::json_state::write_json_file(
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
