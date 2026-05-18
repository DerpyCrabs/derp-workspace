use super::*;

impl CompositorState {
    pub(super) fn shell_window_stack_seed_known_windows(&mut self) {
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
        self.clear_shell_osk_text_input_if_no_shell_focus();
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

    pub(super) fn logical_focus_target_is_valid(&self, window_id: u32) -> bool {
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

    pub(super) fn shell_window_switcher_restore_window_id(&self) -> Option<u32> {
        self.input_routing.shell_window_switcher_restore_window_id()
    }

    pub(crate) fn shell_window_switcher_open(&self) -> bool {
        self.input_routing.shell_window_switcher_open()
    }

    pub(super) fn shell_window_switcher_candidates(&self) -> Vec<u32> {
        self.windows.shell_window_switcher_candidates(
            &self.output_topology.space,
            self.shell_osr.shell_ipc_peer_pid,
        )
    }

    pub(super) fn shell_window_switcher_effective_selected_window_id(&self) -> Option<u32> {
        self.windows
            .shell_window_switcher_effective_selected_window_id(
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
        let pivot_window_id = self
            .windows
            .shell_window_switcher_selected_window_id
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

    pub(super) fn topmost_native_window_from_stack(&self) -> Option<u32> {
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

    pub(crate) fn stack_z_by_window_id(&self) -> HashMap<u32, u32> {
        self.windows.stack_z_by_window_id()
    }

    fn space_elements_top_to_bottom_from<'a, I>(&self, elements: I) -> Vec<DerpSpaceElem>
    where
        I: Iterator<Item = &'a DerpSpaceElem>,
    {
        let stack_z = self.stack_z_by_window_id();
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
        self.space_elements_top_to_bottom_from(
            self.output_topology.space.elements_for_output(output),
        )
    }
}
