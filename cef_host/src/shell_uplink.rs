//! Renderer ↔ browser process bridge: JS calls `__derpShellWireSend(op, arg?, arg2?)` → compositor `shell_wire` on the Unix stream (no HTTP).
//!
//! After `move_delta`, optionally `BrowserHost::invalidate(VIEW)` throttled so OSR keeps up with shell chrome
//! during drag. Disable with `CEF_HOST_SHELL_DRAG_INVALIDATE=0`, or tune ms with `CEF_HOST_SHELL_DRAG_INVALIDATE_MS`
//! (default 8, clamped 1–50).

use std::{
    io::Write,
    os::unix::net::UnixStream,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use cef::{sys, *};

pub const PROCESS_MESSAGE_NAME: &str = "derp_shell_uplink";

pub(crate) fn cef_string_userfree_to_string(s: &CefStringUserfreeUtf16) -> String {
    CefStringUtf8::from(&CefStringUtf16::from(s)).to_string()
}

pub fn write_shell_packet(ipc: &Arc<Mutex<UnixStream>>, packet: &[u8]) {
    let mut g = ipc.lock().expect("compositor ipc");
    let _ = g.write_all(packet);
    let _ = g.flush();
}

static LAST_DRAG_VIEW_INVALIDATE: Mutex<Option<Instant>> = Mutex::new(None);

fn drag_invalidate_shell_view_enabled() -> bool {
    std::env::var("CEF_HOST_SHELL_DRAG_INVALIDATE").as_deref() != Ok("0")
}

fn drag_invalidate_min_interval() -> Duration {
    let ms: u64 = std::env::var("CEF_HOST_SHELL_DRAG_INVALIDATE_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8)
        .clamp(1, 50);
    Duration::from_millis(ms)
}

fn reset_drag_invalidate_throttle() {
    *LAST_DRAG_VIEW_INVALIDATE.lock().expect("LAST_DRAG_VIEW_INVALIDATE") = None;
}

fn maybe_invalidate_shell_view_after_move_delta(browser: Option<&mut Browser>) {
    if !drag_invalidate_shell_view_enabled() {
        return;
    }
    let min_gap = drag_invalidate_min_interval();
    let now = Instant::now();
    {
        let mut last = LAST_DRAG_VIEW_INVALIDATE.lock().expect("LAST_DRAG_VIEW_INVALIDATE");
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
    if !drag_invalidate_shell_view_enabled() {
        return;
    }
    reset_drag_invalidate_throttle();
    if let Some(b) = browser {
        if let Some(host) = b.host() {
            host.invalidate(PaintElementType::VIEW);
        }
    }
}

fn handle_uplink_list(
    ipc: &Arc<Mutex<UnixStream>>,
    browser: Option<&mut Browser>,
    args: &ListValue,
) {
    let op = cef_string_userfree_to_string(&args.string(0));
    match op.as_str() {
        "close" => {
            let wid = args.int(1) as u32;
            write_shell_packet(ipc, &shell_wire::encode_shell_close(wid));
        }
        "quit" => {
            write_shell_packet(ipc, &shell_wire::encode_shell_quit_compositor());
        }
        "spawn" => {
            let cmd = cef_string_userfree_to_string(&args.string(1));
            if let Some(pkt) = shell_wire::encode_spawn_wayland_client(&cmd) {
                write_shell_packet(ipc, &pkt);
            }
        }
        "move_begin" => {
            let wid = args.int(1) as u32;
            eprintln!("[derp-shell-move] cef_host uplink: move_begin window_id={wid}");
            reset_drag_invalidate_throttle();
            write_shell_packet(ipc, &shell_wire::encode_shell_move_begin(wid));
        }
        "move_delta" => {
            let dx = args.int(1) as i32;
            let dy = args.int(2) as i32;
            eprintln!("[derp-shell-move] cef_host uplink: move_delta dx={dx} dy={dy}");
            write_shell_packet(ipc, &shell_wire::encode_shell_move_delta(dx, dy));
            maybe_invalidate_shell_view_after_move_delta(browser);
        }
        "move_end" => {
            let wid = args.int(1) as u32;
            eprintln!("[derp-shell-move] cef_host uplink: move_end window_id={wid}");
            write_shell_packet(ipc, &shell_wire::encode_shell_move_end(wid));
            invalidate_shell_view_unthrottled(browser);
        }
        "taskbar_activate" => {
            let wid = args.int(1) as u32;
            write_shell_packet(ipc, &shell_wire::encode_shell_taskbar_activate(wid));
        }
        "minimize" => {
            let wid = args.int(1) as u32;
            write_shell_packet(ipc, &shell_wire::encode_shell_minimize(wid));
        }
        _ => {}
    }
}

/// Browser process: handle message from the render process.
pub fn on_browser_process_message(
    ipc: &Arc<Mutex<UnixStream>>,
    browser: Option<&mut Browser>,
    source_process: ProcessId,
    message: Option<&mut ProcessMessage>,
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
    handle_uplink_list(ipc, browser, &args);
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
                "move_begin" | "move_end" | "taskbar_activate" | "minimize" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("move_begin/move_end/taskbar_activate/minimize require window id");
                    };
                    let id = if a1.is_int() != 0 {
                        a1.int_value()
                    } else if a1.is_uint() != 0 {
                        a1.uint_value() as i32
                    } else if a1.is_double() != 0 {
                        a1.double_value() as i32
                    } else {
                        return_exception!("move_begin/move_end/taskbar_activate/minimize: second arg must be a number");
                    };
                    if id < 0 {
                        return_exception!("window id must be non-negative");
                    }
                    let _ = list.set_int(1, id);
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
                _ => {
                    return_exception!(
                        "unknown op (use close, quit, spawn, move_begin, move_delta, move_end, taskbar_activate, minimize)"
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
            eprintln!("cef_host: __derpShellWireSend bound (frame is_main={is_main})");
        }
    }
}
