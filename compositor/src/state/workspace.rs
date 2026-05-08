use super::*;

pub(crate) struct WorkspaceLayoutState {
    pub(crate) workspace_state: WorkspaceState,
    pub(crate) taskbar_pins: Vec<WorkspaceTaskbarPinMonitor>,
    pub(crate) shell_workspace_revision: u64,
    pub(crate) control_workspace_revision: u64,
    pub(crate) session_default_layout_index: u32,
    pub(crate) tile_preview_rect_global: Option<Rectangle<i32, Logical>>,
    pub(crate) tile_preview_solid: SolidColorBuffer,
    pub(crate) scratchpad_settings: crate::session::settings_config::ScratchpadSettingsFile,
    pub(crate) scratchpad_windows: HashMap<u32, ScratchpadWindowState>,
    pub(crate) scratchpad_last_window_by_id: HashMap<String, u32>,
}

impl WorkspaceLayoutState {
    pub(crate) fn new() -> Self {
        Self {
            workspace_state: WorkspaceState::default(),
            taskbar_pins: crate::session::taskbar_pins::read_taskbar_pins(),
            shell_workspace_revision: 0,
            control_workspace_revision: 0,
            session_default_layout_index: 0,
            tile_preview_rect_global: None,
            tile_preview_solid: SolidColorBuffer::new((1, 1), Color32F::TRANSPARENT),
            scratchpad_settings: crate::session::settings_config::read_scratchpad_settings(),
            scratchpad_windows: HashMap::new(),
            scratchpad_last_window_by_id: HashMap::new(),
        }
    }

    pub(crate) fn next_shell_workspace_revision(&mut self) -> u64 {
        self.shell_workspace_revision = self.shell_workspace_revision.wrapping_add(1);
        self.shell_workspace_revision
    }

    pub(crate) fn set_session_default_layout_index(&mut self, index: u32) {
        self.session_default_layout_index = index;
    }

    pub(crate) fn apply_tile_preview_rect(
        &mut self,
        visible: bool,
        rect: Option<Rectangle<i32, Logical>>,
    ) {
        self.tile_preview_rect_global = visible.then_some(rect).flatten();
    }

    pub(crate) fn workspace_group_visible_window_id(
        &self,
        registry: &WindowRegistry,
        group_id: &str,
    ) -> Option<u32> {
        let group = self
            .workspace_state
            .groups
            .iter()
            .find(|group| group.id == group_id)?;
        let split_left_window_id = self
            .workspace_state
            .split_by_group_id
            .get(group_id)
            .map(|split| split.left_window_id);
        if let Some(window_id) = self.workspace_state.visible_window_id_for_group(group_id) {
            if split_left_window_id != Some(window_id)
                && registry
                    .window_info(window_id)
                    .is_some_and(|info| !info.minimized)
            {
                return Some(window_id);
            }
        }
        if let Some(left_window_id) = split_left_window_id {
            if let Some(first_right_window_id) = group
                .window_ids
                .iter()
                .copied()
                .find(|window_id| *window_id != left_window_id)
            {
                return Some(first_right_window_id);
            }
        }
        group
            .window_ids
            .iter()
            .copied()
            .find(|window_id| {
                registry
                    .window_info(*window_id)
                    .is_some_and(|info| !info.minimized)
            })
            .or_else(|| group.window_ids.first().copied())
    }

    pub(crate) fn workspace_window_is_logically_visible(
        &self,
        registry: &WindowRegistry,
        window_id: u32,
    ) -> bool {
        let Some(info) = registry.window_info(window_id) else {
            return false;
        };
        if info.minimized {
            return false;
        }
        let Some(group_id) = group_id_for_window(&self.workspace_state, window_id) else {
            return true;
        };
        let Some(group) = self
            .workspace_state
            .groups
            .iter()
            .find(|group| group.id == group_id)
        else {
            return true;
        };
        let split_left_window_id = self
            .workspace_state
            .split_by_group_id
            .get(group_id)
            .map(|split| split.left_window_id);
        group.window_ids.len() <= 1
            || self.workspace_group_visible_window_id(registry, group_id) == Some(window_id)
            || split_left_window_id == Some(window_id)
    }

