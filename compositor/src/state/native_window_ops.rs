use super::*;

impl CompositorState {
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
        let info = self
            .windows
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
            .output_topology
            .space
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
        let Some(src_out) = self
            .output_topology
            .space
            .outputs()
            .find(|o| o.name() == src_name.as_str())
        else {
            return Err("src output".into());
        };
        let Some(tgt_out) = self
            .output_topology
            .space
            .outputs()
            .find(|o| o.name() == tgt_name.as_str())
        else {
            return Err("tgt output".into());
        };
        let Some(src_work) = self.shell_maximize_work_area_global_for_window(&src_out, window_id)
        else {
            return Err("src work".into());
        };
        let Some(tgt_work) = self.shell_maximize_work_area_global_for_window(&tgt_out, window_id)
        else {
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
            let client_rect = self.workspace_auto_layout_client_rect_from_frame_rect_for_window(
                window_id, frame_rect,
            );
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

    pub(super) fn shell_apply_global_client_rect(
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

    pub(super) fn shell_tile_frame_rect_for_output(
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

    pub(super) fn shell_output_for_window_info(&self, info: &WindowInfo) -> Option<Output> {
        self.output_for_window_position(info.x, info.y, info.width, info.height)
            .and_then(|name| {
                self.output_topology
                    .space
                    .outputs()
                    .find(|output| output.name() == name)
                    .cloned()
            })
            .or_else(|| {
                if info.output_name.is_empty() {
                    None
                } else {
                    self.output_topology
                        .space
                        .outputs()
                        .find(|output| output.name() == info.output_name)
                        .cloned()
                }
            })
            .or_else(|| self.leftmost_output())
    }

    pub(super) fn super_tile_window_half(
        &mut self,
        window_id: u32,
        right: bool,
    ) -> Result<(), String> {
        let info = self
            .windows
            .window_registry
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
        let client_rect = self
            .workspace_auto_layout_client_rect_from_frame_rect_for_window(window_id, frame_rect);
        self.shell_apply_global_client_rect(window_id, client_rect, 0);
        self.workspace_send_state();
        Ok(())
    }

    pub(super) fn super_tile_down(&mut self, window_id: u32) -> Result<(), String> {
        let info = self
            .windows
            .window_registry
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

    pub(super) fn shell_set_hidden_native_window_geometry(
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
                    if !self
                        .windows
                        .toplevel_floating_restore
                        .contains_key(&window_id)
                    {
                        if let Some(s) = self.toplevel_rect_snapshot(&window) {
                            self.windows.toplevel_floating_restore.insert(window_id, s);
                        }
                    }
                }
                let _ = self
                    .windows
                    .window_registry
                    .update_native(window_id, |window_info| {
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
                    if !self
                        .windows
                        .toplevel_floating_restore
                        .contains_key(&window_id)
                    {
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
                let _ = self
                    .windows
                    .window_registry
                    .update_native(window_id, |window_info| {
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
        let Some(sid) = self
            .windows
            .window_registry
            .surface_id_for_window(window_id)
        else {
            return;
        };
        let Some((x, y, w, h)) = self.shell_output_local_rect_to_logical_global(lx, ly, lw, lh)
        else {
            return;
        };
        let mut target_output_name = self
            .output_for_window_position(x, y, w, h)
            .unwrap_or_default();
        let maximized_rect = if layout_state == 1 {
            self.output_topology
                .space
                .outputs()
                .find(|output| output.name() == target_output_name)
                .cloned()
                .or_else(|| {
                    if info.output_name.is_empty() {
                        None
                    } else {
                        self.output_topology
                            .space
                            .outputs()
                            .find(|output| output.name() == info.output_name)
                            .cloned()
                    }
                })
                .or_else(|| self.leftmost_output())
                .and_then(|output| {
                    target_output_name = output.name().to_string();
                    self.shell_maximize_work_area_global_for_window(&output, window_id)
                })
        } else {
            None
        };
        let (target_x, target_y, target_w, target_h) = if let Some(rect) = maximized_rect {
            (
                rect.loc.x,
                rect.loc.y,
                rect.size.w.max(1),
                rect.size.h.max(1),
            )
        } else {
            (x, y, w.max(1), h.max(1))
        };
        if info.minimized
            && self.shell_set_hidden_native_window_geometry(
                window_id,
                target_x,
                target_y,
                target_w,
                target_h,
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
                if !self
                    .windows
                    .toplevel_floating_restore
                    .contains_key(&window_id)
                {
                    if let Some(s) = self.toplevel_rect_snapshot(&window) {
                        self.windows.toplevel_floating_restore.insert(window_id, s);
                    }
                }
            }
            let (map_x, map_y, content_w, content_h) = (target_x, target_y, target_w, target_h);

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
            self.output_topology.space.map_element(
                DerpSpaceElem::Wayland(window.clone()),
                (map_x, map_y),
                true,
            );
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
            let next_output_name = self
                .windows
                .window_registry
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
            if !self
                .windows
                .toplevel_floating_restore
                .contains_key(&window_id)
            {
                let geometry = x11.geometry();
                let location = self
                    .output_topology
                    .space
                    .element_location(&DerpSpaceElem::X11(x11.clone()))
                    .unwrap_or(geometry.loc);
                self.windows.toplevel_floating_restore.insert(
                    window_id,
                    (location.x, location.y, geometry.size.w, geometry.size.h),
                );
            }
        }
        let rect = Rectangle::new(
            Point::from((target_x, target_y)),
            Size::from((target_w, target_h)),
        );
        self.apply_x11_window_bounds(window_id, &x11, rect, layout_state == 1, false, true);
        self.workspace_relayout_auto_layout_outputs_after_geometry(
            &previous_output_name,
            &target_output_name,
        );
        self.shell_reply_window_list();
    }

    pub(super) fn shell_close_group_window(&mut self, window_id: u32) -> bool {
        let group_window_ids =
            group_id_for_window(&self.workspace_layout.workspace_state, window_id).and_then(
                |group_id| {
                    self.workspace_layout
                        .workspace_state
                        .groups
                        .iter()
                        .find(|group| group.id == group_id)
                        .map(|group| group.window_ids.clone())
                },
            );
        let Some(group_window_ids) = group_window_ids else {
            if self
                .windows
                .window_registry
                .window_info(window_id)
                .is_none()
            {
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
            self.windows
                .shell_close_refocus_targets
                .insert(window_id, target);
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
        let Some(sid) = self
            .windows
            .window_registry
            .surface_id_for_window(window_id)
        else {
            tracing::warn!(
                target: "derp_toplevel",
                window_id,
                title = %info.title,
                "shell_close_window abort: no surface_id_for_window"
            );
            return;
        };
        if let Some(w) = self.find_window_by_surface_id(sid) {
            self.output_topology
                .space
                .raise_element(&DerpSpaceElem::Wayland(w.clone()), true);
            let wl_surf = w.toplevel().unwrap().wl_surface().clone();
            let k_serial = SERIAL_COUNTER.next_serial();
            if let Some(kb) = self.input_routing.seat.get_keyboard() {
                kb.set_focus(self, Some(wl_surf), k_serial);
            }
        } else if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
            self.output_topology
                .space
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
                    let _ = self
                        .windows
                        .window_registry
                        .transition(window_id, WindowLifecycleEvent::RequestClose);
                    self.windows
                        .shell_close_pending_native_windows
                        .insert(window_id);
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
                    let _ = self
                        .windows
                        .window_registry
                        .transition(window_id, WindowLifecycleEvent::RequestClose);
                    self.windows
                        .shell_close_pending_native_windows
                        .insert(window_id);
                    if let Err(error) = x11.close() {
                        tracing::warn!(
                            target: "derp_toplevel",
                            window_id,
                            ?error,
                            "shell_close_window minimized x11 close failed"
                        );
                        self.windows
                            .shell_close_pending_native_windows
                            .remove(&window_id);
                        self.windows.shell_close_refocus_targets.remove(&window_id);
                        let _ = self
                            .windows
                            .window_registry
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
            let _ = self
                .windows
                .window_registry
                .transition(window_id, WindowLifecycleEvent::RequestClose);
            self.windows
                .shell_close_pending_native_windows
                .insert(window_id);
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
                if let Some(x11) = self
                    .windows
                    .shell_known_x11_windows
                    .get(&window_id)
                    .cloned()
                {
                    self.shell_hide_x11_window_to_tray(window_id, &x11);
                    return;
                }
                self.remember_tray_hidden_x11_window_id(window_id, Some(&info));
                self.windows
                    .shell_close_pending_native_windows
                    .remove(&window_id);
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
        let _ = self
            .windows
            .window_registry
            .transition(window_id, WindowLifecycleEvent::RequestClose);
        self.windows
            .shell_close_pending_native_windows
            .insert(window_id);
        if let Err(error) = x11.close() {
            tracing::warn!(
                target: "derp_toplevel",
                window_id,
                ?error,
                "shell_close_window x11 close failed"
            );
            self.windows
                .shell_close_pending_native_windows
                .remove(&window_id);
            self.windows.shell_close_refocus_targets.remove(&window_id);
            let _ = self
                .windows
                .window_registry
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
        self.output_topology
            .space
            .unmap_elem(&DerpSpaceElem::Wayland(window));
        self.clear_toplevel_layout_maps(window_id);
        self.windows
            .pending_gnome_initial_toplevels
            .remove(&window_id);
        self.windows
            .shell_close_pending_native_windows
            .remove(&window_id);
        let keyboard_had_focus = self.keyboard_focused_window_id() == Some(window_id);
        if self.windows.shell_pending_native_focus_window_id == Some(window_id) {
            self.windows.shell_pending_native_focus_window_id = None;
        }
        self.shell_window_stack_forget(window_id);
        self.windows.window_registry.clear_restore_handle(window_id);
        if keyboard_had_focus {
            let serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat.get_keyboard().unwrap().set_focus(
                self,
                Option::<WlSurface>::None,
                serial,
            );
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
        let Some(sid) = self
            .windows
            .window_registry
            .surface_id_for_window(window_id)
        else {
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
                    self.windows
                        .toplevel_fullscreen_return_maximized
                        .insert(window_id);
                } else {
                    self.windows
                        .toplevel_fullscreen_return_maximized
                        .remove(&window_id);
                    if !self
                        .windows
                        .toplevel_floating_restore
                        .contains_key(&window_id)
                    {
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
                self.windows
                    .toplevel_fullscreen_return_maximized
                    .insert(window_id);
            } else {
                self.windows
                    .toplevel_fullscreen_return_maximized
                    .remove(&window_id);
                if !self
                    .windows
                    .toplevel_floating_restore
                    .contains_key(&window_id)
                {
                    let geometry = x11.geometry();
                    let location = self
                        .output_topology
                        .space
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
        if self
            .windows
            .toplevel_fullscreen_return_maximized
            .remove(&window_id)
        {
            self.shell_set_window_maximized(window_id, true);
            return;
        }
        let rect = self
            .windows
            .toplevel_floating_restore
            .remove(&window_id)
            .map(|(x, y, w, h)| Rectangle::new(Point::from((x, y)), Size::from((w, h))))
            .unwrap_or_else(|| {
                let geometry = x11.geometry();
                let location = self
                    .output_topology
                    .space
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
        let Some(sid) = self
            .windows
            .window_registry
            .surface_id_for_window(window_id)
        else {
            return;
        };
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let wl = window.toplevel().unwrap().wl_surface();
            if enabled {
                if read_toplevel_tiling(wl).0 || read_toplevel_tiling(wl).1 {
                    return;
                }
                if !self
                    .windows
                    .toplevel_floating_restore
                    .contains_key(&window_id)
                {
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
            if !self
                .windows
                .toplevel_floating_restore
                .contains_key(&window_id)
            {
                let geometry = x11.geometry();
                let location = self
                    .output_topology
                    .space
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
        let rect = self
            .windows
            .toplevel_floating_restore
            .remove(&window_id)
            .map(|(x, y, w, h)| Rectangle::new(Point::from((x, y)), Size::from((w, h))))
            .unwrap_or_else(|| {
                let geometry = x11.geometry();
                let location = self
                    .output_topology
                    .space
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
        let window_id = self
            .windows
            .window_registry
            .window_id_for_wl_surface(&surf)?;
        self.logical_focus_target_is_valid(window_id)
            .then_some(window_id)
    }

    pub(crate) fn try_refocus_after_closed_toplevel(&mut self) {
        let Some(target) = self.pick_next_logical_focus_target(None, true) else {
            let serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat.get_keyboard().unwrap().set_focus(
                self,
                Option::<WlSurface>::None,
                serial,
            );
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
        if let Some(target) = self
            .windows
            .shell_close_refocus_targets
            .remove(&closed_window_id)
        {
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
        if info.minimized
            || self.window_info_is_solid_shell_host(&info)
            || self.window_is_shell_status_indicator(&info)
        {
            return;
        }
        let Some(sid) = self
            .windows
            .window_registry
            .surface_id_for_window(window_id)
        else {
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
            self.output_topology
                .space
                .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
            self.shell_window_stack_touch(window_id);
            let wl_surface = window.toplevel().unwrap().wl_surface().clone();
            let k_serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat.get_keyboard().unwrap().set_focus(
                self,
                Some(wl_surface),
                k_serial,
            );
            self.shell_emit_chrome_event(ChromeEvent::FocusChanged {
                surface_id: Some(sid),
                window_id: Some(window_id),
            });
            self.raise_shell_status_indicators();
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
        self.output_topology
            .space
            .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
        self.shell_window_stack_touch(window_id);
        if let Some(wl_surface) = x11.wl_surface() {
            self.windows.shell_pending_native_focus_window_id = None;
            let k_serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat.get_keyboard().unwrap().set_focus(
                self,
                Some(wl_surface),
                k_serial,
            );
            self.shell_emit_chrome_event(ChromeEvent::FocusChanged {
                surface_id: Some(sid),
                window_id: Some(window_id),
            });
        } else {
            self.windows.shell_pending_native_focus_window_id = Some(window_id);
        }
        self.emit_x11_window_updates(&x11, false, false);
        self.raise_shell_status_indicators();
    }

    pub(super) fn shell_emit_window_state(&mut self, window_id: u32, minimized: bool) {
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
        if self.windows.window_registry.lifecycle(window_id)
            == Some(WindowLifecycle::CloseRequested)
        {
            return;
        }
        if info.minimized {
            return;
        }
        let Some(sid) = self
            .windows
            .window_registry
            .surface_id_for_window(window_id)
        else {
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
            let _ = self
                .windows
                .window_registry
                .set_restore_handle(window_id, RestoreHandle::Wayland(window.clone()));
            let _ = self
                .windows
                .window_registry
                .transition(window_id, WindowLifecycleEvent::Minimize);
            self.output_topology
                .space
                .unmap_elem(&DerpSpaceElem::Wayland(window));

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
        let _ = self
            .windows
            .window_registry
            .set_restore_handle(window_id, RestoreHandle::X11(x11.clone()));
        let _ = self
            .windows
            .window_registry
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
        self.output_topology
            .space
            .unmap_elem(&DerpSpaceElem::X11(x11.clone()));
        if self.keyboard_focused_window_id() == Some(window_id) {
            let serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat.get_keyboard().unwrap().set_focus(
                self,
                Option::<WlSurface>::None,
                serial,
            );
            self.keyboard_on_focus_surface_changed(None);
        }
        self.emit_x11_window_updates(&x11, false, false);
        self.shell_emit_window_state(window_id, true);
    }

    /// Map a compositor-minimized toplevel back into the space and focus it.
    pub fn shell_restore_minimized_window(&mut self, window_id: u32) {
        if self
            .windows
            .window_registry
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
                let _ = self
                    .windows
                    .window_registry
                    .transition(window_id, WindowLifecycleEvent::Restore);

                let _ = window.set_activated(true);
                self.output_topology
                    .space
                    .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
                let wl_surface = window.toplevel().unwrap().wl_surface().clone();
                let k_serial = SERIAL_COUNTER.next_serial();
                self.input_routing.seat.get_keyboard().unwrap().set_focus(
                    self,
                    Some(wl_surface),
                    k_serial,
                );
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
                let _ = self
                    .windows
                    .window_registry
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
                self.apply_x11_window_bounds(
                    window_id,
                    &x11,
                    rect,
                    info.maximized,
                    info.fullscreen,
                    true,
                );
                if let Err(error) = x11.set_activated(true) {
                    tracing::warn!(window_id, ?error, "x11 set_activated(true) failed");
                }
                self.output_topology
                    .space
                    .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
                if let Some(wl_surface) = x11.wl_surface() {
                    self.windows.shell_pending_native_focus_window_id = None;
                    let k_serial = SERIAL_COUNTER.next_serial();
                    self.input_routing.seat.get_keyboard().unwrap().set_focus(
                        self,
                        Some(wl_surface),
                        k_serial,
                    );
                }
                self.emit_x11_window_updates(&x11, true, false);
                self.shell_emit_window_state(window_id, false);
                if self.windows.shell_pending_native_focus_window_id == Some(window_id) {
                    self.shell_raise_and_focus_window(window_id);
                }
            }
            RestoreHandle::None => {
                let _ = self
                    .windows
                    .window_registry
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
            if self
                .windows
                .window_registry
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
}
