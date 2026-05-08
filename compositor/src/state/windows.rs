use super::*;

pub(crate) struct WindowManagementState {
    pub(crate) chrome_bridge: SharedChromeBridge,
    pub(crate) window_registry: WindowRegistry,
    pub(crate) pending_deferred_toplevels: HashMap<(ClientId, u32), PendingDeferredToplevel>,
    pub(crate) pending_gnome_initial_toplevels: HashSet<u32>,
    pub(crate) wayland_commit_needs_render: bool,
    pub(crate) xwayland_shell_state: XWaylandShellState,
    pub(crate) x11_wm_slot: Option<(XwmId, X11Wm)>,
    pub(crate) x11_client: Option<Client>,
    pub(crate) shell_spawn_known_native_window_ids: Option<HashSet<u32>>,
    pub(crate) shell_spawn_target_output_name: Option<String>,
    pub(crate) shell_pending_native_configure_frames: HashMap<u32, PendingNativeConfigureFrame>,
    pub(crate) shell_known_x11_windows: HashMap<u32, X11Surface>,
    pub(crate) shell_pending_native_focus_window_id: Option<u32>,
    pub(crate) shell_close_pending_native_windows: HashSet<u32>,
    pub(crate) shell_close_refocus_targets: HashMap<u32, u32>,
    pub(crate) toplevel_floating_restore: HashMap<u32, (i32, i32, i32, i32)>,
    pub(crate) toplevel_fullscreen_return_maximized: HashSet<u32>,
    pub(crate) shell_window_stack_order: Vec<u32>,
    pub(crate) shell_window_stack_revision: u64,
    pub(crate) shell_window_domain_revision: u64,
    pub(crate) control_windows_revision: u64,
    pub(crate) shell_window_switcher_selected_window_id: Option<u32>,
}

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
pub const SHELL_DRAG_WINDOW_ALPHA: f32 = 0.76;
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

impl WindowManagementState {
    pub(crate) fn next_shell_window_domain_revision(&mut self) -> u64 {
        self.shell_window_domain_revision = self.shell_window_domain_revision.wrapping_add(1);
        self.shell_window_domain_revision
    }

    pub(crate) fn next_shell_window_stack_revision(&mut self) -> u64 {
        self.shell_window_stack_revision = self.shell_window_stack_revision.wrapping_add(1);
        self.shell_window_stack_revision
    }

    pub(crate) fn shell_window_stack_seed_known_windows(&mut self) {
        let before = self.shell_window_stack_order.clone();
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
        if self.shell_window_stack_order != before {
            self.next_shell_window_stack_revision();
        }
    }

    pub(crate) fn shell_window_stack_touch(&mut self, window_id: u32) {
        if window_id == 0 || self.window_registry.window_info(window_id).is_none() {
            return;
        }
        let before = self.shell_window_stack_order.clone();
        self.shell_window_stack_order
            .retain(|wid| *wid != window_id);
        self.shell_window_stack_order.push(window_id);
        if self.shell_window_stack_order != before {
            self.next_shell_window_stack_revision();
        }
    }

