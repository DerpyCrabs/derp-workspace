use std::sync::Mutex;

use cef::{
    Browser, CefString, ImplBrowser, ImplBrowserHost, ImplFrame, KeyEvent, KeyEventType,
    MouseButtonType, MouseEvent, PointerType, TouchEvent, TouchEventType,
};
use serde_json::json;

use crate::cef::osr_view_state::OsrViewState;

fn dispatch_shell_detail(browser: &Browser, detail: serde_json::Value) {
    let Ok(js) = serde_json::to_string(&detail) else {
        return;
    };
    let code = format!("window.dispatchEvent(new CustomEvent('derp-shell',{{detail:{js}}}));");
    let Some(frame) = browser.main_frame() else {
        return;
    };
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
                g.logical_width = logical_w.max(1) as i32;
                g.logical_height = logical_h.max(1) as i32;
                let pw = physical_w.max(1) as i32;
                let ph = physical_h.max(1) as i32;
                g.set_physical_size(pw, ph);
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
        shell_wire::DecodedCompositorToShellMessage::OutputLayout {
            canvas_logical_w,
            canvas_logical_h,
            canvas_physical_w,
            canvas_physical_h,
            context_menu_atlas_buffer_h,
            screens,
            shell_chrome_primary,
        } => {
            tracing::warn!(
                target: "derp_hotplug_shell",
                canvas_logical_w,
                canvas_logical_h,
                canvas_physical_w,
                canvas_physical_h,
                n_screens = screens.len(),
                primary = ?shell_chrome_primary,
                "cef_ui OutputLayout task enter"
            );
            if let Ok(mut g) = view_state.lock() {
                g.logical_width = canvas_logical_w.max(1) as i32;
                g.logical_height = canvas_logical_h.max(1) as i32;
                let pw = canvas_physical_w.max(1) as i32;
                let ph = canvas_physical_h.max(1) as i32;
                g.set_physical_size(pw, ph);
            }
            let Ok(guard) = browser.lock() else {
                tracing::warn!(target: "derp_hotplug_shell", "cef_ui OutputLayout browser lock poisoned");
                return;
            };
            let Some(b) = guard.as_ref() else {
                tracing::warn!(target: "derp_hotplug_shell", "cef_ui OutputLayout missing browser");
                return;
            };
            if let Some(host) = b.host() {
                tracing::warn!(target: "derp_hotplug_shell", "cef_ui OutputLayout was_resized notify_screen invalidate");
                host.was_resized();
                host.notify_screen_info_changed();
                host.invalidate(cef::PaintElementType::VIEW);
            } else {
                tracing::warn!(target: "derp_hotplug_shell", "cef_ui OutputLayout no browser host");
            }
            let screens_j: Vec<serde_json::Value> = screens
                .iter()
                .map(|s| {
                    json!({
                        "name": &s.name,
                        "x": s.x,
                        "y": s.y,
                        "width": s.w,
                        "height": s.h,
                        "transform": s.transform,
                        "refresh_milli_hz": s.refresh_milli_hz,
                    })
                })
                .collect();
            let (mut cox, mut coy) = (0i32, 0i32);
            if !screens.is_empty() {
                cox = screens[0].x;
                coy = screens[0].y;
                for s in screens.iter().skip(1) {
                    cox = cox.min(s.x);
                    coy = coy.min(s.y);
                }
            }
            dispatch_shell_detail(
                b,
                json!({
                    "type": "output_layout",
                    "canvas_logical_width": canvas_logical_w,
                    "canvas_logical_height": canvas_logical_h,
                    "canvas_logical_origin_x": cox,
                    "canvas_logical_origin_y": coy,
                    "canvas_physical_width": canvas_physical_w,
                    "canvas_physical_height": canvas_physical_h,
                    "context_menu_atlas_buffer_h": context_menu_atlas_buffer_h,
                    "screens": screens_j,
                    "shell_chrome_primary": shell_chrome_primary,
                }),
            );
            tracing::warn!(target: "derp_hotplug_shell", "cef_ui OutputLayout dispatch_shell_detail done");
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
            client_side_decoration,
            output_name,
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
                    "type": "window_mapped",
                    "window_id": window_id,
                    "surface_id": surface_id,
                    "x": x,
                    "y": y,
                    "width": w,
                    "height": h,
                    "title": title,
                    "app_id": app_id,
                    "client_side_decoration": client_side_decoration,
                    "output_name": output_name,
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
            maximized,
            fullscreen,
            client_side_decoration,
            output_name,
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
                    "type": "window_geometry",
                    "window_id": window_id,
                    "surface_id": surface_id,
                    "x": x,
                    "y": y,
                    "width": w,
                    "height": h,
                    "maximized": maximized,
                    "fullscreen": fullscreen,
                    "client_side_decoration": client_side_decoration,
                    "output_name": output_name,
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
                    json!({
                        "window_id": w.window_id,
                        "surface_id": w.surface_id,
                        "stack_z": w.stack_z,
                        "x": w.x,
                        "y": w.y,
                        "width": w.w,
                        "height": w.h,
                        "minimized": w.minimized != 0,
                        "maximized": w.maximized != 0,
                        "fullscreen": w.fullscreen != 0,
                        "client_side_decoration": w.client_side_decoration != 0,
                        "shell_flags": w.shell_flags,
                        "title": &w.title,
                        "app_id": &w.app_id,
                        "output_name": &w.output_name,
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
        shell_wire::DecodedCompositorToShellMessage::WindowState {
            window_id,
            minimized,
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
                    "type": "window_state",
                    "window_id": window_id,
                    "minimized": minimized,
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
        shell_wire::DecodedCompositorToShellMessage::PointerMove { x, y, modifiers } => {
            let Ok(guard) = browser.lock() else {
                return;
            };
            let Some(b) = guard.as_ref() else {
                return;
            };
            let Some(host) = b.host() else {
                return;
            };

            let ev = MouseEvent { x, y, modifiers };
            host.send_mouse_move_event(Some(&ev), 0);
        }
        shell_wire::DecodedCompositorToShellMessage::PointerButton {
            x,
            y,
            button,
            mouse_up,
            titlebar_drag_window_id: _,
            modifiers,
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

            let ev = MouseEvent { x, y, modifiers };
            let ty = match button {
                1 => MouseButtonType::MIDDLE,
                2 => MouseButtonType::RIGHT,
                _ => MouseButtonType::LEFT,
            };
            host.send_mouse_move_event(Some(&ev), 0);
            host.send_mouse_click_event(Some(&ev), ty, if mouse_up { 1 } else { 0 }, 1);
        }
        shell_wire::DecodedCompositorToShellMessage::PointerAxis {
            x,
            y,
            delta_x,
            delta_y,
            modifiers,
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

            let ev = MouseEvent { x, y, modifiers };
            host.send_mouse_move_event(Some(&ev), 0);
            host.send_mouse_wheel_event(Some(&ev), -delta_x, -delta_y);
        }
        shell_wire::DecodedCompositorToShellMessage::Key {
            cef_key_type,
            modifiers,
            windows_key_code,
            native_key_code,
            character,
            unmodified_character,
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

            let ty = match cef_key_type {
                shell_wire::CEF_KEYEVENT_RAWKEYDOWN => KeyEventType::RAWKEYDOWN,
                shell_wire::CEF_KEYEVENT_KEYDOWN => KeyEventType::KEYDOWN,
                shell_wire::CEF_KEYEVENT_KEYUP => KeyEventType::KEYUP,
                shell_wire::CEF_KEYEVENT_CHAR => KeyEventType::CHAR,
                _ => return,
            };
            let clamp_u16 = |v: u32| -> u16 { v.min(u32::from(u16::MAX)) as u16 };
            let mut ev = KeyEvent::default();
            ev.type_ = ty;
            ev.modifiers = modifiers;
            ev.windows_key_code = windows_key_code;
            ev.native_key_code = native_key_code;
            ev.character = clamp_u16(character);
            ev.unmodified_character = clamp_u16(unmodified_character);
            ev.focus_on_editable_field = 1;
            host.send_key_event(Some(&ev));
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
                x: x as f32,
                y: y as f32,
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
        shell_wire::DecodedCompositorToShellMessage::ContextMenuDismiss => {
            let Ok(guard) = browser.lock() else {
                return;
            };
            let Some(b) = guard.as_ref() else {
                return;
            };
            dispatch_shell_detail(
                b,
                json!({
                    "type": "context_menu_dismiss",
                }),
            );
        }
        shell_wire::DecodedCompositorToShellMessage::Keybind {
            action,
            target_window_id,
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
                    "type": "keybind",
                    "action": action,
                    "target_window_id": target_window_id,
                }),
            );
        }
        shell_wire::DecodedCompositorToShellMessage::KeyboardLayout { label } => {
            let Ok(guard) = browser.lock() else {
                return;
            };
            let Some(b) = guard.as_ref() else {
                return;
            };
            dispatch_shell_detail(
                b,
                json!({
                    "type": "keyboard_layout",
                    "label": label,
                }),
            );
        }
        shell_wire::DecodedCompositorToShellMessage::VolumeOverlay {
            volume_linear_percent_x100,
            muted,
            state_known,
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
                    "type": "volume_overlay",
                    "volume_linear_percent_x100": volume_linear_percent_x100,
                    "muted": muted,
                    "state_known": state_known,
                }),
            );
        }

        shell_wire::DecodedCompositorToShellMessage::ProgramsMenuToggle => {
            let Ok(guard) = browser.lock() else {
                return;
            };
            let Some(b) = guard.as_ref() else {
                return;
            };
            dispatch_shell_detail(
                b,
                json!({
                    "type": "programs_menu_toggle",
                }),
            );
        }
        shell_wire::DecodedCompositorToShellMessage::Ping => {
            let Ok(guard) = browser.lock() else {
                return;
            };
            let Some(b) = guard.as_ref() else {
                return;
            };
            dispatch_shell_detail(
                b,
                json!({
                    "type": "compositor_ping",
                }),
            );
        }
    }
}
