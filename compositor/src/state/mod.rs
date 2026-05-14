use std::{
    cell::RefCell,
    collections::{HashMap, HashSet, VecDeque},
    ffi::OsString,
    io::Write,
    os::fd::{AsRawFd, OwnedFd},
    os::unix::net::UnixStream,
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
    backend::drm::DrmDeviceFd,
    backend::egl::EGLDevice,
    backend::input::{KeyState, Keycode},
    backend::renderer::{
        element::solid::SolidColorBuffer,
        gles::{GlesRenderer, GlesTarget},
        utils::CommitCounter,
        Color32F, ImportDma, Renderer,
    },
    backend::{renderer::element::Id, session::libseat::LibSeatSession},
    desktop::{
        layer_map_for_output,
        space::{Space, SpaceElement},
        utils::{under_from_surface_tree, with_surfaces_surface_tree},
        LayerSurface as DesktopLayerSurface, PopupManager, Window, WindowSurfaceType,
    },
    input::{
        keyboard::{keysyms, KeysymHandle, Layout, ModifiersState, XkbConfig},
        pointer::MotionEvent,
        Seat, SeatState,
    },
    reexports::{
        calloop::{
            channel::{self, Event as CalloopChannelEvent},
            timer::{TimeoutAction, Timer},
            EventLoop, LoopHandle, LoopSignal, RegistrationToken,
        },
        wayland_protocols::xdg::{
            decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode as XdgDecoMode,
            shell::server::xdg_toplevel,
        },
        wayland_server::{
            backend::{ClientData, ClientId, DisconnectReason},
            protocol::{wl_data_source::WlDataSource, wl_output::WlOutput, wl_surface::WlSurface},
            Client, Display, DisplayHandle,
        },
    },
    utils::{Buffer, Logical, Point, Rectangle, Serial, Size, Transform, SERIAL_COUNTER},
    wayland::{
        compositor::{CompositorClientState, CompositorState as WlCompositorState},
        content_type::{ContentTypeState, ContentTypeSurfaceCachedState},
        cursor_shape::CursorShapeManagerState,
        dmabuf::{DmabufFeedbackBuilder, DmabufGlobal, DmabufHandler, DmabufState, ImportNotifier},
        drm_syncobj::{supports_syncobj_eventfd, DrmSyncobjHandler, DrmSyncobjState},
        fifo::FifoManagerState,
        foreign_toplevel_list::{ForeignToplevelHandle, ForeignToplevelListState},
        fractional_scale::{FractionalScaleHandler, FractionalScaleManagerState},
        idle_inhibit::IdleInhibitManagerState,
        input_method::{InputMethodManagerState, InputMethodSeat},
        keyboard_shortcuts_inhibit::KeyboardShortcutsInhibitState,
        output::OutputManagerState,
        presentation::{
            PresentationFeedbackCachedState, PresentationFeedbackCallback, PresentationState,
        },
        selection::{
            data_device::{
                clear_data_device_selection, current_data_device_selection_userdata,
                request_data_device_client_selection, set_data_device_selection, DataDeviceState,
            },
            primary_selection::{
                clear_primary_selection, current_primary_selection_userdata,
                request_primary_client_selection, set_primary_selection, PrimarySelectionState,
            },
            wlr_data_control::DataControlState,
            SelectionTarget,
        },
        shell::{
            kde::decoration::{KdeDecorationHandler, KdeDecorationState},
            wlr_layer::{Layer, WlrLayerShellState},
            xdg::{SurfaceCachedState, ToplevelSurface, XdgShellState, XdgToplevelSurfaceData},
        },
        shm::ShmState,
        text_input::{TextInputManagerState, TextInputSeat},
        viewporter::ViewporterState,
        xdg_activation::{XdgActivationState, XdgActivationTokenData},
        xdg_foreign::{XdgForeignHandler, XdgForeignState},
        xdg_toplevel_icon::XdgToplevelIconManager,
        xwayland_shell::{XWaylandShellHandler, XWaylandShellState},
    },
    xwayland::{
        xwm::{Reorder, ResizeEdge, WmWindowType, X11Window, XwmId},
        X11Surface, X11Wm, XwmHandler,
    },
};

use crate::tearing_control::{
    TearingControlState, TearingControlSurfaceCachedState, TearingPresentationHint,
};
use crate::{
    chrome_bridge::{ChromeEvent, NoOpChromeBridge, SharedChromeBridge, WindowInfo},
    derp_space::DerpSpaceElem,
    desktop::exclusion_clip,
    session::workspace_model::{
        group_id_for_window, next_active_window_after_removal, reconcile_workspace_state,
        WorkspaceCustomAutoSlot, WorkspaceMonitorLayoutState, WorkspaceMonitorLayoutType,
        WorkspaceMonitorTileEntry, WorkspaceMonitorTileState, WorkspaceMutation, WorkspaceRect,
        WorkspaceSlotRule, WorkspaceSlotRuleField, WorkspaceSlotRuleOp, WorkspaceState,
        WorkspaceTaskbarPin, WorkspaceTaskbarPinMonitor,
    },
    shell::shell_ipc,
    window_registry::{
        RestoreHandle, WindowBackend, WindowKind, WindowLifecycle, WindowLifecycleEvent,
        WindowRegistry,
    },
    CalloopData,
};
use smithay::input::pointer::CursorImageStatus;

#[derive(Default)]
pub(crate) struct KdeServerDecorationSurfaceData {
    mode: Mutex<
        Option<
            wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration::Mode,
        >,
    >,
}

#[derive(Default)]
pub(crate) struct XdgDecorationSurfaceData {
    resource: Mutex<
        Option<
            smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::ZxdgToplevelDecorationV1,
        >,
    >,
    mode: Mutex<Option<u32>>,
}

fn disconnected_wayland_clients() -> &'static Mutex<Vec<ClientId>> {
    static QUEUE: OnceLock<Mutex<Vec<ClientId>>> = OnceLock::new();
    QUEUE.get_or_init(|| Mutex::new(Vec::new()))
}

pub(crate) struct X11SyncResult {
    pub(crate) info: WindowInfo,
    pub(crate) metadata_changed: bool,
    pub(crate) geometry_changed: bool,
    pub(crate) state_changed: bool,
}

fn compositor_state_validation_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("DERP_VALIDATE_STATE").is_some())
}

fn rect_contains_rect(outer: Rectangle<i32, Logical>, inner: Rectangle<i32, Logical>) -> bool {
    if outer.size.w <= 0 || outer.size.h <= 0 || inner.size.w <= 0 || inner.size.h <= 0 {
        return false;
    }
    let outer_right = outer.loc.x.saturating_add(outer.size.w);
    let outer_bottom = outer.loc.y.saturating_add(outer.size.h);
    let inner_right = inner.loc.x.saturating_add(inner.size.w);
    let inner_bottom = inner.loc.y.saturating_add(inner.size.h);
    inner.loc.x >= outer.loc.x
        && inner.loc.y >= outer.loc.y
        && inner_right <= outer_right
        && inner_bottom <= outer_bottom
}

pub(crate) fn toplevel_should_defer_initial_map(
    parent: Option<&WlSurface>,
    title: &str,
    app_id: &str,
    is_embedded_shell_host: bool,
) -> bool {
    if is_embedded_shell_host || parent.is_some() {
        return false;
    }
    if window_title_is_screen_sharing_indicator(title) {
        return false;
    }
    app_id.trim().is_empty()
}

pub(crate) fn window_title_is_screen_sharing_indicator(title: &str) -> bool {
    let title = title.trim().to_ascii_lowercase();
    title.contains(" is sharing your screen")
        || title.contains(" is sharing a window")
        || title.contains(" is sharing your tab")
}

pub(crate) fn shell_window_row_should_show(info: &WindowInfo) -> bool {
    !window_title_is_screen_sharing_indicator(&info.title)
}

#[derive(Debug)]
pub(crate) struct PendingDeferredToplevel {
    pub window: Window,
    pub map_x: i32,
    pub map_y: i32,
    pub initial_client_rect: Option<Rectangle<i32, Logical>>,
}

#[derive(Debug, Clone)]
pub(crate) struct ScratchpadWindowState {
    pub scratchpad_id: String,
}

