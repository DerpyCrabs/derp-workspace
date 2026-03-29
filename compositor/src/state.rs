use std::{
    collections::HashMap,
    ffi::OsString,
    io::Write,
    os::fd::OwnedFd,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

use smithay::{
    backend::allocator::dmabuf::{Dmabuf, DmabufFlags},
    backend::allocator::{Format, Fourcc, Modifier},
    backend::input::{KeyState, TouchSlot},
    backend::renderer::{gles::GlesRenderer, ImportDma},
    backend::{
        renderer::element::{memory::MemoryRenderBuffer, Id},
        session::libseat::LibSeatSession,
    },
    desktop::{
        space::{Space, SpaceElement},
        utils::under_from_surface_tree,
        PopupManager, Window, WindowSurfaceType,
    },
    input::{
        keyboard::{KeysymHandle, ModifiersState},
        Seat, SeatState,
    },
    reexports::{
        calloop::{generic::Generic, EventLoop, Interest, LoopSignal, Mode, PostAction},
        wayland_server::{
            backend::{ClientData, ClientId, DisconnectReason},
            protocol::wl_surface::WlSurface,
            Display, DisplayHandle,
        },
    },
    utils::{Buffer, Logical, Point, Rectangle, Size, SERIAL_COUNTER},
    wayland::{
        compositor::{CompositorClientState, CompositorState as WlCompositorState},
        cursor_shape::CursorShapeManagerState,
        fractional_scale::{FractionalScaleHandler, FractionalScaleManagerState},
        output::OutputManagerState,
        selection::data_device::DataDeviceState,
        shell::xdg::{
            decoration::{XdgDecorationHandler, XdgDecorationState},
            ToplevelSurface, XdgShellState,
        },
        shm::ShmState,
        socket::ListeningSocketSource,
        xwayland_shell::{XWaylandShellHandler, XWaylandShellState},
        dmabuf::{DmabufGlobal, DmabufHandler, DmabufState, ImportNotifier},
    },
    xwayland::{
        xwm::{Reorder, ResizeEdge, X11Window, XwmId},
        X11Surface, X11Wm, XwmHandler,
    },
};

use crate::{
    chrome_bridge::{ChromeEvent, NoOpChromeBridge, SharedChromeBridge, WindowInfo},
    derp_space::DerpSpaceElem,
    shell_ipc,
    window_registry::WindowRegistry,
    CalloopData,
};
use smithay::input::pointer::CursorImageStatus;

/// Titlebar strip height in **logical** pixels; keep in sync with `shell` decoration UI.
pub const SHELL_TITLEBAR_HEIGHT: i32 = 28;
/// Default **position** (output top-left + offset) for new xdg toplevels in **logical** px.
pub const DEFAULT_XDG_TOPLEVEL_OFFSET_X: i32 = 200;
pub const DEFAULT_XDG_TOPLEVEL_OFFSET_Y: i32 = 200;
/// Added per already-mapped toplevel so new windows are not stacked at the identical `(offset_x, offset_y)` (breaks shell chrome / input).
pub const DEFAULT_XDG_TOPLEVEL_CASCADE_STEP: i32 = 48;
/// Width of one titlebar control (minimize / close); keep in sync with `shell` CSS.
pub const SHELL_TITLEBAR_BUTTON_WIDTH: i32 = 40;
/// Right side of titlebar reserved for shell controls (minimize + close); keep in sync with `shell` CSS.
pub const SHELL_TITLEBAR_CONTROLS_INSET: i32 = SHELL_TITLEBAR_BUTTON_WIDTH * 2;
/// Border thickness around client for chrome hit-testing; keep in sync with `shell` CSS.
pub const SHELL_BORDER_THICKNESS: i32 = 4;
/// Wayland `app_id` for the embedded Solid CEF toplevel — must not appear in the shell HUD list.
pub const DERP_SOLID_SHELL_APP_ID: &str = "com.derp.solid-shell";
/// Window title set by `cef_host` (`WindowInfo::window_name`); used with [`DERP_SOLID_SHELL_APP_ID`].
pub const DERP_SOLID_SHELL_TITLE: &str = "derp-shell";

/// Solid’s own Chromium toplevel is composed below the HUD; shell IPC must not treat it like a managed app window.
#[inline]
pub(crate) fn window_is_solid_shell_host(title: &str, app_id: &str) -> bool {
    title == DERP_SOLID_SHELL_TITLE || app_id == DERP_SOLID_SHELL_APP_ID
}

#[derive(Debug, Clone)]
pub enum SocketConfig {
    Auto,
    Fixed(String),
}

pub struct CompositorInitOptions {
    pub socket: SocketConfig,
    pub seat_name: String,
    pub chrome_bridge: SharedChromeBridge,
    /// When set, listen on `XDG_RUNTIME_DIR`/name for shell pixel IPC ([`shell_wire`]).
    pub shell_ipc_socket: Option<String>,
    /// In-process shell bridge: `(compositor → peer tx, peer → compositor rx)`. When set, Unix
    /// shell socket is not bound (`shell_ipc_socket` ignored for listen).
    pub shell_ipc_embedded: Option<(
        std::sync::mpsc::Sender<Vec<u8>>,
        std::sync::mpsc::Receiver<Vec<u8>>,
    )>,
    /// If set while shell IPC is enabled, exit the compositor when `cef_host` sends nothing for this long (see `DERP_SHELL_WATCHDOG_SEC`).
    pub shell_ipc_stall_timeout: Option<Duration>,
    /// Headless / E2E hooks (`DERP_SHELL_E2E_*`). BGRA upload was removed; dma-buf path does not populate these yet.
    pub shell_e2e_status_path: Option<PathBuf>,
    /// Headless / E2E: PNG screenshot path (`DERP_SHELL_E2E_SCREENSHOT`).
    pub shell_e2e_screenshot_path: Option<PathBuf>,
}

impl Default for CompositorInitOptions {
    fn default() -> Self {
        Self {
            socket: SocketConfig::Auto,
            seat_name: "compositor".to_string(),
            chrome_bridge: Arc::new(NoOpChromeBridge),
            shell_ipc_socket: None,
            shell_ipc_embedded: None,
            shell_ipc_stall_timeout: None,
            shell_e2e_status_path: None,
            shell_e2e_screenshot_path: None,
        }
    }
}

/// Wayland `zwp_linux_dmabuf_v1` tranche for this compositor's EGL display.
///
/// Uses `EGLContext::dmabuf_render_formats` (non-external modifiers per
/// `EGL_EXT_image_dma_buf_import_modifiers`). `GlesRenderer::dmabuf_formats` / texture formats can
/// include external-only combos that [`GlesRenderer::import_dmabuf`] / `eglCreateImageFromDmaBufs`
/// reject with `EGL_BAD_MATCH` on KMS.
pub fn formats_for_linux_dmabuf_global(renderer: &GlesRenderer) -> Vec<Format> {
    let mut out: Vec<Format> = renderer
        .egl_context()
        .dmabuf_render_formats()
        .iter()
        .copied()
        .filter(|f| {
            matches!(
                f.code,
                Fourcc::Argb8888 | Fourcc::Xrgb8888 | Fourcc::Abgr8888 | Fourcc::Xbgr8888
            )
        })
        .collect();
    if out.is_empty() {
        out = renderer.dmabuf_formats().iter().copied().collect();
        tracing::warn!(
            "linux-dmabuf global: no RGB buffer formats in EGL render set; falling back to texture/import formats"
        );
    }
    out
}

pub struct CompositorState {
    pub start_time: std::time::Instant,
    pub socket_name: OsString,
    pub display_handle: DisplayHandle,

    pub space: Space<DerpSpaceElem>,
    pub loop_signal: LoopSignal,

    pub compositor_state: WlCompositorState,
    pub xdg_shell_state: XdgShellState,
    pub xdg_decoration_state: XdgDecorationState,
    pub fractional_scale_manager_state: FractionalScaleManagerState,
    pub cursor_shape_manager_state: CursorShapeManagerState,
    pub shm_state: ShmState,
    pub dmabuf_state: DmabufState,
    /// Populated when [`Self::init_linux_dmabuf_global`] runs (DRM or winit).
    dmabuf_global: Option<DmabufGlobal>,
    /// DRM: validate client dma-bufs with the scanout GLES stack. Nested winit leaves this unset.
    pub(crate) dmabuf_import_renderer: Option<Weak<Mutex<GlesRenderer>>>,
    pub output_manager_state: OutputManagerState,
    pub seat_state: SeatState<CompositorState>,
    pub data_device_state: DataDeviceState,
    pub popups: PopupManager,

    pub xwayland_shell_state: XWaylandShellState,
    pub x11_wm_slot: Option<(XwmId, X11Wm)>,

    pub seat: Seat<Self>,

    pub chrome_bridge: SharedChromeBridge,
    pub window_registry: WindowRegistry,

    /// Unix stream peer, in-process channel pair, or disconnected.
    pub shell_ipc_conn: crate::shell_ipc::ShellIpcConn,
    /// Linux [`SO_PEERCRED::pid`] of the shell IPC peer (`cef_host`), when connected via Unix socket.
    pub(crate) shell_ipc_peer_pid: Option<i32>,
    /// After first mapped output: run [`Self::shell_on_shell_client_connected`] once for embedded IPC.
    shell_embedded_initial_handshake_done: bool,
    pub shell_read_buf: Vec<u8>,
    /// `XDG_RUNTIME_DIR` when shell IPC is enabled.
    pub shell_ipc_runtime_dir: Option<PathBuf>,
    pub(crate) shell_read_scratch: Vec<u8>,
    /// Winit [`Window::inner_size`](https://docs.rs/winit/latest/winit/window/struct.Window.html#method-inner_size) —
    /// same denominator the backend uses for pointer normalization ([`crate::winit`] updates on resize).
    pub(crate) shell_window_physical_px: (i32, i32),
    /// When true, [`smithay::backend::input::AbsolutePositionEvent`] `x`/`y` on touch are **window pixels**
    /// (Smithay winit). When false (DRM libinput), touch coords use libinput mm / [`position_transformed`].
    pub(crate) touch_abs_is_window_pixels: bool,
    /// Touch→pointer emulation: slot of the emulated finger (first finger only).
    pub(crate) touch_emulation_slot: Option<TouchSlot>,
    /// First-finger touch is translated to [`shell_wire::MSG_COMPOSITOR_TOUCH`] (no synthetic LMB to CEF).
    pub(crate) touch_routes_to_cef: bool,
    /// Typing and shortcuts go to `cef_host` after interacting with the Solid shell layer.
    pub(crate) shell_ipc_keyboard_to_cef: bool,
    /// Latest pointer position as fraction of [`Self::shell_window_physical_px`] (0..1), window-local physical.
    pub(crate) shell_pointer_norm: Option<(f64, f64)>,
    /// Last `(x,y)` sent on shell IPC [`shell_wire::MSG_COMPOSITOR_POINTER_MOVE`] (dedupe spam).
    pub(crate) shell_last_pointer_ipc_px: Option<(i32, i32)>,
    /// Last client cursor from [`smithay::wayland::seat::SeatHandler::cursor_image`]; composited on DRM / nested swapchain.
    pub pointer_cursor_image: CursorImageStatus,
    /// Themed / system default pointer (`left_ptr`); also used for [`CursorImageStatus::Named`].
    pub(crate) cursor_fallback_buffer: MemoryRenderBuffer,
    /// Hotspot within [`Self::cursor_fallback_buffer`] (logical px).
    pub(crate) cursor_fallback_hotspot: (i32, i32),
    /// Last Wayland client toplevel that had keyboard focus (non–solid-shell). Used for taskbar
    /// minimize when real keyboard focus is on the shell/CEF layer.
    pub(crate) shell_last_non_shell_focus_window_id: Option<u32>,
    /// Wayland [`Window`] handles for compositor-minimized toplevels (unmapped from [`Self::space`]).
    pub(crate) shell_minimized_windows: HashMap<u32, Window>,
    /// [`WindowRegistry`]-scoped id for shell-initiated move (`MSG_SHELL_MOVE_*`).
    shell_move_window_id: Option<u32>,
    /// Pending delta for [`Self::shell_move_flush_pending_deltas`]. Applied from each [`Self::shell_move_delta`]
    /// (immediate flush) and from [`Self::shell_move_end`].
    shell_move_pending_delta: (i32, i32),
    /// Shell-initiated interactive resize ([`shell_wire::MSG_SHELL_RESIZE_*`]).
    shell_resize_window_id: Option<u32>,
    shell_resize_edges: Option<crate::grabs::resize_grab::ResizeEdge>,
    shell_resize_initial_rect: Option<Rectangle<i32, Logical>>,
    shell_resize_accum: (f64, f64),
    /// Drives nested winit repaints when Wayland clients commit or on first frame.
    pub(crate) needs_winit_redraw: bool,

    /// When [`Self::shell_ipc_stall_timeout`] is set: max gap without any shell→compositor message while connected.
    shell_ipc_stall_timeout: Option<Duration>,
    /// Last time a length-prefixed message was decoded from the shell peer.
    shell_ipc_last_rx: Option<Instant>,
    /// Last [`shell_wire::encode_compositor_ping`] sent (throttle while waiting for [`shell_wire::MSG_SHELL_PONG`]).
    pub(crate) shell_ipc_last_compositor_ping: Option<Instant>,

    /// Fds from the last `recvmsg` batch (dma-buf plane handles), drained in message order.
    pub shell_ipc_pending_fds: Vec<std::os::fd::OwnedFd>,
    pub shell_has_frame: bool,
    pub shell_view_px: Option<(u32, u32)>,
    pub shell_frame_is_dmabuf: bool,
    pub shell_dmabuf: Option<Dmabuf>,
    pub(crate) shell_dmabuf_overlay_id: Id,
    pub shell_post_drain_hook: Option<Box<dyn FnMut() + Send>>,
    /// Set from `DERP_SHELL_E2E_*` (no CPU output on dma-buf path until readback exists).
    #[allow(dead_code)]
    shell_e2e_status_path: Option<PathBuf>,
    #[allow(dead_code)]
    shell_e2e_screenshot_path: Option<PathBuf>,

    /// DRM only: used so **Ctrl+Alt+F1–F12** can switch virtual terminals via libseat (kernel shortcuts do not apply while we hold the input session).
    pub(crate) vt_session: Option<LibSeatSession>,
}

impl CompositorState {
    pub fn new(
        event_loop: &mut EventLoop<CalloopData>,
        display: Display<Self>,
        options: CompositorInitOptions,
    ) -> Self {
        let start_time = std::time::Instant::now();

        let dh = display.handle();

        let compositor_state = WlCompositorState::new::<Self>(&dh);
        let xdg_shell_state = XdgShellState::new::<Self>(&dh);
        let xdg_decoration_state = XdgDecorationState::new::<Self>(&dh);
        let fractional_scale_manager_state = FractionalScaleManagerState::new::<Self>(&dh);
        let cursor_shape_manager_state = CursorShapeManagerState::new::<Self>(&dh);
        let shm_state = ShmState::new::<Self>(&dh, vec![]);
        let dmabuf_state = DmabufState::new();
        let output_manager_state = OutputManagerState::new_with_xdg_output::<Self>(&dh);
        let mut seat_state = SeatState::new();
        let data_device_state = DataDeviceState::new::<Self>(&dh);
        let xwayland_shell_state = XWaylandShellState::new::<Self>(&dh);
        let chrome_bridge = options.chrome_bridge;
        let shell_ipc_socket = options.shell_ipc_socket.clone();
        let shell_ipc_embedded = options.shell_ipc_embedded;
        let shell_ipc_stall_timeout = options.shell_ipc_stall_timeout;
        let shell_e2e_status_path = options.shell_e2e_status_path.clone();
        let shell_e2e_screenshot_path = options.shell_e2e_screenshot_path.clone();
        let popups = PopupManager::default();
        let window_registry = WindowRegistry::new();
        let (cursor_fallback_buffer, cursor_fallback_hotspot) = crate::cursor_fallback::load_cursor_fallback();

        let mut seat: Seat<Self> = seat_state.new_wl_seat(&dh, &options.seat_name);
        seat.add_keyboard(Default::default(), 200, 25).unwrap();
        seat.add_pointer();

        let space = Space::default();

        let socket_name = Self::init_wayland_listener(display, event_loop, &options.socket);

        let loop_signal = event_loop.get_signal();

        let mut s = Self {
            start_time,
            display_handle: dh,
            space,
            loop_signal,
            socket_name,
            compositor_state,
            xdg_shell_state,
            xdg_decoration_state,
            fractional_scale_manager_state,
            cursor_shape_manager_state,
            shm_state,
            dmabuf_state,
            dmabuf_global: None,
            dmabuf_import_renderer: None,
            output_manager_state,
            seat_state,
            data_device_state,
            popups,
            xwayland_shell_state,
            x11_wm_slot: None,
            seat,
            chrome_bridge,
            window_registry,
            shell_ipc_conn: crate::shell_ipc::ShellIpcConn::Disconnected,
            shell_ipc_peer_pid: None,
            shell_embedded_initial_handshake_done: false,
            shell_read_buf: Vec::new(),
            shell_ipc_runtime_dir: None,
            shell_read_scratch: Vec::with_capacity(256 * 1024),
            shell_window_physical_px: (1, 1),
            touch_abs_is_window_pixels: false,
            touch_emulation_slot: None,
            touch_routes_to_cef: false,
            shell_ipc_keyboard_to_cef: false,
            shell_pointer_norm: None,
            shell_last_pointer_ipc_px: None,
            // Smithay only calls `cursor_image` when focus changes; motion with focus `None` and no
            // prior surface leaves this stale — `Hidden` meant zero composited cursor on the shell/CEF path.
            pointer_cursor_image: CursorImageStatus::default_named(),
            cursor_fallback_buffer,
            cursor_fallback_hotspot,
            shell_last_non_shell_focus_window_id: None,
            shell_minimized_windows: HashMap::new(),
            shell_move_window_id: None,
            shell_move_pending_delta: (0, 0),
            shell_resize_window_id: None,
            shell_resize_edges: None,
            shell_resize_initial_rect: None,
            shell_resize_accum: (0.0, 0.0),
            needs_winit_redraw: true,
            shell_ipc_stall_timeout,
            shell_ipc_last_rx: None,
            shell_ipc_last_compositor_ping: None,
            shell_ipc_pending_fds: Vec::new(),
            shell_has_frame: false,
            shell_view_px: None,
            shell_frame_is_dmabuf: false,
            shell_dmabuf: None,
            shell_dmabuf_overlay_id: Id::new(),
            shell_post_drain_hook: None,
            shell_e2e_status_path,
            shell_e2e_screenshot_path,
            vt_session: None,
        };

        if let Some((to_peer, from_peer)) = shell_ipc_embedded {
            if let Ok(rd) = std::env::var("XDG_RUNTIME_DIR") {
                let rd_path = PathBuf::from(&rd);
                s.shell_ipc_conn = crate::shell_ipc::ShellIpcConn::Embedded {
                    to_peer,
                    from_peer,
                };
                s.shell_ipc_runtime_dir = Some(rd_path);
                tracing::info!("shell ipc embedded (in-process channel)");
            } else {
                tracing::warn!("XDG_RUNTIME_DIR unset; embedded shell ipc not started");
            }
        } else if let Some(name) = shell_ipc_socket {
            if let Ok(rd) = std::env::var("XDG_RUNTIME_DIR") {
                let rd_path = PathBuf::from(&rd);
                if let Err(e) =
                    shell_ipc::register_shell_ipc_listener(event_loop, Path::new(&rd), &name)
                {
                    tracing::warn!(?e, name, "failed to bind shell ipc socket");
                } else {
                    s.shell_ipc_runtime_dir = Some(rd_path);
                    tracing::info!(%name, "shell ipc listening");
                }
            } else {
                tracing::warn!("XDG_RUNTIME_DIR unset; shell ipc not started");
            }
        }
        s
    }

    /// Advertise `zwp_linux_dmabuf_v1` using formats from the live GLES stack (call after `bind_wl_display`).
    pub fn init_linux_dmabuf_global(&mut self, formats: impl IntoIterator<Item = Format>) {
        if self.dmabuf_global.is_some() {
            return;
        }
        let formats: Vec<Format> = formats.into_iter().collect();
        if formats.is_empty() {
            tracing::warn!("linux-dmabuf global skipped (no dma-buf formats from renderer)");
            return;
        }
        let global = self
            .dmabuf_state
            .create_global::<Self>(&self.display_handle, formats);
        self.dmabuf_global = Some(global);
        tracing::info!("linux-dmabuf global created (native client buffers)");
    }

    /// DRM session handle for **Ctrl+Alt+F1–F12** VT switching ([`crate::input`]).
    pub fn set_vt_session(&mut self, session: Option<LibSeatSession>) {
        self.vt_session = session;
    }

    fn init_wayland_listener(
        display: Display<CompositorState>,
        event_loop: &mut EventLoop<CalloopData>,
        socket: &SocketConfig,
    ) -> OsString {
        let listening_socket = match socket {
            SocketConfig::Auto => ListeningSocketSource::new_auto().unwrap(),
            SocketConfig::Fixed(name) => ListeningSocketSource::with_name(name).unwrap(),
        };

        let socket_name = listening_socket.socket_name().to_os_string();

        let loop_handle = event_loop.handle();

        loop_handle
            .insert_source(listening_socket, move |client_stream, _, state| {
                state
                    .display_handle
                    .insert_client(client_stream, Arc::new(ClientState::default()))
                    .unwrap();
            })
            .expect("Failed to init the wayland event source.");

        loop_handle
            .insert_source(
                Generic::new(display, Interest::READ, Mode::Level),
                |_, display, state| {
                    unsafe {
                        display
                            .get_mut()
                            .dispatch_clients(&mut state.state)
                            .unwrap();
                    }
                    Ok(PostAction::Continue)
                },
            )
            .unwrap();

        socket_name
    }

    pub(crate) fn apply_fractional_scale_to_surface(&self, surface: &WlSurface) {
        let scale = self
            .space
            .outputs()
            .next()
            .map(|o| o.current_scale().fractional_scale())
            .unwrap_or(1.0);
        smithay::wayland::compositor::with_states(surface, |states| {
            smithay::wayland::fractional_scale::with_fractional_scale(states, |fs| {
                fs.set_preferred_scale(scale);
            });
        });
    }

    pub(crate) fn refresh_all_surface_fractional_scales(&self) {
        let scale = self
            .space
            .outputs()
            .next()
            .map(|o| o.current_scale().fractional_scale())
            .unwrap_or(1.0);
        for elem in self.space.elements() {
            if let DerpSpaceElem::Wayland(window) = elem {
                let surf = window.toplevel().unwrap().wl_surface();
                smithay::wayland::compositor::with_states(surf, |states| {
                    smithay::wayland::fractional_scale::with_fractional_scale(states, |fs| {
                        fs.set_preferred_scale(scale);
                    });
                });
            }
        }
    }

    pub fn surface_under(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(WlSurface, Point<f64, Logical>)> {
        self.space.element_under(pos).and_then(|(elem, location)| {
            let local = pos - location.to_f64();
            match elem {
                DerpSpaceElem::Wayland(window) => window
                    .surface_under(local, WindowSurfaceType::ALL)
                    .map(|(s, p)| (s, (p + location).to_f64())),
                DerpSpaceElem::X11(x11) => {
                    let surf = x11.wl_surface()?;
                    under_from_surface_tree(&surf, local, (0, 0), WindowSurfaceType::ALL)
                        .map(|(s, p)| (s, (p + location).to_f64()))
                }
            }
        })
    }

    /// Logical top-left for mapping a new xdg toplevel (client rectangle origin).
    ///
    /// The first window uses the default output-relative corner. Each additional window is placed
    /// **to the right of the rightmost** existing window (same `GAP` as [`DEFAULT_XDG_TOPLEVEL_CASCADE_STEP`]),
    /// or **below** all windows if there is no horizontal room. That avoids overlap even when the first
    /// window was dragged away from the default position (a fixed diagonal grid still collides).
    pub fn new_toplevel_initial_location(&self) -> (i32, i32) {
        const GAP: i32 = DEFAULT_XDG_TOPLEVEL_CASCADE_STEP;
        const MIN_PLACEHOLDER_W: i32 = 240;

        let Some(output) = self.space.outputs().next() else {
            return (DEFAULT_XDG_TOPLEVEL_OFFSET_X, DEFAULT_XDG_TOPLEVEL_OFFSET_Y);
        };
        let Some(geo) = self.space.output_geometry(output) else {
            return (DEFAULT_XDG_TOPLEVEL_OFFSET_X, DEFAULT_XDG_TOPLEVEL_OFFSET_Y);
        };

        let base_x = geo.loc.x.saturating_add(DEFAULT_XDG_TOPLEVEL_OFFSET_X);
        let base_y = geo.loc.y.saturating_add(DEFAULT_XDG_TOPLEVEL_OFFSET_Y);

        if self.space.elements().count() == 0 {
            return (base_x, base_y);
        }

        let mut max_right = i32::MIN;
        let mut min_top = i32::MAX;
        let mut max_bottom = i32::MIN;

        for w in self.space.elements() {
            let Some(loc) = self.space.element_location(w) else {
                continue;
            };
            let sz = w.geometry().size;
            let wdt = sz.w.max(1);
            let hgt = sz.h.max(1);
            max_right = max_right.max(loc.x.saturating_add(wdt));
            min_top = min_top.min(loc.y);
            max_bottom = max_bottom.max(loc.y.saturating_add(hgt));
        }

        if max_right == i32::MIN {
            return (base_x, base_y);
        }

        let right_limit = geo
            .loc
            .x
            .saturating_add(geo.size.w)
            .saturating_sub(MIN_PLACEHOLDER_W);

        let (mut x, mut y) = if max_right.saturating_add(GAP) > right_limit {
            (base_x, max_bottom.saturating_add(GAP))
        } else {
            (
                max_right.saturating_add(GAP),
                if min_top == i32::MAX { base_y } else { min_top },
            )
        };

        let min_y_client = geo.loc.y.saturating_add(SHELL_TITLEBAR_HEIGHT);
        let max_y_client = geo
            .loc
            .y
            .saturating_add(geo.size.h)
            .saturating_sub(32);
        y = y.clamp(min_y_client, max_y_client.max(min_y_client));

        let min_x_client = geo.loc.x;
        let max_x_client = geo
            .loc
            .x
            .saturating_add(geo.size.w)
            .saturating_sub(MIN_PLACEHOLDER_W);
        x = x.clamp(min_x_client, max_x_client.max(min_x_client));

        (x, y)
    }

    /// Top-left of the first mapped output in compositor logical space (shell host expects 0,0 here).
    pub(crate) fn primary_output_logical_origin(&self) -> (i32, i32) {
        let Some(output) = self.space.outputs().next() else {
            return (0, 0);
        };
        let Some(geo) = self.space.output_geometry(output) else {
            return (0, 0);
        };
        (geo.loc.x, geo.loc.y)
    }

    #[inline]
    pub(crate) fn shell_ipc_peer_matches_wayland_pid(&self, wayland_client_pid: Option<i32>) -> bool {
        let Some(shell_pid) = self.shell_ipc_peer_pid else {
            return false;
        };
        if shell_pid <= 0 {
            return false;
        }
        wayland_client_pid == Some(shell_pid)
    }

    /// Solid’s embedded CEF toplevel: known title/app_id or same PID as the shell Unix socket peer.
    pub(crate) fn toplevel_is_embedded_shell_host(
        &self,
        title: &str,
        app_id: &str,
        wayland_client_pid: Option<i32>,
    ) -> bool {
        window_is_solid_shell_host(title, app_id)
            || self.shell_ipc_peer_matches_wayland_pid(wayland_client_pid)
    }

    pub(crate) fn window_info_is_solid_shell_host(&self, info: &WindowInfo) -> bool {
        window_is_solid_shell_host(&info.title, &info.app_id)
            || self.shell_ipc_peer_matches_wayland_pid(info.wayland_client_pid)
    }

    /// Updates [`WindowRegistry`] from current [`Space`] layout and notifies the bridge if geometry changed.
    pub fn notify_geometry_if_changed(&mut self, window: &Window) {
        self.notify_geometry_for_window(window, false);
    }

    /// Like [`Self::notify_geometry_if_changed`], but when `force_shell_emit` is true always sends
    /// [`ChromeEvent::WindowGeometryChanged`] after updating the registry so the Solid shell can
    /// reconcile optimistic titlebar bumps even when `set_geometry` reports no delta (e.g. duplicate
    /// compositor updates vs. last-emitted shell state).
    pub(crate) fn notify_geometry_for_window(&mut self, window: &Window, force_shell_emit: bool) {
        let Some(toplevel) = window.toplevel() else {
            return;
        };
        let wl = toplevel.wl_surface();
        let Some(loc) = self
            .space
            .element_location(&DerpSpaceElem::Wayland(window.clone()))
        else {
            return;
        };
        let size = window.geometry().size;
        let changed = self
            .window_registry
            .set_geometry(wl, loc.x, loc.y, size.w, size.h);
        if force_shell_emit || changed == Some(true) {
            if let Some(info) = self.window_registry.snapshot_for_wl_surface(wl) {
                self.shell_emit_chrome_event(ChromeEvent::WindowGeometryChanged { info });
            }
        }
    }

    /// Map one **output-local logical** point to **shell layout** pixels (normalized over the output).
    pub(crate) fn shell_output_local_point_to_buffer_px(
        &self,
        output_size: smithay::utils::Size<i32, Logical>,
        lx: f64,
        ly: f64,
    ) -> Option<(i32, i32)> {
        let gw = output_size.w.max(1) as f64;
        let gh = output_size.h.max(1) as f64;
        let nx = (lx / gw).clamp(0.0, 1.0);
        let ny = (ly / gh).clamp(0.0, 1.0);
        let (buf_w, buf_h) = self.shell_output_logical_size()?;
        Some(crate::shell_letterbox::norm_to_buffer_px(nx, ny, buf_w, buf_h))
    }

    /// [`crate::chrome_bridge::WindowInfo`] uses **global compositor logical** geometry. Shell IPC uses the
    /// same normalized **shell layout** pixel space as [`Self::shell_output_local_point_to_buffer_px`].
    pub(crate) fn shell_window_info_to_osr_buffer_pixels(
        &self,
        info: &crate::chrome_bridge::WindowInfo,
    ) -> Option<crate::chrome_bridge::WindowInfo> {
        let output = self.space.outputs().next()?;
        let geo = self.space.output_geometry(output)?;
        let lx0 = (info.x - geo.loc.x) as f64;
        let ly0 = (info.y - geo.loc.y) as f64;
        let iw = info.width.max(1);
        let ih = info.height.max(1);
        let lx1 = lx0 + (iw - 1) as f64;
        let ly1 = ly0 + (ih - 1) as f64;
        let (bx0, by0) = self.shell_output_local_point_to_buffer_px(geo.size, lx0, ly0)?;
        let (bx1, by1) = self.shell_output_local_point_to_buffer_px(geo.size, lx1, ly1)?;
        let bw = (bx1 - bx0 + 1).max(1);
        let bh = (by1 - by0 + 1).max(1);
        Some(crate::chrome_bridge::WindowInfo {
            window_id: info.window_id,
            surface_id: info.surface_id,
            title: info.title.clone(),
            app_id: info.app_id.clone(),
            wayland_client_pid: info.wayland_client_pid,
            x: bx0,
            y: by0,
            width: bw,
            height: bh,
            minimized: info.minimized,
        })
    }

    fn chrome_event_suppress_shell_ipc(
        &self,
        event: &ChromeEvent,
        unmap_removed_info: Option<&WindowInfo>,
    ) -> bool {
        match event {
            ChromeEvent::WindowMapped { info }
            | ChromeEvent::WindowGeometryChanged { info }
            | ChromeEvent::WindowMetadataChanged { info } => {
                self.window_info_is_solid_shell_host(info)
            }
            ChromeEvent::WindowUnmapped { window_id } => {
                if let Some(i) = unmap_removed_info {
                    return self.window_info_is_solid_shell_host(i);
                }
                self.window_registry
                    .window_info(*window_id)
                    .map(|i| self.window_info_is_solid_shell_host(&i))
                    .unwrap_or(false)
            }
            ChromeEvent::FocusChanged { window_id, .. } => window_id
                .and_then(|w| self.window_registry.window_info(w))
                .map(|i| self.window_info_is_solid_shell_host(&i))
                .unwrap_or(false),
            ChromeEvent::WindowStateChanged { info, .. } => {
                self.window_info_is_solid_shell_host(info)
            }
        }
    }

    /// Notify [`ChromeBridge`] and push the same event on the shell IPC socket (if connected).
    ///
    /// The embedded Solid CEF toplevel is omitted on the shell wire so the HUD does not wrap its own content.
    pub fn shell_emit_chrome_event(&mut self, event: ChromeEvent) {
        self.shell_emit_chrome_event_inner(event, None);
    }

    /// Like [`Self::shell_emit_chrome_event`] for unmap after the window row was removed from [`WindowRegistry`].
    pub(crate) fn shell_emit_chrome_window_unmapped(
        &mut self,
        window_id: u32,
        removed_info: Option<WindowInfo>,
    ) {
        let hint = removed_info.as_ref();
        self.shell_emit_chrome_event_inner(
            ChromeEvent::WindowUnmapped { window_id },
            hint,
        );
    }

    /// When title/app_id becomes that of the Solid host after an earlier map with empty metadata, retract the phantom HUD entry.
    pub(crate) fn shell_retract_phantom_shell_window(&mut self, window_id: u32) {
        tracing::info!(
            target: "derp_shell_sync",
            window_id,
            "shell ipc WindowUnmapped (retract phantom shell host)"
        );
        let p = shell_wire::encode_window_unmapped(window_id);
        self.shell_ipc_try_write(&p);
        self.chrome_bridge
            .notify(ChromeEvent::WindowUnmapped { window_id });
    }

    fn shell_emit_chrome_event_inner(
        &mut self,
        event: ChromeEvent,
        unmap_removed_info: Option<&WindowInfo>,
    ) {
        let ipc_event = match &event {
            ChromeEvent::WindowMapped { info } => ChromeEvent::WindowMapped {
                info: self
                    .shell_window_info_to_osr_buffer_pixels(info)
                    .unwrap_or_else(|| info.clone()),
            },
            ChromeEvent::WindowGeometryChanged { info } => ChromeEvent::WindowGeometryChanged {
                info: self
                    .shell_window_info_to_osr_buffer_pixels(info)
                    .unwrap_or_else(|| info.clone()),
            },
            ChromeEvent::WindowStateChanged { info, minimized } => {
                ChromeEvent::WindowStateChanged {
                    info: self
                        .shell_window_info_to_osr_buffer_pixels(info)
                        .unwrap_or_else(|| info.clone()),
                    minimized: *minimized,
                }
            },
            _ => event.clone(),
        };

        let suppress = self.chrome_event_suppress_shell_ipc(&ipc_event, unmap_removed_info);
        let focus_cleared_for_shell = matches!(ipc_event, ChromeEvent::FocusChanged { .. }) && suppress;
        let shell_packet_source: ChromeEvent = if focus_cleared_for_shell {
            ChromeEvent::FocusChanged {
                surface_id: None,
                window_id: None,
            }
        } else {
            ipc_event.clone()
        };
        let skip_shell_packet = suppress && !focus_cleared_for_shell;

        // Filter compositor.log with: `derp_shell_sync` (see scripts/list-derp-logs.sh).
        match &ipc_event {
            ChromeEvent::WindowMapped { info } if !suppress => {
                tracing::info!(
                    target: "derp_shell_sync",
                    window_id = info.window_id,
                    surface_id = info.surface_id,
                    buf_x = info.x,
                    buf_y = info.y,
                    buf_w = info.width,
                    buf_h = info.height,
                    "shell ipc WindowMapped (OSR buffer px)"
                );
            }
            ChromeEvent::WindowMapped { info } if suppress => {
                tracing::debug!(
                    target: "derp_shell_sync",
                    window_id = info.window_id,
                    surface_id = info.surface_id,
                    "shell ipc WindowMapped suppressed (solid host)"
                );
            }
            ChromeEvent::WindowGeometryChanged { info } if !suppress => {
                tracing::debug!(
                    target: "derp_shell_sync",
                    window_id = info.window_id,
                    buf_x = info.x,
                    buf_y = info.y,
                    buf_w = info.width,
                    buf_h = info.height,
                    "shell ipc WindowGeometry"
                );
            }
            ChromeEvent::WindowGeometryChanged { info } if suppress => {
                tracing::trace!(
                    target: "derp_shell_sync",
                    window_id = info.window_id,
                    "shell ipc WindowGeometry suppressed (solid host)"
                );
            }
            ChromeEvent::WindowUnmapped { window_id } if !suppress => {
                tracing::info!(
                    target: "derp_shell_sync",
                    window_id,
                    "shell ipc WindowUnmapped"
                );
            }
            ChromeEvent::WindowUnmapped { window_id } if suppress => {
                tracing::debug!(
                    target: "derp_shell_sync",
                    window_id,
                    "shell ipc WindowUnmapped suppressed (solid host)"
                );
            }
            ChromeEvent::WindowMetadataChanged { info } if !suppress => {
                tracing::trace!(
                    target: "derp_shell_sync",
                    window_id = info.window_id,
                    title = %info.title,
                    "shell ipc WindowMetadata"
                );
            }
            ChromeEvent::WindowMetadataChanged { info } if suppress => {
                tracing::trace!(
                    target: "derp_shell_sync",
                    window_id = info.window_id,
                    "shell ipc WindowMetadata suppressed (solid host)"
                );
            }
            ChromeEvent::FocusChanged {
                surface_id,
                window_id,
            } => {
                if focus_cleared_for_shell {
                    tracing::debug!(
                        target: "derp_shell_sync",
                        ?surface_id,
                        ?window_id,
                        "shell ipc FocusChanged (solid host focused → clear HUD focus)"
                    );
                } else {
                    tracing::debug!(
                        target: "derp_shell_sync",
                        ?surface_id,
                        ?window_id,
                        "shell ipc FocusChanged"
                    );
                }
            }
            ChromeEvent::WindowStateChanged {
                info,
                minimized,
            } if !suppress => {
                tracing::debug!(
                    target: "derp_shell_sync",
                    window_id = info.window_id,
                    minimized,
                    "shell ipc WindowState"
                );
            }
            ChromeEvent::WindowStateChanged { info, .. } if suppress => {
                tracing::trace!(
                    target: "derp_shell_sync",
                    window_id = info.window_id,
                    "shell ipc WindowState suppressed (solid host)"
                );
            }
            _ => {}
        }

        if !skip_shell_packet {
            if let Some(p) = crate::shell_encode::chrome_event_to_shell_packet(&shell_packet_source)
            {
                self.shell_ipc_try_write(&p);
            }
        }
        self.chrome_bridge.notify(event);
    }

    /// Logical size matching [`Space::output_geometry`] / pointer normalization (not raw `current_mode` when they differ).
    pub fn shell_output_logical_size(&self) -> Option<(u32, u32)> {
        let output = self.space.outputs().next()?;
        let geo = self.space.output_geometry(output)?;
        let w = u32::try_from(geo.size.w).ok()?.max(1);
        let h = u32::try_from(geo.size.h).ok()?.max(1);
        Some((w, h))
    }

    pub fn send_shell_output_geometry(&mut self) {
        let Some((lw, lh)) = self.shell_output_logical_size() else {
            return;
        };
        let (pw, ph) = self.shell_window_physical_px;
        let physical_w = u32::try_from(pw).unwrap_or(lw).max(1);
        let physical_h = u32::try_from(ph).unwrap_or(lh).max(1);
        let pkt = shell_wire::encode_output_geometry(lw, lh, physical_w, physical_h);
        self.shell_ipc_try_write(&pkt);
    }

    /// Embedded shell IPC: first full handshake after [`Space::map_output`] so output geometry is non-empty.
    pub fn shell_embedded_notify_output_ready(&mut self) {
        if !matches!(
            self.shell_ipc_conn,
            crate::shell_ipc::ShellIpcConn::Embedded { .. }
        ) {
            return;
        }
        if self.shell_embedded_initial_handshake_done {
            return;
        }
        if self.shell_output_logical_size().is_none() {
            return;
        }
        self.shell_embedded_initial_handshake_done = true;
        self.shell_on_shell_client_connected();
    }

    /// After shell Unix `SO_PEERCRED` is set: snap host toplevel(s) to the output origin and drop any HUD row
    /// from an early map (Wayland before shell IPC).
    pub(crate) fn resync_embedded_shell_host_after_ipc_connect(&mut self) {
        if self.shell_ipc_peer_pid.is_none() {
            return;
        }
        let host_ids: Vec<u32> = self
            .window_registry
            .all_infos()
            .into_iter()
            .filter(|i| self.window_info_is_solid_shell_host(i))
            .map(|i| i.window_id)
            .collect();
        for wid in host_ids {
            self.shell_retract_phantom_shell_window(wid);
            let Some(sid) = self.window_registry.surface_id_for_window(wid) else {
                continue;
            };
            let Some(window) = self.find_window_by_surface_id(sid) else {
                continue;
            };
            let (ox, oy) = self.primary_output_logical_origin();
            self.space
                .map_element(DerpSpaceElem::Wayland(window.clone()), (ox, oy), true);
            self.notify_geometry_if_changed(&window);
            self.needs_winit_redraw = true;
        }
    }

    /// Full sync when `cef_host` connects: output size, all mapped windows, current focus (IPC only).
    pub fn shell_on_shell_client_connected(&mut self) {
        self.shell_note_shell_ipc_rx();
        self.shell_ipc_last_compositor_ping = None;
        self.send_shell_output_geometry();
        self.resync_embedded_shell_host_after_ipc_connect();
        for info in self.window_registry.all_infos() {
            if self.window_info_is_solid_shell_host(&info) {
                continue;
            }
            let ipc_info = self
                .shell_window_info_to_osr_buffer_pixels(&info)
                .unwrap_or_else(|| info.clone());
            if let Some(p) = shell_wire::encode_window_mapped(
                ipc_info.window_id,
                ipc_info.surface_id,
                ipc_info.x,
                ipc_info.y,
                ipc_info.width,
                ipc_info.height,
                &ipc_info.title,
                &ipc_info.app_id,
            ) {
                self.shell_ipc_try_write(&p);
            }
        }
        let (surface_id, window_id) = match self.seat.get_keyboard().and_then(|k| k.current_focus()) {
            Some(surf) => {
                let wid = self.window_registry.window_id_for_wl_surface(&surf);
                let sid = wid.and_then(|w| self.window_registry.surface_id_for_window(w));
                let focus_is_shell = wid
                    .and_then(|w| self.window_registry.window_info(w))
                    .map(|i| self.window_info_is_solid_shell_host(&i))
                    .unwrap_or(false);
                if focus_is_shell {
                    (None, None)
                } else {
                    (sid, wid)
                }
            }
            None => (None, None),
        };
        let pkt = shell_wire::encode_focus_changed(surface_id, window_id);
        self.shell_ipc_try_write(&pkt);
    }

    pub(crate) fn shell_note_shell_ipc_rx(&mut self) {
        self.shell_ipc_last_rx = Some(Instant::now());
    }

    pub(crate) fn shell_clear_ipc_last_rx(&mut self) {
        self.shell_ipc_last_rx = None;
    }

    /// Stops the compositor if a shell IPC client is connected but has been silent longer than [`Self::shell_ipc_stall_timeout`].
    pub(crate) fn shell_check_ipc_watchdog(&mut self) {
        let Some(limit) = self.shell_ipc_stall_timeout else {
            return;
        };
        if self.shell_ipc_conn.is_disconnected() {
            self.shell_ipc_last_compositor_ping = None;
            return;
        }
        let Some(last_rx) = self.shell_ipc_last_rx else {
            return;
        };
        let idle = last_rx.elapsed();
        // Silence does not reset `shell_ipc_last_rx`; prod `cef_host` answers ping → pong.
        let prod_after = std::cmp::max(limit / 2, Duration::from_millis(500))
            .min(Duration::from_secs(2));
        if idle >= prod_after {
            let throttle = Duration::from_secs(1);
            if self
                .shell_ipc_last_compositor_ping
                .map(|t| t.elapsed() >= throttle)
                .unwrap_or(true)
            {
                self.shell_ipc_try_write(&shell_wire::encode_compositor_ping());
                self.shell_ipc_last_compositor_ping = Some(Instant::now());
            }
        }
        if idle <= limit {
            return;
        }
        tracing::warn!(
            timeout_secs = limit.as_secs(),
            "shell ipc: no message from cef_host within timeout; stopping compositor (stuck shell IPC / JS)"
        );
        self.loop_signal.stop();
        self.loop_signal.wakeup();
    }

    fn shell_point_in_decoration_chrome(
        &self,
        px: f64,
        py: f64,
        x0: i32,
        y0: i32,
        w: i32,
        h: i32,
    ) -> bool {
        let th = SHELL_TITLEBAR_HEIGHT;
        let b = SHELL_BORDER_THICKNESS;
        let top = y0.saturating_sub(th);
        if px >= x0 as f64 && px < (x0 + w) as f64 && py >= top as f64 && py < y0 as f64 {
            return true;
        }
        if px >= (x0 - b) as f64
            && px < (x0 + w + b) as f64
            && py >= (y0 + h) as f64
            && py < (y0 + h + b) as f64
        {
            return true;
        }
        if px >= (x0 - b) as f64 && px < x0 as f64 && py >= y0 as f64 && py < (y0 + h) as f64 {
            return true;
        }
        if px >= (x0 + w) as f64
            && px < (x0 + w + b) as f64
            && py >= y0 as f64
            && py < (y0 + h) as f64
        {
            return true;
        }
        false
    }

    /// Titlebar strip for **drag** (excludes minimize + close button strip on the right).
    pub fn shell_point_in_titlebar_drag_region(
        &self,
        px: f64,
        py: f64,
        x0: i32,
        y0: i32,
        w: i32,
        _h: i32,
    ) -> bool {
        let th = SHELL_TITLEBAR_HEIGHT;
        let inset = SHELL_TITLEBAR_CONTROLS_INSET;
        let top = y0.saturating_sub(th);
        let drag_right = x0 + w - inset;
        px >= x0 as f64
            && px < drag_right as f64
            && py >= top as f64
            && py < y0 as f64
    }

    /// Titlebar minimize control (left of close); matches shell minimize button zone.
    pub fn shell_point_in_titlebar_minimize_region(
        &self,
        px: f64,
        py: f64,
        x0: i32,
        y0: i32,
        w: i32,
        _h: i32,
    ) -> bool {
        let th = SHELL_TITLEBAR_HEIGHT;
        let bw = SHELL_TITLEBAR_BUTTON_WIDTH;
        let ci = SHELL_TITLEBAR_CONTROLS_INSET;
        let top = y0.saturating_sub(th);
        let min_left = x0 + w - ci;
        let min_right = x0 + w - bw;
        px >= min_left as f64
            && px < min_right as f64
            && py >= top as f64
            && py < y0 as f64
    }

    /// Titlebar close control strip (rightmost [`SHELL_TITLEBAR_BUTTON_WIDTH`] px).
    pub fn shell_point_in_titlebar_close_region(
        &self,
        px: f64,
        py: f64,
        x0: i32,
        y0: i32,
        w: i32,
        _h: i32,
    ) -> bool {
        let th = SHELL_TITLEBAR_HEIGHT;
        let bw = SHELL_TITLEBAR_BUTTON_WIDTH;
        let top = y0.saturating_sub(th);
        let close_left = x0 + w - bw;
        px >= close_left as f64
            && px < (x0 + w) as f64
            && py >= top as f64
            && py < y0 as f64
    }

    /// Topmost window whose titlebar minimize region contains `pos`, if any.
    pub fn window_for_titlebar_minimize_at(&self, pos: Point<f64, Logical>) -> Option<Window> {
        let px = pos.x;
        let py = pos.y;
        for elem in self.space.elements().rev() {
            let DerpSpaceElem::Wayland(window) = elem else {
                continue;
            };
            let loc = self.space.element_location(elem)?;
            let geo = window.geometry();
            let x0 = loc.x;
            let y0 = loc.y;
            let w = geo.size.w;
            let h = geo.size.h;
            if self.shell_point_in_titlebar_minimize_region(px, py, x0, y0, w, h) {
                return Some(window.clone());
            }
        }
        None
    }

    /// Topmost window whose titlebar close region contains `pos`, if any.
    pub fn window_for_titlebar_close_at(&self, pos: Point<f64, Logical>) -> Option<Window> {
        let px = pos.x;
        let py = pos.y;
        for elem in self.space.elements().rev() {
            let DerpSpaceElem::Wayland(window) = elem else {
                continue;
            };
            let loc = self.space.element_location(elem)?;
            let geo = window.geometry();
            let x0 = loc.x;
            let y0 = loc.y;
            let w = geo.size.w;
            let h = geo.size.h;
            if self.shell_point_in_titlebar_close_region(px, py, x0, y0, w, h) {
                return Some(window.clone());
            }
        }
        None
    }

    /// Topmost window whose server-side titlebar drag region contains `pos`, if any.
    pub fn window_for_titlebar_drag_at(&self, pos: Point<f64, Logical>) -> Option<Window> {
        let px = pos.x;
        let py = pos.y;
        for elem in self.space.elements().rev() {
            let DerpSpaceElem::Wayland(window) = elem else {
                continue;
            };
            let loc = self.space.element_location(elem)?;
            let geo = window.geometry();
            let x0 = loc.x;
            let y0 = loc.y;
            let w = geo.size.w;
            let h = geo.size.h;
            if self.shell_point_in_titlebar_drag_region(px, py, x0, y0, w, h) {
                return Some(window.clone());
            }
        }
        None
    }

    /// Whether `pos` lies over shell-drawn per-window chrome (title strip or border frame) for any stacked window.
    pub fn shell_point_in_any_window_decoration(&self, pos: Point<f64, Logical>) -> bool {
        let px = pos.x;
        let py = pos.y;
        for elem in self.space.elements().rev() {
            let DerpSpaceElem::Wayland(window) = elem else {
                continue;
            };
            let Some(loc) = self.space.element_location(elem) else {
                continue;
            };
            let geo = window.geometry();
            if self.shell_point_in_decoration_chrome(px, py, loc.x, loc.y, geo.size.w, geo.size.h) {
                return true;
            }
        }
        false
    }

    /// True if the pointer is over the Solid shell layer (desktop + decoration chrome), not the native Wayland client beneath.
    pub fn shell_pointer_route_to_cef(&self, pos: Point<f64, Logical>) -> bool {
        let px = pos.x;
        let py = pos.y;

        for elem in self.space.elements().rev() {
            let DerpSpaceElem::Wayland(window) = elem else {
                continue;
            };
            let Some(loc) = self.space.element_location(elem) else {
                continue;
            };
            let geo = window.geometry();
            let x0 = loc.x;
            let y0 = loc.y;
            let w = geo.size.w;
            let h = geo.size.h;

            if self.shell_point_in_decoration_chrome(px, py, x0, y0, w, h) {
                return true;
            }
            if px >= x0 as f64 && px < (x0 + w) as f64 && py >= y0 as f64 && py < (y0 + h) as f64 {
                return false;
            }
        }

        true
    }

    /// Map normalized pointer (`nx`, `ny` over the output) to **shell layout** pixels (see `MSG_OUTPUT_GEOMETRY`).
    pub fn shell_pointer_buffer_pixels(&self, nx: f64, ny: f64) -> Option<(i32, i32)> {
        let (w, h) = self.shell_output_logical_size()?;
        Some(crate::shell_letterbox::norm_to_buffer_px(nx, ny, w, h))
    }

    pub(crate) fn shell_pointer_norm_from_global(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(f64, f64)> {
        let output = self.space.outputs().next()?;
        let output_geo = self.space.output_geometry(output)?;
        let local = pos - output_geo.loc.to_f64();
        let gw = output_geo.size.w.max(1) as f64;
        let gh = output_geo.size.h.max(1) as f64;
        Some((
            (local.x / gw).clamp(0.0, 1.0),
            (local.y / gh).clamp(0.0, 1.0),
        ))
    }

    pub fn find_window_by_surface_id(&self, surface_id: u32) -> Option<Window> {
        let window_id = self.window_registry.window_id_for_shell_surface(surface_id)?;
        self.space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                w.toplevel()
                    .and_then(|t| self.window_registry.window_id_for_wl_surface(t.wl_surface()))
                    .filter(|&id| id == window_id)
                    .map(|_| w.clone())
            } else {
                None
            }
        })
    }

    pub(crate) fn shell_move_is_active(&self) -> bool {
        self.shell_move_window_id.is_some()
    }

    pub(crate) fn shell_move_end_active(&mut self) {
        let Some(wid) = self.shell_move_window_id else {
            return;
        };
        tracing::warn!(target: "derp_shell_move", wid, "shell_move_end_active (seat LMB release)");
        self.shell_move_end(wid);
    }

    pub fn shell_move_begin(&mut self, window_id: u32) {
        if let Some(rid) = self.shell_resize_window_id {
            self.shell_resize_end(rid);
        }
        let Some(info) = self.window_registry.window_info(window_id) else {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_begin: unknown window_id (registry)"
            );
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_begin: ignored (embedded Solid / shell host)"
            );
            return;
        }
        let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_begin: unknown surface (registry)"
            );
            return;
        };
        let Some(window) = self.find_window_by_surface_id(sid) else {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                sid,
                "shell_move_begin: surface not in space"
            );
            return;
        };

        if self.shell_move_window_id == Some(window_id) {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_begin: already active (no-op)"
            );
            return;
        }

        if let Some(prev) = self.shell_move_window_id {
            if prev != window_id {
                self.shell_move_end(prev);
            }
        }

        self.space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        let wl_surface = window.toplevel().unwrap().wl_surface().clone();
        let k_serial = SERIAL_COUNTER.next_serial();
        self.seat
            .get_keyboard()
            .unwrap()
            .set_focus(self, Some(wl_surface.clone()), k_serial);
        self.space.elements().for_each(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                w.toplevel().unwrap().send_pending_configure();
            }
        });

        self.shell_move_window_id = Some(window_id);
        self.shell_move_pending_delta = (0, 0);
        self.needs_winit_redraw = true;
        let loc = self
            .space
            .element_location(&DerpSpaceElem::Wayland(window.clone()));
        tracing::warn!(
            target: "derp_shell_move",
            window_id,
            loc = ?loc,
            "shell_move_begin: started"
        );
    }

    /// Applies [`Self::shell_move_pending_delta`] to the active shell-move window in [`Self::space`].
    fn shell_move_flush_pending_deltas(&mut self) {
        let Some(wid) = self.shell_move_window_id else {
            return;
        };
        let (pdx, pdy) = self.shell_move_pending_delta;
        if pdx == 0 && pdy == 0 {
            return;
        }
        let Some(sid) = self.window_registry.surface_id_for_window(wid) else {
            tracing::warn!(target: "derp_shell_move", wid, "shell_move_flush: registry lost window");
            self.shell_move_window_id = None;
            self.shell_move_pending_delta = (0, 0);
            return;
        };
        let Some(window) = self.find_window_by_surface_id(sid) else {
            tracing::warn!(target: "derp_shell_move", wid, sid, "shell_move_flush: window gone");
            self.shell_move_window_id = None;
            self.shell_move_pending_delta = (0, 0);
            return;
        };
        let Some(loc) = self.space.element_location(&DerpSpaceElem::Wayland(window.clone())) else {
            tracing::warn!(target: "derp_shell_move", wid, "shell_move_flush: no element_location");
            return;
        };
        let before = (loc.x, loc.y);
        let after = (loc.x + pdx, loc.y + pdy);
        self.space
            .map_element(DerpSpaceElem::Wayland(window.clone()), after, true);
        self.shell_move_pending_delta = (0, 0);
        self.notify_geometry_for_window(&window, true);
        self.needs_winit_redraw = true;
        tracing::debug!(
            target: "derp_shell_move",
            wid,
            pdx,
            pdy,
            before = ?before,
            after = ?after,
            "shell_move: flushed pending delta"
        );
    }

    pub fn shell_move_delta(&mut self, dx: i32, dy: i32) {
        let Some(wid) = self.shell_move_window_id else {
            tracing::debug!(
                target: "derp_shell_move",
                dx,
                dy,
                "shell_move_delta: ignored (no active move)"
            );
            return;
        };
        let Some(sid) = self.window_registry.surface_id_for_window(wid) else {
            tracing::warn!(target: "derp_shell_move", wid, "shell_move_delta: registry lost window");
            self.shell_move_window_id = None;
            self.shell_move_pending_delta = (0, 0);
            return;
        };
        let Some(window) = self.find_window_by_surface_id(sid) else {
            tracing::warn!(target: "derp_shell_move", wid, sid, "shell_move_delta: window gone from space");
            self.shell_move_window_id = None;
            self.shell_move_pending_delta = (0, 0);
            return;
        };
        let Some(_loc) = self
            .space
            .element_location(&DerpSpaceElem::Wayland(window.clone()))
        else {
            tracing::warn!(target: "derp_shell_move", wid, "shell_move_delta: no element_location");
            return;
        };
        self.shell_move_pending_delta.0 += dx;
        self.shell_move_pending_delta.1 += dy;
        tracing::trace!(
            target: "derp_shell_move",
            wid,
            dx,
            dy,
            accum = ?self.shell_move_pending_delta,
            "shell_move_delta: flushing to space (Wayland geometry tracks pointer)"
        );
        self.shell_move_flush_pending_deltas();
    }

    /// Clears shell move state after `move_end` IPC, compositor button release, or disconnect.
    pub(crate) fn shell_move_end_cleanup(&mut self, window_id: u32, window: &Window) {
        if self.shell_move_window_id != Some(window_id) {
            return;
        }
        self.shell_move_window_id = None;
        self.notify_geometry_for_window(window, true);
        self.needs_winit_redraw = true;
    }

    pub fn shell_move_end(&mut self, window_id: u32) {
        if self.shell_move_window_id != Some(window_id) {
            tracing::debug!(
                target: "derp_shell_move",
                window_id,
                active = ?self.shell_move_window_id,
                "shell_move_end: ignored (stale or no active move)"
            );
            return;
        }
        let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_end: no surface; clearing active move"
            );
            self.shell_move_window_id = None;
            self.shell_move_pending_delta = (0, 0);
            self.needs_winit_redraw = true;
            return;
        };
        let Some(window) = self.find_window_by_surface_id(sid) else {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                sid,
                "shell_move_end: surface missing; clearing"
            );
            self.shell_move_window_id = None;
            self.shell_move_pending_delta = (0, 0);
            self.needs_winit_redraw = true;
            return;
        };
        self.shell_move_flush_pending_deltas();
        self.shell_move_end_cleanup(window_id, &window);
        tracing::warn!(
            target: "derp_shell_move",
            window_id,
            "shell_move_end: finished"
        );
    }

    /// End an in-progress shell move when the shell IPC client disconnects (avoid stuck state).
    pub(crate) fn shell_disconnect_end_move_if_any(&mut self) {
        let Some(wid) = self.shell_move_window_id else {
            return;
        };
        self.shell_move_end(wid);
    }

    pub(crate) fn shell_resize_is_active(&self) -> bool {
        self.shell_resize_window_id.is_some()
    }

    pub(crate) fn shell_resize_end_active(&mut self) {
        let Some(wid) = self.shell_resize_window_id else {
            return;
        };
        self.shell_resize_end(wid);
    }

    pub(crate) fn shell_disconnect_end_resize_if_any(&mut self) {
        let Some(wid) = self.shell_resize_window_id else {
            return;
        };
        self.shell_resize_end(wid);
    }

    pub fn shell_resize_begin(&mut self, window_id: u32, edges_wire: u32) {
        use crate::grabs::resize_grab::{resize_tracking_set_resizing, ResizeEdge as GrabResizeEdge};
        use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;

        if let Some(mid) = self.shell_move_window_id {
            self.shell_move_end(mid);
        }
        if self.shell_resize_window_id == Some(window_id) {
            tracing::warn!(
                target: "derp_shell_resize",
                window_id,
                "shell_resize_begin: already active (no-op)"
            );
            return;
        }
        if let Some(prev) = self.shell_resize_window_id {
            self.shell_resize_end(prev);
        }

        let Some(edges) = GrabResizeEdge::from_bits(edges_wire) else {
            tracing::warn!(
                target: "derp_shell_resize",
                edges_wire,
                "shell_resize_begin: invalid edges"
            );
            return;
        };
        if edges.is_empty() {
            return;
        }

        let Some(info) = self.window_registry.window_info(window_id) else {
            tracing::warn!(
                target: "derp_shell_resize",
                window_id,
                "shell_resize_begin: unknown window"
            );
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            tracing::warn!(
                target: "derp_shell_resize",
                window_id,
                "shell_resize_begin: ignored (shell host)"
            );
            return;
        }
        let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
            return;
        };
        let Some(window) = self.find_window_by_surface_id(sid) else {
            return;
        };
        let Some(loc) = self
            .space
            .element_location(&DerpSpaceElem::Wayland(window.clone()))
        else {
            return;
        };
        let geo = window.geometry();
        let initial_rect = Rectangle::new(loc, geo.size);
        let tl = window.toplevel().unwrap();
        let wl = tl.wl_surface();
        resize_tracking_set_resizing(wl, edges, initial_rect);
        tl.with_pending_state(|state| {
            state.states.set(xdg_toplevel::State::Resizing);
        });
        tl.send_pending_configure();

        self.shell_resize_window_id = Some(window_id);
        self.shell_resize_edges = Some(edges);
        self.shell_resize_initial_rect = Some(initial_rect);
        self.shell_resize_accum = (0.0, 0.0);

        self.space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        let k_serial = SERIAL_COUNTER.next_serial();
        self.seat
            .get_keyboard()
            .unwrap()
            .set_focus(self, Some(wl.clone()), k_serial);
        self.needs_winit_redraw = true;
    }

    pub fn shell_resize_delta(&mut self, dx: i32, dy: i32) {
        use crate::grabs::resize_grab::compute_clamped_resize_size;
        use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;

        let Some(wid) = self.shell_resize_window_id else {
            return;
        };
        let Some(edges) = self.shell_resize_edges else {
            return;
        };
        let Some(initial_rect) = self.shell_resize_initial_rect else {
            return;
        };
        let Some(sid) = self.window_registry.surface_id_for_window(wid) else {
            self.shell_resize_window_id = None;
            self.shell_resize_edges = None;
            self.shell_resize_initial_rect = None;
            self.shell_resize_accum = (0.0, 0.0);
            return;
        };
        let Some(window) = self.find_window_by_surface_id(sid) else {
            self.shell_resize_window_id = None;
            self.shell_resize_edges = None;
            self.shell_resize_initial_rect = None;
            self.shell_resize_accum = (0.0, 0.0);
            return;
        };

        self.shell_resize_accum.0 += dx as f64;
        self.shell_resize_accum.1 += dy as f64;

        let tl = window.toplevel().unwrap();
        let wl = tl.wl_surface();
        let last_size = compute_clamped_resize_size(
            wl,
            edges,
            initial_rect.size,
            self.shell_resize_accum.0,
            self.shell_resize_accum.1,
        );

        tl.with_pending_state(|state| {
            state.states.set(xdg_toplevel::State::Resizing);
            state.size = Some(last_size);
        });
        tl.send_pending_configure();
        self.needs_winit_redraw = true;
    }

    pub fn shell_resize_end(&mut self, window_id: u32) {
        use crate::grabs::resize_grab::{
            compute_clamped_resize_size, resize_tracking_set_waiting_last_commit,
        };
        use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;

        if self.shell_resize_window_id != Some(window_id) {
            tracing::debug!(
                target: "derp_shell_resize",
                window_id,
                active = ?self.shell_resize_window_id,
                "shell_resize_end: ignored"
            );
            return;
        }

        let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
            self.shell_resize_window_id = None;
            self.shell_resize_edges = None;
            self.shell_resize_initial_rect = None;
            self.shell_resize_accum = (0.0, 0.0);
            return;
        };
        let Some(window) = self.find_window_by_surface_id(sid) else {
            self.shell_resize_window_id = None;
            self.shell_resize_edges = None;
            self.shell_resize_initial_rect = None;
            self.shell_resize_accum = (0.0, 0.0);
            return;
        };

        let Some(edges) = self.shell_resize_edges else {
            self.shell_resize_window_id = None;
            self.shell_resize_accum = (0.0, 0.0);
            return;
        };
        let Some(initial_rect) = self.shell_resize_initial_rect else {
            self.shell_resize_window_id = None;
            self.shell_resize_edges = None;
            self.shell_resize_accum = (0.0, 0.0);
            return;
        };

        let tl = window.toplevel().unwrap();
        let wl = tl.wl_surface();
        let last_size = compute_clamped_resize_size(
            wl,
            edges,
            initial_rect.size,
            self.shell_resize_accum.0,
            self.shell_resize_accum.1,
        );

        tl.with_pending_state(|state| {
            state.states.unset(xdg_toplevel::State::Resizing);
            state.size = Some(last_size);
        });
        tl.send_pending_configure();
        resize_tracking_set_waiting_last_commit(wl, edges, initial_rect);

        self.shell_resize_window_id = None;
        self.shell_resize_edges = None;
        self.shell_resize_initial_rect = None;
        self.shell_resize_accum = (0.0, 0.0);

        self.needs_winit_redraw = true;
        tracing::debug!(
            target: "derp_shell_resize",
            window_id,
            "shell_resize_end: finished"
        );
    }

    /// Compositor → shell: full window list ([`shell_wire::MSG_WINDOW_LIST`]).
    pub fn shell_reply_window_list(&mut self) {
        let windows: Vec<shell_wire::ShellWindowSnapshot> = self
            .window_registry
            .all_infos()
            .into_iter()
            .filter(|i| !self.window_info_is_solid_shell_host(i))
            .map(|i| {
                let i = self
                    .shell_window_info_to_osr_buffer_pixels(&i)
                    .unwrap_or_else(|| i.clone());
                shell_wire::ShellWindowSnapshot {
                    window_id: i.window_id,
                    surface_id: i.surface_id,
                    x: i.x,
                    y: i.y,
                    w: i.width,
                    h: i.height,
                    minimized: if i.minimized { 1 } else { 0 },
                    title: i.title,
                    app_id: i.app_id,
                }
            })
            .collect();
        if let Some(pkt) = shell_wire::encode_window_list(&windows) {
            self.shell_ipc_try_write(&pkt);
        }
    }

    pub fn shell_set_window_geometry(&mut self, window_id: u32, x: i32, y: i32, w: i32, h: i32) {
        let Some(info) = self.window_registry.window_info(window_id) else {
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            return;
        }
        let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
            return;
        };
        let Some(window) = self.find_window_by_surface_id(sid) else {
            return;
        };
        let tl = window.toplevel().unwrap();
        tl.with_pending_state(|state| {
            state.size = Some(smithay::utils::Size::from((w, h)));
        });
        tl.send_pending_configure();
        self.space
            .map_element(DerpSpaceElem::Wayland(window.clone()), (x, y), true);
        self.notify_geometry_if_changed(&window);
        self.needs_winit_redraw = true;
    }

    pub fn shell_close_window(&mut self, window_id: u32) {
        let Some(info) = self.window_registry.window_info(window_id) else {
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            return;
        }
        let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
            return;
        };
        let Some(window) = self.find_window_by_surface_id(sid) else {
            return;
        };
        if self.shell_move_window_id == Some(window_id) {
            self.shell_move_end(window_id);
        }
        if self.shell_resize_window_id == Some(window_id) {
            self.shell_resize_end(window_id);
        }
        window.toplevel().unwrap().send_close();
        self.needs_winit_redraw = true;
    }

    pub fn shell_set_window_fullscreen(&mut self, window_id: u32, enabled: bool) {
        use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;
        let Some(info) = self.window_registry.window_info(window_id) else {
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            return;
        }
        let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
            return;
        };
        let Some(window) = self.find_window_by_surface_id(sid) else {
            return;
        };
        let tl = window.toplevel().unwrap();
        tl.with_pending_state(|state| {
            if enabled {
                state.states.set(xdg_toplevel::State::Fullscreen);
            } else {
                state.states.unset(xdg_toplevel::State::Fullscreen);
                state.fullscreen_output = None;
            }
        });
        tl.send_pending_configure();
        self.needs_winit_redraw = true;
    }

    fn keyboard_focused_window_id(&self) -> Option<u32> {
        let surf = self.seat.get_keyboard()?.current_focus()?;
        self.window_registry.window_id_for_wl_surface(&surf)
    }

    /// Raise a mapped Wayland toplevel to the top of the stack and give it keyboard focus.
    pub fn shell_raise_and_focus_window(&mut self, window_id: u32) {
        let Some(info) = self.window_registry.window_info(window_id) else {
            return;
        };
        if info.minimized || self.window_info_is_solid_shell_host(&info) {
            return;
        }
        let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
            return;
        };
        let Some(window) = self.find_window_by_surface_id(sid) else {
            return;
        };
        self.shell_ipc_keyboard_to_cef = false;
        self.space.elements().for_each(|e| {
            e.set_activate(false);
            if let DerpSpaceElem::Wayland(w) = e {
                w.toplevel().unwrap().send_pending_configure();
            }
        });
        let _ = window.set_activated(true);
        self.space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        let wl_surface = window.toplevel().unwrap().wl_surface().clone();
        let k_serial = SERIAL_COUNTER.next_serial();
        self.seat
            .get_keyboard()
            .unwrap()
            .set_focus(self, Some(wl_surface), k_serial);
        self.space.elements().for_each(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                w.toplevel().unwrap().send_pending_configure();
            }
        });
        self.needs_winit_redraw = true;
    }

    fn shell_emit_window_state(&mut self, window_id: u32, minimized: bool) {
        let Some(info) = self.window_registry.window_info(window_id) else {
            return;
        };
        self.shell_emit_chrome_event(ChromeEvent::WindowStateChanged { info, minimized });
    }

    /// Hide a toplevel (xdg minimized + unmap); stash the [`Window`] for restore.
    pub fn shell_minimize_window(&mut self, window_id: u32) {
        let Some(info) = self.window_registry.window_info(window_id) else {
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            return;
        }
        if info.minimized {
            return;
        }
        let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
            return;
        };
        let Some(window) = self.find_window_by_surface_id(sid) else {
            return;
        };

        if self.shell_move_window_id == Some(window_id) {
            self.shell_move_end(window_id);
        }
        if self.shell_resize_window_id == Some(window_id) {
            self.shell_resize_end(window_id);
        }

        let _ = window.set_activated(false);
        window.toplevel().unwrap().send_pending_configure();
        self.shell_minimized_windows
            .insert(window_id, window.clone());
        self.space.unmap_elem(&DerpSpaceElem::Wayland(window));
        self.window_registry.set_minimized(window_id, true);

        if self.shell_last_non_shell_focus_window_id == Some(window_id) {
            self.shell_last_non_shell_focus_window_id = None;
        }

        if self.keyboard_focused_window_id() == Some(window_id) {
            let serial = SERIAL_COUNTER.next_serial();
            self.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Option::<WlSurface>::None, serial);
        }

        self.needs_winit_redraw = true;
        self.shell_emit_window_state(window_id, true);
    }

    /// Map a compositor-minimized toplevel back into the space and focus it.
    pub fn shell_restore_minimized_window(&mut self, window_id: u32) {
        let Some(info) = self.window_registry.window_info(window_id) else {
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            return;
        }
        if !info.minimized {
            return;
        }
        let Some(window) = self.shell_minimized_windows.remove(&window_id) else {
            let _ = self.window_registry.set_minimized(window_id, false);
            return;
        };

        self.shell_ipc_keyboard_to_cef = false;
        self.space.elements().for_each(|e| {
            e.set_activate(false);
            if let DerpSpaceElem::Wayland(w) = e {
                w.toplevel().unwrap().send_pending_configure();
            }
        });

        self.space.map_element(
            DerpSpaceElem::Wayland(window.clone()),
            (info.x, info.y),
            true,
        );
        let _ = self.window_registry.set_minimized(window_id, false);

        let _ = window.set_activated(true);
        self.space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        let wl_surface = window.toplevel().unwrap().wl_surface().clone();
        let k_serial = SERIAL_COUNTER.next_serial();
        self.seat
            .get_keyboard()
            .unwrap()
            .set_focus(self, Some(wl_surface), k_serial);
        self.space.elements().for_each(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                w.toplevel().unwrap().send_pending_configure();
            }
        });

        self.notify_geometry_if_changed(&window);
        self.needs_winit_redraw = true;
        self.shell_emit_window_state(window_id, false);
    }

    /// Taskbar: restore if minimized; else minimize if already focused; else raise and focus.
    pub fn shell_taskbar_activate(&mut self, window_id: u32) {
        let Some(info) = self.window_registry.window_info(window_id) else {
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            return;
        }

        if info.minimized {
            self.shell_restore_minimized_window(window_id);
            return;
        }

        let kb = self.keyboard_focused_window_id();
        let last = self.shell_last_non_shell_focus_window_id;
        let should_minimize =
            kb == Some(window_id) || last == Some(window_id);
        if should_minimize {
            self.shell_minimize_window(window_id);
        } else {
            self.shell_raise_and_focus_window(window_id);
        }
    }

    /// Letterboxed shell in **output-local logical** pixels `(ox, oy, cw, ch)`.
    pub(crate) fn shell_letterbox_logical(
        &self,
        output_logical_size: Size<i32, Logical>,
    ) -> Option<(i32, i32, i32, i32)> {
        let (buf_w, buf_h) = self.shell_view_px?;
        crate::shell_letterbox::letterbox_logical(output_logical_size, buf_w, buf_h)
    }

    /// Map global logical pointer position to **shell view / buffer** pixels (letterboxed HUD).
    pub(crate) fn shell_pointer_view_px(&self, pos: Point<f64, Logical>) -> Option<(i32, i32)> {
        let output = self.space.outputs().next()?;
        let output_geo = self.space.output_geometry(output)?;
        let local = pos - output_geo.loc.to_f64();
        let (buf_w, buf_h) = self.shell_view_px?;
        let (ox, oy, cw, ch) = self.shell_letterbox_logical(output_geo.size)?;
        let lx = local.x - ox as f64;
        let ly = local.y - oy as f64;
        crate::shell_letterbox::local_in_letterbox_to_buffer_px(lx, ly, cw, ch, buf_w, buf_h)
    }

    /// Build a dma-buf from plane metadata + [`OwnedFd`]s (same order as `planes`). On success, drains `fds`.
    pub fn apply_shell_frame_dmabuf(
        &mut self,
        width: u32,
        height: u32,
        drm_format: u32,
        modifier: u64,
        flags: u32,
        planes: &[shell_wire::FrameDmabufPlane],
        fds: &mut Vec<OwnedFd>,
    ) -> Result<(), &'static str> {
        if width == 0 || height == 0 {
            fds.clear();
            return Err("bad dimensions");
        }
        if planes.is_empty() || planes.len() != fds.len() {
            fds.clear();
            return Err("dmabuf plane/fd mismatch");
        }
        let format = Fourcc::try_from(drm_format).map_err(|_| "unrecognized drm fourcc")?;
        let modifier_u64_raw = modifier;
        let modifier = Modifier::from(modifier_u64_raw);
        let dmabuf_flags = if (flags & shell_wire::DMABUF_FLAG_Y_INVERT) != 0 {
            DmabufFlags::Y_INVERT
        } else {
            DmabufFlags::empty()
        };
        let mut b = Dmabuf::builder(
            Size::<i32, Buffer>::from((width as i32, height as i32)),
            format,
            modifier,
            dmabuf_flags,
        );
        for (p, fd) in planes.iter().zip(fds.drain(..)) {
            let off = u32::try_from(p.offset).map_err(|_| "plane offset too large")?;
            if !b.add_plane(fd, p.plane_idx, off, p.stride) {
                return Err("dmabuf add_plane failed");
            }
        }
        let Some(dmabuf) = b.build() else {
            return Err("dmabuf build");
        };
        // Fresh [`Id`] each frame: static dma-buf textures use an empty damage snapshot with a stable
        // commit counter, otherwise [`OutputDamageTracker`] stops marking the shell plane damaged and
        // only the cursor region repaints (streaks / stale CEF under the pointer).
        self.shell_dmabuf_overlay_id = Id::new();
        self.shell_dmabuf = Some(dmabuf);
        self.shell_frame_is_dmabuf = true;
        self.shell_has_frame = true;
        self.shell_view_px = Some((width, height));
        self.needs_winit_redraw = true;
        self.shell_move_flush_pending_deltas();
        tracing::debug!(
            target: "derp_shell_dmabuf",
            width,
            height,
            drm_format,
            drm_format_hex = drm_format,
            modifier = ?modifier,
            modifier_u64 = modifier_u64_raw,
            flags,
            plane_count = planes.len(),
            planes = ?planes
                .iter()
                .map(|p| (p.plane_idx, p.stride, p.offset))
                .collect::<Vec<_>>(),
            fourcc_resolved = ?format,
            "apply_shell_frame_dmabuf (IPC from cef_host)"
        );
        Ok(())
    }

    pub fn clear_shell_frame(&mut self) {
        self.shell_has_frame = false;
        self.shell_view_px = None;
        self.shell_frame_is_dmabuf = false;
        self.shell_dmabuf = None;
        self.shell_last_pointer_ipc_px = None;
        self.touch_routes_to_cef = false;
        self.needs_winit_redraw = true;
    }

    /// Current keyboard → `cef_event_flags_t` (shift/control/alt/meta/caps/AltGr).
    pub(crate) fn shell_cef_event_flags(&self) -> u32 {
        let Some(kb) = self.seat.get_keyboard() else {
            return 0;
        };
        Self::cef_flags_from_modifiers(&kb.modifier_state())
    }

    fn cef_flags_from_modifiers(m: &ModifiersState) -> u32 {
        let mut f = 0u32;
        if m.caps_lock {
            f |= 1;
        }
        if m.shift {
            f |= 2;
        }
        if m.ctrl {
            f |= 4;
        }
        if m.alt {
            f |= 8;
        }
        if m.logo {
            f |= 128;
        }
        if m.iso_level3_shift {
            f |= 4096;
        }
        f
    }

    pub(crate) fn shell_ipc_forward_keyboard_to_cef(
        &mut self,
        key_state: KeyState,
        mods: &ModifiersState,
        keysym: &KeysymHandle<'_>,
    ) {
        if self.shell_ipc_conn.is_disconnected() || !self.shell_has_frame {
            return;
        }
        let sym = keysym.modified_sym();
        let mods_u = Self::cef_flags_from_modifiers(mods);
        let native = sym.raw() as i32;
        match key_state {
            KeyState::Pressed => {
                self.shell_ipc_try_write(&shell_wire::encode_compositor_key(
                    shell_wire::CEF_KEYEVENT_RAWKEYDOWN,
                    mods_u,
                    0,
                    native,
                    0,
                    0,
                ));
                if let Some(ch) = sym.key_char() {
                    if !ch.is_control() {
                        let cu = ch as u32;
                        self.shell_ipc_try_write(&shell_wire::encode_compositor_key(
                            shell_wire::CEF_KEYEVENT_CHAR,
                            mods_u,
                            0,
                            native,
                            cu,
                            cu,
                        ));
                    }
                }
            }
            KeyState::Released => {
                self.shell_ipc_try_write(&shell_wire::encode_compositor_key(
                    shell_wire::CEF_KEYEVENT_KEYUP,
                    mods_u,
                    0,
                    native,
                    0,
                    0,
                ));
            }
        }
    }

    /// Solid / CEF OSR is composited from dma-buf, not a Wayland surface under the cursor — forward moves to `cef_host`.
    pub(crate) fn shell_ipc_maybe_forward_pointer_move(&mut self, pos: Point<f64, Logical>) {
        if self.shell_ipc_conn.is_disconnected() || !self.shell_has_frame {
            return;
        }
        let route = self.shell_pointer_route_to_cef(pos);
        if !route && !self.shell_move_is_active() && !self.shell_resize_is_active() {
            return;
        }
        let Some((bx, by)) = self.shell_pointer_view_px(pos) else {
            return;
        };
        if self.shell_last_pointer_ipc_px == Some((bx, by)) {
            return;
        }
        self.shell_last_pointer_ipc_px = Some((bx, by));
        self.shell_ipc_try_write(&shell_wire::encode_compositor_pointer_move(
            bx,
            by,
            self.shell_cef_event_flags(),
        ));
    }

    /// Forward scroll / pointer axis to `cef_host` when the pointer is over the Solid shell (OSR).
    pub(crate) fn shell_ipc_maybe_forward_pointer_axis(&mut self, delta_x: i32, delta_y: i32) {
        if self.shell_ipc_conn.is_disconnected() || !self.shell_has_frame {
            return;
        }
        if delta_x == 0 && delta_y == 0 {
            return;
        }
        let pointer = self.seat.get_pointer().unwrap();
        let pos = pointer.current_location();
        let route = self.shell_pointer_route_to_cef(pos);
        if !route && !self.shell_move_is_active() && !self.shell_resize_is_active() {
            return;
        }
        let Some((bx, by)) = self.shell_pointer_view_px(pos) else {
            return;
        };
        self.shell_ipc_try_write(&shell_wire::encode_compositor_pointer_axis(
            bx,
            by,
            delta_x,
            delta_y,
            self.shell_cef_event_flags(),
        ));
    }

    /// Send compositor → `cef_host` message. No-op if shell IPC is disconnected.
    pub fn shell_ipc_try_write(&mut self, packet: &[u8]) {
        match &mut self.shell_ipc_conn {
            crate::shell_ipc::ShellIpcConn::Disconnected => {}
            crate::shell_ipc::ShellIpcConn::Unix(stream) => {
                if let Err(e) = stream.write_all(packet) {
                    tracing::warn!(?e, "shell ipc: write to client failed");
                    return;
                }
                if let Err(e) = stream.flush() {
                    tracing::warn!(?e, "shell ipc: flush failed");
                }
            }
            crate::shell_ipc::ShellIpcConn::Embedded { to_peer, .. } => {
                if to_peer.send(packet.to_vec()).is_err() {
                    tracing::warn!("shell ipc: embedded peer disconnected (tx)");
                    shell_ipc::disconnect_shell_client(self);
                }
            }
        }
    }

    /// Run `sh -c` with [`Self::socket_name`] as `WAYLAND_DISPLAY` (nested compositor clients).
    ///
    /// Disabled unless `DERP_ALLOW_SHELL_SPAWN=1` (trusted local shell IPC only).
    pub fn try_spawn_wayland_client_sh(&self, shell_command: &str) -> Result<(), String> {
        if std::env::var("DERP_ALLOW_SHELL_SPAWN").as_deref() != Ok("1") {
            return Err(
                "spawning from shell IPC requires DERP_ALLOW_SHELL_SPAWN=1 (trusted local connection)"
                    .into(),
            );
        }
        let trimmed = shell_command.trim();
        if trimmed.is_empty() {
            return Err("empty command".into());
        }
        if trimmed.len() > shell_wire::MAX_SPAWN_COMMAND_BYTES as usize {
            return Err("command too long".into());
        }
        let display = self.socket_name.to_string_lossy().into_owned();
        let runtime = std::env::var("XDG_RUNTIME_DIR").map_err(|_| "XDG_RUNTIME_DIR unset")?;
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(trimmed)
            .env("WAYLAND_DISPLAY", display)
            .env("XDG_RUNTIME_DIR", runtime)
            .stdin(Stdio::null());
        let child = cmd.spawn().map_err(|e| e.to_string())?;
        tracing::info!(pid = child.id(), "spawned Wayland client via shell IPC");
        Ok(())
    }
}

