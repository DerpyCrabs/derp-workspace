//! Wire format: `[u32 body_len LE][body]` where `body` is a single message.
//!
//! Frame message body layout (all little-endian):
//! - `u32 protocol_version` — must be [`SHELL_PIXEL_PROTOCOL_VERSION`]
//! - `u32 msg_type` — [`MSG_FRAME`]
//! - `u32 width`, `u32 height`, `u32 stride`, `u32 format` — [`PIXEL_FORMAT_BGRA8888`]
//! - `u32 data_len` — must equal `stride * height` and fit in payload
//! - `data_len` bytes of pixels

pub const SHELL_PIXEL_PROTOCOL_VERSION: u32 = 1;
pub const MSG_FRAME: u32 = 1;
/// Matches [`smithay::backend::allocator::Fourcc::Bgra8888`] / typical CEF BGRA buffers.
pub const PIXEL_FORMAT_BGRA8888: u32 = 0;
/// Cap per message (body length), ~64 MiB.
pub const MAX_BODY_BYTES: u32 = 64 * 1024 * 1024;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodedMessage {
    Frame {
        width: u32,
        height: u32,
        stride: u32,
        format: u32,
        pixels: Vec<u8>,
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
    if msg != MSG_FRAME {
        return Err(DecodeError::UnknownMsgType);
    }
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
    let data_end = 28usize.checked_add(data_len as usize).ok_or(DecodeError::BadFrameLayout)?;
    if body.len() < data_end {
        return Err(DecodeError::BadFrameLayout);
    }
    let expected = stride.checked_mul(height).ok_or(DecodeError::BadFrameLayout)?;
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
}