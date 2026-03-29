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
//!   [`MSG_SHELL_RESIZE_BEGIN`], [`MSG_SHELL_RESIZE_DELTA`], [`MSG_SHELL_RESIZE_END`] (**breaking:** deploy `compositor` + `cef_host` + `shell_wire` together)
//! - compositor → shell: [`MSG_WINDOW_LIST`], [`MSG_WINDOW_STATE`], [`MSG_COMPOSITOR_PING`] (watchdog keepalive)

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
/// Max planes in [`MSG_FRAME_DMABUF_COMMIT`] (matches Linux dma-buf multi-plane caps).
pub const MAX_DMABUF_PLANES: u32 = 4;

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
) -> Vec<u8> {
    let body_len = 28u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
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
    pub title: String,
    pub app_id: String,
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
        body.extend_from_slice(&w.minimized.to_le_bytes());
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
    let body_len = 4u32;
    let mut v = Vec::with_capacity(12);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_LIST_WINDOWS.to_le_bytes());
    v
}

pub fn encode_shell_set_geometry(window_id: u32, x: i32, y: i32, w: i32, h: i32) -> Vec<u8> {
    let body_len = 24u32;
    let mut v = Vec::with_capacity(4 + body_len as usize);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_SET_GEOMETRY.to_le_bytes());
    v.extend_from_slice(&window_id.to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
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

pub fn encode_shell_quit_compositor() -> Vec<u8> {
    let body_len = 4u32;
    let mut v = Vec::with_capacity(12);
    v.extend_from_slice(&body_len.to_le_bytes());
    v.extend_from_slice(&MSG_SHELL_QUIT_COMPOSITOR.to_le_bytes());
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
    },
    ShellClose {
        window_id: u32,
    },
    ShellSetFullscreen {
        window_id: u32,
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
    WindowState {
        window_id: u32,
        minimized: bool,
    },
    /// Compositor requests [`encode_shell_pong`] from `cef_host`.
    Ping,
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
    if body.len() != end {
        return Err(DecodeError::BadWindowPayload);
    }
    let title = std::str::from_utf8(&body[36..36 + title_len])
        .map_err(|_| DecodeError::BadUtf8Command)?
        .to_string();
    let app_id = std::str::from_utf8(&body[36 + title_len..end])
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
            if body.len() != 28 {
                return Err(DecodeError::BadWindowPayload);
            }
            let window_id = u32::from_le_bytes(body[4..8].try_into().unwrap());
            let surface_id = u32::from_le_bytes(body[8..12].try_into().unwrap());
            let x = i32::from_le_bytes(body[12..16].try_into().unwrap());
            let y = i32::from_le_bytes(body[16..20].try_into().unwrap());
            let w = i32::from_le_bytes(body[20..24].try_into().unwrap());
            let h = i32::from_le_bytes(body[24..28].try_into().unwrap());
            Ok(DecodedCompositorToShellMessage::WindowGeometry {
                window_id,
                surface_id,
                x,
                y,
                w,
                h,
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
        | MSG_SHELL_TASKBAR_ACTIVATE
        | MSG_SHELL_MINIMIZE
        | MSG_SHELL_QUIT_COMPOSITOR
        | MSG_SHELL_PONG => Err(DecodeError::UnknownMsgType),
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
        if off + 36 > body.len() {
            return Err(DecodeError::BadWindowListPayload);
        }
        let window_id = u32::from_le_bytes(body[off..off + 4].try_into().unwrap());
        let surface_id = u32::from_le_bytes(body[off + 4..off + 8].try_into().unwrap());
        let x = i32::from_le_bytes(body[off + 8..off + 12].try_into().unwrap());
        let y = i32::from_le_bytes(body[off + 12..off + 16].try_into().unwrap());
        let w = i32::from_le_bytes(body[off + 16..off + 20].try_into().unwrap());
        let h = i32::from_le_bytes(body[off + 20..off + 24].try_into().unwrap());
        let minimized = u32::from_le_bytes(body[off + 24..off + 28].try_into().unwrap());
        if minimized > 1 {
            return Err(DecodeError::BadWindowListPayload);
        }
        let title_len = u32::from_le_bytes(body[off + 28..off + 32].try_into().unwrap()) as usize;
        let app_len = u32::from_le_bytes(body[off + 32..off + 36].try_into().unwrap()) as usize;
        if title_len > MAX_WINDOW_STRING_BYTES as usize || app_len > MAX_WINDOW_STRING_BYTES as usize {
            return Err(DecodeError::BadWindowListPayload);
        }
        off += 36;
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
            minimized,
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
            if body.len() != 24 {
                return Err(DecodeError::BadWindowPayload);
            }
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
        MSG_FRAME_DMABUF_COMMIT => decode_frame_dmabuf_commit_body(body),
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn rejects_unknown_shell_to_compositor_msg_type() {
        let body_len = 4u32;
        let mut buf = Vec::new();
        buf.extend_from_slice(&body_len.to_le_bytes());
        buf.extend_from_slice(&999_999u32.to_le_bytes());
        assert!(matches!(
            pop_message(&mut buf),
            Err(DecodeError::UnknownMsgType)
        ));
    }

    #[test]
    fn round_trip_compositor_pointer_button_with_titlebar_id() {
        let mut buf = encode_compositor_pointer_button(3, 4, 0, false, 99, 8);
        match pop_compositor_to_shell_message(&mut buf).unwrap() {
            Some(DecodedCompositorToShellMessage::PointerButton {
                x,
                y,
                button,
                mouse_up,
                titlebar_drag_window_id,
                modifiers,
            }) => {
                assert_eq!(
                    (x, y, button, mouse_up, titlebar_drag_window_id, modifiers),
                    (3, 4, 0, false, 99, 8)
                );
            }
            _ => panic!("expected PointerButton"),
        }
        assert!(buf.is_empty());
    }

    #[test]
    fn round_trip_compositor_pointer_move() {
        let mut buf = encode_compositor_pointer_move(42, -3, 4);
        match pop_compositor_to_shell_message(&mut buf).unwrap() {
            Some(DecodedCompositorToShellMessage::PointerMove { x, y, modifiers }) => {
                assert_eq!((x, y, modifiers), (42, -3, 4));
            }
            _ => panic!("expected PointerMove"),
        }
        assert!(buf.is_empty());
    }

    #[test]
    fn decode_legacy_pointer_move_without_modifiers_field() {
        let mut body = Vec::new();
        body.extend_from_slice(&12u32.to_le_bytes());
        body.extend_from_slice(&MSG_COMPOSITOR_POINTER_MOVE.to_le_bytes());
        body.extend_from_slice(&1i32.to_le_bytes());
        body.extend_from_slice(&2i32.to_le_bytes());
        let mut buf = body;
        match pop_compositor_to_shell_message(&mut buf).unwrap() {
            Some(DecodedCompositorToShellMessage::PointerMove { x, y, modifiers }) => {
                assert_eq!((x, y, modifiers), (1, 2, 0));
            }
            _ => panic!("expected PointerMove"),
        }
    }

    #[test]
    fn round_trip_compositor_touch() {
        let mut buf = encode_compositor_touch(-1, TOUCH_PHASE_PRESSED, 100, 200);
        match pop_compositor_to_shell_message(&mut buf).unwrap() {
            Some(DecodedCompositorToShellMessage::Touch {
                touch_id,
                phase,
                x,
                y,
            }) => {
                assert_eq!((touch_id, phase, x, y), (-1, TOUCH_PHASE_PRESSED, 100, 200));
            }
            _ => panic!("expected Touch"),
        }
        assert!(buf.is_empty());
    }

    #[test]
    fn round_trip_compositor_pointer_axis() {
        let mut buf = encode_compositor_pointer_axis(10, 20, 0, -120, 2);
        match pop_compositor_to_shell_message(&mut buf).unwrap() {
            Some(DecodedCompositorToShellMessage::PointerAxis {
                x,
                y,
                delta_x,
                delta_y,
                modifiers,
            }) => {
                assert_eq!((x, y, delta_x, delta_y, modifiers), (10, 20, 0, -120, 2));
            }
            _ => panic!("expected PointerAxis"),
        }
        assert!(buf.is_empty());
    }

    #[test]
    fn round_trip_compositor_key() {
        let mut buf = encode_compositor_key(
            CEF_KEYEVENT_CHAR,
            4,
            0,
            0x61,
            'z' as u32,
            'z' as u32,
        );
        match pop_compositor_to_shell_message(&mut buf).unwrap() {
            Some(DecodedCompositorToShellMessage::Key {
                cef_key_type,
                modifiers,
                windows_key_code,
                native_key_code,
                character,
                unmodified_character,
            }) => {
                assert_eq!(cef_key_type, CEF_KEYEVENT_CHAR);
                assert_eq!(modifiers, 4);
                assert_eq!(windows_key_code, 0);
                assert_eq!(native_key_code, 0x61);
                assert_eq!(character, 'z' as u32);
                assert_eq!(unmodified_character, 'z' as u32);
            }
            _ => panic!("expected Key"),
        }
        assert!(buf.is_empty());
    }

    #[test]
    fn round_trip_output_geometry() {
        let mut buf = encode_output_geometry(2880, 1920, 2880, 1920);
        match pop_compositor_to_shell_message(&mut buf).unwrap() {
            Some(DecodedCompositorToShellMessage::OutputGeometry {
                logical_w,
                logical_h,
                physical_w,
                physical_h,
            }) => {
                assert_eq!(
                    (logical_w, logical_h, physical_w, physical_h),
                    (2880, 1920, 2880, 1920)
                );
            }
            _ => panic!("expected OutputGeometry"),
        }
    }

    #[test]
    fn rejects_output_geometry_payload_wrong_length() {
        let body_len = 24u32;
        let mut raw: Vec<u8> = Vec::new();
        raw.extend_from_slice(&body_len.to_le_bytes());
        raw.extend_from_slice(&MSG_OUTPUT_GEOMETRY.to_le_bytes());
        raw.extend_from_slice(&1280u32.to_le_bytes());
        raw.extend_from_slice(&720u32.to_le_bytes());
        raw.extend_from_slice(&1280u32.to_le_bytes());
        raw.extend_from_slice(&720u32.to_le_bytes());
        raw.extend_from_slice(&0u32.to_le_bytes());
        let mut buf = raw;
        assert!(matches!(
            pop_compositor_to_shell_message(&mut buf),
            Err(DecodeError::BadCompositorToShellPayload)
        ));
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
    fn round_trip_shell_resize_messages() {
        let mut buf = encode_shell_resize_begin(5, RESIZE_EDGE_RIGHT | RESIZE_EDGE_BOTTOM).unwrap();
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellResizeBegin { window_id, edges }) => {
                assert_eq!(window_id, 5);
                assert_eq!(edges, RESIZE_EDGE_RIGHT | RESIZE_EDGE_BOTTOM);
            }
            o => panic!("expected ShellResizeBegin: {o:?}"),
        }
        assert!(buf.is_empty());

        buf = encode_shell_resize_delta(-2, 7);
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellResizeDelta { dx, dy }) => assert_eq!((dx, dy), (-2, 7)),
            o => panic!("expected ShellResizeDelta: {o:?}"),
        }

        buf = encode_shell_resize_end(5);
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellResizeEnd { window_id }) => assert_eq!(window_id, 5),
            o => panic!("expected ShellResizeEnd: {o:?}"),
        }
        assert!(buf.is_empty());

        assert!(encode_shell_resize_begin(1, 0).is_none());
    }

    #[test]
    fn concatenated_shell_resize_decode_order() {
        let mut buf = Vec::new();
        buf.extend(encode_shell_resize_begin(2, RESIZE_EDGE_LEFT).unwrap());
        buf.extend(encode_shell_resize_delta(3, 0));
        buf.extend(encode_shell_resize_delta(0, -1));
        buf.extend(encode_shell_resize_end(2));
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellResizeBegin { window_id, edges }) => {
                assert_eq!((window_id, edges), (2, RESIZE_EDGE_LEFT));
            }
            o => panic!("expected begin: {o:?}"),
        }
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellResizeDelta { dx, dy }) => assert_eq!((dx, dy), (3, 0)),
            o => panic!("expected delta: {o:?}"),
        }
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellResizeDelta { dx, dy }) => assert_eq!((dx, dy), (0, -1)),
            o => panic!("expected delta2: {o:?}"),
        }
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellResizeEnd { window_id }) => assert_eq!(window_id, 2),
            o => panic!("expected end: {o:?}"),
        }
        assert!(buf.is_empty());
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

        buf = encode_shell_taskbar_activate(42);
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellTaskbarActivate { window_id }) => assert_eq!(window_id, 42),
            _ => panic!("expected ShellTaskbarActivate"),
        }

        buf = encode_shell_minimize(5);
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellMinimize { window_id }) => assert_eq!(window_id, 5),
            _ => panic!("expected ShellMinimize"),
        }
    }

    #[test]
    fn round_trip_window_state_compositor_to_shell() {
        let enc = encode_window_state(7, true);
        let mut b = enc;
        match pop_compositor_to_shell_message(&mut b).unwrap() {
            Some(DecodedCompositorToShellMessage::WindowState {
                window_id,
                minimized,
            }) => {
                assert_eq!(window_id, 7);
                assert!(minimized);
            }
            _ => panic!("expected WindowState"),
        }
        assert!(b.is_empty());
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
                minimized: 0,
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
                minimized: 1,
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
            buf.extend(encode_compositor_pointer_move(i, -i, 0));
        }
        for i in 0i32..50 {
            match pop_compositor_to_shell_message(&mut buf).unwrap() {
                Some(DecodedCompositorToShellMessage::PointerMove { x, y, modifiers }) => {
                    assert_eq!((x, y, modifiers), (i, -i, 0));
                }
                other => panic!("expected PointerMove at {i}, got {other:?}"),
            }
        }
        assert!(buf.is_empty(), "leftover bytes: {}", buf.len());
    }

    #[test]
    fn concatenated_shell_move_and_dmabuf_messages_decode_in_order() {
        let planes = [FrameDmabufPlane {
            plane_idx: 0,
            stride: 8,
            offset: 0,
        }];
        let dma = encode_frame_dmabuf_commit(2, 2, 0x34324241, 0, 0, 0, &planes).unwrap();
        let mut buf = Vec::new();
        buf.extend(encode_shell_move_begin(7));
        buf.extend(encode_shell_move_delta(1, 2));
        buf.extend(dma);
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
            Some(DecodedMessage::FrameDmabufCommit {
                width,
                height,
                planes: pl,
                ..
            }) => {
                assert_eq!((width, height), (2, 2));
                assert_eq!(pl.as_slice(), planes);
            }
            other => panic!("expected FrameDmabufCommit: {other:?}"),
        }
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::ShellMoveEnd { window_id }) => assert_eq!(window_id, 7),
            other => panic!("expected end: {other:?}"),
        }
        assert!(buf.is_empty());
    }

    #[test]
    fn ping_pong_round_trip() {
        let mut a = encode_compositor_ping();
        match pop_compositor_to_shell_message(&mut a).unwrap() {
            Some(DecodedCompositorToShellMessage::Ping) => {}
            o => panic!("expected Ping: {o:?}"),
        }
        assert!(a.is_empty());

        let mut b = encode_shell_pong();
        match pop_message(&mut b).unwrap() {
            Some(DecodedMessage::ShellPong) => {}
            o => panic!("expected ShellPong: {o:?}"),
        }
        assert!(b.is_empty());
    }

    #[test]
    fn round_trip_frame_dmabuf_commit() {
        let planes = vec![
            FrameDmabufPlane {
                plane_idx: 0,
                stride: 11_520,
                offset: 0,
            },
            FrameDmabufPlane {
                plane_idx: 1,
                stride: 0,
                offset: 22_118_400,
            },
        ];
        let drm_format = 0x34324241u32;
        let enc = encode_frame_dmabuf_commit(2880, 1920, drm_format, 0, 0, 42, &planes).unwrap();
        let mut buf = enc;
        match pop_message(&mut buf).unwrap() {
            Some(DecodedMessage::FrameDmabufCommit {
                width,
                height,
                drm_format: f,
                modifier,
                flags,
                generation,
                planes: pl,
            }) => {
                assert_eq!((width, height), (2880, 1920));
                assert_eq!(f, drm_format);
                assert_eq!(modifier, 0);
                assert_eq!(flags, 0);
                assert_eq!(generation, 42);
                assert_eq!(pl, planes);
            }
            other => panic!("expected FrameDmabufCommit: {other:?}"),
        }
        assert!(buf.is_empty());
    }
}
