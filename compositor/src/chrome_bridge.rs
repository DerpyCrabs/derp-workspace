//! Versioned command/event channel for a future CEF shell process (see plan Phase 3).
//! Wire format (JSON, protobuf, etc.) stays outside this trait.

use std::sync::Arc;

/// Protocol version for IPC evolution (`protocol_version` in messages).
pub const CHROME_BRIDGE_PROTOCOL_VERSION: u32 = 4;

/// Stable compositor window id, metadata, and layout in Smithay logical space.
///
/// `x`/`y` are the window element position in **global** compositor space; `width`/`height` are
/// the Smithay desktop window client geometry size. On the shell Unix socket, events use
/// **output-local** layout integers (see [`crate::state::CompositorState::shell_window_info_to_output_local_layout`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub window_id: u32,
    /// Compositor token for shell IPC (not the raw Wayland protocol id).
    pub surface_id: u32,
    pub title: String,
    pub app_id: String,
    /// Linux: Wayland client PID at map time; matches shell IPC `SO_PEERCRED` for `cef_host`.
    pub wayland_client_pid: Option<i32>,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub output_name: String,
    /// Compositor-minimized: unmapped from space but still alive.
    pub minimized: bool,
    pub maximized: bool,
    pub fullscreen: bool,
    pub client_side_decoration: bool,
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
    SetMaximized {
        id: u32,
        enabled: bool,
    },
    SetPresentationFullscreen {
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
        surface_id: Option<u32>,
        /// Compositor [`WindowInfo::window_id`], if the surface is a known toplevel.
        window_id: Option<u32>,
    },
    WindowStateChanged {
        info: WindowInfo,
        minimized: bool,
    },
    Keybind {
        action: String,
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
