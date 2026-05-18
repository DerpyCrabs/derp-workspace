//! Wire format: `[u32 body_len LE][body]` where `body` is a single message.
//!
//! Spawn message body (`msg_type` [`MSG_SPAWN_WAYLAND_CLIENT`]):
//! - `u32 msg_type`, `u32 command_len`, then `command_len` UTF-8 bytes (no NUL).
//!
//! Compositor → shell process, same length-prefixed framing:
//! - [`MSG_COMPOSITOR_POINTER_MOVE`], [`MSG_COMPOSITOR_POINTER_BUTTON`], [`MSG_COMPOSITOR_POINTER_AXIS`], [`MSG_COMPOSITOR_KEY`], [`MSG_COMPOSITOR_TOUCH`]
//! - [`MSG_OUTPUT_GEOMETRY`]: logical size (DIP / layout) plus physical pixel size for HiDPI shell HUD math
//! - [`MSG_WINDOW_MAPPED`], [`MSG_WINDOW_UNMAPPED`], [`MSG_WINDOW_GEOMETRY`], [`MSG_WINDOW_METADATA`], [`MSG_FOCUS_CHANGED`]
//!
//! **Privacy:** the compositor never sends native Wayland client pixels or buffer contents to the shell.
//! Shell→compositor **`MSG_FRAME_DMABUF_COMMIT`** is metadata plus out-of-band fds, not client buffer pixels.
//!
//! **Dma-buf frames:** [`MSG_FRAME_DMABUF_COMMIT`] metadata travels in the length-prefixed body; **plane
//! fds must be sent in the same `sendmsg(2)`** as that packet using `SCM_RIGHTS` (see compositor and
//! `cef_host` helpers). Deploy **`compositor` and `cef_host` from the same tree** when this opcode changes.
//!
//! Shell → compositor (decoded by [`pop_message`]):
//! - [`MSG_SPAWN_WAYLAND_CLIENT`], [`MSG_FRAME_DMABUF_COMMIT`],
//!   [`MSG_SHELL_MOVE_BEGIN`], [`MSG_SHELL_MOVE_DELTA`], [`MSG_SHELL_MOVE_END`],
//!   [`MSG_SHELL_LIST_WINDOWS`], [`MSG_SHELL_SET_GEOMETRY`], [`MSG_SHELL_CLOSE`], [`MSG_SHELL_SET_FULLSCREEN`],
//!   [`MSG_SHELL_TASKBAR_ACTIVATE`], [`MSG_SHELL_MINIMIZE`], [`MSG_SHELL_QUIT_COMPOSITOR`],
//!   [`MSG_SHELL_RESIZE_BEGIN`], [`MSG_SHELL_RESIZE_DELTA`], [`MSG_SHELL_RESIZE_END`], [`MSG_SHELL_SET_MAXIMIZED`], [`MSG_SHELL_SET_PRESENTATION_FULLSCREEN`], [`MSG_SHELL_CONTEXT_MENU`], [`MSG_SHELL_TILE_PREVIEW`], [`MSG_SHELL_CHROME_METRICS`], [`MSG_SHELL_WINDOWS_SYNC`] (**breaking:** deploy `compositor` + `cef_host` + `shell_wire` together)
//! - compositor → shell: [`MSG_WINDOW_LIST`] rows include `shell_flags` ([`SHELL_WINDOW_FLAG_SHELL_HOSTED`] for compositor-backed OSR frames); [`MSG_FOCUS_CHANGED`] is the only compositor → shell focus event; [`MSG_WINDOW_STATE`]; [`MSG_OUTPUT_LAYOUT`]; [`MSG_COMPOSITOR_KEYBOARD_LAYOUT`]; [`MSG_COMPOSITOR_VOLUME_OVERLAY`]

mod wire_schema_generated;
pub use wire_schema_generated::*;

pub struct WireCursor<'a> {
    payload: &'a [u8],
    offset: usize,
}

impl<'a> WireCursor<'a> {
    pub fn new(payload: &'a [u8]) -> Self {
        Self { payload, offset: 0 }
    }

    pub fn read_u32(&mut self) -> Option<u32> {
        let bytes = self.payload.get(self.offset..self.offset.checked_add(4)?)?;
        self.offset += 4;
        Some(u32::from_le_bytes(bytes.try_into().ok()?))
    }

    pub fn read_i32(&mut self) -> Option<i32> {
        let bytes = self.payload.get(self.offset..self.offset.checked_add(4)?)?;
        self.offset += 4;
        Some(i32::from_le_bytes(bytes.try_into().ok()?))
    }

    pub fn read_u16(&mut self) -> Option<u16> {
        let bytes = self.payload.get(self.offset..self.offset.checked_add(2)?)?;
        self.offset += 2;
        Some(u16::from_le_bytes(bytes.try_into().ok()?))
    }

    pub fn read_u64(&mut self) -> Option<u64> {
        let bytes = self.payload.get(self.offset..self.offset.checked_add(8)?)?;
        self.offset += 8;
        Some(u64::from_le_bytes(bytes.try_into().ok()?))
    }

    pub fn read_bytes(&mut self, len: usize) -> Option<&'a [u8]> {
        let bytes = self
            .payload
            .get(self.offset..self.offset.checked_add(len)?)?;
        self.offset += len;
        Some(bytes)
    }

    pub fn read_utf8(&mut self, len: usize) -> Option<Result<&'a str, std::str::Utf8Error>> {
        Some(std::str::from_utf8(self.read_bytes(len)?))
    }

    pub fn peek_u32_at(&self, offset: usize) -> Option<u32> {
        let bytes = self.payload.get(offset..offset.checked_add(4)?)?;
        Some(u32::from_le_bytes(bytes.try_into().ok()?))
    }

    pub fn set_offset(&mut self, offset: usize) -> Option<()> {
        if offset > self.payload.len() {
            return None;
        }
        self.offset = offset;
        Some(())
    }

    pub fn remaining(&self) -> usize {
        self.payload.len().saturating_sub(self.offset)
    }

    pub fn offset(&self) -> usize {
        self.offset
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SharedSnapshotHeader {
    pub magic: u32,
    pub payload_len: u32,
    pub flags: u32,
    pub sequence: u64,
}

pub fn write_shared_snapshot_header(
    dst: &mut [u8],
    sequence: u64,
    payload_len: u32,
    flags: u32,
) -> Result<(), String> {
    if dst.len() < SHELL_SHARED_SNAPSHOT_HEADER_BYTES as usize {
        return Err("shared snapshot header slice too small".to_string());
    }
    dst[..SHELL_SHARED_SNAPSHOT_HEADER_BYTES as usize].fill(0);
    dst[0..4].copy_from_slice(&SHELL_SHARED_SNAPSHOT_MAGIC.to_le_bytes());
    dst[8..12].copy_from_slice(&payload_len.to_le_bytes());
    dst[12..16].copy_from_slice(&flags.to_le_bytes());
    dst[16..24].copy_from_slice(&sequence.to_le_bytes());
    Ok(())
}

pub fn read_shared_snapshot_header(src: &[u8]) -> Result<SharedSnapshotHeader, String> {
    if src.len() < SHELL_SHARED_SNAPSHOT_HEADER_BYTES as usize {
        return Err("shared snapshot header slice too small".to_string());
    }
    let mut cursor = WireCursor::new(src);
    let magic = cursor
        .read_u32()
        .ok_or_else(|| "shared snapshot header slice too small".to_string())?;
    cursor
        .set_offset(8)
        .ok_or_else(|| "shared snapshot header slice too small".to_string())?;
    let payload_len = cursor
        .read_u32()
        .ok_or_else(|| "shared snapshot header slice too small".to_string())?;
    let flags = cursor
        .read_u32()
        .ok_or_else(|| "shared snapshot header slice too small".to_string())?;
    let sequence = cursor
        .read_u64()
        .ok_or_else(|| "shared snapshot header slice too small".to_string())?;
    Ok(SharedSnapshotHeader {
        magic,
        payload_len,
        flags,
        sequence,
    })
}

/// Full length-prefixed wire packet for [`MSG_FRAME_DMABUF_COMMIT`] (fds attached out-of-band).
pub fn encode_frame_dmabuf_commit(
    width: u32,
    height: u32,
    drm_format: u32,
    modifier: u64,
    flags: u32,
    generation: u32,
    planes: &[FrameDmabufPlane],
) -> Option<Vec<u8>> {
    let n = u32::try_from(planes.len()).ok()?;
    if n == 0 || n > MAX_DMABUF_PLANES {
        return None;
    }
    let body_len = 36u32.checked_add(n.checked_mul(16)?)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_FRAME_DMABUF_COMMIT.to_le_bytes());
    v.extend_from_slice(&width.to_le_bytes());
    v.extend_from_slice(&height.to_le_bytes());
    v.extend_from_slice(&drm_format.to_le_bytes());
    v.extend_from_slice(&modifier.to_le_bytes());
    v.extend_from_slice(&n.to_le_bytes());
    v.extend_from_slice(&flags.to_le_bytes());
    v.extend_from_slice(&generation.to_le_bytes());
    for p in planes {
        v.extend_from_slice(&p.plane_idx.to_le_bytes());
        v.extend_from_slice(&p.stride.to_le_bytes());
        v.extend_from_slice(&p.offset.to_le_bytes());
    }
    Some(v)
}

pub fn encode_spawn_wayland_client(command: &str) -> Option<Vec<u8>> {
    let b = command.as_bytes();
    if b.is_empty() || b.contains(&0) {
        return None;
    }
    let cmd_len = u32::try_from(b.len()).ok()?;
    if cmd_len > MAX_SPAWN_COMMAND_BYTES {
        return None;
    }
    let header = 4u32 * 2;
    let body_len = header.checked_add(cmd_len)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SPAWN_WAYLAND_CLIENT.to_le_bytes());
    v.extend_from_slice(&cmd_len.to_le_bytes());
    v.extend_from_slice(b);
    Some(v)
}

/// `physical_w` / `physical_h` are winit [`inner_size`] / DRM mode pixels — OSR device pixels for this output.
pub fn encode_output_geometry(
    logical_w: u32,
    logical_h: u32,
    physical_w: u32,
    physical_h: u32,
) -> Vec<u8> {
    let body_len = 20u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_OUTPUT_GEOMETRY.to_le_bytes());
    v.extend_from_slice(&logical_w.to_le_bytes());
    v.extend_from_slice(&logical_h.to_le_bytes());
    v.extend_from_slice(&physical_w.to_le_bytes());
    v.extend_from_slice(&physical_h.to_le_bytes());
    v
}

pub fn encode_output_layout(
    revision: u64,
    canvas_logical_w: u32,
    canvas_logical_h: u32,
    canvas_physical_w: u32,
    canvas_physical_h: u32,
    screens: &[OutputLayoutScreen],
    shell_chrome_primary: Option<&str>,
    taskbar_auto_hide: bool,
) -> Option<Vec<u8>> {
    let n = u32::try_from(screens.len()).ok()?;
    if n == 0 || n > MAX_OUTPUT_LAYOUT_SCREENS {
        return None;
    }
    let prim_bytes: &[u8] = match shell_chrome_primary {
        None => &[],
        Some(s) if s.is_empty() => &[],
        Some(s) => {
            let b = s.as_bytes();
            if b.is_empty() || b.len() > MAX_OUTPUT_LAYOUT_NAME_BYTES as usize {
                return None;
            }
            b
        }
    };
    let mut body_sz: usize = 4 + 8 + 16 + 4;
    for s in screens {
        let nl = u32::try_from(s.name.as_bytes().len()).ok()?;
        let il = u32::try_from(s.identity.as_bytes().len()).ok()?;
        if nl == 0 || nl > MAX_OUTPUT_LAYOUT_NAME_BYTES || il > MAX_OUTPUT_LAYOUT_NAME_BYTES {
            return None;
        }
        if s.taskbar_side > TASKBAR_SIDE_RIGHT {
            return None;
        }
        body_sz = body_sz
            .checked_add(4)?
            .checked_add(nl as usize)?
            .checked_add(4)?
            .checked_add(il as usize)?
            .checked_add(40)?;
    }
    body_sz = body_sz.checked_add(4)?.checked_add(prim_bytes.len())?;
    body_sz = body_sz.checked_add(8)?;
    for s in screens {
        let nl = u32::try_from(s.name.as_bytes().len()).ok()?;
        body_sz = body_sz
            .checked_add(4)?
            .checked_add(nl as usize)?
            .checked_add(4)?;
    }
    body_sz = body_sz.checked_add(4)?;
    for s in screens {
        let nl = u32::try_from(s.name.as_bytes().len()).ok()?;
        body_sz = body_sz
            .checked_add(4)?
            .checked_add(nl as usize)?
            .checked_add(16)?;
    }
    body_sz = body_sz.checked_add(4)?;
    for s in screens {
        let nl = u32::try_from(s.name.as_bytes().len()).ok()?;
        body_sz = body_sz
            .checked_add(4)?
            .checked_add(nl as usize)?
            .checked_add(4)?;
    }
    let body_len = u32::try_from(body_sz).ok()?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_sz);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_OUTPUT_LAYOUT.to_le_bytes());
    v.extend_from_slice(&revision.to_le_bytes());
    v.extend_from_slice(&canvas_logical_w.to_le_bytes());
    v.extend_from_slice(&canvas_logical_h.to_le_bytes());
    v.extend_from_slice(&canvas_physical_w.to_le_bytes());
    v.extend_from_slice(&canvas_physical_h.to_le_bytes());
    v.extend_from_slice(&n.to_le_bytes());
    for s in screens {
        let nb = s.name.as_bytes();
        let nl = nb.len() as u32;
        let ib = s.identity.as_bytes();
        let il = ib.len() as u32;
        v.extend_from_slice(&nl.to_le_bytes());
        v.extend_from_slice(nb);
        v.extend_from_slice(&il.to_le_bytes());
        v.extend_from_slice(ib);
        v.extend_from_slice(&s.x.to_le_bytes());
        v.extend_from_slice(&s.y.to_le_bytes());
        v.extend_from_slice(&s.w.to_le_bytes());
        v.extend_from_slice(&s.h.to_le_bytes());
        v.extend_from_slice(&s.transform.to_le_bytes());
        v.extend_from_slice(&s.refresh_milli_hz.to_le_bytes());
        v.extend_from_slice(&(if s.vrr_supported { 1u32 } else { 0u32 }).to_le_bytes());
        v.extend_from_slice(&(if s.vrr_enabled { 1u32 } else { 0u32 }).to_le_bytes());
        v.extend_from_slice(&s.physical_w.max(1).to_le_bytes());
        v.extend_from_slice(&s.physical_h.max(1).to_le_bytes());
    }
    let pl = u32::try_from(prim_bytes.len()).ok()?;
    v.extend_from_slice(&pl.to_le_bytes());
    v.extend_from_slice(prim_bytes);
    v.extend_from_slice(&(if taskbar_auto_hide { 1u32 } else { 0u32 }).to_le_bytes());
    v.extend_from_slice(&n.to_le_bytes());
    for s in screens {
        let nb = s.name.as_bytes();
        let nl = nb.len() as u32;
        v.extend_from_slice(&nl.to_le_bytes());
        v.extend_from_slice(nb);
        v.extend_from_slice(&s.taskbar_side.to_le_bytes());
    }
    v.extend_from_slice(&n.to_le_bytes());
    for s in screens {
        let nb = s.name.as_bytes();
        let nl = nb.len() as u32;
        v.extend_from_slice(&nl.to_le_bytes());
        v.extend_from_slice(nb);
        v.extend_from_slice(&s.usable_x.to_le_bytes());
        v.extend_from_slice(&s.usable_y.to_le_bytes());
        v.extend_from_slice(&s.usable_w.max(1).to_le_bytes());
        v.extend_from_slice(&s.usable_h.max(1).to_le_bytes());
    }
    v.extend_from_slice(&n.to_le_bytes());
    for s in screens {
        let nb = s.name.as_bytes();
        let nl = nb.len() as u32;
        let mut flags = 0u32;
        if s.taskbar_programs {
            flags |= 1;
        }
        if s.taskbar_osk {
            flags |= 2;
        }
        if s.taskbar_keyboard_layout {
            flags |= 4;
        }
        if s.taskbar_clock {
            flags |= 8;
        }
        v.extend_from_slice(&nl.to_le_bytes());
        v.extend_from_slice(nb);
        v.extend_from_slice(&flags.to_le_bytes());
    }
    Some(v)
}

