//! BGRA frames to the compositor: shared-memory + small commits by default, socket bulk legacy optional.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use memmap2::{MmapMut, MmapOptions};
use shell_wire;
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

struct ShmSlot {
    #[allow(dead_code)]
    path: PathBuf,
    _file: File,
    mmap: MmapMut,
    cap: usize,
}

pub struct ShellFrameSink {
    ipc: Arc<Mutex<UnixStream>>,
    runtime_dir: PathBuf,
    shm: Option<ShmSlot>,
    encode_buf: Vec<u8>,
    frame_no: u64,
    shm_seq: u32,
}

impl ShellFrameSink {
    pub fn new(ipc: Arc<Mutex<UnixStream>>, runtime_dir: PathBuf) -> Self {
        Self {
            ipc,
            runtime_dir,
            shm: None,
            encode_buf: Vec::new(),
            frame_no: 0,
            shm_seq: 0,
        }
    }

    pub fn tune_connected_stream(stream: &UnixStream) {
        tune_socket(stream);
    }

    /// Push one full BGRA view frame. Uses shm unless `CEF_HOST_SHELL_LEGACY_FRAMES=1`.
    pub fn push_pixels(
        &mut self,
        width: u32,
        height: u32,
        stride: u32,
        pix: &[u8],
    ) -> io::Result<()> {
        if std::env::var("CEF_HOST_SHELL_LEGACY_FRAMES").as_deref() == Ok("1") {
            shell_wire::encode_frame_bgra_into(&mut self.encode_buf, width, height, stride, pix)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame encode"))?;
            let mut ipc = self.ipc.lock().expect("ipc");
            ipc.write_all(&self.encode_buf)?;
            ipc.flush()?;
            return Ok(());
        }

        let frame_bytes = (stride as usize)
            .checked_mul(height as usize)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "frame size"))?;
        if frame_bytes != pix.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "pixel slice length",
            ));
        }
        let need_cap = frame_bytes
            .checked_mul(2)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "cap overflow"))?;

        let must_recreate = self.shm.as_ref().map(|s| s.cap < need_cap).unwrap_or(true);
        if must_recreate {
            self.shm_seq = self.shm_seq.wrapping_add(1);
            let basename = format!(
                "derp-shell-shm-{}-{}.bin",
                std::process::id(),
                self.shm_seq
            );
            let path = self.runtime_dir.join(&basename);
            let file = OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .truncate(true)
                .open(&path)?;
            file.set_len(need_cap as u64)?;
            let mmap = unsafe { MmapOptions::new().len(need_cap).map_mut(&file)? };
            let region = shell_wire::encode_shell_shm_region(&basename, need_cap as u64).ok_or_else(|| {
                io::Error::new(io::ErrorKind::Other, "encode_shell_shm_region")
            })?;
            let mut ipc = self.ipc.lock().expect("ipc");
            ipc.write_all(&region)?;
            ipc.flush()?;
            drop(ipc);
            self.shm = Some(ShmSlot {
                path,
                _file: file,
                mmap,
                cap: need_cap,
            });
        }

        let slot = self.shm.as_mut().expect("shm");
        let half = frame_bytes;
        let offset = if (self.frame_no % 2) == 0 { 0 } else { half };
        slot.mmap[offset..offset + half].copy_from_slice(pix);

        let pkt = shell_wire::encode_frame_shm_commit(
            width,
            height,
            stride,
            offset as u64,
            half as u32,
        )
        .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "encode_frame_shm_commit"))?;
        let mut ipc = self.ipc.lock().expect("ipc");
        ipc.write_all(&pkt)?;
        ipc.flush()?;
        self.frame_no = self.frame_no.wrapping_add(1);
        Ok(())
    }
}
