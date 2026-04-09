//! Wire format: `[u32 body_len LE][body]` where `body` is a single message.
//!
//! Spawn message body (`msg_type` [`MSG_SPAWN_WAYLAND_CLIENT`]):
//! - `u32 msg_type`, `u32 command_len`, then `command_len` UTF-8 bytes (no NUL).
//!
//! Compositor → shell process, same length-prefixed framing:
//! - [`MSG_COMPOSITOR_POINTER_MOVE`], [`MSG_COMPOSITOR_POINTER_BUTTON`], [`MSG_COMPOSITOR_POINTER_AXIS`], [`MSG_COMPOSITOR_KEY`], [`MSG_COMPOSITOR_TOUCH`] (legacy; current session uses `wl_seat` only)
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
//!   [`MSG_SHELL_TASKBAR_ACTIVATE`], [`MSG_SHELL_MINIMIZE`], [`MSG_SHELL_QUIT_COMPOSITOR`], [`MSG_SHELL_PONG`] (reply to [`MSG_COMPOSITOR_PING`]),
//!   [`MSG_SHELL_RESIZE_BEGIN`], [`MSG_SHELL_RESIZE_DELTA`], [`MSG_SHELL_RESIZE_END`], [`MSG_SHELL_SET_MAXIMIZED`], [`MSG_SHELL_SET_PRESENTATION_FULLSCREEN`], [`MSG_SHELL_CONTEXT_MENU`], [`MSG_SHELL_TILE_PREVIEW`], [`MSG_SHELL_CHROME_METRICS`], [`MSG_SHELL_WINDOWS_SYNC`] (**breaking:** deploy `compositor` + `cef_host` + `shell_wire` together)
//! - compositor → shell: [`MSG_WINDOW_LIST`] rows include `shell_flags` ([`SHELL_WINDOW_FLAG_SHELL_HOSTED`] for compositor-backed OSR frames); [`MSG_FOCUS_CHANGED`] is the only compositor → shell focus event; [`MSG_WINDOW_STATE`], [`MSG_COMPOSITOR_PING`]; [`MSG_OUTPUT_LAYOUT`] includes trailing `context_menu_atlas_buffer_h`; [`MSG_COMPOSITOR_KEYBOARD_LAYOUT`]; [`MSG_COMPOSITOR_VOLUME_OVERLAY`]

pub const MSG_SPAWN_WAYLAND_CLIENT: u32 = 2;
pub const MSG_COMPOSITOR_POINTER_MOVE: u32 = 3;
pub const MSG_COMPOSITOR_POINTER_BUTTON: u32 = 4;
/// Real touch finger / slot (not pointer-emulated mouse). Maps to CEF [`send_touch_event`].
pub const MSG_COMPOSITOR_TOUCH: u32 = 31;
/// Compositor → shell: watchdog keepalive; [`cef_host`] must reply with [`MSG_SHELL_PONG`].
pub const MSG_COMPOSITOR_PING: u32 = 32;

/// [`MSG_COMPOSITOR_TOUCH`] `phase` values (compositor → `cef_host` → CEF).
pub const TOUCH_PHASE_MOVED: u32 = 0;
pub const TOUCH_PHASE_PRESSED: u32 = 1;
pub const TOUCH_PHASE_RELEASED: u32 = 2;
pub const TOUCH_PHASE_CANCELLED: u32 = 3;
/// Compositor output size in **logical** pixels (match winit / Smithay output mode).
pub const MSG_OUTPUT_GEOMETRY: u32 = 5;
pub const MSG_WINDOW_MAPPED: u32 = 6;
pub const MSG_WINDOW_UNMAPPED: u32 = 7;
pub const MSG_WINDOW_GEOMETRY: u32 = 8;
pub const MSG_WINDOW_METADATA: u32 = 9;
pub const MSG_FOCUS_CHANGED: u32 = 10;
/// Compositor → shell: snapshot of all mapped toplevels (reply to [`MSG_SHELL_LIST_WINDOWS`]).
pub const MSG_WINDOW_LIST: u32 = 11;

pub const MSG_SHELL_MOVE_BEGIN: u32 = 20;
pub const MSG_SHELL_MOVE_DELTA: u32 = 21;
pub const MSG_SHELL_MOVE_END: u32 = 22;

/// Shell → compositor: request [`MSG_WINDOW_LIST`] reply.
pub const MSG_SHELL_LIST_WINDOWS: u32 = 23;
pub const MSG_SHELL_SET_GEOMETRY: u32 = 24;
pub const MSG_SHELL_CLOSE: u32 = 25;
pub const MSG_SHELL_SET_FULLSCREEN: u32 = 26;
/// Shell → compositor: stop the compositor event loop (end session).
pub const MSG_SHELL_QUIT_COMPOSITOR: u32 = 27;
/// Shell → compositor: reply to [`MSG_COMPOSITOR_PING`] (watchdog liveness).
pub const MSG_SHELL_PONG: u32 = 30;

