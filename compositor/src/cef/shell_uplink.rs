use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cef::{sys, *};

use crate::cef::e2e_bridge;
use crate::cef::osr_view_state::OsrViewState;
use crate::cef::shared_state;
use crate::cef::shell_snapshot;
use crate::cef::uplink::UplinkToCompositor;

pub const PROCESS_MESSAGE_NAME: &str = "derp_shell_uplink";

pub(crate) fn cef_string_userfree_to_string(s: &CefStringUserfreeUtf16) -> String {
    CefStringUtf8::from(&CefStringUtf16::from(s)).to_string()
}

static LAST_DRAG_VIEW_INVALIDATE: Mutex<Option<Instant>> = Mutex::new(None);

fn drag_invalidate_min_interval() -> Duration {
    Duration::from_millis(1)
}

fn reset_drag_invalidate_throttle() {
    *LAST_DRAG_VIEW_INVALIDATE
        .lock()
        .expect("LAST_DRAG_VIEW_INVALIDATE") = None;
}

fn maybe_invalidate_shell_view_after_move_delta(
    browser: Option<&mut Browser>,
    reason: crate::cef::begin_frame_diag::ShellViewInvalidateReason,
) {
    let min_gap = drag_invalidate_min_interval();
    let now = Instant::now();
    {
        let mut last = LAST_DRAG_VIEW_INVALIDATE
            .lock()
            .expect("LAST_DRAG_VIEW_INVALIDATE");
        if let Some(t) = *last {
            if now.duration_since(t) < min_gap {
                return;
            }
        }
        *last = Some(now);
    }
    if let Some(b) = browser {
        if let Some(host) = b.host() {
            crate::cef::begin_frame_diag::note_shell_view_invalidate(reason);
            host.invalidate(PaintElementType::VIEW);
        }
    }
}

fn invalidate_shell_view_unthrottled(
    browser: Option<&mut Browser>,
    reason: crate::cef::begin_frame_diag::ShellViewInvalidateReason,
) {
    reset_drag_invalidate_throttle();
    if let Some(b) = browser {
        if let Some(host) = b.host() {
            crate::cef::begin_frame_diag::note_shell_view_invalidate(reason);
            host.invalidate(PaintElementType::VIEW);
        }
    }
}

