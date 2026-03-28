//! Wire format: `[u32 body_len LE][body]` where `body` is a single message.
//!
//! Frame message body layout (all little-endian):
//! - `u32 protocol_version` — must be [`SHELL_PIXEL_PROTOCOL_VERSION`]
//! - `u32 msg_type` — [`MSG_FRAME`]
//! - `u32 width`, `u32 height`, `u32 stride`, `u32 format` — [`PIXEL_FORMAT_BGRA8888`]
//! - `u32 data_len` — must equal `stride * height` and fit in payload
//! - `data_len` bytes of pixels
//!
//! Spawn message body (`msg_type` [`MSG_SPAWN_WAYLAND_CLIENT`]):
//! - `u32 protocol_version`, `u32 msg_type`, `u32 command_len`, then `command_len` UTF-8 bytes (no NUL).
//!
//! Compositor → shell process (CEF OSR), same length-prefixed framing:
//! - [`MSG_COMPOSITOR_POINTER_MOVE`], [`MSG_COMPOSITOR_POINTER_BUTTON`]
//! - [`MSG_OUTPUT_GEOMETRY`]: output logical size (matches OSR / DIP target)
//! - [`MSG_WINDOW_MAPPED`], [`MSG_WINDOW_UNMAPPED`], [`MSG_WINDOW_GEOMETRY`], [`MSG_WINDOW_METADATA`], [`MSG_FOCUS_CHANGED`]
//!
//! **Privacy:** the compositor never sends native Wayland client pixels or buffer contents to the shell;
//! only metadata, pointer routing, and shell→compositor **ingress** frames ([`MSG_FRAME`]) exist on this socket.
//!
//! Shell → compositor (decoded by [`pop_message`]):
//! - [`MSG_SHELL_MOVE_BEGIN`], [`MSG_SHELL_MOVE_DELTA`], [`MSG_SHELL_MOVE_END`],
//!   [`MSG_SHELL_LIST_WINDOWS`], [`MSG_SHELL_SET_GEOMETRY`], [`MSG_SHELL_CLOSE`], [`MSG_SHELL_SET_FULLSCREEN`],
//!   shell [`MSG_SHELL_QUIT_COMPOSITOR`] (end compositor session)
//! - compositor → shell: [`MSG_WINDOW_LIST`] (reply to list command)

pub const SHELL_PIXEL_PROTOCOL_VERSION: u32 = 5;

pub const MSG_FRAME: u32 = 1;
pub const MSG_SPAWN_WAYLAND_CLIENT: u32 = 2;
pub const MSG_COMPOSITOR_POINTER_MOVE: u32 = 3;
pub const MSG_COMPOSITOR_POINTER_BUTTON: u32 = 4;
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

pub const PIXEL_FORMAT_BGRA8888: u32 = 0;
pub const MAX_BODY_BYTES: u32 = 64 * 1024 * 1024;
pub const MAX_SPAWN_COMMAND_BYTES: u32 = 4096;
pub const MAX_WINDOW_STRING_BYTES: u32 = 4096;
pub const MAX_WINDOW_LIST_ENTRIES: u32 = 512;

fn frame_header_len() -> u32 {
    4 * 7
}

pub fn encode_frame_bgra(width: u32, height: u32, stride: u32, pixels: &[u8]) -> Option<Vec<u8>> {
    if width == 0 || height == 0 {
        return None;
    }
    let data_len = stride.checked_mul(height)?;
    if data_len as usize > pixels.len() {
        return None;
    }
    let header = frame_header_len();
    let body_len = header.checked_add(data_len)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_FRAME.to_le_bytes());
    v.extend_from_slice(&width.to_le_bytes());
    v.extend_from_slice(&height.to_le_bytes());
    v.extend_from_slice(&stride.to_le_bytes());
    v.extend_from_slice(&PIXEL_FORMAT_BGRA8888.to_le_bytes());
    v.extend_from_slice(&data_len.to_le_bytes());
    v.extend_from_slice(&pixels[..data_len as usize]);
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
    let header = 4u32 * 3;
    let body_len = header.checked_add(cmd_len)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_SPAWN_WAYLAND_CLIENT.to_le_bytes());
    v.extend_from_slice(&cmd_len.to_le_bytes());
    v.extend_from_slice(b);
    Some(v)
}