    pub(crate) fn workspace_window_render_alpha(
        moving_window_id: Option<u32>,
        window_id: u32,
    ) -> f32 {
        if moving_window_id == Some(window_id) {
            SHELL_DRAG_WINDOW_ALPHA
        } else {
            1.0
        }
    }

    pub(crate) fn workspace_window_is_tiled(&self, window_id: u32) -> bool {
        self.workspace_state.monitor_tiles.iter().any(|monitor| {
            monitor
                .entries
                .iter()
                .any(|entry| entry.window_id == window_id)
        })
    }

    pub(crate) fn workspace_auto_layout_client_rect_from_frame_rect(
        rect: Rectangle<i32, Logical>,
        titlebar_h: i32,
    ) -> Rectangle<i32, Logical> {
        let titlebar_h = titlebar_h.max(0);
        Rectangle::new(
            Point::from((rect.loc.x, rect.loc.y.saturating_add(titlebar_h))),
            Size::from((
                rect.size.w.max(1),
                rect.size.h.saturating_sub(titlebar_h).max(1),
            )),
        )
    }

    pub(crate) fn workspace_monitor_layout_state_for_output(
        &self,
        output_name: &str,
        output_id: Option<&str>,
    ) -> Option<&WorkspaceMonitorLayoutState> {
        self.workspace_state
            .monitor_layout_for_output(output_name)
            .or_else(|| {
                let output_id = output_id?;
                self.workspace_state
                    .monitor_layouts
                    .iter()
                    .find(|entry| entry.output_id == output_id)
            })
    }

    pub(crate) fn workspace_clamp_master_ratio(value: Option<f64>) -> f64 {
        const DEFAULT_MASTER_RATIO: f64 = 0.55;
        let ratio = value.unwrap_or(DEFAULT_MASTER_RATIO);
        if ratio.is_nan() {
            return DEFAULT_MASTER_RATIO;
        }
        ratio.clamp(0.01, 0.99)
    }

    pub(crate) fn workspace_custom_auto_slots(
        layout_state: &WorkspaceMonitorLayoutState,
    ) -> Vec<WorkspaceCustomAutoSlot> {
        let mut slots = Vec::new();
        let mut seen = HashSet::new();
        for slot in &layout_state.params.custom_slots {
            if slot.slot_id.trim().is_empty() || !seen.insert(slot.slot_id.clone()) {
                continue;
            }
            if !slot.x.is_finite()
                || !slot.y.is_finite()
                || !slot.width.is_finite()
                || !slot.height.is_finite()
                || slot.width <= 0.0
                || slot.height <= 0.0
            {
                continue;
            }
            let mut next = slot.clone();
            next.x = next.x.clamp(0.0, 0.999);
            next.y = next.y.clamp(0.0, 0.999);
            next.width = next.width.clamp(0.001, 1.0 - next.x);
            next.height = next.height.clamp(0.001, 1.0 - next.y);
            next.rules.retain(|rule| !rule.value.trim().is_empty());
            slots.push(next);
        }
        slots
    }

    pub(crate) fn workspace_custom_auto_frame_rect(
        slot: &WorkspaceCustomAutoSlot,
        work_area: Rectangle<i32, Logical>,
    ) -> Rectangle<i32, Logical> {
        let x = work_area.loc.x;
        let y = work_area.loc.y;
        let w = work_area.size.w.max(1);
        let h = work_area.size.h.max(1);
        let left = x.saturating_add((slot.x * f64::from(w)).round() as i32);
        let top = y.saturating_add((slot.y * f64::from(h)).round() as i32);
        let right = x.saturating_add(((slot.x + slot.width) * f64::from(w)).round() as i32);
        let bottom = y.saturating_add(((slot.y + slot.height) * f64::from(h)).round() as i32);
        Rectangle::new(
            Point::from((left, top)),
            Size::from((
                right.saturating_sub(left).max(1),
                bottom.saturating_sub(top).max(1),
            )),
        )
    }

