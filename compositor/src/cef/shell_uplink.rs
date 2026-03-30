use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cef::{sys, *};

use crate::cef::osr_view_state::OsrViewState;
use crate::cef::uplink::UplinkToCompositor;

pub const PROCESS_MESSAGE_NAME: &str = "derp_shell_uplink";

pub(crate) fn cef_string_userfree_to_string(s: &CefStringUserfreeUtf16) -> String {
    CefStringUtf8::from(&CefStringUtf16::from(s)).to_string()
}

static LAST_DRAG_VIEW_INVALIDATE: Mutex<Option<Instant>> = Mutex::new(None);

fn drag_invalidate_min_interval() -> Duration {
    Duration::from_millis(8)
}

fn reset_drag_invalidate_throttle() {
    *LAST_DRAG_VIEW_INVALIDATE
        .lock()
        .expect("LAST_DRAG_VIEW_INVALIDATE") = None;
}

fn maybe_invalidate_shell_view_after_move_delta(browser: Option<&mut Browser>) {
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
            host.invalidate(PaintElementType::VIEW);
        }
    }
}

fn invalidate_shell_view_unthrottled(browser: Option<&mut Browser>) {
    reset_drag_invalidate_throttle();
    if let Some(b) = browser {
        if let Some(host) = b.host() {
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
            maybe_invalidate_shell_view_after_move_delta(browser);
        }
        "move_end" => {
            let wid = args.int(1) as u32;
            tracing::debug!(target: "derp_shell_move", wid, "cef uplink: move_end");
            uplink.shell_move_end(wid);
            invalidate_shell_view_unthrottled(browser);
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
            maybe_invalidate_shell_view_after_move_delta(browser);
        }
        "resize_end" => {
            let wid = args.int(1) as u32;
            tracing::debug!(target: "derp_shell_resize", wid, "cef uplink: resize_end");
            uplink.shell_resize_end(wid);
            invalidate_shell_view_unthrottled(browser);
        }
        "taskbar_activate" => {
            let wid = args.int(1) as u32;
            uplink.shell_taskbar_activate(wid);
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
        "set_ui_scale" => {
            let pct = args.int(1);
            let scale = match pct {
                100 => 1.0,
                150 => 1.5,
                _ => return,
            };
            uplink.shell_set_ui_scale(scale);
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
                "move_begin" | "move_end" | "taskbar_activate" | "minimize" | "resize_end" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("move_begin/move_end/resize_end/taskbar_activate/minimize require window id");
                    };
                    let id = if a1.is_int() != 0 {
                        a1.int_value()
                    } else if a1.is_uint() != 0 {
                        a1.uint_value() as i32
                    } else if a1.is_double() != 0 {
                        a1.double_value() as i32
                    } else {
                        return_exception!("move_begin/move_end/resize_end/taskbar_activate/minimize: second arg must be a number");
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
                "set_ui_scale" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("set_ui_scale requires percent (100 or 150)");
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
                    if pct != 100 && pct != 150 {
                        return_exception!("set_ui_scale: percent must be 100 or 150");
                    }
                    let _ = list.set_int(1, pct);
                }
                _ => {
                    return_exception!(
                        "unknown op (use close, quit, spawn, move_begin, move_delta, move_end, resize_begin, resize_delta, resize_end, taskbar_activate, minimize, set_geometry, set_fullscreen, set_maximized, presentation_fullscreen, set_output_layout, set_ui_scale)"
                    );
                }
            }

            self.frame
                .send_process_message(ProcessId::BROWSER, Some(&mut msg));
            0
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
            let attrs = sys::cef_v8_propertyattribute_t(0);
            let _ = global.set_value_bykey(Some(&fname), func.as_mut(), attrs.into());
            tracing::debug!(
                target: "derp_shell_osr",
                is_main,
                "cef: __derpShellWireSend bound"
            );
        }
    }
}