pub fn encode_output_geometry(logical_w: u32, logical_h: u32) -> Vec<u8> {
    let body_len = 16u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_OUTPUT_GEOMETRY.to_le_bytes());
    v.extend_from_slice(&logical_w.to_le_bytes());
    v.extend_from_slice(&logical_h.to_le_bytes());
    v
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
    let header = 4u32 * 10;
    let body_len = header.checked_add(tl)?.checked_add(al)?;
    if body_len > MAX_BODY_BYTES {
        return None;
    }
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
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
) -> Option<Vec<u8>> {
    encode_window_strings(
        MSG_WINDOW_MAPPED,
        window_id,
        surface_id,
        x,
        y,
        w,
        h,
        title,
        app_id,
    )
}

pub fn encode_window_unmapped(window_id: u32) -> Vec<u8> {
    let body_len = 12u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
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
) -> Vec<u8> {
    let body_len = 32u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_WINDOW_GEOMETRY.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v.extend_from_slice(&surface_id.to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v
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
    let body_len = 16u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_FOCUS_CHANGED.to_le_bytes());
    v.extend_from_slice(&surface_id.unwrap_or(0).to_le_bytes());
    v.extend_from_slice(&window_id.unwrap_or(0).to_le_bytes());
    v
}

pub fn encode_shell_move_begin(window_id: u32) -> Vec<u8> {
    let body_len = 12u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_MOVE_BEGIN.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v
}

pub fn encode_shell_move_delta(dx: i32, dy: i32) -> Vec<u8> {
    let body_len = 16u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_MOVE_DELTA.to_le_bytes());
    v.extend_from_slice(&dx.to_le_bytes());
    v.extend_from_slice(&dy.to_le_bytes());
    v
}

pub fn encode_shell_move_end(window_id: u32) -> Vec<u8> {
    let body_len = 12u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_MOVE_END.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v
}

/// One row in [`MSG_WINDOW_LIST`] / [`DecodedCompositorToShellMessage::WindowList`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellWindowSnapshot {
    pub window_id: u32,
    pub surface_id: u32,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub title: String,
    pub app_id: String,
}

pub fn encode_window_list(windows: &[ShellWindowSnapshot]) -> Option<Vec<u8>> {
    let count = u32::try_from(windows.len()).ok()?;
    if count > MAX_WINDOW_LIST_ENTRIES {
        return None;
    }
    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    body.extend_from_slice(&MSG_WINDOW_LIST.to_le_bytes());
    body.extend_from_slice(&count.to_le_bytes());
    for w in windows {
        let tb = w.title.as_bytes();
        let ab = w.app_id.as_bytes();
        if tb.len() > MAX_WINDOW_STRING_BYTES as usize || ab.len() > MAX_WINDOW_STRING_BYTES as usize {
            return None;
        }
        let tl = u32::try_from(tb.len()).ok()?;
        let al = u32::try_from(ab.len()).ok()?;
        body.extend_from_slice(&w.window_id.to_le_bytes());
        body.extend_from_slice(&w.surface_id.to_le_bytes());
        body.extend_from_slice(&w.x.to_le_bytes());
        body.extend_from_slice(&w.y.to_le_bytes());
        body.extend_from_slice(&w.w.to_le_bytes());
        body.extend_from_slice(&w.h.to_le_bytes());
        body.extend_from_slice(&tl.to_le_bytes());
        body.extend_from_slice(&al.to_le_bytes());
        body.extend_from_slice(tb);
        body.extend_from_slice(ab);
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
    let body_len = 8u32;
    let mut v = Vec::with_capacity(12);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_LIST_WINDOWS.to_le_bytes());
    v
}

pub fn encode_shell_set_geometry(window_id: u32, x: i32, y: i32, w: i32, h: i32) -> Vec<u8> {
    let body_len = 28u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_SET_GEOMETRY.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v
}