    pub(crate) fn workspace_slot_rule_matches(haystack: &str, rule: &WorkspaceSlotRule) -> bool {
        let value = rule.value.trim();
        if value.is_empty() {
            return false;
        }
        match rule.op {
            WorkspaceSlotRuleOp::Equals => haystack == value,
            WorkspaceSlotRuleOp::Contains => haystack.contains(value),
            WorkspaceSlotRuleOp::StartsWith => haystack.starts_with(value),
        }
    }

    pub(crate) fn workspace_compute_auto_layout_frame_rects<F>(
        layout_state: &WorkspaceMonitorLayoutState,
        window_ids: &[u32],
        work_area: Rectangle<i32, Logical>,
        slot_matches: F,
    ) -> HashMap<u32, Rectangle<i32, Logical>>
    where
        F: Fn(u32, &WorkspaceCustomAutoSlot) -> bool,
    {
        let mut out = HashMap::new();
        if window_ids.is_empty() {
            return out;
        }
        let x = work_area.loc.x;
        let y = work_area.loc.y;
        let w = work_area.size.w.max(1);
        let h = work_area.size.h.max(1);
        match layout_state.layout {
            WorkspaceMonitorLayoutType::ManualSnap => {}
            WorkspaceMonitorLayoutType::CustomAuto => {
                let slots = Self::workspace_custom_auto_slots(layout_state);
                if slots.is_empty() {
                    return out;
                }
                let mut assigned_windows = HashSet::new();
                let mut assigned_slots: HashSet<usize> = HashSet::new();
                for &window_id in window_ids {
                    let Some(slot_index) =
                        slots.iter().position(|slot| slot_matches(window_id, slot))
                    else {
                        continue;
                    };
                    if !assigned_slots.insert(slot_index) {
                        continue;
                    }
                    assigned_windows.insert(window_id);
                    out.insert(
                        window_id,
                        Self::workspace_custom_auto_frame_rect(&slots[slot_index], work_area),
                    );
                }
                for &window_id in window_ids {
                    if assigned_windows.contains(&window_id) {
                        continue;
                    }
                    let Some(slot_index) =
                        (0..slots.len()).find(|index| assigned_slots.insert(*index))
                    else {
                        let slot_index = slots.len().saturating_sub(1);
                        out.insert(
                            window_id,
                            Self::workspace_custom_auto_frame_rect(&slots[slot_index], work_area),
                        );
                        continue;
                    };
                    out.insert(
                        window_id,
                        Self::workspace_custom_auto_frame_rect(&slots[slot_index], work_area),
                    );
                }
            }
            WorkspaceMonitorLayoutType::MasterStack => {
                if window_ids.len() == 1 {
                    out.insert(
                        window_ids[0],
                        Rectangle::new(Point::from((x, y)), Size::from((w, h))),
                    );
                    return out;
                }
                let ratio = Self::workspace_clamp_master_ratio(layout_state.params.master_ratio);
                let master_w = ((f64::from(w)) * ratio).floor() as i32;
                let stack_w = w.saturating_sub(master_w).max(1);
                out.insert(
                    window_ids[0],
                    Rectangle::new(Point::from((x, y)), Size::from((master_w.max(1), h))),
                );
                let stack_ids = &window_ids[1..];
                let stack_count = stack_ids.len() as i32;
                for (index, window_id) in stack_ids.iter().enumerate() {
                    let i = index as i32;
                    let top = y + ((f64::from(i * h) / f64::from(stack_count)).round() as i32);
                    let bottom =
                        y + ((f64::from((i + 1) * h) / f64::from(stack_count)).round() as i32);
                    out.insert(
                        *window_id,
                        Rectangle::new(
                            Point::from((x.saturating_add(master_w), top)),
                            Size::from((stack_w, bottom.saturating_sub(top).max(1))),
                        ),
                    );
                }
            }
            WorkspaceMonitorLayoutType::Columns => {
                let n = window_ids.len() as i32;
                let cap = layout_state
                    .params
                    .max_columns
                    .map(|value| value.max(1) as i32)
                    .unwrap_or(n)
                    .max(1);
                if n <= cap {
                    for (index, window_id) in window_ids.iter().enumerate() {
                        let i = index as i32;
                        let left = x + ((i * w) / n);
                        let right = if i == n - 1 {
                            x.saturating_add(w)
                        } else {
                            x + (((i + 1) * w) / n)
                        };
                        out.insert(
                            *window_id,
                            Rectangle::new(
                                Point::from((left, y)),
                                Size::from((right.saturating_sub(left).max(1), h)),
                            ),
                        );
                    }
                    return out;
                }
                let num_cols = cap.max(1);
                for index in 0..(num_cols - 1) {
                    let left = x + ((index * w) / num_cols);
                    let right = x + (((index + 1) * w) / num_cols);
                    out.insert(
                        window_ids[index as usize],
                        Rectangle::new(
                            Point::from((left, y)),
                            Size::from((right.saturating_sub(left).max(1), h)),
                        ),
                    );
                }
                let stack_ids = &window_ids[(num_cols - 1) as usize..];
                let stack_count = stack_ids.len() as i32;
                let last_left = x + (((num_cols - 1) * w) / num_cols);
                let last_right = x.saturating_add(w);
                for (index, window_id) in stack_ids.iter().enumerate() {
                    let i = index as i32;
                    let top = y + ((f64::from(i * h) / f64::from(stack_count)).round() as i32);
                    let bottom =
                        y + ((f64::from((i + 1) * h) / f64::from(stack_count)).round() as i32);
                    out.insert(
                        *window_id,
                        Rectangle::new(
                            Point::from((last_left, top)),
                            Size::from((
                                last_right.saturating_sub(last_left).max(1),
                                bottom.saturating_sub(top).max(1),
                            )),
                        ),
                    );
                }
            }
            WorkspaceMonitorLayoutType::Grid => {
                let n = window_ids.len() as i32;
                let cols = (f64::from(n).sqrt().ceil() as i32).max(1);
                let rows = ((n + cols - 1) / cols).max(1);
                for (index, window_id) in window_ids.iter().enumerate() {
                    let i = index as i32;
                    let row = i / cols;
                    let col = i % cols;
                    let left = x + ((col * w) / cols);
                    let top = y + ((row * h) / rows);
                    let right = if col == cols - 1 {
                        x.saturating_add(w)
                    } else {
                        x + (((col + 1) * w) / cols)
                    };
                    let bottom = if row == rows - 1 {
                        y.saturating_add(h)
                    } else {
                        y + (((row + 1) * h) / rows)
                    };
                    out.insert(
                        *window_id,
                        Rectangle::new(
                            Point::from((left, top)),
                            Size::from((
                                right.saturating_sub(left).max(1),
                                bottom.saturating_sub(top).max(1),
                            )),
                        ),
                    );
                }
            }
        }
        out
    }

