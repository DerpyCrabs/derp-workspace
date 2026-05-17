use super::*;

impl CompositorState {
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
            self.shell_osr
                .shell_hosted_app_state
                .insert(wid, st.clone());
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

    pub(super) fn workspace_copy_window_geometry(
        &mut self,
        target_window_id: u32,
        source_window_id: u32,
    ) {
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

    fn workspace_detached_window_shell_chrome_titlebar_h(
        &self,
        window_id: u32,
        state: &WorkspaceState,
    ) -> i32 {
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return self.shell_osr.shell_chrome_titlebar_h.max(0);
        };
        let group_has_chrome = group_id_for_window(state, window_id).is_some_and(|group_id| {
            state
                .groups
                .iter()
                .find(|group| group.id == group_id)
                .is_some_and(|group| group.window_ids.len() > 1)
        });
        let uses_shell_chrome = if self.native_window_shell_decoration_disabled(window_id) {
            group_has_chrome
        } else {
            !info.client_side_decoration || group_has_chrome
        };
        if uses_shell_chrome {
            self.shell_osr.shell_chrome_titlebar_h.max(0)
        } else {
            0
        }
    }

    pub(super) fn workspace_begin_detached_window_drag(
        &mut self,
        window_id: u32,
        shell_chrome_titlebar_h: i32,
    ) {
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
        let drag_handle_h = self.shell_osr.shell_chrome_titlebar_h.max(0);
        let y = (pos.y.round() as i32)
            .saturating_sub(drag_handle_h / 2)
            .saturating_add(shell_chrome_titlebar_h.max(0));
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
        let mut detached_window_drag_titlebar_h = 0;
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
            WorkspaceMutation::SplitWindowToOwnGroup {
                window_id,
                start_drag,
            } => {
                if *start_drag || self.shell_ui_pointer_grab_active() {
                    detached_window_drag = Some(*window_id);
                    detached_window_drag_titlebar_h = self
                        .workspace_detached_window_shell_chrome_titlebar_h(*window_id, &next_state);
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
                self.workspace_begin_detached_window_drag(
                    window_id,
                    detached_window_drag_titlebar_h,
                );
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
            self.workspace_begin_detached_window_drag(window_id, detached_window_drag_titlebar_h);
        } else if let Some(window_id) = activation_window_id {
            self.shell_activate_window(window_id);
            if let Some((target_window_id, source_window_id)) = copy_geometry_after_activation {
                self.workspace_copy_window_geometry(target_window_id, source_window_id);
            }
        }
        self.shell_send_mutation_ack("workspace_mutation", client_mutation_id, true);
    }

    pub(super) fn workspace_apply_close_side_effects(&mut self, window_id: u32) {
        let group_id = group_id_for_window(&self.workspace_layout.workspace_state, window_id)
            .map(str::to_string);
        self.workspace_sync_from_registry();
        let Some(group_id) = group_id else {
            self.workspace_send_state();
            return;
        };
        let next_visible = next_active_window_after_removal(
            &self.workspace_layout.workspace_state,
            &group_id,
            window_id,
        );
        self.workspace_layout.workspace_state = reconcile_workspace_state(
            &self.workspace_layout.workspace_state,
            &self.workspace_live_window_ids(),
        );
        self.workspace_send_state();
        if let Some(next_visible) = next_visible {
            self.shell_activate_window(next_visible);
        }
    }
}
