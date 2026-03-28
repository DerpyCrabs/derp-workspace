//! Versioned command/event channel for a future CEF shell process (see plan Phase 3).
//! Wire format (JSON, protobuf, etc.) stays outside this trait.

use std::sync::Arc;

/// Protocol version for IPC evolution (`protocol_version` in messages).
pub const CHROME_BRIDGE_PROTOCOL_VERSION: u32 = 2;

/// Stable compositor window id and metadata for the shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub window_id: u32,
    pub surface_id: u32,
    pub title: String,
    pub app_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChromeCommand {
    ListWindows,
    SetGeometry {
        id: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    },
    Close {
        id: u32,
    },
    SetFullscreen {
        id: u32,
        enabled: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChromeEvent {
    WindowMapped {
        info: WindowInfo,
    },
    WindowUnmapped {
        window_id: u32,
    },
    WindowMetadataChanged {
        info: WindowInfo,
    },
    FocusChanged {
        /// Wayland object id for the focused surface, if any.
        surface_id: Option<u32>,
        /// Compositor [`WindowInfo::window_id`], if the surface is a known toplevel.
        window_id: Option<u32>,
    },
}

pub type CommandResult<T = ()> = Result<T, String>;

pub trait ChromeBridge: Send + Sync + 'static {
    /// Compositor → shell (future: CEF / JS).
    fn notify(&self, event: ChromeEvent);

    /// Shell → compositor (future: deserialize and apply).
    fn handle_command(&self, cmd: ChromeCommand) -> CommandResult {
        let _ = cmd;
        Ok(())
    }
}

/// Default stub: no IPC.
#[derive(Debug, Default)]
pub struct NoOpChromeBridge;

impl ChromeBridge for NoOpChromeBridge {
    fn notify(&self, _event: ChromeEvent) {}
}

/// Test double: records notifications.
#[derive(Debug, Default)]
pub struct LoggingChromeBridge {
    events: std::sync::Mutex<Vec<ChromeEvent>>,
}

impl LoggingChromeBridge {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn take_events(&self) -> Vec<ChromeEvent> {
        let mut g = self.events.lock().unwrap();
        std::mem::take(&mut *g)
    }
}

impl ChromeBridge for LoggingChromeBridge {
    fn notify(&self, event: ChromeEvent) {
        self.events.lock().unwrap().push(event);
    }
}

pub type SharedChromeBridge = Arc<dyn ChromeBridge>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logging_bridge_records_focus_with_window_id() {
        let b = LoggingChromeBridge::new();
        b.notify(ChromeEvent::FocusChanged {
            surface_id: Some(42),
            window_id: Some(7),
        });
        let ev = b.take_events();
        assert_eq!(ev.len(), 1);
        assert_eq!(
            ev[0],
            ChromeEvent::FocusChanged {
                surface_id: Some(42),
                window_id: Some(7),
            }
        );
    }

    #[test]
    fn logging_bridge_window_lifecycle_sequence() {
        let b = LoggingChromeBridge::new();
        let info = WindowInfo {
            window_id: 1,
            surface_id: 10,
            title: "t".into(),
            app_id: "a".into(),
        };
        b.notify(ChromeEvent::WindowMapped {
            info: info.clone(),
        });
        b.notify(ChromeEvent::WindowMetadataChanged {
            info: WindowInfo {
                title: "t2".into(),
                ..info.clone()
            },
        });
        b.notify(ChromeEvent::WindowUnmapped { window_id: 1 });
        let ev = b.take_events();
        assert_eq!(ev.len(), 3);
    }

    #[test]
    fn no_op_command_ok() {
        let b = NoOpChromeBridge;
        assert!(b.handle_command(ChromeCommand::ListWindows).is_ok());
    }

    #[test]
    fn registry_updates_match_metadata_changed_event() {
        use crate::window_registry::WindowRegistry;

        let mut reg = WindowRegistry::new();
        reg.register_toplevel(9, "old".into(), "id".into());
        assert_eq!(reg.set_title(9, "new".into()), Some(true));

        let info = reg.snapshot_for_surface(9).unwrap();
        let b = LoggingChromeBridge::new();
        b.notify(ChromeEvent::WindowMetadataChanged { info: info.clone() });
        let ev = b.take_events();
        assert_eq!(ev.len(), 1);
        assert_eq!(
            ev[0],
            ChromeEvent::WindowMetadataChanged { info }
        );
    }
}