/// Shell → compositor: dma-buf frame metadata (`drm_format` = raw DRM FourCC). Plane fds follow via `SCM_RIGHTS`.
pub const MSG_FRAME_DMABUF_COMMIT: u32 = 33;
/// Compositor → shell: mouse wheel / scroll (libinput pointer axis) at buffer-space `(x,y)`; `delta_*` are CEF wheel units (often same scale as libinput `amount_v120`).
pub const MSG_COMPOSITOR_POINTER_AXIS: u32 = 34;
/// Compositor → shell: keyboard for CEF OSR (`cef_event_flags_t` modifiers + CEF key event types).
pub const MSG_COMPOSITOR_KEY: u32 = 35;
/// Shell → compositor: taskbar button — focus, restore from minimized, or minimize if already focused.
pub const MSG_SHELL_TASKBAR_ACTIVATE: u32 = 36;
/// Compositor → shell: minimized state changed (`minimized`: 0 or 1).
pub const MSG_WINDOW_STATE: u32 = 37;
/// Shell → compositor: minimize a toplevel (unmap + stash).
pub const MSG_SHELL_MINIMIZE: u32 = 38;
/// Shell → compositor: start interactive resize (`edges` = bitmask matching `xdg_toplevel::resize_edge` / Smithay resize bits).
pub const MSG_SHELL_RESIZE_BEGIN: u32 = 39;
/// Shell → compositor: pointer delta while resizing (same coordinate spirit as [`MSG_SHELL_MOVE_DELTA`]).
pub const MSG_SHELL_RESIZE_DELTA: u32 = 40;
/// Shell → compositor: end interactive resize for `window_id`.
pub const MSG_SHELL_RESIZE_END: u32 = 41;
/// Shell → compositor: set native toplevel maximized (xdg configure).
pub const MSG_SHELL_SET_MAXIMIZED: u32 = 42;
/// Shell → compositor: OSR shell plane above native windows (HTML5 presentation fullscreen).
pub const MSG_SHELL_SET_PRESENTATION_FULLSCREEN: u32 = 43;
pub const MSG_OUTPUT_LAYOUT: u32 = 44;
pub const MSG_SHELL_SET_OUTPUT_LAYOUT: u32 = 45;
/// Shell → compositor: context menu atlas placement (buffer rect + global logical rect).
pub const MSG_SHELL_CONTEXT_MENU: u32 = 46;
/// Compositor → shell: close context menu (e.g. click outside); shell must hide UI without echoing [`MSG_SHELL_CONTEXT_MENU`].
pub const MSG_COMPOSITOR_CONTEXT_MENU_DISMISS: u32 = 47;
pub const MSG_SHELL_TILE_PREVIEW: u32 = 48;
pub const MSG_SHELL_CHROME_METRICS: u32 = 49;
/// Compositor → shell: toggle Programs menu (Win/Super tap when keyboard was on a native client).
pub const MSG_COMPOSITOR_PROGRAMS_MENU_TOGGLE: u32 = 50;
pub const MSG_COMPOSITOR_KEYBIND: u32 = 51;
/// Compositor → shell: active keyboard layout short label (UTF-8).
pub const MSG_COMPOSITOR_KEYBOARD_LAYOUT: u32 = 52;
pub const MSG_COMPOSITOR_VOLUME_OVERLAY: u32 = 53;
/// Shell → compositor: replace registered **shell UI windows** (global layout + z); compositor derives buffer rects.
pub const MSG_SHELL_WINDOWS_SYNC: u32 = 54;

/// Bit flags for [`MSG_SHELL_RESIZE_BEGIN`] `edges` (align with Wayland `resize_edge` enum values used in compositor).
pub const RESIZE_EDGE_TOP: u32 = 1;
pub const RESIZE_EDGE_BOTTOM: u32 = 2;
pub const RESIZE_EDGE_LEFT: u32 = 4;
pub const RESIZE_EDGE_RIGHT: u32 = 8;

/// CEF [`cef_key_event_type_t`] values (composite → shell → `cef_host`).
pub const CEF_KEYEVENT_RAWKEYDOWN: u32 = 0;
pub const CEF_KEYEVENT_KEYDOWN: u32 = 1;
pub const CEF_KEYEVENT_KEYUP: u32 = 2;
pub const CEF_KEYEVENT_CHAR: u32 = 3;

pub const MAX_BODY_BYTES: u32 = 64 * 1024 * 1024;
pub const MAX_SPAWN_COMMAND_BYTES: u32 = 4096;
pub const MAX_WINDOW_STRING_BYTES: u32 = 4096;
pub const MAX_WINDOW_LIST_ENTRIES: u32 = 512;
/// Max entries in [`MSG_OUTPUT_LAYOUT`].
pub const MAX_OUTPUT_LAYOUT_SCREENS: u32 = 16;
/// Max UTF-8 bytes for [`OutputLayoutScreen::name`].
pub const MAX_OUTPUT_LAYOUT_NAME_BYTES: u32 = 128;
/// Max UTF-8 bytes in [`MSG_SHELL_SET_OUTPUT_LAYOUT`] JSON payload.
pub const MAX_SHELL_OUTPUT_LAYOUT_JSON_BYTES: u32 = 4096;
pub const MAX_KEYBIND_ACTION_BYTES: u32 = 256;
/// Max UTF-8 bytes for [`MSG_COMPOSITOR_KEYBOARD_LAYOUT`] `label`.
pub const MAX_KEYBOARD_LAYOUT_LABEL_BYTES: u32 = 32;
/// Max planes in [`MSG_FRAME_DMABUF_COMMIT`] (matches Linux dma-buf multi-plane caps).
pub const MAX_DMABUF_PLANES: u32 = 4;
/// Max rows in [`MSG_SHELL_WINDOWS_SYNC`].
pub const MAX_SHELL_UI_WINDOWS: u32 = 32;

/// `flags` bitfield for [`MSG_FRAME_DMABUF_COMMIT`].
pub const DMABUF_FLAG_Y_INVERT: u32 = 1;

/// One plane in [`MSG_FRAME_DMABUF_COMMIT`] (fds are out-of-band via `SCM_RIGHTS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameDmabufPlane {
    pub plane_idx: u32,
    pub stride: u32,
    pub offset: u64,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputLayoutScreen {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub transform: u32,
    pub refresh_milli_hz: u32,
}

