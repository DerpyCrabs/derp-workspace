//! Unix stream socket for [`shell_wire`] (pixel frames + optional spawn commands).

use std::{
    io::{self, Read},
    os::unix::net::UnixListener,
    path::{Path, PathBuf},
};

use smithay::reexports::calloop::{generic::Generic, EventLoop, Interest, Mode, PostAction};
use tracing::{error, warn};

use crate::CalloopData;

fn bind_shell_socket(path: &Path) -> io::Result<UnixListener> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    UnixListener::bind(path)
}

/// Register a non-blocking listener under `runtime_dir` / `socket_name`.
pub fn register_shell_ipc_listener(
    event_loop: &mut EventLoop<CalloopData>,
    runtime_dir: &Path,
    socket_name: &str,
) -> io::Result<PathBuf> {
    let path = runtime_dir.join(socket_name);
    let listener = bind_shell_socket(&path)?;
    listener.set_nonblocking(true)?;
    let listener = Generic::new(listener, Interest::READ, Mode::Level);

    event_loop
        .handle()
        .insert_source(listener, |_, listener, data| {
            loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if let Err(e) = stream.set_nonblocking(true) {
                            warn!(?e, "shell ipc: set_nonblocking");
                            continue;
                        }
                        data.state.shell_ipc_client = Some(stream);
                        data.state.shell_read_buf.clear();
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                    Err(e) => {
                        error!(?e, "shell ipc: accept");
                        break;
                    }
                }
            }
            Ok(PostAction::Continue)
        })
        .map_err(io::Error::other)?;

    Ok(path)
}

/// Read available bytes from the active shell client and apply complete frames to the shell buffer.
pub fn drain_shell_stream(state: &mut crate::state::CompositorState) {
    let Some(ref mut stream) = state.shell_ipc_client else {
        return;
    };

    let mut tmp = [0u8; 65536];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => {
                state.shell_ipc_client = None;
                state.shell_read_buf.clear();
                state.clear_shell_frame();
                break;
            }
            Ok(n) => state.shell_read_buf.extend_from_slice(&tmp[..n]),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
            Err(e) => {
                warn!(?e, "shell ipc: read");
                state.shell_ipc_client = None;
                state.shell_read_buf.clear();
                state.clear_shell_frame();
                break;
            }
        }
    }

    loop {
        match shell_wire::pop_message(&mut state.shell_read_buf) {
            Ok(Some(shell_wire::DecodedMessage::Frame {
                width,
                height,
                stride,
                format: _,
                pixels,
            })) => {
                if let Err(e) = state.apply_shell_frame_bgra(width, height, stride, &pixels) {
                    warn!(?e, "shell ipc: bad frame");
                }
            }
            Ok(Some(shell_wire::DecodedMessage::SpawnWaylandClient { command })) => {
                if let Err(e) = state.try_spawn_wayland_client_sh(&command) {
                    warn!(%e, "shell ipc: spawn");
                }
            }
            Ok(None) => break,
            Err(e) => {
                warn!(?e, "shell ipc: decode error, dropping client");
                state.shell_ipc_client = None;
                state.shell_read_buf.clear();
                state.clear_shell_frame();
                break;
            }
        }
    }
}
