use super::*;

impl CompositorState {
    pub(super) fn shell_window_snapshot_row(
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
        let (origin_x, origin_y) = self.output_topology.shell_canvas_logical_origin;
        let restore = if kind == WindowKind::ShellHosted {
            self.windows
                .window_registry
                .window_record(info.window_id)
                .and_then(|record| record.shell_hosted_float_restore)
                .map(|rect| {
                    (
                        rect.loc.x.saturating_sub(origin_x),
                        rect.loc.y.saturating_sub(origin_y),
                        rect.size.w,
                        rect.size.h,
                    )
                })
        } else {
            self.windows
                .toplevel_floating_restore
                .get(&info.window_id)
                .copied()
                .map(|(x, y, w, h)| (x.saturating_sub(origin_x), y.saturating_sub(origin_y), w, h))
        }
        .unwrap_or((0, 0, 0, 0));
        let capture_identifier = self
            .capture
            .capture_toplevel_handles
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
            restore_x: restore.0,
            restore_y: restore.1,
            restore_w: restore.2,
            restore_h: restore.3,
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
            }) | if self
                .workspace_layout
                .scratchpad_windows
                .contains_key(&info.window_id)
            {
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
            icon_name: info.icon.name.clone(),
            icon_buffers: info
                .icon
                .buffers
                .iter()
                .map(|buffer| shell_wire::ShellWindowIconBufferSnapshot {
                    width: buffer.width,
                    height: buffer.height,
                    scale: buffer.scale,
                })
                .collect(),
        }
    }

    pub(super) fn shell_send_window_geometry_snapshot_for_window(&mut self, window_id: u32) {
        let window_kind = if self.windows.window_registry.is_shell_hosted(window_id) {
            WindowKind::ShellHosted
        } else {
            WindowKind::Native
        };
        let Some(row) = self
            .windows
            .window_registry
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

    pub(super) fn shell_window_list_rows_inner(
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
            if record.kind != WindowKind::ShellHosted
                && (record.info.width <= 0 || record.info.height <= 0)
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

    pub(super) fn shell_window_list_rows(&mut self) -> Vec<shell_wire::ShellWindowSnapshot> {
        self.shell_window_list_rows_inner(true)
    }

    pub(super) fn shell_window_list_message(
        &mut self,
    ) -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::WindowList {
            revision: self.next_shell_window_domain_revision(),
            windows: self.shell_window_list_rows(),
        }
    }

    pub(super) fn shell_window_list_snapshot_message(
        &mut self,
    ) -> shell_wire::DecodedCompositorToShellMessage {
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

    pub(super) fn shell_window_order_snapshot_message(
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

    pub(super) fn enrich_shell_live_message(
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
                let Some(info) = self
                    .windows
                    .window_registry
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
                if let Some(row) = self
                    .windows
                    .window_registry
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

    /// Compositor â†’ shell: full window list ([`shell_wire::MSG_WINDOW_LIST`]).
    pub fn shell_reply_window_list(&mut self) {
        crate::cef::begin_frame_diag::note_shell_reply_window_list();
        let workspace_changed = self.workspace_sync_from_registry();
        if workspace_changed {
            self.workspace_send_state();
        }
        let msg = self.shell_window_list_message();
        self.shell_send_to_cef(msg);
    }

    pub(super) fn workspace_live_window_ids(&self) -> Vec<u32> {
        let mut window_ids: Vec<u32> = self
            .windows
            .window_registry
            .all_records()
            .into_iter()
            .filter(|record| !self.window_info_is_solid_shell_host(&record.info))
            .filter(|record| shell_window_row_should_show(&record.info))
            .filter(|record| {
                !self
                    .workspace_layout
                    .scratchpad_windows
                    .contains_key(&record.info.window_id)
            })
            .filter(|record| !self.shell_x11_window_is_tray_hidden(record.info.window_id))
            .filter(|record| {
                record.kind == WindowKind::ShellHosted
                    || !self.window_id_is_deferred_initial_map(record.info.window_id)
            })
            .filter(|record| {
                record.kind == WindowKind::ShellHosted
                    || (record.info.width > 0 && record.info.height > 0)
            })
            .map(|record| record.info.window_id)
            .collect();
        window_ids.sort_unstable();
        window_ids
    }

    pub(super) fn workspace_warn_invariants(&self, context: &str) {
        let live_window_ids = self.workspace_live_window_ids();
        for warning in self
            .workspace_layout
            .workspace_state
            .invariant_warnings(&live_window_ids)
        {
            tracing::warn!(
                target: "derp_workspace_state",
                context,
                warning = %warning,
                "workspace invariant"
            );
        }
    }

    pub(super) fn state_invariant_failures(&self, context: &str) -> Vec<String> {
        let mut failures = Vec::new();
        let outputs: HashSet<String> = self
            .output_topology
            .space
            .outputs()
            .map(|output| output.name())
            .collect();
        let live_window_ids = self.workspace_live_window_ids();
        for warning in self
            .workspace_layout
            .workspace_state
            .invariant_warnings(&live_window_ids)
        {
            failures.push(format!("{context}: workspace {warning}"));
        }
        for record in self.windows.window_registry.all_records() {
            let info = record.info;
            if self.window_info_is_solid_shell_host(&info)
                || !shell_window_row_should_show(&info)
                || self.shell_x11_window_is_tray_hidden(info.window_id)
                || (record.kind != WindowKind::ShellHosted
                    && self.window_id_is_deferred_initial_map(info.window_id))
                || (record.kind != WindowKind::ShellHosted && (info.width <= 0 || info.height <= 0))
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
            let shell_decoration_disabled = record.kind != WindowKind::ShellHosted
                && !self.native_window_uses_shell_chrome(&info);
            if !info.minimized
                && !info.fullscreen
                && frame.size.h <= client.size.h
                && self.shell_osr.shell_chrome_titlebar_h > 0
                && !shell_decoration_disabled
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
            if self
                .windows
                .window_registry
                .window_info(*window_id)
                .is_none()
            {
                failures.push(format!(
                    "{context}: stack contains unknown window {window_id}"
                ));
            }
        }
        for window_id in [
            self.input_routing.shell_move_window_id,
            self.input_routing.shell_resize_window_id,
            self.input_routing
                .shell_move_proxy
                .as_ref()
                .map(|proxy| proxy.window_id),
            self.input_routing
                .shell_native_drag_preview
                .as_ref()
                .map(|preview| preview.window_id),
        ]
        .into_iter()
        .flatten()
        {
            if self
                .windows
                .window_registry
                .window_info(window_id)
                .is_none()
            {
                failures.push(format!(
                    "{context}: interaction references unknown window {window_id}"
                ));
            }
        }
        failures
    }

    pub(super) fn validate_state_after(&self, context: &str) {
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

    pub(super) fn workspace_sync_from_registry(&mut self) -> bool {
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

    pub(super) fn workspace_send_state(&mut self) {
        self.workspace_warn_invariants("send_state");
        self.next_shell_workspace_revision();
        let Some(msg) = self.workspace_state_message() else {
            return;
        };
        self.shell_send_to_cef(msg);
    }

    pub(super) fn taskbar_pin_current_output_name(
        &self,
        output_name: &str,
        output_id: &str,
    ) -> String {
        if !output_id.is_empty() {
            if let Some(name) = self
                .output_topology
                .space
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
        let Some((command, output_name, output_id)) =
            self.workspace_layout.taskbar_pin_launch_command(json)
        else {
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
        self.workspace_layout
            .workspace_state_for_shell(|output_id| {
                self.output_topology
                    .space
                    .outputs()
                    .find(|output| Self::shell_output_identity(output) == output_id)
                    .map(|output| output.name())
            })
    }

    pub(super) fn workspace_state_binary_message(
        &self,
    ) -> Option<shell_wire::DecodedCompositorToShellMessage> {
        let state = self.workspace_state_for_shell();
        self.workspace_layout.workspace_state_binary_message(&state)
    }

    pub(super) fn workspace_state_message(
        &self,
    ) -> Option<shell_wire::DecodedCompositorToShellMessage> {
        let state = self.workspace_state_for_shell();
        self.workspace_layout.workspace_state_message(&state)
    }

    #[allow(dead_code)]
    pub(super) fn shell_hosted_app_state_broadcast_json(&self) -> String {
        self.shell_osr.hosted_app_state_broadcast_json()
    }

    pub(crate) fn shell_hosted_app_state_send(&mut self) {
        self.next_shell_hosted_app_state_revision();
        self.shell_send_to_cef(self.shell_hosted_app_state_message());
    }

    pub(super) fn shell_hosted_app_state_message(
        &self,
    ) -> shell_wire::DecodedCompositorToShellMessage {
        self.shell_osr.shell_hosted_app_state_message()
    }

    pub(super) fn shell_focus_message(&self) -> shell_wire::DecodedCompositorToShellMessage {
        let window_id = self.logical_focused_window_id();
        let surface_id =
            window_id.and_then(|w| self.windows.window_registry.surface_id_for_window(w));
        ShellOsrState::shell_focus_message(window_id, surface_id)
    }

    pub(super) fn shell_focus_snapshot_message(
        &self,
    ) -> shell_wire::DecodedCompositorToShellMessage {
        self.shell_osr.shell_focus_snapshot_message(
            |window_id| {
                self.windows
                    .window_registry
                    .window_info(window_id)
                    .map(|info| {
                        !info.minimized
                            && !self.window_info_is_solid_shell_host(&info)
                            && shell_window_row_should_show(&info)
                            && !self.shell_x11_window_is_tray_hidden(info.window_id)
                    })
                    .unwrap_or(false)
            },
            |window_id| {
                self.windows
                    .window_registry
                    .surface_id_for_window(window_id)
            },
        )
    }

    pub(super) fn shell_tray_hints_message(&self) -> shell_wire::DecodedCompositorToShellMessage {
        let slot_w: i32 = 40;
        if self.shell_effective_primary_output().is_none() {
            return shell_wire::DecodedCompositorToShellMessage::TrayHints {
                slot_count: 0,
                slot_w,
                reserved_w: 0,
            };
        }
        let slot_count = self.tray_notifications.sni_tray_slot_count();
        let reserved_w = slot_count.saturating_mul(slot_w.max(1) as u32);
        shell_wire::DecodedCompositorToShellMessage::TrayHints {
            slot_count,
            slot_w,
            reserved_w,
        }
    }

    pub(crate) fn shell_native_drag_preview_begin(&mut self, window_id: u32) {
        let preview_allowed = self
            .windows
            .window_registry
            .window_info(window_id)
            .is_some_and(|info| self.native_window_uses_shell_chrome(&info));
        if self.windows.window_registry.is_shell_hosted(window_id) || !preview_allowed {
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
        let generation = self
            .input_routing
            .shell_native_drag_preview_generation
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
        let clear = self
            .input_routing
            .shell_native_drag_preview
            .as_ref()
            .and_then(|preview| {
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
        let Some((window_id, generation)) = self
            .input_routing
            .shell_native_drag_preview
            .as_ref()
            .and_then(|preview| {
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
        let Some((window_id, generation)) = self
            .input_routing
            .shell_native_drag_preview
            .as_ref()
            .and_then(|preview| {
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

    pub(super) fn shell_native_drag_preview_capture_signature(
        &self,
        window_id: u32,
    ) -> Option<(String, i32, i32, i32, i32)> {
        let source = self.capture_window_source_descriptor(window_id)?;
        let actual_rect = self.mapped_native_window_content_rect(window_id)?;
        let output = self
            .output_topology
            .space
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

    pub(super) fn shell_native_drag_preview_capture_ready(
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
        let sid = self
            .windows
            .window_registry
            .surface_id_for_window(window_id)?;
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let loc = self
                .output_topology
                .space
                .element_location(&DerpSpaceElem::Wayland(window.clone()))?;
            let size = window.geometry().size;
            return Some(Rectangle::new(loc, size));
        }
        let x11 = self.find_x11_window_by_surface_id(sid)?;
        let loc = self
            .output_topology
            .space
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
        let info = self
            .windows
            .window_registry
            .window_info(preview.window_id)?;
        if !self.native_window_uses_shell_chrome(&info) {
            return None;
        }
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

    pub(super) fn shell_send_native_drag_preview_detail(
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

    pub(super) fn shell_native_drag_preview_message(
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

    pub(super) fn shell_interaction_owner_signature(&self) -> (u32, u32, u32, u32) {
        self.input_routing.shell_interaction_owner_signature()
    }

    pub(super) fn sync_shell_interaction_serial(&mut self) {
        self.input_routing.sync_shell_interaction_serial();
    }

    pub(super) fn shell_interaction_state_message(
        &self,
    ) -> shell_wire::DecodedCompositorToShellMessage {
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
        let pointer = self
            .input_routing
            .seat
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
            self.input_routing.shell_super_held,
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
}
