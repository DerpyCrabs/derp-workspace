//! Renderer ↔ browser process bridge: JS calls `__derpShellWireSend(op, arg?, arg2?)` → compositor `shell_wire` on the Unix stream (no HTTP).

use std::{
    io::Write,
    os::unix::net::UnixStream,
    sync::{Arc, Mutex},
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

fn handle_uplink_list(ipc: &Arc<Mutex<UnixStream>>, args: &ListValue) {
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
            write_shell_packet(ipc, &shell_wire::encode_shell_move_begin(wid));
        }
        "move_delta" => {
            let dx = args.int(1) as i32;
            let dy = args.int(2) as i32;
            write_shell_packet(ipc, &shell_wire::encode_shell_move_delta(dx, dy));
        }
        "move_end" => {
            let wid = args.int(1) as u32;
            write_shell_packet(ipc, &shell_wire::encode_shell_move_end(wid));
        }
        _ => {}
    }
}

/// Browser process: handle message from the render process.
pub fn on_browser_process_message(
    ipc: &Arc<Mutex<UnixStream>>,
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
    handle_uplink_list(ipc, &args);
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
                "move_begin" | "move_end" => {
                    let Some(a1) = args.get(1).and_then(|a| a.as_ref()) else {
                        return_exception!("move_begin/move_end require window id");
                    };
                    let id = if a1.is_int() != 0 {
                        a1.int_value()
                    } else if a1.is_uint() != 0 {
                        a1.uint_value() as i32
                    } else if a1.is_double() != 0 {
                        a1.double_value() as i32
                    } else {
                        return_exception!("move_begin/move_end: second arg must be a number");
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
                        "unknown op (use close, quit, spawn, move_begin, move_delta, move_end)"
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
            if frame.is_main() != 1 {
                return;
            }
            let Some(context) = context else {
                return;
            };
            let Some(global) = context.global() else {
                return;
            };
            let frame = frame.clone();
            let mut handler = ShellWireV8Handler::new(frame);
            let fname = CefString::from("__derpShellWireSend");
            let mut func = v8_value_create_function(Some(&fname), Some(&mut handler));
            let attrs = sys::cef_v8_propertyattribute_t(0);
            let _ = global.set_value_bykey(Some(&fname), func.as_mut(), attrs.into());
        }
    }
}