impl XWaylandShellHandler for CompositorState {
    fn xwayland_shell_state(&mut self) -> &mut XWaylandShellState {
        &mut self.xwayland_shell_state
    }

    fn surface_associated(&mut self, _xwm_id: XwmId, _surface: WlSurface, _window: X11Surface) {
        self.loop_signal.wakeup();
        self.needs_winit_redraw = true;
    }
}

impl XwmHandler for CompositorState {
    fn xwm_state(&mut self, xwm: XwmId) -> &mut X11Wm {
        let (id, wm) = self
            .x11_wm_slot
            .as_mut()
            .expect("X11 WM should exist while handling X11 events");
        assert_eq!(*id, xwm);
        wm
    }

    fn new_window(&mut self, _xwm: XwmId, _window: X11Surface) {}

    fn new_override_redirect_window(&mut self, _xwm: XwmId, _window: X11Surface) {}

    fn map_window_request(&mut self, _xwm: XwmId, window: X11Surface) {
        if window.is_override_redirect() {
            return;
        }
        if let Err(e) = window.set_mapped(true) {
            tracing::warn!(?e, "x11 map_window_request set_mapped");
            return;
        }
        let geo = window.geometry();
        self.space.map_element(
            DerpSpaceElem::X11(window.clone()),
            (geo.loc.x, geo.loc.y),
            false,
        );
        self.loop_signal.wakeup();
        self.needs_winit_redraw = true;
    }