    pub(crate) fn workspace_set_pre_tile_geometry(
        &mut self,
        window_id: u32,
        bounds: WorkspaceRect,
    ) -> bool {
        self.workspace_state
            .pre_tile_geometry
            .retain(|entry| entry.window_id != window_id);
        self.workspace_state
            .pre_tile_geometry
            .push(crate::session::workspace_model::WorkspacePreTileGeometry { window_id, bounds });
        true
    }

    pub(crate) fn workspace_pre_tile_geometry(&self, window_id: u32) -> Option<WorkspaceRect> {
        self.workspace_state
            .pre_tile_geometry
            .iter()
            .find(|entry| entry.window_id == window_id)
            .map(|entry| entry.bounds.clone())
    }

    pub(crate) fn workspace_clear_pre_tile_geometry(&mut self, window_id: u32) -> bool {
        let before = self.workspace_state.pre_tile_geometry.len();
        self.workspace_state
            .pre_tile_geometry
            .retain(|entry| entry.window_id != window_id);
        before != self.workspace_state.pre_tile_geometry.len()
    }

    pub(crate) fn workspace_monitor_tile_for_window(
        &self,
        window_id: u32,
    ) -> Option<(String, String)> {
        for monitor in &self.workspace_state.monitor_tiles {
            for entry in &monitor.entries {
                if entry.window_id == window_id {
                    return Some((monitor.output_name.clone(), entry.zone.clone()));
                }
            }
        }
        None
    }

