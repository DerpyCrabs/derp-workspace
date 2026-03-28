//! Unix stream socket for [`shell_wire`] (pixel frames + optional spawn commands).
//!
//! The accepted client uses **blocking** I/O so compositor→`cef_host` writes always complete whole
//! length‑prefixed packets (non‑blocking duplex `O_NONBLOCK` was losing / interleaving pointer
//! updates). [`drain_shell_stream`] uses **`FIONREAD`** to read only queued bytes without blocking the
//! compositor tick.

use std::{
    io::{self, Read},
    os::unix::io::AsRawFd,
    os::unix::net::UnixListener,
    path::{Path, PathBuf},
};

#[cfg(unix)]
fn tune_shell_accepted_stream(stream: &std::os::unix::net::UnixStream) {
    let fd = stream.as_raw_fd();
    let sz: libc::c_int = 4 * 1024 * 1024;
    unsafe {
        let _ = libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_RCVBUF,
            &sz as *const _ as *const libc::c_void,
            std::mem::size_of_val(&sz) as libc::socklen_t,
        );
        let _ = libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_SNDBUF,
            &sz as *const _ as *const libc::c_void,
            std::mem::size_of_val(&sz) as libc::socklen_t,
        );
    }
}

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

#[cfg(unix)]
fn unix_bytes_available(stream: &std::os::unix::net::UnixStream) -> io::Result<usize> {
    let mut n: libc::c_int = 0;
    let fd = stream.as_raw_fd();
    if unsafe { libc::ioctl(fd, libc::FIONREAD, &mut n as *mut libc::c_int) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((n.max(0)) as usize)
}

fn disconnect_shell_client(state: &mut crate::state::CompositorState) {
    state.shell_disconnect_end_move_if_any();
    state.shell_ipc_client = None;
    state.shell_read_buf.clear();
    state.shell_shm = None;
    state.shell_clear_ipc_last_rx();
    state.clear_shell_frame();
}

fn dispatch_shell_message(
    state: &mut crate::state::CompositorState,
    msg: shell_wire::DecodedMessage,
) {
    state.shell_note_shell_ipc_rx();
    use shell_wire::DecodedMessage::*;
    match msg {
        ShellShmRegion {
            basename,
            total_bytes,
        } => {
            let Some(rd) = state.shell_ipc_runtime_dir.as_ref() else {
                warn!("shell ipc: shm region but no runtime dir");
                return;
            };
            state.shell_shm = None;
            match crate::shell_shm::ShellShmMapping::open(rd, &basename, total_bytes) {
                Ok(m) => {
                    tracing::debug!(%basename, total_bytes, "shell ipc: mapped shm region");
                    state.shell_shm = Some(m);
                }
                Err(e) => warn!(?e, %basename, "shell ipc: shm map failed"),
            }
        }
        FrameShmCommit {
            width,
            height,
            stride,
            offset,
            data_len,
            dirty_rects,
        } => {
            let slot = state.shell_shm.take();
            let Some(ref shm) = slot else {
                warn!("shell ipc: shm commit without region");
                return;
            };
            let o = offset as usize;
            let end = match o.checked_add(data_len as usize) {
                Some(e) => e,
                None => {
                    warn!("shell ipc: shm commit overflow");
                    state.shell_shm = slot;
                    return;
                }
            };
            if end > shm.len() {
                warn!(
                    end,
                    len = shm.len(),
                    "shell ipc: shm commit out of range"
                );
                state.shell_shm = slot;
                return;
            }
            let slice = &shm.as_slice()[o..end];
            let res =
                state.apply_shell_frame_bgra(width, height, stride, slice, dirty_rects.as_slice());
            state.shell_shm = slot;
            if let Err(e) = res {
                warn!(?e, "shell ipc: bad shm frame");
            }
        }
        Frame {
            width,
            height,
            stride,
            format: _,
            pixels,
        } => {
            if let Err(e) = state.apply_shell_frame_bgra(width, height, stride, &pixels, &[]) {
                warn!(?e, "shell ipc: bad frame");
            }
        }
        SpawnWaylandClient { command } => {
            if let Err(e) = state.try_spawn_wayland_client_sh(&command) {
                warn!(%e, "shell ipc: spawn");
            }
        }
        ShellMoveBegin { window_id } => {
            tracing::warn!(target: "derp_shell_move", window_id, "shell ipc rx: move_begin");
            state.shell_move_begin(window_id);
        }
        ShellMoveDelta { dx, dy } => {
            tracing::warn!(target: "derp_shell_move", dx, dy, "shell ipc rx: move_delta");
            state.shell_move_delta(dx, dy);
        }
        ShellMoveEnd { window_id } => {
            tracing::warn!(target: "derp_shell_move", window_id, "shell ipc rx: move_end");
            state.shell_move_end(window_id);
        }
        ShellListWindows => state.shell_reply_window_list(),
        ShellSetGeometry {
            window_id,
            x,
            y,
            width,
            height,
        } => state.shell_set_window_geometry(window_id, x, y, width, height),
        ShellClose { window_id } => state.shell_close_window(window_id),
        ShellSetFullscreen { window_id, enabled } => {
            state.shell_set_window_fullscreen(window_id, enabled);
        }
        ShellQuitCompositor => {
            state.loop_signal.stop();
            state.loop_signal.wakeup();
        }
    }
}

/// Pop and handle all complete shell→compositor messages currently in [`CompositorState::shell_read_buf`].
/// Applies only the **last** [`shell_wire::DecodedMessage::Frame`] or [`shell_wire::DecodedMessage::FrameShmCommit`]
/// in this batch (avoids redundant work when the queue bursts).
fn drain_decoded_messages(state: &mut crate::state::CompositorState) {
    let mut batch: Vec<shell_wire::DecodedMessage> = Vec::new();
    loop {
        match shell_wire::pop_message(&mut state.shell_read_buf) {
            Ok(Some(msg)) => batch.push(msg),
            Ok(None) => break,
            Err(e) => {
                warn!(?e, "shell ipc: decode error, dropping client");
                disconnect_shell_client(state);
                return;
            }
        }
    }
    if batch.is_empty() {
        return;
    }
    let last_socket_frame = batch
        .iter()
        .rposition(|m| matches!(m, shell_wire::DecodedMessage::Frame { .. }));
    let last_shm_commit = batch
        .iter()
        .rposition(|m| matches!(m, shell_wire::DecodedMessage::FrameShmCommit { .. }));
    for (i, msg) in batch.into_iter().enumerate() {
        if let Some(j) = last_socket_frame {
            if i != j && matches!(msg, shell_wire::DecodedMessage::Frame { .. }) {
                continue;
            }
        }
        if let Some(j) = last_shm_commit {
            if i != j && matches!(msg, shell_wire::DecodedMessage::FrameShmCommit { .. }) {
                continue;
            }
        }
        dispatch_shell_message(state, msg);
    }
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
                        // Blocking peer: reliable compositor→shell writes; drain uses FIONREAD.
                        #[cfg(unix)]
                        tune_shell_accepted_stream(&stream);
                        data.state.shell_ipc_client = Some(stream);
                        data.state.shell_read_buf.clear();
                        data.state.shell_shm = None;
                        data.state.shell_on_shell_client_connected();
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
#[cfg(unix)]
pub fn drain_shell_stream(state: &mut crate::state::CompositorState) {
    let t0 = std::time::Instant::now();
    let mut total_read = 0usize;
    'drain: loop {
        let avail = {
            let Some(stream) = state.shell_ipc_client.as_mut() else {
                return;
            };
            match unix_bytes_available(stream) {
                Ok(a) => a,
                Err(e) => {
                    warn!(?e, "shell ipc: FIONREAD");
                    break 'drain;
                }
            }
        };
        if avail == 0 {
            break;
        }

        let want = std::cmp::min(avail, 8 * 1024 * 1024);
        if state.shell_read_scratch.len() < want {
            state.shell_read_scratch.resize(want, 0);
        }
        let cap = std::cmp::min(want, state.shell_read_scratch.len());
        let n = {
            let Some(stream) = state.shell_ipc_client.as_mut() else {
                return;
            };
            match stream.read(&mut state.shell_read_scratch[..cap]) {
                Ok(0) => {
                    disconnect_shell_client(state);
                    return;
                }
                Ok(n) => n,
                Err(e) => {
                    warn!(?e, "shell ipc: read");
                    disconnect_shell_client(state);
                    return;
                }
            }
        };
        total_read += n;
        state
            .shell_read_buf
            .extend_from_slice(&state.shell_read_scratch[..n]);
        drain_decoded_messages(state);
        if state.shell_ipc_client.is_none() {
            return;
        }
    }
    tracing::trace!(
        target: "shell_ipc",
        bytes = total_read,
        elapsed_us = t0.elapsed().as_micros(),
        read_buf_len = state.shell_read_buf.len(),
        "drain_shell_stream"
    );
}

#[cfg(not(unix))]
pub fn drain_shell_stream(_state: &mut crate::state::CompositorState) {}

#[cfg(all(test, unix))]
#[test]
fn fionread_zero_when_receive_queue_empty() {
    let (_a, b) = std::os::unix::net::UnixStream::pair().unwrap();
    assert_eq!(unix_bytes_available(&b).unwrap(), 0);
}

#[cfg(all(test, unix))]
#[test]
fn fionread_matches_queued_byte_count() {
    use std::io::Write;
    let (mut a, mut b) = std::os::unix::net::UnixStream::pair().unwrap();
    assert_eq!(unix_bytes_available(&b).unwrap(), 0);
    a.write_all(&[0u8; 123]).unwrap();
    assert_eq!(unix_bytes_available(&b).unwrap(), 123);
    let mut got = [0u8; 123];
    b.read_exact(&mut got).unwrap();
    assert_eq!(unix_bytes_available(&b).unwrap(), 0);
}
