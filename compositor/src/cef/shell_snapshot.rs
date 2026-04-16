use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{fence, Ordering};
use std::sync::{Mutex, OnceLock};

#[cfg(unix)]
use std::os::fd::AsRawFd;

const SNAPSHOT_CAPACITY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Default)]
struct SnapshotState {
    output_geometry: Option<shell_wire::DecodedCompositorToShellMessage>,
    output_layout: Option<shell_wire::DecodedCompositorToShellMessage>,
    windows: BTreeMap<u32, shell_wire::ShellWindowSnapshot>,
    focus_changed: Option<shell_wire::DecodedCompositorToShellMessage>,
    workspace_state_json: Option<String>,
    shell_hosted_app_state_json: Option<String>,
    keyboard_layout: Option<String>,
    volume_overlay: Option<(u16, bool, bool)>,
    tray_hints: Option<(u32, i32, u32)>,
    tray_sni: Option<Vec<shell_wire::TraySniItemWire>>,
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
    state: SnapshotState,
    sequence: u64,
}

impl SharedShellSnapshotWriter {
    fn stable_shell_flags(prev: Option<&shell_wire::ShellWindowSnapshot>) -> u32 {
        prev.map(|row| row.shell_flags).unwrap_or(0)
    }

    pub fn new(runtime_dir: PathBuf) -> Result<Self, String> {
        let path = runtime_dir.join(format!("derp-shell-snapshot-{}.bin", std::process::id()));
        let mut mmap = SharedMmapFile::create(&path, SNAPSHOT_CAPACITY_BYTES)?;
        mmap.as_slice_mut().fill(0);
        let mut this = Self {
            path,
            mmap,
            state: SnapshotState::default(),
            sequence: 0,
        };
        this.publish()?;
        Ok(this)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn apply_message(
        &mut self,
        msg: &shell_wire::DecodedCompositorToShellMessage,
    ) -> Result<bool, String> {
        let changed = match msg {
            shell_wire::DecodedCompositorToShellMessage::OutputGeometry { .. } => {
                self.state.output_geometry = Some(msg.clone());
                true
            }
            shell_wire::DecodedCompositorToShellMessage::OutputLayout { .. } => {
                self.state.output_layout = Some(msg.clone());
                true
            }
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
            } => {
                let prev = self.state.windows.get(window_id);
                self.state.windows.insert(
                    *window_id,
                    shell_wire::ShellWindowSnapshot {
                        window_id: *window_id,
                        surface_id: *surface_id,
                        stack_z: prev.map(|w| w.stack_z).unwrap_or(*window_id),
                        x: *x,
                        y: *y,
                        w: *w,
                        h: *h,
                        minimized: prev.map(|w| w.minimized).unwrap_or(0),
                        maximized: prev.map(|w| w.maximized).unwrap_or(0),
                        fullscreen: prev.map(|w| w.fullscreen).unwrap_or(0),
                        client_side_decoration: if *client_side_decoration { 1 } else { 0 },
                        shell_flags: Self::stable_shell_flags(prev),
                        title: title.clone(),
                        app_id: app_id.clone(),
                        output_name: output_name.clone(),
                        capture_identifier: prev
                            .map(|w| w.capture_identifier.clone())
                            .unwrap_or_default(),
                    },
                );
                true
            }
            shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { window_id } => {
                self.state.windows.remove(window_id).is_some()
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
            } => {
                let prev = self.state.windows.get(window_id);
                self.state.windows.insert(
                    *window_id,
                    shell_wire::ShellWindowSnapshot {
                        window_id: *window_id,
                        surface_id: *surface_id,
                        stack_z: prev.map(|row| row.stack_z).unwrap_or(*window_id),
                        x: *x,
                        y: *y,
                        w: *w,
                        h: *h,
                        minimized: prev.map(|row| row.minimized).unwrap_or(0),
                        maximized: if *maximized { 1 } else { 0 },
                        fullscreen: if *fullscreen { 1 } else { 0 },
                        client_side_decoration: if *client_side_decoration { 1 } else { 0 },
                        shell_flags: Self::stable_shell_flags(prev),
                        title: prev.map(|row| row.title.clone()).unwrap_or_default(),
                        app_id: prev.map(|row| row.app_id.clone()).unwrap_or_default(),
                        output_name: output_name.clone(),
                        capture_identifier: prev
                            .map(|row| row.capture_identifier.clone())
                            .unwrap_or_default(),
                    },
                );
                true
            }
            shell_wire::DecodedCompositorToShellMessage::WindowMetadata {
                window_id,
                surface_id,
                title,
                app_id,
            } => {
                let prev = self.state.windows.get(window_id);
                self.state.windows.insert(
                    *window_id,
                    shell_wire::ShellWindowSnapshot {
                        window_id: *window_id,
                        surface_id: *surface_id,
                        stack_z: prev.map(|row| row.stack_z).unwrap_or(*window_id),
                        x: prev.map(|row| row.x).unwrap_or(0),
                        y: prev.map(|row| row.y).unwrap_or(0),
                        w: prev.map(|row| row.w).unwrap_or(0),
                        h: prev.map(|row| row.h).unwrap_or(0),
                        minimized: prev.map(|row| row.minimized).unwrap_or(0),
                        maximized: prev.map(|row| row.maximized).unwrap_or(0),
                        fullscreen: prev.map(|row| row.fullscreen).unwrap_or(0),
                        client_side_decoration: prev
                            .map(|row| row.client_side_decoration)
                            .unwrap_or(0),
                        shell_flags: Self::stable_shell_flags(prev),
                        title: title.clone(),
                        app_id: app_id.clone(),
                        output_name: prev.map(|row| row.output_name.clone()).unwrap_or_default(),
                        capture_identifier: prev
                            .map(|row| row.capture_identifier.clone())
                            .unwrap_or_default(),
                    },
                );
                true
            }
            shell_wire::DecodedCompositorToShellMessage::FocusChanged { .. } => {
                self.state.focus_changed = Some(msg.clone());
                true
            }
            shell_wire::DecodedCompositorToShellMessage::WorkspaceState { state_json } => {
                self.state.workspace_state_json = Some(state_json.clone());
                true
            }
            shell_wire::DecodedCompositorToShellMessage::ShellHostedAppState { state_json } => {
                self.state.shell_hosted_app_state_json = Some(state_json.clone());
                true
            }
            shell_wire::DecodedCompositorToShellMessage::WindowList { windows } => {
                self.state.windows.clear();
                for window in windows {
                    self.state.windows.insert(window.window_id, window.clone());
                }
                true
            }
            shell_wire::DecodedCompositorToShellMessage::WindowState {
                window_id,
                minimized,
            } => {
                let Some(window) = self.state.windows.get_mut(window_id) else {
                    return Ok(false);
                };
                window.minimized = if *minimized { 1 } else { 0 };
                true
            }
            shell_wire::DecodedCompositorToShellMessage::KeyboardLayout { label } => {
                self.state.keyboard_layout = Some(label.clone());
                true
            }
            shell_wire::DecodedCompositorToShellMessage::VolumeOverlay {
                volume_linear_percent_x100,
                muted,
                state_known,
            } => {
                self.state.volume_overlay =
                    Some((*volume_linear_percent_x100, *muted, *state_known));
                true
            }
            shell_wire::DecodedCompositorToShellMessage::TrayHints {
                slot_count,
                slot_w,
                reserved_w,
            } => {
                self.state.tray_hints = Some((*slot_count, *slot_w, *reserved_w));
                true
            }
            shell_wire::DecodedCompositorToShellMessage::TraySni { items } => {
                self.state.tray_sni = Some(items.clone());
                true
            }
            _ => false,
        };
        if changed {
            self.publish()?;
        }
        Ok(changed)
    }