pub fn encode_shell_close(window_id: u32) -> Vec<u8> {
    let body_len = 12u32;
    let mut v = Vec::with_capacity(16);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_CLOSE.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v
}

pub fn encode_shell_set_fullscreen(window_id: u32, enabled: bool) -> Vec<u8> {
    let body_len = 16u32;
    let mut v = Vec::with_capacity(20);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_SET_FULLSCREEN.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v.extend_from_slice(&(if enabled { 1u32 } else { 0 }).to_le_bytes());
    v
}

pub fn encode_shell_quit_compositor() -> Vec<u8> {
    let body_len = 8u32;
    let mut v = Vec::with_capacity(12);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_QUIT_COMPOSITOR.to_le_bytes());
    v
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodedMessage {
    Frame {
        width: u32,
        height: u32,
        stride: u32,
        format: u32,
        pixels: Vec<u8>,
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
    ShellListWindows,
    ShellSetGeometry {
        window_id: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    },
    ShellClose {
        window_id: u32,
    },
    ShellSetFullscreen {
        window_id: u32,
        enabled: bool,
    },
    ShellQuitCompositor,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    Incomplete,
    BodyTooLarge,
    BadProtocolVersion,
    UnknownMsgType,
    BadFrameLayout,
    UnsupportedPixelFormat,
    BadSpawnPayload,
    BadUtf8Command,
    BadCompositorToShellPayload,
    BadWindowPayload,
    BadWindowListPayload,
}

/// Messages the **compositor** writes on the shell Unix socket for `cef_host` to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodedCompositorToShellMessage {
    PointerMove {
        x: i32,
        y: i32,
    },
    PointerButton {
        x: i32,
        y: i32,
        button: u32,
        mouse_up: bool,
    },
    OutputGeometry {
        logical_w: u32,
        logical_h: u32,
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
}

pub fn encode_compositor_pointer_move(x: i32, y: i32) -> Vec<u8> {
    let body_len = 16u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_POINTER_MOVE.to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v
}

pub fn encode_compositor_pointer_button(x: i32, y: i32, button: u32, mouse_up: bool) -> Vec<u8> {
    let body_len = 24u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&SHELL_PIXEL_PROTOCOL_VERSION.to_le_bytes());
    v.extend_from_slice(&MSG_COMPOSITOR_POINTER_BUTTON.to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v.extend_from_slice(&button.to_le_bytes());
    v.extend_from_slice(&(if mouse_up { 1u32 } else { 0 }).to_le_bytes());
    v
}

fn decode_window_strings_body(
    body: &[u8],
    expect_type: u32,
) -> Result<DecodedCompositorToShellMessage, DecodeError> {
    if body.len() < 40 {
        return Err(DecodeError::BadWindowPayload);
    }
    let ver = u32::from_le_bytes(body[0..4].try_into().unwrap());
    if ver != SHELL_PIXEL_PROTOCOL_VERSION {
        return Err(DecodeError::BadProtocolVersion);
    }
    let msg = u32::from_le_bytes(body[4..8].try_into().unwrap());
    if msg != expect_type {
        return Err(DecodeError::UnknownMsgType);
    }
    let window_id = u32::from_le_bytes(body[8..12].try_into().unwrap());
    let surface_id = u32::from_le_bytes(body[12..16].try_into().unwrap());
    let x = i32::from_le_bytes(body[16..20].try_into().unwrap());
    let y = i32::from_le_bytes(body[20..24].try_into().unwrap());
    let w = i32::from_le_bytes(body[24..28].try_into().unwrap());
    let h = i32::from_le_bytes(body[28..32].try_into().unwrap());
    let title_len = u32::from_le_bytes(body[32..36].try_into().unwrap()) as usize;
    let app_len = u32::from_le_bytes(body[36..40].try_into().unwrap()) as usize;
    if title_len > MAX_WINDOW_STRING_BYTES as usize || app_len > MAX_WINDOW_STRING_BYTES as usize {
        return Err(DecodeError::BadWindowPayload);
    }
    let end = 40usize
        .checked_add(title_len)
        .and_then(|a| a.checked_add(app_len))
        .ok_or(DecodeError::BadWindowPayload)?;
    if body.len() != end {
        return Err(DecodeError::BadWindowPayload);
    }
    let title = std::str::from_utf8(&body[40..40 + title_len])
        .map_err(|_| DecodeError::BadUtf8Command)?
        .to_string();
    let app_id = std::str::from_utf8(&body[40 + title_len..end])
        .map_err(|_| DecodeError::BadUtf8Command)?
        .to_string();
    Ok(match expect_type {
        MSG_WINDOW_MAPPED => DecodedCompositorToShellMessage::WindowMapped {
            window_id,
            surface_id,
            x,
            y,
            w,
            h,
            title,
            app_id,
        },
        MSG_WINDOW_METADATA => DecodedCompositorToShellMessage::WindowMetadata {
            window_id,
            surface_id,
            title,
            app_id,
        },
        _ => return Err(DecodeError::UnknownMsgType),
    })
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
    if buf.len() < 4 + body_len {
        return Ok(None);
    }
    let packet: Vec<u8> = buf.drain(..4 + body_len).collect();
    let body = &packet[4..];
    if body.len() < 8 {
        return Err(DecodeError::BadCompositorToShellPayload);
    }
    let ver = u32::from_le_bytes(body[0..4].try_into().unwrap());
    if ver != SHELL_PIXEL_PROTOCOL_VERSION {
        return Err(DecodeError::BadProtocolVersion);
    }
    let msg = u32::from_le_bytes(body[4..8].try_into().unwrap());
    match msg {
        MSG_COMPOSITOR_POINTER_MOVE => {
            if body.len() != 16 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let x = i32::from_le_bytes(body[8..12].try_into().unwrap());
            let y = i32::from_le_bytes(body[12..16].try_into().unwrap());
            Ok(Some(DecodedCompositorToShellMessage::PointerMove { x, y }))
        }
        MSG_COMPOSITOR_POINTER_BUTTON => {
            if body.len() != 24 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let x = i32::from_le_bytes(body[8..12].try_into().unwrap());
            let y = i32::from_le_bytes(body[12..16].try_into().unwrap());
            let button = u32::from_le_bytes(body[16..20].try_into().unwrap());
            let up_flag = u32::from_le_bytes(body[20..24].try_into().unwrap());
            if button > 2 || up_flag > 1 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            Ok(Some(DecodedCompositorToShellMessage::PointerButton {
                x,
                y,
                button,
                mouse_up: up_flag != 0,
            }))
        }
        MSG_OUTPUT_GEOMETRY => {
            if body.len() != 16 {
                return Err(DecodeError::BadCompositorToShellPayload);
            }
            let logical_w = u32::from_le_bytes(body[8..12].try_into().unwrap());
            let logical_h = u32::from_le_bytes(body[12..16].try_into().unwrap());
            Ok(Some(DecodedCompositorToShellMessage::OutputGeometry {
                logical_w,
                logical_h,
            }))
        }
        MSG_WINDOW_MAPPED => decode_window_strings_body(body, MSG_WINDOW_MAPPED).map(Some),
        MSG_WINDOW_UNMAPPED => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[8..12].try_into().unwrap());
            Ok(Some(DecodedCompositorToShellMessage::WindowUnmapped {
                window_id,
            }))
        }
        MSG_WINDOW_GEOMETRY => {
            if body.len() != 32 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[8..12].try_into().unwrap());
            let surface_id = u32::from_le_bytes(body[12..16].try_into().unwrap());
            let x = i32::from_le_bytes(body[16..20].try_into().unwrap());
            let y = i32::from_le_bytes(body[20..24].try_into().unwrap());
            let w = i32::from_le_bytes(body[24..28].try_into().unwrap());
            let h = i32::from_le_bytes(body[28..32].try_into().unwrap());
            Ok(Some(DecodedCompositorToShellMessage::WindowGeometry {
                window_id,
                surface_id,
                x,
                y,
                w,
                h,
            }))
        }
        MSG_WINDOW_METADATA => decode_window_strings_body(body, MSG_WINDOW_METADATA).map(Some),
        MSG_FOCUS_CHANGED => {
            if body.len() != 16 {
                return Err(DecodeError::BadWindowPayload);
            }
            let sid = u32::from_le_bytes([body[8], body[9], body[10], body[11]]);
            let wid = u32::from_le_bytes([body[12], body[13], body[14], body[15]]);
            Ok(Some(DecodedCompositorToShellMessage::FocusChanged {
                surface_id: if sid == 0 { None } else { Some(sid) },
                window_id: if wid == 0 { None } else { Some(wid) },
            }))
        }
        MSG_WINDOW_LIST => decode_window_list_compositor_body(body).map(Some),
        MSG_FRAME
        | MSG_SPAWN_WAYLAND_CLIENT
        | MSG_SHELL_MOVE_BEGIN
        | MSG_SHELL_MOVE_DELTA
        | MSG_SHELL_MOVE_END
        | MSG_SHELL_LIST_WINDOWS
        | MSG_SHELL_SET_GEOMETRY
        | MSG_SHELL_CLOSE
        | MSG_SHELL_SET_FULLSCREEN
        | MSG_SHELL_QUIT_COMPOSITOR => Err(DecodeError::UnknownMsgType),
        _ => Err(DecodeError::UnknownMsgType),
    }
}

