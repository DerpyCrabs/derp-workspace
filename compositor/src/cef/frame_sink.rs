use std::io;
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::io::RawFd;

use libc;
use smithay::reexports::calloop::channel::Sender;

use crate::cef::compositor_tx::CefToCompositor;

pub struct DirectDmabufSink {
    dmabuf_generation: u32,
    cef_tx: Sender<CefToCompositor>,
}

impl DirectDmabufSink {
    pub fn new(cef_tx: Sender<CefToCompositor>) -> Self {
        Self {
            dmabuf_generation: 0,
            cef_tx,
        }
    }

    pub fn push_dmabuf_planes(
        &mut self,
        width: u32,
        height: u32,
        drm_format: u32,
        modifier: u64,
        flags: u32,
        planes: Vec<shell_wire::FrameDmabufPlane>,
        src_fds: Vec<RawFd>,
        dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
    ) -> io::Result<()> {
        if planes.is_empty() || planes.len() != src_fds.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "plane/fd count mismatch",
            ));
        }
        let mut owned: Vec<OwnedFd> = Vec::with_capacity(src_fds.len());
        for fd in src_fds {
            if fd < 0 {
                drop(owned);
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "negative plane fd",
                ));
            }
            let d = unsafe { libc::dup(fd) };
            if d < 0 {
                drop(owned);
                return Err(io::Error::last_os_error());
            }
            owned.push(unsafe { OwnedFd::from_raw_fd(d) });
        }
        self.dmabuf_generation = self.dmabuf_generation.wrapping_add(1);
        let generation = self.dmabuf_generation;
        self.cef_tx
            .send(CefToCompositor::Dmabuf {
                width,
                height,
                drm_format,
                modifier,
                flags,
                generation,
                planes,
                fds: owned,
                dirty_buffer,
            })
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "compositor channel closed"))
    }
}
