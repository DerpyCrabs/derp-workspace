use std::{
    os::fd::OwnedFd,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

pub struct PendingShellDmabuf {
    pub width: u32,
    pub height: u32,
    pub drm_format: u32,
    pub modifier: u64,
    pub flags: u32,
    pub generation: u32,
    pub planes: Vec<shell_wire::FrameDmabufPlane>,
    pub fds: Vec<OwnedFd>,
    pub dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
}

pub struct LatestShellDmabuf {
    frame: Mutex<Option<PendingShellDmabuf>>,
    notified: AtomicBool,
}

impl LatestShellDmabuf {
    pub fn new() -> Self {
        Self {
            frame: Mutex::new(None),
            notified: AtomicBool::new(false),
        }
    }

    pub fn replace(&self, frame: PendingShellDmabuf) -> bool {
        *self.frame.lock().expect("latest_shell_dmabuf") = Some(frame);
        !self.notified.swap(true, Ordering::AcqRel)
    }

    pub fn take(&self) -> Option<PendingShellDmabuf> {
        self.frame.lock().expect("latest_shell_dmabuf").take()
    }

    pub fn finish_dispatch(&self) -> bool {
        self.notified.store(false, Ordering::Release);
        if self.frame.lock().expect("latest_shell_dmabuf").is_none() {
            return false;
        }
        !self.notified.swap(true, Ordering::AcqRel)
    }
}

pub struct PendingShellSoftwareFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
    pub generation: u32,
    pub dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
}

pub struct LatestShellSoftwareFrame {
    frame: Mutex<Option<PendingShellSoftwareFrame>>,
    notified: AtomicBool,
}

impl LatestShellSoftwareFrame {
    pub fn new() -> Self {
        Self {
            frame: Mutex::new(None),
            notified: AtomicBool::new(false),
        }
    }

    pub fn replace(&self, frame: PendingShellSoftwareFrame) -> bool {
        *self.frame.lock().expect("latest_shell_software_frame") = Some(frame);
        !self.notified.swap(true, Ordering::AcqRel)
    }

    pub fn take(&self) -> Option<PendingShellSoftwareFrame> {
        self.frame
            .lock()
            .expect("latest_shell_software_frame")
            .take()
    }

    pub fn finish_dispatch(&self) -> bool {
        self.notified.store(false, Ordering::Release);
        if self
            .frame
            .lock()
            .expect("latest_shell_software_frame")
            .is_none()
        {
            return false;
        }
        !self.notified.swap(true, Ordering::AcqRel)
    }
}

pub enum CefToCompositor {
    DmabufReady(Arc<LatestShellDmabuf>),
    SoftwareFrameReady(Arc<LatestShellSoftwareFrame>),
    SetOutputVrr { name: String, enabled: bool },
    Run(Box<dyn FnOnce(&mut crate::state::CompositorState) + Send>),
}