fn decode_window_list_compositor_body(body: &[u8]) -> Result<DecodedCompositorToShellMessage, DecodeError> {
    if body.len() < 12 {
        return Err(DecodeError::BadWindowListPayload);
    }
    let ver = u32::from_le_bytes(body[0..4].try_into().unwrap());
    if ver != SHELL_PIXEL_PROTOCOL_VERSION {
        return Err(DecodeError::BadProtocolVersion);
    }
    let msg = u32::from_le_bytes(body[4..8].try_into().unwrap());
    if msg != MSG_WINDOW_LIST {
        return Err(DecodeError::UnknownMsgType);
    }
    let count = u32::from_le_bytes(body[8..12].try_into().unwrap()) as usize;
    if count > MAX_WINDOW_LIST_ENTRIES as usize {
        return Err(DecodeError::BadWindowListPayload);
    }
    let mut off = 12usize;
    let mut windows = Vec::with_capacity(count);
    for _ in 0..count {
        if off + 32 > body.len() {
            return Err(DecodeError::BadWindowListPayload);
        }
        let window_id = u32::from_le_bytes(body[off..off + 4].try_into().unwrap());
        let surface_id = u32::from_le_bytes(body[off + 4..off + 8].try_into().unwrap());
        let x = i32::from_le_bytes(body[off + 8..off + 12].try_into().unwrap());
        let y = i32::from_le_bytes(body[off + 12..off + 16].try_into().unwrap());
        let w = i32::from_le_bytes(body[off + 16..off + 20].try_into().unwrap());
        let h = i32::from_le_bytes(body[off + 20..off + 24].try_into().unwrap());
        let title_len = u32::from_le_bytes(body[off + 24..off + 28].try_into().unwrap()) as usize;
        let app_len = u32::from_le_bytes(body[off + 28..off + 32].try_into().unwrap()) as usize;
        if title_len > MAX_WINDOW_STRING_BYTES as usize || app_len > MAX_WINDOW_STRING_BYTES as usize {
            return Err(DecodeError::BadWindowListPayload);
        }
        off += 32;
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
        windows.push(ShellWindowSnapshot {
            window_id,
            surface_id,
            x,
            y,
            w,
            h,
            title,
            app_id,
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
    if buf.len() < 4 + body_len {
        return Ok(None);
    }
    let packet: Vec<u8> = buf.drain(..4 + body_len).collect();
    let body = &packet[4..];

    if body.len() < 8 {
        return Err(DecodeError::BadFrameLayout);
    }
    let ver = u32::from_le_bytes(body[0..4].try_into().unwrap());
    if ver != SHELL_PIXEL_PROTOCOL_VERSION {
        return Err(DecodeError::BadProtocolVersion);
    }
    let msg = u32::from_le_bytes(body[4..8].try_into().unwrap());
    match msg {
        MSG_FRAME => decode_frame_body(body),
        MSG_SPAWN_WAYLAND_CLIENT => decode_spawn_body(body),
        MSG_SHELL_MOVE_BEGIN => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[8..12].try_into().unwrap());
            Ok(Some(DecodedMessage::ShellMoveBegin { window_id }))
        }
        MSG_SHELL_MOVE_DELTA => {
            if body.len() != 16 {
                return Err(DecodeError::BadWindowPayload);
            }
            let dx = i32::from_le_bytes(body[8..12].try_into().unwrap());
            let dy = i32::from_le_bytes(body[12..16].try_into().unwrap());
            Ok(Some(DecodedMessage::ShellMoveDelta { dx, dy }))
        }
        MSG_SHELL_MOVE_END => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[8..12].try_into().unwrap());
            Ok(Some(DecodedMessage::ShellMoveEnd { window_id }))
        }
        MSG_SHELL_LIST_WINDOWS => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(Some(DecodedMessage::ShellListWindows))
        }
        MSG_SHELL_SET_GEOMETRY => {
            if body.len() != 28 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[8..12].try_into().unwrap());
            let x = i32::from_le_bytes(body[12..16].try_into().unwrap());
            let y = i32::from_le_bytes(body[16..20].try_into().unwrap());
            let width = i32::from_le_bytes(body[20..24].try_into().unwrap());
            let height = i32::from_le_bytes(body[24..28].try_into().unwrap());
            Ok(Some(DecodedMessage::ShellSetGeometry {
                window_id,
                x,
                y,
                width,
                height,
            }))
        }
        MSG_SHELL_CLOSE => {
            if body.len() != 12 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[8..12].try_into().unwrap());
            Ok(Some(DecodedMessage::ShellClose { window_id }))
        }
        MSG_SHELL_SET_FULLSCREEN => {
            if body.len() != 16 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[8..12].try_into().unwrap());
            let en = u32::from_le_bytes(body[12..16].try_into().unwrap());
            if en > 1 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(Some(DecodedMessage::ShellSetFullscreen {
                window_id,
                enabled: en != 0,
            }))
        }
        MSG_SHELL_QUIT_COMPOSITOR => {
            if body.len() != 8 {
                return Err(DecodeError::BadWindowPayload);
            }
            Ok(Some(DecodedMessage::ShellQuitCompositor))
        }
        _ => Err(DecodeError::UnknownMsgType),
    }
}