fn handle_uplink_list(
    uplink: &UplinkToCompositor,
    browser: Option<&mut Browser>,
    _view_state: Option<&Arc<Mutex<OsrViewState>>>,
    args: &ListValue,
) {
    let op = cef_string_userfree_to_string(&args.string(0));
    match op.as_str() {
        "close" => {
            let wid = args.int(1) as u32;
            uplink.shell_close(wid);
        }
        "quit" => uplink.quit_compositor(),
        "spawn" => {
            let cmd = cef_string_userfree_to_string(&args.string(1));
            uplink.spawn_wayland_client(cmd);
        }
        "move_begin" => {
            let wid = args.int(1) as u32;
            tracing::debug!(target: "derp_shell_move", wid, "cef uplink: move_begin");
            reset_drag_invalidate_throttle();
            uplink.shell_move_begin(wid);
        }
        "move_delta" => {
            let dx = args.int(1) as i32;
            let dy = args.int(2) as i32;
            tracing::debug!(target: "derp_shell_move", dx, dy, "cef uplink: move_delta");
            uplink.shell_move_delta(dx, dy);
        }
        "move_end" => {
            let wid = args.int(1) as u32;
            tracing::debug!(target: "derp_shell_move", wid, "cef uplink: move_end");
            uplink.shell_move_end(wid);
            invalidate_shell_view_unthrottled(
                browser,
                crate::cef::begin_frame_diag::ShellViewInvalidateReason::MoveEnd,
            );
        }
        "resize_begin" => {
            let wid = args.int(1) as u32;
            let edges = args.int(2) as u32;
            tracing::debug!(target: "derp_shell_resize", wid, edges, "cef uplink: resize_begin");
            reset_drag_invalidate_throttle();
            if shell_wire::encode_shell_resize_begin(wid, edges).is_some() {
                uplink.shell_resize_begin(wid, edges);
            }
        }
        "resize_delta" => {
            let dx = args.int(1) as i32;
            let dy = args.int(2) as i32;
            tracing::debug!(target: "derp_shell_resize", dx, dy, "cef uplink: resize_delta");
            uplink.shell_resize_delta(dx, dy);
            maybe_invalidate_shell_view_after_move_delta(
                browser,
                crate::cef::begin_frame_diag::ShellViewInvalidateReason::ResizeDelta,
            );
        }
        "resize_end" => {
            let wid = args.int(1) as u32;
            tracing::debug!(target: "derp_shell_resize", wid, "cef uplink: resize_end");
            uplink.shell_resize_end(wid);
            invalidate_shell_view_unthrottled(
                browser,
                crate::cef::begin_frame_diag::ShellViewInvalidateReason::ResizeEnd,
            );
        }
        "resize_shell_grab_begin" => {
            let wid = args.int(1) as u32;
            tracing::debug!(target: "derp_shell_resize", wid, "cef uplink: resize_shell_grab_begin");
            reset_drag_invalidate_throttle();
            uplink.shell_resize_shell_grab_begin(wid);
        }
        "resize_shell_grab_end" => {
            tracing::debug!(target: "derp_shell_resize", "cef uplink: resize_shell_grab_end");
            uplink.shell_resize_shell_grab_end();
            invalidate_shell_view_unthrottled(
                browser,
                crate::cef::begin_frame_diag::ShellViewInvalidateReason::ResizeShellGrabEnd,
            );
        }
        "taskbar_activate" => {
            let wid = args.int(1) as u32;
            uplink.shell_taskbar_activate(wid);
        }
        "activate_window" => {
            let wid = args.int(1) as u32;
            uplink.shell_activate_window(wid);
        }
        "shell_focus_ui_window" => {
            let wid = args.int(1) as u32;
            uplink.shell_focus_shell_ui_window(wid);
        }
        "shell_blur_ui_window" => {
            uplink.shell_blur_shell_ui_focus();
        }
        "shell_ui_grab_begin" => {
            let wid = args.int(1) as u32;
            uplink.shell_ui_pointer_grab_begin(wid);
        }
        "shell_ui_grab_end" => {
            uplink.shell_ui_pointer_grab_end();
        }
        "minimize" => {
            let wid = args.int(1) as u32;
            uplink.shell_minimize(wid);
        }
        "set_fullscreen" => {
            let wid = args.int(1) as u32;
            let en = args.int(2) != 0;
            uplink.shell_set_fullscreen(wid, en);
        }
        "set_maximized" => {
            let wid = args.int(1) as u32;
            let en = args.int(2) != 0;
            uplink.shell_set_maximized(wid, en);
        }
        "set_geometry" => {
            let wid = args.int(1) as u32;
            let vx = args.int(2);
            let vy = args.int(3);
            let vw = args.int(4).max(1);
            let vh = args.int(5).max(1);
            let layout = args.int(6) as u32;
            uplink.shell_set_geometry(wid, vx, vy, vw, vh, layout);
        }
        "presentation_fullscreen" => {
            let en = args.int(1) != 0;
            uplink.shell_set_presentation_fullscreen(en);
        }
        "set_output_layout" => {
            let json = cef_string_userfree_to_string(&args.string(1));
            uplink.shell_apply_output_layout(json);
        }
        "set_shell_primary" => {
            let name = cef_string_userfree_to_string(&args.string(1));
            uplink.shell_set_shell_primary(name);
        }
        "set_ui_scale" => {
            let pct = args.int(1);
            let scale = match pct {
                100 => 1.0,
                150 => 1.5,
                200 => 2.0,
                _ => return,
            };
            uplink.shell_set_ui_scale(scale);
        }
        "set_tile_preview" => {
            let vis = args.int(1) != 0;
            let x = args.int(2);
            let y = args.int(3);
            let w = args.int(4);
            let h = args.int(5);
            uplink.shell_tile_preview_canvas(vis, x, y, w, h);
        }
        "set_chrome_metrics" => {
            uplink.shell_chrome_metrics(args.int(1), args.int(2));
        }
        "request_compositor_sync" => {
            uplink.shell_request_compositor_sync();
        }
        "backed_window_open" => {
            let json = cef_string_userfree_to_string(&args.string(1));
            uplink.shell_backed_window_open(json);
        }
        "workspace_mutation" => {
            let json = cef_string_userfree_to_string(&args.string(1));
            uplink.shell_workspace_mutation(json);
        }
        "shell_hosted_window_state" => {
            let json = cef_string_userfree_to_string(&args.string(1));
            uplink.shell_hosted_window_state(json);
        }
        "shell_ipc_pong" => {
            uplink.shell_ipc_pong();
        }
        "shared_state_sync" => {
            let kind = args.int(1) as u32;
            uplink.shell_shared_state_sync(kind);
        }
        "sni_tray_activate" => {
            let id = cef_string_userfree_to_string(&args.string(1));
            uplink.sni_tray_activate(id);
        }
        "sni_tray_open_menu" => {
            let id = cef_string_userfree_to_string(&args.string(1));
            let serial = args.int(2) as u32;
            uplink.sni_tray_open_menu(id, serial);
        }
        "sni_tray_menu_event" => {
            let id = cef_string_userfree_to_string(&args.string(1));
            let menu_path = cef_string_userfree_to_string(&args.string(2));
            let item_id = args.int(3);
            uplink.sni_tray_menu_event(id, menu_path, item_id);
        }
        "set_desktop_background" => {
            let json = cef_string_userfree_to_string(&args.string(1));
            uplink.shell_set_desktop_background(json);
        }
        "e2e_snapshot_response" => {
            let request_id = args.int(1) as u64;
            let json = cef_string_userfree_to_string(&args.string(2));
            e2e_bridge::publish_shell_snapshot(request_id, json);
        }
        "e2e_html_response" => {
            let request_id = args.int(1) as u64;
            let html = cef_string_userfree_to_string(&args.string(2));
            e2e_bridge::publish_shell_html(request_id, html);
        }
        "e2e_test_window_open_response" => {
            let request_id = args.int(1) as u64;
            let ok = args.int(2) != 0;
            e2e_bridge::publish_shell_test_window_open(request_id, ok);
        }
        _ => {}
    }
}

pub fn on_browser_process_message(
    uplink: &UplinkToCompositor,
    browser: Option<&mut Browser>,
    source_process: ProcessId,
    message: Option<&mut ProcessMessage>,
    view_state: Option<&Arc<Mutex<OsrViewState>>>,
) -> bool {
    if source_process != ProcessId::RENDERER {
        return false;
    }
    let Some(msg) = message else {
        return false;
    };
    if cef_string_userfree_to_string(&msg.name()) != PROCESS_MESSAGE_NAME {
        return false;
    }
    let Some(args) = msg.argument_list() else {
        return true;
    };
    handle_uplink_list(uplink, browser, view_state, &args);
    true
}

