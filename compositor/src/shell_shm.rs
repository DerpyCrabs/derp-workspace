//! Read-only mmap of the shell pixel file created by `cef_host` ([`shell_wire::MSG_SHELL_SHM_REGION`]).

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use memmap2::Mmap;

/// Shared BGRA backing file mapped read-only (compositor side).
pub struct ShellShmMapping {
    _path: PathBuf,
    _file: File,
    map: Mmap,
    len: usize,
}

impl ShellShmMapping {
    /// Open `runtime_dir.join(basename)` and map the whole file. `basename` must be validated (no `..`, no `/`).
    pub fn open(runtime_dir: &Path, basename: &str, min_len: u64) -> io::Result<Self> {
        let path = runtime_dir.join(basename);
        if path.file_name().and_then(|s| s.to_str()) != Some(basename) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "shell shm: basename path escape",
            ));
        }
        let file = File::open(&path)?;
        let meta = file.metadata()?;
        let len = meta.len();
        if len < min_len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "shell shm: file smaller than commit",
            ));
        }
        let map = unsafe { Mmap::map(&file)? };
        let len = len as usize;
        Ok(Self {
            _path: path,
            _file: file,
            map,
            len,
        })
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }

    #[inline]
    pub fn as_slice(&self) -> &[u8] {
        &self.map[..self.len]
    }
}