    fn publish(&mut self) -> Result<(), String> {
        let payload = self.encode_payload()?;
        let header_len = shell_wire::SHELL_SHARED_SNAPSHOT_HEADER_BYTES as usize;
        if payload.len() + header_len > self.mmap.len {
            return Err(format!("snapshot payload too large: {}", payload.len()));
        }
        let start_seq = self.sequence.wrapping_add(1) | 1;
        let end_seq = start_seq.wrapping_add(1);
        let buf = self.mmap.as_slice_mut();
        shell_wire::write_shared_snapshot_header(&mut buf[..header_len], start_seq, 0, 0)?;
        fence(Ordering::Release);
        buf[header_len..header_len + payload.len()].copy_from_slice(&payload);
        if header_len + payload.len() < buf.len() {
            buf[header_len + payload.len()..].fill(0);
        }
        fence(Ordering::Release);
        shell_wire::write_shared_snapshot_header(
            &mut buf[..header_len],
            end_seq,
            payload.len() as u32,
            0,
        )?;
        fence(Ordering::Release);
        self.sequence = end_seq;
        Ok(())
    }

    fn encode_payload(&self) -> Result<Vec<u8>, String> {
        let mut payload = Vec::new();
        if let Some(shell_wire::DecodedCompositorToShellMessage::OutputGeometry {
            logical_w,
            logical_h,
            physical_w,
            physical_h,
        }) = &self.state.output_geometry
        {
            payload.extend_from_slice(&shell_wire::encode_output_geometry(
                *logical_w,
                *logical_h,
                *physical_w,
                *physical_h,
            ));
        }
        if let Some(shell_wire::DecodedCompositorToShellMessage::OutputLayout {
            canvas_logical_w,
            canvas_logical_h,
            canvas_physical_w,
            canvas_physical_h,
            context_menu_atlas_buffer_h,
            screens,
            shell_chrome_primary,
        }) = &self.state.output_layout
        {
            if let Some(bytes) = shell_wire::encode_output_layout(
                *canvas_logical_w,
                *canvas_logical_h,
                *canvas_physical_w,
                *canvas_physical_h,
                *context_menu_atlas_buffer_h,
                screens,
                shell_chrome_primary.as_deref(),
            ) {
                payload.extend_from_slice(&bytes);
            }
        }
        let windows: Vec<_> = self.state.windows.values().cloned().collect();
        if let Some(bytes) = shell_wire::encode_window_list(&windows) {
            payload.extend_from_slice(&bytes);
        }
        if let Some(shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id,
            window_id,
        }) = &self.state.focus_changed
        {
            payload.extend_from_slice(&shell_wire::encode_focus_changed(*surface_id, *window_id));
        }
        if let Some(state_json) = &self.state.workspace_state_json {
            if let Some(bytes) = shell_wire::encode_compositor_workspace_state(state_json) {
                payload.extend_from_slice(&bytes);
            }
        }
        if let Some(state_json) = &self.state.shell_hosted_app_state_json {
            if let Some(bytes) = shell_wire::encode_compositor_shell_hosted_app_state(state_json) {
                payload.extend_from_slice(&bytes);
            }
        }
        if let Some(label) = &self.state.keyboard_layout {
            if let Some(bytes) = shell_wire::encode_compositor_keyboard_layout(label) {
                payload.extend_from_slice(&bytes);
            }
        }
        if let Some((volume_linear_percent_x100, muted, state_known)) = self.state.volume_overlay {
            payload.extend_from_slice(&shell_wire::encode_compositor_volume_overlay(
                volume_linear_percent_x100,
                muted,
                state_known,
            ));
        }
        if let Some((slot_count, slot_w, reserved_w)) = self.state.tray_hints {
            payload.extend_from_slice(&shell_wire::encode_compositor_tray_hints(
                slot_count, slot_w, reserved_w,
            ));
        }
        if let Some(items) = &self.state.tray_sni {
            let bytes = shell_wire::encode_compositor_tray_sni(items)
                .ok_or_else(|| "encode tray sni snapshot".to_string())?;
            payload.extend_from_slice(&bytes);
        }
        Ok(payload)
    }
}