wrap_v8_handler! {
    pub struct ShellWireV8Handler {
        frame: Frame,
    }

    impl V8Handler {
        fn execute(
            &self,
            _name: Option<&CefString>,
            _object: Option<&mut V8Value>,
            arguments: Option<&[Option<V8Value>]>,
            _retval: Option<&mut Option<V8Value>>,
            exception: Option<&mut CefString>,
        ) -> i32 {
            macro_rules! return_exception {
                ($message:expr) => {{
                    if let Some(ex) = exception {
                        *ex = CefString::from($message);
                    }
                    return 1;
                }};
            }

            let Some(args) = arguments else {
                return 0;
            };
            let Some(op_v) = args.first().and_then(|a| a.as_ref()) else {
                return_exception!("expected (op, arg?)");
            };
            if op_v.is_string() == 0 {
                return_exception!("op must be a string");
            }
            let op = cef_string_userfree_to_string(&op_v.string_value());

            let mut msg = match process_message_create(Some(&CefString::from(PROCESS_MESSAGE_NAME))) {
                Some(m) => m,
                None => return_exception!("process_message_create failed"),
            };
            let Some(list) = msg.argument_list() else {
                return_exception!("no argument list");
            };
            let _ = list.set_string(0, Some(&CefString::from(op.as_str())));

            match op.as_str() {
                "close" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("close requires window id");
                    };
                    let id = if a1.is_int() != 0 {
                        a1.int_value()
                    } else if a1.is_uint() != 0 {
                        a1.uint_value() as i32
                    } else if a1.is_double() != 0 {
                        a1.double_value() as i32
                    } else {
                        return_exception!("close: second arg must be a number");
                    };
                    if id < 0 {
                        return_exception!("close: window id must be non-negative");
                    }
                    let _ = list.set_int(1, id);
                }
                "quit" => {}
                "backed_window_open" | "workspace_mutation" | "shell_hosted_window_state" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!(
                            "backed_window_open/workspace_mutation/shell_hosted_window_state requires JSON string"
                        );
                    };
                    if a1.is_string() == 0 {
                        return_exception!(
                            "backed_window_open/workspace_mutation/shell_hosted_window_state: second arg must be a string"
                        );
                    }
                    let json = cef_string_userfree_to_string(&a1.string_value());
                    let _ = list.set_string(1, Some(&CefString::from(json.as_str())));
                }
                "shell_blur_ui_window" => {}
                "shell_ui_grab_end" => {}
                "resize_shell_grab_end" => {}
                "request_compositor_sync" => {}
                "shell_ipc_pong" => {}
                "spawn" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("spawn requires command string");
                    };
                    if a1.is_string() == 0 {
                        return_exception!("spawn: command must be a string");
                    }
                    let cmd = cef_string_userfree_to_string(&a1.string_value());
                    let _ = list.set_string(1, Some(&CefString::from(cmd.as_str())));
                }
                "move_begin" | "move_end" | "taskbar_activate" | "activate_window"
                | "shell_focus_ui_window" | "shell_ui_grab_begin" | "minimize" | "resize_end"
                | "resize_shell_grab_begin" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("move_begin/move_end/resize_end/resize_shell_grab_begin/taskbar_activate/activate_window/shell_focus_ui_window/shell_ui_grab_begin/minimize require window id");
                    };
                    let id = if a1.is_int() != 0 {
                        a1.int_value()
                    } else if a1.is_uint() != 0 {
                        a1.uint_value() as i32
                    } else if a1.is_double() != 0 {
                        a1.double_value() as i32
                    } else {
                        return_exception!("move_begin/move_end/resize_end/resize_shell_grab_begin/taskbar_activate/activate_window/shell_focus_ui_window/shell_ui_grab_begin/minimize: second arg must be a number");
                    };
                    if id < 0 {
                        return_exception!("window id must be non-negative");
                    }
                    let _ = list.set_int(1, id);
                }
                "resize_begin" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("resize_begin requires window id");
                    };
                    let Some(a2) = args.get(2).and_then(|a| a.as_ref()) else {
                        return_exception!("resize_begin requires edges bitmask");
                    };
                    let id = if a1.is_int() != 0 {
                        a1.int_value()
                    } else if a1.is_uint() != 0 {
                        a1.uint_value() as i32
                    } else if a1.is_double() != 0 {
                        a1.double_value() as i32
                    } else {
                        return_exception!("resize_begin: window id must be a number");
                    };
                    if id < 0 {
                        return_exception!("window id must be non-negative");
                    }
                    let edges = if a2.is_int() != 0 {
                        a2.int_value()
                    } else if a2.is_uint() != 0 {
                        a2.uint_value() as i32
                    } else if a2.is_double() != 0 {
                        a2.double_value() as i32
                    } else {
                        return_exception!("resize_begin: edges must be a number");
                    };
                    if edges <= 0 || edges > 15 {
                        return_exception!("resize_begin: edges must be 1..=15 (bitmask)");
                    }
                    let _ = list.set_int(1, id);
                    let _ = list.set_int(2, edges);
                }
                "move_delta" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("move_delta requires dx");
                    };
                    let Some(a2) = args.get(2).and_then(|a| a.as_ref()) else {
                        return_exception!("move_delta requires dy");
                    };
                    let dx = if a1.is_int() != 0 {
                        a1.int_value()
                    } else if a1.is_double() != 0 {
                        a1.double_value() as i32
                    } else {
                        return_exception!("move_delta: dx must be a number");
                    };
                    let dy = if a2.is_int() != 0 {
                        a2.int_value()
                    } else if a2.is_double() != 0 {
                        a2.double_value() as i32
                    } else {
                        return_exception!("move_delta: dy must be a number");
                    };
                    let _ = list.set_int(1, dx);
                    let _ = list.set_int(2, dy);
                }
                "resize_delta" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("resize_delta requires dx");
                    };
                    let Some(a2) = args.get(2).and_then(|a| a.as_ref()) else {
                        return_exception!("resize_delta requires dy");
                    };
                    let dx = if a1.is_int() != 0 {
                        a1.int_value()
                    } else if a1.is_double() != 0 {
                        a1.double_value() as i32
                    } else {
                        return_exception!("resize_delta: dx must be a number");
                    };
                    let dy = if a2.is_int() != 0 {
                        a2.int_value()
                    } else if a2.is_double() != 0 {
                        a2.double_value() as i32
                    } else {
                        return_exception!("resize_delta: dy must be a number");
                    };
                    let _ = list.set_int(1, dx);
                    let _ = list.set_int(2, dy);
                }
                "set_geometry" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("set_geometry requires window id");
                    };
                    let Some(ax) = args.get(2).and_then(|a| a.as_ref()) else {
                        return_exception!("set_geometry requires x,y,w,h");
                    };
                    let Some(ay) = args.get(3).and_then(|a| a.as_ref()) else {
                        return_exception!("set_geometry requires y,w,h");
                    };
                    let Some(aw) = args.get(4).and_then(|a| a.as_ref()) else {
                        return_exception!("set_geometry requires w,h");
                    };
                    let Some(ah) = args.get(5).and_then(|a| a.as_ref()) else {
                        return_exception!("set_geometry requires h");
                    };
                    let id = if a1.is_int() != 0 {
                        a1.int_value()
                    } else if a1.is_uint() != 0 {
                        a1.uint_value() as i32
                    } else if a1.is_double() != 0 {
                        a1.double_value() as i32
                    } else {
                        return_exception!("set_geometry: window id must be a number");
                    };
                    if id < 0 {
                        return_exception!("set_geometry: window id must be non-negative");
                    }
                    macro_rules! int_arg {
                        ($v:expr, $label:literal) => {
                            if $v.is_int() != 0 {
                                $v.int_value()
                            } else if $v.is_uint() != 0 {
                                $v.uint_value() as i32
                            } else if $v.is_double() != 0 {
                                $v.double_value() as i32
                            } else {
                                return_exception!(concat!($label, " must be a number"));
                            }
                        };
                    }
                    let x = int_arg!(ax, "set_geometry: x");
                    let y = int_arg!(ay, "set_geometry: y");
                    let w = int_arg!(aw, "set_geometry: w");
                    let h = int_arg!(ah, "set_geometry: h");
                    let layout = if let Some(al) = args.get(6).and_then(|a| a.as_ref()) {
                        let v = int_arg!(al, "set_geometry: layout");
                        if v < 0 || v > 1 {
                            return_exception!("set_geometry: layout must be 0 or 1");
                        }
                        v
                    } else {
                        0
                    };
                    let _ = list.set_int(1, id);
                    let _ = list.set_int(2, x);
                    let _ = list.set_int(3, y);
                    let _ = list.set_int(4, w);
                    let _ = list.set_int(5, h);
                    let _ = list.set_int(6, layout);
                }
                "set_fullscreen" | "set_maximized" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("set_fullscreen/set_maximized require window id");
                    };
                    let Some(a2) = args.get(2).and_then(|a| a.as_ref()) else {
                        return_exception!("set_fullscreen/set_maximized require enabled (0 or 1)");
                    };
                    let id = if a1.is_int() != 0 {
                        a1.int_value()
                    } else if a1.is_uint() != 0 {
                        a1.uint_value() as i32
                    } else if a1.is_double() != 0 {
                        a1.double_value() as i32
                    } else {
                        return_exception!("window id must be a number");
                    };
                    if id < 0 {
                        return_exception!("window id must be non-negative");
                    }
                    let en = if a2.is_int() != 0 {
                        a2.int_value()
                    } else if a2.is_uint() != 0 {
                        a2.uint_value() as i32
                    } else if a2.is_double() != 0 {
                        a2.double_value() as i32
                    } else {
                        return_exception!("enabled must be a number");
                    };
                    let _ = list.set_int(1, id);
                    let _ = list.set_int(2, en);
                }
                "e2e_test_window_open_response" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("e2e_test_window_open_response requires request id");
                    };
                    let Some(a2) = args.get(2).and_then(|a| a.as_ref()) else {
                        return_exception!("e2e_test_window_open_response requires ok (0 or 1)");
                    };
                    let id = if a1.is_int() != 0 {
                        a1.int_value()
                    } else if a1.is_uint() != 0 {
                        a1.uint_value() as i32
                    } else if a1.is_double() != 0 {
                        a1.double_value() as i32
                    } else {
                        return_exception!("e2e_test_window_open_response request id must be a number");
                    };
                    if id < 0 {
                        return_exception!("e2e_test_window_open_response request id must be non-negative");
                    }
                    let ok = if a2.is_int() != 0 {
                        a2.int_value()
                    } else if a2.is_uint() != 0 {
                        a2.uint_value() as i32
                    } else if a2.is_double() != 0 {
                        a2.double_value() as i32
                    } else {
                        return_exception!("e2e_test_window_open_response ok must be a number");
                    };
                    let _ = list.set_int(1, id);
                    let _ = list.set_int(2, ok);
                }
                "presentation_fullscreen" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("presentation_fullscreen requires enabled (0 or 1)");
                    };
                    let en = if a1.is_int() != 0 {
                        a1.int_value()
                    } else if a1.is_uint() != 0 {
                        a1.uint_value() as i32
                    } else if a1.is_double() != 0 {
                        a1.double_value() as i32
                    } else {
                        return_exception!("enabled must be a number");
                    };
                    let _ = list.set_int(1, en);
                }
                "set_output_layout" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("set_output_layout requires JSON string");
                    };
                    if a1.is_string() == 0 {
                        return_exception!("set_output_layout: second arg must be a string");
                    }
                    let json = cef_string_userfree_to_string(&a1.string_value());
                    let _ = list.set_string(1, Some(&CefString::from(json.as_str())));
                }
                "set_shell_primary" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("set_shell_primary requires output name string (empty = auto)");
                    };
                    if a1.is_string() == 0 {
                        return_exception!("set_shell_primary: second arg must be a string");
                    }
                    let name = cef_string_userfree_to_string(&a1.string_value());
                    let _ = list.set_string(1, Some(&CefString::from(name.as_str())));
                }
                "set_ui_scale" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("set_ui_scale requires percent (100, 150, or 200)");
                    };
                    let pct = if a1.is_int() != 0 {
                        a1.int_value()
                    } else if a1.is_uint() != 0 {
                        a1.uint_value() as i32
                    } else if a1.is_double() != 0 {
                        a1.double_value() as i32
                    } else {
                        return_exception!("set_ui_scale: percent must be a number");
                    };
                    if pct != 100 && pct != 150 && pct != 200 {
                        return_exception!("set_ui_scale: percent must be 100, 150, or 200");
                    }
                    let _ = list.set_int(1, pct);
                }
                "set_tile_preview" => {
                    macro_rules! int_at_tp {
                        ($idx:literal, $label:literal) => {{
                            let Some(av) = args.get($idx).and_then(|a| a.as_ref()) else {
                                return_exception!($label);
                            };
                            if av.is_int() != 0 {
                                av.int_value()
                            } else if av.is_uint() != 0 {
                                av.uint_value() as i32
                            } else if av.is_double() != 0 {
                                av.double_value() as i32
                            } else {
                                return_exception!($label);
                            }
                        }};
                    }
                    let vis = int_at_tp!(1, "set_tile_preview: arg1 visible (0 or 1)");
                    let x = int_at_tp!(2, "set_tile_preview: arg2 x");
                    let y = int_at_tp!(3, "set_tile_preview: arg3 y");
                    let w = int_at_tp!(4, "set_tile_preview: arg4 w");
                    let h = int_at_tp!(5, "set_tile_preview: arg5 h");
                    if vis < 0 || vis > 1 {
                        return_exception!("set_tile_preview: visible must be 0 or 1");
                    }
                    let _ = list.set_int(1, vis);
                    let _ = list.set_int(2, x);
                    let _ = list.set_int(3, y);
                    let _ = list.set_int(4, w);
                    let _ = list.set_int(5, h);
                }
                "set_chrome_metrics" => {
                    macro_rules! int_at_cm {
                        ($idx:literal, $label:literal) => {{
                            let Some(av) = args.get($idx).and_then(|a| a.as_ref()) else {
                                return_exception!($label);
                            };
                            if av.is_int() != 0 {
                                av.int_value()
                            } else if av.is_uint() != 0 {
                                av.uint_value() as i32
                            } else if av.is_double() != 0 {
                                av.double_value() as i32
                            } else {
                                return_exception!($label);
                            }
                        }};
                    }
                    let th = int_at_cm!(1, "set_chrome_metrics: arg1 titlebar height");
                    let bd = int_at_cm!(2, "set_chrome_metrics: arg2 border width");
                    if th < 0 || th > 256 || bd < 0 || bd > 64 {
                        return_exception!("set_chrome_metrics: titlebar 0..=256 border 0..=64");
                    }
                    let _ = list.set_int(1, th);
                    let _ = list.set_int(2, bd);
                }
                "set_desktop_background" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("set_desktop_background requires JSON string");
                    };
                    if a1.is_string() == 0 {
                        return_exception!("set_desktop_background: second arg must be a string");
                    }
                    let json = cef_string_userfree_to_string(&a1.string_value());
                    let _ = list.set_string(1, Some(&CefString::from(json.as_str())));
                }
                "sni_tray_activate" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("sni_tray_activate requires notifier id string");
                    };
                    if a1.is_string() == 0 {
                        return_exception!("sni_tray_activate: id must be a string");
                    }
                    let id = cef_string_userfree_to_string(&a1.string_value());
                    let _ = list.set_string(1, Some(&CefString::from(id.as_str())));
                }
                "sni_tray_open_menu" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("sni_tray_open_menu requires notifier id string");
                    };
                    if a1.is_string() == 0 {
                        return_exception!("sni_tray_open_menu: id must be a string");
                    }
                    let id = cef_string_userfree_to_string(&a1.string_value());
                    let Some(a2) = args.get(2).and_then(|a| a.as_ref()) else {
                        return_exception!("sni_tray_open_menu requires request serial");
                    };
                    let serial = if a2.is_uint() != 0 {
                        a2.uint_value()
                    } else if a2.is_int() != 0 {
                        a2.int_value().max(0) as u32
                    } else if a2.is_double() != 0 {
                        a2.double_value().max(0.0) as u32
                    } else {
                        return_exception!("sni_tray_open_menu: serial must be a number");
                    };
                    let _ = list.set_string(1, Some(&CefString::from(id.as_str())));
                    let _ = list.set_int(2, serial as i32);
                }
                "sni_tray_menu_event" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("sni_tray_menu_event requires notifier id string");
                    };
                    if a1.is_string() == 0 {
                        return_exception!("sni_tray_menu_event: id must be a string");
                    }
                    let id = cef_string_userfree_to_string(&a1.string_value());
                    let Some(a2) = args.get(2).and_then(|a| a.as_ref()) else {
                        return_exception!("sni_tray_menu_event requires menu path string");
                    };
                    if a2.is_string() == 0 {
                        return_exception!("sni_tray_menu_event: menu path must be a string");
                    }
                    let menu_path = cef_string_userfree_to_string(&a2.string_value());
                    let Some(a3) = args.get(3).and_then(|a| a.as_ref()) else {
                        return_exception!("sni_tray_menu_event requires item id");
                    };
                    let item_id = if a3.is_int() != 0 {
                        a3.int_value()
                    } else if a3.is_uint() != 0 {
                        a3.uint_value() as i32
                    } else if a3.is_double() != 0 {
                        a3.double_value() as i32
                    } else {
                        return_exception!("sni_tray_menu_event: item id must be a number");
                    };
                    let _ = list.set_string(1, Some(&CefString::from(id.as_str())));
                    let _ = list.set_string(2, Some(&CefString::from(menu_path.as_str())));
                    let _ = list.set_int(3, item_id);
                }
                "e2e_snapshot_response" | "e2e_html_response" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("e2e response requires request id");
                    };
                    let Some(a2) = args.get(2).and_then(|a| a.as_ref()) else {
                        return_exception!("e2e response requires payload string");
                    };
                    let id = if a1.is_int() != 0 {
                        a1.int_value()
                    } else if a1.is_uint() != 0 {
                        a1.uint_value() as i32
                    } else if a1.is_double() != 0 {
                        a1.double_value() as i32
                    } else {
                        return_exception!("e2e response request id must be a number");
                    };
                    if id < 0 {
                        return_exception!("e2e response request id must be non-negative");
                    }
                    if a2.is_string() == 0 {
                        return_exception!("e2e response payload must be a string");
                    }
                    let payload = cef_string_userfree_to_string(&a2.string_value());
                    let _ = list.set_int(1, id);
                    let _ = list.set_string(2, Some(&CefString::from(payload.as_str())));
                }
                _ => {
                    return_exception!(
                        "unknown op (use close, quit, backed_window_open, workspace_mutation, shell_hosted_window_state, request_compositor_sync, shell_ipc_pong, spawn, move_begin, move_delta, move_end, resize_begin, resize_delta, resize_end, resize_shell_grab_begin, resize_shell_grab_end, taskbar_activate, activate_window, shell_focus_ui_window, shell_blur_ui_window, shell_ui_grab_begin, shell_ui_grab_end, minimize, set_geometry, set_fullscreen, set_maximized, presentation_fullscreen, set_output_layout, set_shell_primary, set_ui_scale, set_tile_preview, set_chrome_metrics, set_desktop_background, sni_tray_activate, sni_tray_open_menu, sni_tray_menu_event, e2e_snapshot_response, e2e_html_response, e2e_test_window_open_response)"
                    );
                }
            }

            self.frame
                .send_process_message(ProcessId::BROWSER, Some(&mut msg));
            1
        }
    }
}

