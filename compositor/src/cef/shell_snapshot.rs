use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{fence, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use crate::cef::shell_snapshot_model::{
    snapshot_dirty_domains, snapshot_domain_for_message, ShellSnapshotModel,
};
use crate::session::workspace_model::{
    WorkspaceMonitorLayoutType, WorkspaceSlotRuleField, WorkspaceSlotRuleOp, WorkspaceState,
};

#[cfg(unix)]
use std::os::fd::AsRawFd;

const SNAPSHOT_CAPACITY_BYTES: usize = 16 * 1024 * 1024;
const SNAPSHOT_DOMAIN_CHUNKS_MAGIC: u32 = 0x4452_444d;
const SNAPSHOT_DELTA_CHUNK_FLAG: u32 = 0x8000_0000;

pub enum SnapshotDirtyRead {
    Unchanged,
    Dirty { bytes: Vec<u8>, payload_len: usize },
    Fallback { bytes: Vec<u8>, payload_len: usize },
}

enum SnapshotReadResult {
    Unchanged,
    Changed {
        bytes: Vec<u8>,
        payload_len: usize,
        filtered: bool,
    },
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
            .map_err(|e| format!("open snapshot file {}: {e}", path.display()))?;
        file.set_len(len as u64)
            .map_err(|e| format!("resize snapshot file {}: {e}", path.display()))?;
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
            return Err(format!("mmap snapshot file {}", path.display()));
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
        Err("shared snapshots require unix mmap".to_string())
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

struct ReadOnlyMmapFile {
    _file: File,
    ptr: usize,
    len: usize,
}

impl ReadOnlyMmapFile {
    #[cfg(unix)]
    fn open(path: &Path) -> Result<Self, String> {
        let file = open_snapshot_file(path)?;
        let len = file
            .metadata()
            .map_err(|e| format!("stat snapshot file {}: {e}", path.display()))?
            .len() as usize;
        if len == 0 {
            return Err(format!("snapshot file {} is empty", path.display()));
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
            return Err(format!("mmap snapshot file {}", path.display()));
        }
        Ok(Self {
            _file: file,
            ptr: ptr as usize,
            len,
        })
    }

    #[cfg(not(unix))]
    fn open(path: &Path) -> Result<Self, String> {
        let _ = path;
        Err("shared snapshots require unix mmap".to_string())
    }

    fn as_slice(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr as *const u8, self.len) }
    }
}

impl Drop for ReadOnlyMmapFile {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            let _ = libc::munmap(self.ptr as *mut libc::c_void, self.len);
        }
    }
}

#[derive(Default)]
struct SnapshotReadCache {
    path: Option<PathBuf>,
    mmap: Option<ReadOnlyMmapFile>,
}

impl SnapshotReadCache {
    fn mapped_slice<'a>(&'a mut self, path: &Path) -> Result<&'a [u8], String> {
        let reuse = self.path.as_deref() == Some(path) && self.mmap.is_some();
        if !reuse {
            self.path = Some(path.to_path_buf());
            self.mmap = Some(ReadOnlyMmapFile::open(path)?);
        }
        Ok(self
            .mmap
            .as_ref()
            .ok_or_else(|| format!("snapshot cache unavailable {}", path.display()))?
            .as_slice())
    }
}

fn snapshot_read_cache() -> &'static Mutex<SnapshotReadCache> {
    static CACHE: OnceLock<Mutex<SnapshotReadCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(SnapshotReadCache::default()))
}

fn mapped_snapshot_header(
    mapped: &[u8],
) -> Result<[u8; shell_wire::SHELL_SHARED_SNAPSHOT_HEADER_BYTES as usize], String> {
    let header_len = shell_wire::SHELL_SHARED_SNAPSHOT_HEADER_BYTES as usize;
    if mapped.len() < header_len {
        return Err("snapshot mapping shorter than header".to_string());
    }
    let mut header = [0u8; shell_wire::SHELL_SHARED_SNAPSHOT_HEADER_BYTES as usize];
    header.copy_from_slice(&mapped[..header_len]);
    Ok(header)
}

#[cfg(unix)]
fn open_snapshot_file(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|e| format!("open snapshot file {}: {e}", path.display()))
}

pub struct SharedShellSnapshotWriter {
    path: PathBuf,
    mmap: SharedMmapFile,
    sequence: u64,
    last_payload: Option<Vec<u8>>,
    domain_revisions: [u64; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT],
    domain_chunks: [Vec<u8>; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT],
    domain_delta_chunks: [Vec<u8>; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT],
    domain_chunks_initialized: bool,
    authoritative: ShellSnapshotModel,
}

