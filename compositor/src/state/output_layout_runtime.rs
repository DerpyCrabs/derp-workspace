use super::*;

impl CompositorState {
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

    pub(crate) fn apply_translated_workspace_elements(
        &mut self,
        elem_targets: Vec<(DerpSpaceElem, i32, i32)>,
    ) {
        if elem_targets.is_empty() {
            return;
        }
        for (elem, nx, ny) in elem_targets {
            match elem {
                DerpSpaceElem::Wayland(w) => {
                    self.output_topology.space.map_element(
                        DerpSpaceElem::Wayland(w.clone()),
                        (nx, ny),
                        true,
                    );
                    self.notify_geometry_for_window(&w, true);
                }
                DerpSpaceElem::X11(x) => {
                    let mut geo = x.geometry();
                    geo.loc.x = nx;
                    geo.loc.y = ny;
                    let _ = x.configure(Some(geo));
                    self.output_topology.space.map_element(
                        DerpSpaceElem::X11(x.clone()),
                        (nx, ny),
                        false,
                    );
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
    pub(crate) fn snapshot_output_geometry_by_name(
        &self,
    ) -> HashMap<String, Rectangle<i32, Logical>> {
        self.output_topology.snapshot_output_geometry_by_name()
    }

    pub(crate) fn output_name_for_window_from_geometry_map(
        geos: &HashMap<String, Rectangle<i32, Logical>>,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> Option<String> {
        OutputTopologyState::output_name_for_window_from_geometry_map(geos, x, y, w, h)
    }

    pub(crate) fn shift_mapped_toplevels_for_output_moves(
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
                    let Some(info) = self.windows.window_registry.snapshot_for_wl_surface(wl)
                    else {
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
                    self.output_topology.space.map_element(
                        DerpSpaceElem::Wayland(w.clone()),
                        (nx, ny),
                        true,
                    );
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
                    self.output_topology.space.map_element(
                        DerpSpaceElem::X11(x.clone()),
                        (nx, ny),
                        false,
                    );
                }
            }
        }
        self.core.loop_signal.wakeup();
    }

    pub(crate) fn pick_nearest_surviving_output(&self, remove: &Output) -> Option<Output> {
        self.output_topology.pick_nearest_surviving_output(remove)
    }

    pub(crate) fn migrate_wayland_window_to_target_work_area(
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
        self.windows
            .toplevel_fullscreen_return_maximized
            .remove(&window_id);
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
        self.output_topology.space.map_element(
            DerpSpaceElem::Wayland(window.clone()),
            (map_x, map_y),
            true,
        );
        self.output_topology
            .space
            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
        tl.send_pending_configure();
        let tn = target.name().to_string();
        self.shell_emit_requested_native_geometry(
            window_id, map_x, map_y, content_w, content_h, tn, false, false,
        );
        self.capture_refresh_window_source_cache(window_id);
    }

    pub(crate) fn migrate_x11_surface_to_work_area(
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
        self.output_topology
            .space
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
        let x11_to_move: Vec<X11Surface> = self
            .output_topology
            .space
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

    pub(crate) fn shell_clear_stale_primary_output(&mut self) -> bool {
        self.output_topology.shell_clear_stale_primary_output()
    }

    pub(crate) fn shell_output_layout_message(
        &mut self,
    ) -> Option<shell_wire::DecodedCompositorToShellMessage> {
        self.shell_output_layout_message_with_revision(true)
    }

    pub(crate) fn shell_output_layout_snapshot_message(
        &mut self,
    ) -> Option<shell_wire::DecodedCompositorToShellMessage> {
        self.shell_output_layout_message_with_revision(false)
    }

    pub(crate) fn shell_output_layout_message_with_revision(
        &mut self,
        bump_revision: bool,
    ) -> Option<shell_wire::DecodedCompositorToShellMessage> {
        self.recompute_shell_canvas_from_outputs();
        self.output_topology
            .shell_output_layout_message_with_revision(
                bump_revision,
                self.shell_osr.shell_window_physical_px,
                self.session_services.osk_visible == Some(true),
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

    pub(crate) fn refresh_usable_area_dependent_window_layouts(&mut self) {
        self.refresh_taskbar_dependent_window_layouts();
        self.resync_embedded_shell_host_after_ipc_connect();
        self.send_shell_output_layout();
    }

    pub(crate) fn refresh_taskbar_dependent_window_layouts(&mut self) {
        self.workspace_apply_manual_tiles_for_all_outputs();
        self.workspace_apply_auto_layout_for_all_outputs();
        let maximized: Vec<_> = self
            .windows
            .window_registry
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
            let Some(surface_id) = self
                .windows
                .window_registry
                .surface_id_for_window(window_id)
            else {
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
        let output_names: Vec<String> = self
            .output_topology
            .space
            .outputs()
            .map(|o| o.name().into())
            .collect();
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
        let host_ids: Vec<u32> = self
            .windows
            .window_registry
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
            self.output_topology.space.map_element(
                DerpSpaceElem::Wayland(window.clone()),
                (ox, oy),
                true,
            );
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
        let surface_id =
            window_id.and_then(|w| self.windows.window_registry.surface_id_for_window(w));
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
}