wrap_v8_handler! {
    pub struct SharedStateWriteV8Handler {
        frame: Frame,
    }

    impl V8Handler {
        fn execute(
            &self,
            _name: Option<&CefString>,
            _object: Option<&mut V8Value>,
            arguments: Option<&[Option<V8Value>]>,
            retval: Option<&mut Option<V8Value>>,
            exception: Option<&mut CefString>,
        ) -> i32 {
            macro_rules! return_exception {
                ($message:expr) => {{
                    if let Some(ex) = exception {
                        *ex = CefString::from($message);
                    }
                    return 1;
                }};
            }

            let Some(args) = arguments else {
                return_exception!("expected (path, payload, kind, abi?)");
            };
            let Some(path_v) = args.first().and_then(|a| a.as_ref()) else {
                return_exception!("expected shared state path");
            };
            if path_v.is_string() == 0 {
                return_exception!("shared state path must be a string");
            }
            let path = cef_string_userfree_to_string(&path_v.string_value());
            if path.is_empty() {
                return_exception!("shared state path must not be empty");
            }
            let Some(payload_v) = args.get(1).and_then(|a| a.as_ref()) else {
                return_exception!("expected shared state payload");
            };
            if payload_v.is_array_buffer() == 0 {
                return_exception!("shared state payload must be an ArrayBuffer");
            }
            let Some(kind_v) = args.get(2).and_then(|a| a.as_ref()) else {
                return_exception!("expected shared state kind");
            };
            let kind = if kind_v.is_uint() != 0 {
                kind_v.uint_value()
            } else if kind_v.is_int() != 0 && kind_v.int_value() >= 0 {
                kind_v.int_value() as u32
            } else if kind_v.is_double() != 0 && kind_v.double_value() >= 0.0 {
                kind_v.double_value() as u32
            } else {
                return_exception!("shared state kind must be a non-negative number");
            };
            if kind != shared_state::SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES
                && kind != shared_state::SHELL_SHARED_STATE_KIND_UI_WINDOWS
            {
                return_exception!("unknown shared state kind");
            }
            let abi = match args.get(3).and_then(|a| a.as_ref()) {
                Some(v) if v.is_uint() != 0 => v.uint_value(),
                Some(v) if v.is_int() != 0 && v.int_value() >= 0 => v.int_value() as u32,
                Some(v) if v.is_double() != 0 && v.double_value() >= 0.0 => v.double_value() as u32,
                Some(_) => return_exception!("shared state abi must be a non-negative number"),
                None => shared_state::SHELL_SHARED_STATE_ABI_VERSION,
            };
            let payload_len = payload_v.array_buffer_byte_length();
            let payload_ptr = payload_v.array_buffer_data();
            if payload_len > 0 && payload_ptr.is_null() {
                return_exception!("shared state payload pointer missing");
            }
            let payload = if payload_len == 0 {
                &[][..]
            } else {
                unsafe { std::slice::from_raw_parts(payload_ptr as *const u8, payload_len) }
            };
            if shared_state::write_payload(Path::new(&path), abi, payload).is_err() {
                if let Some(retval) = retval {
                    *retval = v8_value_create_bool(0);
                }
                return 1;
            }
            let mut msg = match process_message_create(Some(&CefString::from(PROCESS_MESSAGE_NAME))) {
                Some(m) => m,
                None => return_exception!("process_message_create failed"),
            };
            let Some(list) = msg.argument_list() else {
                return_exception!("no argument list");
            };
            let _ = list.set_string(0, Some(&CefString::from("shared_state_sync")));
            let _ = list.set_int(1, kind as i32);
            self.frame
                .send_process_message(ProcessId::BROWSER, Some(&mut msg));
            if let Some(retval) = retval {
                *retval = v8_value_create_bool(1);
            }
            1
        }
    }
}

