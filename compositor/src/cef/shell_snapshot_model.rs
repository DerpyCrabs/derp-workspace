use std::collections::HashMap;

#[derive(Default)]
pub(crate) struct ShellSnapshotModel {
    output_geometry: Option<shell_wire::DecodedCompositorToShellMessage>,
    output_layout: Option<shell_wire::DecodedCompositorToShellMessage>,
    window_list_revision: u64,
    window_order_revision: u64,
    window_rows_by_id: HashMap<u32, shell_wire::ShellWindowSnapshot>,
    window_order_entries: Vec<shell_wire::ShellWindowOrderEntry>,
    sorted_window_ids: Vec<u32>,
    sorted_window_ids_dirty: bool,
    window_list_cache: Vec<shell_wire::ShellWindowSnapshot>,
    window_list_cache_dirty: bool,
    focus_changed: Option<shell_wire::DecodedCompositorToShellMessage>,
    keyboard_layout: Option<shell_wire::DecodedCompositorToShellMessage>,
    workspace_state: Option<shell_wire::DecodedCompositorToShellMessage>,
    shell_hosted_app_state: Option<shell_wire::DecodedCompositorToShellMessage>,
    command_palette_state: Option<shell_wire::DecodedCompositorToShellMessage>,
    interaction_state: Option<shell_wire::DecodedCompositorToShellMessage>,
    native_drag_preview: Option<shell_wire::DecodedCompositorToShellMessage>,
    tray_hints: Option<shell_wire::DecodedCompositorToShellMessage>,
    tray_sni: Option<shell_wire::DecodedCompositorToShellMessage>,
}

impl ShellSnapshotModel {
    fn next_window_list_revision(&mut self) -> u64 {
        self.window_list_revision = self.window_list_revision.wrapping_add(1);
        self.window_list_revision
    }

    fn next_window_order_revision(&mut self) -> u64 {
        self.window_order_revision = self.window_order_revision.wrapping_add(1);
        self.window_order_revision
    }

    fn window_row_mut(&mut self, window_id: u32) -> Option<&mut shell_wire::ShellWindowSnapshot> {
        self.window_rows_by_id.get_mut(&window_id)
    }

    fn window_row_remove(&mut self, window_id: u32) -> bool {
        self.window_rows_by_id.remove(&window_id).is_some()
    }

    fn mark_all_window_caches_dirty(&mut self) {
        self.sorted_window_ids_dirty = true;
        self.window_list_cache_dirty = true;
    }

    fn mark_window_list_cache_dirty(&mut self) {
        self.window_list_cache_dirty = true;
    }

    fn ordered_window_rows(&mut self) -> Vec<shell_wire::ShellWindowSnapshot> {
        self.ensure_window_list_cache();
        self.window_list_cache.clone()
    }

    fn refresh_window_order_entries_from_rows(&mut self) {
        self.ensure_window_list_cache();
        self.window_order_entries = self
            .window_list_cache
            .iter()
            .map(|window| shell_wire::ShellWindowOrderEntry {
                window_id: window.window_id,
                stack_z: window.stack_z,
            })
            .collect();
    }

    fn ensure_sorted_window_ids(&mut self) {
        if !self.sorted_window_ids_dirty {
            return;
        }
        self.sorted_window_ids = self.window_rows_by_id.keys().copied().collect();
        self.sorted_window_ids.sort_unstable();
        self.sorted_window_ids_dirty = false;
    }

    fn ensure_window_list_cache(&mut self) {
        if !self.window_list_cache_dirty {
            return;
        }
        self.ensure_sorted_window_ids();
        self.window_list_cache.clear();
        for window_id in self.sorted_window_ids.iter().copied() {
            if let Some(row) = self.window_rows_by_id.get(&window_id) {
                self.window_list_cache.push(row.clone());
            }
        }
        self.window_list_cache_dirty = false;
    }

