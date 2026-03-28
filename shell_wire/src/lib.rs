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
//! - [`MSG_COMPOSITOR_POINTER_MOVE`]: `i32 x`, `i32 y` in **OSR buffer pixel** space (same as the last frame; `cef_host` maps to CEF view/DIP coords).
//! - [`MSG_COMPOSITOR_POINTER_BUTTON`]: `i32 x`, `i32 y`, `u32 button` (0 = left, 1 = middle, 2 = right), `u32 mouse_up` (0 = down, 1 = up).

pub const SHELL_PIXEL_PROTOCOL_VERSION: u32 = 2;
pub const MSG_FRAME: u32 = 1;
pub const MSG_SPAWN_WAYLAND_CLIENT: u32 = 2;
/// Compositor sends pointer motion in **OSR buffer** coordinates (see crate docs).
pub const MSG_COMPOSITOR_POINTER_MOVE: u32 = 3;
/// Compositor sends mouse button down/up in **OSR buffer** coordinates (see crate docs).
pub const MSG_COMPOSITOR_POINTER_BUTTON: u32 = 4;
/// Matches [`smithay::backend::allocator::Fourcc::Bgra8888`] / typical CEF BGRA buffers.
pub const PIXEL_FORMAT_BGRA8888: u32 = 0;
/// Cap per message (body length), ~64 MiB.
pub const MAX_BODY_BYTES: u32 = 64 * 1024 * 1024;
/// Max UTF-8 length for [`encode_spawn_wayland_client`].
pub const MAX_SPAWN_COMMAND_BYTES: u32 = 4096;

/// Build one framed message: BGRA8888 tightly packed rows (`stride == width * 4`).
pub fn encode_frame_bgra(width: u32, height: u32, stride: u32, pixels: &[u8]) -> Option<Vec<u8>> {
    if width == 0 || height == 0 {
        return None;
    }
    let data_len = stride.checked_mul(height)?;
    if data_len as usize > pixels.len() {
        return None;
    }
    let header: u32 = 4 * 7;
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

/// Build a framed spawn message: compositor runs `sh -c` with `WAYLAND_DISPLAY` set (see compositor).
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
}

/// Framed compositor → shell pointer move (OSR buffer pixels).
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

/// Framed compositor → shell button event (`button`: 0 left, 1 middle, 2 right).
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

/// Decode one compositor-originated message (`cef_host` read side). Removes consumed bytes from `buf`.
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
        MSG_FRAME | MSG_SPAWN_WAYLAND_CLIENT => Err(DecodeError::UnknownMsgType),
        _ => Err(DecodeError::UnknownMsgType),
    }
}

/// Try to decode one message from `buf`. On success, removes consumed bytes from `buf`.
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
    fn round_trip_compositor_pointer_button() {
        let mut buf = encode_compositor_pointer_button(10, 20, 2, true);
        match pop_compositor_to_shell_message(&mut buf).unwrap() {
            Some(DecodedCompositorToShellMessage::PointerButton {
                x,
                y,
                button,
                mouse_up,
            }) => {
                assert_eq!((x, y, button, mouse_up), (10, 20, 2, true));
            }
            _ => panic!("expected PointerButton"),
        }
        assert!(buf.is_empty());
    }
}