impl SharedShellSnapshotWriter {
    pub fn new(runtime_dir: PathBuf) -> Result<Self, String> {
        super::cleanup_shell_runtime_files(&runtime_dir);
        let path = runtime_dir.join(format!("derp-shell-snapshot-{}.bin", std::process::id()));
        let mut mmap = SharedMmapFile::create(&path, SNAPSHOT_CAPACITY_BYTES)?;
        mmap.as_slice_mut().fill(0);
        let mut this = Self {
            path,
            mmap,
            sequence: 0,
            last_payload: None,
            domain_revisions: [0; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT],
            domain_chunks: std::array::from_fn(|_| Vec::new()),
            domain_delta_chunks: std::array::from_fn(|_| Vec::new()),
            domain_chunks_initialized: false,
            authoritative: ShellSnapshotModel::default(),
        };
        this.publish_payload_at(0, 0, Vec::new())?;
        Ok(this)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn publish_messages(
        &mut self,
        sequence: u64,
        messages: &[shell_wire::DecodedCompositorToShellMessage],
    ) -> Result<bool, String> {
        let encode_start = Instant::now();
        let dirty_domains = snapshot_dirty_domains(messages);
        for message in messages {
            self.authoritative.apply(message);
        }
        let refresh_domains = if self.domain_chunks_initialized {
            dirty_domains
        } else {
            (1u32 << shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT) - 1
        };
        let authoritative_messages = self.authoritative.messages_for_domains(refresh_domains);
        if !self.domain_chunks_initialized {
            warn_snapshot_invariants(&authoritative_messages);
        }
        let actual_dirty_domains = refresh_domain_chunk_cache(
            &mut self.domain_chunks,
            dirty_domains,
            &authoritative_messages,
            !self.domain_chunks_initialized,
        )?;
        refresh_delta_chunk_cache(
            &mut self.domain_delta_chunks,
            actual_dirty_domains,
            messages,
        )?;
        self.bump_domain_revisions(actual_dirty_domains);
        self.domain_chunks_initialized = true;
        let published = self.publish_payload_at(
            sequence,
            actual_dirty_domains,
            encode_payload_chunks(
                &self.domain_revisions,
                &self.domain_chunks,
                &self.domain_delta_chunks,
            )?,
        );
        crate::cef::begin_frame_diag::note_shell_snapshot_encode(
            encode_start.elapsed(),
            authoritative_messages.len(),
        );
        published
    }

    fn bump_domain_revisions(&mut self, dirty_domains: u32) {
        for (index, revision) in self.domain_revisions.iter_mut().enumerate() {
            let bit = 1u32 << index;
            if dirty_domains & bit != 0 {
                *revision = revision.wrapping_add(1).max(1);
            }
        }
    }

    fn publish_payload_at(
        &mut self,
        sequence: u64,
        flags: u32,
        payload: Vec<u8>,
    ) -> Result<bool, String> {
        if self.last_payload.as_deref() == Some(payload.as_slice()) {
            return Ok(false);
        }
        let header_len = shell_wire::SHELL_SHARED_SNAPSHOT_HEADER_BYTES as usize;
        if payload.len() + header_len > self.mmap.len {
            return Err(format!("snapshot payload too large: {}", payload.len()));
        }
        let end_seq = if sequence == 0 {
            if !payload.is_empty() {
                return Err("snapshot sequence missing for non-empty payload".to_string());
            }
            0
        } else {
            if sequence % 2 != 0 {
                return Err(format!("snapshot sequence must be even: {sequence}"));
            }
            if sequence <= self.sequence {
                return Err(format!(
                    "snapshot sequence must advance: current={} next={sequence}",
                    self.sequence
                ));
            }
            sequence
        };
        let start_seq = if end_seq == 0 { 1 } else { end_seq - 1 };
        let buf = self.mmap.as_slice_mut();
        shell_wire::write_shared_snapshot_header(&mut buf[..header_len], start_seq, 0, flags)?;
        fence(Ordering::Release);
        buf[header_len..header_len + payload.len()].copy_from_slice(&payload);
        fence(Ordering::Release);
        shell_wire::write_shared_snapshot_header(
            &mut buf[..header_len],
            end_seq,
            payload.len() as u32,
            flags,
        )?;
        fence(Ordering::Release);
        self.sequence = end_seq;
        self.last_payload = Some(payload);
        Ok(true)
    }
}

fn encode_payload_chunks(
    domain_revisions: &[u64; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT],
    domain_chunks: &[Vec<u8>; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT],
    domain_delta_chunks: &[Vec<u8>; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT],
) -> Result<Vec<u8>, String> {
    let mut payload = Vec::new();
    for revision in domain_revisions {
        payload.extend_from_slice(&revision.to_le_bytes());
    }
    let chunks_len = domain_chunks
        .iter()
        .filter(|chunk| !chunk.is_empty())
        .count()
        + domain_delta_chunks
            .iter()
            .filter(|chunk| !chunk.is_empty())
            .count();
    payload.extend_from_slice(&SNAPSHOT_DOMAIN_CHUNKS_MAGIC.to_le_bytes());
    payload.extend_from_slice(
        &u32::try_from(chunks_len)
            .map_err(|_| "too many snapshot domain chunks".to_string())?
            .to_le_bytes(),
    );
    for (index, chunk) in domain_chunks.iter().enumerate() {
        if chunk.is_empty() {
            continue;
        }
        let domain = 1u32 << index;
        payload.extend_from_slice(&domain.to_le_bytes());
        payload.extend_from_slice(
            &u32::try_from(chunk.len())
                .map_err(|_| "snapshot domain chunk too large".to_string())?
                .to_le_bytes(),
        );
        payload.extend_from_slice(&chunk);
    }
    for (index, chunk) in domain_delta_chunks.iter().enumerate() {
        if chunk.is_empty() {
            continue;
        }
        let domain = SNAPSHOT_DELTA_CHUNK_FLAG | (1u32 << index);
        payload.extend_from_slice(&domain.to_le_bytes());
        payload.extend_from_slice(
            &u32::try_from(chunk.len())
                .map_err(|_| "snapshot domain delta chunk too large".to_string())?
                .to_le_bytes(),
        );
        payload.extend_from_slice(&chunk);
    }
    Ok(payload)
}

fn refresh_domain_chunk_cache(
    domain_chunks: &mut [Vec<u8>; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT],
    dirty_domains: u32,
    messages: &[shell_wire::DecodedCompositorToShellMessage],
    force_all: bool,
) -> Result<u32, String> {
    let mut next_chunks: [Option<Vec<u8>>; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT] =
        std::array::from_fn(|index| {
            let domain = 1u32 << index;
            if force_all || dirty_domains & domain != 0 {
                Some(Vec::new())
            } else {
                None
            }
        });
    for msg in messages {
        let domain = snapshot_domain_for_message(msg);
        let Some(index) = snapshot_domain_index(domain) else {
            continue;
        };
        let Some(chunk) = next_chunks[index].as_mut() else {
            continue;
        };
        append_snapshot_message(chunk, msg)?;
    }
    let mut actual_dirty_domains = 0u32;
    for (index, chunk) in domain_chunks.iter_mut().enumerate() {
        let domain = 1u32 << index;
        if !force_all && dirty_domains & domain == 0 {
            continue;
        }
        let next = next_chunks[index].take().unwrap_or_default();
        if *chunk != next {
            *chunk = next;
            actual_dirty_domains |= domain;
        }
    }
    Ok(actual_dirty_domains)
}

fn refresh_delta_chunk_cache(
    domain_delta_chunks: &mut [Vec<u8>; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT],
    dirty_domains: u32,
    messages: &[shell_wire::DecodedCompositorToShellMessage],
) -> Result<(), String> {
    let mut next_chunks: [Vec<u8>; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT] =
        std::array::from_fn(|_| Vec::new());
    for msg in messages {
        let domain = snapshot_domain_for_message(msg);
        let Some(index) = snapshot_domain_index(domain) else {
            continue;
        };
        if dirty_domains & domain == 0 {
            continue;
        }
        append_snapshot_message(&mut next_chunks[index], msg)?;
    }
    for (index, chunk) in domain_delta_chunks.iter_mut().enumerate() {
        let domain = 1u32 << index;
        if dirty_domains & domain != 0 {
            *chunk = std::mem::take(&mut next_chunks[index]);
        } else {
            chunk.clear();
        }
    }
    Ok(())
}

fn snapshot_domain_index(domain: u32) -> Option<usize> {
    if domain == 0 || !domain.is_power_of_two() {
        return None;
    }
    let index = domain.trailing_zeros() as usize;
    if index < shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT {
        Some(index)
    } else {
        None
    }
}

fn snapshot_chunk_base_domain(domain: u32) -> u32 {
    domain & !SNAPSHOT_DELTA_CHUNK_FLAG
}

fn snapshot_payload_domain_revisions(
    payload: &[u8],
) -> Option<[u64; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT]> {
    if payload.len() < shell_wire::SHELL_SNAPSHOT_DOMAIN_REVISION_BYTES {
        return None;
    }
    let mut revisions = [0u64; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT];
    for (index, revision) in revisions.iter_mut().enumerate() {
        let offset = index * 8;
        *revision = u64::from_le_bytes(payload[offset..offset + 8].try_into().ok()?);
    }
    Some(revisions)
}

fn encode_dirty_snapshot_payload(
    payload: &[u8],
    previous_domain_revisions: &[u64; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT],
) -> Option<(u32, Vec<u8>)> {
    let current_domain_revisions = snapshot_payload_domain_revisions(payload)?;
    let mut offset = shell_wire::SHELL_SNAPSHOT_DOMAIN_REVISION_BYTES;
    if offset + 8 > payload.len()
        || u32::from_le_bytes(payload[offset..offset + 4].try_into().ok()?)
            != SNAPSHOT_DOMAIN_CHUNKS_MAGIC
    {
        return None;
    }
    let chunk_count = u32::from_le_bytes(payload[offset + 4..offset + 8].try_into().ok()?) as usize;
    offset += 8;
    let mut normal_chunks = Vec::<(u32, &[u8])>::new();
    let mut delta_chunks = HashMap::<u32, &[u8]>::new();
    let mut selected_flags = 0u32;
    for _ in 0..chunk_count {
        if offset + 8 > payload.len() {
            return None;
        }
        let domain = u32::from_le_bytes(payload[offset..offset + 4].try_into().ok()?);
        let chunk_len =
            u32::from_le_bytes(payload[offset + 4..offset + 8].try_into().ok()?) as usize;
        let chunk_start = offset + 8;
        let chunk_end = chunk_start.checked_add(chunk_len)?;
        if chunk_end > payload.len() {
            return None;
        }
        let base_domain = snapshot_chunk_base_domain(domain);
        let changed = snapshot_domain_index(base_domain)
            .map(|index| previous_domain_revisions[index] != current_domain_revisions[index])
            .unwrap_or(true);
        if changed {
            selected_flags |= base_domain;
            if domain & SNAPSHOT_DELTA_CHUNK_FLAG != 0 {
                delta_chunks.insert(base_domain, &payload[chunk_start..chunk_end]);
            } else {
                normal_chunks.push((base_domain, &payload[chunk_start..chunk_end]));
            }
        }
        offset = chunk_end;
    }
    if offset != payload.len() {
        return None;
    }
    let mut out = Vec::new();
    for revision in current_domain_revisions {
        out.extend_from_slice(&revision.to_le_bytes());
    }
    out.extend_from_slice(&SNAPSHOT_DOMAIN_CHUNKS_MAGIC.to_le_bytes());
    let selected: Vec<(u32, &[u8])> = normal_chunks
        .into_iter()
        .filter_map(|(domain, chunk)| {
            delta_chunks
                .get(&domain)
                .copied()
                .map(|delta| (domain, delta))
                .or(Some((domain, chunk)))
        })
        .collect();
    out.extend_from_slice(&u32::try_from(selected.len()).ok()?.to_le_bytes());
    for (domain, chunk) in selected {
        out.extend_from_slice(&domain.to_le_bytes());
        out.extend_from_slice(&u32::try_from(chunk.len()).ok()?.to_le_bytes());
        out.extend_from_slice(chunk);
    }
    Some((selected_flags, out))
}

fn snapshot_read_bytes(
    path: &Path,
    last_sequence: Option<u64>,
    previous_domain_revisions: Option<&[u64; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT]>,
) -> Result<SnapshotReadResult, String> {
    #[cfg(not(unix))]
    {
        let _ = (path, last_sequence, previous_domain_revisions);
        return Err("shared snapshots require unix reads".to_string());
    }
    #[cfg(unix)]
    {
        let header_len = shell_wire::SHELL_SHARED_SNAPSHOT_HEADER_BYTES as usize;
        let mut cache = snapshot_read_cache()
            .lock()
            .map_err(|_| format!("snapshot cache lock poisoned {}", path.display()))?;
        let mapped = cache.mapped_slice(path)?;
        let head_a_bytes = mapped_snapshot_header(mapped)?;
        let head_a = shell_wire::read_shared_snapshot_header(&head_a_bytes)?;
        if head_a.magic != shell_wire::SHELL_SHARED_SNAPSHOT_MAGIC
            || head_a.sequence % 2 != 0
            || last_sequence == Some(head_a.sequence)
        {
            return Ok(SnapshotReadResult::Unchanged);
        }
        let payload_len = head_a.payload_len as usize;
        if header_len + payload_len > mapped.len() {
            return Ok(SnapshotReadResult::Unchanged);
        }
        fence(Ordering::Acquire);
        let payload = &mapped[header_len..header_len + payload_len];
        let filtered = previous_domain_revisions
            .and_then(|revisions| encode_dirty_snapshot_payload(payload, revisions));
        let (flags, payload, filtered) = filtered
            .map(|(flags, payload)| (flags, Cow::Owned(payload), true))
            .unwrap_or((head_a.flags, Cow::Borrowed(payload), false));
        let mut out = Vec::with_capacity(header_len + payload.len());
        out.resize(header_len, 0);
        shell_wire::write_shared_snapshot_header(
            &mut out[..header_len],
            head_a.sequence,
            payload.len() as u32,
            flags,
        )?;
        out.extend_from_slice(&payload);
        fence(Ordering::Acquire);
        let head_b_bytes = mapped_snapshot_header(mapped)?;
        let head_b = shell_wire::read_shared_snapshot_header(&head_b_bytes)?;
        if head_a.sequence != head_b.sequence || head_b.sequence % 2 != 0 {
            return Ok(SnapshotReadResult::Unchanged);
        }
        Ok(SnapshotReadResult::Changed {
            bytes: out,
            payload_len: payload.len(),
            filtered,
        })
    }
}

fn extend_snapshot_packet(
    payload: &mut Vec<u8>,
    packet: Option<Vec<u8>>,
    label: &str,
) -> Result<(), String> {
    let packet = packet.ok_or_else(|| format!("encode {label} snapshot"))?;
    payload.extend_from_slice(&packet);
    Ok(())
}

fn push_json_string(out: &mut Vec<u8>, value: Option<&serde_json::Value>) -> Option<()> {
    let s = value.and_then(|v| v.as_str()).unwrap_or_default();
    let bytes = s.as_bytes();
    out.extend_from_slice(&u32::try_from(bytes.len()).ok()?.to_le_bytes());
    out.extend_from_slice(bytes);
    Some(())
}

fn push_json_u32(out: &mut Vec<u8>, value: Option<&serde_json::Value>) -> Option<()> {
    out.extend_from_slice(
        &(value.and_then(|v| v.as_u64()).unwrap_or_default() as u32).to_le_bytes(),
    );
    Some(())
}

fn push_json_i32(out: &mut Vec<u8>, value: Option<&serde_json::Value>) -> Option<()> {
    out.extend_from_slice(
        &(value.and_then(|v| v.as_i64()).unwrap_or_default() as i32).to_le_bytes(),
    );
    Some(())
}

fn push_json_f64(out: &mut Vec<u8>, value: Option<&serde_json::Value>) -> Option<()> {
    out.extend_from_slice(
        &value
            .and_then(|v| v.as_f64())
            .unwrap_or_default()
            .to_le_bytes(),
    );
    Some(())
}

fn json_array(value: Option<&serde_json::Value>) -> &[serde_json::Value] {
    value
        .and_then(|v| v.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn json_object(
    value: Option<&serde_json::Value>,
) -> Option<&serde_json::Map<String, serde_json::Value>> {
    value.and_then(|v| v.as_object())
}

fn layout_code(value: Option<&serde_json::Value>) -> u32 {
    match value.and_then(|v| v.as_str()).unwrap_or_default() {
        "master-stack" => 1,
        "columns" => 2,
        "grid" => 3,
        "custom-auto" => 4,
        _ => 0,
    }
}

fn rule_field_code(value: Option<&serde_json::Value>) -> u32 {
    match value.and_then(|v| v.as_str()).unwrap_or_default() {
        "title" => 1,
        "x11_class" => 2,
        "x11_instance" => 3,
        "kind" => 4,
        _ => 0,
    }
}

fn rule_op_code(value: Option<&serde_json::Value>) -> u32 {
    match value.and_then(|v| v.as_str()).unwrap_or_default() {
        "contains" => 1,
        "starts_with" => 2,
        _ => 0,
    }
}

fn layout_type_code(value: &WorkspaceMonitorLayoutType) -> u32 {
    match value {
        WorkspaceMonitorLayoutType::MasterStack => 1,
        WorkspaceMonitorLayoutType::Columns => 2,
        WorkspaceMonitorLayoutType::Grid => 3,
        WorkspaceMonitorLayoutType::CustomAuto => 4,
        WorkspaceMonitorLayoutType::ManualSnap => 0,
    }
}

fn slot_rule_field_code(value: &WorkspaceSlotRuleField) -> u32 {
    match value {
        WorkspaceSlotRuleField::Title => 1,
        WorkspaceSlotRuleField::X11Class => 2,
        WorkspaceSlotRuleField::X11Instance => 3,
        WorkspaceSlotRuleField::Kind => 4,
        WorkspaceSlotRuleField::AppId => 0,
    }
}

fn slot_rule_op_code(value: &WorkspaceSlotRuleOp) -> u32 {
    match value {
        WorkspaceSlotRuleOp::Contains => 1,
        WorkspaceSlotRuleOp::StartsWith => 2,
        WorkspaceSlotRuleOp::Equals => 0,
    }
}

fn push_wire_string(out: &mut Vec<u8>, value: &str) -> Option<()> {
    let bytes = value.as_bytes();
    out.extend_from_slice(&u32::try_from(bytes.len()).ok()?.to_le_bytes());
    out.extend_from_slice(bytes);
    Some(())
}

pub(crate) fn encode_workspace_state_binary_payload(state: &WorkspaceState) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    body.extend_from_slice(&u32::try_from(state.groups.len()).ok()?.to_le_bytes());
    for group in &state.groups {
        push_wire_string(&mut body, &group.id)?;
        body.extend_from_slice(&u32::try_from(group.window_ids.len()).ok()?.to_le_bytes());
        for window_id in &group.window_ids {
            body.extend_from_slice(&window_id.to_le_bytes());
        }
    }
    body.extend_from_slice(
        &u32::try_from(state.active_tab_by_group_id.len())
            .ok()?
            .to_le_bytes(),
    );
    for (group_id, window_id) in &state.active_tab_by_group_id {
        push_wire_string(&mut body, group_id)?;
        body.extend_from_slice(&window_id.to_le_bytes());
    }
    body.extend_from_slice(
        &u32::try_from(state.pinned_window_ids.len())
            .ok()?
            .to_le_bytes(),
    );
    for window_id in &state.pinned_window_ids {
        body.extend_from_slice(&window_id.to_le_bytes());
    }
    body.extend_from_slice(
        &u32::try_from(state.split_by_group_id.len())
            .ok()?
            .to_le_bytes(),
    );
    for (group_id, split) in &state.split_by_group_id {
        push_wire_string(&mut body, group_id)?;
        body.extend_from_slice(&split.left_window_id.to_le_bytes());
        body.extend_from_slice(&split.left_pane_fraction.to_le_bytes());
    }
    body.extend_from_slice(&u32::try_from(state.monitor_tiles.len()).ok()?.to_le_bytes());
    for monitor in &state.monitor_tiles {
        push_wire_string(&mut body, &monitor.output_id)?;
        push_wire_string(&mut body, &monitor.output_name)?;
        body.extend_from_slice(&u32::try_from(monitor.entries.len()).ok()?.to_le_bytes());
        for entry in &monitor.entries {
            body.extend_from_slice(&entry.window_id.to_le_bytes());
            push_wire_string(&mut body, &entry.zone)?;
            body.extend_from_slice(&entry.bounds.x.to_le_bytes());
            body.extend_from_slice(&entry.bounds.y.to_le_bytes());
            body.extend_from_slice(&entry.bounds.width.to_le_bytes());
            body.extend_from_slice(&entry.bounds.height.to_le_bytes());
        }
    }
    body.extend_from_slice(
        &u32::try_from(state.monitor_layouts.len())
            .ok()?
            .to_le_bytes(),
    );
    for layout in &state.monitor_layouts {
        push_wire_string(&mut body, &layout.output_id)?;
        push_wire_string(&mut body, &layout.output_name)?;
        body.extend_from_slice(&layout_type_code(&layout.layout).to_le_bytes());
        body.extend_from_slice(&layout.params.master_ratio.unwrap_or_default().to_le_bytes());
        body.extend_from_slice(&layout.params.max_columns.unwrap_or_default().to_le_bytes());
        push_wire_string(
            &mut body,
            layout
                .params
                .custom_layout_id
                .as_deref()
                .unwrap_or_default(),
        )?;
        body.extend_from_slice(
            &u32::try_from(layout.params.custom_slots.len())
                .ok()?
                .to_le_bytes(),
        );
        for slot in &layout.params.custom_slots {
            push_wire_string(&mut body, &slot.slot_id)?;
            body.extend_from_slice(&slot.x.to_le_bytes());
            body.extend_from_slice(&slot.y.to_le_bytes());
            body.extend_from_slice(&slot.width.to_le_bytes());
            body.extend_from_slice(&slot.height.to_le_bytes());
            body.extend_from_slice(&u32::try_from(slot.rules.len()).ok()?.to_le_bytes());
            for rule in &slot.rules {
                body.extend_from_slice(&slot_rule_field_code(&rule.field).to_le_bytes());
                body.extend_from_slice(&slot_rule_op_code(&rule.op).to_le_bytes());
                push_wire_string(&mut body, &rule.value)?;
            }
        }
    }
    body.extend_from_slice(
        &u32::try_from(state.pre_tile_geometry.len())
            .ok()?
            .to_le_bytes(),
    );
    for entry in &state.pre_tile_geometry {
        body.extend_from_slice(&entry.window_id.to_le_bytes());
        body.extend_from_slice(&entry.bounds.x.to_le_bytes());
        body.extend_from_slice(&entry.bounds.y.to_le_bytes());
        body.extend_from_slice(&entry.bounds.width.to_le_bytes());
        body.extend_from_slice(&entry.bounds.height.to_le_bytes());
    }
    body.extend_from_slice(&state.next_group_seq.to_le_bytes());
    if body.len() > shell_wire::MAX_WORKSPACE_BINARY_BYTES as usize {
        return None;
    }
    Some(body)
}

fn encode_workspace_state_binary(revision: u64, state_json: &str) -> Option<Vec<u8>> {
    let root: serde_json::Value = serde_json::from_str(state_json).ok()?;
    let object = root.as_object()?;
    let mut body = Vec::new();
    body.extend_from_slice(&shell_wire::MSG_COMPOSITOR_WORKSPACE_STATE_BINARY.to_le_bytes());
    body.extend_from_slice(&revision.to_le_bytes());
    let groups = json_array(object.get("groups"));
    body.extend_from_slice(&u32::try_from(groups.len()).ok()?.to_le_bytes());
    for group in groups {
        let group = group.as_object()?;
        push_json_string(&mut body, group.get("id"))?;
        let window_ids = json_array(group.get("windowIds"));
        body.extend_from_slice(&u32::try_from(window_ids.len()).ok()?.to_le_bytes());
        for window_id in window_ids {
            push_json_u32(&mut body, Some(window_id))?;
        }
    }
    let active = json_object(object.get("activeTabByGroupId"));
    body.extend_from_slice(
        &u32::try_from(active.map(|v| v.len()).unwrap_or(0))
            .ok()?
            .to_le_bytes(),
    );
    if let Some(active) = active {
        for (group_id, window_id) in active {
            let group_value = serde_json::Value::String(group_id.clone());
            push_json_string(&mut body, Some(&group_value))?;
            push_json_u32(&mut body, Some(window_id))?;
        }
    }
    let pinned = json_array(object.get("pinnedWindowIds"));
    body.extend_from_slice(&u32::try_from(pinned.len()).ok()?.to_le_bytes());
    for window_id in pinned {
        push_json_u32(&mut body, Some(window_id))?;
    }
    let splits = json_object(object.get("splitByGroupId"));
    body.extend_from_slice(
        &u32::try_from(splits.map(|v| v.len()).unwrap_or(0))
            .ok()?
            .to_le_bytes(),
    );
    if let Some(splits) = splits {
        for (group_id, split) in splits {
            let group_value = serde_json::Value::String(group_id.clone());
            let split = split.as_object()?;
            push_json_string(&mut body, Some(&group_value))?;
            push_json_u32(&mut body, split.get("leftWindowId"))?;
            push_json_f64(&mut body, split.get("leftPaneFraction"))?;
        }
    }
    let monitor_tiles = json_array(object.get("monitorTiles"));
    body.extend_from_slice(&u32::try_from(monitor_tiles.len()).ok()?.to_le_bytes());
    for monitor in monitor_tiles {
        let monitor = monitor.as_object()?;
        push_json_string(&mut body, monitor.get("outputId"))?;
        push_json_string(&mut body, monitor.get("outputName"))?;
        let entries = json_array(monitor.get("entries"));
        body.extend_from_slice(&u32::try_from(entries.len()).ok()?.to_le_bytes());
        for entry in entries {
            let entry = entry.as_object()?;
            let bounds = entry.get("bounds").and_then(|v| v.as_object())?;
            push_json_u32(&mut body, entry.get("windowId"))?;
            push_json_string(&mut body, entry.get("zone"))?;
            push_json_i32(&mut body, bounds.get("x"))?;
            push_json_i32(&mut body, bounds.get("y"))?;
            push_json_i32(&mut body, bounds.get("width"))?;
            push_json_i32(&mut body, bounds.get("height"))?;
        }
    }
    let monitor_layouts = json_array(object.get("monitorLayouts"));
    body.extend_from_slice(&u32::try_from(monitor_layouts.len()).ok()?.to_le_bytes());
    for layout in monitor_layouts {
        let layout = layout.as_object()?;
        let params = layout.get("params").and_then(|v| v.as_object());
        push_json_string(&mut body, layout.get("outputId"))?;
        push_json_string(&mut body, layout.get("outputName"))?;
        body.extend_from_slice(&layout_code(layout.get("layout")).to_le_bytes());
        push_json_f64(&mut body, params.and_then(|p| p.get("masterRatio")))?;
        push_json_u32(&mut body, params.and_then(|p| p.get("maxColumns")))?;
        push_json_string(&mut body, params.and_then(|p| p.get("customLayoutId")))?;
        let slots = json_array(params.and_then(|p| p.get("customSlots")));
        body.extend_from_slice(&u32::try_from(slots.len()).ok()?.to_le_bytes());
        for slot in slots {
            let slot = slot.as_object()?;
            push_json_string(&mut body, slot.get("slotId"))?;
            push_json_f64(&mut body, slot.get("x"))?;
            push_json_f64(&mut body, slot.get("y"))?;
            push_json_f64(&mut body, slot.get("width"))?;
            push_json_f64(&mut body, slot.get("height"))?;
            let rules = json_array(slot.get("rules"));
            body.extend_from_slice(&u32::try_from(rules.len()).ok()?.to_le_bytes());
            for rule in rules {
                let rule = rule.as_object()?;
                body.extend_from_slice(&rule_field_code(rule.get("field")).to_le_bytes());
                body.extend_from_slice(&rule_op_code(rule.get("op")).to_le_bytes());
                push_json_string(&mut body, rule.get("value"))?;
            }
        }
    }
    let pre_tiles = json_array(object.get("preTileGeometry"));
    body.extend_from_slice(&u32::try_from(pre_tiles.len()).ok()?.to_le_bytes());
    for entry in pre_tiles {
        let entry = entry.as_object()?;
        let bounds = entry.get("bounds").and_then(|v| v.as_object())?;
        push_json_u32(&mut body, entry.get("windowId"))?;
        push_json_i32(&mut body, bounds.get("x"))?;
        push_json_i32(&mut body, bounds.get("y"))?;
        push_json_i32(&mut body, bounds.get("width"))?;
        push_json_i32(&mut body, bounds.get("height"))?;
    }
    push_json_u32(&mut body, object.get("nextGroupSeq"))?;
    if body.len() > shell_wire::MAX_WORKSPACE_BINARY_BYTES as usize {
        return None;
    }
    let body_len = u32::try_from(body.len()).ok()?;
    let mut packet = Vec::with_capacity(4 + body.len());
    packet.extend_from_slice(&body_len.to_le_bytes());
    packet.extend_from_slice(&body);
    Some(packet)
}

fn append_snapshot_message(
    payload: &mut Vec<u8>,
    msg: &shell_wire::DecodedCompositorToShellMessage,
) -> Result<(), String> {
    match msg {
        shell_wire::DecodedCompositorToShellMessage::OutputGeometry {
            logical_w,
            logical_h,
            physical_w,
            physical_h,
        } => {
            payload.extend_from_slice(&shell_wire::encode_output_geometry(
                *logical_w,
                *logical_h,
                *physical_w,
                *physical_h,
            ));
        }
        shell_wire::DecodedCompositorToShellMessage::OutputLayout {
            revision,
            canvas_logical_w,
            canvas_logical_h,
            canvas_physical_w,
            canvas_physical_h,
            screens,
            shell_chrome_primary,
        } => extend_snapshot_packet(
            payload,
            shell_wire::encode_output_layout(
                *revision,
                *canvas_logical_w,
                *canvas_logical_h,
                *canvas_physical_w,
                *canvas_physical_h,
                screens,
                shell_chrome_primary.as_deref(),
            ),
            "output layout",
        )?,
        shell_wire::DecodedCompositorToShellMessage::WindowMapped {
            window_id,
            surface_id,
            x,
            y,
            w,
            h,
            title,
            app_id,
            client_side_decoration,
            output_name,
            ..
        } => extend_snapshot_packet(
            payload,
            shell_wire::encode_window_mapped(
                *window_id,
                *surface_id,
                *x,
                *y,
                *w,
                *h,
                title,
                app_id,
                *client_side_decoration,
                output_name,
            ),
            "window mapped",
        )?,
        shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { window_id } => {
            payload.extend_from_slice(&shell_wire::encode_window_unmapped(*window_id));
        }
        shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
            window_id,
            surface_id,
            x,
            y,
            w,
            h,
            maximized,
            fullscreen,
            client_side_decoration,
            output_name,
            ..
        } => extend_snapshot_packet(
            payload,
            shell_wire::encode_window_geometry(
                *window_id,
                *surface_id,
                *x,
                *y,
                *w,
                *h,
                *maximized,
                *fullscreen,
                *client_side_decoration,
                output_name,
            ),
            "window geometry",
        )?,
        shell_wire::DecodedCompositorToShellMessage::WindowMetadata {
            window_id,
            surface_id,
            title,
            app_id,
        } => extend_snapshot_packet(
            payload,
            shell_wire::encode_window_metadata(*window_id, *surface_id, title, app_id),
            "window metadata",
        )?,
        shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id,
            window_id,
        } => {
            payload.extend_from_slice(&shell_wire::encode_focus_changed(*surface_id, *window_id));
        }
        shell_wire::DecodedCompositorToShellMessage::WindowList { revision, windows } => {
            extend_snapshot_packet(
                payload,
                shell_wire::encode_window_list(*revision, windows),
                "window list",
            )?
        }
        shell_wire::DecodedCompositorToShellMessage::WindowOrder { revision, windows } => {
            extend_snapshot_packet(
                payload,
                shell_wire::encode_window_order(*revision, windows),
                "window order",
            )?
        }
        shell_wire::DecodedCompositorToShellMessage::WindowState {
            window_id,
            minimized,
        } => {
            payload.extend_from_slice(&shell_wire::encode_window_state(*window_id, *minimized));
        }
        shell_wire::DecodedCompositorToShellMessage::KeyboardLayout { label } => {
            extend_snapshot_packet(
                payload,
                shell_wire::encode_compositor_keyboard_layout(label),
                "keyboard layout",
            )?;
        }
        shell_wire::DecodedCompositorToShellMessage::VolumeOverlay {
            volume_linear_percent_x100,
            muted,
            state_known,
        } => {
            payload.extend_from_slice(&shell_wire::encode_compositor_volume_overlay(
                *volume_linear_percent_x100,
                *muted,
                *state_known,
            ));
        }
        shell_wire::DecodedCompositorToShellMessage::WorkspaceState {
            revision,
            state_json,
        } => {
            extend_snapshot_packet(
                payload,
                encode_workspace_state_binary(*revision, state_json).or_else(|| {
                    shell_wire::encode_compositor_workspace_state(*revision, state_json)
                }),
                "workspace state",
            )?;
        }
        shell_wire::DecodedCompositorToShellMessage::WorkspaceStateBinary { revision, state } => {
            extend_snapshot_packet(
                payload,
                shell_wire::encode_compositor_workspace_state_binary(*revision, state),
                "workspace state binary",
            )?;
        }
        shell_wire::DecodedCompositorToShellMessage::ShellHostedAppState {
            revision,
            state_json,
        } => {
            extend_snapshot_packet(
                payload,
                shell_wire::encode_compositor_shell_hosted_app_state(*revision, state_json),
                "shell hosted app state",
            )?;
        }
        shell_wire::DecodedCompositorToShellMessage::InteractionState {
            revision,
            pointer_x,
            pointer_y,
            move_window_id,
            resize_window_id,
            move_proxy_window_id,
            move_capture_window_id,
            move_visual,
            resize_visual,
        } => {
            payload.extend_from_slice(&shell_wire::encode_compositor_interaction_state(
                *revision,
                *pointer_x,
                *pointer_y,
                *move_window_id,
                *resize_window_id,
                *move_proxy_window_id,
                *move_capture_window_id,
                *move_visual,
                *resize_visual,
            ));
        }
        shell_wire::DecodedCompositorToShellMessage::NativeDragPreview {
            window_id,
            generation,
            image_path,
        } => {
            extend_snapshot_packet(
                payload,
                shell_wire::encode_compositor_native_drag_preview(
                    *window_id,
                    *generation,
                    image_path,
                ),
                "native drag preview",
            )?;
        }
        shell_wire::DecodedCompositorToShellMessage::TrayHints {
            slot_count,
            slot_w,
            reserved_w,
        } => {
            payload.extend_from_slice(&shell_wire::encode_compositor_tray_hints(
                *slot_count,
                *slot_w,
                *reserved_w,
            ));
        }
        shell_wire::DecodedCompositorToShellMessage::TraySni { items } => {
            extend_snapshot_packet(
                payload,
                shell_wire::encode_compositor_tray_sni(items),
                "tray sni",
            )?;
        }
        _ => {}
    }
    Ok(())
}

