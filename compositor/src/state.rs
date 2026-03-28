use std::{
    ffi::OsString,
    io::Write,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

use smithay::{
    backend::input::TouchSlot,
    backend::{
        renderer::element::memory::MemoryRenderBuffer,
        session::libseat::LibSeatSession,
    },
    desktop::{PopupManager, Space, Window, WindowSurfaceType},
    input::{Seat, SeatState},
    reexports::{
        calloop::{generic::Generic, EventLoop, Interest, LoopSignal, Mode, PostAction},
        wayland_server::{
            backend::{ClientData, ClientId, DisconnectReason},
            protocol::wl_surface::WlSurface,
            Display, DisplayHandle, Resource,
        },
    },
    utils::{Logical, Point, Size},
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
    },
};

use crate::{
    chrome_bridge::{ChromeEvent, NoOpChromeBridge, SharedChromeBridge},
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
/// Right side of titlebar reserved for shell controls (close); keep in sync with `shell` CSS.
pub const SHELL_TITLEBAR_CONTROLS_INSET: i32 = 40;
/// Border thickness around client for chrome hit-testing; keep in sync with `shell` CSS.
pub const SHELL_BORDER_THICKNESS: i32 = 4;

#[derive(Debug, Clone)]
pub enum SocketConfig {
    Auto,
    Fixed(String),
}

#[derive(Clone)]
pub struct CompositorInitOptions {
    pub socket: SocketConfig,
    pub seat_name: String,
    pub chrome_bridge: SharedChromeBridge,
    /// When set, listen on `XDG_RUNTIME_DIR`/name for shell pixel IPC ([`shell_wire`]).
    pub shell_ipc_socket: Option<String>,
    /// When set, each applied shell frame overwrites this file with JSON luminance stats (E2E tests).
    pub shell_e2e_status_path: Option<PathBuf>,
    /// When set, each applied shell frame overwrites this path with a PNG (BGRA → RGBA) for visual debugging / screenshot tests.
    pub shell_e2e_screenshot_path: Option<PathBuf>,
    /// If set while shell IPC is enabled, exit the compositor when `cef_host` sends nothing for this long (see `DERP_SHELL_WATCHDOG_SEC`).
    pub shell_ipc_stall_timeout: Option<Duration>,
}

impl Default for CompositorInitOptions {
    fn default() -> Self {
        Self {
            socket: SocketConfig::Auto,
            seat_name: "compositor".to_string(),
            chrome_bridge: Arc::new(NoOpChromeBridge),
            shell_ipc_socket: None,
            shell_e2e_status_path: None,
            shell_e2e_screenshot_path: None,
            shell_ipc_stall_timeout: None,
        }
    }
}

pub struct CompositorState {
    pub start_time: std::time::Instant,
    pub socket_name: OsString,
    pub display_handle: DisplayHandle,

    pub space: Space<Window>,
    pub loop_signal: LoopSignal,

    pub compositor_state: WlCompositorState,
    pub xdg_shell_state: XdgShellState,
    pub xdg_decoration_state: XdgDecorationState,
    pub fractional_scale_manager_state: FractionalScaleManagerState,
    pub cursor_shape_manager_state: CursorShapeManagerState,
    pub shm_state: ShmState,
    pub output_manager_state: OutputManagerState,
    pub seat_state: SeatState<CompositorState>,
    pub data_device_state: DataDeviceState,
    pub popups: PopupManager,

    pub seat: Seat<Self>,

    pub chrome_bridge: SharedChromeBridge,
    pub window_registry: WindowRegistry,

    pub shell_ipc_client: Option<UnixStream>,
    pub shell_read_buf: Vec<u8>,
    /// `XDG_RUNTIME_DIR` when shell IPC is enabled (for [`shell_wire::MSG_SHELL_SHM_REGION`] paths).
    pub shell_ipc_runtime_dir: Option<PathBuf>,
    pub(crate) shell_read_scratch: Vec<u8>,
    pub(crate) shell_shm: Option<crate::shell_shm::ShellShmMapping>,
    pub shell_memory_buffer: MemoryRenderBuffer,
    pub shell_has_frame: bool,
    /// Last OSR frame dimensions (buffer pixels) — maps nested pointer into the same space as the BGRA frame for [`shell_ipc_try_write`](Self::shell_ipc_try_write).
    pub shell_view_px: Option<(u32, u32)>,
    /// Winit [`Window::inner_size`](https://docs.rs/winit/latest/winit/window/struct.Window.html#method.inner_size) —
    /// same denominator the backend uses for pointer normalization ([`crate::winit`] updates on resize).
    pub(crate) shell_window_physical_px: (i32, i32),
    /// When true, [`smithay::backend::input::AbsolutePositionEvent`] `x`/`y` on touch are **window pixels**
    /// (Smithay winit). When false (DRM libinput), touch coords use libinput mm / [`position_transformed`].
    pub(crate) touch_abs_is_window_pixels: bool,
    /// Touch→pointer emulation: slot of the emulated finger (first finger only).
    pub(crate) touch_emulation_slot: Option<TouchSlot>,
    /// Latest pointer position as fraction of [`Self::shell_window_physical_px`] (0..1), window-local physical.
    pub(crate) shell_pointer_norm: Option<(f64, f64)>,
    /// Last client cursor from [`smithay::wayland::seat::SeatHandler::cursor_image`]; composited on DRM / nested swapchain.
    pub pointer_cursor_image: CursorImageStatus,
    /// Themed / system default pointer (`left_ptr`); also used for [`CursorImageStatus::Named`].
    pub(crate) cursor_fallback_buffer: MemoryRenderBuffer,
    /// Hotspot within [`Self::cursor_fallback_buffer`] (logical px).
    pub(crate) cursor_fallback_hotspot: (i32, i32),
    /// [`WindowRegistry`]-scoped id for shell-initiated move (`MSG_SHELL_MOVE_*`).
    shell_move_window_id: Option<u32>,
    shell_e2e_status_path: Option<PathBuf>,
    shell_e2e_screenshot_path: Option<PathBuf>,
    /// Drives nested winit repaints when Wayland clients commit or on first frame.
    pub(crate) needs_winit_redraw: bool,

    /// When [`Self::shell_ipc_stall_timeout`] is set: max gap without any shell→compositor message while connected.
    shell_ipc_stall_timeout: Option<Duration>,
    /// Last time a length-prefixed message was decoded from [`Self::shell_ipc_client`].
    shell_ipc_last_rx: Option<Instant>,

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
        let output_manager_state = OutputManagerState::new_with_xdg_output::<Self>(&dh);
        let mut seat_state = SeatState::new();
        let data_device_state = DataDeviceState::new::<Self>(&dh);
        let chrome_bridge = options.chrome_bridge;
        let shell_ipc_socket = options.shell_ipc_socket.clone();
        let shell_ipc_stall_timeout = options.shell_ipc_stall_timeout;
        let shell_e2e_status_path = options.shell_e2e_status_path.clone();
        let shell_e2e_screenshot_path = options.shell_e2e_screenshot_path.clone();
        let popups = PopupManager::default();
        let window_registry = WindowRegistry::new();
        let shell_memory_buffer = crate::shell_overlay::new_shell_memory_buffer();
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
            output_manager_state,
            seat_state,
            data_device_state,
            popups,
            seat,
            chrome_bridge,
            window_registry,
            shell_ipc_client: None,
            shell_read_buf: Vec::new(),
            shell_ipc_runtime_dir: None,
            shell_read_scratch: Vec::with_capacity(256 * 1024),
            shell_shm: None,
            shell_memory_buffer,
            shell_has_frame: false,
            shell_view_px: None,
            shell_window_physical_px: (1, 1),
            touch_abs_is_window_pixels: false,
            touch_emulation_slot: None,
            shell_pointer_norm: None,
            // Smithay only calls `cursor_image` when focus changes; motion with focus `None` and no
            // prior surface leaves this stale — `Hidden` meant zero composited cursor on the shell/CEF path.
            pointer_cursor_image: CursorImageStatus::default_named(),
            cursor_fallback_buffer,
            cursor_fallback_hotspot,
            shell_move_window_id: None,
            shell_e2e_status_path,
            shell_e2e_screenshot_path,
            needs_winit_redraw: true,
            shell_ipc_stall_timeout,
            shell_ipc_last_rx: None,
            vt_session: None,
        };

        if let Some(name) = shell_ipc_socket {
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
        for window in self.space.elements() {
            let surf = window.toplevel().unwrap().wl_surface();
            smithay::wayland::compositor::with_states(surf, |states| {
                smithay::wayland::fractional_scale::with_fractional_scale(states, |fs| {
                    fs.set_preferred_scale(scale);
                });
            });
        }
    }

    pub fn surface_under(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(WlSurface, Point<f64, Logical>)> {
        self.space
            .element_under(pos)
            .and_then(|(window, location)| {
                window
                    .surface_under(pos - location.to_f64(), WindowSurfaceType::ALL)
                    .map(|(s, p)| (s, (p + location).to_f64()))
            })
    }

    /// Updates [`WindowRegistry`] from current [`Space`] layout and notifies the bridge if geometry changed.
    pub fn notify_geometry_if_changed(&mut self, window: &Window) {
        let Some(toplevel) = window.toplevel() else {
            return;
        };
        let surface_id = toplevel.wl_surface().id().protocol_id();
        let Some(loc) = self.space.element_location(window) else {
            return;
        };
        let size = window.geometry().size;
        let changed = self
            .window_registry
            .set_geometry(surface_id, loc.x, loc.y, size.w, size.h);
        if let Some(true) = changed {
            if let Some(info) = self.window_registry.snapshot_for_surface(surface_id) {
                self.shell_emit_chrome_event(ChromeEvent::WindowGeometryChanged { info });
            }
        }
    }

    /// Notify [`ChromeBridge`] and push the same event on the shell IPC socket (if connected).
    pub fn shell_emit_chrome_event(&mut self, event: ChromeEvent) {
        if let Some(p) = crate::shell_encode::chrome_event_to_shell_packet(&event) {
            self.shell_ipc_try_write(&p);
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
        let pkt = shell_wire::encode_output_geometry(lw, lh);
        self.shell_ipc_try_write(&pkt);
    }

    /// Full sync when `cef_host` connects: output size, all mapped windows, current focus (IPC only).
    pub fn shell_on_shell_client_connected(&mut self) {
        self.shell_note_shell_ipc_rx();
        self.send_shell_output_geometry();
        for info in self.window_registry.all_infos() {
            if let Some(p) = shell_wire::encode_window_mapped(
                info.window_id,
                info.surface_id,
                info.x,
                info.y,
                info.width,
                info.height,
                &info.title,
                &info.app_id,
            ) {
                self.shell_ipc_try_write(&p);
            }
        }
        let (surface_id, window_id) = match self.seat.get_keyboard().and_then(|k| k.current_focus())
        {
            Some(surf) => {
                let sid = surf.id().protocol_id();
                let wid = self.window_registry.window_id_for_surface(sid);
                (Some(sid), wid)
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
        if self.shell_ipc_client.is_none() {
            return;
        }
        let Some(last) = self.shell_ipc_last_rx else {
            return;
        };
        if last.elapsed() <= limit {
            return;
        }
        tracing::warn!(
            timeout_secs = limit.as_secs(),
            "shell ipc: no message from cef_host within timeout; stopping compositor (stuck shell / JS or CEF not painting)"
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

    /// Titlebar strip for **drag** (excludes right control inset reserved for shell close button).
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

    /// Topmost window whose server-side titlebar drag region contains `pos`, if any.
    pub fn window_for_titlebar_drag_at(&self, pos: Point<f64, Logical>) -> Option<Window> {
        let px = pos.x;
        let py = pos.y;
        for window in self.space.elements().rev() {
            let loc = self.space.element_location(window)?;
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
        for window in self.space.elements().rev() {
            let Some(loc) = self.space.element_location(window) else {
                continue;
            };
            let geo = window.geometry();
            if self.shell_point_in_decoration_chrome(px, py, loc.x, loc.y, geo.size.w, geo.size.h) {
                return true;
            }
        }
        false
    }

    /// True if pointer should be injected into the CEF shell (desktop + decoration chrome), not the native client.
    ///
    /// Does **not** depend on whether a shell BGRA frame has arrived yet — without a frame we still pick output-normalized
    /// coordinates so the shell process can move the OSR cursor before the first paint.
    pub fn shell_pointer_route_to_cef(&self, pos: Point<f64, Logical>) -> bool {
        let px = pos.x;
        let py = pos.y;

        for window in self.space.elements().rev() {
            let Some(loc) = self.space.element_location(window) else {
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

    /// Map normalized pointer (`nx`, `ny`) to OSR buffer pixels for compositor → shell IPC.
    ///
    /// Prefers letterbox mapping when [`Self::shell_has_frame`] and buffer size are known; otherwise assumes buffer
    /// matches output logical size (1:1), which matches `MSG_OUTPUT_GEOMETRY` before the first paint.
    pub fn shell_pointer_buffer_pixels(&self, nx: f64, ny: f64) -> Option<(i32, i32)> {
        if let Some(xy) = self.shell_pointer_view_px_norm(nx, ny) {
            return Some(xy);
        }
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
        Some(
            if let Some((ox, oy, cw, ch)) = self.shell_letterbox_logical(output_geo.size) {
                let pw = cw.max(1) as f64;
                let ph = ch.max(1) as f64;
                (
                    ((local.x - ox as f64) / pw).clamp(0.0, 1.0),
                    ((local.y - oy as f64) / ph).clamp(0.0, 1.0),
                )
            } else {
                let gw = output_geo.size.w.max(1) as f64;
                let gh = output_geo.size.h.max(1) as f64;
                (
                    (local.x / gw).clamp(0.0, 1.0),
                    (local.y / gh).clamp(0.0, 1.0),
                )
            },
        )
    }

    pub fn find_window_by_surface_id(&self, surface_id: u32) -> Option<Window> {
        self.space
            .elements()
            .find(|w| {
                w.toplevel()
                    .map(|t| t.wl_surface().id().protocol_id() == surface_id)
                    .unwrap_or(false)
            })
            .cloned()
    }

    pub fn shell_move_begin(&mut self, window_id: u32) {
        if self
            .window_registry
            .surface_id_for_window(window_id)
            .is_none()
        {
            return;
        }
        self.shell_move_window_id = Some(window_id);
    }

    pub fn shell_move_delta(&mut self, dx: i32, dy: i32) {
        let Some(wid) = self.shell_move_window_id else {
            return;
        };
        let Some(sid) = self.window_registry.surface_id_for_window(wid) else {
            self.shell_move_window_id = None;
            return;
        };
        let Some(window) = self.find_window_by_surface_id(sid) else {
            self.shell_move_window_id = None;
            return;
        };
        let Some(loc) = self.space.element_location(&window) else {
            return;
        };
        self.space
            .map_element(window.clone(), (loc.x + dx, loc.y + dy), true);
        self.notify_geometry_if_changed(&window);
        self.needs_winit_redraw = true;
    }

    pub fn shell_move_end(&mut self, window_id: u32) {
        if self.shell_move_window_id == Some(window_id) {
            self.shell_move_window_id = None;
        }
    }

    /// Compositor → shell: full window list ([`shell_wire::MSG_WINDOW_LIST`]).
    pub fn shell_reply_window_list(&mut self) {
        let windows: Vec<shell_wire::ShellWindowSnapshot> = self
            .window_registry
            .all_infos()
            .into_iter()
            .map(|i| shell_wire::ShellWindowSnapshot {
                window_id: i.window_id,
                surface_id: i.surface_id,
                x: i.x,
                y: i.y,
                w: i.width,
                h: i.height,
                title: i.title,
                app_id: i.app_id,
            })
            .collect();
        if let Some(pkt) = shell_wire::encode_window_list(&windows) {
            self.shell_ipc_try_write(&pkt);
        }
    }

    pub fn shell_set_window_geometry(&mut self, window_id: u32, x: i32, y: i32, w: i32, h: i32) {
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
        self.space.map_element(window.clone(), (x, y), true);
        self.notify_geometry_if_changed(&window);
        self.needs_winit_redraw = true;
    }

    pub fn shell_close_window(&mut self, window_id: u32) {
        let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
            return;
        };
        let Some(window) = self.find_window_by_surface_id(sid) else {
            return;
        };
        window.toplevel().unwrap().send_close();
        self.needs_winit_redraw = true;
    }

    pub fn shell_set_window_fullscreen(&mut self, window_id: u32, enabled: bool) {
        use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;
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

    pub fn clear_shell_frame(&mut self) {
        self.shell_has_frame = false;
        self.shell_view_px = None;
        self.needs_winit_redraw = true;
    }

    /// Letterboxed shell in **output-local logical** pixels `(ox, oy, cw, ch)`.
    ///
    /// Matches [`AbsolutePositionEvent::position_transformed`] (logical) and the logical `size`
    /// passed to [`smithay::backend::renderer::element::memory::MemoryRenderBufferRenderElement::from_buffer`],
    /// so hit-testing and drawing use one coordinate space.
    pub(crate) fn shell_letterbox_logical(
        &self,
        output_logical_size: Size<i32, Logical>,
    ) -> Option<(i32, i32, i32, i32)> {
        if !self.shell_has_frame {
            return None;
        }
        let (buf_w, buf_h) = self.shell_view_px?;
        crate::shell_letterbox::letterbox_logical(output_logical_size, buf_w, buf_h)
    }

    /// Map normalized pointer (0..1) in letterboxed shell space into OSR buffer pixels.
    pub fn shell_pointer_view_px_norm(&self, nx: f64, ny: f64) -> Option<(i32, i32)> {
        if !self.shell_has_frame {
            return None;
        }
        let (vw, vh) = self.shell_view_px?;
        Some(crate::shell_letterbox::norm_to_buffer_px(nx, ny, vw, vh))
    }

    /// Fallback: map global **logical** seat position to OSR buffer pixels (e.g. button before motion).
    pub fn shell_pointer_view_px(&self, pos: Point<f64, Logical>) -> Option<(i32, i32)> {
        if !self.shell_has_frame {
            return None;
        }
        let (vw, vh) = self.shell_view_px?;
        let output = self.space.outputs().next()?;
        let geo = self.space.output_geometry(output)?;
        let (ox_l, oy_l, cw_l, ch_l) = self.shell_letterbox_logical(geo.size)?;
        let ox = geo.loc.x as f64 + ox_l as f64;
        let oy = geo.loc.y as f64 + oy_l as f64;
        let lx = pos.x - ox;
        let ly = pos.y - oy;
        crate::shell_letterbox::local_in_letterbox_to_buffer_px(lx, ly, cw_l, ch_l, vw, vh)
    }

    pub fn shell_overlay_has_pointer(&self, pos: Point<f64, Logical>) -> bool {
        self.shell_pointer_view_px(pos).is_some()
    }

    /// Send compositor → `cef_host` message (pointer routing). No-op if shell IPC is disconnected.
    pub fn shell_ipc_try_write(&mut self, packet: &[u8]) {
        if let Some(ref mut stream) = self.shell_ipc_client {
            // Shell client uses a **blocking** socket so the whole frame/packet is delivered or
            // fails atomically (no truncated length prefix).
            if let Err(e) = stream.write_all(packet) {
                tracing::warn!(?e, "shell ipc: write to client failed");
                return;
            }
            if let Err(e) = stream.flush() {
                tracing::warn!(?e, "shell ipc: flush failed");
            }
        }
    }

    /// Upload a BGRA8888 frame (`shell_wire` pixels) into [`Self::shell_memory_buffer`].
    pub fn apply_shell_frame_bgra(
        &mut self,
        width: u32,
        height: u32,
        stride: u32,
        pixels: &[u8],
    ) -> Result<(), &'static str> {
        let w = width as i32;
        let h = height as i32;
        if w <= 0 || h <= 0 {
            return Err("bad dimensions");
        }
        let need = (stride as usize)
            .checked_mul(h as usize)
            .ok_or("stride overflow")?;
        if pixels.len() < need {
            return Err("pixel buffer too small");
        }
        {
            let mut ctx = self.shell_memory_buffer.render();
            ctx.resize((w, h));
            ctx.draw(|mem| {
                let row = w as usize * 4;
                if stride as usize == row {
                    mem[..need].copy_from_slice(&pixels[..need]);
                } else {
                    for y in 0..h as usize {
                        let src_off = y * stride as usize;
                        let dst_off = y * row;
                        mem[dst_off..dst_off + row]
                            .copy_from_slice(&pixels[src_off..src_off + row]);
                    }
                }
                Ok(vec![smithay::utils::Rectangle::from_size(
                    smithay::utils::Size::from((w, h)),
                )])
            })
            .map_err(|_: ()| "memory buffer draw")?;
        }
        self.shell_has_frame = true;
        self.shell_view_px = Some((width, height));
        self.needs_winit_redraw = true;
        if let Some(ref path) = self.shell_e2e_status_path {
            write_shell_e2e_frame_status(path, w, h, stride, pixels);
        }
        if let Some(ref path) = self.shell_e2e_screenshot_path {
            write_shell_e2e_screenshot_png(path, w, h, stride, pixels);
        }
        tracing::trace!(
            target: "shell_ipc",
            width,
            height,
            stride,
            frame_bytes = pixels.len(),
            "apply_shell_frame_bgra"
        );
        Ok(())
    }

    /// Run `sh -c` with [`Self::socket_name`] as `WAYLAND_DISPLAY` (nested compositor clients).
    ///
    /// Disabled unless `DERP_ALLOW_SHELL_SPAWN=1` (trusted local shell IPC only).
    #[cfg(unix)]
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

    #[cfg(not(unix))]
    pub fn try_spawn_wayland_client_sh(&self, _shell_command: &str) -> Result<(), String> {
        Err("shell IPC spawn is only supported on Unix".into())
    }
}

/// BT.709 luma for BGRA samples (B, G, R channels).
fn shell_sample_luma(b: u8, g: u8, r: u8) -> f32 {
    // BT.709 luma (B, G, R order for BGRA).
    0.0722 * b as f32 + 0.7152 * g as f32 + 0.2126 * r as f32
}

fn write_shell_e2e_frame_status(path: &Path, w: i32, h: i32, stride: u32, pixels: &[u8]) {
    let wu = w as usize;
    let hu = h as usize;
    let stride = stride as usize;
    if wu == 0 || hu == 0 {
        return;
    }
    let sample_coords = [
        (0usize, 0usize),
        (wu.saturating_sub(1), 0),
        (0, hu.saturating_sub(1)),
        (wu.saturating_sub(1), hu.saturating_sub(1)),
        (wu / 2, hu / 2),
    ];
    let mut lumas = Vec::new();
    for (x, y) in sample_coords {
        let o = y.saturating_mul(stride).saturating_add(x.saturating_mul(4));
        if o + 3 < pixels.len() {
            lumas.push(shell_sample_luma(pixels[o], pixels[o + 1], pixels[o + 2]));
        }
    }
    if lumas.is_empty() {
        return;
    }
    let min_l = lumas.iter().copied().fold(f32::MAX, f32::min);
    let max_l = lumas.iter().copied().fold(f32::MIN, f32::max);
    let spread = max_l - min_l;
    // Lowercase JSON numbers for easy parsing in tests.
    let json = format!(
        r#"{{"width":{w},"height":{h},"min_luma":{min_l},"max_luma":{max_l},"spread":{spread},"has_frame":true}}"#,
        w = w,
        h = h,
        min_l = min_l,
        max_l = max_l,
        spread = spread,
    );
    if let Err(e) = std::fs::write(path, json) {
        tracing::warn!(?e, path = ?path, "shell e2e: failed to write status file");
    }
}

/// Encode the latest shell frame as PNG (BGRA input) for E2E / manual inspection.
fn write_shell_e2e_screenshot_png(path: &Path, w: i32, h: i32, stride: u32, pixels: &[u8]) {
    let wu = w as u32;
    let hu = h as u32;
    if wu == 0 || hu == 0 {
        return;
    }
    let stride = stride as usize;
    let row_bytes = wu as usize * 4;
    let mut rgba = vec![0u8; row_bytes * hu as usize];
    for y in 0..hu as usize {
        let src_row = y * stride;
        let dst_row = y * row_bytes;
        for x in 0..wu as usize {
            let s = src_row + x * 4;
            let d = dst_row + x * 4;
            if s + 3 >= pixels.len() || d + 3 >= rgba.len() {
                continue;
            }
            rgba[d] = pixels[s + 2];
            rgba[d + 1] = pixels[s + 1];
            rgba[d + 2] = pixels[s];
            rgba[d + 3] = pixels[s + 3];
        }
    }
    let Some(img) = image::RgbaImage::from_raw(wu, hu, rgba) else {
        tracing::warn!(path = ?path, "shell e2e: screenshot dimensions mismatch buffer");
        return;
    };
    let tmp_path = path.with_extension("tmp.png");
    if let Err(e) = img.save(&tmp_path) {
        tracing::warn!(?e, path = ?tmp_path, "shell e2e: png encode failed");
        return;
    }
    if let Err(e) = std::fs::rename(&tmp_path, path) {
        tracing::warn!(?e, dst = ?path, "shell e2e: failed to finalize screenshot png");
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

smithay::delegate_xdg_decoration!(CompositorState);
smithay::delegate_fractional_scale!(CompositorState);
smithay::delegate_cursor_shape!(CompositorState);

#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}
    fn disconnected(&self, _client_id: ClientId, _reason: DisconnectReason) {}
}
