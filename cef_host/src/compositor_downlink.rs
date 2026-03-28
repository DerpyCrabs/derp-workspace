//! Read compositor → shell messages from the duplex Unix socket and forward to CEF OSR (`BrowserHost` input + JS `derp-shell` for shell state only).

use std::sync::Mutex;

use cef::{
    Browser, CefString, ImplBrowser, ImplBrowserHost, ImplFrame, MouseButtonType, MouseEvent,
    PointerType, TouchEvent, TouchEventType,
};
use serde_json::json;

use cef_host::osr_view_state::OsrViewState;

/// Window `x,y,w,h` on the shell wire are **OSR buffer** pixels (same space as pointer IPC); map to CEF view/DIP for `position:fixed` + `clientX`/`clientY`.
fn shell_window_rect_buffer_to_view(vs: &OsrViewState, x: i32, y: i32, w: i32, h: i32) -> (i32, i32, i32, i32) {
    let xi = x.max(0);
    let yi = y.max(0);
    let wi = w.max(1);
    let hi = h.max(1);
    let (vx0, vy0) = vs.buffer_to_view(xi, yi);
    let (vx1, vy1) = vs.buffer_to_view(xi + wi - 1, yi + hi - 1);
    (vx0, vy0, (vx1 - vx0 + 1).max(1), (vy1 - vy0 + 1).max(1))
}

fn dispatch_shell_detail(browser: &Browser, detail: serde_json::Value) {
    let Ok(js) = serde_json::to_string(&detail) else {
        return;
    };
    let code = format!("window.dispatchEvent(new CustomEvent('derp-shell',{{detail:{js}}}));");
    let Some(frame) = browser.main_frame() else {
        return;
    };
    // `None` script URL runs in the loaded document (fake https://derp/ origins were ignored for OSR HUD).
    frame.execute_java_script(Some(&CefString::from(code.as_str())), None, 0);
}

