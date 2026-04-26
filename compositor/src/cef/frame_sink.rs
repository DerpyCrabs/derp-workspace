use std::io;
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::io::RawFd;

use libc;
use std::sync::Arc;

use smithay::reexports::calloop::channel::Sender;

use crate::cef::compositor_tx::{
    CefToCompositor, LatestShellDmabuf, LatestShellSoftwareFrame, PendingShellDmabuf,
    PendingShellSoftwareFrame,
};

pub struct DirectDmabufSink {
    dmabuf_generation: u32,
    software_generation: u32,
    cef_tx: Sender<CefToCompositor>,
    latest_dmabuf: Arc<LatestShellDmabuf>,
    latest_software: Arc<LatestShellSoftwareFrame>,
}

impl DirectDmabufSink {
    pub fn new(
        cef_tx: Sender<CefToCompositor>,
        latest_dmabuf: Arc<LatestShellDmabuf>,
        latest_software: Arc<LatestShellSoftwareFrame>,
    ) -> Self {
        Self {
            dmabuf_generation: 0,
            software_generation: 0,
            cef_tx,
            latest_dmabuf,
            latest_software,
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
            let d = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
            if d < 0 {
                drop(owned);
                return Err(io::Error::last_os_error());
            }
            owned.push(unsafe { OwnedFd::from_raw_fd(d) });
        }
        self.dmabuf_generation = self.dmabuf_generation.wrapping_add(1);
        let generation = self.dmabuf_generation;
        let should_notify = self.latest_dmabuf.replace(PendingShellDmabuf {
            width,
            height,
            drm_format,
            modifier,
            flags,
            generation,
            planes,
            fds: owned,
            dirty_buffer,
        });
        if !should_notify {
            return Ok(());
        }
        self.cef_tx
            .send(CefToCompositor::DmabufReady(self.latest_dmabuf.clone()))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "compositor channel closed"))
    }

    pub fn push_software_frame(
        &mut self,
        width: u32,
        height: u32,
        pixels: &[u8],
        dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
    ) -> io::Result<()> {
        let byte_len = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "software frame too large")
            })?;
        if pixels.len() < byte_len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "software frame buffer too small",
            ));
        }
        self.software_generation = self.software_generation.wrapping_add(1);
        let generation = self.software_generation;
        let should_notify = self.latest_software.replace(PendingShellSoftwareFrame {
            width,
            height,
            pixels: pixels[..byte_len].to_vec(),
            generation,
            dirty_buffer,
        });
        if !should_notify {
            return Ok(());
        }
        self.cef_tx
            .send(CefToCompositor::SoftwareFrameReady(
                self.latest_software.clone(),
            ))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "compositor channel closed"))
    }
}
