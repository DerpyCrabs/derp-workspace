//! Shell ↔ compositor transport: Unix stream (legacy `cef_host` process) or in-process channel (DerpWorkspace merged binary).
//!
//! The accepted Unix client uses **blocking** I/O so compositor→`cef_host` writes complete whole
//! length‑prefixed packets. [`drain_shell_stream`] uses **`FIONREAD`** to read only queued bytes without blocking the
//! compositor tick.

use std::{
    io,
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
use tracing::{error, info, warn};

use crate::CalloopData;

/// One-shot `derp_shell_osr` INFO after the first accepted dma-buf shell frame.
static SOLID_SHELL_FIRST_DMABUF_LOG: std::sync::Once = std::sync::Once::new();

/// Duplex path to the CEF / shell side (OSR ingress + chrome commands).
pub enum ShellIpcConn {
    Disconnected,
    Unix(std::os::unix::net::UnixStream),
    Embedded {
        to_peer: std::sync::mpsc::Sender<Vec<u8>>,
        from_peer: std::sync::mpsc::Receiver<Vec<u8>>,
    },
}

impl ShellIpcConn {
    pub fn is_disconnected(&self) -> bool {
        matches!(self, Self::Disconnected)
    }
}

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

pub(crate) fn disconnect_shell_client(state: &mut crate::state::CompositorState) {
    state.shell_disconnect_end_move_if_any();
    state.shell_ipc_conn = ShellIpcConn::Disconnected;
    state.shell_read_buf.clear();
    state.shell_ipc_pending_fds.clear();
    state.shell_clear_ipc_last_rx();
    state.shell_ipc_last_compositor_ping = None;
    state.clear_shell_frame();
}

fn dispatch_frame_dmabuf_commit(
    state: &mut crate::state::CompositorState,
    width: u32,
    height: u32,
    drm_format: u32,
    modifier: u64,
    flags: u32,
    generation: u32,
    planes: Vec<shell_wire::FrameDmabufPlane>,
    apply: bool,
) {
    let _ = generation;
    state.shell_note_shell_ipc_rx();
    if matches!(state.shell_ipc_conn, ShellIpcConn::Embedded { .. }) {
        warn!(
            target: "shell_ipc",
            "dma-buf shell frame over embedded IPC is unsupported (no FD passing); ignoring"
        );
        return;
    }
    let n = planes.len();
    if n == 0 {
        return;
    }
    if n > shell_wire::MAX_DMABUF_PLANES as usize {
        warn!(n, "shell ipc: dma-buf plane count invalid");
        state.shell_ipc_pending_fds.clear();
        return;
    }
    if state.shell_ipc_pending_fds.len() < n {
        warn!(
            have = state.shell_ipc_pending_fds.len(),
            need = n,
            "shell ipc: dma-buf commit missing fds"
        );
        state.shell_ipc_pending_fds.clear();
        return;
    }
    let mut fds: Vec<std::os::fd::OwnedFd> = state.shell_ipc_pending_fds.drain(..n).collect();
    if !apply {
        return;
    }
    match state.apply_shell_frame_dmabuf(
        width,
        height,
        drm_format,
        modifier,
        flags,
        &planes,
        &mut fds,
    ) {
        Ok(()) => {
            SOLID_SHELL_FIRST_DMABUF_LOG.call_once(|| {
                info!(
                    target: "derp_shell_osr",
                    width,
                    height,
                    drm_format,
                    modifier,
                    plane_count = planes.len(),
                    "solid shell OSR: dma-buf path active (first frame accepted)"
                );
            });
        }
        Err(e) => warn!(?e, "shell ipc: dma-buf frame rejected"),
    }
}

fn dispatch_shell_message(
    state: &mut crate::state::CompositorState,
    msg: shell_wire::DecodedMessage,
) {
    state.shell_note_shell_ipc_rx();
    use shell_wire::DecodedMessage::*;
    match msg {
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
            tracing::trace!(target: "derp_shell_move", dx, dy, "shell ipc rx: move_delta");
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
        ShellPong => {}
        // `drain_decoded_messages` peels this off first; kept so the match stays exhaustive.
        FrameDmabufCommit { .. } => {}
    }
}

/// Pop and handle all complete shell→compositor messages currently in [`CompositorState::shell_read_buf`].
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
    let last_dmabuf = batch
        .iter()
        .rposition(|m| matches!(m, shell_wire::DecodedMessage::FrameDmabufCommit { .. }));
    for (i, msg) in batch.into_iter().enumerate() {
        if let shell_wire::DecodedMessage::FrameDmabufCommit {
            width,
            height,
            drm_format,
            modifier,
            flags,
            generation,
            planes,
        } = msg
        {
            let apply = last_dmabuf == Some(i);
            dispatch_frame_dmabuf_commit(
                state,
                width,
                height,
                drm_format,
                modifier,
                flags,
                generation,
                planes,
                apply,
            );
            continue;
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
                        #[cfg(unix)]
                        tune_shell_accepted_stream(&stream);
                        data.state.shell_ipc_conn = ShellIpcConn::Unix(stream);
                        data.state.shell_read_buf.clear();
                        data.state.shell_ipc_pending_fds.clear();
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

/// Feed embedded channel payloads into the decode path (one [`Vec`] per length-prefixed wire packet).
fn drain_embedded_channel(state: &mut crate::state::CompositorState) {
    loop {
        let packet = match &mut state.shell_ipc_conn {
            ShellIpcConn::Embedded { from_peer, .. } => match from_peer.try_recv() {
                Ok(p) => p,
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    tracing::warn!("shell ipc: embedded peer disconnected (rx)");
                    disconnect_shell_client(state);
                    return;
                }
            },
            _ => return,
        };
        state.shell_read_buf.extend_from_slice(&packet);
        drain_decoded_messages(state);
        if state.shell_ipc_conn.is_disconnected() {
            return;
        }
    }
}

/// Read available bytes from the active shell Unix peer and apply complete frames.
#[cfg(unix)]
pub fn drain_shell_stream(state: &mut crate::state::CompositorState) {
    match &mut state.shell_ipc_conn {
        ShellIpcConn::Embedded { .. } => {
            drain_embedded_channel(state);
        }
        ShellIpcConn::Disconnected => {}
        ShellIpcConn::Unix(_) => drain_shell_unix_stream(state),
    }
}

#[cfg(unix)]
fn drain_shell_unix_stream(state: &mut crate::state::CompositorState) {
    let t0 = std::time::Instant::now();
    let mut total_read = 0usize;
    'drain: loop {
        let avail = match &mut state.shell_ipc_conn {
            ShellIpcConn::Unix(stream) => match unix_bytes_available(stream) {
                Ok(a) => a,
                Err(e) => {
                    warn!(?e, "shell ipc: FIONREAD");
                    break 'drain;
                }
            },
            _ => return,
        };
        if avail == 0 {
            break;
        }

        let want = std::cmp::min(avail, 8 * 1024 * 1024);
        if state.shell_read_scratch.len() < want {
            state.shell_read_scratch.resize(want, 0);
        }
        let cap = std::cmp::min(want, state.shell_read_scratch.len());
        let n = match &mut state.shell_ipc_conn {
            ShellIpcConn::Unix(stream) => {
                match crate::shell_unix_msg::recv_stream_with_fds(stream, &mut state.shell_read_scratch[..cap])
                {
                    Ok((0, fds)) if fds.is_empty() => {
                        disconnect_shell_client(state);
                        return;
                    }
                    Ok((0, fds)) => {
                        state.shell_ipc_pending_fds.extend(fds);
                        break 'drain;
                    }
                    Ok((n, fds)) => {
                        state.shell_ipc_pending_fds.extend(fds);
                        n
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        break 'drain;
                    }
                    Err(e) => {
                        warn!(?e, "shell ipc: recvmsg");
                        disconnect_shell_client(state);
                        return;
                    }
                }
            }
            _ => return,
        };
        total_read += n;
        state
            .shell_read_buf
            .extend_from_slice(&state.shell_read_scratch[..n]);
        drain_decoded_messages(state);
        if state.shell_ipc_conn.is_disconnected() {
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

#[allow(dead_code)]
pub fn run_post_drain_hooks(state: &mut crate::state::CompositorState) {
    if let Some(hook) = state.shell_post_drain_hook.as_mut() {
        hook();
    }
}

#[cfg(all(test, unix))]
#[test]
fn fionread_zero_when_receive_queue_empty() {
    let (_a, b) = std::os::unix::net::UnixStream::pair().unwrap();
    assert_eq!(unix_bytes_available(&b).unwrap(), 0);
}

#[cfg(all(test, unix))]
#[test]
fn fionread_matches_queued_byte_count() {
    use std::io::{Read, Write};
    let (mut a, mut b) = std::os::unix::net::UnixStream::pair().unwrap();
    assert_eq!(unix_bytes_available(&b).unwrap(), 0);
    a.write_all(&[0u8; 123]).unwrap();
    assert_eq!(unix_bytes_available(&b).unwrap(), 123);
    let mut got = [0u8; 123];
    b.read_exact(&mut got).unwrap();
    assert_eq!(unix_bytes_available(&b).unwrap(), 0);
}

/// [`MSG_FRAME_DMABUF_COMMIT`] bytes + [`SCM_RIGHTS`] must arrive in one `recvmsg`, matching `cef_host` + [`crate::shell_unix_msg::recv_stream_with_fds`].
#[cfg(all(test, unix))]
#[test]
fn dmabuf_wire_payload_arrives_with_fds_in_one_recvmsg() {
    use nix::sys::socket::{sendmsg, ControlMessage, MsgFlags};
    use std::fs::File;
    use std::io::IoSlice;
    use std::os::fd::AsRawFd;

    let (tx, rx) = std::os::unix::net::UnixStream::pair().unwrap();
    rx.set_nonblocking(true).unwrap();

    let file = File::open("/dev/null").unwrap();
    let planes = [shell_wire::FrameDmabufPlane {
        plane_idx: 0,
        stride: 256,
        offset: 0,
    }];
    let pkt = shell_wire::encode_frame_dmabuf_commit(64, 64, 0x34324241, 0, 0, 7, &planes).unwrap();
    let fds = [file.as_raw_fd()];
    let iov = [IoSlice::new(pkt.as_slice())];
    let cmsgs = [ControlMessage::ScmRights(&fds)];
    sendmsg::<()>(tx.as_raw_fd(), &iov, &cmsgs, MsgFlags::empty(), None).unwrap();
    drop(tx);

    let mut scratch = vec![0u8; 4096];
    let (n, received) = crate::shell_unix_msg::recv_stream_with_fds(&rx, &mut scratch).unwrap();
    assert_eq!(n, pkt.len());
    assert_eq!(&scratch[..n], pkt.as_slice());
    assert_eq!(received.len(), 1);

    let mut buf: Vec<u8> = scratch[..n].to_vec();
    match shell_wire::pop_message(&mut buf).unwrap() {
        Some(shell_wire::DecodedMessage::FrameDmabufCommit {
            width,
            height,
            drm_format,
            modifier,
            flags,
            generation,
            planes: pl,
        }) => {
            assert_eq!((width, height), (64, 64));
            assert_eq!(drm_format, 0x34324241);
            assert_eq!(modifier, 0);
            assert_eq!(flags, 0);
            assert_eq!(generation, 7);
            assert_eq!(pl, planes);
        }
        o => panic!("expected FrameDmabufCommit: {o:?}"),
    }
    assert!(buf.is_empty());
}
