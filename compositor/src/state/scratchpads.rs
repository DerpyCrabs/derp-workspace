use super::*;

impl CompositorState {
    pub(super) fn scratchpad_rule_value(
        &self,
        window_id: u32,
        info: &WindowInfo,
        field: &crate::session::settings_config::ScratchpadRuleFieldFile,
    ) -> String {
        match field {
            crate::session::settings_config::ScratchpadRuleFieldFile::AppId => info.app_id.clone(),
            crate::session::settings_config::ScratchpadRuleFieldFile::Title => info.title.clone(),
            crate::session::settings_config::ScratchpadRuleFieldFile::Kind => {
                if self.windows.window_registry.is_shell_hosted(window_id) {
                    info.app_id
                        .strip_prefix("derp.")
                        .unwrap_or(info.app_id.as_str())
                        .to_string()
                } else {
                    "native".into()
                }
            }
            crate::session::settings_config::ScratchpadRuleFieldFile::X11Class => self
                .find_x11_window_by_window_id(window_id)
                .map(|window| window.class())
                .unwrap_or_default(),
            crate::session::settings_config::ScratchpadRuleFieldFile::X11Instance => self
                .find_x11_window_by_window_id(window_id)
                .map(|window| window.instance())
                .unwrap_or_default(),
        }
    }

    fn scratchpad_rule_matches(
        haystack: &str,
        rule: &crate::session::settings_config::ScratchpadRuleFile,
    ) -> bool {
        let value = rule.value.trim();
        if value.is_empty() {
            return false;
        }
        match rule.op {
            crate::session::settings_config::ScratchpadRuleOpFile::Equals => haystack == value,
            crate::session::settings_config::ScratchpadRuleOpFile::Contains => {
                haystack.contains(value)
            }
            crate::session::settings_config::ScratchpadRuleOpFile::StartsWith => {
                haystack.starts_with(value)
            }
        }
    }

    fn scratchpad_match_for_window(&self, window_id: u32, info: &WindowInfo) -> Option<String> {
        if self.window_info_is_solid_shell_host(info) || !shell_window_row_should_show(info) {
            return None;
        }
        for scratchpad in &self.workspace_layout.scratchpad_settings.items {
            if scratchpad.rules.iter().any(|rule| {
                let value = self.scratchpad_rule_value(window_id, info, &rule.field);
                Self::scratchpad_rule_matches(&value, rule)
            }) {
                return Some(scratchpad.id.clone());
            }
        }
        None
    }

    fn scratchpad_config_by_id(
        &self,
        scratchpad_id: &str,
    ) -> Option<&crate::session::settings_config::ScratchpadFile> {
        self.workspace_layout.scratchpad_settings
            .items
            .iter()
            .find(|item| item.id == scratchpad_id)
    }

    fn scratchpad_output(
        &self,
        cfg: &crate::session::settings_config::ScratchpadFile,
    ) -> Option<Output> {
        match cfg.placement.monitor.as_str() {
            "primary" => self.shell_effective_primary_output(),
            "pointer" => self.input_routing.seat
                .get_pointer()
                .and_then(|pointer| self.output_containing_global_point(pointer.current_location()))
                .or_else(|| self.shell_effective_primary_output())
                .or_else(|| self.leftmost_output()),
            "focused" | "" => self.new_toplevel_placement_output(None),
            name => self.output_topology.space
                .outputs()
                .find(|output| output.name() == name)
                .cloned()
                .or_else(|| self.new_toplevel_placement_output(None)),
        }
    }

    fn scratchpad_place_window(&mut self, window_id: u32) {
        let Some(sp) = self.workspace_layout.scratchpad_windows.get(&window_id).cloned() else {
            return;
        };
        let Some(cfg) = self.scratchpad_config_by_id(&sp.scratchpad_id).cloned() else {
            return;
        };
        let Some(output) = self.scratchpad_output(&cfg) else {
            return;
        };
        let Some(work) = self.shell_maximize_work_area_global_for_output(&output) else {
            return;
        };
        let width = (work.size.w as i64)
            .saturating_mul(cfg.placement.width_percent as i64)
            .saturating_div(100)
            .clamp(240, work.size.w.max(1) as i64) as i32;
        let height = (work.size.h as i64)
            .saturating_mul(cfg.placement.height_percent as i64)
            .saturating_div(100)
            .clamp(160, work.size.h.max(1) as i64) as i32;
        let x = work.loc.x + (work.size.w - width) / 2;
        let y = work.loc.y + (work.size.h - height) / 2;
        let (ox, oy) = self.output_topology.shell_canvas_logical_origin;
        self.shell_set_window_geometry(
            window_id,
            x.saturating_sub(ox),
            y.saturating_sub(oy),
            width,
            height,
            0,
        );
    }