fn decode_frame_body(body: &[u8]) -> Result<Option<DecodedMessage>, DecodeError> {
    if body.len() < 8 + 24 {
        return Err(DecodeError::BadFrameLayout);
    }
    let width = u32::from_le_bytes(body[8..12].try_into().unwrap());
    let height = u32::from_le_bytes(body[12..16].try_into().unwrap());
    let stride = u32::from_le_bytes(body[16..20].try_into().unwrap());
    let format = u32::from_le_bytes(body[20..24].try_into().unwrap());
    let data_len = u32::from_le_bytes(body[24..28].try_into().unwrap());
    if format != PIXEL_FORMAT_BGRA8888 {
        return Err(DecodeError::UnsupportedPixelFormat);
    }
    let data_end = 28usize
        .checked_add(data_len as usize)
        .ok_or(DecodeError::BadFrameLayout)?;
    if body.len() < data_end {
        return Err(DecodeError::BadFrameLayout);
    }
    let expected = stride
        .checked_mul(height)
        .ok_or(DecodeError::BadFrameLayout)?;
    if expected != data_len {
        return Err(DecodeError::BadFrameLayout);
    }
    let pixels = body[28..data_end].to_vec();
    Ok(Some(DecodedMessage::Frame {
        width,
        height,
        stride,
        format,
        pixels,
    }))
}

