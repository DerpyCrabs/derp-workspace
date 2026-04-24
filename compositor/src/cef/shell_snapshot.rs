use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{fence, Ordering};
use std::sync::{Mutex, OnceLock};

use crate::cef::shell_snapshot_model::{snapshot_dirty_domains, ShellSnapshotModel};

#[cfg(unix)]
use std::os::fd::AsRawFd;

const SNAPSHOT_CAPACITY_BYTES: usize = 16 * 1024 * 1024;

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
        let dirty_domains = snapshot_dirty_domains(messages);
        for message in messages {
            self.authoritative.apply(message);
        }
        let authoritative_messages = self.authoritative.messages();
        warn_snapshot_invariants(&authoritative_messages);
        self.publish_payload_at(
            sequence,
            dirty_domains,
            encode_payload_messages(&authoritative_messages)?,
        )
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

fn encode_payload_messages(
    messages: &[shell_wire::DecodedCompositorToShellMessage],
) -> Result<Vec<u8>, String> {
    let mut payload = Vec::new();
    for msg in messages {
        append_snapshot_message(&mut payload, msg)?;
    }
    Ok(payload)
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
                shell_wire::encode_compositor_workspace_state(*revision, state_json),
                "workspace state",
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