    pub(crate) fn workspace_set_monitor_tile(
        &mut self,
        output_name: &str,
        output_id: String,
        window_id: u32,
        zone: String,
        bounds: WorkspaceRect,
    ) -> bool {
        for monitor in &mut self.workspace_state.monitor_tiles {
            monitor.entries.retain(|entry| entry.window_id != window_id);
        }
        self.workspace_state
            .monitor_tiles
            .retain(|monitor| !monitor.entries.is_empty());
        if let Some(monitor) = self
            .workspace_state
            .monitor_tiles
            .iter_mut()
            .find(|monitor| monitor.output_name == output_name)
        {
            monitor.entries.push(WorkspaceMonitorTileEntry {
                window_id,
                zone,
                bounds,
            });
            monitor.entries.sort_by_key(|entry| entry.window_id);
            return true;
        }
        self.workspace_state
            .monitor_tiles
            .push(WorkspaceMonitorTileState {
                output_id,
                output_name: output_name.to_string(),
                entries: vec![WorkspaceMonitorTileEntry {
                    window_id,
                    zone,
                    bounds,
                }],
            });
        true
    }

    pub(crate) fn workspace_remove_monitor_tile(&mut self, window_id: u32) -> bool {
        let mut changed = false;
        for monitor in &mut self.workspace_state.monitor_tiles {
            let before = monitor.entries.len();
            monitor.entries.retain(|entry| entry.window_id != window_id);
            changed |= before != monitor.entries.len();
        }
        self.workspace_state
            .monitor_tiles
            .retain(|monitor| !monitor.entries.is_empty());
        changed
    }

    pub(crate) fn workspace_set_auto_layout_tiles_for_output(
        &mut self,
        output_name: &str,
        output_id: String,
        frame_rects: &HashMap<u32, Rectangle<i32, Logical>>,
    ) -> bool {
        let mut entries: Vec<WorkspaceMonitorTileEntry> = frame_rects
            .iter()
            .map(|(window_id, rect)| WorkspaceMonitorTileEntry {
                window_id: *window_id,
                zone: "auto-fill".to_string(),
                bounds: WorkspaceRect {
                    x: rect.loc.x,
                    y: rect.loc.y,
                    width: rect.size.w.max(1),
                    height: rect.size.h.max(1),
                },
            })
            .collect();
        entries.sort_by_key(|entry| entry.window_id);
        self.workspace_state
            .monitor_tiles
            .retain(|monitor| monitor.output_name != output_name);
        if !entries.is_empty() {
            self.workspace_state
                .monitor_tiles
                .push(WorkspaceMonitorTileState {
                    output_id,
                    output_name: output_name.to_string(),
                    entries,
                });
        }
        true
    }

    pub(crate) fn workspace_auto_layout_output_names(&self) -> Vec<String> {
        self.workspace_state
            .monitor_layouts
            .iter()
            .filter(|entry| entry.layout != WorkspaceMonitorLayoutType::ManualSnap)
            .map(|entry| entry.output_name.clone())
            .collect()
    }

    pub(crate) fn workspace_merge_group_into_group(
        &mut self,
        source_group_id: &str,
        target_group_id: &str,
    ) {
        if source_group_id == target_group_id {
            return;
        }
        let Some(source_index) = self
            .workspace_state
            .groups
            .iter()
            .position(|group| group.id == source_group_id)
        else {
            return;
        };
        let Some(target_index) = self
            .workspace_state
            .groups
            .iter()
            .position(|group| group.id == target_group_id)
        else {
            return;
        };
        let source = self.workspace_state.groups[source_index].clone();
        let source_visible = self
            .workspace_state
            .visible_window_id_for_group(source_group_id)
            .or_else(|| source.window_ids.first().copied());
        for window_id in &source.window_ids {
            if !self.workspace_state.groups[target_index]
                .window_ids
                .contains(window_id)
            {
                self.workspace_state.groups[target_index]
                    .window_ids
                    .push(*window_id);
            }
        }
        if let Some(source_visible) = source_visible {
            self.workspace_state
                .active_tab_by_group_id
                .insert(target_group_id.to_string(), source_visible);
        }
        self.workspace_state.groups.remove(source_index);
        self.workspace_state
            .active_tab_by_group_id
            .remove(source_group_id);
        self.workspace_state
            .split_by_group_id
            .remove(source_group_id);
        self.workspace_state
            .split_by_group_id
            .remove(target_group_id);
    }

