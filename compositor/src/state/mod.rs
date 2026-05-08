use std::{
    cell::RefCell,
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
    backend::drm::DrmDeviceFd,
    backend::egl::EGLDevice,
    backend::input::{KeyState, Keycode, TouchSlot},
    backend::renderer::{
        element::solid::SolidColorBuffer,
        gles::{GlesRenderer, GlesTarget},
        utils::CommitCounter,
        Color32F, ImportDma, Renderer,
    },
    backend::{
        renderer::element::Id,
        session::libseat::LibSeatSession,
    },
    desktop::{
        layer_map_for_output,
        space::{Space, SpaceElement},
        utils::{under_from_surface_tree, with_surfaces_surface_tree},
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
        content_type::{ContentTypeState, ContentTypeSurfaceCachedState},
        cursor_shape::CursorShapeManagerState,
        dmabuf::{DmabufFeedbackBuilder, DmabufGlobal, DmabufHandler, DmabufState, ImportNotifier},
        drm_syncobj::{supports_syncobj_eventfd, DrmSyncobjHandler, DrmSyncobjState},
        fifo::FifoManagerState,
        foreign_toplevel_list::{ForeignToplevelHandle, ForeignToplevelListState},
        fractional_scale::{FractionalScaleHandler, FractionalScaleManagerState},
        idle_inhibit::IdleInhibitManagerState,
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
        xdg_activation::{XdgActivationState, XdgActivationTokenData},
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
use crate::tearing_control::{
    TearingControlState, TearingControlSurfaceCachedState, TearingPresentationHint,
};
use smithay::input::pointer::CursorImageStatus;

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
    pub xdg_decoration_state: XdgDecorationState,
    pub fractional_scale_manager_state: FractionalScaleManagerState,
    pub viewporter_state: ViewporterState,
    pub cursor_shape_manager_state: CursorShapeManagerState,
    pub shm_state: ShmState,
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

    fn shell_window_stack_seed_known_windows(&mut self) {
        self.windows.shell_window_stack_seed_known_windows();
    }

    pub(crate) fn shell_window_stack_touch(&mut self, window_id: u32) {
        self.windows.shell_window_stack_touch(window_id);
    }

    pub(crate) fn shell_window_stack_forget(&mut self, window_id: u32) {
        self.windows.shell_window_stack_forget(window_id);
    }

    pub(crate) fn shell_note_non_shell_focus(&mut self) {
        self.shell_osr.shell_focused_ui_window_id = None;
        self.shell_osr.shell_last_sent_ui_focus_id = None;
        self.shell_osr.shell_last_sent_focus_pair = None;
        self.shell_osr.shell_exclusion_zones_need_full_damage = true;
    }

    pub(crate) fn shell_keyboard_capture_active(&self) -> bool {
        self.input_routing.shell_keyboard_capture_active()
    }

    pub(crate) fn shell_keyboard_capture_shell_ui(&mut self) {
        self.input_routing.shell_keyboard_capture_shell_ui();
    }

    pub(crate) fn shell_keyboard_capture_programs_menu(&mut self, restore_window_id: Option<u32>) {
        self.input_routing
            .shell_keyboard_capture_programs_menu(restore_window_id);
    }

    pub(crate) fn shell_keyboard_capture_window_switcher(
        &mut self,
        restore_window_id: Option<u32>,
    ) {
        self.input_routing
            .shell_keyboard_capture_window_switcher(restore_window_id);
    }

    pub(crate) fn shell_keyboard_capture_clear(&mut self) {
        self.input_routing.shell_keyboard_capture_clear();
    }

    pub(crate) fn logical_focused_window_id(&self) -> Option<u32> {
        self.input_routing.logical_focused_window_id(
            self.keyboard_focused_window_id(),
            self.shell_osr.shell_focused_ui_window_id,
            |window_id| self.logical_focus_target_is_valid(window_id),
        )
    }

    pub(crate) fn shell_taskbar_should_toggle_minimize(&self, window_id: u32) -> bool {
        let logical_focused_window_id = self.logical_focused_window_id();
        if logical_focused_window_id == Some(window_id) {
            return true;
        }
        if self.keyboard_focused_window_id() == Some(window_id) {
            return true;
        }
        if logical_focused_window_id.is_some() {
            return false;
        }
        self.pick_next_logical_focus_target(None, true) == Some(window_id)
    }

    fn logical_focus_target_is_valid(&self, window_id: u32) -> bool {
        self.windows.logical_focus_target_is_valid(
            &self.output_topology.space,
            self.shell_osr.shell_ipc_peer_pid,
            window_id,
        )
    }

    pub(crate) fn pick_next_logical_focus_target(
        &self,
        exclude_window_id: Option<u32>,
        include_shell_hosted: bool,
    ) -> Option<u32> {
        self.windows.pick_next_logical_focus_target(
            &self.output_topology.space,
            self.shell_osr.shell_ipc_peer_pid,
            exclude_window_id,
            include_shell_hosted,
        )
    }

    fn shell_window_switcher_restore_window_id(&self) -> Option<u32> {
        self.input_routing.shell_window_switcher_restore_window_id()
    }

    pub(crate) fn shell_window_switcher_open(&self) -> bool {
        self.input_routing.shell_window_switcher_open()
    }

    fn shell_window_switcher_candidates(&self) -> Vec<u32> {
        self.windows.shell_window_switcher_candidates(
            &self.output_topology.space,
            self.shell_osr.shell_ipc_peer_pid,
        )
    }

    fn shell_window_switcher_effective_selected_window_id(&self) -> Option<u32> {
        self.windows.shell_window_switcher_effective_selected_window_id(
            &self.output_topology.space,
            self.shell_osr.shell_ipc_peer_pid,
            self.shell_window_switcher_open(),
            self.shell_window_switcher_restore_window_id(),
        )
    }

    pub(crate) fn shell_window_switcher_cycle(&mut self, reverse: bool) {
        let candidates = self.shell_window_switcher_candidates();
        if candidates.len() < 2 {
            return;
        }
        let restore_window_id = self.shell_window_switcher_restore_window_id().or_else(|| {
            self.logical_focused_window_id()
                .or_else(|| self.keyboard_focused_window_id())
                .filter(|window_id| self.logical_focus_target_is_valid(*window_id))
        });
        if !self.shell_window_switcher_open() {
            self.shell_keyboard_capture_window_switcher(restore_window_id);
            self.shell_send_to_cef(self.shell_focus_message());
        }
        let pivot_window_id = self.windows.shell_window_switcher_selected_window_id
            .filter(|window_id| self.logical_focus_target_is_valid(*window_id))
            .or(restore_window_id)
            .unwrap_or(candidates[0]);
        let pivot_index = candidates
            .iter()
            .position(|wid| *wid == pivot_window_id)
            .unwrap_or(0);
        let len = candidates.len();
        let next_index = if reverse {
            (pivot_index + len - 1) % len
        } else {
            (pivot_index + 1) % len
        };
        self.windows.shell_window_switcher_selected_window_id = candidates.get(next_index).copied();
        self.shell_send_interaction_state();
    }

    pub(crate) fn shell_window_switcher_cancel(&mut self) {
        let restore_window_id = self
            .shell_window_switcher_restore_window_id()
            .filter(|window_id| self.logical_focus_target_is_valid(*window_id));
        self.windows.shell_window_switcher_selected_window_id = None;
        self.shell_keyboard_capture_clear();
        self.shell_send_interaction_state();
        if let Some(window_id) = restore_window_id {
            self.focus_logical_window(window_id);
            return;
        }
        self.shell_send_to_cef(self.shell_focus_message());
    }

    pub(crate) fn shell_window_switcher_commit(&mut self) {
        let restore_window_id = self
            .shell_window_switcher_restore_window_id()
            .filter(|window_id| self.logical_focus_target_is_valid(*window_id));
        let selected_window_id = self.shell_window_switcher_effective_selected_window_id();
        self.windows.shell_window_switcher_selected_window_id = None;
        self.shell_keyboard_capture_clear();
        self.shell_send_interaction_state();
        if let Some(window_id) = selected_window_id.or(restore_window_id) {
            self.focus_logical_window(window_id);
            return;
        }
        self.shell_send_to_cef(self.shell_focus_message());
    }

    pub(crate) fn focus_logical_window(&mut self, window_id: u32) {
        if self.windows.window_registry.is_shell_hosted(window_id) {
            self.shell_focus_shell_ui_window(window_id);
        } else {
            self.shell_raise_and_focus_window(window_id);
        }
    }

    fn topmost_native_window_from_stack(&self) -> Option<u32> {
        self.windows.topmost_native_window_from_stack(
            &self.output_topology.space,
            self.shell_osr.shell_ipc_peer_pid,
        )
    }

    pub(crate) fn shell_window_stack_ids(&self) -> Vec<u32> {
        self.windows.shell_window_stack_ids()
    }

    pub(crate) fn shell_window_stack_z(&self, window_id: u32) -> u32 {
        self.windows.shell_window_stack_z(window_id)
    }

    fn space_elements_top_to_bottom_from<'a, I>(&self, elements: I) -> Vec<DerpSpaceElem>
    where
        I: Iterator<Item = &'a DerpSpaceElem>,
    {
        let stack_z: HashMap<u32, u32> = self
            .shell_window_stack_ids()
            .into_iter()
            .enumerate()
            .map(|(index, window_id)| (window_id, index as u32 + 1))
            .collect();
        let mut entries: Vec<(u32, usize, DerpSpaceElem)> = elements
            .enumerate()
            .map(|(index, elem)| {
                let z = self
                    .derp_elem_window_id(elem)
                    .and_then(|window_id| stack_z.get(&window_id).copied())
                    .unwrap_or(0);
                (z, index, elem.clone())
            })
            .collect();
        entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        entries.into_iter().map(|(_, _, elem)| elem).collect()
    }

    pub(crate) fn space_elements_top_to_bottom(&self) -> Vec<DerpSpaceElem> {
        self.space_elements_top_to_bottom_from(self.output_topology.space.elements())
    }

    pub(crate) fn space_elements_for_output_top_to_bottom(
        &self,
        output: &Output,
    ) -> Vec<DerpSpaceElem> {
        self.space_elements_top_to_bottom_from(self.output_topology.space.elements_for_output(output))
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
        smithay::wayland::relative_pointer::RelativePointerManagerState::new::<Self>(&dh);
        smithay::wayland::pointer_constraints::PointerConstraintsState::new::<Self>(&dh);
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
            xdg_decoration_state,
            fractional_scale_manager_state,
            viewporter_state,
            cursor_shape_manager_state,
            shm_state,
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

    pub(crate) fn keyboard_clear_per_window_layout_map(&mut self) {
        self.input_routing.keyboard_clear_per_window_layout_map();
    }

    pub(crate) fn keyboard_apply_settings(
        &mut self,
        settings: &crate::session::settings_config::KeyboardSettingsFile,
    ) -> Result<(), String> {
        if settings.layouts.is_empty() {
            return Err("keyboard layouts cannot be empty".into());
        }
        let Some(handle) = self.input_routing.seat.get_keyboard() else {
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
        let session_default_layout_index = self.keyboard_layout_index_current();
        self.workspace_layout
            .set_session_default_layout_index(session_default_layout_index);
        self.emit_keyboard_layout_to_shell();
        Ok(())
    }

    pub fn apply_shell_tile_preview_canvas(
        &mut self,
        visible: bool,
        lx: i32,
        ly: i32,
        lw: i32,
        lh: i32,
    ) {
        let rect = if !visible || lw < 1 || lh < 1 {
            None
        } else if let Some((gx, gy, gw, gh)) =
            self.shell_output_local_rect_to_logical_global(lx, ly, lw, lh)
        {
            Some(Rectangle::new(
                Point::<i32, Logical>::from((gx, gy)),
                Size::<i32, Logical>::from((gw, gh)),
            ))
        } else {
            None
        };
        self.workspace_layout.apply_tile_preview_rect(visible, rect);
        self.shell_osr.shell_exclusion_zones_need_full_damage = true;
        self.shell_osr.shell_dmabuf_dirty_force_full = true;
    }

    pub fn apply_shell_chrome_metrics(&mut self, titlebar_h: i32, border_w: i32) {
        let prev_titlebar_h = self.shell_osr.shell_chrome_titlebar_h;
        let prev_border_w = self.shell_osr.shell_chrome_border_w;
        self.shell_osr.shell_chrome_titlebar_h = titlebar_h.clamp(0, 256);
        self.shell_osr.shell_chrome_border_w = border_w.clamp(0, 64);
        if prev_titlebar_h != self.shell_osr.shell_chrome_titlebar_h
            || prev_border_w != self.shell_osr.shell_chrome_border_w
        {
            self.shell_reply_window_list();
            let rows = self.shell_window_list_rows();
            for row in rows {
                self.shell_send_to_cef(
                    shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
                        window_id: row.window_id,
                        surface_id: row.surface_id,
                        x: row.x,
                        y: row.y,
                        w: row.w,
                        h: row.h,
                        client_x: row.client_x,
                        client_y: row.client_y,
                        client_w: row.client_w,
                        client_h: row.client_h,
                        frame_x: row.frame_x,
                        frame_y: row.frame_y,
                        frame_w: row.frame_w,
                        frame_h: row.frame_h,
                        maximized: row.maximized != 0,
                        fullscreen: row.fullscreen != 0,
                        client_side_decoration: row.client_side_decoration != 0,
                        output_id: row.output_id,
                        output_name: row.output_name,
                    },
                );
            }
        }
        self.workspace_apply_auto_layout_for_all_outputs();
    }

    fn shell_shared_state_payload_is_stale(
        &self,
        kind: u32,
        sequence: u64,
        payload: &[u8],
    ) -> bool {
        self.shell_osr.shared_state_payload_is_stale(
            kind,
            sequence,
            payload,
            self.output_topology.shell_output_topology_revision,
        )
    }

    pub fn sync_shell_shared_state(&mut self, kind: u32) {
        let (path, min_sequence_exclusive) = match kind {
            crate::cef::shared_state::SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES => (
                &self.shell_osr.shell_exclusion_shared_path,
                Some(self.shell_osr.shell_exclusion_shared_sequence),
            ),
            crate::cef::shared_state::SHELL_SHARED_STATE_KIND_UI_WINDOWS => (
                &self.shell_osr.shell_ui_windows_shared_path,
                Some(self.shell_osr.shell_ui_windows_shared_sequence),
            ),
            _ => return,
        };
        let Ok(Some((sequence, payload))) = crate::cef::shared_state::read_payload_if_newer(
            path,
            crate::cef::shared_state::SHELL_SHARED_STATE_ABI_VERSION,
            min_sequence_exclusive,
        ) else {
            return;
        };
        if self.shell_shared_state_payload_is_stale(kind, sequence, &payload) {
            match kind {
                crate::cef::shared_state::SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES => {
                    self.shell_osr.shell_exclusion_shared_sequence = sequence;
                }
                crate::cef::shared_state::SHELL_SHARED_STATE_KIND_UI_WINDOWS => {
                    self.shell_osr.shell_ui_windows_shared_sequence = sequence;
                }
                _ => {}
            }
            return;
        }
        match kind {
            crate::cef::shared_state::SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES => {
                self.shell_osr.shell_exclusion_shared_sequence = sequence;
                self.apply_shell_exclusion_zones_payload(&payload);
            }
            crate::cef::shared_state::SHELL_SHARED_STATE_KIND_UI_WINDOWS => {
                self.shell_osr.shell_ui_windows_shared_sequence = sequence;
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
        self.shell_osr.point_in_shell_exclusion_zones(pos)
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

    pub(crate) fn shell_placement_renders_above_window(
        &self,
        placement: &ShellUiWindowPlacement,
        window_id: u32,
    ) -> bool {
        let native_z = self.shell_window_stack_z(window_id);
        let placement_z = self.shell_placement_stack_z(placement);
        ShellOsrState::shell_placement_renders_above_window(
            placement,
            window_id,
            native_z,
            placement_z,
        )
    }

    pub(crate) fn shell_placement_stack_z(&self, placement: &ShellUiWindowPlacement) -> u32 {
        ShellOsrState::shell_placement_stack_z(placement, self.shell_window_stack_z(placement.id))
    }

    pub(crate) fn shell_ui_placement_topmost_at(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<ShellUiWindowPlacement> {
        let placements = self.shell_visible_placements();
        ShellOsrState::shell_ui_placement_topmost_at(pos, &placements, |id| {
            self.shell_window_stack_z(id)
        })
    }

    pub(crate) fn native_surface_under_no_shell_exclusion(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(Option<u32>, WlSurface, Point<f64, Logical>)> {
        if let Some((surface, point)) = self.layer_surface_under(pos, &[Layer::Overlay, Layer::Top])
        {
            return Some((None, surface, point));
        }
        for elem in self.space_elements_top_to_bottom() {
            let Some(map_loc) = self.output_topology.space.element_location(&elem) else {
                continue;
            };
            let render_loc = map_loc - elem.geometry().loc;
            let local = pos - render_loc.to_f64();
            let window_id = self.derp_elem_window_id(&elem);
            if window_id
                .is_some_and(|window_id| !self.workspace_window_is_visible_during_render(window_id))
            {
                continue;
            }
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

    fn shell_visible_placements_stamp(&self) -> ShellVisiblePlacementsStamp {
        ShellVisiblePlacementsStamp {
            ui_generation: self.shell_osr.shell_ui_windows_generation,
            window_registry_revision: self.windows.window_registry.revision(),
            window_stack_revision: self.windows.shell_window_stack_revision,
            output_topology_revision: self.output_topology.shell_output_topology_revision,
            workspace_revision: self.workspace_layout.shell_workspace_revision,
        }
    }

    fn rebuild_shell_visible_placements_cache(&self) -> ShellVisiblePlacementsCache {
        let mut frames = self.shell_backed_placements();
        frames.extend(self.shell_native_frame_placements());
        self.shell_osr
            .shell_visible_placements_cache(self.shell_visible_placements_stamp(), frames)
    }

    fn shell_visible_placements_cache(&self) -> ShellVisiblePlacementsCache {
        self.rebuild_shell_visible_placements_cache()
    }

    pub(crate) fn shell_visible_placements(&self) -> Vec<ShellUiWindowPlacement> {
        self.shell_visible_placements_cache().all
    }

    pub(crate) fn shell_window_frame_placements(&self) -> Vec<ShellUiWindowPlacement> {
        self.shell_visible_placements_cache().frames
    }

    fn shell_native_frame_placements(&self) -> Vec<ShellUiWindowPlacement> {
        let Some(ws) = self.workspace_logical_bounds() else {
            return Vec::new();
        };
        let mut placements = Vec::new();
        for record in self.windows.window_registry.all_records() {
            if record.kind != WindowKind::Native {
                continue;
            }
            let info = record.info;
            if info.minimized
                || self.window_info_is_solid_shell_host(&info)
                || !shell_window_row_should_show(&info)
                || self.shell_x11_window_is_tray_hidden(info.window_id)
                || !self.workspace_window_is_visible_during_render(info.window_id)
            {
                continue;
            }
            let outer = self.shell_native_outer_global_rect(&info);
            let Some(clamped) = outer.intersection(ws) else {
                continue;
            };
            let Some(br) = self.shell_global_rect_to_buffer_rect(&clamped) else {
                continue;
            };
            placements.push(ShellUiWindowPlacement {
                id: info.window_id,
                z: self.shell_window_stack_z(info.window_id),
                global_rect: clamped,
                buffer_rect: br,
            });
        }
        placements
    }

    fn shell_hosted_visible_placements(&self) -> Vec<ShellUiWindowPlacement> {
        self.shell_visible_placements()
            .into_iter()
            .filter(|w| {
                self.windows.window_registry.is_shell_hosted(w.id)
                    || self.windows.window_registry.window_info(w.id).is_none()
            })
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

    pub(crate) fn shell_global_rect_to_buffer_mapping(
        &self,
        global: &Rectangle<i32, Logical>,
    ) -> Option<(Rectangle<i32, Logical>, Rectangle<i32, Buffer>)> {
        self.shell_osr.shell_global_rect_to_buffer_mapping(
            global,
            self.shell_output_logical_size(),
            self.workspace_logical_bounds(),
        )
    }

    pub(crate) fn shell_global_rect_to_buffer_rect(
        &self,
        global: &Rectangle<i32, Logical>,
    ) -> Option<Rectangle<i32, Buffer>> {
        self.shell_osr.shell_global_rect_to_buffer_rect(
            global,
            self.shell_output_logical_size(),
            self.workspace_logical_bounds(),
        )
    }

    pub fn apply_shell_ui_windows_payload(&mut self, payload: &[u8]) {
        let stack_z_by_id: HashMap<u32, u32> = self
            .shell_window_stack_ids()
            .into_iter()
            .enumerate()
            .map(|(idx, id)| (id, idx as u32 + 1))
            .collect();
        let focused_is_shell_hosted = self
            .shell_osr
            .shell_focused_ui_window_id
            .is_some_and(|fid| self.windows.window_registry.is_shell_hosted(fid));
        let pointer_grab_id = self.input_routing.shell_ui_pointer_grab;
        let pointer_grab_is_shell_hosted =
            pointer_grab_id.is_some_and(|gid| self.windows.window_registry.is_shell_hosted(gid));
        let Some(applied) = self.shell_osr.apply_shell_ui_windows_payload(
            payload,
            self.output_topology.shell_output_topology_revision,
            self.shell_output_logical_size(),
            self.workspace_logical_bounds(),
            &stack_z_by_id,
            focused_is_shell_hosted,
            pointer_grab_id,
            pointer_grab_is_shell_hosted,
        ) else {
            return;
        };
        if applied.focus_lost {
            self.shell_emit_shell_ui_focus_if_changed(None);
        }
        if applied.grab_lost {
            self.input_routing.shell_ui_pointer_grab = None;
        }
        if applied.changed {
            self.shell_move_try_activate_deferred();
        }
    }

    pub(crate) fn shell_emit_shell_ui_focus_if_changed(&mut self, id: Option<u32>) {
        let Some(emit) = self.shell_osr.shell_emit_shell_ui_focus_if_changed(id) else {
            return;
        };
        self.shell_send_to_cef(emit.message);
        self.shell_nudge_cef_repaint();
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
        self.cancel_shell_move_resize_for_window(window_id);
        self.input_routing.shell_backed_move_candidate = None;
        self.input_routing.shell_ui_pointer_grab = Some(window_id);
    }

    pub(crate) fn shell_ui_pointer_grab_end(&mut self) {
        self.input_routing.shell_ui_pointer_grab = None;
    }

    pub(crate) fn shell_ui_pointer_grab_active(&self) -> bool {
        self.input_routing.shell_ui_pointer_grab.is_some()
    }

    pub(crate) fn shell_focus_shell_ui_window(&mut self, window_id: u32) {
        if window_id == 0 {
            return;
        }
        if !self.shell_osr.shell_ui_windows.iter().any(|w| w.id == window_id)
            && !self.windows.window_registry.is_shell_hosted(window_id)
        {
            return;
        }
        let k_serial = SERIAL_COUNTER.next_serial();
        self.output_topology.space.elements().for_each(|e| {
            e.set_activate(false);
            if let DerpSpaceElem::Wayland(w) = e {
                if let Some(toplevel) = w.toplevel() {
                    toplevel.send_pending_configure();
                }
            }
        });
        let Some(keyboard) = self.input_routing.seat.get_keyboard() else {
            return;
        };
        keyboard.set_focus(self, Option::<WlSurface>::None, k_serial);
        self.keyboard_on_focus_surface_changed(None);
        self.windows.shell_pending_native_focus_window_id = None;
        self.shell_keyboard_capture_shell_ui();
        self.shell_window_stack_touch(window_id);
        self.shell_emit_shell_ui_focus_if_changed(Some(window_id));
        self.shell_reply_window_list();
    }

    pub(crate) fn shell_blur_shell_ui_focus(&mut self) {
        self.input_routing.shell_ui_pointer_grab = None;
        self.shell_emit_shell_ui_focus_if_changed(None);
        self.shell_keyboard_capture_clear();
        let k_serial = SERIAL_COUNTER.next_serial();
        self.input_routing.seat
            .get_keyboard()
            .unwrap()
            .set_focus(self, Option::<WlSurface>::None, k_serial);
        self.keyboard_on_focus_surface_changed(None);
    }

    pub fn apply_shell_exclusion_zones_payload(&mut self, payload: &[u8]) {
        let Some(applied) = self.shell_osr.apply_shell_exclusion_zones_payload(
            payload,
            self.output_topology.shell_output_topology_revision,
            self.workspace_logical_bounds(),
            self.tray_notifications.shell_tray_strip_global(),
        ) else {
            return;
        };
        self.tray_notifications
            .set_shell_tray_strip_global(applied.tray_strip_global);
    }

    pub(crate) fn derp_elem_window_id(&self, elem: &DerpSpaceElem) -> Option<u32> {
        self.windows.derp_elem_window_id(elem)
    }

    fn workspace_window_is_logically_visible(&self, window_id: u32) -> bool {
        self.workspace_layout
            .workspace_window_is_logically_visible(&self.windows.window_registry, window_id)
    }

    pub(crate) fn workspace_window_is_visible_during_render(&self, window_id: u32) -> bool {
        self.workspace_window_is_logically_visible(window_id)
    }

    pub(crate) fn workspace_window_render_alpha(&self, window_id: u32) -> f32 {
        WorkspaceLayoutState::workspace_window_render_alpha(
            self.input_routing.shell_move_window_id,
            window_id,
        )
    }

    pub(crate) fn workspace_window_is_tiled(&self, window_id: u32) -> bool {
        self.workspace_layout.workspace_window_is_tiled(window_id)
    }

    pub(crate) fn shell_native_outer_global_rect(
        &self,
        info: &WindowInfo,
    ) -> Rectangle<i32, Logical> {
        let th = self.shell_osr.shell_chrome_titlebar_h.max(0);
        let bd = self.shell_osr.shell_chrome_border_w.max(0);
        let suppress_side_strips =
            info.maximized || info.fullscreen || self.workspace_window_is_tiled(info.window_id);
        let inset = if suppress_side_strips { 0 } else { bd };
        let inset_top = if suppress_side_strips {
            0
        } else {
            SHELL_BORDER_TOP_THICKNESS
        };
        let x = info.x.saturating_sub(inset);
        let y = info.y.saturating_sub(th.saturating_add(inset_top));
        let w = info.width.max(1).saturating_add(inset.saturating_mul(2));
        let h = info
            .height
            .max(1)
            .saturating_add(th)
            .saturating_add(inset_top)
            .saturating_add(inset);
        Rectangle::new(Point::from((x, y)), Size::from((w.max(1), h.max(1))))
    }

    pub(crate) fn ordered_window_ids_on_output(&self, output: &Output) -> Vec<u32> {
        let visible_window_ids_on_output: HashSet<u32> = self.output_topology.space
            .elements_for_output(output)
            .filter_map(|e| self.derp_elem_window_id(e))
            .filter(|window_id| self.workspace_window_is_visible_during_render(*window_id))
            .collect();
        self.shell_window_stack_ids()
            .into_iter()
            .filter(|window_id| visible_window_ids_on_output.contains(window_id))
            .collect()
    }

    pub(crate) fn output_has_fullscreen_native_direct_path(&self, output: &Output) -> bool {
        if self.shell_osr.shell_presentation_fullscreen
            || self.shell_osr.shell_exclusion_overlay_open
            || self.capture.has_screenshot_request()
            || self.capture.screenshot_selection_active()
            || self.workspace_layout.tile_preview_rect_global.is_some()
            || self.input_routing.shell_move_window_id.is_some()
            || !self.shell_osr.shell_ui_windows.is_empty()
            || !self.shell_osr.shell_exclusion_floating.is_empty()
        {
            return false;
        }
        let Some(output_geo) = self.output_topology.space.output_geometry(output) else {
            return false;
        };
        let Some(window_id) = self.ordered_window_ids_on_output(output).last().copied() else {
            return false;
        };
        if self.windows.window_registry.is_shell_hosted(window_id) {
            return false;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return false;
        };
        if !info.fullscreen
            || info.minimized
            || self.window_info_is_solid_shell_host(&info)
            || self.workspace_window_render_alpha(window_id) < 0.999
        {
            return false;
        }
        let rect = Rectangle::new(
            Point::from((info.x, info.y)),
            Size::from((info.width.max(1), info.height.max(1))),
        );
        rect.contains(output_geo.loc)
            && rect.contains(Point::from((
                output_geo
                    .loc
                    .x
                    .saturating_add(output_geo.size.w.saturating_sub(1)),
                output_geo
                    .loc
                    .y
                    .saturating_add(output_geo.size.h.saturating_sub(1)),
            )))
    }

    pub(crate) fn output_async_tearing_candidate_window(&self, output: &Output) -> Option<u32> {
        if !self.output_has_fullscreen_native_direct_path(output) {
            return None;
        }
        let window_id = self.ordered_window_ids_on_output(output).last().copied()?;
        (self.tearing_hint_for_window_id(window_id) == TearingPresentationHint::Async)
            .then_some(window_id)
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

    fn shell_decoration_clip_rects_for_window(
        &self,
        window_id: u32,
    ) -> Vec<Rectangle<i32, Logical>> {
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return Vec::new();
        };
        if info.minimized || !self.workspace_window_is_visible_during_render(window_id) {
            return Vec::new();
        }
        let is_shell_hosted = self.windows.window_registry.is_shell_hosted(window_id);
        if !is_shell_hosted
            && self.windows.window_registry.window_kind(window_id) != Some(WindowKind::Native)
        {
            return Vec::new();
        }
        let outer = if is_shell_hosted {
            self.shell_backed_outer_global_rect(&info)
        } else {
            self.shell_native_outer_global_rect(&info)
        };
        let titlebar_h = self.shell_osr.shell_chrome_titlebar_h.max(0);
        if titlebar_h <= 0 {
            return Vec::new();
        }
        let no_outer_border = info.maximized || info.fullscreen;
        let border = if no_outer_border {
            0
        } else {
            self.shell_osr.shell_chrome_border_w.max(0)
        };
        let inset_top = if no_outer_border {
            0
        } else {
            SHELL_BORDER_TOP_THICKNESS
        };
        let mut out = vec![Rectangle::new(
            outer.loc,
            Size::from((outer.size.w.max(1), titlebar_h.saturating_add(inset_top))),
        )];
        if border > 0 {
            let client = Self::shell_hosted_client_global_rect(&info);
            out.push(Rectangle::new(
                Point::from((outer.loc.x, client.loc.y)),
                Size::from((border, client.size.h.max(1))),
            ));
            out.push(Rectangle::new(
                Point::from((client.loc.x.saturating_add(client.size.w), client.loc.y)),
                Size::from((border, client.size.h.max(1))),
            ));
            out.push(Rectangle::new(
                Point::from((outer.loc.x, client.loc.y.saturating_add(client.size.h))),
                Size::from((outer.size.w.max(1), border)),
            ));
        }
        out
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
        let Some(out_geo) = self.output_topology.space.output_geometry(output) else {
            return Vec::new();
        };
        let Some(visible) = ws.intersection(out_geo) else {
            return Vec::new();
        };
        let mut out: Vec<Rectangle<i32, Logical>> = self.shell_osr.shell_exclusion_global
            .iter()
            .filter_map(|z| z.intersection(visible))
            .collect();
        out.extend(
            self.shell_osr.shell_exclusion_floating
                .iter()
                .filter_map(|z| z.intersection(visible)),
        );
        if let Some(rect) = self
            .shell_native_drag_preview_clip_rect()
            .and_then(|rect| rect.intersection(visible))
        {
            out.push(rect);
        }
        let placements = self.shell_hosted_clip_placements(elem_window);
        match elem_window {
            None => {
                for placement in &self.shell_osr.shell_ui_windows {
                    for r in self.shell_decoration_clip_rects_for_window(placement.id) {
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
                    for r in self.shell_decoration_clip_rects_for_window(ow) {
                        if let Some(i) = r.intersection(visible) {
                            out.push(i);
                        }
                    }
                }
                if include_self_decor {
                    for r in self.shell_decoration_clip_rects_for_window(self_id) {
                        if let Some(i) = r.intersection(visible) {
                            out.push(i);
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
        let Some(out_geo) = self.output_topology.space.output_geometry(output) else {
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
        self.shell_osr.shell_cef_active()
    }

    pub(crate) fn shell_send_to_cef(&mut self, msg: shell_wire::DecodedCompositorToShellMessage) {
        if !self.shell_osr.prepare_shell_send_to_cef(&msg) {
            return;
        }
        let workspace_dirty = matches!(
            msg,
            shell_wire::DecodedCompositorToShellMessage::WindowMapped { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowList { .. }
        );
        let workspace_changed = workspace_dirty && self.workspace_sync_from_registry();
        if workspace_changed {
            self.next_shell_workspace_revision();
        }
        let authoritative_snapshot =
            self.shell_authoritative_snapshot_messages(&msg, workspace_changed);
        let workspace_state_message = if workspace_changed {
            self.workspace_state_message()
        } else {
            None
        };
        let snapshot_epoch = authoritative_snapshot
            .as_ref()
            .map(|_| self.next_shell_snapshot_epoch());
        let live_epoch = snapshot_epoch.unwrap_or(self.shell_osr.shell_snapshot_epoch);
        if matches!(
            msg,
            shell_wire::DecodedCompositorToShellMessage::OutputLayout { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowMapped { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowGeometry { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowMetadata { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowState { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowList { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowOrder { .. }
                | shell_wire::DecodedCompositorToShellMessage::FocusChanged { .. }
                | shell_wire::DecodedCompositorToShellMessage::InteractionState { .. }
                | shell_wire::DecodedCompositorToShellMessage::WorkspaceState { .. }
                | shell_wire::DecodedCompositorToShellMessage::WorkspaceStateBinary { .. }
        ) {
            self.validate_state_after("shell_send_to_cef");
        }
        self.shell_osr.shell_send_to_cef_link(
            msg,
            authoritative_snapshot,
            snapshot_epoch,
            live_epoch,
            workspace_state_message,
        );
    }

    fn shell_authoritative_snapshot_messages(
        &mut self,
        msg: &shell_wire::DecodedCompositorToShellMessage,
        _workspace_changed: bool,
    ) -> Option<Vec<shell_wire::DecodedCompositorToShellMessage>> {
        self.shell_clear_stale_primary_output();
        ShellOsrState::shell_authoritative_snapshot_messages(
            msg,
            self.shell_output_layout_snapshot_message(),
            self.shell_window_list_snapshot_message(),
            self.shell_window_order_snapshot_message(),
            self.shell_focus_snapshot_message(),
            self.workspace_state_binary_message(),
            self.shell_hosted_app_state_message(),
            shell_wire::DecodedCompositorToShellMessage::CommandPaletteState {
                revision: self.session_services.command_palette_revision(),
                state_json: self.command_palette_state_value().to_string(),
            },
            self.shell_interaction_state_message(),
            self.shell_native_drag_preview_message(),
            shell_wire::DecodedCompositorToShellMessage::KeyboardLayout {
                label: self.input_routing.shell_keyboard_layout_label.clone(),
            },
            self.shell_tray_hints_message(),
            shell_wire::DecodedCompositorToShellMessage::TraySni {
                items: self.tray_notifications.sni_tray_items(),
            },
        )
    }

    pub(crate) fn shell_nudge_cef_repaint(&mut self) {
        self.shell_osr.shell_nudge_cef_repaint();
    }

    pub(crate) fn shell_force_next_dmabuf_full_damage(&mut self) {
        self.shell_osr.shell_force_next_dmabuf_full_damage();
    }

    pub(crate) fn programs_menu_toggle_from_super(&mut self, serial: Serial) {
        let _ = serial;
        self.programs_menu_opened_from_shell(0);
        self.shell_send_keybind_ex("toggle_programs_menu", None);
    }

    pub(crate) fn programs_menu_opened_from_shell(&mut self, restore_window_id: u32) {
        let restore_from_shell = (restore_window_id != 0
            && self.logical_focus_target_is_valid(restore_window_id))
        .then_some(restore_window_id);
        let restore_window_id = restore_from_shell.or_else(|| {
            self.logical_focused_window_id()
                .or_else(|| self.keyboard_focused_window_id())
                .filter(|window_id| self.logical_focus_target_is_valid(*window_id))
        });
        self.shell_keyboard_capture_programs_menu(restore_window_id);
        self.shell_send_to_cef(self.shell_focus_message());
    }

    pub(crate) fn programs_menu_closed_from_shell(&mut self) {
        let restore_window_id = self.input_routing.programs_menu_close_restore_window();
        if let Some(window_id) = restore_window_id {
            if self.logical_focus_target_is_valid(window_id) {
                self.focus_logical_window(window_id);
                return;
            }
        }
        self.shell_send_to_cef(self.shell_focus_message());
    }

    pub(crate) fn programs_menu_prepare_super_press(&mut self) {
        if self.input_routing.pointer_pressed_buttons.is_empty() {
            self.shell_resize_end_active();
            self.shell_move_end_active();
            self.shell_ui_pointer_grab_end();
            self.input_routing.shell_backed_move_candidate = None;
        }
        self.input_routing.programs_menu_prepare_super_press(
            !self.input_routing.pointer_pressed_buttons.is_empty(),
            self.shell_move_is_active(),
            self.shell_resize_is_active(),
            self.input_routing.shell_backed_move_candidate.is_some(),
        );
    }

    #[cfg(test)]
    pub(crate) fn programs_menu_super_press_chord(
        pointer_button_pressed: bool,
        shell_move_active: bool,
        shell_resize_active: bool,
        shell_backed_move_candidate: bool,
    ) -> bool {
        InputRoutingState::programs_menu_super_press_chord(
            pointer_button_pressed,
            shell_move_active,
            shell_resize_active,
            shell_backed_move_candidate,
        )
    }

    pub(crate) fn shell_send_keybind(&mut self, action: &str) {
        self.shell_send_keybind_ex(action, None);
    }

    pub(crate) fn shell_send_keybind_ex(&mut self, action: &str, target_window_id: Option<u32>) {
        self.shell_emit_chrome_event(ChromeEvent::Keybind {
            action: action.to_string(),
            target_window_id,
            output_name: self
                .new_toplevel_placement_output(None)
                .map(|output| output.name().to_string()),
        });
        if action != "toggle_programs_menu" {
            self.shell_nudge_cef_repaint();
        }
    }

    pub(crate) fn screenshot_selection_active(&self) -> bool {
        self.capture.screenshot_selection_active()
    }

    pub(crate) fn begin_screenshot_selection_mode(&mut self) {
        let current_pointer = self.input_routing.seat
            .get_pointer()
            .map(|pointer| pointer.current_location().to_i32_round());
        self.capture
            .begin_screenshot_selection_mode(current_pointer);
        self.input_routing.programs_menu_clear_super_press();
        self.shell_keyboard_capture_clear();
        self.shell_emit_shell_ui_focus_if_changed(None);
        self.core.loop_signal.wakeup();
    }

    pub(crate) fn cancel_screenshot_selection_mode(&mut self) {
        if !self.capture.cancel_screenshot_selection_mode() {
            return;
        }
        self.input_routing.programs_menu_clear_super_press();
        self.core.loop_signal.wakeup();
    }

    pub(crate) fn update_screenshot_selection_pointer(&mut self, pos: Point<f64, Logical>) {
        if self.capture.update_screenshot_selection_pointer(pos) {
            self.core.loop_signal.wakeup();
        }
    }

    pub(crate) fn screenshot_selection_rect(&self) -> Option<Rectangle<i32, Logical>> {
        self.capture.screenshot_selection_rect()
    }

    pub(crate) fn handle_screenshot_pointer_button(
        &mut self,
        button: u32,
        button_state: smithay::backend::input::ButtonState,
    ) -> bool {
        let pos = self.input_routing.seat
            .get_pointer()
            .map(|pointer| pointer.current_location().to_i32_round())
            .or(self.capture.screenshot_selection_current());
        let Some(action) = self
            .capture
            .handle_screenshot_pointer_button(button, button_state, pos)
        else {
            return false;
        };
        match action {
            ScreenshotPointerAction::RequestRegion(rect) => {
                self.input_routing.programs_menu_clear_super_press();
                if let Err(error) = self.request_screenshot_region(rect) {
                    tracing::warn!(%error, "screenshot region request failed");
                }
            }
            ScreenshotPointerAction::Cancel => {
                self.input_routing.programs_menu_clear_super_press();
            }
            ScreenshotPointerAction::None => {}
        }
        self.core.loop_signal.wakeup();
        true
    }

    pub(crate) fn request_screenshot_current_output(&mut self) -> Result<(), String> {
        let output = self
            .new_toplevel_placement_output(None)
            .ok_or_else(|| "no output available for screenshot".to_string())?;
        self.capture.request_screenshot_output(output.name());
        self.core.loop_signal.wakeup();
        Ok(())
    }

    pub(crate) fn request_screenshot_region(
        &mut self,
        logical_rect: Rectangle<i32, Logical>,
    ) -> Result<(), String> {
        let outputs = self.output_topology.space
            .outputs()
            .filter_map(|output| {
                let geo = self.output_topology.space.output_geometry(output)?;
                if geo.overlaps(logical_rect) {
                    Some(output.name())
                } else {
                    None
                }
            })
            .collect();
        self.capture
            .request_screenshot_region(logical_rect, outputs)?;
        self.core.loop_signal.wakeup();
        Ok(())
    }

    pub(crate) fn screenshot_capture_output_if_needed(
        &mut self,
        output: &Output,
        renderer: &mut GlesRenderer,
        framebuffer: &GlesTarget<'_>,
    ) {
        let Some(mut request) = self.capture.take_screenshot_request() else {
            return;
        };
        let output_name = output.name();
        if !request.needs_output(&output_name) {
            self.capture.set_screenshot_request(request);
            return;
        }
        let capture = (|| -> Result<(), String> {
            let geo = self.output_topology.space
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
        self.capture.set_screenshot_request(request);
    }

    fn finish_screenshot_request(
        &mut self,
        request: crate::render::screenshot::PendingScreenshotRequest,
    ) -> Result<PathBuf, String> {
        let (path, png) = CaptureState::finish_screenshot_request(request)?;
        self.publish_screenshot_clipboard(png);
        tracing::warn!(path = %path.display(), "screenshot saved");
        Ok(path)
    }

    fn publish_screenshot_clipboard(&mut self, png: Vec<u8>) {
        set_data_device_selection::<Self>(
            &self.core.display_handle,
            &self.input_routing.seat,
            vec!["image/png".into()],
            Arc::new(png),
        );
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

    pub(crate) fn shell_consider_focus_spawned_toplevel(&mut self, window_id: u32) {
        if !self.shell_window_is_pending_spawn_focus_candidate(window_id) {
            return;
        }
        self.windows.shell_spawn_known_native_window_ids = None;
        self.windows.shell_spawn_target_output_name = None;
        self.shell_raise_and_focus_window(window_id);
        self.shell_reply_window_list();
    }

    fn shell_prepare_spawned_toplevel_stack(&mut self, window_id: u32) {
        if self.shell_window_is_pending_spawn_focus_candidate(window_id) {
            self.shell_window_stack_touch(window_id);
        }
    }

    fn shell_window_is_pending_spawn_focus_candidate(&self, window_id: u32) -> bool {
        let Some(known_window_ids) = self.windows.shell_spawn_known_native_window_ids.as_ref() else {
            return false;
        };
        if known_window_ids.contains(&window_id) {
            return false;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return false;
        };
        !self.window_info_is_solid_shell_host(&info) && shell_window_row_should_show(&info)
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
        let infos = self.windows.window_registry.native_infos_for_client(&client_id);
        let doomed_surface_keys: HashSet<_> = self.windows.window_registry
            .native_surface_keys_for_client(&client_id)
            .into_iter()
            .collect();
        if infos.is_empty() {
            self.windows.pending_deferred_toplevels
                .retain(|(cid, _), _| cid != &client_id);
            self.input_routing.idle_inhibit_surfaces
                .retain(|(cid, _)| cid != &client_id);
            return;
        }
        let focused_removed = infos
            .iter()
            .any(|info| self.keyboard_focused_window_id() == Some(info.window_id));
        let doomed_windows: Vec<_> = self.output_topology.space
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
            self.output_topology.space.unmap_elem(&DerpSpaceElem::Wayland(window));
        }
        for info in &infos {
            if let Some(window) = self.find_window_by_surface_id(info.surface_id) {
                self.output_topology.space.unmap_elem(&DerpSpaceElem::Wayland(window));
            }
            self.clear_toplevel_layout_maps(info.window_id);
            self.windows.pending_gnome_initial_toplevels.remove(&info.window_id);
            self.windows.shell_close_pending_native_windows
                .remove(&info.window_id);
            self.shell_window_stack_forget(info.window_id);
            self.windows.shell_known_x11_windows.remove(&info.window_id);
            self.tray_notifications.shell_tray_hidden_x11_windows.remove(&info.window_id);
            self.forget_tray_hidden_x11_window_id(info.window_id);
        }
        self.windows.pending_deferred_toplevels
            .retain(|(cid, _), _| cid != &client_id);
        self.input_routing.idle_inhibit_surfaces
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
                    } else if self.windows.window_registry
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
                    let fs = self.windows.window_registry
                        .window_info(wid)
                        .is_some_and(|info| info.fullscreen);
                    self.shell_set_window_fullscreen(wid, !fs);
                }
            }
            "toggle_maximize" => {
                if let Some(wid) = self.super_keybind_target_window_id() {
                    let maximized = self.windows.window_registry
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
                    let maximized = self.windows.window_registry
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
                let fullscreen = self.windows.window_registry
                    .window_info(intent.window_id)
                    .is_some_and(|info| info.fullscreen);
                self.shell_set_window_fullscreen(intent.window_id, !fullscreen);
                true
            }
            "toggle_maximize" | "tile_up" => {
                let maximized = self.windows.window_registry
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
        crate::cef::begin_frame_diag::note_shell_dmabuf_rx(width, height);
        if width == 0 || height == 0 || planes.is_empty() || planes.len() != fds.len() {
            fds.clear();
            return;
        }
        if self.shell_osr.shell_has_frame && generation <= self.shell_osr.shell_dmabuf_generation {
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
                self.shell_osr.shell_dmabuf_generation = generation;
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

    pub(crate) fn accept_shell_software_frame_from_cef(
        &mut self,
        width: u32,
        height: u32,
        generation: u32,
        pixels: Vec<u8>,
        dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
    ) {
        if width == 0 || height == 0 || pixels.is_empty() {
            return;
        }
        if self.shell_osr.shell_has_frame && generation <= self.shell_osr.shell_software_generation {
            return;
        }
        match self.apply_shell_frame_software(width, height, pixels, dirty_buffer) {
            Ok(()) => {
                self.shell_osr.shell_software_generation = generation;
            }
            Err(e) => {
                tracing::warn!(target: "derp_hotplug_shell", ?e, "shell software frame rejected")
            }
        }
    }

    /// Advertise `zwp_linux_dmabuf_v1` using formats from the live GLES stack (call after `bind_wl_display`).
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
            self.output_topology.space
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

    pub(crate) fn tearing_hint_for_surface(
        &self,
        surface: &WlSurface,
    ) -> TearingPresentationHint {
        smithay::wayland::compositor::with_states(surface, |states| {
            states
                .cached_state
                .get::<TearingControlSurfaceCachedState>()
                .current()
                .hint()
        })
    }

    pub(crate) fn wl_surface_for_window_id(&self, window_id: u32) -> Option<WlSurface> {
        let sid = self.windows.window_registry.surface_id_for_window(window_id)?;
        if let Some(window) = self.find_window_by_surface_id(sid) {
            return window.toplevel().map(|toplevel| toplevel.wl_surface().clone());
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
        self.tearing_hint_for_window_id(window_id).label().to_string()
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
        if let Some(hit) = self.layer_surface_under(pos, &[Layer::Overlay, Layer::Top]) {
            return Some(hit);
        }
        for elem in self.space_elements_top_to_bottom() {
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
            if let Some(out) = self.output_topology.space
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
        let stagger_index = (self.output_topology.space
            .elements()
            .filter_map(|element| {
                let DerpSpaceElem::Wayland(window) = element else {
                    return None;
                };
                let toplevel = window.toplevel()?;
                let window_id = self.windows.window_registry
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
        if !self.windows.pending_gnome_initial_toplevels.contains(&window_id) {
            return false;
        }
        let (maximized, fullscreen) = read_toplevel_tiling(wl);
        if maximized || fullscreen {
            self.windows.pending_gnome_initial_toplevels.remove(&window_id);
            return false;
        }
        let Some((width, height)) = self.preferred_new_toplevel_size(window) else {
            return false;
        };
        let Some(out) = self.new_toplevel_placement_output(tl.parent().as_ref()) else {
            self.windows.pending_gnome_initial_toplevels.remove(&window_id);
            return false;
        };
        if self
            .workspace_auto_layout_initial_client_rect_for_window(&out.name(), window_id)
            .is_some()
        {
            self.windows.pending_gnome_initial_toplevels.remove(&window_id);
            return false;
        }
        let Some(work) = self.shell_maximize_work_area_global_for_output(&out) else {
            self.windows.pending_gnome_initial_toplevels.remove(&window_id);
            return false;
        };
        self.windows.pending_gnome_initial_toplevels.remove(&window_id);
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
        let th = self.shell_osr.shell_chrome_titlebar_h
            .max(SHELL_TITLEBAR_HEIGHT)
            .max(22);
        let bd = self.shell_osr.shell_chrome_border_w
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
        let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl_surface) else {
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

    pub fn new_toplevel_initial_location(
        &self,
        window: &Window,
        parent_wl: Option<&WlSurface>,
    ) -> (i32, i32) {
        if let Some(rect) = self.new_toplevel_initial_client_rect(window, parent_wl) {
            return (rect.loc.x, rect.loc.y);
        }
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

    pub(crate) fn new_toplevel_initial_client_rect(
        &self,
        window: &Window,
        parent_wl: Option<&WlSurface>,
    ) -> Option<Rectangle<i32, Logical>> {
        let out = self.new_toplevel_placement_output(parent_wl)?;
        let window_id = window.toplevel().and_then(|toplevel| {
            self.windows.window_registry
                .window_id_for_wl_surface(toplevel.wl_surface())
        })?;
        self.workspace_auto_layout_initial_client_rect_for_window(&out.name(), window_id)
    }

    fn workspace_auto_layout_frame_area_for_output(
        &self,
        output: &Output,
    ) -> Option<Rectangle<i32, Logical>> {
        let geo = self.output_topology.space.output_geometry(output)?;
        if self.output_topology.taskbar_auto_hide {
            return Some(Rectangle::new(
                geo.loc,
                Size::from((geo.size.w.max(1), geo.size.h.max(1))),
            ));
        }
        let side = self.taskbar_side_for_output_name(output.name().as_str());
        Some(apply_taskbar_reserve_to_global_rect(
            geo,
            side,
            SHELL_TASKBAR_RESERVE_PX,
        ))
    }

    fn workspace_auto_layout_client_rect_from_frame_rect(
        &self,
        rect: Rectangle<i32, Logical>,
    ) -> Rectangle<i32, Logical> {
        WorkspaceLayoutState::workspace_auto_layout_client_rect_from_frame_rect(
            rect,
            self.shell_osr.shell_chrome_titlebar_h,
        )
    }

    fn workspace_monitor_layout_state_for_output(
        &self,
        output_name: &str,
    ) -> Option<&WorkspaceMonitorLayoutState> {
        let output_id = self.workspace_output_identity_for_name(output_name);
        self.workspace_layout
            .workspace_monitor_layout_state_for_output(output_name, output_id.as_deref())
    }

    fn workspace_is_auto_layout_managed_window(&self, info: &WindowInfo) -> bool {
        if info.minimized || info.maximized || info.fullscreen {
            return false;
        }
        if self.window_info_is_solid_shell_host(info) {
            return false;
        }
        info.app_id != "derp.debug" && info.app_id != "derp.settings"
    }

    fn workspace_window_output_name_for_auto_layout(&self, info: &WindowInfo) -> String {
        if !info.output_name.is_empty() {
            return info.output_name.clone();
        }
        self.output_for_window_position(info.x, info.y, info.width, info.height)
            .unwrap_or_default()
    }

    fn workspace_auto_layout_window_ids_for_output(
        &self,
        output_name: &str,
        extra_window_id: Option<u32>,
    ) -> Vec<u32> {
        let mut window_ids = Vec::new();
        for info in self.windows.window_registry.all_infos() {
            if !self.workspace_is_auto_layout_managed_window(&info) {
                continue;
            }
            if self.workspace_window_output_name_for_auto_layout(&info) != output_name {
                continue;
            }
            window_ids.push(info.window_id);
        }
        if let Some(window_id) = extra_window_id {
            if !window_ids.contains(&window_id) {
                window_ids.push(window_id);
            }
        }
        window_ids.sort_unstable();
        window_ids
    }

    fn workspace_custom_auto_slots(
        layout_state: &WorkspaceMonitorLayoutState,
    ) -> Vec<WorkspaceCustomAutoSlot> {
        WorkspaceLayoutState::workspace_custom_auto_slots(layout_state)
    }

    fn workspace_custom_auto_frame_rect(
        slot: &WorkspaceCustomAutoSlot,
        work_area: Rectangle<i32, Logical>,
    ) -> Rectangle<i32, Logical> {
        WorkspaceLayoutState::workspace_custom_auto_frame_rect(slot, work_area)
    }

    fn workspace_slot_rule_value(
        &self,
        window_id: u32,
        info: &WindowInfo,
        field: &WorkspaceSlotRuleField,
    ) -> String {
        match field {
            WorkspaceSlotRuleField::AppId => info.app_id.clone(),
            WorkspaceSlotRuleField::Title => info.title.clone(),
            WorkspaceSlotRuleField::Kind => {
                if self.windows.window_registry.is_shell_hosted(window_id) {
                    info.app_id
                        .strip_prefix("derp.")
                        .unwrap_or(info.app_id.as_str())
                        .to_string()
                } else {
                    "native".into()
                }
            }
            WorkspaceSlotRuleField::X11Class => self
                .find_x11_window_by_window_id(window_id)
                .map(|window| window.class())
                .unwrap_or_default(),
            WorkspaceSlotRuleField::X11Instance => self
                .find_x11_window_by_window_id(window_id)
                .map(|window| window.instance())
                .unwrap_or_default(),
        }
    }

    fn workspace_slot_rule_matches(haystack: &str, rule: &WorkspaceSlotRule) -> bool {
        WorkspaceLayoutState::workspace_slot_rule_matches(haystack, rule)
    }

    fn workspace_window_matches_slot_rules(
        &self,
        window_id: u32,
        slot: &WorkspaceCustomAutoSlot,
    ) -> bool {
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return false;
        };
        slot.rules.iter().any(|rule| {
            let value = self.workspace_slot_rule_value(window_id, &info, &rule.field);
            Self::workspace_slot_rule_matches(&value, rule)
        })
    }

    fn workspace_compute_auto_layout_frame_rects(
        &self,
        layout_state: &WorkspaceMonitorLayoutState,
        window_ids: &[u32],
        work_area: Rectangle<i32, Logical>,
    ) -> HashMap<u32, Rectangle<i32, Logical>> {
        WorkspaceLayoutState::workspace_compute_auto_layout_frame_rects(
            layout_state,
            window_ids,
            work_area,
            |window_id, slot| self.workspace_window_matches_slot_rules(window_id, slot),
        )
    }
    pub(crate) fn workspace_auto_layout_initial_client_rect_for_window(
        &self,
        output_name: &str,
        window_id: u32,
    ) -> Option<Rectangle<i32, Logical>> {
        let layout_state = self.workspace_monitor_layout_state_for_output(output_name)?;
        if layout_state.layout == WorkspaceMonitorLayoutType::ManualSnap {
            return None;
        }
        let output = self.output_topology.space
            .outputs()
            .find(|entry| entry.name() == output_name)?;
        let work_area = self.workspace_auto_layout_frame_area_for_output(output)?;
        let window_ids =
            self.workspace_auto_layout_window_ids_for_output(output_name, Some(window_id));
        let frame_rects =
            self.workspace_compute_auto_layout_frame_rects(layout_state, &window_ids, work_area);
        frame_rects
            .get(&window_id)
            .copied()
            .map(|rect| self.workspace_auto_layout_client_rect_from_frame_rect(rect))
    }

    fn workspace_set_pre_tile_geometry(&mut self, window_id: u32, bounds: WorkspaceRect) -> bool {
        self.workspace_layout
            .workspace_set_pre_tile_geometry(window_id, bounds)
    }

    fn workspace_pre_tile_geometry(&self, window_id: u32) -> Option<WorkspaceRect> {
        self.workspace_layout.workspace_pre_tile_geometry(window_id)
    }

    fn workspace_clear_pre_tile_geometry(&mut self, window_id: u32) -> bool {
        self.workspace_layout
            .workspace_clear_pre_tile_geometry(window_id)
    }

    fn workspace_monitor_tile_for_window(&self, window_id: u32) -> Option<(String, String)> {
        self.workspace_layout
            .workspace_monitor_tile_for_window(window_id)
    }

    fn workspace_set_monitor_tile(
        &mut self,
        output_name: &str,
        window_id: u32,
        zone: String,
        bounds: WorkspaceRect,
    ) -> bool {
        let output_id = self
            .workspace_output_identity_for_name(output_name)
            .unwrap_or_default();
        self.workspace_layout.workspace_set_monitor_tile(
            output_name,
            output_id,
            window_id,
            zone,
            bounds,
        )
    }

    fn workspace_remove_monitor_tile(&mut self, window_id: u32) -> bool {
        self.workspace_layout.workspace_remove_monitor_tile(window_id)
    }

    fn workspace_set_auto_layout_tiles_for_output(
        &mut self,
        output_name: &str,
        frame_rects: &HashMap<u32, Rectangle<i32, Logical>>,
    ) -> bool {
        let output_id = self
            .workspace_output_identity_for_name(output_name)
            .unwrap_or_default();
        self.workspace_layout
            .workspace_set_auto_layout_tiles_for_output(output_name, output_id, frame_rects)
    }

    fn workspace_custom_auto_group_ids_for_output(&self, output_name: &str) -> Vec<String> {
        let mut out = Vec::new();
        for group in &self.workspace_layout.workspace_state.groups {
            let Some(visible_window_id) =
                self.workspace_layout.workspace_state.visible_window_id_for_group(&group.id)
            else {
                continue;
            };
            let Some(info) = self.windows.window_registry.window_info(visible_window_id) else {
                continue;
            };
            if !self.workspace_is_auto_layout_managed_window(&info) {
                continue;
            }
            if self.workspace_window_output_name_for_auto_layout(&info) == output_name {
                out.push(group.id.clone());
            }
        }
        out
    }

    fn workspace_custom_auto_slot_for_group(
        &self,
        group_id: &str,
        slots: &[WorkspaceCustomAutoSlot],
    ) -> Option<usize> {
        let group = self.workspace_layout.workspace_state
            .groups
            .iter()
            .find(|group| group.id == group_id)?;
        slots.iter().position(|slot| {
            group
                .window_ids
                .iter()
                .any(|window_id| self.workspace_window_matches_slot_rules(*window_id, slot))
        })
    }

    fn workspace_custom_auto_assignment(
        &self,
        output_name: &str,
        slots: &[WorkspaceCustomAutoSlot],
    ) -> (Vec<Option<String>>, Vec<String>) {
        let group_ids = self.workspace_custom_auto_group_ids_for_output(output_name);
        let mut slot_groups = vec![None; slots.len()];
        let mut assigned_groups = HashSet::new();
        for group_id in &group_ids {
            let Some(slot_index) = self.workspace_custom_auto_slot_for_group(group_id, slots)
            else {
                continue;
            };
            if slot_groups[slot_index].is_none() {
                slot_groups[slot_index] = Some(group_id.clone());
                assigned_groups.insert(group_id.clone());
            }
        }
        for group_id in &group_ids {
            if assigned_groups.contains(group_id) {
                continue;
            }
            let Some(slot_index) = slot_groups.iter().position(Option::is_none) else {
                continue;
            };
            slot_groups[slot_index] = Some(group_id.clone());
            assigned_groups.insert(group_id.clone());
        }
        let overflow = group_ids
            .into_iter()
            .filter(|group_id| !assigned_groups.contains(group_id))
            .collect();
        (slot_groups, overflow)
    }

    fn workspace_merge_group_into_group(&mut self, source_group_id: &str, target_group_id: &str) {
        self.workspace_layout
            .workspace_merge_group_into_group(source_group_id, target_group_id);
    }

    fn workspace_custom_auto_overflow_target_slot(
        &self,
        slots: &[WorkspaceCustomAutoSlot],
        slot_groups: &[Option<String>],
    ) -> Option<usize> {
        let preferred_slots: Vec<usize> = slot_groups
            .iter()
            .enumerate()
            .filter_map(|(index, group_id)| {
                if group_id.is_none() {
                    return None;
                }
                let slot = slots.get(index)?;
                if slot.rules.is_empty() {
                    return Some(index);
                }
                None
            })
            .collect();
        if let Some(focused) = self.logical_focused_window_id() {
            if let Some(group_id) = group_id_for_window(&self.workspace_layout.workspace_state, focused) {
                if let Some(index) = slot_groups
                    .iter()
                    .position(|slot_group| slot_group.as_deref() == Some(group_id))
                {
                    if preferred_slots.is_empty()
                        || slots.get(index).is_some_and(|slot| slot.rules.is_empty())
                    {
                        return Some(index);
                    }
                }
            }
        }
        if let Some(index) = preferred_slots.last().copied() {
            return Some(index);
        }
        slot_groups.iter().rposition(Option::is_some)
    }

    fn workspace_apply_custom_auto_layout_for_output_name(
        &mut self,
        output_name: &str,
        layout_state: &WorkspaceMonitorLayoutState,
        work_area: Rectangle<i32, Logical>,
    ) -> bool {
        let slots = Self::workspace_custom_auto_slots(layout_state);
        if slots.is_empty() {
            return false;
        }
        let (mut slot_groups, overflow_groups) =
            self.workspace_custom_auto_assignment(output_name, &slots);
        if !overflow_groups.is_empty() {
            let target_slot = self
                .workspace_custom_auto_overflow_target_slot(&slots, &slot_groups)
                .unwrap_or_else(|| slots.len().saturating_sub(1));
            if slot_groups[target_slot].is_none() {
                slot_groups[target_slot] = overflow_groups.first().cloned();
            }
            if let Some(target_group_id) = slot_groups[target_slot].clone() {
                for source_group_id in overflow_groups {
                    if source_group_id != target_group_id {
                        self.workspace_merge_group_into_group(&source_group_id, &target_group_id);
                    }
                }
            }
        }
        let mut frame_rects = HashMap::new();
        let mut entries = Vec::new();
        for (slot_index, group_id) in slot_groups.iter().enumerate() {
            let Some(group_id) = group_id else {
                continue;
            };
            let Some(window_id) = self.workspace_layout.workspace_state.visible_window_id_for_group(group_id) else {
                continue;
            };
            let rect = Self::workspace_custom_auto_frame_rect(&slots[slot_index], work_area);
            frame_rects.insert(window_id, rect);
            entries.push(WorkspaceMonitorTileEntry {
                window_id,
                zone: format!(
                    "custom:{}:{}",
                    layout_state
                        .params
                        .custom_layout_id
                        .as_deref()
                        .unwrap_or("auto"),
                    slots[slot_index].slot_id
                ),
                bounds: WorkspaceRect {
                    x: rect.loc.x,
                    y: rect.loc.y,
                    width: rect.size.w.max(1),
                    height: rect.size.h.max(1),
                },
            });
        }
        entries.sort_by_key(|entry| entry.window_id);
        self.workspace_layout.workspace_state
            .monitor_tiles
            .retain(|monitor| monitor.output_name != output_name);
        if !entries.is_empty() {
            self.workspace_layout.workspace_state
                .monitor_tiles
                .push(WorkspaceMonitorTileState {
                    output_id: self
                        .workspace_output_identity_for_name(output_name)
                        .unwrap_or_default(),
                    output_name: output_name.to_string(),
                    entries,
                });
        }
        for (window_id, frame_rect) in frame_rects {
            let Some(info) = self.windows.window_registry.window_info(window_id) else {
                continue;
            };
            self.workspace_set_pre_tile_geometry(
                window_id,
                WorkspaceRect {
                    x: info.x,
                    y: info.y,
                    width: info.width.max(1),
                    height: info.height.max(1),
                },
            );
            let client_rect = self.workspace_auto_layout_client_rect_from_frame_rect(frame_rect);
            let target_x = client_rect.loc.x;
            let target_y = client_rect.loc.y;
            let target_w = client_rect.size.w.max(1);
            let target_h = client_rect.size.h.max(1);
            if self.windows.window_registry.is_shell_hosted(window_id) {
                let snap = self.windows.window_registry
                    .update_shell_hosted(window_id, |window_info, _| {
                        window_info.x = target_x;
                        window_info.y = target_y;
                        window_info.width = target_w;
                        window_info.height = target_h;
                        window_info.output_name = output_name.to_string();
                        window_info.maximized = false;
                        window_info.fullscreen = false;
                        window_info.clone()
                    });
                if let Some(snap) = snap {
                    self.capture_refresh_window_source_cache(window_id);
                    self.shell_backed_emit_geometry_messages(&snap);
                }
                continue;
            }
            self.clear_toplevel_layout_maps(window_id);
            let Some(surface_id) = self.windows.window_registry.surface_id_for_window(window_id) else {
                continue;
            };
            if let Some(window) = self.find_window_by_surface_id(surface_id) {
                let tl = window.toplevel().unwrap();
                tl.with_pending_state(|state| {
                    state.states.unset(xdg_toplevel::State::Fullscreen);
                    state.fullscreen_output = None;
                    state.states.unset(xdg_toplevel::State::Maximized);
                    state.size = Some(Size::from((target_w, target_h)));
                });
                tl.send_pending_configure();
                self.output_topology.space.map_element(
                    DerpSpaceElem::Wayland(window.clone()),
                    (target_x, target_y),
                    false,
                );
                self.shell_emit_requested_native_geometry(
                    window_id,
                    target_x,
                    target_y,
                    target_w,
                    target_h,
                    output_name.to_string(),
                    false,
                    false,
                );
                continue;
            }
            let Some(x11) = self.find_x11_window_by_surface_id(surface_id) else {
                continue;
            };
            let rect = Rectangle::new(client_rect.loc, client_rect.size);
            self.apply_x11_window_bounds(window_id, &x11, rect, false, false, false);
        }
        self.workspace_send_state();
        true
    }

    pub(crate) fn workspace_apply_auto_layout_for_output_name(
        &mut self,
        output_name: &str,
    ) -> bool {
        let Some(layout_state) = self
            .workspace_monitor_layout_state_for_output(output_name)
            .cloned()
        else {
            return false;
        };
        if layout_state.layout == WorkspaceMonitorLayoutType::ManualSnap {
            return false;
        }
        let Some(output) = self.output_topology.space
            .outputs()
            .find(|entry| entry.name() == output_name)
            .cloned()
        else {
            return false;
        };
        let Some(work_area) = self.workspace_auto_layout_frame_area_for_output(&output) else {
            return false;
        };
        if layout_state.layout == WorkspaceMonitorLayoutType::CustomAuto {
            return self.workspace_apply_custom_auto_layout_for_output_name(
                output_name,
                &layout_state,
                work_area,
            );
        }
        let window_ids = self.workspace_auto_layout_window_ids_for_output(output_name, None);
        let frame_rects =
            self.workspace_compute_auto_layout_frame_rects(&layout_state, &window_ids, work_area);
        self.workspace_set_auto_layout_tiles_for_output(output_name, &frame_rects);
        for window_id in window_ids {
            let Some(info) = self.windows.window_registry.window_info(window_id) else {
                continue;
            };
            self.workspace_set_pre_tile_geometry(
                window_id,
                WorkspaceRect {
                    x: info.x,
                    y: info.y,
                    width: info.width.max(1),
                    height: info.height.max(1),
                },
            );
            let Some(frame_rect) = frame_rects.get(&window_id).copied() else {
                continue;
            };
            let client_rect = self.workspace_auto_layout_client_rect_from_frame_rect(frame_rect);
            let target_x = client_rect.loc.x;
            let target_y = client_rect.loc.y;
            let target_w = client_rect.size.w.max(1);
            let target_h = client_rect.size.h.max(1);
            let already_applied = info.x == target_x
                && info.y == target_y
                && info.width == target_w
                && info.height == target_h
                && info.output_name == output_name
                && !info.maximized
                && !info.fullscreen;
            if self.windows.window_registry.is_shell_hosted(window_id) {
                if already_applied {
                    continue;
                }
                let snap = self.windows.window_registry
                    .update_shell_hosted(window_id, |window_info, _| {
                        window_info.x = target_x;
                        window_info.y = target_y;
                        window_info.width = target_w;
                        window_info.height = target_h;
                        window_info.output_name = output_name.to_string();
                        window_info.maximized = false;
                        window_info.fullscreen = false;
                        window_info.clone()
                    });
                if let Some(snap) = snap {
                    self.capture_refresh_window_source_cache(window_id);
                    self.shell_backed_emit_geometry_messages(&snap);
                }
                continue;
            }
            self.clear_toplevel_layout_maps(window_id);
            let Some(surface_id) = self.windows.window_registry.surface_id_for_window(window_id) else {
                continue;
            };
            if let Some(window) = self.find_window_by_surface_id(surface_id) {
                if already_applied {
                    continue;
                }
                let tl = window.toplevel().unwrap();
                tl.with_pending_state(|state| {
                    state.states.unset(xdg_toplevel::State::Fullscreen);
                    state.fullscreen_output = None;
                    state.states.unset(xdg_toplevel::State::Maximized);
                    state.size = Some(Size::from((target_w, target_h)));
                });
                tl.send_pending_configure();
                self.output_topology.space.map_element(
                    DerpSpaceElem::Wayland(window.clone()),
                    (target_x, target_y),
                    false,
                );
                self.shell_emit_requested_native_geometry(
                    window_id,
                    target_x,
                    target_y,
                    target_w,
                    target_h,
                    output_name.to_string(),
                    false,
                    false,
                );
                continue;
            }
            let Some(x11) = self.find_x11_window_by_surface_id(surface_id) else {
                continue;
            };
            let rect = Rectangle::new(client_rect.loc, client_rect.size);
            self.apply_x11_window_bounds(window_id, &x11, rect, false, false, false);
        }
        self.workspace_send_state();
        true
    }

    fn workspace_apply_auto_layout_for_all_outputs(&mut self) -> bool {
        let output_names = self.workspace_layout.workspace_auto_layout_output_names();
        let mut applied = false;
        for output_name in output_names {
            if self.workspace_apply_auto_layout_for_output_name(&output_name) {
                applied = true;
            }
        }
        applied
    }

    fn workspace_relayout_auto_layout_outputs_after_geometry(
        &mut self,
        previous_output_name: &str,
        next_output_name: &str,
    ) {
        if !previous_output_name.is_empty() {
            let _ = self.workspace_apply_auto_layout_for_output_name(previous_output_name);
        }
        if !next_output_name.is_empty() && next_output_name != previous_output_name {
            let _ = self.workspace_apply_auto_layout_for_output_name(next_output_name);
        }
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

    fn keyboard_layout_should_track_window(&self, wid: u32) -> bool {
        self.windows.window_registry
            .window_info(wid)
            .map(|i| !self.window_info_is_solid_shell_host(&i))
            .unwrap_or(false)
    }

    pub(crate) fn keyboard_layout_index_current(&mut self) -> u32 {
        let Some(kbd) = self.input_routing.seat.get_keyboard() else {
            return 0;
        };
        kbd.with_xkb_state(self, |ctx| match ctx.xkb().lock() {
            Ok(xkb) => xkb.active_layout().0,
            Err(_) => 0,
        })
    }

    fn keyboard_layout_set_index(&mut self, idx: u32) {
        let Some(kbd) = self.input_routing.seat.get_keyboard() else {
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
        let kbd = self.input_routing.seat.get_keyboard().unwrap();
        kbd.with_xkb_state(self, |ctx| {
            let xkb = ctx.xkb().lock().unwrap();
            let layout = xkb.active_layout();
            xkb.layout_name(layout).to_string()
        })
    }

    pub(crate) fn emit_keyboard_layout_to_shell(&mut self) {
        let raw = self.keyboard_layout_active_name_raw();
        let label = InputRoutingState::keyboard_layout_label_short(&raw);
        self.input_routing.shell_keyboard_layout_label = label.clone();
        self.shell_emit_chrome_event(ChromeEvent::KeyboardLayout { label });
    }

    pub(crate) fn keyboard_on_focus_surface_changed(&mut self, focused: Option<&WlSurface>) {
        let new_wid = focused.and_then(|s| self.windows.window_registry.window_id_for_wl_surface(s));
        let shell_host = new_wid
            .and_then(|w| self.windows.window_registry.window_info(w))
            .map(|i| self.window_info_is_solid_shell_host(&i))
            .unwrap_or(false);
        let tracked: HashSet<u32> = self
            .windows
            .window_registry
            .all_infos()
            .into_iter()
            .filter(|info| !self.window_info_is_solid_shell_host(info))
            .map(|info| info.window_id)
            .collect();
        self.input_routing
            .queue_keyboard_focus_change(new_wid, shell_host, |window_id| {
                tracked.contains(&window_id)
            });
        let tx = self.shell_osr.cef_to_compositor_tx.clone();
        let _ = tx.send(crate::cef::compositor_tx::CefToCompositor::Run(Box::new(
            |state| {
                state.keyboard_drain_focus_layout_queue();
            },
        )));
    }

    fn keyboard_drain_focus_layout_queue(&mut self) {
        while let Some(op) = self.input_routing.keyboard_layout_focus_queue.pop_front() {
            if let Some(w) = op.save_from {
                let idx = self.keyboard_layout_index_current();
                self.input_routing.keyboard_save_layout_for_window(w, idx);
            }
            if let Some(w) = op.restore_for {
                let idx = self.input_routing.keyboard_layout_for_window_or_default(
                    w,
                    self.workspace_layout.session_default_layout_index,
                );
                self.keyboard_layout_set_index(idx);
            } else if op.shell_host || op.save_from.is_some() {
                self.keyboard_layout_set_index(self.workspace_layout.session_default_layout_index);
            }
            self.emit_keyboard_layout_to_shell();
        }
    }

    pub(crate) fn keyboard_cycle_layout_for_shortcut(&mut self) {
        let Some(kbd) = self.input_routing.seat.get_keyboard() else {
            return;
        };
        let idx = kbd.with_xkb_state(self, |mut ctx| {
            ctx.cycle_next_layout();
            let xkb = ctx.xkb().lock().unwrap();
            xkb.active_layout().0
        });
        if let Some(wid) = self.keyboard_focused_window_id() {
            if self.keyboard_layout_should_track_window(wid) {
                self.input_routing.keyboard_save_layout_for_window(wid, idx);
            }
        }
        self.emit_keyboard_layout_to_shell();
    }

    pub(crate) fn xdg_sync_pending_deferred_toplevel(&mut self, root: &WlSurface) {
        let Some(key) = crate::window_registry::wl_surface_key(root) else {
            return;
        };
        if !self.windows.pending_deferred_toplevels.contains_key(&key) {
            return;
        }
        {
            let pending = self.windows.pending_deferred_toplevels
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
            let pending = self.windows.pending_deferred_toplevels.get(&key).expect("checked");
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
            let pending = self.windows.pending_deferred_toplevels.get(&key).expect("checked");
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
            let ident = !app_id.trim().is_empty();
            let geo = pending.window.geometry();
            let matches_initial_rect = pending.initial_client_rect.is_none_or(|rect| {
                geo.size.w == rect.size.w.max(1) && geo.size.h == rect.size.h.max(1)
            });
            let retry_initial_resize = ident
                && has_buffer_extent
                && pending.initial_client_rect.is_some()
                && !matches_initial_rect;
            let ready = ident && has_buffer_extent && matches_initial_rect;
            (ready, title, app_id, retry_initial_resize)
        };
        if retry_initial_resize {
            let pending = self.windows.pending_deferred_toplevels.get(&key).expect("checked");
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
            let pending = self.windows.pending_deferred_toplevels.remove(&key).unwrap();
            let wl0 = pending.window.toplevel().unwrap().wl_surface();
            let _ = self.windows.window_registry.set_title(wl0, title);
            let _ = self.windows.window_registry.set_app_id(wl0, app_id);
            let wl0 = wl0.clone();
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
                let _ = self.windows.window_registry
                    .transition(window_id, WindowLifecycleEvent::Map);
            }
            self.notify_geometry_if_changed(&pending.window);
            let info = self.windows.window_registry
                .snapshot_for_wl_surface(&wl0)
                .expect("pending map: registry row");
            let spawn_focus_wid = info.window_id;
            self.scratchpad_consider_window(spawn_focus_wid);
            let current_info = self.windows.window_registry
                .window_info(spawn_focus_wid)
                .unwrap_or(info);
            let output_name = current_info.output_name.clone();
            let pending_activation_focus =
                self.windows.shell_pending_native_focus_window_id == Some(spawn_focus_wid);
            if !(self.workspace_layout.scratchpad_windows.contains_key(&spawn_focus_wid) && current_info.minimized) {
                self.shell_emit_chrome_event(ChromeEvent::WindowMapped { info: current_info });
            }
            if !self.workspace_layout.scratchpad_windows.contains_key(&spawn_focus_wid) {
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

    pub(crate) fn window_id_is_deferred_initial_map(&self, window_id: u32) -> bool {
        self.windows.window_registry
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
        let mut layout_w = gw;
        let mut layout_h = gh;
        let mut layout_max = max;
        let mut layout_fs = fs;
        let mut pending_output_name = None;
        if let Some(pending) = self.windows.shell_pending_native_configure_frames
            .get(&window_id)
            .cloned()
        {
            if pending.x == gx
                && pending.y == gy
                && pending.width == gw
                && pending.height == gh
                && pending.maximized == max
                && pending.fullscreen == fs
            {
                self.windows.shell_pending_native_configure_frames
                    .remove(&window_id);
                pending_output_name = Some(pending.output_name);
            } else {
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
        let output_name = pending_output_name.unwrap_or_else(|| {
            self.output_for_window_position(gx, gy, layout_w, layout_h)
                .unwrap_or_default()
        });
        let changed = self.windows.window_registry
            .set_shell_layout(wl, gx, gy, layout_w, layout_h, output_name);
        self.capture_refresh_window_source_cache(window_id);
        let tiling_changed = self.windows.window_registry
            .set_tiling_state(wl, layout_max, layout_fs)
            .unwrap_or(false);
        let layout_or_tiling = changed == Some(true) || tiling_changed;
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
        let snapshot = self.windows.window_registry.update_native(window_id, |info| {
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
        let _ = self.windows.window_registry
            .set_shell_layout(wl, gx, gy, gw, gh, output_name);
        if let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl) {
            self.capture_refresh_window_source_cache(window_id);
        }
        let (max, fs) = read_toplevel_tiling(wl);
        let _ = self.windows.window_registry.set_tiling_state(wl, max, fs);
    }

    pub(crate) fn resync_wayland_window_registry_from_space(&mut self) {
        let wins: Vec<Window> = self.output_topology.space
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
        self.shell_move_deferred_cancel(Some(window_id));
        if self.input_routing.shell_move_window_id == Some(window_id) {
            if self.windows.window_registry.is_shell_hosted(window_id) {
                self.shell_move_end_backed_only(window_id);
            } else {
                self.shell_move_end(window_id);
            }
        }
        if self.input_routing.shell_resize_window_id == Some(window_id) {
            if self.windows.window_registry.is_shell_hosted(window_id) {
                self.shell_resize_end_backed_only(window_id);
            } else {
                self.shell_resize_end(window_id);
            }
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
        let g = self.output_topology.space.output_geometry(output)?;
        let th = self.shell_osr.shell_chrome_titlebar_h.max(0);
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
        let (geo, output_name) = {
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
            (g, out.name().to_string())
        };
        let wl = tl.wl_surface();
        let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl) else {
            return false;
        };
        self.windows.pending_gnome_initial_toplevels.remove(&window_id);
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
        self.output_topology.space
            .map_element(DerpSpaceElem::Wayland(window.clone()), (map_x, map_y), true);
        self.output_topology.space
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
        self.windows.pending_gnome_initial_toplevels.remove(&window_id);
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
        self.output_topology.space
            .map_element(DerpSpaceElem::Wayland(window.clone()), (map_x, map_y), true);
        self.output_topology.space
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
        self.windows.pending_gnome_initial_toplevels.remove(&window_id);
        self.cancel_shell_move_resize_for_window(window_id);
        tl.with_pending_state(|st| {
            st.states.unset(xdg_toplevel::State::Maximized);
            st.states.unset(xdg_toplevel::State::Fullscreen);
            st.fullscreen_output = None;
            st.size = Some(Size::from((w, h)));
        });
        self.output_topology.space
            .map_element(DerpSpaceElem::Wayland(window.clone()), (x, y), true);
        self.output_topology.space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        tl.send_pending_configure();
        let output_name = self
            .output_for_window_position(x, y, w, h)
            .unwrap_or_default();
        self.shell_emit_requested_native_geometry(
            window_id,
            x,
            y,
            w,
            h,
            output_name,
            false,
            false,
        );
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
        self.output_topology.space
            .map_element(DerpSpaceElem::Wayland(window.clone()), (x, y), true);
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
        let return_max = self.windows.toplevel_fullscreen_return_maximized.remove(&window_id);
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
            self.output_topology.space
                .map_element(DerpSpaceElem::Wayland(window.clone()), (x, y), true);
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
                self.windows.window_registry
                    .window_info(*window_id)
                    .map(|i| {
                        self.window_info_is_solid_shell_host(&i)
                            || !shell_window_row_should_show(&i)
                    })
                    .unwrap_or(false)
            }
            ChromeEvent::FocusChanged { window_id, .. } => window_id
                .and_then(|w| self.windows.window_registry.window_info(w))
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
        self.shell_force_next_dmabuf_full_damage();
        self.input_routing.keyboard_forget_window(window_id);
        if self.shell_osr.shell_hosted_app_state.remove(&window_id).is_some() {
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
        self.windows.chrome_bridge
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

    pub(crate) fn workspace_logical_bounds(&self) -> Option<Rectangle<i32, Logical>> {
        self.output_topology.workspace_logical_bounds()
    }

    pub(crate) fn wayland_scale_for_shell_ui(shell_ui_scale: f64) -> Scale {
        OutputTopologyState::wayland_scale_for_shell_ui(shell_ui_scale)
    }

    pub(crate) fn wayland_toplevel_map_and_content_for_shell_frame(
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> (i32, i32, i32, i32) {
        (x, y, w, h)
    }

    #[allow(dead_code)]
    pub(crate) fn apply_shell_ui_scale_to_outputs(&mut self) {
        self.output_topology.apply_shell_ui_scale_to_outputs();
    }

    pub(crate) fn set_shell_ui_scale(&mut self, scale: f64) {
        if !self.output_topology.set_shell_ui_scale(scale) {
            return;
        }
        self.apply_xwayland_client_scale();
        self.send_shell_output_layout();
        if !self.output_topology.display_config_save_suppressed {
            self.display_config_request_save();
        }
    }

    pub(crate) fn display_config_request_save(&mut self) {
        self.output_topology.display_config_request_save();
    }

    pub(crate) fn normalize_workspace_to_origin_after_output_removed(&mut self) {
        let elem_targets = self
            .output_topology
            .normalize_workspace_to_origin_after_output_removed();
        self.apply_translated_workspace_elements(elem_targets);
    }

    pub(crate) fn translate_workspace_by(&mut self, dx: i32, dy: i32) {
        let elem_targets = self.output_topology.translate_workspace_by(dx, dy);
        self.apply_translated_workspace_elements(elem_targets);
    }

    fn apply_translated_workspace_elements(&mut self, elem_targets: Vec<(DerpSpaceElem, i32, i32)>) {
        if elem_targets.is_empty() {
            return;
        }
        for (elem, nx, ny) in elem_targets {
            match elem {
                DerpSpaceElem::Wayland(w) => {
                    self.output_topology.space
                        .map_element(DerpSpaceElem::Wayland(w.clone()), (nx, ny), true);
                    self.notify_geometry_for_window(&w, true);
                }
                DerpSpaceElem::X11(x) => {
                    let mut geo = x.geometry();
                    geo.loc.x = nx;
                    geo.loc.y = ny;
                    let _ = x.configure(Some(geo));
                    self.output_topology.space
                        .map_element(DerpSpaceElem::X11(x.clone()), (nx, ny), false);
                }
            }
        }
        self.core.loop_signal.wakeup();
    }

    pub(crate) fn recompute_shell_canvas_from_outputs(&mut self) {
        let prev_phys = self.shell_osr.shell_window_physical_px;
        let Some(update) = self
            .output_topology
            .recompute_shell_canvas_from_outputs(prev_phys)
        else {
            return;
        };
        self.shell_osr.shell_window_physical_px = update.physical_px;
        if update.changed {
            self.shell_osr.shell_dmabuf_dirty_force_full = true;
            tracing::warn!(
                target: "derp_hotplug_shell",
                prev_origin = ?update.prev_origin,
                prev_size = ?update.prev_size,
                prev_phys = ?prev_phys,
                origin = ?update.origin,
                size = ?update.size,
                phys = ?self.shell_osr.shell_window_physical_px,
                "recompute_shell_canvas_from_outputs canvas changed clear_shell_frame"
            );
            self.clear_shell_frame();
            self.shell_nudge_cef_repaint();
        }
    }

    pub(crate) fn leftmost_output(&self) -> Option<Output> {
        self.output_topology.leftmost_output()
    }

    pub(crate) fn output_containing_global_point(&self, p: Point<f64, Logical>) -> Option<Output> {
        self.output_topology.output_containing_global_point(p)
    }

    pub(crate) fn output_for_global_xywh(&self, x: i32, y: i32, w: i32, h: i32) -> Option<Output> {
        self.output_topology.output_for_global_xywh(x, y, w, h)
    }

    pub(crate) fn output_for_window_position(
        &self,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> Option<String> {
        self.output_topology.output_for_window_position(x, y, w, h)
    }

    #[allow(dead_code)]
    fn snapshot_output_geometry_by_name(&self) -> HashMap<String, Rectangle<i32, Logical>> {
        self.output_topology.snapshot_output_geometry_by_name()
    }

    fn output_name_for_window_from_geometry_map(
        geos: &HashMap<String, Rectangle<i32, Logical>>,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> Option<String> {
        OutputTopologyState::output_name_for_window_from_geometry_map(geos, x, y, w, h)
    }

    fn shift_mapped_toplevels_for_output_moves(
        &mut self,
        before_outputs: &HashMap<String, Rectangle<i32, Logical>>,
    ) {
        if before_outputs.is_empty() {
            return;
        }
        let mut deltas: HashMap<String, (i32, i32)> = HashMap::new();
        for o in self.output_topology.space.outputs() {
            let name: String = o.name().into();
            let Some(bg) = before_outputs.get(&name) else {
                continue;
            };
            let Some(ag) = self.output_topology.space.output_geometry(o) else {
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
        let elems: Vec<DerpSpaceElem> = self.output_topology.space.elements().cloned().collect();
        for e in elems {
            match e {
                DerpSpaceElem::Wayland(w) => {
                    let Some(tl) = w.toplevel() else {
                        continue;
                    };
                    let wl = tl.wl_surface();
                    let Some(info) = self.windows.window_registry.snapshot_for_wl_surface(wl) else {
                        continue;
                    };
                    if self.window_info_is_solid_shell_host(&info) {
                        continue;
                    }
                    let elem = DerpSpaceElem::Wayland(w.clone());
                    let Some(loc) = self.output_topology.space.element_location(&elem) else {
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
                    self.output_topology.space
                        .map_element(DerpSpaceElem::Wayland(w.clone()), (nx, ny), true);
                    self.notify_geometry_for_window(&w, true);
                }
                DerpSpaceElem::X11(x) => {
                    let elem = DerpSpaceElem::X11(x.clone());
                    let Some(loc) = self.output_topology.space.element_location(&elem) else {
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
                    self.output_topology.space
                        .map_element(DerpSpaceElem::X11(x.clone()), (nx, ny), false);
                }
            }
        }
        self.core.loop_signal.wakeup();
    }

    pub(crate) fn pick_nearest_surviving_output(&self, remove: &Output) -> Option<Output> {
        self.output_topology.pick_nearest_surviving_output(remove)
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
        let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl) else {
            return;
        };
        self.clear_toplevel_layout_maps(window_id);
        self.cancel_shell_move_resize_for_window(window_id);
        self.windows.toplevel_fullscreen_return_maximized.remove(&window_id);
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
        self.output_topology.space
            .map_element(DerpSpaceElem::Wayland(window.clone()), (map_x, map_y), true);
        self.output_topology.space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        tl.send_pending_configure();
        let tn = target.name().to_string();
        self.shell_emit_requested_native_geometry(
            window_id,
            map_x,
            map_y,
            content_w,
            content_h,
            tn,
            false,
            false,
        );
        self.capture_refresh_window_source_cache(window_id);
    }

    fn migrate_x11_surface_to_work_area(
        &mut self,
        x: &X11Surface,
        target_work: &Rectangle<i32, Logical>,
    ) {
        let elem = DerpSpaceElem::X11(x.clone());
        let Some(_loc) = self.output_topology.space.element_location(&elem) else {
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
        self.output_topology.space
            .map_element(DerpSpaceElem::X11(x.clone()), (nx, ny), false);
        self.core.loop_signal.wakeup();
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
        let elems: Vec<DerpSpaceElem> = self.output_topology.space.elements().cloned().collect();
        for e in elems {
            let DerpSpaceElem::Wayland(window) = e else {
                continue;
            };
            let Some(tl) = window.toplevel() else {
                continue;
            };
            let wl = tl.wl_surface();
            let Some(info) = self.windows.window_registry.snapshot_for_wl_surface(wl) else {
                continue;
            };
            if self.window_info_is_solid_shell_host(&info) {
                continue;
            }
            let elem = DerpSpaceElem::Wayland(window.clone());
            let Some(loc) = self.output_topology.space.element_location(&elem) else {
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
        let x11_to_move: Vec<X11Surface> = self.output_topology.space
            .elements()
            .filter_map(|e| {
                let DerpSpaceElem::X11(x) = e else {
                    return None;
                };
                let elem = DerpSpaceElem::X11(x.clone());
                let loc = self.output_topology.space.element_location(&elem)?;
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

    fn shell_clear_stale_primary_output(&mut self) -> bool {
        self.output_topology.shell_clear_stale_primary_output()
    }

    fn shell_output_layout_message(
        &mut self,
    ) -> Option<shell_wire::DecodedCompositorToShellMessage> {
        self.shell_output_layout_message_with_revision(true)
    }

    fn shell_output_layout_snapshot_message(
        &mut self,
    ) -> Option<shell_wire::DecodedCompositorToShellMessage> {
        self.shell_output_layout_message_with_revision(false)
    }

    fn shell_output_layout_message_with_revision(
        &mut self,
        bump_revision: bool,
    ) -> Option<shell_wire::DecodedCompositorToShellMessage> {
        self.recompute_shell_canvas_from_outputs();
        self.output_topology.shell_output_layout_message_with_revision(
            bump_revision,
            self.shell_osr.shell_window_physical_px,
        )
    }

    pub(crate) fn shell_output_identity(output: &Output) -> String {
        OutputTopologyState::shell_output_identity(output)
    }

    pub(crate) fn workspace_output_identity_for_name(&self, output_name: &str) -> Option<String> {
        self.output_topology
            .workspace_output_identity_for_name(output_name)
    }

    pub(crate) fn set_output_vrr_states<I>(&mut self, states: I)
    where
        I: IntoIterator<Item = (String, bool, bool)>,
    {
        self.output_topology.set_output_vrr_states(states);
    }

    pub(crate) fn set_output_vrr_state(&mut self, name: String, supported: bool, enabled: bool) {
        self.output_topology
            .set_output_vrr_state(name, supported, enabled);
    }

    pub(crate) fn output_vrr_state(&self, name: &str) -> (bool, bool) {
        self.output_topology.output_vrr_state(name)
    }

    pub(crate) fn set_output_flip_state(
        &mut self,
        name: String,
        mode: impl Into<String>,
        fallback_reason: Option<String>,
    ) {
        self.output_topology
            .set_output_flip_state(name, mode, fallback_reason);
    }

    pub(crate) fn output_flip_state(&self, name: &str) -> (String, Option<String>) {
        self.output_topology.output_flip_state(name)
    }

    pub(crate) fn taskbar_side_for_output_name(&self, name: &str) -> ShellTaskbarSide {
        self.output_topology.taskbar_side_for_output_name(name)
    }

    pub fn set_taskbar_auto_hide(&mut self, enabled: bool) {
        if !self
            .output_topology
            .set_taskbar_auto_hide(enabled)
            .needs_side_effects()
        {
            return;
        }
        self.refresh_taskbar_dependent_window_layouts();
        self.resync_embedded_shell_host_after_ipc_connect();
        self.send_shell_output_layout();
        self.display_config_request_save();
    }

    pub fn set_taskbar_side(&mut self, output_name: String, side: ShellTaskbarSide) {
        if !self
            .output_topology
            .set_taskbar_side(output_name, side)
            .needs_side_effects()
        {
            return;
        }
        self.refresh_taskbar_dependent_window_layouts();
        self.resync_embedded_shell_host_after_ipc_connect();
        self.send_shell_output_layout();
        self.display_config_request_save();
    }

    fn refresh_taskbar_dependent_window_layouts(&mut self) {
        self.workspace_apply_auto_layout_for_all_outputs();
        let maximized: Vec<_> = self.windows.window_registry
            .all_records()
            .into_iter()
            .filter(|record| record.info.maximized && !record.info.minimized)
            .map(|record| record.info.window_id)
            .collect();
        let mut changed = false;
        for window_id in maximized {
            if self.windows.window_registry.is_shell_hosted(window_id) {
                changed |= self.shell_backed_set_window_maximized_if_any(window_id, true);
                continue;
            }
            let Some(surface_id) = self.windows.window_registry.surface_id_for_window(window_id) else {
                continue;
            };
            if let Some(window) = self.find_window_by_surface_id(surface_id) {
                changed |= self.apply_toplevel_maximize_layout(&window);
                continue;
            }
            let Some(x11) = self.find_x11_window_by_surface_id(surface_id) else {
                continue;
            };
            let Some(output) = self.x11_target_output(window_id) else {
                continue;
            };
            let Some(rect) = self.shell_maximize_work_area_global_for_output(&output) else {
                continue;
            };
            changed |= self.apply_x11_window_bounds(window_id, &x11, rect, true, false, true);
        }
        if changed {
            self.shell_reply_window_list();
        }
    }

    pub fn send_shell_output_layout(&mut self) {
        let cleared_stale_primary = self.shell_clear_stale_primary_output();
        let Some(msg) = self.shell_output_layout_message() else {
            tracing::warn!(
                target: "derp_hotplug_shell",
                cleared_stale_primary,
                "send_shell_output_layout abort no workspace_logical_bounds"
            );
            if cleared_stale_primary {
                self.resync_embedded_shell_host_after_ipc_connect();
            }
            return;
        };
        let shell_wire::DecodedCompositorToShellMessage::OutputLayout {
            revision: _,
            canvas_logical_w,
            canvas_logical_h,
            canvas_physical_w,
            canvas_physical_h,
            screens,
            shell_chrome_primary,
            taskbar_auto_hide,
        } = &msg
        else {
            return;
        };
        let screen_names: Vec<&str> = screens.iter().map(|s| s.name.as_str()).collect();
        tracing::warn!(
            target: "derp_hotplug_shell",
            lw = *canvas_logical_w,
            lh = *canvas_logical_h,
            physical_w = *canvas_physical_w,
            physical_h = *canvas_physical_h,
            n_screens = screens.len(),
            ?screen_names,
            primary = ?shell_chrome_primary,
            taskbar_auto_hide = *taskbar_auto_hide,
            suppressed = self.output_topology.display_config_save_suppressed,
            "send_shell_output_layout shell_send_to_cef OutputLayout"
        );
        self.shell_send_to_cef(msg);
        if cleared_stale_primary {
            self.resync_embedded_shell_host_after_ipc_connect();
        }
    }

    pub(crate) fn shell_after_drm_topology_changed(&mut self) {
        self.shell_resize_end_active();
        self.shell_move_end_active();
        self.shell_osr.shell_exclusion_zones_need_full_damage = true;
        self.shell_osr.shell_dmabuf_dirty_force_full = true;
        self.backdrop_layers_by_output.clear();
        let output_names: Vec<String> = self.output_topology.space.outputs().map(|o| o.name().into()).collect();
        tracing::warn!(
            target: "derp_hotplug_shell",
            ?output_names,
            primary = ?self.output_topology.shell_primary_output_name,
            cef = self.shell_cef_active(),
            has_frame = self.shell_osr.shell_has_frame,
            "shell_after_drm_topology_changed enter"
        );
        self.send_shell_output_layout();
        self.shell_seed_initial_pointer_position();
        self.shell_reply_window_list();
        self.shell_nudge_cef_repaint();
        tracing::warn!(
            target: "derp_hotplug_shell",
            has_frame = self.shell_osr.shell_has_frame,
            "shell_after_drm_topology_changed exit"
        );
    }

    pub fn set_shell_primary_output_name(&mut self, name: String) {
        if !self
            .output_topology
            .set_shell_primary_output_name(name)
            .needs_side_effects()
        {
            return;
        }
        self.resync_embedded_shell_host_after_ipc_connect();
        self.send_shell_output_layout();
        self.display_config_request_save();
    }

    pub fn apply_shell_output_layout_json(&mut self, json: &str) {
        let Some(before_outputs) = self.output_topology.apply_shell_output_layout_json(json) else {
            return;
        };
        self.shift_mapped_toplevels_for_output_moves(&before_outputs);
        self.resync_wayland_window_registry_from_space();
        self.workspace_apply_auto_layout_for_all_outputs();
        self.recompute_shell_canvas_from_outputs();
        self.send_shell_output_layout();
        self.display_config_request_save();
    }

    /// Logical size matching [`Space::output_geometry`] / pointer normalization (not raw `current_mode` when they differ).
    pub fn shell_output_logical_size(&self) -> Option<(u32, u32)> {
        self.output_topology.shell_output_logical_size()
    }

    pub fn send_shell_output_geometry(&mut self) {
        self.send_shell_output_layout();
    }

    /// Embedded shell IPC: first full handshake after [`Space::map_output`] so output geometry is non-empty.
    pub fn shell_embedded_notify_output_ready(&mut self) {
        let output_ready = self.shell_output_logical_size().is_some();
        let cef_active = self.shell_cef_active();
        self.shell_osr
            .shell_embedded_notify_output_ready(output_ready, cef_active);
    }

    /// After shell Unix `SO_PEERCRED` is set: snap host toplevel(s) to the output origin and drop any HUD row
    /// from an early map (Wayland before shell IPC).
    pub(crate) fn resync_embedded_shell_host_after_ipc_connect(&mut self) {
        if self.shell_osr.shell_ipc_peer_pid.is_none() && !self.shell_cef_active() {
            return;
        }
        let host_ids: Vec<u32> = self.windows.window_registry
            .all_infos()
            .into_iter()
            .filter(|i| self.window_info_is_solid_shell_host(i))
            .map(|i| i.window_id)
            .collect();
        for wid in host_ids {
            self.shell_retract_phantom_shell_window(wid);
            let Some(sid) = self.windows.window_registry.surface_id_for_window(wid) else {
                continue;
            };
            let Some(window) = self.find_window_by_surface_id(sid) else {
                continue;
            };
            let (ox, oy) = self.primary_output_logical_origin();
            self.output_topology.space
                .map_element(DerpSpaceElem::Wayland(window.clone()), (ox, oy), true);
            self.notify_geometry_if_changed(&window);
        }
    }

    /// Full sync when `cef_host` connects: output size, all mapped windows, current focus (IPC only).
    pub fn shell_on_shell_client_connected(&mut self) {
        self.shell_osr.shell_on_shell_client_connected();
        self.send_shell_output_geometry();
        self.resync_embedded_shell_host_after_ipc_connect();
        self.shell_reply_window_list();
        self.emit_keyboard_layout_to_shell();
        self.shell_hosted_app_state_send();
        self.shell_send_to_cef(
            shell_wire::DecodedCompositorToShellMessage::CommandPaletteState {
                revision: self.session_services.command_palette_revision(),
                state_json: self.command_palette_state_value().to_string(),
            },
        );
        self.shell_send_to_cef(self.notifications_state_message());
        let window_id = self.logical_focused_window_id();
        let surface_id = window_id.and_then(|w| self.windows.window_registry.surface_id_for_window(w));
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id,
            window_id,
        });
        self.sync_tray_hints_to_shell();
    }

    pub(crate) fn shell_ipc_on_shell_load_success(&mut self) {
        self.shell_osr.shell_ipc_on_shell_load_success();
        if self.input_routing.programs_menu_take_pending_toggle() {
            self.programs_menu_toggle_from_super(SERIAL_COUNTER.next_serial());
        }
        self.emit_keyboard_layout_to_shell();
    }

    pub(crate) fn sync_tray_hints_to_shell(&mut self) {
        self.shell_send_to_cef(self.shell_tray_hints_message());
    }

    pub(crate) fn on_notifications_state_updated(&mut self, state_json: String) {
        let state_json = self
            .tray_notifications
            .update_notifications_state_json(state_json);
        self.shell_send_to_cef(
            shell_wire::DecodedCompositorToShellMessage::NotificationsState { state_json },
        );
    }

    pub(crate) fn on_notification_event(
        &mut self,
        event: crate::notifications::NotificationEventPayload,
    ) {
        self.shell_send_to_cef(
            shell_wire::DecodedCompositorToShellMessage::NotificationEvent {
                notification_id: event.notification_id,
                event_type: event.event_type,
                action_key: event.action_key,
                close_reason: event.close_reason,
                source: event.source,
            },
        );
    }

    pub(crate) fn notifications_state_message(
        &self,
    ) -> shell_wire::DecodedCompositorToShellMessage {
        self.tray_notifications.notifications_state_message()
    }

    pub(crate) fn notifications_state_json(&self) -> String {
        self.tray_notifications.notifications_state_json()
    }

    pub(crate) fn notifications_set_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.tray_notifications.notifications_set_enabled(enabled)
    }

    pub(crate) fn notifications_shell_notify(
        &mut self,
        request: crate::notifications::ShellNotificationRequest,
    ) -> Result<u32, String> {
        self.tray_notifications.notifications_shell_notify(request)
    }

    pub(crate) fn notifications_close(&mut self, id: u32, reason: u32, source: String) {
        self.tray_notifications
            .notifications_close(id, reason, source);
    }

    pub(crate) fn notifications_invoke_action(
        &mut self,
        id: u32,
        action_key: String,
        source: String,
    ) {
        self.tray_notifications
            .notifications_invoke_action(id, action_key, source);
    }

    fn tray_hidden_x11_window_id_for_sni_item(&self, id: &str) -> Option<u32> {
        let records: Vec<WindowInfo> = self.windows.window_registry
            .all_records()
            .into_iter()
            .filter(|record| record.kind == WindowKind::Native)
            .map(|record| record.info)
            .collect();
        self.tray_notifications
            .hidden_x11_window_id_for_sni_item(id, records.iter())
    }

    pub(crate) fn on_sni_tray_items_updated(&mut self, items: Vec<shell_wire::TraySniItemWire>) {
        let live_pids: HashSet<i32> = self.windows.window_registry
            .all_records()
            .into_iter()
            .filter(|record| record.kind == WindowKind::Native)
            .filter_map(|record| record.info.wayland_client_pid)
            .collect();
        let items = self
            .tray_notifications
            .update_sni_tray_items(items, &live_pids);
        self.refresh_tray_hidden_x11_notifier_window_ids();
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::TraySni { items });
        self.sync_tray_hints_to_shell();
    }

    pub(crate) fn on_sni_tray_menu_updated(&mut self, menu: shell_wire::TraySniMenuWire) {
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::TraySniMenu { menu });
    }

    pub(crate) fn sni_tray_activate_clicked(&mut self, id: String) {
        self.tray_notifications.sni_tray_activate_clicked(id.clone());
        let fallback_window_id = self.tray_notifications.single_hidden_x11_window_id();
        if let Some(window_id) = self
            .tray_hidden_x11_window_id_for_sni_item(&id)
            .or(fallback_window_id)
        {
            let _ = self.shell_restore_tray_hidden_x11_window_to_space(window_id);
        }
    }

    pub(crate) fn sni_tray_open_menu(&mut self, id: String, request_serial: u32) {
        self.tray_notifications.sni_tray_open_menu(id, request_serial);
    }

    pub(crate) fn sni_tray_menu_event(&mut self, id: String, menu_path: String, item_id: i32) {
        self.tray_notifications
            .sni_tray_menu_event(id, menu_path, item_id);
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
        self.shell_osr.shell_exclusion_overlay_open && self.shell_point_in_shell_floating_overlay_global(pos)
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

    pub fn find_window_by_surface_id(&self, surface_id: u32) -> Option<Window> {
        self.windows
            .find_window_by_surface_id(&self.output_topology.space, surface_id)
    }

    fn x11_window_id_for_surface(&self, window: &X11Surface) -> Option<u32> {
        self.windows.x11_window_id_for_surface(window)
    }

    pub(crate) fn find_x11_window_by_surface_id(&self, surface_id: u32) -> Option<X11Surface> {
        self.windows
            .find_x11_window_by_surface_id(&self.output_topology.space, surface_id)
    }

    fn find_x11_window_by_window_id(&self, window_id: u32) -> Option<X11Surface> {
        self.windows
            .find_x11_window_by_window_id(&self.output_topology.space, window_id)
    }

    pub(crate) fn xwayland_scale_for_window_id(&self, window_id: u32) -> Option<f64> {
        let x11 = self.find_x11_window_by_window_id(window_id)?;
        Some(self.xwayland_scale_for_space_element(&DerpSpaceElem::X11(x11)))
    }

    fn x11_window_title_app_id(window: &X11Surface) -> (String, String) {
        WindowManagementState::x11_window_title_app_id(window)
    }

    fn x11_window_should_hide_to_tray_on_close(&self, info: &WindowInfo) -> bool {
        self.tray_notifications
            .x11_window_should_hide_to_tray_on_close(info)
    }

    fn shell_x11_window_is_tray_hidden(&self, window_id: u32) -> bool {
        self.tray_notifications
            .shell_x11_window_is_tray_hidden(window_id)
    }

    fn remember_tray_hidden_x11_window_id(&mut self, window_id: u32, info: Option<&WindowInfo>) {
        self.tray_notifications
            .remember_tray_hidden_x11_window_id(window_id, info);
    }

    fn forget_tray_hidden_x11_window_id(&mut self, window_id: u32) -> bool {
        self.tray_notifications
            .forget_tray_hidden_x11_window_id(window_id)
    }

    fn refresh_tray_hidden_x11_notifier_window_ids(&mut self) {
        let records: Vec<WindowInfo> = self.windows.window_registry
            .all_records()
            .into_iter()
            .filter(|record| {
                record.kind == WindowKind::Native
                    && self.shell_x11_window_is_tray_hidden(record.info.window_id)
            })
            .map(|record| record.info)
            .collect();
        self.tray_notifications
            .refresh_tray_hidden_x11_notifier_window_ids(records.iter());
    }

    fn shell_hide_x11_window_to_tray(&mut self, window_id: u32, x11: &X11Surface) {
        self.windows.shell_close_pending_native_windows.remove(&window_id);
        self.windows.shell_close_refocus_targets.remove(&window_id);
        let info = self.windows.window_registry.window_info(window_id);
        self.remember_tray_hidden_x11_window_id(window_id, info.as_ref());
        self.tray_notifications.shell_tray_hidden_x11_windows
            .insert(window_id, x11.clone());
        self.windows.shell_known_x11_windows.insert(window_id, x11.clone());
        let _ = self.windows.window_registry
            .set_restore_handle(window_id, RestoreHandle::X11(x11.clone()));
        let _ = self.windows.window_registry
            .transition(window_id, WindowLifecycleEvent::HideToTray);
        if self.windows.shell_pending_native_focus_window_id == Some(window_id) {
            self.windows.shell_pending_native_focus_window_id = None;
        }
        if self.keyboard_focused_window_id() == Some(window_id) {
            let serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Option::<WlSurface>::None, serial);
            self.keyboard_on_focus_surface_changed(None);
        }
        if let Err(error) = x11.set_activated(false) {
            tracing::warn!(window_id, ?error, "x11 set_activated failed");
        }
        if let Err(error) = x11.set_hidden(true) {
            tracing::warn!(window_id, ?error, "x11 set_hidden failed");
        }
        if let Err(error) = x11.set_mapped(false) {
            tracing::warn!(window_id, ?error, "x11 set_mapped(false) failed");
        }
        self.output_topology.space.unmap_elem(&DerpSpaceElem::X11(x11.clone()));
        self.shell_emit_chrome_window_unmapped(
            window_id,
            self.windows.window_registry.window_info(window_id),
        );
        self.shell_force_next_dmabuf_full_damage();
        self.core.loop_signal.wakeup();
    }

    fn shell_restore_tray_hidden_x11_window(&mut self, window_id: u32, x11: &X11Surface) -> bool {
        let had_surface = self.tray_notifications.shell_tray_hidden_x11_windows
            .remove(&window_id)
            .is_some();
        let had_id = self.forget_tray_hidden_x11_window_id(window_id);
        if !had_surface && !had_id {
            return false;
        }
        self.windows.shell_pending_native_focus_window_id = Some(window_id);
        let _ = self.windows.window_registry
            .transition(window_id, WindowLifecycleEvent::Restore);
        self.windows.window_registry.clear_restore_handle(window_id);
        if let Err(error) = x11.set_hidden(false) {
            tracing::warn!(window_id, ?error, "x11 set_hidden(false) failed");
        }
        self.shell_reply_window_list();
        true
    }

    fn shell_restore_tray_hidden_x11_window_to_space(&mut self, window_id: u32) -> bool {
        let Some(x11) = self.tray_notifications.shell_tray_hidden_x11_windows
            .get(&window_id)
            .or_else(|| self.windows.shell_known_x11_windows.get(&window_id))
            .cloned()
        else {
            return false;
        };
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return false;
        };
        if let Err(error) = x11.set_mapped(true) {
            tracing::warn!(window_id, ?error, "x11 set_mapped(true) failed");
            return false;
        }
        let rect = Rectangle::new(
            Point::from((info.x, info.y)),
            Size::from((info.width.max(1), info.height.max(1))),
        );
        if let Err(error) = x11.configure(Some(rect)) {
            tracing::warn!(window_id, ?error, "x11 configure restore failed");
        }
        self.output_topology.space
            .map_element(DerpSpaceElem::X11(x11.clone()), (info.x, info.y), false);
        if !self.shell_restore_tray_hidden_x11_window(window_id, &x11) {
            return false;
        }
        let current_info = self.windows.window_registry.window_info(window_id).unwrap_or(info);
        self.shell_emit_chrome_event(ChromeEvent::WindowMapped { info: current_info });
        self.shell_raise_and_focus_window(window_id);
        self.core.loop_signal.wakeup();
        true
    }

    fn sync_registry_from_x11_surface(&mut self, window: &X11Surface) -> Option<X11SyncResult> {
        let geometry = window.geometry();
        let location = self.output_topology.space
            .element_location(&DerpSpaceElem::X11(window.clone()))
            .unwrap_or(geometry.loc);
        let elem = DerpSpaceElem::X11(window.clone());
        let in_space = self.output_topology.space.elements().any(|e| *e == elem);
        let width = geometry.size.w.max(1);
        let height = geometry.size.h.max(1);
        let output_name = self
            .output_for_window_position(location.x, location.y, width, height);
        let result = self.windows.sync_registry_from_x11_surface(
            window,
            location,
            in_space,
            output_name,
        )?;
        let info = &result.info;
        self.capture_refresh_window_source_cache(info.window_id);
        Some(result)
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
        if self.windows.window_registry
            .window_id_for_wl_surface(surface)
            .is_none()
        {
            let (title, app_id) = Self::x11_window_title_app_id(window);
            let pid = window.pid().and_then(|pid| i32::try_from(pid).ok());
            let window_id = self.windows.window_registry
                .register_toplevel(surface, title, app_id, pid);
            let _ = self.windows.window_registry
                .set_native_backend(window_id, WindowBackend::X11);
        }
        let info = self.emit_x11_window_updates(window, false, true);
        if let Some(info) = &info {
            let elem = DerpSpaceElem::X11(window.clone());
            if self.output_topology.space.elements().any(|e| *e == elem)
                && self.windows.window_registry.lifecycle(info.window_id)
                    != Some(WindowLifecycle::Minimized)
            {
                let _ = self.windows.window_registry
                    .transition(info.window_id, WindowLifecycleEvent::Map);
            }
            self.windows.shell_known_x11_windows
                .insert(info.window_id, window.clone());
        }
        info
    }

    fn cleanup_x11_window(&mut self, window: &X11Surface, emit_unmapped: bool) {
        let Some(surface) = window.wl_surface() else {
            self.output_topology.space.unmap_elem(&DerpSpaceElem::X11(window.clone()));
            return;
        };
        let window_id_pre = self.windows.window_registry.window_id_for_wl_surface(&surface);
        let keyboard_had_focus = window_id_pre
            .is_some_and(|window_id| self.keyboard_focused_window_id() == Some(window_id));
        self.output_topology.space.unmap_elem(&DerpSpaceElem::X11(window.clone()));
        if let Some(window_id) = window_id_pre {
            self.windows.shell_known_x11_windows.remove(&window_id);
            self.clear_toplevel_layout_maps(window_id);
            self.windows.shell_close_pending_native_windows.remove(&window_id);
            self.windows.window_registry.clear_restore_handle(window_id);
            if self.windows.shell_pending_native_focus_window_id == Some(window_id) {
                self.windows.shell_pending_native_focus_window_id = None;
            }
            self.shell_window_stack_forget(window_id);
            self.tray_notifications.shell_tray_hidden_x11_windows.remove(&window_id);
            self.forget_tray_hidden_x11_window_id(window_id);
        }
        let removed = self.windows.window_registry.snapshot_for_wl_surface(&surface);
        if let Some(window_id) = self.windows.window_registry.remove_by_wl_surface(&surface) {
            self.capture_forget_window_source_cache(window_id);
            if emit_unmapped {
                self.shell_emit_chrome_window_unmapped(window_id, removed);
            }
            self.try_refocus_after_closed_window(window_id, keyboard_had_focus);
        }
    }

    pub(crate) fn shell_move_shell_hosted_frame_ready_now(&self, window_id: u32) -> bool {
        if self.shell_osr.shell_focused_ui_window_id != Some(window_id) {
            return false;
        }
        let placements = self.shell_visible_placements();
        let Some(placement) = placements
            .iter()
            .find(|placement| placement.id == window_id)
        else {
            return false;
        };
        let topmost = placements
            .iter()
            .max_by_key(|placement| (self.shell_placement_stack_z(placement), placement.id));
        topmost.is_some_and(|topmost| topmost.id == placement.id)
    }

    fn shell_move_shell_hosted_proxy_visible_now(
        &self,
        info: &WindowInfo,
        placement: &ShellUiWindowPlacement,
    ) -> bool {
        let outer = self.shell_backed_outer_global_rect(info);
        let outer_right = outer.loc.x.saturating_add(outer.size.w);
        let outer_bottom = outer.loc.y.saturating_add(outer.size.h);
        let placement_right = placement
            .global_rect
            .loc
            .x
            .saturating_add(placement.global_rect.size.w);
        let placement_bottom = placement
            .global_rect
            .loc
            .y
            .saturating_add(placement.global_rect.size.h);
        (placement.global_rect.loc.x - outer.loc.x).abs() <= 1
            && (placement.global_rect.loc.y - outer.loc.y).abs() <= 1
            && (placement_right - outer_right).abs() <= 1
            && (placement_bottom - outer_bottom).abs() <= 1
    }

    fn shell_move_proxy_release_ready_now(&self, window_id: u32) -> bool {
        if !self.windows.window_registry.is_shell_hosted(window_id) {
            return true;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return false;
        };
        let Some(placement) = self
            .shell_visible_placements()
            .into_iter()
            .find(|placement| placement.id == window_id)
        else {
            return false;
        };
        let outer = self.shell_backed_outer_global_rect(&info);
        let expected = self
            .workspace_logical_bounds()
            .map(|workspace| {
                Point::from((
                    outer.loc.x.max(workspace.loc.x),
                    outer.loc.y.max(workspace.loc.y),
                ))
            })
            .unwrap_or(outer.loc);
        (placement.global_rect.loc.x - expected.x).abs() <= 1
            && (placement.global_rect.loc.y - expected.y).abs() <= 1
    }

    pub(crate) fn shell_move_deferred_ready(&self, pending: &ShellMoveDeferredStartState) -> bool {
        if self.shell_osr.shell_dmabuf_commit == pending.wait_for_shell_commit {
            return false;
        }
        if self.shell_osr.shell_ui_windows_generation == pending.wait_for_ui_generation {
            return false;
        }
        self.windows.window_registry.is_shell_hosted(pending.window_id)
            && self.shell_move_shell_hosted_frame_ready_now(pending.window_id)
    }

    pub(crate) fn shell_move_deferred_cancel(&mut self, window_id: Option<u32>) {
        self.input_routing.shell_move_deferred_cancel(window_id);
    }

    pub(crate) fn shell_move_deferred_accumulate_delta(&mut self, dx: i32, dy: i32) {
        self.input_routing
            .shell_move_deferred_accumulate_delta(dx, dy);
    }

    pub(crate) fn shell_move_activate_backed_now(
        &mut self,
        window_id: u32,
        initial_pending_delta: (i32, i32),
        pointer_driven: bool,
    ) -> bool {
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return false;
        };
        if !self.windows.window_registry.is_shell_hosted(window_id) || info.minimized {
            return false;
        }
        self.input_routing
            .shell_move_begin_state(window_id, pointer_driven, initial_pending_delta);
        self.shell_move_proxy_cancel(Some(window_id));
        self.shell_keyboard_capture_shell_ui();
        if initial_pending_delta != (0, 0) {
            self.shell_move_flush_pending_deltas_backed();
        }
        self.shell_send_interaction_state();
        true
    }

    pub(crate) fn shell_move_try_activate_deferred(&mut self) {
        let Some(pending) = self.input_routing.shell_move_deferred.take() else {
            return;
        };
        if !self.shell_move_deferred_ready(&pending) {
            self.input_routing.shell_move_deferred = Some(pending);
            return;
        }
        if !self.shell_move_activate_backed_now(pending.window_id, pending.pending_delta, true) {
            self.shell_move_proxy_cancel(Some(pending.window_id));
            self.shell_send_interaction_state();
        }
    }

    pub(crate) fn shell_move_is_active(&self) -> bool {
        self.input_routing.shell_move_is_active()
    }

    pub(crate) fn shell_move_accepts_pointer_delta(&self) -> bool {
        self.input_routing.shell_move_accepts_pointer_delta()
    }

    pub(crate) fn shell_move_end_active(&mut self) {
        let Some(wid) = self.input_routing.shell_move_end_active_window() else {
            return;
        };
        self.shell_move_end(wid);
    }

    pub(crate) fn shell_move_proxy_try_arm_capture(&mut self) {
        let Some(window_id) = self.input_routing.shell_move_proxy.as_ref().map(|proxy| proxy.window_id) else {
            return;
        };
        if self.input_routing.shell_move_proxy.as_ref().is_some_and(|proxy| {
            proxy.pending_capture || proxy.texture.is_some() || proxy.release_state.is_some()
        }) {
            return;
        }
        if self.input_routing.shell_move_proxy
            .as_ref()
            .and_then(|proxy| proxy.arm_after_shell_commit)
            .is_some_and(|commit| commit == self.shell_osr.shell_dmabuf_commit)
        {
            return;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return;
        };
        let shell_hosted = self.windows.window_registry.is_shell_hosted(window_id);
        if shell_hosted {
            let had_proxy = self.input_routing.shell_move_proxy.take().is_some();
            if had_proxy {
                self.shell_send_interaction_state();
            }
            return;
        }
        let visible_placement = self
            .shell_visible_placements()
            .into_iter()
            .find(|placement| placement.id == window_id);
        let request_opaque_source = self.input_routing.shell_move_proxy
            .as_ref()
            .is_some_and(|proxy| proxy.request_opaque_source);
        if shell_hosted && visible_placement.is_none() {
            if request_opaque_source {
                if let Some(proxy) = self.input_routing.shell_move_proxy.as_mut() {
                    proxy.request_opaque_source = false;
                    proxy.arm_after_shell_commit = None;
                }
                self.shell_send_interaction_state();
            }
            return;
        }
        if shell_hosted && !self.shell_move_shell_hosted_frame_ready_now(window_id) {
            if request_opaque_source {
                if let Some(proxy) = self.input_routing.shell_move_proxy.as_mut() {
                    proxy.request_opaque_source = false;
                    proxy.arm_after_shell_commit = None;
                }
                self.shell_send_interaction_state();
            }
            return;
        }
        let native_source_global_rect =
            (!shell_hosted).then(|| self.shell_native_outer_global_rect(&info));
        let native_texture_global_rect = if shell_hosted {
            None
        } else {
            native_source_global_rect.map(|outer| {
                let titlebar_h = info.y.saturating_sub(outer.loc.y).max(1);
                Rectangle::new(outer.loc, Size::from((outer.size.w.max(1), titlebar_h)))
            })
        };
        let native_texture_capture = if shell_hosted {
            None
        } else {
            native_texture_global_rect.and_then(|texture_global_rect| {
                self.shell_global_rect_to_buffer_mapping(&texture_global_rect)
            })
        };
        if !shell_hosted
            && (native_source_global_rect.is_none()
                || native_texture_global_rect.is_none()
                || native_texture_capture.is_none())
        {
            return;
        }
        let shell_hosted_proxy_visible = shell_hosted
            && visible_placement.as_ref().is_some_and(|placement| {
                self.shell_move_shell_hosted_proxy_visible_now(&info, placement)
            });
        if shell_hosted && !shell_hosted_proxy_visible {
            if request_opaque_source {
                if let Some(proxy) = self.input_routing.shell_move_proxy.as_mut() {
                    proxy.request_opaque_source = false;
                    proxy.arm_after_shell_commit = None;
                }
                self.shell_send_interaction_state();
            }
            return;
        }
        let Some(proxy) = self.input_routing.shell_move_proxy.as_mut() else {
            return;
        };
        if shell_hosted && !proxy.request_opaque_source {
            proxy.request_opaque_source = true;
            proxy.arm_after_shell_commit = Some(self.shell_osr.shell_dmabuf_commit);
            self.shell_send_interaction_state();
            return;
        }
        proxy.arm_after_shell_commit = None;
        proxy.source_client_rect = Rectangle::new(
            Point::from((info.x, info.y)),
            Size::from((info.width.max(1), info.height.max(1))),
        );
        if shell_hosted {
            let Some(placement) = visible_placement else {
                return;
            };
            proxy.source_global_rect = Some(placement.global_rect);
            proxy.texture_global_rect = Some(placement.global_rect);
            proxy.source_buffer_rect = Some(placement.buffer_rect);
        } else {
            let Some((capture_texture_global_rect, capture_source_buffer_rect)) =
                native_texture_capture
            else {
                return;
            };
            proxy.source_global_rect = native_source_global_rect;
            proxy.texture_global_rect = Some(capture_texture_global_rect);
            proxy.source_buffer_rect = Some(capture_source_buffer_rect);
        }
        proxy.pending_capture = true;
    }

    pub(crate) fn shell_move_proxy_target_global_rect(&self) -> Option<Rectangle<i32, Logical>> {
        let proxy = self.input_routing.shell_move_proxy.as_ref()?;
        let source_global_rect = proxy.source_global_rect?;
        let info = self.windows.window_registry.window_info(proxy.window_id)?;
        let dx = info.x.saturating_sub(proxy.source_client_rect.loc.x);
        let dy = info.y.saturating_sub(proxy.source_client_rect.loc.y);
        Some(Rectangle::new(
            Point::from((
                source_global_rect.loc.x.saturating_add(dx),
                source_global_rect.loc.y.saturating_add(dy),
            )),
            source_global_rect.size,
        ))
    }

    pub(crate) fn shell_move_proxy_release(&mut self, window_id: u32) {
        let can_keep = self.shell_osr.shell_has_frame && self.shell_osr.shell_frame_is_dmabuf;
        let current_commit = self.shell_osr.shell_dmabuf_commit;
        let Some(proxy) = self.input_routing.shell_move_proxy.as_mut() else {
            return;
        };
        if proxy.window_id != window_id {
            return;
        }
        if proxy.texture.is_none() || !can_keep {
            self.input_routing.shell_move_proxy = None;
            return;
        }
        proxy.release_state = Some(ShellMoveProxyReleaseState::AwaitShellStateCommit(
            current_commit,
        ));
    }

    pub(crate) fn shell_move_proxy_cancel(&mut self, window_id: Option<u32>) {
        if self.input_routing.shell_move_proxy
            .as_ref()
            .is_some_and(|proxy| window_id.is_none() || window_id == Some(proxy.window_id))
        {
            self.input_routing.shell_move_proxy = None;
        }
    }

    fn shell_drag_restore_rect_from_client_frame(
        pointer: Point<f64, Logical>,
        frame_x: i32,
        frame_y: i32,
        frame_w: i32,
        frame_h: i32,
        restore_w: i32,
        restore_h: i32,
    ) -> Rectangle<i32, Logical> {
        let fw = frame_w.max(1) as f64;
        let fh = frame_h.max(1) as f64;
        let rw = restore_w.max(1) as f64;
        let rh = restore_h.max(1) as f64;
        let ox = (pointer.x - frame_x as f64).clamp(0.0, fw);
        let oy = (pointer.y - frame_y as f64).clamp(0.0, fh);
        let rx = ox / fw;
        let ry = oy / fh;
        let clamped_rx = rx.clamp(0.3, 0.7);
        let x = (pointer.x - clamped_rx * rw).round() as i32;
        let y = (pointer.y - ry * rh).round() as i32;
        Rectangle::new(
            Point::from((x, y)),
            Size::from((restore_w.max(1), restore_h.max(1))),
        )
    }

    fn shell_restore_size_for_maximized_drag(
        &self,
        window_id: u32,
        info: &WindowInfo,
        kind: WindowKind,
    ) -> (i32, i32) {
        if kind == WindowKind::ShellHosted {
            if let Some(record) = self.windows.window_registry.window_record(window_id) {
                if let Some(rect) = record.shell_hosted_float_restore {
                    let w = rect.size.w.max(1);
                    let h = rect.size.h.max(1);
                    if w < info.width.saturating_sub(24) || h < info.height.saturating_sub(120) {
                        return (w, h);
                    }
                }
            }
        } else if let Some((_, _, w, h)) = self.windows.toplevel_floating_restore.get(&window_id).copied() {
            let w = w.max(1);
            let h = h.max(1);
            if w < info.width.saturating_sub(24) || h < info.height.saturating_sub(120) {
                return (w, h);
            }
        }
        (
            (info.width.max(1) * 55 / 100).max(360),
            (info.height.max(1) * 55 / 100).max(280),
        )
    }

    fn shell_restore_maximized_drag_window_if_needed(&mut self, window_id: u32) {
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return;
        };
        if info.minimized || info.fullscreen || !info.maximized {
            return;
        }
        let kind = self.windows.window_registry
            .window_kind(window_id)
            .unwrap_or(WindowKind::Native);
        let Some(pointer) = self.input_routing.seat.get_pointer() else {
            return;
        };
        let (restore_w, restore_h) =
            self.shell_restore_size_for_maximized_drag(window_id, &info, kind);
        let rect = Self::shell_drag_restore_rect_from_client_frame(
            pointer.current_location(),
            info.x,
            info.y,
            info.width,
            info.height,
            restore_w,
            restore_h,
        );
        let (ox, oy) = self.output_topology.shell_canvas_logical_origin;
        self.shell_set_window_geometry(
            window_id,
            rect.loc.x.saturating_sub(ox),
            rect.loc.y.saturating_sub(oy),
            rect.size.w,
            rect.size.h,
            0,
        );
        if kind != WindowKind::ShellHosted {
            self.capture_refresh_window_source_cache(window_id);
            self.shell_native_drag_preview_begin(window_id);
        }
    }

    pub fn shell_move_begin(&mut self, window_id: u32) {
        self.shell_move_begin_inner(window_id, true);
    }

    pub fn shell_move_begin_from_shell(&mut self, window_id: u32) {
        self.shell_move_begin_inner(window_id, true);
    }

    fn shell_move_begin_inner(&mut self, window_id: u32, pointer_driven: bool) {
        self.shell_resize_end_active();
        if self.shell_move_try_begin_backed(window_id, pointer_driven) {
            return;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
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
        let Some(sid) = self.windows.window_registry.surface_id_for_window(window_id) else {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_begin: unknown surface (registry)"
            );
            return;
        };

        if self.input_routing.shell_move_window_id == Some(window_id) {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_begin: already active (no-op)"
            );
            return;
        }

        if let Some(prev) = self.input_routing.shell_move_window_id {
            if prev != window_id {
                self.shell_move_end(prev);
            }
        }
        if let Some(window) = self.find_window_by_surface_id(sid) {
            self.output_topology.space
                .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
            let Some(toplevel) = window.toplevel() else {
                return;
            };
            let wl_surface = toplevel.wl_surface().clone();
            let k_serial = SERIAL_COUNTER.next_serial();
            let Some(keyboard) = self.input_routing.seat.get_keyboard() else {
                return;
            };
            keyboard.set_focus(self, Some(wl_surface.clone()), k_serial);
            self.output_topology.space.elements().for_each(|e| {
                if let DerpSpaceElem::Wayland(w) = e {
                    if let Some(toplevel) = w.toplevel() {
                        toplevel.send_pending_configure();
                    }
                }
            });

            self.input_routing
                .shell_move_begin_state(window_id, pointer_driven, (0, 0));
            self.shell_native_drag_preview_begin(window_id);
            self.shell_send_interaction_state();
            return;
        }
        if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
            self.output_topology.space
                .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
            if let Some(wl_surface) = x11.wl_surface() {
                let k_serial = SERIAL_COUNTER.next_serial();
                self.input_routing.seat
                    .get_keyboard()
                    .unwrap()
                    .set_focus(self, Some(wl_surface), k_serial);
            }
            self.output_topology.space.elements().for_each(|e| {
                if let DerpSpaceElem::Wayland(w) = e {
                    w.toplevel().unwrap().send_pending_configure();
                }
            });

            self.input_routing
                .shell_move_begin_state(window_id, pointer_driven, (0, 0));
            self.shell_native_drag_preview_begin(window_id);
            self.shell_send_interaction_state();
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
        if self.input_routing.shell_move_window_id
            .is_some_and(|wid| self.windows.window_registry.is_shell_hosted(wid))
        {
            self.shell_move_flush_pending_deltas_backed();
            return;
        }
        let Some(wid) = self.input_routing.shell_move_window_id else {
            return;
        };
        let (pdx, pdy) = self.input_routing.shell_move_pending_delta;
        if pdx == 0 && pdy == 0 {
            return;
        }
        let Some(sid) = self.windows.window_registry.surface_id_for_window(wid) else {
            tracing::warn!(target: "derp_shell_move", wid, "shell_move_flush: registry lost window");
            self.input_routing.shell_move_clear_active_state();
            self.shell_native_drag_preview_cancel(Some(wid));
            self.shell_move_proxy_cancel(Some(wid));
            self.shell_send_interaction_state();
            return;
        };
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let Some(loc) = self.output_topology.space
                .element_location(&DerpSpaceElem::Wayland(window.clone()))
            else {
                tracing::warn!(target: "derp_shell_move", wid, "shell_move_flush: no element_location");
                return;
            };
            let before = (loc.x, loc.y);
            let after = (loc.x + pdx, loc.y + pdy);
            self.output_topology.space
                .map_element(DerpSpaceElem::Wayland(window.clone()), after, true);
            self.input_routing.shell_move_pending_delta = (0, 0);
            self.notify_geometry_for_window(&window, true);
            self.shell_send_interaction_state();
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
            self.input_routing.shell_move_clear_active_state();
            self.shell_native_drag_preview_cancel(Some(wid));
            self.shell_move_proxy_cancel(Some(wid));
            self.shell_send_interaction_state();
            return;
        };
        let Some(loc) = self.output_topology.space
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
            self.input_routing.shell_move_clear_active_state();
            self.shell_native_drag_preview_cancel(Some(wid));
            self.shell_move_proxy_cancel(Some(wid));
            self.shell_send_interaction_state();
            return;
        }
        self.output_topology.space
            .map_element(DerpSpaceElem::X11(x11.clone()), after, true);
        self.input_routing.shell_move_pending_delta = (0, 0);
        self.emit_x11_window_updates(&x11, true, false);
        self.shell_send_interaction_state();
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
        let Some(wid) = self.input_routing.shell_move_window_id else {
            if self.input_routing.shell_move_deferred.is_some() {
                self.shell_move_deferred_accumulate_delta(dx, dy);
                return;
            }
            tracing::debug!(
                target: "derp_shell_move",
                dx,
                dy,
                "shell_move_delta: ignored (no active move)"
            );
            return;
        };
        self.shell_restore_maximized_drag_window_if_needed(wid);
        if self.windows.window_registry.is_shell_hosted(wid) {
            self.input_routing.shell_move_pending_delta.0 += dx;
            self.input_routing.shell_move_pending_delta.1 += dy;
            self.shell_move_proxy_try_arm_capture();
            if self.shell_move_delta_flush_due() {
                self.shell_move_flush_pending_deltas_backed();
            }
            return;
        }
        let Some(sid) = self.windows.window_registry.surface_id_for_window(wid) else {
            tracing::warn!(target: "derp_shell_move", wid, "shell_move_delta: registry lost window");
            self.input_routing.shell_move_clear_active_state();
            self.shell_native_drag_preview_cancel(Some(wid));
            self.shell_move_proxy_cancel(Some(wid));
            self.shell_send_interaction_state();
            return;
        };
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let Some(_loc) = self.output_topology.space
                .element_location(&DerpSpaceElem::Wayland(window.clone()))
            else {
                tracing::warn!(target: "derp_shell_move", wid, "shell_move_delta: no element_location");
                return;
            };
        } else if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
            let Some(_loc) = self.output_topology.space
                .element_location(&DerpSpaceElem::X11(x11.clone()))
            else {
                tracing::warn!(target: "derp_shell_move", wid, "shell_move_delta: no element_location");
                return;
            };
        } else {
            tracing::warn!(target: "derp_shell_move", wid, sid, "shell_move_delta: window gone from space");
            self.input_routing.shell_move_clear_active_state();
            self.shell_native_drag_preview_cancel(Some(wid));
            self.shell_move_proxy_cancel(Some(wid));
            self.shell_send_interaction_state();
            return;
        }
        self.input_routing.shell_move_pending_delta.0 += dx;
        self.input_routing.shell_move_pending_delta.1 += dy;
        tracing::trace!(
            target: "derp_shell_move",
            wid,
            dx,
            dy,
            accum = ?self.input_routing.shell_move_pending_delta,
            "shell_move_delta: flushing to space"
        );
        self.shell_move_proxy_try_arm_capture();
        if self.shell_move_delta_flush_due() {
            self.shell_move_flush_pending_deltas();
        }
    }

    pub(crate) fn shell_move_delta_flush_due(&mut self) -> bool {
        self.input_routing.shell_move_delta_flush_due()
    }

    /// Clears shell move state after `move_end` IPC, compositor button release, or disconnect.
    pub(crate) fn shell_move_end_cleanup(&mut self, window_id: u32, window: &Window) {
        if self.input_routing.shell_move_window_id != Some(window_id) {
            return;
        }
        self.input_routing.shell_move_clear_active_state();
        self.shell_native_drag_preview_cancel(Some(window_id));
        self.notify_geometry_for_window(window, true);
        self.shell_move_proxy_release(window_id);
        self.shell_send_interaction_state();
    }

    pub fn shell_move_end(&mut self, window_id: u32) {
        if self.input_routing.shell_move_deferred
            .as_ref()
            .is_some_and(|pending| pending.window_id == window_id)
        {
            self.input_routing.shell_move_deferred = None;
            return;
        }
        if self.input_routing.shell_move_window_id != Some(window_id) {
            tracing::debug!(
                target: "derp_shell_move",
                window_id,
                active = ?self.input_routing.shell_move_window_id,
                "shell_move_end: ignored (stale or no active move)"
            );
            return;
        }
        if self.windows.window_registry.is_shell_hosted(window_id) {
            self.shell_move_end_backed_only(window_id);
            return;
        }
        let Some(sid) = self.windows.window_registry.surface_id_for_window(window_id) else {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_end: no surface; clearing active move"
            );
            self.input_routing.shell_move_clear_active_state();
            self.shell_native_drag_preview_cancel(Some(window_id));
            self.shell_move_proxy_cancel(Some(window_id));
            self.shell_send_interaction_state();
            return;
        };
        if let Some(window) = self.find_window_by_surface_id(sid) {
            self.shell_move_flush_pending_deltas();
            self.shell_move_end_cleanup(window_id, &window);
            return;
        }
        if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
            self.shell_move_flush_pending_deltas();
            self.input_routing.shell_move_clear_active_state();
            self.shell_native_drag_preview_cancel(Some(window_id));
            self.emit_x11_window_updates(&x11, true, false);
            self.shell_move_proxy_release(window_id);
            self.shell_send_interaction_state();
            return;
        }
        tracing::warn!(
            target: "derp_shell_move",
            window_id,
            sid,
            "shell_move_end: surface missing; clearing"
        );
        self.input_routing.shell_move_clear_active_state();
        self.shell_native_drag_preview_cancel(Some(window_id));
        self.shell_move_proxy_cancel(Some(window_id));
        self.shell_send_interaction_state();
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
        let info = self.windows.window_registry.window_info(window_id)?;
        self.output_topology.space
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
        if let Some(window_id) = self.x11_window_id_for_surface(window) {
            if let Some(client_rect) =
                self.workspace_auto_layout_initial_client_rect_for_window(&output.name(), window_id)
            {
                return client_rect;
            }
        }
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
        raise: bool,
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
        self.output_topology.space.map_element(
            DerpSpaceElem::X11(window.clone()),
            (rect.loc.x, rect.loc.y),
            raise,
        );
        self.emit_x11_window_updates(window, true, false);
        true
    }

    pub(crate) fn shell_resize_is_active(&self) -> bool {
        self.input_routing.shell_resize_is_active()
    }

    pub(crate) fn shell_resize_end_active(&mut self) {
        if let Some(wid) = self.input_routing.shell_resize_active_window() {
            self.shell_resize_end(wid);
        }
        if self.input_routing.shell_resize_shell_grab_end() {
            self.shell_send_interaction_state();
        }
    }

    pub fn shell_resize_shell_grab_begin(&mut self, window_id: u32) {
        if window_id == 0 {
            return;
        }
        if let Some(mid) = self.input_routing.shell_move_window_id {
            if self.windows.window_registry.is_shell_hosted(mid) {
                self.shell_move_end_backed_only(mid);
            } else {
                self.shell_move_end(mid);
            }
        }
        if let Some(prev) = self.input_routing.shell_resize_window_id {
            if self.windows.window_registry.is_shell_hosted(prev) {
                self.shell_resize_end_backed_only(prev);
            } else {
                self.shell_resize_end(prev);
            }
        }
        self.input_routing.shell_resize_shell_grab_begin(window_id);
        self.shell_send_interaction_state();
    }

    pub fn shell_resize_shell_grab_end(&mut self) {
        if self.input_routing.shell_resize_shell_grab_end() {
            self.shell_send_interaction_state();
        }
    }

    pub fn shell_resize_begin(&mut self, window_id: u32, edges_wire: u32) {
        use crate::grabs::resize_grab::{
            resize_tracking_set_resizing, ResizeEdge as GrabResizeEdge,
        };
        use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;

        if let Some(mid) = self.input_routing.shell_move_window_id {
            if self.windows.window_registry.is_shell_hosted(mid) {
                self.shell_move_end_backed_only(mid);
            } else {
                self.shell_move_end(mid);
            }
        }
        self.input_routing.shell_resize_shell_grab = None;
        if self.input_routing.shell_resize_window_id == Some(window_id) {
            tracing::warn!(
                target: "derp_shell_resize",
                window_id,
                "shell_resize_begin: already active (no-op)"
            );
            return;
        }
        if let Some(prev) = self.input_routing.shell_resize_window_id {
            if self.windows.window_registry.is_shell_hosted(prev) {
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

        let Some(info) = self.windows.window_registry.window_info(window_id) else {
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
        let Some(sid) = self.windows.window_registry.surface_id_for_window(window_id) else {
            return;
        };
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let Some(loc) = self.output_topology.space
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

            self.input_routing
                .shell_resize_begin_state(window_id, edges, initial_rect);

            self.output_topology.space
                .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
            let k_serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Some(wl.clone()), k_serial);
            self.shell_send_interaction_state();
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            return;
        };
        let Some(loc) = self.output_topology.space
            .element_location(&DerpSpaceElem::X11(x11.clone()))
        else {
            return;
        };
        let geo = x11.geometry();
        let initial_rect = Rectangle::new(loc, geo.size);

        self.input_routing
            .shell_resize_begin_state(window_id, edges, initial_rect);

        self.output_topology.space
            .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
        if let Some(wl) = x11.wl_surface() {
            let k_serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Some(wl), k_serial);
        }
        self.shell_send_interaction_state();
    }

    fn shell_emit_interactive_resize_geometry(
        &mut self,
        window_id: u32,
        initial_rect: Rectangle<i32, Logical>,
        edges: crate::grabs::resize_grab::ResizeEdge,
        width: i32,
        height: i32,
    ) {
        let Some(mut info) = self.windows.window_registry.window_info(window_id) else {
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

        let Some(wid) = self.input_routing.shell_resize_window_id else {
            return;
        };
        let Some(edges) = self.input_routing.shell_resize_edges else {
            return;
        };
        let Some(initial_rect) = self.input_routing.shell_resize_initial_rect else {
            return;
        };
        if self.windows.window_registry.is_shell_hosted(wid) {
            self.shell_resize_delta_backed(dx, dy);
            return;
        }
        let Some(sid) = self.windows.window_registry.surface_id_for_window(wid) else {
            self.input_routing.shell_resize_clear_active_state();
            self.shell_send_interaction_state();
            return;
        };
        self.input_routing.shell_resize_accum.0 += dx as f64;
        self.input_routing.shell_resize_accum.1 += dy as f64;
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let tl = window.toplevel().unwrap();
            let wl = tl.wl_surface();
            let last_size = compute_clamped_resize_size(
                self,
                wl,
                edges,
                initial_rect.size,
                self.input_routing.shell_resize_accum.0,
                self.input_routing.shell_resize_accum.1,
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
            self.input_routing.shell_resize_clear_active_state();
            self.shell_send_interaction_state();
            return;
        };
        let rect = self.x11_resize_rect(
            &x11,
            initial_rect,
            edges,
            self.input_routing.shell_resize_accum.0,
            self.input_routing.shell_resize_accum.1,
        );
        self.apply_x11_window_bounds(
            wid,
            &x11,
            rect,
            x11.is_maximized(),
            x11.is_fullscreen(),
            true,
        );
    }

    pub fn shell_resize_end(&mut self, window_id: u32) {
        use crate::grabs::resize_grab::{
            compute_clamped_resize_size, resize_tracking_set_waiting_last_commit,
        };
        use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;

        if self.input_routing.shell_resize_window_id != Some(window_id) {
            tracing::debug!(
                target: "derp_shell_resize",
                window_id,
                active = ?self.input_routing.shell_resize_window_id,
                "shell_resize_end: ignored"
            );
            return;
        }

        if self.windows.window_registry.is_shell_hosted(window_id) {
            self.shell_resize_end_backed_only(window_id);
            return;
        }

        let Some(sid) = self.windows.window_registry.surface_id_for_window(window_id) else {
            self.input_routing.shell_resize_clear_active_state();
            self.shell_send_interaction_state();
            return;
        };
        let Some(edges) = self.input_routing.shell_resize_edges else {
            self.input_routing.shell_resize_clear_active_state();
            self.shell_send_interaction_state();
            return;
        };
        let Some(initial_rect) = self.input_routing.shell_resize_initial_rect else {
            self.input_routing.shell_resize_clear_active_state();
            self.shell_send_interaction_state();
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
                self.input_routing.shell_resize_accum.0,
                self.input_routing.shell_resize_accum.1,
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
                self.input_routing.shell_resize_accum.0,
                self.input_routing.shell_resize_accum.1,
            );
            self.apply_x11_window_bounds(
                window_id,
                &x11,
                rect,
                x11.is_maximized(),
                x11.is_fullscreen(),
                true,
            );
        } else {
            self.input_routing.shell_resize_clear_active_state();
            self.shell_send_interaction_state();
            return;
        }

        self.input_routing.shell_resize_clear_active_state();
        self.shell_send_interaction_state();

        tracing::debug!(
            target: "derp_shell_resize",
            window_id,
            "shell_resize_end: finished"
        );
    }

    fn shell_window_snapshot_row(
        &mut self,
        info: &WindowInfo,
        kind: WindowKind,
    ) -> shell_wire::ShellWindowSnapshot {
        let output_id = self
            .workspace_output_identity_for_name(&info.output_name)
            .unwrap_or_default();
        let scratchpad_kind = self.scratchpad_rule_value(
            info.window_id,
            info,
            &crate::session::settings_config::ScratchpadRuleFieldFile::Kind,
        );
        let x11_class = self.scratchpad_rule_value(
            info.window_id,
            info,
            &crate::session::settings_config::ScratchpadRuleFieldFile::X11Class,
        );
        let x11_instance = self.scratchpad_rule_value(
            info.window_id,
            info,
            &crate::session::settings_config::ScratchpadRuleFieldFile::X11Instance,
        );
        let frame = if kind == WindowKind::ShellHosted {
            self.shell_backed_outer_global_rect(info)
        } else {
            self.shell_native_outer_global_rect(info)
        };
        let capture_identifier = self.capture.capture_toplevel_handles
            .get(&info.window_id)
            .map(|handle| handle.identifier())
            .unwrap_or_default();
        shell_wire::ShellWindowSnapshot {
            window_id: info.window_id,
            surface_id: info.surface_id,
            stack_z: self.shell_window_stack_z(info.window_id),
            x: info.x,
            y: info.y,
            w: info.width,
            h: info.height,
            client_x: info.x,
            client_y: info.y,
            client_w: info.width,
            client_h: info.height,
            frame_x: frame.loc.x,
            frame_y: frame.loc.y,
            frame_w: frame.size.w,
            frame_h: frame.size.h,
            minimized: if info.minimized { 1 } else { 0 },
            maximized: if info.maximized { 1 } else { 0 },
            fullscreen: if info.fullscreen { 1 } else { 0 },
            client_side_decoration: if info.client_side_decoration { 1 } else { 0 },
            workspace_visible: if self.workspace_window_is_visible_during_render(info.window_id) {
                1
            } else {
                0
            },
            shell_flags: (if kind == WindowKind::ShellHosted {
                shell_wire::SHELL_WINDOW_FLAG_SHELL_HOSTED
            } else {
                0
            }) | if self.workspace_layout.scratchpad_windows.contains_key(&info.window_id) {
                shell_wire::SHELL_WINDOW_FLAG_SCRATCHPAD
            } else {
                0
            },
            title: info.title.clone(),
            app_id: info.app_id.clone(),
            output_id,
            output_name: info.output_name.clone(),
            capture_identifier,
            kind: scratchpad_kind,
            x11_class,
            x11_instance,
        }
    }

    fn shell_send_window_geometry_snapshot_for_window(&mut self, window_id: u32) {
        let window_kind = if self.windows.window_registry.is_shell_hosted(window_id) {
            WindowKind::ShellHosted
        } else {
            WindowKind::Native
        };
        let Some(row) = self.windows.window_registry
            .window_info(window_id)
            .and_then(|info| self.shell_window_info_to_output_local_layout(&info))
            .map(|info| self.shell_window_snapshot_row(&info, window_kind))
        else {
            return;
        };
        self.shell_send_to_cef(
            shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
                window_id: row.window_id,
                surface_id: row.surface_id,
                x: row.x,
                y: row.y,
                w: row.w,
                h: row.h,
                client_x: row.client_x,
                client_y: row.client_y,
                client_w: row.client_w,
                client_h: row.client_h,
                frame_x: row.frame_x,
                frame_y: row.frame_y,
                frame_w: row.frame_w,
                frame_h: row.frame_h,
                maximized: row.maximized != 0,
                fullscreen: row.fullscreen != 0,
                client_side_decoration: row.client_side_decoration != 0,
                output_id: row.output_id,
                output_name: row.output_name,
            },
        );
    }

    fn shell_window_list_rows_inner(
        &mut self,
        sync_capture_handles: bool,
    ) -> Vec<shell_wire::ShellWindowSnapshot> {
        self.shell_window_stack_seed_known_windows();
        if sync_capture_handles {
            self.capture_sync_toplevel_handles();
        }
        let records = self.windows.window_registry.all_records();
        let mut windows: Vec<shell_wire::ShellWindowSnapshot> = Vec::new();
        for record in records {
            if self.window_info_is_solid_shell_host(&record.info) {
                continue;
            }
            if !shell_window_row_should_show(&record.info) {
                continue;
            }
            if self.shell_x11_window_is_tray_hidden(record.info.window_id) {
                continue;
            }
            if record.kind != WindowKind::ShellHosted
                && self.window_id_is_deferred_initial_map(record.info.window_id)
            {
                continue;
            }
            let i = self
                .shell_window_info_to_output_local_layout(&record.info)
                .unwrap_or_else(|| record.info.clone());
            windows.push(self.shell_window_snapshot_row(&i, record.kind));
        }
        windows.sort_by(|a, b| a.window_id.cmp(&b.window_id));
        windows
    }

    fn shell_window_list_rows(&mut self) -> Vec<shell_wire::ShellWindowSnapshot> {
        self.shell_window_list_rows_inner(true)
    }

    fn shell_window_list_message(&mut self) -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::WindowList {
            revision: self.next_shell_window_domain_revision(),
            windows: self.shell_window_list_rows(),
        }
    }

    fn shell_window_list_snapshot_message(&mut self) -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::WindowList {
            revision: self.next_shell_window_domain_revision(),
            windows: self.shell_window_list_rows_inner(false),
        }
    }

    pub(crate) fn shell_window_order_message(
        &mut self,
    ) -> shell_wire::DecodedCompositorToShellMessage {
        let windows: Vec<shell_wire::ShellWindowOrderEntry> = self
            .shell_window_list_rows()
            .into_iter()
            .map(|window| shell_wire::ShellWindowOrderEntry {
                window_id: window.window_id,
                stack_z: window.stack_z,
            })
            .collect();
        self.shell_osr.shell_last_sent_window_order = windows
            .iter()
            .map(|window| (window.window_id, window.stack_z))
            .collect();
        shell_wire::DecodedCompositorToShellMessage::WindowOrder {
            revision: self.next_shell_window_domain_revision(),
            windows,
        }
    }

    fn shell_window_order_snapshot_message(
        &mut self,
    ) -> shell_wire::DecodedCompositorToShellMessage {
        let windows: Vec<shell_wire::ShellWindowOrderEntry> = self
            .shell_window_list_rows_inner(false)
            .into_iter()
            .map(|window| shell_wire::ShellWindowOrderEntry {
                window_id: window.window_id,
                stack_z: window.stack_z,
            })
            .collect();
        self.shell_osr.shell_last_sent_window_order = windows
            .iter()
            .map(|window| (window.window_id, window.stack_z))
            .collect();
        shell_wire::DecodedCompositorToShellMessage::WindowOrder {
            revision: self.next_shell_window_domain_revision(),
            windows,
        }
    }

    fn enrich_shell_live_message(
        &mut self,
        msg: shell_wire::DecodedCompositorToShellMessage,
    ) -> shell_wire::DecodedCompositorToShellMessage {
        match msg {
            shell_wire::DecodedCompositorToShellMessage::WindowMapped {
                window_id,
                surface_id,
                stack_z,
                x,
                y,
                w,
                h,
                minimized,
                maximized,
                fullscreen,
                title,
                app_id,
                client_side_decoration,
                shell_flags,
                output_id,
                output_name,
                capture_identifier,
                kind,
                x11_class,
                x11_instance,
            } => {
                let window_kind = if self.windows.window_registry.is_shell_hosted(window_id) {
                    WindowKind::ShellHosted
                } else {
                    WindowKind::Native
                };
                let Some(info) = self.windows.window_registry
                    .window_info(window_id)
                    .and_then(|info| self.shell_window_info_to_output_local_layout(&info))
                else {
                    return shell_wire::DecodedCompositorToShellMessage::WindowMapped {
                        window_id,
                        surface_id,
                        stack_z,
                        x,
                        y,
                        w,
                        h,
                        minimized,
                        maximized,
                        fullscreen,
                        title,
                        app_id,
                        client_side_decoration,
                        shell_flags,
                        output_id,
                        output_name,
                        capture_identifier,
                        kind,
                        x11_class,
                        x11_instance,
                    };
                };
                let row = self.shell_window_snapshot_row(&info, window_kind);
                shell_wire::DecodedCompositorToShellMessage::WindowMapped {
                    window_id: row.window_id,
                    surface_id: row.surface_id,
                    stack_z: row.stack_z,
                    x: row.x,
                    y: row.y,
                    w: row.w,
                    h: row.h,
                    minimized: row.minimized != 0,
                    maximized: row.maximized != 0,
                    fullscreen: row.fullscreen != 0,
                    title: row.title,
                    app_id: row.app_id,
                    client_side_decoration: row.client_side_decoration != 0,
                    shell_flags: row.shell_flags,
                    output_id: row.output_id,
                    output_name: row.output_name,
                    capture_identifier: row.capture_identifier,
                    kind: row.kind,
                    x11_class: row.x11_class,
                    x11_instance: row.x11_instance,
                }
            }
            shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
                window_id,
                surface_id,
                x,
                y,
                w,
                h,
                maximized,
                fullscreen,
                client_side_decoration,
                output_name,
                ..
            } => {
                let window_kind = if self.windows.window_registry.is_shell_hosted(window_id) {
                    WindowKind::ShellHosted
                } else {
                    WindowKind::Native
                };
                if let Some(row) = self.windows.window_registry
                    .window_info(window_id)
                    .and_then(|info| self.shell_window_info_to_output_local_layout(&info))
                    .map(|info| self.shell_window_snapshot_row(&info, window_kind))
                {
                    return shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
                        window_id: row.window_id,
                        surface_id: row.surface_id,
                        x: row.x,
                        y: row.y,
                        w: row.w,
                        h: row.h,
                        client_x: row.client_x,
                        client_y: row.client_y,
                        client_w: row.client_w,
                        client_h: row.client_h,
                        frame_x: row.frame_x,
                        frame_y: row.frame_y,
                        frame_w: row.frame_w,
                        frame_h: row.frame_h,
                        maximized: row.maximized != 0,
                        fullscreen: row.fullscreen != 0,
                        client_side_decoration: row.client_side_decoration != 0,
                        output_id: row.output_id,
                        output_name: row.output_name,
                    };
                }
                shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
                    window_id,
                    surface_id,
                    x,
                    y,
                    w,
                    h,
                    client_x: x,
                    client_y: y,
                    client_w: w,
                    client_h: h,
                    frame_x: x,
                    frame_y: y,
                    frame_w: w,
                    frame_h: h,
                    maximized,
                    fullscreen,
                    client_side_decoration,
                    output_id: self
                        .workspace_output_identity_for_name(&output_name)
                        .unwrap_or_default(),
                    output_name,
                }
            }
            other => other,
        }
    }

    /// Compositor → shell: full window list ([`shell_wire::MSG_WINDOW_LIST`]).
    pub fn shell_reply_window_list(&mut self) {
        crate::cef::begin_frame_diag::note_shell_reply_window_list();
        let workspace_changed = self.workspace_sync_from_registry();
        if workspace_changed {
            self.workspace_send_state();
        }
        let msg = self.shell_window_list_message();
        self.shell_send_to_cef(msg);
    }

    fn workspace_live_window_ids(&self) -> Vec<u32> {
        let mut window_ids: Vec<u32> = self.windows.window_registry
            .all_records()
            .into_iter()
            .filter(|record| !self.window_info_is_solid_shell_host(&record.info))
            .filter(|record| shell_window_row_should_show(&record.info))
            .filter(|record| !self.workspace_layout.scratchpad_windows.contains_key(&record.info.window_id))
            .filter(|record| !self.shell_x11_window_is_tray_hidden(record.info.window_id))
            .filter(|record| {
                record.kind == WindowKind::ShellHosted
                    || !self.window_id_is_deferred_initial_map(record.info.window_id)
            })
            .map(|record| record.info.window_id)
            .collect();
        window_ids.sort_unstable();
        window_ids
    }

    fn workspace_warn_invariants(&self, context: &str) {
        let live_window_ids = self.workspace_live_window_ids();
        for warning in self.workspace_layout.workspace_state.invariant_warnings(&live_window_ids) {
            tracing::warn!(
                target: "derp_workspace_state",
                context,
                warning = %warning,
                "workspace invariant"
            );
        }
    }

    fn state_invariant_failures(&self, context: &str) -> Vec<String> {
        let mut failures = Vec::new();
        let outputs: HashSet<String> = self.output_topology.space.outputs().map(|output| output.name()).collect();
        let live_window_ids = self.workspace_live_window_ids();
        for warning in self.workspace_layout.workspace_state.invariant_warnings(&live_window_ids) {
            failures.push(format!("{context}: workspace {warning}"));
        }
        for record in self.windows.window_registry.all_records() {
            let info = record.info;
            if self.window_info_is_solid_shell_host(&info)
                || !shell_window_row_should_show(&info)
                || self.shell_x11_window_is_tray_hidden(info.window_id)
                || (record.kind != WindowKind::ShellHosted
                    && self.window_id_is_deferred_initial_map(info.window_id))
            {
                continue;
            }
            if info.width <= 0 || info.height <= 0 {
                failures.push(format!(
                    "{context}: window {} has invalid client size {}x{}",
                    info.window_id, info.width, info.height
                ));
            }
            if !outputs.is_empty() {
                if info.output_name.is_empty() {
                    failures.push(format!(
                        "{context}: window {} has empty output",
                        info.window_id
                    ));
                } else if !outputs.contains(&info.output_name) {
                    failures.push(format!(
                        "{context}: window {} is assigned to removed output {}",
                        info.window_id, info.output_name
                    ));
                }
            }
            if !info.minimized && self.shell_osr.shell_chrome_titlebar_h <= 0 && !info.fullscreen {
                failures.push(format!(
                    "{context}: window {} is visible while titlebar height is {}",
                    info.window_id, self.shell_osr.shell_chrome_titlebar_h
                ));
            }
            let client = Rectangle::new(
                Point::from((info.x, info.y)),
                Size::from((info.width.max(1), info.height.max(1))),
            );
            let frame = if record.kind == WindowKind::ShellHosted {
                self.shell_backed_outer_global_rect(&info)
            } else {
                self.shell_native_outer_global_rect(&info)
            };
            if !rect_contains_rect(frame, client) {
                failures.push(format!(
                    "{context}: window {} frame does not contain client frame=({},{} {}x{}) client=({},{} {}x{})",
                    info.window_id,
                    frame.loc.x,
                    frame.loc.y,
                    frame.size.w,
                    frame.size.h,
                    client.loc.x,
                    client.loc.y,
                    client.size.w,
                    client.size.h
                ));
            }
            if !info.minimized
                && !info.fullscreen
                && frame.size.h <= client.size.h
                && self.shell_osr.shell_chrome_titlebar_h > 0
            {
                failures.push(format!(
                    "{context}: window {} frame has no titlebar height frame_h={} client_h={}",
                    info.window_id, frame.size.h, client.size.h
                ));
            }
            if info.maximized && info.fullscreen {
                failures.push(format!(
                    "{context}: window {} is both maximized and fullscreen",
                    info.window_id
                ));
            }
        }
        for window_id in &self.windows.shell_window_stack_order {
            if self.windows.window_registry.window_info(*window_id).is_none() {
                failures.push(format!(
                    "{context}: stack contains unknown window {window_id}"
                ));
            }
        }
        for window_id in [
            self.input_routing.shell_move_window_id,
            self.input_routing.shell_resize_window_id,
            self.input_routing.shell_move_proxy.as_ref().map(|proxy| proxy.window_id),
            self.input_routing.shell_native_drag_preview
                .as_ref()
                .map(|preview| preview.window_id),
        ]
        .into_iter()
        .flatten()
        {
            if self.windows.window_registry.window_info(window_id).is_none() {
                failures.push(format!(
                    "{context}: interaction references unknown window {window_id}"
                ));
            }
        }
        if self.input_routing.touch_emulation_slot.is_none() && self.input_routing.touch_routes_to_cef {
            failures.push(format!(
                "{context}: touch routes to CEF without an active touch slot"
            ));
        }
        failures
    }

    fn validate_state_after(&self, context: &str) {
        if !compositor_state_validation_enabled() {
            return;
        }
        let failures = self.state_invariant_failures(context);
        if failures.is_empty() {
            return;
        }
        for failure in &failures {
            tracing::warn!(target: "derp_state_invariant", failure = %failure);
        }
        panic!(
            "compositor state invariant failed after {context}: {}",
            failures.join("; ")
        );
    }

    fn workspace_sync_from_registry(&mut self) -> bool {
        let live_window_ids = self.workspace_live_window_ids();
        if !self
            .workspace_layout
            .workspace_sync_from_live_window_ids(&live_window_ids)
        {
            return false;
        }
        self.workspace_warn_invariants("sync_from_registry");
        true
    }

    fn workspace_send_state(&mut self) {
        self.workspace_warn_invariants("send_state");
        self.next_shell_workspace_revision();
        let Some(msg) = self.workspace_state_message() else {
            return;
        };
        self.shell_send_to_cef(msg);
    }

    fn taskbar_pin_current_output_name(&self, output_name: &str, output_id: &str) -> String {
        if !output_id.is_empty() {
            if let Some(name) = self.output_topology.space
                .outputs()
                .find(|output| Self::shell_output_identity(output) == output_id)
                .map(|output| output.name())
            {
                return name;
            }
        }
        output_name.to_string()
    }

    pub(crate) fn apply_taskbar_pin_add_json(&mut self, json: &str) {
        if self.workspace_layout.apply_taskbar_pin_add_json(json) {
            self.workspace_send_state();
        }
    }

    pub(crate) fn apply_taskbar_pin_remove_json(&mut self, json: &str) {
        if self.workspace_layout.apply_taskbar_pin_remove_json(json) {
            self.workspace_send_state();
        }
    }

    pub(crate) fn launch_taskbar_pin_json(&mut self, json: &str) {
        let Some((command, output_name, output_id)) = self.workspace_layout.taskbar_pin_launch_command(json) else {
            return;
        };
        let target = self.taskbar_pin_current_output_name(&output_name, &output_id);
        self.windows.shell_spawn_target_output_name = Some(target);
        if let Err(error) = self.try_spawn_wayland_client_sh(&command) {
            self.windows.shell_spawn_target_output_name = None;
            tracing::warn!(%error, command = %command, "taskbar pin launch failed");
        }
    }

    pub(crate) fn workspace_state_for_shell(&self) -> WorkspaceState {
        self.workspace_layout.workspace_state_for_shell(|output_id| {
            self.output_topology
                .space
                .outputs()
                .find(|output| Self::shell_output_identity(output) == output_id)
                .map(|output| output.name())
        })
    }

    fn workspace_state_binary_message(
        &self,
    ) -> Option<shell_wire::DecodedCompositorToShellMessage> {
        let state = self.workspace_state_for_shell();
        self.workspace_layout.workspace_state_binary_message(&state)
    }

    fn workspace_state_message(&self) -> Option<shell_wire::DecodedCompositorToShellMessage> {
        let state = self.workspace_state_for_shell();
        self.workspace_layout.workspace_state_message(&state)
    }

    #[allow(dead_code)]
    fn shell_hosted_app_state_broadcast_json(&self) -> String {
        self.shell_osr.hosted_app_state_broadcast_json()
    }

    pub(crate) fn shell_hosted_app_state_send(&mut self) {
        self.next_shell_hosted_app_state_revision();
        self.shell_send_to_cef(self.shell_hosted_app_state_message());
    }

    fn shell_hosted_app_state_message(&self) -> shell_wire::DecodedCompositorToShellMessage {
        self.shell_osr.shell_hosted_app_state_message()
    }

    fn shell_focus_message(&self) -> shell_wire::DecodedCompositorToShellMessage {
        let window_id = self.logical_focused_window_id();
        let surface_id = window_id.and_then(|w| self.windows.window_registry.surface_id_for_window(w));
        ShellOsrState::shell_focus_message(window_id, surface_id)
    }

    fn shell_focus_snapshot_message(&self) -> shell_wire::DecodedCompositorToShellMessage {
        self.shell_osr.shell_focus_snapshot_message(
            |window_id| {
                self.windows.window_registry
                    .window_info(window_id)
                    .map(|info| {
                        !info.minimized
                            && !self.window_info_is_solid_shell_host(&info)
                            && shell_window_row_should_show(&info)
                            && !self.shell_x11_window_is_tray_hidden(info.window_id)
                    })
                    .unwrap_or(false)
            },
            |window_id| self.windows.window_registry.surface_id_for_window(window_id),
        )
    }

    fn shell_tray_hints_message(&self) -> shell_wire::DecodedCompositorToShellMessage {
        let slot_w: i32 = 40;
        if self.shell_effective_primary_output().is_none() {
            return shell_wire::DecodedCompositorToShellMessage::TrayHints {
                slot_count: 0,
                slot_w,
                reserved_w: 0,
            };
        }
        let slot_count = self.tray_notifications.sni_tray_slot_count();
        let reserved_w = slot_count
            .saturating_mul(slot_w.max(1) as u32);
        shell_wire::DecodedCompositorToShellMessage::TrayHints {
            slot_count,
            slot_w,
            reserved_w,
        }
    }

    pub(crate) fn shell_native_drag_preview_begin(&mut self, window_id: u32) {
        if self.windows.window_registry.is_shell_hosted(window_id) {
            if let Some(preview) = self.input_routing.shell_native_drag_preview.take() {
                self.shell_send_native_drag_preview_detail(
                    preview.window_id,
                    preview.generation,
                    String::new(),
                );
            }
            return;
        }
        let capture_signature = self.shell_native_drag_preview_capture_signature(window_id);
        if let Some(preview) = self.input_routing.shell_native_drag_preview.take() {
            self.shell_send_native_drag_preview_detail(
                preview.window_id,
                preview.generation,
                String::new(),
            );
        }
        let generation = self.input_routing.shell_native_drag_preview_generation
            .wrapping_add(1)
            .max(1);
        self.input_routing.shell_native_drag_preview_generation = generation;
        let (output_name, logical_width, logical_height, buffer_width, buffer_height) =
            capture_signature.unwrap_or_else(|| (String::new(), 0, 0, 0, 0));
        self.input_routing.shell_native_drag_preview = Some(NativeDragPreviewState {
            window_id,
            generation,
            capture_pending: true,
            image_path: None,
            shell_ready: false,
            output_name,
            logical_width,
            logical_height,
            buffer_width,
            buffer_height,
        });
        self.shell_send_native_drag_preview_state();
    }

    pub(crate) fn shell_native_drag_preview_cancel(&mut self, window_id: Option<u32>) {
        let clear = self.input_routing.shell_native_drag_preview.as_ref().and_then(|preview| {
            (window_id.is_none() || window_id == Some(preview.window_id))
                .then_some((preview.window_id, preview.generation))
        });
        if let Some((preview_window_id, generation)) = clear {
            self.input_routing.shell_native_drag_preview = None;
            self.shell_send_native_drag_preview_detail(
                preview_window_id,
                generation,
                String::new(),
            );
        }
    }

    pub(crate) fn shell_native_drag_preview_mark_ready(&mut self, window_id: u32, generation: u32) {
        let Some(preview) = self.input_routing.shell_native_drag_preview.as_mut() else {
            return;
        };
        if preview.window_id != window_id || preview.generation != generation {
            return;
        }
        if preview.shell_ready {
            return;
        }
        preview.shell_ready = true;
        self.shell_send_interaction_state();
    }

    pub(crate) fn shell_native_drag_preview_capture_if_needed(
        &mut self,
        renderer: &mut GlesRenderer,
    ) {
        let Some((window_id, generation)) =
            self.input_routing.shell_native_drag_preview.as_ref().and_then(|preview| {
                if !preview.capture_pending && preview.image_path.is_none() {
                    return None;
                }
                Some((preview.window_id, preview.generation))
            })
        else {
            return;
        };
        let Some((
            output_name,
            next_logical_width,
            next_logical_height,
            buffer_width,
            buffer_height,
        )) = self.shell_native_drag_preview_capture_signature(window_id)
        else {
            return;
        };
        let mut should_send_clear = false;
        if let Some(preview) = self.input_routing.shell_native_drag_preview.as_mut() {
            if preview.window_id == window_id
                && preview.generation == generation
                && (preview.output_name != output_name
                    || preview.logical_width != next_logical_width
                    || preview.logical_height != next_logical_height
                    || preview.buffer_width != buffer_width
                    || preview.buffer_height != buffer_height)
            {
                preview.output_name = output_name.clone();
                preview.logical_width = next_logical_width;
                preview.logical_height = next_logical_height;
                preview.buffer_width = buffer_width;
                preview.buffer_height = buffer_height;
                preview.image_path = None;
                preview.shell_ready = false;
                preview.capture_pending = true;
                should_send_clear = true;
            }
        }
        if should_send_clear {
            self.shell_send_native_drag_preview_state();
        }
        let Some((window_id, generation)) =
            self.input_routing.shell_native_drag_preview.as_ref().and_then(|preview| {
                if !preview.capture_pending || preview.image_path.is_some() {
                    return None;
                }
                Some((preview.window_id, preview.generation))
            })
        else {
            return;
        };
        if !self.shell_native_drag_preview_capture_ready(
            window_id,
            next_logical_width,
            next_logical_height,
        ) {
            return;
        }
        let png =
            match crate::render::capture_ext::capture_window_preview_png(self, renderer, window_id)
            {
                Ok(png) => png,
                Err(error) => {
                    tracing::warn!(
                        target: "derp_shell_move",
                        window_id,
                        %error,
                        "native drag preview capture failed"
                    );
                    if let Some(preview) = self.input_routing.shell_native_drag_preview.as_mut() {
                        if preview.window_id == window_id && preview.generation == generation {
                            preview.capture_pending = false;
                        }
                    }
                    return;
                }
            };
        let path = crate::cef::runtime_dir().join(format!(
            "derp-native-drag-preview-{}-{}-{}.png",
            std::process::id(),
            window_id,
            generation,
        ));
        let path = match crate::render::screenshot::save_png_to_path(&png, &path) {
            Ok(path) => path,
            Err(error) => {
                tracing::warn!(
                    target: "derp_shell_move",
                    window_id,
                    %error,
                    "native drag preview save failed"
                );
                if let Some(preview) = self.input_routing.shell_native_drag_preview.as_mut() {
                    if preview.window_id == window_id && preview.generation == generation {
                        preview.capture_pending = false;
                    }
                }
                return;
            }
        };
        let Some(preview) = self.input_routing.shell_native_drag_preview.as_mut() else {
            return;
        };
        if preview.window_id != window_id || preview.generation != generation {
            return;
        }
        preview.capture_pending = false;
        preview.shell_ready = false;
        preview.image_path = Some(path.to_string_lossy().into_owned());
        self.shell_send_native_drag_preview_state();
    }

    fn shell_native_drag_preview_capture_signature(
        &self,
        window_id: u32,
    ) -> Option<(String, i32, i32, i32, i32)> {
        let source = self.capture_window_source_descriptor(window_id)?;
        let actual_rect = self.mapped_native_window_content_rect(window_id)?;
        let output = self.output_topology.space
            .outputs()
            .find(|output| output.name() == source.output_name)?;
        let scale = output.current_scale().fractional_scale();
        Some((
            source.output_name,
            actual_rect.size.w,
            actual_rect.size.h,
            ((actual_rect.size.w as f64) * scale).round().max(1.0) as i32,
            ((actual_rect.size.h as f64) * scale).round().max(1.0) as i32,
        ))
    }

    fn shell_native_drag_preview_capture_ready(
        &self,
        window_id: u32,
        logical_width: i32,
        logical_height: i32,
    ) -> bool {
        if logical_width <= 0 || logical_height <= 0 {
            return false;
        }
        let Some(actual_rect) = self.mapped_native_window_content_rect(window_id) else {
            return false;
        };
        actual_rect.size.w == logical_width && actual_rect.size.h == logical_height
    }

    pub(crate) fn mapped_native_window_content_rect(
        &self,
        window_id: u32,
    ) -> Option<Rectangle<i32, Logical>> {
        let sid = self.windows.window_registry.surface_id_for_window(window_id)?;
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let loc = self.output_topology.space
                .element_location(&DerpSpaceElem::Wayland(window.clone()))?;
            let size = window.geometry().size;
            return Some(Rectangle::new(loc, size));
        }
        let x11 = self.find_x11_window_by_surface_id(sid)?;
        let loc = self.output_topology.space
            .element_location(&DerpSpaceElem::X11(x11.clone()))?;
        Some(Rectangle::new(loc, x11.geometry().size))
    }

    pub(crate) fn shell_native_drag_preview_clip_rect(&self) -> Option<Rectangle<i32, Logical>> {
        let preview = self.input_routing.shell_native_drag_preview.as_ref()?;
        if self.input_routing.shell_move_window_id != Some(preview.window_id)
            || preview.image_path.is_none()
            || !preview.shell_ready
        {
            return None;
        }
        let info = self.windows.window_registry.window_info(preview.window_id)?;
        Some(self.shell_native_outer_global_rect(&info))
    }

    pub(crate) fn shell_send_native_drag_preview_state(&mut self) {
        let Some(shell_wire::DecodedCompositorToShellMessage::NativeDragPreview {
            window_id,
            generation,
            image_path,
        }) = self.shell_native_drag_preview_message()
        else {
            return;
        };
        self.shell_send_native_drag_preview_detail(window_id, generation, image_path);
    }

    fn shell_send_native_drag_preview_detail(
        &mut self,
        window_id: u32,
        generation: u32,
        image_path: String,
    ) {
        self.shell_send_to_cef(
            shell_wire::DecodedCompositorToShellMessage::NativeDragPreview {
                window_id,
                generation,
                image_path,
            },
        );
    }

    fn shell_native_drag_preview_message(
        &self,
    ) -> Option<shell_wire::DecodedCompositorToShellMessage> {
        let preview = self.input_routing.shell_native_drag_preview.as_ref()?;
        Some(
            shell_wire::DecodedCompositorToShellMessage::NativeDragPreview {
                window_id: preview.window_id,
                generation: preview.generation,
                image_path: preview.image_path.clone().unwrap_or_default(),
            },
        )
    }

    fn shell_interaction_owner_signature(&self) -> (u32, u32, u32, u32) {
        self.input_routing.shell_interaction_owner_signature()
    }

    fn sync_shell_interaction_serial(&mut self) {
        self.input_routing.sync_shell_interaction_serial();
    }

    fn shell_interaction_state_message(&self) -> shell_wire::DecodedCompositorToShellMessage {
        let (_, _, move_proxy_window_id, move_capture_window_id) =
            self.shell_interaction_owner_signature();
        let interaction_visual = |window_id: Option<u32>| {
            window_id
                .and_then(|wid| self.windows.window_registry.window_info(wid))
                .map(|info| {
                    let i = self
                        .shell_window_info_to_output_local_layout(&info)
                        .unwrap_or_else(|| info.clone());
                    shell_wire::CompositorInteractionVisual {
                        x: i.x,
                        y: i.y,
                        width: i.width.max(1),
                        height: i.height.max(1),
                        maximized: i.maximized,
                        fullscreen: i.fullscreen,
                    }
                })
        };
        let pointer = self.input_routing.seat
            .get_pointer()
            .map(|pointer| pointer.current_location().to_i32_round())
            .unwrap_or_else(|| Point::from((0, 0)));
        ShellOsrState::shell_interaction_state_message(
            self.input_routing.shell_interaction_revision,
            self.input_routing.shell_interaction_serial,
            pointer,
            self.input_routing.shell_move_window_id,
            self.input_routing.shell_resize_window_id,
            move_proxy_window_id,
            move_capture_window_id,
            interaction_visual(self.input_routing.shell_move_window_id),
            interaction_visual(self.input_routing.shell_resize_window_id),
            self.shell_window_switcher_effective_selected_window_id(),
        )
    }

    pub(crate) fn shell_send_interaction_state(&mut self) {
        self.sync_shell_interaction_serial();
        self.next_shell_interaction_revision();
        self.input_routing.shell_interaction_last_sent_at = Some(Instant::now());
        self.shell_send_to_cef(self.shell_interaction_state_message());
    }

    pub(crate) fn shell_send_interaction_state_throttled(&mut self) {
        if !InputRoutingState::shell_hot_interaction_due(
            &mut self.input_routing.shell_interaction_last_sent_at,
            Duration::from_millis(16),
        ) {
            return;
        }
        self.sync_shell_interaction_serial();
        self.next_shell_interaction_revision();
        self.shell_send_to_cef(self.shell_interaction_state_message());
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
                && kind != "pdf_viewer"
            {
                continue;
            }
            let Some(st) = obj.get("state") else {
                continue;
            };
            if st.is_null() {
                continue;
            }
            self.shell_osr.shell_hosted_app_state.insert(wid, st.clone());
        }
    }

    pub(crate) fn apply_shell_hosted_window_state_json(&mut self, json: &str) {
        let changed = self
            .shell_osr
            .apply_shell_hosted_window_state_json(json, |window_id| {
                self.windows.window_registry.is_shell_hosted(window_id)
            });
        if changed {
            self.shell_hosted_app_state_send();
        }
    }

    fn workspace_copy_window_geometry(&mut self, target_window_id: u32, source_window_id: u32) {
        let Some(source_info) = self.windows.window_registry.window_info(source_window_id) else {
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

    fn workspace_begin_detached_window_drag(&mut self, window_id: u32) {
        let Some(pointer) = self.input_routing.seat.get_pointer() else {
            self.shell_activate_window(window_id);
            return;
        };
        let pos = pointer.current_location();
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return;
        };
        let width = info.width.max(1);
        let height = info.height.max(1);
        let x = (pos.x.round() as i32).saturating_sub(width / 2);
        let y = (pos.y.round() as i32).saturating_add(self.shell_osr.shell_chrome_titlebar_h.max(0) / 2);
        let (ox, oy) = self.output_topology.shell_canvas_logical_origin;
        self.shell_set_window_geometry(
            window_id,
            x.saturating_sub(ox),
            y.saturating_sub(oy),
            width,
            height,
            0,
        );
        self.shell_activate_window(window_id);
        self.shell_move_begin(window_id);
    }

    pub(crate) fn apply_workspace_mutation_json(&mut self, mutation_json: &str) {
        #[derive(serde::Deserialize)]
        struct WorkspaceMutationEnvelope {
            #[serde(rename = "clientMutationId")]
            client_mutation_id: Option<u64>,
            mutation: WorkspaceMutation,
        }
        let client_mutation_id = serde_json::from_str::<serde_json::Value>(mutation_json)
            .ok()
            .and_then(|value| value.get("clientMutationId").and_then(|v| v.as_u64()));
        let Ok((mutation, client_mutation_id)) =
            serde_json::from_str::<WorkspaceMutationEnvelope>(mutation_json)
                .map(|envelope| (envelope.mutation, envelope.client_mutation_id))
                .or_else(|_| {
                    serde_json::from_str::<WorkspaceMutation>(mutation_json)
                        .map(|mutation| (mutation, client_mutation_id))
                })
        else {
            self.shell_send_mutation_ack("workspace_mutation", client_mutation_id, false);
            return;
        };
        self.workspace_sync_from_registry();
        let previous_state = self.workspace_layout.workspace_state.clone();
        let Some(next_state) = previous_state.apply_mutation(&mutation) else {
            self.shell_send_mutation_ack("workspace_mutation", client_mutation_id, true);
            return;
        };
        let next_state = reconcile_workspace_state(&next_state, &self.workspace_live_window_ids());
        let mut activation_window_id = None;
        let mut detached_window_drag = None;
        let mut activate_before_workspace_state = false;
        let mut detached_drag_before_workspace_state = false;
        let mut copy_geometry_after_activation = None;
        let mut auto_layout_output_name = None;
        let mut auto_layout_all_outputs = false;
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
                        activate_before_workspace_state =
                            !self.windows.window_registry.is_shell_hosted(next_visible);
                        if !activate_before_workspace_state {
                            copy_geometry_after_activation = Some((next_visible, previous_visible));
                        }
                    }
                }
            }
            WorkspaceMutation::SelectWindowTab { window_id } => {
                if let Some(group_id) = group_id_for_window(&previous_state, *window_id) {
                    let previous_visible = previous_state.visible_window_id_for_group(group_id);
                    let next_visible = next_state.visible_window_id_for_group(group_id);
                    if let (Some(previous_visible), Some(next_visible)) =
                        (previous_visible, next_visible)
                    {
                        if previous_visible != next_visible {
                            self.workspace_copy_window_geometry(next_visible, previous_visible);
                            activation_window_id = Some(next_visible);
                            activate_before_workspace_state =
                                !self.windows.window_registry.is_shell_hosted(next_visible);
                            if !activate_before_workspace_state {
                                copy_geometry_after_activation =
                                    Some((next_visible, previous_visible));
                            }
                        }
                    }
                }
            }
            WorkspaceMutation::MoveWindowToWindow {
                window_id,
                target_window_id,
                ..
            } => {
                let source_group_id =
                    group_id_for_window(&previous_state, *window_id).map(str::to_string);
                let resolved_target_group_id =
                    group_id_for_window(&previous_state, *target_window_id);
                if source_group_id.as_deref() != resolved_target_group_id {
                    self.workspace_copy_window_geometry(*window_id, *target_window_id);
                    activation_window_id = Some(*window_id);
                }
            }
            WorkspaceMutation::MoveWindowToGroup {
                window_id,
                target_group_id,
                target_window_id,
                ..
            } => {
                let source_group_id =
                    group_id_for_window(&previous_state, *window_id).map(str::to_string);
                let requested_target_group = previous_state
                    .groups
                    .iter()
                    .find(|group| group.id == *target_group_id);
                let resolved_target_group_id = if let Some(target_window_id) = target_window_id {
                    if requested_target_group
                        .is_none_or(|group| !group.window_ids.contains(target_window_id))
                    {
                        group_id_for_window(&previous_state, *target_window_id)
                            .unwrap_or(target_group_id)
                    } else {
                        target_group_id.as_str()
                    }
                } else if requested_target_group.is_some() {
                    target_group_id.as_str()
                } else {
                    target_group_id
                };
                if source_group_id.as_deref() != Some(resolved_target_group_id) {
                    if let Some(target_visible) =
                        previous_state.visible_window_id_for_group(resolved_target_group_id)
                    {
                        self.workspace_copy_window_geometry(*window_id, target_visible);
                        activation_window_id = Some(*window_id);
                    }
                }
            }
            WorkspaceMutation::MoveGroupToWindow {
                source_window_id,
                target_window_id,
                ..
            } => {
                let resolved_source_group_id =
                    group_id_for_window(&previous_state, *source_window_id);
                let resolved_target_group_id =
                    group_id_for_window(&previous_state, *target_window_id);
                if resolved_source_group_id != resolved_target_group_id {
                    if let Some(source_group_id) = resolved_source_group_id {
                        if let Some(source_group) = previous_state
                            .groups
                            .iter()
                            .find(|group| group.id == source_group_id)
                        {
                            for window_id in &source_group.window_ids {
                                self.workspace_copy_window_geometry(*window_id, *target_window_id);
                            }
                        }
                        let source_visible =
                            previous_state.visible_window_id_for_group(source_group_id);
                        activation_window_id = source_visible.or(Some(*target_window_id));
                    }
                }
            }
            WorkspaceMutation::MoveGroupToGroup {
                source_group_id,
                target_group_id,
                source_window_id,
                target_window_id,
                ..
            } => {
                let requested_source_group = previous_state
                    .groups
                    .iter()
                    .find(|group| group.id == *source_group_id);
                let resolved_source_group_id = if let Some(source_window_id) = source_window_id {
                    if requested_source_group
                        .is_none_or(|group| !group.window_ids.contains(source_window_id))
                    {
                        group_id_for_window(&previous_state, *source_window_id)
                            .unwrap_or(source_group_id)
                    } else {
                        source_group_id.as_str()
                    }
                } else if requested_source_group.is_some() {
                    source_group_id.as_str()
                } else {
                    source_group_id
                };
                let requested_target_group = previous_state
                    .groups
                    .iter()
                    .find(|group| group.id == *target_group_id);
                let resolved_target_group_id = if let Some(target_window_id) = target_window_id {
                    if requested_target_group
                        .is_none_or(|group| !group.window_ids.contains(target_window_id))
                    {
                        group_id_for_window(&previous_state, *target_window_id)
                            .unwrap_or(target_group_id)
                    } else {
                        target_group_id.as_str()
                    }
                } else if requested_target_group.is_some() {
                    target_group_id.as_str()
                } else {
                    target_group_id
                };
                if resolved_source_group_id != resolved_target_group_id {
                    if let Some(target_visible) =
                        previous_state.visible_window_id_for_group(resolved_target_group_id)
                    {
                        let source_visible =
                            previous_state.visible_window_id_for_group(resolved_source_group_id);
                        if let Some(source_group) = previous_state
                            .groups
                            .iter()
                            .find(|group| group.id == resolved_source_group_id)
                        {
                            for window_id in &source_group.window_ids {
                                self.workspace_copy_window_geometry(*window_id, target_visible);
                            }
                        }
                        activation_window_id = source_visible.or(Some(target_visible));
                    }
                }
            }
            WorkspaceMutation::SplitWindowToOwnGroup { window_id } => {
                if self.shell_ui_pointer_grab_active() {
                    detached_window_drag = Some(*window_id);
                    detached_drag_before_workspace_state =
                        !self.windows.window_registry.is_shell_hosted(*window_id);
                } else {
                    activation_window_id = Some(*window_id);
                }
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
            | WorkspaceMutation::ClearPreTileGeometry { .. } => {}
            WorkspaceMutation::RestoreSessionWorkspace { .. } => {
                auto_layout_all_outputs = true;
            }
            WorkspaceMutation::SetMonitorLayouts { .. } => {
                auto_layout_all_outputs = true;
            }
            WorkspaceMutation::SetMonitorLayout {
                output_name,
                layout,
                ..
            } => {
                if *layout != WorkspaceMonitorLayoutType::ManualSnap {
                    auto_layout_output_name = Some(output_name.clone());
                }
            }
        }
        self.workspace_layout.workspace_state = next_state;
        self.workspace_warn_invariants("apply_mutation");
        if detached_drag_before_workspace_state {
            if let Some(window_id) = detached_window_drag.take() {
                self.workspace_begin_detached_window_drag(window_id);
            }
        } else if activate_before_workspace_state {
            if let Some(window_id) = activation_window_id.take() {
                self.shell_activate_window(window_id);
            }
        }
        let state_sent = if auto_layout_all_outputs {
            self.workspace_apply_auto_layout_for_all_outputs()
        } else if let Some(output_name) = auto_layout_output_name {
            self.workspace_apply_auto_layout_for_output_name(&output_name)
        } else {
            false
        };
        if !state_sent {
            self.workspace_send_state();
        }
        if let Some(window_id) = detached_window_drag {
            self.workspace_begin_detached_window_drag(window_id);
        } else if let Some(window_id) = activation_window_id {
            self.shell_activate_window(window_id);
            if let Some((target_window_id, source_window_id)) = copy_geometry_after_activation {
                self.workspace_copy_window_geometry(target_window_id, source_window_id);
            }
        }
        self.shell_send_mutation_ack("workspace_mutation", client_mutation_id, true);
    }

    fn workspace_apply_close_side_effects(&mut self, window_id: u32) {
        let group_id = group_id_for_window(&self.workspace_layout.workspace_state, window_id).map(str::to_string);
        self.workspace_sync_from_registry();
        let Some(group_id) = group_id else {
            self.workspace_send_state();
            return;
        };
        let next_visible =
            next_active_window_after_removal(&self.workspace_layout.workspace_state, &group_id, window_id);
        self.workspace_layout.workspace_state =
            reconcile_workspace_state(&self.workspace_layout.workspace_state, &self.workspace_live_window_ids());
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
        let (ox, oy) = self.output_topology.shell_canvas_logical_origin;
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
        let info = self.windows.window_registry
            .window_info(window_id)
            .ok_or_else(|| "missing window".to_string())?;
        if info.minimized {
            return Err("minimized".into());
        }
        if self.window_info_is_solid_shell_host(&info) {
            return Err("solid host".into());
        }
        let mut pairs: Vec<(String, Rectangle<i32, Logical>)> = self.output_topology.space
            .outputs()
            .filter_map(|o| {
                let g = self.output_topology.space.output_geometry(o)?;
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
        let Some(src_out) = self.output_topology.space.outputs().find(|o| o.name() == src_name.as_str()) else {
            return Err("src output".into());
        };
        let Some(tgt_out) = self.output_topology.space.outputs().find(|o| o.name() == tgt_name.as_str()) else {
            return Err("tgt output".into());
        };
        let Some(src_work) = self.shell_maximize_work_area_global_for_output(&src_out) else {
            return Err("src work".into());
        };
        let Some(tgt_work) = self.shell_maximize_work_area_global_for_output(&tgt_out) else {
            return Err("tgt work".into());
        };
        let (ox, oy) = self.output_topology.shell_canvas_logical_origin;
        if let Some((_, zone)) = self.workspace_monitor_tile_for_window(window_id) {
            let Some(frame_rect) = self.shell_tile_frame_rect_for_output(&tgt_out, &zone) else {
                return Err("tile target".into());
            };
            self.workspace_set_monitor_tile(
                &tgt_name,
                window_id,
                zone,
                WorkspaceRect {
                    x: frame_rect.loc.x,
                    y: frame_rect.loc.y,
                    width: frame_rect.size.w.max(1),
                    height: frame_rect.size.h.max(1),
                },
            );
            let client_rect = self.workspace_auto_layout_client_rect_from_frame_rect(frame_rect);
            self.shell_apply_global_client_rect(window_id, client_rect, 0);
            self.workspace_send_state();
            return Ok(());
        }
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
        let max_x = tgt_work
            .loc
            .x
            .saturating_add(tgt_work.size.w.saturating_sub(gw));
        let max_y = tgt_work
            .loc
            .y
            .saturating_add(tgt_work.size.h.saturating_sub(gh));
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

    fn shell_apply_global_client_rect(
        &mut self,
        window_id: u32,
        rect: Rectangle<i32, Logical>,
        layout_state: u32,
    ) {
        let (ox, oy) = self.output_topology.shell_canvas_logical_origin;
        self.shell_set_window_geometry(
            window_id,
            rect.loc.x.saturating_sub(ox),
            rect.loc.y.saturating_sub(oy),
            rect.size.w.max(1),
            rect.size.h.max(1),
            layout_state,
        );
    }

    fn shell_tile_frame_rect_for_output(
        &self,
        output: &Output,
        zone: &str,
    ) -> Option<Rectangle<i32, Logical>> {
        let area = self.workspace_auto_layout_frame_area_for_output(output)?;
        let half = area.size.w.max(1).saturating_div(2).max(1);
        match zone {
            "left-half" => Some(Rectangle::new(
                area.loc,
                Size::from((half, area.size.h.max(1))),
            )),
            "right-half" => {
                let x = area.loc.x.saturating_add(half);
                let w = area.size.w.saturating_sub(half).max(1);
                Some(Rectangle::new(
                    Point::from((x, area.loc.y)),
                    Size::from((w, area.size.h.max(1))),
                ))
            }
            _ => Some(area),
        }
    }

    fn shell_output_for_window_info(&self, info: &WindowInfo) -> Option<Output> {
        self.output_for_window_position(info.x, info.y, info.width, info.height)
            .and_then(|name| {
                self.output_topology.space
                    .outputs()
                    .find(|output| output.name() == name)
                    .cloned()
            })
            .or_else(|| {
                if info.output_name.is_empty() {
                    None
                } else {
                    self.output_topology.space
                        .outputs()
                        .find(|output| output.name() == info.output_name)
                        .cloned()
                }
            })
            .or_else(|| self.leftmost_output())
    }

    fn super_tile_window_half(&mut self, window_id: u32, right: bool) -> Result<(), String> {
        let info = self.windows.window_registry
            .window_info(window_id)
            .ok_or_else(|| "missing window".to_string())?;
        if info.minimized || info.fullscreen || self.window_info_is_solid_shell_host(&info) {
            return Err("window state".into());
        }
        let output = self
            .shell_output_for_window_info(&info)
            .ok_or_else(|| "output".to_string())?;
        let output_name = output.name();
        let zone = if right { "right-half" } else { "left-half" };
        let frame_rect = self
            .shell_tile_frame_rect_for_output(&output, zone)
            .ok_or_else(|| "tile frame".to_string())?;
        if !self.workspace_window_is_tiled(window_id) {
            let local = self
                .shell_window_info_to_output_local_layout(&info)
                .unwrap_or_else(|| info.clone());
            self.workspace_set_pre_tile_geometry(
                window_id,
                WorkspaceRect {
                    x: local.x,
                    y: local.y,
                    width: local.width.max(1),
                    height: local.height.max(1),
                },
            );
        }
        self.workspace_set_monitor_tile(
            &output_name,
            window_id,
            zone.to_string(),
            WorkspaceRect {
                x: frame_rect.loc.x,
                y: frame_rect.loc.y,
                width: frame_rect.size.w.max(1),
                height: frame_rect.size.h.max(1),
            },
        );
        let client_rect = self.workspace_auto_layout_client_rect_from_frame_rect(frame_rect);
        self.shell_apply_global_client_rect(window_id, client_rect, 0);
        self.workspace_send_state();
        Ok(())
    }

    fn super_tile_down(&mut self, window_id: u32) -> Result<(), String> {
        let info = self.windows.window_registry
            .window_info(window_id)
            .ok_or_else(|| "missing window".to_string())?;
        if info.minimized || self.window_info_is_solid_shell_host(&info) {
            return Err("window state".into());
        }
        if info.maximized {
            self.shell_set_window_maximized(window_id, false);
            return Ok(());
        }
        if self.workspace_window_is_tiled(window_id) {
            if let Some(bounds) = self.workspace_pre_tile_geometry(window_id) {
                self.shell_set_window_geometry(
                    window_id,
                    bounds.x,
                    bounds.y,
                    bounds.width.max(1),
                    bounds.height.max(1),
                    0,
                );
            }
            self.workspace_remove_monitor_tile(window_id);
            self.workspace_clear_pre_tile_geometry(window_id);
            self.workspace_send_state();
            return Ok(());
        }
        self.shell_set_window_maximized(window_id, false);
        Ok(())
    }

    fn shell_set_hidden_native_window_geometry(
        &mut self,
        window_id: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        target_output_name: &str,
        previous_output_name: &str,
        layout_state: u32,
    ) -> bool {
        let Some(record) = self.windows.window_registry.window_record(window_id) else {
            return false;
        };
        match record.restore_handle {
            RestoreHandle::Wayland(window) => {
                if layout_state == 0 {
                    self.clear_toplevel_layout_maps(window_id);
                } else if layout_state == 1 {
                    self.cancel_shell_move_resize_for_window(window_id);
                    if !self.windows.toplevel_floating_restore.contains_key(&window_id) {
                        if let Some(s) = self.toplevel_rect_snapshot(&window) {
                            self.windows.toplevel_floating_restore.insert(window_id, s);
                        }
                    }
                }
                let _ = self.windows.window_registry.update_native(window_id, |window_info| {
                    window_info.maximized = layout_state == 1;
                    window_info.fullscreen = false;
                    window_info.x = x;
                    window_info.y = y;
                    window_info.width = w.max(1);
                    window_info.height = h.max(1);
                    window_info.output_name = target_output_name.to_string();
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
                self.workspace_relayout_auto_layout_outputs_after_geometry(
                    previous_output_name,
                    target_output_name,
                );
                self.shell_reply_window_list();
                true
            }
            RestoreHandle::X11(x11) => {
                if layout_state == 0 {
                    self.clear_toplevel_layout_maps(window_id);
                } else {
                    self.cancel_shell_move_resize_for_window(window_id);
                    if !self.windows.toplevel_floating_restore.contains_key(&window_id) {
                        let geometry = x11.geometry();
                        self.windows.toplevel_floating_restore.insert(
                            window_id,
                            (
                                geometry.loc.x,
                                geometry.loc.y,
                                geometry.size.w,
                                geometry.size.h,
                            ),
                        );
                    }
                }
                let _ = self.windows.window_registry.update_native(window_id, |window_info| {
                    window_info.maximized = layout_state == 1;
                    window_info.fullscreen = false;
                    window_info.x = x;
                    window_info.y = y;
                    window_info.width = w.max(1);
                    window_info.height = h.max(1);
                    window_info.output_name = target_output_name.to_string();
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
                self.workspace_relayout_auto_layout_outputs_after_geometry(
                    previous_output_name,
                    target_output_name,
                );
                self.shell_reply_window_list();
                true
            }
            RestoreHandle::None => false,
        }
    }

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
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return;
        };
        let previous_output_name = info.output_name.clone();
        if self.window_info_is_solid_shell_host(&info) {
            return;
        }
        let Some(sid) = self.windows.window_registry.surface_id_for_window(window_id) else {
            return;
        };
        let Some((x, y, w, h)) = self.shell_output_local_rect_to_logical_global(lx, ly, lw, lh)
        else {
            return;
        };
        let target_output_name = self
            .output_for_window_position(x, y, w, h)
            .unwrap_or_default();
        if info.minimized
            && self.shell_set_hidden_native_window_geometry(
                window_id,
                x,
                y,
                w,
                h,
                &target_output_name,
                &previous_output_name,
                layout_state,
            )
        {
            return;
        }
        if let Some(window) = self.find_window_by_surface_id(sid) {
            if layout_state == 0 {
                self.clear_toplevel_layout_maps(window_id);
            } else if layout_state == 1 {
                self.cancel_shell_move_resize_for_window(window_id);
                if !self.windows.toplevel_floating_restore.contains_key(&window_id) {
                    if let Some(s) = self.toplevel_rect_snapshot(&window) {
                        self.windows.toplevel_floating_restore.insert(window_id, s);
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
            self.output_topology.space
                .map_element(DerpSpaceElem::Wayland(window.clone()), (map_x, map_y), true);
            self.shell_emit_requested_native_geometry(
                window_id,
                map_x,
                map_y,
                content_w,
                content_h,
                target_output_name,
                layout_state == 1,
                false,
            );
            let next_output_name = self.windows.window_registry
                .window_info(window_id)
                .map(|info| info.output_name)
                .unwrap_or_default();
            self.workspace_relayout_auto_layout_outputs_after_geometry(
                &previous_output_name,
                &next_output_name,
            );
            self.shell_reply_window_list();
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            return;
        };
        if layout_state == 0 {
            self.clear_toplevel_layout_maps(window_id);
        } else {
            self.cancel_shell_move_resize_for_window(window_id);
            if !self.windows.toplevel_floating_restore.contains_key(&window_id) {
                let geometry = x11.geometry();
                let location = self.output_topology.space
                    .element_location(&DerpSpaceElem::X11(x11.clone()))
                    .unwrap_or(geometry.loc);
                self.windows.toplevel_floating_restore.insert(
                    window_id,
                    (location.x, location.y, geometry.size.w, geometry.size.h),
                );
            }
        }
        let rect = Rectangle::new(Point::from((x, y)), Size::from((w.max(1), h.max(1))));
        self.apply_x11_window_bounds(window_id, &x11, rect, layout_state == 1, false, true);
        self.workspace_relayout_auto_layout_outputs_after_geometry(
            &previous_output_name,
            &target_output_name,
        );
        self.shell_reply_window_list();
    }

    fn shell_close_group_window(&mut self, window_id: u32) -> bool {
        let group_window_ids =
            group_id_for_window(&self.workspace_layout.workspace_state, window_id).and_then(|group_id| {
                self.workspace_layout.workspace_state
                    .groups
                    .iter()
                    .find(|group| group.id == group_id)
                    .map(|group| group.window_ids.clone())
            });
        let Some(group_window_ids) = group_window_ids else {
            if self.windows.window_registry.window_info(window_id).is_none() {
                return false;
            }
            self.shell_close_window(window_id);
            return true;
        };
        for member_window_id in group_window_ids.iter().copied() {
            if member_window_id == window_id {
                continue;
            }
            self.shell_close_window(member_window_id);
        }
        self.shell_close_window(window_id);
        true
    }

    pub fn shell_close_window(&mut self, window_id: u32) {
        tracing::warn!(
            target: "derp_shell_close",
            window_id,
            "shell_close_window begin"
        );
        if self.shell_backed_close_if_any(window_id) {
            tracing::warn!(
                target: "derp_shell_close",
                window_id,
                "shell_close_window done shell_hosted"
            );
            self.workspace_apply_close_side_effects(window_id);
            return;
        }
        if let Some(target) = self.close_refocus_target_for_window(window_id) {
            self.windows.shell_close_refocus_targets.insert(window_id, target);
        } else {
            self.windows.shell_close_refocus_targets.remove(&window_id);
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            tracing::warn!(
                target: "derp_toplevel",
                window_id,
                "shell_close_window: no registry entry; prune shell + resync"
            );
            self.shell_send_to_cef(
                shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { window_id },
            );
            self.shell_reply_window_list();
            tracing::warn!(
                target: "derp_shell_close",
                window_id,
                "shell_close_window done prune_missing_registry"
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
        let Some(sid) = self.windows.window_registry.surface_id_for_window(window_id) else {
            tracing::warn!(
                target: "derp_toplevel",
                window_id,
                title = %info.title,
                "shell_close_window abort: no surface_id_for_window"
            );
            return;
        };
        if let Some(w) = self.find_window_by_surface_id(sid) {
            self.output_topology.space
                .raise_element(&DerpSpaceElem::Wayland(w.clone()), true);
            let wl_surf = w.toplevel().unwrap().wl_surface().clone();
            let k_serial = SERIAL_COUNTER.next_serial();
            if let Some(kb) = self.input_routing.seat.get_keyboard() {
                kb.set_focus(self, Some(wl_surf), k_serial);
            }
        } else if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
            self.output_topology.space
                .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
            if let Some(wl_surf) = x11.wl_surface() {
                let k_serial = SERIAL_COUNTER.next_serial();
                if let Some(kb) = self.input_routing.seat.get_keyboard() {
                    kb.set_focus(self, Some(wl_surf), k_serial);
                }
            }
        }
        if self.input_routing.shell_move_window_id == Some(window_id) {
            self.shell_move_end(window_id);
        }
        if self.input_routing.shell_resize_window_id == Some(window_id) {
            self.shell_resize_end(window_id);
        }
        if let Some(record) = self.windows.window_registry.window_record(window_id) {
            match record.restore_handle {
                RestoreHandle::Wayland(window) => {
                    let Some(tl) = window.toplevel() else {
                        return;
                    };
                    let _ = self.windows.window_registry
                        .transition(window_id, WindowLifecycleEvent::RequestClose);
                    self.windows.shell_close_pending_native_windows.insert(window_id);
                    tl.send_close();
                    tracing::warn!(
                        target: "derp_shell_close",
                        window_id,
                        "shell_close_window done minimized_wayland_send_close"
                    );
                    return;
                }
                RestoreHandle::X11(x11) => {
                    if self.x11_window_should_hide_to_tray_on_close(&info) {
                        self.shell_hide_x11_window_to_tray(window_id, &x11);
                        return;
                    }
                    let _ = self.windows.window_registry
                        .transition(window_id, WindowLifecycleEvent::RequestClose);
                    self.windows.shell_close_pending_native_windows.insert(window_id);
                    if let Err(error) = x11.close() {
                        tracing::warn!(
                            target: "derp_toplevel",
                            window_id,
                            ?error,
                            "shell_close_window minimized x11 close failed"
                        );
                        self.windows.shell_close_pending_native_windows.remove(&window_id);
                        self.windows.shell_close_refocus_targets.remove(&window_id);
                        let _ = self.windows.window_registry
                            .transition(window_id, WindowLifecycleEvent::Minimize);
                    }
                    return;
                }
                RestoreHandle::None => {}
            }
        }
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let Some(tl) = window.toplevel() else {
                return;
            };
            let _ = self.windows.window_registry
                .transition(window_id, WindowLifecycleEvent::RequestClose);
            self.windows.shell_close_pending_native_windows.insert(window_id);
            tracing::warn!(
                target: "derp_toplevel",
                window_id,
                wl_surface_protocol_id = tl.wl_surface().id().protocol_id(),
                title = %info.title,
                app_id = %info.app_id,
                "shell_close_window send_close"
            );
            tl.send_close();
            tracing::warn!(
                target: "derp_shell_close",
                window_id,
                "shell_close_window done wayland_send_close"
            );
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            if self.x11_window_should_hide_to_tray_on_close(&info)
                && self.windows.window_registry.window_kind(window_id) == Some(WindowKind::Native)
            {
                if let Some(x11) = self.windows.shell_known_x11_windows.get(&window_id).cloned() {
                    self.shell_hide_x11_window_to_tray(window_id, &x11);
                    return;
                }
                self.remember_tray_hidden_x11_window_id(window_id, Some(&info));
                self.windows.shell_close_pending_native_windows.remove(&window_id);
                self.windows.shell_close_refocus_targets.remove(&window_id);
                self.shell_emit_chrome_window_unmapped(
                    window_id,
                    self.windows.window_registry.window_info(window_id),
                );
                self.shell_reply_window_list();
                return;
            }
            tracing::warn!(
                target: "derp_toplevel",
                window_id,
                "shell_close_window abort: no mapped native window"
            );
            return;
        };
        if self.x11_window_should_hide_to_tray_on_close(&info) {
            self.shell_hide_x11_window_to_tray(window_id, &x11);
            return;
        }
        tracing::warn!(
            target: "derp_toplevel",
            window_id,
            x11_window_id = x11.window_id(),
            title = %info.title,
            app_id = %info.app_id,
            "shell_close_window x11 close"
        );
        let _ = self.windows.window_registry
            .transition(window_id, WindowLifecycleEvent::RequestClose);
        self.windows.shell_close_pending_native_windows.insert(window_id);
        if let Err(error) = x11.close() {
            tracing::warn!(
                target: "derp_toplevel",
                window_id,
                ?error,
                "shell_close_window x11 close failed"
            );
            self.windows.shell_close_pending_native_windows.remove(&window_id);
            self.windows.shell_close_refocus_targets.remove(&window_id);
            let _ = self.windows.window_registry
                .transition(window_id, WindowLifecycleEvent::Map);
        } else {
            tracing::warn!(
                target: "derp_shell_close",
                window_id,
                "shell_close_window done x11"
            );
        }
    }

    pub(crate) fn hide_bufferless_native_window(&mut self, root: &WlSurface) {
        let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(root) else {
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
        let pending_deferred = self.window_id_is_deferred_initial_map(window_id);
        let Some(window) = self.output_topology.space.elements().find_map(|e| {
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
        if pending_deferred && !buffer_removed {
            return;
        }
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
            close_pending = self.windows.shell_close_pending_native_windows.contains(&window_id),
            "native window lost content; pruning stuck window"
        );
        self.output_topology.space.unmap_elem(&DerpSpaceElem::Wayland(window));
        self.clear_toplevel_layout_maps(window_id);
        self.windows.pending_gnome_initial_toplevels.remove(&window_id);
        self.windows.shell_close_pending_native_windows.remove(&window_id);
        let keyboard_had_focus = self.keyboard_focused_window_id() == Some(window_id);
        if self.windows.shell_pending_native_focus_window_id == Some(window_id) {
            self.windows.shell_pending_native_focus_window_id = None;
        }
        self.shell_window_stack_forget(window_id);
        self.windows.window_registry.clear_restore_handle(window_id);
        if keyboard_had_focus {
            let serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Option::<WlSurface>::None, serial);
            self.keyboard_on_focus_surface_changed(None);
        }
        let removed = self.windows.window_registry.snapshot_for_wl_surface(root);
        if let Some(pruned_window_id) = self.windows.window_registry.remove_by_wl_surface(root) {
            self.capture_forget_window_source_cache(pruned_window_id);
            self.shell_emit_chrome_window_unmapped(pruned_window_id, removed);
            self.try_refocus_after_closed_window(pruned_window_id, keyboard_had_focus);
        } else {
            self.windows.shell_close_refocus_targets.remove(&window_id);
        }
    }

    pub fn shell_set_window_fullscreen(&mut self, window_id: u32, enabled: bool) {
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            return;
        }
        let Some(sid) = self.windows.window_registry.surface_id_for_window(window_id) else {
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
                    self.windows.toplevel_fullscreen_return_maximized.insert(window_id);
                } else {
                    self.windows.toplevel_fullscreen_return_maximized.remove(&window_id);
                    if !self.windows.toplevel_floating_restore.contains_key(&window_id) {
                        if let Some(s) = self.toplevel_rect_snapshot(&window) {
                            self.windows.toplevel_floating_restore.insert(window_id, s);
                        }
                    }
                }
                if self.apply_toplevel_fullscreen_layout(&window, None) {
                    self.shell_reply_window_list();
                }
            } else {
                if !read_toplevel_tiling(wl).1 {
                    return;
                }
                if self.toplevel_unfullscreen(&window) {
                    self.shell_reply_window_list();
                }
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
                self.windows.toplevel_fullscreen_return_maximized.insert(window_id);
            } else {
                self.windows.toplevel_fullscreen_return_maximized.remove(&window_id);
                if !self.windows.toplevel_floating_restore.contains_key(&window_id) {
                    let geometry = x11.geometry();
                    let location = self.output_topology.space
                        .element_location(&DerpSpaceElem::X11(x11.clone()))
                        .unwrap_or(geometry.loc);
                    self.windows.toplevel_floating_restore.insert(
                        window_id,
                        (location.x, location.y, geometry.size.w, geometry.size.h),
                    );
                }
            }
            let Some(output) = self.x11_target_output(window_id) else {
                return;
            };
            let Some(rect) = self.output_topology.space.output_geometry(&output) else {
                return;
            };
            if self.apply_x11_window_bounds(window_id, &x11, rect, false, true, true) {
                self.shell_reply_window_list();
            }
            return;
        }
        if !info.fullscreen {
            return;
        }
        if self.windows.toplevel_fullscreen_return_maximized.remove(&window_id) {
            self.shell_set_window_maximized(window_id, true);
            return;
        }
        let rect = self.windows.toplevel_floating_restore
            .remove(&window_id)
            .map(|(x, y, w, h)| Rectangle::new(Point::from((x, y)), Size::from((w, h))))
            .unwrap_or_else(|| {
                let geometry = x11.geometry();
                let location = self.output_topology.space
                    .element_location(&DerpSpaceElem::X11(x11.clone()))
                    .unwrap_or(geometry.loc);
                Rectangle::new(location, geometry.size)
            });
        if self.apply_x11_window_bounds(window_id, &x11, rect, false, false, true) {
            self.shell_reply_window_list();
        }
    }

    pub fn shell_set_window_maximized(&mut self, window_id: u32, enabled: bool) {
        if self.shell_backed_set_window_maximized_if_any(window_id, enabled) {
            return;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            return;
        }
        let Some(sid) = self.windows.window_registry.surface_id_for_window(window_id) else {
            return;
        };
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let wl = window.toplevel().unwrap().wl_surface();
            if enabled {
                if read_toplevel_tiling(wl).0 || read_toplevel_tiling(wl).1 {
                    return;
                }
                if !self.windows.toplevel_floating_restore.contains_key(&window_id) {
                    if let Some(s) = self.toplevel_rect_snapshot(&window) {
                        self.windows.toplevel_floating_restore.insert(window_id, s);
                    }
                }
                if self.apply_toplevel_maximize_layout(&window) {
                    self.shell_reply_window_list();
                }
            } else {
                if !read_toplevel_tiling(wl).0 {
                    return;
                }
                if self.toplevel_unmaximize(&window) {
                    self.shell_reply_window_list();
                }
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
            if !self.windows.toplevel_floating_restore.contains_key(&window_id) {
                let geometry = x11.geometry();
                let location = self.output_topology.space
                    .element_location(&DerpSpaceElem::X11(x11.clone()))
                    .unwrap_or(geometry.loc);
                self.windows.toplevel_floating_restore.insert(
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
            if self.apply_x11_window_bounds(window_id, &x11, rect, true, false, true) {
                self.shell_reply_window_list();
            }
            return;
        }
        if !info.maximized {
            return;
        }
        let rect = self.windows.toplevel_floating_restore
            .remove(&window_id)
            .map(|(x, y, w, h)| Rectangle::new(Point::from((x, y)), Size::from((w, h))))
            .unwrap_or_else(|| {
                let geometry = x11.geometry();
                let location = self.output_topology.space
                    .element_location(&DerpSpaceElem::X11(x11.clone()))
                    .unwrap_or(geometry.loc);
                Rectangle::new(location, geometry.size)
            });
        if self.apply_x11_window_bounds(window_id, &x11, rect, false, false, true) {
            self.shell_reply_window_list();
        }
    }

    pub fn shell_set_presentation_fullscreen(&mut self, enabled: bool) {
        self.shell_osr.shell_presentation_fullscreen = enabled;
    }

    pub(crate) fn keyboard_focused_window_id(&self) -> Option<u32> {
        let surf = self.input_routing.seat.get_keyboard()?.current_focus()?;
        let window_id = self.windows.window_registry.window_id_for_wl_surface(&surf)?;
        self.logical_focus_target_is_valid(window_id)
            .then_some(window_id)
    }

    pub(crate) fn try_refocus_after_closed_toplevel(&mut self) {
        let Some(target) = self.pick_next_logical_focus_target(None, true) else {
            let serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat
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
        if let Some(target) = self.windows.shell_close_refocus_targets.remove(&closed_window_id) {
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
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return;
        };
        if info.minimized || self.window_info_is_solid_shell_host(&info) {
            return;
        }
        let Some(sid) = self.windows.window_registry.surface_id_for_window(window_id) else {
            return;
        };
        self.shell_keyboard_capture_clear();
        self.shell_note_non_shell_focus();
        self.output_topology.space.elements().for_each(|e| {
            e.set_activate(false);
            if let DerpSpaceElem::Wayland(w) = e {
                w.toplevel().unwrap().send_pending_configure();
            }
        });
        if let Some(window) = self.find_window_by_surface_id(sid) {
            if self.windows.shell_pending_native_focus_window_id == Some(window_id) {
                self.windows.shell_pending_native_focus_window_id = None;
            }
            let _ = window.set_activated(true);
            self.output_topology.space
                .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
            self.shell_window_stack_touch(window_id);
            let wl_surface = window.toplevel().unwrap().wl_surface().clone();
            let k_serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Some(wl_surface), k_serial);
            self.shell_emit_chrome_event(ChromeEvent::FocusChanged {
                surface_id: Some(sid),
                window_id: Some(window_id),
            });
            self.output_topology.space.elements().for_each(|e| {
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
        self.output_topology.space
            .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
        self.shell_window_stack_touch(window_id);
        if let Some(wl_surface) = x11.wl_surface() {
            self.windows.shell_pending_native_focus_window_id = None;
            let k_serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Some(wl_surface), k_serial);
            self.shell_emit_chrome_event(ChromeEvent::FocusChanged {
                surface_id: Some(sid),
                window_id: Some(window_id),
            });
        } else {
            self.windows.shell_pending_native_focus_window_id = Some(window_id);
        }
        self.emit_x11_window_updates(&x11, false, false);
    }

    fn shell_emit_window_state(&mut self, window_id: u32, minimized: bool) {
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return;
        };
        let output_name = info.output_name.clone();
        self.shell_emit_chrome_event(ChromeEvent::WindowStateChanged { info, minimized });
        if !output_name.is_empty() {
            let _ = self.workspace_apply_auto_layout_for_output_name(&output_name);
        }
        self.shell_reply_window_list();
    }

    /// Hide a toplevel (xdg minimized + unmap); stash the [`Window`] for restore.
    pub fn shell_minimize_window(&mut self, window_id: u32) {
        if self.shell_backed_minimize_if_any(window_id) {
            return;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            return;
        }
        if self.windows.window_registry.lifecycle(window_id) == Some(WindowLifecycle::CloseRequested) {
            return;
        }
        if info.minimized {
            return;
        }
        let Some(sid) = self.windows.window_registry.surface_id_for_window(window_id) else {
            return;
        };
        if self.input_routing.shell_move_window_id == Some(window_id) {
            self.shell_move_end(window_id);
        }
        if self.input_routing.shell_resize_window_id == Some(window_id) {
            self.shell_resize_end(window_id);
        }
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let _ = window.set_activated(false);
            window.toplevel().unwrap().send_pending_configure();
            let _ = self.windows.window_registry
                .set_restore_handle(window_id, RestoreHandle::Wayland(window.clone()));
            let _ = self.windows.window_registry
                .transition(window_id, WindowLifecycleEvent::Minimize);
            self.output_topology.space.unmap_elem(&DerpSpaceElem::Wayland(window));

            if self.keyboard_focused_window_id() == Some(window_id) {
                let serial = SERIAL_COUNTER.next_serial();
                self.input_routing.seat.get_keyboard().unwrap().set_focus(
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
        let _ = self.windows.window_registry
            .set_restore_handle(window_id, RestoreHandle::X11(x11.clone()));
        let _ = self.windows.window_registry
            .transition(window_id, WindowLifecycleEvent::Minimize);
        if self.windows.shell_pending_native_focus_window_id == Some(window_id) {
            self.windows.shell_pending_native_focus_window_id = None;
        }
        if let Err(error) = x11.set_activated(false) {
            tracing::warn!(window_id, ?error, "x11 set_activated failed");
        }
        if let Err(error) = x11.set_hidden(true) {
            tracing::warn!(window_id, ?error, "x11 set_hidden failed");
        }
        self.output_topology.space.unmap_elem(&DerpSpaceElem::X11(x11.clone()));
        if self.keyboard_focused_window_id() == Some(window_id) {
            let serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat
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
        if self.windows.window_registry
            .window_info(window_id)
            .filter(|_| self.windows.window_registry.is_shell_hosted(window_id))
            .is_some_and(|info| info.minimized)
        {
            self.shell_backed_restore_minimized_if_any(window_id);
            self.shell_focus_shell_ui_window(window_id);
            return;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            return;
        }
        if !info.minimized {
            return;
        }
        match self.windows.window_registry.take_restore_handle(window_id) {
            RestoreHandle::Wayland(window) => {
            self.shell_keyboard_capture_clear();
            self.output_topology.space.elements().for_each(|e| {
                e.set_activate(false);
                if let DerpSpaceElem::Wayland(w) = e {
                    w.toplevel().unwrap().send_pending_configure();
                }
            });

            self.output_topology.space.map_element(
                DerpSpaceElem::Wayland(window.clone()),
                (info.x, info.y),
                true,
            );
            let _ = self.windows.window_registry
                .transition(window_id, WindowLifecycleEvent::Restore);

            let _ = window.set_activated(true);
            self.output_topology.space
                .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
            let wl_surface = window.toplevel().unwrap().wl_surface().clone();
            let k_serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Some(wl_surface), k_serial);
            self.output_topology.space.elements().for_each(|e| {
                if let DerpSpaceElem::Wayland(w) = e {
                    w.toplevel().unwrap().send_pending_configure();
                }
            });

            self.shell_emit_requested_native_geometry(
                window_id,
                info.x,
                info.y,
                info.width,
                info.height,
                info.output_name.clone(),
                info.maximized,
                info.fullscreen,
            );
            self.shell_emit_window_state(window_id, false);
            return;
            }
            RestoreHandle::X11(x11) => {

        self.shell_keyboard_capture_clear();
        self.output_topology.space.elements().for_each(|e| {
            e.set_activate(false);
            if let DerpSpaceElem::Wayland(w) = e {
                w.toplevel().unwrap().send_pending_configure();
            }
        });
        self.windows.shell_pending_native_focus_window_id = Some(window_id);
        let _ = self.windows.window_registry
            .transition(window_id, WindowLifecycleEvent::Restore);
        if let Err(error) = x11.set_hidden(false) {
            tracing::warn!(window_id, ?error, "x11 set_hidden(false) failed");
        }
        let rect = Rectangle::new(
            Point::from((info.x, info.y)),
            Size::from((info.width.max(1), info.height.max(1))),
        );
        self.output_topology.space.map_element(
            DerpSpaceElem::X11(x11.clone()),
            (rect.loc.x, rect.loc.y),
            false,
        );
        self.apply_x11_window_bounds(window_id, &x11, rect, info.maximized, info.fullscreen, true);
        if let Err(error) = x11.set_activated(true) {
            tracing::warn!(window_id, ?error, "x11 set_activated(true) failed");
        }
        self.output_topology.space
            .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
        if let Some(wl_surface) = x11.wl_surface() {
            self.windows.shell_pending_native_focus_window_id = None;
            let k_serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Some(wl_surface), k_serial);
        }
        self.emit_x11_window_updates(&x11, true, false);
        self.shell_emit_window_state(window_id, false);
        if self.windows.shell_pending_native_focus_window_id == Some(window_id) {
            self.shell_raise_and_focus_window(window_id);
        }
            }
            RestoreHandle::None => {
                let _ = self.windows.window_registry
                    .transition(window_id, WindowLifecycleEvent::Restore);
            }
        }
    }

    /// Taskbar: restore if minimized; else minimize if already focused; else raise and focus.
    pub fn shell_taskbar_activate(&mut self, window_id: u32) {
        if self.shell_backed_taskbar_activate(window_id) {
            return;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            return;
        }

        if info.minimized {
            self.shell_restore_minimized_window(window_id);
            return;
        }

        let should_minimize = self.shell_taskbar_should_toggle_minimize(window_id);
        if should_minimize {
            self.shell_minimize_window(window_id);
        } else {
            self.shell_raise_and_focus_window(window_id);
            self.shell_reply_window_list();
        }
    }

    /// Shell-internal activation without taskbar toggle semantics.
    pub fn shell_activate_window(&mut self, window_id: u32) {
        if self.windows.window_registry.is_shell_hosted(window_id) {
            if self.windows.window_registry
                .window_info(window_id)
                .is_some_and(|info| info.minimized)
            {
                self.shell_backed_restore_minimized_if_any(window_id);
            }
            self.shell_focus_shell_ui_window(window_id);
            return;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
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
        InputRoutingState::shell_pointer_ipc_for_cef(
            pos,
            self.output_topology.shell_canvas_logical_origin,
            self.output_topology.shell_canvas_logical_size,
        )
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
        let workspace_ready = self.workspace_logical_bounds().is_some();
        let shell_output_logical_size = self.shell_output_logical_size();
        let applied = self.shell_osr.apply_shell_frame_dmabuf(
            width,
            height,
            drm_format,
            modifier,
            flags,
            planes,
            fds,
            dirty_buffer,
            workspace_ready,
            shell_output_logical_size,
        )?;
        let mut handoff_shell_move_proxy = false;
        let proxy_release_state = self.input_routing.shell_move_proxy
            .as_ref()
            .and_then(|proxy| proxy.release_state.map(|state| (proxy.window_id, state)));
        let released_move_proxy = match proxy_release_state {
            Some((_, ShellMoveProxyReleaseState::AwaitShellStateCommit(commit)))
                if commit != applied.commit =>
            {
                if let Some(proxy) = self.input_routing.shell_move_proxy.as_mut() {
                    proxy.release_state =
                        Some(ShellMoveProxyReleaseState::AwaitVisibleShellCommit {
                            commit: applied.commit,
                            ui_generation: self.shell_osr.shell_ui_windows_generation,
                        });
                }
                handoff_shell_move_proxy = true;
                false
            }
            Some((
                window_id,
                ShellMoveProxyReleaseState::AwaitVisibleShellCommit { commit, .. },
            )) if commit != applied.commit
                && self.shell_move_proxy_release_ready_now(window_id) =>
            {
                true
            }
            _ => false,
        };
        if released_move_proxy {
            self.input_routing.shell_move_proxy = None;
        }

        if handoff_shell_move_proxy || released_move_proxy {
            self.shell_send_interaction_state();
        }
        self.shell_move_proxy_try_arm_capture();
        self.shell_move_try_activate_deferred();
        self.shell_move_flush_pending_deltas();
        Ok(())
    }

    pub fn apply_shell_frame_software(
        &mut self,
        width: u32,
        height: u32,
        pixels: Vec<u8>,
        dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
    ) -> Result<(), &'static str> {
        let workspace_ready = self.workspace_logical_bounds().is_some();
        self.shell_osr.apply_shell_frame_software(
            width,
            height,
            pixels,
            dirty_buffer,
            workspace_ready,
        )?;
        self.shell_move_proxy_try_arm_capture();
        self.shell_move_try_activate_deferred();
        self.shell_move_flush_pending_deltas();
        Ok(())
    }

    pub fn clear_shell_frame(&mut self) {
        self.shell_osr.clear_shell_frame();
        self.input_routing.shell_move_proxy = None;
        self.input_routing.shell_native_drag_preview = None;
        self.input_routing.shell_last_pointer_ipc_px = None;
        self.input_routing.shell_last_pointer_ipc_global_logical = None;
        self.input_routing.shell_last_pointer_ipc_modifiers = None;
        self.input_routing.touch_routes_to_cef = false;
    }

    /// Current keyboard → `cef_event_flags_t` (shift/control/alt/meta/caps/AltGr).
    pub(crate) fn shell_cef_event_flags(&self) -> u32 {
        self.input_routing.shell_cef_event_flags()
    }

    fn cef_flags_from_modifiers(m: &ModifiersState) -> u32 {
        InputRoutingState::cef_flags_from_modifiers(m)
    }

    pub(crate) fn shell_cef_sym_should_autorepeat(raw: u32) -> bool {
        InputRoutingState::shell_cef_sym_should_autorepeat(raw)
    }

    pub(crate) fn shell_cef_repeat_clear(&mut self, lh: &LoopHandle<CalloopData>) {
        self.input_routing.shell_cef_repeat_clear(lh);
    }

    pub(crate) fn shell_cef_repeat_arm(
        &mut self,
        lh: &LoopHandle<CalloopData>,
        keycode: Keycode,
        sym_raw: u32,
    ) {
        self.shell_cef_repeat_clear(lh);
        self.input_routing.shell_cef_repeat_keycode = Some(keycode);
        self.input_routing.shell_cef_repeat_sym_raw = Some(sym_raw);
        let lh2 = lh.clone();
        match lh.insert_source(
            Timer::from_duration(Duration::from_millis(200)),
            move |_, _, d: &mut CalloopData| d.state.shell_cef_repeat_on_tick(&lh2),
        ) {
            Ok(t) => self.input_routing.shell_cef_repeat_token = Some(t),
            Err(_) => {
                self.input_routing.shell_cef_repeat_keycode = None;
                self.input_routing.shell_cef_repeat_sym_raw = None;
            }
        }
    }

    fn shell_cef_repeat_on_tick(&mut self, lh: &LoopHandle<CalloopData>) -> TimeoutAction {
        let Some(keycode) = self.input_routing.shell_cef_repeat_keycode else {
            self.input_routing.shell_cef_repeat_token = None;
            return TimeoutAction::Drop;
        };
        let Some(keyboard) = self.input_routing.seat.get_keyboard().map(|k| k.clone()) else {
            self.shell_cef_repeat_clear(lh);
            return TimeoutAction::Drop;
        };
        if !keyboard.pressed_keys().contains(&keycode) {
            self.shell_cef_repeat_clear(lh);
            return TimeoutAction::Drop;
        }
        if !self.shell_keyboard_capture_active()
            || !self.shell_cef_active()
            || !self.shell_osr.shell_has_frame
        {
            self.shell_cef_repeat_clear(lh);
            return TimeoutAction::Drop;
        }
        let Some(sym_raw) = self.input_routing.shell_cef_repeat_sym_raw else {
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
        if !self.shell_cef_active() || !self.shell_osr.shell_has_frame {
            return;
        }
        let sym = keysym.modified_sym();
        let mut mods_u = Self::cef_flags_from_modifiers(mods);
        if key_state == KeyState::Pressed && is_autorepeat {
            mods_u |= InputRoutingState::CEF_EVENTFLAG_IS_REPEAT;
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
        if !self.shell_cef_active() || !self.shell_osr.shell_has_frame {
            return;
        }
        self.sync_shell_shared_state_for_input();
        let route = self.shell_pointer_should_ipc_to_cef(pos);
        if !route
            && !self.shell_move_is_active()
            && !self.shell_resize_is_active()
            && self.input_routing.shell_ui_pointer_grab.is_none()
        {
            return;
        }
        let Some((bx, by)) = self.shell_pointer_coords_for_cef(pos) else {
            return;
        };
        let global_key = (pos.x.round() as i32, pos.y.round() as i32);
        let modifiers = self.shell_cef_event_flags();
        if self.input_routing.shell_last_pointer_ipc_global_logical == Some(global_key)
            && self.input_routing.shell_last_pointer_ipc_modifiers == Some(modifiers)
        {
            return;
        }
        self.input_routing.shell_last_pointer_ipc_global_logical = Some(global_key);
        self.input_routing.shell_last_pointer_ipc_px = Some((bx, by));
        self.input_routing.shell_last_pointer_ipc_modifiers = Some(modifiers);
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::PointerMove {
            x: bx,
            y: by,
            modifiers,
        });
    }

    /// Forward scroll / pointer axis to `cef_host` when the pointer is over the Solid shell (OSR).
    pub(crate) fn shell_ipc_maybe_forward_pointer_axis(&mut self, delta_x: i32, delta_y: i32) {
        if !self.shell_cef_active() || !self.shell_osr.shell_has_frame {
            return;
        }
        if delta_x == 0 && delta_y == 0 {
            return;
        }
        let Some(pointer) = self.input_routing.seat.get_pointer() else {
            return;
        };
        let pos = pointer.current_location();
        self.sync_shell_shared_state_for_input();
        let route = self.shell_pointer_should_ipc_to_cef(pos);
        if !route
            && !self.shell_move_is_active()
            && !self.shell_resize_is_active()
            && self.input_routing.shell_ui_pointer_grab.is_none()
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

    pub(crate) fn shell_ipc_refresh_pointer_modifiers(&mut self) {
        let Some(pointer) = self.input_routing.seat.get_pointer() else {
            return;
        };
        self.shell_ipc_maybe_forward_pointer_move(pointer.current_location());
    }

    pub(crate) fn apply_cursor_settings(
        &mut self,
        settings: crate::session::settings_config::CursorSettingsFile,
    ) -> Result<crate::session::settings_config::CursorSettingsFile, String> {
        let settings = crate::session::settings_config::write_cursor_settings(settings)?;
        crate::session::settings_config::mirror_cursor_settings_to_gnome(&settings);
        self.input_routing.cursor_theme.apply_settings(settings.clone());
        self.core.loop_signal.wakeup();
        Ok(settings)
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
        let display = self.core.socket_name.to_string_lossy().into_owned();
        let runtime = std::env::var("XDG_RUNTIME_DIR").map_err(|_| "XDG_RUNTIME_DIR unset")?;
        let mut envs = vec![
            ("WAYLAND_DISPLAY".to_string(), display),
            ("XDG_RUNTIME_DIR".to_string(), runtime),
        ];
        let cursor_settings = self.input_routing.cursor_theme.settings();
        envs.push(("XCURSOR_THEME".to_string(), cursor_settings.theme));
        envs.push(("XCURSOR_SIZE".to_string(), cursor_settings.size.to_string()));
        self.xdg_activation_prune_stale_tokens();
        let activation_token = {
            let surface = self.input_routing.seat
                .get_keyboard()
                .and_then(|keyboard| keyboard.current_focus())
                .or_else(|| {
                    self.input_routing.seat
                        .get_pointer()
                        .and_then(|pointer| pointer.current_focus())
                });
            let app_id = self
                .logical_focused_window_id()
                .or_else(|| self.keyboard_focused_window_id())
                .and_then(|window_id| self.windows.window_registry.window_info(window_id))
                .map(|info| info.app_id);
            let data = XdgActivationTokenData {
                app_id,
                surface,
                ..Default::default()
            };
            let (token, _) = self.xdg_activation_state.create_external_token(Some(data));
            String::from(token.clone())
        };
        envs.push(("XDG_ACTIVATION_TOKEN".to_string(), activation_token));
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

        self.windows.shell_spawn_known_native_window_ids = Some(
            self.windows.window_registry
                .all_records()
                .into_iter()
                .filter(|record| record.kind == WindowKind::Native)
                .map(|record| record.info.window_id)
                .collect(),
        );

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
            let child = match cmd.spawn() {
                Ok(child) => child,
                Err(error) => {
                    self.windows.shell_spawn_known_native_window_ids = None;
                    return Err(error.to_string());
                }
            };
            tracing::debug!(
                pid = child.id(),
                "spawned Wayland client via direct fallback"
            );
        }
        Ok(())
    }
}


mod core;
pub(crate) use core::*;
mod capture;
use capture::*;
mod outputs;
pub(crate) use outputs::*;
mod shell_osr;
pub(crate) use shell_osr::*;
mod workspace;
pub(crate) use workspace::*;
mod input_routing;
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
mod scratchpads;
mod x11;
mod protocols;

pub struct ClientState {
    pub compositor_state: CompositorClientState,
}

impl Default for ClientState {
    fn default() -> Self {
        Self {
            compositor_state: CompositorClientState::default(),
        }
    }
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
