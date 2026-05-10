use super::*;

impl CompositorState {
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
            self.windows
                .window_registry
                .window_id_for_wl_surface(toplevel.wl_surface())
        })?;
        self.workspace_auto_layout_initial_client_rect_for_window(&out.name(), window_id)
    }

    pub(super) fn workspace_auto_layout_frame_area_for_output(
        &self,
        output: &Output,
    ) -> Option<Rectangle<i32, Logical>> {
        let geo = self
            .output_topology
            .layer_usable_area_global_for_output(output)?;
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

    pub(super) fn workspace_auto_layout_client_rect_from_frame_rect_for_window(
        &self,
        window_id: u32,
        rect: Rectangle<i32, Logical>,
    ) -> Rectangle<i32, Logical> {
        WorkspaceLayoutState::workspace_auto_layout_client_rect_from_frame_rect(
            rect,
            self.native_window_shell_chrome_titlebar_h(window_id),
        )
    }

    pub(super) fn workspace_window_has_group_chrome(&self, window_id: u32) -> bool {
        self.workspace_layout
            .workspace_window_has_group_chrome(window_id)
    }

    pub(super) fn workspace_monitor_layout_state_for_output(
        &self,
        output_name: &str,
    ) -> Option<&WorkspaceMonitorLayoutState> {
        let output_id = self.workspace_output_identity_for_name(output_name);
        self.workspace_layout
            .workspace_monitor_layout_state_for_output(output_name, output_id.as_deref())
    }

    pub(super) fn workspace_is_auto_layout_managed_window(&self, info: &WindowInfo) -> bool {
        if info.minimized || info.maximized || info.fullscreen {
            return false;
        }
        if self.window_info_is_solid_shell_host(info) {
            return false;
        }
        info.app_id != "derp.debug" && info.app_id != "derp.settings"
    }

    pub(super) fn workspace_window_output_name_for_auto_layout(&self, info: &WindowInfo) -> String {
        if !info.output_name.is_empty() {
            return info.output_name.clone();
        }
        self.output_for_window_position(info.x, info.y, info.width, info.height)
            .unwrap_or_default()
    }

    pub(super) fn workspace_auto_layout_window_ids_for_output(
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

    pub(super) fn workspace_custom_auto_slots(
        layout_state: &WorkspaceMonitorLayoutState,
    ) -> Vec<WorkspaceCustomAutoSlot> {
        WorkspaceLayoutState::workspace_custom_auto_slots(layout_state)
    }

    pub(super) fn workspace_custom_auto_frame_rect(
        slot: &WorkspaceCustomAutoSlot,
        work_area: Rectangle<i32, Logical>,
    ) -> Rectangle<i32, Logical> {
        WorkspaceLayoutState::workspace_custom_auto_frame_rect(slot, work_area)
    }

    pub(super) fn workspace_slot_rule_value(
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

    pub(super) fn workspace_slot_rule_matches(haystack: &str, rule: &WorkspaceSlotRule) -> bool {
        WorkspaceLayoutState::workspace_slot_rule_matches(haystack, rule)
    }

    pub(super) fn workspace_window_matches_slot_rules(
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

    pub(super) fn workspace_compute_auto_layout_frame_rects(
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
        let output = self
            .output_topology
            .space
            .outputs()
            .find(|entry| entry.name() == output_name)?;
        let work_area = self.workspace_auto_layout_frame_area_for_output(output)?;
        let window_ids =
            self.workspace_auto_layout_window_ids_for_output(output_name, Some(window_id));
        let frame_rects =
            self.workspace_compute_auto_layout_frame_rects(layout_state, &window_ids, work_area);
        frame_rects.get(&window_id).copied().map(|rect| {
            self.workspace_auto_layout_client_rect_from_frame_rect_for_window(window_id, rect)
        })
    }

    pub(super) fn workspace_set_pre_tile_geometry(
        &mut self,
        window_id: u32,
        bounds: WorkspaceRect,
    ) -> bool {
        self.workspace_layout
            .workspace_set_pre_tile_geometry(window_id, bounds)
    }

    pub(super) fn workspace_pre_tile_geometry(&self, window_id: u32) -> Option<WorkspaceRect> {
        self.workspace_layout.workspace_pre_tile_geometry(window_id)
    }

    pub(super) fn workspace_clear_pre_tile_geometry(&mut self, window_id: u32) -> bool {
        self.workspace_layout
            .workspace_clear_pre_tile_geometry(window_id)
    }

    pub(super) fn workspace_monitor_tile_for_window(
        &self,
        window_id: u32,
    ) -> Option<(String, String)> {
        self.workspace_layout
            .workspace_monitor_tile_for_window(window_id)
    }

    pub(super) fn workspace_set_monitor_tile(
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

    pub(super) fn workspace_remove_monitor_tile(&mut self, window_id: u32) -> bool {
        self.workspace_layout
            .workspace_remove_monitor_tile(window_id)
    }

    pub(super) fn workspace_set_auto_layout_tiles_for_output(
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

    pub(super) fn workspace_custom_auto_group_ids_for_output(
        &self,
        output_name: &str,
    ) -> Vec<String> {
        let mut out = Vec::new();
        for group in &self.workspace_layout.workspace_state.groups {
            let Some(visible_window_id) = self
                .workspace_layout
                .workspace_state
                .visible_window_id_for_group(&group.id)
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

    pub(super) fn workspace_custom_auto_slot_for_group(
        &self,
        group_id: &str,
        slots: &[WorkspaceCustomAutoSlot],
    ) -> Option<usize> {
        let group = self
            .workspace_layout
            .workspace_state
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

    pub(super) fn workspace_custom_auto_assignment(
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

    pub(super) fn workspace_merge_group_into_group(
        &mut self,
        source_group_id: &str,
        target_group_id: &str,
    ) {
        self.workspace_layout
            .workspace_merge_group_into_group(source_group_id, target_group_id);
    }

    pub(super) fn workspace_custom_auto_overflow_target_slot(
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
            if let Some(group_id) =
                group_id_for_window(&self.workspace_layout.workspace_state, focused)
            {
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

    pub(super) fn workspace_apply_custom_auto_layout_for_output_name(
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
            let Some(window_id) = self
                .workspace_layout
                .workspace_state
                .visible_window_id_for_group(group_id)
            else {
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
        self.workspace_layout
            .workspace_state
            .monitor_tiles
            .retain(|monitor| monitor.output_name != output_name);
        if !entries.is_empty() {
            self.workspace_layout
                .workspace_state
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
            let client_rect = self.workspace_auto_layout_client_rect_from_frame_rect_for_window(
                window_id, frame_rect,
            );
            let target_x = client_rect.loc.x;
            let target_y = client_rect.loc.y;
            let target_w = client_rect.size.w.max(1);
            let target_h = client_rect.size.h.max(1);
            if self.windows.window_registry.is_shell_hosted(window_id) {
                let snap = self.windows.window_registry.update_shell_hosted(
                    window_id,
                    |window_info, _| {
                        window_info.x = target_x;
                        window_info.y = target_y;
                        window_info.width = target_w;
                        window_info.height = target_h;
                        window_info.output_name = output_name.to_string();
                        window_info.maximized = false;
                        window_info.fullscreen = false;
                        window_info.clone()
                    },
                );
                if let Some(snap) = snap {
                    self.capture_refresh_window_source_cache(window_id);
                    self.shell_backed_emit_geometry_messages(&snap);
                }
                continue;
            }
            self.clear_toplevel_layout_maps(window_id);
            let Some(surface_id) = self
                .windows
                .window_registry
                .surface_id_for_window(window_id)
            else {
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
        let Some(output) = self
            .output_topology
            .space
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
            let client_rect = self.workspace_auto_layout_client_rect_from_frame_rect_for_window(
                window_id, frame_rect,
            );
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
                let snap = self.windows.window_registry.update_shell_hosted(
                    window_id,
                    |window_info, _| {
                        window_info.x = target_x;
                        window_info.y = target_y;
                        window_info.width = target_w;
                        window_info.height = target_h;
                        window_info.output_name = output_name.to_string();
                        window_info.maximized = false;
                        window_info.fullscreen = false;
                        window_info.clone()
                    },
                );
                if let Some(snap) = snap {
                    self.capture_refresh_window_source_cache(window_id);
                    self.shell_backed_emit_geometry_messages(&snap);
                }
                continue;
            }
            self.clear_toplevel_layout_maps(window_id);
            let Some(surface_id) = self
                .windows
                .window_registry
                .surface_id_for_window(window_id)
            else {
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

    pub(super) fn workspace_apply_auto_layout_for_all_outputs(&mut self) -> bool {
        let output_names = self.workspace_layout.workspace_auto_layout_output_names();
        let mut applied = false;
        for output_name in output_names {
            if self.workspace_apply_auto_layout_for_output_name(&output_name) {
                applied = true;
            }
        }
        applied
    }

    pub(super) fn workspace_apply_manual_tiles_for_all_outputs(&mut self) -> bool {
        let monitors = self.workspace_layout.workspace_state.monitor_tiles.clone();
        let mut applied = false;
        for monitor in monitors {
            let Some(layout_state) = self
                .workspace_monitor_layout_state_for_output(&monitor.output_name)
                .cloned()
            else {
                continue;
            };
            if layout_state.layout != WorkspaceMonitorLayoutType::ManualSnap {
                continue;
            }
            let Some(output) = self
                .output_topology
                .space
                .outputs()
                .find(|entry| entry.name() == monitor.output_name)
                .cloned()
            else {
                continue;
            };
            for entry in monitor.entries {
                let Some(frame_rect) = self.shell_tile_frame_rect_for_output(&output, &entry.zone)
                else {
                    continue;
                };
                self.workspace_set_monitor_tile(
                    &monitor.output_name,
                    entry.window_id,
                    entry.zone,
                    WorkspaceRect {
                        x: frame_rect.loc.x,
                        y: frame_rect.loc.y,
                        width: frame_rect.size.w.max(1),
                        height: frame_rect.size.h.max(1),
                    },
                );
                let client_rect = self
                    .workspace_auto_layout_client_rect_from_frame_rect_for_window(
                        entry.window_id,
                        frame_rect,
                    );
                self.shell_apply_global_client_rect(entry.window_id, client_rect, 0);
                applied = true;
            }
        }
        if applied {
            self.workspace_send_state();
        }
        applied
    }

    pub(super) fn workspace_relayout_auto_layout_outputs_after_geometry(
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
}