    pub(crate) fn workspace_sync_from_live_window_ids(&mut self, live_window_ids: &[u32]) -> bool {
        let next = reconcile_workspace_state(&self.workspace_state, live_window_ids);
        if next == self.workspace_state {
            return false;
        }
        self.workspace_state = next;
        true
    }

    pub(crate) fn workspace_state_for_shell<F>(&self, output_name_for_id: F) -> WorkspaceState
    where
        F: Fn(&str) -> Option<String>,
    {
        let mut state = self.workspace_state.clone();
        state.taskbar_pins = self.taskbar_pins.clone();
        for monitor in &mut state.monitor_tiles {
            if monitor.output_id.is_empty() {
                continue;
            }
            if let Some(output_name) = output_name_for_id(&monitor.output_id) {
                monitor.output_name = output_name;
            }
        }
        for layout in &mut state.monitor_layouts {
            if layout.output_id.is_empty() {
                continue;
            }
            if let Some(output_name) = output_name_for_id(&layout.output_id) {
                layout.output_name = output_name;
            }
        }
        for monitor in &mut state.taskbar_pins {
            if monitor.output_id.is_empty() {
                continue;
            }
            if let Some(output_name) = output_name_for_id(&monitor.output_id) {
                monitor.output_name = output_name;
            }
        }
        state
    }

    pub(crate) fn workspace_state_binary_message(
        &self,
        state: &WorkspaceState,
    ) -> Option<shell_wire::DecodedCompositorToShellMessage> {
        let state = crate::cef::shell_snapshot::encode_workspace_state_binary_payload(state)?;
        Some(
            shell_wire::DecodedCompositorToShellMessage::WorkspaceStateBinary {
                revision: self.shell_workspace_revision,
                state,
            },
        )
    }

    pub(crate) fn workspace_state_message(
        &self,
        state: &WorkspaceState,
    ) -> Option<shell_wire::DecodedCompositorToShellMessage> {
        let Ok(state_json) = state.to_json() else {
            return None;
        };
        Some(
            shell_wire::DecodedCompositorToShellMessage::WorkspaceState {
                revision: self.shell_workspace_revision,
                state_json,
            },
        )
    }

    pub(crate) fn set_scratchpad_settings(
        &mut self,
        settings: crate::session::settings_config::ScratchpadSettingsFile,
    ) {
        self.scratchpad_settings = settings;
    }

    pub(crate) fn scratchpad_forget_window(&mut self, window_id: u32) {
        self.scratchpad_windows.remove(&window_id);
        self.scratchpad_last_window_by_id
            .retain(|_, remembered| *remembered != window_id);
    }

    fn taskbar_pin_monitor_matches(
        monitor: &WorkspaceTaskbarPinMonitor,
        output_name: &str,
        output_id: &str,
    ) -> bool {
        if !output_id.is_empty() && !monitor.output_id.is_empty() {
            return monitor.output_id == output_id;
        }
        monitor.output_name == output_name
    }

    pub(crate) fn taskbar_pin_monitor_index(
        &self,
        output_name: &str,
        output_id: &str,
    ) -> Option<usize> {
        self.taskbar_pins
            .iter()
            .position(|monitor| Self::taskbar_pin_monitor_matches(monitor, output_name, output_id))
    }

    pub(crate) fn write_taskbar_pins_state(&self) {
        if let Err(error) =
            crate::session::taskbar_pins::write_taskbar_pins(self.taskbar_pins.clone())
        {
            tracing::warn!(%error, "write taskbar pins failed");
        }
    }