pub fn encode_shell_set_output_layout_json(json: &str) -> Option<Vec<u8>> {
    let b = json.as_bytes();
    let jl = u32::try_from(b.len()).ok()?;
    if jl == 0 || jl > MAX_SHELL_OUTPUT_LAYOUT_JSON_BYTES {
        return None;
    }
    let body_len = 8u32.checked_add(jl)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_SET_OUTPUT_LAYOUT.to_le_bytes());
    v.extend_from_slice(&jl.to_le_bytes());
    v.extend_from_slice(b);
    Some(v)
}

fn decode_output_layout_body(body: &[u8]) -> Result<DecodedCompositorToShellMessage, DecodeError> {
    if body.len() < 32 {
        return Err(DecodeError::BadOutputLayoutPayload);
    }
    let mut cursor = WireCursor::new(body);
    let msg = cursor
        .read_u32()
        .ok_or(DecodeError::BadOutputLayoutPayload)?;
    if msg != MSG_OUTPUT_LAYOUT {
        return Err(DecodeError::UnknownMsgType);
    }
    let revision = cursor
        .read_u64()
        .ok_or(DecodeError::BadOutputLayoutPayload)?;
    let canvas_logical_w = cursor
        .read_u32()
        .ok_or(DecodeError::BadOutputLayoutPayload)?;
    let canvas_logical_h = cursor
        .read_u32()
        .ok_or(DecodeError::BadOutputLayoutPayload)?;
    let canvas_physical_w = cursor
        .read_u32()
        .ok_or(DecodeError::BadOutputLayoutPayload)?;
    let canvas_physical_h = cursor
        .read_u32()
        .ok_or(DecodeError::BadOutputLayoutPayload)?;
    let count = cursor
        .read_u32()
        .ok_or(DecodeError::BadOutputLayoutPayload)?;
    if count == 0 || count > MAX_OUTPUT_LAYOUT_SCREENS {
        return Err(DecodeError::BadOutputLayoutPayload);
    }
    let mut screens = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let nl = cursor
            .read_u32()
            .ok_or(DecodeError::BadOutputLayoutPayload)? as usize;
        if nl == 0 || nl > MAX_OUTPUT_LAYOUT_NAME_BYTES as usize {
            return Err(DecodeError::BadOutputLayoutPayload);
        }
        let name = cursor
            .read_utf8(nl)
            .ok_or(DecodeError::BadOutputLayoutPayload)?
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        let il = cursor
            .read_u32()
            .ok_or(DecodeError::BadOutputLayoutPayload)? as usize;
        if il > MAX_OUTPUT_LAYOUT_NAME_BYTES as usize {
            return Err(DecodeError::BadOutputLayoutPayload);
        }
        let identity = cursor
            .read_utf8(il)
            .ok_or(DecodeError::BadOutputLayoutPayload)?
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        let fixed_len = {
            let off = cursor.offset();
            let remaining = cursor.remaining();
            let candidate_w = cursor
                .peek_u32_at(
                    off.checked_add(8)
                        .ok_or(DecodeError::BadOutputLayoutPayload)?,
                )
                .ok_or(DecodeError::BadOutputLayoutPayload)?;
            let candidate_h = cursor
                .peek_u32_at(
                    off.checked_add(12)
                        .ok_or(DecodeError::BadOutputLayoutPayload)?,
                )
                .ok_or(DecodeError::BadOutputLayoutPayload)?;
            let max_physical_w = canvas_physical_w.max(canvas_logical_w).max(candidate_w);
            let max_physical_h = canvas_physical_h.max(canvas_logical_h).max(candidate_h);
            let looks_like_physical_tail = remaining >= 40
                && cursor
                    .peek_u32_at(
                        off.checked_add(24)
                            .ok_or(DecodeError::BadOutputLayoutPayload)?,
                    )
                    .ok_or(DecodeError::BadOutputLayoutPayload)?
                    <= 1
                && cursor
                    .peek_u32_at(
                        off.checked_add(28)
                            .ok_or(DecodeError::BadOutputLayoutPayload)?,
                    )
                    .ok_or(DecodeError::BadOutputLayoutPayload)?
                    <= 1
                && (1..=max_physical_w.saturating_mul(8).max(1)).contains(
                    &cursor
                        .peek_u32_at(
                            off.checked_add(32)
                                .ok_or(DecodeError::BadOutputLayoutPayload)?,
                        )
                        .ok_or(DecodeError::BadOutputLayoutPayload)?,
                )
                && (1..=max_physical_h.saturating_mul(8).max(1)).contains(
                    &cursor
                        .peek_u32_at(
                            off.checked_add(36)
                                .ok_or(DecodeError::BadOutputLayoutPayload)?,
                        )
                        .ok_or(DecodeError::BadOutputLayoutPayload)?,
                );
            if looks_like_physical_tail {
                40
            } else if remaining >= 32 {
                32
            } else {
                24
            }
        };
        if cursor.remaining() < fixed_len {
            return Err(DecodeError::BadOutputLayoutPayload);
        }
        let x = cursor
            .read_i32()
            .ok_or(DecodeError::BadOutputLayoutPayload)?;
        let y = cursor
            .read_i32()
            .ok_or(DecodeError::BadOutputLayoutPayload)?;
        let w = cursor
            .read_u32()
            .ok_or(DecodeError::BadOutputLayoutPayload)?;
        let h = cursor
            .read_u32()
            .ok_or(DecodeError::BadOutputLayoutPayload)?;
        let transform = cursor
            .read_u32()
            .ok_or(DecodeError::BadOutputLayoutPayload)?;
        let refresh_milli_hz = cursor
            .read_u32()
            .ok_or(DecodeError::BadOutputLayoutPayload)?;
        let (vrr_supported, vrr_enabled) = if fixed_len >= 32 {
            let supported = cursor
                .read_u32()
                .ok_or(DecodeError::BadOutputLayoutPayload)?;
            let enabled = cursor
                .read_u32()
                .ok_or(DecodeError::BadOutputLayoutPayload)?;
            if supported > 1 || enabled > 1 || enabled > supported {
                return Err(DecodeError::BadOutputLayoutPayload);
            }
            (supported != 0, enabled != 0)
        } else {
            (false, false)
        };
        let (physical_w, physical_h) = if fixed_len == 40 {
            (
                cursor
                    .read_u32()
                    .ok_or(DecodeError::BadOutputLayoutPayload)?
                    .max(1),
                cursor
                    .read_u32()
                    .ok_or(DecodeError::BadOutputLayoutPayload)?
                    .max(1),
            )
        } else {
            (w.max(1), h.max(1))
        };
        screens.push(OutputLayoutScreen {
            name,
            identity,
            x,
            y,
            w,
            h,
            usable_x: x,
            usable_y: y,
            usable_w: w.max(1),
            usable_h: h.max(1),
            physical_w,
            physical_h,
            transform,
            refresh_milli_hz,
            vrr_supported,
            vrr_enabled,
            taskbar_side: TASKBAR_SIDE_BOTTOM,
            taskbar_programs: false,
            taskbar_osk: false,
            taskbar_keyboard_layout: false,
            taskbar_clock: false,
        });
    }
    let pl = cursor
        .read_u32()
        .ok_or(DecodeError::BadOutputLayoutPayload)? as usize;
    if pl > MAX_OUTPUT_LAYOUT_NAME_BYTES as usize {
        return Err(DecodeError::BadOutputLayoutPayload);
    }
    let shell_chrome_primary = if pl == 0 {
        None
    } else {
        Some(
            cursor
                .read_utf8(pl)
                .ok_or(DecodeError::BadOutputLayoutPayload)?
                .map_err(|_| DecodeError::BadUtf8Command)?
                .to_string(),
        )
    };
    if pl == 0 {
        cursor
            .read_bytes(0)
            .ok_or(DecodeError::BadOutputLayoutPayload)?;
    }
    let mut taskbar_auto_hide = false;
    if cursor.remaining() > 0 {
        let auto_hide = cursor
            .read_u32()
            .ok_or(DecodeError::BadOutputLayoutPayload)?;
        if auto_hide > 1 {
            return Err(DecodeError::BadOutputLayoutPayload);
        }
        taskbar_auto_hide = auto_hide != 0;
        let side_count = cursor
            .read_u32()
            .ok_or(DecodeError::BadOutputLayoutPayload)? as usize;
        if side_count > MAX_OUTPUT_LAYOUT_SCREENS as usize {
            return Err(DecodeError::BadOutputLayoutPayload);
        }
        for _ in 0..side_count {
            let nl = cursor
                .read_u32()
                .ok_or(DecodeError::BadOutputLayoutPayload)? as usize;
            if nl == 0 || nl > MAX_OUTPUT_LAYOUT_NAME_BYTES as usize {
                return Err(DecodeError::BadOutputLayoutPayload);
            }
            let name = cursor
                .read_utf8(nl)
                .ok_or(DecodeError::BadOutputLayoutPayload)?
                .map_err(|_| DecodeError::BadUtf8Command)?
                .to_string();
            let side = cursor
                .read_u32()
                .ok_or(DecodeError::BadOutputLayoutPayload)?;
            if side > TASKBAR_SIDE_RIGHT {
                return Err(DecodeError::BadOutputLayoutPayload);
            }
            if let Some(screen) = screens.iter_mut().find(|screen| screen.name == name) {
                screen.taskbar_side = side;
            }
        }
    }
    if cursor.remaining() > 0 {
        let usable_count = cursor
            .read_u32()
            .ok_or(DecodeError::BadOutputLayoutPayload)? as usize;
        if usable_count > MAX_OUTPUT_LAYOUT_SCREENS as usize {
            return Err(DecodeError::BadOutputLayoutPayload);
        }
        for _ in 0..usable_count {
            let nl = cursor
                .read_u32()
                .ok_or(DecodeError::BadOutputLayoutPayload)? as usize;
            if nl == 0 || nl > MAX_OUTPUT_LAYOUT_NAME_BYTES as usize {
                return Err(DecodeError::BadOutputLayoutPayload);
            }
            let name = cursor
                .read_utf8(nl)
                .ok_or(DecodeError::BadOutputLayoutPayload)?
                .map_err(|_| DecodeError::BadUtf8Command)?
                .to_string();
            let usable_x = cursor
                .read_i32()
                .ok_or(DecodeError::BadOutputLayoutPayload)?;
            let usable_y = cursor
                .read_i32()
                .ok_or(DecodeError::BadOutputLayoutPayload)?;
            let usable_w = cursor
                .read_u32()
                .ok_or(DecodeError::BadOutputLayoutPayload)?
                .max(1);
            let usable_h = cursor
                .read_u32()
                .ok_or(DecodeError::BadOutputLayoutPayload)?
                .max(1);
            if let Some(screen) = screens.iter_mut().find(|screen| screen.name == name) {
                screen.usable_x = usable_x;
                screen.usable_y = usable_y;
                screen.usable_w = usable_w;
                screen.usable_h = usable_h;
            }
        }
    }
    if cursor.remaining() > 0 {
        let component_count = cursor
            .read_u32()
            .ok_or(DecodeError::BadOutputLayoutPayload)? as usize;
        if component_count > MAX_OUTPUT_LAYOUT_SCREENS as usize {
            return Err(DecodeError::BadOutputLayoutPayload);
        }
        for _ in 0..component_count {
            let nl = cursor
                .read_u32()
                .ok_or(DecodeError::BadOutputLayoutPayload)? as usize;
            if nl == 0 || nl > MAX_OUTPUT_LAYOUT_NAME_BYTES as usize {
                return Err(DecodeError::BadOutputLayoutPayload);
            }
            let name = cursor
                .read_utf8(nl)
                .ok_or(DecodeError::BadOutputLayoutPayload)?
                .map_err(|_| DecodeError::BadUtf8Command)?
                .to_string();
            let flags = cursor
                .read_u32()
                .ok_or(DecodeError::BadOutputLayoutPayload)?;
            if flags & !15 != 0 {
                return Err(DecodeError::BadOutputLayoutPayload);
            }
            if let Some(screen) = screens.iter_mut().find(|screen| screen.name == name) {
                screen.taskbar_programs = flags & 1 != 0;
                screen.taskbar_osk = flags & 2 != 0;
                screen.taskbar_keyboard_layout = flags & 4 != 0;
                screen.taskbar_clock = flags & 8 != 0;
            }
        }
    }
    if cursor.remaining() != 0 {
        return Err(DecodeError::BadOutputLayoutPayload);
    }
    Ok(DecodedCompositorToShellMessage::OutputLayout {
        revision,
        canvas_logical_w: canvas_logical_w.max(1),
        canvas_logical_h: canvas_logical_h.max(1),
        canvas_physical_w: canvas_physical_w.max(1),
        canvas_physical_h: canvas_physical_h.max(1),
        screens,
        shell_chrome_primary,
        taskbar_auto_hide,
    })
}

