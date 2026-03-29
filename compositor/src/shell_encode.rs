//! Map [`crate::chrome_bridge::ChromeEvent`] to `shell_wire` packets for the shell Unix socket.

use crate::chrome_bridge::ChromeEvent;

pub fn chrome_event_to_shell_packet(ev: &ChromeEvent) -> Option<Vec<u8>> {
    Some(match ev {
        ChromeEvent::WindowMapped { info } => shell_wire::encode_window_mapped(
            info.window_id,
            info.surface_id,
            info.x,
            info.y,
            info.width,
            info.height,
            &info.title,
            &info.app_id,
        )?,
        ChromeEvent::WindowUnmapped { window_id } => shell_wire::encode_window_unmapped(*window_id),
        ChromeEvent::WindowGeometryChanged { info } => shell_wire::encode_window_geometry(
            info.window_id,
            info.surface_id,
            info.x,
            info.y,
            info.width,
            info.height,
        ),
        ChromeEvent::WindowMetadataChanged { info } => shell_wire::encode_window_metadata(
            info.window_id,
            info.surface_id,
            &info.title,
            &info.app_id,
        )?,
        ChromeEvent::FocusChanged {
            surface_id,
            window_id,
        } => shell_wire::encode_focus_changed(*surface_id, *window_id),
        ChromeEvent::WindowStateChanged { info, minimized } => {
            shell_wire::encode_window_state(info.window_id, *minimized)
        }
    })
}
