use crate::chrome_bridge::ChromeEvent;

pub fn chrome_event_to_shell_message(
    ev: &ChromeEvent,
) -> Option<shell_wire::DecodedCompositorToShellMessage> {
    Some(match ev {
        ChromeEvent::WindowMapped { info } => shell_wire::DecodedCompositorToShellMessage::WindowMapped {
            window_id: info.window_id,
            surface_id: info.surface_id,
            x: info.x,
            y: info.y,
            w: info.width,
            h: info.height,
            title: info.title.clone(),
            app_id: info.app_id.clone(),
            client_side_decoration: info.client_side_decoration,
            output_name: info.output_name.clone(),
        },
        ChromeEvent::WindowUnmapped { window_id } => {
            shell_wire::DecodedCompositorToShellMessage::WindowUnmapped {
                window_id: *window_id,
            }
        }
        ChromeEvent::WindowGeometryChanged { info } => {
            shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
                window_id: info.window_id,
                surface_id: info.surface_id,
                x: info.x,
                y: info.y,
                w: info.width,
                h: info.height,
                maximized: info.maximized,
                fullscreen: info.fullscreen,
                client_side_decoration: info.client_side_decoration,
                output_name: info.output_name.clone(),
            }
        }
        ChromeEvent::WindowMetadataChanged { info } => {
            shell_wire::DecodedCompositorToShellMessage::WindowMetadata {
                window_id: info.window_id,
                surface_id: info.surface_id,
                title: info.title.clone(),
                app_id: info.app_id.clone(),
            }
        }
        ChromeEvent::FocusChanged {
            surface_id,
            window_id,
        } => shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id: *surface_id,
            window_id: *window_id,
        },
        ChromeEvent::WindowStateChanged { info, minimized } => {
            shell_wire::DecodedCompositorToShellMessage::WindowState {
                window_id: info.window_id,
                minimized: *minimized,
            }
        }
        ChromeEvent::Keybind {
            action,
            target_window_id,
        } => shell_wire::DecodedCompositorToShellMessage::Keybind {
            action: action.clone(),
            target_window_id: target_window_id.unwrap_or(0),
        },
    })
}