fn encode_window_strings(
    msg_type: u32,
    window_id: u32,
    surface_id: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    title: &str,
    app_id: &str,
    icon_name: &str,
    icon_buffers: &[ShellWindowIconBufferSnapshot],
) -> Option<Vec<u8>> {
    let tb = title.as_bytes();
    let ab = app_id.as_bytes();
    let ib = icon_name.as_bytes();
    if tb.contains(&0) || ab.contains(&0) || ib.contains(&0) {
        return None;
    }
    let tl = u32::try_from(tb.len()).ok()?;
    let al = u32::try_from(ab.len()).ok()?;
    let il = u32::try_from(ib.len()).ok()?;
    let bl = u32::try_from(icon_buffers.len()).ok()?;
    if tl > MAX_WINDOW_STRING_BYTES
        || al > MAX_WINDOW_STRING_BYTES
        || il > MAX_WINDOW_STRING_BYTES
        || bl > MAX_WINDOW_ICON_BUFFERS
    {
        return None;
    }
    let header = 4u32 * 9;
    let body_len = header
        .checked_add(tl)?
        .checked_add(al)?
        .checked_add(8)?
        .checked_add(il)?
        .checked_add(bl.checked_mul(12)?)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&msg_type.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v.extend_from_slice(&surface_id.to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v.extend_from_slice(&tl.to_le_bytes());
    v.extend_from_slice(&al.to_le_bytes());
    v.extend_from_slice(tb);
    v.extend_from_slice(ab);
    v.extend_from_slice(&il.to_le_bytes());
    v.extend_from_slice(ib);
    v.extend_from_slice(&bl.to_le_bytes());
    for buffer in icon_buffers {
        v.extend_from_slice(&buffer.width.to_le_bytes());
        v.extend_from_slice(&buffer.height.to_le_bytes());
        v.extend_from_slice(&buffer.scale.to_le_bytes());
    }
    Some(v)
}

pub fn encode_window_mapped(
    window_id: u32,
    surface_id: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    title: &str,
    app_id: &str,
    client_side_decoration: bool,
    output_name: &str,
) -> Option<Vec<u8>> {
    let tb = title.as_bytes();
    let ab = app_id.as_bytes();
    let ob = output_name.as_bytes();
    if tb.contains(&0) || ab.contains(&0) || ob.contains(&0) {
        return None;
    }
    let tl = u32::try_from(tb.len()).ok()?;
    let al = u32::try_from(ab.len()).ok()?;
    let ol = u32::try_from(ob.len()).ok()?;
    if tl > MAX_WINDOW_STRING_BYTES || al > MAX_WINDOW_STRING_BYTES || ol > MAX_WINDOW_STRING_BYTES
    {
        return None;
    }
    let header = 4u32 * 9;
    let body_len = header
        .checked_add(tl)?
        .checked_add(al)?
        .checked_add(4)?
        .checked_add(4)?
        .checked_add(ol)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_WINDOW_MAPPED.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v.extend_from_slice(&surface_id.to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v.extend_from_slice(&tl.to_le_bytes());
    v.extend_from_slice(&al.to_le_bytes());
    v.extend_from_slice(tb);
    v.extend_from_slice(ab);
    v.extend_from_slice(&(if client_side_decoration { 1u32 } else { 0 }).to_le_bytes());
    v.extend_from_slice(&ol.to_le_bytes());
    v.extend_from_slice(ob);
    Some(v)
}

pub fn encode_window_unmapped(window_id: u32) -> Vec<u8> {
    let body_len = 8u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_WINDOW_UNMAPPED.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v
}

pub fn encode_window_geometry(
    window_id: u32,
    surface_id: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    client_x: i32,
    client_y: i32,
    client_w: i32,
    client_h: i32,
    frame_x: i32,
    frame_y: i32,
    frame_w: i32,
    frame_h: i32,
    maximized: bool,
    fullscreen: bool,
    client_side_decoration: bool,
    output_name: &str,
) -> Option<Vec<u8>> {
    let ob = output_name.as_bytes();
    if ob.contains(&0) {
        return None;
    }
    let ol = u32::try_from(ob.len()).ok()?;
    if ol > MAX_WINDOW_STRING_BYTES {
        return None;
    }
    let body_len = 40u32
        .checked_add(4)?
        .checked_add(ol)?
        .checked_add(WINDOW_GEOMETRY_RECTS_BYTES as u32)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_WINDOW_GEOMETRY.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v.extend_from_slice(&surface_id.to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v.extend_from_slice(&(if maximized { 1u32 } else { 0 }).to_le_bytes());
    v.extend_from_slice(&(if fullscreen { 1u32 } else { 0 }).to_le_bytes());
    v.extend_from_slice(&(if client_side_decoration { 1u32 } else { 0 }).to_le_bytes());
    v.extend_from_slice(&ol.to_le_bytes());
    v.extend_from_slice(ob);
    v.extend_from_slice(&WINDOW_GEOMETRY_RECTS_SCHEMA_VERSION.to_le_bytes());
    v.extend_from_slice(&client_x.to_le_bytes());
    v.extend_from_slice(&client_y.to_le_bytes());
    v.extend_from_slice(&client_w.to_le_bytes());
    v.extend_from_slice(&client_h.to_le_bytes());
    v.extend_from_slice(&frame_x.to_le_bytes());
    v.extend_from_slice(&frame_y.to_le_bytes());
    v.extend_from_slice(&frame_w.to_le_bytes());
    v.extend_from_slice(&frame_h.to_le_bytes());
    Some(v)
}

pub fn encode_window_metadata(
    window_id: u32,
    surface_id: u32,
    title: &str,
    app_id: &str,
    icon_name: &str,
    icon_buffers: &[ShellWindowIconBufferSnapshot],
) -> Option<Vec<u8>> {
    encode_window_strings(
        MSG_WINDOW_METADATA,
        window_id,
        surface_id,
        0,
        0,
        0,
        0,
        title,
        app_id,
        icon_name,
        icon_buffers,
    )
}

pub fn encode_focus_changed(surface_id: Option<u32>, window_id: Option<u32>) -> Vec<u8> {
    let body_len = 12u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_FOCUS_CHANGED.to_le_bytes());
    v.extend_from_slice(&surface_id.unwrap_or(0).to_le_bytes());
    v.extend_from_slice(&window_id.unwrap_or(0).to_le_bytes());
    v
}

pub fn encode_shell_move_begin(window_id: u32) -> Vec<u8> {
    let body_len = 8u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_MOVE_BEGIN.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v
}

pub fn encode_shell_move_delta(dx: i32, dy: i32) -> Vec<u8> {
    let body_len = 12u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_MOVE_DELTA.to_le_bytes());
    v.extend_from_slice(&dx.to_le_bytes());
    v.extend_from_slice(&dy.to_le_bytes());
    v
}

pub fn encode_shell_move_end(window_id: u32) -> Vec<u8> {
    let body_len = 8u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_MOVE_END.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v
}

pub fn encode_shell_resize_begin(window_id: u32, edges: u32) -> Option<Vec<u8>> {
    if edges == 0 || edges > 15 {
        return None;
    }
    let body_len = 12u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_RESIZE_BEGIN.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v.extend_from_slice(&edges.to_le_bytes());
    Some(v)
}

pub fn encode_shell_resize_delta(dx: i32, dy: i32) -> Vec<u8> {
    let body_len = 12u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_RESIZE_DELTA.to_le_bytes());
    v.extend_from_slice(&dx.to_le_bytes());
    v.extend_from_slice(&dy.to_le_bytes());
    v
}

pub fn encode_shell_resize_end(window_id: u32) -> Vec<u8> {
    let body_len = 8u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_RESIZE_END.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v
}

pub fn encode_window_list(revision: u64, windows: &[ShellWindowSnapshot]) -> Option<Vec<u8>> {
    let count = u32::try_from(windows.len()).ok()?;
    if count > MAX_WINDOW_LIST_ENTRIES {
        return None;
    }
    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(&MSG_WINDOW_LIST.to_le_bytes());
    body.extend_from_slice(&revision.to_le_bytes());
    body.extend_from_slice(&count.to_le_bytes());
    body.extend_from_slice(&WINDOW_LIST_SCHEMA_VERSION.to_le_bytes());
    body.extend_from_slice(&(WINDOW_LIST_ROW_BYTES as u32).to_le_bytes());
    for w in windows {
        let tb = w.title.as_bytes();
        let ab = w.app_id.as_bytes();
        let ib = w.output_id.as_bytes();
        let ob = w.output_name.as_bytes();
        let cb = w.capture_identifier.as_bytes();
        let kb = w.kind.as_bytes();
        let xcb = w.x11_class.as_bytes();
        let xib = w.x11_instance.as_bytes();
        let inb = w.icon_name.as_bytes();
        if tb.len() > MAX_WINDOW_STRING_BYTES as usize
            || ab.len() > MAX_WINDOW_STRING_BYTES as usize
            || ib.len() > MAX_WINDOW_STRING_BYTES as usize
            || ob.len() > MAX_WINDOW_STRING_BYTES as usize
            || cb.len() > MAX_WINDOW_STRING_BYTES as usize
            || kb.len() > MAX_WINDOW_STRING_BYTES as usize
            || xcb.len() > MAX_WINDOW_STRING_BYTES as usize
            || xib.len() > MAX_WINDOW_STRING_BYTES as usize
            || inb.len() > MAX_WINDOW_STRING_BYTES as usize
            || w.icon_buffers.len() > MAX_WINDOW_ICON_BUFFERS as usize
        {
            return None;
        }
        let tl = u32::try_from(tb.len()).ok()?;
        let al = u32::try_from(ab.len()).ok()?;
        let ilen = u32::try_from(ib.len()).ok()?;
        let olen = u32::try_from(ob.len()).ok()?;
        let clen = u32::try_from(cb.len()).ok()?;
        let klen = u32::try_from(kb.len()).ok()?;
        let xclen = u32::try_from(xcb.len()).ok()?;
        let xilen = u32::try_from(xib.len()).ok()?;
        let inlen = u32::try_from(inb.len()).ok()?;
        let icon_buffer_count = u32::try_from(w.icon_buffers.len()).ok()?;
        body.extend_from_slice(&w.window_id.to_le_bytes());
        body.extend_from_slice(&w.surface_id.to_le_bytes());
        body.extend_from_slice(&w.stack_z.to_le_bytes());
        body.extend_from_slice(&w.x.to_le_bytes());
        body.extend_from_slice(&w.y.to_le_bytes());
        body.extend_from_slice(&w.w.to_le_bytes());
        body.extend_from_slice(&w.h.to_le_bytes());
        body.extend_from_slice(&w.client_x.to_le_bytes());
        body.extend_from_slice(&w.client_y.to_le_bytes());
        body.extend_from_slice(&w.client_w.to_le_bytes());
        body.extend_from_slice(&w.client_h.to_le_bytes());
        body.extend_from_slice(&w.frame_x.to_le_bytes());
        body.extend_from_slice(&w.frame_y.to_le_bytes());
        body.extend_from_slice(&w.frame_w.to_le_bytes());
        body.extend_from_slice(&w.frame_h.to_le_bytes());
        body.extend_from_slice(&w.restore_x.to_le_bytes());
        body.extend_from_slice(&w.restore_y.to_le_bytes());
        body.extend_from_slice(&w.restore_w.to_le_bytes());
        body.extend_from_slice(&w.restore_h.to_le_bytes());
        body.extend_from_slice(&w.minimized.to_le_bytes());
        body.extend_from_slice(&w.maximized.to_le_bytes());
        body.extend_from_slice(&w.fullscreen.to_le_bytes());
        body.extend_from_slice(&w.client_side_decoration.to_le_bytes());
        body.extend_from_slice(&w.workspace_visible.to_le_bytes());
        body.extend_from_slice(&w.shell_flags.to_le_bytes());
        body.extend_from_slice(&tl.to_le_bytes());
        body.extend_from_slice(&al.to_le_bytes());
        body.extend_from_slice(tb);
        body.extend_from_slice(ab);
        body.extend_from_slice(&ilen.to_le_bytes());
        body.extend_from_slice(ib);
        body.extend_from_slice(&olen.to_le_bytes());
        body.extend_from_slice(ob);
        body.extend_from_slice(&clen.to_le_bytes());
        body.extend_from_slice(cb);
        body.extend_from_slice(&klen.to_le_bytes());
        body.extend_from_slice(kb);
        body.extend_from_slice(&xclen.to_le_bytes());
        body.extend_from_slice(xcb);
        body.extend_from_slice(&xilen.to_le_bytes());
        body.extend_from_slice(xib);
        body.extend_from_slice(&inlen.to_le_bytes());
        body.extend_from_slice(inb);
        body.extend_from_slice(&icon_buffer_count.to_le_bytes());
        for buffer in &w.icon_buffers {
            body.extend_from_slice(&buffer.width.to_le_bytes());
            body.extend_from_slice(&buffer.height.to_le_bytes());
            body.extend_from_slice(&buffer.scale.to_le_bytes());
        }
    }
    let body_len = u32::try_from(body.len()).ok()?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body.len());
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&body);
    Some(v)
}

pub fn encode_window_order(revision: u64, windows: &[ShellWindowOrderEntry]) -> Option<Vec<u8>> {
    let count = u32::try_from(windows.len()).ok()?;
    if count > MAX_WINDOW_LIST_ENTRIES {
        return None;
    }
    let body_len = 16u32.checked_add(count.checked_mul(8)?)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_WINDOW_ORDER.to_le_bytes());
    v.extend_from_slice(&revision.to_le_bytes());
    v.extend_from_slice(&count.to_le_bytes());
    for window in windows {
        v.extend_from_slice(&window.window_id.to_le_bytes());
        v.extend_from_slice(&window.stack_z.to_le_bytes());
    }
    Some(v)
}

pub fn encode_shell_list_windows() -> Vec<u8> {
    let body_len = 4u32;
    let mut v = Vec::with_capacity(12);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_LIST_WINDOWS.to_le_bytes());
    v
}

pub fn encode_shell_set_geometry(window_id: u32, x: i32, y: i32, w: i32, h: i32) -> Vec<u8> {
    encode_shell_set_geometry_with_layout(window_id, x, y, w, h, 0)
}

pub fn encode_shell_set_geometry_with_layout(
    window_id: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    layout_state: u32,
) -> Vec<u8> {
    let body_len = 28u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_SET_GEOMETRY.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v.extend_from_slice(&layout_state.to_le_bytes());
    v
}

pub fn encode_shell_close(window_id: u32) -> Vec<u8> {
    let body_len = 8u32;
    let mut v = Vec::with_capacity(16);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_CLOSE.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v
}

pub fn encode_shell_taskbar_activate(window_id: u32) -> Vec<u8> {
    let body_len = 8u32;
    let mut v = Vec::with_capacity(16);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_TASKBAR_ACTIVATE.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v
}

pub fn encode_shell_minimize(window_id: u32) -> Vec<u8> {
    let body_len = 8u32;
    let mut v = Vec::with_capacity(16);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_MINIMIZE.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v
}

pub fn encode_window_state(window_id: u32, minimized: bool) -> Vec<u8> {
    let body_len = 12u32;
    let mut v = Vec::with_capacity(20);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_WINDOW_STATE.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v.extend_from_slice(&(if minimized { 1u32 } else { 0 }).to_le_bytes());
    v
}

pub fn encode_shell_set_fullscreen(window_id: u32, enabled: bool) -> Vec<u8> {
    let body_len = 12u32;
    let mut v = Vec::with_capacity(20);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_SET_FULLSCREEN.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v.extend_from_slice(&(if enabled { 1u32 } else { 0 }).to_le_bytes());
    v
}

pub fn encode_shell_set_maximized(window_id: u32, enabled: bool) -> Vec<u8> {
    let body_len = 12u32;
    let mut v = Vec::with_capacity(20);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_SET_MAXIMIZED.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v.extend_from_slice(&(if enabled { 1u32 } else { 0 }).to_le_bytes());
    v
}

pub fn encode_shell_set_presentation_fullscreen(enabled: bool) -> Vec<u8> {
    let body_len = 8u32;
    let mut v = Vec::with_capacity(16);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_SET_PRESENTATION_FULLSCREEN.to_le_bytes());
    v.extend_from_slice(&(if enabled { 1u32 } else { 0 }).to_le_bytes());
    v
}

pub fn encode_shell_quit_compositor() -> Vec<u8> {
    let body_len = 4u32;
    let mut v = Vec::with_capacity(12);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_QUIT_COMPOSITOR.to_le_bytes());
    v
}

pub fn encode_shell_tile_preview(
    visible: bool,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Vec<u8> {
    let body_len = 24u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_TILE_PREVIEW.to_le_bytes());
    v.extend_from_slice(&(if visible { 1u32 } else { 0 }).to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v.extend_from_slice(&width.to_le_bytes());
    v.extend_from_slice(&height.to_le_bytes());
    v
}

pub fn encode_shell_chrome_metrics(titlebar_h: i32, border_w: i32) -> Vec<u8> {
    let body_len = 12u32;
    let mut v = Vec::with_capacity(20);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_CHROME_METRICS.to_le_bytes());
    v.extend_from_slice(&titlebar_h.to_le_bytes());
    v.extend_from_slice(&border_w.to_le_bytes());
    v
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    Incomplete,
    BodyTooLarge,
    UnknownMsgType,
    BadSpawnPayload,
    BadUtf8Command,
    BadCompositorToShellPayload,
    BadWindowPayload,
    BadWindowListPayload,
    BadWindowOrderPayload,
    BadDmabufCommitPayload,
    BadOutputLayoutPayload,
    BadShellWindowsPayload,
}

pub fn encode_compositor_pointer_move(x: i32, y: i32, modifiers: u32) -> Vec<u8> {
    let body_len = 16u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_POINTER_MOVE.to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v.extend_from_slice(&modifiers.to_le_bytes());
    v
}

pub fn encode_compositor_pointer_button(
    x: i32,
    y: i32,
    button: u32,
    mouse_up: bool,
    titlebar_drag_window_id: u32,
    modifiers: u32,
) -> Vec<u8> {
    let body_len = 28u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_POINTER_BUTTON.to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v.extend_from_slice(&button.to_le_bytes());
    v.extend_from_slice(&(if mouse_up { 1u32 } else { 0 }).to_le_bytes());
    v.extend_from_slice(&titlebar_drag_window_id.to_le_bytes());
    v.extend_from_slice(&modifiers.to_le_bytes());
    v
}

pub fn encode_compositor_context_menu_dismiss() -> Vec<u8> {
    let body_len = 4u32;
    let mut v = Vec::with_capacity(12);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_CONTEXT_MENU_DISMISS.to_le_bytes());
    v
}

pub fn encode_compositor_programs_menu_toggle() -> Vec<u8> {
    let body_len = 4u32;
    let mut v = Vec::with_capacity(12);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_PROGRAMS_MENU_TOGGLE.to_le_bytes());
    v
}

pub fn encode_compositor_tray_hints(slot_count: u32, slot_w: i32, reserved_w: u32) -> Vec<u8> {
    let body_len = 16u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_TRAY_HINTS.to_le_bytes());
    v.extend_from_slice(&slot_count.to_le_bytes());
    v.extend_from_slice(&slot_w.to_le_bytes());
    v.extend_from_slice(&reserved_w.to_le_bytes());
    v
}