pub fn encode_output_layout(
    canvas_logical_w: u32,
    canvas_logical_h: u32,
    canvas_physical_w: u32,
    canvas_physical_h: u32,
    context_menu_atlas_buffer_h: u32,
    screens: &[OutputLayoutScreen],
    shell_chrome_primary: Option<&str>,
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
    let mut body_sz: usize = 4 + 16 + 4;
    for s in screens {
        let nl = u32::try_from(s.name.as_bytes().len()).ok()?;
        if nl == 0 || nl > MAX_OUTPUT_LAYOUT_NAME_BYTES {
            return None;
        }
        body_sz = body_sz.checked_add(4)?.checked_add(nl as usize)?.checked_add(28)?;
    }
    body_sz = body_sz.checked_add(4)?.checked_add(prim_bytes.len())?;
    body_sz = body_sz.checked_add(4)?;
    let body_len = u32::try_from(body_sz).ok()?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_sz);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_OUTPUT_LAYOUT.to_le_bytes());
    v.extend_from_slice(&canvas_logical_w.to_le_bytes());
    v.extend_from_slice(&canvas_logical_h.to_le_bytes());
    v.extend_from_slice(&canvas_physical_w.to_le_bytes());
    v.extend_from_slice(&canvas_physical_h.to_le_bytes());
    v.extend_from_slice(&n.to_le_bytes());
    for s in screens {
        let nb = s.name.as_bytes();
        let nl = nb.len() as u32;
        v.extend_from_slice(&nl.to_le_bytes());
        v.extend_from_slice(nb);
        v.extend_from_slice(&s.x.to_le_bytes());
        v.extend_from_slice(&s.y.to_le_bytes());
        v.extend_from_slice(&s.w.to_le_bytes());
        v.extend_from_slice(&s.h.to_le_bytes());
        v.extend_from_slice(&s.transform.to_le_bytes());
        v.extend_from_slice(&s.refresh_milli_hz.to_le_bytes());
    }
    let pl = u32::try_from(prim_bytes.len()).ok()?;
    v.extend_from_slice(&pl.to_le_bytes());
    v.extend_from_slice(prim_bytes);
    v.extend_from_slice(&context_menu_atlas_buffer_h.to_le_bytes());
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
    if body.len() < 24 {
        return Err(DecodeError::BadOutputLayoutPayload);
    }
    let msg = u32::from_le_bytes(body[0..4].try_into().unwrap());
    if msg != MSG_OUTPUT_LAYOUT {
        return Err(DecodeError::UnknownMsgType);
    }
    let canvas_logical_w = u32::from_le_bytes(body[4..8].try_into().unwrap());
    let canvas_logical_h = u32::from_le_bytes(body[8..12].try_into().unwrap());
    let canvas_physical_w = u32::from_le_bytes(body[12..16].try_into().unwrap());
    let canvas_physical_h = u32::from_le_bytes(body[16..20].try_into().unwrap());
    let count = u32::from_le_bytes(body[20..24].try_into().unwrap());
    if count == 0 || count > MAX_OUTPUT_LAYOUT_SCREENS {
        return Err(DecodeError::BadOutputLayoutPayload);
    }
    let mut off = 24usize;
    let mut screens = Vec::with_capacity(count as usize);
    for _ in 0..count {
        if off + 4 > body.len() {
            return Err(DecodeError::BadOutputLayoutPayload);
        }
        let nl = u32::from_le_bytes(body[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        if nl == 0 || nl > MAX_OUTPUT_LAYOUT_NAME_BYTES as usize {
            return Err(DecodeError::BadOutputLayoutPayload);
        }
        if off + nl + 28 > body.len() {
            return Err(DecodeError::BadOutputLayoutPayload);
        }
        let name = std::str::from_utf8(&body[off..off + nl])
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        off += nl;
        let x = i32::from_le_bytes(body[off..off + 4].try_into().unwrap());
        let y = i32::from_le_bytes(body[off + 4..off + 8].try_into().unwrap());
        let w = u32::from_le_bytes(body[off + 8..off + 12].try_into().unwrap());
        let h = u32::from_le_bytes(body[off + 12..off + 16].try_into().unwrap());
        let transform = u32::from_le_bytes(body[off + 16..off + 20].try_into().unwrap());
        let refresh_milli_hz = u32::from_le_bytes(body[off + 20..off + 24].try_into().unwrap());
        off += 24;
        screens.push(OutputLayoutScreen {
            name,
            x,
            y,
            w,
            h,
            transform,
            refresh_milli_hz,
        });
    }
    if off + 4 > body.len() {
        return Err(DecodeError::BadOutputLayoutPayload);
    }
    let pl = u32::from_le_bytes(body[off..off + 4].try_into().unwrap()) as usize;
    off += 4;
    if pl > MAX_OUTPUT_LAYOUT_NAME_BYTES as usize {
        return Err(DecodeError::BadOutputLayoutPayload);
    }
    if off + pl > body.len() {
        return Err(DecodeError::BadOutputLayoutPayload);
    }
    let shell_chrome_primary = if pl == 0 {
        None
    } else {
        Some(
            std::str::from_utf8(&body[off..off + pl])
                .map_err(|_| DecodeError::BadUtf8Command)?
                .to_string(),
        )
    };
    off += pl;
    if off + 4 > body.len() {
        return Err(DecodeError::BadOutputLayoutPayload);
    }
    let context_menu_atlas_buffer_h = u32::from_le_bytes(body[off..off + 4].try_into().unwrap());
    off += 4;
    if off != body.len() {
        return Err(DecodeError::BadOutputLayoutPayload);
    }
    Ok(DecodedCompositorToShellMessage::OutputLayout {
        canvas_logical_w: canvas_logical_w.max(1),
        canvas_logical_h: canvas_logical_h.max(1),
        canvas_physical_w: canvas_physical_w.max(1),
        canvas_physical_h: canvas_physical_h.max(1),
        context_menu_atlas_buffer_h,
        screens,
        shell_chrome_primary,
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
) -> Option<Vec<u8>> {
    let tb = title.as_bytes();
    let ab = app_id.as_bytes();
    if tb.contains(&0) || ab.contains(&0) {
        return None;
    }
    let tl = u32::try_from(tb.len()).ok()?;
    let al = u32::try_from(ab.len()).ok()?;
    if tl > MAX_WINDOW_STRING_BYTES || al > MAX_WINDOW_STRING_BYTES {
        return None;
    }
    let header = 4u32 * 9;
    let body_len = header.checked_add(tl)?.checked_add(al)?;
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
    if tl > MAX_WINDOW_STRING_BYTES || al > MAX_WINDOW_STRING_BYTES || ol > MAX_WINDOW_STRING_BYTES {
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
    let body_len = 40u32.checked_add(4)?.checked_add(ol)?;
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
    Some(v)
}

pub fn encode_window_metadata(
    window_id: u32,
    surface_id: u32,
    title: &str,
    app_id: &str,
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

pub const SHELL_WINDOW_FLAG_SHELL_HOSTED: u32 = 1;

/// One row in [`MSG_WINDOW_LIST`] / [`DecodedCompositorToShellMessage::WindowList`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellWindowSnapshot {
    pub window_id: u32,
    pub surface_id: u32,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    /// 0 = normal, 1 = compositor-minimized (hidden from space).
    pub minimized: u32,
    pub maximized: u32,
    pub fullscreen: u32,
    pub client_side_decoration: u32,
    pub shell_flags: u32,
    pub title: String,
    pub app_id: String,
    pub output_name: String,
}

pub fn encode_window_list(windows: &[ShellWindowSnapshot]) -> Option<Vec<u8>> {
    let count = u32::try_from(windows.len()).ok()?;
    if count > MAX_WINDOW_LIST_ENTRIES {
        return None;
    }
    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(&MSG_WINDOW_LIST.to_le_bytes());
    body.extend_from_slice(&count.to_le_bytes());
    for w in windows {
        let tb = w.title.as_bytes();
        let ab = w.app_id.as_bytes();
        let ob = w.output_name.as_bytes();
        if tb.len() > MAX_WINDOW_STRING_BYTES as usize
            || ab.len() > MAX_WINDOW_STRING_BYTES as usize
            || ob.len() > MAX_WINDOW_STRING_BYTES as usize
        {
            return None;
        }
        let tl = u32::try_from(tb.len()).ok()?;
        let al = u32::try_from(ab.len()).ok()?;
        let olen = u32::try_from(ob.len()).ok()?;
        body.extend_from_slice(&w.window_id.to_le_bytes());
        body.extend_from_slice(&w.surface_id.to_le_bytes());
        body.extend_from_slice(&w.x.to_le_bytes());
        body.extend_from_slice(&w.y.to_le_bytes());
        body.extend_from_slice(&w.w.to_le_bytes());
        body.extend_from_slice(&w.h.to_le_bytes());
        body.extend_from_slice(&w.minimized.to_le_bytes());
        body.extend_from_slice(&w.maximized.to_le_bytes());
        body.extend_from_slice(&w.fullscreen.to_le_bytes());
        body.extend_from_slice(&w.client_side_decoration.to_le_bytes());
        body.extend_from_slice(&w.shell_flags.to_le_bytes());
        body.extend_from_slice(&tl.to_le_bytes());
        body.extend_from_slice(&al.to_le_bytes());
        body.extend_from_slice(tb);
        body.extend_from_slice(ab);
        body.extend_from_slice(&olen.to_le_bytes());
        body.extend_from_slice(ob);
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

pub fn encode_shell_tile_preview(visible: bool, x: i32, y: i32, width: i32, height: i32) -> Vec<u8> {
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
pub enum DecodedMessage {
    /// CEF accelerated OSR: Linux dma-buf. Import [`FrameDmabufPlane`] fds after decode (same `recvmsg`).
    FrameDmabufCommit {
        width: u32,
        height: u32,
        /// Raw DRM FourCC (e.g. `drm_fourcc::DrmFourcc::Argb8888 as u32`).
        drm_format: u32,
        modifier: u64,
        flags: u32,
        generation: u32,
        planes: Vec<FrameDmabufPlane>,
    },
    SpawnWaylandClient {
        command: String,
    },
    ShellMoveBegin {
        window_id: u32,
    },
    ShellMoveDelta {
        dx: i32,
        dy: i32,
    },
    ShellMoveEnd {
        window_id: u32,
    },
    ShellResizeBegin {
        window_id: u32,
        edges: u32,
    },
    ShellResizeDelta {
        dx: i32,
        dy: i32,
    },
    ShellResizeEnd {
        window_id: u32,
    },
    ShellListWindows,
    ShellSetGeometry {
        window_id: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        /// 0 = floating; 1 = maximized (compositor sets xdg maximized + maps this rect).
        layout_state: u32,
    },
    ShellClose {
        window_id: u32,
    },
    ShellSetFullscreen {
        window_id: u32,
        enabled: bool,
    },
    ShellSetMaximized {
        window_id: u32,
        enabled: bool,
    },
    ShellSetPresentationFullscreen {
        enabled: bool,
    },
    ShellTaskbarActivate {
        window_id: u32,
    },
    ShellMinimize {
        window_id: u32,
    },
    ShellQuitCompositor,
    /// Reply to [`MSG_COMPOSITOR_PING`].
    ShellPong,
    ShellSetOutputLayout {
        layout_json: String,
    },
    ShellContextMenu {
        visible: bool,
        bx: i32,
        by: i32,
        bw: u32,
        bh: u32,
        gx: i32,
        gy: i32,
        gw: u32,
        gh: u32,
    },
    ShellTilePreview {
        visible: bool,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    },
    ShellChromeMetrics {
        titlebar_h: i32,
        border_w: i32,
    },
    ShellWindowsSync {
        generation: u32,
        windows: Vec<ShellUiWindowWireRow>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellUiWindowWireRow {
    pub id: u32,
    pub gx: i32,
    pub gy: i32,
    pub gw: u32,
    pub gh: u32,
    pub z: u32,
    pub flags: u32,
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
    BadDmabufCommitPayload,
    BadOutputLayoutPayload,
    BadShellWindowsPayload,
}

/// Messages the **compositor** writes on the shell Unix socket for `cef_host` to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodedCompositorToShellMessage {
    PointerMove {
        x: i32,
        y: i32,
        /// `cef_event_flags_t` bitfield (shift/ctrl/alt/meta, etc.).
        modifiers: u32,
    },
    PointerButton {
        x: i32,
        y: i32,
        button: u32,
        mouse_up: bool,
        /// Compositor-assigned window id when this is a **left press** in the server titlebar-drag strip; `0` otherwise.
        titlebar_drag_window_id: u32,
        modifiers: u32,
    },
    /// Buffer-space coords (same as pointer move); `touch_id` is the Wayland/libinput touch slot (`i32`, `-1` if unknown).
    Touch {
        touch_id: i32,
        phase: u32,
        x: i32,
        y: i32,
    },
    /// Scroll wheel / pointer axis at buffer-space `(x,y)`; forwarded to CEF [`send_mouse_wheel_event`].
    PointerAxis {
        x: i32,
        y: i32,
        delta_x: i32,
        delta_y: i32,
        modifiers: u32,
    },
    /// CEF [`KeyEvent`]: `cef_key_type` is [`CEF_KEYEVENT_RAWKEYDOWN`] etc.; UTF-16 code units in `character` / `unmodified_character`.
    Key {
        cef_key_type: u32,
        modifiers: u32,
        windows_key_code: i32,
        native_key_code: i32,
        character: u32,
        unmodified_character: u32,
    },
    OutputGeometry {
        logical_w: u32,
        logical_h: u32,
        /// Backing-store / framebuffer pixels for this output (≥ logical on HiDPI).
        physical_w: u32,
        physical_h: u32,
    },
    OutputLayout {
        canvas_logical_w: u32,
        canvas_logical_h: u32,
        canvas_physical_w: u32,
        canvas_physical_h: u32,
        context_menu_atlas_buffer_h: u32,
        screens: Vec<OutputLayoutScreen>,
        shell_chrome_primary: Option<String>,
    },
    WindowMapped {
        window_id: u32,
        surface_id: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        title: String,
        app_id: String,
        client_side_decoration: bool,
        output_name: String,
    },
    WindowUnmapped {
        window_id: u32,
    },
    WindowGeometry {
        window_id: u32,
        surface_id: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        maximized: bool,
        fullscreen: bool,
        client_side_decoration: bool,
        output_name: String,
    },
    WindowMetadata {
        window_id: u32,
        surface_id: u32,
        title: String,
        app_id: String,
    },
    FocusChanged {
        surface_id: Option<u32>,
        window_id: Option<u32>,
    },
    WindowList {
        windows: Vec<ShellWindowSnapshot>,
    },
    WindowState {
        window_id: u32,
        minimized: bool,
    },
    /// Compositor requests [`encode_shell_pong`] from `cef_host`.
    Ping,
    ContextMenuDismiss,
    ProgramsMenuToggle,
    Keybind {
        action: String,
        target_window_id: u32,
    },
    KeyboardLayout {
        label: String,
    },
    VolumeOverlay {
        volume_linear_percent_x100: u16,
        muted: bool,
        state_known: bool,
    },
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

pub fn encode_compositor_ping() -> Vec<u8> {
    let body_len = 4u32;
    let mut v = Vec::with_capacity(12);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_PING.to_le_bytes());
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

pub fn encode_compositor_keybind(action: &str, target_window_id: u32) -> Option<Vec<u8>> {
    let b = action.as_bytes();
    if b.is_empty() || b.contains(&0) {
        return None;
    }
    let al = u32::try_from(b.len()).ok()?;
    if al > MAX_KEYBIND_ACTION_BYTES {
        return None;
    }
    let body_len = 12u32.checked_add(al)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_KEYBIND.to_le_bytes());
    v.extend_from_slice(&al.to_le_bytes());
    v.extend_from_slice(b);
    v.extend_from_slice(&target_window_id.to_le_bytes());
    Some(v)
}

pub fn encode_shell_pong() -> Vec<u8> {
    let body_len = 4u32;
    let mut v = Vec::with_capacity(12);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_PONG.to_le_bytes());
    v
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

fn decode_window_strings_body(
    body: &[u8],
    expect_type: u32,
) -> Result<DecodedCompositorToShellMessage, DecodeError> {
    if body.len() < 36 {
        return Err(DecodeError::BadWindowPayload);
    }
    let msg = u32::from_le_bytes(body[0..4].try_into().unwrap());
    if msg != expect_type {
        return Err(DecodeError::UnknownMsgType);
    }
    let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
    let surface_id = u32::from_le_bytes(body[8..12].try_into().unwrap());
    let x = i32::from_le_bytes(body[12..16].try_into().unwrap());
    let y = i32::from_le_bytes(body[16..20].try_into().unwrap());
    let w = i32::from_le_bytes(body[20..24].try_into().unwrap());
    let h = i32::from_le_bytes(body[24..28].try_into().unwrap());
    let title_len = u32::from_le_bytes(body[28..32].try_into().unwrap()) as usize;
    let app_len = u32::from_le_bytes(body[32..36].try_into().unwrap()) as usize;
    if title_len > MAX_WINDOW_STRING_BYTES as usize || app_len > MAX_WINDOW_STRING_BYTES as usize {
        return Err(DecodeError::BadWindowPayload);
    }
    let end = 36usize
        .checked_add(title_len)
        .and_then(|a| a.checked_add(app_len))
        .ok_or(DecodeError::BadWindowPayload)?;
    if end > body.len() {
        return Err(DecodeError::BadWindowPayload);
    }
    let title = std::str::from_utf8(&body[36..36 + title_len])
        .map_err(|_| DecodeError::BadUtf8Command)?
        .to_string();
    let app_id = std::str::from_utf8(&body[36 + title_len..end])
        .map_err(|_| DecodeError::BadUtf8Command)?
        .to_string();
    match expect_type {
        MSG_WINDOW_METADATA => {
            if body.len() != end {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(DecodedCompositorToShellMessage::WindowMetadata {
                window_id,
                surface_id,
                title,
                app_id,
            })
        }
        MSG_WINDOW_MAPPED => {
            let (pos_after_csd, client_side_decoration) = if body.len() == end {
                (end, false)
            } else if body.len() < end + 4 {
                return Err(DecodeError::BadWindowPayload);
            } else {
                let c = u32::from_le_bytes(body[end..end + 4].try_into().unwrap());
                if c > 1 {
                    return Err(DecodeError::BadWindowPayload);
                }
                (end + 4, c != 0)
            };
            let output_name = if body.len() == pos_after_csd {
                String::new()
            } else {
                if body.len() < pos_after_csd + 4 {
                    return Err(DecodeError::BadWindowPayload);
                }
                let ol =
                    u32::from_le_bytes(body[pos_after_csd..pos_after_csd + 4].try_into().unwrap())
                        as usize;
                if ol > MAX_WINDOW_STRING_BYTES as usize {
                    return Err(DecodeError::BadWindowPayload);
                }
                let tail = pos_after_csd
                    .checked_add(4)
                    .and_then(|a| a.checked_add(ol))
                    .ok_or(DecodeError::BadWindowPayload)?;
                if body.len() != tail {
                    return Err(DecodeError::BadWindowPayload);
                }
                std::str::from_utf8(&body[pos_after_csd + 4..tail])
                    .map_err(|_| DecodeError::BadUtf8Command)?
                    .to_string()
            };
            Ok(DecodedCompositorToShellMessage::WindowMapped {
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

fn decode_compositor_to_shell_body(body: &[u8]) -> Result<DecodedCompositorToShellMessage, DecodeError> {
    if body.len() < 4 {
        return Err(DecodeError::BadCompositorToShellPayload);
    }
    let msg = u32::from_le_bytes(body[0..4].try_into().unwrap());
    match msg {
        MSG_COMPOSITOR_POINTER_MOVE => {
            if body.len() != 12 && body.len() != 16 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let x = i32::from_le_bytes(body[4..8].try_into().unwrap());
            let y = i32::from_le_bytes(body[8..12].try_into().unwrap());
            let modifiers = if body.len() >= 16 {
                u32::from_le_bytes(body[12..16].try_into().unwrap())
            } else {
                0
            };
            Ok(DecodedCompositorToShellMessage::PointerMove { x, y, modifiers })
        }
        MSG_COMPOSITOR_POINTER_BUTTON => {
            if body.len() != 24 && body.len() != 28 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let titlebar_drag_window_id = u32::from_le_bytes(body[20..24].try_into().unwrap());
            let x = i32::from_le_bytes(body[4..8].try_into().unwrap());
            let y = i32::from_le_bytes(body[8..12].try_into().unwrap());
            let button = u32::from_le_bytes(body[12..16].try_into().unwrap());
            let up_flag = u32::from_le_bytes(body[16..20].try_into().unwrap());
            if button > 2 || up_flag > 1 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let modifiers = if body.len() >= 28 {
                u32::from_le_bytes(body[24..28].try_into().unwrap())
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
            let touch_id = i32::from_le_bytes(body[4..8].try_into().unwrap());
            let phase = u32::from_le_bytes(body[8..12].try_into().unwrap());
            if phase > TOUCH_PHASE_CANCELLED {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let x = i32::from_le_bytes(body[12..16].try_into().unwrap());
            let y = i32::from_le_bytes(body[16..20].try_into().unwrap());
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
            let x = i32::from_le_bytes(body[4..8].try_into().unwrap());
            let y = i32::from_le_bytes(body[8..12].try_into().unwrap());
            let delta_x = i32::from_le_bytes(body[12..16].try_into().unwrap());
            let delta_y = i32::from_le_bytes(body[16..20].try_into().unwrap());
            let modifiers = if body.len() >= 24 {
                u32::from_le_bytes(body[20..24].try_into().unwrap())
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
            let cef_key_type = u32::from_le_bytes(body[4..8].try_into().unwrap());
            if cef_key_type > 3 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let modifiers = u32::from_le_bytes(body[8..12].try_into().unwrap());
            let windows_key_code = i32::from_le_bytes(body[12..16].try_into().unwrap());
            let native_key_code = i32::from_le_bytes(body[16..20].try_into().unwrap());
            let character = u32::from_le_bytes(body[20..24].try_into().unwrap());
            let unmodified_character = u32::from_le_bytes(body[24..28].try_into().unwrap());
            Ok(DecodedCompositorToShellMessage::Key {
                cef_key_type,
                modifiers,
                windows_key_code,
                native_key_code,
                character,
                unmodified_character,
            })
        }
        MSG_OUTPUT_GEOMETRY => {
            if body.len() != 20 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let logical_w = u32::from_le_bytes(body[4..8].try_into().unwrap());
            let logical_h = u32::from_le_bytes(body[8..12].try_into().unwrap());
            let physical_w = u32::from_le_bytes(body[12..16].try_into().unwrap());
            let physical_h = u32::from_le_bytes(body[16..20].try_into().unwrap());
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
            let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
            Ok(DecodedCompositorToShellMessage::WindowUnmapped {
                window_id,
            })
        }
        MSG_WINDOW_GEOMETRY => {
            if body.len() < 28 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
            let surface_id = u32::from_le_bytes(body[8..12].try_into().unwrap());
            let x = i32::from_le_bytes(body[12..16].try_into().unwrap());
            let y = i32::from_le_bytes(body[16..20].try_into().unwrap());
            let w = i32::from_le_bytes(body[20..24].try_into().unwrap());
            let h = i32::from_le_bytes(body[24..28].try_into().unwrap());
            let (maximized, fullscreen, csd_base) = if body.len() == 28 {
                (false, false, None)
            } else if body.len() < 36 {
                return Err(DecodeError::BadWindowPayload);
            } else {
                let mx = u32::from_le_bytes(body[28..32].try_into().unwrap());
                let fs = u32::from_le_bytes(body[32..36].try_into().unwrap());
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
                        let c = u32::from_le_bytes(body[base..base + 4].try_into().unwrap());
                        if c > 1 {
                            return Err(DecodeError::BadWindowPayload);
                        }
                        (c != 0, base + 4)
                    }
                }
            };
            let output_name = if body.len() == pos {
                String::new()
            } else {
                if body.len() < pos + 4 {
                    return Err(DecodeError::BadWindowPayload);
                }
                let ol = u32::from_le_bytes(body[pos..pos + 4].try_into().unwrap()) as usize;
                if ol > MAX_WINDOW_STRING_BYTES as usize {
                    return Err(DecodeError::BadWindowPayload);
                }
                let tail = pos
                    .checked_add(4)
                    .and_then(|a| a.checked_add(ol))
                    .ok_or(DecodeError::BadWindowPayload)?;
                if body.len() != tail {
                    return Err(DecodeError::BadWindowPayload);
                }
                std::str::from_utf8(&body[pos + 4..tail])
                    .map_err(|_| DecodeError::BadUtf8Command)?
                    .to_string()
            };
            Ok(DecodedCompositorToShellMessage::WindowGeometry {
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
            })
        }
        MSG_WINDOW_METADATA => decode_window_strings_body(body, MSG_WINDOW_METADATA),
        MSG_FOCUS_CHANGED => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let sid = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
            let wid = u32::from_le_bytes([body[8], body[9], body[10], body[11]]);
            Ok(DecodedCompositorToShellMessage::FocusChanged {
                surface_id: if sid == 0 { None } else { Some(sid) },
                window_id: if wid == 0 { None } else { Some(wid) },
            })
        }
        MSG_WINDOW_STATE => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
            let m = u32::from_le_bytes(body[8..12].try_into().unwrap());
            if m > 1 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            Ok(DecodedCompositorToShellMessage::WindowState {
                window_id,
                minimized: m != 0,
            })
        }
        MSG_WINDOW_LIST => decode_window_list_compositor_body(body),
        MSG_COMPOSITOR_PING => {
            if body.len() != 4 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            Ok(DecodedCompositorToShellMessage::Ping)
        }
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
            let al = u32::from_le_bytes(body[4..8].try_into().unwrap()) as usize;
            if al == 0 || al > MAX_KEYBIND_ACTION_BYTES as usize {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let end = 8usize
                .checked_add(al)
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            if body.len() != end && body.len() != end + 4 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let action = std::str::from_utf8(&body[8..end])
                .map_err(|_| DecodeError::BadUtf8Command)?
                .to_string();
            let target_window_id = if body.len() >= end + 4 {
                u32::from_le_bytes(body[end..end + 4].try_into().unwrap())
            } else {
                0
            };
            Ok(DecodedCompositorToShellMessage::Keybind {
                action,
                target_window_id,
            })
        }
        MSG_COMPOSITOR_KEYBOARD_LAYOUT => {
            if body.len() < 8 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let ll = u32::from_le_bytes(body[4..8].try_into().unwrap()) as usize;
            if ll > MAX_KEYBOARD_LAYOUT_LABEL_BYTES as usize {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let end = 8usize
                .checked_add(ll)
                .ok_or(DecodeError::BadCompositorToShellPayload)?;
            if body.len() != end {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let label = std::str::from_utf8(&body[8..end])
                .map_err(|_| DecodeError::BadUtf8Command)?
                .to_string();
            Ok(DecodedCompositorToShellMessage::KeyboardLayout { label })
        }
        MSG_COMPOSITOR_VOLUME_OVERLAY => {
            if body.len() != 8 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let volume_linear_percent_x100 =
                u16::from_le_bytes(body[4..6].try_into().unwrap());
            let flags = u16::from_le_bytes(body[6..8].try_into().unwrap());
            Ok(DecodedCompositorToShellMessage::VolumeOverlay {
                volume_linear_percent_x100,
                muted: flags & 1 != 0,
                state_known: flags & 2 != 0,
            })
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
        | MSG_SHELL_PONG
        | MSG_SHELL_TILE_PREVIEW
        | MSG_SHELL_CHROME_METRICS
        | MSG_SHELL_WINDOWS_SYNC => Err(DecodeError::UnknownMsgType),
        _ => Err(DecodeError::UnknownMsgType),
    }
}

fn decode_window_list_compositor_body(body: &[u8]) -> Result<DecodedCompositorToShellMessage, DecodeError> {
    if body.len() < 8 {
        return Err(DecodeError::BadWindowListPayload);
    }
    let msg = u32::from_le_bytes(body[0..4].try_into().unwrap());
    if msg != MSG_WINDOW_LIST {
        return Err(DecodeError::UnknownMsgType);
    }
    let count = u32::from_le_bytes(body[4..8].try_into().unwrap()) as usize;
    if count > MAX_WINDOW_LIST_ENTRIES as usize {
        return Err(DecodeError::BadWindowListPayload);
    }
    let mut off = 8usize;
    let mut windows = Vec::with_capacity(count);
    for _ in 0..count {
        if off + 52 > body.len() {
            return Err(DecodeError::BadWindowListPayload);
        }
        let window_id = u32::from_le_bytes(body[off..off + 4].try_into().unwrap());
        let surface_id = u32::from_le_bytes(body[off + 4..off + 8].try_into().unwrap());
        let x = i32::from_le_bytes(body[off + 8..off + 12].try_into().unwrap());
        let y = i32::from_le_bytes(body[off + 12..off + 16].try_into().unwrap());
        let w = i32::from_le_bytes(body[off + 16..off + 20].try_into().unwrap());
        let h = i32::from_le_bytes(body[off + 20..off + 24].try_into().unwrap());
        let minimized = u32::from_le_bytes(body[off + 24..off + 28].try_into().unwrap());
        let maximized = u32::from_le_bytes(body[off + 28..off + 32].try_into().unwrap());
        let fullscreen = u32::from_le_bytes(body[off + 32..off + 36].try_into().unwrap());
        let client_side_decoration = u32::from_le_bytes(body[off + 36..off + 40].try_into().unwrap());
        let shell_flags = u32::from_le_bytes(body[off + 40..off + 44].try_into().unwrap());
        if minimized > 1 || maximized > 1 || fullscreen > 1 || client_side_decoration > 1 {
            return Err(DecodeError::BadWindowListPayload);
        }
        let title_len = u32::from_le_bytes(body[off + 44..off + 48].try_into().unwrap()) as usize;
        let app_len = u32::from_le_bytes(body[off + 48..off + 52].try_into().unwrap()) as usize;
        if title_len > MAX_WINDOW_STRING_BYTES as usize || app_len > MAX_WINDOW_STRING_BYTES as usize {
            return Err(DecodeError::BadWindowListPayload);
        }
        off += 52;
        let tend = off
            .checked_add(title_len)
            .ok_or(DecodeError::BadWindowListPayload)?;
        let aend = tend
            .checked_add(app_len)
            .ok_or(DecodeError::BadWindowListPayload)?;
        if aend > body.len() {
            return Err(DecodeError::BadWindowListPayload);
        }
        let title = std::str::from_utf8(&body[off..tend])
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        let app_id = std::str::from_utf8(&body[tend..aend])
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        off = aend;
        if off + 4 > body.len() {
            return Err(DecodeError::BadWindowListPayload);
        }
        let output_len = u32::from_le_bytes(body[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        if output_len > MAX_WINDOW_STRING_BYTES as usize {
            return Err(DecodeError::BadWindowListPayload);
        }
        if off + output_len > body.len() {
            return Err(DecodeError::BadWindowListPayload);
        }
        let output_name = std::str::from_utf8(&body[off..off + output_len])
            .map_err(|_| DecodeError::BadUtf8Command)?
            .to_string();
        off += output_len;
        windows.push(ShellWindowSnapshot {
            window_id,
            surface_id,
            x,
            y,
            w,
            h,
            minimized,
            maximized,
            fullscreen,
            client_side_decoration,
            shell_flags,
            title,
            app_id,
            output_name,
        });
    }
    if off != body.len() {
        return Err(DecodeError::BadWindowListPayload);
    }
    Ok(DecodedCompositorToShellMessage::WindowList { windows })
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

fn decode_shell_to_compositor_body(body: &[u8]) -> Result<DecodedMessage, DecodeError> {
    if body.len() < 4 {
        return Err(DecodeError::BadWindowPayload);
    }
    let msg = u32::from_le_bytes(body[0..4].try_into().unwrap());
    match msg {
        MSG_SPAWN_WAYLAND_CLIENT => decode_spawn_body(body),
        MSG_SHELL_MOVE_BEGIN => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
            Ok(DecodedMessage::ShellMoveBegin { window_id })
        }
        MSG_SHELL_MOVE_DELTA => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let dx = i32::from_le_bytes(body[4..8].try_into().unwrap());
            let dy = i32::from_le_bytes(body[8..12].try_into().unwrap());
            Ok(DecodedMessage::ShellMoveDelta { dx, dy })
        }
        MSG_SHELL_MOVE_END => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
            Ok(DecodedMessage::ShellMoveEnd { window_id })
        }
        MSG_SHELL_RESIZE_BEGIN => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
            let edges = u32::from_le_bytes(body[8..12].try_into().unwrap());
            if edges == 0 || edges > 15 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(DecodedMessage::ShellResizeBegin { window_id, edges })
        }
        MSG_SHELL_RESIZE_DELTA => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let dx = i32::from_le_bytes(body[4..8].try_into().unwrap());
            let dy = i32::from_le_bytes(body[8..12].try_into().unwrap());
            Ok(DecodedMessage::ShellResizeDelta { dx, dy })
        }
        MSG_SHELL_RESIZE_END => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
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
                u32::from_le_bytes(body[24..28].try_into().unwrap())
            } else if body.len() == 24 {
                0u32
            } else {
                return Err(DecodeError::BadWindowPayload);
            };
            let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
            let x = i32::from_le_bytes(body[8..12].try_into().unwrap());
            let y = i32::from_le_bytes(body[12..16].try_into().unwrap());
            let width = i32::from_le_bytes(body[16..20].try_into().unwrap());
            let height = i32::from_le_bytes(body[20..24].try_into().unwrap());
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
            let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
            Ok(DecodedMessage::ShellClose { window_id })
        }
        MSG_SHELL_SET_FULLSCREEN => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
            let en = u32::from_le_bytes(body[8..12].try_into().unwrap());
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
            let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
            let en = u32::from_le_bytes(body[8..12].try_into().unwrap());
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
            let en = u32::from_le_bytes(body[4..8].try_into().unwrap());
            if en > 1 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(DecodedMessage::ShellSetPresentationFullscreen {
                enabled: en != 0,
            })
        }
        MSG_SHELL_TASKBAR_ACTIVATE => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
            Ok(DecodedMessage::ShellTaskbarActivate { window_id })
        }
        MSG_SHELL_MINIMIZE => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
            Ok(DecodedMessage::ShellMinimize { window_id })
        }
        MSG_SHELL_QUIT_COMPOSITOR => {
            if body.len() != 4 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(DecodedMessage::ShellQuitCompositor)
        }
        MSG_SHELL_PONG => {
            if body.len() != 4 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(DecodedMessage::ShellPong)
        }
        MSG_SHELL_SET_OUTPUT_LAYOUT => {
            if body.len() < 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            let jl = u32::from_le_bytes(body[4..8].try_into().unwrap()) as usize;
            if jl == 0 || jl > MAX_SHELL_OUTPUT_LAYOUT_JSON_BYTES as usize {
                return Err(DecodeError::BadWindowPayload);
            }
            if body.len() != 8 + jl {
                return Err(DecodeError::BadWindowPayload);
            }
            let layout_json =
                std::str::from_utf8(&body[8..8 + jl]).map_err(|_| DecodeError::BadUtf8Command)?;
            Ok(DecodedMessage::ShellSetOutputLayout {
                layout_json: layout_json.to_string(),
            })
        }
        MSG_FRAME_DMABUF_COMMIT => decode_frame_dmabuf_commit_body(body),
        MSG_SHELL_WINDOWS_SYNC => {
            if body.len() < 12 {
                return Err(DecodeError::BadShellWindowsPayload);
            }
            let generation = u32::from_le_bytes(body[4..8].try_into().unwrap());
            let count = u32::from_le_bytes(body[8..12].try_into().unwrap());
            if count > MAX_SHELL_UI_WINDOWS {
                return Err(DecodeError::BadShellWindowsPayload);
            }
            let need = 12usize
                .checked_add((count as usize).checked_mul(28).ok_or(DecodeError::BadShellWindowsPayload)?)
                .ok_or(DecodeError::BadShellWindowsPayload)?;
            if body.len() != need {
                return Err(DecodeError::BadShellWindowsPayload);
            }
            let mut windows = Vec::with_capacity(count as usize);
            let mut off = 12usize;
            for _ in 0..count {
                let id = u32::from_le_bytes(body[off..off + 4].try_into().unwrap());
                let gx = i32::from_le_bytes(body[off + 4..off + 8].try_into().unwrap());
                let gy = i32::from_le_bytes(body[off + 8..off + 12].try_into().unwrap());
                let gw = u32::from_le_bytes(body[off + 12..off + 16].try_into().unwrap());
                let gh = u32::from_le_bytes(body[off + 16..off + 20].try_into().unwrap());
                let z = u32::from_le_bytes(body[off + 20..off + 24].try_into().unwrap());
                let flags = u32::from_le_bytes(body[off + 24..off + 28].try_into().unwrap());
                off += 28;
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
        MSG_SHELL_CONTEXT_MENU => {
            if body.len() != 40 {
                return Err(DecodeError::BadWindowPayload);
            }
            let vis = u32::from_le_bytes(body[4..8].try_into().unwrap());
            if vis > 1 {
                return Err(DecodeError::BadWindowPayload);
            }
            let bx = i32::from_le_bytes(body[8..12].try_into().unwrap());
            let by = i32::from_le_bytes(body[12..16].try_into().unwrap());
            let bw = u32::from_le_bytes(body[16..20].try_into().unwrap());
            let bh = u32::from_le_bytes(body[20..24].try_into().unwrap());
            let gx = i32::from_le_bytes(body[24..28].try_into().unwrap());
            let gy = i32::from_le_bytes(body[28..32].try_into().unwrap());
            let gw = u32::from_le_bytes(body[32..36].try_into().unwrap());
            let gh = u32::from_le_bytes(body[36..40].try_into().unwrap());
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
            let vis = u32::from_le_bytes(body[4..8].try_into().unwrap());
            if vis > 1 {
                return Err(DecodeError::BadWindowPayload);
            }
            let x = i32::from_le_bytes(body[8..12].try_into().unwrap());
            let y = i32::from_le_bytes(body[12..16].try_into().unwrap());
            let width = i32::from_le_bytes(body[16..20].try_into().unwrap());
            let height = i32::from_le_bytes(body[20..24].try_into().unwrap());
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
            let titlebar_h = i32::from_le_bytes(body[4..8].try_into().unwrap());
            let border_w = i32::from_le_bytes(body[8..12].try_into().unwrap());
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
    if body.len() < 36 {
        return Err(DecodeError::BadDmabufCommitPayload);
    }
    let width = u32::from_le_bytes(body[4..8].try_into().unwrap());
    let height = u32::from_le_bytes(body[8..12].try_into().unwrap());
    let drm_format = u32::from_le_bytes(body[12..16].try_into().unwrap());
    let modifier = u64::from_le_bytes(body[16..24].try_into().unwrap());
    let plane_count = u32::from_le_bytes(body[24..28].try_into().unwrap());
    let flags = u32::from_le_bytes(body[28..32].try_into().unwrap());
    let generation = u32::from_le_bytes(body[32..36].try_into().unwrap());
    if plane_count == 0 || plane_count > MAX_DMABUF_PLANES {
        return Err(DecodeError::BadDmabufCommitPayload);
    }
    let need = 36usize
        .checked_add((plane_count as usize).checked_mul(16).ok_or(DecodeError::BadDmabufCommitPayload)?)
        .ok_or(DecodeError::BadDmabufCommitPayload)?;
    if body.len() != need {
        return Err(DecodeError::BadDmabufCommitPayload);
    }
    let mut planes = Vec::with_capacity(plane_count as usize);
    let mut o = 36usize;
    for _ in 0..plane_count {
        let plane_idx = u32::from_le_bytes(body[o..o + 4].try_into().unwrap());
        o += 4;
        let stride = u32::from_le_bytes(body[o..o + 4].try_into().unwrap());
        o += 4;
        let offset = u64::from_le_bytes(body[o..o + 8].try_into().unwrap());
        o += 8;
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
    if body.len() < 8 {
        return Err(DecodeError::BadSpawnPayload);
    }
    let cmd_len = u32::from_le_bytes(body[4..8].try_into().unwrap()) as usize;
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
    let cmd_bytes = &body[8..end];
    if cmd_bytes.contains(&0) {
        return Err(DecodeError::BadSpawnPayload);
    }
    let command = std::str::from_utf8(cmd_bytes).map_err(|_| DecodeError::BadUtf8Command)?;
    Ok(DecodedMessage::SpawnWaylandClient {
        command: command.to_string(),
    })
}
