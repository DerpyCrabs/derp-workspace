use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::OsString,
    io::Write,
    os::fd::OwnedFd,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
    time::{Duration, Instant},
};

use smithay::output::{Output, Scale};
use smithay::reexports::wayland_server::Resource;
use smithay::{
    backend::allocator::dmabuf::{Dmabuf, DmabufFlags},
    backend::allocator::{Format, Fourcc, Modifier},
    backend::egl::EGLDevice,
    backend::input::{KeyState, Keycode, TouchSlot},
    backend::renderer::{
        element::solid::SolidColorBuffer,
        gles::{GlesRenderer, GlesTarget},
        utils::CommitCounter,
        Color32F, ImportDma, Renderer,
    },
    backend::{
        renderer::element::{memory::MemoryRenderBuffer, Id},
        session::libseat::LibSeatSession,
    },
    desktop::{
        layer_map_for_output,
        space::{Space, SpaceElement},
        utils::under_from_surface_tree,
        LayerSurface as DesktopLayerSurface, PopupManager, Window, WindowSurfaceType,
    },
    input::{
        keyboard::{keysyms, KeysymHandle, Layout, ModifiersState, XkbConfig},
        Seat, SeatState,
    },
    reexports::{
        calloop::{
            channel::{self, Event as CalloopChannelEvent},
            timer::{TimeoutAction, Timer},
            EventLoop, LoopHandle, LoopSignal, RegistrationToken,
        },
        wayland_protocols::xdg::shell::server::xdg_toplevel,
        wayland_server::{
            backend::{ClientData, ClientId, DisconnectReason},
            protocol::{wl_output::WlOutput, wl_surface::WlSurface},
            Client, Display, DisplayHandle,
        },
    },
    utils::{Buffer, Logical, Point, Rectangle, Serial, Size, Transform, SERIAL_COUNTER},
    wayland::{
        compositor::{CompositorClientState, CompositorState as WlCompositorState},
        cursor_shape::CursorShapeManagerState,
        dmabuf::{DmabufFeedbackBuilder, DmabufGlobal, DmabufHandler, DmabufState, ImportNotifier},
        foreign_toplevel_list::{ForeignToplevelHandle, ForeignToplevelListState},
        fractional_scale::{FractionalScaleHandler, FractionalScaleManagerState},
        idle_inhibit::IdleInhibitManagerState,
        keyboard_shortcuts_inhibit::KeyboardShortcutsInhibitState,
        output::OutputManagerState,
        selection::{
            data_device::{
                clear_data_device_selection, current_data_device_selection_userdata,
                request_data_device_client_selection, set_data_device_selection, DataDeviceState,
            },
            wlr_data_control::DataControlState,
            SelectionTarget,
        },
        shell::wlr_layer::{Layer, WlrLayerShellState},
        shell::xdg::{
            decoration::{XdgDecorationHandler, XdgDecorationState},
            SurfaceCachedState, ToplevelSurface, XdgShellState, XdgToplevelSurfaceData,
        },
        shm::ShmState,
        viewporter::ViewporterState,
        xwayland_shell::{XWaylandShellHandler, XWaylandShellState},
    },
    xwayland::{
        xwm::{Reorder, ResizeEdge, X11Window, XwmId},
        X11Surface, X11Wm, XwmHandler,
    },
};

use crate::{
    chrome_bridge::{ChromeEvent, NoOpChromeBridge, SharedChromeBridge, WindowInfo},
    derp_space::DerpSpaceElem,
    desktop::exclusion_clip,
    session::workspace_model::{
        group_id_for_window, next_active_window_after_removal, reconcile_workspace_state,
        WorkspaceMutation, WorkspaceState,
    },
    shell::shell_ipc,
    window_registry::{WindowKind, WindowRegistry},
    CalloopData,
};
use smithay::input::pointer::CursorImageStatus;

fn disconnected_wayland_clients() -> &'static Mutex<Vec<ClientId>> {
    static QUEUE: OnceLock<Mutex<Vec<ClientId>>> = OnceLock::new();
    QUEUE.get_or_init(|| Mutex::new(Vec::new()))
}

struct X11SyncResult {
    info: WindowInfo,
    metadata_changed: bool,
    geometry_changed: bool,
    state_changed: bool,
}

/// Titlebar strip height in **logical** pixels; keep in sync with `shell` decoration UI.
pub const SHELL_TITLEBAR_HEIGHT: i32 = 26;
pub const SHELL_TASKBAR_RESERVE_PX: i32 = 44;
/// Default **position** (output top-left + offset) for new xdg toplevels in **logical** px.
pub const DEFAULT_XDG_TOPLEVEL_OFFSET_X: i32 = 200;
pub const DEFAULT_XDG_TOPLEVEL_OFFSET_Y: i32 = 200;
pub const DEFAULT_XDG_TOPLEVEL_WIDTH: i32 = 800;
pub const DEFAULT_XDG_TOPLEVEL_HEIGHT: i32 = 600;
pub const DEFAULT_XDG_TOPLEVEL_STAGGER_X: i32 = 32;
pub const DEFAULT_XDG_TOPLEVEL_STAGGER_Y: i32 = 24;
pub const DEFAULT_XDG_TOPLEVEL_STAGGER_STEPS: i32 = 6;
pub const GNOME_AUTO_MAXIMIZE_THRESHOLD_PERCENT: i32 = 90;
/// Border thickness around client for chrome hit-testing; keep in sync with `shell` `CHROME_BORDER_PX`.
pub const SHELL_BORDER_THICKNESS: i32 = 4;
/// Top border inset above client (shell tabs flush to frame top when 0); keep in sync with `CHROME_BORDER_TOP_PX`.
pub const SHELL_BORDER_TOP_THICKNESS: i32 = 0;
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
    pub context_id:
        smithay::backend::renderer::ContextId<smithay::backend::renderer::gles::GlesTexture>,
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

pub(crate) struct CachedBackdropLayers {
    pub key: crate::render::backdrop_render::BackdropCacheKey,
    pub layers: crate::render::backdrop_render::BackdropLayers,
}

#[derive(Default)]
pub(crate) struct CachedShellRenderOutput {
    pub main: Option<
        crate::render::shell_render::CachedShellElement<
            crate::render::shell_render::ShellMainCacheKey,
        >,
    >,
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
        let Some(data) = states.data_map.get::<XdgToplevelSurfaceData>() else {
            return (false, false);
        };
        let Ok(data) = data.lock() else {
            return (false, false);
        };
        let st = data.current_server_state();
        (
            st.states.contains(xdg_toplevel::State::Maximized),
            st.states.contains(xdg_toplevel::State::Fullscreen),
        )
    })
}

fn global_point_in_output_rect(cx: i32, cy: i32, g: &Rectangle<i32, Logical>) -> bool {
    cx >= g.loc.x
        && cy >= g.loc.y
        && cx < g.loc.x.saturating_add(g.size.w)
        && cy < g.loc.y.saturating_add(g.size.h)
}