wrap_v8_handler! {
    pub struct SharedSnapshotVersionV8Handler;

    impl V8Handler {
        fn execute(
            &self,
            _name: Option<&CefString>,
            _object: Option<&mut V8Value>,
            arguments: Option<&[Option<V8Value>]>,
            retval: Option<&mut Option<V8Value>>,
            exception: Option<&mut CefString>,
        ) -> i32 {
            macro_rules! return_exception {
                ($message:expr) => {{
                    if let Some(ex) = exception {
                        *ex = CefString::from($message);
                    }
                    return 1;
                }};
            }

            let Some(args) = arguments else {
                return_exception!("expected snapshot path");
            };
            let Some(path_v) = args.first().and_then(|a| a.as_ref()) else {
                return_exception!("expected snapshot path");
            };
            if path_v.is_string() == 0 {
                return_exception!("snapshot path must be a string");
            }
            let path = cef_string_userfree_to_string(&path_v.string_value());
            if path.is_empty() {
                return_exception!("snapshot path must not be empty");
            }
            let abi = match args.get(1).and_then(|a| a.as_ref()) {
                Some(v) if v.is_uint() != 0 => v.uint_value(),
                Some(v) if v.is_int() != 0 && v.int_value() >= 0 => v.int_value() as u32,
                Some(v) if v.is_double() != 0 && v.double_value() >= 0.0 => v.double_value() as u32,
                Some(_) => return_exception!("snapshot abi must be a non-negative number"),
                None => shell_wire::SHELL_SHARED_SNAPSHOT_ABI_VERSION,
            };
            let value = match shell_snapshot::snapshot_version(std::path::Path::new(&path), abi) {
                Ok(Some(sequence)) => v8_value_create_double(sequence as f64),
                Ok(None) => v8_value_create_null(),
                Err(_) => v8_value_create_null(),
            };
            if let Some(retval) = retval {
                *retval = value;
            }
            1
        }
    }
}