    fn scratchpad_hide_window(&mut self, window_id: u32) {
        if self.windows.shell_pending_native_focus_window_id == Some(window_id) {
            self.windows.shell_pending_native_focus_window_id = None;
        }
        if self.windows.window_registry.is_shell_hosted(window_id) {
            let _ = self.shell_backed_minimize_if_any(window_id);
        } else {
            self.shell_minimize_window(window_id);
        }
    }

    fn scratchpad_show_window(&mut self, window_id: u32) {
        self.scratchpad_place_window(window_id);
        if self.windows.window_registry
            .window_info(window_id)
            .is_some_and(|info| info.minimized)
        {
            self.shell_restore_minimized_window(window_id);
        } else {
            self.shell_raise_and_focus_window(window_id);
        }
        if let Some(sp) = self.workspace_layout.scratchpad_windows.get(&window_id) {
            self.workspace_layout.scratchpad_last_window_by_id
                .insert(sp.scratchpad_id.clone(), window_id);
        }
        self.shell_reply_window_list();
    }

    pub(crate) fn scratchpad_consider_window(&mut self, window_id: u32) {
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            self.scratchpad_forget_window(window_id);
            return;
        };
        if self.window_id_is_deferred_initial_map(window_id) {
            return;
        }
        let matched = self.scratchpad_match_for_window(window_id, &info);
        match matched {
            Some(scratchpad_id) => {
                let was = self.workspace_layout.scratchpad_windows
                    .get(&window_id)
                    .map(|state| state.scratchpad_id.as_str());
                let new_assignment = was != Some(scratchpad_id.as_str());
                self.workspace_layout.scratchpad_windows.insert(
                    window_id,
                    ScratchpadWindowState {
                        scratchpad_id: scratchpad_id.clone(),
                    },
                );
                if self.workspace_sync_from_registry() {
                    self.workspace_send_state();
                }
                if new_assignment {
                    let default_visible = self
                        .scratchpad_config_by_id(&scratchpad_id)
                        .map(|cfg| cfg.default_visible)
                        .unwrap_or(false);
                    if default_visible {
                        self.scratchpad_show_window(window_id);
                    } else {
                        self.scratchpad_place_window(window_id);
                        self.scratchpad_hide_window(window_id);
                        self.shell_reply_window_list();
                    }
                }
            }
            None => {
                if self.workspace_layout.scratchpad_windows.remove(&window_id).is_some() {
                    self.shell_reply_window_list();
                }
            }
        }
    }

    pub(crate) fn scratchpad_forget_window(&mut self, window_id: u32) {
        self.workspace_layout.scratchpad_forget_window(window_id);
    }

    pub(crate) fn apply_scratchpad_settings(
        &mut self,
        settings: crate::session::settings_config::ScratchpadSettingsFile,
    ) -> Result<(), String> {
        let settings = crate::session::settings_config::sanitize_scratchpad_settings(settings);
        crate::session::settings_config::write_scratchpad_settings(settings.clone())?;
        self.workspace_layout.set_scratchpad_settings(settings);
        let window_ids: Vec<u32> = self.windows.window_registry
            .all_infos()
            .into_iter()
            .map(|info| info.window_id)
            .collect();
        for window_id in window_ids {
            self.scratchpad_consider_window(window_id);
        }
        self.shell_reply_window_list();
        Ok(())
    }

    pub(crate) fn apply_hotkey_settings(
        &mut self,
        settings: crate::session::settings_config::HotkeySettingsFile,
    ) -> Result<(), String> {
        crate::session::settings_config::write_hotkey_settings(settings)?;
        self.input_routing.hotkey_settings = crate::session::settings_config::read_hotkey_settings();
        Ok(())
    }

    pub(crate) fn toggle_scratchpad(&mut self, scratchpad_id: &str) {
        if self.scratchpad_config_by_id(scratchpad_id).is_none() {
            return;
        }
        let mut windows: Vec<u32> = self.workspace_layout.scratchpad_windows
            .iter()
            .filter_map(|(window_id, state)| {
                (state.scratchpad_id == scratchpad_id)
                    .then_some(*window_id)
                    .filter(|window_id| self.windows.window_registry.window_info(*window_id).is_some())
            })
            .collect();
        windows.sort_by_key(|window_id| self.shell_window_stack_z(*window_id));
        if let Some(visible) = windows.iter().rev().copied().find(|window_id| {
            self.windows.window_registry
                .window_info(*window_id)
                .is_some_and(|info| !info.minimized)
        }) {
            self.scratchpad_hide_window(visible);
            self.shell_reply_window_list();
            return;
        }
        let preferred = self.workspace_layout.scratchpad_last_window_by_id
            .get(scratchpad_id)
            .copied()
            .filter(|window_id| windows.contains(window_id))
            .or_else(|| windows.first().copied());
        if let Some(window_id) = preferred {
            self.scratchpad_show_window(window_id);
        }
    }

    fn super_hotkey_key_token_matches(raw_sym: u32, token: &str) -> bool {
        let t = token.trim().to_ascii_lowercase();
        match t.as_str() {
            "`" | "grave" | "backquote" => raw_sym == keysyms::KEY_grave,
            "space" => raw_sym == keysyms::KEY_space,
            "return" | "enter" => {
                raw_sym == keysyms::KEY_Return || raw_sym == keysyms::KEY_KP_Enter
            }
            "tab" => raw_sym == keysyms::KEY_Tab,
            "left" => raw_sym == keysyms::KEY_Left,
            "right" => raw_sym == keysyms::KEY_Right,
            "up" => raw_sym == keysyms::KEY_Up,
            "down" => raw_sym == keysyms::KEY_Down,
            "," | "comma" => raw_sym == keysyms::KEY_comma,
            "." | "period" => raw_sym == keysyms::KEY_period,
            "/" | "slash" => raw_sym == keysyms::KEY_slash,
            ";" | "semicolon" => raw_sym == keysyms::KEY_semicolon,
            "'" | "apostrophe" => raw_sym == keysyms::KEY_apostrophe,
            "[" | "bracketleft" => raw_sym == keysyms::KEY_bracketleft,
            "]" | "bracketright" => raw_sym == keysyms::KEY_bracketright,
            _ if t.len() == 1 => {
                let ch = t.as_bytes()[0];
                if ch.is_ascii_lowercase() {
                    raw_sym == keysyms::KEY_a + u32::from(ch - b'a')
                        || raw_sym == keysyms::KEY_A + u32::from(ch - b'a')
                } else if ch.is_ascii_digit() {
                    raw_sym == keysyms::KEY_0 + u32::from(ch - b'0')
                } else {
                    false
                }
            }
            _ => false,
        }
    }

    fn super_hotkey_chord_matches(
        raw_sym: u32,
        ctrl: bool,
        alt: bool,
        shift: bool,
        chord: &str,
    ) -> bool {
        let Some(chord) = crate::session::settings_config::normalize_hotkey_chord(chord) else {
            return false;
        };
        let parts: Vec<String> = chord
            .split('+')
            .map(|part| part.trim().to_ascii_lowercase())
            .filter(|part| !part.is_empty())
            .collect();
        if parts.is_empty() || !parts.iter().any(|part| part == "super") {
            return false;
        }
        let wants_ctrl = parts.iter().any(|part| part == "ctrl");
        let wants_alt = parts.iter().any(|part| part == "alt");
        let wants_shift = parts.iter().any(|part| part == "shift");
        if wants_ctrl != ctrl || wants_alt != alt || wants_shift != shift {
            return false;
        }
        let Some(key) = parts
            .iter()
            .find(|part| !matches!(part.as_str(), "super" | "ctrl" | "alt" | "shift"))
        else {
            return false;
        };
        Self::super_hotkey_key_token_matches(raw_sym, key)
    }

    pub(crate) fn super_hotkey_action_for_chord(
        &self,
        raw_sym: u32,
        ctrl: bool,
        alt: bool,
        shift: bool,
    ) -> Option<SuperHotkeyAction> {
        use crate::session::settings_config::HotkeyActionFile;
        for binding in &self.input_routing.hotkey_settings.bindings {
            if !binding.enabled {
                continue;
            }
            if !Self::super_hotkey_chord_matches(raw_sym, ctrl, alt, shift, &binding.chord) {
                continue;
            }
            return match binding.action {
                HotkeyActionFile::Builtin => {
                    Some(SuperHotkeyAction::Builtin(binding.builtin.clone()))
                }
                HotkeyActionFile::Launch => Some(SuperHotkeyAction::Launch {
                    command: binding.command.clone(),
                    desktop_id: binding.desktop_id.clone(),
                    app_name: binding.app_name.clone(),
                }),
                HotkeyActionFile::Scratchpad => {
                    Some(SuperHotkeyAction::Scratchpad(binding.scratchpad_id.clone()))
                }
            };
        }
        for scratchpad in &self.workspace_layout.scratchpad_settings.items {
            if scratchpad.hotkey.trim().is_empty() {
                continue;
            }
            if Self::super_hotkey_chord_matches(raw_sym, ctrl, alt, shift, &scratchpad.hotkey) {
                return Some(SuperHotkeyAction::Scratchpad(scratchpad.id.clone()));
            }
        }
        None
    }
}
