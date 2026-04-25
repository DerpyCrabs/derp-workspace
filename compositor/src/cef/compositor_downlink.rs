use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use cef::{
    binary_value_create, process_message_create, Browser, CefString, ImplBrowser, ImplBrowserHost,
    ImplFrame, ImplListValue, ImplProcessMessage, KeyEvent, KeyEventType, MouseButtonType,
    MouseEvent, PointerType, ProcessId, TouchEvent, TouchEventType,
};
use serde_json::{json, Value};

use crate::cef::osr_view_state::OsrViewState;

pub const PROCESS_MESSAGE_NAME: &str = "derp_shell_downlink";
const HOT_BATCH_MAGIC: &[u8; 4] = b"DHB1";
const HOT_DETAIL_WINDOW_GEOMETRY: u8 = 1;
const HOT_DETAIL_WINDOW_STATE: u8 = 2;
const HOT_DETAIL_WINDOW_UNMAPPED: u8 = 3;
const HOT_DETAIL_FOCUS_CHANGED: u8 = 4;
const HOT_DETAIL_WINDOW_ORDER: u8 = 5;
const HOT_DETAIL_INTERACTION_STATE: u8 = 6;
static CEF_HOST_FOCUSED_FOR_INPUT: AtomicBool = AtomicBool::new(false);

fn detail_with_snapshot_epoch(mut detail: Value, snapshot_epoch: u64) -> Value {
    if snapshot_epoch > 0 {
        if let Some(object) = detail.as_object_mut() {
            object.insert("snapshot_epoch".to_string(), json!(snapshot_epoch));
        }
    }
    detail
}

fn value_u32(value: &Value, key: &str) -> Option<u32> {
    value.get(key)?.as_u64().and_then(|v| u32::try_from(v).ok())
}

fn value_i32(value: &Value, key: &str) -> Option<i32> {
    value.get(key)?.as_i64().and_then(|v| i32::try_from(v).ok())
}

fn value_bool(value: &Value, key: &str) -> Option<bool> {
    value.get(key)?.as_bool()
}

fn value_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

