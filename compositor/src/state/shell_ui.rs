use super::*;

impl CompositorState {
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

    pub(super) fn shell_shared_state_payload_is_stale(
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

    pub(super) fn shell_visible_placements_stamp(&self) -> ShellVisiblePlacementsStamp {
        ShellVisiblePlacementsStamp {
            ui_generation: self.shell_osr.shell_ui_windows_generation,
            window_registry_revision: self.windows.window_registry.revision(),
            window_stack_revision: self.windows.shell_window_stack_revision,
            output_topology_revision: self.output_topology.shell_output_topology_revision,
            workspace_revision: self.workspace_layout.shell_workspace_revision,
        }
    }

    pub(super) fn rebuild_shell_visible_placements_cache(&self) -> ShellVisiblePlacementsCache {
        let mut frames = self.shell_backed_placements();
        frames.extend(self.shell_native_frame_placements());
        let ui_windows = self.shell_visible_ui_window_placements();
        self.shell_osr.shell_visible_placements_cache(
            self.shell_visible_placements_stamp(),
            frames,
            ui_windows,
        )
    }

    pub(super) fn shell_visible_placements_cache(&self) -> ShellVisiblePlacementsCache {
        self.rebuild_shell_visible_placements_cache()
    }

    pub(crate) fn shell_visible_placements(&self) -> Vec<ShellUiWindowPlacement> {
        self.shell_visible_placements_cache().all
    }

    pub(crate) fn shell_window_frame_placements(&self) -> Vec<ShellUiWindowPlacement> {
        self.shell_visible_placements_cache().frames
    }

    pub(super) fn shell_native_frame_placements(&self) -> Vec<ShellUiWindowPlacement> {
        let Some(ws) = self.workspace_logical_bounds() else {
            return Vec::new();
        };
        let stack_z_by_window_id = self.stack_z_by_window_id();
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
                z: stack_z_by_window_id
                    .get(&info.window_id)
                    .copied()
                    .unwrap_or(0),
                global_rect: clamped,
                buffer_rect: br,
            });
        }
        placements
    }

    pub(super) fn shell_ui_window_id_can_render_without_registry(window_id: u32) -> bool {
        matches!(window_id, 9003 | 9004)
    }

    pub(super) fn shell_visible_ui_window_placements(&self) -> Vec<ShellUiWindowPlacement> {
        self.shell_osr
            .shell_ui_windows
            .iter()
            .filter(|w| {
                if let Some(info) = self.windows.window_registry.window_info(w.id) {
                    return self.windows.window_registry.is_shell_hosted(w.id)
                        && !info.minimized
                        && self.workspace_window_is_visible_during_render(w.id);
                }
                Self::shell_ui_window_id_can_render_without_registry(w.id)
            })
            .cloned()
            .collect()
    }

    pub(super) fn shell_hosted_visible_placements(&self) -> Vec<ShellUiWindowPlacement> {
        self.shell_visible_placements()
    }

    pub(super) fn shell_hosted_clip_placements(
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
        let stack_z_by_id = self.stack_z_by_window_id();
        let Some(applied) = self.shell_osr.apply_shell_ui_windows_payload(
            payload,
            self.output_topology.shell_output_topology_revision,
            self.shell_output_logical_size(),
            self.workspace_logical_bounds(),
            &stack_z_by_id,
        ) else {
            return;
        };
        if applied.changed {
            self.shell_nudge_cef_repaint();
        }
    }

    pub(crate) fn shell_promote_pending_ui_windows_for_frame(&mut self) {
        let focused_is_shell_hosted = self
            .shell_osr
            .shell_focused_ui_window_id
            .is_some_and(|fid| self.windows.window_registry.is_shell_hosted(fid));
        let pointer_grab_id = self.input_routing.shell_ui_pointer_grab;
        let pointer_grab_is_shell_hosted =
            pointer_grab_id.is_some_and(|gid| self.windows.window_registry.is_shell_hosted(gid));
        let Some(applied) = self.shell_osr.promote_pending_shell_ui_windows(
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
        if !self
            .shell_osr
            .shell_ui_windows
            .iter()
            .any(|w| w.id == window_id)
            && !self.windows.window_registry.is_shell_hosted(window_id)
        {
            return;
        }
        let k_serial = SERIAL_COUNTER.next_serial();
        self.output_topology.space.elements().for_each(|e| {
            e.set_activate(false);
            if let DerpSpaceElem::Wayland(w) = e {
                if let Some(toplevel) = w.toplevel() {
                    self.send_xdg_toplevel_configure(&toplevel, None);
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
        self.input_routing.seat.get_keyboard().unwrap().set_focus(
            self,
            Option::<WlSurface>::None,
            k_serial,
        );
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
}