wrap_v8_handler! {
    pub struct SharedSnapshotReadV8Handler;

    impl V8Handler {
        fn execute(
            &self,
            _name: Option<&CefString>,
            _object: Option<&mut V8Value>,
            arguments: Option<&[Option<V8Value>]>,
            retval: Option<&mut Option<V8Value>>,
            exception: Option<&mut CefString>,
        ) -> i32 {
            macro_rules! return_exception {
                ($message:expr) => {{
                    if let Some(ex) = exception {
                        *ex = CefString::from($message);
                    }
                    return 1;
                }};
            }

            let Some(args) = arguments else {
                return_exception!("expected snapshot path");
            };
            let Some(path_v) = args.first().and_then(|a| a.as_ref()) else {
                return_exception!("expected snapshot path");
            };
            if path_v.is_string() == 0 {
                return_exception!("snapshot path must be a string");
            }
            let path = cef_string_userfree_to_string(&path_v.string_value());
            if path.is_empty() {
                return_exception!("snapshot path must not be empty");
            }
            let abi = match args.get(1).and_then(|a| a.as_ref()) {
                Some(v) if v.is_uint() != 0 => v.uint_value(),
                Some(v) if v.is_int() != 0 && v.int_value() >= 0 => v.int_value() as u32,
                Some(v) if v.is_double() != 0 && v.double_value() >= 0.0 => v.double_value() as u32,
                Some(_) => return_exception!("snapshot abi must be a non-negative number"),
                None => shell_wire::SHELL_SHARED_SNAPSHOT_ABI_VERSION,
            };
            let value = match shell_snapshot::snapshot_read(std::path::Path::new(&path), abi) {
                Ok(Some(bytes)) => {
                    crate::cef::begin_frame_diag::note_shell_snapshot_read();
                    v8_value_create_array_buffer_with_copy(bytes.as_ptr() as *mut u8, bytes.len())
                }
                Ok(None) => v8_value_create_null(),
                Err(_) => v8_value_create_null(),
            };
            if let Some(retval) = retval {
                *retval = value;
            }
            1
        }
    }
}