pub fn encode_compositor_interaction_state(
    revision: u64,
    interaction_serial: u64,
    pointer_x: i32,
    pointer_y: i32,
    move_window_id: u32,
    resize_window_id: u32,
    move_proxy_window_id: u32,
    move_capture_window_id: u32,
    move_visual: Option<CompositorInteractionVisual>,
    resize_visual: Option<CompositorInteractionVisual>,
    window_switcher_selected_window_id: u32,
    super_held: bool,
) -> Vec<u8> {
    let body_len = COMPOSITOR_INTERACTION_STATE_BYTES as u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    let encode_visual =
        |out: &mut Vec<u8>, visual: Option<CompositorInteractionVisual>| match visual {
            Some(visual) => {
                let mut flags = 0u32;
                if visual.maximized {
                    flags |= 1;
                }
                if visual.fullscreen {
                    flags |= 2;
                }
                out.extend_from_slice(&visual.x.to_le_bytes());
                out.extend_from_slice(&visual.y.to_le_bytes());
                out.extend_from_slice(&visual.width.to_le_bytes());
                out.extend_from_slice(&visual.height.to_le_bytes());
                out.extend_from_slice(&flags.to_le_bytes());
            }
            None => {
                out.extend_from_slice(&0i32.to_le_bytes());
                out.extend_from_slice(&0i32.to_le_bytes());
                out.extend_from_slice(&0i32.to_le_bytes());
                out.extend_from_slice(&0i32.to_le_bytes());
                out.extend_from_slice(&0u32.to_le_bytes());
            }
        };
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_INTERACTION_STATE.to_le_bytes());
    v.extend_from_slice(&revision.to_le_bytes());
    v.extend_from_slice(&pointer_x.to_le_bytes());
    v.extend_from_slice(&pointer_y.to_le_bytes());
    v.extend_from_slice(&move_window_id.to_le_bytes());
    v.extend_from_slice(&resize_window_id.to_le_bytes());
    v.extend_from_slice(&move_proxy_window_id.to_le_bytes());
    v.extend_from_slice(&move_capture_window_id.to_le_bytes());
    encode_visual(&mut v, move_visual);
    encode_visual(&mut v, resize_visual);
    v.extend_from_slice(&window_switcher_selected_window_id.to_le_bytes());
    v.extend_from_slice(&interaction_serial.to_le_bytes());
    v.extend_from_slice(&(super_held as u32).to_le_bytes());
    v
}

pub fn encode_compositor_native_drag_preview(
    window_id: u32,
    generation: u32,
    image_path: &str,
) -> Option<Vec<u8>> {
    let path = image_path.as_bytes();
    let path_len = u32::try_from(path.len()).ok()?;
    if window_id == 0 || generation == 0 || path_len > MAX_WINDOW_STRING_BYTES {
        return None;
    }
    let body_len = 16u32.checked_add(path_len)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_NATIVE_DRAG_PREVIEW.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v.extend_from_slice(&generation.to_le_bytes());
    v.extend_from_slice(&path_len.to_le_bytes());
    v.extend_from_slice(path);
    Some(v)
}

pub fn encode_compositor_tray_sni(items: &[TraySniItemWire]) -> Option<Vec<u8>> {
    let count = u32::try_from(items.len()).ok()?;
    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(&MSG_COMPOSITOR_TRAY_SNI.to_le_bytes());
    body.extend_from_slice(&count.to_le_bytes());
    for item in items {
        let id = item.id.as_bytes();
        let title = item.title.as_bytes();
        let icon = item.icon_png.as_slice();
        if id.len() > MAX_WINDOW_STRING_BYTES as usize
            || title.len() > MAX_WINDOW_STRING_BYTES as usize
            || icon.len() > MAX_BODY_BYTES as usize
        {
            return None;
        }
        let id_len = u32::try_from(id.len()).ok()?;
        let title_len = u32::try_from(title.len()).ok()?;
        let icon_len = u32::try_from(icon.len()).ok()?;
        body.extend_from_slice(&id_len.to_le_bytes());
        body.extend_from_slice(id);
        body.extend_from_slice(&title_len.to_le_bytes());
        body.extend_from_slice(title);
        body.extend_from_slice(&icon_len.to_le_bytes());
        body.extend_from_slice(icon);
    }
    let body_len = u32::try_from(body.len()).ok()?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body.len());
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&body);
    Some(v)
}

pub fn encode_compositor_volume_overlay(
    volume_linear_percent_x100: u16,
    muted: bool,
    state_known: bool,
) -> Vec<u8> {
    let body_len = 8u32;
    let mut flags = 0u16;
    if muted {
        flags |= 1;
    }
    if state_known {
        flags |= 2;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_VOLUME_OVERLAY.to_le_bytes());
    v.extend_from_slice(&volume_linear_percent_x100.to_le_bytes());
    v.extend_from_slice(&flags.to_le_bytes());
    v
}

pub fn encode_shell_windows_sync(
    generation: u32,
    windows: &[ShellUiWindowWireRow],
) -> Option<Vec<u8>> {
    let n = u32::try_from(windows.len()).ok()?;
    if n > MAX_SHELL_UI_WINDOWS {
        return None;
    }
    let row_sz: u32 = 28;
    let body_len = 12u32.checked_add(n.checked_mul(row_sz)?)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_WINDOWS_SYNC.to_le_bytes());
    v.extend_from_slice(&generation.to_le_bytes());
    v.extend_from_slice(&n.to_le_bytes());
    for w in windows {
        if w.id == 0 || w.gw == 0 || w.gh == 0 {
            return None;
        }
        v.extend_from_slice(&w.id.to_le_bytes());
        v.extend_from_slice(&w.gx.to_le_bytes());
        v.extend_from_slice(&w.gy.to_le_bytes());
        v.extend_from_slice(&w.gw.to_le_bytes());
        v.extend_from_slice(&w.gh.to_le_bytes());
        v.extend_from_slice(&w.z.to_le_bytes());
        v.extend_from_slice(&w.flags.to_le_bytes());
    }
    Some(v)
}

pub fn encode_compositor_keyboard_layout(label: &str) -> Option<Vec<u8>> {
    let b = label.as_bytes();
    if b.contains(&0) {
        return None;
    }
    let ll = u32::try_from(b.len()).ok()?;
    if ll > MAX_KEYBOARD_LAYOUT_LABEL_BYTES {
        return None;
    }
    let body_len = 8u32.checked_add(ll)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_KEYBOARD_LAYOUT.to_le_bytes());
    v.extend_from_slice(&ll.to_le_bytes());
    v.extend_from_slice(b);
    Some(v)
}

pub fn encode_compositor_workspace_state(revision: u64, state_json: &str) -> Option<Vec<u8>> {
    let b = state_json.as_bytes();
    if b.is_empty() {
        return None;
    }
    let len = u32::try_from(b.len()).ok()?;
    if len > MAX_WORKSPACE_JSON_BYTES {
        return None;
    }
    let body_len = 16u32.checked_add(len)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_WORKSPACE_STATE.to_le_bytes());
    v.extend_from_slice(&revision.to_le_bytes());
    v.extend_from_slice(&len.to_le_bytes());
    v.extend_from_slice(b);
    Some(v)
}

pub fn encode_compositor_workspace_state_binary(revision: u64, payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() > MAX_WORKSPACE_BINARY_BYTES as usize {
        return None;
    }
    let body_len = 12usize.checked_add(payload.len())?;
    let body_len = u32::try_from(body_len).ok()?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_WORKSPACE_STATE_BINARY.to_le_bytes());
    v.extend_from_slice(&revision.to_le_bytes());
    v.extend_from_slice(payload);
    Some(v)
}

pub fn encode_compositor_shell_hosted_app_state(
    revision: u64,
    state_json: &str,
) -> Option<Vec<u8>> {
    let b = state_json.as_bytes();
    if b.is_empty() {
        return None;
    }
    let len = u32::try_from(b.len()).ok()?;
    if len > MAX_SHELL_HOSTED_APP_STATE_JSON_BYTES {
        return None;
    }
    let body_len = 16u32.checked_add(len)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_SHELL_HOSTED_APP_STATE.to_le_bytes());
    v.extend_from_slice(&revision.to_le_bytes());
    v.extend_from_slice(&len.to_le_bytes());
    v.extend_from_slice(b);
    Some(v)
}

pub fn encode_compositor_command_palette_state(revision: u64, state_json: &str) -> Option<Vec<u8>> {
    let b = state_json.as_bytes();
    if b.is_empty() {
        return None;
    }
    let len = u32::try_from(b.len()).ok()?;
    if len > MAX_COMMAND_PALETTE_STATE_JSON_BYTES {
        return None;
    }
    let body_len = 16u32.checked_add(len)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_COMMAND_PALETTE_STATE.to_le_bytes());
    v.extend_from_slice(&revision.to_le_bytes());
    v.extend_from_slice(&len.to_le_bytes());
    v.extend_from_slice(b);
    Some(v)
}

pub fn encode_compositor_lock_state(state_json: &str) -> Option<Vec<u8>> {
    let b = state_json.as_bytes();
    if b.is_empty() {
        return None;
    }
    let len = u32::try_from(b.len()).ok()?;
    if len > MAX_LOCK_STATE_JSON_BYTES {
        return None;
    }
    let body_len = 8u32.checked_add(len)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_LOCK_STATE.to_le_bytes());
    v.extend_from_slice(&len.to_le_bytes());
    v.extend_from_slice(b);
    Some(v)
}

pub fn encode_shell_workspace_mutation(mutation_json: &str) -> Option<Vec<u8>> {
    let b = mutation_json.as_bytes();
    if b.is_empty() {
        return None;
    }
    let len = u32::try_from(b.len()).ok()?;
    if len > MAX_WORKSPACE_JSON_BYTES {
        return None;
    }
    let body_len = 8u32.checked_add(len)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_WORKSPACE_MUTATION.to_le_bytes());
    v.extend_from_slice(&len.to_le_bytes());
    v.extend_from_slice(b);
    Some(v)
}

pub fn encode_compositor_keybind(
    action: &str,
    target_window_id: u32,
    output_name: Option<&str>,
) -> Option<Vec<u8>> {
    let b = action.as_bytes();
    if b.is_empty() || b.contains(&0) {
        return None;
    }
    let al = u32::try_from(b.len()).ok()?;
    if al > MAX_KEYBIND_ACTION_BYTES {
        return None;
    }
    let output_bytes = output_name.map(str::as_bytes);
    let output_len = match output_bytes {
        Some(bytes) => {
            let len = u32::try_from(bytes.len()).ok()?;
            if len == 0 || len > MAX_OUTPUT_LAYOUT_NAME_BYTES {
                return None;
            }
            len
        }
        None => 0,
    };
    let body_len = 12u32
        .checked_add(al)?
        .checked_add(if output_bytes.is_some() {
            4u32.checked_add(output_len)?
        } else {
            0
        })?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_KEYBIND.to_le_bytes());
    v.extend_from_slice(&al.to_le_bytes());
    v.extend_from_slice(b);
    v.extend_from_slice(&target_window_id.to_le_bytes());
    if let Some(bytes) = output_bytes {
        v.extend_from_slice(&output_len.to_le_bytes());
        v.extend_from_slice(bytes);
    }
    Some(v)
}

pub fn encode_compositor_touch(touch_id: i32, phase: u32, x: i32, y: i32) -> Vec<u8> {
    let body_len = 20u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_TOUCH.to_le_bytes());
    v.extend_from_slice(&touch_id.to_le_bytes());
    v.extend_from_slice(&phase.to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v
}

pub fn encode_compositor_pointer_axis(
    x: i32,
    y: i32,
    delta_x: i32,
    delta_y: i32,
    modifiers: u32,
) -> Vec<u8> {
    let body_len = 24u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_POINTER_AXIS.to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v.extend_from_slice(&delta_x.to_le_bytes());
    v.extend_from_slice(&delta_y.to_le_bytes());
    v.extend_from_slice(&modifiers.to_le_bytes());
    v
}

pub fn encode_compositor_key(
    cef_key_type: u32,
    modifiers: u32,
    windows_key_code: i32,
    native_key_code: i32,
    character: u32,
    unmodified_character: u32,
) -> Vec<u8> {
    let body_len = 28u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_KEY.to_le_bytes());
    v.extend_from_slice(&cef_key_type.to_le_bytes());
    v.extend_from_slice(&modifiers.to_le_bytes());
    v.extend_from_slice(&windows_key_code.to_le_bytes());
    v.extend_from_slice(&native_key_code.to_le_bytes());
    v.extend_from_slice(&character.to_le_bytes());
    v.extend_from_slice(&unmodified_character.to_le_bytes());
    v
}

pub fn encode_compositor_ime_commit_text(text: &str) -> Option<Vec<u8>> {
    let b = text.as_bytes();
    let tl = u32::try_from(b.len()).ok()?;
    if tl == 0 || tl > MAX_IME_COMMIT_TEXT_BYTES {
        return None;
    }
    let body_len = 8u32.checked_add(tl)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_IME_COMMIT_TEXT.to_le_bytes());
    v.extend_from_slice(&tl.to_le_bytes());
    v.extend_from_slice(b);
    Some(v)
}

fn decode_window_strings_body(
    body: &[u8],
    expect_type: u32,
) -> Result<DecodedCompositorToShellMessage, DecodeError> {
    if body.len() < 36 {
        return Err(DecodeError::BadWindowPayload);
    }
    let mut cursor = WireCursor::new(body);
    let msg = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
    if msg != expect_type {
        return Err(DecodeError::UnknownMsgType);
    }
    let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
    let surface_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
    let x = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
    let y = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
    let w = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
    let h = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
    let title_len = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)? as usize;
    let app_len = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)? as usize;
    if title_len > MAX_WINDOW_STRING_BYTES as usize || app_len > MAX_WINDOW_STRING_BYTES as usize {
        return Err(DecodeError::BadWindowPayload);
    }
    let title = cursor
        .read_utf8(title_len)
        .ok_or(DecodeError::BadWindowPayload)?
        .map_err(|_| DecodeError::BadUtf8Command)?
        .to_string();
    let app_id = cursor
        .read_utf8(app_len)
        .ok_or(DecodeError::BadWindowPayload)?
        .map_err(|_| DecodeError::BadUtf8Command)?
        .to_string();
    match expect_type {
        MSG_WINDOW_METADATA => {
            let mut icon_name = String::new();
            let mut icon_buffers = Vec::new();
            if cursor.remaining() != 0 {
                let icon_name_len =
                    cursor.read_u32().ok_or(DecodeError::BadWindowPayload)? as usize;
                if icon_name_len > MAX_WINDOW_STRING_BYTES as usize {
                    return Err(DecodeError::BadWindowPayload);
                }
                icon_name = cursor
                    .read_utf8(icon_name_len)
                    .ok_or(DecodeError::BadWindowPayload)?
                    .map_err(|_| DecodeError::BadUtf8Command)?
                    .to_string();
                let icon_buffer_count =
                    cursor.read_u32().ok_or(DecodeError::BadWindowPayload)? as usize;
                if icon_buffer_count > MAX_WINDOW_ICON_BUFFERS as usize {
                    return Err(DecodeError::BadWindowPayload);
                }
                let icon_buffers_bytes = icon_buffer_count
                    .checked_mul(12)
                    .ok_or(DecodeError::BadWindowPayload)?;
                if cursor.remaining() < icon_buffers_bytes {
                    return Err(DecodeError::BadWindowPayload);
                }
                for _ in 0..icon_buffer_count {
                    icon_buffers.push(ShellWindowIconBufferSnapshot {
                        width: cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?,
                        height: cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?,
                        scale: cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?,
                    });
                }
            }
            if cursor.remaining() != 0 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(DecodedCompositorToShellMessage::WindowMetadata {
                window_id,
                surface_id,
                title,
                app_id,
                icon_name,
                icon_buffers,
            })
        }
        MSG_WINDOW_MAPPED => {
            let client_side_decoration = if cursor.remaining() == 0 {
                false
            } else {
                let c = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
                if c > 1 {
                    return Err(DecodeError::BadWindowPayload);
                }
                c != 0
            };
            let output_name = if cursor.remaining() == 0 {
                String::new()
            } else {
                let ol = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)? as usize;
                if ol > MAX_WINDOW_STRING_BYTES as usize {
                    return Err(DecodeError::BadWindowPayload);
                }
                if cursor.remaining() != ol {
                    return Err(DecodeError::BadWindowPayload);
                }
                cursor
                    .read_utf8(ol)
                    .ok_or(DecodeError::BadWindowPayload)?
                    .map_err(|_| DecodeError::BadUtf8Command)?
                    .to_string()
            };
            Ok(DecodedCompositorToShellMessage::WindowMapped {
                window_id,
                surface_id,
                stack_z: window_id,
                x,
                y,
                w,
                h,
                minimized: false,
                maximized: false,
                fullscreen: false,
                title,
                app_id,
                client_side_decoration,
                shell_flags: 0,
                output_id: String::new(),
                output_name,
                capture_identifier: String::new(),
                kind: String::new(),
                x11_class: String::new(),
                x11_instance: String::new(),
            })
        }
        _ => Err(DecodeError::UnknownMsgType),
    }
}