#[derive(Clone)]
pub(crate) struct PendingNativeConfigureFrame {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    output_name: String,
    maximized: bool,
    fullscreen: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SuperHotkeyAction {
    Builtin(String),
    Launch {
        command: String,
        desktop_id: String,
        app_name: String,
    },
    Scratchpad(String),
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

pub(crate) fn read_toplevel_client_side_decoration(wl: &WlSurface) -> bool {
    smithay::wayland::compositor::with_states(wl, |states| {
        if let Some(xdg_mode) = states
            .data_map
            .get::<XdgDecorationSurfaceData>()
            .and_then(|data| data.mode.lock().ok().and_then(|mode| *mode))
        {
            return xdg_mode != 2;
        }
        if let Some(kde_mode) = states
            .data_map
            .get::<KdeServerDecorationSurfaceData>()
            .and_then(|data| data.mode.lock().ok().and_then(|mode| *mode))
        {
            return kde_mode
                != wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration::Mode::Server;
        }
        let Some(data) = states.data_map.get::<XdgToplevelSurfaceData>() else {
            return false;
        };
        let Ok(data) = data.lock() else {
            return false;
        };
        !matches!(
            data.current_server_state().decoration_mode,
            Some(XdgDecoMode::ServerSide)
        )
    })
}

pub(crate) fn read_toplevel_shell_decoration_disabled(wl: &WlSurface) -> bool {
    smithay::wayland::compositor::with_states(wl, |states| {
        let kde_disabled = states
            .data_map
            .get::<KdeServerDecorationSurfaceData>()
            .and_then(|data| data.mode.lock().ok().and_then(|mode| *mode))
            == Some(
                wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration::Mode::None,
            );
        let xdg_disabled = states
            .data_map
            .get::<XdgDecorationSurfaceData>()
            .and_then(|data| data.mode.lock().ok().and_then(|mode| *mode))
            == Some(0);
        kde_disabled || xdg_disabled
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
}

impl Default for CompositorInitOptions {
    fn default() -> Self {
        Self {
            socket: SocketConfig::Auto,
            seat_name: "compositor".to_string(),
            chrome_bridge: Arc::new(NoOpChromeBridge),
            shell_to_cef: Arc::new(Mutex::new(None)),
            shell_cef_handshake: None,
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
    CaptureState::formats_for_linux_dmabuf_global(renderer)
}

pub(crate) fn normalize_capture_dmabuf_format(format: Format) -> Format {
    CaptureState::normalize_dmabuf_format(format)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ShellKeyboardCapture {
    None,
    ShellUi,
    ProgramsMenu { restore_window_id: Option<u32> },
    WindowSwitcher { restore_window_id: Option<u32> },
}

pub struct CompositorState {
    pub(crate) core: CoreState,
    pub(crate) output_topology: OutputTopologyState,

    pub compositor_state: WlCompositorState,
    pub(crate) _fifo_manager_state: FifoManagerState,
    pub(crate) _presentation_state: PresentationState,
    pub(crate) _content_type_state: ContentTypeState,
    pub(crate) _tearing_control_state: TearingControlState,
    pub xdg_shell_state: XdgShellState,
    pub xdg_activation_state: XdgActivationState,
    pub xdg_foreign_state: XdgForeignState,
    pub(crate) xdg_activation_token_max_age_override: Option<Duration>,
    pub kde_decoration_state: KdeDecorationState,
    pub(crate) _xdg_toplevel_icon_manager: XdgToplevelIconManager,
    pub fractional_scale_manager_state: FractionalScaleManagerState,
    pub viewporter_state: ViewporterState,
    pub cursor_shape_manager_state: CursorShapeManagerState,
    pub shm_state: ShmState,
    pub(crate) _text_input_manager_state: TextInputManagerState,
    pub(crate) _input_method_manager_state: InputMethodManagerState,
    pub layer_shell_state: WlrLayerShellState,
    pub(crate) _idle_inhibit_manager_state: IdleInhibitManagerState,
    pub popups: PopupManager,

    pub(crate) capture: CaptureState,
    pub(crate) tray_notifications: TrayNotificationsState,
    pub(crate) windows: WindowManagementState,
    pub(crate) explicit_sync: Mutex<ExplicitSyncState>,
    pub(crate) shell_osr: ShellOsrState,
    pub(crate) workspace_layout: WorkspaceLayoutState,
    pub(crate) input_routing: InputRoutingState,
    pub(crate) session_services: SessionServicesState,

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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ShellUiWindowPlacement {
    pub id: u32,
    pub z: u32,
    pub global_rect: Rectangle<i32, Logical>,
    pub buffer_rect: Rectangle<i32, Buffer>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct ShellVisiblePlacementsStamp {
    ui_generation: u32,
    window_registry_revision: u64,
    window_stack_revision: u64,
    output_topology_revision: u64,
    workspace_revision: u64,
}

#[derive(Clone)]
pub(crate) struct ShellVisiblePlacementsCache {
    stamp: ShellVisiblePlacementsStamp,
    all: Vec<ShellUiWindowPlacement>,
    frames: Vec<ShellUiWindowPlacement>,
}

pub(crate) struct ShellMoveProxyState {
    pub window_id: u32,
    pub source_client_rect: Rectangle<i32, Logical>,
    pub source_global_rect: Option<Rectangle<i32, Logical>>,
    pub texture_global_rect: Option<Rectangle<i32, Logical>>,
    pub source_buffer_rect: Option<Rectangle<i32, Buffer>>,
    pub arm_after_shell_commit: Option<CommitCounter>,
    pub request_opaque_source: bool,
    pub pending_capture: bool,
    pub texture: Option<smithay::backend::renderer::gles::GlesTexture>,
    pub texture_id: Id,
    pub commit: CommitCounter,
    pub release_state: Option<ShellMoveProxyReleaseState>,
}

pub(crate) struct NativeDragPreviewState {
    pub window_id: u32,
    pub generation: u32,
    pub capture_pending: bool,
    pub image_path: Option<String>,
    pub shell_ready: bool,
    pub output_name: String,
    pub logical_width: i32,
    pub logical_height: i32,
    pub buffer_width: i32,
    pub buffer_height: i32,
}

pub(crate) struct ShellMoveDeferredStartState {
    pub window_id: u32,
    pub wait_for_shell_commit: CommitCounter,
    pub wait_for_ui_generation: u32,
    pub pending_delta: (i32, i32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShellMoveProxyReleaseState {
    AwaitShellStateCommit(CommitCounter),
    AwaitVisibleShellCommit {
        commit: CommitCounter,
        ui_generation: u32,
    },
}

pub(crate) struct KeyboardLayoutFocusOp {
    save_from: Option<u32>,
    restore_for: Option<u32>,
    shell_host: bool,
}

impl CompositorState {
    #[allow(dead_code)]
    fn next_shell_output_topology_revision(&mut self) -> u64 {
        self.output_topology.next_shell_output_topology_revision()
    }

    fn next_shell_window_domain_revision(&mut self) -> u64 {
        self.windows.next_shell_window_domain_revision()
    }

    fn next_shell_workspace_revision(&mut self) -> u64 {
        self.workspace_layout.next_shell_workspace_revision()
    }

    fn next_shell_hosted_app_state_revision(&mut self) -> u64 {
        self.shell_osr.next_shell_hosted_app_state_revision()
    }

    fn next_shell_interaction_revision(&mut self) -> u64 {
        self.input_routing.next_shell_interaction_revision()
    }

    fn next_shell_snapshot_epoch(&mut self) -> u64 {
        self.shell_osr.next_shell_snapshot_epoch()
    }

    fn shell_send_mutation_ack(
        &mut self,
        domain: &str,
        client_mutation_id: Option<u64>,
        accepted: bool,
    ) {
        let Some(client_mutation_id) = client_mutation_id else {
            return;
        };
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::MutationAck {
            domain: domain.to_string(),
            client_mutation_id,
            status: if accepted {
                "accepted".to_string()
            } else {
                "rejected".to_string()
            },
            snapshot_epoch: self.shell_osr.shell_snapshot_epoch,
        });
    }

    pub fn stop_event_loop(&self) {
        self.core.stop_event_loop();
    }

    pub fn socket_name(&self) -> &OsString {
        self.core.socket_name()
    }

    pub fn cef_to_compositor_tx(
        &self,
    ) -> channel::Sender<crate::cef::compositor_tx::CefToCompositor> {
        self.shell_osr.cef_to_compositor_tx.clone()
    }

    pub fn loop_signal(&self) -> LoopSignal {
        self.core.loop_signal()
    }

    pub fn event_loop_stop_flag(&self) -> Arc<AtomicBool> {
        self.core.event_loop_stop_flag()
    }

    pub fn event_loop_should_stop(&self) -> bool {
        self.core.event_loop_should_stop()
    }

    pub fn new(
        event_loop: &mut EventLoop<CalloopData>,
        display: Display<Self>,
        options: CompositorInitOptions,
    ) -> Result<Self, String> {
        let start_time = std::time::Instant::now();

        let dh = display.handle();

        let compositor_state = WlCompositorState::new_v6::<Self>(&dh);
        let fifo_manager_state = FifoManagerState::new::<Self>(&dh);
        let presentation_state = PresentationState::new::<Self>(&dh, libc::CLOCK_MONOTONIC as u32);
        let content_type_state = ContentTypeState::new::<Self>(&dh);
        let tearing_control_state = TearingControlState::new::<Self>(&dh);
        let xdg_shell_state = XdgShellState::new::<Self>(&dh);
        let xdg_activation_state = XdgActivationState::new::<Self>(&dh);
        let xdg_foreign_state = XdgForeignState::new::<Self>(&dh);
        dh.create_global::<Self, wayland_protocols_misc::zwp_virtual_keyboard_v1::server::zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1, _>(1, ());
        dh.create_global::<Self, smithay::reexports::wayland_protocols::xdg::toplevel_drag::v1::server::xdg_toplevel_drag_manager_v1::XdgToplevelDragManagerV1, _>(1, ());
        dh.create_global::<Self, smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_decoration_manager_v1::ZxdgDecorationManagerV1, _>(1, ());
        let kde_decoration_state = KdeDecorationState::new::<Self>(
            &dh,
            wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration_manager::Mode::Server,
        );
        let mut xdg_toplevel_icon_manager = XdgToplevelIconManager::new::<Self>(&dh);
        xdg_toplevel_icon_manager.add_icon_size(16);
        xdg_toplevel_icon_manager.add_icon_size(32);
        xdg_toplevel_icon_manager.add_icon_size(64);
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
        smithay::wayland::relative_pointer::RelativePointerManagerState::new::<Self>(&dh);
        smithay::wayland::pointer_gestures::PointerGesturesState::new::<Self>(&dh);
        smithay::wayland::pointer_constraints::PointerConstraintsState::new::<Self>(&dh);
        let screencopy_manager_state =
            crate::render::capture::ScreencopyManagerState::new::<Self>(&dh);
        let ext_image_capture_manager_state =
            crate::render::capture_ext::ExtImageCaptureManagerState::new::<Self>(&dh);
        let mut seat_state = SeatState::new();
        let data_device_state = DataDeviceState::new::<Self>(&dh);
        let primary_selection_state = PrimarySelectionState::new::<Self>(&dh);
        let data_control_state =
            DataControlState::new::<Self, _>(&dh, Some(&primary_selection_state), |_| true);
        let text_input_manager_state = TextInputManagerState::new::<Self>(&dh);
        let input_method_manager_state = InputMethodManagerState::new::<Self, _>(&dh, |_| true);
        let xwayland_shell_state = XWaylandShellState::new::<Self>(&dh);
        let chrome_bridge = options.chrome_bridge;
        let shell_to_cef = options.shell_to_cef;
        let shell_cef_handshake = options.shell_cef_handshake;
        let popups = PopupManager::default();
        let window_registry = WindowRegistry::new();
        let wallpaper_loader = crate::desktop::desktop_background::spawn_wallpaper_loader_thread();
        let cursor_theme = crate::platform::cursor_fallback::CursorThemeManager::new(
            crate::session::settings_config::read_cursor_settings(),
        );

        let mut seat: Seat<Self> = seat_state.new_wl_seat(&dh, &options.seat_name);
        seat.add_keyboard(Default::default(), 200, 25)
            .map_err(|e| format!("seat add keyboard: {e:?}"))?;
        seat.add_pointer();
        seat.add_touch();

        let space = Space::default();

        let socket_name = crate::platform::wayland_listener::init_wayland_listener(
            display,
            event_loop,
            &options.socket,
        )?;

        let loop_signal = event_loop.get_signal();
        let loop_handle: LoopHandle<'static, CalloopData> =
            unsafe { std::mem::transmute(event_loop.handle().clone()) };
        let event_loop_stop = Arc::new(AtomicBool::new(false));

        let (cef_to_compositor_tx, cef_rx) = channel::channel();
        event_loop
            .handle()
            .insert_source(cef_rx, |ev, _, d: &mut CalloopData| match ev {
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
                CalloopChannelEvent::Msg(
                    crate::cef::compositor_tx::CefToCompositor::SoftwareFrameReady(latest_frame),
                ) => loop {
                    let Some(frame) = latest_frame.take() else {
                        if latest_frame.finish_dispatch() {
                            continue;
                        }
                        break;
                    };
                    d.state.accept_shell_software_frame_from_cef(
                        frame.width,
                        frame.height,
                        frame.generation,
                        frame.pixels,
                        frame.dirty_buffer,
                    );
                    if let Some(drms) = d.drm.as_mut() {
                        drms.request_render();
                    }
                    if !latest_frame.finish_dispatch() {
                        break;
                    }
                },
                CalloopChannelEvent::Msg(
                    crate::cef::compositor_tx::CefToCompositor::SetOutputVrr { name, enabled },
                ) => {
                    if let Some(drms) = d.drm.as_mut() {
                        drms.set_output_vrr(&mut d.state, name, enabled);
                    }
                }
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

        let notifications_enabled =
            crate::session::settings_config::read_notifications_settings().enabled;
        let (notifications_to_loop_tx, notifications_rx) =
            channel::channel::<crate::notifications::NotificationsLoopMsg>();
        let (notifications_cmd_tx, notifications_cmd_rx) =
            std::sync::mpsc::channel::<crate::notifications::NotificationsCmd>();
        crate::notifications::spawn_notifications_thread(
            notifications_to_loop_tx,
            notifications_cmd_rx,
            notifications_enabled,
        );
        event_loop
            .handle()
            .insert_source(notifications_rx, |ev, _, d: &mut CalloopData| match ev {
                CalloopChannelEvent::Msg(msg) => match msg {
                    crate::notifications::NotificationsLoopMsg::State(state_json) => {
                        d.state.on_notifications_state_updated(state_json);
                    }
                    crate::notifications::NotificationsLoopMsg::Event(event) => {
                        d.state.on_notification_event(event);
                    }
                },
                CalloopChannelEvent::Closed => {}
            })
            .map_err(|e| format!("notifications channel: {e}"))?;

        let mut s = Self {
            core: CoreState {
                start_time,
                display_handle: dh,
                loop_signal,
                loop_handle,
                event_loop_stop,
                socket_name,
            },
            output_topology: OutputTopologyState {
                space,
                output_manager_state,
                shell_primary_output_name: None,
                taskbar_auto_hide: false,
                taskbar_side_by_output_name: HashMap::new(),
                output_vrr_by_name: HashMap::new(),
                output_flip_state_by_name: HashMap::new(),
                display_config_save_pending: false,
                display_config_save_suppressed: false,
                shell_output_topology_revision: 0,
                shell_canvas_logical_origin: (0, 0),
                shell_canvas_logical_size: (1, 1),
                shell_ui_scale: 1.5,
            },
            compositor_state,
            _fifo_manager_state: fifo_manager_state,
            _presentation_state: presentation_state,
            _content_type_state: content_type_state,
            _tearing_control_state: tearing_control_state,
            xdg_shell_state,
            xdg_activation_state,
            xdg_foreign_state,
            xdg_activation_token_max_age_override: None,
            kde_decoration_state,
            _xdg_toplevel_icon_manager: xdg_toplevel_icon_manager,
            fractional_scale_manager_state,
            viewporter_state,
            cursor_shape_manager_state,
            shm_state,
            _text_input_manager_state: text_input_manager_state,
            _input_method_manager_state: input_method_manager_state,
            layer_shell_state,
            _idle_inhibit_manager_state: idle_inhibit_manager_state,
            popups,
            capture: CaptureState::new(
                dmabuf_state,
                foreign_toplevel_list_state,
                screencopy_manager_state,
                ext_image_capture_manager_state,
            ),
            tray_notifications: TrayNotificationsState::new(
                sni_cmd_tx,
                notifications_cmd_tx,
                notifications_enabled,
            ),
            windows: WindowManagementState {
                chrome_bridge,
                window_registry,
                pending_deferred_toplevels: HashMap::new(),
                pending_gnome_initial_toplevels: HashSet::new(),
                wayland_commit_needs_render: false,
                xwayland_shell_state,
                x11_wm_slot: None,
                x11_client: None,
                shell_spawn_known_native_window_ids: None,
                shell_spawn_target_output_name: None,
                shell_pending_native_configure_frames: HashMap::new(),
                shell_known_x11_windows: HashMap::new(),
                shell_pending_native_focus_window_id: None,
                shell_close_pending_native_windows: HashSet::new(),
                shell_close_refocus_targets: HashMap::new(),
                toplevel_floating_restore: HashMap::new(),
                toplevel_fullscreen_return_maximized: HashSet::new(),
                shell_window_stack_order: Vec::new(),
                shell_window_stack_revision: 0,
                shell_window_domain_revision: 0,
                control_windows_revision: 0,
                shell_window_switcher_selected_window_id: None,
            },
            explicit_sync: Mutex::new(ExplicitSyncState::default()),
            shell_osr: ShellOsrState {
                shell_to_cef,
                cef_to_compositor_tx,
                shell_cef_handshake,
                shell_ipc_peer_pid: None,
                shell_embedded_initial_handshake_done: false,
                shell_ipc_runtime_dir: std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from),
                shell_window_physical_px: (1, 1),
                shell_has_frame: false,
                shell_view_px: None,
                shell_frame_is_dmabuf: false,
                shell_dmabuf: None,
                shell_software_frame: None,
                shell_software_generation: 0,
                shell_dmabuf_generation: 0,
                shell_dmabuf_overlay_id: Id::new(),
                shell_dmabuf_commit: CommitCounter::default(),
                shell_dmabuf_dirty_buffer: Vec::new(),
                shell_dmabuf_dirty_force_full: true,
                shell_dmabuf_next_force_full: false,
                shell_presentation_fullscreen: false,
                shell_exclusion_global: Vec::new(),
                shell_exclusion_floating: Vec::new(),
                shell_exclusion_overlay_open: false,
                shell_exclusion_zones_need_full_damage: false,
                shell_ui_windows: Vec::new(),
                shell_ui_windows_generation: 0,
                shell_ui_windows_shared_sequence: 0,
                shell_ui_windows_shared_path: crate::cef::shared_state::path_for_kind(
                    crate::cef::runtime_dir(),
                    crate::cef::shared_state::SHELL_SHARED_STATE_KIND_UI_WINDOWS,
                ),
                shell_focused_ui_window_id: None,
                shell_snapshot_epoch: 0,
                shell_last_sent_ui_focus_id: None,
                shell_last_sent_focus_pair: None,
                shell_last_sent_window_order: Vec::new(),
                shell_visible_placements_cache: RefCell::new(None),
                shell_exclusion_shared_sequence: 0,
                shell_exclusion_shared_path: crate::cef::shared_state::path_for_kind(
                    crate::cef::runtime_dir(),
                    crate::cef::shared_state::SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES,
                ),
                shell_chrome_titlebar_h: SHELL_TITLEBAR_HEIGHT,
                shell_chrome_border_w: SHELL_BORDER_THICKNESS,
                shell_hosted_app_state: HashMap::new(),
                shell_hosted_app_state_revision: 0,
            },
            workspace_layout: WorkspaceLayoutState::new(),
            input_routing: InputRoutingState::new(
                seat_state,
                seat,
                data_device_state,
                primary_selection_state,
                data_control_state,
                keyboard_shortcuts_inhibit_state,
                cursor_theme,
            ),
            session_services: SessionServicesState::new(),
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
        };
        crate::controls::display_config::apply_keyboard_from_display_file(&mut s);
        let keyboard_settings = crate::session::settings_config::read_keyboard_settings();
        if !keyboard_settings.layouts.is_empty() {
            let _ = s.keyboard_apply_settings(&keyboard_settings);
        }
        crate::desktop::desktop_background::load_from_display_file_into(&mut s);
        let session_default_layout_index = s.keyboard_layout_index_current();
        s.workspace_layout
            .set_session_default_layout_index(session_default_layout_index);
        s.hydrate_shell_hosted_app_state_from_session();
        Ok(s)
    }

    fn super_keybind_target_window_id(&self) -> Option<u32> {
        if let Some(wid) = self.logical_focused_window_id() {
            if let Some(info) = self.windows.window_registry.window_info(wid) {
                if !self.window_info_is_solid_shell_host(&info) {
                    return Some(wid);
                }
            }
        }
        if let Some(wid) = self.keyboard_focused_window_id() {
            if let Some(info) = self.windows.window_registry.window_info(wid) {
                if !self.window_info_is_solid_shell_host(&info) {
                    return Some(wid);
                }
            }
        }
        self.topmost_native_window_from_stack()
    }

    pub(crate) fn handle_pending_wayland_client_disconnects(&mut self) {
        let pending = disconnected_wayland_clients()
            .lock()
            .map(|mut queue| std::mem::take(&mut *queue))
            .unwrap_or_default();
        for client_id in pending {
            self.cleanup_disconnected_wayland_client(client_id);
        }
        self.cleanup_dead_native_client_processes();
    }

    pub(crate) fn cleanup_dead_native_client_processes(&mut self) {
        let infos: Vec<_> = self
            .windows
            .window_registry
            .all_records()
            .into_iter()
            .filter(|record| {
                record.kind == WindowKind::Native
                    && record.backend == WindowBackend::WaylandXdg
                    && record.info.wayland_client_pid.is_some_and(|pid| {
                        pid > 0 && std::fs::metadata(format!("/proc/{pid}")).is_err()
                    })
            })
            .map(|record| record.info)
            .collect();
        for info in infos {
            self.cleanup_dead_native_window(info);
        }
    }

    fn cleanup_dead_native_window(&mut self, info: WindowInfo) {
        if let Some(window) = self.find_window_by_surface_id(info.surface_id) {
            self.output_topology
                .space
                .unmap_elem(&DerpSpaceElem::Wayland(window));
        }
        if let Some(key) = self
            .windows
            .window_registry
            .surface_key_for_window(info.window_id)
        {
            self.windows.pending_deferred_toplevels.remove(&key);
        }
        self.clear_toplevel_layout_maps(info.window_id);
        self.windows
            .pending_gnome_initial_toplevels
            .remove(&info.window_id);
        self.windows
            .shell_close_pending_native_windows
            .remove(&info.window_id);
        self.shell_window_stack_forget(info.window_id);
        self.windows.shell_known_x11_windows.remove(&info.window_id);
        self.tray_notifications
            .shell_tray_hidden_x11_windows
            .remove(&info.window_id);
        self.forget_tray_hidden_x11_window_id(info.window_id);
        self.capture_forget_window_source_cache(info.window_id);
        if self.windows.shell_pending_native_focus_window_id == Some(info.window_id) {
            self.windows.shell_pending_native_focus_window_id = None;
        }
        self.clear_pointer_focus_for_window(info.window_id);
        let keyboard_had_focus = self.keyboard_focused_window_id() == Some(info.window_id);
        if let Some(removed) = self
            .windows
            .window_registry
            .remove_by_window_id(info.window_id)
        {
            self.shell_emit_chrome_window_unmapped(removed.window_id, Some(removed));
            self.try_refocus_after_closed_window(info.window_id, keyboard_had_focus);
        }
    }

    fn clear_pointer_focus_for_window(&mut self, window_id: u32) {
        let Some(pointer) = self.input_routing.seat.get_pointer() else {
            return;
        };
        if !pointer.current_focus().is_some_and(|surface| {
            self.windows
                .window_registry
                .window_id_for_wl_surface(&surface)
                == Some(window_id)
        }) {
            return;
        }
        let location = pointer.current_location();
        pointer.motion(
            self,
            None,
            &MotionEvent {
                location,
                serial: SERIAL_COUNTER.next_serial(),
                time: 0,
            },
        );
    }

    fn cleanup_disconnected_wayland_client(&mut self, client_id: ClientId) {
        let infos = self
            .windows
            .window_registry
            .native_infos_for_client(&client_id);
        let doomed_surface_keys: HashSet<_> = self
            .windows
            .window_registry
            .native_surface_keys_for_client(&client_id)
            .into_iter()
            .collect();
        if infos.is_empty() {
            self.windows
                .pending_deferred_toplevels
                .retain(|(cid, _), _| cid != &client_id);
            self.input_routing
                .idle_inhibit_surfaces
                .retain(|(cid, _)| cid != &client_id);
            return;
        }
        let focused_removed = infos
            .iter()
            .any(|info| self.keyboard_focused_window_id() == Some(info.window_id));
        for info in &infos {
            self.clear_pointer_focus_for_window(info.window_id);
            self.cancel_shell_move_resize_for_window(info.window_id);
        }
        let doomed_windows: Vec<_> = self
            .output_topology
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
            self.output_topology
                .space
                .unmap_elem(&DerpSpaceElem::Wayland(window));
        }
        for info in &infos {
            if let Some(window) = self.find_window_by_surface_id(info.surface_id) {
                self.output_topology
                    .space
                    .unmap_elem(&DerpSpaceElem::Wayland(window));
            }
            self.clear_toplevel_layout_maps(info.window_id);
            self.windows
                .pending_gnome_initial_toplevels
                .remove(&info.window_id);
            self.windows
                .shell_close_pending_native_windows
                .remove(&info.window_id);
            self.shell_window_stack_forget(info.window_id);
            self.windows.shell_known_x11_windows.remove(&info.window_id);
            self.tray_notifications
                .shell_tray_hidden_x11_windows
                .remove(&info.window_id);
            self.forget_tray_hidden_x11_window_id(info.window_id);
        }
        self.windows
            .pending_deferred_toplevels
            .retain(|(cid, _), _| cid != &client_id);
        self.input_routing
            .idle_inhibit_surfaces
            .retain(|(cid, _)| cid != &client_id);
        let removed = self.windows.window_registry.remove_by_client_id(&client_id);
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
        self.input_routing.programs_menu_mark_super_chord();
        match action {
            "close_focused" => {
                if let Some(wid) = self.logical_focused_window_id() {
                    if self.windows.window_registry.is_shell_hosted(wid) {
                        self.shell_send_keybind("close_focused");
                    } else if self
                        .windows
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
                        .windows
                        .window_registry
                        .window_info(wid)
                        .is_some_and(|info| info.fullscreen);
                    self.shell_set_window_fullscreen(wid, !fs);
                }
            }
            "toggle_maximize" => {
                if let Some(wid) = self.super_keybind_target_window_id() {
                    let maximized = self
                        .windows
                        .window_registry
                        .window_info(wid)
                        .is_some_and(|info| info.maximized);
                    self.shell_set_window_maximized(wid, !maximized);
                }
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
            action if action.starts_with("toggle_scratchpad:") => {
                let id = action.trim_start_matches("toggle_scratchpad:");
                self.toggle_scratchpad(id);
            }
            "tile_left" | "tile_right" => {
                if let Some(wid) = self.super_keybind_target_window_id() {
                    if let Err(error) = self.super_tile_window_half(wid, action == "tile_right") {
                        tracing::warn!(%error, action, window_id = wid, "super tile failed");
                    }
                }
            }
            "tile_up" => {
                if let Some(wid) = self.super_keybind_target_window_id() {
                    let maximized = self
                        .windows
                        .window_registry
                        .window_info(wid)
                        .is_some_and(|info| info.maximized);
                    self.shell_set_window_maximized(wid, !maximized);
                }
            }
            "tile_down" => {
                if let Some(wid) = self.super_keybind_target_window_id() {
                    if let Err(error) = self.super_tile_down(wid) {
                        tracing::warn!(%error, action, window_id = wid, "super tile down failed");
                    }
                }
            }
            "move_monitor_left" | "move_monitor_right" => {
                if let Some(wid) = self.super_keybind_target_window_id() {
                    if let Err(error) = self
                        .super_move_window_to_adjacent_monitor(wid, action == "move_monitor_right")
                    {
                        tracing::warn!(%error, action, window_id = wid, "super move monitor failed");
                    }
                }
            }
            "launch_terminal" => {
                if let Err(error) = self.try_spawn_wayland_client_sh("foot") {
                    tracing::warn!(%error, "launch terminal hotkey failed");
                }
            }
            "open_settings" | "tab_next" | "tab_previous" => self.shell_send_keybind(action),
            "cycle_keyboard_layout" => self.keyboard_cycle_layout_for_shortcut(),
            _ => {}
        }
    }

    pub(crate) fn handle_super_hotkey_action(&mut self, action: SuperHotkeyAction) {
        match action {
            SuperHotkeyAction::Builtin(action) => self.handle_super_keybind(&action),
            SuperHotkeyAction::Launch {
                command,
                desktop_id: _,
                app_name: _,
            } => {
                self.input_routing.programs_menu_mark_super_chord();
                if let Err(error) = self.try_spawn_wayland_client_sh(&command) {
                    tracing::warn!(%error, command = %command, "hotkey launch failed");
                }
            }
            SuperHotkeyAction::Scratchpad(id) => {
                self.input_routing.programs_menu_mark_super_chord();
                self.toggle_scratchpad(&id);
            }
        }
    }

    pub(crate) fn apply_shell_window_intent_json(&mut self, json: &str) {
        #[derive(serde::Deserialize)]
        struct WindowIntent {
            #[serde(rename = "clientMutationId")]
            client_mutation_id: Option<u64>,
            action: String,
            #[serde(rename = "windowId")]
            window_id: u32,
        }
        let Ok(intent) = serde_json::from_str::<WindowIntent>(json) else {
            tracing::warn!(target: "derp_window_intent", %json, "window intent parse failed");
            return;
        };
        let accepted = match intent.action.as_str() {
            "toggle_fullscreen" => {
                let fullscreen = self
                    .windows
                    .window_registry
                    .window_info(intent.window_id)
                    .is_some_and(|info| info.fullscreen);
                self.shell_set_window_fullscreen(intent.window_id, !fullscreen);
                true
            }
            "toggle_maximize" | "tile_up" => {
                let maximized = self
                    .windows
                    .window_registry
                    .window_info(intent.window_id)
                    .is_some_and(|info| info.maximized);
                self.shell_set_window_maximized(intent.window_id, !maximized);
                true
            }
            "tile_left" | "tile_right" => {
                if let Err(error) =
                    self.super_tile_window_half(intent.window_id, intent.action == "tile_right")
                {
                    tracing::warn!(%error, action = %intent.action, window_id = intent.window_id, "window intent tile failed");
                    false
                } else {
                    true
                }
            }
            "tile_down" => {
                if let Err(error) = self.super_tile_down(intent.window_id) {
                    tracing::warn!(%error, action = %intent.action, window_id = intent.window_id, "window intent tile down failed");
                    false
                } else {
                    true
                }
            }
            "move_monitor_left" | "move_monitor_right" => {
                if let Err(error) = self.super_move_window_to_adjacent_monitor(
                    intent.window_id,
                    intent.action == "move_monitor_right",
                ) {
                    tracing::warn!(%error, action = %intent.action, window_id = intent.window_id, "window intent move monitor failed");
                    false
                } else {
                    true
                }
            }
            "close_group" => self.shell_close_group_window(intent.window_id),
            _ => false,
        };
        self.shell_send_mutation_ack("window_intent", intent.client_mutation_id, accepted);
    }

    pub fn init_linux_dmabuf_global(
        &mut self,
        renderer: &GlesRenderer,
        formats: impl IntoIterator<Item = Format>,
    ) {
        self.capture
            .init_linux_dmabuf_global(renderer, &self.core.display_handle, formats);
    }

    pub fn init_drm_syncobj_global(&mut self, import_device: DrmDeviceFd) -> bool {
        self.capture
            .init_drm_syncobj_global(&self.core.display_handle, import_device)
    }

    /// DRM session handle for **Ctrl+Alt+F1–F12** VT switching ([`crate::input`]).
    pub fn set_vt_session(&mut self, session: Option<LibSeatSession>) {
        self.session_services.set_vt_session(session);
    }

    pub(crate) fn fractional_scale_for_space_element(&self, elem: &DerpSpaceElem) -> f64 {
        let fallback = || {
            self.output_topology
                .space
                .outputs()
                .map(|o| o.current_scale().fractional_scale())
                .fold(1.0f64, f64::max)
        };
        let Some(bbox) = self.output_topology.space.element_bbox(elem) else {
            return fallback();
        };
        if bbox.size.w == 0 || bbox.size.h == 0 {
            return fallback();
        }
        let mut best = 1.0f64;
        let mut hit = false;
        for o in self.output_topology.space.outputs() {
            let Some(geo) = self.output_topology.space.output_geometry(o) else {
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
        self.windows
            .wayland_window_containing_surface(&self.output_topology.space, surface)
    }

    pub(crate) fn x11_window_containing_surface(&self, surface: &WlSurface) -> Option<X11Surface> {
        self.windows
            .x11_window_containing_surface(&self.output_topology.space, surface)
    }

    pub(crate) fn content_type_label_for_surface(&self, surface: &WlSurface) -> String {
        smithay::wayland::compositor::with_states(surface, |states| {
            let mut guard = states.cached_state.get::<ContentTypeSurfaceCachedState>();
            format!("{:?}", guard.current().content_type()).to_ascii_lowercase()
        })
    }

    pub(crate) fn tearing_hint_for_surface(&self, surface: &WlSurface) -> TearingPresentationHint {
        smithay::wayland::compositor::with_states(surface, |states| {
            states
                .cached_state
                .get::<TearingControlSurfaceCachedState>()
                .current()
                .hint()
        })
    }

    pub(crate) fn wl_surface_for_window_id(&self, window_id: u32) -> Option<WlSurface> {
        let sid = self
            .windows
            .window_registry
            .surface_id_for_window(window_id)?;
        if let Some(window) = self.find_window_by_surface_id(sid) {
            return window
                .toplevel()
                .map(|toplevel| toplevel.wl_surface().clone());
        }
        self.find_x11_window_by_surface_id(sid)
            .and_then(|x11| x11.wl_surface())
    }

    pub(crate) fn content_type_label_for_window_id(&self, window_id: u32) -> String {
        self.wl_surface_for_window_id(window_id)
            .map(|surface| self.content_type_label_for_surface(&surface))
            .unwrap_or_else(|| "none".to_string())
    }

    pub(crate) fn tearing_hint_for_window_id(&self, window_id: u32) -> TearingPresentationHint {
        self.wl_surface_for_window_id(window_id)
            .map(|surface| self.tearing_hint_for_surface(&surface))
            .unwrap_or(TearingPresentationHint::Vsync)
    }

    pub(crate) fn tearing_hint_label_for_window_id(&self, window_id: u32) -> String {
        self.tearing_hint_for_window_id(window_id)
            .label()
            .to_string()
    }

    pub(crate) fn drain_presentation_feedback_for_output(
        &mut self,
        output: &Output,
    ) -> Vec<PresentationFeedbackCallback> {
        let mut callbacks = Vec::new();
        let mut seen = HashSet::new();
        for elem in self.output_topology.space.elements_for_output(output) {
            match elem {
                DerpSpaceElem::Wayland(window) => {
                    if let Some(toplevel) = window.toplevel() {
                        with_surfaces_surface_tree(toplevel.wl_surface(), |surface, states| {
                            let key = surface
                                .client()
                                .map(|client| (client.id(), surface.id().protocol_id()));
                            if key.is_none_or(|key| seen.insert(key)) {
                                callbacks.extend(std::mem::take(
                                    &mut states
                                        .cached_state
                                        .get::<PresentationFeedbackCachedState>()
                                        .current()
                                        .callbacks,
                                ));
                            }
                        });
                    }
                }
                DerpSpaceElem::X11(x11) => {
                    if let Some(surface) = x11.wl_surface() {
                        with_surfaces_surface_tree(&surface, |surface, states| {
                            let key = surface
                                .client()
                                .map(|client| (client.id(), surface.id().protocol_id()));
                            if key.is_none_or(|key| seen.insert(key)) {
                                callbacks.extend(std::mem::take(
                                    &mut states
                                        .cached_state
                                        .get::<PresentationFeedbackCachedState>()
                                        .current()
                                        .callbacks,
                                ));
                            }
                        });
                    }
                }
            }
        }
        callbacks
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

    pub(crate) fn signal_fifo_barriers_for_output(&mut self, output: &Output) {
        let mut clients: HashMap<ClientId, Client> = HashMap::new();

        for elem in self.output_topology.space.elements_for_output(output) {
            match elem {
                DerpSpaceElem::Wayland(window) => {
                    window.with_surfaces(|surface, states| {
                        let barrier = states
                            .cached_state
                            .get::<smithay::wayland::fifo::FifoBarrierCachedState>()
                            .current()
                            .barrier
                            .take();
                        if let Some(barrier) = barrier {
                            barrier.signal();
                            if let Some(client) = surface.client() {
                                clients.insert(client.id(), client);
                            }
                        }
                    });
                }
                DerpSpaceElem::X11(x11) => {
                    if let Some(surface) = x11.wl_surface() {
                        with_surfaces_surface_tree(&surface, |surface, states| {
                            let barrier = states
                                .cached_state
                                .get::<smithay::wayland::fifo::FifoBarrierCachedState>()
                                .current()
                                .barrier
                                .take();
                            if let Some(barrier) = barrier {
                                barrier.signal();
                                if let Some(client) = surface.client() {
                                    clients.insert(client.id(), client);
                                }
                            }
                        });
                    }
                }
            }
        }

        let layer_map = layer_map_for_output(output);
        for layer_surface in layer_map.layers() {
            layer_surface.with_surfaces(|surface, states| {
                let barrier = states
                    .cached_state
                    .get::<smithay::wayland::fifo::FifoBarrierCachedState>()
                    .current()
                    .barrier
                    .take();
                if let Some(barrier) = barrier {
                    barrier.signal();
                    if let Some(client) = surface.client() {
                        clients.insert(client.id(), client);
                    }
                }
            });
        }
        drop(layer_map);

        if let CursorImageStatus::Surface(surface) = &self.input_routing.pointer_cursor_image {
            with_surfaces_surface_tree(surface, |surface, states| {
                let barrier = states
                    .cached_state
                    .get::<smithay::wayland::fifo::FifoBarrierCachedState>()
                    .current()
                    .barrier
                    .take();
                if let Some(barrier) = barrier {
                    barrier.signal();
                    if let Some(client) = surface.client() {
                        clients.insert(client.id(), client);
                    }
                }
            });
        }

        let dh = self.core.display_handle.clone();
        for client in clients.into_values() {
            <Self as smithay::wayland::compositor::CompositorHandler>::client_compositor_state(
                self, &client,
            )
            .blocker_cleared(self, &dh);
        }
    }

    pub(crate) fn apply_xwayland_client_scale(&self) {
        let Some(client) = self.windows.x11_client.as_ref() else {
            return;
        };
        let scale = Self::xwayland_client_scale_for_shell_ui(self.output_topology.shell_ui_scale);
        <Self as smithay::wayland::compositor::CompositorHandler>::client_compositor_state(
            self, client,
        )
        .set_client_scale(scale);
    }

    pub fn surface_under(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(WlSurface, Point<f64, Logical>)> {
        self.surface_under_except_window(pos, None)
    }

    pub(crate) fn upper_layer_surface_under(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(WlSurface, Point<f64, Logical>)> {
        self.layer_surface_under(pos, &[Layer::Overlay, Layer::Top])
    }

    pub(crate) fn surface_under_except_window(
        &self,
        pos: Point<f64, Logical>,
        skip_window_id: Option<u32>,
    ) -> Option<(WlSurface, Point<f64, Logical>)> {
        if let Some(hit) = self.layer_surface_under(pos, &[Layer::Overlay, Layer::Top]) {
            return Some(hit);
        }
        for elem in self.space_elements_top_to_bottom() {
            if skip_window_id.is_some() && self.derp_elem_window_id(&elem) == skip_window_id {
                continue;
            }
            let Some(map_loc) = self.output_topology.space.element_location(&elem) else {
                continue;
            };
            let render_loc = map_loc - elem.geometry().loc;
            let local = pos - render_loc.to_f64();
            let hit = match &elem {
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
            if self.native_hit_blocked_by_shell_exclusion(&elem, pos) {
                continue;
            }
            return Some((surf, p_global));
        }
        self.layer_surface_under(pos, &[Layer::Bottom, Layer::Background])
    }

    pub(crate) fn surface_under_except_window_or_toplevel_bounds(
        &self,
        pos: Point<f64, Logical>,
        skip_window_id: Option<u32>,
    ) -> Option<(WlSurface, Point<f64, Logical>)> {
        if let Some(hit) = self.layer_surface_under(pos, &[Layer::Overlay, Layer::Top]) {
            return Some(hit);
        }
        for elem in self.space_elements_top_to_bottom() {
            if skip_window_id.is_some() && self.derp_elem_window_id(&elem) == skip_window_id {
                continue;
            }
            let Some(map_loc) = self.output_topology.space.element_location(&elem) else {
                continue;
            };
            let geometry = elem.geometry();
            let render_loc = map_loc - geometry.loc;
            let local = pos - render_loc.to_f64();
            let hit = match &elem {
                DerpSpaceElem::Wayland(window) => window
                    .surface_under(local, WindowSurfaceType::ALL)
                    .map(|(s, p)| (s, (p + render_loc).to_f64()))
                    .or_else(|| {
                        let inside = local.x >= geometry.loc.x as f64
                            && local.y >= geometry.loc.y as f64
                            && local.x < (geometry.loc.x + geometry.size.w) as f64
                            && local.y < (geometry.loc.y + geometry.size.h) as f64;
                        let surface = window.toplevel()?.wl_surface().clone();
                        inside.then(|| (surface, map_loc.to_f64()))
                    }),
                DerpSpaceElem::X11(x11) => {
                    let surf = x11.wl_surface()?;
                    under_from_surface_tree(&surf, local, (0, 0), WindowSurfaceType::ALL)
                        .map(|(s, p)| (s, (p + render_loc).to_f64()))
                        .or_else(|| {
                            let inside = local.x >= geometry.loc.x as f64
                                && local.y >= geometry.loc.y as f64
                                && local.x < (geometry.loc.x + geometry.size.w) as f64
                                && local.y < (geometry.loc.y + geometry.size.h) as f64;
                            inside.then(|| (surf, map_loc.to_f64()))
                        })
                }
            };
            let Some((surf, p_global)) = hit else {
                continue;
            };
            let blocked_by_shell = if self.point_in_shell_exclusion_zones(pos) {
                true
            } else if let Some(window_id) = self.derp_elem_window_id(&elem) {
                self.shell_ui_placement_topmost_at(pos).is_some_and(|w| {
                    Some(w.id) != skip_window_id
                        && self.shell_placement_renders_above_window(&w, window_id)
                })
            } else {
                false
            };
            if blocked_by_shell {
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
        for output in self.output_topology.space.outputs() {
            let Some(output_geo) = self.output_topology.space.output_geometry(output) else {
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
        for output in self.output_topology.space.outputs() {
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
        for elem in self.space_elements_top_to_bottom() {
            let Some(map_loc) = self.output_topology.space.element_location(&elem) else {
                continue;
            };
            if self.native_hit_blocked_by_shell_exclusion(&elem, pos) {
                continue;
            }
            let render_loc = map_loc - elem.geometry().loc;
            let local = pos - render_loc.to_f64();
            let hit = match &elem {
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
            return Some((elem, map_loc));
        }
        None
    }

    fn new_toplevel_placement_output(&self, parent_wl: Option<&WlSurface>) -> Option<Output> {
        if let Some(pw) = parent_wl {
            if let Some(w) = self.output_topology.space.elements().find_map(|e| {
                if let DerpSpaceElem::Wayland(w) = e {
                    w.toplevel()
                        .filter(|t| t.wl_surface() == pw)
                        .map(|_| w.clone())
                } else {
                    None
                }
            }) {
                let elem = DerpSpaceElem::Wayland(w.clone());
                if let Some(loc) = self.output_topology.space.element_location(&elem) {
                    let sz = w.geometry().size;
                    let ww = sz.w.max(1);
                    let hh = sz.h.max(1);
                    if let Some(o) = self.output_for_global_xywh(loc.x, loc.y, ww, hh) {
                        return Some(o);
                    }
                }
            }
        }
        if let Some(target_name) = self.windows.shell_spawn_target_output_name.as_ref() {
            if let Some(out) = self
                .output_topology
                .space
                .outputs()
                .find(|output| output.name() == target_name.as_str())
            {
                return Some(out.clone());
            }
        }
        if let Some(ptr) = self.input_routing.seat.get_pointer() {
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
            .output_topology
            .space
            .elements()
            .filter_map(|element| {
                let DerpSpaceElem::Wayland(window) = element else {
                    return None;
                };
                let toplevel = window.toplevel()?;
                let window_id = self
                    .windows
                    .window_registry
                    .window_id_for_wl_surface(toplevel.wl_surface())?;
                let info = self.windows.window_registry.window_info(window_id)?;
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
        let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl) else {
            return false;
        };
        if !self
            .windows
            .pending_gnome_initial_toplevels
            .contains(&window_id)
        {
            return false;
        }
        let (maximized, fullscreen) = read_toplevel_tiling(wl);
        if maximized || fullscreen {
            self.windows
                .pending_gnome_initial_toplevels
                .remove(&window_id);
            return false;
        }
        let Some((width, height)) = self.preferred_new_toplevel_size(window) else {
            return false;
        };
        let Some(out) = self.new_toplevel_placement_output(tl.parent().as_ref()) else {
            self.windows
                .pending_gnome_initial_toplevels
                .remove(&window_id);
            return false;
        };
        if self
            .workspace_auto_layout_initial_client_rect_for_window(&out.name(), window_id)
            .is_some()
        {
            self.windows
                .pending_gnome_initial_toplevels
                .remove(&window_id);
            return false;
        }
        let Some(work) = self.shell_maximize_work_area_global_for_output(&out) else {
            self.windows
                .pending_gnome_initial_toplevels
                .remove(&window_id);
            return false;
        };
        self.windows
            .pending_gnome_initial_toplevels
            .remove(&window_id);
        if Self::should_auto_maximize_new_toplevel(&work, width, height) {
            return self.apply_toplevel_maximize_layout(window);
        }
        let current = window.geometry().size;
        let needs_resize = current.w != width || current.h != height;
        if !needs_resize {
            return false;
        }
        tl.with_pending_state(|st| {
            st.states.unset(xdg_toplevel::State::Fullscreen);
            st.fullscreen_output = None;
            st.states.unset(xdg_toplevel::State::Maximized);
            st.size = Some(Size::from((width, height)));
        });
        tl.send_pending_configure();
        true
    }

    pub(crate) fn shell_managed_native_min_content_size(&self) -> Size<i32, Logical> {
        let th = self
            .shell_osr
            .shell_chrome_titlebar_h
            .max(SHELL_TITLEBAR_HEIGHT)
            .max(22);
        let bd = self
            .shell_osr
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
        let Some(window_id) = self
            .windows
            .window_registry
            .window_id_for_wl_surface(wl_surface)
        else {
            return base;
        };
        let shell_min = if self.windows.window_registry.is_shell_hosted(window_id) {
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

    pub(crate) fn shell_effective_primary_output(&self) -> Option<Output> {
        self.output_topology.shell_effective_primary_output()
    }

    pub(crate) fn primary_output_logical_origin(&self) -> (i32, i32) {
        let Some(output) = self.shell_effective_primary_output() else {
            return (0, 0);
        };
        let Some(geo) = self.output_topology.space.output_geometry(&output) else {
            return (0, 0);
        };
        (geo.loc.x, geo.loc.y)
    }

    /// Solid’s embedded CEF toplevel: known title/app_id or same PID as the shell Unix socket peer.
    pub(crate) fn toplevel_is_embedded_shell_host(
        &self,
        title: &str,
        app_id: &str,
        wayland_client_pid: Option<i32>,
    ) -> bool {
        WindowManagementState::toplevel_is_embedded_shell_host(
            title,
            app_id,
            wayland_client_pid,
            self.shell_osr.shell_ipc_peer_pid,
        )
    }

    pub(crate) fn window_info_is_solid_shell_host(&self, info: &WindowInfo) -> bool {
        WindowManagementState::window_info_is_solid_shell_host(
            info,
            self.shell_osr.shell_ipc_peer_pid,
        )
    }

    pub(crate) fn xdg_sync_pending_deferred_toplevel(&mut self, root: &WlSurface) {
        let Some(key) = crate::window_registry::wl_surface_key(root) else {
            return;
        };
        if !self.windows.pending_deferred_toplevels.contains_key(&key) {
            return;
        }
        {
            let pending = self
                .windows
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
                .windows
                .pending_deferred_toplevels
                .get(&key)
                .expect("checked");
            if let Some(tl) = pending.window.toplevel() {
                if let Some(rect) = pending.initial_client_rect {
                    tl.with_pending_state(|state| {
                        state.states.unset(xdg_toplevel::State::Fullscreen);
                        state.fullscreen_output = None;
                        state.states.unset(xdg_toplevel::State::Maximized);
                        state.size = Some(Size::from((rect.size.w.max(1), rect.size.h.max(1))));
                    });
                }
                tl.send_pending_configure();
            }
        }
        let (ready_to_map, title, app_id, retry_initial_resize) = {
            let pending = self
                .windows
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
            let geo = pending.window.geometry();
            let matches_initial_rect = pending.initial_client_rect.is_none_or(|rect| {
                geo.size.w == rect.size.w.max(1) && geo.size.h == rect.size.h.max(1)
            });
            let retry_initial_resize =
                has_buffer_extent && pending.initial_client_rect.is_some() && !matches_initial_rect;
            let ready = has_buffer_extent && matches_initial_rect;
            (ready, title, app_id, retry_initial_resize)
        };
        if retry_initial_resize {
            let pending = self
                .windows
                .pending_deferred_toplevels
                .get(&key)
                .expect("checked");
            if let Some(rect) = pending.initial_client_rect {
                if let Some(tl) = pending.window.toplevel() {
                    tl.with_pending_state(|state| {
                        state.states.unset(xdg_toplevel::State::Fullscreen);
                        state.fullscreen_output = None;
                        state.states.unset(xdg_toplevel::State::Maximized);
                        state.size = Some(Size::from((rect.size.w.max(1), rect.size.h.max(1))));
                    });
                    tl.send_pending_configure();
                }
            }
        }
        if ready_to_map {
            let pending = self
                .windows
                .pending_deferred_toplevels
                .remove(&key)
                .unwrap();
            let wl0 = pending.window.toplevel().unwrap().wl_surface();
            let existing = self.windows.window_registry.snapshot_for_wl_surface(wl0);
            let title = if title.trim().is_empty() {
                existing
                    .as_ref()
                    .map(|info| info.title.clone())
                    .unwrap_or_default()
            } else {
                title
            };
            let app_id = if app_id.trim().is_empty() {
                existing
                    .as_ref()
                    .map(|info| info.app_id.clone())
                    .unwrap_or_default()
            } else {
                app_id
            };
            let _ = self.windows.window_registry.set_title(wl0, title.clone());
            let _ = self.windows.window_registry.set_app_id(wl0, app_id.clone());
            let wl0 = wl0.clone();
            let status_indicator_location = {
                let geo = pending.window.geometry();
                self.shell_status_indicator_initial_location(
                    &title, &app_id, geo.size.w, geo.size.h,
                )
            };
            let map_x = status_indicator_location
                .map(|loc| loc.0)
                .or_else(|| pending.initial_client_rect.as_ref().map(|rect| rect.loc.x))
                .unwrap_or(pending.map_x);
            let map_y = status_indicator_location
                .map(|loc| loc.1)
                .or_else(|| pending.initial_client_rect.as_ref().map(|rect| rect.loc.y))
                .unwrap_or(pending.map_y);
            self.output_topology.space.map_element(
                DerpSpaceElem::Wayland(pending.window.clone()),
                (map_x, map_y),
                false,
            );
            if let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(&wl0) {
                if self
                    .windows
                    .window_registry
                    .window_info(window_id)
                    .is_some_and(|info| info.width <= 0 || info.height <= 0)
                {
                    let geo = pending.window.geometry();
                    let width = pending
                        .initial_client_rect
                        .as_ref()
                        .map(|rect| rect.size.w)
                        .unwrap_or(geo.size.w)
                        .max(1);
                    let height = pending
                        .initial_client_rect
                        .as_ref()
                        .map(|rect| rect.size.h)
                        .unwrap_or(geo.size.h)
                        .max(1);
                    let output_name = self
                        .output_for_window_position(map_x, map_y, width, height)
                        .unwrap_or_default();
                    let _ = self
                        .windows
                        .window_registry
                        .update_native(window_id, |info| {
                            info.x = map_x;
                            info.y = map_y;
                            info.width = width;
                            info.height = height;
                            info.output_name = output_name;
                        });
                }
                let _ = self
                    .windows
                    .window_registry
                    .transition(window_id, WindowLifecycleEvent::Map);
            }
            self.notify_geometry_if_changed(&pending.window);
            let info = self
                .windows
                .window_registry
                .snapshot_for_wl_surface(&wl0)
                .expect("pending map: registry row");
            let spawn_focus_wid = info.window_id;
            self.scratchpad_consider_window(spawn_focus_wid);
            let current_info = self
                .windows
                .window_registry
                .window_info(spawn_focus_wid)
                .unwrap_or(info);
            let output_name = current_info.output_name.clone();
            let pending_activation_focus =
                self.windows.shell_pending_native_focus_window_id == Some(spawn_focus_wid);
            let shell_status_indicator = self.window_is_shell_status_indicator(&current_info);
            if !(self
                .workspace_layout
                .scratchpad_windows
                .contains_key(&spawn_focus_wid)
                && current_info.minimized)
            {
                self.shell_emit_chrome_event(ChromeEvent::WindowMapped { info: current_info });
            }
            if shell_status_indicator {
                self.raise_shell_status_indicators();
            } else if !self
                .workspace_layout
                .scratchpad_windows
                .contains_key(&spawn_focus_wid)
            {
                if pending_activation_focus {
                    self.shell_raise_and_focus_window(spawn_focus_wid);
                    self.shell_reply_window_list();
                } else {
                    self.shell_consider_focus_spawned_toplevel(spawn_focus_wid);
                }
                let _ = self.workspace_apply_auto_layout_for_output_name(&output_name);
            }
        }
    }

    pub(crate) fn xdg_force_map_pending_deferred_toplevel(&mut self, root: &WlSurface) {
        let Some(key) = crate::window_registry::wl_surface_key(root) else {
            return;
        };
        let Some(pending) = self.windows.pending_deferred_toplevels.remove(&key) else {
            return;
        };
        pending.window.on_commit();
        let Some(toplevel) = pending.window.toplevel() else {
            return;
        };
        let wl0 = toplevel.wl_surface().clone();
        let existing = self.windows.window_registry.snapshot_for_wl_surface(&wl0);
        let (title, app_id) = smithay::wayland::compositor::with_states(&wl0, |states| {
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
        let title = if title.trim().is_empty() {
            existing
                .as_ref()
                .map(|info| info.title.clone())
                .unwrap_or_default()
        } else {
            title
        };
        let app_id = if app_id.trim().is_empty() {
            existing
                .as_ref()
                .map(|info| info.app_id.clone())
                .unwrap_or_default()
        } else {
            app_id
        };
        let _ = self.windows.window_registry.set_title(&wl0, title.clone());
        let _ = self
            .windows
            .window_registry
            .set_app_id(&wl0, app_id.clone());
        let map_x = pending
            .initial_client_rect
            .as_ref()
            .map(|rect| rect.loc.x)
            .unwrap_or(pending.map_x);
        let map_y = pending
            .initial_client_rect
            .as_ref()
            .map(|rect| rect.loc.y)
            .unwrap_or(pending.map_y);
        self.output_topology.space.map_element(
            DerpSpaceElem::Wayland(pending.window.clone()),
            (map_x, map_y),
            false,
        );
        if let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(&wl0) {
            let geo = pending.window.geometry();
            let width = pending
                .initial_client_rect
                .as_ref()
                .map(|rect| rect.size.w)
                .or_else(|| existing.as_ref().map(|info| info.width))
                .unwrap_or(geo.size.w)
                .max(360);
            let height = pending
                .initial_client_rect
                .as_ref()
                .map(|rect| rect.size.h)
                .or_else(|| existing.as_ref().map(|info| info.height))
                .unwrap_or(geo.size.h)
                .max(280);
            let output_name = self
                .output_for_window_position(map_x, map_y, width, height)
                .unwrap_or_default();
            self.shell_emit_requested_native_geometry(
                window_id,
                map_x,
                map_y,
                width,
                height,
                output_name,
                false,
                false,
            );
            let _ = self
                .windows
                .window_registry
                .transition(window_id, WindowLifecycleEvent::Map);
        }
        if let Some(info) = self.windows.window_registry.snapshot_for_wl_surface(&wl0) {
            self.shell_emit_chrome_event(ChromeEvent::WindowMapped { info });
        }
    }

    pub(crate) fn window_id_is_deferred_initial_map(&self, window_id: u32) -> bool {
        self.windows
            .window_registry
            .lifecycle(window_id)
            .is_some_and(WindowLifecycle::is_deferred_initial_map)
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
        let map_loc = self.output_topology.space.element_location(&elem)?;
        let geo = window.geometry();
        Some((map_loc.x, map_loc.y, geo.size.w, geo.size.h))
    }

    pub(crate) fn native_window_shell_decoration_disabled(&self, window_id: u32) -> bool {
        let Some(wl) = self.wl_surface_for_window_id(window_id) else {
            return false;
        };
        read_toplevel_shell_decoration_disabled(&wl)
    }

    pub(crate) fn native_window_uses_shell_chrome(&self, info: &WindowInfo) -> bool {
        if self.window_is_shell_status_indicator(info) {
            return false;
        }
        if self.native_window_shell_decoration_disabled(info.window_id) {
            return self.workspace_window_has_group_chrome(info.window_id);
        }
        !info.client_side_decoration || self.workspace_window_has_group_chrome(info.window_id)
    }

    pub(crate) fn native_window_shell_chrome_titlebar_h(&self, window_id: u32) -> i32 {
        self.windows
            .window_registry
            .window_info(window_id)
            .filter(|info| self.native_window_uses_shell_chrome(info))
            .map(|_| self.shell_osr.shell_chrome_titlebar_h.max(0))
            .unwrap_or(0)
    }

    pub(crate) fn notify_geometry_for_window(&mut self, window: &Window, force_shell_emit: bool) {
        let Some(toplevel) = window.toplevel() else {
            return;
        };
        let wl = toplevel.wl_surface();
        let Some((gx, gy, gw, gh)) = self.wayland_window_shell_rect_and_deco(window) else {
            return;
        };
        let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl) else {
            return;
        };
        let (max, fs) = read_toplevel_tiling(wl);
        let client_side_decoration = read_toplevel_client_side_decoration(wl);
        let mut layout_x = gx;
        let mut layout_y = gy;
        let mut layout_w = gw;
        let mut layout_h = gh;
        let mut layout_max = max;
        let mut layout_fs = fs;
        let mut pending_output_name = None;
        let mut remap_to_canonical_maximized_rect = false;
        if self.input_routing.shell_move_window_id == Some(window_id) {
            self.windows
                .shell_pending_native_configure_frames
                .remove(&window_id);
        } else if let Some(pending) = self
            .windows
            .shell_pending_native_configure_frames
            .get(&window_id)
            .cloned()
        {
            if (pending.width <= 1 || pending.height <= 1) && gw > 1 && gh > 1 {
                self.windows
                    .shell_pending_native_configure_frames
                    .remove(&window_id);
            } else if pending.x == gx
                && pending.y == gy
                && pending.width == gw
                && pending.height == gh
                && pending.maximized == max
                && pending.fullscreen == fs
            {
                self.windows
                    .shell_pending_native_configure_frames
                    .remove(&window_id);
                pending_output_name = Some(pending.output_name);
            } else {
                layout_x = pending.x;
                layout_y = pending.y;
                layout_w = pending.width;
                layout_h = pending.height;
                layout_max = pending.maximized;
                layout_fs = pending.fullscreen;
                pending_output_name = Some(
                    self.output_for_window_position(gx, gy, pending.width, pending.height)
                        .unwrap_or(pending.output_name),
                );
            }
        }
        let mut output_name = pending_output_name.unwrap_or_else(|| {
            self.output_for_window_position(gx, gy, layout_w, layout_h)
                .unwrap_or_default()
        });
        if layout_max && !layout_fs {
            if let Some(output) = self
                .output_topology
                .space
                .outputs()
                .find(|output| output.name() == output_name)
                .cloned()
                .or_else(|| self.output_for_global_xywh(layout_x, layout_y, layout_w, layout_h))
                .or_else(|| self.leftmost_output())
            {
                if let Some(rect) =
                    self.shell_maximize_work_area_global_for_window(&output, window_id)
                {
                    remap_to_canonical_maximized_rect =
                        (layout_x, layout_y) != (rect.loc.x, rect.loc.y);
                    layout_x = rect.loc.x;
                    layout_y = rect.loc.y;
                    layout_w = rect.size.w.max(1);
                    layout_h = rect.size.h.max(1);
                    output_name = output.name().to_string();
                }
            }
        }
        let changed = self.windows.window_registry.set_shell_layout(
            wl,
            layout_x,
            layout_y,
            layout_w,
            layout_h,
            output_name,
        );
        if remap_to_canonical_maximized_rect && (layout_x, layout_y) != (gx, gy) {
            self.output_topology.space.map_element(
                DerpSpaceElem::Wayland(window.clone()),
                (layout_x, layout_y),
                false,
            );
        }
        self.capture_refresh_window_source_cache(window_id);
        let tiling_changed = self
            .windows
            .window_registry
            .set_tiling_state(wl, layout_max, layout_fs)
            .unwrap_or(false);
        let decoration_changed = self
            .windows
            .window_registry
            .window_info(window_id)
            .is_some_and(|info| info.client_side_decoration != client_side_decoration);
        if decoration_changed {
            let _ = self
                .windows
                .window_registry
                .update_native(window_id, |info| {
                    info.client_side_decoration = client_side_decoration;
                    info.clone()
                });
        }
        let layout_or_tiling = changed == Some(true) || tiling_changed || decoration_changed;
        if force_shell_emit || layout_or_tiling {
            if let Some(info) = self.windows.window_registry.snapshot_for_wl_surface(wl) {
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
        fullscreen: bool,
    ) {
        self.windows.shell_pending_native_configure_frames.insert(
            window_id,
            PendingNativeConfigureFrame {
                x,
                y,
                width: w.max(1),
                height: h.max(1),
                output_name: output_name.clone(),
                maximized,
                fullscreen,
            },
        );
        let snapshot = self
            .windows
            .window_registry
            .update_native(window_id, |info| {
                info.x = x;
                info.y = y;
                info.width = w.max(1);
                info.height = h.max(1);
                info.output_name = output_name.clone();
                info.maximized = maximized;
                info.fullscreen = fullscreen;
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
            .windows
            .window_registry
            .set_shell_layout(wl, gx, gy, gw, gh, output_name);
        if let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl) {
            self.capture_refresh_window_source_cache(window_id);
        }
        let (max, fs) = read_toplevel_tiling(wl);
        let _ = self.windows.window_registry.set_tiling_state(wl, max, fs);
        if let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl) {
            let client_side_decoration = read_toplevel_client_side_decoration(wl);
            let changed = self
                .windows
                .window_registry
                .window_info(window_id)
                .is_some_and(|info| info.client_side_decoration != client_side_decoration);
            if changed {
                let _ = self
                    .windows
                    .window_registry
                    .update_native(window_id, |info| {
                        info.client_side_decoration = client_side_decoration;
                        info.clone()
                    });
            }
        }
    }

    pub(crate) fn resync_wayland_window_registry_from_space(&mut self) {
        let wins: Vec<Window> = self
            .output_topology
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

    pub(crate) fn clear_toplevel_layout_maps(&mut self, window_id: u32) {
        self.windows.clear_toplevel_layout_maps(window_id);
    }

    fn client_wl_output_for(&self, wl_surface: &WlSurface, output: &Output) -> Option<WlOutput> {
        let client = wl_surface.client()?;
        output.client_outputs(&client).next()
    }

    pub(crate) fn toplevel_rect_snapshot(&self, window: &Window) -> Option<(i32, i32, i32, i32)> {
        self.windows
            .toplevel_rect_snapshot(&self.output_topology.space, window)
    }

    pub(crate) fn shell_maximize_work_area_global_for_output(
        &self,
        output: &Output,
    ) -> Option<Rectangle<i32, Logical>> {
        self.shell_maximize_work_area_global_for_output_with_titlebar(
            output,
            self.shell_osr.shell_chrome_titlebar_h.max(0),
        )
    }

    pub(crate) fn shell_maximize_work_area_global_for_window(
        &self,
        output: &Output,
        window_id: u32,
    ) -> Option<Rectangle<i32, Logical>> {
        self.shell_maximize_work_area_global_for_output_with_titlebar(
            output,
            self.native_window_shell_chrome_titlebar_h(window_id),
        )
    }

    pub(crate) fn shell_maximize_work_area_global_for_output_with_titlebar(
        &self,
        output: &Output,
        titlebar_h: i32,
    ) -> Option<Rectangle<i32, Logical>> {
        let g = self.effective_layer_usable_area_global_for_output(output)?;
        let th = titlebar_h.max(0);
        if self.output_topology.taskbar_auto_hide {
            return Some(Rectangle::new(
                Point::from((g.loc.x, g.loc.y.saturating_add(th))),
                Size::from((g.size.w.max(1), g.size.h.saturating_sub(th).max(1))),
            ));
        }
        let side = self.taskbar_side_for_output_name(output.name().as_str());
        let without_titlebar = Rectangle::new(
            Point::from((g.loc.x, g.loc.y.saturating_add(th))),
            Size::from((g.size.w.max(1), g.size.h.saturating_sub(th).max(1))),
        );
        Some(apply_taskbar_reserve_to_global_rect(
            without_titlebar,
            side,
            SHELL_TASKBAR_RESERVE_PX,
        ))
    }

    pub(crate) fn apply_toplevel_maximize_layout(&mut self, window: &Window) -> bool {
        let Some(tl) = window.toplevel() else {
            return false;
        };
        let wl = tl.wl_surface();
        let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl) else {
            return false;
        };
        let (geo, output_name) = {
            let o = self
                .toplevel_rect_snapshot(window)
                .and_then(|(x, y, w, h)| self.output_for_global_xywh(x, y, w, h))
                .or_else(|| self.leftmost_output());
            let Some(ref out) = o else {
                return false;
            };
            let Some(g) = self.shell_maximize_work_area_global_for_window(out, window_id) else {
                return false;
            };
            (g, out.name().to_string())
        };
        self.windows
            .pending_gnome_initial_toplevels
            .remove(&window_id);
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
        self.output_topology.space.map_element(
            DerpSpaceElem::Wayland(window.clone()),
            (map_x, map_y),
            true,
        );
        self.output_topology
            .space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        tl.send_pending_configure();
        self.shell_emit_requested_native_geometry(
            window_id,
            map_x,
            map_y,
            content_w,
            content_h,
            output_name,
            true,
            false,
        );
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
                self.wayland_window_shell_rect_and_deco(window)
                    .and_then(|(gx, gy, gw, gh)| self.output_for_global_xywh(gx, gy, gw, gh))
            })
            .or_else(|| self.leftmost_output())
        else {
            return false;
        };
        let Some(geo) = self.output_topology.space.output_geometry(&sm_out) else {
            return false;
        };
        let Some(tl) = window.toplevel() else {
            return false;
        };
        let wl = tl.wl_surface();
        let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl) else {
            return false;
        };
        self.windows
            .pending_gnome_initial_toplevels
            .remove(&window_id);
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
        self.output_topology.space.map_element(
            DerpSpaceElem::Wayland(window.clone()),
            (map_x, map_y),
            true,
        );
        self.output_topology
            .space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        tl.send_pending_configure();
        self.shell_emit_requested_native_geometry(
            window_id,
            map_x,
            map_y,
            content_w,
            content_h,
            sm_out.name(),
            false,
            true,
        );
        true
    }

    pub(crate) fn restore_toplevel_floating_layout(
        &mut self,
        window_id: u32,
        window: &Window,
    ) -> bool {
        let Some((x, y, w, h)) = self.windows.toplevel_floating_restore.remove(&window_id) else {
            return false;
        };
        let Some(tl) = window.toplevel() else {
            return false;
        };
        self.windows
            .pending_gnome_initial_toplevels
            .remove(&window_id);
        self.cancel_shell_move_resize_for_window(window_id);
        tl.with_pending_state(|st| {
            st.states.unset(xdg_toplevel::State::Maximized);
            st.states.unset(xdg_toplevel::State::Fullscreen);
            st.fullscreen_output = None;
            st.size = Some(Size::from((w, h)));
        });
        self.output_topology.space.map_element(
            DerpSpaceElem::Wayland(window.clone()),
            (x, y),
            true,
        );
        self.output_topology
            .space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        tl.send_pending_configure();
        let output_name = self
            .output_for_window_position(x, y, w, h)
            .unwrap_or_default();
        self.shell_emit_requested_native_geometry(window_id, x, y, w, h, output_name, false, false);
        true
    }

    pub(crate) fn toplevel_unmaximize(&mut self, window: &Window) -> bool {
        let Some(tl) = window.toplevel() else {
            return false;
        };
        let wl = tl.wl_surface();
        let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl) else {
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
        self.output_topology.space.map_element(
            DerpSpaceElem::Wayland(window.clone()),
            (x, y),
            true,
        );
        tl.send_pending_configure();
        let output_name = self
            .output_for_window_position(
                x,
                y,
                DEFAULT_XDG_TOPLEVEL_WIDTH,
                DEFAULT_XDG_TOPLEVEL_HEIGHT,
            )
            .unwrap_or_default();
        self.shell_emit_requested_native_geometry(
            window_id,
            x,
            y,
            DEFAULT_XDG_TOPLEVEL_WIDTH,
            DEFAULT_XDG_TOPLEVEL_HEIGHT,
            output_name,
            false,
            false,
        );
        true
    }

    pub(crate) fn toplevel_unfullscreen(&mut self, window: &Window) -> bool {
        let Some(tl) = window.toplevel() else {
            return false;
        };
        let wl = tl.wl_surface();
        let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl) else {
            return false;
        };
        if !read_toplevel_tiling(wl).1 {
            return false;
        }
        let return_max = self
            .windows
            .toplevel_fullscreen_return_maximized
            .remove(&window_id);
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
            self.output_topology.space.map_element(
                DerpSpaceElem::Wayland(window.clone()),
                (x, y),
                true,
            );
            tl.send_pending_configure();
            let output_name = self
                .output_for_window_position(
                    x,
                    y,
                    DEFAULT_XDG_TOPLEVEL_WIDTH,
                    DEFAULT_XDG_TOPLEVEL_HEIGHT,
                )
                .unwrap_or_default();
            self.shell_emit_requested_native_geometry(
                window_id,
                x,
                y,
                DEFAULT_XDG_TOPLEVEL_WIDTH,
                DEFAULT_XDG_TOPLEVEL_HEIGHT,
                output_name,
                false,
                false,
            );
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
        let (ox, oy) = self.output_topology.shell_canvas_logical_origin;
        Some(crate::chrome_bridge::WindowInfo {
            window_id: info.window_id,
            surface_id: info.surface_id,
            title: info.title.clone(),
            app_id: info.app_id.clone(),
            icon: info.icon.clone(),
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
                self.windows
                    .window_registry
                    .window_info(*window_id)
                    .map(|i| {
                        self.window_info_is_solid_shell_host(&i)
                            || !shell_window_row_should_show(&i)
                    })
                    .unwrap_or(false)
            }
            ChromeEvent::FocusChanged { window_id, .. } => window_id
                .and_then(|w| self.windows.window_registry.window_info(w))
                .map(|i| {
                    self.window_info_is_solid_shell_host(&i) || !shell_window_row_should_show(&i)
                })
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
        self.shell_force_next_dmabuf_full_damage();
        self.input_routing.keyboard_forget_window(window_id);
        self.clear_shell_osk_text_input_for_window(window_id);
        if self
            .shell_osr
            .shell_hosted_app_state
            .remove(&window_id)
            .is_some()
        {
            self.shell_hosted_app_state_send();
        }
        self.scratchpad_forget_window(window_id);
        let hint = removed_info.as_ref();
        self.shell_emit_chrome_event_inner(ChromeEvent::WindowUnmapped { window_id }, hint);
        self.shell_reply_window_list();
        if let Some(output_name) = removed_info
            .as_ref()
            .map(|info| info.output_name.clone())
            .filter(|output_name| !output_name.is_empty())
        {
            let _ = self.workspace_apply_auto_layout_for_output_name(&output_name);
        }
    }

    /// When title/app_id becomes that of the Solid host after an earlier map with empty metadata, retract the phantom HUD entry.
    pub(crate) fn shell_retract_phantom_shell_window(&mut self, window_id: u32) {
        self.input_routing.keyboard_forget_window(window_id);
        tracing::debug!(
            target: "derp_shell_sync",
            window_id,
            "shell ipc WindowUnmapped (retract phantom shell host)"
        );
        self.shell_send_to_cef(
            shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { window_id },
        );
        self.windows
            .chrome_bridge
            .notify(ChromeEvent::WindowUnmapped { window_id });
    }

    fn shell_emit_chrome_event_inner(
        &mut self,
        event: ChromeEvent,
        unmap_removed_info: Option<&WindowInfo>,
    ) {
        if let ChromeEvent::WindowMapped { info } = &event {
            self.shell_prepare_spawned_toplevel_stack(info.window_id);
        }
        if matches!(
            event,
            ChromeEvent::WindowMapped { .. }
                | ChromeEvent::WindowGeometryChanged { .. }
                | ChromeEvent::WindowStateChanged { .. }
                | ChromeEvent::WindowUnmapped { .. }
        ) {
            self.shell_osr.shell_exclusion_zones_need_full_damage = true;
            self.shell_force_next_dmabuf_full_damage();
            self.shell_nudge_cef_repaint();
        }
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
                let mapped_window_id = match &msg {
                    shell_wire::DecodedCompositorToShellMessage::WindowMapped {
                        window_id, ..
                    } => Some(*window_id),
                    _ => None,
                };
                let msg = self.enrich_shell_live_message(msg);
                self.shell_send_to_cef(msg);
                if let Some(window_id) = mapped_window_id {
                    self.shell_send_window_geometry_snapshot_for_window(window_id);
                }
            }
        }
        self.windows.chrome_bridge.notify(event);
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
        self.shell_osr.shell_exclusion_overlay_open
            && self.shell_point_in_shell_floating_overlay_global(pos)
    }

    pub fn shell_point_in_shell_floating_overlay_global(&self, pos: Point<f64, Logical>) -> bool {
        let px = pos.x;
        let py = pos.y;
        for r in &self.shell_osr.shell_exclusion_floating {
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
        if !self.shell_osr.shell_exclusion_overlay_open {
            return;
        }
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::ContextMenuDismiss);
    }

    /// Map normalized pointer (`nx`, `ny` over the canvas) to **shell OSR buffer** pixels (letterbox-aware).
    pub fn shell_pointer_buffer_pixels(&self, nx: f64, ny: f64) -> Option<(i32, i32)> {
        InputRoutingState::shell_pointer_buffer_pixels(
            nx,
            ny,
            self.shell_osr.shell_view_px,
            self.shell_output_logical_size(),
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
        Some(InputRoutingState::shell_pointer_norm_from_global(
            pos,
            self.workspace_logical_bounds()?,
        ))
    }
}

mod core;
mod focus_stack;
mod native_window_ops;
mod osk_runtime;
mod output_layout_runtime;
mod render_workspace;
mod screenshot_requests;
mod shell_move_resize;
mod shell_snapshot;
mod shell_ui;
mod spawn_runtime;
mod tray_runtime;
mod workspace_session;
pub(crate) use core::*;
mod capture;
use capture::*;
mod outputs;
pub(crate) use outputs::*;
mod shell_ipc_cef;
mod shell_osr;
pub(crate) use shell_osr::*;
mod workspace;
mod workspace_layout;
pub(crate) use workspace::*;
mod input_routing;
mod keyboard_session_input;
pub(crate) use input_routing::*;
mod tray_notifications;
pub(crate) use tray_notifications::*;
mod session_services;
pub(crate) use session_services::*;
mod background;
pub(crate) use background::*;
mod windows;
pub(crate) use windows::*;
mod explicit_sync;
pub(crate) use explicit_sync::*;
mod protocols;
mod scratchpads;
mod x11;
mod x11_runtime;

pub struct ClientState {
    pub compositor_state: CompositorClientState,
    pub peer_pid: Option<i32>,
    pub peer_uid: Option<u32>,
    pub virtual_keyboard_allowed: bool,
}

impl Default for ClientState {
    fn default() -> Self {
        Self {
            compositor_state: CompositorClientState::default(),
            peer_pid: None,
            peer_uid: None,
            virtual_keyboard_allowed: false,
        }
    }
}

impl ClientState {
    pub(crate) fn from_stream(stream: &UnixStream) -> Self {
        let mut state = Self::default();
        #[cfg(target_os = "linux")]
        {
            let mut cred = libc::ucred {
                pid: 0,
                uid: 0,
                gid: 0,
            };
            let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
            let ok = unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    (&mut cred as *mut libc::ucred).cast(),
                    &mut len,
                )
            } == 0;
            if ok {
                state.peer_pid = Some(cred.pid);
                state.peer_uid = Some(cred.uid);
                state.virtual_keyboard_allowed =
                    virtual_keyboard_client_is_allowed(state.peer_uid, state.peer_pid);
            }
        }
        state
    }
}

fn process_name_for_pid(pid: Option<i32>) -> Option<String> {
    let pid = pid?;
    if pid <= 0 {
        return None;
    }
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

fn virtual_keyboard_client_is_allowed(uid: Option<u32>, pid: Option<i32>) -> bool {
    if uid != Some(unsafe { libc::geteuid() }) {
        return false;
    }
    let Some(process_name) = process_name_for_pid(pid) else {
        return false;
    };
    matches!(
        process_name.as_str(),
        "squeekboard" | "wvkbd" | "wvkbd-mobintl"
    ) || process_name.starts_with("derp-test-clien")
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
mod tests;