    pub(crate) fn apply(&mut self, message: &shell_wire::DecodedCompositorToShellMessage) {
        match message {
            shell_wire::DecodedCompositorToShellMessage::OutputGeometry { .. } => {
                self.output_geometry = Some(message.clone());
            }
            shell_wire::DecodedCompositorToShellMessage::OutputLayout { .. } => {
                self.output_layout = Some(message.clone());
            }
            shell_wire::DecodedCompositorToShellMessage::WindowList { revision, windows } => {
                self.window_list_revision = *revision;
                self.window_order_revision = *revision;
                self.window_rows_by_id.clear();
                for window in windows {
                    self.window_rows_by_id
                        .insert(window.window_id, window.clone());
                }
                self.mark_all_window_caches_dirty();
                self.refresh_window_order_entries_from_rows();
            }
            shell_wire::DecodedCompositorToShellMessage::WindowOrder { revision, windows } => {
                self.window_order_revision = *revision;
                self.window_order_entries = windows.clone();
            }
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
                if let Some(row) = self.window_row_mut(*window_id) {
                    row.surface_id = *surface_id;
                    row.stack_z = *stack_z;
                    row.x = *x;
                    row.y = *y;
                    row.w = *w;
                    row.h = *h;
                    row.client_x = *x;
                    row.client_y = *y;
                    row.client_w = *w;
                    row.client_h = *h;
                    row.frame_x = *x;
                    row.frame_y = *y;
                    row.frame_w = *w;
                    row.frame_h = *h;
                    row.minimized = if *minimized { 1 } else { 0 };
                    row.maximized = if *maximized { 1 } else { 0 };
                    row.fullscreen = if *fullscreen { 1 } else { 0 };
                    row.title = title.clone();
                    row.app_id = app_id.clone();
                    row.client_side_decoration = if *client_side_decoration { 1 } else { 0 };
                    row.shell_flags = *shell_flags;
                    row.output_id = output_id.clone();
                    row.output_name = output_name.clone();
                    row.capture_identifier = capture_identifier.clone();
                    row.kind = kind.clone();
                    row.x11_class = x11_class.clone();
                    row.x11_instance = x11_instance.clone();
                } else {
                    self.window_rows_by_id.insert(
                        *window_id,
                        shell_wire::ShellWindowSnapshot {
                            window_id: *window_id,
                            surface_id: *surface_id,
                            stack_z: *stack_z,
                            x: *x,
                            y: *y,
                            w: *w,
                            h: *h,
                            client_x: *x,
                            client_y: *y,
                            client_w: *w,
                            client_h: *h,
                            frame_x: *x,
                            frame_y: *y,
                            frame_w: *w,
                            frame_h: *h,
                            minimized: if *minimized { 1 } else { 0 },
                            maximized: if *maximized { 1 } else { 0 },
                            fullscreen: if *fullscreen { 1 } else { 0 },
                            client_side_decoration: if *client_side_decoration { 1 } else { 0 },
                            workspace_visible: 1,
                            shell_flags: *shell_flags,
                            title: title.clone(),
                            app_id: app_id.clone(),
                            output_id: output_id.clone(),
                            output_name: output_name.clone(),
                            capture_identifier: capture_identifier.clone(),
                            kind: kind.clone(),
                            x11_class: x11_class.clone(),
                            x11_instance: x11_instance.clone(),
                            icon_name: String::new(),
                            icon_buffers: Vec::new(),
                        },
                    );
                }
                self.mark_all_window_caches_dirty();
                self.next_window_list_revision();
                self.refresh_window_order_entries_from_rows();
                self.next_window_order_revision();
            }
            shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { window_id } => {
                if self.window_row_remove(*window_id) {
                    self.mark_all_window_caches_dirty();
                    self.next_window_list_revision();
                    self.refresh_window_order_entries_from_rows();
                    self.next_window_order_revision();
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
                output_id,
                output_name,
                client_x,
                client_y,
                client_w,
                client_h,
                frame_x,
                frame_y,
                frame_w,
                frame_h,
            } => {
                let changed = if let Some(row) = self.window_row_mut(*window_id) {
                    let changed = row.surface_id != *surface_id
                        || row.x != *x
                        || row.y != *y
                        || row.w != *w
                        || row.h != *h
                        || row.client_x != *client_x
                        || row.client_y != *client_y
                        || row.client_w != *client_w
                        || row.client_h != *client_h
                        || row.frame_x != *frame_x
                        || row.frame_y != *frame_y
                        || row.frame_w != *frame_w
                        || row.frame_h != *frame_h
                        || row.maximized != if *maximized { 1 } else { 0 }
                        || row.fullscreen != if *fullscreen { 1 } else { 0 }
                        || row.client_side_decoration
                            != if *client_side_decoration { 1 } else { 0 }
                        || row.output_id != *output_id
                        || row.output_name != *output_name;
                    row.surface_id = *surface_id;
                    row.x = *x;
                    row.y = *y;
                    row.w = *w;
                    row.h = *h;
                    row.client_x = *client_x;
                    row.client_y = *client_y;
                    row.client_w = *client_w;
                    row.client_h = *client_h;
                    row.frame_x = *frame_x;
                    row.frame_y = *frame_y;
                    row.frame_w = *frame_w;
                    row.frame_h = *frame_h;
                    row.maximized = if *maximized { 1 } else { 0 };
                    row.fullscreen = if *fullscreen { 1 } else { 0 };
                    row.client_side_decoration = if *client_side_decoration { 1 } else { 0 };
                    row.output_id = output_id.clone();
                    row.output_name = output_name.clone();
                    changed
                } else {
                    false
                };
                if changed {
                    self.mark_window_list_cache_dirty();
                    self.next_window_list_revision();
                }
            }
            shell_wire::DecodedCompositorToShellMessage::WindowMetadata {
                window_id,
                surface_id,
                title,
                app_id,
                icon_name,
                icon_buffers,
            } => {
                let changed = if let Some(row) = self.window_row_mut(*window_id) {
                    let changed = row.surface_id != *surface_id
                        || row.title != *title
                        || row.app_id != *app_id
                        || row.icon_name != *icon_name
                        || row.icon_buffers != *icon_buffers;
                    row.surface_id = *surface_id;
                    row.title = title.clone();
                    row.app_id = app_id.clone();
                    row.icon_name = icon_name.clone();
                    row.icon_buffers = icon_buffers.clone();
                    changed
                } else {
                    false
                };
                if changed {
                    self.mark_window_list_cache_dirty();
                    self.next_window_list_revision();
                }
            }
            shell_wire::DecodedCompositorToShellMessage::WindowState {
                window_id,
                minimized,
            } => {
                let changed = if let Some(row) = self.window_row_mut(*window_id) {
                    let next_minimized = if *minimized { 1 } else { 0 };
                    if row.minimized != next_minimized {
                        row.minimized = next_minimized;
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                if changed {
                    self.mark_window_list_cache_dirty();
                    self.next_window_list_revision();
                }
            }
            shell_wire::DecodedCompositorToShellMessage::FocusChanged { .. } => {
                self.focus_changed = Some(message.clone());
            }
            shell_wire::DecodedCompositorToShellMessage::KeyboardLayout { .. } => {
                self.keyboard_layout = Some(message.clone());
            }
            shell_wire::DecodedCompositorToShellMessage::WorkspaceState { .. } => {
                self.workspace_state = Some(message.clone());
            }
            shell_wire::DecodedCompositorToShellMessage::WorkspaceStateBinary { .. } => {
                self.workspace_state = Some(message.clone());
            }
            shell_wire::DecodedCompositorToShellMessage::ShellHostedAppState { .. } => {
                self.shell_hosted_app_state = Some(message.clone());
            }
            shell_wire::DecodedCompositorToShellMessage::CommandPaletteState { .. } => {
                self.command_palette_state = Some(message.clone());
            }
            shell_wire::DecodedCompositorToShellMessage::InteractionState { .. } => {
                self.interaction_state = Some(message.clone());
            }
            shell_wire::DecodedCompositorToShellMessage::NativeDragPreview { .. } => {
                self.native_drag_preview = Some(message.clone());
            }
            shell_wire::DecodedCompositorToShellMessage::TrayHints { .. } => {
                self.tray_hints = Some(message.clone());
            }
            shell_wire::DecodedCompositorToShellMessage::TraySni { .. } => {
                self.tray_sni = Some(message.clone());
            }
            _ => {}
        }
    }

    #[cfg(test)]
    pub(crate) fn messages(&mut self) -> Vec<shell_wire::DecodedCompositorToShellMessage> {
        self.messages_for_domains((1u32 << shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT) - 1)
    }

    pub(crate) fn messages_for_domains(
        &mut self,
        domains: u32,
    ) -> Vec<shell_wire::DecodedCompositorToShellMessage> {
        let mut messages = Vec::new();
        if domains & shell_wire::SHELL_SNAPSHOT_DOMAIN_OUTPUTS != 0 {
            if let Some(message) = self.output_geometry.clone() {
                messages.push(message);
            }
            if let Some(message) = self.output_layout.clone() {
                messages.push(message);
            }
        }
        if domains & shell_wire::SHELL_SNAPSHOT_DOMAIN_WINDOWS != 0 {
            let rows = self.ordered_window_rows();
            messages.push(shell_wire::DecodedCompositorToShellMessage::WindowList {
                revision: self.window_list_revision,
                windows: rows,
            });
        }
        if domains & shell_wire::SHELL_SNAPSHOT_DOMAIN_WINDOW_ORDER != 0 {
            if self.window_order_entries.is_empty() && !self.window_rows_by_id.is_empty() {
                self.refresh_window_order_entries_from_rows();
            }
            messages.push(shell_wire::DecodedCompositorToShellMessage::WindowOrder {
                revision: self.window_order_revision,
                windows: self.window_order_entries.clone(),
            });
        }
        if domains & shell_wire::SHELL_SNAPSHOT_DOMAIN_FOCUS != 0 {
            if let Some(message) = self.focus_changed.clone() {
                messages.push(message);
            }
        }
        if domains & shell_wire::SHELL_SNAPSHOT_DOMAIN_WORKSPACE != 0 {
            if let Some(message) = self.workspace_state.clone() {
                messages.push(message);
            }
        }
        if domains & shell_wire::SHELL_SNAPSHOT_DOMAIN_SHELL_HOSTED_APPS != 0 {
            if let Some(message) = self.shell_hosted_app_state.clone() {
                messages.push(message);
            }
        }
        if domains & shell_wire::SHELL_SNAPSHOT_DOMAIN_COMMAND_PALETTE != 0 {
            if let Some(message) = self.command_palette_state.clone() {
                messages.push(message);
            }
        }
        if domains & shell_wire::SHELL_SNAPSHOT_DOMAIN_INTERACTION != 0 {
            if let Some(message) = self.interaction_state.clone() {
                messages.push(message);
            }
        }
        if domains & shell_wire::SHELL_SNAPSHOT_DOMAIN_NATIVE_DRAG_PREVIEW != 0 {
            if let Some(message) = self.native_drag_preview.clone() {
                messages.push(message);
            }
        }
        if domains & shell_wire::SHELL_SNAPSHOT_DOMAIN_KEYBOARD != 0 {
            if let Some(message) = self.keyboard_layout.clone() {
                messages.push(message);
            }
        }
        if domains & shell_wire::SHELL_SNAPSHOT_DOMAIN_TRAY != 0 {
            if let Some(message) = self.tray_hints.clone() {
                messages.push(message);
            }
            if let Some(message) = self.tray_sni.clone() {
                messages.push(message);
            }
        }
        messages
    }
}

pub(crate) fn snapshot_domain_for_message(
    message: &shell_wire::DecodedCompositorToShellMessage,
) -> u32 {
    match message {
        shell_wire::DecodedCompositorToShellMessage::OutputGeometry { .. }
        | shell_wire::DecodedCompositorToShellMessage::OutputLayout { .. } => {
            shell_wire::SHELL_SNAPSHOT_DOMAIN_OUTPUTS
        }
        shell_wire::DecodedCompositorToShellMessage::WindowList { .. }
        | shell_wire::DecodedCompositorToShellMessage::WindowMapped { .. }
        | shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { .. } => {
            shell_wire::SHELL_SNAPSHOT_DOMAIN_WINDOWS
        }
        shell_wire::DecodedCompositorToShellMessage::WindowGeometry { .. } => {
            shell_wire::SHELL_SNAPSHOT_DOMAIN_WINDOW_GEOMETRY
        }
        shell_wire::DecodedCompositorToShellMessage::WindowMetadata { .. } => {
            shell_wire::SHELL_SNAPSHOT_DOMAIN_WINDOW_METADATA
        }
        shell_wire::DecodedCompositorToShellMessage::WindowState { .. } => {
            shell_wire::SHELL_SNAPSHOT_DOMAIN_WINDOW_STATE
        }
        shell_wire::DecodedCompositorToShellMessage::WindowOrder { .. } => {
            shell_wire::SHELL_SNAPSHOT_DOMAIN_WINDOW_ORDER
        }
        shell_wire::DecodedCompositorToShellMessage::FocusChanged { .. } => {
            shell_wire::SHELL_SNAPSHOT_DOMAIN_FOCUS
        }
        shell_wire::DecodedCompositorToShellMessage::KeyboardLayout { .. } => {
            shell_wire::SHELL_SNAPSHOT_DOMAIN_KEYBOARD
        }
        shell_wire::DecodedCompositorToShellMessage::WorkspaceState { .. }
        | shell_wire::DecodedCompositorToShellMessage::WorkspaceStateBinary { .. } => {
            shell_wire::SHELL_SNAPSHOT_DOMAIN_WORKSPACE
        }
        shell_wire::DecodedCompositorToShellMessage::ShellHostedAppState { .. } => {
            shell_wire::SHELL_SNAPSHOT_DOMAIN_SHELL_HOSTED_APPS
        }
        shell_wire::DecodedCompositorToShellMessage::CommandPaletteState { .. } => {
            shell_wire::SHELL_SNAPSHOT_DOMAIN_COMMAND_PALETTE
        }
        shell_wire::DecodedCompositorToShellMessage::InteractionState { .. } => {
            shell_wire::SHELL_SNAPSHOT_DOMAIN_INTERACTION
        }
        shell_wire::DecodedCompositorToShellMessage::NativeDragPreview { .. } => {
            shell_wire::SHELL_SNAPSHOT_DOMAIN_NATIVE_DRAG_PREVIEW
        }
        shell_wire::DecodedCompositorToShellMessage::TrayHints { .. }
        | shell_wire::DecodedCompositorToShellMessage::TraySni { .. } => {
            shell_wire::SHELL_SNAPSHOT_DOMAIN_TRAY
        }
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::ShellSnapshotModel;

    fn mapped_window(
        window_id: u32,
        stack_z: u32,
        title: &str,
    ) -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::WindowMapped {
            window_id,
            surface_id: window_id * 10,
            stack_z,
            x: 10,
            y: 20,
            w: 300,
            h: 200,
            minimized: false,
            maximized: false,
            fullscreen: false,
            title: title.to_string(),
            app_id: format!("app.{window_id}"),
            client_side_decoration: false,
            shell_flags: 0,
            output_id: "out-a".to_string(),
            output_name: "DP-1".to_string(),
            capture_identifier: String::new(),
            kind: "native".to_string(),
            x11_class: String::new(),
            x11_instance: String::new(),
        }
    }

    #[test]
    fn model_keeps_window_list_authoritative_from_incremental_events() {
        let mut model = ShellSnapshotModel::default();
        model.apply(&mapped_window(3, 3, "First"));
        model.apply(
            &shell_wire::DecodedCompositorToShellMessage::WindowMetadata {
                window_id: 3,
                surface_id: 31,
                title: "Renamed".to_string(),
                app_id: "app.renamed".to_string(),
                icon_name: "utilities-terminal".to_string(),
                icon_buffers: vec![shell_wire::ShellWindowIconBufferSnapshot {
                    width: 32,
                    height: 32,
                    scale: 1,
                }],
            },
        );

        let messages = model.messages();
        let Some(shell_wire::DecodedCompositorToShellMessage::WindowList { revision, windows }) =
            messages.iter().find(|message| {
                matches!(
                    message,
                    shell_wire::DecodedCompositorToShellMessage::WindowList { .. }
                )
            })
        else {
            panic!("missing window list");
        };

        assert_eq!(*revision, 2);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].window_id, 3);
        assert_eq!(windows[0].surface_id, 31);
        assert_eq!(windows[0].title, "Renamed");
        assert_eq!(windows[0].app_id, "app.renamed");
    }

