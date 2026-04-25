use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{fence, Ordering};
use std::sync::{Mutex, OnceLock};

#[cfg(unix)]
use std::os::fd::AsRawFd;

pub const SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES: u32 = 1;
pub const SHELL_SHARED_STATE_KIND_UI_WINDOWS: u32 = 2;
pub const SHELL_SHARED_STATE_KIND_FLOATING_LAYERS: u32 = 3;
pub const SHELL_SHARED_STATE_ABI_VERSION: u32 = 2;
pub const SHELL_SHARED_STATE_HEADER_BYTES: usize = 32;

const SHELL_SHARED_STATE_MAGIC: u32 = 0x4452_5054;
const SHELL_SHARED_STATE_CAPACITY_BYTES: usize = 512 * 1024;

#[derive(Clone, Copy)]
struct SharedStateHeader {
    magic: u32,
    abi_version: u32,
    payload_len: u32,
    _flags: u32,
    sequence: u64,
}

struct SharedMmapFile {
    _file: File,
    ptr: usize,
    len: usize,
}

impl SharedMmapFile {
    #[cfg(unix)]
    fn create(path: &Path, len: usize) -> Result<Self, String> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(path)
            .map_err(|e| format!("open shared state file {}: {e}", path.display()))?;
        file.set_len(len as u64)
            .map_err(|e| format!("resize shared state file {}: {e}", path.display()))?;
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                file.as_raw_fd(),
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            return Err(format!("mmap shared state file {}", path.display()));
        }
        Ok(Self {
            _file: file,
            ptr: ptr as usize,
            len,
        })
    }

    #[cfg(not(unix))]
    fn create(path: &Path, len: usize) -> Result<Self, String> {
        let _ = (path, len);
        Err("shared state requires unix mmap".to_string())
    }

    fn as_slice_mut(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.ptr as *mut u8, self.len) }
    }
}

impl Drop for SharedMmapFile {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            let _ = libc::munmap(self.ptr as *mut libc::c_void, self.len);
        }
    }
}

#[cfg(unix)]
struct ReadOnlySharedMmapFile {
    _file: File,
    ptr: usize,
    len: usize,
}

#[cfg(unix)]
impl ReadOnlySharedMmapFile {
    fn open(path: &Path, file: File) -> Result<Self, String> {
        let len = file
            .metadata()
            .map_err(|e| format!("stat shared state file {}: {e}", path.display()))?
            .len() as usize;
        if len < SHELL_SHARED_STATE_HEADER_BYTES {
            return Err(format!("shared state file {} too small", path.display()));
        }
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ,
                libc::MAP_SHARED,
                file.as_raw_fd(),
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            return Err(format!("mmap shared state file {}", path.display()));
        }
        Ok(Self {
            _file: file,
            ptr: ptr as usize,
            len,
        })
    }

    fn as_slice(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr as *const u8, self.len) }
    }
}

#[cfg(unix)]
impl Drop for ReadOnlySharedMmapFile {
    fn drop(&mut self) {
        unsafe {
            let _ = libc::munmap(self.ptr as *mut libc::c_void, self.len);
        }
    }
}

struct SharedStateWriter {
    mmap: SharedMmapFile,
    sequence: u64,
}

impl SharedStateWriter {
    fn new(path: &Path) -> Result<Self, String> {
        let mut mmap = SharedMmapFile::create(path, SHELL_SHARED_STATE_CAPACITY_BYTES)?;
        mmap.as_slice_mut().fill(0);
        Ok(Self { mmap, sequence: 0 })
    }

    fn write_payload(&mut self, abi: u32, payload: &[u8]) -> Result<u64, String> {
        if abi != SHELL_SHARED_STATE_ABI_VERSION {
            return Err(format!("shared state abi mismatch: {abi}"));
        }
        if SHELL_SHARED_STATE_HEADER_BYTES + payload.len() > self.mmap.len {
            return Err(format!("shared state payload too large: {}", payload.len()));
        }
        let start_seq = self.sequence.wrapping_add(1) | 1;
        let end_seq = start_seq.wrapping_add(1);
        let buf = self.mmap.as_slice_mut();
        write_header(
            &mut buf[..SHELL_SHARED_STATE_HEADER_BYTES],
            abi,
            start_seq,
            0,
            0,
        )?;
        fence(Ordering::Release);
        buf[SHELL_SHARED_STATE_HEADER_BYTES..SHELL_SHARED_STATE_HEADER_BYTES + payload.len()]
            .copy_from_slice(payload);
        fence(Ordering::Release);
        write_header(
            &mut buf[..SHELL_SHARED_STATE_HEADER_BYTES],
            abi,
            end_seq,
            payload.len() as u32,
            0,
        )?;
        fence(Ordering::Release);
        self.sequence = end_seq;
        Ok(end_seq)
    }
}

fn writer_cache() -> &'static Mutex<HashMap<PathBuf, SharedStateWriter>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, SharedStateWriter>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(unix)]
fn reader_cache() -> &'static Mutex<HashMap<PathBuf, ReadOnlySharedMmapFile>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, ReadOnlySharedMmapFile>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn path_for_kind(runtime_dir: PathBuf, kind: u32) -> PathBuf {
    super::cleanup_shell_runtime_files(&runtime_dir);
    let name = match kind {
        SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES => "derp-shell-exclusion-zones-state",
        SHELL_SHARED_STATE_KIND_UI_WINDOWS => "derp-shell-ui-windows-state",
        SHELL_SHARED_STATE_KIND_FLOATING_LAYERS => "derp-shell-floating-layers-state",
        _ => "derp-shell-unknown-state",
    };
    runtime_dir.join(format!("{name}-{}.bin", std::process::id()))
}