pub fn pop_compositor_to_shell_message(
    buf: &mut Vec<u8>,
) -> Result<Option<DecodedCompositorToShellMessage>, DecodeError> {
    if buf.len() < 4 {
        return Ok(None);
    }
    let body_len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if body_len > MAX_BODY_BYTES as usize {
        return Err(DecodeError::BodyTooLarge);
    }
    let total = 4 + body_len;
    if buf.len() < total {
        return Ok(None);
    }
    let decoded = decode_compositor_to_shell_body(&buf[4..total])?;
    buf.drain(..total);
    return Ok(Some(decoded));
}

fn decode_interaction_visual(
    window_id: u32,
    cursor: &mut WireCursor<'_>,
) -> Option<Option<CompositorInteractionVisual>> {
    let x = cursor.read_i32()?;
    let y = cursor.read_i32()?;
    let width = cursor.read_i32()?;
    let height = cursor.read_i32()?;
    let flags = cursor.read_u32()?;
    Some((window_id != 0).then_some(CompositorInteractionVisual {
        x,
        y,
        width,
        height,
        maximized: (flags & 1) != 0,
        fullscreen: (flags & 2) != 0,
    }))
}

fn decode_compositor_to_shell_body(
    body: &[u8],
) -> Result<DecodedCompositorToShellMessage, DecodeError> {
    let mut cursor = WireCursor::new(body);
    let msg = cursor
        .read_u32()
        .ok_or(DecodeError::BadCompositorToShellPayload)?;
    match msg {
        MSG_COMPOSITOR_POINTER_MOVE => {
            if body.len() != 12 && body.len() != 16 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let x = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let y = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let modifiers = if body.len() >= 16 {
                cursor
                    .read_u32()
                    .ok_or(DecodeError::BadCompositorToShellPayload)?
            } else {
                0
            };
            Ok(DecodedCompositorToShellMessage::PointerMove { x, y, modifiers })
        }
        MSG_COMPOSITOR_POINTER_BUTTON => {
            if body.len() != 24 && body.len() != 28 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let x = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let y = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let button = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let up_flag = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let titlebar_drag_window_id = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            if button > 2 || up_flag > 1 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let modifiers = if body.len() >= 28 {
                cursor
                    .read_u32()
                    .ok_or(DecodeError::BadCompositorToShellPayload)?
            } else {
                0
            };
            Ok(DecodedCompositorToShellMessage::PointerButton {
                x,
                y,
                button,
                mouse_up: up_flag != 0,
                titlebar_drag_window_id,
                modifiers,
            })
        }
        MSG_COMPOSITOR_TOUCH => {
            if body.len() != 20 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let touch_id = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let phase = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            if phase > TOUCH_PHASE_CANCELLED {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let x = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let y = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            Ok(DecodedCompositorToShellMessage::Touch {
                touch_id,
                phase,
                x,
                y,
            })
        }
        MSG_COMPOSITOR_POINTER_AXIS => {
            if body.len() != 20 && body.len() != 24 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let x = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let y = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let delta_x = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let delta_y = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let modifiers = if body.len() >= 24 {
                cursor
                    .read_u32()
                    .ok_or(DecodeError::BadCompositorToShellPayload)?
            } else {
                0
            };
            Ok(DecodedCompositorToShellMessage::PointerAxis {
                x,
                y,
                delta_x,
                delta_y,
                modifiers,
            })
        }
        MSG_COMPOSITOR_KEY => {
            if body.len() != 28 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let cef_key_type = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            if cef_key_type > 3 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let modifiers = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let windows_key_code = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let native_key_code = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let character = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let unmodified_character = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            Ok(DecodedCompositorToShellMessage::Key {
                cef_key_type,
                modifiers,
                windows_key_code,
                native_key_code,
                character,
                unmodified_character,
            })
        }
        MSG_COMPOSITOR_IME_COMMIT_TEXT => {
            if body.len() < 8 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let tl = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)? as usize;
            if tl == 0 || tl > MAX_IME_COMMIT_TEXT_BYTES as usize {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            if body.len() != 8 + tl {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let text = std::str::from_utf8(
                cursor
                    .read_bytes(tl)
                    .ok_or(DecodeError::BadCompositorToShellPayload)?,
            )
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
            Ok(DecodedCompositorToShellMessage::ImeCommitText { text })
        }
        MSG_OUTPUT_GEOMETRY => {
            if body.len() != 20 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let logical_w = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let logical_h = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let physical_w = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let physical_h = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            Ok(DecodedCompositorToShellMessage::OutputGeometry {
                logical_w,
                logical_h,
                physical_w: physical_w.max(1),
                physical_h: physical_h.max(1),
            })
        }
        MSG_OUTPUT_LAYOUT => decode_output_layout_body(body),
        MSG_WINDOW_MAPPED => decode_window_strings_body(body, MSG_WINDOW_MAPPED),
        MSG_WINDOW_UNMAPPED => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            Ok(DecodedCompositorToShellMessage::WindowUnmapped { window_id })
        }
        MSG_WINDOW_GEOMETRY => {
            if body.len() < 28 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            let surface_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            let x = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let y = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let w = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let h = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let (maximized, fullscreen, csd_base) = if body.len() == 28 {
                (false, false, None)
            } else if body.len() < 36 {
                return Err(DecodeError::BadWindowPayload);
            } else {
                let mx = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
                let fs = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
                if mx > 1 || fs > 1 {
                    return Err(DecodeError::BadWindowPayload);
                }
                (mx != 0, fs != 0, Some(36usize))
            };
            let (client_side_decoration, pos) = match csd_base {
                None => (false, 28usize),
                Some(base) => {
                    if body.len() == base {
                        (false, base)
                    } else if body.len() < base + 4 {
                        return Err(DecodeError::BadWindowPayload);
                    } else {
                        let c = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
                        if c > 1 {
                            return Err(DecodeError::BadWindowPayload);
                        }
                        (c != 0, base + 4)
                    }
                }
            };
            let (output_name, rect_pos) = if body.len() == pos {
                (String::new(), pos)
            } else {
                if body.len() < pos + 4 {
                    return Err(DecodeError::BadWindowPayload);
                }
                let ol = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)? as usize;
                if ol > MAX_WINDOW_STRING_BYTES as usize {
                    return Err(DecodeError::BadWindowPayload);
                }
                let tail = pos
                    .checked_add(4)
                    .and_then(|a| a.checked_add(ol))
                    .ok_or(DecodeError::BadWindowPayload)?;
                if body.len() != tail && body.len() != tail + WINDOW_GEOMETRY_RECTS_BYTES {
                    return Err(DecodeError::BadWindowPayload);
                }
                let output_name = cursor
                    .read_utf8(ol)
                    .ok_or(DecodeError::BadWindowPayload)?
                    .map_err(|_| DecodeError::BadUtf8Command)?
                    .to_string();
                (output_name, tail)
            };
            let (client_x, client_y, client_w, client_h, frame_x, frame_y, frame_w, frame_h) =
                if body.len() == rect_pos {
                    (x, y, w, h, x, y, w, h)
                } else {
                    if body.len() != rect_pos + WINDOW_GEOMETRY_RECTS_BYTES {
                        return Err(DecodeError::BadWindowPayload);
                    }
                    let schema = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
                    if schema != WINDOW_GEOMETRY_RECTS_SCHEMA_VERSION {
                        return Err(DecodeError::BadWindowPayload);
                    }
                    (
                        cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?,
                        cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?,
                        cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?,
                        cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?,
                        cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?,
                        cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?,
                        cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?,
                        cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?,
                    )
                };
            Ok(DecodedCompositorToShellMessage::WindowGeometry {
                window_id,
                surface_id,
                x,
                y,
                w,
                h,
                client_x,
                client_y,
                client_w,
                client_h,
                frame_x,
                frame_y,
                frame_w,
                frame_h,
                maximized,
                fullscreen,
                client_side_decoration,
                output_id: String::new(),
                output_name,
            })
        }
        MSG_WINDOW_METADATA => decode_window_strings_body(body, MSG_WINDOW_METADATA),
        MSG_FOCUS_CHANGED => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let sid = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            let wid = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            Ok(DecodedCompositorToShellMessage::FocusChanged {
                surface_id: if sid == 0 { None } else { Some(sid) },
                window_id: if wid == 0 { None } else { Some(wid) },
            })
        }
        MSG_WINDOW_STATE => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            let m = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            if m > 1 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            Ok(DecodedCompositorToShellMessage::WindowState {
                window_id,
                minimized: m != 0,
            })
        }
        MSG_WINDOW_LIST => decode_window_list_compositor_body(body),
        MSG_WINDOW_ORDER => decode_window_order_compositor_body(body),
        MSG_COMPOSITOR_CONTEXT_MENU_DISMISS => {
            if body.len() != 4 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            Ok(DecodedCompositorToShellMessage::ContextMenuDismiss)
        }
        MSG_COMPOSITOR_PROGRAMS_MENU_TOGGLE => {
            if body.len() != 4 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            Ok(DecodedCompositorToShellMessage::ProgramsMenuToggle)
        }
        MSG_COMPOSITOR_KEYBIND => {
            if body.len() < 8 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let al = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)? as usize;
            if al == 0 || al > MAX_KEYBIND_ACTION_BYTES as usize {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let end = 8usize
                .checked_add(al)
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            if body.len() != end && body.len() != end + 4 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let action = std::str::from_utf8(
                cursor
                    .read_bytes(al)
                    .ok_or(DecodeError::BadCompositorToShellPayload)?,
            )
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
            let target_window_id = if body.len() >= end + 4 {
                cursor
                    .read_u32()
                    .ok_or(DecodeError::BadCompositorToShellPayload)?
            } else {
                0
            };
            let output_name = if body.len() == end + 4 {
                None
            } else {
                if body.len() < end + 8 {
                    return Err(DecodeError::BadCompositorToShellPayload);
                }
                let ol = cursor
                    .read_u32()
                    .ok_or(DecodeError::BadCompositorToShellPayload)?
                    as usize;
                if ol == 0 || ol > MAX_OUTPUT_LAYOUT_NAME_BYTES as usize {
                    return Err(DecodeError::BadCompositorToShellPayload);
                }
                if body.len() != end + 8 + ol {
                    return Err(DecodeError::BadCompositorToShellPayload);
                }
                Some(
                    std::str::from_utf8(
                        cursor
                            .read_bytes(ol)
                            .ok_or(DecodeError::BadCompositorToShellPayload)?,
                    )
                    .map_err(|_| DecodeError::BadUtf8Command)?
                    .to_string(),
                )
            };
            Ok(DecodedCompositorToShellMessage::Keybind {
                action,
                target_window_id,
                output_name,
            })
        }
        MSG_COMPOSITOR_KEYBOARD_LAYOUT => {
            if body.len() < 8 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let ll = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)? as usize;
            if ll > MAX_KEYBOARD_LAYOUT_LABEL_BYTES as usize {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let end = 8usize
                .checked_add(ll)
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            if body.len() != end {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let label = std::str::from_utf8(
                cursor
                    .read_bytes(ll)
                    .ok_or(DecodeError::BadCompositorToShellPayload)?,
            )
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
            Ok(DecodedCompositorToShellMessage::KeyboardLayout { label })
        }
        MSG_COMPOSITOR_VOLUME_OVERLAY => {
            if body.len() != 8 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let volume_linear_percent_x100 = cursor
                .read_u16()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let flags = cursor
                .read_u16()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            Ok(DecodedCompositorToShellMessage::VolumeOverlay {
                volume_linear_percent_x100,
                muted: flags & 1 != 0,
                state_known: flags & 2 != 0,
            })
        }
        MSG_COMPOSITOR_WORKSPACE_STATE => {
            if body.len() < 16 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let revision = cursor
                .read_u64()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let len = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)? as usize;
            if len == 0 || len > MAX_WORKSPACE_JSON_BYTES as usize {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let end = 16usize
                .checked_add(len)
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            if body.len() != end {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let state_json = std::str::from_utf8(
                cursor
                    .read_bytes(len)
                    .ok_or(DecodeError::BadCompositorToShellPayload)?,
            )
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
            Ok(DecodedCompositorToShellMessage::WorkspaceState {
                revision,
                state_json,
            })
        }
        MSG_COMPOSITOR_SHELL_HOSTED_APP_STATE => {
            if body.len() < 16 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let revision = cursor
                .read_u64()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let len = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)? as usize;
            if len == 0 || len > MAX_SHELL_HOSTED_APP_STATE_JSON_BYTES as usize {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let end = 16usize
                .checked_add(len)
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            if body.len() != end {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let state_json = std::str::from_utf8(
                cursor
                    .read_bytes(len)
                    .ok_or(DecodeError::BadCompositorToShellPayload)?,
            )
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
            Ok(DecodedCompositorToShellMessage::ShellHostedAppState {
                revision,
                state_json,
            })
        }
        MSG_COMPOSITOR_COMMAND_PALETTE_STATE => {
            if body.len() < 16 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let revision = cursor
                .read_u64()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let len = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)? as usize;
            if len == 0 || len > MAX_COMMAND_PALETTE_STATE_JSON_BYTES as usize {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let end = 16usize
                .checked_add(len)
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            if body.len() != end {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let state_json = std::str::from_utf8(
                cursor
                    .read_bytes(len)
                    .ok_or(DecodeError::BadCompositorToShellPayload)?,
            )
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
            Ok(DecodedCompositorToShellMessage::CommandPaletteState {
                revision,
                state_json,
            })
        }
        MSG_COMPOSITOR_LOCK_STATE => {
            if body.len() < 8 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let len = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)? as usize;
            if len == 0 || len > MAX_LOCK_STATE_JSON_BYTES as usize {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let end = 8usize
                .checked_add(len)
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            if body.len() != end {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let state_json = std::str::from_utf8(
                cursor
                    .read_bytes(len)
                    .ok_or(DecodeError::BadCompositorToShellPayload)?,
            )
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
            Ok(DecodedCompositorToShellMessage::LockState { state_json })
        }
        MSG_COMPOSITOR_INTERACTION_STATE => {
            if body.len() != COMPOSITOR_INTERACTION_STATE_BYTES_V1
                && body.len() != COMPOSITOR_INTERACTION_STATE_BYTES_V2
                && body.len() != COMPOSITOR_INTERACTION_STATE_BYTES
            {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let revision = cursor
                .read_u64()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let pointer_x = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let pointer_y = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let move_window_id = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let resize_window_id = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let move_proxy_window_id = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let move_capture_window_id = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let mut move_visual_cursor = WireCursor::new(
                body.get(36..56)
                    .ok_or(DecodeError::BadCompositorToShellPayload)?,
            );
            let move_visual = decode_interaction_visual(move_window_id, &mut move_visual_cursor)
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let mut resize_visual_cursor = WireCursor::new(
                body.get(56..76)
                    .ok_or(DecodeError::BadCompositorToShellPayload)?,
            );
            let resize_visual =
                decode_interaction_visual(resize_window_id, &mut resize_visual_cursor)
                    .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let window_switcher_selected_window_id = WireCursor::new(
                body.get(76..80)
                    .ok_or(DecodeError::BadCompositorToShellPayload)?,
            )
            .read_u32()
            .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let interaction_serial = if body.len() >= COMPOSITOR_INTERACTION_STATE_BYTES_V2 {
                WireCursor::new(
                    body.get(80..88)
                        .ok_or(DecodeError::BadCompositorToShellPayload)?,
                )
                .read_u64()
                .ok_or(DecodeError::BadCompositorToShellPayload)?
            } else {
                0
            };
            let super_held = if body.len() == COMPOSITOR_INTERACTION_STATE_BYTES {
                WireCursor::new(
                    body.get(88..92)
                        .ok_or(DecodeError::BadCompositorToShellPayload)?,
                )
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?
                    != 0
            } else {
                false
            };
            Ok(DecodedCompositorToShellMessage::InteractionState {
                revision,
                interaction_serial,
                pointer_x,
                pointer_y,
                move_window_id,
                resize_window_id,
                move_proxy_window_id,
                move_capture_window_id,
                move_visual,
                resize_visual,
                window_switcher_selected_window_id,
                super_held,
            })
        }
        MSG_COMPOSITOR_NATIVE_DRAG_PREVIEW => {
            if body.len() < 16 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let window_id = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let generation = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let path_len = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?
                as usize;
            if window_id == 0 || generation == 0 || path_len > MAX_WINDOW_STRING_BYTES as usize {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let end = 16usize
                .checked_add(path_len)
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            if body.len() != end {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let image_path = std::str::from_utf8(
                cursor
                    .read_bytes(path_len)
                    .ok_or(DecodeError::BadCompositorToShellPayload)?,
            )
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
            Ok(DecodedCompositorToShellMessage::NativeDragPreview {
                window_id,
                generation,
                image_path,
            })
        }
        MSG_COMPOSITOR_TRAY_HINTS => {
            if body.len() != 16 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let slot_count = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let slot_w = cursor
                .read_i32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            let reserved_w = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            Ok(DecodedCompositorToShellMessage::TrayHints {
                slot_count,
                slot_w,
                reserved_w,
            })
        }
        MSG_COMPOSITOR_TRAY_SNI => {
            if body.len() < 8 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let count = cursor
                .read_u32()
                .ok_or(DecodeError::BadCompositorToShellPayload)? as usize;
            let mut items = Vec::with_capacity(count);
            for _ in 0..count {
                let id_len = cursor
                    .read_u32()
                    .ok_or(DecodeError::BadCompositorToShellPayload)?
                    as usize;
                if id_len > MAX_WINDOW_STRING_BYTES as usize {
                    return Err(DecodeError::BadCompositorToShellPayload);
                }
                let id = std::str::from_utf8(
                    cursor
                        .read_bytes(id_len)
                        .ok_or(DecodeError::BadCompositorToShellPayload)?,
                )
                .map_err(|_| DecodeError::BadUtf8Command)?
                .to_string();
                let title_len = cursor
                    .read_u32()
                    .ok_or(DecodeError::BadCompositorToShellPayload)?
                    as usize;
                if title_len > MAX_WINDOW_STRING_BYTES as usize {
                    return Err(DecodeError::BadCompositorToShellPayload);
                }
                let title = std::str::from_utf8(
                    cursor
                        .read_bytes(title_len)
                        .ok_or(DecodeError::BadCompositorToShellPayload)?,
                )
                .map_err(|_| DecodeError::BadUtf8Command)?
                .to_string();
                let icon_len = cursor
                    .read_u32()
                    .ok_or(DecodeError::BadCompositorToShellPayload)?
                    as usize;
                let icon_png = cursor
                    .read_bytes(icon_len)
                    .ok_or(DecodeError::BadCompositorToShellPayload)?
                    .to_vec();
                items.push(TraySniItemWire {
                    id,
                    title,
                    icon_png,
                });
            }
            if cursor.remaining() != 0 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            Ok(DecodedCompositorToShellMessage::TraySni { items })
        }
        MSG_SPAWN_WAYLAND_CLIENT
        | MSG_SHELL_MOVE_BEGIN
        | MSG_SHELL_MOVE_DELTA
        | MSG_SHELL_MOVE_END
        | MSG_SHELL_RESIZE_BEGIN
        | MSG_SHELL_RESIZE_DELTA
        | MSG_SHELL_RESIZE_END
        | MSG_SHELL_LIST_WINDOWS
        | MSG_SHELL_SET_GEOMETRY
        | MSG_SHELL_CLOSE
        | MSG_SHELL_SET_FULLSCREEN
        | MSG_SHELL_SET_MAXIMIZED
        | MSG_SHELL_SET_PRESENTATION_FULLSCREEN
        | MSG_SHELL_SET_OUTPUT_LAYOUT
        | MSG_SHELL_TASKBAR_ACTIVATE
        | MSG_SHELL_MINIMIZE
        | MSG_SHELL_QUIT_COMPOSITOR
        | MSG_SHELL_TILE_PREVIEW
        | MSG_SHELL_CHROME_METRICS
        | MSG_SHELL_WINDOWS_SYNC
        | MSG_SHELL_WORKSPACE_MUTATION => Err(DecodeError::UnknownMsgType),
        _ => Err(DecodeError::UnknownMsgType),
    }
}

fn decode_window_list_compositor_body(
    body: &[u8],
) -> Result<DecodedCompositorToShellMessage, DecodeError> {
    if body.len() < 16 {
        return Err(DecodeError::BadWindowListPayload);
    }
    let mut cursor = WireCursor::new(body);
    let msg = cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?;
    if msg != MSG_WINDOW_LIST {
        return Err(DecodeError::UnknownMsgType);
    }
    let revision = cursor.read_u64().ok_or(DecodeError::BadWindowListPayload)?;
    let count = cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)? as usize;
    if count > MAX_WINDOW_LIST_ENTRIES as usize {
        return Err(DecodeError::BadWindowListPayload);
    }
    let (mut off, row_bytes) = if body.len() >= WINDOW_LIST_HEADER_BYTES {
        let schema_version = cursor
            .peek_u32_at(16)
            .ok_or(DecodeError::BadWindowListPayload)?;
        let row_bytes = cursor
            .peek_u32_at(20)
            .ok_or(DecodeError::BadWindowListPayload)? as usize;
        if schema_version == WINDOW_LIST_SCHEMA_VERSION {
            if row_bytes != WINDOW_LIST_ROW_BYTES {
                return Err(DecodeError::BadWindowListPayload);
            }
            cursor
                .set_offset(WINDOW_LIST_HEADER_BYTES)
                .ok_or(DecodeError::BadWindowListPayload)?;
            (WINDOW_LIST_HEADER_BYTES, row_bytes)
        } else {
            (WINDOW_LIST_HEADER_BYTES_V1, WINDOW_LIST_ROW_BYTES_V1)
        }
    } else {
        (WINDOW_LIST_HEADER_BYTES_V1, WINDOW_LIST_ROW_BYTES_V1)
    };
    let mut windows = Vec::with_capacity(count);
    for _ in 0..count {
        if off + row_bytes > body.len() {
            return Err(DecodeError::BadWindowListPayload);
        }
        cursor
            .set_offset(off)
            .ok_or(DecodeError::BadWindowListPayload)?;
        let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?;
        let surface_id = cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?;
        let stack_z = cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?;
        let x = cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?;
        let y = cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?;
        let w = cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?;
        let h = cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?;
        let (
            client_x,
            client_y,
            client_w,
            client_h,
            frame_x,
            frame_y,
            frame_w,
            frame_h,
            restore_x,
            restore_y,
            restore_w,
            restore_h,
            minimized,
            maximized,
            fullscreen,
            client_side_decoration,
            workspace_visible,
            shell_flags,
            title_len,
            app_len,
        ) = if row_bytes == WINDOW_LIST_ROW_BYTES {
            (
                cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)? as usize,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)? as usize,
            )
        } else {
            (
                x,
                y,
                w,
                h,
                x,
                y,
                w,
                h,
                0,
                0,
                0,
                0,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)?,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)? as usize,
                cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)? as usize,
            )
        };
        if minimized > 1
            || maximized > 1
            || fullscreen > 1
            || client_side_decoration > 1
            || workspace_visible > 1
        {
            return Err(DecodeError::BadWindowListPayload);
        }
        if title_len > MAX_WINDOW_STRING_BYTES as usize
            || app_len > MAX_WINDOW_STRING_BYTES as usize
        {
            return Err(DecodeError::BadWindowListPayload);
        }
        off += row_bytes;
        cursor
            .set_offset(off)
            .ok_or(DecodeError::BadWindowListPayload)?;
        let title = cursor
            .read_utf8(title_len)
            .ok_or(DecodeError::BadWindowListPayload)?
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        let app_id = cursor
            .read_utf8(app_len)
            .ok_or(DecodeError::BadWindowListPayload)?
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        let output_id_len = cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)? as usize;
        if output_id_len > MAX_WINDOW_STRING_BYTES as usize {
            return Err(DecodeError::BadWindowListPayload);
        }
        let output_id = cursor
            .read_utf8(output_id_len)
            .ok_or(DecodeError::BadWindowListPayload)?
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        let output_len = cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)? as usize;
        if output_len > MAX_WINDOW_STRING_BYTES as usize {
            return Err(DecodeError::BadWindowListPayload);
        }
        let output_name = cursor
            .read_utf8(output_len)
            .ok_or(DecodeError::BadWindowListPayload)?
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        let capture_len = cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)? as usize;
        if capture_len > MAX_WINDOW_STRING_BYTES as usize {
            return Err(DecodeError::BadWindowListPayload);
        }
        let capture_identifier = cursor
            .read_utf8(capture_len)
            .ok_or(DecodeError::BadWindowListPayload)?
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        let kind_len = cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)? as usize;
        if kind_len > MAX_WINDOW_STRING_BYTES as usize {
            return Err(DecodeError::BadWindowListPayload);
        }
        let kind = cursor
            .read_utf8(kind_len)
            .ok_or(DecodeError::BadWindowListPayload)?
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        let x11_class_len = cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)? as usize;
        if x11_class_len > MAX_WINDOW_STRING_BYTES as usize {
            return Err(DecodeError::BadWindowListPayload);
        }
        let x11_class = cursor
            .read_utf8(x11_class_len)
            .ok_or(DecodeError::BadWindowListPayload)?
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        let x11_instance_len = cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)? as usize;
        if x11_instance_len > MAX_WINDOW_STRING_BYTES as usize {
            return Err(DecodeError::BadWindowListPayload);
        }
        let x11_instance = cursor
            .read_utf8(x11_instance_len)
            .ok_or(DecodeError::BadWindowListPayload)?
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        let icon_name_len = cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)? as usize;
        if icon_name_len > MAX_WINDOW_STRING_BYTES as usize {
            return Err(DecodeError::BadWindowListPayload);
        }
        let icon_name = cursor
            .read_utf8(icon_name_len)
            .ok_or(DecodeError::BadWindowListPayload)?
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        let icon_buffer_count =
            cursor.read_u32().ok_or(DecodeError::BadWindowListPayload)? as usize;
        if icon_buffer_count > MAX_WINDOW_ICON_BUFFERS as usize {
            return Err(DecodeError::BadWindowListPayload);
        }
        let icon_buffers_bytes = icon_buffer_count
            .checked_mul(12)
            .ok_or(DecodeError::BadWindowListPayload)?;
        if cursor.remaining() < icon_buffers_bytes {
            return Err(DecodeError::BadWindowListPayload);
        }
        let mut icon_buffers = Vec::with_capacity(icon_buffer_count);
        for _ in 0..icon_buffer_count {
            icon_buffers.push(ShellWindowIconBufferSnapshot {
                width: cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
                height: cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
                scale: cursor.read_i32().ok_or(DecodeError::BadWindowListPayload)?,
            });
        }
        off = cursor.offset();
        windows.push(ShellWindowSnapshot {
            window_id,
            surface_id,
            stack_z,
            x,
            y,
            w,
            h,
            client_x,
            client_y,
            client_w,
            client_h,
            frame_x,
            frame_y,
            frame_w,
            frame_h,
            restore_x,
            restore_y,
            restore_w,
            restore_h,
            minimized,
            maximized,
            fullscreen,
            client_side_decoration,
            workspace_visible,
            shell_flags,
            title,
            app_id,
            output_id,
            output_name,
            capture_identifier,
            kind,
            x11_class,
            x11_instance,
            icon_name,
            icon_buffers,
        });
    }
    if off != body.len() {
        return Err(DecodeError::BadWindowListPayload);
    }
    Ok(DecodedCompositorToShellMessage::WindowList { revision, windows })
}

