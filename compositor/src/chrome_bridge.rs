//! Versioned command/event channel for a future CEF shell process (see plan Phase 3).
//! Wire format (JSON, protobuf, etc.) stays outside this trait.

use std::sync::Arc;

/// Protocol version for IPC evolution (`protocol_version` in messages).
pub const CHROME_BRIDGE_PROTOCOL_VERSION: u32 = 3;

/// Stable compositor window id, metadata, and layout in Smithay logical space.
///
/// `x`/`y` are the window element position in compositor space; `width`/`height` are
/// the Smithay desktop window client geometry size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub window_id: u32,
    pub surface_id: u32,
    pub title: String,
    pub app_id: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
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
    WindowGeometryChanged {
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
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
        b.notify(ChromeEvent::WindowMapped { info: info.clone() });
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
        assert_eq!(ev[0], ChromeEvent::WindowMetadataChanged { info });
    }

    #[test]
    fn logging_bridge_records_window_geometry_changed() {
        use crate::window_registry::WindowRegistry;

        let mut reg = WindowRegistry::new();
        reg.register_toplevel(3, "t".into(), "app".into());
        assert_eq!(reg.set_geometry(3, 1, 2, 400, 300), Some(true));
        let info = reg.snapshot_for_surface(3).unwrap();
        let b = LoggingChromeBridge::new();
        b.notify(ChromeEvent::WindowGeometryChanged { info: info.clone() });
        let ev = b.take_events();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0], ChromeEvent::WindowGeometryChanged { info });
    }

    #[test]
    fn geometry_then_metadata_sequence_preserves_layout_fields() {
        use crate::window_registry::WindowRegistry;

        let mut reg = WindowRegistry::new();
        reg.register_toplevel(8, "tit".into(), "aid".into());
        assert_eq!(reg.set_geometry(8, 0, 0, 640, 480), Some(true));
        assert_eq!(reg.set_title(8, "new".into()), Some(true));

        let info = reg.snapshot_for_surface(8).unwrap();
        assert_eq!((info.x, info.y, info.width, info.height), (0, 0, 640, 480));
        assert_eq!(info.title, "new");

        let b = LoggingChromeBridge::new();
        b.notify(ChromeEvent::WindowGeometryChanged { info: info.clone() });
        b.notify(ChromeEvent::WindowMetadataChanged { info });
        let ev = b.take_events();
        assert!(matches!(ev[0], ChromeEvent::WindowGeometryChanged { .. }));
        assert!(matches!(ev[1], ChromeEvent::WindowMetadataChanged { .. }));
    }
}
