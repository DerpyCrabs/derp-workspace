use std::sync::Mutex;

use cef::{
    Browser, CefString, ImplBrowser, ImplBrowserHost, ImplFrame, KeyEvent, KeyEventType,
    MouseButtonType, MouseEvent, PointerType, TouchEvent, TouchEventType,
};
use serde_json::{json, Value};

use crate::cef::osr_view_state::OsrViewState;

fn execute_main_frame_script(browser: &Browser, code: &str) {
    let Some(frame) = browser.main_frame() else {
        return;
    };
    frame.execute_java_script(Some(&CefString::from(code)), None, 0);
}

fn apply_output_dimensions_to_osr(
    logical_w: u32,
    logical_h: u32,
    physical_w: u32,
    physical_h: u32,
    view_state: &Mutex<OsrViewState>,
    browser: Option<&Browser>,
) {
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
            crate::cef::begin_frame_diag::note_shell_view_invalidate(
                crate::cef::begin_frame_diag::ShellViewInvalidateReason::OutputResize,
            );
            host.invalidate(cef::PaintElementType::VIEW);
        }
    }
}

fn dispatch_shell_detail_batch(browser: &Browser, details: &[Value]) {
    if details.is_empty() {
        return;
    }
    crate::cef::begin_frame_diag::note_shell_detail_batch(details.len());
    let Ok(js) = serde_json::to_string(details) else {
        return;
    };
    let mut code = String::with_capacity(js.len() + 320);
    code.push_str("(()=>{const derpShellBatch=");
    code.push_str(&js);
    code.push_str(";const derpApplyCompositorBatch=window.__DERP_APPLY_COMPOSITOR_BATCH;if(typeof derpApplyCompositorBatch==='function'){try{derpApplyCompositorBatch(derpShellBatch);return;}catch(err){console.warn('[derp-shell-bridge] compositor batch handler failed',err);}}for(let i=0;i<derpShellBatch.length;i++)window.dispatchEvent(new CustomEvent('derp-shell',{detail:derpShellBatch[i]}));})();");
    execute_main_frame_script(browser, code.as_str());
}