fn decode_window_order_compositor_body(
    body: &[u8],
) -> Result<DecodedCompositorToShellMessage, DecodeError> {
    if body.len() < 16 {
        return Err(DecodeError::BadWindowOrderPayload);
    }
    let mut cursor = WireCursor::new(body);
    let msg = cursor
        .read_u32()
        .ok_or(DecodeError::BadWindowOrderPayload)?;
    if msg != MSG_WINDOW_ORDER {
        return Err(DecodeError::UnknownMsgType);
    }
    let revision = cursor
        .read_u64()
        .ok_or(DecodeError::BadWindowOrderPayload)?;
    let count = cursor
        .read_u32()
        .ok_or(DecodeError::BadWindowOrderPayload)? as usize;
    if count > MAX_WINDOW_LIST_ENTRIES as usize {
        return Err(DecodeError::BadWindowOrderPayload);
    }
    let expected = 16usize
        .checked_add(
            count
                .checked_mul(8)
                .ok_or(DecodeError::BadWindowOrderPayload)?,
        )
        .ok_or(DecodeError::BadWindowOrderPayload)?;
    if body.len() != expected {
        return Err(DecodeError::BadWindowOrderPayload);
    }
    let mut windows = Vec::with_capacity(count);
    for _ in 0..count {
        windows.push(ShellWindowOrderEntry {
            window_id: cursor
                .read_u32()
                .ok_or(DecodeError::BadWindowOrderPayload)?,
            stack_z: cursor
                .read_u32()
                .ok_or(DecodeError::BadWindowOrderPayload)?,
        });
    }
    Ok(DecodedCompositorToShellMessage::WindowOrder { revision, windows })
}