fn decode_spawn_body(body: &[u8]) -> Result<Option<DecodedMessage>, DecodeError> {
    if body.len() < 12 {
        return Err(DecodeError::BadSpawnPayload);
    }
    let cmd_len = u32::from_le_bytes(body[8..12].try_into().unwrap()) as usize;
    if cmd_len > MAX_SPAWN_COMMAND_BYTES as usize {
        return Err(DecodeError::BadSpawnPayload);
    }
    let end = 12usize
        .checked_add(cmd_len)
        .ok_or(DecodeError::BadSpawnPayload)?;
    if body.len() != end {
        return Err(DecodeError::BadSpawnPayload);
    }
    if cmd_len == 0 {
        return Err(DecodeError::BadSpawnPayload);
    }
    let cmd_bytes = &body[12..end];
    if cmd_bytes.contains(&0) {
        return Err(DecodeError::BadSpawnPayload);
    }
    let command = std::str::from_utf8(cmd_bytes).map_err(|_| DecodeError::BadUtf8Command)?;
    Ok(Some(DecodedMessage::SpawnWaylandClient {
        command: command.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_tiny_frame() {
        let w = 2u32;
        let h = 2u32;
        let st = 8u32;
        let pix = vec![0u8; 16];
        let mut buf = encode_frame_bgra(w, h, st, &pix).unwrap();
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::Frame {
                width,
                height,
                stride,
                pixels,
                ..
            }) => {
                assert_eq!(width, w);
                assert_eq!(height, h);
                assert_eq!(stride, st);
                assert_eq!(pixels.as_slice(), pix.as_slice());
            }
            _ => panic!("expected frame"),
        }
        assert!(buf.is_empty());
    }

    #[test]
    fn round_trip_spawn() {
        let mut buf = encode_spawn_wayland_client("foot -a").unwrap();
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::SpawnWaylandClient { command }) => {
                assert_eq!(command, "foot -a");
            }
            _ => panic!("expected spawn"),
        }
        assert!(buf.is_empty());
    }

    #[test]
    fn spawn_rejects_nul() {
        assert!(encode_spawn_wayland_client("a\0b").is_none());
    }

    #[test]
    fn rejects_wrong_protocol_version() {
        let mut buf = vec![8u8, 0, 0, 0];
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&MSG_FRAME.to_le_bytes());
        assert!(matches!(
            pop_message(&mut buf),
            Err(DecodeError::BadProtocolVersion)
        ));
    }

    #[test]
    fn round_trip_compositor_pointer_move() {
        let mut buf = encode_compositor_pointer_move(42, -3);
        match pop_compositor_to_shell_message(&mut buf).unwrap() {
            Some(DecodedCompositorToShellMessage::PointerMove { x, y }) => {
                assert_eq!(x, 42);
                assert_eq!(y, -3);
            }
            _ => panic!("expected PointerMove"),
        }
        assert!(buf.is_empty());
    }

    #[test]
    fn round_trip_output_geometry() {
        let mut buf = encode_output_geometry(1920, 1080);
        match pop_compositor_to_shell_message(&mut buf).unwrap() {
            Some(DecodedCompositorToShellMessage::OutputGeometry {
                logical_w,
                logical_h,
            }) => {
                assert_eq!((logical_w, logical_h), (1920, 1080));
            }
            _ => panic!("expected OutputGeometry"),
        }
    }

    #[test]
    fn round_trip_window_mapped() {
        let enc = encode_window_mapped(1, 99, 10, 20, 800, 600, "Hi", "app").unwrap();
        let mut b = enc;
        match pop_compositor_to_shell_message(&mut b).unwrap() {
            Some(DecodedCompositorToShellMessage::WindowMapped {
                window_id,
                surface_id,
                x,
                y,
                w,
                h,
                title,
                app_id,
            }) => {
                assert_eq!(window_id, 1);
                assert_eq!(surface_id, 99);
                assert_eq!((x, y, w, h), (10, 20, 800, 600));
                assert_eq!(title, "Hi");
                assert_eq!(app_id, "app");
            }
            _ => panic!("expected WindowMapped"),
        }
    }

    #[test]
    fn round_trip_shell_move_delta() {
        let mut buf = encode_shell_move_delta(3, -5);
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellMoveDelta { dx, dy }) => assert_eq!((dx, dy), (3, -5)),
            _ => panic!("expected delta"),
        }
    }

    #[test]
    fn round_trip_shell_chrome_commands() {
        let mut buf = encode_shell_list_windows();
        assert!(matches!(
            pop_message(&mut buf).unwrap(),
            Some(DecodedMessage::ShellListWindows)
        ));

        buf = encode_shell_set_geometry(3, 1, 2, 640, 480);
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellSetGeometry {
                window_id,
                x,
                y,
                width,
                height,
            }) => {
                assert_eq!((window_id, x, y, width, height), (3, 1, 2, 640, 480));
            }
            _ => panic!("expected ShellSetGeometry"),
        }

        buf = encode_shell_close(9);
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellClose { window_id }) => assert_eq!(window_id, 9),
            _ => panic!("expected ShellClose"),
        }

        buf = encode_shell_set_fullscreen(4, true);
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellSetFullscreen {
                window_id,
                enabled,
            }) => {
                assert_eq!((window_id, enabled), (4, true));
            }
            _ => panic!("expected ShellSetFullscreen"),
        }

        buf = encode_shell_quit_compositor();
        assert!(matches!(
            pop_message(&mut buf).unwrap(),
            Some(DecodedMessage::ShellQuitCompositor)
        ));
    }

    #[test]
    fn round_trip_window_list_compositor_to_shell() {
        let wins = vec![
            ShellWindowSnapshot {
                window_id: 1,
                surface_id: 10,
                x: 0,
                y: 0,
                w: 100,
                h: 50,
                title: "a".into(),
                app_id: "b".into(),
            },
            ShellWindowSnapshot {
                window_id: 2,
                surface_id: 20,
                x: 5,
                y: 6,
                w: 7,
                h: 8,
                title: "".into(),
                app_id: "".into(),
            },
        ];
        let enc = encode_window_list(&wins).unwrap();
        let mut b = enc;
        match pop_compositor_to_shell_message(&mut b).unwrap() {
            Some(DecodedCompositorToShellMessage::WindowList { windows }) => {
                assert_eq!(windows, wins);
            }
            _ => panic!("expected WindowList"),
        }
        assert!(b.is_empty());
    }

    /// Several length‑prefixed packets in one buffer (as the kernel may deliver them) must decode
    /// in order without desync — regression for duplex shell IPC.
    #[test]
    fn concatenated_compositor_pointer_messages_decode_in_order() {
        let mut buf = Vec::new();
        for i in 0i32..50 {
            buf.extend(encode_compositor_pointer_move(i, -i));
        }
        for i in 0i32..50 {
            match pop_compositor_to_shell_message(&mut buf).unwrap() {
                Some(DecodedCompositorToShellMessage::PointerMove { x, y }) => {
                    assert_eq!((x, y), (i, -i));
                }
                other => panic!("expected PointerMove at {i}, got {other:?}"),
            }
        }
        assert!(buf.is_empty(), "leftover bytes: {}", buf.len());
    }

    #[test]
    fn concatenated_shell_move_and_frame_messages_decode_in_order() {
        let w = 2u32;
        let h = 2u32;
        let st = 8u32;
        let pix = vec![1u8; 16];
        let mut buf = Vec::new();
        buf.extend(encode_shell_move_begin(7));
        buf.extend(encode_shell_move_delta(1, 2));
        buf.extend(encode_frame_bgra(w, h, st, &pix).unwrap());
        buf.extend(encode_shell_move_end(7));

        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellMoveBegin { window_id }) => assert_eq!(window_id, 7),
            other => panic!("expected begin: {other:?}"),
        }
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellMoveDelta { dx, dy }) => assert_eq!((dx, dy), (1, 2)),
            other => panic!("expected delta: {other:?}"),
        }
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::Frame { width, height, .. }) => {
                assert_eq!((width, height), (w, h));
            }
            other => panic!("expected frame: {other:?}"),
        }
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellMoveEnd { window_id }) => assert_eq!(window_id, 7),
            other => panic!("expected end: {other:?}"),
        }
        assert!(buf.is_empty());
    }
}
