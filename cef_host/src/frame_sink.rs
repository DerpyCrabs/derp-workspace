//! Shell frames to the compositor: [`MSG_FRAME_DMABUF_COMMIT`] + SCM_RIGHTS fds.

use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use shell_wire;
#[cfg(unix)]
use libc;
#[cfg(unix)]
use std::os::unix::io::AsRawFd;
#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[cfg(unix)]
fn tune_socket(stream: &UnixStream) {
    let fd = stream.as_raw_fd();
    let sz: libc::c_int = 4 * 1024 * 1024;
    unsafe {
        let _ = libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_SNDBUF,
            &sz as *const _ as *const libc::c_void,
            std::mem::size_of_val(&sz) as libc::socklen_t,
        );
    }
}

pub struct ShellFrameSink {
    ipc: Arc<Mutex<UnixStream>>,
    #[allow(dead_code)]
    runtime_dir: PathBuf,
    dmabuf_generation: u32,
}

impl ShellFrameSink {
    pub fn new(ipc: Arc<Mutex<UnixStream>>, runtime_dir: PathBuf) -> Self {
        Self {
            ipc,
            runtime_dir,
            dmabuf_generation: 0,
        }
    }

    pub fn tune_connected_stream(stream: &UnixStream) {
        tune_socket(stream);
    }

    /// Send [`shell_wire::MSG_FRAME_DMABUF_COMMIT`] with **metadata** in `pkt` and duplicated plane fds via `SCM_RIGHTS`.
    pub fn send_dmabuf_packet_with_fds(
        &mut self,
        pkt: &[u8],
        src_fds: &[std::os::fd::RawFd],
    ) -> io::Result<()> {
        use nix::sys::socket::{sendmsg, ControlMessage, MsgFlags};
        use std::io::IoSlice;
        use std::os::fd::AsRawFd;
        if src_fds.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "dma-buf commit needs at least one fd",
            ));
        }
        let mut duped: Vec<std::os::fd::RawFd> = Vec::with_capacity(src_fds.len());
        for &fd in src_fds {
            if fd < 0 {
                for d in duped {
                    let _ = nix::unistd::close(d);
                }
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "negative plane fd",
                ));
            }
            let d = unsafe { libc::dup(fd) };
            if d < 0 {
                for x in duped {
                    let _ = nix::unistd::close(x);
                }
                return Err(io::Error::last_os_error());
            }
            duped.push(d);
        }
        let iov = [IoSlice::new(pkt)];
        let cmsgs = [ControlMessage::ScmRights(&duped)];
        let ipc = self.ipc.lock().expect("ipc");
        sendmsg::<()>(
            ipc.as_raw_fd(),
            &iov,
            &cmsgs,
            MsgFlags::empty(),
            None,
        )
        .map_err(|e| io::Error::from_raw_os_error(e as i32))?;
        for fd in duped {
            let _ = nix::unistd::close(fd);
        }
        Ok(())
    }

    /// Increment generation and build+send one dma-buf commit (fds duplicated per send).
    pub fn push_dmabuf_planes(
        &mut self,
        width: u32,
        height: u32,
        drm_format: u32,
        modifier: u64,
        flags: u32,
        planes: &[shell_wire::FrameDmabufPlane],
        src_fds: &[std::os::fd::RawFd],
    ) -> io::Result<()> {
        if planes.is_empty() || planes.len() != src_fds.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "plane/fd count mismatch",
            ));
        }
        self.dmabuf_generation = self.dmabuf_generation.wrapping_add(1);
        let Some(pkt) = shell_wire::encode_frame_dmabuf_commit(
            width,
            height,
            drm_format,
            modifier,
            flags,
            self.dmabuf_generation,
            planes,
        ) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "encode_frame_dmabuf_commit",
            ));
        };
        self.send_dmabuf_packet_with_fds(&pkt, src_fds)
    }
}