    fn mapped_override_redirect_window(&mut self, _xwm: XwmId, window: X11Surface) {
        let geo = window.geometry();
        self.space.map_element(
            DerpSpaceElem::X11(window.clone()),
            (geo.loc.x, geo.loc.y),
            false,
        );
        self.loop_signal.wakeup();
        self.needs_winit_redraw = true;
    }

    fn unmapped_window(&mut self, _xwm: XwmId, window: X11Surface) {
        self.space.unmap_elem(&DerpSpaceElem::X11(window));
        self.needs_winit_redraw = true;
    }

    fn destroyed_window(&mut self, xwm: XwmId, window: X11Surface) {
        self.unmapped_window(xwm, window);
    }

    fn configure_request(
        &mut self,
        _xwm: XwmId,
        window: X11Surface,
        x: Option<i32>,
        y: Option<i32>,
        w: Option<u32>,
        h: Option<u32>,
        _reorder: Option<Reorder>,
    ) {
        let mut geo = window.geometry();
        if let Some(x) = x {
            geo.loc.x = x;
        }
        if let Some(y) = y {
            geo.loc.y = y;
        }
        if let Some(w) = w {
            geo.size.w = w as i32;
        }
        if let Some(h) = h {
            geo.size.h = h as i32;
        }
        if let Err(e) = window.configure(Some(geo)) {
            tracing::warn!(?e, "x11 configure_request");
        }
    }