fn warn_snapshot_invariants(messages: &[shell_wire::DecodedCompositorToShellMessage]) {
    let mut window_ids = HashSet::new();
    let mut output_names = HashSet::new();
    let mut output_ids = HashSet::new();
    let mut window_list_count = 0usize;
    let mut focused_window_id = None;
    let mut workspace_json = None;
    for msg in messages {
        match msg {
            shell_wire::DecodedCompositorToShellMessage::OutputLayout { screens, .. } => {
                for screen in screens {
                    if !output_names.insert(screen.name.clone()) {
                        tracing::warn!(output = %screen.name, "snapshot duplicate output");
                    }
                    if !screen.identity.is_empty() && !output_ids.insert(screen.identity.clone()) {
                        tracing::warn!(output_id = %screen.identity, "snapshot duplicate output identity");
                    }
                }
            }
            shell_wire::DecodedCompositorToShellMessage::WindowList { windows, .. } => {
                window_list_count += 1;
                for window in windows {
                    if !window_ids.insert(window.window_id) {
                        tracing::warn!(window_id = window.window_id, "snapshot duplicate window");
                    }
                }
            }
            shell_wire::DecodedCompositorToShellMessage::FocusChanged { window_id, .. } => {
                focused_window_id = *window_id;
            }
            shell_wire::DecodedCompositorToShellMessage::WorkspaceState { state_json, .. } => {
                workspace_json = Some(state_json.as_str());
            }
            _ => {}
        }
    }
    if window_list_count != 1 {
        tracing::warn!(count = window_list_count, "snapshot window list count");
    }
    if let Some(window_id) = focused_window_id {
        if window_id != 0 && !window_ids.contains(&window_id) {
            tracing::warn!(window_id, "snapshot focused window missing");
        }
    }
    for msg in messages {
        if let shell_wire::DecodedCompositorToShellMessage::WindowList { windows, .. } = msg {
            for window in windows {
                if !window.output_name.is_empty()
                    && !output_names.is_empty()
                    && !output_names.contains(&window.output_name)
                {
                    tracing::warn!(
                        window_id = window.window_id,
                        output = %window.output_name,
                        "snapshot window output missing"
                    );
                }
            }
        }
    }
    if let Some(state_json) = workspace_json {
        warn_workspace_invariants(state_json, &window_ids, &output_names, &output_ids);
    }
}