    #[test]
    fn model_emits_full_window_and_order_domains_after_window_changes() {
        let mut model = ShellSnapshotModel::default();
        model.apply(&mapped_window(3, 3, "First"));
        model.apply(&mapped_window(4, 9, "Second"));
        model.apply(
            &shell_wire::DecodedCompositorToShellMessage::WindowOrder {
                revision: 22,
                windows: vec![
                    shell_wire::ShellWindowOrderEntry {
                        window_id: 3,
                        stack_z: 12,
                    },
                    shell_wire::ShellWindowOrderEntry {
                        window_id: 4,
                        stack_z: 2,
                    },
                ],
            },
        );

        let messages = model.messages();
        let window_list = messages
            .iter()
            .find_map(|message| match message {
                shell_wire::DecodedCompositorToShellMessage::WindowList { windows, .. } => {
                    Some(windows)
                }
                _ => None,
            })
            .expect("missing window list");
        let window_order = messages
            .iter()
            .find_map(|message| match message {
                shell_wire::DecodedCompositorToShellMessage::WindowOrder {
                    revision,
                    windows,
                } => Some((*revision, windows)),
                _ => None,
            })
            .expect("missing window order");

        assert_eq!(window_list.len(), 2);
        assert_eq!(window_list[0].stack_z, 3);
        assert_eq!(window_order.0, 22);
        assert_eq!(window_order.1.len(), 2);
        assert_eq!(window_order.1[0].window_id, 3);
        assert_eq!(window_order.1[0].stack_z, 12);
    }

