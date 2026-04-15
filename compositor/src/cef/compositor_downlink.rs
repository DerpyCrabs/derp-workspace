use std::sync::Mutex;

use cef::{
    Browser, CefString, ImplBrowser, ImplBrowserHost, ImplFrame, KeyEvent, KeyEventType,
    MouseButtonType, MouseEvent, PointerType, TouchEvent, TouchEventType,
};
use serde_json::{json, Value};

use crate::cef::osr_view_state::OsrViewState;

fn dispatch_shell_detail_batch(browser: &Browser, details: &[Value]) {
    if details.is_empty() {
        return;
    }
    crate::cef::begin_frame_diag::note_shell_detail_batch(details.len());
    let Ok(js) = serde_json::to_string(details) else {
        return;
    };
    let code = format!(
        "(()=>{{const derpShellBatch={js};const derpApplyCompositorBatch=window.__DERP_APPLY_COMPOSITOR_BATCH;if(typeof derpApplyCompositorBatch==='function'){{try{{derpApplyCompositorBatch(derpShellBatch);return;}}catch(err){{console.warn('[derp-shell-bridge] compositor batch handler failed',err);}}}}for(let i=0;i<derpShellBatch.length;i++)window.dispatchEvent(new CustomEvent('derp-shell',{{detail:derpShellBatch[i]}}));}})();"
    );
    let Some(frame) = browser.main_frame() else {
        return;
    };
    frame.execute_java_script(Some(&CefString::from(code.as_str())), None, 0);
}

fn dispatch_shell_snapshot_notify(browser: &Browser) {
    crate::cef::begin_frame_diag::note_shell_snapshot_notify();
    let Some(frame) = browser.main_frame() else {
        return;
    };
    frame.execute_java_script(
        Some(&CefString::from(
            "window.dispatchEvent(new Event('derp-shell-snapshot'));",
        )),
        None,
        0,
    );
}

fn flush_shell_updates(
    browser: Option<&Browser>,
    details: &mut Vec<Value>,
    snapshot_dirty: &mut bool,
) {
    if !*snapshot_dirty && details.is_empty() {
        return;
    }
    let Some(browser) = browser else {
        details.clear();
        *snapshot_dirty = false;
        return;
    };
    if !details.is_empty() {
        dispatch_shell_detail_batch(browser, details);
        details.clear();
    }
    if *snapshot_dirty {
        dispatch_shell_snapshot_notify(browser);
        *snapshot_dirty = false;
    }
}

pub fn apply_messages(
    messages: Vec<shell_wire::DecodedCompositorToShellMessage>,
    browser: &Mutex<Option<Browser>>,
    view_state: &Mutex<OsrViewState>,
) {
    let Ok(guard) = browser.lock() else {
        return;
    };
    let browser = guard.as_ref();
    let mut pending_details = Vec::new();
    let mut snapshot_dirty = false;
    for msg in messages {
        apply_message(
            msg,
            browser,
            view_state,
            &mut pending_details,
            &mut snapshot_dirty,
        );
    }
    flush_shell_updates(browser, &mut pending_details, &mut snapshot_dirty);
}

