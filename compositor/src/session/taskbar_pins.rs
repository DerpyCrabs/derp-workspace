use crate::session::workspace_model::{WorkspaceTaskbarPin, WorkspaceTaskbarPinMonitor};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskbarPinsFile {
    #[serde(default)]
    pub monitors: Vec<WorkspaceTaskbarPinMonitor>,
}

fn taskbar_pins_path() -> Option<std::path::PathBuf> {
    crate::session::json_state::state_file_path("taskbar-pins.json")
}

fn sanitize_text(value: &str, max_len: usize) -> String {
    value.trim().chars().take(max_len).collect()
}

fn sanitize_pin(pin: WorkspaceTaskbarPin) -> Option<WorkspaceTaskbarPin> {
    match pin {
        WorkspaceTaskbarPin::App {
            id,
            label,
            command,
            desktop_id,
            app_name,
            desktop_icon,
        } => {
            let id = sanitize_text(&id, 512);
            let label = sanitize_text(&label, 256);
            let command = sanitize_text(&command, 4096);
            if id.is_empty() || label.is_empty() || command.is_empty() {
                return None;
            }
            Some(WorkspaceTaskbarPin::App {
                id,
                label,
                command,
                desktop_id: desktop_id
                    .map(|value| sanitize_text(&value, 512))
                    .filter(|value| !value.is_empty()),
                app_name: app_name
                    .map(|value| sanitize_text(&value, 256))
                    .filter(|value| !value.is_empty()),
                desktop_icon: desktop_icon
                    .map(|value| sanitize_text(&value, 512))
                    .filter(|value| !value.is_empty()),
            })
        }
        WorkspaceTaskbarPin::Folder { id, label, path } => {
            let id = sanitize_text(&id, 512);
            let label = sanitize_text(&label, 256);
            let path = sanitize_text(&path, 4096);
            if id.is_empty() || label.is_empty() || path.is_empty() {
                return None;
            }
            Some(WorkspaceTaskbarPin::Folder { id, label, path })
        }
    }
}

pub fn taskbar_pin_id(pin: &WorkspaceTaskbarPin) -> &str {
    match pin {
        WorkspaceTaskbarPin::App { id, .. } | WorkspaceTaskbarPin::Folder { id, .. } => id,
    }
}

pub fn sanitize_taskbar_pins(
    monitors: Vec<WorkspaceTaskbarPinMonitor>,
) -> Vec<WorkspaceTaskbarPinMonitor> {
    let mut out = Vec::new();
    let mut seen_monitors = std::collections::HashSet::new();
    for monitor in monitors {
        let output_name = sanitize_text(&monitor.output_name, 256);
        if output_name.is_empty() {
            continue;
        }
        let output_id = sanitize_text(&monitor.output_id, 512);
        let monitor_key = if output_id.is_empty() {
            format!("name:{output_name}")
        } else {
            format!("id:{output_id}")
        };
        if !seen_monitors.insert(monitor_key) {
            continue;
        }
        let mut pins = Vec::new();
        let mut seen_pins = std::collections::HashSet::new();
        for pin in monitor.pins {
            let Some(pin) = sanitize_pin(pin) else {
                continue;
            };
            if !seen_pins.insert(taskbar_pin_id(&pin).to_string()) {
                continue;
            }
            pins.push(pin);
        }
        if !pins.is_empty() {
            out.push(WorkspaceTaskbarPinMonitor {
                output_id,
                output_name,
                pins,
            });
        }
    }
    out
}

pub fn read_taskbar_pins() -> Vec<WorkspaceTaskbarPinMonitor> {
    let Some(path) = taskbar_pins_path() else {
        return Vec::new();
    };
    sanitize_taskbar_pins(
        crate::session::json_state::read_json_file::<TaskbarPinsFile>(&path, "read taskbar pins")
            .monitors,
    )
}

pub fn write_taskbar_pins(monitors: Vec<WorkspaceTaskbarPinMonitor>) -> Result<(), String> {
    let Some(path) = taskbar_pins_path() else {
        return Err("taskbar pins path unavailable".into());
    };
    crate::session::json_state::write_json_file(
        &path,
        &TaskbarPinsFile {
            monitors: sanitize_taskbar_pins(monitors),
        },
        "write taskbar pins",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_pin(id: &str, label: &str, command: &str) -> WorkspaceTaskbarPin {
        WorkspaceTaskbarPin::App {
            id: id.into(),
            label: label.into(),
            command: command.into(),
            desktop_id: Some("org.example.App.desktop".into()),
            app_name: Some(label.into()),
            desktop_icon: Some("example".into()),
        }
    }

    fn folder_pin(id: &str, label: &str, path: &str) -> WorkspaceTaskbarPin {
        WorkspaceTaskbarPin::Folder {
            id: id.into(),
            label: label.into(),
            path: path.into(),
        }
    }

    #[test]
    fn sanitize_keeps_per_monitor_pins_distinct_and_ordered() {
        let pins = sanitize_taskbar_pins(vec![
            WorkspaceTaskbarPinMonitor {
                output_id: "make:model:serial-a".into(),
                output_name: "DP-1".into(),
                pins: vec![
                    app_pin("app:org.example.App.desktop", "Example", "example"),
                    app_pin("app:org.example.App.desktop", "Duplicate", "example"),
                ],
            },
            WorkspaceTaskbarPinMonitor {
                output_id: "make:model:serial-b".into(),
                output_name: "DP-1".into(),
                pins: vec![folder_pin(
                    "folder:/home/crab/Projects",
                    "Projects",
                    "/home/crab/Projects",
                )],
            },
        ]);

        assert_eq!(pins.len(), 2);
        assert_eq!(pins[0].output_id, "make:model:serial-a");
        assert_eq!(pins[0].pins.len(), 1);
        assert_eq!(
            taskbar_pin_id(&pins[0].pins[0]),
            "app:org.example.App.desktop"
        );
        assert_eq!(pins[1].output_id, "make:model:serial-b");
        assert_eq!(
            taskbar_pin_id(&pins[1].pins[0]),
            "folder:/home/crab/Projects"
        );
    }

    #[test]
    fn sanitize_preserves_missing_output_identity() {
        let pins = sanitize_taskbar_pins(vec![WorkspaceTaskbarPinMonitor {
            output_id: "missing-output".into(),
            output_name: "HDMI-A-9".into(),
            pins: vec![folder_pin(
                "folder:/home/crab/Archive",
                "Archive",
                "/home/crab/Archive",
            )],
        }]);

        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].output_id, "missing-output");
        assert_eq!(pins[0].output_name, "HDMI-A-9");
        assert_eq!(
            taskbar_pin_id(&pins[0].pins[0]),
            "folder:/home/crab/Archive"
        );
    }
}