pub fn pop_message(buf: &mut Vec<u8>) -> Result<Option<DecodedMessage>, DecodeError> {
    if buf.len() < 4 {
        return Ok(None);
    }
    let body_len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if body_len > MAX_BODY_BYTES as usize {
        return Err(DecodeError::BodyTooLarge);
    }
    let total = 4 + body_len;
    if buf.len() < total {
        return Ok(None);
    }
    let decoded = decode_shell_to_compositor_body(&buf[4..total])?;
    buf.drain(..total);
    Ok(Some(decoded))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pop_message_decodes_spawn_packets() {
        let mut buf = encode_spawn_wayland_client("foot").unwrap();

        assert_eq!(
            pop_message(&mut buf).unwrap(),
            Some(DecodedMessage::SpawnWaylandClient {
                command: "foot".to_string(),
            })
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn output_layout_round_trip_preserves_primary_output() {
        let packet = encode_output_layout(
            17,
            3840,
            2160,
            3840,
            2160,
            &[OutputLayoutScreen {
                name: "DP-1".into(),
                identity: "make:model:serial".into(),
                x: 0,
                y: 0,
                w: 3840,
                h: 2160,
                usable_x: 0,
                usable_y: 40,
                usable_w: 3840,
                usable_h: 2120,
                physical_w: 3840,
                physical_h: 2160,
                transform: 0,
                refresh_milli_hz: 60000,
                vrr_supported: true,
                vrr_enabled: false,
                taskbar_side: TASKBAR_SIDE_LEFT,
                taskbar_programs: true,
                taskbar_osk: false,
                taskbar_keyboard_layout: true,
                taskbar_clock: true,
            }],
            Some("DP-1"),
            true,
        )
        .unwrap();
        let mut buf = packet;

        assert_eq!(
            pop_compositor_to_shell_message(&mut buf).unwrap(),
            Some(DecodedCompositorToShellMessage::OutputLayout {
                revision: 17,
                canvas_logical_w: 3840,
                canvas_logical_h: 2160,
                canvas_physical_w: 3840,
                canvas_physical_h: 2160,
                screens: vec![OutputLayoutScreen {
                    name: "DP-1".into(),
                    identity: "make:model:serial".into(),
                    x: 0,
                    y: 0,
                    w: 3840,
                    h: 2160,
                    usable_x: 0,
                    usable_y: 40,
                    usable_w: 3840,
                    usable_h: 2120,
                    physical_w: 3840,
                    physical_h: 2160,
                    transform: 0,
                    refresh_milli_hz: 60000,
                    vrr_supported: true,
                    vrr_enabled: false,
                    taskbar_side: TASKBAR_SIDE_LEFT,
                    taskbar_programs: true,
                    taskbar_osk: false,
                    taskbar_keyboard_layout: true,
                    taskbar_clock: true,
                }],
                shell_chrome_primary: Some("DP-1".to_string()),
                taskbar_auto_hide: true,
            })
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn output_layout_decode_defaults_legacy_taskbar_settings() {
        let mut body = Vec::new();
        body.extend_from_slice(&MSG_OUTPUT_LAYOUT.to_le_bytes());
        body.extend_from_slice(&3u64.to_le_bytes());
        body.extend_from_slice(&800u32.to_le_bytes());
        body.extend_from_slice(&600u32.to_le_bytes());
        body.extend_from_slice(&800u32.to_le_bytes());
        body.extend_from_slice(&600u32.to_le_bytes());
        body.extend_from_slice(&1u32.to_le_bytes());
        body.extend_from_slice(&4u32.to_le_bytes());
        body.extend_from_slice(b"DP-1");
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(&10i32.to_le_bytes());
        body.extend_from_slice(&20i32.to_le_bytes());
        body.extend_from_slice(&800u32.to_le_bytes());
        body.extend_from_slice(&600u32.to_le_bytes());
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(&60000u32.to_le_bytes());
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(&0u32.to_le_bytes());
        let mut packet = Vec::new();
        packet.extend_from_slice(&(body.len() as u32).to_le_bytes());
        packet.extend_from_slice(&body);

        assert_eq!(
            pop_compositor_to_shell_message(&mut packet).unwrap(),
            Some(DecodedCompositorToShellMessage::OutputLayout {
                revision: 3,
                canvas_logical_w: 800,
                canvas_logical_h: 600,
                canvas_physical_w: 800,
                canvas_physical_h: 600,
                screens: vec![OutputLayoutScreen {
                    name: "DP-1".into(),
                    identity: "".into(),
                    x: 10,
                    y: 20,
                    w: 800,
                    h: 600,
                    usable_x: 10,
                    usable_y: 20,
                    usable_w: 800,
                    usable_h: 600,
                    physical_w: 800,
                    physical_h: 600,
                    transform: 0,
                    refresh_milli_hz: 60000,
                    vrr_supported: false,
                    vrr_enabled: false,
                    taskbar_side: TASKBAR_SIDE_BOTTOM,
                    taskbar_programs: false,
                    taskbar_osk: false,
                    taskbar_keyboard_layout: false,
                    taskbar_clock: false,
                }],
                shell_chrome_primary: None,
                taskbar_auto_hide: false,
            })
        );
        assert!(packet.is_empty());
    }

    #[test]
    fn window_list_round_trip_preserves_capture_identifier() {
        let packet = encode_window_list(
            23,
            &[ShellWindowSnapshot {
                window_id: 7,
                surface_id: 9,
                stack_z: 11,
                x: 13,
                y: 15,
                w: 640,
                h: 480,
                client_x: 13,
                client_y: 15,
                client_w: 640,
                client_h: 480,
                frame_x: 9,
                frame_y: -11,
                frame_w: 648,
                frame_h: 510,
                restore_x: 21,
                restore_y: 22,
                restore_w: 620,
                restore_h: 430,
                minimized: 0,
                maximized: 1,
                fullscreen: 0,
                client_side_decoration: 1,
                workspace_visible: 1,
                shell_flags: SHELL_WINDOW_FLAG_SHELL_HOSTED,
                title: "Example".to_string(),
                app_id: "app.example".to_string(),
                output_id: "make:model:serial".to_string(),
                output_name: "DP-1".to_string(),
                capture_identifier: "capture-identifier-123".to_string(),
                kind: "native".to_string(),
                x11_class: "ExampleClass".to_string(),
                x11_instance: "example-instance".to_string(),
                icon_name: "utilities-terminal".to_string(),
                icon_buffers: vec![ShellWindowIconBufferSnapshot {
                    width: 32,
                    height: 32,
                    scale: 1,
                }],
            }],
        )
        .unwrap();
        let mut buf = packet;

        assert_eq!(
            pop_compositor_to_shell_message(&mut buf).unwrap(),
            Some(DecodedCompositorToShellMessage::WindowList {
                revision: 23,
                windows: vec![ShellWindowSnapshot {
                    window_id: 7,
                    surface_id: 9,
                    stack_z: 11,
                    x: 13,
                    y: 15,
                    w: 640,
                    h: 480,
                    client_x: 13,
                    client_y: 15,
                    client_w: 640,
                    client_h: 480,
                    frame_x: 9,
                    frame_y: -11,
                    frame_w: 648,
                    frame_h: 510,
                    restore_x: 21,
                    restore_y: 22,
                    restore_w: 620,
                    restore_h: 430,
                    minimized: 0,
                    maximized: 1,
                    fullscreen: 0,
                    client_side_decoration: 1,
                    workspace_visible: 1,
                    shell_flags: SHELL_WINDOW_FLAG_SHELL_HOSTED,
                    title: "Example".to_string(),
                    app_id: "app.example".to_string(),
                    output_id: "make:model:serial".to_string(),
                    output_name: "DP-1".to_string(),
                    capture_identifier: "capture-identifier-123".to_string(),
                    kind: "native".to_string(),
                    x11_class: "ExampleClass".to_string(),
                    x11_instance: "example-instance".to_string(),
                    icon_name: "utilities-terminal".to_string(),
                    icon_buffers: vec![ShellWindowIconBufferSnapshot {
                        width: 32,
                        height: 32,
                        scale: 1,
                    }],
                }]
            })
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn window_order_round_trip_preserves_stack_values() {
        let packet = encode_window_order(
            31,
            &[
                ShellWindowOrderEntry {
                    window_id: 7,
                    stack_z: 12,
                },
                ShellWindowOrderEntry {
                    window_id: 9,
                    stack_z: 14,
                },
            ],
        )
        .unwrap();
        let mut buf = packet;

        assert_eq!(
            pop_compositor_to_shell_message(&mut buf).unwrap(),
            Some(DecodedCompositorToShellMessage::WindowOrder {
                revision: 31,
                windows: vec![
                    ShellWindowOrderEntry {
                        window_id: 7,
                        stack_z: 12,
                    },
                    ShellWindowOrderEntry {
                        window_id: 9,
                        stack_z: 14,
                    },
                ],
            })
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn pop_message_rejects_oversized_packets() {
        let mut buf = (MAX_BODY_BYTES + 1).to_le_bytes().to_vec();

        assert_eq!(pop_message(&mut buf), Err(DecodeError::BodyTooLarge));
    }

    fn set_body_u32(packet: &mut [u8], body_offset: usize, value: u32) {
        packet[4 + body_offset..4 + body_offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn shell_context_menu_packet(visible: u32) -> Vec<u8> {
        let body_len = 40u32;
        let mut v = Vec::new();
        v.extend_from_slice(&body_len.to_le_bytes());
        v.extend_from_slice(&MSG_SHELL_CONTEXT_MENU.to_le_bytes());
        v.extend_from_slice(&visible.to_le_bytes());
        v.extend_from_slice(&1i32.to_le_bytes());
        v.extend_from_slice(&2i32.to_le_bytes());
        v.extend_from_slice(&3u32.to_le_bytes());
        v.extend_from_slice(&4u32.to_le_bytes());
        v.extend_from_slice(&5i32.to_le_bytes());
        v.extend_from_slice(&6i32.to_le_bytes());
        v.extend_from_slice(&7u32.to_le_bytes());
        v.extend_from_slice(&8u32.to_le_bytes());
        v
    }

    fn assert_shell_malformed_no_panic(mut packet: Vec<u8>) {
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| pop_message(&mut packet)));
        assert!(result.is_ok());
        assert!(result.unwrap().is_err());
    }

    fn assert_compositor_malformed_no_panic(mut packet: Vec<u8>) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            pop_compositor_to_shell_message(&mut packet)
        }));
        assert!(result.is_ok());
        assert!(result.unwrap().is_err());
    }

    fn truncated_packet(packet: &[u8]) -> Vec<u8> {
        let body_len = u32::from_le_bytes(packet[0..4].try_into().unwrap()) as usize;
        assert!(body_len > 0);
        let truncated_body_len = body_len - 1;
        let mut v = Vec::new();
        v.extend_from_slice(&(truncated_body_len as u32).to_le_bytes());
        v.extend_from_slice(&packet[4..4 + truncated_body_len]);
        v
    }

    fn oversized_string_shell_packet(msg: u32, max_len: u32) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&8u32.to_le_bytes());
        v.extend_from_slice(&msg.to_le_bytes());
        v.extend_from_slice(&(max_len + 1).to_le_bytes());
        v
    }

    fn partial_string_shell_packet(msg: u32) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&10u32.to_le_bytes());
        v.extend_from_slice(&msg.to_le_bytes());
        v.extend_from_slice(&4u32.to_le_bytes());
        v.extend_from_slice(b"ab");
        v
    }

    fn partial_string_compositor_packet(msg: u32) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&10u32.to_le_bytes());
        v.extend_from_slice(&msg.to_le_bytes());
        v.extend_from_slice(&4u32.to_le_bytes());
        v.extend_from_slice(b"ab");
        v
    }

    #[test]
    fn malformed_shell_to_compositor_frames_do_not_panic() {
        let mut packets = vec![
            encode_spawn_wayland_client("weston-terminal").unwrap(),
            encode_frame_dmabuf_commit(
                10,
                10,
                875713112,
                0,
                0,
                1,
                &[FrameDmabufPlane {
                    plane_idx: 0,
                    stride: 40,
                    offset: 0,
                }],
            )
            .unwrap(),
            encode_shell_move_begin(1),
            encode_shell_move_delta(1, 2),
            encode_shell_move_end(1),
            encode_shell_resize_begin(1, RESIZE_EDGE_RIGHT).unwrap(),
            encode_shell_resize_delta(1, 2),
            encode_shell_resize_end(1),
            encode_shell_list_windows(),
            encode_shell_set_geometry_with_layout(1, 2, 3, 4, 5, 6),
            encode_shell_close(1),
            encode_shell_set_fullscreen(1, true),
            encode_shell_set_maximized(1, true),
            encode_shell_set_presentation_fullscreen(true),
            encode_shell_set_output_layout_json("{}").unwrap(),
            encode_shell_taskbar_activate(1),
            encode_shell_minimize(1),
            encode_shell_quit_compositor(),
            encode_shell_tile_preview(true, 1, 2, 3, 4),
            encode_shell_chrome_metrics(30, 1),
            encode_shell_windows_sync(
                1,
                &[ShellUiWindowWireRow {
                    id: 1,
                    gx: 0,
                    gy: 0,
                    gw: 100,
                    gh: 100,
                    z: 1,
                    flags: 0,
                }],
            )
            .unwrap(),
            encode_shell_workspace_mutation("{}").unwrap(),
            shell_context_menu_packet(1),
        ];

        for packet in packets.drain(..) {
            assert_shell_malformed_no_panic(truncated_packet(&packet));
        }

        assert_shell_malformed_no_panic((MAX_BODY_BYTES + 1).to_le_bytes().to_vec());

        let mut fullscreen = encode_shell_set_fullscreen(1, true);
        set_body_u32(&mut fullscreen, 8, 2);
        assert_shell_malformed_no_panic(fullscreen);
        let mut maximized = encode_shell_set_maximized(1, true);
        set_body_u32(&mut maximized, 8, 2);
        assert_shell_malformed_no_panic(maximized);
        let mut presentation = encode_shell_set_presentation_fullscreen(true);
        set_body_u32(&mut presentation, 4, 2);
        assert_shell_malformed_no_panic(presentation);
        let mut resize = encode_shell_resize_begin(1, RESIZE_EDGE_RIGHT).unwrap();
        set_body_u32(&mut resize, 8, 16);
        assert_shell_malformed_no_panic(resize);
        let mut context = shell_context_menu_packet(1);
        set_body_u32(&mut context, 4, 2);
        assert_shell_malformed_no_panic(context);

        assert_shell_malformed_no_panic(oversized_string_shell_packet(
            MSG_SPAWN_WAYLAND_CLIENT,
            MAX_SPAWN_COMMAND_BYTES,
        ));
        assert_shell_malformed_no_panic(partial_string_shell_packet(MSG_SPAWN_WAYLAND_CLIENT));
        assert_shell_malformed_no_panic(oversized_string_shell_packet(
            MSG_SHELL_SET_OUTPUT_LAYOUT,
            MAX_SHELL_OUTPUT_LAYOUT_JSON_BYTES,
        ));
        assert_shell_malformed_no_panic(partial_string_shell_packet(MSG_SHELL_SET_OUTPUT_LAYOUT));
        assert_shell_malformed_no_panic(oversized_string_shell_packet(
            MSG_SHELL_WORKSPACE_MUTATION,
            MAX_WORKSPACE_JSON_BYTES,
        ));
        assert_shell_malformed_no_panic(partial_string_shell_packet(MSG_SHELL_WORKSPACE_MUTATION));
    }

    #[test]
    fn malformed_compositor_to_shell_frames_do_not_panic() {
        let screen = OutputLayoutScreen {
            name: "DP-1".to_string(),
            identity: "make:model:serial".to_string(),
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
            usable_x: 0,
            usable_y: 0,
            usable_w: 1920,
            usable_h: 1040,
            physical_w: 1920,
            physical_h: 1080,
            transform: 0,
            refresh_milli_hz: 60000,
            vrr_supported: false,
            vrr_enabled: false,
            taskbar_side: TASKBAR_SIDE_BOTTOM,
            taskbar_programs: true,
            taskbar_osk: true,
            taskbar_keyboard_layout: true,
            taskbar_clock: true,
        };
        let window = ShellWindowSnapshot {
            window_id: 7,
            surface_id: 9,
            stack_z: 11,
            x: 13,
            y: 15,
            w: 640,
            h: 480,
            client_x: 13,
            client_y: 15,
            client_w: 640,
            client_h: 480,
            frame_x: 9,
            frame_y: -11,
            frame_w: 648,
            frame_h: 510,
            restore_x: 21,
            restore_y: 22,
            restore_w: 620,
            restore_h: 430,
            minimized: 0,
            maximized: 1,
            fullscreen: 0,
            client_side_decoration: 1,
            workspace_visible: 1,
            shell_flags: SHELL_WINDOW_FLAG_SHELL_HOSTED,
            title: "Example".to_string(),
            app_id: "app.example".to_string(),
            output_id: "make:model:serial".to_string(),
            output_name: "DP-1".to_string(),
            capture_identifier: "capture".to_string(),
            kind: "native".to_string(),
            x11_class: "ExampleClass".to_string(),
            x11_instance: "example-instance".to_string(),
            icon_name: "utilities-terminal".to_string(),
            icon_buffers: vec![ShellWindowIconBufferSnapshot {
                width: 32,
                height: 32,
                scale: 1,
            }],
        };
        let mut packets = vec![
            encode_compositor_pointer_move(1, 2, 0),
            encode_compositor_pointer_button(1, 2, 0, false, 0, 0),
            encode_compositor_touch(1, TOUCH_PHASE_MOVED, 2, 3),
            encode_compositor_pointer_axis(1, 2, 3, 4, 0),
            encode_compositor_key(CEF_KEYEVENT_KEYDOWN, 0, 65, 65, 65, 65),
            encode_compositor_ime_commit_text("abc").unwrap(),
            encode_output_geometry(1920, 1080, 1920, 1080),
            encode_output_layout(
                1,
                1920,
                1080,
                1920,
                1080,
                &[screen.clone()],
                Some("DP-1"),
                false,
            )
            .unwrap(),
            encode_window_mapped(1, 2, 3, 4, 5, 6, "Title", "app", true, "DP-1").unwrap(),
            encode_window_unmapped(1),
            encode_window_geometry(
                1, 2, 3, 4, 5, 6, 3, 4, 5, 6, 2, 3, 7, 8, false, false, true, "DP-1",
            )
            .unwrap(),
            encode_window_metadata(
                1,
                2,
                "Title",
                "app",
                "utilities-terminal",
                &[ShellWindowIconBufferSnapshot {
                    width: 32,
                    height: 32,
                    scale: 1,
                }],
            )
            .unwrap(),
            encode_focus_changed(Some(1), Some(2)),
            encode_window_state(1, true),
            encode_window_list(1, &[window.clone()]).unwrap(),
            encode_window_order(
                1,
                &[ShellWindowOrderEntry {
                    window_id: 1,
                    stack_z: 2,
                }],
            )
            .unwrap(),
            encode_compositor_context_menu_dismiss(),
            encode_compositor_programs_menu_toggle(),
            encode_compositor_keybind("workspace-next", 0, Some("DP-1")).unwrap(),
            encode_compositor_keyboard_layout("us").unwrap(),
            encode_compositor_volume_overlay(5000, true, true),
            encode_compositor_workspace_state(1, "{}").unwrap(),
            encode_compositor_shell_hosted_app_state(1, "{}").unwrap(),
            encode_compositor_command_palette_state(1, "{}").unwrap(),
            encode_compositor_interaction_state(1, 2, 0, 0, 0, 0, 0, 0, None, None, 0, false),
            encode_compositor_native_drag_preview(1, 1, "C:\\tmp\\preview.png").unwrap(),
            encode_compositor_tray_hints(1, 24, 24),
            encode_compositor_tray_sni(&[TraySniItemWire {
                id: "id".to_string(),
                title: "Title".to_string(),
                icon_png: vec![1, 2, 3],
            }])
            .unwrap(),
        ];

        for packet in packets.drain(..) {
            assert_compositor_malformed_no_panic(truncated_packet(&packet));
        }

        assert_compositor_malformed_no_panic((MAX_BODY_BYTES + 1).to_le_bytes().to_vec());

        let mut button = encode_compositor_pointer_button(1, 2, 0, false, 0, 0);
        set_body_u32(&mut button, 12, 3);
        assert_compositor_malformed_no_panic(button);
        let mut touch = encode_compositor_touch(1, TOUCH_PHASE_MOVED, 2, 3);
        set_body_u32(&mut touch, 8, TOUCH_PHASE_CANCELLED + 1);
        assert_compositor_malformed_no_panic(touch);
        let mut key = encode_compositor_key(CEF_KEYEVENT_KEYDOWN, 0, 65, 65, 65, 65);
        set_body_u32(&mut key, 4, 4);
        assert_compositor_malformed_no_panic(key);
        let mut state = encode_window_state(1, true);
        set_body_u32(&mut state, 8, 2);
        assert_compositor_malformed_no_panic(state);

        let mut layout =
            encode_output_layout(1, 1920, 1080, 1920, 1080, &[screen], Some("DP-1"), false)
                .unwrap();
        set_body_u32(&mut layout, 32, MAX_OUTPUT_LAYOUT_NAME_BYTES + 1);
        assert_compositor_malformed_no_panic(layout);
        let mut mapped =
            encode_window_mapped(1, 2, 3, 4, 5, 6, "Title", "app", true, "DP-1").unwrap();
        set_body_u32(&mut mapped, 28, MAX_WINDOW_STRING_BYTES + 1);
        assert_compositor_malformed_no_panic(mapped);
        let mut metadata = encode_window_metadata(
            1,
            2,
            "Title",
            "app",
            "utilities-terminal",
            &[ShellWindowIconBufferSnapshot {
                width: 32,
                height: 32,
                scale: 1,
            }],
        )
        .unwrap();
        let metadata_icon_count_offset =
            36 + "Title".len() + "app".len() + 4 + "utilities-terminal".len();
        set_body_u32(
            &mut metadata,
            metadata_icon_count_offset,
            MAX_WINDOW_ICON_BUFFERS + 1,
        );
        assert_compositor_malformed_no_panic(metadata);
        let mut geometry = encode_window_geometry(
            1, 2, 3, 4, 5, 6, 3, 4, 5, 6, 2, 3, 7, 8, false, false, true, "DP-1",
        )
        .unwrap();
        set_body_u32(&mut geometry, 28, 2);
        assert_compositor_malformed_no_panic(geometry);
        let mut list = encode_window_list(1, &[window]).unwrap();
        set_body_u32(&mut list, 20, (WINDOW_LIST_ROW_BYTES + 4) as u32);
        assert_compositor_malformed_no_panic(list);
        let mut order = encode_window_order(
            1,
            &[ShellWindowOrderEntry {
                window_id: 1,
                stack_z: 2,
            }],
        )
        .unwrap();
        set_body_u32(&mut order, 12, MAX_WINDOW_LIST_ENTRIES + 1);
        assert_compositor_malformed_no_panic(order);

        assert_compositor_malformed_no_panic(partial_string_compositor_packet(
            MSG_COMPOSITOR_KEYBOARD_LAYOUT,
        ));
        assert_compositor_malformed_no_panic(partial_string_compositor_packet(
            MSG_COMPOSITOR_KEYBIND,
        ));
        assert_compositor_malformed_no_panic(partial_string_compositor_packet(
            MSG_COMPOSITOR_IME_COMMIT_TEXT,
        ));
    }

    #[test]
    fn wire_cursor_reads_checked_little_endian_scalars() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&7u32.to_le_bytes());
        payload.extend_from_slice(&(-12i32).to_le_bytes());
        let mut cursor = WireCursor::new(&payload);

        assert_eq!(cursor.read_u32(), Some(7));
        assert_eq!(cursor.read_i32(), Some(-12));
        assert_eq!(cursor.read_u32(), None);
    }
}