pub fn snapshot_version(path: &Path, expected_abi: u32) -> Result<Option<u64>, String> {
    #[cfg(not(unix))]
    {
        let _ = (path, expected_abi);
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
    if header.magic != shell_wire::SHELL_SHARED_SNAPSHOT_MAGIC
        || header.abi_version != expected_abi
        || header.sequence % 2 != 0
    {
        return Ok(None);
    }
    Ok(Some(header.sequence))
}

pub fn snapshot_read(path: &Path, expected_abi: u32) -> Result<Option<Vec<u8>>, String> {
    #[cfg(not(unix))]
    {
        let _ = (path, expected_abi);
        return Err("shared snapshots require unix reads".to_string());
    }
    let header_len = shell_wire::SHELL_SHARED_SNAPSHOT_HEADER_BYTES as usize;
    #[cfg(unix)]
    {
        let mut cache = snapshot_read_cache()
            .lock()
            .map_err(|_| format!("snapshot cache lock poisoned {}", path.display()))?;
        let mapped = cache.mapped_slice(path)?;
        let head_a_bytes = mapped_snapshot_header(mapped)?;
        let head_a = shell_wire::read_shared_snapshot_header(&head_a_bytes)?;
        if head_a.magic != shell_wire::SHELL_SHARED_SNAPSHOT_MAGIC
            || head_a.abi_version != expected_abi
            || head_a.sequence % 2 != 0
        {
            return Ok(None);
        }
        let payload_len = head_a.payload_len as usize;
        if header_len + payload_len > mapped.len() {
            return Ok(None);
        }
        fence(Ordering::Acquire);
        let mut out = Vec::with_capacity(header_len + payload_len);
        out.extend_from_slice(&head_a_bytes);
        out.extend_from_slice(&mapped[header_len..header_len + payload_len]);
        fence(Ordering::Acquire);
        let head_b_bytes = mapped_snapshot_header(mapped)?;
        let head_b = shell_wire::read_shared_snapshot_header(&head_b_bytes)?;
        if head_a.sequence != head_b.sequence || head_b.sequence % 2 != 0 {
            return Ok(None);
        }
        Ok(Some(out))
    }
}

pub fn snapshot_read_if_changed(
    path: &Path,
    expected_abi: u32,
    last_sequence: u64,
) -> Result<Option<Vec<u8>>, String> {
    #[cfg(not(unix))]
    {
        let _ = (path, expected_abi, last_sequence);
        return Err("shared snapshots require unix reads".to_string());
    }
    let header_len = shell_wire::SHELL_SHARED_SNAPSHOT_HEADER_BYTES as usize;
    #[cfg(unix)]
    {
        let mut cache = snapshot_read_cache()
            .lock()
            .map_err(|_| format!("snapshot cache lock poisoned {}", path.display()))?;
        let mapped = cache.mapped_slice(path)?;
        let head_a_bytes = mapped_snapshot_header(mapped)?;
        let head_a = shell_wire::read_shared_snapshot_header(&head_a_bytes)?;
        if head_a.magic != shell_wire::SHELL_SHARED_SNAPSHOT_MAGIC
            || head_a.abi_version != expected_abi
            || head_a.sequence % 2 != 0
            || head_a.sequence == last_sequence
        {
            return Ok(None);
        }
        let payload_len = head_a.payload_len as usize;
        if header_len + payload_len > mapped.len() {
            return Ok(None);
        }
        fence(Ordering::Acquire);
        let mut out = Vec::with_capacity(header_len + payload_len);
        out.extend_from_slice(&head_a_bytes);
        out.extend_from_slice(&mapped[header_len..header_len + payload_len]);
        fence(Ordering::Acquire);
        let head_b_bytes = mapped_snapshot_header(mapped)?;
        let head_b = shell_wire::read_shared_snapshot_header(&head_b_bytes)?;
        if head_a.sequence != head_b.sequence || head_b.sequence % 2 != 0 {
            return Ok(None);
        }
        Ok(Some(out))
    }
}