    fn configure_notify(
        &mut self,
        _xwm: XwmId,
        window: X11Surface,
        geometry: Rectangle<i32, Logical>,
        _above: Option<X11Window>,
    ) {
        let elem = DerpSpaceElem::X11(window.clone());
        if self.space.elements().any(|e| *e == elem) {
            self.space
                .map_element(elem, (geometry.loc.x, geometry.loc.y), false);
            self.needs_winit_redraw = true;
        }
    }

    fn resize_request(
        &mut self,
        _xwm: XwmId,
        _window: X11Surface,
        _button: u32,
        _edges: ResizeEdge,
    ) {
    }

    fn move_request(&mut self, _xwm: XwmId, _window: X11Surface, _button: u32) {}

    fn disconnected(&mut self, _xwm: XwmId) {
        tracing::warn!("XWayland WM disconnected from X server");
        self.x11_wm_slot = None;
    }
}

impl XdgDecorationHandler for CompositorState {
    fn new_decoration(&mut self, toplevel: ToplevelSurface) {
        use smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode as XdgDecoMode;
        toplevel.with_pending_state(|state| {
            state.decoration_mode = Some(XdgDecoMode::ServerSide);
        });
        toplevel.send_configure();
    }

    fn request_mode(&mut self, toplevel: ToplevelSurface, _mode: smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode)
    {
        use smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode as XdgDecoMode;
        // Shell draws decorations (CEF); force SSD so clients like foot omit CSD.
        toplevel.with_pending_state(|state| {
            state.decoration_mode = Some(XdgDecoMode::ServerSide);
        });
        toplevel.send_configure();
    }

