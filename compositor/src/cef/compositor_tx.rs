use std::os::fd::OwnedFd;

pub enum CefToCompositor {
    ShellRxNote,
    Dmabuf {
        width: u32,
        height: u32,
        drm_format: u32,
        modifier: u64,
        flags: u32,
        generation: u32,
        planes: Vec<shell_wire::FrameDmabufPlane>,
        fds: Vec<OwnedFd>,
    },
    Run(Box<dyn FnOnce(&mut crate::state::CompositorState) + Send>),
}