fn warn_workspace_window_ref(value: &serde_json::Value, field: &str, window_ids: &HashSet<u32>) {
    if let Some(id) = value.as_u64().and_then(|id| u32::try_from(id).ok()) {
        if id != 0 && !window_ids.contains(&id) {
            tracing::warn!(field, window_id = id, "snapshot workspace window missing");
        }
    }
}

fn warn_workspace_invariants(
    state_json: &str,
    window_ids: &HashSet<u32>,
    output_names: &HashSet<String>,
    output_ids: &HashSet<String>,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(state_json) else {
        tracing::warn!("snapshot workspace json invalid");
        return;
    };
    let mut group_window_owner = HashMap::<u32, String>::new();
    if let Some(groups) = value.get("groups").and_then(|v| v.as_array()) {
        for group in groups {
            let group_id = group
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if let Some(ids) = group.get("windowIds").and_then(|v| v.as_array()) {
                for id in ids {
                    warn_workspace_window_ref(id, "groups.windowIds", window_ids);
                    if let Some(window_id) = id.as_u64().and_then(|id| u32::try_from(id).ok()) {
                        if let Some(previous_group_id) =
                            group_window_owner.insert(window_id, group_id.clone())
                        {
                            tracing::warn!(
                                window_id,
                                group_id = %group_id,
                                previous_group_id = %previous_group_id,
                                "snapshot workspace duplicate group window"
                            );
                        }
                    }
                }
            }
        }
    }
    if let Some(ids) = value.get("pinnedWindowIds").and_then(|v| v.as_array()) {
        for id in ids {
            warn_workspace_window_ref(id, "pinnedWindowIds", window_ids);
        }
    }
    if let Some(splits) = value.get("splitByGroupId").and_then(|v| v.as_object()) {
        for split in splits.values() {
            if let Some(id) = split.get("leftWindowId") {
                warn_workspace_window_ref(id, "splitByGroupId.leftWindowId", window_ids);
            }
        }
    }
    if let Some(monitors) = value.get("monitorTiles").and_then(|v| v.as_array()) {
        let mut tiled_window_owner = HashMap::<u32, String>::new();
        for monitor in monitors {
            let output_name = monitor
                .get("outputName")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let output_id = monitor
                .get("outputId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !output_id.is_empty() && !output_ids.is_empty() && !output_ids.contains(output_id) {
                tracing::warn!(output_id, "snapshot workspace output identity missing");
            }
            if let Some(output) = monitor.get("outputName").and_then(|v| v.as_str()) {
                if !output.is_empty() && !output_names.is_empty() && !output_names.contains(output)
                {
                    tracing::warn!(output, "snapshot workspace output missing");
                }
            }
            if let Some(entries) = monitor.get("entries").and_then(|v| v.as_array()) {
                for entry in entries {
                    if let Some(id) = entry.get("windowId") {
                        warn_workspace_window_ref(id, "monitorTiles.entries.windowId", window_ids);
                        if let Some(window_id) = id.as_u64().and_then(|id| u32::try_from(id).ok()) {
                            if let Some(previous_output) =
                                tiled_window_owner.insert(window_id, output_name.to_string())
                            {
                                tracing::warn!(
                                    window_id,
                                    output = %output_name,
                                    previous_output = %previous_output,
                                    "snapshot workspace duplicate tiled window"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    if let Some(entries) = value.get("preTileGeometry").and_then(|v| v.as_array()) {
        for entry in entries {
            if let Some(id) = entry.get("windowId") {
                warn_workspace_window_ref(id, "preTileGeometry.windowId", window_ids);
            }
        }
    }
}

pub fn snapshot_version(path: &Path) -> Result<Option<u64>, String> {
    #[cfg(not(unix))]
    {
        let _ = path;
        return Err("shared snapshots require unix reads".to_string());
    }
    #[cfg(unix)]
    let header_bytes = {
        let mut cache = snapshot_read_cache()
            .lock()
            .map_err(|_| format!("snapshot cache lock poisoned {}", path.display()))?;
        let mapped = cache.mapped_slice(path)?;
        mapped_snapshot_header(mapped)?
    };
    #[cfg(unix)]
    let header = shell_wire::read_shared_snapshot_header(&header_bytes)?;
    if header.magic != shell_wire::SHELL_SHARED_SNAPSHOT_MAGIC || header.sequence % 2 != 0 {
        return Ok(None);
    }
    Ok(Some(header.sequence))
}

pub fn snapshot_read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    #[cfg(not(unix))]
    {
        let _ = path;
        return Err("shared snapshots require unix reads".to_string());
    }
    #[cfg(unix)]
    {
        match snapshot_read_bytes(path, None, None)? {
            SnapshotReadResult::Changed { bytes, .. } => Ok(Some(bytes)),
            SnapshotReadResult::Unchanged => Ok(None),
        }
    }
}

pub fn snapshot_read_if_changed(
    path: &Path,
    last_sequence: u64,
) -> Result<Option<Vec<u8>>, String> {
    #[cfg(not(unix))]
    {
        let _ = (path, last_sequence);
        return Err("shared snapshots require unix reads".to_string());
    }
    #[cfg(unix)]
    {
        match snapshot_read_bytes(path, Some(last_sequence), None)? {
            SnapshotReadResult::Changed { bytes, .. } => Ok(Some(bytes)),
            SnapshotReadResult::Unchanged => Ok(None),
        }
    }
}

pub fn snapshot_read_dirty_if_changed(
    path: &Path,
    last_sequence: u64,
    previous_domain_revisions: &[u64; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT],
) -> Result<SnapshotDirtyRead, String> {
    #[cfg(not(unix))]
    {
        let _ = (path, last_sequence, previous_domain_revisions);
        return Err("shared snapshots require unix reads".to_string());
    }
    #[cfg(unix)]
    {
        match snapshot_read_bytes(path, Some(last_sequence), Some(previous_domain_revisions))? {
            SnapshotReadResult::Unchanged => Ok(SnapshotDirtyRead::Unchanged),
            SnapshotReadResult::Changed {
                bytes,
                payload_len,
                filtered,
            } => {
                if filtered {
                    Ok(SnapshotDirtyRead::Dirty { bytes, payload_len })
                } else {
                    Ok(SnapshotDirtyRead::Fallback { bytes, payload_len })
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_snapshot_message, encode_dirty_snapshot_payload, encode_payload_chunks,
        refresh_domain_chunk_cache, SNAPSHOT_DOMAIN_CHUNKS_MAGIC,
    };

    fn chunks() -> [Vec<u8>; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT] {
        std::array::from_fn(|_| Vec::new())
    }

    fn delta_chunks() -> [Vec<u8>; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT] {
        std::array::from_fn(|_| Vec::new())
    }

    fn output_geometry(w: u32) -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::OutputGeometry {
            logical_w: w,
            logical_h: 1080,
            physical_w: w,
            physical_h: 1080,
        }
    }

    fn window_list(revision: u64) -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::WindowList {
            revision,
            windows: vec![shell_wire::ShellWindowSnapshot {
                window_id: 9,
                surface_id: 10,
                stack_z: 9,
                x: 20,
                y: 30,
                w: 800,
                h: 600,
                minimized: 0,
                maximized: 0,
                fullscreen: 0,
                client_side_decoration: 1,
                workspace_visible: 1,
                shell_flags: 0,
                title: "Terminal".to_string(),
                app_id: "foot".to_string(),
                output_id: "output-id".to_string(),
                output_name: "DP-1".to_string(),
                capture_identifier: "cap".to_string(),
                kind: "native".to_string(),
                x11_class: "Foot".to_string(),
                x11_instance: "foot".to_string(),
            }],
        }
    }

    fn focus(window_id: u32) -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id: Some(window_id + 1),
            window_id: Some(window_id),
        }
    }

    #[test]
    fn refresh_domain_chunk_cache_keeps_clean_chunks() {
        let mut chunks = chunks();
        let messages = vec![output_geometry(1920), window_list(4), focus(9)];
        refresh_domain_chunk_cache(&mut chunks, 0, &messages, true).unwrap();
        let output_chunk = chunks[0].clone();
        let window_chunk = chunks[1].clone();
        let focus_chunk = chunks[2].clone();
        assert!(!output_chunk.is_empty());
        assert!(!window_chunk.is_empty());
        assert!(!focus_chunk.is_empty());

        let messages = vec![output_geometry(2560), window_list(4), focus(9)];
        refresh_domain_chunk_cache(
            &mut chunks,
            shell_wire::SHELL_SNAPSHOT_DOMAIN_OUTPUTS,
            &messages,
            false,
        )
        .unwrap();

        assert_ne!(chunks[0], output_chunk);
        assert_eq!(chunks[1], window_chunk);
        assert_eq!(chunks[2], focus_chunk);
    }

    #[test]
    fn encode_payload_chunks_keeps_full_payload_from_cached_chunks() {
        let mut chunks = chunks();
        refresh_domain_chunk_cache(
            &mut chunks,
            shell_wire::SHELL_SNAPSHOT_DOMAIN_OUTPUTS,
            &[output_geometry(1920), window_list(1)],
            true,
        )
        .unwrap();
        let mut revisions = [0u64; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT];
        revisions[0] = 1;
        let payload = encode_payload_chunks(&revisions, &chunks, &delta_chunks()).unwrap();
        let header_len = shell_wire::SHELL_SNAPSHOT_DOMAIN_REVISION_BYTES;
        assert_eq!(
            u32::from_le_bytes(payload[header_len..header_len + 4].try_into().unwrap()),
            SNAPSHOT_DOMAIN_CHUNKS_MAGIC
        );
        assert_eq!(
            u32::from_le_bytes(payload[header_len + 4..header_len + 8].try_into().unwrap()),
            2
        );
    }

    #[test]
    fn encode_dirty_snapshot_payload_keeps_only_changed_chunks() {
        let mut chunks = chunks();
        refresh_domain_chunk_cache(
            &mut chunks,
            0,
            &[output_geometry(1920), window_list(1), focus(9)],
            true,
        )
        .unwrap();
        let mut revisions = [0u64; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT];
        revisions[0] = 2;
        revisions[1] = 7;
        revisions[2] = 3;
        let payload = encode_payload_chunks(&revisions, &chunks, &delta_chunks()).unwrap();
        let mut previous = revisions;
        previous[0] = 1;
        previous[2] = 2;
        let (flags, dirty_payload) = encode_dirty_snapshot_payload(&payload, &previous).unwrap();
        let header_len = shell_wire::SHELL_SNAPSHOT_DOMAIN_REVISION_BYTES;
        assert_eq!(
            flags,
            shell_wire::SHELL_SNAPSHOT_DOMAIN_OUTPUTS | shell_wire::SHELL_SNAPSHOT_DOMAIN_FOCUS
        );
        assert_eq!(
            u32::from_le_bytes(
                dirty_payload[header_len + 4..header_len + 8]
                    .try_into()
                    .unwrap()
            ),
            2
        );
        assert_eq!(
            u32::from_le_bytes(
                dirty_payload[header_len + 8..header_len + 12]
                    .try_into()
                    .unwrap()
            ),
            shell_wire::SHELL_SNAPSHOT_DOMAIN_OUTPUTS
        );
    }

    #[test]
    fn encode_dirty_snapshot_payload_preserves_revision_prefix_when_no_chunks_changed() {
        let mut chunks = chunks();
        refresh_domain_chunk_cache(&mut chunks, 0, &[output_geometry(1920)], true).unwrap();
        let mut revisions = [0u64; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT];
        revisions[0] = 5;
        let payload = encode_payload_chunks(&revisions, &chunks, &delta_chunks()).unwrap();
        let (flags, dirty_payload) = encode_dirty_snapshot_payload(&payload, &revisions).unwrap();
        let header_len = shell_wire::SHELL_SNAPSHOT_DOMAIN_REVISION_BYTES;
        assert_eq!(flags, 0);
        assert_eq!(
            u64::from_le_bytes(dirty_payload[0..8].try_into().unwrap()),
            5
        );
        assert_eq!(
            u32::from_le_bytes(
                dirty_payload[header_len + 4..header_len + 8]
                    .try_into()
                    .unwrap()
            ),
            0
        );
    }

    #[test]
    fn encode_dirty_snapshot_payload_prefers_delta_chunk() {
        let mut chunks = chunks();
        refresh_domain_chunk_cache(&mut chunks, 0, &[output_geometry(1920)], true).unwrap();
        let mut deltas = delta_chunks();
        append_snapshot_message(&mut deltas[0], &output_geometry(2560)).unwrap();
        let mut revisions = [0u64; shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT];
        revisions[0] = 6;
        let payload = encode_payload_chunks(&revisions, &chunks, &deltas).unwrap();
        let mut previous = revisions;
        previous[0] = 5;
        let (flags, dirty_payload) = encode_dirty_snapshot_payload(&payload, &previous).unwrap();
        let header_len = shell_wire::SHELL_SNAPSHOT_DOMAIN_REVISION_BYTES;
        assert_eq!(flags, shell_wire::SHELL_SNAPSHOT_DOMAIN_OUTPUTS);
        assert_eq!(
            u32::from_le_bytes(
                dirty_payload[header_len + 4..header_len + 8]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u32::from_le_bytes(
                dirty_payload[header_len + 8..header_len + 12]
                    .try_into()
                    .unwrap()
            ),
            shell_wire::SHELL_SNAPSHOT_DOMAIN_OUTPUTS
        );
        let chunk_len = u32::from_le_bytes(
            dirty_payload[header_len + 12..header_len + 16]
                .try_into()
                .unwrap(),
        ) as usize;
        let chunk_start = header_len + 16;
        assert_eq!(chunk_len, deltas[0].len());
        assert_eq!(
            u32::from_le_bytes(
                dirty_payload[chunk_start + 8..chunk_start + 12]
                    .try_into()
                    .unwrap()
            ),
            2560
        );
    }
}