wrap_v8_handler! {
    pub struct SharedSnapshotReadIfChangedV8Handler;

    impl V8Handler {
        fn execute(
            &self,
            _name: Option<&CefString>,
            _object: Option<&mut V8Value>,
            arguments: Option<&[Option<V8Value>]>,
            retval: Option<&mut Option<V8Value>>,
            exception: Option<&mut CefString>,
        ) -> i32 {
            macro_rules! return_exception {
                ($message:expr) => {{
                    if let Some(ex) = exception {
                        *ex = CefString::from($message);
                    }
                    return 1;
                }};
            }

            let Some(args) = arguments else {
                return_exception!("expected snapshot path");
            };
            let Some(path_v) = args.first().and_then(|a| a.as_ref()) else {
                return_exception!("expected snapshot path");
            };
            if path_v.is_string() == 0 {
                return_exception!("snapshot path must be a string");
            }
            let path = cef_string_userfree_to_string(&path_v.string_value());
            if path.is_empty() {
                return_exception!("snapshot path must not be empty");
            }
            let Some(last_sequence_v) = args.get(1).and_then(|a| a.as_ref()) else {
                return_exception!("expected last snapshot sequence");
            };
            let last_sequence = if last_sequence_v.is_double() != 0 && last_sequence_v.double_value() >= 0.0 {
                last_sequence_v.double_value() as u64
            } else if last_sequence_v.is_uint() != 0 {
                u64::from(last_sequence_v.uint_value())
            } else if last_sequence_v.is_int() != 0 && last_sequence_v.int_value() >= 0 {
                last_sequence_v.int_value() as u64
            } else {
                return_exception!("last snapshot sequence must be a non-negative number");
            };
            let abi = match args.get(2).and_then(|a| a.as_ref()) {
                Some(v) if v.is_uint() != 0 => v.uint_value(),
                Some(v) if v.is_int() != 0 && v.int_value() >= 0 => v.int_value() as u32,
                Some(v) if v.is_double() != 0 && v.double_value() >= 0.0 => v.double_value() as u32,
                Some(_) => return_exception!("snapshot abi must be a non-negative number"),
                None => shell_wire::SHELL_SHARED_SNAPSHOT_ABI_VERSION,
            };
            let value = match shell_snapshot::snapshot_read_if_changed(
                std::path::Path::new(&path),
                abi,
                last_sequence,
            ) {
                Ok(Some(bytes)) => {
                    crate::cef::begin_frame_diag::note_shell_snapshot_read();
                    v8_value_create_array_buffer_with_copy(bytes.as_ptr() as *mut u8, bytes.len())
                }
                Ok(None) => v8_value_create_null(),
                Err(_) => v8_value_create_null(),
            };
            if let Some(retval) = retval {
                *retval = value;
            }
            1
        }
    }
}