pub fn write_payload(path: &Path, abi: u32, payload: &[u8]) -> Result<u64, String> {
    let mut cache = writer_cache()
        .lock()
        .map_err(|_| "shared state writer cache poisoned".to_string())?;
    let writer = if let Some(writer) = cache.get_mut(path) {
        writer
    } else {
        cache.insert(path.to_path_buf(), SharedStateWriter::new(path)?);
        cache
            .get_mut(path)
            .ok_or_else(|| "missing shared state writer".to_string())?
    };
    writer.write_payload(abi, payload)
}

#[cfg(unix)]
fn with_reader_mmap<T>(
    path: &Path,
    f: impl FnOnce(&[u8]) -> Result<T, String>,
) -> Result<Option<T>, String> {
    let mut cache = reader_cache()
        .lock()
        .map_err(|_| "shared state reader cache poisoned".to_string())?;
    if !cache.contains_key(path) {
        let file = match OpenOptions::new().read(true).open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("open shared state file {}: {e}", path.display())),
        };
        let mmap = ReadOnlySharedMmapFile::open(path, file)?;
        cache.insert(path.to_path_buf(), mmap);
    }
    let Some(mmap) = cache.get(path) else {
        return Ok(None);
    };
    Ok(Some(f(mmap.as_slice())?))
}

#[cfg(unix)]
fn read_payload_inner(
    mapped: &[u8],
    expected_abi: u32,
    min_sequence_exclusive: Option<u64>,
) -> Result<Option<(u64, Vec<u8>)>, String> {
    let head_a_bytes = read_header_bytes(mapped)?;
    let head_a = read_header(&head_a_bytes)?;
    if head_a.magic != SHELL_SHARED_STATE_MAGIC
        || head_a.abi_version != expected_abi
        || head_a.sequence % 2 != 0
    {
        return Ok(None);
    }
    if min_sequence_exclusive.is_some_and(|seq| head_a.sequence <= seq) {
        return Ok(None);
    }
    let payload_len = head_a.payload_len as usize;
    if SHELL_SHARED_STATE_HEADER_BYTES + payload_len > mapped.len()
        || SHELL_SHARED_STATE_HEADER_BYTES + payload_len > SHELL_SHARED_STATE_CAPACITY_BYTES
    {
        return Ok(None);
    }
    fence(Ordering::Acquire);
    let payload = mapped
        [SHELL_SHARED_STATE_HEADER_BYTES..SHELL_SHARED_STATE_HEADER_BYTES + payload_len]
        .to_vec();
    fence(Ordering::Acquire);
    let head_b_bytes = read_header_bytes(mapped)?;
    let head_b = read_header(&head_b_bytes)?;
    if head_a.sequence != head_b.sequence || head_b.sequence % 2 != 0 {
        return Ok(None);
    }
    Ok(Some((head_b.sequence, payload)))
}

#[cfg(unix)]
fn read_header_bytes(mapped: &[u8]) -> Result<[u8; SHELL_SHARED_STATE_HEADER_BYTES], String> {
    if mapped.len() < SHELL_SHARED_STATE_HEADER_BYTES {
        return Err("shared state mapping shorter than header".to_string());
    }
    let mut header = [0u8; SHELL_SHARED_STATE_HEADER_BYTES];
    header.copy_from_slice(&mapped[..SHELL_SHARED_STATE_HEADER_BYTES]);
    Ok(header)
}

pub fn read_payload(path: &Path, expected_abi: u32) -> Result<Option<Vec<u8>>, String> {
    read_payload_if_newer(path, expected_abi, None)
        .map(|payload| payload.map(|(_, payload)| payload))
}

pub fn read_payload_if_newer(
    path: &Path,
    expected_abi: u32,
    min_sequence_exclusive: Option<u64>,
) -> Result<Option<(u64, Vec<u8>)>, String> {
    #[cfg(not(unix))]
    {
        let _ = (path, expected_abi, min_sequence_exclusive);
        return Err("shared state requires unix reads".to_string());
    }
    #[cfg(unix)]
    with_reader_mmap(path, |mapped| {
        read_payload_inner(mapped, expected_abi, min_sequence_exclusive)
    })
    .map(|value| value.flatten())
}

fn write_header(
    dst: &mut [u8],
    abi: u32,
    sequence: u64,
    payload_len: u32,
    flags: u32,
) -> Result<(), String> {
    if dst.len() < SHELL_SHARED_STATE_HEADER_BYTES {
        return Err("shared state header slice too small".to_string());
    }
    dst[..SHELL_SHARED_STATE_HEADER_BYTES].fill(0);
    dst[0..4].copy_from_slice(&SHELL_SHARED_STATE_MAGIC.to_le_bytes());
    dst[4..8].copy_from_slice(&abi.to_le_bytes());
    dst[8..12].copy_from_slice(&payload_len.to_le_bytes());
    dst[12..16].copy_from_slice(&flags.to_le_bytes());
    dst[16..24].copy_from_slice(&sequence.to_le_bytes());
    Ok(())
}

fn read_header(src: &[u8]) -> Result<SharedStateHeader, String> {
    if src.len() < SHELL_SHARED_STATE_HEADER_BYTES {
        return Err("shared state header slice too small".to_string());
    }
    Ok(SharedStateHeader {
        magic: u32::from_le_bytes(src[0..4].try_into().unwrap()),
        abi_version: u32::from_le_bytes(src[4..8].try_into().unwrap()),
        payload_len: u32::from_le_bytes(src[8..12].try_into().unwrap()),
        _flags: u32::from_le_bytes(src[12..16].try_into().unwrap()),
        sequence: u64::from_le_bytes(src[16..24].try_into().unwrap()),
    })
}