    #[test]
    fn model_keeps_workspace_domain_authoritative_after_window_churn() {
        let mut model = ShellSnapshotModel::default();
        model.apply(&mapped_window(3, 3, "First"));
        model.apply(&shell_wire::DecodedCompositorToShellMessage::WorkspaceState {
            revision: 7,
            state_json: r#"{"groups":[{"id":"group-1","windowIds":[3]}],"activeTabByGroupId":{"group-1":3},"nextGroupSeq":2}"#.to_string(),
        });
        model.apply(&shell_wire::DecodedCompositorToShellMessage::WindowUnmapped {
            window_id: 3,
        });

        let messages = model.messages();
        let workspace = messages
            .iter()
            .find_map(|message| match message {
                shell_wire::DecodedCompositorToShellMessage::WorkspaceState {
                    revision,
                    state_json,
                } => Some((*revision, state_json)),
                _ => None,
            })
            .expect("missing workspace state");
        let window_list = messages
            .iter()
            .find_map(|message| match message {
                shell_wire::DecodedCompositorToShellMessage::WindowList { windows, .. } => {
                    Some(windows)
                }
                _ => None,
            })
            .expect("missing window list");
        let window_order = messages
            .iter()
            .find_map(|message| match message {
                shell_wire::DecodedCompositorToShellMessage::WindowOrder { windows, .. } => {
                    Some(windows)
                }
                _ => None,
            })
            .expect("missing window order");

        assert_eq!(workspace.0, 7);
        assert!(workspace.1.contains("group-1"));
        assert!(window_list.is_empty());
        assert!(window_order.is_empty());
    }
}