fn push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_i32(bytes: &mut Vec<u8>, value: i32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(bytes: &mut Vec<u8>, value: u64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_string(bytes: &mut Vec<u8>, value: &str) -> bool {
    let Ok(length) = u32::try_from(value.len()) else {
        return false;
    };
    push_u32(bytes, length);
    bytes.extend_from_slice(value.as_bytes());
    true
}

fn push_hot_visual(bytes: &mut Vec<u8>, detail: &Value, key: &str) -> bool {
    let Some(visual) = detail.get(key) else {
        push_i32(bytes, 0);
        push_i32(bytes, 0);
        push_i32(bytes, 0);
        push_i32(bytes, 0);
        push_u32(bytes, 0);
        return true;
    };
    if visual.is_null() {
        push_i32(bytes, 0);
        push_i32(bytes, 0);
        push_i32(bytes, 0);
        push_i32(bytes, 0);
        push_u32(bytes, 0);
        return true;
    }
    let (Some(x), Some(y), Some(width), Some(height)) = (
        value_i32(visual, "x"),
        value_i32(visual, "y"),
        value_i32(visual, "width"),
        value_i32(visual, "height"),
    ) else {
        return false;
    };
    push_i32(bytes, x);
    push_i32(bytes, y);
    push_i32(bytes, width);
    push_i32(bytes, height);
    let mut flags = 0u32;
    if value_bool(visual, "maximized").unwrap_or(false) {
        flags |= 1;
    }
    if value_bool(visual, "fullscreen").unwrap_or(false) {
        flags |= 2;
    }
    push_u32(bytes, flags);
    true
}

fn encode_hot_detail(bytes: &mut Vec<u8>, detail: &Value) -> bool {
    let Some(kind) = value_string(detail, "type") else {
        return false;
    };
    let snapshot_epoch = detail
        .get("snapshot_epoch")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    match kind {
        "window_geometry" => {
            bytes.push(HOT_DETAIL_WINDOW_GEOMETRY);
            push_u64(bytes, snapshot_epoch);
            let (Some(window_id), Some(surface_id), Some(x), Some(y), Some(width), Some(height)) = (
                value_u32(detail, "window_id"),
                value_u32(detail, "surface_id"),
                value_i32(detail, "x"),
                value_i32(detail, "y"),
                value_i32(detail, "width"),
                value_i32(detail, "height"),
            ) else {
                return false;
            };
            push_u32(bytes, window_id);
            push_u32(bytes, surface_id);
            push_i32(bytes, x);
            push_i32(bytes, y);
            push_i32(bytes, width);
            push_i32(bytes, height);
            let mut flags = 0u8;
            if value_bool(detail, "maximized").unwrap_or(false) {
                flags |= 1;
            }
            if value_bool(detail, "fullscreen").unwrap_or(false) {
                flags |= 2;
            }
            bytes.push(flags);
            push_string(bytes, value_string(detail, "output_id").unwrap_or(""))
                && push_string(bytes, value_string(detail, "output_name").unwrap_or(""))
        }
        "window_state" => {
            bytes.push(HOT_DETAIL_WINDOW_STATE);
            push_u64(bytes, snapshot_epoch);
            let Some(window_id) = value_u32(detail, "window_id") else {
                return false;
            };
            push_u32(bytes, window_id);
            bytes.push(u8::from(value_bool(detail, "minimized").unwrap_or(false)));
            true
        }
        "window_unmapped" => {
            bytes.push(HOT_DETAIL_WINDOW_UNMAPPED);
            push_u64(bytes, snapshot_epoch);
            let Some(window_id) = value_u32(detail, "window_id") else {
                return false;
            };
            push_u32(bytes, window_id);
            true
        }
        "focus_changed" => {
            bytes.push(HOT_DETAIL_FOCUS_CHANGED);
            push_u64(bytes, snapshot_epoch);
            match detail.get("surface_id").and_then(Value::as_u64) {
                Some(surface_id) => {
                    let Ok(surface_id) = u32::try_from(surface_id) else {
                        return false;
                    };
                    bytes.push(1);
                    push_u32(bytes, surface_id);
                }
                None => {
                    bytes.push(0);
                    push_u32(bytes, 0);
                }
            }
            match detail.get("window_id").and_then(Value::as_u64) {
                Some(window_id) => {
                    let Ok(window_id) = u32::try_from(window_id) else {
                        return false;
                    };
                    bytes.push(1);
                    push_u32(bytes, window_id);
                }
                None => {
                    bytes.push(0);
                    push_u32(bytes, 0);
                }
            }
            true
        }
        "window_order" => {
            bytes.push(HOT_DETAIL_WINDOW_ORDER);
            push_u64(bytes, snapshot_epoch);
            push_u64(
                bytes,
                detail.get("revision").and_then(Value::as_u64).unwrap_or(0),
            );
            let Some(windows) = detail.get("windows").and_then(Value::as_array) else {
                return false;
            };
            let Ok(count) = u32::try_from(windows.len()) else {
                return false;
            };
            push_u32(bytes, count);
            for window in windows {
                let (Some(window_id), Some(stack_z)) =
                    (value_u32(window, "window_id"), value_u32(window, "stack_z"))
                else {
                    return false;
                };
                push_u32(bytes, window_id);
                push_u32(bytes, stack_z);
            }
            true
        }
        "interaction_state" => {
            bytes.push(HOT_DETAIL_INTERACTION_STATE);
            push_u64(bytes, snapshot_epoch);
            let (Some(pointer_x), Some(pointer_y)) = (
                value_i32(detail, "pointer_x"),
                value_i32(detail, "pointer_y"),
            ) else {
                return false;
            };
            let move_window_id = value_u32(detail, "move_window_id").unwrap_or(0);
            let resize_window_id = value_u32(detail, "resize_window_id").unwrap_or(0);
            let move_proxy_window_id = value_u32(detail, "move_proxy_window_id").unwrap_or(0);
            let move_capture_window_id = value_u32(detail, "move_capture_window_id").unwrap_or(0);
            let window_switcher_selected_window_id =
                value_u32(detail, "window_switcher_selected_window_id").unwrap_or(0);
            push_u64(
                bytes,
                detail.get("revision").and_then(Value::as_u64).unwrap_or(0),
            );
            push_i32(bytes, pointer_x);
            push_i32(bytes, pointer_y);
            push_u32(bytes, move_window_id);
            push_u32(bytes, resize_window_id);
            push_u32(bytes, move_proxy_window_id);
            push_u32(bytes, move_capture_window_id);
            push_hot_visual(bytes, detail, "move_rect")
                && push_hot_visual(bytes, detail, "resize_rect")
                && {
                    push_u32(bytes, window_switcher_selected_window_id);
                    true
                }
        }
        _ => false,
    }
}

fn encode_hot_detail_batch(details: &[Value]) -> Option<Vec<u8>> {
    let count = u32::try_from(details.len()).ok()?;
    if details
        .iter()
        .any(|detail| value_string(detail, "type") == Some("interaction_state"))
    {
        return None;
    }
    let mut bytes = Vec::with_capacity(8 + details.len().saturating_mul(48));
    bytes.extend_from_slice(HOT_BATCH_MAGIC);
    push_u32(&mut bytes, count);
    for detail in details {
        let start = bytes.len();
        if !encode_hot_detail(&mut bytes, detail) {
            bytes.truncate(start);
            return None;
        }
    }
    Some(bytes)
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
    let Some(frame) = browser.main_frame() else {
        return;
    };
    let Some(mut msg) = process_message_create(Some(&CefString::from(PROCESS_MESSAGE_NAME))) else {
        return;
    };
    let Some(list) = msg.argument_list() else {
        return;
    };
    let (op, payload_bytes) = if let Some(bytes) = encode_hot_detail_batch(details) {
        ("batch_hot", bytes)
    } else {
        let Ok(js) = serde_json::to_vec(details) else {
            return;
        };
        ("batch_json", js)
    };
    let Some(mut payload) = binary_value_create(Some(&payload_bytes)) else {
        return;
    };
    let _ = list.set_string(0, Some(&CefString::from(op)));
    let _ = list.set_binary(1, Some(&mut payload));
    frame.send_process_message(ProcessId::RENDERER, Some(&mut msg));
}

fn dispatch_shell_snapshot_notify(browser: &Browser) {
    crate::cef::begin_frame_diag::note_shell_snapshot_notify();
    let Some(frame) = browser.main_frame() else {
        return;
    };
    let Some(mut msg) = process_message_create(Some(&CefString::from(PROCESS_MESSAGE_NAME))) else {
        return;
    };
    let Some(list) = msg.argument_list() else {
        return;
    };
    let _ = list.set_string(0, Some(&CefString::from("snapshot_notify")));
    frame.send_process_message(ProcessId::RENDERER, Some(&mut msg));
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

fn ensure_host_focus_for_input(host: &cef::BrowserHost) {
    if CEF_HOST_FOCUSED_FOR_INPUT
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
    {
        host.set_focus(1);
    }
}

pub fn apply_messages(
    messages: Vec<crate::cef::bridge::PendingCompositorMessage>,
    browser: &Mutex<Option<Browser>>,
    view_state: &Mutex<OsrViewState>,
) {
    let browser = match browser.lock() {
        Ok(guard) => guard.as_ref().cloned(),
        Err(_) => return,
    };
    let mut pending_details = Vec::new();
    let mut snapshot_dirty = false;
    for pending in messages {
        apply_message(
            pending.msg,
            pending.snapshot_epoch,
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
    message_snapshot_epoch: u64,
    browser: Option<&Browser>,
    view_state: &Mutex<OsrViewState>,
    pending_details: &mut Vec<Value>,
    _snapshot_dirty: &mut bool,
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
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "output_geometry",
                    "logical_width": logical_w,
                    "logical_height": logical_h,
                }),
                message_snapshot_epoch,
            ));
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
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "output_layout",
                    "revision": revision,
                    "canvas_logical_width": canvas_logical_w,
                    "canvas_logical_height": canvas_logical_h,
                    "canvas_physical_width": canvas_physical_w,
                    "canvas_physical_height": canvas_physical_h,
                    "screens": screens,
                    "shell_chrome_primary": shell_chrome_primary,
                }),
                message_snapshot_epoch,
            ));
        }
        shell_wire::DecodedCompositorToShellMessage::WindowMapped {
            window_id,
            surface_id,
            stack_z,
            x,
            y,
            w,
            h,
            minimized,
            maximized,
            fullscreen,
            title,
            app_id,
            shell_flags,
            output_id,
            output_name,
            capture_identifier,
            kind,
            x11_class,
            x11_instance,
            ..
        } => {
            crate::cef::begin_frame_diag::note_shell_detail_window_mapped();
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "window_mapped",
                    "window_id": window_id,
                    "surface_id": surface_id,
                    "stack_z": stack_z,
                    "x": x,
                    "y": y,
                    "width": w,
                    "height": h,
                    "minimized": minimized,
                    "maximized": maximized,
                    "fullscreen": fullscreen,
                    "title": title,
                    "app_id": app_id,
                    "shell_flags": shell_flags,
                    "output_id": output_id,
                    "output_name": output_name,
                    "capture_identifier": capture_identifier,
                    "kind": kind,
                    "x11_class": x11_class,
                    "x11_instance": x11_instance,
                }),
                message_snapshot_epoch,
            ));
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
            output_id,
            output_name,
            ..
        } => {
            crate::cef::begin_frame_diag::note_shell_detail_window_geometry();
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "window_geometry",
                    "window_id": window_id,
                    "surface_id": surface_id,
                    "x": x,
                    "y": y,
                    "width": w,
                    "height": h,
                    "output_id": output_id,
                    "output_name": output_name,
                    "maximized": maximized,
                    "fullscreen": fullscreen,
                }),
                message_snapshot_epoch,
            ));
        }
        shell_wire::DecodedCompositorToShellMessage::WindowMetadata {
            window_id,
            surface_id,
            title,
            app_id,
        } => {
            crate::cef::begin_frame_diag::note_shell_detail_window_metadata();
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "window_metadata",
                    "window_id": window_id,
                    "surface_id": surface_id,
                    "title": title,
                    "app_id": app_id,
                }),
                message_snapshot_epoch,
            ));
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
                        "workspace_visible": window.workspace_visible != 0,
                        "shell_flags": window.shell_flags,
                        "title": window.title,
                        "app_id": window.app_id,
                        "output_id": window.output_id,
                        "output_name": window.output_name,
                        "capture_identifier": window.capture_identifier,
                        "kind": window.kind,
                        "x11_class": window.x11_class,
                        "x11_instance": window.x11_instance,
                    })
                })
                .collect();
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "window_list",
                    "revision": revision,
                    "windows": windows,
                }),
                message_snapshot_epoch,
            ));
        }
        shell_wire::DecodedCompositorToShellMessage::WindowState {
            window_id,
            minimized,
        } => {
            crate::cef::begin_frame_diag::note_shell_detail_window_state();
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "window_state",
                    "window_id": window_id,
                    "minimized": minimized,
                }),
                message_snapshot_epoch,
            ));
        }
        shell_wire::DecodedCompositorToShellMessage::WindowOrder { revision, windows } => {
            let windows: Vec<Value> = windows
                .into_iter()
                .map(|window| {
                    json!({
                        "window_id": window.window_id,
                        "stack_z": window.stack_z,
                    })
                })
                .collect();
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "window_order",
                    "revision": revision,
                    "windows": windows,
                }),
                message_snapshot_epoch,
            ));
        }
        shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id,
            window_id,
        } => {
            CEF_HOST_FOCUSED_FOR_INPUT.store(false, Ordering::Relaxed);
            crate::cef::begin_frame_diag::note_shell_detail_focus_changed();
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "focus_changed",
                    "surface_id": surface_id,
                    "window_id": window_id,
                }),
                message_snapshot_epoch,
            ));
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
            let Some(b) = browser else {
                return;
            };
            let Some(host) = b.host() else {
                return;
            };
            ensure_host_focus_for_input(&host);
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
            let Some(b) = browser else {
                return;
            };
            let Some(host) = b.host() else {
                return;
            };
            ensure_host_focus_for_input(&host);
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
            let Some(b) = browser else {
                return;
            };
            let Some(host) = b.host() else {
                return;
            };
            ensure_host_focus_for_input(&host);
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
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "workspace_state",
                    "revision": revision,
                    "state": state,
                }),
                message_snapshot_epoch,
            ));
        }
        shell_wire::DecodedCompositorToShellMessage::WorkspaceStateBinary { .. } => {}
        shell_wire::DecodedCompositorToShellMessage::ShellHostedAppState {
            revision,
            state_json,
        } => {
            let Ok(state) = serde_json::from_str::<Value>(&state_json) else {
                return;
            };
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "shell_hosted_app_state",
                    "revision": revision,
                    "state": state,
                }),
                message_snapshot_epoch,
            ));
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
            window_switcher_selected_window_id,
        } => {
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "interaction_state",
                    "revision": revision,
                    "pointer_x": pointer_x,
                    "pointer_y": pointer_y,
                    "move_window_id": move_window_id,
                    "resize_window_id": resize_window_id,
                    "move_proxy_window_id": move_proxy_window_id,
                    "move_capture_window_id": move_capture_window_id,
                    "window_switcher_selected_window_id": window_switcher_selected_window_id,
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
                }),
                message_snapshot_epoch,
            ));
        }
        shell_wire::DecodedCompositorToShellMessage::TrayHints {
            slot_count,
            slot_w,
            reserved_w,
        } => {
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "tray_hints",
                    "slot_count": slot_count,
                    "slot_w": slot_w,
                    "reserved_w": reserved_w,
                }),
                message_snapshot_epoch,
            ));
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
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "tray_sni",
                    "items": items,
                }),
                message_snapshot_epoch,
            ));
        }
        shell_wire::DecodedCompositorToShellMessage::MutationAck {
            domain,
            client_mutation_id,
            status,
            snapshot_epoch: ack_snapshot_epoch,
        } => {
            pending_details.push(detail_with_snapshot_epoch(
                json!({
                    "type": "mutation_ack",
                    "domain": domain,
                    "client_mutation_id": client_mutation_id,
                    "status": status,
                    "snapshot_epoch": ack_snapshot_epoch,
                }),
                message_snapshot_epoch,
            ));
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