    pub(crate) fn shell_window_stack_forget(&mut self, window_id: u32) {
        let before_len = self.shell_window_stack_order.len();
        self.shell_window_stack_order
            .retain(|wid| *wid != window_id);
        if self.shell_window_stack_order.len() != before_len {
            self.next_shell_window_stack_revision();
        }
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

    pub(crate) fn shell_ipc_peer_matches_wayland_pid(
        shell_ipc_peer_pid: Option<i32>,
        wayland_client_pid: Option<i32>,
    ) -> bool {
        let Some(shell_pid) = shell_ipc_peer_pid else {
            return false;
        };
        if shell_pid <= 0 {
            return false;
        }
        wayland_client_pid == Some(shell_pid)
    }

    pub(crate) fn window_info_is_solid_shell_host(
        info: &WindowInfo,
        shell_ipc_peer_pid: Option<i32>,
    ) -> bool {
        window_is_solid_shell_host(&info.title, &info.app_id)
            || Self::shell_ipc_peer_matches_wayland_pid(shell_ipc_peer_pid, info.wayland_client_pid)
    }

    pub(crate) fn toplevel_is_embedded_shell_host(
        title: &str,
        app_id: &str,
        wayland_client_pid: Option<i32>,
        shell_ipc_peer_pid: Option<i32>,
    ) -> bool {
        window_is_solid_shell_host(title, app_id)
            || Self::shell_ipc_peer_matches_wayland_pid(shell_ipc_peer_pid, wayland_client_pid)
    }

    pub(crate) fn logical_focus_target_is_valid(
        &self,
        space: &Space<DerpSpaceElem>,
        shell_ipc_peer_pid: Option<i32>,
        window_id: u32,
    ) -> bool {
        let Some(info) = self.window_registry.window_info(window_id) else {
            return false;
        };
        if info.minimized || Self::window_info_is_solid_shell_host(&info, shell_ipc_peer_pid) {
            return false;
        }
        if self.window_registry.is_shell_hosted(window_id) {
            return true;
        }
        let Some(sid) = self.window_registry.surface_id_for_window(window_id) else {
            return false;
        };
        self.find_window_by_surface_id(space, sid).is_some()
            || self.find_x11_window_by_surface_id(space, sid).is_some()
    }

    pub(crate) fn pick_next_logical_focus_target(
        &self,
        space: &Space<DerpSpaceElem>,
        shell_ipc_peer_pid: Option<i32>,
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
            if self.logical_focus_target_is_valid(space, shell_ipc_peer_pid, wid) {
                return Some(wid);
            }
        }
        None
    }

    pub(crate) fn shell_window_switcher_candidates(
        &self,
        space: &Space<DerpSpaceElem>,
        shell_ipc_peer_pid: Option<i32>,
    ) -> Vec<u32> {
        let mut seen = HashSet::new();
        let mut candidates = Vec::new();
        for &wid in self.shell_window_stack_ids().iter().rev() {
            if !seen.insert(wid) {
                continue;
            }
            if !self.logical_focus_target_is_valid(space, shell_ipc_peer_pid, wid) {
                continue;
            }
            candidates.push(wid);
        }
        candidates
    }

    pub(crate) fn shell_window_switcher_effective_selected_window_id(
        &self,
        space: &Space<DerpSpaceElem>,
        shell_ipc_peer_pid: Option<i32>,
        open: bool,
        restore_window_id: Option<u32>,
    ) -> Option<u32> {
        if !open {
            return None;
        }
        if let Some(window_id) = self
            .shell_window_switcher_selected_window_id
            .filter(|window_id| {
                self.logical_focus_target_is_valid(space, shell_ipc_peer_pid, *window_id)
            })
        {
            return Some(window_id);
        }
        let restore_window_id = restore_window_id.filter(|window_id| {
            self.logical_focus_target_is_valid(space, shell_ipc_peer_pid, *window_id)
        });
        let candidates = self.shell_window_switcher_candidates(space, shell_ipc_peer_pid);
        if let Some(restore_window_id) = restore_window_id {
            if let Some(index) = candidates.iter().position(|wid| *wid == restore_window_id) {
                return candidates
                    .get((index + 1) % candidates.len().max(1))
                    .copied()
                    .or(Some(restore_window_id));
            }
        }
        candidates.first().copied()
    }