wrap_render_process_handler! {
    pub struct DerpRenderProcessHandler;

    impl RenderProcessHandler {
        fn on_process_message_received(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            source_process: ProcessId,
            message: Option<&mut ProcessMessage>,
        ) -> std::os::raw::c_int {
            if source_process != ProcessId::BROWSER {
                return 0;
            }
            let Some(_msg) = message else {
                return 0;
            };
            let Some(frame) = frame else {
                return 1;
            };
            if frame.is_main() != 1 {
                return 0;
            }
            0
        }

        fn on_context_created(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            context: Option<&mut V8Context>,
        ) {
            let Some(frame) = frame else {
                return;
            };
            let Some(context) = context else {
                return;
            };
            let Some(global) = context.global() else {
                return;
            };
            let is_main = frame.is_main();
            let mut handler = ShellWireV8Handler::new(frame.clone());
            let fname = CefString::from("__derpShellWireSend");
            let mut func = v8_value_create_function(Some(&fname), Some(&mut handler));
            let shared_state_write_name = CefString::from("__derpShellSharedStateWrite");
            let mut shared_state_write_handler = SharedStateWriteV8Handler::new(frame.clone());
            let mut shared_state_write_func =
                v8_value_create_function(Some(&shared_state_write_name), Some(&mut shared_state_write_handler));
            let snapshot_version_name = CefString::from("__derpCompositorSnapshotVersion");
            let mut snapshot_version_handler = SharedSnapshotVersionV8Handler::new();
            let mut snapshot_version_func =
                v8_value_create_function(Some(&snapshot_version_name), Some(&mut snapshot_version_handler));
            let snapshot_read_name = CefString::from("__derpCompositorSnapshotRead");
            let mut snapshot_read_handler = SharedSnapshotReadV8Handler::new();
            let mut snapshot_read_func =
                v8_value_create_function(Some(&snapshot_read_name), Some(&mut snapshot_read_handler));
            let snapshot_read_if_changed_name = CefString::from("__derpCompositorSnapshotReadIfChanged");
            let mut snapshot_read_if_changed_handler = SharedSnapshotReadIfChangedV8Handler::new();
            let mut snapshot_read_if_changed_func = v8_value_create_function(
                Some(&snapshot_read_if_changed_name),
                Some(&mut snapshot_read_if_changed_handler),
            );
            let attrs = sys::cef_v8_propertyattribute_t(0);
            let _ = global.set_value_bykey(Some(&fname), func.as_mut(), attrs.into());
            let _ = global.set_value_bykey(
                Some(&shared_state_write_name),
                shared_state_write_func.as_mut(),
                attrs.into(),
            );
            let _ = global.set_value_bykey(
                Some(&snapshot_version_name),
                snapshot_version_func.as_mut(),
                attrs.into(),
            );
            let _ = global.set_value_bykey(
                Some(&snapshot_read_name),
                snapshot_read_func.as_mut(),
                attrs.into(),
            );
            let _ = global.set_value_bykey(
                Some(&snapshot_read_if_changed_name),
                snapshot_read_if_changed_func.as_mut(),
                attrs.into(),
            );
            tracing::warn!(
                target: "derp_shell_boot",
                is_main,
                frame_url = %cef_string_userfree_to_string(&frame.url()),
                "render context created"
            );
            tracing::debug!(
                target: "derp_shell_osr",
                is_main,
                "cef: __derpShellWireSend bound"
            );
        }
    }
}