pub fn apply_message(
    msg: shell_wire::DecodedCompositorToShellMessage,
    browser: &Mutex<Option<Browser>>,
    view_state: &Mutex<OsrViewState>,
) {
    match msg {
        shell_wire::DecodedCompositorToShellMessage::OutputGeometry {
            logical_w,
            logical_h,
            physical_w,
            physical_h,
        } => {
            if let Ok(mut g) = view_state.lock() {
                g.dip_w = logical_w as i32;
                g.dip_h = logical_h as i32;
                let pw = physical_w.max(1) as i32;
                let ph = physical_h.max(1) as i32;
                g.set_buffer_size(pw, ph);
                g.set_target_buffer(pw, ph);
                g.reset_undersized_nudge();
            }
            let Ok(guard) = browser.lock() else {
                return;
            };
            let Some(b) = guard.as_ref() else {
                return;
            };
            if let Some(host) = b.host() {
                host.was_resized();
                host.notify_screen_info_changed();
                host.invalidate(cef::PaintElementType::VIEW);
            }
            dispatch_shell_detail(
                b,
                json!({
                    "type": "output_geometry",
                    "logical_width": logical_w,
                    "logical_height": logical_h,
                }),
            );
        }
        shell_wire::DecodedCompositorToShellMessage::WindowMapped {
            window_id,
            surface_id,
            x,
            y,
            w,
            h,
            title,
            app_id,
        } => {
            let Ok(guard) = browser.lock() else {
                return;
            };
            let Some(b) = guard.as_ref() else {
                return;
            };
            let (vx, vy, vw, vh) = view_state
                .lock()
                .map(|s| shell_window_rect_buffer_to_view(&s, x, y, w, h))
                .unwrap_or((x, y, w, h));
            dispatch_shell_detail(
                b,
                json!({
                    "type": "window_mapped",
                    "window_id": window_id,
                    "surface_id": surface_id,
                    "x": vx,
                    "y": vy,
                    "width": vw,
                    "height": vh,
                    "title": title,
                    "app_id": app_id,
                }),
            );
        }
        shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { window_id } => {
            let Ok(guard) = browser.lock() else {
                return;
            };
            let Some(b) = guard.as_ref() else {
                return;
            };
            dispatch_shell_detail(
                b,
                json!({ "type": "window_unmapped", "window_id": window_id }),
            );
        }
        shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
            window_id,
            surface_id,
            x,
            y,
            w,
            h,
        } => {
            let Ok(guard) = browser.lock() else {
                return;
            };
            let Some(b) = guard.as_ref() else {
                return;
            };
            let (vx, vy, vw, vh) = view_state
                .lock()
                .map(|s| shell_window_rect_buffer_to_view(&s, x, y, w, h))
                .unwrap_or((x, y, w, h));
            dispatch_shell_detail(
                b,
                json!({
                    "type": "window_geometry",
                    "window_id": window_id,
                    "surface_id": surface_id,
                    "x": vx,
                    "y": vy,
                    "width": vw,
                    "height": vh,
                }),
            );
        }
        shell_wire::DecodedCompositorToShellMessage::WindowMetadata {
            window_id,
            surface_id,
            title,
            app_id,
        } => {
            let Ok(guard) = browser.lock() else {
                return;
            };
            let Some(b) = guard.as_ref() else {
                return;
            };
            dispatch_shell_detail(
                b,
                json!({
                    "type": "window_metadata",
                    "window_id": window_id,
                    "surface_id": surface_id,
                    "title": title,
                    "app_id": app_id,
                }),
            );
        }
        shell_wire::DecodedCompositorToShellMessage::WindowList { windows } => {
            let Ok(guard) = browser.lock() else {
                return;
            };
            let Some(b) = guard.as_ref() else {
                return;
            };
            let list: Vec<_> = windows
                .iter()
                .map(|w| {
                    let (vx, vy, vw, vh) = view_state
                        .lock()
                        .map(|s| shell_window_rect_buffer_to_view(&s, w.x, w.y, w.w, w.h))
                        .unwrap_or((w.x, w.y, w.w, w.h));
                    json!({
                        "window_id": w.window_id,
                        "surface_id": w.surface_id,
                        "x": vx,
                        "y": vy,
                        "width": vw,
                        "height": vh,
                        "title": &w.title,
                        "app_id": &w.app_id,
                    })
                })
                .collect();
            dispatch_shell_detail(
                b,
                json!({
                    "type": "window_list",
                    "windows": list,
                }),
            );
        }
        shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id,
            window_id,
        } => {
            let Ok(guard) = browser.lock() else {
                return;
            };
            let Some(b) = guard.as_ref() else {
                return;
            };
            dispatch_shell_detail(
                b,
                json!({
                    "type": "focus_changed",
                    "surface_id": surface_id,
                    "window_id": window_id,
                }),
            );
        }
        shell_wire::DecodedCompositorToShellMessage::PointerMove { x, y } => {
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
            titlebar_drag_window_id: _,
        } => {
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
            // OSR: Blink's last synthetic position must match the click or hit-testing targets the wrong node.
            host.send_mouse_move_event(Some(&ev), 0);
            host.send_mouse_click_event(Some(&ev), ty, if mouse_up { 1 } else { 0 }, 1);
        }
        shell_wire::DecodedCompositorToShellMessage::Touch {
            touch_id,
            phase,
            x,
            y,
        } => {
            let Ok(guard) = browser.lock() else {
                return;
            };
            let Some(b) = guard.as_ref() else {
                return;
            };
            let Some(host) = b.host() else {
                return;
            };

            let (vx, vy) = view_state
                .lock()
                .map(|s| s.buffer_to_view(x, y))
                .unwrap_or((x, y));

            let ty = match phase {
                shell_wire::TOUCH_PHASE_MOVED => TouchEventType::MOVED,
                shell_wire::TOUCH_PHASE_PRESSED => TouchEventType::PRESSED,
                shell_wire::TOUCH_PHASE_RELEASED => TouchEventType::RELEASED,
                shell_wire::TOUCH_PHASE_CANCELLED => TouchEventType::CANCELLED,
                _ => TouchEventType::RELEASED,
            };

            let pressure = match phase {
                shell_wire::TOUCH_PHASE_PRESSED => 1.0_f32,
                shell_wire::TOUCH_PHASE_MOVED => 1.0_f32,
                _ => 0.0_f32,
            };

            let ev = TouchEvent {
                id: touch_id,
                x: vx as f32,
                y: vy as f32,
                radius_x: 0.0,
                radius_y: 0.0,
                rotation_angle: 0.0,
                pressure,
                type_: ty,
                modifiers: 0,
                pointer_type: PointerType::TOUCH,
            };
            host.send_touch_event(Some(&ev));
        }
        shell_wire::DecodedCompositorToShellMessage::Ping => {}
    }
}