    pub(crate) fn apply_taskbar_pin_add_json(&mut self, json: &str) -> bool {
        #[derive(serde::Deserialize)]
        struct Params {
            #[serde(rename = "outputName")]
            output_name: String,
            #[serde(default, rename = "outputId")]
            output_id: Option<String>,
            pin: WorkspaceTaskbarPin,
        }
        let Ok(params) = serde_json::from_str::<Params>(json) else {
            return false;
        };
        let output_name = params.output_name.trim();
        if output_name.is_empty() {
            return false;
        }
        let output_id = params.output_id.unwrap_or_default();
        let output_id = output_id.trim();
        let mut monitors = self.taskbar_pins.clone();
        let index = monitors
            .iter()
            .position(|monitor| Self::taskbar_pin_monitor_matches(monitor, output_name, output_id))
            .unwrap_or_else(|| {
                monitors.push(WorkspaceTaskbarPinMonitor {
                    output_id: output_id.to_string(),
                    output_name: output_name.to_string(),
                    pins: Vec::new(),
                });
                monitors.len() - 1
            });
        let pin_id = crate::session::taskbar_pins::taskbar_pin_id(&params.pin).to_string();
        let monitor = &mut monitors[index];
        monitor.output_name = output_name.to_string();
        if !output_id.is_empty() {
            monitor.output_id = output_id.to_string();
        }
        if let Some(existing) = monitor
            .pins
            .iter_mut()
            .find(|pin| crate::session::taskbar_pins::taskbar_pin_id(pin) == pin_id)
        {
            *existing = params.pin;
        } else {
            monitor.pins.push(params.pin);
        }
        let next = crate::session::taskbar_pins::sanitize_taskbar_pins(monitors);
        if next == self.taskbar_pins {
            return false;
        }
        self.taskbar_pins = next;
        self.write_taskbar_pins_state();
        true
    }

    pub(crate) fn apply_taskbar_pin_remove_json(&mut self, json: &str) -> bool {
        #[derive(serde::Deserialize)]
        struct Params {
            #[serde(rename = "outputName")]
            output_name: String,
            #[serde(default, rename = "outputId")]
            output_id: Option<String>,
            #[serde(rename = "pinId")]
            pin_id: String,
        }
        let Ok(params) = serde_json::from_str::<Params>(json) else {
            return false;
        };
        let output_name = params.output_name.trim();
        if output_name.is_empty() {
            return false;
        }
        let output_id = params.output_id.unwrap_or_default();
        let output_id = output_id.trim();
        let pin_id = params.pin_id.trim();
        if pin_id.is_empty() {
            return false;
        }
        let mut next = self.taskbar_pins.clone();
        if let Some(index) = next
            .iter()
            .position(|monitor| Self::taskbar_pin_monitor_matches(monitor, output_name, output_id))
        {
            next[index]
                .pins
                .retain(|pin| crate::session::taskbar_pins::taskbar_pin_id(pin) != pin_id);
            if next[index].pins.is_empty() {
                next.remove(index);
            }
        }
        let next = crate::session::taskbar_pins::sanitize_taskbar_pins(next);
        if next == self.taskbar_pins {
            return false;
        }
        self.taskbar_pins = next;
        self.write_taskbar_pins_state();
        true
    }

    pub(crate) fn taskbar_pin_launch_command(
        &self,
        json: &str,
    ) -> Option<(String, String, String)> {
        #[derive(serde::Deserialize)]
        struct Params {
            #[serde(rename = "outputName")]
            output_name: String,
            #[serde(default, rename = "outputId")]
            output_id: Option<String>,
            #[serde(rename = "pinId")]
            pin_id: String,
        }
        let Ok(params) = serde_json::from_str::<Params>(json) else {
            return None;
        };
        let output_name = params.output_name.trim();
        let output_id = params.output_id.unwrap_or_default();
        let output_id = output_id.trim();
        let pin_id = params.pin_id.trim();
        let index = self.taskbar_pin_monitor_index(output_name, output_id)?;
        let pin = self.taskbar_pins[index]
            .pins
            .iter()
            .find(|pin| crate::session::taskbar_pins::taskbar_pin_id(pin) == pin_id)
            .cloned()?;
        let WorkspaceTaskbarPin::App { command, .. } = pin else {
            return None;
        };
        Some((command, output_name.to_string(), output_id.to_string()))
    }
}
