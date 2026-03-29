//! `recvmsg(2)` on the shell Unix stream to pick up [`SCM_RIGHTS`] fds paired with wire payloads.

#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[cfg(unix)]
use nix::errno::Errno;
#[cfg(unix)]
use nix::sys::socket::{recvmsg, ControlMessageOwned, MsgFlags};
#[cfg(unix)]
use std::io::{self, IoSliceMut};

/// Non-blocking recv: returns bytes read into `buf` and any passed fds.
/// On `EAGAIN` / `EWOULDBLOCK`, returns `Ok((0, vec![]))`.
#[cfg(unix)]
pub fn recv_stream_with_fds(
    stream: &UnixStream,
    buf: &mut [u8],
) -> io::Result<(usize, Vec<OwnedFd>)> {
    let mut iov = [IoSliceMut::new(buf)];
    let mut cmsg = nix::cmsg_space!([std::os::fd::RawFd; 4]);
    let msg = match recvmsg::<()>(
        stream.as_raw_fd(),
        &mut iov,
        Some(&mut cmsg),
        MsgFlags::MSG_DONTWAIT | MsgFlags::MSG_CMSG_CLOEXEC,
    ) {
        Ok(m) => m,
        Err(Errno::EAGAIN) => {
            return Err(io::Error::from(io::ErrorKind::WouldBlock));
        }
        Err(e) => return Err(io::Error::from_raw_os_error(e as i32)),
    };

    let mut fds = Vec::new();
    if let Ok(iter) = msg.cmsgs() {
        for c in iter {
            if let ControlMessageOwned::ScmRights(r) = c {
                for raw in r {
                    if raw >= 0 {
                        fds.push(unsafe { OwnedFd::from_raw_fd(raw) });
                    }
                }
            }
        }
    }

    if msg
        .flags
        .intersects(MsgFlags::MSG_CTRUNC | MsgFlags::MSG_TRUNC)
    {
        tracing::warn!(
            target: "shell_ipc",
            "recvmsg: truncated (MSG_CTRUNC/MSG_TRUNC); dma-buf shell frame may be corrupt"
        );
    }

    Ok((msg.bytes, fds))
}