    pub(crate) fn topmost_native_window_from_stack(
        &self,
        space: &Space<DerpSpaceElem>,
        shell_ipc_peer_pid: Option<i32>,
    ) -> Option<u32> {
        for &wid in self.shell_window_stack_ids().iter().rev() {
            if self.window_registry.is_shell_hosted(wid) {
                continue;
            }
            if self.logical_focus_target_is_valid(space, shell_ipc_peer_pid, wid) {
                return Some(wid);
            }
        }
        None
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

    pub(crate) fn wayland_window_containing_surface(
        &self,
        space: &Space<DerpSpaceElem>,
        surface: &WlSurface,
    ) -> Option<Window> {
        let mut root = surface.clone();
        while let Some(p) = smithay::wayland::compositor::get_parent(&root) {
            root = p;
        }
        space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                w.toplevel()
                    .is_some_and(|t| t.wl_surface() == &root)
                    .then_some(w.clone())
            } else {
                None
            }
        })
    }

    pub(crate) fn x11_window_containing_surface(
        &self,
        space: &Space<DerpSpaceElem>,
        surface: &WlSurface,
    ) -> Option<X11Surface> {
        let mut root = surface.clone();
        while let Some(p) = smithay::wayland::compositor::get_parent(&root) {
            root = p;
        }
        space.elements().find_map(|e| {
            if let DerpSpaceElem::X11(x11) = e {
                x11.wl_surface()
                    .is_some_and(|wl| wl == root)
                    .then_some(x11.clone())
            } else {
                None
            }
        })
    }

    pub(crate) fn find_window_by_surface_id(
        &self,
        space: &Space<DerpSpaceElem>,
        surface_id: u32,
    ) -> Option<Window> {
        let window_id = self
            .window_registry
            .window_id_for_shell_surface(surface_id)?;
        space.elements().find_map(|e| {
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

    pub(crate) fn x11_window_id_for_surface(&self, window: &X11Surface) -> Option<u32> {
        let wl = window.wl_surface()?;
        self.window_registry.window_id_for_wl_surface(&wl)
    }

    pub(crate) fn find_x11_window_by_surface_id(
        &self,
        space: &Space<DerpSpaceElem>,
        surface_id: u32,
    ) -> Option<X11Surface> {
        let window_id = self
            .window_registry
            .window_id_for_shell_surface(surface_id)?;
        self.find_x11_window_by_window_id(space, window_id)
    }

    pub(crate) fn find_x11_window_by_window_id(
        &self,
        space: &Space<DerpSpaceElem>,
        window_id: u32,
    ) -> Option<X11Surface> {
        space.elements().find_map(|e| {
            if let DerpSpaceElem::X11(x11) = e {
                self.x11_window_id_for_surface(x11)
                    .filter(|&id| id == window_id)
                    .map(|_| x11.clone())
            } else {
                None
            }
        })
    }

    pub(crate) fn x11_window_title_app_id(window: &X11Surface) -> (String, String) {
        let title = window.title();
        let class = window.class();
        let instance = window.instance();
        let app_id = if !class.is_empty() { class } else { instance };
        (title, app_id)
    }

    pub(crate) fn sync_registry_from_x11_surface(
        &mut self,
        window: &X11Surface,
        location: Point<i32, Logical>,
        in_space: bool,
        output_name: Option<String>,
    ) -> Option<X11SyncResult> {
        let window_id = self.x11_window_id_for_surface(window)?;
        let prev = self.window_registry.window_info(window_id)?;
        let (title, app_id) = Self::x11_window_title_app_id(window);
        let geometry = window.geometry();
        let pid = window.pid().and_then(|pid| i32::try_from(pid).ok());
        let compositor_minimized =
            self.window_registry.lifecycle(window_id) == Some(WindowLifecycle::Minimized);
        let minimized = compositor_minimized || (window.is_hidden() && prev.minimized);
        let skip_x11_geometry = compositor_minimized && !in_space;
        let width = geometry.size.w.max(1);
        let height = geometry.size.h.max(1);
        let output_name = output_name.unwrap_or_else(|| prev.output_name.clone());
        let (x, y, width, height, output_name) = if skip_x11_geometry {
            (
                prev.x,
                prev.y,
                prev.width,
                prev.height,
                prev.output_name.clone(),
            )
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

    pub(crate) fn clear_toplevel_layout_maps(&mut self, window_id: u32) {
        self.toplevel_floating_restore.remove(&window_id);
        self.toplevel_fullscreen_return_maximized.remove(&window_id);
        self.shell_pending_native_configure_frames
            .remove(&window_id);
    }

    pub(crate) fn toplevel_rect_snapshot(
        &self,
        space: &Space<DerpSpaceElem>,
        window: &Window,
    ) -> Option<(i32, i32, i32, i32)> {
        let loc = space.element_location(&DerpSpaceElem::Wayland(window.clone()))?;
        let sz = window.geometry().size;
        Some((loc.x, loc.y, sz.w, sz.h))
    }
}
