use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::OsString,
    os::fd::OwnedFd,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};

use smithay::{
    backend::allocator::dmabuf::{Dmabuf, DmabufFlags},
    backend::allocator::{Format, Fourcc, Modifier},
    backend::input::{KeyState, Keycode, TouchSlot},
    backend::renderer::{
        element::solid::SolidColorBuffer,
        gles::GlesRenderer,
        utils::CommitCounter,
        Color32F,
        ImportDma,
        Renderer,
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
        keyboard::{keysyms, KeysymHandle, Layout, ModifiersState},
        Seat, SeatState,
    },
    reexports::{
        calloop::{
            channel::{self, Event as CalloopChannelEvent},
            generic::Generic,
            timer::{TimeoutAction, Timer},
            EventLoop,
            Interest,
            LoopHandle,
            LoopSignal,
            Mode,
            PostAction,
            RegistrationToken,
        },
        wayland_server::{
            backend::{ClientData, ClientId, DisconnectReason},
            protocol::{wl_output::WlOutput, wl_surface::WlSurface},
            Display, DisplayHandle,
        },
        wayland_protocols::xdg::shell::server::xdg_toplevel,
    },
    utils::{Buffer, Logical, Point, Rectangle, Serial, Size, Transform, SERIAL_COUNTER},
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
pub const SHELL_TASKBAR_RESERVE_PX: i32 = 44;
/// Default **position** (output top-left + offset) for new xdg toplevels in **logical** px.
pub const DEFAULT_XDG_TOPLEVEL_OFFSET_X: i32 = 200;
pub const DEFAULT_XDG_TOPLEVEL_OFFSET_Y: i32 = 200;
/// Added per already-mapped toplevel so new windows are not stacked at the identical `(offset_x, offset_y)` (breaks shell chrome / input).
pub const DEFAULT_XDG_TOPLEVEL_CASCADE_STEP: i32 = 30;
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

pub(crate) struct DesktopWallpaperGpu {
    pub texture: smithay::backend::renderer::gles::GlesTexture,
    pub context_id: smithay::backend::renderer::ContextId<
        smithay::backend::renderer::gles::GlesTexture,
    >,
    pub tex_w: i32,
    pub tex_h: i32,
}

pub(crate) struct DesktopWallpaperGpuEntry {
    pub gpu: DesktopWallpaperGpu,
    pub commit: CommitCounter,
}

pub(crate) struct BackdropWallpaperIdCache {
    pub key: String,
    pub ids: Vec<Id>,
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
    pub event_loop_stop: Arc<AtomicBool>,

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
    shell_cef_repeat_token: Option<RegistrationToken>,
    pub(crate) shell_cef_repeat_keycode: Option<Keycode>,
    shell_cef_repeat_sym_raw: Option<u32>,
    /// Super key pressed; used with [`Self::programs_menu_super_chord`] for Programs menu tap detection.
    pub(crate) programs_menu_super_armed: bool,
    pub(crate) programs_menu_super_chord: bool,
    keyboard_layout_by_window: HashMap<u32, u32>,
    keyboard_layout_last_focus_window: Option<u32>,
    keyboard_layout_focus_queue: VecDeque<KeyboardLayoutFocusOp>,
    session_default_layout_index: u32,
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
    focus_history_non_shell: Vec<u32>,
    /// After [`Self::try_spawn_wayland_client_sh`]: focus the first new non-shell toplevel with a greater window id.
    shell_spawn_focus_above_window_id: Option<u32>,
    /// Wayland [`Window`] handles for compositor-minimized toplevels (unmapped from [`Self::space`]).
    pub(crate) shell_minimized_windows: HashMap<u32, Window>,
    /// [`WindowRegistry`]-scoped id for shell-initiated move (`MSG_SHELL_MOVE_*`).
    pub(crate) shell_move_window_id: Option<u32>,
    /// Pending delta for [`Self::shell_move_flush_pending_deltas`]. Applied from each [`Self::shell_move_delta`]
    /// (immediate flush) and from [`Self::shell_move_end`].
    pub(crate) shell_move_pending_delta: (i32, i32),
    pub(crate) shell_move_is_backed: bool,
    /// Shell-initiated interactive resize ([`shell_wire::MSG_SHELL_RESIZE_*`]).
    pub(crate) shell_resize_window_id: Option<u32>,
    pub(crate) shell_resize_edges: Option<crate::grabs::resize_grab::ResizeEdge>,
    pub(crate) shell_resize_initial_rect: Option<Rectangle<i32, Logical>>,
    pub(crate) shell_resize_accum: (f64, f64),
    pub(crate) shell_resize_shell_grab: Option<u32>,
    pub(crate) shell_resize_is_backed: bool,
    pub(crate) shell_ui_pointer_grab: Option<u32>,

    /// When [`Self::shell_ipc_stall_timeout`] is set: max gap without any shell→compositor message while connected.
    shell_ipc_stall_timeout: Option<Duration>,
    /// Last time a length-prefixed message was decoded from the shell peer.
    shell_ipc_last_rx: Option<Instant>,
    /// Last compositor ping sent (throttle while shell may reply with [`shell_wire::MSG_SHELL_PONG`]).
    pub(crate) shell_ipc_last_compositor_ping: Option<Instant>,
    pub(crate) shell_ipc_last_pong: Option<Instant>,
    pub(crate) shell_ipc_unanswered_ping_since: Option<Instant>,
    pub(crate) shell_ipc_ping_late_warned_for: Option<Instant>,
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
    pub(crate) shell_exclusion_global: Vec<Rectangle<i32, Logical>>,
    pub(crate) shell_exclusion_decor: HashMap<u32, Vec<Rectangle<i32, Logical>>>,
    pub(crate) shell_exclusion_zones_need_full_damage: bool,
    pub(crate) shell_context_menu_atlas_buffer_h: u32,
    pub(crate) shell_context_menu_overlay_id: Id,
    pub(crate) shell_context_menu: Option<ShellContextMenuPlacement>,
    pub(crate) shell_ui_windows: Vec<ShellUiWindowPlacement>,
    pub(crate) shell_ui_windows_generation: u32,
    pub(crate) shell_ui_suppress_osr_exclusion: bool,
    pub(crate) shell_focused_ui_window_id: Option<u32>,
    pub(crate) shell_last_sent_ui_focus_id: Option<u32>,
    pub(crate) shell_backed_windows:
        std::collections::HashMap<u32, crate::shell_backed::ShellBackedWindowEntry>,
    pub(crate) shell_ui_backed_placements: Vec<ShellUiWindowPlacement>,
    pub(crate) tile_preview_rect_global: Option<Rectangle<i32, Logical>>,
    pub(crate) tile_preview_solid: SolidColorBuffer,
    pub(crate) shell_chrome_titlebar_h: i32,
    pub(crate) shell_chrome_border_w: i32,

    pub(crate) desktop_background_config: crate::display_config::DesktopBackgroundConfig,
    pub(crate) desktop_background_by_output_name:
        HashMap<String, crate::display_config::DesktopBackgroundConfig>,
    wallpaper_req_tx: std::sync::mpsc::Sender<PathBuf>,
    wallpaper_done_rx: std::sync::mpsc::Receiver<
        Result<(PathBuf, crate::desktop_background::DesktopWallpaperCpu), String>,
    >,
    pub(crate) desktop_wallpaper_cpu_by_path:
        HashMap<PathBuf, Arc<crate::desktop_background::DesktopWallpaperCpu>>,
    pub(crate) desktop_wallpaper_gpu_by_path: HashMap<PathBuf, DesktopWallpaperGpuEntry>,
    wallpaper_decode_inflight: HashSet<PathBuf>,
    pub(crate) desktop_backdrop_solid: SolidColorBuffer,
    pub(crate) backdrop_wallpaper_id_cache: HashMap<String, BackdropWallpaperIdCache>,
    pub(crate) shell_begin_frame_last: Option<Instant>,
}


#[derive(Debug, Clone)]
pub struct ShellContextMenuPlacement {
    pub buffer_rect: Rectangle<i32, Buffer>,
    pub global_rect: Rectangle<i32, Logical>,
}

#[derive(Debug, Clone)]
#[derive(PartialEq, Eq)]
pub(crate) struct ShellUiWindowPlacement {
    pub id: u32,
    pub z: u32,
    pub global_rect: Rectangle<i32, Logical>,
    pub buffer_rect: Rectangle<i32, Buffer>,
}

struct KeyboardLayoutFocusOp {
    save_from: Option<u32>,
    restore_for: Option<u32>,
    shell_host: bool,
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

    pub fn stop_event_loop(&self) {
        self.event_loop_stop.store(true, Ordering::Release);
        self.loop_signal.stop();
        self.loop_signal.wakeup();
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
        let wallpaper_loader = crate::desktop_background::spawn_wallpaper_loader_thread();
        let (cursor_fallback_buffer, cursor_fallback_hotspot) = crate::cursor_fallback::load_cursor_fallback();

        let mut seat: Seat<Self> = seat_state.new_wl_seat(&dh, &options.seat_name);
        seat.add_keyboard(Default::default(), 200, 25).unwrap();
        seat.add_pointer();

        let space = Space::default();

        let socket_name = Self::init_wayland_listener(display, event_loop, &options.socket);

        let loop_signal = event_loop.get_signal();
        let event_loop_stop = Arc::new(AtomicBool::new(false));

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

        let mut s = Self {
            start_time,
            display_handle: dh,
            space,
            loop_signal,
            event_loop_stop,
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
            shell_cef_repeat_token: None,
            shell_cef_repeat_keycode: None,
            shell_cef_repeat_sym_raw: None,
            programs_menu_super_armed: false,
            programs_menu_super_chord: false,
            keyboard_layout_by_window: HashMap::new(),
            keyboard_layout_last_focus_window: None,
            keyboard_layout_focus_queue: VecDeque::new(),
            session_default_layout_index: 0,
            shell_pointer_norm: None,
            shell_last_pointer_ipc_px: None,
            // Smithay only calls `cursor_image` when focus changes; motion with focus `None` and no
            // prior surface leaves this stale — `Hidden` meant zero composited cursor on the shell/CEF path.
            pointer_cursor_image: CursorImageStatus::default_named(),
            cursor_fallback_buffer,
            cursor_fallback_hotspot,
            shell_last_non_shell_focus_window_id: None,
            focus_history_non_shell: Vec::new(),
            shell_spawn_focus_above_window_id: None,
            shell_minimized_windows: HashMap::new(),
            shell_move_window_id: None,
            shell_move_pending_delta: (0, 0),
            shell_resize_window_id: None,
            shell_resize_edges: None,
            shell_resize_initial_rect: None,
            shell_resize_accum: (0.0, 0.0),
            shell_resize_shell_grab: None,
            shell_ui_pointer_grab: None,
            shell_ipc_stall_timeout,
            shell_ipc_last_rx: None,
            shell_ipc_last_compositor_ping: None,
            shell_ipc_last_pong: None,
            shell_ipc_unanswered_ping_since: None,
            shell_ipc_ping_late_warned_for: None,
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
            shell_exclusion_global: Vec::new(),
            shell_exclusion_decor: HashMap::new(),
            shell_exclusion_zones_need_full_damage: false,
            shell_context_menu_atlas_buffer_h: 0,
            shell_context_menu_overlay_id: Id::new(),
            shell_context_menu: None,
            shell_ui_windows: Vec::new(),
            shell_ui_windows_generation: 0,
            shell_ui_suppress_osr_exclusion: false,
            shell_focused_ui_window_id: None,
            shell_last_sent_ui_focus_id: None,
            shell_backed_windows: std::collections::HashMap::new(),
            shell_ui_backed_placements: Vec::new(),
            shell_move_is_backed: false,
            shell_resize_is_backed: false,
            tile_preview_rect_global: None,
            tile_preview_solid: SolidColorBuffer::new((1, 1), Color32F::TRANSPARENT),
            shell_chrome_titlebar_h: SHELL_TITLEBAR_HEIGHT,
            shell_chrome_border_w: SHELL_BORDER_THICKNESS,
            desktop_background_config: crate::display_config::DesktopBackgroundConfig::default(),
            desktop_background_by_output_name: HashMap::new(),
            wallpaper_req_tx: wallpaper_loader.req_tx,
            wallpaper_done_rx: wallpaper_loader.done_rx,
            desktop_wallpaper_cpu_by_path: HashMap::new(),
            desktop_wallpaper_gpu_by_path: HashMap::new(),
            wallpaper_decode_inflight: HashSet::new(),
            desktop_backdrop_solid: SolidColorBuffer::new(
                (1, 1),
                Color32F::new(0.1, 0.1, 0.1, 1.0),
            ),
            backdrop_wallpaper_id_cache: HashMap::new(),
            shell_begin_frame_last: None,
        };
        crate::display_config::apply_keyboard_from_display_file(&mut s);
        crate::desktop_background::load_from_display_file_into(&mut s);
        s.session_default_layout_index = s.keyboard_layout_index_current();
        s
    }

    pub(crate) fn keyboard_clear_per_window_layout_map(&mut self) {
        self.keyboard_layout_by_window.clear();
        self.keyboard_layout_last_focus_window = None;
        self.keyboard_layout_focus_queue.clear();
    }

    pub(crate) fn apply_desktop_background_from_display_file(
        &mut self,
        cfg: &crate::display_config::DisplayConfigFile,
    ) {
        self.desktop_background_config = cfg.desktop_background.clone();
        self.desktop_background_by_output_name = cfg.desktop_background_outputs.clone();
        self.request_desktop_wallpaper_decode();
    }

    pub(crate) fn desktop_background_for_output(
        &self,
        output: &Output,
    ) -> &crate::display_config::DesktopBackgroundConfig {
        let n = output.name();
        self.desktop_background_by_output_name
            .get(&n)
            .unwrap_or(&self.desktop_background_config)
    }

    fn collect_desktop_wallpaper_paths(&self) -> HashSet<PathBuf> {
        let mut s = HashSet::new();
        let mut add = |cfg: &crate::display_config::DesktopBackgroundConfig| {
            if cfg.mode == "image" && !cfg.image_path.trim().is_empty() {
                let p = crate::desktop_background::normalize_filesystem_path(&cfg.image_path);
                if !p.as_os_str().is_empty() {
                    s.insert(p);
                }
            }
        };
        add(&self.desktop_background_config);
        for c in self.desktop_background_by_output_name.values() {
            add(c);
        }
        s
    }

    fn prune_desktop_wallpaper_paths(&mut self, needed: &HashSet<PathBuf>) {
        self.desktop_wallpaper_cpu_by_path.retain(|k, _| needed.contains(k));
        self.desktop_wallpaper_gpu_by_path.retain(|k, _| needed.contains(k));
        self.wallpaper_decode_inflight.retain(|k| needed.contains(k));
    }

    pub fn apply_shell_desktop_background_json(&mut self, json: &str) {
        #[derive(serde::Deserialize)]
        struct ShellDesktopBg {
            #[serde(flatten)]
            default: crate::display_config::DesktopBackgroundConfig,
            #[serde(default)]
            desktop_background_outputs: HashMap<String, crate::display_config::DesktopBackgroundConfig>,
        }
        let (default, outs) = match serde_json::from_str::<ShellDesktopBg>(json) {
            Ok(w) => (w.default, w.desktop_background_outputs),
            Err(_) => {
                let cfg: crate::display_config::DesktopBackgroundConfig = match serde_json::from_str(json)
                {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!(target: "derp_wallpaper", ?e, "desktop background json");
                        return;
                    }
                };
                (cfg, HashMap::new())
            }
        };
        self.desktop_background_config = default;
        self.desktop_background_by_output_name = outs;
        self.display_config_save_pending = true;
        self.shell_exclusion_zones_need_full_damage = true;
        self.shell_dmabuf_dirty_force_full = true;
        self.request_desktop_wallpaper_decode();
    }

    fn request_desktop_wallpaper_decode(&mut self) {
        let needed = self.collect_desktop_wallpaper_paths();
        self.prune_desktop_wallpaper_paths(&needed);
        if needed.is_empty() {
            self.shell_exclusion_zones_need_full_damage = true;
            return;
        }
        for p in needed {
            if self.desktop_wallpaper_cpu_by_path.contains_key(&p) {
                continue;
            }
            if self.wallpaper_decode_inflight.contains(&p) {
                continue;
            }
            if self.wallpaper_req_tx.send(p.clone()).is_ok() {
                self.wallpaper_decode_inflight.insert(p);
            }
        }
    }

    pub(crate) fn sync_desktop_wallpaper_upload(&mut self, renderer: &mut GlesRenderer) {
        use smithay::backend::allocator::Fourcc;
        use smithay::backend::renderer::ImportMem;
        while let Ok(r) = self.wallpaper_done_rx.try_recv() {
            match r {
                Ok((path, cpu)) => {
                    self.wallpaper_decode_inflight.remove(&path);
                    self.desktop_wallpaper_cpu_by_path.insert(path, Arc::new(cpu));
                }
                Err(e) => tracing::warn!(target: "derp_wallpaper", "{e}"),
            }
        }
        let needed = self.collect_desktop_wallpaper_paths();
        for path in needed {
            if self.desktop_wallpaper_gpu_by_path.contains_key(&path) {
                continue;
            }
            let Some(cpu) = self.desktop_wallpaper_cpu_by_path.get(&path) else {
                continue;
            };
            match renderer.import_memory(
                &cpu.bgra,
                Fourcc::Argb8888,
                Size::from((cpu.w, cpu.h)),
                false,
            ) {
                Ok(tex) => {
                    let ctx_id = renderer.context_id();
                    let mut commit = CommitCounter::default();
                    commit.increment();
                    self.desktop_wallpaper_gpu_by_path.insert(
                        path,
                        DesktopWallpaperGpuEntry {
                            gpu: DesktopWallpaperGpu {
                                texture: tex,
                                context_id: ctx_id,
                                tex_w: cpu.w,
                                tex_h: cpu.h,
                            },
                            commit,
                        },
                    );
                    self.shell_exclusion_zones_need_full_damage = true;
                }
                Err(e) => tracing::warn!(target: "derp_wallpaper", ?e, "wallpaper import_memory"),
            }
        }
    }

    pub fn apply_shell_tile_preview_canvas(
        &mut self,
        visible: bool,
        lx: i32,
        ly: i32,
        lw: i32,
        lh: i32,
    ) {
        if !visible || lw < 1 || lh < 1 {
            self.tile_preview_rect_global = None;
        } else if let Some((gx, gy, gw, gh)) =
            self.shell_output_local_rect_to_logical_global(lx, ly, lw, lh)
        {
            self.tile_preview_rect_global = Some(Rectangle::new(
                Point::<i32, Logical>::from((gx, gy)),
                Size::<i32, Logical>::from((gw, gh)),
            ));
        }
        self.shell_exclusion_zones_need_full_damage = true;
        self.shell_dmabuf_dirty_force_full = true;
    }

    pub fn apply_shell_chrome_metrics(&mut self, titlebar_h: i32, border_w: i32) {
        self.shell_chrome_titlebar_h = titlebar_h.clamp(0, 256);
        self.shell_chrome_border_w = border_w.clamp(0, 64);
    }

    pub(crate) fn point_in_shell_exclusion_zones(&self, pos: Point<f64, Logical>) -> bool {
        let px = pos.x;
        let py = pos.y;
        if self.shell_exclusion_global.is_empty() && self.shell_exclusion_decor.is_empty() {
            return false;
        }
        for r in &self.shell_exclusion_global {
            let x1 = r.loc.x as f64;
            let y1 = r.loc.y as f64;
            let x2 = x1 + r.size.w.max(0) as f64;
            let y2 = y1 + r.size.h.max(0) as f64;
            if px >= x1 && px < x2 && py >= y1 && py < y2 {
                return true;
            }
        }
        for rs in self.shell_exclusion_decor.values() {
            for r in rs {
                let x1 = r.loc.x as f64;
                let y1 = r.loc.y as f64;
                let x2 = x1 + r.size.w.max(0) as f64;
                let y2 = y1 + r.size.h.max(0) as f64;
                if px >= x1 && px < x2 && py >= y1 && py < y2 {
                    return true;
                }
            }
        }
        false
    }

    pub(crate) fn native_hit_blocked_by_shell_exclusion(
        &self,
        _elem: &DerpSpaceElem,
        pos: Point<f64, Logical>,
    ) -> bool {
        self.point_in_shell_exclusion_zones(pos) || self.shell_ui_topmost_at(pos).is_some()
    }

    pub(crate) fn native_hit_blocked_exclusion_only(
        &self,
        _elem: &DerpSpaceElem,
        pos: Point<f64, Logical>,
    ) -> bool {
        self.point_in_shell_exclusion_zones(pos)
    }

    pub(crate) fn surface_under_bypassing_shell_ui_overlay(
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
            if self.native_hit_blocked_exclusion_only(elem, pos) {
                continue;
            }
            return Some((surf, p_global));
        }
        None
    }

    pub(crate) fn shell_ui_placement_topmost_at(&self, pos: Point<f64, Logical>) -> Option<&ShellUiWindowPlacement> {
        let px = pos.x;
        let py = pos.y;
        let mut best: Option<&ShellUiWindowPlacement> = None;
        let mut best_z = 0u32;
        for w in self
            .shell_ui_backed_placements
            .iter()
            .chain(self.shell_ui_windows.iter())
        {
            let g = &w.global_rect;
            let x2 = g.loc.x.saturating_add(g.size.w) as f64;
            let y2 = g.loc.y.saturating_add(g.size.h) as f64;
            if px >= g.loc.x as f64 && px < x2 && py >= g.loc.y as f64 && py < y2 {
                if best.is_none() || w.z >= best_z {
                    best_z = w.z;
                    best = Some(w);
                }
            }
        }
        best
    }

    pub(crate) fn shell_ui_topmost_at(&self, pos: Point<f64, Logical>) -> Option<&ShellUiWindowPlacement> {
        if self.shell_ui_suppress_osr_exclusion {
            return None;
        }
        self.shell_ui_placement_topmost_at(pos)
    }

    pub(crate) fn shell_global_rect_to_buffer_rect(
        &self,
        global: &Rectangle<i32, Logical>,
    ) -> Option<Rectangle<i32, Buffer>> {
        let (buf_w, buf_h) = self.shell_view_px?;
        let content_h = buf_h.saturating_sub(self.shell_context_menu_atlas_buffer_h).max(1);
        let (lw_u, lh_u) = self.shell_output_logical_size()?;
        let lw = lw_u as i32;
        let lh = lh_u as i32;
        let (ox, oy, cw_l, ch_l) = crate::shell_letterbox::letterbox_logical(
            Size::from((lw, lh)),
            buf_w,
            content_h,
        )?;
        let ws = self.workspace_logical_bounds()?;
        let g = global.intersection(ws)?;
        if g.size.w < 1 || g.size.h < 1 {
            return None;
        }
        let wf = g.size.w.max(1) as f64;
        let hf = g.size.h.max(1) as f64;
        let wsf = ws.size.w.max(1) as f64;
        let hsf = ws.size.h.max(1) as f64;
        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut max_x = i32::MIN;
        let mut max_y = i32::MIN;
        let mut any = false;
        for k in 0..4u8 {
            let gx = g.loc.x as f64 + if (k & 1) == 0 { 0.25 } else { wf - 0.25 };
            let gy = g.loc.y as f64 + if (k & 2) == 0 { 0.25 } else { hf - 0.25 };
            let nx = ((gx - ws.loc.x as f64) / wsf).clamp(0.0, 1.0);
            let ny = ((gy - ws.loc.y as f64) / hsf).clamp(0.0, 1.0);
            let lx = nx * lw as f64 - ox as f64;
            let ly = ny * lh as f64 - oy as f64;
            if let Some((bx, by)) = crate::shell_letterbox::local_in_letterbox_to_buffer_px(
                lx, ly, cw_l, ch_l, buf_w, content_h,
            ) {
                any = true;
                min_x = min_x.min(bx);
                min_y = min_y.min(by);
                max_x = max_x.max(bx);
                max_y = max_y.max(by);
            }
        }
        if !any {
            return None;
        }
        Some(Rectangle::from_loc_and_size(
            Point::new(min_x, min_y),
            Size::new(
                (max_x - min_x + 1).max(1),
                (max_y - min_y + 1).max(1),
            ),
        ))
    }

    pub fn apply_shell_ui_windows_json(&mut self, json: &str) {
        const MAX: usize = shell_wire::MAX_SHELL_UI_WINDOWS as usize;
        #[derive(serde::Deserialize)]
        struct Row {
            id: u32,
            gx: i32,
            gy: i32,
            gw: i32,
            gh: i32,
            z: u32,
            #[serde(default)]
            flags: u32,
        }
        #[derive(serde::Deserialize)]
        struct Root {
            generation: u32,
            windows: Vec<Row>,
            #[serde(default)]
            suppress_osr_exclusion: bool,
        }
        let Ok(root) = serde_json::from_str::<Root>(json) else {
            return;
        };
        let Some(ws) = self.workspace_logical_bounds() else {
            self.shell_ui_windows.clear();
            return;
        };
        let mut rows: Vec<_> = root
            .windows
            .into_iter()
            .filter(|r| r.id > 0 && r.gw > 0 && r.gh > 0)
            .collect();
        rows.sort_by(|a, b| a.z.cmp(&b.z).then_with(|| a.id.cmp(&b.id)));
        let mut out = Vec::new();
        for e in rows.into_iter().take(MAX) {
            let gr = Rectangle::new(
                Point::<i32, Logical>::from((e.gx, e.gy)),
                Size::<i32, Logical>::from((e.gw.max(1), e.gh.max(1))),
            );
            let Some(clamped) = gr.intersection(ws) else {
                continue;
            };
            let Some(br) = self.shell_global_rect_to_buffer_rect(&clamped) else {
                continue;
            };
            out.push(ShellUiWindowPlacement {
                id: e.id,
                z: e.z,
                global_rect: clamped,
                buffer_rect: br,
            });
        }
        let js_changed = out != self.shell_ui_windows;
        let suppress_changed = root.suppress_osr_exclusion != self.shell_ui_suppress_osr_exclusion;
        self.shell_ui_windows = out;
        self.shell_ui_windows_generation = root.generation;
        self.shell_ui_suppress_osr_exclusion = root.suppress_osr_exclusion;
        if let Some(fid) = self.shell_focused_ui_window_id {
            if !self.shell_ui_windows.iter().any(|w| w.id == fid)
                && !self.shell_backed_windows.contains_key(&fid)
            {
                self.shell_emit_shell_ui_focus_if_changed(None);
            }
        }
        if let Some(gid) = self.shell_ui_pointer_grab {
            if !self.shell_ui_windows.iter().any(|w| w.id == gid)
                && !self.shell_backed_windows.contains_key(&gid)
            {
                self.shell_ui_pointer_grab = None;
            }
        }
        self.shell_backed_refresh_placements();
        if js_changed || suppress_changed {
            self.shell_exclusion_zones_need_full_damage = true;
        }
    }

    pub(crate) fn shell_emit_shell_ui_focus_if_changed(&mut self, id: Option<u32>) {
        self.shell_focused_ui_window_id = id;
        if id == self.shell_last_sent_ui_focus_id {
            return;
        }
        self.shell_last_sent_ui_focus_id = id;
        let (surface_id, window_id) = match id {
            None => (None, None),
            Some(w) => (Some(w), Some(w)),
        };
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id,
            window_id,
        });
        self.shell_backed_refresh_placements();
    }

    pub(crate) fn shell_emit_shell_ui_focus_from_point(&mut self, pos: Point<f64, Logical>) {
        if self.shell_point_in_context_menu_global(pos) {
            self.shell_emit_shell_ui_focus_if_changed(None);
            return;
        }
        let id = self.shell_ui_placement_topmost_at(pos).map(|w| w.id);
        self.shell_emit_shell_ui_focus_if_changed(id);
    }

    pub(crate) fn shell_ui_pointer_grab_begin(&mut self, window_id: u32) {
        if window_id == 0 {
            return;
        }
        self.shell_ui_pointer_grab = Some(window_id);
    }

    pub(crate) fn shell_ui_pointer_grab_end(&mut self) {
        self.shell_ui_pointer_grab = None;
    }

    pub(crate) fn shell_ui_pointer_grab_active(&self) -> bool {
        self.shell_ui_pointer_grab.is_some()
    }

    pub(crate) fn shell_focus_shell_ui_window(&mut self, window_id: u32) {
        if window_id == 0 {
            return;
        }
        if !self.shell_ui_windows.iter().any(|w| w.id == window_id)
            && !self.shell_backed_windows.contains_key(&window_id)
        {
            return;
        }
        let k_serial = SERIAL_COUNTER.next_serial();
        self.space.elements().for_each(|e| {
            e.set_activate(false);
            if let DerpSpaceElem::Wayland(w) = e {
                w.toplevel().unwrap().send_pending_configure();
            }
        });
        self.seat
            .get_keyboard()
            .unwrap()
            .set_focus(self, Option::<WlSurface>::None, k_serial);
        self.keyboard_on_focus_surface_changed(None);
        self.shell_ipc_keyboard_to_cef = true;
        self.shell_emit_shell_ui_focus_if_changed(Some(window_id));
    }

    pub(crate) fn shell_blur_shell_ui_focus(&mut self) {
        self.shell_ui_pointer_grab = None;
        self.shell_emit_shell_ui_focus_if_changed(None);
        self.shell_ipc_keyboard_to_cef = false;
        if let Some(target) = self.pick_next_focus_target() {
            self.shell_raise_and_focus_window(target);
        } else {
            let k_serial = SERIAL_COUNTER.next_serial();
            self.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Option::<WlSurface>::None, k_serial);
            self.keyboard_on_focus_surface_changed(None);
        }
    }

    pub fn apply_shell_exclusion_zones_json(&mut self, json: &str) {
        pub const MAX_SHELL_EXCLUSION_ZONES: usize = 128;
        #[derive(serde::Deserialize)]
        struct EzRect {
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            #[serde(default)]
            window_id: Option<u32>,
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
            self.shell_exclusion_global.clear();
            self.shell_exclusion_decor.clear();
            self.shell_exclusion_zones_need_full_damage = true;
            self.shell_dmabuf_dirty_force_full = true;
            return;
        };
        let mut next_global: Vec<Rectangle<i32, Logical>> = Vec::new();
        let mut next_decor: HashMap<u32, Vec<Rectangle<i32, Logical>>> = HashMap::new();
        let mut used = 0usize;
        for e in root.rects {
            if used >= MAX_SHELL_EXCLUSION_ZONES {
                break;
            }
            let w = e.w.max(1);
            let h = e.h.max(1);
            let r = Rectangle::new(
                Point::<i32, Logical>::from((e.x, e.y)),
                Size::<i32, Logical>::from((w, h)),
            );
            let Some(clamped) = r.intersection(ws) else {
                continue;
            };
            used += 1;
            match e.window_id.filter(|&id| id > 0) {
                None => next_global.push(clamped),
                Some(id) => next_decor.entry(id).or_default().push(clamped),
            }
        }
        let changed =
            next_global != self.shell_exclusion_global || next_decor != self.shell_exclusion_decor;
        self.shell_exclusion_global = next_global;
        self.shell_exclusion_decor = next_decor;
        if changed {
            self.shell_exclusion_zones_need_full_damage = true;
            self.shell_dmabuf_dirty_force_full = true;
        }
    }

    pub(crate) fn derp_elem_window_id(&self, elem: &DerpSpaceElem) -> Option<u32> {
        match elem {
            DerpSpaceElem::Wayland(w) => w
                .toplevel()
                .and_then(|t| self.window_registry.window_id_for_wl_surface(t.wl_surface())),
            DerpSpaceElem::X11(x) => x
                .wl_surface()
                .as_ref()
                .and_then(|s| self.window_registry.window_id_for_wl_surface(s)),
        }
    }

    fn window_ids_strictly_above_on_output(&self, output: &Output, self_id: u32) -> Vec<u32> {
        let stack: Vec<u32> = self
            .space
            .elements_for_output(output)
            .filter_map(|e| self.derp_elem_window_id(e))
            .collect();
        let Some(idx) = stack.iter().position(|&id| id == self_id) else {
            return Vec::new();
        };
        stack[(idx + 1)..].to_vec()
    }

    pub(crate) fn shell_exclusion_clip_rects_logical(
        &self,
        output: &Output,
        elem_window: Option<u32>,
    ) -> Vec<Rectangle<i32, Logical>> {
        let Some(ws) = self.workspace_logical_bounds() else {
            return Vec::new();
        };
        let mut out: Vec<Rectangle<i32, Logical>> = self
            .shell_exclusion_global
            .iter()
            .filter_map(|z| z.intersection(ws))
            .collect();
        match elem_window {
            None => {
                for rs in self.shell_exclusion_decor.values() {
                    for r in rs {
                        if let Some(i) = r.intersection(ws) {
                            out.push(i);
                        }
                    }
                }
            }
            Some(self_id) => {
                for ow in self.window_ids_strictly_above_on_output(output, self_id) {
                    if let Some(rs) = self.shell_exclusion_decor.get(&ow) {
                        for r in rs {
                            if let Some(i) = r.intersection(ws) {
                                out.push(i);
                            }
                        }
                    }
                }
                if let Some(rs) = self.shell_exclusion_decor.get(&self_id) {
                    for r in rs {
                        if let Some(i) = r.intersection(ws) {
                            out.push(i);
                        }
                    }
                }
            }
        }
        if !self.shell_ui_suppress_osr_exclusion {
            for w in self
                .shell_ui_backed_placements
                .iter()
                .chain(self.shell_ui_windows.iter())
            {
                if let Some(i) = w.global_rect.intersection(ws) {
                    out.push(i);
                }
            }
        }
        out
    }

    pub(crate) fn shell_exclusion_clip_ctx_for_draw(
        &self,
        output: &Output,
        elem_window: Option<u32>,
    ) -> Option<Arc<exclusion_clip::ShellExclusionClipCtx>> {
        let zones = self.shell_exclusion_clip_rects_logical(output, elem_window);
        if zones.is_empty() {
            return None;
        }
        let Some(out_geo) = self.space.output_geometry(output) else {
            return None;
        };
        let Some(ws) = self.workspace_logical_bounds() else {
            return None;
        };
        let filtered: Vec<Rectangle<i32, Logical>> =
            zones.iter().filter_map(|z| z.intersection(ws)).collect();
        if filtered.is_empty() {
            return None;
        }
        Some(Arc::new(exclusion_clip::ShellExclusionClipCtx {
            zones: Arc::from(filtered.into_boxed_slice()),
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

    pub(crate) fn shell_nudge_cef_repaint(&self) {
        let Ok(g) = self.shell_to_cef.lock() else {
            tracing::warn!(target: "derp_hotplug_shell", "shell_nudge_cef_repaint shell_to_cef lock poisoned");
            return;
        };
        if let Some(link) = g.as_ref() {
            link.schedule_external_begin_frame();
            link.schedule_external_begin_frame();
        } else {
            tracing::warn!(target: "derp_hotplug_shell", "shell_nudge_cef_repaint no ShellToCefLink");
        }
    }

    pub(crate) fn programs_menu_toggle_from_super(&mut self, serial: Serial) {
        tracing::debug!(target: "derp_shell_menu", "programs_menu_toggle_from_super");
        self.space.elements().for_each(|e| {
            e.set_activate(false);
            if let DerpSpaceElem::Wayland(w) = e {
                w.toplevel().unwrap().send_pending_configure();
            }
        });
        let keyboard = self.seat.get_keyboard().unwrap();
        keyboard.set_focus(self, Option::<WlSurface>::None, serial);
        self.keyboard_on_focus_surface_changed(None);
        self.shell_ipc_keyboard_to_cef = true;
        self.shell_emit_shell_ui_focus_if_changed(None);
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::ProgramsMenuToggle);
    }

    pub(crate) fn shell_send_keybind(&mut self, action: &str) {
        self.shell_send_keybind_ex(action, None);
    }

    pub(crate) fn shell_send_keybind_ex(&mut self, action: &str, target_window_id: Option<u32>) {
        self.shell_emit_chrome_event(ChromeEvent::Keybind {
            action: action.to_string(),
            target_window_id,
        });
    }

    fn super_keybind_target_window_id(&self) -> Option<u32> {
        if let Some(wid) = self.keyboard_focused_window_id() {
            if let Some(info) = self.window_registry.window_info(wid) {
                if !self.window_info_is_solid_shell_host(&info) {
                    return Some(wid);
                }
            }
        }
        self.shell_last_non_shell_focus_window_id
    }

    pub(crate) fn shell_consider_focus_spawned_toplevel(&mut self, window_id: u32) {
        let Some(th) = self.shell_spawn_focus_above_window_id else {
            return;
        };
        if window_id <= th {
            return;
        }
        let Some(info) = self.window_registry.window_info(window_id) else {
            self.shell_spawn_focus_above_window_id = None;
            return;
        };
        if self.window_info_is_solid_shell_host(&info) || !shell_window_row_should_show(&info) {
            return;
        }
        self.shell_spawn_focus_above_window_id = None;
        self.shell_raise_and_focus_window(window_id);
    }

    pub(crate) fn handle_super_keybind(&mut self, action: &str) {
        match action {
            "close_focused" => {
                if let Some(wid) = self.super_keybind_target_window_id() {
                    self.shell_close_window(wid);
                }
            }
            "toggle_fullscreen" => {
                if let Some(wid) = self.super_keybind_target_window_id() {
                    let Some(sid) = self.window_registry.surface_id_for_window(wid) else {
                        return;
                    };
                    let Some(window) = self.find_window_by_surface_id(sid) else {
                        return;
                    };
                    let wl = window.toplevel().unwrap().wl_surface();
                    let fs = read_toplevel_tiling(wl).1;
                    self.shell_set_window_fullscreen(wid, !fs);
                }
            }
            "toggle_maximize" => {
                self.shell_send_keybind_ex(
                    "toggle_maximize",
                    self.super_keybind_target_window_id(),
                );
            }
            "launch_terminal"
            | "toggle_programs_menu"
            | "open_settings"
            | "tile_left"
            | "tile_right"
            | "tile_up"
            | "tile_down"
            | "move_monitor_left"
            | "move_monitor_right" => self.shell_send_keybind(action),
            "cycle_keyboard_layout" => self.keyboard_cycle_layout_for_shortcut(),
            _ => {}
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
            Err(e) => tracing::warn!(target: "derp_hotplug_shell", ?e, "shell dma-buf frame rejected"),
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
        let mut best = 1.0f64;
        let mut hit = false;
        for o in self.space.outputs() {
            let Some(geo) = self.space.output_geometry(o) else {
                continue;
            };
            let Some(ix) = geo.intersection(bbox) else {
                continue;
            };
            if ix.size.w > 0 && ix.size.h > 0 {
                hit = true;
                best = best.max(o.current_scale().fractional_scale());
            }
        }
        if hit { best } else { fallback() }
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

    fn new_toplevel_placement_output(&self, parent_wl: Option<&WlSurface>) -> Option<Output> {
        if let Some(pw) = parent_wl {
            if let Some(w) = self.space.elements().find_map(|e| {
                if let DerpSpaceElem::Wayland(w) = e {
                    w.toplevel()
                        .filter(|t| t.wl_surface() == pw)
                        .map(|_| w.clone())
                } else {
                    None
                }
            }) {
                let elem = DerpSpaceElem::Wayland(w.clone());
                if let Some(loc) = self.space.element_location(&elem) {
                    let sz = w.geometry().size;
                    let ww = sz.w.max(1);
                    let hh = sz.h.max(1);
                    if let Some(o) = self.output_for_global_xywh(loc.x, loc.y, ww, hh) {
                        return Some(o);
                    }
                }
            }
        }
        if let Some(ptr) = self.seat.get_pointer() {
            if let Some(out) = self.output_containing_global_point(ptr.current_location()) {
                return Some(out);
            }
        }
        if let Some(out) = self.shell_effective_primary_output() {
            return Some(out);
        }
        self.leftmost_output()
    }

    fn element_top_left_occupied(&self, x: i32, y: i32) -> bool {
        self.space.elements().any(|e| {
            self.space
                .element_location(e)
                .is_some_and(|loc| loc.x == x && loc.y == y)
        })
    }

    pub fn new_toplevel_initial_location(
        &self,
        window: &Window,
        parent_wl: Option<&WlSurface>,
    ) -> (i32, i32) {
        let Some(out) = self.new_toplevel_placement_output(parent_wl) else {
            return (DEFAULT_XDG_TOPLEVEL_OFFSET_X, DEFAULT_XDG_TOPLEVEL_OFFSET_Y);
        };
        let Some(work) = self.shell_maximize_work_area_global_for_output(&out) else {
            return (DEFAULT_XDG_TOPLEVEL_OFFSET_X, DEFAULT_XDG_TOPLEVEL_OFFSET_Y);
        };

        let geo = window.geometry().size;
        let bbox = window.bbox().size;
        let (ww, hh) = if geo.w > 0 && geo.h > 0 {
            (geo.w, geo.h)
        } else if bbox.w > 0 && bbox.h > 0 {
            (bbox.w, bbox.h)
        } else {
            (800, 600)
        };

        let max_x = work
            .loc
            .x
            .saturating_add(work.size.w)
            .saturating_sub(ww);
        let max_y = work
            .loc
            .y
            .saturating_add(work.size.h)
            .saturating_sub(hh);

        let mut x = work
            .loc
            .x
            .saturating_add(work.size.w.saturating_sub(ww) / 2);
        let mut y = work
            .loc
            .y
            .saturating_add(work.size.h.saturating_sub(hh) / 2);

        x = x.clamp(work.loc.x, max_x.max(work.loc.x));
        y = y.clamp(work.loc.y, max_y.max(work.loc.y));

        let step = DEFAULT_XDG_TOPLEVEL_CASCADE_STEP;
        for _ in 0..64 {
            if !self.element_top_left_occupied(x, y) {
                break;
            }
            x = x.saturating_add(step);
            y = y.saturating_add(step);
            x = x.clamp(work.loc.x, max_x.max(work.loc.x));
            y = y.clamp(work.loc.y, max_y.max(work.loc.y));
        }

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

    fn keyboard_layout_should_track_window(&self, wid: u32) -> bool {
        self.window_registry
            .window_info(wid)
            .map(|i| !self.window_info_is_solid_shell_host(&i))
            .unwrap_or(false)
    }

    pub(crate) fn keyboard_layout_index_current(&mut self) -> u32 {
        let kbd = self.seat.get_keyboard().unwrap();
        kbd.with_xkb_state(self, |ctx| {
            let xkb = ctx.xkb().lock().unwrap();
            xkb.active_layout().0
        })
    }

    fn keyboard_layout_set_index(&mut self, idx: u32) {
        let Some(kbd) = self.seat.get_keyboard() else {
            return;
        };
        kbd.with_xkb_state(self, |mut ctx| {
            let nl = {
                let xkb = ctx.xkb().lock().unwrap();
                xkb.layouts().count()
            };
            if nl == 0 {
                return;
            }
            let max_v = u32::try_from(nl.saturating_sub(1)).unwrap_or(u32::MAX);
            let li = idx.min(max_v);
            ctx.set_layout(Layout(li));
        });
    }

    fn keyboard_layout_active_name_raw(&mut self) -> String {
        let kbd = self.seat.get_keyboard().unwrap();
        kbd.with_xkb_state(self, |ctx| {
            let xkb = ctx.xkb().lock().unwrap();
            let layout = xkb.active_layout();
            xkb.layout_name(layout).to_string()
        })
    }

    fn keyboard_layout_label_short(name: &str) -> String {
        let s = name.split_whitespace().next().unwrap_or(name);
        let s = s
            .find('(')
            .map(|i| s[..i].trim_end())
            .unwrap_or(s);
        let mut out: String = s.chars().take(12).collect();
        if out.is_empty() {
            out.push('?');
        }
        out.make_ascii_uppercase();
        let max = shell_wire::MAX_KEYBOARD_LAYOUT_LABEL_BYTES as usize;
        while out.len() > max {
            out.pop();
        }
        out
    }

    pub(crate) fn emit_keyboard_layout_to_shell(&mut self) {
        let raw = self.keyboard_layout_active_name_raw();
        let label = Self::keyboard_layout_label_short(&raw);
        self.shell_emit_chrome_event(ChromeEvent::KeyboardLayout { label });
    }

    pub(crate) fn keyboard_on_focus_surface_changed(&mut self, focused: Option<&WlSurface>) {
        let new_wid = focused.and_then(|s| self.window_registry.window_id_for_wl_surface(s));
        let shell_host = new_wid
            .and_then(|w| self.window_registry.window_info(w))
            .map(|i| self.window_info_is_solid_shell_host(&i))
            .unwrap_or(false);
        let prev = self.keyboard_layout_last_focus_window.take();
        let save_from = prev.filter(|&w| self.keyboard_layout_should_track_window(w));
        let restore_for = new_wid.filter(|&w| self.keyboard_layout_should_track_window(w));
        self.keyboard_layout_last_focus_window = if restore_for.is_some() {
            new_wid
        } else {
            None
        };
        self.keyboard_layout_focus_queue.push_back(KeyboardLayoutFocusOp {
            save_from,
            restore_for,
            shell_host,
        });
        let tx = self.cef_to_compositor_tx.clone();
        let _ = tx.send(crate::cef::compositor_tx::CefToCompositor::Run(Box::new(|state| {
            state.keyboard_drain_focus_layout_queue();
        })));
    }

    fn keyboard_drain_focus_layout_queue(&mut self) {
        while let Some(op) = self.keyboard_layout_focus_queue.pop_front() {
            if let Some(w) = op.save_from {
                let idx = self.keyboard_layout_index_current();
                self.keyboard_layout_by_window.insert(w, idx);
            }
            if let Some(w) = op.restore_for {
                let idx = self
                    .keyboard_layout_by_window
                    .get(&w)
                    .copied()
                    .unwrap_or(self.session_default_layout_index);
                self.keyboard_layout_set_index(idx);
            } else if op.shell_host || op.save_from.is_some() {
                self.keyboard_layout_set_index(self.session_default_layout_index);
            }
            self.emit_keyboard_layout_to_shell();
        }
    }

    pub(crate) fn keyboard_cycle_layout_for_shortcut(&mut self) {
        let Some(kbd) = self.seat.get_keyboard() else {
            return;
        };
        let idx = kbd.with_xkb_state(self, |mut ctx| {
            ctx.cycle_next_layout();
            let xkb = ctx.xkb().lock().unwrap();
            xkb.active_layout().0
        });
        if let Some(wid) = self.keyboard_focused_window_id() {
            if self.keyboard_layout_should_track_window(wid) {
                self.keyboard_layout_by_window.insert(wid, idx);
            }
        }
        self.emit_keyboard_layout_to_shell();
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
            let spawn_focus_wid = info.window_id;
            self.shell_emit_chrome_event(ChromeEvent::WindowMapped { info });
            self.shell_consider_focus_spawned_toplevel(spawn_focus_wid);
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
        let output_name = self
            .output_for_window_position(gx, gy, gw, gh)
            .unwrap_or_default();
        let changed = self
            .window_registry
            .set_shell_layout(wl, gx, gy, gw, gh, csd, output_name);
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
    }

    fn sync_registry_from_space_for_wayland(&mut self, window: &Window) {
        let Some(toplevel) = window.toplevel() else {
            return;
        };
        let wl = toplevel.wl_surface();
        let Some((gx, gy, gw, gh, csd)) = self.wayland_window_shell_rect_and_deco(window) else {
            return;
        };
        let output_name = self
            .output_for_window_position(gx, gy, gw, gh)
            .unwrap_or_default();
        let _ = self.window_registry.set_shell_layout(wl, gx, gy, gw, gh, csd, output_name);
        let (max, fs) = read_toplevel_tiling(wl);
        let _ = self.window_registry.set_tiling_state(wl, max, fs);
    }

    pub(crate) fn resync_wayland_window_registry_from_space(&mut self) {
        let wins: Vec<Window> = self
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
        for w in wins {
            self.sync_registry_from_space_for_wayland(&w);
        }
    }

    pub(crate) fn cancel_shell_move_resize_for_window(&mut self, window_id: u32) {
        if self.shell_move_window_id == Some(window_id) {
            if self.shell_move_is_backed {
                self.shell_move_end_backed_only(window_id);
            } else {
                self.shell_move_end(window_id);
            }
        }
        if self.shell_resize_window_id == Some(window_id) {
            if self.shell_resize_is_backed {
                self.shell_resize_end_backed_only(window_id);
            } else {
                self.shell_resize_end(window_id);
            }
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

    pub(crate) fn shell_maximize_work_area_global_for_output(
        &self,
        output: &Output,
    ) -> Option<Rectangle<i32, Logical>> {
        let g = self.space.output_geometry(output)?;
        let th = self.shell_chrome_titlebar_h.max(0);
        let tb = SHELL_TASKBAR_RESERVE_PX;
        let h = g.size.h.saturating_sub(th).saturating_sub(tb).max(1);
        let w = g.size.w.max(1);
        Some(Rectangle::new(
            Point::from((g.loc.x, g.loc.y.saturating_add(th))),
            Size::from((w, h)),
        ))
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
            let Some(g) = self.shell_maximize_work_area_global_for_output(out) else {
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
        let (x, y) = self.new_toplevel_initial_location(window, tl.parent().as_ref());
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
            let (x, y) = self.new_toplevel_initial_location(window, tl.parent().as_ref());
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
            output_name: info.output_name.clone(),
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
            ChromeEvent::Keybind { .. } | ChromeEvent::KeyboardLayout { .. } => false,
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
        self.keyboard_layout_by_window.remove(&window_id);
        if self.keyboard_layout_last_focus_window == Some(window_id) {
            self.keyboard_layout_last_focus_window = None;
        }
        let hint = removed_info.as_ref();
        self.shell_emit_chrome_event_inner(
            ChromeEvent::WindowUnmapped { window_id },
            hint,
        );
    }

    /// When title/app_id becomes that of the Solid host after an earlier map with empty metadata, retract the phantom HUD entry.
    pub(crate) fn shell_retract_phantom_shell_window(&mut self, window_id: u32) {
        self.keyboard_layout_by_window.remove(&window_id);
        if self.keyboard_layout_last_focus_window == Some(window_id) {
            self.keyboard_layout_last_focus_window = None;
        }
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
        if self.display_config_save_suppressed {
            if self.workspace_logical_bounds().is_some() {
                self.recompute_shell_canvas_from_outputs();
            }
            return;
        }
        self.send_shell_output_layout();
        self.display_config_request_save();
    }

    pub(crate) fn display_config_request_save(&mut self) {
        if !self.display_config_save_suppressed {
            self.display_config_save_pending = true;
        }
    }

    pub(crate) fn normalize_workspace_to_origin_after_output_removed(&mut self) {
        let Some(ws) = self.workspace_logical_bounds() else {
            return;
        };
        let dx = -ws.loc.x;
        let dy = -ws.loc.y;
        if dx == 0 && dy == 0 {
            return;
        }
        let elem_targets: Vec<(DerpSpaceElem, i32, i32)> = self
            .space
            .elements()
            .filter_map(|e| {
                let loc = self.space.element_location(e)?;
                Some((
                    e.clone(),
                    loc.x.saturating_add(dx),
                    loc.y.saturating_add(dy),
                ))
            })
            .collect();
        let outs: Vec<Output> = self.space.outputs().cloned().collect();
        let sc = Self::wayland_scale_for_shell_ui(self.shell_ui_scale);
        for out in outs.iter() {
            let Some(g) = self.space.output_geometry(out) else {
                continue;
            };
            let Some(mode) = out.current_mode() else {
                continue;
            };
            let tf = out.current_transform();
            let nx = g.loc.x.saturating_add(dx);
            let ny = g.loc.y.saturating_add(dy);
            out.change_current_state(
                Some(mode),
                Some(tf),
                Some(sc),
                Some((nx, ny).into()),
            );
            self.space.map_output(out, (nx, ny));
        }
        for (elem, nx, ny) in elem_targets {
            match elem {
                DerpSpaceElem::Wayland(w) => {
                    self.space
                        .map_element(DerpSpaceElem::Wayland(w.clone()), (nx, ny), true);
                    self.notify_geometry_for_window(&w, true);
                }
                DerpSpaceElem::X11(x) => {
                    let mut geo = x.geometry();
                    geo.loc.x = nx;
                    geo.loc.y = ny;
                    let _ = x.configure(Some(geo));
                    self.space
                        .map_element(DerpSpaceElem::X11(x.clone()), (nx, ny), false);
                }
            }
        }
        self.loop_signal.wakeup();
    }

    pub(crate) fn translate_workspace_by(&mut self, dx: i32, dy: i32) {
        if dx == 0 && dy == 0 {
            return;
        }
        let elem_targets: Vec<(DerpSpaceElem, i32, i32)> = self
            .space
            .elements()
            .filter_map(|e| {
                let loc = self.space.element_location(e)?;
                Some((
                    e.clone(),
                    loc.x.saturating_add(dx),
                    loc.y.saturating_add(dy),
                ))
            })
            .collect();
        let outs: Vec<Output> = self.space.outputs().cloned().collect();
        let sc = Self::wayland_scale_for_shell_ui(self.shell_ui_scale);
        for out in outs.iter() {
            let Some(g) = self.space.output_geometry(out) else {
                continue;
            };
            let Some(mode) = out.current_mode() else {
                continue;
            };
            let tf = out.current_transform();
            let nx = g.loc.x.saturating_add(dx);
            let ny = g.loc.y.saturating_add(dy);
            out.change_current_state(
                Some(mode),
                Some(tf),
                Some(sc),
                Some((nx, ny).into()),
            );
            self.space.map_output(out, (nx, ny));
        }
        for (elem, nx, ny) in elem_targets {
            match elem {
                DerpSpaceElem::Wayland(w) => {
                    self.space
                        .map_element(DerpSpaceElem::Wayland(w.clone()), (nx, ny), true);
                    self.notify_geometry_for_window(&w, true);
                }
                DerpSpaceElem::X11(x) => {
                    let mut geo = x.geometry();
                    geo.loc.x = nx;
                    geo.loc.y = ny;
                    let _ = x.configure(Some(geo));
                    self.space
                        .map_element(DerpSpaceElem::X11(x.clone()), (nx, ny), false);
                }
            }
        }
        self.loop_signal.wakeup();
    }

    pub(crate) fn recompute_shell_canvas_from_outputs(&mut self) {
        let prev_origin = self.shell_canvas_logical_origin;
        let prev_size = self.shell_canvas_logical_size;
        let prev_phys = self.shell_window_physical_px;
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
        if prev_origin != self.shell_canvas_logical_origin
            || prev_size != self.shell_canvas_logical_size
            || prev_phys != self.shell_window_physical_px
        {
            tracing::warn!(
                target: "derp_hotplug_shell",
                prev_origin = ?prev_origin,
                prev_size = ?prev_size,
                prev_phys = ?prev_phys,
                origin = ?self.shell_canvas_logical_origin,
                size = ?self.shell_canvas_logical_size,
                phys = ?self.shell_window_physical_px,
                "recompute_shell_canvas_from_outputs canvas changed clear_shell_frame"
            );
            self.clear_shell_frame();
            self.shell_nudge_cef_repaint();
        }
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

    pub(crate) fn output_for_window_position(
        &self,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> Option<String> {
        let cx = x.saturating_add(w.saturating_div(2));
        let cy = y.saturating_add(h.saturating_div(2));
        let mut first: Option<String> = None;
        for o in self.space.outputs() {
            if first.is_none() {
                first = Some(o.name().into());
            }
            let Some(g) = self.space.output_geometry(o) else {
                continue;
            };
            if cx >= g.loc.x
                && cy >= g.loc.y
                && cx < g.loc.x.saturating_add(g.size.w)
                && cy < g.loc.y.saturating_add(g.size.h)
            {
                return Some(o.name().into());
            }
        }
        first
    }

    fn snapshot_output_geometry_by_name(&self) -> HashMap<String, Rectangle<i32, Logical>> {
        let mut m = HashMap::new();
        for o in self.space.outputs() {
            if let Some(g) = self.space.output_geometry(o) {
                m.insert(o.name().into(), g);
            }
        }
        m
    }

    fn output_name_for_window_from_geometry_map(
        geos: &HashMap<String, Rectangle<i32, Logical>>,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> Option<String> {
        if geos.is_empty() {
            return None;
        }
        let cx = x.saturating_add(w.saturating_div(2));
        let cy = y.saturating_add(h.saturating_div(2));
        for (name, g) in geos {
            if cx >= g.loc.x
                && cy >= g.loc.y
                && cx < g.loc.x.saturating_add(g.size.w)
                && cy < g.loc.y.saturating_add(g.size.h)
            {
                return Some(name.clone());
            }
        }
        let mut pairs: Vec<(i32, String)> = geos
            .iter()
            .map(|(n, g)| (g.loc.x, n.clone()))
            .collect();
        pairs.sort_by_key(|(px, _)| *px);
        pairs.into_iter().next().map(|(_, n)| n)
    }

    fn shift_mapped_toplevels_for_output_moves(
        &mut self,
        before_outputs: &HashMap<String, Rectangle<i32, Logical>>,
    ) {
        if before_outputs.is_empty() {
            return;
        }
        let mut deltas: HashMap<String, (i32, i32)> = HashMap::new();
        for o in self.space.outputs() {
            let name: String = o.name().into();
            let Some(bg) = before_outputs.get(&name) else {
                continue;
            };
            let Some(ag) = self.space.output_geometry(o) else {
                continue;
            };
            let dx = ag.loc.x.saturating_sub(bg.loc.x);
            let dy = ag.loc.y.saturating_sub(bg.loc.y);
            if dx != 0 || dy != 0 {
                deltas.insert(name, (dx, dy));
            }
        }
        if deltas.is_empty() {
            return;
        }
        let elems: Vec<DerpSpaceElem> = self.space.elements().cloned().collect();
        for e in elems {
            match e {
                DerpSpaceElem::Wayland(w) => {
                    let Some(tl) = w.toplevel() else {
                        continue;
                    };
                    let wl = tl.wl_surface();
                    let Some(info) = self.window_registry.snapshot_for_wl_surface(wl) else {
                        continue;
                    };
                    if self.window_info_is_solid_shell_host(&info) {
                        continue;
                    }
                    let elem = DerpSpaceElem::Wayland(w.clone());
                    let Some(loc) = self.space.element_location(&elem) else {
                        continue;
                    };
                    let g = w.geometry();
                    let ww = g.size.w.max(1);
                    let hh = g.size.h.max(1);
                    let Some(oname) =
                        Self::output_name_for_window_from_geometry_map(before_outputs, loc.x, loc.y, ww, hh)
                    else {
                        continue;
                    };
                    let Some(&(dx, dy)) = deltas.get(&oname) else {
                        continue;
                    };
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let nx = loc.x.saturating_add(dx);
                    let ny = loc.y.saturating_add(dy);
                    self.space
                        .map_element(DerpSpaceElem::Wayland(w.clone()), (nx, ny), true);
                    self.notify_geometry_for_window(&w, true);
                }
                DerpSpaceElem::X11(x) => {
                    let elem = DerpSpaceElem::X11(x.clone());
                    let Some(loc) = self.space.element_location(&elem) else {
                        continue;
                    };
                    let geo = x.geometry();
                    let ww = geo.size.w.max(1);
                    let hh = geo.size.h.max(1);
                    let Some(oname) =
                        Self::output_name_for_window_from_geometry_map(before_outputs, loc.x, loc.y, ww, hh)
                    else {
                        continue;
                    };
                    let Some(&(dx, dy)) = deltas.get(&oname) else {
                        continue;
                    };
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let nx = loc.x.saturating_add(dx);
                    let ny = loc.y.saturating_add(dy);
                    let mut ngeo = geo;
                    ngeo.loc.x = nx;
                    ngeo.loc.y = ny;
                    let _ = x.configure(Some(ngeo));
                    self.space
                        .map_element(DerpSpaceElem::X11(x.clone()), (nx, ny), false);
                }
            }
        }
        self.loop_signal.wakeup();
    }

    pub(crate) fn pick_nearest_surviving_output(&self, remove: &Output) -> Option<Output> {
        let removed_name = remove.name();
        let rg = self.space.output_geometry(remove)?;
        let rcx = rg.loc.x.saturating_add(rg.size.w.saturating_div(2));
        let rcy = rg.loc.y.saturating_add(rg.size.h.saturating_div(2));
        let mut scored: Vec<(i32, i32, Output)> = self
            .space
            .outputs()
            .filter(|o| o.name() != removed_name)
            .filter_map(|o| {
                let g = self.space.output_geometry(o)?;
                let cx = g.loc.x.saturating_add(g.size.w.saturating_div(2));
                let cy = g.loc.y.saturating_add(g.size.h.saturating_div(2));
                Some(((cx - rcx).abs(), (cy - rcy).abs(), o.clone()))
            })
            .collect();
        if scored.is_empty() {
            return None;
        }
        scored.sort_by_key(|(dx, dy, _)| (*dx, *dy));
        let (best_dx, best_dy, _) = scored[0];
        let tier: Vec<Output> = scored
            .into_iter()
            .filter(|(dx, dy, _)| *dx == best_dx && *dy == best_dy)
            .map(|(_, _, o)| o)
            .collect();
        if tier.len() == 1 {
            return tier.into_iter().next();
        }
        if let Some(pref) = self.shell_effective_primary_output() {
            let pn = pref.name();
            if let Some(o) = tier.iter().find(|o| o.name() == pn) {
                return Some(o.clone());
            }
        }
        tier.into_iter().next()
    }

    fn migrate_wayland_window_to_target_work_area(
        &mut self,
        window: &Window,
        target_work: &Rectangle<i32, Logical>,
        target: &Output,
    ) {
        let Some(tl) = window.toplevel() else {
            return;
        };
        let wl = tl.wl_surface();
        let Some(window_id) = self.window_registry.window_id_for_wl_surface(wl) else {
            return;
        };
        self.clear_toplevel_layout_maps(window_id);
        self.cancel_shell_move_resize_for_window(window_id);
        self.toplevel_fullscreen_return_maximized.remove(&window_id);
        let csd = Self::wayland_window_has_client_side_decoration(window);
        let geo = window.geometry();
        let ww = geo
            .size
            .w
            .max(1)
            .min(target_work.size.w)
            .max(1);
        let hh = geo
            .size
            .h
            .max(1)
            .min(target_work.size.h)
            .max(1);
        let max_x = target_work
            .loc
            .x
            .saturating_add(target_work.size.w)
            .saturating_sub(ww);
        let max_y = target_work
            .loc
            .y
            .saturating_add(target_work.size.h)
            .saturating_sub(hh);
        let gx = target_work
            .loc
            .x
            .saturating_add(target_work.size.w.saturating_sub(ww) / 2)
            .clamp(target_work.loc.x, max_x);
        let gy = target_work
            .loc
            .y
            .saturating_add(target_work.size.h.saturating_sub(hh) / 2)
            .clamp(target_work.loc.y, max_y);
        let (map_x, map_y, content_w, content_h) =
            Self::wayland_toplevel_map_and_content_for_shell_frame(window, csd, gx, gy, ww, hh);
        tl.with_pending_state(|st| {
            st.states.unset(xdg_toplevel::State::Fullscreen);
            st.states.unset(xdg_toplevel::State::Maximized);
            st.fullscreen_output = None;
            st.size = Some(Size::from((content_w, content_h)));
        });
        self.space
            .map_element(DerpSpaceElem::Wayland(window.clone()), (map_x, map_y), true);
        self.space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        tl.send_pending_configure();
        self.notify_geometry_for_window(window, true);
        let tn = target.name().to_string();
        let _ = self.window_registry.set_output_name_for_wl(wl, tn);
    }

    fn migrate_x11_surface_to_work_area(
        &mut self,
        x: &X11Surface,
        target_work: &Rectangle<i32, Logical>,
    ) {
        let elem = DerpSpaceElem::X11(x.clone());
        let Some(_loc) = self.space.element_location(&elem) else {
            return;
        };
        let mut geo = x.geometry();
        let ww = geo
            .size
            .w
            .max(1)
            .min(target_work.size.w)
            .max(1);
        let hh = geo
            .size
            .h
            .max(1)
            .min(target_work.size.h)
            .max(1);
        let max_x = target_work
            .loc
            .x
            .saturating_add(target_work.size.w)
            .saturating_sub(ww);
        let max_y = target_work
            .loc
            .y
            .saturating_add(target_work.size.h)
            .saturating_sub(hh);
        let nx = target_work
            .loc
            .x
            .saturating_add(target_work.size.w.saturating_sub(ww) / 2)
            .clamp(target_work.loc.x, max_x);
        let ny = target_work
            .loc
            .y
            .saturating_add(target_work.size.h.saturating_sub(hh) / 2)
            .clamp(target_work.loc.y, max_y);
        geo.loc.x = nx;
        geo.loc.y = ny;
        geo.size.w = ww;
        geo.size.h = hh;
        if let Err(e) = x.configure(Some(geo)) {
            tracing::warn!(target: "derp_output", ?e, "x11 migrate configure");
        }
        self.space
            .map_element(DerpSpaceElem::X11(x.clone()), (nx, ny), false);
        self.loop_signal.wakeup();
    }

    pub(crate) fn migrate_windows_before_output_unmapped(&mut self, remove: &Output) {
        let Some(target) = self.pick_nearest_surviving_output(remove) else {
            tracing::warn!(
                target: "derp_output",
                name = %remove.name(),
                "output removal: no surviving output; skipping window migration"
            );
            return;
        };
        let removed_name = remove.name().to_string();
        let Some(target_work) = self.shell_maximize_work_area_global_for_output(&target) else {
            return;
        };
        let elems: Vec<DerpSpaceElem> = self.space.elements().cloned().collect();
        for e in elems {
            let DerpSpaceElem::Wayland(window) = e else {
                continue;
            };
            let Some(tl) = window.toplevel() else {
                continue;
            };
            let wl = tl.wl_surface();
            let Some(info) = self.window_registry.snapshot_for_wl_surface(wl) else {
                continue;
            };
            if self.window_info_is_solid_shell_host(&info) {
                continue;
            }
            let elem = DerpSpaceElem::Wayland(window.clone());
            let Some(loc) = self.space.element_location(&elem) else {
                continue;
            };
            let g = window.geometry();
            let ww = g.size.w.max(1);
            let hh = g.size.h.max(1);
            let spatial_on_removed = self
                .output_for_window_position(loc.x, loc.y, ww, hh)
                .as_deref()
                == Some(removed_name.as_str());
            if info.output_name != removed_name && !spatial_on_removed {
                continue;
            }
            self.migrate_wayland_window_to_target_work_area(&window, &target_work, &target);
        }
        let x11_to_move: Vec<X11Surface> = self
            .space
            .elements()
            .filter_map(|e| {
                let DerpSpaceElem::X11(x) = e else {
                    return None;
                };
                let elem = DerpSpaceElem::X11(x.clone());
                let loc = self.space.element_location(&elem)?;
                let g = x.geometry();
                let w = g.size.w.max(1);
                let h = g.size.h.max(1);
                let on_removed = self
                    .output_for_window_position(loc.x, loc.y, w, h)
                    .as_deref()
                    == Some(removed_name.as_str());
                on_removed.then(|| x.clone())
            })
            .collect();
        for x in x11_to_move {
            self.migrate_x11_surface_to_work_area(&x, &target_work);
        }
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
            tracing::warn!(
                target: "derp_hotplug_shell",
                cleared_stale_primary,
                "send_shell_output_layout abort no workspace_logical_bounds"
            );
            if cleared_stale_primary {
                self.resync_embedded_shell_host_after_ipc_connect();
            }
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
        let screen_names: Vec<&str> = screens.iter().map(|s| s.name.as_str()).collect();
        tracing::warn!(
            target: "derp_hotplug_shell",
            lw,
            lh,
            physical_w,
            physical_h,
            n_screens = screens.len(),
            ?screen_names,
            primary = ?self.shell_primary_output_name,
            suppressed = self.display_config_save_suppressed,
            "send_shell_output_layout shell_send_to_cef OutputLayout"
        );
        if self.display_config_save_suppressed {
            return;
        }
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

    pub(crate) fn shell_after_drm_topology_changed(&mut self) {
        self.shell_resize_end_active();
        self.shell_move_end_active();
        self.shell_exclusion_zones_need_full_damage = true;
        self.shell_dmabuf_dirty_force_full = true;
        let output_names: Vec<String> = self.space.outputs().map(|o| o.name().into()).collect();
        tracing::warn!(
            target: "derp_hotplug_shell",
            ?output_names,
            primary = ?self.shell_primary_output_name,
            cef = self.shell_cef_active(),
            has_frame = self.shell_has_frame,
            "shell_after_drm_topology_changed enter"
        );
        self.send_shell_output_layout();
        self.shell_reply_window_list();
        self.shell_nudge_cef_repaint();
        tracing::warn!(
            target: "derp_hotplug_shell",
            has_frame = self.shell_has_frame,
            "shell_after_drm_topology_changed exit"
        );
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
        if self.display_config_save_suppressed {
            return;
        }
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
        let before_outputs = self.snapshot_output_geometry_by_name();
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
        self.shift_mapped_toplevels_for_output_moves(&before_outputs);
        self.resync_wayland_window_registry_from_space();
        self.recompute_shell_canvas_from_outputs();
        self.send_shell_output_layout();
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
        if !self.shell_cef_active() {
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
        self.shell_ipc_last_pong = None;
        self.shell_ipc_unanswered_ping_since = None;
        self.shell_ipc_ping_late_warned_for = None;
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
                output_name: ipc_info.output_name.clone(),
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

    pub(crate) fn shell_ipc_on_pong(&mut self) {
        self.shell_ipc_last_pong = Some(Instant::now());
        self.shell_ipc_ping_late_warned_for = None;
        self.shell_ipc_unanswered_ping_since = None;
    }

    pub(crate) fn shell_check_ipc_watchdog(&mut self) {
        let Some(limit) = self.shell_ipc_stall_timeout else {
            return;
        };
        if !self.shell_cef_active() {
            self.shell_ipc_last_compositor_ping = None;
            self.shell_ipc_last_pong = None;
            self.shell_ipc_unanswered_ping_since = None;
            self.shell_ipc_ping_late_warned_for = None;
            return;
        }
        let Some(last_rx) = self.shell_ipc_last_rx else {
            return;
        };
        let idle = last_rx.elapsed();
        let prod_after = std::cmp::max(limit / 2, Duration::from_millis(500))
            .min(Duration::from_secs(2));
        if idle >= prod_after {
            let throttle = Duration::from_secs(1);
            if self
                .shell_ipc_last_compositor_ping
                .map(|t| t.elapsed() >= throttle)
                .unwrap_or(true)
            {
                let prev = self.shell_ipc_last_compositor_ping;
                let now = Instant::now();
                let prev_round_answered = prev.map_or(true, |pp| {
                    self.shell_ipc_last_pong.map(|p| p >= pp).unwrap_or(false)
                });
                self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Ping);
                self.shell_ipc_last_compositor_ping = Some(now);
                if prev_round_answered {
                    self.shell_ipc_unanswered_ping_since = Some(now);
                }
            }
        }
        if let Some(u) = self.shell_ipc_unanswered_ping_since {
            if u.elapsed() >= Duration::from_secs(10) {
                if self.shell_ipc_ping_late_warned_for != Some(u) {
                    self.shell_ipc_ping_late_warned_for = Some(u);
                    tracing::warn!(
                        "shell ipc: no pong within 10s after compositor ping (CEF or shell handler may be stuck)"
                    );
                }
            }
        }
        if idle <= limit {
            return;
        }
        tracing::warn!(
            timeout_secs = limit.as_secs(),
            "shell watchdog: no CEF/compositor activity within timeout; stopping compositor (stuck shell / JS)"
        );
        self.stop_event_loop();
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

        let in_placement = self.shell_ui_placement_topmost_at(pos).is_some();
        if in_placement {
            if !self.shell_ui_suppress_osr_exclusion {
                return true;
            }
            if self.surface_under(pos).is_none() {
                return true;
            }
            return false;
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
        if let Some(w) = self.shell_ui_placement_topmost_at(pos) {
            let g = &w.global_rect;
            let gw = g.size.w.max(1) as f64;
            let gh = g.size.h.max(1) as f64;
            let px = pos.x - g.loc.x as f64;
            let py = pos.y - g.loc.y as f64;
            if px >= 0.0 && py >= 0.0 && px < gw && py < gh {
                return self.shell_pointer_ipc_for_cef(pos);
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
        self.shell_resize_end_active();
        if self.shell_move_try_begin_backed(window_id) {
            return;
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

        self.shell_move_is_backed = false;
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
        if self.shell_move_is_backed {
            self.shell_move_flush_pending_deltas_backed();
            return;
        }
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
        if self.shell_move_is_backed {
            self.shell_move_pending_delta.0 += dx;
            self.shell_move_pending_delta.1 += dy;
            self.shell_move_flush_pending_deltas_backed();
            return;
        }
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
        if self.shell_move_is_backed {
            self.shell_move_end_backed_only(window_id);
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
        self.shell_resize_window_id.is_some() || self.shell_resize_shell_grab.is_some()
    }

    pub(crate) fn shell_resize_end_active(&mut self) {
        if let Some(wid) = self.shell_resize_window_id {
            self.shell_resize_end(wid);
        }
        self.shell_resize_shell_grab = None;
    }

    pub fn shell_resize_shell_grab_begin(&mut self, window_id: u32) {
        if window_id == 0 {
            return;
        }
        if let Some(mid) = self.shell_move_window_id {
            if self.shell_move_is_backed {
                self.shell_move_end_backed_only(mid);
            } else {
                self.shell_move_end(mid);
            }
        }
        if let Some(prev) = self.shell_resize_window_id {
            if self.shell_resize_is_backed {
                self.shell_resize_end_backed_only(prev);
            } else {
                self.shell_resize_end(prev);
            }
        }
        self.shell_resize_shell_grab = Some(window_id);
    }

    pub fn shell_resize_shell_grab_end(&mut self) {
        self.shell_resize_shell_grab = None;
    }

    pub fn shell_resize_begin(&mut self, window_id: u32, edges_wire: u32) {
        use crate::grabs::resize_grab::{resize_tracking_set_resizing, ResizeEdge as GrabResizeEdge};
        use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;

        if let Some(mid) = self.shell_move_window_id {
            if self.shell_move_is_backed {
                self.shell_move_end_backed_only(mid);
            } else {
                self.shell_move_end(mid);
            }
        }
        self.shell_resize_shell_grab = None;
        if self.shell_resize_window_id == Some(window_id) {
            tracing::warn!(
                target: "derp_shell_resize",
                window_id,
                "shell_resize_begin: already active (no-op)"
            );
            return;
        }
        if let Some(prev) = self.shell_resize_window_id {
            if self.shell_resize_is_backed {
                self.shell_resize_end_backed_only(prev);
            } else {
                self.shell_resize_end(prev);
            }
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

        if self.shell_resize_try_begin_backed(window_id, edges_wire) {
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

        self.shell_resize_is_backed = false;
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
        if self.shell_resize_is_backed {
            self.shell_resize_delta_backed(dx, dy);
            return;
        }
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

        if self.shell_resize_is_backed {
            self.shell_resize_end_backed_only(window_id);
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
        let mut windows: Vec<shell_wire::ShellWindowSnapshot> = self
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
                    shell_flags: 0,
                    title: i.title,
                    app_id: i.app_id,
                    output_name: i.output_name,
                }
            })
            .collect();
        self.shell_backed_extend_window_list_snapshots(&mut windows);
        windows.sort_by(|a, b| a.window_id.cmp(&b.window_id));
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowList { windows });
    }

    /// Output-local **layout** rect from the shell (same integers as HUD `fixed` CSS / CEF DIP) → global logical.
    pub(crate) fn shell_output_local_rect_to_logical_global(
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
        if self.shell_backed_set_window_geometry_ipc(window_id, lx, ly, lw, lh, layout_state) {
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

        let (map_x, map_y, content_w, content_h) = (x, y, w.max(1), h.max(1));

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
        if self.shell_backed_close_if_any(window_id) {
            return;
        }
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

    pub(crate) fn keyboard_focused_window_id(&self) -> Option<u32> {
        let surf = self.seat.get_keyboard()?.current_focus()?;
        self.window_registry.window_id_for_wl_surface(&surf)
    }

    pub(crate) fn push_non_shell_focus_history(&mut self, wid: u32) {
        self.focus_history_non_shell.retain(|&x| x != wid);
        self.focus_history_non_shell.push(wid);
        const MAX: usize = 64;
        while self.focus_history_non_shell.len() > MAX {
            self.focus_history_non_shell.remove(0);
        }
    }

    pub(crate) fn focus_history_remove_window(&mut self, wid: u32) {
        self.focus_history_non_shell.retain(|&x| x != wid);
    }

    fn is_valid_user_focus_target(&self, window_id: u32) -> bool {
        let Some(info) = self.window_registry.window_info(window_id) else {
            return false;
        };
        if info.minimized || self.window_info_is_solid_shell_host(&info) {
            return false;
        }
        let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
            return false;
        };
        self.find_window_by_surface_id(sid).is_some()
    }

    fn pick_next_focus_target(&self) -> Option<u32> {
        for &wid in self.focus_history_non_shell.iter().rev() {
            if self.is_valid_user_focus_target(wid) {
                return Some(wid);
            }
        }
        for e in self.space.elements().rev() {
            if let DerpSpaceElem::Wayland(w) = e {
                let Some(tl) = w.toplevel() else {
                    continue;
                };
                let wl = tl.wl_surface();
                let Some(wid) = self.window_registry.window_id_for_wl_surface(wl) else {
                    continue;
                };
                if self.is_valid_user_focus_target(wid) {
                    return Some(wid);
                }
            }
        }
        None
    }

    pub(crate) fn try_refocus_after_closed_toplevel(&mut self) {
        let Some(target) = self.pick_next_focus_target() else {
            let serial = SERIAL_COUNTER.next_serial();
            self.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Option::<WlSurface>::None, serial);
            self.keyboard_on_focus_surface_changed(None);
            return;
        };
        self.shell_raise_and_focus_window(target);
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
        self.shell_emit_shell_ui_focus_if_changed(None);
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
        if self.shell_backed_minimize_if_any(window_id) {
            return;
        }
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
            self.keyboard_on_focus_surface_changed(None);
        }

        self.shell_emit_window_state(window_id, true);
    }

    /// Map a compositor-minimized toplevel back into the space and focus it.
    pub fn shell_restore_minimized_window(&mut self, window_id: u32) {
        if self
            .shell_backed_windows
            .get(&window_id)
            .is_some_and(|e| e.minimized)
        {
            self.shell_backed_restore_minimized_if_any(window_id);
            self.shell_focus_shell_ui_window(window_id);
            return;
        }
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
        if self.shell_backed_taskbar_activate(window_id) {
            return;
        }
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
        let should_minimize = kb == Some(window_id);
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
        let (pw, ph) = self.shell_window_physical_px;
        if pw > 0 && ph > 0 && self.workspace_logical_bounds().is_some() {
            let exp_w = u32::try_from(pw).unwrap_or(width).max(1);
            let exp_h = u32::try_from(ph).unwrap_or(height).max(1);
            const LO: u64 = 97;
            const HI: u64 = 103;
            let ew = exp_w as u64;
            let eh = exp_h as u64;
            let ww = width as u64;
            let hh = height as u64;
            let w_ok = ww * 100 >= ew * LO && ww * 100 <= ew * HI;
            let h_ok = hh * 100 >= eh * LO && hh * 100 <= eh * HI;
            if !w_ok || !h_ok {
                fds.clear();
                self.shell_nudge_cef_repaint();
                tracing::debug!(
                    target: "derp_hotplug_shell",
                    width,
                    height,
                    exp_w,
                    exp_h,
                    "apply_shell_frame_dmabuf reject mismatched size pending CEF resize paint"
                );
                return Err("dmabuf size mismatch shell_window_physical_px");
            }
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
        if resized {
            tracing::warn!(
                target: "derp_hotplug_shell",
                width,
                height,
                "apply_shell_frame_dmabuf OSR size changed shell_has_frame true"
            );
        }
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
        tracing::warn!(target: "derp_hotplug_shell", "clear_shell_frame");
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

    const CEF_EVENTFLAG_IS_REPEAT: u32 = 1 << 13;

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

    pub(crate) fn shell_cef_sym_should_autorepeat(raw: u32) -> bool {
        !matches!(
            raw,
            keysyms::KEY_Shift_L
                | keysyms::KEY_Shift_R
                | keysyms::KEY_Control_L
                | keysyms::KEY_Control_R
                | keysyms::KEY_Alt_L
                | keysyms::KEY_Alt_R
                | keysyms::KEY_Caps_Lock
        )
    }

    pub(crate) fn shell_cef_repeat_clear(&mut self, lh: &LoopHandle<CalloopData>) {
        if let Some(t) = self.shell_cef_repeat_token.take() {
            let _ = lh.remove(t);
        }
        self.shell_cef_repeat_keycode = None;
        self.shell_cef_repeat_sym_raw = None;
    }

    pub(crate) fn shell_cef_repeat_arm(
        &mut self,
        lh: &LoopHandle<CalloopData>,
        keycode: Keycode,
        sym_raw: u32,
    ) {
        self.shell_cef_repeat_clear(lh);
        self.shell_cef_repeat_keycode = Some(keycode);
        self.shell_cef_repeat_sym_raw = Some(sym_raw);
        let lh2 = lh.clone();
        match lh.insert_source(
            Timer::from_duration(Duration::from_millis(200)),
            move |_, _, d: &mut CalloopData| d.state.shell_cef_repeat_on_tick(&lh2),
        ) {
            Ok(t) => self.shell_cef_repeat_token = Some(t),
            Err(_) => {
                self.shell_cef_repeat_keycode = None;
                self.shell_cef_repeat_sym_raw = None;
            }
        }
    }

    fn shell_cef_repeat_on_tick(&mut self, lh: &LoopHandle<CalloopData>) -> TimeoutAction {
        let Some(keycode) = self.shell_cef_repeat_keycode else {
            self.shell_cef_repeat_token = None;
            return TimeoutAction::Drop;
        };
        let Some(keyboard) = self.seat.get_keyboard().map(|k| k.clone()) else {
            self.shell_cef_repeat_clear(lh);
            return TimeoutAction::Drop;
        };
        if !keyboard.pressed_keys().contains(&keycode) {
            self.shell_cef_repeat_clear(lh);
            return TimeoutAction::Drop;
        }
        if !self.shell_ipc_keyboard_to_cef || !self.shell_cef_active() || !self.shell_has_frame {
            self.shell_cef_repeat_clear(lh);
            return TimeoutAction::Drop;
        }
        let Some(sym_raw) = self.shell_cef_repeat_sym_raw else {
            self.shell_cef_repeat_clear(lh);
            return TimeoutAction::Drop;
        };
        let mods = keyboard.modifier_state();
        let mut ticked = false;
        keyboard.with_pressed_keysyms(|handles| {
            let Some(h) = handles
                .iter()
                .find(|h| h.modified_sym().raw() == sym_raw)
            else {
                return;
            };
            self.shell_ipc_forward_keyboard_to_cef(KeyState::Pressed, &mods, h, true);
            ticked = true;
        });
        if !ticked {
            self.shell_cef_repeat_clear(lh);
            return TimeoutAction::Drop;
        }
        TimeoutAction::ToDuration(Duration::from_millis(40))
    }

    fn keysym_raw_to_windows_vkey(raw: u32) -> i32 {
        match raw {
            keysyms::KEY_BackSpace => 0x08,
            keysyms::KEY_Tab => 0x09,
            keysyms::KEY_ISO_Left_Tab => 0x09,
            keysyms::KEY_Return => 0x0D,
            keysyms::KEY_KP_Enter => 0x0D,
            keysyms::KEY_Escape => 0x1B,
            keysyms::KEY_Left => 0x25,
            keysyms::KEY_Up => 0x26,
            keysyms::KEY_Right => 0x27,
            keysyms::KEY_Down => 0x28,
            keysyms::KEY_Page_Up => 0x21,
            keysyms::KEY_Page_Down => 0x22,
            keysyms::KEY_Home => 0x24,
            keysyms::KEY_End => 0x23,
            keysyms::KEY_Insert => 0x2D,
            keysyms::KEY_Delete => 0x2E,
            _ => 0,
        }
    }

    pub(crate) fn shell_ipc_forward_keyboard_to_cef(
        &mut self,
        key_state: KeyState,
        mods: &ModifiersState,
        keysym: &KeysymHandle<'_>,
        is_autorepeat: bool,
    ) {
        if !self.shell_cef_active() || !self.shell_has_frame {
            return;
        }
        let sym = keysym.modified_sym();
        let mut mods_u = Self::cef_flags_from_modifiers(mods);
        if key_state == KeyState::Pressed && is_autorepeat {
            mods_u |= Self::CEF_EVENTFLAG_IS_REPEAT;
        }
        let native = sym.raw() as i32;
        let win_vk = Self::keysym_raw_to_windows_vkey(sym.raw());
        match key_state {
            KeyState::Pressed => {
                let raw = sym.raw();
                let ctl_char: Option<u32> = match raw {
                    keysyms::KEY_BackSpace => Some(0x08),
                    keysyms::KEY_Delete | keysyms::KEY_KP_Delete => Some(0x7f),
                    _ => None,
                };
                let printable = sym.key_char().filter(|c| !c.is_control());
                if is_autorepeat {
                    self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                        cef_key_type: shell_wire::CEF_KEYEVENT_KEYDOWN,
                        modifiers: mods_u,
                        windows_key_code: win_vk,
                        native_key_code: native,
                        character: 0,
                        unmodified_character: 0,
                    });
                    if let Some(cu) = ctl_char {
                        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                            cef_key_type: shell_wire::CEF_KEYEVENT_CHAR,
                            modifiers: mods_u,
                            windows_key_code: win_vk,
                            native_key_code: native,
                            character: cu,
                            unmodified_character: cu,
                        });
                    } else if let Some(ch) = printable {
                        let cu = ch as u32;
                        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                            cef_key_type: shell_wire::CEF_KEYEVENT_CHAR,
                            modifiers: mods_u,
                            windows_key_code: win_vk,
                            native_key_code: native,
                            character: cu,
                            unmodified_character: cu,
                        });
                    }
                } else {
                    self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                        cef_key_type: shell_wire::CEF_KEYEVENT_RAWKEYDOWN,
                        modifiers: mods_u,
                        windows_key_code: win_vk,
                        native_key_code: native,
                        character: 0,
                        unmodified_character: 0,
                    });
                    if let Some(cu) = ctl_char {
                        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                            cef_key_type: shell_wire::CEF_KEYEVENT_CHAR,
                            modifiers: mods_u,
                            windows_key_code: win_vk,
                            native_key_code: native,
                            character: cu,
                            unmodified_character: cu,
                        });
                    } else if let Some(ch) = printable {
                        let cu = ch as u32;
                        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                            cef_key_type: shell_wire::CEF_KEYEVENT_CHAR,
                            modifiers: mods_u,
                            windows_key_code: win_vk,
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
                    windows_key_code: win_vk,
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
        if !route && !self.shell_move_is_active() && !self.shell_resize_is_active() && self.shell_ui_pointer_grab.is_none()
        {
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
        if !route && !self.shell_move_is_active() && !self.shell_resize_is_active() && self.shell_ui_pointer_grab.is_none()
        {
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
    pub fn try_spawn_wayland_client_sh(&mut self, shell_command: &str) -> Result<(), String> {
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
        self.shell_spawn_focus_above_window_id = Some(self.window_registry.highest_allocated_window_id());
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