fn apply_message(
    msg: shell_wire::DecodedCompositorToShellMessage,
    browser: Option<&Browser>,
    view_state: &Mutex<OsrViewState>,
    pending_details: &mut Vec<Value>,
    snapshot_dirty: &mut bool,
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
            if let Some(b) = browser {
                if let Some(host) = b.host() {
                    host.was_resized();
                    host.notify_screen_info_changed();
                    host.invalidate(cef::PaintElementType::VIEW);
                }
            }
            *snapshot_dirty = true;
        }
        shell_wire::DecodedCompositorToShellMessage::OutputLayout {
            canvas_logical_w,
            canvas_logical_h,
            canvas_physical_w,
            canvas_physical_h,
            context_menu_atlas_buffer_h: _,
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
            if let Some(b) = browser {
                if let Some(host) = b.host() {
                    tracing::warn!(target: "derp_hotplug_shell", "cef_ui OutputLayout was_resized notify_screen invalidate");
                    host.was_resized();
                    host.notify_screen_info_changed();
                    host.invalidate(cef::PaintElementType::VIEW);
                } else {
                    tracing::warn!(target: "derp_hotplug_shell", "cef_ui OutputLayout no browser host");
                }
            } else {
                tracing::warn!(target: "derp_hotplug_shell", "cef_ui OutputLayout missing browser");
                return;
            }
            *snapshot_dirty = true;
            tracing::warn!(target: "derp_hotplug_shell", "cef_ui OutputLayout dispatch_shell_detail done");
        }
        shell_wire::DecodedCompositorToShellMessage::WindowMapped {
            window_id: _,
            surface_id: _,
            x: _,
            y: _,
            w: _,
            h: _,
            title: _,
            app_id: _,
            client_side_decoration: _,
            output_name: _,
        } => {
            crate::cef::begin_frame_diag::note_shell_detail_window_mapped();
            *snapshot_dirty = true;
        }
        shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { window_id: _ } => {
            *snapshot_dirty = true;
        }
        shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
            window_id: _,
            surface_id: _,
            x: _,
            y: _,
            w: _,
            h: _,
            maximized: _,
            fullscreen: _,
            client_side_decoration: _,
            output_name: _,
        } => {
            crate::cef::begin_frame_diag::note_shell_detail_window_geometry();
            *snapshot_dirty = true;
        }
        shell_wire::DecodedCompositorToShellMessage::WindowMetadata {
            window_id: _,
            surface_id: _,
            title: _,
            app_id: _,
        } => {
            crate::cef::begin_frame_diag::note_shell_detail_window_metadata();
            *snapshot_dirty = true;
        }
        shell_wire::DecodedCompositorToShellMessage::WindowList { windows: _ } => {
            crate::cef::begin_frame_diag::note_shell_detail_window_list();
            *snapshot_dirty = true;
        }
        shell_wire::DecodedCompositorToShellMessage::WindowState {
            window_id: _,
            minimized: _,
        } => {
            crate::cef::begin_frame_diag::note_shell_detail_window_state();
            *snapshot_dirty = true;
        }
        shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id: _,
            window_id: _,
        } => {
            crate::cef::begin_frame_diag::note_shell_detail_focus_changed();
            *snapshot_dirty = true;
        }
        shell_wire::DecodedCompositorToShellMessage::PointerMove { x, y, modifiers } => {
            flush_shell_updates(browser, pending_details, snapshot_dirty);
            let Some(b) = browser else {
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
            flush_shell_updates(browser, pending_details, snapshot_dirty);
            let Some(b) = browser else {
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
            flush_shell_updates(browser, pending_details, snapshot_dirty);
            let Some(b) = browser else {
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
            flush_shell_updates(browser, pending_details, snapshot_dirty);
            let Some(b) = browser else {
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
            flush_shell_updates(browser, pending_details, snapshot_dirty);
            let Some(b) = browser else {
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
            pending_details.push(json!({
                "type": "context_menu_dismiss",
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::Keybind {
            action,
            target_window_id,
            output_name,
        } => {
            pending_details.push(json!({
                "type": "keybind",
                "action": action,
                "target_window_id": target_window_id,
                "output_name": output_name,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::KeyboardLayout { label: _ } => {
            *snapshot_dirty = true;
        }
        shell_wire::DecodedCompositorToShellMessage::VolumeOverlay {
            volume_linear_percent_x100: _,
            muted: _,
            state_known: _,
        } => {
            *snapshot_dirty = true;
        }
        shell_wire::DecodedCompositorToShellMessage::WorkspaceState { state_json } => {
            let _ = state_json;
            *snapshot_dirty = true;
        }
        shell_wire::DecodedCompositorToShellMessage::TrayHints {
            slot_count: _,
            slot_w: _,
            reserved_w: _,
        } => {
            *snapshot_dirty = true;
        }
        shell_wire::DecodedCompositorToShellMessage::TraySni { items: _ } => {
            *snapshot_dirty = true;
        }
        shell_wire::DecodedCompositorToShellMessage::TraySniMenu { menu } => {
            let rows: Vec<Value> = menu
                .entries
                .into_iter()
                .map(|e| {
                    json!({
                        "dbusmenu_id": e.dbusmenu_id,
                        "label": e.label,
                        "separator": e.separator,
                        "enabled": e.enabled,
                    })
                })
                .collect();
            pending_details.push(json!({
                "type": "tray_sni_menu",
                "request_serial": menu.request_serial,
                "notifier_id": menu.notifier_id,
                "menu_path": menu.menu_path,
                "entries": rows,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::ProgramsMenuToggle => {
            pending_details.push(json!({
                "type": "programs_menu_toggle",
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::Ping => {
            pending_details.push(json!({
                "type": "compositor_ping",
            }));
        }
    }
}