fn pick_output_name_for_global_window_center_first(
    pairs: &[(String, Rectangle<i32, Logical>)],
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Option<String> {
    if pairs.is_empty() {
        return None;
    }
    let ww = w.max(1);
    let hh = h.max(1);
    let cx = x.saturating_add(ww / 2);
    let cy = y.saturating_add(hh / 2);
    pairs
        .iter()
        .find(|(_, g)| global_point_in_output_rect(cx, cy, g))
        .map(|(name, _)| name.clone())
}

fn window_output_fit_challenger_beats_incumbent(
    window_rect: Rectangle<i32, Logical>,
    cx: i32,
    cy: i32,
    incumbent: (&str, Rectangle<i32, Logical>),
    challenger: (&str, Rectangle<i32, Logical>),
) -> bool {
    let area_i = window_rect
        .intersection(incumbent.1)
        .map(|ix| (ix.size.w as i64).saturating_mul(ix.size.h as i64))
        .unwrap_or(0);
    let area_c = window_rect
        .intersection(challenger.1)
        .map(|ix| (ix.size.w as i64).saturating_mul(ix.size.h as i64))
        .unwrap_or(0);
    if area_c != area_i {
        return area_c > area_i;
    }
    let center_in_i = global_point_in_output_rect(cx, cy, &incumbent.1);
    let center_in_c = global_point_in_output_rect(cx, cy, &challenger.1);
    if center_in_c != center_in_i {
        return center_in_c;
    }
    if challenger.1.loc.x != incumbent.1.loc.x {
        return challenger.1.loc.x < incumbent.1.loc.x;
    }
    challenger.0 < incumbent.0
}

fn pick_output_name_for_global_window_rect_from_output_rects(
    pairs: &[(String, Rectangle<i32, Logical>)],
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Option<String> {
    if pairs.is_empty() {
        return None;
    }
    let ww = w.max(1);
    let hh = h.max(1);
    let window_rect = Rectangle::new(Point::from((x, y)), Size::from((ww, hh)));
    let cx = x.saturating_add(ww.saturating_div(2));
    let cy = y.saturating_add(hh.saturating_div(2));

    let mut chosen_idx = 0usize;
    for idx in 1..pairs.len() {
        let a = &pairs[chosen_idx];
        let b = &pairs[idx];
        if window_output_fit_challenger_beats_incumbent(
            window_rect,
            cx,
            cy,
            (a.0.as_str(), a.1),
            (b.0.as_str(), b.1),
        ) {
            chosen_idx = idx;
        }
    }
    let chosen = &pairs[chosen_idx];
    let max_area = window_rect
        .intersection(chosen.1)
        .map(|ix| (ix.size.w as i64).saturating_mul(ix.size.h as i64))
        .unwrap_or(0);
    if max_area > 0 {
        return Some(chosen.0.clone());
    }
    for (name, g) in pairs {
        if global_point_in_output_rect(cx, cy, g) {
            return Some(name.clone());
        }
    }
    pairs
        .iter()
        .min_by_key(|(_, g)| g.loc.x)
        .map(|(n, _)| n.clone())
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
    let modifierless = Modifier::from(72057594037927935u64);
    let mut out: Vec<Format> = renderer
        .egl_context()
        .dmabuf_render_formats()
        .iter()
        .copied()
        .filter(|f| {
            matches!(f.code, Fourcc::Argb8888 | Fourcc::Xrgb8888) && f.modifier == modifierless
        })
        .collect();
    if out.is_empty() {
        out = renderer
            .dmabuf_formats()
            .iter()
            .copied()
            .filter(|f| {
                matches!(f.code, Fourcc::Argb8888 | Fourcc::Xrgb8888) && f.modifier == modifierless
            })
            .collect();
        tracing::warn!(
            "linux-dmabuf global: no modifierless XRGB/ARGB formats in EGL render set; falling back to texture/import formats"
        );
    }
    if out.is_empty() {
        out = renderer
            .egl_context()
            .dmabuf_render_formats()
            .iter()
            .copied()
            .filter(|f| matches!(f.code, Fourcc::Argb8888 | Fourcc::Xrgb8888))
            .collect();
        if out.is_empty() {
            out = renderer
                .dmabuf_formats()
                .iter()
                .copied()
                .filter(|f| matches!(f.code, Fourcc::Argb8888 | Fourcc::Xrgb8888))
                .collect();
        }
        tracing::warn!(
            "linux-dmabuf global: no modifierless XRGB/ARGB formats available; falling back to explicit modifiers"
        );
    }
    let advertised_formats: Vec<(u32, u64)> = out
        .iter()
        .map(|f| (f.code as u32, u64::from(f.modifier)))
        .collect();
    tracing::warn!(
        ?advertised_formats,
        "linux-dmabuf advertised format/modifier pairs"
    );
    out
}

fn client_allows_linux_dmabuf(
    _client: &smithay::reexports::wayland_server::Client,
    _dh: &DisplayHandle,
) -> bool {
    true
}

pub(crate) fn normalize_capture_dmabuf_format(format: Format) -> Format {
    let modifier = if format.modifier == Modifier::Invalid {
        Modifier::Linear
    } else {
        format.modifier
    };
    Format {
        code: format.code,
        modifier,
    }
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
    pub(crate) capture_dmabuf_formats: Vec<Format>,
    pub(crate) capture_dmabuf_device: Option<libc::dev_t>,
    pub output_manager_state: OutputManagerState,
    pub layer_shell_state: WlrLayerShellState,
    pub(crate) foreign_toplevel_list_state: ForeignToplevelListState,
    pub(crate) capture_toplevel_handles: HashMap<u32, ForeignToplevelHandle>,
    pub(crate) capture_window_source_cache:
        HashMap<u32, crate::render::capture::CachedCaptureWindowSource>,
    pub(crate) _idle_inhibit_manager_state: IdleInhibitManagerState,
    pub(crate) idle_inhibit_surfaces: HashSet<(ClientId, u32)>,
    pub(crate) keyboard_shortcuts_inhibit_state: KeyboardShortcutsInhibitState,
    pub(crate) _screencopy_manager_state: crate::render::capture::ScreencopyManagerState,
    pub(crate) pending_screencopy_copies: Vec<crate::render::capture::PendingScreencopyCopy>,
    pub(crate) _ext_image_capture_manager_state:
        crate::render::capture_ext::ExtImageCaptureManagerState,
    pub(crate) pending_image_copy_captures:
        Vec<crate::render::capture_ext::PendingImageCopyCapture>,
    pub seat_state: SeatState<CompositorState>,
    pub data_device_state: DataDeviceState,
    pub data_control_state: DataControlState,
    pub(crate) screenshot_request: Option<crate::render::screenshot::PendingScreenshotRequest>,
    pub(crate) screenshot_selection_active: bool,
    pub(crate) screenshot_selection_anchor: Option<Point<i32, Logical>>,
    pub(crate) screenshot_selection_current: Option<Point<i32, Logical>>,
    pub(crate) screenshot_overlay_needs_full_damage: bool,
    pub(crate) capture_force_full_damage_frames: u8,
    pub(crate) active_image_copy_capture_sessions: usize,
    pub popups: PopupManager,
    pub(crate) shell_tray_strip_global: Option<Rectangle<i32, Logical>>,
    pub(crate) sni_tray_cmd_tx: Option<std::sync::mpsc::Sender<crate::tray::sni_tray::SniTrayCmd>>,
    pub(crate) sni_tray_slot_count: u32,

    pub xwayland_shell_state: XWaylandShellState,
    pub x11_wm_slot: Option<(XwmId, X11Wm)>,
    pub(crate) x11_client: Option<Client>,

    pub seat: Seat<Self>,

    pub chrome_bridge: SharedChromeBridge,
    pub window_registry: WindowRegistry,
    pub(crate) pending_deferred_toplevels: HashMap<(ClientId, u32), PendingDeferredToplevel>,
    pub(crate) pending_gnome_initial_toplevels: HashSet<u32>,

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
    pub(crate) programs_menu_super_pending_toggle: bool,
    keyboard_layout_by_window: HashMap<u32, u32>,
    keyboard_layout_last_focus_window: Option<u32>,
    keyboard_layout_focus_queue: VecDeque<KeyboardLayoutFocusOp>,
    pub(crate) shell_hosted_app_state: HashMap<u32, serde_json::Value>,
    session_default_layout_index: u32,
    /// Latest pointer position as fraction of [`Self::shell_window_physical_px`] (0..1), window-local physical.
    pub(crate) shell_pointer_norm: Option<(f64, f64)>,
    pub(crate) shell_initial_pointer_centered: bool,
    /// Last `(x,y)` sent on shell IPC [`shell_wire::MSG_COMPOSITOR_POINTER_MOVE`] (dedupe spam).
    pub(crate) shell_last_pointer_ipc_px: Option<(i32, i32)>,
    pub(crate) shell_last_pointer_ipc_global_logical: Option<(i32, i32)>,
    /// Last client cursor from [`smithay::wayland::seat::SeatHandler::cursor_image`]; composited on DRM / nested swapchain.
    pub pointer_cursor_image: CursorImageStatus,
    /// Themed / system default pointer (`left_ptr`); also used for [`CursorImageStatus::Named`].
    pub(crate) cursor_fallback_buffer: MemoryRenderBuffer,
    /// Hotspot within [`Self::cursor_fallback_buffer`] (logical px).
    pub(crate) cursor_fallback_hotspot: (i32, i32),
    /// After [`Self::try_spawn_wayland_client_sh`]: focus the first new non-shell toplevel with a greater window id.
    shell_spawn_focus_above_window_id: Option<u32>,
    /// Wayland [`Window`] handles for compositor-minimized toplevels (unmapped from [`Self::space`]).
    pub(crate) shell_minimized_windows: HashMap<u32, Window>,
    pub(crate) shell_minimized_x11_windows: HashMap<u32, X11Surface>,
    pub(crate) shell_pending_native_focus_window_id: Option<u32>,
    pub(crate) shell_close_pending_native_windows: HashSet<u32>,
    pub(crate) shell_close_refocus_targets: HashMap<u32, u32>,
    /// [`WindowRegistry`]-scoped id for shell-initiated move (`MSG_SHELL_MOVE_*`).
    pub(crate) shell_move_window_id: Option<u32>,
    /// Pending delta for [`Self::shell_move_flush_pending_deltas`]. Applied from each [`Self::shell_move_delta`]
    /// (immediate flush) and from [`Self::shell_move_end`].
    pub(crate) shell_move_pending_delta: (i32, i32),
    pub(crate) shell_backed_move_candidate: Option<(u32, Point<f64, Logical>)>,
    /// Shell-initiated interactive resize ([`shell_wire::MSG_SHELL_RESIZE_*`]).
    pub(crate) shell_resize_window_id: Option<u32>,
    pub(crate) shell_resize_edges: Option<crate::grabs::resize_grab::ResizeEdge>,
    pub(crate) shell_resize_initial_rect: Option<Rectangle<i32, Logical>>,
    pub(crate) shell_resize_accum: (f64, f64),
    pub(crate) shell_resize_shell_grab: Option<u32>,
    pub(crate) shell_ui_pointer_grab: Option<u32>,

    /// When [`Self::shell_ipc_stall_timeout`] is set: max gap without any shell→compositor message while connected.
    shell_ipc_stall_timeout: Option<Duration>,
    shell_ipc_watchdog_armed: bool,
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
    pub(crate) shell_dmabuf_generation: u32,
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
    pub(crate) shell_exclusion_floating: Vec<Rectangle<i32, Logical>>,
    pub(crate) shell_exclusion_overlay_open: bool,
    pub(crate) shell_exclusion_zones_need_full_damage: bool,
    pub(crate) e2e_last_session_power_action: Option<String>,
    pub(crate) e2e_last_session_power_requested_at_ms: Option<u128>,
    pub(crate) shell_ui_windows: Vec<ShellUiWindowPlacement>,
    pub(crate) shell_ui_windows_generation: u32,
    pub(crate) shell_ui_windows_shared_sequence: u64,
    pub(crate) shell_focused_ui_window_id: Option<u32>,
    pub(crate) shell_window_stack_order: Vec<u32>,
    pub(crate) workspace_state: WorkspaceState,
    pub(crate) shell_last_sent_ui_focus_id: Option<u32>,
    pub(crate) shell_exclusion_shared_sequence: u64,
    pub(crate) tile_preview_rect_global: Option<Rectangle<i32, Logical>>,
    pub(crate) tile_preview_solid: SolidColorBuffer,
    pub(crate) shell_chrome_titlebar_h: i32,
    pub(crate) shell_chrome_border_w: i32,

    pub(crate) desktop_background_config: crate::controls::display_config::DesktopBackgroundConfig,
    pub(crate) desktop_background_by_output_name:
        HashMap<String, crate::controls::display_config::DesktopBackgroundConfig>,
    wallpaper_req_tx: std::sync::mpsc::Sender<PathBuf>,
    wallpaper_done_rx: std::sync::mpsc::Receiver<
        Result<
            (
                PathBuf,
                crate::desktop::desktop_background::DesktopWallpaperCpu,
            ),
            String,
        >,
    >,
    pub(crate) desktop_wallpaper_cpu_by_path:
        HashMap<PathBuf, Arc<crate::desktop::desktop_background::DesktopWallpaperCpu>>,
    pub(crate) desktop_wallpaper_gpu_by_path: HashMap<PathBuf, DesktopWallpaperGpuEntry>,
    wallpaper_decode_inflight: HashSet<PathBuf>,
    pub(crate) backdrop_wallpaper_id_cache: HashMap<String, BackdropWallpaperIdCache>,
    pub(crate) backdrop_layers_by_output: HashMap<String, CachedBackdropLayers>,
    pub(crate) shell_render_cache_by_output: HashMap<String, CachedShellRenderOutput>,
    pub(crate) shell_begin_frame_last: Option<Instant>,
    pub(crate) shell_begin_frame_fast_until: Option<Instant>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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
    fn shell_window_stack_seed_known_windows(&mut self) {
        self.shell_window_stack_order
            .retain(|wid| self.window_registry.window_info(*wid).is_some());
        let current = self.shell_window_stack_order.clone();
        let mut ids: Vec<u32> = self
            .window_registry
            .all_records()
            .into_iter()
            .map(|record| record.info.window_id)
            .collect();
        ids.sort_unstable();
        let current_set: HashSet<u32> = current.iter().copied().collect();
        let mut missing: Vec<u32> = ids
            .into_iter()
            .filter(|id| !current_set.contains(id))
            .collect();
        missing.extend(current);
        self.shell_window_stack_order = missing;
    }

    pub(crate) fn shell_window_stack_touch(&mut self, window_id: u32) {
        if window_id == 0 || self.window_registry.window_info(window_id).is_none() {
            return;
        }
        self.shell_window_stack_order
            .retain(|wid| *wid != window_id);
        self.shell_window_stack_order.push(window_id);
    }

    pub(crate) fn shell_window_stack_forget(&mut self, window_id: u32) {
        self.shell_window_stack_order
            .retain(|wid| *wid != window_id);
    }

    pub(crate) fn shell_note_non_shell_focus(&mut self) {
        self.shell_focused_ui_window_id = None;
        self.shell_last_sent_ui_focus_id = None;
        self.shell_exclusion_zones_need_full_damage = true;
    }

    pub(crate) fn logical_focused_window_id(&self) -> Option<u32> {
        if self.shell_ipc_keyboard_to_cef {
            return self.shell_focused_ui_window_id;
        }
        self.keyboard_focused_window_id()
    }

    fn logical_focus_target_is_valid(&self, window_id: u32) -> bool {
        let Some(info) = self.window_registry.window_info(window_id) else {
            return false;
        };
        if info.minimized || self.window_info_is_solid_shell_host(&info) {
            return false;
        }
        if self.window_registry.is_shell_hosted(window_id) {
            return true;
        }
        let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
            return false;
        };
        self.find_window_by_surface_id(sid).is_some()
            || self.find_x11_window_by_surface_id(sid).is_some()
    }

    pub(crate) fn pick_next_logical_focus_target(
        &self,
        exclude_window_id: Option<u32>,
        include_shell_hosted: bool,
    ) -> Option<u32> {
        for &wid in self.shell_window_stack_ids().iter().rev() {
            if exclude_window_id == Some(wid) {
                continue;
            }
            if !include_shell_hosted && self.window_registry.is_shell_hosted(wid) {
                continue;
            }
            if self.logical_focus_target_is_valid(wid) {
                return Some(wid);
            }
        }
        None
    }

    pub(crate) fn focus_logical_window(&mut self, window_id: u32) {
        if self.window_registry.is_shell_hosted(window_id) {
            self.shell_focus_shell_ui_window(window_id);
        } else {
            self.shell_raise_and_focus_window(window_id);
        }
    }

    fn topmost_native_window_from_stack(&self) -> Option<u32> {
        for &wid in self.shell_window_stack_ids().iter().rev() {
            if self.window_registry.is_shell_hosted(wid) {
                continue;
            }
            if self.logical_focus_target_is_valid(wid) {
                return Some(wid);
            }
        }
        None
    }

    pub(crate) fn shell_window_stack_ids(&self) -> Vec<u32> {
        let ordered: Vec<u32> = self
            .shell_window_stack_order
            .iter()
            .copied()
            .filter(|wid| self.window_registry.window_info(*wid).is_some())
            .collect();
        let seen: HashSet<u32> = ordered.iter().copied().collect();
        let mut missing: Vec<u32> = self
            .window_registry
            .all_records()
            .into_iter()
            .map(|record| record.info.window_id)
            .filter(|wid| !seen.contains(wid))
            .collect();
        missing.sort_unstable();
        missing.extend(ordered);
        missing
    }

    pub(crate) fn shell_window_stack_z(&self, window_id: u32) -> u32 {
        self.shell_window_stack_ids()
            .iter()
            .position(|wid| *wid == window_id)
            .map(|idx| idx as u32 + 1)
            .unwrap_or(0)
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
    ) -> Result<Self, String> {
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
        let layer_shell_state = WlrLayerShellState::new::<Self>(&dh);
        let foreign_toplevel_list_state = ForeignToplevelListState::new::<Self>(&dh);
        let idle_inhibit_manager_state = IdleInhibitManagerState::new::<Self>(&dh);
        let keyboard_shortcuts_inhibit_state = KeyboardShortcutsInhibitState::new::<Self>(&dh);
        let screencopy_manager_state =
            crate::render::capture::ScreencopyManagerState::new::<Self>(&dh);
        let ext_image_capture_manager_state =
            crate::render::capture_ext::ExtImageCaptureManagerState::new::<Self>(&dh);
        let mut seat_state = SeatState::new();
        let data_device_state = DataDeviceState::new::<Self>(&dh);
        let data_control_state = DataControlState::new::<Self, _>(&dh, None, |_| true);
        let xwayland_shell_state = XWaylandShellState::new::<Self>(&dh);
        let chrome_bridge = options.chrome_bridge;
        let shell_to_cef = options.shell_to_cef;
        let shell_cef_handshake = options.shell_cef_handshake;
        let shell_ipc_stall_timeout = options.shell_ipc_stall_timeout;
        let popups = PopupManager::default();
        let window_registry = WindowRegistry::new();
        let wallpaper_loader = crate::desktop::desktop_background::spawn_wallpaper_loader_thread();
        let (cursor_fallback_buffer, cursor_fallback_hotspot) =
            crate::platform::cursor_fallback::load_cursor_fallback();

        let mut seat: Seat<Self> = seat_state.new_wl_seat(&dh, &options.seat_name);
        seat.add_keyboard(Default::default(), 200, 25)
            .map_err(|e| format!("seat add keyboard: {e:?}"))?;
        seat.add_pointer();

        let space = Space::default();

        let socket_name = crate::platform::wayland_listener::init_wayland_listener(
            display,
            event_loop,
            &options.socket,
        )?;

        let loop_signal = event_loop.get_signal();
        let event_loop_stop = Arc::new(AtomicBool::new(false));

        let (cef_to_compositor_tx, cef_rx) = channel::channel();
        event_loop
            .handle()
            .insert_source(cef_rx, |ev, _, d: &mut CalloopData| match ev {
                CalloopChannelEvent::Msg(
                    crate::cef::compositor_tx::CefToCompositor::ShellRxNote,
                ) => {
                    d.state.shell_note_shell_ipc_rx();
                }
                CalloopChannelEvent::Msg(
                    crate::cef::compositor_tx::CefToCompositor::DmabufReady(latest_dmabuf),
                ) => loop {
                    let Some(frame) = latest_dmabuf.take() else {
                        if latest_dmabuf.finish_dispatch() {
                            continue;
                        }
                        break;
                    };
                    d.state.accept_shell_dmabuf_from_cef(
                        frame.width,
                        frame.height,
                        frame.drm_format,
                        frame.modifier,
                        frame.flags,
                        frame.generation,
                        &frame.planes,
                        frame.fds,
                        frame.dirty_buffer,
                    );
                    if let Some(drms) = d.drm.as_mut() {
                        drms.request_render();
                    }
                    if !latest_dmabuf.finish_dispatch() {
                        break;
                    }
                },
                CalloopChannelEvent::Msg(crate::cef::compositor_tx::CefToCompositor::Run(f)) => {
                    f(&mut d.state);
                }
                CalloopChannelEvent::Closed => {}
            })
            .map_err(|e| format!("cef from-shell channel: {e}"))?;

        let (sni_to_loop_tx, sni_rx) = channel::channel::<shell_wire::SniTrayLoopMsg>();
        let (sni_cmd_tx, sni_cmd_rx) =
            std::sync::mpsc::channel::<crate::tray::sni_tray::SniTrayCmd>();
        crate::tray::sni_tray::spawn_sni_tray_thread(sni_to_loop_tx, sni_cmd_rx);
        event_loop
            .handle()
            .insert_source(sni_rx, |ev, _, d: &mut CalloopData| match ev {
                CalloopChannelEvent::Msg(msg) => match msg {
                    shell_wire::SniTrayLoopMsg::Items(items) => {
                        d.state.on_sni_tray_items_updated(items);
                    }
                    shell_wire::SniTrayLoopMsg::Menu(menu) => {
                        d.state.on_sni_tray_menu_updated(menu);
                    }
                },
                CalloopChannelEvent::Closed => {}
            })
            .map_err(|e| format!("sni tray channel: {e}"))?;

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
            capture_dmabuf_formats: Vec::new(),
            capture_dmabuf_device: None,
            output_manager_state,
            layer_shell_state,
            foreign_toplevel_list_state,
            capture_toplevel_handles: HashMap::new(),
            capture_window_source_cache: HashMap::new(),
            _idle_inhibit_manager_state: idle_inhibit_manager_state,
            idle_inhibit_surfaces: HashSet::new(),
            keyboard_shortcuts_inhibit_state,
            _screencopy_manager_state: screencopy_manager_state,
            pending_screencopy_copies: Vec::new(),
            _ext_image_capture_manager_state: ext_image_capture_manager_state,
            pending_image_copy_captures: Vec::new(),
            seat_state,
            data_device_state,
            data_control_state,
            screenshot_request: None,
            screenshot_selection_active: false,
            screenshot_selection_anchor: None,
            screenshot_selection_current: None,
            screenshot_overlay_needs_full_damage: false,
            capture_force_full_damage_frames: 0,
            active_image_copy_capture_sessions: 0,
            popups,
            shell_tray_strip_global: None,
            sni_tray_cmd_tx: Some(sni_cmd_tx),
            sni_tray_slot_count: 0,
            xwayland_shell_state,
            x11_wm_slot: None,
            x11_client: None,
            seat,
            chrome_bridge,
            window_registry,
            pending_deferred_toplevels: HashMap::new(),
            pending_gnome_initial_toplevels: HashSet::new(),
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
            programs_menu_super_pending_toggle: false,
            keyboard_layout_by_window: HashMap::new(),
            keyboard_layout_last_focus_window: None,
            keyboard_layout_focus_queue: VecDeque::new(),
            shell_hosted_app_state: HashMap::new(),
            session_default_layout_index: 0,
            shell_pointer_norm: None,
            shell_initial_pointer_centered: false,
            shell_last_pointer_ipc_px: None,
            shell_last_pointer_ipc_global_logical: None,
            // Smithay only calls `cursor_image` when focus changes; motion with focus `None` and no
            // prior surface leaves this stale — `Hidden` meant zero composited cursor on the shell/CEF path.
            pointer_cursor_image: CursorImageStatus::default_named(),
            cursor_fallback_buffer,
            cursor_fallback_hotspot,
            shell_spawn_focus_above_window_id: None,
            shell_minimized_windows: HashMap::new(),
            shell_minimized_x11_windows: HashMap::new(),
            shell_pending_native_focus_window_id: None,
            shell_close_pending_native_windows: HashSet::new(),
            shell_close_refocus_targets: HashMap::new(),
            shell_move_window_id: None,
            shell_move_pending_delta: (0, 0),
            shell_backed_move_candidate: None,
            shell_resize_window_id: None,
            shell_resize_edges: None,
            shell_resize_initial_rect: None,
            shell_resize_accum: (0.0, 0.0),
            shell_resize_shell_grab: None,
            shell_ui_pointer_grab: None,
            shell_ipc_stall_timeout,
            shell_ipc_watchdog_armed: false,
            shell_ipc_last_rx: None,
            shell_ipc_last_compositor_ping: None,
            shell_ipc_last_pong: None,
            shell_ipc_unanswered_ping_since: None,
            shell_ipc_ping_late_warned_for: None,
            shell_has_frame: false,
            shell_view_px: None,
            shell_frame_is_dmabuf: false,
            shell_dmabuf: None,
            shell_dmabuf_generation: 0,
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
            shell_exclusion_floating: Vec::new(),
            shell_exclusion_overlay_open: false,
            shell_exclusion_zones_need_full_damage: false,
            e2e_last_session_power_action: None,
            e2e_last_session_power_requested_at_ms: None,
            shell_ui_windows: Vec::new(),
            shell_ui_windows_generation: 0,
            shell_ui_windows_shared_sequence: 0,
            shell_focused_ui_window_id: None,
            shell_window_stack_order: Vec::new(),
            workspace_state: WorkspaceState::default(),
            shell_last_sent_ui_focus_id: None,
            shell_exclusion_shared_sequence: 0,
            tile_preview_rect_global: None,
            tile_preview_solid: SolidColorBuffer::new((1, 1), Color32F::TRANSPARENT),
            shell_chrome_titlebar_h: SHELL_TITLEBAR_HEIGHT,
            shell_chrome_border_w: SHELL_BORDER_THICKNESS,
            desktop_background_config:
                crate::controls::display_config::DesktopBackgroundConfig::default(),
            desktop_background_by_output_name: HashMap::new(),
            wallpaper_req_tx: wallpaper_loader.req_tx,
            wallpaper_done_rx: wallpaper_loader.done_rx,
            desktop_wallpaper_cpu_by_path: HashMap::new(),
            desktop_wallpaper_gpu_by_path: HashMap::new(),
            wallpaper_decode_inflight: HashSet::new(),
            backdrop_wallpaper_id_cache: HashMap::new(),
            backdrop_layers_by_output: HashMap::new(),
            shell_render_cache_by_output: HashMap::new(),
            shell_begin_frame_last: None,
            shell_begin_frame_fast_until: None,
        };
        crate::controls::display_config::apply_keyboard_from_display_file(&mut s);
        let keyboard_settings = crate::session::settings_config::read_keyboard_settings();
        if !keyboard_settings.layouts.is_empty() {
            let _ = s.keyboard_apply_settings(&keyboard_settings);
        }
        crate::desktop::desktop_background::load_from_display_file_into(&mut s);
        s.session_default_layout_index = s.keyboard_layout_index_current();
        s.hydrate_shell_hosted_app_state_from_session();
        Ok(s)
    }

    pub(crate) fn keyboard_clear_per_window_layout_map(&mut self) {
        self.keyboard_layout_by_window.clear();
        self.keyboard_layout_last_focus_window = None;
        self.keyboard_layout_focus_queue.clear();
    }

    pub(crate) fn keyboard_apply_settings(
        &mut self,
        settings: &crate::session::settings_config::KeyboardSettingsFile,
    ) -> Result<(), String> {
        if settings.layouts.is_empty() {
            return Err("keyboard layouts cannot be empty".into());
        }
        let Some(handle) = self.seat.get_keyboard() else {
            return Err("missing keyboard handle".into());
        };
        let base =
            crate::controls::display_config::read_keyboard_from_display_file().unwrap_or_default();
        let layout = settings
            .layouts
            .iter()
            .map(|entry| entry.layout.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let variant = settings
            .layouts
            .iter()
            .map(|entry| entry.variant.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let xkb_cfg = XkbConfig {
            rules: base.rules.as_str(),
            model: base.model.as_str(),
            layout: layout.as_str(),
            variant: variant.as_str(),
            options: base.options.clone(),
        };
        handle
            .set_xkb_config(self, xkb_cfg)
            .map_err(|e| format!("set_xkb_config: {e:?}"))?;
        handle.change_repeat_info(
            i32::try_from(settings.repeat_rate)
                .map_err(|_| "repeat_rate out of range".to_string())?,
            i32::try_from(settings.repeat_delay_ms)
                .map_err(|_| "repeat_delay_ms out of range".to_string())?,
        );
        self.keyboard_clear_per_window_layout_map();
        self.session_default_layout_index = self.keyboard_layout_index_current();
        self.emit_keyboard_layout_to_shell();
        Ok(())
    }

    pub(crate) fn apply_desktop_background_from_display_file(
        &mut self,
        cfg: &crate::controls::display_config::DisplayConfigFile,
    ) {
        self.desktop_background_config = cfg.desktop_background.clone();
        self.desktop_background_by_output_name = cfg.desktop_background_outputs.clone();
        self.backdrop_layers_by_output.clear();
        self.request_desktop_wallpaper_decode();
    }

    pub(crate) fn desktop_background_for_output(
        &self,
        output: &Output,
    ) -> &crate::controls::display_config::DesktopBackgroundConfig {
        let n = output.name();
        self.desktop_background_by_output_name
            .get(&n)
            .unwrap_or(&self.desktop_background_config)
    }

    fn collect_desktop_wallpaper_paths(&self) -> HashSet<PathBuf> {
        let mut s = HashSet::new();
        let mut add = |cfg: &crate::controls::display_config::DesktopBackgroundConfig| {
            if cfg.mode == "image" && !cfg.image_path.trim().is_empty() {
                let p =
                    crate::desktop::desktop_background::normalize_filesystem_path(&cfg.image_path);
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
        self.desktop_wallpaper_cpu_by_path
            .retain(|k, _| needed.contains(k));
        self.desktop_wallpaper_gpu_by_path
            .retain(|k, _| needed.contains(k));
        self.wallpaper_decode_inflight
            .retain(|k| needed.contains(k));
    }

    pub fn apply_shell_desktop_background_json(&mut self, json: &str) {
        #[derive(serde::Deserialize)]
        struct ShellDesktopBg {
            #[serde(flatten)]
            default: crate::controls::display_config::DesktopBackgroundConfig,
            #[serde(default)]
            desktop_background_outputs:
                HashMap<String, crate::controls::display_config::DesktopBackgroundConfig>,
        }
        let (default, outs) = match serde_json::from_str::<ShellDesktopBg>(json) {
            Ok(w) => (w.default, w.desktop_background_outputs),
            Err(_) => {
                let cfg: crate::controls::display_config::DesktopBackgroundConfig =
                    match serde_json::from_str(json) {
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
                    self.desktop_wallpaper_cpu_by_path
                        .insert(path, Arc::new(cpu));
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

    pub fn sync_shell_shared_state(&mut self, kind: u32) {
        let path = crate::cef::shared_state::path_for_kind(crate::cef::runtime_dir(), kind);
        let min_sequence_exclusive = match kind {
            crate::cef::shared_state::SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES => {
                Some(self.shell_exclusion_shared_sequence)
            }
            crate::cef::shared_state::SHELL_SHARED_STATE_KIND_UI_WINDOWS => {
                Some(self.shell_ui_windows_shared_sequence)
            }
            _ => None,
        };
        let Ok(Some((sequence, payload))) = crate::cef::shared_state::read_payload_if_newer(
            &path,
            crate::cef::shared_state::SHELL_SHARED_STATE_ABI_VERSION,
            min_sequence_exclusive,
        ) else {
            return;
        };
        match kind {
            crate::cef::shared_state::SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES => {
                self.shell_exclusion_shared_sequence = sequence;
                self.apply_shell_exclusion_zones_payload(&payload);
            }
            crate::cef::shared_state::SHELL_SHARED_STATE_KIND_UI_WINDOWS => {
                self.shell_ui_windows_shared_sequence = sequence;
                self.apply_shell_ui_windows_payload(&payload);
            }
            _ => {}
        }
    }

    pub(crate) fn sync_shell_shared_state_for_input(&mut self) {
        self.sync_shell_shared_state(
            crate::cef::shared_state::SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES,
        );
        self.sync_shell_shared_state(crate::cef::shared_state::SHELL_SHARED_STATE_KIND_UI_WINDOWS);
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
        elem: &DerpSpaceElem,
        pos: Point<f64, Logical>,
    ) -> bool {
        if self.point_in_shell_exclusion_zones(pos) {
            return true;
        }
        let Some(window_id) = self.derp_elem_window_id(elem) else {
            return false;
        };
        self.shell_ui_placement_topmost_at(pos)
            .is_some_and(|w| self.shell_placement_renders_above_window(&w, window_id))
    }

    fn shell_placement_renders_above_window(
        &self,
        placement: &ShellUiWindowPlacement,
        window_id: u32,
    ) -> bool {
        let native_z = self.shell_window_stack_z(window_id);
        placement.z > native_z || (placement.z == native_z && placement.id > window_id)
    }

    pub(crate) fn shell_ui_placement_topmost_at(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<ShellUiWindowPlacement> {
        let px = pos.x;
        let py = pos.y;
        let mut best: Option<ShellUiWindowPlacement> = None;
        let placements = self.shell_hosted_visible_placements();
        for w in &placements {
            let g = &w.global_rect;
            let x2 = g.loc.x.saturating_add(g.size.w) as f64;
            let y2 = g.loc.y.saturating_add(g.size.h) as f64;
            if px >= g.loc.x as f64 && px < x2 && py >= g.loc.y as f64 && py < y2 {
                if best
                    .as_ref()
                    .is_none_or(|cur| w.z > cur.z || (w.z == cur.z && w.id > cur.id))
                {
                    best = Some(w.clone());
                }
            }
        }
        best
    }

    pub(crate) fn native_surface_under_no_shell_exclusion(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(Option<u32>, WlSurface, Point<f64, Logical>)> {
        if let Some((surface, point)) = self.layer_surface_under(pos, &[Layer::Overlay, Layer::Top])
        {
            return Some((None, surface, point));
        }
        for elem in self.space.elements().rev() {
            let Some(map_loc) = self.space.element_location(elem) else {
                continue;
            };
            let render_loc = map_loc - elem.geometry().loc;
            let local = pos - render_loc.to_f64();
            let window_id = self.derp_elem_window_id(elem);
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
            return Some((window_id, surf, p_global));
        }
        self.layer_surface_under(pos, &[Layer::Bottom, Layer::Background])
            .map(|(surface, point)| (None, surface, point))
    }

    pub(crate) fn shell_ui_placement_topmost_for_input_at(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<ShellUiWindowPlacement> {
        let placement = self.shell_ui_placement_topmost_at(pos)?;
        let Some((window_id, _, _)) = self.native_surface_under_no_shell_exclusion(pos) else {
            return Some(placement);
        };
        let Some(window_id) = window_id else {
            return None;
        };
        self.shell_placement_renders_above_window(&placement, window_id)
            .then_some(placement)
    }

    fn shell_visible_placements(&self) -> Vec<ShellUiWindowPlacement> {
        let mut placements = self.shell_ui_windows.clone();
        let shell_ids: HashSet<u32> = placements.iter().map(|w| w.id).collect();
        placements.extend(
            self.shell_backed_placements()
                .into_iter()
                .filter(|w| !shell_ids.contains(&w.id)),
        );
        placements
    }

    fn shell_hosted_visible_placements(&self) -> Vec<ShellUiWindowPlacement> {
        self.shell_visible_placements()
            .into_iter()
            .filter(|w| self.window_registry.is_shell_hosted(w.id))
            .collect()
    }

    fn shell_hosted_clip_placements(
        &self,
        native_window_id: Option<u32>,
    ) -> Vec<ShellUiWindowPlacement> {
        let placements = self.shell_hosted_visible_placements();
        let Some(native_window_id) = native_window_id else {
            return placements;
        };
        placements
            .into_iter()
            .filter(|w| self.shell_placement_renders_above_window(w, native_window_id))
            .collect()
    }

    pub(crate) fn shell_global_rect_to_buffer_rect(
        &self,
        global: &Rectangle<i32, Logical>,
    ) -> Option<Rectangle<i32, Buffer>> {
        let (buf_w, buf_h) = self.shell_view_px?;
        let content_h = buf_h.max(1);
        let (lw_u, lh_u) = self.shell_output_logical_size()?;
        let lw = lw_u as i32;
        let lh = lh_u as i32;
        let (ox, oy, cw_l, ch_l) = crate::shell::shell_letterbox::letterbox_logical(
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
            if let Some((bx, by)) = crate::shell::shell_letterbox::local_in_letterbox_to_buffer_px(
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
        Some(Rectangle::new(
            Point::new(min_x, min_y),
            Size::new((max_x - min_x + 1).max(1), (max_y - min_y + 1).max(1)),
        ))
    }

    pub fn apply_shell_ui_windows_payload(&mut self, payload: &[u8]) {
        const MAX: usize = shell_wire::MAX_SHELL_UI_WINDOWS as usize;
        if payload.len() < 8 {
            return;
        }
        let generation = u32::from_le_bytes(payload[0..4].try_into().unwrap());
        let count = u32::from_le_bytes(payload[4..8].try_into().unwrap()) as usize;
        let need = 8usize.checked_add(count.checked_mul(28).unwrap_or(usize::MAX));
        if need != Some(payload.len()) {
            return;
        }
        let Some(ws) = self.workspace_logical_bounds() else {
            self.shell_ui_windows.clear();
            return;
        };
        let mut rows = Vec::new();
        let mut offset = 8usize;
        for _ in 0..count {
            let id = u32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
            let gx = i32::from_le_bytes(payload[offset + 4..offset + 8].try_into().unwrap());
            let gy = i32::from_le_bytes(payload[offset + 8..offset + 12].try_into().unwrap());
            let gw = u32::from_le_bytes(payload[offset + 12..offset + 16].try_into().unwrap());
            let gh = u32::from_le_bytes(payload[offset + 16..offset + 20].try_into().unwrap());
            let _z = u32::from_le_bytes(payload[offset + 20..offset + 24].try_into().unwrap());
            offset += 28;
            if id == 0 || gw == 0 || gh == 0 {
                continue;
            }
            rows.push((
                id,
                gx,
                gy,
                gw as i32,
                gh as i32,
                self.shell_window_stack_z(id),
            ));
        }
        rows.sort_by(|a, b| a.5.cmp(&b.5).then_with(|| a.0.cmp(&b.0)));
        let mut out = Vec::new();
        for (id, gx, gy, gw, gh, z) in rows.into_iter().take(MAX) {
            let gr = Rectangle::new(
                Point::<i32, Logical>::from((gx, gy)),
                Size::<i32, Logical>::from((gw.max(1), gh.max(1))),
            );
            let Some(clamped) = gr.intersection(ws) else {
                continue;
            };
            let Some(br) = self.shell_global_rect_to_buffer_rect(&clamped) else {
                continue;
            };
            out.push(ShellUiWindowPlacement {
                id,
                z,
                global_rect: clamped,
                buffer_rect: br,
            });
        }
        let js_changed = out != self.shell_ui_windows;
        self.shell_ui_windows = out;
        self.shell_ui_windows_generation = generation;
        if let Some(fid) = self.shell_focused_ui_window_id {
            if !self.shell_ui_windows.iter().any(|w| w.id == fid)
                && !self.window_registry.is_shell_hosted(fid)
            {
                self.shell_emit_shell_ui_focus_if_changed(None);
            }
        }
        if let Some(gid) = self.shell_ui_pointer_grab {
            if !self.shell_ui_windows.iter().any(|w| w.id == gid)
                && !self.window_registry.is_shell_hosted(gid)
            {
                self.shell_ui_pointer_grab = None;
            }
        }
        if js_changed {
            self.shell_exclusion_zones_need_full_damage = true;
        }
    }

    pub(crate) fn shell_emit_shell_ui_focus_if_changed(&mut self, id: Option<u32>) {
        self.shell_focused_ui_window_id = id;
        if id == self.shell_last_sent_ui_focus_id {
            return;
        }
        tracing::warn!(
            target: "derp_shell_clip",
            focused = ?id,
            logical = ?self.logical_focused_window_id(),
            "shell ui focus changed"
        );
        self.shell_last_sent_ui_focus_id = id;
        let (surface_id, window_id) = match id {
            None => (None, None),
            Some(w) => (Some(w), Some(w)),
        };
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id,
            window_id,
        });
        self.shell_exclusion_zones_need_full_damage = true;
    }

    pub(crate) fn shell_emit_shell_ui_focus_from_point(&mut self, pos: Point<f64, Logical>) {
        if self.shell_point_in_shell_floating_overlay_global(pos) {
            return;
        }
        let id = self
            .shell_ui_placement_topmost_for_input_at(pos)
            .map(|w| w.id);
        let Some(window_id) = id else {
            return;
        };
        self.shell_window_stack_touch(window_id);
        self.shell_emit_shell_ui_focus_if_changed(Some(window_id));
        self.shell_reply_window_list();
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
            && !self.window_registry.is_shell_hosted(window_id)
        {
            return;
        }
        let k_serial = SERIAL_COUNTER.next_serial();
        self.space.elements().for_each(|e| {
            e.set_activate(false);
            if let DerpSpaceElem::Wayland(w) = e {
                if let Some(toplevel) = w.toplevel() {
                    toplevel.send_pending_configure();
                }
            }
        });
        let Some(keyboard) = self.seat.get_keyboard() else {
            return;
        };
        keyboard.set_focus(self, Option::<WlSurface>::None, k_serial);
        self.keyboard_on_focus_surface_changed(None);
        self.shell_pending_native_focus_window_id = None;
        self.shell_ipc_keyboard_to_cef = true;
        self.shell_window_stack_touch(window_id);
        self.shell_emit_shell_ui_focus_if_changed(Some(window_id));
        self.shell_reply_window_list();
    }

    pub(crate) fn shell_blur_shell_ui_focus(&mut self) {
        self.shell_ui_pointer_grab = None;
        self.shell_emit_shell_ui_focus_if_changed(None);
        self.shell_ipc_keyboard_to_cef = false;
        let k_serial = SERIAL_COUNTER.next_serial();
        self.seat
            .get_keyboard()
            .unwrap()
            .set_focus(self, Option::<WlSurface>::None, k_serial);
        self.keyboard_on_focus_surface_changed(None);
    }

    pub fn apply_shell_exclusion_zones_payload(&mut self, payload: &[u8]) {
        if payload.len() < 8 {
            return;
        }
        let rect_count = u32::from_le_bytes(payload[0..4].try_into().unwrap()) as usize;
        let has_tray_strip = u32::from_le_bytes(payload[4..8].try_into().unwrap());
        if has_tray_strip > 1 {
            return;
        }
        let base_len = 8usize
            .saturating_add(rect_count.saturating_mul(20))
            .saturating_add(if has_tray_strip == 1 { 16 } else { 0 });
        if payload.len() < base_len {
            return;
        }
        let mut overlay_open = false;
        let mut next_floating: Vec<Rectangle<i32, Logical>> = Vec::new();
        if payload.len() > base_len {
            if payload.len() < base_len + 8 {
                return;
            }
            let fc = u32::from_le_bytes(payload[base_len + 4..base_len + 8].try_into().unwrap()) as usize;
            let expected = base_len + 8 + fc.saturating_mul(20);
            if expected != payload.len() {
                return;
            }
            overlay_open = u32::from_le_bytes(payload[base_len..base_len + 4].try_into().unwrap()) != 0;
            let mut fo = base_len + 8;
            for _ in 0..fc {
                let x = i32::from_le_bytes(payload[fo..fo + 4].try_into().unwrap());
                let y = i32::from_le_bytes(payload[fo + 4..fo + 8].try_into().unwrap());
                let w = i32::from_le_bytes(payload[fo + 8..fo + 12].try_into().unwrap());
                let h = i32::from_le_bytes(payload[fo + 12..fo + 16].try_into().unwrap());
                let r = Rectangle::new(
                    Point::<i32, Logical>::from((x, y)),
                    Size::<i32, Logical>::from((w.max(1), h.max(1))),
                );
                fo += 20;
                next_floating.push(r);
            }
        } else if payload.len() != base_len {
            return;
        }
        let Some(ws) = self.workspace_logical_bounds() else {
            self.shell_exclusion_global.clear();
            self.shell_exclusion_decor.clear();
            self.shell_exclusion_floating.clear();
            self.shell_exclusion_overlay_open = false;
            self.shell_tray_strip_global = None;
            self.shell_exclusion_zones_need_full_damage = true;
            self.shell_dmabuf_dirty_force_full = true;
            return;
        };
        let mut next_global: Vec<Rectangle<i32, Logical>> = Vec::new();
        let mut next_decor: HashMap<u32, Vec<Rectangle<i32, Logical>>> = HashMap::new();
        let mut offset = 8usize;
        for _ in 0..rect_count {
            let x = i32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
            let y = i32::from_le_bytes(payload[offset + 4..offset + 8].try_into().unwrap());
            let w = i32::from_le_bytes(payload[offset + 8..offset + 12].try_into().unwrap());
            let h = i32::from_le_bytes(payload[offset + 12..offset + 16].try_into().unwrap());
            let window_id =
                u32::from_le_bytes(payload[offset + 16..offset + 20].try_into().unwrap());
            offset += 20;
            let r = Rectangle::new(
                Point::<i32, Logical>::from((x, y)),
                Size::<i32, Logical>::from((w.max(1), h.max(1))),
            );
            let Some(clamped) = r.intersection(ws) else {
                continue;
            };
            if window_id == 0 {
                next_global.push(clamped);
            } else {
                next_decor.entry(window_id).or_default().push(clamped);
            }
        }
        let next_tray_strip = if has_tray_strip == 0 {
            None
        } else {
            let x = i32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
            let y = i32::from_le_bytes(payload[offset + 4..offset + 8].try_into().unwrap());
            let w = i32::from_le_bytes(payload[offset + 8..offset + 12].try_into().unwrap());
            let h = i32::from_le_bytes(payload[offset + 12..offset + 16].try_into().unwrap());
            if w < 1 || h < 1 {
                None
            } else {
                Rectangle::new(
                    Point::<i32, Logical>::from((x, y)),
                    Size::<i32, Logical>::from((w.max(1), h.max(1))),
                )
                .intersection(ws)
            }
        };
        next_floating.retain_mut(|r| {
            if let Some(c) = r.intersection(ws) {
                *r = c;
                true
            } else {
                false
            }
        });
        let global_changed = next_global != self.shell_exclusion_global;
        let tray_changed = next_tray_strip != self.shell_tray_strip_global;
        let floating_changed = next_floating != self.shell_exclusion_floating;
        let overlay_changed = overlay_open != self.shell_exclusion_overlay_open;
        self.shell_exclusion_global = next_global;
        self.shell_exclusion_decor = next_decor;
        self.shell_exclusion_floating = next_floating;
        self.shell_exclusion_overlay_open = overlay_open;
        self.shell_tray_strip_global = next_tray_strip;
        if global_changed || tray_changed || floating_changed || overlay_changed {
            self.shell_exclusion_zones_need_full_damage = true;
            self.shell_dmabuf_dirty_force_full = true;
        }
    }

    pub(crate) fn derp_elem_window_id(&self, elem: &DerpSpaceElem) -> Option<u32> {
        match elem {
            DerpSpaceElem::Wayland(w) => w.toplevel().and_then(|t| {
                self.window_registry
                    .window_id_for_wl_surface(t.wl_surface())
            }),
            DerpSpaceElem::X11(x) => x
                .wl_surface()
                .as_ref()
                .and_then(|s| self.window_registry.window_id_for_wl_surface(s)),
        }
    }

    pub(crate) fn ordered_window_ids_on_output(&self, output: &Output) -> Vec<u32> {
        let mut seen = HashSet::new();
        let mut stack = Vec::new();
        for id in self
            .space
            .elements_for_output(output)
            .filter_map(|e| self.derp_elem_window_id(e))
        {
            if seen.insert(id) {
                stack.push(id);
            }
        }
        stack
    }

    fn window_ids_strictly_above_in_stack<'a>(
        &self,
        ordered_window_ids: &'a [u32],
        self_id: u32,
    ) -> &'a [u32] {
        let Some(idx) = ordered_window_ids.iter().position(|id| *id == self_id) else {
            return &[];
        };
        &ordered_window_ids[(idx + 1)..]
    }

    pub(crate) fn shell_exclusion_clip_rects_logical(
        &self,
        output: &Output,
        elem_window: Option<u32>,
        include_self_decor: bool,
        ordered_window_ids_on_output: Option<&[u32]>,
    ) -> Vec<Rectangle<i32, Logical>> {
        let Some(ws) = self.workspace_logical_bounds() else {
            return Vec::new();
        };
        let Some(out_geo) = self.space.output_geometry(output) else {
            return Vec::new();
        };
        let Some(visible) = ws.intersection(out_geo) else {
            return Vec::new();
        };
        let mut out: Vec<Rectangle<i32, Logical>> = self
            .shell_exclusion_global
            .iter()
            .filter_map(|z| z.intersection(visible))
            .collect();
        let placements = self.shell_hosted_clip_placements(elem_window);
        match elem_window {
            None => {
                for rs in self.shell_exclusion_decor.values() {
                    for r in rs {
                        if let Some(i) = r.intersection(visible) {
                            out.push(i);
                        }
                    }
                }
            }
            Some(self_id) => {
                let ordered_window_ids_on_output_owned;
                let ordered_window_ids_on_output = if let Some(ordered) =
                    ordered_window_ids_on_output
                {
                    ordered
                } else {
                    ordered_window_ids_on_output_owned = self.ordered_window_ids_on_output(output);
                    &ordered_window_ids_on_output_owned
                };
                for &ow in
                    self.window_ids_strictly_above_in_stack(ordered_window_ids_on_output, self_id)
                {
                    if let Some(rs) = self.shell_exclusion_decor.get(&ow) {
                        for r in rs {
                            if let Some(i) = r.intersection(visible) {
                                out.push(i);
                            }
                        }
                    }
                }
                if include_self_decor {
                    if let Some(rs) = self.shell_exclusion_decor.get(&self_id) {
                        for r in rs {
                            if let Some(i) = r.intersection(visible) {
                                out.push(i);
                            }
                        }
                    }
                }
            }
        }
        for w in &placements {
            if let Some(i) = w.global_rect.intersection(visible) {
                out.push(i);
            }
        }
        out
    }

    pub(crate) fn shell_exclusion_clip_ctx_for_draw(
        &self,
        output: &Output,
        elem_window: Option<u32>,
        include_self_decor: bool,
        ordered_window_ids_on_output: Option<&[u32]>,
    ) -> Option<Arc<exclusion_clip::ShellExclusionClipCtx>> {
        let zones = self.shell_exclusion_clip_rects_logical(
            output,
            elem_window,
            include_self_decor,
            ordered_window_ids_on_output,
        );
        if zones.is_empty() {
            return None;
        }
        let Some(out_geo) = self.space.output_geometry(output) else {
            return None;
        };
        let Some(ws) = self.workspace_logical_bounds() else {
            return None;
        };
        let Some(visible) = ws.intersection(out_geo) else {
            return None;
        };
        let filtered: Vec<Rectangle<i32, Logical>> = zones
            .iter()
            .filter_map(|z| z.intersection(visible))
            .collect();
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
        self.shell_to_cef
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }

    pub(crate) fn shell_send_to_cef(&mut self, msg: shell_wire::DecodedCompositorToShellMessage) {
        let workspace_dirty = matches!(
            msg,
            shell_wire::DecodedCompositorToShellMessage::WindowMapped { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowList { .. }
        );
        let Ok(g) = self.shell_to_cef.lock() else {
            return;
        };
        if let Some(link) = g.as_ref() {
            link.send(msg);
        }
        drop(g);
        if workspace_dirty {
            self.workspace_sync_from_registry();
            self.workspace_send_state();
        }
    }

    const SHELL_BEGIN_FRAME_INTERACTION_HOLD: Duration = Duration::from_millis(160);
    const SHELL_BEGIN_FRAME_FORCED_REPAINT_HOLD: Duration = Duration::from_millis(450);

    fn shell_begin_frame_fast_track_for(&mut self, hold: Duration) {
        let until = Instant::now() + hold;
        match self.shell_begin_frame_fast_until {
            Some(prev) if prev >= until => {}
            _ => self.shell_begin_frame_fast_until = Some(until),
        }
    }

    pub(crate) fn shell_begin_frame_note_shell_input(&mut self) {
        self.shell_begin_frame_fast_track_for(Self::SHELL_BEGIN_FRAME_INTERACTION_HOLD);
    }

    pub(crate) fn shell_begin_frame_note_forced_repaint(&mut self) {
        self.shell_begin_frame_fast_track_for(Self::SHELL_BEGIN_FRAME_FORCED_REPAINT_HOLD);
    }

    pub(crate) fn shell_begin_frame_interaction_active(&self, now: Instant) -> bool {
        self.shell_move_is_active()
            || self.shell_resize_is_active()
            || self.shell_ui_pointer_grab_active()
            || self.screenshot_selection_active()
            || self.touch_routes_to_cef
            || self
                .shell_begin_frame_fast_until
                .is_some_and(|until| now < until)
    }

    pub(crate) fn shell_nudge_cef_repaint(&mut self) {
        self.shell_begin_frame_note_forced_repaint();
        let Ok(g) = self.shell_to_cef.lock() else {
            tracing::warn!(target: "derp_hotplug_shell", "shell_nudge_cef_repaint shell_to_cef lock poisoned");
            return;
        };
        if let Some(link) = g.as_ref() {
            link.schedule_external_begin_frame(
                crate::cef::begin_frame_diag::CompositorScheduleKind::Forced,
            );
        } else {
            tracing::warn!(target: "derp_hotplug_shell", "shell_nudge_cef_repaint no ShellToCefLink");
        }
    }

    pub(crate) fn programs_menu_toggle_from_super(&mut self, serial: Serial) {
        tracing::warn!(
            target: "derp_shell_menu",
            shell_cef_active = self.shell_cef_active(),
            shell_has_frame = self.shell_has_frame,
            shell_ipc_keyboard_to_cef = self.shell_ipc_keyboard_to_cef,
            pending_toggle = self.programs_menu_super_pending_toggle,
            "programs_menu_toggle_from_super"
        );
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
        self.shell_send_keybind_ex("toggle_programs_menu", None);
    }

    pub(crate) fn shell_send_keybind(&mut self, action: &str) {
        self.shell_send_keybind_ex(action, None);
    }

    pub(crate) fn shell_send_keybind_ex(&mut self, action: &str, target_window_id: Option<u32>) {
        tracing::warn!(
            target: "derp_shell_menu",
            %action,
            ?target_window_id,
            shell_cef_active = self.shell_cef_active(),
            shell_has_frame = self.shell_has_frame,
            shell_ipc_keyboard_to_cef = self.shell_ipc_keyboard_to_cef,
            pending_toggle = self.programs_menu_super_pending_toggle,
            "shell_send_keybind_ex"
        );
        self.shell_begin_frame_note_shell_input();
        self.shell_emit_chrome_event(ChromeEvent::Keybind {
            action: action.to_string(),
            target_window_id,
            output_name: self
                .new_toplevel_placement_output(None)
                .map(|output| output.name().to_string()),
        });
        self.shell_nudge_cef_repaint();
    }

    pub(crate) fn screenshot_selection_active(&self) -> bool {
        self.screenshot_selection_active
    }

    pub(crate) fn begin_screenshot_selection_mode(&mut self) {
        self.screenshot_selection_active = true;
        self.screenshot_selection_anchor = None;
        self.screenshot_selection_current = self
            .seat
            .get_pointer()
            .map(|pointer| pointer.current_location().to_i32_round());
        self.screenshot_overlay_needs_full_damage = true;
        self.programs_menu_super_armed = false;
        self.programs_menu_super_chord = false;
        self.shell_ipc_keyboard_to_cef = false;
        self.shell_emit_shell_ui_focus_if_changed(None);
        self.loop_signal.wakeup();
    }

    pub(crate) fn cancel_screenshot_selection_mode(&mut self) {
        if !self.screenshot_selection_active {
            return;
        }
        self.screenshot_selection_active = false;
        self.screenshot_selection_anchor = None;
        self.screenshot_selection_current = None;
        self.screenshot_overlay_needs_full_damage = true;
        self.programs_menu_super_armed = false;
        self.programs_menu_super_chord = false;
        self.loop_signal.wakeup();
    }

    pub(crate) fn update_screenshot_selection_pointer(&mut self, pos: Point<f64, Logical>) {
        if !self.screenshot_selection_active {
            return;
        }
        self.screenshot_selection_current = Some(pos.to_i32_round());
        self.screenshot_overlay_needs_full_damage = true;
        self.loop_signal.wakeup();
    }

    pub(crate) fn screenshot_selection_rect(&self) -> Option<Rectangle<i32, Logical>> {
        if !self.screenshot_selection_active {
            return None;
        }
        let anchor = self.screenshot_selection_anchor?;
        let current = self.screenshot_selection_current?;
        let x0 = anchor.x.min(current.x);
        let y0 = anchor.y.min(current.y);
        let x1 = anchor.x.max(current.x);
        let y1 = anchor.y.max(current.y);
        let width = x1.saturating_sub(x0).saturating_add(1);
        let height = y1.saturating_sub(y0).saturating_add(1);
        if width <= 0 || height <= 0 {
            return None;
        }
        Some(Rectangle::new((x0, y0).into(), (width, height).into()))
    }

    pub(crate) fn handle_screenshot_pointer_button(
        &mut self,
        button: u32,
        button_state: smithay::backend::input::ButtonState,
    ) -> bool {
        if !self.screenshot_selection_active {
            return false;
        }
        const BTN_LEFT: u32 = 0x110;
        const BTN_RIGHT: u32 = 0x111;
        let pos = self
            .seat
            .get_pointer()
            .map(|pointer| pointer.current_location().to_i32_round())
            .or(self.screenshot_selection_current);
        match (button, button_state) {
            (BTN_RIGHT, smithay::backend::input::ButtonState::Pressed) => {
                self.cancel_screenshot_selection_mode();
            }
            (BTN_LEFT, smithay::backend::input::ButtonState::Pressed) => {
                if let Some(pos) = pos {
                    self.screenshot_selection_anchor = Some(pos);
                    self.screenshot_selection_current = Some(pos);
                    self.screenshot_overlay_needs_full_damage = true;
                    self.loop_signal.wakeup();
                }
            }
            (BTN_LEFT, smithay::backend::input::ButtonState::Released) => {
                let rect = self.screenshot_selection_rect();
                self.cancel_screenshot_selection_mode();
                if let Some(rect) = rect {
                    if let Err(error) = self.request_screenshot_region(rect) {
                        tracing::warn!(%error, "screenshot region request failed");
                    }
                }
            }
            _ => {}
        }
        true
    }

    pub(crate) fn request_screenshot_current_output(&mut self) -> Result<(), String> {
        let output = self
            .new_toplevel_placement_output(None)
            .ok_or_else(|| "no output available for screenshot".to_string())?;
        self.screenshot_request =
            Some(crate::render::screenshot::PendingScreenshotRequest::for_output(output.name()));
        self.loop_signal.wakeup();
        Ok(())
    }

    pub(crate) fn request_screenshot_region(
        &mut self,
        logical_rect: Rectangle<i32, Logical>,
    ) -> Result<(), String> {
        if logical_rect.size.w <= 0 || logical_rect.size.h <= 0 {
            return Err("screenshot region must be non-empty".into());
        }
        let outputs = self
            .space
            .outputs()
            .filter_map(|output| {
                let geo = self.space.output_geometry(output)?;
                if geo.overlaps(logical_rect) {
                    Some(output.name())
                } else {
                    None
                }
            })
            .collect();
        self.screenshot_request = Some(
            crate::render::screenshot::PendingScreenshotRequest::for_region(logical_rect, outputs)?,
        );
        self.loop_signal.wakeup();
        Ok(())
    }

    pub(crate) fn screenshot_capture_output_if_needed(
        &mut self,
        output: &Output,
        renderer: &mut GlesRenderer,
        framebuffer: &GlesTarget<'_>,
    ) {
        let Some(mut request) = self.screenshot_request.take() else {
            return;
        };
        let output_name = output.name();
        if !request.needs_output(&output_name) {
            self.screenshot_request = Some(request);
            return;
        }
        let capture = (|| -> Result<(), String> {
            let geo = self
                .space
                .output_geometry(output)
                .ok_or_else(|| format!("screenshot missing geometry for output {output_name}"))?;
            let mode = output
                .current_mode()
                .ok_or_else(|| format!("screenshot missing mode for output {output_name}"))?;
            let image = crate::render::screenshot::capture_output_image(
                renderer,
                framebuffer,
                Size::from((mode.size.w as i32, mode.size.h as i32)),
                output.current_transform(),
            )?;
            request.push_capture(crate::render::screenshot::CapturedOutputFrame {
                output_name: output_name.clone(),
                logical_rect: geo,
                image,
            });
            Ok(())
        })();
        if let Err(error) = capture {
            if let Some(request_id) = request.e2e_request_id {
                crate::e2e::publish_screenshot_result(request_id, Err(error.clone()));
            }
            tracing::warn!(%error, output = %output_name, "screenshot capture failed");
            return;
        }
        if request.is_complete() {
            let request_id = request.e2e_request_id;
            if let Err(error) = self.finish_screenshot_request(request) {
                if let Some(request_id) = request_id {
                    crate::e2e::publish_screenshot_result(request_id, Err(error.clone()));
                }
                tracing::warn!(%error, "screenshot finalize failed");
            }
            return;
        }
        self.screenshot_request = Some(request);
    }

    fn finish_screenshot_request(
        &mut self,
        request: crate::render::screenshot::PendingScreenshotRequest,
    ) -> Result<PathBuf, String> {
        let image = request.finalize_image()?;
        let png = crate::render::screenshot::encode_png(&image)?;
        let path = if let Some(save_path) = request.save_path.as_ref() {
            crate::render::screenshot::save_png_to_path(&png, save_path)?
        } else {
            crate::render::screenshot::save_png(&png)?
        };
        if let Some(request_id) = request.e2e_request_id {
            crate::e2e::publish_screenshot_result(
                request_id,
                Ok(crate::e2e::E2eScreenshotResult {
                    request_id,
                    path: path.display().to_string(),
                    width: image.width(),
                    height: image.height(),
                    captured_at_ms: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis(),
                }),
            );
        }
        self.publish_screenshot_clipboard(png);
        tracing::warn!(path = %path.display(), "screenshot saved");
        Ok(path)
    }

    fn publish_screenshot_clipboard(&mut self, png: Vec<u8>) {
        set_data_device_selection::<Self>(
            &self.display_handle,
            &self.seat,
            vec!["image/png".into()],
            Arc::new(png),
        );
    }

    fn super_keybind_target_window_id(&self) -> Option<u32> {
        if let Some(wid) = self.keyboard_focused_window_id() {
            if let Some(info) = self.window_registry.window_info(wid) {
                if !self.window_info_is_solid_shell_host(&info) {
                    return Some(wid);
                }
            }
        }
        self.topmost_native_window_from_stack()
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

    pub(crate) fn handle_pending_wayland_client_disconnects(&mut self) {
        let pending = disconnected_wayland_clients()
            .lock()
            .map(|mut queue| std::mem::take(&mut *queue))
            .unwrap_or_default();
        for client_id in pending {
            self.cleanup_disconnected_wayland_client(client_id);
        }
    }

    fn cleanup_disconnected_wayland_client(&mut self, client_id: ClientId) {
        let infos = self.window_registry.native_infos_for_client(&client_id);
        let doomed_surface_keys: HashSet<_> = self
            .window_registry
            .native_surface_keys_for_client(&client_id)
            .into_iter()
            .collect();
        if infos.is_empty() {
            self.pending_deferred_toplevels
                .retain(|(cid, _), _| cid != &client_id);
            self.idle_inhibit_surfaces
                .retain(|(cid, _)| cid != &client_id);
            return;
        }
        let focused_removed = infos
            .iter()
            .any(|info| self.keyboard_focused_window_id() == Some(info.window_id));
        let doomed_windows: Vec<_> = self
            .space
            .elements()
            .filter_map(|elem| match elem {
                DerpSpaceElem::Wayland(window) => {
                    let toplevel = window.toplevel()?;
                    let wl_surface = toplevel.wl_surface();
                    let client = wl_surface.client()?;
                    doomed_surface_keys
                        .contains(&(client.id(), wl_surface.id().protocol_id()))
                        .then_some(window.clone())
                }
                _ => None,
            })
            .collect();
        for window in doomed_windows {
            self.space.unmap_elem(&DerpSpaceElem::Wayland(window));
        }
        for info in &infos {
            if let Some(window) = self.find_window_by_surface_id(info.surface_id) {
                self.space.unmap_elem(&DerpSpaceElem::Wayland(window));
            }
            self.clear_toplevel_layout_maps(info.window_id);
            self.pending_gnome_initial_toplevels.remove(&info.window_id);
            self.shell_close_pending_native_windows
                .remove(&info.window_id);
            self.shell_window_stack_forget(info.window_id);
            self.shell_minimized_windows.remove(&info.window_id);
            self.shell_minimized_x11_windows.remove(&info.window_id);
        }
        self.pending_deferred_toplevels
            .retain(|(cid, _), _| cid != &client_id);
        self.idle_inhibit_surfaces
            .retain(|(cid, _)| cid != &client_id);
        let removed = self.window_registry.remove_by_client_id(&client_id);
        let mut refocused_after_close = false;
        for info in removed {
            let window_id = info.window_id;
            self.capture_forget_window_source_cache(info.window_id);
            tracing::warn!(
                target: "derp_toplevel",
                window_id = info.window_id,
                title = %info.title,
                app_id = %info.app_id,
                pid = ?info.wayland_client_pid,
                "wayland client disconnected; pruning native window"
            );
            self.shell_emit_chrome_window_unmapped(info.window_id, Some(info));
            if !refocused_after_close {
                refocused_after_close = self.try_refocus_after_closed_window(window_id, false);
            }
        }
        if focused_removed && !refocused_after_close {
            self.try_refocus_after_closed_toplevel();
        }
    }

    pub(crate) fn handle_super_keybind(&mut self, action: &str) {
        self.programs_menu_super_chord = true;
        match action {
            "close_focused" => {
                if let Some(wid) = self.logical_focused_window_id() {
                    if self.window_registry.is_shell_hosted(wid) {
                        self.shell_send_keybind("close_focused");
                    } else if self
                        .window_registry
                        .window_info(wid)
                        .is_some_and(|info| !self.window_info_is_solid_shell_host(&info))
                    {
                        self.shell_close_window(wid);
                    } else {
                        self.shell_send_keybind("close_focused");
                    }
                } else if let Some(wid) = self.super_keybind_target_window_id() {
                    self.shell_close_window(wid);
                }
            }
            "toggle_fullscreen" => {
                if let Some(wid) = self.super_keybind_target_window_id() {
                    let fs = self
                        .window_registry
                        .window_info(wid)
                        .is_some_and(|info| info.fullscreen);
                    self.shell_set_window_fullscreen(wid, !fs);
                }
            }
            "toggle_maximize" => {
                self.shell_send_keybind_ex(
                    "toggle_maximize",
                    self.super_keybind_target_window_id(),
                );
            }
            "screenshot_region" => {
                self.begin_screenshot_selection_mode();
            }
            "screenshot_current_output" => {
                if let Err(error) = self.request_screenshot_current_output() {
                    tracing::warn!(%error, "screenshot current output request failed");
                }
            }
            "toggle_programs_menu" => {
                self.programs_menu_toggle_from_super(SERIAL_COUNTER.next_serial());
            }
            "launch_terminal" | "open_settings" | "tile_left" | "tile_right" | "tile_up"
            | "tile_down" | "tab_next" | "tab_previous" | "move_monitor_left"
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
        generation: u32,
        planes: &[shell_wire::FrameDmabufPlane],
        mut fds: Vec<OwnedFd>,
        dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
    ) {
        self.shell_note_shell_ipc_rx();
        crate::cef::begin_frame_diag::note_shell_dmabuf_rx(width, height);
        if width == 0 || height == 0 || planes.is_empty() || planes.len() != fds.len() {
            fds.clear();
            return;
        }
        if self.shell_has_frame && generation <= self.shell_dmabuf_generation {
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
                self.shell_dmabuf_generation = generation;
                shell_ipc::log_first_shell_dmabuf(
                    width,
                    height,
                    drm_format,
                    modifier,
                    planes.len(),
                );
            }
            Err(e) => {
                tracing::warn!(target: "derp_hotplug_shell", ?e, "shell dma-buf frame rejected")
            }
        }
    }

    /// Advertise `zwp_linux_dmabuf_v1` using formats from the live GLES stack (call after `bind_wl_display`).
    pub fn init_linux_dmabuf_global(
        &mut self,
        _renderer: &GlesRenderer,
        formats: impl IntoIterator<Item = Format>,
    ) {
        if self.dmabuf_global.is_some() {
            return;
        }
        let formats: Vec<Format> = formats.into_iter().collect();
        if formats.is_empty() {
            tracing::warn!("linux-dmabuf global skipped (no dma-buf formats from renderer)");
            return;
        }
        let render_node = EGLDevice::device_for_display(_renderer.egl_context().display())
            .ok()
            .and_then(|device| device.try_get_render_node().ok().flatten());
        let render_node_dev_id = render_node.as_ref().map(|node| node.dev_id());
        let display_handle = self.display_handle.clone();
        let global = render_node
            .and_then(|node| {
                DmabufFeedbackBuilder::new(node.dev_id(), formats.iter().copied())
                    .build()
                    .ok()
            })
            .map(|feedback| {
                self.dmabuf_state
                    .create_global_with_filter_and_default_feedback::<Self, _>(
                        &self.display_handle,
                        &feedback,
                        move |client| client_allows_linux_dmabuf(client, &display_handle),
                    )
            })
            .unwrap_or_else(|| {
                tracing::warn!("linux-dmabuf global falling back to v3 without default feedback");
                let display_handle = self.display_handle.clone();
                self.dmabuf_state.create_global_with_filter::<Self, _>(
                    &self.display_handle,
                    formats.iter().copied(),
                    move |client| client_allows_linux_dmabuf(client, &display_handle),
                )
            });
        self.dmabuf_global = Some(global);
        self.capture_dmabuf_formats = formats
            .iter()
            .copied()
            .map(normalize_capture_dmabuf_format)
            .collect();
        self.capture_dmabuf_device = render_node_dev_id;
        tracing::debug!("linux-dmabuf global created");
    }

    /// DRM session handle for **Ctrl+Alt+F1–F12** VT switching ([`crate::input`]).
    pub fn set_vt_session(&mut self, session: Option<LibSeatSession>) {
        self.vt_session = session;
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
        if hit {
            best
        } else {
            fallback()
        }
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

    pub(crate) fn x11_window_containing_surface(&self, surface: &WlSurface) -> Option<X11Surface> {
        let mut root = surface.clone();
        while let Some(p) = smithay::wayland::compositor::get_parent(&root) {
            root = p;
        }
        self.space.elements().find_map(|e| {
            if let DerpSpaceElem::X11(x11) = e {
                x11.wl_surface()
                    .is_some_and(|wl| wl == root)
                    .then_some(x11.clone())
            } else {
                None
            }
        })
    }

    pub(crate) fn xwayland_scale_for_fractional_output(scale: f64) -> f64 {
        let floor = scale.floor().max(1.0);
        let ceil = scale.ceil().max(1.0);
        if (scale - floor).abs() <= (ceil - scale).abs() {
            floor
        } else {
            ceil
        }
    }

    pub(crate) fn xwayland_scale_for_space_element(&self, elem: &DerpSpaceElem) -> f64 {
        Self::xwayland_scale_for_fractional_output(self.fractional_scale_for_space_element(elem))
    }

    pub(crate) fn xwayland_client_scale_for_output_scale(output_scale: f64) -> f64 {
        output_scale / Self::xwayland_scale_for_fractional_output(output_scale)
    }

    pub(crate) fn xwayland_client_scale_for_shell_ui(shell_ui_scale: f64) -> f64 {
        Self::xwayland_client_scale_for_output_scale(shell_ui_scale)
    }

    pub(crate) fn apply_xwayland_client_scale(&self) {
        let Some(client) = self.x11_client.as_ref() else {
            return;
        };
        let scale = Self::xwayland_client_scale_for_shell_ui(self.shell_ui_scale);
        <Self as smithay::wayland::compositor::CompositorHandler>::client_compositor_state(
            self, client,
        )
        .set_client_scale(scale);
    }

    pub fn surface_under(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(WlSurface, Point<f64, Logical>)> {
        if let Some(hit) = self.layer_surface_under(pos, &[Layer::Overlay, Layer::Top]) {
            return Some(hit);
        }
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
        self.layer_surface_under(pos, &[Layer::Bottom, Layer::Background])
    }

    fn layer_surface_under(
        &self,
        pos: Point<f64, Logical>,
        layers: &[Layer],
    ) -> Option<(WlSurface, Point<f64, Logical>)> {
        for output in self.space.outputs() {
            let Some(output_geo) = self.space.output_geometry(output) else {
                continue;
            };
            let local = pos - output_geo.loc.to_f64();
            let layer_map = layer_map_for_output(output);
            for layer in layers {
                let Some(surface) = layer_map.layer_under(*layer, local) else {
                    continue;
                };
                let Some(geometry) = layer_map.layer_geometry(surface) else {
                    continue;
                };
                let hit_local = local - geometry.loc.to_f64();
                let Some((wl_surface, surface_loc)) =
                    surface.surface_under(hit_local, WindowSurfaceType::ALL)
                else {
                    continue;
                };
                return Some((
                    wl_surface,
                    (surface_loc + geometry.loc + output_geo.loc).to_f64(),
                ));
            }
        }
        None
    }

    pub(crate) fn layer_surface_for_root(
        &self,
        root: &WlSurface,
    ) -> Option<(Output, DesktopLayerSurface)> {
        for output in self.space.outputs() {
            let layer_map = layer_map_for_output(output);
            let Some(layer) = layer_map.layer_for_surface(root, WindowSurfaceType::ALL) else {
                continue;
            };
            return Some((output.clone(), layer.clone()));
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
                DerpSpaceElem::Wayland(window) => window
                    .surface_under(local, WindowSurfaceType::ALL)
                    .is_some(),
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

    fn preferred_new_toplevel_size(&self, window: &Window) -> Option<(i32, i32)> {
        let Some(toplevel) = window.toplevel() else {
            let geo = window.geometry().size;
            if geo.w > 0 && geo.h > 0 {
                return Some((geo.w, geo.h));
            }
            let bbox = window.bbox().size;
            if bbox.w > 0 && bbox.h > 0 {
                return Some((bbox.w, bbox.h));
            }
            return None;
        };
        let geo = window.geometry().size;
        if geo.w > 0 && geo.h > 0 {
            let clamped =
                self.clamp_wayland_toplevel_content_size(toplevel.wl_surface(), geo.w, geo.h);
            return Some((clamped.w, clamped.h));
        }
        let bbox = window.bbox().size;
        if bbox.w > 0 && bbox.h > 0 {
            let clamped =
                self.clamp_wayland_toplevel_content_size(toplevel.wl_surface(), bbox.w, bbox.h);
            return Some((clamped.w, clamped.h));
        }
        None
    }

    fn centered_toplevel_origin_for_work_area(
        work: &Rectangle<i32, Logical>,
        width: i32,
        height: i32,
    ) -> (i32, i32) {
        let max_x = work.loc.x.saturating_add(work.size.w).saturating_sub(width);
        let max_y = work
            .loc
            .y
            .saturating_add(work.size.h)
            .saturating_sub(height);
        let x = work
            .loc
            .x
            .saturating_add(work.size.w.saturating_sub(width) / 2)
            .clamp(work.loc.x, max_x.max(work.loc.x));
        let y = work
            .loc
            .y
            .saturating_add(work.size.h.saturating_sub(height) / 2)
            .clamp(work.loc.y, max_y.max(work.loc.y));
        (x, y)
    }

    fn staggered_toplevel_origin_for_output(
        &self,
        output: &Output,
        work: &Rectangle<i32, Logical>,
        width: i32,
        height: i32,
    ) -> (i32, i32) {
        let (base_x, base_y) = Self::centered_toplevel_origin_for_work_area(work, width, height);
        let output_name = output.name();
        let stagger_index = (self
            .space
            .elements()
            .filter_map(|element| {
                let DerpSpaceElem::Wayland(window) = element else {
                    return None;
                };
                let toplevel = window.toplevel()?;
                let window_id = self
                    .window_registry
                    .window_id_for_wl_surface(toplevel.wl_surface())?;
                let info = self.window_registry.window_info(window_id)?;
                if self.window_info_is_solid_shell_host(&info)
                    || info.minimized
                    || info.output_name != output_name
                {
                    return None;
                }
                Some(window_id)
            })
            .count() as i32)
            % DEFAULT_XDG_TOPLEVEL_STAGGER_STEPS.max(1);
        let max_x = work.loc.x.saturating_add(work.size.w).saturating_sub(width);
        let max_y = work
            .loc
            .y
            .saturating_add(work.size.h)
            .saturating_sub(height);
        let x = base_x
            .saturating_add(stagger_index.saturating_mul(DEFAULT_XDG_TOPLEVEL_STAGGER_X))
            .clamp(work.loc.x, max_x.max(work.loc.x));
        let y = base_y
            .saturating_add(stagger_index.saturating_mul(DEFAULT_XDG_TOPLEVEL_STAGGER_Y))
            .clamp(work.loc.y, max_y.max(work.loc.y));
        (x, y)
    }

    fn should_auto_maximize_new_toplevel(
        work: &Rectangle<i32, Logical>,
        width: i32,
        height: i32,
    ) -> bool {
        let ww = i64::from(width.max(1));
        let hh = i64::from(height.max(1));
        let work_w = i64::from(work.size.w.max(1));
        let work_h = i64::from(work.size.h.max(1));
        let threshold = i64::from(GNOME_AUTO_MAXIMIZE_THRESHOLD_PERCENT);
        ww.saturating_mul(100) >= work_w.saturating_mul(threshold)
            && hh.saturating_mul(100) >= work_h.saturating_mul(threshold)
    }

    pub(crate) fn finalize_gnome_initial_toplevel_layout(&mut self, window: &Window) -> bool {
        let Some(tl) = window.toplevel() else {
            return false;
        };
        let wl = tl.wl_surface();
        let Some(window_id) = self.window_registry.window_id_for_wl_surface(wl) else {
            return false;
        };
        if !self.pending_gnome_initial_toplevels.contains(&window_id) {
            return false;
        }
        let (maximized, fullscreen) = read_toplevel_tiling(wl);
        if maximized || fullscreen {
            self.pending_gnome_initial_toplevels.remove(&window_id);
            return false;
        }
        let Some((width, height)) = self.preferred_new_toplevel_size(window) else {
            return false;
        };
        let Some(out) = self.new_toplevel_placement_output(tl.parent().as_ref()) else {
            self.pending_gnome_initial_toplevels.remove(&window_id);
            return false;
        };
        let Some(work) = self.shell_maximize_work_area_global_for_output(&out) else {
            self.pending_gnome_initial_toplevels.remove(&window_id);
            return false;
        };
        self.pending_gnome_initial_toplevels.remove(&window_id);
        if Self::should_auto_maximize_new_toplevel(&work, width, height) {
            return self.apply_toplevel_maximize_layout(window);
        }
        let (x, y) = self.staggered_toplevel_origin_for_output(&out, &work, width, height);
        let elem = DerpSpaceElem::Wayland(window.clone());
        let current = window.geometry().size;
        let needs_resize = current.w != width || current.h != height;
        let needs_reposition = self
            .space
            .element_location(&elem)
            .map(|loc| loc.x != x || loc.y != y)
            .unwrap_or(true);
        if !needs_reposition && !needs_resize {
            return false;
        }
        if needs_resize {
            tl.with_pending_state(|st| {
                st.states.unset(xdg_toplevel::State::Fullscreen);
                st.fullscreen_output = None;
                st.states.unset(xdg_toplevel::State::Maximized);
                st.size = Some(Size::from((width, height)));
            });
            tl.send_pending_configure();
        }
        self.space.map_element(elem.clone(), (x, y), true);
        self.space.raise_element(&elem, true);
        true
    }

    pub(crate) fn shell_managed_native_min_content_size(&self) -> Size<i32, Logical> {
        let th = self
            .shell_chrome_titlebar_h
            .max(SHELL_TITLEBAR_HEIGHT)
            .max(22);
        let bd = self
            .shell_chrome_border_w
            .max(SHELL_BORDER_THICKNESS)
            .max(0);
        Size::from((
            th.saturating_mul(6)
                .saturating_add(bd.saturating_mul(4))
                .max(184),
            th.saturating_mul(2)
                .saturating_add(bd.saturating_mul(2))
                .max(64),
        ))
    }

    pub(crate) fn clamp_wayland_toplevel_content_size(
        &self,
        wl_surface: &WlSurface,
        width: i32,
        height: i32,
    ) -> Size<i32, Logical> {
        let base = Size::from((width.max(1), height.max(1)));
        let Some(window_id) = self.window_registry.window_id_for_wl_surface(wl_surface) else {
            return base;
        };
        let shell_min = if self.window_registry.is_shell_hosted(window_id) {
            Size::from((1, 1))
        } else {
            self.shell_managed_native_min_content_size()
        };
        let (min_size, max_size) =
            smithay::wayland::compositor::with_states(wl_surface, |states| {
                let mut guard = states.cached_state.get::<SurfaceCachedState>();
                let data = guard.current();
                (data.min_size, data.max_size)
            });
        let min_width = min_size.w.max(1).max(shell_min.w);
        let min_height = min_size.h.max(1).max(shell_min.h);
        let max_width = if max_size.w == 0 {
            i32::MAX
        } else {
            max_size.w.max(min_width)
        };
        let max_height = if max_size.h == 0 {
            i32::MAX
        } else {
            max_size.h.max(min_height)
        };
        Size::from((
            width.max(min_width).min(max_width),
            height.max(min_height).min(max_height),
        ))
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
        let (width, height) = self
            .preferred_new_toplevel_size(window)
            .unwrap_or((DEFAULT_XDG_TOPLEVEL_WIDTH, DEFAULT_XDG_TOPLEVEL_HEIGHT));
        self.staggered_toplevel_origin_for_output(&out, &work, width, height)
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
    pub(crate) fn shell_ipc_peer_matches_wayland_pid(
        &self,
        wayland_client_pid: Option<i32>,
    ) -> bool {
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
        let Some(kbd) = self.seat.get_keyboard() else {
            return 0;
        };
        kbd.with_xkb_state(self, |ctx| match ctx.xkb().lock() {
            Ok(xkb) => xkb.active_layout().0,
            Err(_) => 0,
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
        let s = s.find('(').map(|i| s[..i].trim_end()).unwrap_or(s);
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
        self.keyboard_layout_last_focus_window = if restore_for.is_some() { new_wid } else { None };
        self.keyboard_layout_focus_queue
            .push_back(KeyboardLayoutFocusOp {
                save_from,
                restore_for,
                shell_host,
            });
        let tx = self.cef_to_compositor_tx.clone();
        let _ = tx.send(crate::cef::compositor_tx::CefToCompositor::Run(Box::new(
            |state| {
                state.keyboard_drain_focus_layout_queue();
            },
        )));
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
            let pending = self.pending_deferred_toplevels.get(&key).expect("checked");
            if let Some(tl) = pending.window.toplevel() {
                tl.send_configure();
            }
        }
        let (ready_to_map, title, app_id) = {
            let pending = self.pending_deferred_toplevels.get(&key).expect("checked");
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
            let ready = ident && has_buffer_extent;
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
                will_map_now = ready,
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
                will_map_now = ready,
                "xdg sync deferred toplevel detail"
            );
            (ready, title, app_id)
        };
        if ready_to_map {
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
            p.window.toplevel().and_then(|t| {
                self.window_registry
                    .window_id_for_wl_surface(t.wl_surface())
            }) == Some(window_id)
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
    ) -> Option<(i32, i32, i32, i32)> {
        let elem = DerpSpaceElem::Wayland(window.clone());
        let map_loc = self.space.element_location(&elem)?;
        let geo = window.geometry();
        Some((map_loc.x, map_loc.y, geo.size.w, geo.size.h))
    }

    pub(crate) fn notify_geometry_for_window(&mut self, window: &Window, force_shell_emit: bool) {
        let Some(toplevel) = window.toplevel() else {
            return;
        };
        let wl = toplevel.wl_surface();
        let Some((gx, gy, gw, gh)) = self.wayland_window_shell_rect_and_deco(window) else {
            return;
        };
        let output_name = self
            .output_for_window_position(gx, gy, gw, gh)
            .unwrap_or_default();
        let changed = self
            .window_registry
            .set_shell_layout(wl, gx, gy, gw, gh, output_name);
        if let Some(window_id) = self.window_registry.window_id_for_wl_surface(wl) {
            self.capture_refresh_window_source_cache(window_id);
        }
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

    fn shell_emit_requested_native_geometry(
        &mut self,
        window_id: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        output_name: String,
        maximized: bool,
    ) {
        let snapshot = self.window_registry.update_native(window_id, |info| {
            info.x = x;
            info.y = y;
            info.width = w.max(1);
            info.height = h.max(1);
            info.output_name = output_name.clone();
            info.maximized = maximized;
            info.fullscreen = false;
            info.clone()
        });
        if let Some(info) = snapshot {
            self.capture_refresh_window_source_cache(info.window_id);
            self.shell_emit_chrome_event(ChromeEvent::WindowGeometryChanged { info });
        }
    }

    fn sync_registry_from_space_for_wayland(&mut self, window: &Window) {
        let Some(toplevel) = window.toplevel() else {
            return;
        };
        let wl = toplevel.wl_surface();
        let Some((gx, gy, gw, gh)) = self.wayland_window_shell_rect_and_deco(window) else {
            return;
        };
        let output_name = self
            .output_for_window_position(gx, gy, gw, gh)
            .unwrap_or_default();
        let _ = self
            .window_registry
            .set_shell_layout(wl, gx, gy, gw, gh, output_name);
        if let Some(window_id) = self.window_registry.window_id_for_wl_surface(wl) {
            self.capture_refresh_window_source_cache(window_id);
        }
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
            if self.window_registry.is_shell_hosted(window_id) {
                self.shell_move_end_backed_only(window_id);
            } else {
                self.shell_move_end(window_id);
            }
        }
        if self.shell_resize_window_id == Some(window_id) {
            if self.window_registry.is_shell_hosted(window_id) {
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
        self.pending_gnome_initial_toplevels.remove(&window_id);
        self.cancel_shell_move_resize_for_window(window_id);
        let gx = geo.loc.x;
        let gy = geo.loc.y;
        let gw = geo.size.w;
        let gh = geo.size.h;
        let (map_x, map_y, content_w, content_h) =
            Self::wayland_toplevel_map_and_content_for_shell_frame(gx, gy, gw, gh);
        tl.with_pending_state(|st| {
            st.states.unset(xdg_toplevel::State::Fullscreen);
            st.fullscreen_output = None;
            st.states.set(xdg_toplevel::State::Maximized);
            st.size = Some(Size::from((content_w, content_h)));
        });
        self.space
            .map_element(DerpSpaceElem::Wayland(window.clone()), (map_x, map_y), true);
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
        let Some(sm_out) = wl_output_hint
            .as_ref()
            .and_then(Output::from_resource)
            .or_else(|| {
                self.wayland_window_shell_rect_and_deco(window).and_then(|(gx, gy, gw, gh)| {
                    self.output_for_global_xywh(gx, gy, gw, gh)
                })
            })
            .or_else(|| self.leftmost_output())
        else {
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
        self.pending_gnome_initial_toplevels.remove(&window_id);
        self.cancel_shell_move_resize_for_window(window_id);
        let wl_out = wl_output_hint.or_else(|| self.client_wl_output_for(wl, &sm_out));
        let gx = geo.loc.x;
        let gy = geo.loc.y;
        let gw = geo.size.w;
        let gh = geo.size.h;
        let (map_x, map_y, content_w, content_h) =
            Self::wayland_toplevel_map_and_content_for_shell_frame(gx, gy, gw, gh);
        tl.with_pending_state(|st| {
            st.states.unset(xdg_toplevel::State::Maximized);
            st.states.set(xdg_toplevel::State::Fullscreen);
            st.fullscreen_output = wl_out;
            st.size = Some(Size::from((content_w, content_h)));
        });
        self.space
            .map_element(DerpSpaceElem::Wayland(window.clone()), (map_x, map_y), true);
        self.space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        tl.send_pending_configure();
        self.notify_geometry_if_changed(window);
        true
    }

    pub(crate) fn restore_toplevel_floating_layout(
        &mut self,
        window_id: u32,
        window: &Window,
    ) -> bool {
        let Some((x, y, w, h)) = self.toplevel_floating_restore.remove(&window_id) else {
            return false;
        };
        let Some(tl) = window.toplevel() else {
            return false;
        };
        self.pending_gnome_initial_toplevels.remove(&window_id);
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
            st.size = Some(Size::from((
                DEFAULT_XDG_TOPLEVEL_WIDTH,
                DEFAULT_XDG_TOPLEVEL_HEIGHT,
            )));
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
                st.size = Some(Size::from((
                    DEFAULT_XDG_TOPLEVEL_WIDTH,
                    DEFAULT_XDG_TOPLEVEL_HEIGHT,
                )));
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
                self.window_info_is_solid_shell_host(info) || !shell_window_row_should_show(info)
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
                self.window_info_is_solid_shell_host(info) || !shell_window_row_should_show(info)
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
        if self.shell_hosted_app_state.remove(&window_id).is_some() {
            self.shell_hosted_app_state_send();
        }
        let hint = removed_info.as_ref();
        self.shell_emit_chrome_event_inner(ChromeEvent::WindowUnmapped { window_id }, hint);
        self.shell_reply_window_list();
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
        self.shell_send_to_cef(
            shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { window_id },
        );
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
            }
            _ => event.clone(),
        };

        let suppress = self.chrome_event_suppress_shell_ipc(&ipc_event, unmap_removed_info);
        let focus_cleared_for_shell =
            matches!(ipc_event, ChromeEvent::FocusChanged { .. }) && suppress;
        let shell_packet_source: ChromeEvent = if focus_cleared_for_shell {
            ChromeEvent::FocusChanged {
                surface_id: None,
                window_id: None,
            }
        } else {
            ipc_event.clone()
        };
        let skip_shell_packet = suppress && !focus_cleared_for_shell;

        // Filter compositor.log with: `derp_shell_sync` (see scripts/fetch-logs.sh).
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
            ChromeEvent::WindowStateChanged { info, minimized } if !suppress => {
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
                crate::shell::shell_encode::chrome_event_to_shell_message(&shell_packet_source)
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
            Size::<i32, Logical>::from(((max_x - min_x).max(1), (max_y - min_y).max(1))),
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

    pub(crate) fn wayland_toplevel_map_and_content_for_shell_frame(
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> (i32, i32, i32, i32) {
        (x, y, w, h)
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
            out.change_current_state(Some(mode), Some(tf), Some(sc), Some(loc.into()));
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
        self.apply_xwayland_client_scale();
        self.apply_shell_ui_scale_to_outputs();
        self.send_shell_output_layout();
        if !self.display_config_save_suppressed {
            self.display_config_request_save();
        }
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
            out.change_current_state(Some(mode), Some(tf), Some(sc), Some((nx, ny).into()));
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
            out.change_current_state(Some(mode), Some(tf), Some(sc), Some((nx, ny).into()));
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
        self.shell_canvas_logical_origin = (bounds.loc.x, bounds.loc.y);
        let mut max_scale = 1.0f64;
        for o in self.space.outputs() {
            max_scale = max_scale.max(o.current_scale().fractional_scale() as f64);
        }
        let ch_canvas = ch_work.max(1);
        self.shell_canvas_logical_size = (cw, ch_canvas);
        let pw = ((cw as f64) * max_scale).round().max(1.0) as i32;
        let ph = ((ch_work as f64) * max_scale).round().max(1.0) as i32;
        self.shell_window_physical_px = (pw, ph);
        if prev_origin != self.shell_canvas_logical_origin
            || prev_size != self.shell_canvas_logical_size
            || prev_phys != self.shell_window_physical_px
        {
            self.shell_dmabuf_dirty_force_full = true;
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
        let picked = self.output_for_window_position(x, y, w, h)?;
        self.space
            .outputs()
            .find(|o| o.name() == picked.as_str())
            .cloned()
            .or_else(|| self.leftmost_output())
    }

    pub(crate) fn output_for_window_position(
        &self,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> Option<String> {
        let pairs: Vec<(String, Rectangle<i32, Logical>)> = self
            .space
            .outputs()
            .filter_map(|o| {
                let g = self.space.output_geometry(o)?;
                Some((o.name().into(), g))
            })
            .collect();
        if pairs.is_empty() {
            return self.space.outputs().next().map(|o| o.name().into());
        }
        pick_output_name_for_global_window_rect_from_output_rects(&pairs, x, y, w, h)
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
        let pairs: Vec<(String, Rectangle<i32, Logical>)> = geos
            .iter()
            .map(|(n, g)| (n.clone(), *g))
            .collect();
        pick_output_name_for_global_window_rect_from_output_rects(&pairs, x, y, w, h)
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
                    let Some(oname) = Self::output_name_for_window_from_geometry_map(
                        before_outputs,
                        loc.x,
                        loc.y,
                        ww,
                        hh,
                    ) else {
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
                    let Some(oname) = Self::output_name_for_window_from_geometry_map(
                        before_outputs,
                        loc.x,
                        loc.y,
                        ww,
                        hh,
                    ) else {
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
        let geo = window.geometry();
        let ww = geo.size.w.max(1).min(target_work.size.w).max(1);
        let hh = geo.size.h.max(1).min(target_work.size.h).max(1);
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
            Self::wayland_toplevel_map_and_content_for_shell_frame(gx, gy, ww, hh);
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
        self.capture_refresh_window_source_cache(window_id);
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
        let ww = geo.size.w.max(1).min(target_work.size.w).max(1);
        let hh = geo.size.h.max(1).min(target_work.size.h).max(1);
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
            if !self.space.outputs().any(|o| o.name() == n.as_str()) {
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
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::OutputLayout {
            canvas_logical_w: lw.max(1),
            canvas_logical_h: lh.max(1),
            canvas_physical_w: physical_w,
            canvas_physical_h: physical_h,
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
        self.backdrop_layers_by_output.clear();
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
        self.shell_seed_initial_pointer_position();
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
            if !self.space.outputs().any(|o| o.name() == name.as_str()) {
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
            let Some(out) = self.space.outputs().find(|o| o.name() == s.name).cloned() else {
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
            out.change_current_state(Some(mode), Some(tf), Some(sc), Some((s.x, s.y).into()));
            self.space.map_output(out, (s.x, s.y));
        }
        let mut row_buckets: HashMap<i32, Vec<usize>> = HashMap::new();
        for (i, (s, _)) in resolved.iter().enumerate() {
            row_buckets.entry(s.y).or_default().push(i);
        }
        let mut new_xy: Vec<(i32, i32)> = resolved.iter().map(|(s, _)| (s.x, s.y)).collect();
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
            out.change_current_state(Some(mode), Some(tf), Some(sc), Some((nx, ny).into()));
            self.space.map_output(out, (nx, ny));
        }
        if let Some(ref n) = self.shell_primary_output_name {
            if !self.space.outputs().any(|o| o.name() == n.as_str()) {
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
        self.shell_embedded_initial_handshake_done = true;
        if let Ok(g) = self.shell_to_cef.lock() {
            if let Some(link) = g.as_ref() {
                link.set_delivery_ready(true);
            }
        }
        self.shell_note_shell_ipc_rx();
        self.shell_ipc_last_compositor_ping = None;
        self.shell_ipc_last_pong = None;
        self.shell_ipc_unanswered_ping_since = None;
        self.shell_ipc_ping_late_warned_for = None;
        self.send_shell_output_geometry();
        self.resync_embedded_shell_host_after_ipc_connect();
        self.shell_reply_window_list();
        self.shell_hosted_app_state_send();
        let window_id = self.logical_focused_window_id();
        let surface_id = window_id.and_then(|w| self.window_registry.surface_id_for_window(w));
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id,
            window_id,
        });
        self.sync_tray_hints_to_shell();
    }

    pub(crate) fn shell_note_shell_ipc_rx(&mut self) {
        self.shell_ipc_last_rx = Some(Instant::now());
    }

    pub(crate) fn shell_ipc_on_shell_load_success(&mut self) {
        if let Ok(g) = self.shell_to_cef.lock() {
            if let Some(link) = g.as_ref() {
                link.set_delivery_ready(true);
            }
        }
        self.shell_ipc_watchdog_armed = true;
        self.shell_ipc_last_rx = Some(Instant::now());
        self.shell_ipc_last_compositor_ping = None;
        self.shell_ipc_last_pong = None;
        self.shell_ipc_unanswered_ping_since = None;
        self.shell_ipc_ping_late_warned_for = None;
        tracing::warn!(
            target: "derp_shell_menu",
            pending_toggle = self.programs_menu_super_pending_toggle,
            shell_has_frame = self.shell_has_frame,
            shell_ipc_keyboard_to_cef = self.shell_ipc_keyboard_to_cef,
            "shell_ipc_on_shell_load_success"
        );
        if self.programs_menu_super_pending_toggle {
            self.programs_menu_super_pending_toggle = false;
            self.programs_menu_toggle_from_super(SERIAL_COUNTER.next_serial());
        }
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
            self.shell_ipc_watchdog_armed = false;
            self.shell_ipc_last_rx = None;
            self.shell_ipc_last_compositor_ping = None;
            self.shell_ipc_last_pong = None;
            self.shell_ipc_unanswered_ping_since = None;
            self.shell_ipc_ping_late_warned_for = None;
            return;
        }
        if !self.shell_ipc_watchdog_armed {
            return;
        }
        let Some(last_rx) = self.shell_ipc_last_rx else {
            return;
        };
        let idle = last_rx.elapsed();
        let prod_after =
            std::cmp::max(limit / 2, Duration::from_millis(500)).min(Duration::from_secs(2));
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

    pub(crate) fn sync_tray_hints_to_shell(&mut self) {
        let sni_n = self.sni_tray_slot_count;
        let slot_w: i32 = 40;
        if self.shell_effective_primary_output().is_none() {
            self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::TrayHints {
                slot_count: 0,
                slot_w,
                reserved_w: 0,
            });
            return;
        }
        let reserved_w = sni_n.saturating_mul(slot_w.max(1) as u32);
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::TrayHints {
            slot_count: sni_n,
            slot_w,
            reserved_w,
        });
    }

    pub(crate) fn on_sni_tray_items_updated(&mut self, items: Vec<shell_wire::TraySniItemWire>) {
        self.sni_tray_slot_count = items.len() as u32;
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::TraySni { items });
        self.sync_tray_hints_to_shell();
    }

    pub(crate) fn on_sni_tray_menu_updated(&mut self, menu: shell_wire::TraySniMenuWire) {
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::TraySniMenu { menu });
    }

    pub(crate) fn sni_tray_activate_clicked(&mut self, id: String) {
        if let Some(tx) = &self.sni_tray_cmd_tx {
            let _ = tx.send(crate::tray::sni_tray::SniTrayCmd::Activate { id });
        }
    }

    pub(crate) fn sni_tray_open_menu(&mut self, id: String, request_serial: u32) {
        if let Some(tx) = &self.sni_tray_cmd_tx {
            let _ = tx.send(crate::tray::sni_tray::SniTrayCmd::OpenMenu { id, request_serial });
        }
    }

    pub(crate) fn sni_tray_menu_event(&mut self, id: String, menu_path: String, item_id: i32) {
        if let Some(tx) = &self.sni_tray_cmd_tx {
            let _ = tx.send(crate::tray::sni_tray::SniTrayCmd::MenuEvent {
                id,
                menu_path,
                item_id,
            });
        }
    }

    /// True if the pointer is over the Solid shell layer (desktop), not the native Wayland client beneath.
    pub fn shell_pointer_route_to_cef(&self, pos: Point<f64, Logical>) -> bool {
        if self.point_in_shell_exclusion_zones(pos) {
            return true;
        }

        let in_placement = self.shell_ui_placement_topmost_for_input_at(pos).is_some();
        if in_placement {
            return true;
        }

        if self.native_surface_under_no_shell_exclusion(pos).is_some() {
            return false;
        }

        true
    }

    pub(crate) fn shell_pointer_should_ipc_to_cef(&self, pos: Point<f64, Logical>) -> bool {
        if self.shell_pointer_route_to_cef(pos) {
            return true;
        }
        self.shell_exclusion_overlay_open && self.shell_point_in_shell_floating_overlay_global(pos)
    }

    pub fn shell_point_in_shell_floating_overlay_global(&self, pos: Point<f64, Logical>) -> bool {
        let px = pos.x;
        let py = pos.y;
        for r in &self.shell_exclusion_floating {
            let x2 = r.loc.x.saturating_add(r.size.w) as f64;
            let y2 = r.loc.y.saturating_add(r.size.h) as f64;
            const EPS: f64 = 1.0e-6;
            if px >= r.loc.x as f64 - EPS
                && px < x2 + EPS
                && py >= r.loc.y as f64 - EPS
                && py < y2 + EPS
            {
                return true;
            }
        }
        false
    }

    pub(crate) fn shell_dismiss_context_menu_from_compositor(&mut self) {
        if !self.shell_exclusion_overlay_open {
            return;
        }
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::ContextMenuDismiss);
    }

    /// Map normalized pointer (`nx`, `ny` over the canvas) to **shell OSR buffer** pixels (letterbox-aware).
    pub fn shell_pointer_buffer_pixels(&self, nx: f64, ny: f64) -> Option<(i32, i32)> {
        let (buf_w, buf_h) = self.shell_view_px?;
        let content_h = buf_h.max(1);
        let (lw, lh) = self.shell_output_logical_size()?;
        let (ox, oy, cw, ch) = crate::shell::shell_letterbox::letterbox_logical(
            Size::from((lw as i32, lh as i32)),
            buf_w,
            content_h,
        )?;
        let nx = nx.clamp(0.0, 1.0);
        let ny = ny.clamp(0.0, 1.0);
        let lx = nx * lw as f64 - ox as f64;
        let ly = ny * lh as f64 - oy as f64;
        crate::shell::shell_letterbox::local_in_letterbox_to_buffer_px(
            lx, ly, cw, ch, buf_w, content_h,
        )
    }

    pub(crate) fn shell_pointer_coords_for_cef(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(i32, i32)> {
        if let Some(w) = self.shell_ui_placement_topmost_for_input_at(pos) {
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
        let window_id = self
            .window_registry
            .window_id_for_shell_surface(surface_id)?;
        self.space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                w.toplevel()
                    .and_then(|t| {
                        self.window_registry
                            .window_id_for_wl_surface(t.wl_surface())
                    })
                    .filter(|&id| id == window_id)
                    .map(|_| w.clone())
            } else {
                None
            }
        })
    }

    fn x11_window_id_for_surface(&self, window: &X11Surface) -> Option<u32> {
        let wl = window.wl_surface()?;
        self.window_registry.window_id_for_wl_surface(&wl)
    }

    pub(crate) fn find_x11_window_by_surface_id(&self, surface_id: u32) -> Option<X11Surface> {
        let window_id = self
            .window_registry
            .window_id_for_shell_surface(surface_id)?;
        self.find_x11_window_by_window_id(window_id)
    }

    fn find_x11_window_by_window_id(&self, window_id: u32) -> Option<X11Surface> {
        self.space.elements().find_map(|e| {
            if let DerpSpaceElem::X11(x11) = e {
                self.x11_window_id_for_surface(x11)
                    .filter(|&id| id == window_id)
                    .map(|_| x11.clone())
            } else {
                None
            }
        })
    }

    pub(crate) fn xwayland_scale_for_window_id(&self, window_id: u32) -> Option<f64> {
        let x11 = self.find_x11_window_by_window_id(window_id)?;
        Some(self.xwayland_scale_for_space_element(&DerpSpaceElem::X11(x11)))
    }

    fn x11_window_title_app_id(window: &X11Surface) -> (String, String) {
        let title = window.title();
        let class = window.class();
        let instance = window.instance();
        let app_id = if !class.is_empty() { class } else { instance };
        (title, app_id)
    }

    fn sync_registry_from_x11_surface(&mut self, window: &X11Surface) -> Option<X11SyncResult> {
        let window_id = self.x11_window_id_for_surface(window)?;
        let prev = self.window_registry.window_info(window_id)?;
        let (title, app_id) = Self::x11_window_title_app_id(window);
        let geometry = window.geometry();
        let location = self
            .space
            .element_location(&DerpSpaceElem::X11(window.clone()))
            .unwrap_or(geometry.loc);
        let elem = DerpSpaceElem::X11(window.clone());
        let in_space = self.space.elements().any(|e| *e == elem);
        let pid = window.pid().and_then(|pid| i32::try_from(pid).ok());
        let compositor_minimized = self.shell_minimized_x11_windows.contains_key(&window_id);
        let minimized = compositor_minimized || (window.is_hidden() && prev.minimized);
        let skip_x11_geometry = compositor_minimized && !in_space;
        let width = geometry.size.w.max(1);
        let height = geometry.size.h.max(1);
        let output_name = self
            .output_for_window_position(location.x, location.y, width, height)
            .unwrap_or_else(|| prev.output_name.clone());
        let (x, y, width, height, output_name) = if skip_x11_geometry {
            (prev.x, prev.y, prev.width, prev.height, prev.output_name.clone())
        } else {
            (location.x, location.y, width, height, output_name)
        };
        let info = self.window_registry.update_native(window_id, |info| {
            info.title = title.clone();
            info.app_id = app_id.clone();
            info.wayland_client_pid = pid;
            info.x = x;
            info.y = y;
            info.width = width;
            info.height = height;
            info.output_name = output_name.clone();
            info.minimized = minimized;
            info.maximized = window.is_maximized();
            info.fullscreen = window.is_fullscreen();
            info.client_side_decoration = window.is_decorated();
            info.clone()
        })?;
        self.capture_refresh_window_source_cache(info.window_id);
        Some(X11SyncResult {
            metadata_changed: prev.title != info.title
                || prev.app_id != info.app_id
                || prev.client_side_decoration != info.client_side_decoration
                || prev.wayland_client_pid != info.wayland_client_pid,
            geometry_changed: prev.x != info.x
                || prev.y != info.y
                || prev.width != info.width
                || prev.height != info.height
                || prev.output_name != info.output_name,
            state_changed: prev.minimized != info.minimized
                || prev.maximized != info.maximized
                || prev.fullscreen != info.fullscreen,
            info,
        })
    }

    fn emit_x11_window_updates(
        &mut self,
        window: &X11Surface,
        force_geometry_emit: bool,
        force_metadata_emit: bool,
    ) -> Option<WindowInfo> {
        let result = self.sync_registry_from_x11_surface(window)?;
        if force_metadata_emit || result.metadata_changed {
            self.shell_emit_chrome_event(ChromeEvent::WindowMetadataChanged {
                info: result.info.clone(),
            });
        }
        if force_geometry_emit || result.geometry_changed {
            self.shell_emit_chrome_event(ChromeEvent::WindowGeometryChanged {
                info: result.info.clone(),
            });
        }
        if result.state_changed {
            self.shell_emit_chrome_event(ChromeEvent::WindowStateChanged {
                info: result.info.clone(),
                minimized: result.info.minimized,
            });
        }
        Some(result.info)
    }

    fn ensure_x11_window_registered(
        &mut self,
        surface: &WlSurface,
        window: &X11Surface,
    ) -> Option<WindowInfo> {
        if window.is_override_redirect() {
            return None;
        }
        if self
            .window_registry
            .window_id_for_wl_surface(surface)
            .is_none()
        {
            let (title, app_id) = Self::x11_window_title_app_id(window);
            let pid = window.pid().and_then(|pid| i32::try_from(pid).ok());
            self.window_registry
                .register_toplevel(surface, title, app_id, pid);
        }
        self.emit_x11_window_updates(window, false, true)
    }

    fn cleanup_x11_window(&mut self, window: &X11Surface, emit_unmapped: bool) {
        let Some(surface) = window.wl_surface() else {
            self.space.unmap_elem(&DerpSpaceElem::X11(window.clone()));
            return;
        };
        let window_id_pre = self.window_registry.window_id_for_wl_surface(&surface);
        let keyboard_had_focus = window_id_pre
            .is_some_and(|window_id| self.keyboard_focused_window_id() == Some(window_id));
        self.space.unmap_elem(&DerpSpaceElem::X11(window.clone()));
        if let Some(window_id) = window_id_pre {
            self.clear_toplevel_layout_maps(window_id);
            self.shell_close_pending_native_windows.remove(&window_id);
            if self.shell_pending_native_focus_window_id == Some(window_id) {
                self.shell_pending_native_focus_window_id = None;
            }
            self.shell_window_stack_forget(window_id);
            self.shell_minimized_windows.remove(&window_id);
            self.shell_minimized_x11_windows.remove(&window_id);
        }
        let removed = self.window_registry.snapshot_for_wl_surface(&surface);
        if let Some(window_id) = self.window_registry.remove_by_wl_surface(&surface) {
            self.capture_forget_window_source_cache(window_id);
            if emit_unmapped {
                self.shell_emit_chrome_window_unmapped(window_id, removed);
            }
            self.try_refocus_after_closed_window(window_id, keyboard_had_focus);
        }
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
        if let Some(window) = self.find_window_by_surface_id(sid) {
            self.space
                .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
            let Some(toplevel) = window.toplevel() else {
                return;
            };
            let wl_surface = toplevel.wl_surface().clone();
            let k_serial = SERIAL_COUNTER.next_serial();
            let Some(keyboard) = self.seat.get_keyboard() else {
                return;
            };
            keyboard.set_focus(self, Some(wl_surface.clone()), k_serial);
            self.space.elements().for_each(|e| {
                if let DerpSpaceElem::Wayland(w) = e {
                    if let Some(toplevel) = w.toplevel() {
                        toplevel.send_pending_configure();
                    }
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
            return;
        }
        if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
            self.space
                .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
            if let Some(wl_surface) = x11.wl_surface() {
                let k_serial = SERIAL_COUNTER.next_serial();
                self.seat
                    .get_keyboard()
                    .unwrap()
                    .set_focus(self, Some(wl_surface), k_serial);
            }
            self.space.elements().for_each(|e| {
                if let DerpSpaceElem::Wayland(w) = e {
                    w.toplevel().unwrap().send_pending_configure();
                }
            });

            self.shell_move_window_id = Some(window_id);
            self.shell_move_pending_delta = (0, 0);
            let loc = self
                .space
                .element_location(&DerpSpaceElem::X11(x11.clone()));
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                loc = ?loc,
                "shell_move_begin: started"
            );
            return;
        }
        tracing::warn!(
            target: "derp_shell_move",
            window_id,
            sid,
            "shell_move_begin: surface not in space"
        );
    }

    /// Applies [`Self::shell_move_pending_delta`] to the active shell-move window in [`Self::space`].
    fn shell_move_flush_pending_deltas(&mut self) {
        if self
            .shell_move_window_id
            .is_some_and(|wid| self.window_registry.is_shell_hosted(wid))
        {
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
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let Some(loc) = self
                .space
                .element_location(&DerpSpaceElem::Wayland(window.clone()))
            else {
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
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            tracing::warn!(target: "derp_shell_move", wid, sid, "shell_move_flush: window gone");
            self.shell_move_window_id = None;
            self.shell_move_pending_delta = (0, 0);
            return;
        };
        let Some(loc) = self
            .space
            .element_location(&DerpSpaceElem::X11(x11.clone()))
        else {
            tracing::warn!(target: "derp_shell_move", wid, "shell_move_flush: no element_location");
            return;
        };
        let before = (loc.x, loc.y);
        let after = (loc.x + pdx, loc.y + pdy);
        let mut geometry = x11.geometry();
        geometry.loc = Point::from(after);
        if let Err(error) = x11.configure(Some(geometry)) {
            tracing::warn!(target: "derp_shell_move", wid, ?error, "shell_move_flush: x11 configure failed");
            self.shell_move_window_id = None;
            self.shell_move_pending_delta = (0, 0);
            return;
        }
        self.space
            .map_element(DerpSpaceElem::X11(x11.clone()), after, true);
        self.shell_move_pending_delta = (0, 0);
        self.emit_x11_window_updates(&x11, true, false);
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
        if self.window_registry.is_shell_hosted(wid) {
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
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let Some(_loc) = self
                .space
                .element_location(&DerpSpaceElem::Wayland(window.clone()))
            else {
                tracing::warn!(target: "derp_shell_move", wid, "shell_move_delta: no element_location");
                return;
            };
        } else if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
            let Some(_loc) = self
                .space
                .element_location(&DerpSpaceElem::X11(x11.clone()))
            else {
                tracing::warn!(target: "derp_shell_move", wid, "shell_move_delta: no element_location");
                return;
            };
        } else {
            tracing::warn!(target: "derp_shell_move", wid, sid, "shell_move_delta: window gone from space");
            self.shell_move_window_id = None;
            self.shell_move_pending_delta = (0, 0);
            return;
        }
        self.shell_move_pending_delta.0 += dx;
        self.shell_move_pending_delta.1 += dy;
        tracing::trace!(
            target: "derp_shell_move",
            wid,
            dx,
            dy,
            accum = ?self.shell_move_pending_delta,
            "shell_move_delta: flushing to space"
        );
        self.shell_move_flush_pending_deltas();
        self.shell_nudge_cef_repaint();
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
        if self.window_registry.is_shell_hosted(window_id) {
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
        if let Some(window) = self.find_window_by_surface_id(sid) {
            self.shell_move_flush_pending_deltas();
            self.shell_move_end_cleanup(window_id, &window);
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_end: finished"
            );
            return;
        }
        if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
            self.shell_move_flush_pending_deltas();
            if self.shell_move_window_id == Some(window_id) {
                self.shell_move_window_id = None;
            }
            self.shell_move_pending_delta = (0, 0);
            self.emit_x11_window_updates(&x11, true, false);
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_end: finished"
            );
            return;
        }
        tracing::warn!(
            target: "derp_shell_move",
            window_id,
            sid,
            "shell_move_end: surface missing; clearing"
        );
        self.shell_move_window_id = None;
        self.shell_move_pending_delta = (0, 0);
    }

    fn x11_resize_rect(
        &self,
        window: &X11Surface,
        initial_rect: Rectangle<i32, Logical>,
        edges: crate::grabs::resize_grab::ResizeEdge,
        dx: f64,
        dy: f64,
    ) -> Rectangle<i32, Logical> {
        let mut width = initial_rect.size.w;
        let mut height = initial_rect.size.h;
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::LEFT) {
            width = width.saturating_sub(dx.round() as i32);
        }
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::RIGHT) {
            width = width.saturating_add(dx.round() as i32);
        }
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::TOP) {
            height = height.saturating_sub(dy.round() as i32);
        }
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::BOTTOM) {
            height = height.saturating_add(dy.round() as i32);
        }
        if let Some(min_size) = window.min_size() {
            width = width.max(min_size.w.max(1));
            height = height.max(min_size.h.max(1));
        } else {
            width = width.max(1);
            height = height.max(1);
        }
        if let Some(max_size) = window.max_size() {
            if max_size.w > 0 {
                width = width.min(max_size.w);
            }
            if max_size.h > 0 {
                height = height.min(max_size.h);
            }
        }
        let mut x = initial_rect.loc.x;
        let mut y = initial_rect.loc.y;
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::LEFT) {
            x = initial_rect.loc.x + initial_rect.size.w - width;
        }
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::TOP) {
            y = initial_rect.loc.y + initial_rect.size.h - height;
        }
        Rectangle::new(Point::from((x, y)), Size::from((width, height)))
    }

    fn x11_target_output(&self, window_id: u32) -> Option<Output> {
        let info = self.window_registry.window_info(window_id)?;
        self.space
            .outputs()
            .find(|output| output.name() == info.output_name.as_str())
            .cloned()
            .or_else(|| self.output_for_global_xywh(info.x, info.y, info.width, info.height))
            .or_else(|| self.leftmost_output())
    }

    fn x11_initial_map_rect(&self, window: &X11Surface) -> Rectangle<i32, Logical> {
        let mut rect = window.geometry();
        if rect.loc.x != 0 || rect.loc.y != 0 {
            rect.size.w = rect.size.w.max(1);
            rect.size.h = rect.size.h.max(1);
            return rect;
        }
        rect.size.w = rect.size.w.max(DEFAULT_XDG_TOPLEVEL_WIDTH.max(1));
        rect.size.h = rect.size.h.max(DEFAULT_XDG_TOPLEVEL_HEIGHT.max(1));
        let Some(output) = self.new_toplevel_placement_output(None) else {
            rect.loc = Point::from((DEFAULT_XDG_TOPLEVEL_OFFSET_X, DEFAULT_XDG_TOPLEVEL_OFFSET_Y));
            return rect;
        };
        let Some(work) = self.shell_maximize_work_area_global_for_output(&output) else {
            rect.loc = Point::from((DEFAULT_XDG_TOPLEVEL_OFFSET_X, DEFAULT_XDG_TOPLEVEL_OFFSET_Y));
            return rect;
        };
        rect.size.w = rect.size.w.min(work.size.w.max(1));
        rect.size.h = rect.size.h.min(work.size.h.max(1));
        rect.loc = Point::from(self.staggered_toplevel_origin_for_output(
            &output,
            &work,
            rect.size.w,
            rect.size.h,
        ));
        rect
    }

    fn apply_x11_window_bounds(
        &mut self,
        window_id: u32,
        window: &X11Surface,
        rect: Rectangle<i32, Logical>,
        maximized: bool,
        fullscreen: bool,
    ) -> bool {
        if let Err(error) = window.set_fullscreen(fullscreen) {
            tracing::warn!(window_id, ?error, "x11 set_fullscreen failed");
        }
        if let Err(error) = window.set_maximized(maximized) {
            tracing::warn!(window_id, ?error, "x11 set_maximized failed");
        }
        if let Err(error) = window.configure(Some(rect)) {
            tracing::warn!(window_id, ?error, "x11 configure failed");
            return false;
        }
        self.space.map_element(
            DerpSpaceElem::X11(window.clone()),
            (rect.loc.x, rect.loc.y),
            true,
        );
        self.emit_x11_window_updates(window, true, false);
        true
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
            if self.window_registry.is_shell_hosted(mid) {
                self.shell_move_end_backed_only(mid);
            } else {
                self.shell_move_end(mid);
            }
        }
        if let Some(prev) = self.shell_resize_window_id {
            if self.window_registry.is_shell_hosted(prev) {
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
        use crate::grabs::resize_grab::{
            resize_tracking_set_resizing, ResizeEdge as GrabResizeEdge,
        };
        use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;

        if let Some(mid) = self.shell_move_window_id {
            if self.window_registry.is_shell_hosted(mid) {
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
            if self.window_registry.is_shell_hosted(prev) {
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
        if let Some(window) = self.find_window_by_surface_id(sid) {
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
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            return;
        };
        let Some(loc) = self
            .space
            .element_location(&DerpSpaceElem::X11(x11.clone()))
        else {
            return;
        };
        let geo = x11.geometry();
        let initial_rect = Rectangle::new(loc, geo.size);

        self.shell_resize_window_id = Some(window_id);
        self.shell_resize_edges = Some(edges);
        self.shell_resize_initial_rect = Some(initial_rect);
        self.shell_resize_accum = (0.0, 0.0);

        self.space
            .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
        if let Some(wl) = x11.wl_surface() {
            let k_serial = SERIAL_COUNTER.next_serial();
            self.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Some(wl), k_serial);
        }
    }

    fn shell_emit_interactive_resize_geometry(
        &mut self,
        window_id: u32,
        initial_rect: Rectangle<i32, Logical>,
        edges: crate::grabs::resize_grab::ResizeEdge,
        width: i32,
        height: i32,
    ) {
        let Some(mut info) = self.window_registry.window_info(window_id) else {
            return;
        };
        let width = width.max(1);
        let height = height.max(1);
        let mut x = initial_rect.loc.x;
        let mut y = initial_rect.loc.y;
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::LEFT) {
            x = initial_rect.loc.x + initial_rect.size.w - width;
        }
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::TOP) {
            y = initial_rect.loc.y + initial_rect.size.h - height;
        }
        info.x = x;
        info.y = y;
        info.width = width;
        info.height = height;
        info.output_name = self
            .output_for_window_position(x, y, width, height)
            .unwrap_or_default();
        self.shell_emit_chrome_event(ChromeEvent::WindowGeometryChanged { info });
        self.shell_nudge_cef_repaint();
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
        if self.window_registry.is_shell_hosted(wid) {
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
        self.shell_resize_accum.0 += dx as f64;
        self.shell_resize_accum.1 += dy as f64;
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let tl = window.toplevel().unwrap();
            let wl = tl.wl_surface();
            let last_size = compute_clamped_resize_size(
                self,
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
            self.shell_emit_interactive_resize_geometry(
                wid,
                initial_rect,
                edges,
                last_size.w,
                last_size.h,
            );
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            self.shell_resize_window_id = None;
            self.shell_resize_edges = None;
            self.shell_resize_initial_rect = None;
            self.shell_resize_accum = (0.0, 0.0);
            return;
        };
        let rect = self.x11_resize_rect(
            &x11,
            initial_rect,
            edges,
            self.shell_resize_accum.0,
            self.shell_resize_accum.1,
        );
        self.apply_x11_window_bounds(wid, &x11, rect, x11.is_maximized(), x11.is_fullscreen());
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

        if self.window_registry.is_shell_hosted(window_id) {
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

        if let Some(window) = self.find_window_by_surface_id(sid) {
            let tl = window.toplevel().unwrap();
            let wl = tl.wl_surface();
            let last_size = compute_clamped_resize_size(
                self,
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
            self.shell_emit_interactive_resize_geometry(
                window_id,
                initial_rect,
                edges,
                last_size.w,
                last_size.h,
            );
        } else if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
            let rect = self.x11_resize_rect(
                &x11,
                initial_rect,
                edges,
                self.shell_resize_accum.0,
                self.shell_resize_accum.1,
            );
            self.apply_x11_window_bounds(
                window_id,
                &x11,
                rect,
                x11.is_maximized(),
                x11.is_fullscreen(),
            );
        } else {
            self.shell_resize_window_id = None;
            self.shell_resize_edges = None;
            self.shell_resize_initial_rect = None;
            self.shell_resize_accum = (0.0, 0.0);
            return;
        }

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
        crate::cef::begin_frame_diag::note_shell_reply_window_list();
        self.workspace_sync_from_registry();
        self.shell_window_stack_seed_known_windows();
        self.capture_sync_toplevel_handles();
        let mut windows: Vec<shell_wire::ShellWindowSnapshot> = self
            .window_registry
            .all_records()
            .into_iter()
            .filter(|record| !self.window_info_is_solid_shell_host(&record.info))
            .filter(|record| shell_window_row_should_show(&record.info))
            .filter(|record| {
                record.kind == WindowKind::ShellHosted
                    || !self.wayland_window_id_is_pending_deferred_toplevel(record.info.window_id)
            })
            .map(|record| {
                let info = record.info;
                let i = self
                    .shell_window_info_to_output_local_layout(&info)
                    .unwrap_or_else(|| info.clone());
                let capture_identifier = self
                    .capture_toplevel_handles
                    .get(&i.window_id)
                    .map(|handle| handle.identifier())
                    .unwrap_or_default();
                shell_wire::ShellWindowSnapshot {
                    window_id: i.window_id,
                    surface_id: i.surface_id,
                    stack_z: self.shell_window_stack_z(i.window_id),
                    x: i.x,
                    y: i.y,
                    w: i.width,
                    h: i.height,
                    minimized: if i.minimized { 1 } else { 0 },
                    maximized: if i.maximized { 1 } else { 0 },
                    fullscreen: if i.fullscreen { 1 } else { 0 },
                    client_side_decoration: if i.client_side_decoration { 1 } else { 0 },
                    shell_flags: if record.kind == WindowKind::ShellHosted {
                        shell_wire::SHELL_WINDOW_FLAG_SHELL_HOSTED
                    } else {
                        0
                    },
                    title: i.title,
                    app_id: i.app_id,
                    output_name: i.output_name,
                    capture_identifier,
                }
            })
            .collect();
        windows.sort_by(|a, b| a.window_id.cmp(&b.window_id));
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowList { windows });
        self.workspace_send_state();
    }

    fn workspace_live_window_ids(&self) -> Vec<u32> {
        let mut window_ids: Vec<u32> = self
            .window_registry
            .all_records()
            .into_iter()
            .filter(|record| !self.window_info_is_solid_shell_host(&record.info))
            .filter(|record| shell_window_row_should_show(&record.info))
            .filter(|record| {
                record.kind == WindowKind::ShellHosted
                    || !self.wayland_window_id_is_pending_deferred_toplevel(record.info.window_id)
            })
            .map(|record| record.info.window_id)
            .collect();
        window_ids.sort_unstable();
        window_ids
    }

    fn workspace_sync_from_registry(&mut self) -> bool {
        let next =
            reconcile_workspace_state(&self.workspace_state, &self.workspace_live_window_ids());
        if next == self.workspace_state {
            return false;
        }
        self.workspace_state = next;
        true
    }

    fn workspace_send_state(&mut self) {
        let Ok(state_json) = self.workspace_state.to_json() else {
            return;
        };
        tracing::warn!(
            target: "derp_workspace",
            groups = self.workspace_state.groups.len(),
            "workspace_send_state"
        );
        self.shell_send_to_cef(
            shell_wire::DecodedCompositorToShellMessage::WorkspaceState { state_json },
        );
    }

    fn shell_hosted_app_state_broadcast_json(&self) -> String {
        let mut m = serde_json::Map::new();
        for (k, v) in &self.shell_hosted_app_state {
            m.insert(k.to_string(), v.clone());
        }
        serde_json::json!({ "byWindowId": serde_json::Value::Object(m) }).to_string()
    }

    pub(crate) fn shell_hosted_app_state_send(&mut self) {
        let state_json = self.shell_hosted_app_state_broadcast_json();
        self.shell_send_to_cef(
            shell_wire::DecodedCompositorToShellMessage::ShellHostedAppState { state_json },
        );
    }

    pub(crate) fn hydrate_shell_hosted_app_state_from_session(&mut self) {
        let file = crate::session::session_state::read_session_state();
        let Some(shell) = file.shell.as_object() else {
            return;
        };
        let Some(rows) = shell.get("shellWindows").and_then(|x| x.as_array()) else {
            return;
        };
        for row in rows {
            let Some(obj) = row.as_object() else {
                continue;
            };
            let wid = obj
                .get("windowId")
                .and_then(|x| x.as_u64())
                .map(|u| u as u32);
            let kind = obj.get("kind").and_then(|x| x.as_str());
            let (Some(wid), Some(kind)) = (wid, kind) else {
                continue;
            };
            if kind != "file_browser"
                && kind != "image_viewer"
                && kind != "video_viewer"
                && kind != "text_editor"
            {
                continue;
            }
            let Some(st) = obj.get("state") else {
                continue;
            };
            if st.is_null() {
                continue;
            }
            self.shell_hosted_app_state.insert(wid, st.clone());
        }
    }

    pub(crate) fn apply_shell_hosted_window_state_json(&mut self, json: &str) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
            return;
        };
        let Some(window_id) = v.get("window_id").and_then(|x| x.as_u64()).map(|u| u as u32) else {
            return;
        };
        let Some(kind) = v.get("kind").and_then(|x| x.as_str()) else {
            return;
        };
        if kind != "file_browser"
            && kind != "image_viewer"
            && kind != "video_viewer"
            && kind != "text_editor"
        {
            return;
        }
        if !self.window_registry.is_shell_hosted(window_id) {
            return;
        }
        let state = match v.get("state") {
            Some(s) if s.is_object() => s.clone(),
            Some(s) if s.is_null() => serde_json::json!({}),
            _ => return,
        };
        self.shell_hosted_app_state.insert(window_id, state);
        self.shell_hosted_app_state_send();
    }

    fn workspace_copy_window_geometry(&mut self, target_window_id: u32, source_window_id: u32) {
        let Some(source_info) = self.window_registry.window_info(source_window_id) else {
            return;
        };
        let Some(layout) = self.shell_window_info_to_output_local_layout(&source_info) else {
            return;
        };
        self.shell_set_window_geometry(
            target_window_id,
            layout.x,
            layout.y,
            layout.width.max(1),
            layout.height.max(1),
            if layout.maximized { 1 } else { 0 },
        );
    }

    pub(crate) fn apply_workspace_mutation_json(&mut self, mutation_json: &str) {
        let Ok(mutation) = serde_json::from_str::<WorkspaceMutation>(mutation_json) else {
            tracing::warn!(target: "derp_workspace", %mutation_json, "workspace mutation parse failed");
            return;
        };
        tracing::warn!(target: "derp_workspace", ?mutation, "workspace mutation received");
        self.workspace_sync_from_registry();
        let previous_state = self.workspace_state.clone();
        let Some(next_state) = previous_state.apply_mutation(&mutation) else {
            tracing::warn!(target: "derp_workspace", ?mutation, "workspace mutation produced no change");
            return;
        };
        let next_state = reconcile_workspace_state(&next_state, &self.workspace_live_window_ids());
        let mut activation_window_id = None;
        match &mutation {
            WorkspaceMutation::SelectTab { group_id, .. } => {
                let previous_visible = previous_state.visible_window_id_for_group(group_id);
                let next_visible = next_state.visible_window_id_for_group(group_id);
                if let (Some(previous_visible), Some(next_visible)) =
                    (previous_visible, next_visible)
                {
                    if previous_visible != next_visible {
                        self.workspace_copy_window_geometry(next_visible, previous_visible);
                        activation_window_id = Some(next_visible);
                    }
                }
            }
            WorkspaceMutation::MoveWindowToGroup {
                window_id,
                target_group_id,
                ..
            } => {
                let source_group_id =
                    group_id_for_window(&previous_state, *window_id).map(str::to_string);
                if source_group_id.as_deref() != Some(target_group_id.as_str()) {
                    if let Some(target_visible) =
                        previous_state.visible_window_id_for_group(target_group_id)
                    {
                        self.workspace_copy_window_geometry(*window_id, target_visible);
                        activation_window_id = Some(target_visible);
                    }
                }
            }
            WorkspaceMutation::SplitWindowToOwnGroup { window_id } => {
                activation_window_id = Some(*window_id);
            }
            WorkspaceMutation::EnterSplit { group_id, .. }
            | WorkspaceMutation::ExitSplit { group_id, .. } => {
                activation_window_id = next_state.visible_window_id_for_group(group_id);
            }
            WorkspaceMutation::SetWindowPinned { .. }
            | WorkspaceMutation::SetSplitFraction { .. }
            | WorkspaceMutation::SetMonitorTile { .. }
            | WorkspaceMutation::RemoveMonitorTile { .. }
            | WorkspaceMutation::ClearMonitorTiles { .. }
            | WorkspaceMutation::SetPreTileGeometry { .. }
            | WorkspaceMutation::ClearPreTileGeometry { .. }
            | WorkspaceMutation::ReplaceState { .. } => {}
        }
        self.workspace_state = next_state;
        self.workspace_send_state();
        if let Some(window_id) = activation_window_id {
            self.shell_activate_window(window_id);
        }
    }

    fn workspace_apply_close_side_effects(&mut self, window_id: u32) {
        let group_id = group_id_for_window(&self.workspace_state, window_id).map(str::to_string);
        self.workspace_sync_from_registry();
        let Some(group_id) = group_id else {
            self.workspace_send_state();
            return;
        };
        let next_visible =
            next_active_window_after_removal(&self.workspace_state, &group_id, window_id);
        self.workspace_state =
            reconcile_workspace_state(&self.workspace_state, &self.workspace_live_window_ids());
        self.workspace_send_state();
        if let Some(next_visible) = next_visible {
            self.shell_activate_window(next_visible);
        }
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

    pub fn super_move_window_to_adjacent_monitor(
        &mut self,
        window_id: u32,
        move_right: bool,
    ) -> Result<(), String> {
        let info = self
            .window_registry
            .window_info(window_id)
            .ok_or_else(|| "missing window".to_string())?;
        if info.minimized {
            return Err("minimized".into());
        }
        if self.window_info_is_solid_shell_host(&info) {
            return Err("solid host".into());
        }
        let mut pairs: Vec<(String, Rectangle<i32, Logical>)> = self
            .space
            .outputs()
            .filter_map(|o| {
                let g = self.space.output_geometry(o)?;
                Some((o.name().into(), g))
            })
            .collect();
        if pairs.len() < 2 {
            return Err("outputs".into());
        }
        pairs.sort_by(|a, b| {
            a.1.loc
                .x
                .cmp(&b.1.loc.x)
                .then_with(|| a.1.loc.y.cmp(&b.1.loc.y))
                .then_with(|| a.0.cmp(&b.0))
        });
        let cur_idx = pick_output_name_for_global_window_center_first(
            &pairs,
            info.x,
            info.y,
            info.width,
            info.height,
        )
        .and_then(|picked| pairs.iter().position(|(n, _)| n == picked.as_str()))
        .or_else(|| {
            pick_output_name_for_global_window_rect_from_output_rects(
                &pairs,
                info.x,
                info.y,
                info.width,
                info.height,
            )
            .and_then(|picked| pairs.iter().position(|(n, _)| n == picked.as_str()))
        })
        .or_else(|| {
            if info.output_name.is_empty() {
                None
            } else {
                pairs
                    .iter()
                    .position(|(n, _)| n == info.output_name.as_str())
            }
        })
        .ok_or_else(|| "current output".to_string())?;
        let tgt_idx = if move_right {
            if cur_idx + 1 >= pairs.len() {
                return Err("no adjacent right".into());
            }
            cur_idx + 1
        } else if cur_idx == 0 {
            return Err("no adjacent left".into());
        } else {
            cur_idx - 1
        };
        let src_name = pairs[cur_idx].0.clone();
        let tgt_name = pairs[tgt_idx].0.clone();
        let Some(src_out) = self.space.outputs().find(|o| o.name() == src_name.as_str()) else {
            return Err("src output".into());
        };
        let Some(tgt_out) = self.space.outputs().find(|o| o.name() == tgt_name.as_str()) else {
            return Err("tgt output".into());
        };
        let Some(src_work) = self.shell_maximize_work_area_global_for_output(&src_out) else {
            return Err("src work".into());
        };
        let Some(tgt_work) = self.shell_maximize_work_area_global_for_output(&tgt_out) else {
            return Err("tgt work".into());
        };
        let (ox, oy) = self.shell_canvas_logical_origin;
        if info.maximized {
            let gx = tgt_work.loc.x;
            let gy = tgt_work.loc.y;
            let gw = tgt_work.size.w.max(1);
            let gh = tgt_work.size.h.max(1);
            self.shell_set_window_geometry(
                window_id,
                gx.saturating_sub(ox),
                gy.saturating_sub(oy),
                gw,
                gh,
                1,
            );
            return Ok(());
        }
        let gy = info.y;
        let tw = tgt_work.size.w.max(1);
        let th = tgt_work.size.h.max(1);
        let gw = info.width.max(1).min(tw);
        let gh = info.height.max(1).min(th);
        let rel_y = gy.saturating_sub(src_work.loc.y);
        let mut nx = tgt_work
            .loc
            .x
            .saturating_add((tgt_work.size.w.saturating_sub(gw)).saturating_div(2));
        let mut ny = tgt_work.loc.y.saturating_add(rel_y);
        let max_x = tgt_work.loc.x.saturating_add(tgt_work.size.w.saturating_sub(gw));
        let max_y = tgt_work.loc.y.saturating_add(tgt_work.size.h.saturating_sub(gh));
        nx = nx.max(tgt_work.loc.x).min(max_x);
        ny = ny.max(tgt_work.loc.y).min(max_y);
        self.shell_set_window_geometry(
            window_id,
            nx.saturating_sub(ox),
            ny.saturating_sub(oy),
            gw,
            gh,
            0,
        );
        Ok(())
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
        let Some((x, y, w, h)) = self.shell_output_local_rect_to_logical_global(lx, ly, lw, lh)
        else {
            return;
        };
        let target_output_name = self
            .output_for_window_position(x, y, w, h)
            .unwrap_or_default();
        if info.minimized {
            if let Some(window) = self.shell_minimized_windows.get(&window_id).cloned() {
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
                let _ = self
                    .window_registry
                    .update_native(window_id, |window_info| {
                        if layout_state == 1 {
                            window_info.maximized = true;
                        } else {
                            window_info.maximized = false;
                        }
                        window_info.fullscreen = false;
                        window_info.x = x;
                        window_info.y = y;
                        window_info.width = w.max(1);
                        window_info.height = h.max(1);
                        window_info.output_name = target_output_name.clone();
                    });
                self.capture_refresh_window_source_cache(window_id);
                let tl = window.toplevel().unwrap();
                tl.with_pending_state(|state| {
                    state.states.unset(xdg_toplevel::State::Fullscreen);
                    state.fullscreen_output = None;
                    if layout_state == 1 {
                        state.states.set(xdg_toplevel::State::Maximized);
                    } else {
                        state.states.unset(xdg_toplevel::State::Maximized);
                    }
                    state.size = Some(smithay::utils::Size::from((w.max(1), h.max(1))));
                });
                tl.send_pending_configure();
                return;
            }
            if let Some(x11) = self.shell_minimized_x11_windows.get(&window_id).cloned() {
                if layout_state == 0 {
                    self.clear_toplevel_layout_maps(window_id);
                } else {
                    self.cancel_shell_move_resize_for_window(window_id);
                    if !self.toplevel_floating_restore.contains_key(&window_id) {
                        let geometry = x11.geometry();
                        self.toplevel_floating_restore.insert(
                            window_id,
                            (geometry.loc.x, geometry.loc.y, geometry.size.w, geometry.size.h),
                        );
                    }
                }
                let _ = self
                    .window_registry
                    .update_native(window_id, |window_info| {
                        window_info.maximized = layout_state == 1;
                        window_info.fullscreen = false;
                        window_info.x = x;
                        window_info.y = y;
                        window_info.width = w.max(1);
                        window_info.height = h.max(1);
                        window_info.output_name = target_output_name.clone();
                    });
                self.capture_refresh_window_source_cache(window_id);
                let rect = Rectangle::new(Point::from((x, y)), Size::from((w.max(1), h.max(1))));
                if let Err(error) = x11.set_fullscreen(false) {
                    tracing::warn!(window_id, ?error, "x11 set_fullscreen failed");
                }
                if let Err(error) = x11.set_maximized(layout_state == 1) {
                    tracing::warn!(window_id, ?error, "x11 set_maximized failed");
                }
                if let Err(error) = x11.configure(Some(rect)) {
                    tracing::warn!(window_id, ?error, "x11 configure failed");
                }
                return;
            }
        }
        if let Some(window) = self.find_window_by_surface_id(sid) {
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

            if info.minimized {
                let _ = self
                    .window_registry
                    .update_native(window_id, |window_info| {
                        if layout_state == 1 {
                            window_info.maximized = true;
                        } else {
                            window_info.maximized = false;
                        }
                        window_info.fullscreen = false;
                        window_info.x = x;
                        window_info.y = y;
                        window_info.width = w.max(1);
                        window_info.height = h.max(1);
                        window_info.output_name = target_output_name.clone();
                    });
                self.capture_refresh_window_source_cache(window_id);
                if let Some(window) = self.shell_minimized_windows.get(&window_id) {
                    let tl = window.toplevel().unwrap();
                    tl.with_pending_state(|state| {
                        state.states.unset(xdg_toplevel::State::Fullscreen);
                        state.fullscreen_output = None;
                        if layout_state == 1 {
                            state.states.set(xdg_toplevel::State::Maximized);
                        } else {
                            state.states.unset(xdg_toplevel::State::Maximized);
                        }
                        state.size = Some(smithay::utils::Size::from((w.max(1), h.max(1))));
                    });
                    tl.send_pending_configure();
                }
                return;
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
            self.shell_emit_requested_native_geometry(
                window_id,
                map_x,
                map_y,
                content_w,
                content_h,
                target_output_name,
                layout_state == 1,
            );
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            return;
        };
        if layout_state == 0 {
            self.clear_toplevel_layout_maps(window_id);
        } else {
            self.cancel_shell_move_resize_for_window(window_id);
            if !self.toplevel_floating_restore.contains_key(&window_id) {
                let geometry = x11.geometry();
                let location = self
                    .space
                    .element_location(&DerpSpaceElem::X11(x11.clone()))
                    .unwrap_or(geometry.loc);
                self.toplevel_floating_restore.insert(
                    window_id,
                    (location.x, location.y, geometry.size.w, geometry.size.h),
                );
            }
        }
        if info.minimized {
            let _ = self
                .window_registry
                .update_native(window_id, |window_info| {
                    window_info.maximized = layout_state == 1;
                    window_info.fullscreen = false;
                    window_info.x = x;
                    window_info.y = y;
                    window_info.width = w.max(1);
                    window_info.height = h.max(1);
                    window_info.output_name = target_output_name.clone();
                });
            self.capture_refresh_window_source_cache(window_id);
            if let Some(window) = self.shell_minimized_x11_windows.get(&window_id) {
                let rect = Rectangle::new(Point::from((x, y)), Size::from((w.max(1), h.max(1))));
                if let Err(error) = window.set_fullscreen(false) {
                    tracing::warn!(window_id, ?error, "x11 set_fullscreen failed");
                }
                if let Err(error) = window.set_maximized(layout_state == 1) {
                    tracing::warn!(window_id, ?error, "x11 set_maximized failed");
                }
                if let Err(error) = window.configure(Some(rect)) {
                    tracing::warn!(window_id, ?error, "x11 configure failed");
                }
            }
            return;
        }
        let rect = Rectangle::new(Point::from((x, y)), Size::from((w.max(1), h.max(1))));
        self.apply_x11_window_bounds(window_id, &x11, rect, layout_state == 1, false);
    }

    pub fn shell_close_window(&mut self, window_id: u32) {
        if self.shell_backed_close_if_any(window_id) {
            self.workspace_apply_close_side_effects(window_id);
            return;
        }
        if let Some(target) = self.close_refocus_target_for_window(window_id) {
            self.shell_close_refocus_targets.insert(window_id, target);
        } else {
            self.shell_close_refocus_targets.remove(&window_id);
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
        } else if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
            self.space
                .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
            if let Some(wl_surf) = x11.wl_surface() {
                let k_serial = SERIAL_COUNTER.next_serial();
                if let Some(kb) = self.seat.get_keyboard() {
                    kb.set_focus(self, Some(wl_surf), k_serial);
                }
            }
        }
        if self.shell_move_window_id == Some(window_id) {
            self.shell_move_end(window_id);
        }
        if self.shell_resize_window_id == Some(window_id) {
            self.shell_resize_end(window_id);
        }
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let Some(tl) = window.toplevel() else {
                return;
            };
            self.shell_close_pending_native_windows.insert(window_id);
            tracing::warn!(
                target: "derp_toplevel",
                window_id,
                wl_surface_protocol_id = tl.wl_surface().id().protocol_id(),
                title = %info.title,
                app_id = %info.app_id,
                "shell_close_window send_close"
            );
            tl.send_close();
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            tracing::warn!(
                target: "derp_toplevel",
                window_id,
                "shell_close_window abort: no mapped native window"
            );
            return;
        };
        tracing::warn!(
            target: "derp_toplevel",
            window_id,
            x11_window_id = x11.window_id(),
            title = %info.title,
            app_id = %info.app_id,
            "shell_close_window x11 close"
        );
        self.shell_close_pending_native_windows.insert(window_id);
        if let Err(error) = x11.close() {
            tracing::warn!(
                target: "derp_toplevel",
                window_id,
                ?error,
                "shell_close_window x11 close failed"
            );
            self.shell_close_pending_native_windows.remove(&window_id);
            self.shell_close_refocus_targets.remove(&window_id);
        }
    }

    pub(crate) fn hide_bufferless_native_window(&mut self, root: &WlSurface) {
        let Some(window_id) = self.window_registry.window_id_for_wl_surface(root) else {
            return;
        };
        let buffer_removed = smithay::wayland::compositor::with_states(root, |states| {
            matches!(
                states
                    .cached_state
                    .get::<smithay::wayland::compositor::SurfaceAttributes>()
                    .current()
                    .buffer,
                Some(smithay::wayland::compositor::BufferAssignment::Removed)
            )
        });
        let Some(window) = self.space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                (w.toplevel().unwrap().wl_surface() == root).then_some(w.clone())
            } else {
                None
            }
        }) else {
            return;
        };
        let bbox = window.bbox();
        let lost_buffer_extent = bbox.size.w < 1 || bbox.size.h < 1;
        if !buffer_removed && !lost_buffer_extent {
            return;
        }
        tracing::warn!(
            target: "derp_toplevel",
            window_id,
            wl_surface_protocol_id = root.id().protocol_id(),
            bbox_w = bbox.size.w,
            bbox_h = bbox.size.h,
            buffer_removed,
            close_pending = self.shell_close_pending_native_windows.contains(&window_id),
            "native window lost content; pruning stuck window"
        );
        self.space.unmap_elem(&DerpSpaceElem::Wayland(window));
        self.clear_toplevel_layout_maps(window_id);
        self.pending_gnome_initial_toplevels.remove(&window_id);
        self.shell_close_pending_native_windows.remove(&window_id);
        let keyboard_had_focus = self.keyboard_focused_window_id() == Some(window_id);
        if self.shell_pending_native_focus_window_id == Some(window_id) {
            self.shell_pending_native_focus_window_id = None;
        }
        self.shell_window_stack_forget(window_id);
        self.shell_minimized_windows.remove(&window_id);
        if keyboard_had_focus {
            let serial = SERIAL_COUNTER.next_serial();
            self.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Option::<WlSurface>::None, serial);
            self.keyboard_on_focus_surface_changed(None);
        }
        let removed = self.window_registry.snapshot_for_wl_surface(root);
        if let Some(pruned_window_id) = self.window_registry.remove_by_wl_surface(root) {
            self.capture_forget_window_source_cache(pruned_window_id);
            self.shell_emit_chrome_window_unmapped(pruned_window_id, removed);
            self.try_refocus_after_closed_window(pruned_window_id, keyboard_had_focus);
        } else {
            self.shell_close_refocus_targets.remove(&window_id);
        }
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
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let wl = window.toplevel().unwrap().wl_surface();
            if enabled {
                if read_toplevel_tiling(wl).1 {
                    return;
                }
                let maximized = read_toplevel_tiling(wl).0;
                if maximized {
                    self.toplevel_fullscreen_return_maximized.insert(window_id);
                } else {
                    self.toplevel_fullscreen_return_maximized.remove(&window_id);
                    if !self.toplevel_floating_restore.contains_key(&window_id) {
                        if let Some(s) = self.toplevel_rect_snapshot(&window) {
                            self.toplevel_floating_restore.insert(window_id, s);
                        }
                    }
                }
                self.apply_toplevel_fullscreen_layout(&window, None);
            } else {
                if !read_toplevel_tiling(wl).1 {
                    return;
                }
                let _ = self.toplevel_unfullscreen(&window);
            }
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            return;
        };
        if enabled {
            if info.fullscreen {
                return;
            }
            if info.maximized {
                self.toplevel_fullscreen_return_maximized.insert(window_id);
            } else {
                self.toplevel_fullscreen_return_maximized.remove(&window_id);
                if !self.toplevel_floating_restore.contains_key(&window_id) {
                    let geometry = x11.geometry();
                    let location = self
                        .space
                        .element_location(&DerpSpaceElem::X11(x11.clone()))
                        .unwrap_or(geometry.loc);
                    self.toplevel_floating_restore.insert(
                        window_id,
                        (location.x, location.y, geometry.size.w, geometry.size.h),
                    );
                }
            }
            let Some(output) = self.x11_target_output(window_id) else {
                return;
            };
            let Some(rect) = self.space.output_geometry(&output) else {
                return;
            };
            self.apply_x11_window_bounds(window_id, &x11, rect, false, true);
            return;
        }
        if !info.fullscreen {
            return;
        }
        if self.toplevel_fullscreen_return_maximized.remove(&window_id) {
            self.shell_set_window_maximized(window_id, true);
            return;
        }
        let rect = self
            .toplevel_floating_restore
            .remove(&window_id)
            .map(|(x, y, w, h)| Rectangle::new(Point::from((x, y)), Size::from((w, h))))
            .unwrap_or_else(|| {
                let geometry = x11.geometry();
                let location = self
                    .space
                    .element_location(&DerpSpaceElem::X11(x11.clone()))
                    .unwrap_or(geometry.loc);
                Rectangle::new(location, geometry.size)
            });
        self.apply_x11_window_bounds(window_id, &x11, rect, false, false);
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
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let wl = window.toplevel().unwrap().wl_surface();
            if enabled {
                return;
            } else {
                if !read_toplevel_tiling(wl).0 {
                    return;
                }
                let _ = self.toplevel_unmaximize(&window);
            }
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            return;
        };
        if enabled {
            if info.maximized {
                return;
            }
            self.cancel_shell_move_resize_for_window(window_id);
            if !self.toplevel_floating_restore.contains_key(&window_id) {
                let geometry = x11.geometry();
                let location = self
                    .space
                    .element_location(&DerpSpaceElem::X11(x11.clone()))
                    .unwrap_or(geometry.loc);
                self.toplevel_floating_restore.insert(
                    window_id,
                    (location.x, location.y, geometry.size.w, geometry.size.h),
                );
            }
            let Some(output) = self.x11_target_output(window_id) else {
                return;
            };
            let Some(rect) = self.shell_maximize_work_area_global_for_output(&output) else {
                return;
            };
            self.apply_x11_window_bounds(window_id, &x11, rect, true, false);
            return;
        }
        if !info.maximized {
            return;
        }
        let rect = self
            .toplevel_floating_restore
            .remove(&window_id)
            .map(|(x, y, w, h)| Rectangle::new(Point::from((x, y)), Size::from((w, h))))
            .unwrap_or_else(|| {
                let geometry = x11.geometry();
                let location = self
                    .space
                    .element_location(&DerpSpaceElem::X11(x11.clone()))
                    .unwrap_or(geometry.loc);
                Rectangle::new(location, geometry.size)
            });
        self.apply_x11_window_bounds(window_id, &x11, rect, false, false);
    }

    pub fn shell_set_presentation_fullscreen(&mut self, enabled: bool) {
        self.shell_presentation_fullscreen = enabled;
    }

    pub(crate) fn keyboard_focused_window_id(&self) -> Option<u32> {
        let surf = self.seat.get_keyboard()?.current_focus()?;
        let window_id = self.window_registry.window_id_for_wl_surface(&surf)?;
        self.logical_focus_target_is_valid(window_id)
            .then_some(window_id)
    }

    pub(crate) fn try_refocus_after_closed_toplevel(&mut self) {
        let Some(target) = self.pick_next_logical_focus_target(None, true) else {
            let serial = SERIAL_COUNTER.next_serial();
            self.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Option::<WlSurface>::None, serial);
            self.keyboard_on_focus_surface_changed(None);
            return;
        };
        self.focus_logical_window(target);
        self.shell_reply_window_list();
    }

    pub(crate) fn close_refocus_target_for_window(&self, window_id: u32) -> Option<u32> {
        let topmost = self.pick_next_logical_focus_target(None, true)?;
        if topmost == window_id {
            return self.pick_next_logical_focus_target(Some(window_id), true);
        }
        Some(topmost)
    }

    pub(crate) fn try_refocus_after_closed_window(
        &mut self,
        closed_window_id: u32,
        keyboard_had_focus: bool,
    ) -> bool {
        if let Some(target) = self.shell_close_refocus_targets.remove(&closed_window_id) {
            if self.logical_focus_target_is_valid(target) {
                self.focus_logical_window(target);
                self.shell_reply_window_list();
                return true;
            }
        }
        if keyboard_had_focus {
            self.try_refocus_after_closed_toplevel();
            return true;
        }
        false
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
        self.shell_ipc_keyboard_to_cef = false;
        self.shell_note_non_shell_focus();
        self.space.elements().for_each(|e| {
            e.set_activate(false);
            if let DerpSpaceElem::Wayland(w) = e {
                w.toplevel().unwrap().send_pending_configure();
            }
        });
        if let Some(window) = self.find_window_by_surface_id(sid) {
            if self.shell_pending_native_focus_window_id == Some(window_id) {
                self.shell_pending_native_focus_window_id = None;
            }
            let _ = window.set_activated(true);
            self.space
                .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
            self.shell_window_stack_touch(window_id);
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
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            return;
        };
        if let Err(error) = x11.set_activated(true) {
            tracing::warn!(window_id, ?error, "x11 set_activated failed");
        }
        self.space
            .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
        self.shell_window_stack_touch(window_id);
        if let Some(wl_surface) = x11.wl_surface() {
            self.shell_pending_native_focus_window_id = None;
            let k_serial = SERIAL_COUNTER.next_serial();
            self.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Some(wl_surface), k_serial);
        } else {
            self.shell_pending_native_focus_window_id = Some(window_id);
        }
        self.emit_x11_window_updates(&x11, false, false);
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
        if self.shell_move_window_id == Some(window_id) {
            self.shell_move_end(window_id);
        }
        if self.shell_resize_window_id == Some(window_id) {
            self.shell_resize_end(window_id);
        }
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let _ = window.set_activated(false);
            window.toplevel().unwrap().send_pending_configure();
            self.shell_minimized_windows
                .insert(window_id, window.clone());
            self.space.unmap_elem(&DerpSpaceElem::Wayland(window));
            self.window_registry.set_minimized(window_id, true);

            if self.keyboard_focused_window_id() == Some(window_id) {
                let serial = SERIAL_COUNTER.next_serial();
                self.seat.get_keyboard().unwrap().set_focus(
                    self,
                    Option::<WlSurface>::None,
                    serial,
                );
                self.keyboard_on_focus_surface_changed(None);
            }

            self.shell_emit_window_state(window_id, true);
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            return;
        };
        self.shell_minimized_x11_windows
            .insert(window_id, x11.clone());
        if self.shell_pending_native_focus_window_id == Some(window_id) {
            self.shell_pending_native_focus_window_id = None;
        }
        if let Err(error) = x11.set_activated(false) {
            tracing::warn!(window_id, ?error, "x11 set_activated failed");
        }
        if let Err(error) = x11.set_hidden(true) {
            tracing::warn!(window_id, ?error, "x11 set_hidden failed");
        }
        self.space.unmap_elem(&DerpSpaceElem::X11(x11.clone()));
        let _ = self
            .window_registry
            .update_native(window_id, |window_info| {
                window_info.minimized = true;
            });
        if self.keyboard_focused_window_id() == Some(window_id) {
            let serial = SERIAL_COUNTER.next_serial();
            self.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Option::<WlSurface>::None, serial);
            self.keyboard_on_focus_surface_changed(None);
        }
        self.emit_x11_window_updates(&x11, false, false);
        self.shell_emit_window_state(window_id, true);
    }

    /// Map a compositor-minimized toplevel back into the space and focus it.
    pub fn shell_restore_minimized_window(&mut self, window_id: u32) {
        if self
            .window_registry
            .window_info(window_id)
            .filter(|_| self.window_registry.is_shell_hosted(window_id))
            .is_some_and(|info| info.minimized)
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
        if let Some(window) = self.shell_minimized_windows.remove(&window_id) {
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
            return;
        }
        let Some(x11) = self.shell_minimized_x11_windows.remove(&window_id) else {
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
        self.shell_pending_native_focus_window_id = Some(window_id);
        let _ = self.window_registry.set_minimized(window_id, false);
        if let Err(error) = x11.set_hidden(false) {
            tracing::warn!(window_id, ?error, "x11 set_hidden(false) failed");
        }
        let rect = Rectangle::new(
            Point::from((info.x, info.y)),
            Size::from((info.width.max(1), info.height.max(1))),
        );
        self.space.map_element(
            DerpSpaceElem::X11(x11.clone()),
            (rect.loc.x, rect.loc.y),
            false,
        );
        self.apply_x11_window_bounds(window_id, &x11, rect, info.maximized, info.fullscreen);
        if let Err(error) = x11.set_activated(true) {
            tracing::warn!(window_id, ?error, "x11 set_activated(true) failed");
        }
        self.space
            .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
        if let Some(wl_surface) = x11.wl_surface() {
            self.shell_pending_native_focus_window_id = None;
            let k_serial = SERIAL_COUNTER.next_serial();
            self.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Some(wl_surface), k_serial);
        }
        self.emit_x11_window_updates(&x11, true, false);
        self.shell_emit_window_state(window_id, false);
        if self.shell_pending_native_focus_window_id == Some(window_id) {
            self.shell_raise_and_focus_window(window_id);
        }
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

        let should_minimize = self.logical_focused_window_id() == Some(window_id);
        if should_minimize {
            self.shell_minimize_window(window_id);
        } else {
            self.shell_raise_and_focus_window(window_id);
            self.shell_reply_window_list();
        }
    }

    /// Shell-internal activation without taskbar toggle semantics.
    pub fn shell_activate_window(&mut self, window_id: u32) {
        if self.window_registry.is_shell_hosted(window_id) {
            if self
                .window_registry
                .window_info(window_id)
                .is_some_and(|info| info.minimized)
            {
                self.shell_backed_restore_minimized_if_any(window_id);
            }
            self.shell_focus_shell_ui_window(window_id);
            return;
        }
        let Some(info) = self.window_registry.window_info(window_id) else {
            return;
        };
        if info.minimized {
            self.shell_restore_minimized_window(window_id);
            return;
        }
        self.shell_raise_and_focus_window(window_id);
        self.shell_reply_window_list();
    }

    pub(crate) fn shell_pointer_ipc_for_cef(&self, pos: Point<f64, Logical>) -> Option<(i32, i32)> {
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

    fn shell_osr_dirty_bbox_covers_buffer(
        dirty: &[(i32, i32, i32, i32)],
        buf_w: u32,
        buf_h: u32,
    ) -> bool {
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
                || v.as_os_str()
                    .eq_ignore_ascii_case(std::ffi::OsStr::new("true"))
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
        self.shell_dmabuf_generation = 0;
        self.shell_dmabuf_overlay_id = Id::new();
        self.shell_dmabuf_commit = CommitCounter::default();
        self.shell_dmabuf_dirty_buffer.clear();
        self.shell_dmabuf_dirty_force_full = true;
        self.shell_last_pointer_ipc_px = None;
        self.shell_last_pointer_ipc_global_logical = None;
        self.touch_routes_to_cef = false;
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
            let Some(h) = handles.iter().find(|h| h.modified_sym().raw() == sym_raw) else {
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
        self.shell_begin_frame_note_shell_input();
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
        self.sync_shell_shared_state_for_input();
        let route = self.shell_pointer_should_ipc_to_cef(pos);
        if !route
            && !self.shell_move_is_active()
            && !self.shell_resize_is_active()
            && self.shell_ui_pointer_grab.is_none()
        {
            return;
        }
        let Some((bx, by)) = self.shell_pointer_coords_for_cef(pos) else {
            return;
        };
        let global_key = (pos.x.round() as i32, pos.y.round() as i32);
        if self.shell_last_pointer_ipc_global_logical == Some(global_key) {
            return;
        }
        self.shell_begin_frame_note_shell_input();
        self.shell_last_pointer_ipc_global_logical = Some(global_key);
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
        let Some(pointer) = self.seat.get_pointer() else {
            return;
        };
        let pos = pointer.current_location();
        self.sync_shell_shared_state_for_input();
        let route = self.shell_pointer_should_ipc_to_cef(pos);
        if !route
            && !self.shell_move_is_active()
            && !self.shell_resize_is_active()
            && self.shell_ui_pointer_grab.is_none()
        {
            return;
        }
        let Some((bx, by)) = self.shell_pointer_coords_for_cef(pos) else {
            return;
        };
        self.shell_begin_frame_note_shell_input();
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
        let mut envs = vec![
            ("WAYLAND_DISPLAY".to_string(), display),
            ("XDG_RUNTIME_DIR".to_string(), runtime),
        ];
        for key in [
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_CURRENT_DESKTOP",
            "XDG_SESSION_DESKTOP",
            "XDG_SESSION_TYPE",
            "DESKTOP_SESSION",
            "DISPLAY",
            "QT_WAYLAND_DISABLE_WINDOWDECORATION",
        ] {
            if let Ok(value) = std::env::var(key) {
                envs.push((key.to_string(), value));
            }
        }

        let mut unit_name = format!(
            "derp-spawn-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        unit_name.retain(|c| c.is_ascii_alphanumeric() || c == '-');

        let mut launched_via_systemd = false;
        let mut systemd_run = std::process::Command::new("systemd-run");
        systemd_run
            .arg("--user")
            .arg("--collect")
            .arg("--quiet")
            .arg("--service-type=exec")
            .arg(format!("--unit={unit_name}"));
        for (key, value) in &envs {
            systemd_run.arg(format!("--setenv={key}={value}"));
        }
        systemd_run
            .arg("/bin/sh")
            .arg("-c")
            .arg(trimmed)
            .stdin(Stdio::null());
        match systemd_run.status() {
            Ok(status) if status.success() => {
                launched_via_systemd = true;
                tracing::debug!(unit = %unit_name, "spawned Wayland client via systemd-run");
            }
            Ok(status) => {
                tracing::warn!(unit = %unit_name, code = status.code(), "systemd-run app spawn failed; falling back to direct spawn");
            }
            Err(error) => {
                tracing::warn!(%error, unit = %unit_name, "systemd-run unavailable for app spawn; falling back to direct spawn");
            }
        }

        if !launched_via_systemd {
            let mut cmd = std::process::Command::new("/bin/sh");
            cmd.arg("-c").arg(trimmed).stdin(Stdio::null());
            for (key, value) in &envs {
                cmd.env(key, value);
            }
            let child = cmd.spawn().map_err(|e| e.to_string())?;
            tracing::debug!(
                pid = child.id(),
                "spawned Wayland client via direct fallback"
            );
        }
        self.shell_spawn_focus_above_window_id =
            Some(self.window_registry.highest_allocated_window_id());
        Ok(())
    }
}

impl XWaylandShellHandler for CompositorState {
    fn xwayland_shell_state(&mut self) -> &mut XWaylandShellState {
        &mut self.xwayland_shell_state
    }

    fn surface_associated(&mut self, _xwm_id: XwmId, surface: WlSurface, window: X11Surface) {
        tracing::warn!(
            wl_surface_protocol_id = surface.id().protocol_id(),
            x11_geo = ?window.geometry(),
            x11_override_redirect = window.is_override_redirect(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 surface_associated"
        );
        if let Some(info) = self.ensure_x11_window_registered(&surface, &window) {
            if self.shell_pending_native_focus_window_id == Some(info.window_id) {
                self.shell_raise_and_focus_window(info.window_id);
            }
            let elem = DerpSpaceElem::X11(window.clone());
            if self.space.elements().any(|e| *e == elem) && !info.minimized {
                self.shell_emit_chrome_event(ChromeEvent::WindowMapped { info: info.clone() });
                self.shell_consider_focus_spawned_toplevel(info.window_id);
            }
        }
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

    fn new_window(&mut self, _xwm: XwmId, window: X11Surface) {
        tracing::warn!(
            x11_geo = ?window.geometry(),
            x11_override_redirect = window.is_override_redirect(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 new_window"
        );
    }

    fn new_override_redirect_window(&mut self, _xwm: XwmId, window: X11Surface) {
        tracing::warn!(
            x11_geo = ?window.geometry(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 new_override_redirect_window"
        );
    }

    fn map_window_request(&mut self, _xwm: XwmId, window: X11Surface) {
        tracing::warn!(
            x11_geo = ?window.geometry(),
            x11_override_redirect = window.is_override_redirect(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 map_window_request"
        );
        if window.is_override_redirect() {
            return;
        }
        if let Err(e) = window.set_mapped(true) {
            tracing::warn!(?e, "x11 map_window_request set_mapped");
            return;
        }
        let geo = self.x11_initial_map_rect(&window);
        if geo != window.geometry() {
            if let Err(error) = window.configure(Some(geo)) {
                tracing::warn!(?error, geometry = ?geo, "x11 map_window_request initial configure");
            }
        }
        let elem = DerpSpaceElem::X11(window.clone());
        let was_mapped = self.space.elements().any(|e| *e == elem);
        self.space.map_element(elem, (geo.loc.x, geo.loc.y), false);
        if let Some(surface) = window.wl_surface() {
            if let Some(info) = self.ensure_x11_window_registered(&surface, &window) {
                if !was_mapped && !info.minimized {
                    self.shell_emit_chrome_event(ChromeEvent::WindowMapped { info: info.clone() });
                    self.shell_consider_focus_spawned_toplevel(info.window_id);
                } else {
                    self.emit_x11_window_updates(&window, true, true);
                }
            }
        }
        self.loop_signal.wakeup();
    }

    fn mapped_override_redirect_window(&mut self, _xwm: XwmId, window: X11Surface) {
        tracing::warn!(
            x11_geo = ?window.geometry(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 mapped_override_redirect_window"
        );
        let geo = window.geometry();
        self.space.map_element(
            DerpSpaceElem::X11(window.clone()),
            (geo.loc.x, geo.loc.y),
            false,
        );
        self.loop_signal.wakeup();
    }

    fn unmapped_window(&mut self, _xwm: XwmId, window: X11Surface) {
        tracing::warn!(
            x11_geo = ?window.geometry(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 unmapped_window"
        );
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            if self.shell_minimized_x11_windows.contains_key(&window_id)
                && !self.shell_close_pending_native_windows.contains(&window_id)
            {
                self.space.unmap_elem(&DerpSpaceElem::X11(window.clone()));
                self.emit_x11_window_updates(&window, false, false);
                return;
            }
        }
        self.cleanup_x11_window(&window, true);
    }

    fn destroyed_window(&mut self, xwm: XwmId, window: X11Surface) {
        let _ = xwm;
        self.cleanup_x11_window(&window, true);
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
        tracing::warn!(
            request_x = x,
            request_y = y,
            request_w = w,
            request_h = h,
            x11_geo = ?window.geometry(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 configure_request"
        );
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
        } else {
            self.emit_x11_window_updates(&window, true, false);
        }
    }

    fn configure_notify(
        &mut self,
        _xwm: XwmId,
        window: X11Surface,
        geometry: Rectangle<i32, Logical>,
        _above: Option<X11Window>,
    ) {
        tracing::warn!(
            geometry = ?geometry,
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 configure_notify"
        );
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            if self.shell_pending_native_focus_window_id == Some(window_id)
                && window.wl_surface().is_some()
            {
                self.shell_raise_and_focus_window(window_id);
            }
        }
        let elem = DerpSpaceElem::X11(window.clone());
        if self.space.elements().any(|e| *e == elem) {
            self.space
                .map_element(elem, (geometry.loc.x, geometry.loc.y), false);
        }
        self.emit_x11_window_updates(&window, true, false);
    }

    fn property_notify(
        &mut self,
        _xwm: XwmId,
        window: X11Surface,
        property: smithay::xwayland::xwm::WmWindowProperty,
    ) {
        tracing::warn!(
            ?property,
            x11_window_id = window.window_id(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 property_notify"
        );
        let force_metadata_emit = matches!(
            property,
            smithay::xwayland::xwm::WmWindowProperty::Title
                | smithay::xwayland::xwm::WmWindowProperty::Class
                | smithay::xwayland::xwm::WmWindowProperty::MotifHints
                | smithay::xwayland::xwm::WmWindowProperty::Pid
        );
        self.emit_x11_window_updates(&window, false, force_metadata_emit);
    }

    fn maximize_request(&mut self, _xwm: XwmId, window: X11Surface) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            self.shell_set_window_maximized(window_id, true);
        }
    }

    fn unmaximize_request(&mut self, _xwm: XwmId, window: X11Surface) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            self.shell_set_window_maximized(window_id, false);
        }
    }

    fn fullscreen_request(&mut self, _xwm: XwmId, window: X11Surface) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            self.shell_set_window_fullscreen(window_id, true);
        }
    }

    fn unfullscreen_request(&mut self, _xwm: XwmId, window: X11Surface) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            self.shell_set_window_fullscreen(window_id, false);
        }
    }

    fn minimize_request(&mut self, _xwm: XwmId, window: X11Surface) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            self.shell_minimize_window(window_id);
        }
    }

    fn unminimize_request(&mut self, _xwm: XwmId, window: X11Surface) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            self.shell_restore_minimized_window(window_id);
        }
    }

    fn resize_request(&mut self, _xwm: XwmId, window: X11Surface, _button: u32, edges: ResizeEdge) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            let edges_wire = match edges {
                ResizeEdge::Top => crate::grabs::resize_grab::ResizeEdge::TOP,
                ResizeEdge::Bottom => crate::grabs::resize_grab::ResizeEdge::BOTTOM,
                ResizeEdge::Left => crate::grabs::resize_grab::ResizeEdge::LEFT,
                ResizeEdge::TopLeft => crate::grabs::resize_grab::ResizeEdge::TOP_LEFT,
                ResizeEdge::BottomLeft => crate::grabs::resize_grab::ResizeEdge::BOTTOM_LEFT,
                ResizeEdge::Right => crate::grabs::resize_grab::ResizeEdge::RIGHT,
                ResizeEdge::TopRight => crate::grabs::resize_grab::ResizeEdge::TOP_RIGHT,
                ResizeEdge::BottomRight => crate::grabs::resize_grab::ResizeEdge::BOTTOM_RIGHT,
            };
            self.shell_resize_begin(window_id, edges_wire.bits());
        }
    }

    fn move_request(&mut self, _xwm: XwmId, window: X11Surface, _button: u32) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            self.shell_move_begin(window_id);
        }
    }

    fn allow_selection_access(&mut self, xwm: XwmId, _selection: SelectionTarget) -> bool {
        self.seat
            .get_keyboard()
            .and_then(|keyboard| keyboard.current_focus())
            .and_then(|surface| self.x11_window_containing_surface(&surface))
            .is_some_and(|window| window.xwm_id() == Some(xwm))
    }

    fn send_selection(
        &mut self,
        _xwm: XwmId,
        selection: SelectionTarget,
        mime_type: String,
        fd: OwnedFd,
    ) {
        if selection != SelectionTarget::Clipboard {
            return;
        }
        if let Some(user_data) = current_data_device_selection_userdata(&self.seat) {
            if user_data.is_empty() || mime_type != "image/png" {
                return;
            }
            let mut file = std::fs::File::from(fd);
            if let Err(error) = file.write_all(user_data.as_slice()) {
                tracing::warn!(%error, "clipboard image write failed");
            }
            return;
        }
        if let Err(error) = request_data_device_client_selection(&self.seat, mime_type, fd) {
            tracing::warn!(
                ?error,
                "failed to request current wayland clipboard for xwayland"
            );
        }
    }

    fn new_selection(&mut self, _xwm: XwmId, selection: SelectionTarget, mime_types: Vec<String>) {
        if selection != SelectionTarget::Clipboard {
            return;
        }
        set_data_device_selection(
            &self.display_handle,
            &self.seat,
            mime_types,
            Arc::new(Vec::new()),
        );
    }

    fn cleared_selection(&mut self, _xwm: XwmId, selection: SelectionTarget) {
        if selection != SelectionTarget::Clipboard {
            return;
        }
        if current_data_device_selection_userdata(&self.seat).is_some() {
            clear_data_device_selection(&self.display_handle, &self.seat);
        }
    }

    fn disconnected(&mut self, _xwm: XwmId) {
        tracing::warn!("XWayland WM disconnected from X server");
        self.x11_wm_slot = None;
        self.x11_client = None;
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

    fn request_mode(
        &mut self,
        toplevel: ToplevelSurface,
        _mode: smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode,
    ) {
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
        let scale = if let Some(x11) = self.x11_window_containing_surface(&surface) {
            self.xwayland_scale_for_space_element(&DerpSpaceElem::X11(x11))
        } else {
            self.wayland_window_containing_surface(&surface)
                .map(|w| self.fractional_scale_for_space_element(&DerpSpaceElem::Wayland(w)))
                .unwrap_or_else(|| {
                    self.leftmost_output()
                        .map(|o| o.current_scale().fractional_scale())
                        .unwrap_or(1.0)
                })
        };
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

smithay::delegate_xdg_decoration!(crate::CompositorState);
smithay::delegate_fractional_scale!(crate::CompositorState);
smithay::delegate_viewporter!(crate::CompositorState);
smithay::delegate_cursor_shape!(crate::CompositorState);
smithay::delegate_xwayland_shell!(crate::CompositorState);
smithay::delegate_dmabuf!(crate::CompositorState);

#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}
    fn disconnected(&self, client_id: ClientId, _reason: DisconnectReason) {
        if let Ok(mut queue) = disconnected_wayland_clients().lock() {
            queue.push(client_id);
        }
    }
}

#[cfg(test)]
mod output_name_pick_tests {
    use super::{
        pick_output_name_for_global_window_center_first,
        pick_output_name_for_global_window_rect_from_output_rects, Logical, Point, Rectangle, Size,
    };

    fn rect(x: i32, y: i32, w: i32, h: i32) -> Rectangle<i32, Logical> {
        Rectangle::new(Point::from((x, y)), Size::from((w, h)))
    }

    #[test]
    fn center_first_follows_integer_center_half_open_rects() {
        let pairs = vec![
            ("HDMI-A-1".to_string(), rect(0, 0, 1920, 1080)),
            ("DP-1".to_string(), rect(1920, 0, 1920, 1080)),
        ];
        assert_eq!(
            pick_output_name_for_global_window_center_first(&pairs, 400, 0, 1600, 1080).unwrap(),
            "HDMI-A-1"
        );
        assert_eq!(
            pick_output_name_for_global_window_center_first(&pairs, 1400, 0, 1600, 1080).unwrap(),
            "DP-1"
        );
    }

    #[test]
    fn wide_window_bottom_band_picks_more_overlap() {
        let pairs = vec![
            ("HDMI-A-1".to_string(), rect(0, 0, 1920, 1080)),
            ("DP-1".to_string(), rect(1920, 0, 1920, 1080)),
        ];
        let got = pick_output_name_for_global_window_rect_from_output_rects(
            &pairs,
            200,
            680,
            3500,
            400,
        )
        .unwrap();
        assert_eq!(got, "DP-1");
    }

    #[test]
    fn single_output_unchanged() {
        let pairs = vec![("ONLY".to_string(), rect(0, 0, 800, 600))];
        let got =
            pick_output_name_for_global_window_rect_from_output_rects(&pairs, 10, 10, 400, 300)
                .unwrap();
        assert_eq!(got, "ONLY");
    }
}