fn dispatch_shell_snapshot_notify(browser: &Browser) {
    crate::cef::begin_frame_diag::note_shell_snapshot_notify();
    execute_main_frame_script(
        browser,
        "(()=>{const derpSyncSnapshot=window.__DERP_SYNC_COMPOSITOR_SNAPSHOT;if(typeof derpSyncSnapshot==='function'){try{derpSyncSnapshot();return;}catch(err){console.warn('[derp-shell-bridge] compositor snapshot handler failed',err);}}window.dispatchEvent(new Event('derp-shell-snapshot'));})();",
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
    let browser = match browser.lock() {
        Ok(guard) => guard.as_ref().cloned(),
        Err(_) => return,
    };
    let mut pending_details = Vec::new();
    let mut snapshot_dirty = false;
    for msg in messages {
        apply_message(
            msg,
            browser.as_ref(),
            view_state,
            &mut pending_details,
            &mut snapshot_dirty,
        );
    }
    flush_shell_updates(browser.as_ref(), &mut pending_details, &mut snapshot_dirty);
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
            apply_output_dimensions_to_osr(
                logical_w, logical_h, physical_w, physical_h, view_state, browser,
            );
            pending_details.push(json!({
                "type": "output_geometry",
                "logical_width": logical_w,
                "logical_height": logical_h,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::OutputLayout {
            revision,
            canvas_logical_w,
            canvas_logical_h,
            canvas_physical_w,
            canvas_physical_h,
            screens,
            shell_chrome_primary,
        } => {
            apply_output_dimensions_to_osr(
                canvas_logical_w,
                canvas_logical_h,
                canvas_physical_w,
                canvas_physical_h,
                view_state,
                browser,
            );
            let screens: Vec<Value> = screens
                .into_iter()
                .map(|screen| {
                    json!({
                        "name": screen.name,
                        "identity": if screen.identity.is_empty() { Value::Null } else { Value::String(screen.identity) },
                        "x": screen.x,
                        "y": screen.y,
                        "width": screen.w,
                        "height": screen.h,
                        "transform": screen.transform,
                        "refresh_milli_hz": screen.refresh_milli_hz,
                    })
                })
                .collect();
            pending_details.push(json!({
                "type": "output_layout",
                "revision": revision,
                "canvas_logical_width": canvas_logical_w,
                "canvas_logical_height": canvas_logical_h,
                "canvas_physical_width": canvas_physical_w,
                "canvas_physical_height": canvas_physical_h,
                "screens": screens,
                "shell_chrome_primary": shell_chrome_primary,
            }));
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
            output_name,
            ..
        } => {
            crate::cef::begin_frame_diag::note_shell_detail_window_mapped();
            pending_details.push(json!({
                "type": "window_mapped",
                "window_id": window_id,
                "surface_id": surface_id,
                "x": x,
                "y": y,
                "width": w,
                "height": h,
                "title": title,
                "app_id": app_id,
                "output_name": output_name,
            }));
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
            output_name,
            ..
        } => {
            crate::cef::begin_frame_diag::note_shell_detail_window_geometry();
            pending_details.push(json!({
                "type": "window_geometry",
                "window_id": window_id,
                "surface_id": surface_id,
                "x": x,
                "y": y,
                "width": w,
                "height": h,
                "output_name": output_name,
                "maximized": maximized,
                "fullscreen": fullscreen,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::WindowMetadata {
            window_id,
            surface_id,
            title,
            app_id,
        } => {
            crate::cef::begin_frame_diag::note_shell_detail_window_metadata();
            pending_details.push(json!({
                "type": "window_metadata",
                "window_id": window_id,
                "surface_id": surface_id,
                "title": title,
                "app_id": app_id,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::WindowList { revision, windows } => {
            crate::cef::begin_frame_diag::note_shell_detail_window_list();
            let windows: Vec<Value> = windows
                .into_iter()
                .map(|window| {
                    json!({
                        "window_id": window.window_id,
                        "surface_id": window.surface_id,
                        "stack_z": window.stack_z,
                        "x": window.x,
                        "y": window.y,
                        "width": window.w,
                        "height": window.h,
                        "minimized": window.minimized != 0,
                        "maximized": window.maximized != 0,
                        "fullscreen": window.fullscreen != 0,
                        "client_side_decoration": window.client_side_decoration != 0,
                        "shell_flags": window.shell_flags,
                        "title": window.title,
                        "app_id": window.app_id,
                        "output_name": window.output_name,
                        "capture_identifier": window.capture_identifier,
                        "kind": window.kind,
                        "x11_class": window.x11_class,
                        "x11_instance": window.x11_instance,
                    })
                })
                .collect();
            pending_details.push(json!({
                "type": "window_list",
                "revision": revision,
                "windows": windows,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::WindowState {
            window_id,
            minimized,
        } => {
            crate::cef::begin_frame_diag::note_shell_detail_window_state();
            pending_details.push(json!({
                "type": "window_state",
                "window_id": window_id,
                "minimized": minimized,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id,
            window_id,
        } => {
            crate::cef::begin_frame_diag::note_shell_detail_focus_changed();
            pending_details.push(json!({
                "type": "focus_changed",
                "surface_id": surface_id,
                "window_id": window_id,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::NativeDragPreview {
            window_id,
            generation,
            image_path,
        } => {
            pending_details.push(json!({
                "type": "native_drag_preview",
                "window_id": window_id,
                "generation": generation,
                "image_path": image_path,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::PointerMove { x, y, modifiers } => {
            flush_shell_updates(browser, pending_details, snapshot_dirty);
            let Some(b) = browser else {
                return;
            };
            let Some(host) = b.host() else {
                return;
            };
            host.set_focus(1);
            let ev = MouseEvent { x, y, modifiers };
            host.send_mouse_move_event(Some(&ev), 0);
        }
        shell_wire::DecodedCompositorToShellMessage::PointerButton {
            x,
            y,
            button,
            mouse_up,
            modifiers,
            ..
        } => {
            flush_shell_updates(browser, pending_details, snapshot_dirty);
            let Some(b) = browser else {
                return;
            };
            let Some(host) = b.host() else {
                return;
            };
            host.set_focus(1);
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
            host.set_focus(1);
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
        shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { window_id } => {
            pending_details.push(json!({
                "type": "window_unmapped",
                "window_id": window_id,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::KeyboardLayout { label } => {
            pending_details.push(json!({
                "type": "keyboard_layout",
                "label": label,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::WorkspaceState {
            revision,
            state_json,
        } => {
            let Ok(state) = serde_json::from_str::<Value>(&state_json) else {
                return;
            };
            pending_details.push(json!({
                "type": "workspace_state",
                "revision": revision,
                "state": state,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::ShellHostedAppState {
            revision,
            state_json,
        } => {
            let Ok(state) = serde_json::from_str::<Value>(&state_json) else {
                return;
            };
            pending_details.push(json!({
                "type": "shell_hosted_app_state",
                "revision": revision,
                "state": state,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::InteractionState {
            revision,
            pointer_x,
            pointer_y,
            move_window_id,
            resize_window_id,
            move_proxy_window_id,
            move_capture_window_id,
            move_visual,
            resize_visual,
        } => {
            pending_details.push(json!({
                "type": "interaction_state",
                "revision": revision,
                "pointer_x": pointer_x,
                "pointer_y": pointer_y,
                "move_window_id": move_window_id,
                "resize_window_id": resize_window_id,
                "move_proxy_window_id": move_proxy_window_id,
                "move_capture_window_id": move_capture_window_id,
                "move_rect": move_visual.map(|visual| json!({
                    "x": visual.x,
                    "y": visual.y,
                    "width": visual.width,
                    "height": visual.height,
                    "maximized": visual.maximized,
                    "fullscreen": visual.fullscreen,
                })),
                "resize_rect": resize_visual.map(|visual| json!({
                    "x": visual.x,
                    "y": visual.y,
                    "width": visual.width,
                    "height": visual.height,
                    "maximized": visual.maximized,
                    "fullscreen": visual.fullscreen,
                })),
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::TrayHints {
            slot_count,
            slot_w,
            reserved_w,
        } => {
            pending_details.push(json!({
                "type": "tray_hints",
                "slot_count": slot_count,
                "slot_w": slot_w,
                "reserved_w": reserved_w,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::TraySni { items } => {
            let items: Vec<Value> = items
                .into_iter()
                .map(|item| {
                    use base64::Engine as _;
                    let icon_base64 =
                        base64::engine::general_purpose::STANDARD.encode(item.icon_png);
                    json!({
                        "id": item.id,
                        "title": item.title,
                        "icon_base64": icon_base64,
                    })
                })
                .collect();
            pending_details.push(json!({
                "type": "tray_sni",
                "items": items,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::MutationAck {
            domain,
            client_mutation_id,
            status,
            snapshot_epoch,
        } => {
            pending_details.push(json!({
                "type": "mutation_ack",
                "domain": domain,
                "client_mutation_id": client_mutation_id,
                "status": status,
                "snapshot_epoch": snapshot_epoch,
            }));
        }
        shell_wire::DecodedCompositorToShellMessage::VolumeOverlay {
            volume_linear_percent_x100,
            muted,
            state_known,
        } => {
            pending_details.push(json!({
                "type": "volume_overlay",
                "volume_linear_percent_x100": volume_linear_percent_x100,
                "muted": muted,
                "state_known": state_known,
            }));
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
