//! Read compositor → shell messages (pointer) from the duplex Unix socket and forward to CEF OSR.

use std::sync::Mutex;

use cef::{Browser, ImplBrowser, ImplBrowserHost, MouseButtonType, MouseEvent};

use cef_host::osr_view_state::OsrViewState;

pub fn apply_message(
    msg: shell_wire::DecodedCompositorToShellMessage,
    browser: &Mutex<Option<Browser>>,
    view_state: &Mutex<OsrViewState>,
) {
    let Ok(guard) = browser.lock() else {
        return;
    };
    let Some(b) = guard.as_ref() else {
        return;
    };
    let Some(host) = b.host() else {
        return;
    };

    let map_xy = |x: i32, y: i32| -> (i32, i32) {
        view_state
            .lock()
            .map(|s| s.buffer_to_view(x, y))
            .unwrap_or((x, y))
    };

    match msg {
        shell_wire::DecodedCompositorToShellMessage::PointerMove { x, y } => {
            let (vx, vy) = map_xy(x, y);
            let ev = MouseEvent {
                x: vx,
                y: vy,
                modifiers: 0,
            };
            host.send_mouse_move_event(Some(&ev), 0);
        }
        shell_wire::DecodedCompositorToShellMessage::PointerButton {
            x,
            y,
            button,
            mouse_up,
        } => {
            let (vx, vy) = map_xy(x, y);
            let ev = MouseEvent {
                x: vx,
                y: vy,
                modifiers: 0,
            };
            let ty = match button {
                1 => MouseButtonType::MIDDLE,
                2 => MouseButtonType::RIGHT,
                _ => MouseButtonType::LEFT,
            };
            host.send_mouse_click_event(Some(&ev), ty, if mouse_up { 1 } else { 0 }, 1);
        }
    }
}
