use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    os::fd::OwnedFd,
    path::PathBuf,
    process::Stdio,
    sync::{atomic::AtomicBool, Arc, Mutex, Weak},
    time::{Duration, Instant},
};

use smithay::{
    backend::allocator::dmabuf::{Dmabuf, DmabufFlags},
    backend::allocator::{Format, Fourcc, Modifier},
    backend::input::{KeyState, TouchSlot},
    backend::renderer::{
        gles::GlesRenderer,
        utils::CommitCounter,
        ImportDma,
    },
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
        calloop::{
            channel::{self, Event as CalloopChannelEvent},
            generic::Generic,
            EventLoop,
            Interest,
            LoopSignal,
            Mode,
            PostAction,
        },
        wayland_server::{
            backend::{ClientData, ClientId, DisconnectReason, ObjectId},
            protocol::{wl_output::WlOutput, wl_surface::WlSurface},
            Display, DisplayHandle,
        },
        wayland_protocols::xdg::shell::server::xdg_toplevel,
    },
    utils::{Buffer, Logical, Point, Rectangle, Size, Transform, SERIAL_COUNTER},
    wayland::{
        compositor::{CompositorClientState, CompositorState as WlCompositorState},
        cursor_shape::CursorShapeManagerState,
        fractional_scale::{FractionalScaleHandler, FractionalScaleManagerState},
        output::OutputManagerState,
        selection::data_device::DataDeviceState,
        shell::xdg::{
            decoration::{XdgDecorationHandler, XdgDecorationState},
            ToplevelSurface, XdgShellState, XdgToplevelSurfaceData,
        },
        viewporter::ViewporterState,
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
use smithay::output::{Output, Scale};
use smithay::reexports::wayland_server::Resource;

use crate::{
    chrome_bridge::{ChromeEvent, NoOpChromeBridge, SharedChromeBridge, WindowInfo},
    derp_space::DerpSpaceElem,
    exclusion_clip,
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

/// Current maximize/fullscreen flags from the compositor’s xdg pending/current state.
pub(crate) fn transform_from_wire(t: u32) -> Transform {
    match t {
        1 => Transform::_90,
        2 => Transform::_180,
        3 => Transform::_270,
        4 => Transform::Flipped,
        5 => Transform::Flipped90,
        6 => Transform::Flipped180,
        7 => Transform::Flipped270,
        _ => Transform::Normal,
    }
}

pub(crate) fn transform_to_wire(t: Transform) -> u32 {
    match t {
        Transform::Normal => 0,
        Transform::_90 => 1,
        Transform::_180 => 2,
        Transform::_270 => 3,
        Transform::Flipped => 4,
        Transform::Flipped90 => 5,
        Transform::Flipped180 => 6,
        Transform::Flipped270 => 7,
    }
}

pub(crate) fn toplevel_should_defer_initial_map(
    parent: Option<&WlSurface>,
    _title: &str,
    app_id: &str,
    is_embedded_shell_host: bool,
) -> bool {
    if is_embedded_shell_host || parent.is_some() {
        return false;
    }
    app_id.trim().is_empty()
}

pub(crate) fn shell_window_row_should_show(info: &WindowInfo) -> bool {
    !info.app_id.trim().is_empty()
}

#[derive(Debug)]
pub(crate) struct PendingDeferredToplevel {
    pub window: Window,
    pub map_x: i32,
    pub map_y: i32,
}

pub(crate) fn read_toplevel_tiling(wl: &WlSurface) -> (bool, bool) {
    smithay::wayland::compositor::with_states(wl, |states| {
        let data = states
            .data_map
            .get::<XdgToplevelSurfaceData>()
            .unwrap()
            .lock()
            .unwrap();
        let st = data.current_server_state();
        (
            st.states.contains(xdg_toplevel::State::Maximized),
            st.states.contains(xdg_toplevel::State::Fullscreen),
        )
    })
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
    pub shell_to_cef: Arc<Mutex<Option<Arc<crate::cef::ShellToCefLink>>>>,
    pub shell_cef_handshake: Option<Arc<AtomicBool>>,
    pub shell_ipc_stall_timeout: Option<Duration>,
}

impl Default for CompositorInitOptions {
    fn default() -> Self {
        Self {
            socket: SocketConfig::Auto,
            seat_name: "compositor".to_string(),
            chrome_bridge: Arc::new(NoOpChromeBridge),
            shell_to_cef: Arc::new(Mutex::new(None)),
            shell_cef_handshake: None,
            shell_ipc_stall_timeout: None,
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
    pub viewporter_state: ViewporterState,
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
    pub(crate) pending_deferred_toplevels: HashMap<(ClientId, u32), PendingDeferredToplevel>,

    pub shell_to_cef: Arc<Mutex<Option<Arc<crate::cef::ShellToCefLink>>>>,
    pub cef_to_compositor_tx: channel::Sender<crate::cef::compositor_tx::CefToCompositor>,
    pub shell_cef_handshake: Option<Arc<AtomicBool>>,
    pub(crate) shell_ipc_peer_pid: Option<i32>,
    shell_embedded_initial_handshake_done: bool,
    pub shell_ipc_runtime_dir: Option<PathBuf>,
    /// Winit [`Window::inner_size`](https://docs.rs/winit/latest/winit/window/struct.Window.html#method-inner_size) —
    /// same denominator the backend uses for pointer normalization ([`crate::winit`] updates on resize).
    pub(crate) shell_window_physical_px: (i32, i32),
    pub(crate) shell_canvas_logical_origin: (i32, i32),
    pub(crate) shell_canvas_logical_size: (u32, u32),
    pub(crate) shell_ui_scale: f64,
    pub(crate) shell_primary_output_name: Option<String>,
    pub(crate) display_config_save_pending: bool,
    pub(crate) display_config_save_suppressed: bool,
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
    wp_fractional_scale_surface_ids: HashSet<ObjectId>,
    pending_fractional_child_windows: HashSet<u32>,

    /// When [`Self::shell_ipc_stall_timeout`] is set: max gap without any shell→compositor message while connected.
    shell_ipc_stall_timeout: Option<Duration>,
    /// Last time a length-prefixed message was decoded from the shell peer.
    shell_ipc_last_rx: Option<Instant>,
    /// Last [`shell_wire::encode_compositor_ping`] sent (throttle while waiting for [`shell_wire::MSG_SHELL_PONG`]).
    pub(crate) shell_ipc_last_compositor_ping: Option<Instant>,
    pub shell_has_frame: bool,
    pub shell_view_px: Option<(u32, u32)>,
    pub shell_frame_is_dmabuf: bool,
    pub shell_dmabuf: Option<Dmabuf>,
    pub(crate) shell_dmabuf_overlay_id: Id,
    pub(crate) shell_dmabuf_commit: CommitCounter,
    pub(crate) shell_dmabuf_dirty_buffer: Vec<Rectangle<i32, Buffer>>,
    pub(crate) shell_dmabuf_dirty_force_full: bool,

    /// DRM only: used so **Ctrl+Alt+F1–F12** can switch virtual terminals via libseat (kernel shortcuts do not apply while we hold the input session).
    pub(crate) vt_session: Option<LibSeatSession>,

    /// Pre-maximize / pre-fullscreen **floating** geometry for [`Self::toplevel_restore_floating`].
    pub(crate) toplevel_floating_restore: HashMap<u32, (i32, i32, i32, i32)>,
    /// After [`xdg_toplevel::Request::UnsetFullscreen`], restore maximized layout instead of floating.
    pub(crate) toplevel_fullscreen_return_maximized: HashSet<u32>,
    /// When true, render OSR shell above native Wayland windows (HTML5 / presentation fullscreen).
    pub shell_presentation_fullscreen: bool,
    pub(crate) shell_exclusion_zones: Vec<Rectangle<i32, Logical>>,
    pub(crate) shell_exclusion_zones_need_full_damage: bool,
    pub(crate) shell_context_menu_atlas_buffer_h: u32,
    pub(crate) shell_context_menu_overlay_id: Id,
    pub(crate) shell_context_menu: Option<ShellContextMenuPlacement>,
}


#[derive(Debug, Clone)]
pub struct ShellContextMenuPlacement {
    pub buffer_rect: Rectangle<i32, Buffer>,
    pub global_rect: Rectangle<i32, Logical>,
}

impl CompositorState {
    pub fn shell_context_menu_atlas_px() -> u32 {
        std::env::var("DERP_SHELL_CONTEXT_MENU_ATLAS_PX")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1536u32)
            .max(256)
            .min(16384)
    }
    pub fn new(
        event_loop: &mut EventLoop<CalloopData>,
        display: Display<Self>,
        options: CompositorInitOptions,
    ) -> Self {
        let start_time = std::time::Instant::now();

        let dh = display.handle();

        let compositor_state = WlCompositorState::new_v6::<Self>(&dh);
        let xdg_shell_state = XdgShellState::new::<Self>(&dh);
        let xdg_decoration_state = XdgDecorationState::new::<Self>(&dh);
        let fractional_scale_manager_state = FractionalScaleManagerState::new::<Self>(&dh);
        let viewporter_state = ViewporterState::new::<Self>(&dh);
        let cursor_shape_manager_state = CursorShapeManagerState::new::<Self>(&dh);
        let shm_state = ShmState::new::<Self>(&dh, vec![]);
        let dmabuf_state = DmabufState::new();
        let output_manager_state = OutputManagerState::new_with_xdg_output::<Self>(&dh);
        let mut seat_state = SeatState::new();
        let data_device_state = DataDeviceState::new::<Self>(&dh);
        let xwayland_shell_state = XWaylandShellState::new::<Self>(&dh);
        let chrome_bridge = options.chrome_bridge;
        let shell_to_cef = options.shell_to_cef;
        let shell_cef_handshake = options.shell_cef_handshake;
        let shell_ipc_stall_timeout = options.shell_ipc_stall_timeout;
        let popups = PopupManager::default();
        let window_registry = WindowRegistry::new();
        let (cursor_fallback_buffer, cursor_fallback_hotspot) = crate::cursor_fallback::load_cursor_fallback();

        let mut seat: Seat<Self> = seat_state.new_wl_seat(&dh, &options.seat_name);
        seat.add_keyboard(Default::default(), 200, 25).unwrap();
        seat.add_pointer();

        let space = Space::default();

        let socket_name = Self::init_wayland_listener(display, event_loop, &options.socket);

        let loop_signal = event_loop.get_signal();

        let (cef_to_compositor_tx, cef_rx) = channel::channel();
        event_loop
            .handle()
            .insert_source(cef_rx, |ev, _, d: &mut CalloopData| {
                match ev {
                    CalloopChannelEvent::Msg(crate::cef::compositor_tx::CefToCompositor::ShellRxNote) => {
                        d.state.shell_note_shell_ipc_rx();
                    }
                    CalloopChannelEvent::Msg(crate::cef::compositor_tx::CefToCompositor::Dmabuf {
                        width,
                        height,
                        drm_format,
                        modifier,
                        flags,
                        generation,
                        planes,
                        fds,
                        dirty_buffer,
                    }) => {
                        d.state.accept_shell_dmabuf_from_cef(
                            width,
                            height,
                            drm_format,
                            modifier,
                            flags,
                            generation,
                            &planes,
                            fds,
                            dirty_buffer,
                        );
                    }
                    CalloopChannelEvent::Msg(crate::cef::compositor_tx::CefToCompositor::Run(f)) => {
                        f(&mut d.state);
                    }
                    CalloopChannelEvent::Closed => {}
                }
            })
            .expect("cef from-shell channel");

        let s = Self {
            start_time,
            display_handle: dh,
            space,
            loop_signal,
            socket_name,
            compositor_state,
            xdg_shell_state,
            xdg_decoration_state,
            fractional_scale_manager_state,
            viewporter_state,
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
            pending_deferred_toplevels: HashMap::new(),
            shell_to_cef,
            cef_to_compositor_tx,
            shell_cef_handshake,
            shell_ipc_peer_pid: None,
            shell_embedded_initial_handshake_done: false,
            shell_ipc_runtime_dir: std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from),
            shell_window_physical_px: (1, 1),
            shell_canvas_logical_origin: (0, 0),
            shell_canvas_logical_size: (1, 1),
            shell_ui_scale: 1.5,
            shell_primary_output_name: None,
            display_config_save_pending: false,
            display_config_save_suppressed: false,
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
            wp_fractional_scale_surface_ids: HashSet::new(),
            pending_fractional_child_windows: HashSet::new(),
            shell_ipc_stall_timeout,
            shell_ipc_last_rx: None,
            shell_ipc_last_compositor_ping: None,
            shell_has_frame: false,
            shell_view_px: None,
            shell_frame_is_dmabuf: false,
            shell_dmabuf: None,
            shell_dmabuf_overlay_id: Id::new(),
            shell_dmabuf_commit: CommitCounter::default(),
            shell_dmabuf_dirty_buffer: Vec::new(),
            shell_dmabuf_dirty_force_full: true,
            vt_session: None,
            toplevel_floating_restore: HashMap::new(),
            toplevel_fullscreen_return_maximized: HashSet::new(),
            shell_presentation_fullscreen: false,
            shell_exclusion_zones: Vec::new(),
            shell_exclusion_zones_need_full_damage: false,
            shell_context_menu_atlas_buffer_h: 0,
            shell_context_menu_overlay_id: Id::new(),
            shell_context_menu: None,
        };

        s
    }

    pub(crate) fn point_in_shell_exclusion_zones(&self, pos: Point<f64, Logical>) -> bool {
        let px = pos.x;
        let py = pos.y;
        if self.shell_exclusion_zones.is_empty() {
            return false;
        }
        for r in &self.shell_exclusion_zones {
            let x1 = r.loc.x as f64;
            let y1 = r.loc.y as f64;
            let x2 = x1 + r.size.w.max(0) as f64;
            let y2 = y1 + r.size.h.max(0) as f64;
            if px >= x1 && px < x2 && py >= y1 && py < y2 {
                return true;
            }
        }
        false
    }

    pub(crate) fn native_hit_blocked_by_shell_exclusion(
        &self,
        _elem: &DerpSpaceElem,
        pos: Point<f64, Logical>,
    ) -> bool {
        self.point_in_shell_exclusion_zones(pos)
    }

    pub fn apply_shell_exclusion_zones_json(&mut self, json: &str) {
        pub const MAX_SHELL_EXCLUSION_ZONES: usize = 64;
        #[derive(serde::Deserialize)]
        struct EzRect {
            x: i32,
            y: i32,
            w: i32,
            h: i32,
        }
        #[derive(serde::Deserialize)]
        struct EzRoot {
            #[serde(default)]
            rects: Vec<EzRect>,
        }
        let Ok(root) = serde_json::from_str::<EzRoot>(json) else {
            return;
        };
        let Some(ws) = self.workspace_logical_bounds() else {
            self.shell_exclusion_zones.clear();
            self.shell_exclusion_zones_need_full_damage = true;
            self.shell_dmabuf_dirty_force_full = true;
            return;
        };
        let mut next: Vec<Rectangle<i32, Logical>> = Vec::new();
        for e in root.rects.into_iter().take(MAX_SHELL_EXCLUSION_ZONES) {
            let w = e.w.max(1);
            let h = e.h.max(1);
            let r = Rectangle::new(
                Point::<i32, Logical>::from((e.x, e.y)),
                Size::<i32, Logical>::from((w, h)),
            );
            if let Some(clamped) = r.intersection(ws) {
                next.push(clamped);
            }
        }
        let changed = next != self.shell_exclusion_zones;
        self.shell_exclusion_zones = next;
        if changed {
            self.shell_exclusion_zones_need_full_damage = true;
            self.shell_dmabuf_dirty_force_full = true;
        }
    }

    pub(crate) fn shell_exclusion_clip_ctx(
        &self,
        output: &Output,
    ) -> Option<Arc<exclusion_clip::ShellExclusionClipCtx>> {
        if self.shell_exclusion_zones.is_empty() {
            return None;
        }
        let Some(out_geo) = self.space.output_geometry(output) else {
            return None;
        };
        let Some(ws) = self.workspace_logical_bounds() else {
            return None;
        };
        let zones: Vec<Rectangle<i32, Logical>> = self
            .shell_exclusion_zones
            .iter()
            .filter_map(|z| z.intersection(ws))
            .collect();
        if zones.is_empty() {
            return None;
        }
        Some(Arc::new(exclusion_clip::ShellExclusionClipCtx {
            zones: Arc::from(zones.into_boxed_slice()),
            output_logical: Rectangle::new(out_geo.loc, out_geo.size),
            scale_f: output.current_scale().fractional_scale(),
        }))
    }

    pub(crate) fn shell_cef_active(&self) -> bool {
        self.shell_to_cef.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub(crate) fn shell_send_to_cef(&self, msg: shell_wire::DecodedCompositorToShellMessage) {
        let Ok(g) = self.shell_to_cef.lock() else {
            return;
        };
        if let Some(link) = g.as_ref() {
            link.send(msg);
        }
    }

    pub(crate) fn accept_shell_dmabuf_from_cef(
        &mut self,
        width: u32,
        height: u32,
        drm_format: u32,
        modifier: u64,
        flags: u32,
        _generation: u32,
        planes: &[shell_wire::FrameDmabufPlane],
        mut fds: Vec<OwnedFd>,
        dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
    ) {
        self.shell_note_shell_ipc_rx();
        if width == 0 || height == 0 || planes.is_empty() || planes.len() != fds.len() {
            fds.clear();
            return;
        }
        match self.apply_shell_frame_dmabuf(
            width,
            height,
            drm_format,
            modifier,
            flags,
            planes,
            &mut fds,
            dirty_buffer,
        ) {
            Ok(()) => {
                shell_ipc::log_first_shell_dmabuf(
                    width,
                    height,
                    drm_format,
                    modifier,
                    planes.len(),
                );
            }
            Err(e) => tracing::warn!(?e, "shell: dma-buf frame rejected"),
        }
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
        tracing::debug!("linux-dmabuf global created (native client buffers)");
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

    pub(crate) fn fractional_scale_for_space_element(&self, elem: &DerpSpaceElem) -> f64 {
        let fallback = || {
            self.space
                .outputs()
                .map(|o| o.current_scale().fractional_scale())
                .fold(1.0f64, f64::max)
        };
        let Some(bbox) = self.space.element_bbox(elem) else {
            return fallback();
        };
        if bbox.size.w == 0 || bbox.size.h == 0 {
            return fallback();
        }
        let cx = bbox.loc.x + bbox.size.w / 2;
        let cy = bbox.loc.y + bbox.size.h / 2;
        self.output_containing_global_point(Point::from((cx as f64, cy as f64)))
            .map(|o| o.current_scale().fractional_scale())
            .unwrap_or_else(fallback)
    }

    pub(crate) fn wayland_window_containing_surface(&self, surface: &WlSurface) -> Option<Window> {
        let mut root = surface.clone();
        while let Some(p) = smithay::wayland::compositor::get_parent(&root) {
            root = p;
        }
        self.space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                w.toplevel()
                    .is_some_and(|t| t.wl_surface() == &root)
                    .then_some(w.clone())
            } else {
                None
            }
        })
    }

    pub(crate) fn refresh_fractional_scale_for_wayland_window(&mut self, window: &Window) {
        let scale =
            self.fractional_scale_for_space_element(&DerpSpaceElem::Wayland(window.clone()));
        let Some(tl) = window.toplevel() else {
            return;
        };
        let surf = tl.wl_surface();
        smithay::wayland::compositor::with_states(surf, |states| {
            smithay::wayland::fractional_scale::with_fractional_scale(states, |fs| {
                fs.set_preferred_scale(scale);
            });
        });
    }

    fn schedule_fractional_children_refresh(&mut self, window: &Window) {
        let Some(tl) = window.toplevel() else {
            return;
        };
        let Some(wid) = self.window_registry.window_id_for_wl_surface(tl.wl_surface()) else {
            return;
        };
        self.pending_fractional_child_windows.insert(wid);
    }

    pub(crate) fn flush_pending_fractional_child_scales(&mut self) {
        if self.pending_fractional_child_windows.is_empty() {
            return;
        }
        let ids: Vec<u32> = self.pending_fractional_child_windows.drain().collect();
        for window_id in ids {
            let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
                continue;
            };
            let Some(window) = self.find_window_by_surface_id(sid) else {
                continue;
            };
            let scale =
                self.fractional_scale_for_space_element(&DerpSpaceElem::Wayland(window.clone()));
            let Some(tl) = window.toplevel() else {
                continue;
            };
            let tl_surf = tl.wl_surface().clone();
            window.with_surfaces(|surface, _| {
                if *surface == tl_surf {
                    return;
                }
                smithay::wayland::compositor::with_states(surface, |states| {
                    smithay::wayland::fractional_scale::with_fractional_scale(states, |fs| {
                        fs.set_preferred_scale(scale);
                    });
                });
            });
        }
    }

    pub(crate) fn refresh_all_surface_fractional_scales(&mut self) {
        let windows: Vec<Window> = self
            .space
            .elements()
            .filter_map(|e| {
                if let DerpSpaceElem::Wayland(w) = e {
                    Some(w.clone())
                } else {
                    None
                }
            })
            .collect();
        for window in windows {
            self.refresh_fractional_scale_for_wayland_window(&window);
            if Self::wayland_window_has_client_side_decoration(&window) {
                self.schedule_fractional_children_refresh(&window);
            }
        }
    }

    pub(crate) fn on_wl_surface_destroyed(&mut self, surface: &WlSurface) {
        self.wp_fractional_scale_surface_ids.remove(&surface.id());
    }

    pub(crate) fn sync_preferred_buffer_scales(&self) {
        use smithay::wayland::compositor::send_surface_state;

        let frac_shell = self.shell_ui_scale.fract().abs() > f64::EPSILON;
        for elem in self.space.elements() {
            let DerpSpaceElem::Wayland(window) = elem else {
                continue;
            };
            if window.toplevel().is_none() {
                continue;
            }
            let outs = self.space.outputs_for_element(elem);
            let mut tf = Transform::Normal;
            if outs.is_empty() {
                if let Some(o) = self.leftmost_output() {
                    tf = o.current_transform();
                }
            } else {
                let mut best_s = 0.0f64;
                for o in outs {
                    let s = o.current_scale().fractional_scale();
                    if s > best_s {
                        best_s = s;
                        tf = o.current_transform();
                    }
                }
            }
            let ceil_pref = self.shell_ui_scale.ceil() as i32;
            let round_pref = self.shell_ui_scale.round() as i32;
            window.with_surfaces(|surface, data| {
                let uses_wp_frac = self
                    .wp_fractional_scale_surface_ids
                    .contains(&surface.id());
                let pref = if frac_shell && uses_wp_frac {
                    1
                } else if frac_shell {
                    ceil_pref
                } else {
                    round_pref
                }
                .max(1);
                send_surface_state(surface, data, pref, tf);
            });
        }
    }

    pub fn surface_under(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(WlSurface, Point<f64, Logical>)> {
        for elem in self.space.elements().rev() {
            let Some(map_loc) = self.space.element_location(elem) else {
                continue;
            };
            let render_loc = map_loc - elem.geometry().loc;
            let local = pos - render_loc.to_f64();
            let hit = match elem {
                DerpSpaceElem::Wayland(window) => window
                    .surface_under(local, WindowSurfaceType::ALL)
                    .map(|(s, p)| (s, (p + render_loc).to_f64())),
                DerpSpaceElem::X11(x11) => {
                    let surf = x11.wl_surface()?;
                    under_from_surface_tree(&surf, local, (0, 0), WindowSurfaceType::ALL)
                        .map(|(s, p)| (s, (p + render_loc).to_f64()))
                }
            };
            let Some((surf, p_global)) = hit else {
                continue;
            };
            if self.native_hit_blocked_by_shell_exclusion(elem, pos) {
                continue;
            }
            return Some((surf, p_global));
        }
        None
    }

    pub fn element_under_respecting_shell_exclusions(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(DerpSpaceElem, Point<i32, Logical>)> {
        for elem in self.space.elements().rev() {
            let Some(map_loc) = self.space.element_location(elem) else {
                continue;
            };
            if self.native_hit_blocked_by_shell_exclusion(elem, pos) {
                continue;
            }
            let render_loc = map_loc - elem.geometry().loc;
            let local = pos - render_loc.to_f64();
            let hit = match elem {
                DerpSpaceElem::Wayland(window) => {
                    window.surface_under(local, WindowSurfaceType::ALL).is_some()
                }
                DerpSpaceElem::X11(x11) => x11.wl_surface().is_some_and(|surf| {
                    under_from_surface_tree(&surf, local, (0, 0), WindowSurfaceType::ALL).is_some()
                }),
            };
            if !hit {
                continue;
            }
            return Some((elem.clone(), map_loc));
        }
        None
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

        let Some(geo) = self.workspace_logical_bounds() else {
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

    pub(crate) fn shell_effective_primary_output(&self) -> Option<Output> {
        if let Some(ref name) = self.shell_primary_output_name {
            if let Some(o) = self
                .space
                .outputs()
                .find(|o| o.name() == name.as_str())
                .cloned()
            {
                return Some(o);
            }
        }
        self.leftmost_output()
    }

    pub(crate) fn primary_output_logical_origin(&self) -> (i32, i32) {
        let Some(output) = self.shell_effective_primary_output() else {
            return (0, 0);
        };
        let Some(geo) = self.space.output_geometry(&output) else {
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

    pub(crate) fn xdg_sync_pending_deferred_toplevel(&mut self, root: &WlSurface) {
        let Some(key) = crate::window_registry::wl_surface_key(root) else {
            return;
        };
        if !self.pending_deferred_toplevels.contains_key(&key) {
            return;
        }
        let reg_win_id = self.window_registry.window_id_for_wl_surface(root);
        tracing::warn!(
            target: "derp_toplevel",
            wl_surface_protocol_id = root.id().protocol_id(),
            window_id = ?reg_win_id,
            "xdg sync deferred toplevel entry"
        );
        {
            let pending = self
                .pending_deferred_toplevels
                .get_mut(&key)
                .expect("checked");
            pending.window.on_commit();
        }
        let initial_configure_sent = smithay::wayland::compositor::with_states(root, |states| {
            states
                .data_map
                .get::<XdgToplevelSurfaceData>()
                .unwrap()
                .lock()
                .unwrap()
                .initial_configure_sent
        });
        if !initial_configure_sent {
            let pending = self
                .pending_deferred_toplevels
                .get(&key)
                .expect("checked");
            if let Some(tl) = pending.window.toplevel() {
                tl.send_configure();
            }
        }
        let (has_identity, title, app_id) = {
            let pending = self
                .pending_deferred_toplevels
                .get(&key)
                .expect("checked");
            let bbox = pending.window.bbox();
            let has_buffer_extent = bbox.size.w >= 1 && bbox.size.h >= 1;
            let (title, app_id) = smithay::wayland::compositor::with_states(root, |states| {
                let attrs = states
                    .data_map
                    .get::<XdgToplevelSurfaceData>()
                    .unwrap()
                    .lock()
                    .unwrap();
                (
                    attrs.title.clone().unwrap_or_default(),
                    attrs.app_id.clone().unwrap_or_default(),
                )
            });
            let parent_p = pending.window.toplevel().and_then(|t| t.parent());
            let ident = !app_id.trim().is_empty();
            let geo = pending.window.geometry();
            tracing::warn!(
                target: "derp_toplevel",
                title = %title,
                app_id = %app_id,
                bbox_w = bbox.size.w,
                bbox_h = bbox.size.h,
                geo = ?geo,
                has_buffer_extent,
                has_identity = ident,
                will_map_now = ident,
                "xdg sync deferred toplevel state"
            );
            tracing::warn!(
                target: "derp_toplevel",
                wl_surface_protocol_id = root.id().protocol_id(),
                window_id = ?reg_win_id,
                title = %title,
                app_id = %app_id,
                parent_wl_surface_protocol_id = ?parent_p.as_ref().map(|p| p.id().protocol_id()),
                has_buffer_extent,
                has_identity = ident,
                will_map_now = ident,
                "xdg sync deferred toplevel detail"
            );
            (ident, title, app_id)
        };
        if has_identity {
            let pending = self.pending_deferred_toplevels.remove(&key).unwrap();
            let wl0 = pending.window.toplevel().unwrap().wl_surface();
            let _ = self.window_registry.set_title(wl0, title);
            let _ = self.window_registry.set_app_id(wl0, app_id);
            let wl0 = wl0.clone();
            self.space.map_element(
                DerpSpaceElem::Wayland(pending.window.clone()),
                (pending.map_x, pending.map_y),
                false,
            );
            self.notify_geometry_if_changed(&pending.window);
            let info = self
                .window_registry
                .snapshot_for_wl_surface(&wl0)
                .expect("pending map: registry row");
            tracing::warn!(
                target: "derp_toplevel",
                window_id = info.window_id,
                title = %info.title,
                app_id = %info.app_id,
                wl_surface_protocol_id = wl0.id().protocol_id(),
                map_x = pending.map_x,
                map_y = pending.map_y,
                "deferred toplevel mapped WindowMapped emitted"
            );
            self.shell_emit_chrome_event(ChromeEvent::WindowMapped { info });
        }
    }

    pub(crate) fn wayland_window_id_is_pending_deferred_toplevel(&self, window_id: u32) -> bool {
        self.pending_deferred_toplevels.values().any(|p| {
            p.window
                .toplevel()
                .and_then(|t| self.window_registry.window_id_for_wl_surface(t.wl_surface()))
                == Some(window_id)
        })
    }

    /// Updates [`WindowRegistry`] from current [`Space`] layout and notifies the bridge if geometry changed.
    pub fn notify_geometry_if_changed(&mut self, window: &Window) {
        self.notify_geometry_for_window(window, false);
    }

    /// Like [`Self::notify_geometry_if_changed`], but when `force_shell_emit` is true always sends
    /// [`ChromeEvent::WindowGeometryChanged`] after updating the registry so the Solid shell can
    /// reconcile optimistic titlebar bumps even when `set_geometry` reports no delta (e.g. duplicate
    /// compositor updates vs. last-emitted shell state).
    pub(crate) fn wayland_window_shell_rect_and_deco(
        &self,
        window: &Window,
    ) -> Option<(i32, i32, i32, i32, bool)> {
        let elem = DerpSpaceElem::Wayland(window.clone());
        let map_loc = self.space.element_location(&elem)?;
        let geo = window.geometry();
        let csd = Self::wayland_window_has_client_side_decoration(window);
        Some((map_loc.x, map_loc.y, geo.size.w, geo.size.h, csd))
    }

    pub(crate) fn notify_geometry_for_window(&mut self, window: &Window, force_shell_emit: bool) {
        let Some(toplevel) = window.toplevel() else {
            return;
        };
        let wl = toplevel.wl_surface();
        let Some((gx, gy, gw, gh, csd)) = self.wayland_window_shell_rect_and_deco(window) else {
            return;
        };
        let changed = self
            .window_registry
            .set_shell_layout(wl, gx, gy, gw, gh, csd);
        let (max, fs) = read_toplevel_tiling(wl);
        let tiling_changed = self
            .window_registry
            .set_tiling_state(wl, max, fs)
            .unwrap_or(false);
        let layout_or_tiling = changed == Some(true) || tiling_changed;
        if force_shell_emit || layout_or_tiling {
            if let Some(info) = self.window_registry.snapshot_for_wl_surface(wl) {
                self.shell_emit_chrome_event(ChromeEvent::WindowGeometryChanged { info });
            }
        }
        self.refresh_fractional_scale_for_wayland_window(window);
        if (force_shell_emit || layout_or_tiling)
            && Self::wayland_window_has_client_side_decoration(window)
        {
            self.schedule_fractional_children_refresh(window);
        }
    }

    pub(crate) fn cancel_shell_move_resize_for_window(&mut self, window_id: u32) {
        if self.shell_move_window_id == Some(window_id) {
            self.shell_move_end(window_id);
        }
        if self.shell_resize_window_id == Some(window_id) {
            self.shell_resize_end(window_id);
        }
    }

    pub(crate) fn clear_toplevel_layout_maps(&mut self, window_id: u32) {
        self.toplevel_floating_restore.remove(&window_id);
        self.toplevel_fullscreen_return_maximized.remove(&window_id);
    }

    fn primary_output_geometry_rect(&self) -> Option<Rectangle<i32, Logical>> {
        let o = self.shell_effective_primary_output()?;
        self.space.output_geometry(&o)
    }

    fn resolve_smithay_output(&self, wl_output: Option<&WlOutput>) -> Option<Output> {
        wl_output
            .and_then(Output::from_resource)
            .or_else(|| self.leftmost_output())
    }

    fn client_wl_output_for(&self, wl_surface: &WlSurface, output: &Output) -> Option<WlOutput> {
        let client = wl_surface.client()?;
        output.client_outputs(&client).next()
    }

    pub(crate) fn toplevel_rect_snapshot(&self, window: &Window) -> Option<(i32, i32, i32, i32)> {
        let loc = self
            .space
            .element_location(&DerpSpaceElem::Wayland(window.clone()))?;
        let sz = window.geometry().size;
        Some((loc.x, loc.y, sz.w, sz.h))
    }

    pub(crate) fn apply_toplevel_maximize_layout(&mut self, window: &Window) -> bool {
        let Some(tl) = window.toplevel() else {
            return false;
        };
        let geo = {
            let o = self
                .toplevel_rect_snapshot(window)
                .and_then(|(x, y, w, h)| self.output_for_global_xywh(x, y, w, h))
                .or_else(|| self.leftmost_output());
            let Some(ref out) = o else {
                return false;
            };
            let Some(g) = self.space.output_geometry(out) else {
                return false;
            };
            g
        };
        let wl = tl.wl_surface();
        let Some(window_id) = self.window_registry.window_id_for_wl_surface(wl) else {
            return false;
        };
        self.cancel_shell_move_resize_for_window(window_id);
        let csd = Self::wayland_window_has_client_side_decoration(window);
        let gx = geo.loc.x;
        let gy = geo.loc.y;
        let gw = geo.size.w;
        let gh = geo.size.h;
        let (map_x, map_y, content_w, content_h) =
            Self::wayland_toplevel_map_and_content_for_shell_frame(window, csd, gx, gy, gw, gh);
        tl.with_pending_state(|st| {
            st.states.unset(xdg_toplevel::State::Fullscreen);
            st.fullscreen_output = None;
            st.states.set(xdg_toplevel::State::Maximized);
            st.size = Some(Size::from((content_w, content_h)));
        });
        self.space.map_element(
            DerpSpaceElem::Wayland(window.clone()),
            (map_x, map_y),
            true,
        );
        self.space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        tl.send_pending_configure();
        self.notify_geometry_if_changed(window);
        true
    }

    pub(crate) fn apply_toplevel_fullscreen_layout(
        &mut self,
        window: &Window,
        wl_output_hint: Option<WlOutput>,
    ) -> bool {
        let Some(sm_out) = self.resolve_smithay_output(wl_output_hint.as_ref()) else {
            return false;
        };
        let Some(geo) = self.space.output_geometry(&sm_out) else {
            return false;
        };
        let Some(tl) = window.toplevel() else {
            return false;
        };
        let wl = tl.wl_surface();
        let Some(window_id) = self.window_registry.window_id_for_wl_surface(wl) else {
            return false;
        };
        self.cancel_shell_move_resize_for_window(window_id);
        let wl_out = wl_output_hint.or_else(|| self.client_wl_output_for(wl, &sm_out));
        let csd = Self::wayland_window_has_client_side_decoration(window);
        let gx = geo.loc.x;
        let gy = geo.loc.y;
        let gw = geo.size.w;
        let gh = geo.size.h;
        let (map_x, map_y, content_w, content_h) =
            Self::wayland_toplevel_map_and_content_for_shell_frame(window, csd, gx, gy, gw, gh);
        tl.with_pending_state(|st| {
            st.states.unset(xdg_toplevel::State::Maximized);
            st.states.set(xdg_toplevel::State::Fullscreen);
            st.fullscreen_output = wl_out;
            st.size = Some(Size::from((content_w, content_h)));
        });
        self.space.map_element(
            DerpSpaceElem::Wayland(window.clone()),
            (map_x, map_y),
            true,
        );
        self.space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        tl.send_pending_configure();
        self.notify_geometry_if_changed(window);
        true
    }

    pub(crate) fn restore_toplevel_floating_layout(&mut self, window_id: u32, window: &Window) -> bool {
        let Some((x, y, w, h)) = self.toplevel_floating_restore.remove(&window_id) else {
            return false;
        };
        let Some(tl) = window.toplevel() else {
            return false;
        };
        self.cancel_shell_move_resize_for_window(window_id);
        tl.with_pending_state(|st| {
            st.states.unset(xdg_toplevel::State::Maximized);
            st.states.unset(xdg_toplevel::State::Fullscreen);
            st.fullscreen_output = None;
            st.size = Some(Size::from((w, h)));
        });
        self.space
            .map_element(DerpSpaceElem::Wayland(window.clone()), (x, y), true);
        self.space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        tl.send_pending_configure();
        self.notify_geometry_if_changed(window);
        true
    }

    pub(crate) fn toplevel_unmaximize(&mut self, window: &Window) -> bool {
        let Some(tl) = window.toplevel() else {
            return false;
        };
        let wl = tl.wl_surface();
        let Some(window_id) = self.window_registry.window_id_for_wl_surface(wl) else {
            return false;
        };
        if !read_toplevel_tiling(wl).0 {
            return false;
        }
        if read_toplevel_tiling(wl).1 {
            return false;
        }
        if self.restore_toplevel_floating_layout(window_id, window) {
            return true;
        }
        let (x, y) = self.new_toplevel_initial_location();
        self.cancel_shell_move_resize_for_window(window_id);
        tl.with_pending_state(|st| {
            st.states.unset(xdg_toplevel::State::Maximized);
            st.size = Some(Size::from((800, 600)));
        });
        self.space
            .map_element(DerpSpaceElem::Wayland(window.clone()), (x, y), true);
        tl.send_pending_configure();
        self.notify_geometry_if_changed(window);
        true
    }

    pub(crate) fn toplevel_unfullscreen(&mut self, window: &Window) -> bool {
        let Some(tl) = window.toplevel() else {
            return false;
        };
        let wl = tl.wl_surface();
        let Some(window_id) = self.window_registry.window_id_for_wl_surface(wl) else {
            return false;
        };
        if !read_toplevel_tiling(wl).1 {
            return false;
        }
        let return_max = self.toplevel_fullscreen_return_maximized.remove(&window_id);
        if return_max {
            self.apply_toplevel_maximize_layout(window)
        } else if self.restore_toplevel_floating_layout(window_id, window) {
            true
        } else {
            let (x, y) = self.new_toplevel_initial_location();
            self.cancel_shell_move_resize_for_window(window_id);
            tl.with_pending_state(|st| {
                st.states.unset(xdg_toplevel::State::Fullscreen);
                st.fullscreen_output = None;
                st.size = Some(Size::from((800, 600)));
            });
            self.space
                .map_element(DerpSpaceElem::Wayland(window.clone()), (x, y), true);
            tl.send_pending_configure();
            self.notify_geometry_if_changed(window);
            true
        }
    }

    /// [`WindowInfo`] in the registry uses **global** compositor logical pixels. Solid shell / CEF view (DIP)
    /// uses **canvas-local logical** coordinates. Pointer IPC uses OSR buffer pixels; the CEF UI thread maps
    /// them to view logical via [`crate::cef::osr_view_state::OsrViewState::physical_to_logical`], with
    /// physical size kept in sync from each received dma-buf.
    pub(crate) fn shell_window_info_to_output_local_layout(
        &self,
        info: &crate::chrome_bridge::WindowInfo,
    ) -> Option<crate::chrome_bridge::WindowInfo> {
        let (ox, oy) = self.shell_canvas_logical_origin;
        Some(crate::chrome_bridge::WindowInfo {
            window_id: info.window_id,
            surface_id: info.surface_id,
            title: info.title.clone(),
            app_id: info.app_id.clone(),
            wayland_client_pid: info.wayland_client_pid,
            x: info.x.saturating_sub(ox),
            y: info.y.saturating_sub(oy),
            width: info.width.max(1),
            height: info.height.max(1),
            minimized: info.minimized,
            maximized: info.maximized,
            fullscreen: info.fullscreen,
            client_side_decoration: info.client_side_decoration,
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
                    || !shell_window_row_should_show(info)
            }
            ChromeEvent::WindowUnmapped { window_id } => {
                if let Some(i) = unmap_removed_info {
                    return self.window_info_is_solid_shell_host(i)
                        || !shell_window_row_should_show(i);
                }
                self.window_registry
                    .window_info(*window_id)
                    .map(|i| {
                        self.window_info_is_solid_shell_host(&i)
                            || !shell_window_row_should_show(&i)
                    })
                    .unwrap_or(false)
            }
            ChromeEvent::FocusChanged { window_id, .. } => window_id
                .and_then(|w| self.window_registry.window_info(w))
                .map(|i| self.window_info_is_solid_shell_host(&i))
                .unwrap_or(false),
            ChromeEvent::WindowStateChanged { info, .. } => {
                self.window_info_is_solid_shell_host(info)
                    || !shell_window_row_should_show(info)
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
        tracing::debug!(
            target: "derp_shell_sync",
            window_id,
            "shell ipc WindowUnmapped (retract phantom shell host)"
        );
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowUnmapped {
            window_id,
        });
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
                    .shell_window_info_to_output_local_layout(info)
                    .unwrap_or_else(|| info.clone()),
            },
            ChromeEvent::WindowGeometryChanged { info } => ChromeEvent::WindowGeometryChanged {
                info: self
                    .shell_window_info_to_output_local_layout(info)
                    .unwrap_or_else(|| info.clone()),
            },
            ChromeEvent::WindowStateChanged { info, minimized } => {
                ChromeEvent::WindowStateChanged {
                    info: self
                        .shell_window_info_to_output_local_layout(info)
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
                tracing::debug!(
                    target: "derp_shell_sync",
                    window_id = info.window_id,
                    surface_id = info.surface_id,
                    shell_x = info.x,
                    shell_y = info.y,
                    shell_w = info.width,
                    shell_h = info.height,
                    "shell ipc WindowMapped (output-local layout px)"
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
                    shell_x = info.x,
                    shell_y = info.y,
                    shell_w = info.width,
                    shell_h = info.height,
                    "shell ipc WindowGeometry (output-local layout px)"
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
                tracing::debug!(
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
            if let Some(msg) =
                crate::shell_encode::chrome_event_to_shell_message(&shell_packet_source)
            {
                self.shell_send_to_cef(msg);
            }
        }
        self.chrome_bridge.notify(event);
    }

    pub(crate) fn workspace_logical_bounds(&self) -> Option<Rectangle<i32, Logical>> {
        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut max_x = i32::MIN;
        let mut max_y = i32::MIN;
        for o in self.space.outputs() {
            let g = self.space.output_geometry(o)?;
            min_x = min_x.min(g.loc.x);
            min_y = min_y.min(g.loc.y);
            max_x = max_x.max(g.loc.x.saturating_add(g.size.w));
            max_y = max_y.max(g.loc.y.saturating_add(g.size.h));
        }
        if min_x == i32::MAX {
            return None;
        }
        Some(Rectangle::new(
            Point::<i32, Logical>::from((min_x, min_y)),
            Size::<i32, Logical>::from((
                (max_x - min_x).max(1),
                (max_y - min_y).max(1),
            )),
        ))
    }

    pub(crate) fn wayland_scale_for_shell_ui(shell_ui_scale: f64) -> Scale {
        if (shell_ui_scale - 1.0).abs() < f64::EPSILON {
            return Scale::Integer(1);
        }
        if shell_ui_scale.fract().abs() < f64::EPSILON {
            return Scale::Integer(shell_ui_scale.round() as i32);
        }
        Scale::Fractional(shell_ui_scale)
    }

    pub(crate) fn wayland_window_has_client_side_decoration(window: &Window) -> bool {
        let geo = window.geometry();
        let bbox = window.bbox();
        if bbox.size.w == 0 || bbox.size.h == 0 {
            return false;
        }
        bbox.size.w != geo.size.w
            || bbox.size.h != geo.size.h
            || geo.loc.x != 0
            || geo.loc.y != 0
            || bbox.loc.x != 0
            || bbox.loc.y != 0
    }

    pub(crate) fn wayland_toplevel_map_and_content_for_shell_frame(
        window: &Window,
        client_side_decoration: bool,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> (i32, i32, i32, i32) {
        if !client_side_decoration {
            return (x, y, w, h);
        }
        let geo = window.geometry();
        let bbox = window.bbox();
        if bbox.size.w == 0 || bbox.size.h == 0 {
            return (x, y, w, h);
        }
        let deco_extra_w = bbox.size.w.saturating_sub(geo.size.w);
        let deco_extra_h = bbox.size.h.saturating_sub(geo.size.h);
        let content_w = w.saturating_sub(deco_extra_w).max(geo.size.w.max(1));
        let content_h = h.saturating_sub(deco_extra_h).max(geo.size.h.max(1));
        let render_x = x.saturating_sub(bbox.loc.x);
        let render_y = y.saturating_sub(bbox.loc.y);
        let map_x = render_x.saturating_add(geo.loc.x);
        let map_y = render_y.saturating_add(geo.loc.y);
        (map_x, map_y, content_w, content_h)
    }

    pub(crate) fn apply_shell_ui_scale_to_outputs(&mut self) {
        let outs: Vec<Output> = self.space.outputs().cloned().collect();
        let sc = Self::wayland_scale_for_shell_ui(self.shell_ui_scale);
        for out in outs {
            let Some(mode) = out.current_mode() else {
                continue;
            };
            let tf = out.current_transform();
            let Some(g) = self.space.output_geometry(&out) else {
                continue;
            };
            let loc = g.loc;
            out.change_current_state(
                Some(mode),
                Some(tf),
                Some(sc),
                Some(loc.into()),
            );
            self.space.map_output(&out, (loc.x, loc.y));
        }
    }

    pub(crate) fn set_shell_ui_scale(&mut self, scale: f64) {
        if (scale - 1.0).abs() > f64::EPSILON
            && (scale - 1.5).abs() > f64::EPSILON
            && (scale - 2.0).abs() > f64::EPSILON
        {
            return;
        }
        self.shell_ui_scale = scale;
        self.apply_shell_ui_scale_to_outputs();
        self.send_shell_output_layout();
        self.refresh_all_surface_fractional_scales();
        self.display_config_request_save();
    }

    pub(crate) fn display_config_request_save(&mut self) {
        if !self.display_config_save_suppressed {
            self.display_config_save_pending = true;
        }
    }

    pub(crate) fn recompute_shell_canvas_from_outputs(&mut self) {
        let Some(bounds) = self.workspace_logical_bounds() else {
            return;
        };
        let cw = bounds.size.w.max(1) as u32;
        let ch_work = bounds.size.h.max(1) as u32;
        let atlas_px = Self::shell_context_menu_atlas_px();
        self.shell_canvas_logical_origin = (bounds.loc.x, bounds.loc.y);
        let mut max_scale = 1.0f64;
        for o in self.space.outputs() {
            max_scale = max_scale.max(o.current_scale().fractional_scale() as f64);
        }
        let atlas_log = ((atlas_px as f64) / max_scale).ceil().max(1.0) as u32;
        let ch_canvas = ch_work.saturating_add(atlas_log).max(1);
        self.shell_canvas_logical_size = (cw, ch_canvas);
        self.shell_context_menu_atlas_buffer_h = atlas_px;
        let pw = ((cw as f64) * max_scale).round().max(1.0) as i32;
        let ph_work = ((ch_work as f64) * max_scale).round().max(1.0);
        let ph = (ph_work + atlas_px as f64).round().max(1.0) as i32;
        self.shell_window_physical_px = (pw, ph);
    }

    pub(crate) fn leftmost_output(&self) -> Option<Output> {
        self.space
            .outputs()
            .min_by_key(|o| {
                self.space
                    .output_geometry(o)
                    .map(|g| g.loc.x)
                    .unwrap_or(i32::MAX)
            })
            .cloned()
    }

    pub(crate) fn output_containing_global_point(&self, p: Point<f64, Logical>) -> Option<Output> {
        let ix = p.x.floor() as i32;
        let iy = p.y.floor() as i32;
        for o in self.space.outputs() {
            let g = self.space.output_geometry(o)?;
            if ix >= g.loc.x
                && iy >= g.loc.y
                && ix < g.loc.x.saturating_add(g.size.w)
                && iy < g.loc.y.saturating_add(g.size.h)
            {
                return Some(o.clone());
            }
        }
        None
    }

    pub(crate) fn output_for_global_xywh(&self, x: i32, y: i32, w: i32, h: i32) -> Option<Output> {
        let cx = x.saturating_add(w.saturating_div(2));
        let cy = y.saturating_add(h.saturating_div(2));
        self.output_containing_global_point(Point::from((cx as f64, cy as f64)))
            .or_else(|| self.leftmost_output())
    }

    pub fn send_shell_output_layout(&mut self) {
        let cleared_stale_primary = if let Some(ref n) = self.shell_primary_output_name {
            if !self
                .space
                .outputs()
                .any(|o| o.name() == n.as_str())
            {
                self.shell_primary_output_name = None;
                true
            } else {
                false
            }
        } else {
            false
        };
        if self.workspace_logical_bounds().is_none() {
            return;
        }
        self.recompute_shell_canvas_from_outputs();
        let (lw, lh) = self.shell_canvas_logical_size;
        let (pw, ph) = self.shell_window_physical_px;
        let physical_w = u32::try_from(pw).unwrap_or(lw).max(1);
        let physical_h = u32::try_from(ph).unwrap_or(lh).max(1);
        let screens: Vec<shell_wire::OutputLayoutScreen> = self
            .space
            .outputs()
            .filter_map(|o| {
                let g = self.space.output_geometry(o)?;
                let tf = o.current_transform();
                let mode = o.current_mode()?;
                let refresh_milli_hz = u32::try_from(mode.refresh.max(1)).unwrap_or(1);
                Some(shell_wire::OutputLayoutScreen {
                    name: o.name(),
                    x: g.loc.x,
                    y: g.loc.y,
                    w: u32::try_from(g.size.w).ok()?.max(1),
                    h: u32::try_from(g.size.h).ok()?.max(1),
                    transform: transform_to_wire(tf),
                    refresh_milli_hz,
                })
            })
            .collect();
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::OutputLayout {
            canvas_logical_w: lw.max(1),
            canvas_logical_h: lh.max(1),
            canvas_physical_w: physical_w,
            canvas_physical_h: physical_h,
            context_menu_atlas_buffer_h: self.shell_context_menu_atlas_buffer_h,
            screens,
            shell_chrome_primary: self.shell_primary_output_name.clone(),
        });
        if cleared_stale_primary {
            self.resync_embedded_shell_host_after_ipc_connect();
        }
    }

    pub fn set_shell_primary_output_name(&mut self, name: String) {
        let pref = if name.is_empty() {
            None
        } else {
            if !self
                .space
                .outputs()
                .any(|o| o.name() == name.as_str())
            {
                return;
            }
            Some(name)
        };
        self.shell_primary_output_name = pref;
        self.resync_embedded_shell_host_after_ipc_connect();
        self.send_shell_output_layout();
        self.display_config_request_save();
    }

    pub fn apply_shell_output_layout_json(&mut self, json: &str) {
        #[derive(serde::Deserialize)]
        struct Scr {
            name: String,
            x: i32,
            y: i32,
            #[serde(default)]
            transform: u32,
        }
        #[derive(serde::Deserialize)]
        struct Root {
            screens: Vec<Scr>,
        }
        let Ok(root) = serde_json::from_str::<Root>(json) else {
            return;
        };
        let mut resolved: Vec<(Scr, Output)> = Vec::new();
        for s in root.screens {
            let Some(out) = self
                .space
                .outputs()
                .find(|o| o.name() == s.name)
                .cloned()
            else {
                continue;
            };
            if out.current_mode().is_none() {
                continue;
            }
            resolved.push((s, out));
        }
        let sc = Self::wayland_scale_for_shell_ui(self.shell_ui_scale);
        for (s, out) in &resolved {
            let mode = out.current_mode().unwrap();
            let tf = transform_from_wire(s.transform);
            out.change_current_state(
                Some(mode),
                Some(tf),
                Some(sc),
                Some((s.x, s.y).into()),
            );
            self.space.map_output(out, (s.x, s.y));
        }
        let mut row_buckets: HashMap<i32, Vec<usize>> = HashMap::new();
        for (i, (s, _)) in resolved.iter().enumerate() {
            row_buckets.entry(s.y).or_default().push(i);
        }
        let mut new_xy: Vec<(i32, i32)> = resolved
            .iter()
            .map(|(s, _)| (s.x, s.y))
            .collect();
        for mut indices in row_buckets.into_values() {
            indices.sort_by_key(|&i| resolved[i].0.x);
            let mut cx = resolved[indices[0]].0.x;
            for &i in &indices {
                let (s, out) = &resolved[i];
                let w = self
                    .space
                    .output_geometry(out)
                    .map(|g| g.size.w)
                    .unwrap_or(0)
                    .max(0);
                new_xy[i] = (cx, s.y);
                cx += w;
            }
        }
        for (i, (s, out)) in resolved.iter().enumerate() {
            let (nx, ny) = new_xy[i];
            let Some(mode) = out.current_mode() else {
                continue;
            };
            let tf = transform_from_wire(s.transform);
            out.change_current_state(
                Some(mode),
                Some(tf),
                Some(sc),
                Some((nx, ny).into()),
            );
            self.space.map_output(out, (nx, ny));
        }
        if let Some(ref n) = self.shell_primary_output_name {
            if !self
                .space
                .outputs()
                .any(|o| o.name() == n.as_str())
            {
                self.shell_primary_output_name = None;
            }
        }
        self.recompute_shell_canvas_from_outputs();
        self.send_shell_output_layout();
        self.refresh_all_surface_fractional_scales();
        self.display_config_request_save();
    }

    /// Logical size matching [`Space::output_geometry`] / pointer normalization (not raw `current_mode` when they differ).
    pub fn shell_output_logical_size(&self) -> Option<(u32, u32)> {
        let b = self.workspace_logical_bounds()?;
        Some((
            u32::try_from(b.size.w).ok()?.max(1),
            u32::try_from(b.size.h).ok()?.max(1),
        ))
    }

    pub fn send_shell_output_geometry(&mut self) {
        self.send_shell_output_layout();
    }

    /// Embedded shell IPC: first full handshake after [`Space::map_output`] so output geometry is non-empty.
    pub fn shell_embedded_notify_output_ready(&mut self) {
        if self.shell_cef_handshake.is_none() {
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
        if self.shell_ipc_peer_pid.is_none() && !self.shell_cef_active() {
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
            if self.wayland_window_id_is_pending_deferred_toplevel(info.window_id) {
                continue;
            }
            if !shell_window_row_should_show(&info) {
                continue;
            }
            let ipc_info = self
                .shell_window_info_to_output_local_layout(&info)
                .unwrap_or_else(|| info.clone());
            self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowMapped {
                window_id: ipc_info.window_id,
                surface_id: ipc_info.surface_id,
                x: ipc_info.x,
                y: ipc_info.y,
                w: ipc_info.width,
                h: ipc_info.height,
                title: ipc_info.title.clone(),
                app_id: ipc_info.app_id.clone(),
                client_side_decoration: ipc_info.client_side_decoration,
            });
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
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id,
            window_id,
        });
        self.shell_reply_window_list();
    }

    pub(crate) fn shell_note_shell_ipc_rx(&mut self) {
        self.shell_ipc_last_rx = Some(Instant::now());
    }

    /// Stops the compositor if a shell IPC client is connected but has been silent longer than [`Self::shell_ipc_stall_timeout`].
    pub(crate) fn shell_check_ipc_watchdog(&mut self) {
        let Some(limit) = self.shell_ipc_stall_timeout else {
            return;
        };
        if !self.shell_cef_active() {
            self.shell_ipc_last_compositor_ping = None;
            return;
        }
        let Some(last_rx) = self.shell_ipc_last_rx else {
            return;
        };
        let idle = last_rx.elapsed();
        // Silence does not reset `shell_ipc_last_rx`; in-process shell handles Ping without a socket round-trip.
        let prod_after = std::cmp::max(limit / 2, Duration::from_millis(500))
            .min(Duration::from_secs(2));
        if idle >= prod_after {
            let throttle = Duration::from_secs(1);
            if self
                .shell_ipc_last_compositor_ping
                .map(|t| t.elapsed() >= throttle)
                .unwrap_or(true)
            {
                self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Ping);
                self.shell_ipc_last_compositor_ping = Some(Instant::now());
            }
        }
        if idle <= limit {
            return;
        }
        tracing::warn!(
            timeout_secs = limit.as_secs(),
            "shell watchdog: no CEF/compositor activity within timeout; stopping compositor (stuck shell / JS)"
        );
        self.loop_signal.stop();
        self.loop_signal.wakeup();
    }

    /// True if the pointer is over the Solid shell layer (desktop), not the native Wayland client beneath.
    pub fn shell_pointer_route_to_cef(&self, pos: Point<f64, Logical>) -> bool {
        if self.point_in_shell_exclusion_zones(pos) {
            return true;
        }
        let px = pos.x;
        let py = pos.y;
        if let Some(ref menu) = self.shell_context_menu {
            let g = &menu.global_rect;
            let x2 = g.loc.x.saturating_add(g.size.w) as f64;
            let y2 = g.loc.y.saturating_add(g.size.h) as f64;
            if px >= g.loc.x as f64 && px < x2 && py >= g.loc.y as f64 && py < y2 {
                return true;
            }
        }

        if self.surface_under(pos).is_some() {
            return false;
        }

        true
    }

    pub fn shell_point_in_context_menu_global(&self, pos: Point<f64, Logical>) -> bool {
        let Some(ref menu) = self.shell_context_menu else {
            return false;
        };
        let g = &menu.global_rect;
        let px = pos.x;
        let py = pos.y;
        let x2 = g.loc.x.saturating_add(g.size.w) as f64;
        let y2 = g.loc.y.saturating_add(g.size.h) as f64;
        const EPS: f64 = 1.0e-6;
        px >= g.loc.x as f64 - EPS
            && px < x2 + EPS
            && py >= g.loc.y as f64 - EPS
            && py < y2 + EPS
    }

    pub(crate) fn shell_dismiss_context_menu_from_compositor(&mut self) {
        if self.shell_context_menu.is_none() {
            return;
        }
        self.shell_context_menu = None;
        self.shell_context_menu_overlay_id = Id::new();
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::ContextMenuDismiss);
    }

    /// Map normalized pointer (`nx`, `ny` over the canvas) to **shell OSR buffer** pixels (letterbox-aware).
    pub fn shell_pointer_buffer_pixels(&self, nx: f64, ny: f64) -> Option<(i32, i32)> {
        let (buf_w, buf_h) = self.shell_view_px?;
        let content_h = buf_h.saturating_sub(self.shell_context_menu_atlas_buffer_h).max(1);
        let (lw, lh) = self.shell_output_logical_size()?;
        let (ox, oy, cw, ch) = crate::shell_letterbox::letterbox_logical(
            Size::from((lw as i32, lh as i32)),
            buf_w,
            content_h,
        )?;
        let nx = nx.clamp(0.0, 1.0);
        let ny = ny.clamp(0.0, 1.0);
        let lx = nx * lw as f64 - ox as f64;
        let ly = ny * lh as f64 - oy as f64;
        crate::shell_letterbox::local_in_letterbox_to_buffer_px(lx, ly, cw, ch, buf_w, content_h)
    }

    pub(crate) fn shell_pointer_coords_for_cef(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(i32, i32)> {
        if let Some(ref menu) = self.shell_context_menu {
            let g = &menu.global_rect;
            let gw = g.size.w.max(1) as f64;
            let gh = g.size.h.max(1) as f64;
            let px = pos.x - g.loc.x as f64;
            let py = pos.y - g.loc.y as f64;
            if px >= 0.0 && py >= 0.0 && px < gw && py < gh {
                let br = &menu.buffer_rect;
                let bw = br.size.w.max(1) as f64;
                let bh = br.size.h.max(1) as f64;
                let bx = br.loc.x as f64 + (px / gw) * bw;
                let by = br.loc.y as f64 + (py / gh) * bh;
                let (buf_w, buf_h) = self.shell_view_px?;
                if buf_w == 0 || buf_h == 0 {
                    return None;
                }
                let (clw, clh) = self.shell_canvas_logical_size;
                let vlx = ((bx / buf_w as f64) * clw as f64).round() as i32;
                let vly = ((by / buf_h as f64) * clh as f64).round() as i32;
                let xmax = clw.saturating_sub(1) as i32;
                let ymax = clh.saturating_sub(1) as i32;
                return Some((vlx.clamp(0, xmax), vly.clamp(0, ymax)));
            }
        }
        self.shell_pointer_ipc_for_cef(pos)
    }

    pub(crate) fn shell_pointer_norm_from_global(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(f64, f64)> {
        let ws = self.workspace_logical_bounds()?;
        let local = pos - ws.loc.to_f64();
        let gw = ws.size.w.max(1) as f64;
        let gh = ws.size.h.max(1) as f64;
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

    pub(crate) fn shell_resize_is_active(&self) -> bool {
        self.shell_resize_window_id.is_some()
    }

    pub(crate) fn shell_resize_end_active(&mut self) {
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
            .filter(|i| shell_window_row_should_show(i))
            .filter(|i| !self.wayland_window_id_is_pending_deferred_toplevel(i.window_id))
            .map(|i| {
                let i = self
                    .shell_window_info_to_output_local_layout(&i)
                    .unwrap_or_else(|| i.clone());
                shell_wire::ShellWindowSnapshot {
                    window_id: i.window_id,
                    surface_id: i.surface_id,
                    x: i.x,
                    y: i.y,
                    w: i.width,
                    h: i.height,
                    minimized: if i.minimized { 1 } else { 0 },
                    maximized: if i.maximized { 1 } else { 0 },
                    fullscreen: if i.fullscreen { 1 } else { 0 },
                    client_side_decoration: if i.client_side_decoration { 1 } else { 0 },
                    title: i.title,
                    app_id: i.app_id,
                }
            })
            .collect();
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowList { windows });
    }

    /// Output-local **layout** rect from the shell (same integers as HUD `fixed` CSS / CEF DIP) → global logical.
    fn shell_output_local_rect_to_logical_global(
        &self,
        lx: i32,
        ly: i32,
        lw: i32,
        lh: i32,
    ) -> Option<(i32, i32, i32, i32)> {
        let (ox, oy) = self.shell_canvas_logical_origin;
        Some((
            ox.saturating_add(lx),
            oy.saturating_add(ly),
            lw.max(1),
            lh.max(1),
        ))
    }

    /// `layout_state`: 0 = floating; 1 = maximized — bounds are **output-local layout** px from the shell.
    pub fn shell_set_window_geometry(
        &mut self,
        window_id: u32,
        lx: i32,
        ly: i32,
        lw: i32,
        lh: i32,
        layout_state: u32,
    ) {
        if layout_state > 1 {
            return;
        }
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
        let Some((x, y, w, h)) = self.shell_output_local_rect_to_logical_global(lx, ly, lw, lh) else {
            return;
        };

        if layout_state == 0 {
            self.clear_toplevel_layout_maps(window_id);
        } else if layout_state == 1 {
            self.cancel_shell_move_resize_for_window(window_id);
            if !self.toplevel_floating_restore.contains_key(&window_id) {
                if let Some(s) = self.toplevel_rect_snapshot(&window) {
                    self.toplevel_floating_restore.insert(window_id, s);
                }
            }
        }

        let csd = Self::wayland_window_has_client_side_decoration(&window);
        let (map_x, map_y, content_w, content_h) =
            Self::wayland_toplevel_map_and_content_for_shell_frame(&window, csd, x, y, w, h);

        let tl = window.toplevel().unwrap();
        tl.with_pending_state(|state| {
            state.states.unset(xdg_toplevel::State::Fullscreen);
            state.fullscreen_output = None;
            if layout_state == 1 {
                state.states.set(xdg_toplevel::State::Maximized);
            } else {
                state.states.unset(xdg_toplevel::State::Maximized);
            }
            state.size = Some(smithay::utils::Size::from((content_w, content_h)));
        });
        tl.send_pending_configure();
        self.space
            .map_element(DerpSpaceElem::Wayland(window.clone()), (map_x, map_y), true);
        self.notify_geometry_if_changed(&window);
    }

    pub fn shell_close_window(&mut self, window_id: u32) {
        let Some(info) = self.window_registry.window_info(window_id) else {
            tracing::warn!(
                target: "derp_toplevel",
                window_id,
                "shell_close_window abort: no window_registry.window_info"
            );
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            tracing::warn!(
                target: "derp_toplevel",
                window_id,
                "shell_close_window abort: solid shell host"
            );
            return;
        }
        let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
            tracing::warn!(
                target: "derp_toplevel",
                window_id,
                title = %info.title,
                "shell_close_window abort: no surface_id_for_window"
            );
            return;
        };
        if let Some(w) = self.find_window_by_surface_id(sid) {
            self.space
                .raise_element(&DerpSpaceElem::Wayland(w.clone()), true);
            let wl_surf = w.toplevel().unwrap().wl_surface().clone();
            let k_serial = SERIAL_COUNTER.next_serial();
            if let Some(kb) = self.seat.get_keyboard() {
                kb.set_focus(self, Some(wl_surf), k_serial);
            }
        }
        if self.shell_move_window_id == Some(window_id) {
            self.shell_move_end(window_id);
        }
        if self.shell_resize_window_id == Some(window_id) {
            self.shell_resize_end(window_id);
        }
        let Some(window) = self.find_window_by_surface_id(sid) else {
            tracing::warn!(
                target: "derp_toplevel",
                window_id,
                "shell_close_window abort: no mapped Wayland window"
            );
            return;
        };
        let Some(tl) = window.toplevel() else {
            return;
        };
        tracing::warn!(
            target: "derp_toplevel",
            window_id,
            wl_surface_protocol_id = tl.wl_surface().id().protocol_id(),
            title = %info.title,
            app_id = %info.app_id,
            "shell_close_window send_close"
        );
        tl.send_close();
    }

    pub fn shell_set_window_fullscreen(&mut self, window_id: u32, enabled: bool) {
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
        let wl = window.toplevel().unwrap().wl_surface();
        if enabled {
            if read_toplevel_tiling(wl).1 {
                return;
            }
            let maximized = read_toplevel_tiling(wl).0;
            if maximized {
                self.toplevel_fullscreen_return_maximized.insert(window_id);
            } else {
                self.toplevel_fullscreen_return_maximized
                    .remove(&window_id);
                if !self.toplevel_floating_restore.contains_key(&window_id) {
                    if let Some(s) = self.toplevel_rect_snapshot(&window) {
                        self.toplevel_floating_restore.insert(window_id, s);
                    }
                }
            }
            let wl_out = self
                .space
                .outputs()
                .next()
                .and_then(|o| self.client_wl_output_for(wl, o));
            self.apply_toplevel_fullscreen_layout(&window, wl_out);
        } else {
            if !read_toplevel_tiling(wl).1 {
                return;
            }
            let _ = self.toplevel_unfullscreen(&window);
        }
    }

    pub fn shell_set_window_maximized(&mut self, window_id: u32, enabled: bool) {
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
        let wl = window.toplevel().unwrap().wl_surface();
        if enabled {
            // Maximize bounds come from the shell via [`MSG_SHELL_SET_GEOMETRY`] + `layout_state = 1`.
            return;
        } else {
            if !read_toplevel_tiling(wl).0 {
                return;
            }
            let _ = self.toplevel_unmaximize(&window);
        }
    }

    pub fn shell_set_presentation_fullscreen(&mut self, enabled: bool) {
        self.shell_presentation_fullscreen = enabled;
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

    pub(crate) fn shell_pointer_ipc_for_cef(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(i32, i32)> {
        let (cox, coy) = self.shell_canvas_logical_origin;
        let (clw, clh) = self.shell_canvas_logical_size;
        let clwf = clw.max(1) as f64;
        let clhf = clh.max(1) as f64;
        let lx = pos.x - cox as f64;
        let ly = pos.y - coy as f64;
        if lx < 0.0 || ly < 0.0 || lx >= clwf || ly >= clhf {
            return None;
        }
        let xmax = clw.saturating_sub(1) as i32;
        let ymax = clh.saturating_sub(1) as i32;
        let x = (lx.round() as i32).clamp(0, xmax);
        let y = (ly.round() as i32).clamp(0, ymax);
        Some((x, y))
    }

    fn shell_osr_dirty_bbox_covers_buffer(dirty: &[(i32, i32, i32, i32)], buf_w: u32, buf_h: u32) -> bool {
        const FRAC_NUM: i64 = 97;
        const FRAC_DEN: i64 = 100;
        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut max_x = i32::MIN;
        let mut max_y = i32::MIN;
        for &(x, y, w, h) in dirty {
            max_x = max_x.max(x.saturating_add(w));
            max_y = max_y.max(y.saturating_add(h));
            min_x = min_x.min(x);
            min_y = min_y.min(y);
        }
        let bw = buf_w as i64;
        let bh = buf_h as i64;
        if bw <= 0 || bh <= 0 {
            return true;
        }
        let rw = (max_x as i64 - min_x as i64).max(0);
        let rh = (max_y as i64 - min_y as i64).max(0);
        rw * rh * FRAC_DEN >= bw * bh * FRAC_NUM
    }

    pub fn apply_shell_frame_dmabuf(
        &mut self,
        width: u32,
        height: u32,
        drm_format: u32,
        modifier: u64,
        flags: u32,
        planes: &[shell_wire::FrameDmabufPlane],
        fds: &mut Vec<OwnedFd>,
        dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
    ) -> Result<(), &'static str> {
        if width == 0 || height == 0 {
            fds.clear();
            return Err("bad dimensions");
        }
        if planes.is_empty() || planes.len() != fds.len() {
            fds.clear();
            return Err("dmabuf plane/fd mismatch");
        }
        let force_env = std::env::var_os("DERP_SHELL_OSR_FULL_DAMAGE").is_some_and(|v| {
            v.as_os_str() == std::ffi::OsStr::new("1")
                || v.as_os_str().eq_ignore_ascii_case(std::ffi::OsStr::new("true"))
        });
        let resized = self.shell_view_px.is_some_and(|p| p != (width, height));
        let dirty_supplied_len = dirty_buffer.as_ref().map(|v| v.len());
        let dirty_list = dirty_buffer.filter(|v| !v.is_empty());
        let bbox_full = dirty_list
            .as_ref()
            .map(|v| Self::shell_osr_dirty_bbox_covers_buffer(v, width, height))
            .unwrap_or(true);
        let mut force_full = force_env || resized || dirty_list.is_none() || bbox_full;
        let buffer_rects: Vec<Rectangle<i32, Buffer>> = if let Some(ref dl) = dirty_list {
            let mut rects = Vec::with_capacity(dl.len());
            for &(x, y, w, h) in dl {
                if w > 0 && h > 0 {
                    rects.push(Rectangle::new(
                        Point::<i32, Buffer>::from((x, y)),
                        Size::<i32, Buffer>::from((w, h)),
                    ));
                }
            }
            if !force_full && rects.is_empty() {
                force_full = true;
            }
            rects
        } else {
            Vec::new()
        };

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
        self.shell_dmabuf_dirty_force_full = force_full;
        if force_full {
            self.shell_dmabuf_dirty_buffer.clear();
        } else {
            self.shell_dmabuf_dirty_buffer = buffer_rects;
        }
        self.shell_dmabuf_commit.increment();

        self.shell_dmabuf = Some(dmabuf);
        self.shell_frame_is_dmabuf = true;
        self.shell_has_frame = true;
        self.shell_view_px = Some((width, height));
        if let Ok(g) = self.shell_to_cef.lock() {
            if let Some(link) = g.as_ref() {
                link.sync_osr_physical_from_dmabuf(width as i32, height as i32);
            }
        }
        self.shell_move_flush_pending_deltas();
        tracing::debug!(
            target: "derp_shell_osr_damage",
            width,
            height,
            force_full,
            force_env,
            resized,
            dirty_supplied = dirty_supplied_len,
            bbox_full,
            partial_rects = self.shell_dmabuf_dirty_buffer.len(),
            commit = ?self.shell_dmabuf_commit,
            "apply_shell_frame_dmabuf damage"
        );
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

        if let Some((lw, lh)) = self.shell_output_logical_size() {
            let (pw, ph) = self.shell_window_physical_px;
            if lw > 0 && lh > 0 && pw > 0 && ph > 0 {
                let exp_w = u32::try_from(pw).unwrap_or(width).max(1);
                let exp_h = u32::try_from(ph).unwrap_or(height).max(1);
                if width * 100 < exp_w * 97 || height * 100 < exp_h * 97 {
                    use std::sync::Once;
                    static SHELL_DMABUF_UNDERSIZED: Once = Once::new();
                    SHELL_DMABUF_UNDERSIZED.call_once(|| {
                        tracing::warn!(
                            target: "derp_shell_dmabuf",
                            width,
                            height,
                            exp_w,
                            exp_h,
                            logical_w = lw,
                            logical_h = lh,
                            "shell dma-buf is smaller than canvas physical size — Solid is being upscaled (soft)."
                        );
                    });
                }
            }
        }
        Ok(())
    }

    pub fn clear_shell_frame(&mut self) {
        self.shell_has_frame = false;
        self.shell_view_px = None;
        self.shell_frame_is_dmabuf = false;
        self.shell_dmabuf = None;
        self.shell_dmabuf_overlay_id = Id::new();
        self.shell_dmabuf_commit = CommitCounter::default();
        self.shell_dmabuf_dirty_buffer.clear();
        self.shell_dmabuf_dirty_force_full = true;
        self.shell_last_pointer_ipc_px = None;
        self.touch_routes_to_cef = false;
        self.shell_context_menu = None;
        self.shell_context_menu_overlay_id = Id::new();
    }

    pub fn apply_shell_context_menu(
        &mut self,
        visible: bool,
        bx: i32,
        by: i32,
        bw: u32,
        bh: u32,
        gx: i32,
        gy: i32,
        gw: u32,
        gh: u32,
    ) {
        const MAX_MENU: u32 = 4096;
        if !visible {
            self.shell_context_menu = None;
            self.shell_context_menu_overlay_id = Id::new();
            return;
        }
        if bw == 0 || bh == 0 || gw == 0 || gh == 0 {
            self.shell_context_menu = None;
            self.shell_context_menu_overlay_id = Id::new();
            return;
        }
        if bw > MAX_MENU || bh > MAX_MENU || gw > MAX_MENU || gh > MAX_MENU {
            tracing::warn!(target: "derp_shell_menu", bw, bh, gw, gh, "context menu rect too large");
            return;
        }
        let Some((buf_w, buf_h)) = self.shell_view_px else {
            return;
        };
        let atlas = self.shell_context_menu_atlas_buffer_h;
        if atlas == 0 || buf_h <= atlas {
            return;
        }
        let atlas_y0 = buf_h.saturating_sub(atlas);
        if by < atlas_y0 as i32
            || bx < 0
            || bx.saturating_add(bw as i32) > buf_w as i32
            || by.saturating_add(bh as i32) > buf_h as i32
        {
            tracing::warn!(
                target: "derp_shell_menu",
                bx,
                by,
                bw,
                bh,
                atlas_y0,
                buf_w,
                buf_h,
                "context menu buffer rect outside atlas"
            );
            return;
        }
        let Some(ws) = self.workspace_logical_bounds() else {
            return;
        };
        let (clw_u, clh_u) = self.shell_canvas_logical_size;
        let ch_work = ws.size.h.max(1) as u32;
        let strip_log = clh_u.saturating_sub(ch_work).max(1);
        let gw_adj = (((bw as u64) * (clw_u as u64)) / (buf_w.max(1) as u64)).clamp(1, MAX_MENU as u64) as u32;
        let gh_adj = (((bh as u64) * (strip_log as u64)) / (atlas.max(1) as u64)).clamp(1, MAX_MENU as u64) as u32;
        let ws_w = ws.size.w.max(1) as u32;
        let ws_h = ws.size.h.max(1) as u32;
        if gw_adj > ws_w || gh_adj > ws_h {
            tracing::warn!(
                target: "derp_shell_menu",
                gw_adj,
                gh_adj,
                ws_w,
                ws_h,
                "context menu logical size exceeds workspace (ignored)"
            );
            return;
        }
        let gr = Rectangle::new(Point::new(gx, gy), Size::new(gw_adj as i32, gh_adj as i32));
        let bounds = Rectangle::new(ws.loc, ws.size);
        if gr.intersection(bounds).is_none() {
            tracing::warn!(target: "derp_shell_menu", gx, gy, gw_adj, gh_adj, "context menu global rect off workspace");
            return;
        }
        self.shell_context_menu = Some(ShellContextMenuPlacement {
            buffer_rect: Rectangle::new(Point::new(bx, by), Size::new(bw as i32, bh as i32)),
            global_rect: gr,
        });
        self.shell_context_menu_overlay_id = Id::new();
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
        if !self.shell_cef_active() || !self.shell_has_frame {
            return;
        }
        let sym = keysym.modified_sym();
        let mods_u = Self::cef_flags_from_modifiers(mods);
        let native = sym.raw() as i32;
        match key_state {
            KeyState::Pressed => {
                self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                    cef_key_type: shell_wire::CEF_KEYEVENT_RAWKEYDOWN,
                    modifiers: mods_u,
                    windows_key_code: 0,
                    native_key_code: native,
                    character: 0,
                    unmodified_character: 0,
                });
                if let Some(ch) = sym.key_char() {
                    if !ch.is_control() {
                        let cu = ch as u32;
                        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                            cef_key_type: shell_wire::CEF_KEYEVENT_CHAR,
                            modifiers: mods_u,
                            windows_key_code: 0,
                            native_key_code: native,
                            character: cu,
                            unmodified_character: cu,
                        });
                    }
                }
            }
            KeyState::Released => {
                self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                    cef_key_type: shell_wire::CEF_KEYEVENT_KEYUP,
                    modifiers: mods_u,
                    windows_key_code: 0,
                    native_key_code: native,
                    character: 0,
                    unmodified_character: 0,
                });
            }
        }
    }

    /// Solid / CEF OSR is composited from dma-buf, not a Wayland surface under the cursor — forward moves to `cef_host`.
    pub(crate) fn shell_ipc_maybe_forward_pointer_move(&mut self, pos: Point<f64, Logical>) {
        if !self.shell_cef_active() || !self.shell_has_frame {
            return;
        }
        let route = self.shell_pointer_route_to_cef(pos);
        if !route && !self.shell_move_is_active() && !self.shell_resize_is_active() {
            return;
        }
        let Some((bx, by)) = self.shell_pointer_coords_for_cef(pos) else {
            return;
        };
        if self.shell_last_pointer_ipc_px == Some((bx, by)) {
            return;
        }
        self.shell_last_pointer_ipc_px = Some((bx, by));
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::PointerMove {
            x: bx,
            y: by,
            modifiers: self.shell_cef_event_flags(),
        });
    }

    /// Forward scroll / pointer axis to `cef_host` when the pointer is over the Solid shell (OSR).
    pub(crate) fn shell_ipc_maybe_forward_pointer_axis(&mut self, delta_x: i32, delta_y: i32) {
        if !self.shell_cef_active() || !self.shell_has_frame {
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
        let Some((bx, by)) = self.shell_pointer_coords_for_cef(pos) else {
            return;
        };
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::PointerAxis {
            x: bx,
            y: by,
            delta_x,
            delta_y,
            modifiers: self.shell_cef_event_flags(),
        });
    }

    /// Run `sh -c` with [`Self::socket_name`] as `WAYLAND_DISPLAY` (nested compositor clients).
    pub fn try_spawn_wayland_client_sh(&self, shell_command: &str) -> Result<(), String> {
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
        tracing::debug!(pid = child.id(), "spawned Wayland client via shell IPC");
        Ok(())
    }
}

impl XWaylandShellHandler for CompositorState {
    fn xwayland_shell_state(&mut self) -> &mut XWaylandShellState {
        &mut self.xwayland_shell_state
    }

    fn surface_associated(&mut self, _xwm_id: XwmId, _surface: WlSurface, _window: X11Surface) {
        self.loop_signal.wakeup();
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
    }

    fn mapped_override_redirect_window(&mut self, _xwm: XwmId, window: X11Surface) {
        let geo = window.geometry();
        self.space.map_element(
            DerpSpaceElem::X11(window.clone()),
            (geo.loc.x, geo.loc.y),
            false,
        );
        self.loop_signal.wakeup();
    }

    fn unmapped_window(&mut self, _xwm: XwmId, window: X11Surface) {
        self.space.unmap_elem(&DerpSpaceElem::X11(window));
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

impl FractionalScaleHandler for CompositorState {
    fn new_fractional_scale(&mut self, surface: WlSurface) {
        self.wp_fractional_scale_surface_ids.insert(surface.id());
        let scale = self
            .wayland_window_containing_surface(&surface)
            .map(|w| self.fractional_scale_for_space_element(&DerpSpaceElem::Wayland(w)))
            .unwrap_or_else(|| {
                self.leftmost_output()
                    .map(|o| o.current_scale().fractional_scale())
                    .unwrap_or(1.0)
            });
        smithay::wayland::compositor::with_states(&surface, |states| {
            smithay::wayland::fractional_scale::with_fractional_scale(states, |fs| {
                fs.set_preferred_scale(scale);
            });
        });
    }
}

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
smithay::delegate_viewporter!(CompositorState);
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