fn decode_shell_to_compositor_body(body: &[u8]) -> Result<DecodedMessage, DecodeError> {
    let mut cursor = WireCursor::new(body);
    let msg = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
    match msg {
        MSG_SPAWN_WAYLAND_CLIENT => decode_spawn_body(body),
        MSG_SHELL_MOVE_BEGIN => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            Ok(DecodedMessage::ShellMoveBegin { window_id })
        }
        MSG_SHELL_MOVE_DELTA => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let dx = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let dy = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            Ok(DecodedMessage::ShellMoveDelta { dx, dy })
        }
        MSG_SHELL_MOVE_END => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            Ok(DecodedMessage::ShellMoveEnd { window_id })
        }
        MSG_SHELL_RESIZE_BEGIN => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            let edges = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            if edges == 0 || edges > 15 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(DecodedMessage::ShellResizeBegin { window_id, edges })
        }
        MSG_SHELL_RESIZE_DELTA => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let dx = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let dy = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            Ok(DecodedMessage::ShellResizeDelta { dx, dy })
        }
        MSG_SHELL_RESIZE_END => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            Ok(DecodedMessage::ShellResizeEnd { window_id })
        }
        MSG_SHELL_LIST_WINDOWS => {
            if body.len() != 4 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(DecodedMessage::ShellListWindows)
        }
        MSG_SHELL_SET_GEOMETRY => {
            let layout_state = if body.len() == 28 {
                let mut tail = WireCursor::new(&body[24..]);
                tail.read_u32().ok_or(DecodeError::BadWindowPayload)?
            } else if body.len() == 24 {
                0u32
            } else {
                return Err(DecodeError::BadWindowPayload);
            };
            let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            let x = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let y = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let width = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let height = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            Ok(DecodedMessage::ShellSetGeometry {
                window_id,
                x,
                y,
                width,
                height,
                layout_state,
            })
        }
        MSG_SHELL_CLOSE => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            Ok(DecodedMessage::ShellClose { window_id })
        }
        MSG_SHELL_SET_FULLSCREEN => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            let en = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            if en > 1 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(DecodedMessage::ShellSetFullscreen {
                window_id,
                enabled: en != 0,
            })
        }
        MSG_SHELL_SET_MAXIMIZED => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            let en = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            if en > 1 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(DecodedMessage::ShellSetMaximized {
                window_id,
                enabled: en != 0,
            })
        }
        MSG_SHELL_SET_PRESENTATION_FULLSCREEN => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let en = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            if en > 1 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(DecodedMessage::ShellSetPresentationFullscreen { enabled: en != 0 })
        }
        MSG_SHELL_TASKBAR_ACTIVATE => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            Ok(DecodedMessage::ShellTaskbarActivate { window_id })
        }
        MSG_SHELL_MINIMIZE => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            Ok(DecodedMessage::ShellMinimize { window_id })
        }
        MSG_SHELL_QUIT_COMPOSITOR => {
            if body.len() != 4 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(DecodedMessage::ShellQuitCompositor)
        }
        MSG_SHELL_SET_OUTPUT_LAYOUT => {
            if body.len() < 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let jl = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)? as usize;
            if jl == 0 || jl > MAX_SHELL_OUTPUT_LAYOUT_JSON_BYTES as usize {
                return Err(DecodeError::BadWindowPayload);
            }
            if body.len() != 8 + jl {
                return Err(DecodeError::BadWindowPayload);
            }
            let layout_json =
                std::str::from_utf8(cursor.read_bytes(jl).ok_or(DecodeError::BadWindowPayload)?)
                    .map_err(|_| DecodeError::BadUtf8Command)?;
            Ok(DecodedMessage::ShellSetOutputLayout {
                layout_json: layout_json.to_string(),
            })
        }
        MSG_FRAME_DMABUF_COMMIT => decode_frame_dmabuf_commit_body(body),
        MSG_SHELL_WINDOWS_SYNC => {
            if body.len() < 12 {
                return Err(DecodeError::BadShellWindowsPayload);
            }
            let mut cursor = WireCursor::new(&body[4..]);
            let generation = cursor
                .read_u32()
                .ok_or(DecodeError::BadShellWindowsPayload)?;
            let count = cursor
                .read_u32()
                .ok_or(DecodeError::BadShellWindowsPayload)?;
            if count > MAX_SHELL_UI_WINDOWS {
                return Err(DecodeError::BadShellWindowsPayload);
            }
            let need = 12usize
                .checked_add(
                    (count as usize)
                        .checked_mul(28)
                        .ok_or(DecodeError::BadShellWindowsPayload)?,
                )
                .ok_or(DecodeError::BadShellWindowsPayload)?;
            if body.len() != need {
                return Err(DecodeError::BadShellWindowsPayload);
            }
            let mut windows = Vec::with_capacity(count as usize);
            for _ in 0..count {
                let id = cursor
                    .read_u32()
                    .ok_or(DecodeError::BadShellWindowsPayload)?;
                let gx = cursor
                    .read_i32()
                    .ok_or(DecodeError::BadShellWindowsPayload)?;
                let gy = cursor
                    .read_i32()
                    .ok_or(DecodeError::BadShellWindowsPayload)?;
                let gw = cursor
                    .read_u32()
                    .ok_or(DecodeError::BadShellWindowsPayload)?;
                let gh = cursor
                    .read_u32()
                    .ok_or(DecodeError::BadShellWindowsPayload)?;
                let z = cursor
                    .read_u32()
                    .ok_or(DecodeError::BadShellWindowsPayload)?;
                let flags = cursor
                    .read_u32()
                    .ok_or(DecodeError::BadShellWindowsPayload)?;
                if id == 0 || gw == 0 || gh == 0 {
                    return Err(DecodeError::BadShellWindowsPayload);
                }
                windows.push(ShellUiWindowWireRow {
                    id,
                    gx,
                    gy,
                    gw,
                    gh,
                    z,
                    flags,
                });
            }
            Ok(DecodedMessage::ShellWindowsSync {
                generation,
                windows,
            })
        }
        MSG_SHELL_WORKSPACE_MUTATION => {
            if body.len() < 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let len = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)? as usize;
            if len == 0 || len > MAX_WORKSPACE_JSON_BYTES as usize {
                return Err(DecodeError::BadWindowPayload);
            }
            let end = 8usize
                .checked_add(len)
                .ok_or(DecodeError::BadWindowPayload)?;
            if body.len() != end {
                return Err(DecodeError::BadWindowPayload);
            }
            let mutation_json = std::str::from_utf8(
                cursor
                    .read_bytes(len)
                    .ok_or(DecodeError::BadWindowPayload)?,
            )
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
            Ok(DecodedMessage::ShellWorkspaceMutation { mutation_json })
        }
        MSG_SHELL_CONTEXT_MENU => {
            if body.len() != 40 {
                return Err(DecodeError::BadWindowPayload);
            }
            let vis = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            if vis > 1 {
                return Err(DecodeError::BadWindowPayload);
            }
            let bx = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let by = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let bw = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            let bh = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            let gx = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let gy = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let gw = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            let gh = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            Ok(DecodedMessage::ShellContextMenu {
                visible: vis != 0,
                bx,
                by,
                bw,
                bh,
                gx,
                gy,
                gw,
                gh,
            })
        }
        MSG_SHELL_TILE_PREVIEW => {
            if body.len() != 24 {
                return Err(DecodeError::BadWindowPayload);
            }
            let vis = cursor.read_u32().ok_or(DecodeError::BadWindowPayload)?;
            if vis > 1 {
                return Err(DecodeError::BadWindowPayload);
            }
            let x = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let y = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let width = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let height = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            Ok(DecodedMessage::ShellTilePreview {
                visible: vis != 0,
                x,
                y,
                width,
                height,
            })
        }
        MSG_SHELL_CHROME_METRICS => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let titlebar_h = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            let border_w = cursor.read_i32().ok_or(DecodeError::BadWindowPayload)?;
            if titlebar_h < 0 || titlebar_h > 256 || border_w < 0 || border_w > 64 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(DecodedMessage::ShellChromeMetrics {
                titlebar_h,
                border_w,
            })
        }
        _ => Err(DecodeError::UnknownMsgType),
    }
}

fn decode_frame_dmabuf_commit_body(body: &[u8]) -> Result<DecodedMessage, DecodeError> {
    let mut cursor = WireCursor::new(body);
    let msg = cursor
        .read_u32()
        .ok_or(DecodeError::BadDmabufCommitPayload)?;
    if msg != MSG_FRAME_DMABUF_COMMIT {
        return Err(DecodeError::UnknownMsgType);
    }
    let width = cursor
        .read_u32()
        .ok_or(DecodeError::BadDmabufCommitPayload)?;
    let height = cursor
        .read_u32()
        .ok_or(DecodeError::BadDmabufCommitPayload)?;
    let drm_format = cursor
        .read_u32()
        .ok_or(DecodeError::BadDmabufCommitPayload)?;
    let modifier = cursor
        .read_u64()
        .ok_or(DecodeError::BadDmabufCommitPayload)?;
    let plane_count = cursor
        .read_u32()
        .ok_or(DecodeError::BadDmabufCommitPayload)?;
    let flags = cursor
        .read_u32()
        .ok_or(DecodeError::BadDmabufCommitPayload)?;
    let generation = cursor
        .read_u32()
        .ok_or(DecodeError::BadDmabufCommitPayload)?;
    if plane_count == 0 || plane_count > MAX_DMABUF_PLANES {
        return Err(DecodeError::BadDmabufCommitPayload);
    }
    let need = 36usize
        .checked_add(
            (plane_count as usize)
                .checked_mul(16)
                .ok_or(DecodeError::BadDmabufCommitPayload)?,
        )
        .ok_or(DecodeError::BadDmabufCommitPayload)?;
    if body.len() != need {
        return Err(DecodeError::BadDmabufCommitPayload);
    }
    let mut planes = Vec::with_capacity(plane_count as usize);
    for _ in 0..plane_count {
        let plane_idx = cursor
            .read_u32()
            .ok_or(DecodeError::BadDmabufCommitPayload)?;
        let stride = cursor
            .read_u32()
            .ok_or(DecodeError::BadDmabufCommitPayload)?;
        let offset = cursor
            .read_u64()
            .ok_or(DecodeError::BadDmabufCommitPayload)?;
        planes.push(FrameDmabufPlane {
            plane_idx,
            stride,
            offset,
        });
    }
    Ok(DecodedMessage::FrameDmabufCommit {
        width,
        height,
        drm_format,
        modifier,
        flags,
        generation,
        planes,
    })
}

fn decode_spawn_body(body: &[u8]) -> Result<DecodedMessage, DecodeError> {
    let mut cursor = WireCursor::new(body);
    let msg = cursor.read_u32().ok_or(DecodeError::BadSpawnPayload)?;
    if msg != MSG_SPAWN_WAYLAND_CLIENT {
        return Err(DecodeError::UnknownMsgType);
    }
    let cmd_len = cursor.read_u32().ok_or(DecodeError::BadSpawnPayload)? as usize;
    if cmd_len > MAX_SPAWN_COMMAND_BYTES as usize {
        return Err(DecodeError::BadSpawnPayload);
    }
    let end = 8usize
        .checked_add(cmd_len)
        .ok_or(DecodeError::BadSpawnPayload)?;
    if body.len() != end {
        return Err(DecodeError::BadSpawnPayload);
    }
    if cmd_len == 0 {
        return Err(DecodeError::BadSpawnPayload);
    }
    let cmd_bytes = cursor
        .read_bytes(cmd_len)
        .ok_or(DecodeError::BadSpawnPayload)?;
    if cmd_bytes.contains(&0) {
        return Err(DecodeError::BadSpawnPayload);
    }
    let command = std::str::from_utf8(cmd_bytes).map_err(|_| DecodeError::BadUtf8Command)?;
    Ok(DecodedMessage::SpawnWaylandClient {
        command: command.to_string(),
    })
}