    fn unset_mode(&mut self, toplevel: ToplevelSurface) {
        use smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode as XdgDecoMode;
        toplevel.with_pending_state(|state| {
            state.decoration_mode = Some(XdgDecoMode::ServerSide);
        });
        toplevel.send_configure();
    }
}

impl FractionalScaleHandler for CompositorState {}

impl DmabufHandler for CompositorState {
    fn dmabuf_state(&mut self) -> &mut DmabufState {
        &mut self.dmabuf_state
    }

    fn dmabuf_imported(
        &mut self,
        _global: &DmabufGlobal,
        dmabuf: Dmabuf,
        notifier: ImportNotifier,
    ) {
        if let Some(weak) = self.dmabuf_import_renderer.as_ref() {
            if let Some(renderer_arc) = weak.upgrade() {
                match renderer_arc.lock() {
                    Ok(mut r) => match r.import_dmabuf(&dmabuf, None) {
                        Ok(_) => {
                            let _ = notifier.successful::<Self>();
                            return;
                        }
                        Err(e) => {
                            tracing::warn!(?e, "linux-dmabuf import rejected by GLES");
                            notifier.failed();
                            return;
                        }
                    },
                    Err(_) => {
                        notifier.failed();
                        return;
                    }
                }
            }
        }
        let _ = notifier.successful::<Self>();
    }
}

smithay::delegate_xdg_decoration!(CompositorState);
smithay::delegate_fractional_scale!(CompositorState);
smithay::delegate_cursor_shape!(CompositorState);
smithay::delegate_xwayland_shell!(CompositorState);
smithay::delegate_dmabuf!(CompositorState);

#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}
    fn disconnected(&self, _client_id: ClientId, _reason: DisconnectReason) {}
}
