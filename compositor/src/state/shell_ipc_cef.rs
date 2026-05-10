use super::*;

impl CompositorState {
    pub(crate) fn shell_cef_active(&self) -> bool {
        self.shell_osr.shell_cef_active()
    }

    pub(crate) fn shell_send_to_cef(&mut self, msg: shell_wire::DecodedCompositorToShellMessage) {
        if !self.shell_osr.prepare_shell_send_to_cef(&msg) {
            return;
        }
        let workspace_changed = self.workspace_sync_from_registry();
        if workspace_changed {
            self.next_shell_workspace_revision();
        }
        let authoritative_snapshot =
            self.shell_authoritative_snapshot_messages(&msg, workspace_changed);
        let workspace_state_message = if workspace_changed {
            self.workspace_state_message()
        } else {
            None
        };
        let snapshot_epoch = authoritative_snapshot
            .as_ref()
            .map(|_| self.next_shell_snapshot_epoch());
        let live_epoch = snapshot_epoch.unwrap_or(self.shell_osr.shell_snapshot_epoch);
        if matches!(
            msg,
            shell_wire::DecodedCompositorToShellMessage::OutputLayout { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowMapped { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowGeometry { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowMetadata { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowState { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowList { .. }
                | shell_wire::DecodedCompositorToShellMessage::WindowOrder { .. }
                | shell_wire::DecodedCompositorToShellMessage::FocusChanged { .. }
                | shell_wire::DecodedCompositorToShellMessage::InteractionState { .. }
                | shell_wire::DecodedCompositorToShellMessage::WorkspaceState { .. }
                | shell_wire::DecodedCompositorToShellMessage::WorkspaceStateBinary { .. }
        ) {
            self.validate_state_after("shell_send_to_cef");
        }
        self.shell_osr.shell_send_to_cef_link(
            msg,
            authoritative_snapshot,
            snapshot_epoch,
            live_epoch,
            workspace_state_message,
        );
    }

    fn shell_authoritative_snapshot_messages(
        &mut self,
        msg: &shell_wire::DecodedCompositorToShellMessage,
        _workspace_changed: bool,
    ) -> Option<Vec<shell_wire::DecodedCompositorToShellMessage>> {
        self.shell_clear_stale_primary_output();
        ShellOsrState::shell_authoritative_snapshot_messages(
            msg,
            self.shell_output_layout_snapshot_message(),
            self.shell_window_list_snapshot_message(),
            self.shell_window_order_snapshot_message(),
            self.shell_focus_snapshot_message(),
            self.workspace_state_binary_message(),
            self.shell_hosted_app_state_message(),
            shell_wire::DecodedCompositorToShellMessage::CommandPaletteState {
                revision: self.session_services.command_palette_revision(),
                state_json: self.command_palette_state_value().to_string(),
            },
            self.shell_interaction_state_message(),
            self.shell_native_drag_preview_message(),
            shell_wire::DecodedCompositorToShellMessage::KeyboardLayout {
                label: self.input_routing.shell_keyboard_layout_label.clone(),
            },
            self.shell_tray_hints_message(),
            shell_wire::DecodedCompositorToShellMessage::TraySni {
                items: self.tray_notifications.sni_tray_items(),
            },
        )
    }

    pub(crate) fn shell_nudge_cef_repaint(&mut self) {
        self.shell_osr.shell_nudge_cef_repaint();
    }

    pub(crate) fn shell_force_next_dmabuf_full_damage(&mut self) {
        self.shell_osr.shell_force_next_dmabuf_full_damage();
    }

    pub(crate) fn programs_menu_toggle_from_super(&mut self, serial: Serial) {
        let _ = serial;
        self.programs_menu_opened_from_shell(0);
        self.shell_send_keybind_ex("toggle_programs_menu", None);
    }

    pub(crate) fn programs_menu_opened_from_shell(&mut self, restore_window_id: u32) {
        let restore_from_shell = (restore_window_id != 0
            && self.logical_focus_target_is_valid(restore_window_id))
        .then_some(restore_window_id);
        let restore_window_id = restore_from_shell.or_else(|| {
            self.logical_focused_window_id()
                .or_else(|| self.keyboard_focused_window_id())
                .filter(|window_id| self.logical_focus_target_is_valid(*window_id))
        });
        self.shell_keyboard_capture_programs_menu(restore_window_id);
        self.shell_send_to_cef(self.shell_focus_message());
    }

    pub(crate) fn programs_menu_closed_from_shell(&mut self) {
        let restore_window_id = self.input_routing.programs_menu_close_restore_window();
        if let Some(window_id) = restore_window_id {
            if self.logical_focus_target_is_valid(window_id) {
                self.focus_logical_window(window_id);
                return;
            }
        }
        self.shell_send_to_cef(self.shell_focus_message());
    }

    pub(crate) fn programs_menu_prepare_super_press(&mut self) {
        if self.input_routing.pointer_pressed_buttons.is_empty() {
            self.shell_resize_end_active();
            self.shell_move_end_active();
            self.shell_ui_pointer_grab_end();
            self.input_routing.shell_backed_move_candidate = None;
        }
        self.input_routing.programs_menu_prepare_super_press(
            !self.input_routing.pointer_pressed_buttons.is_empty(),
            self.shell_move_is_active(),
            self.shell_resize_is_active(),
            self.input_routing.shell_backed_move_candidate.is_some(),
        );
    }

    #[cfg(test)]
    pub(crate) fn programs_menu_super_press_chord(
        pointer_button_pressed: bool,
        shell_move_active: bool,
        shell_resize_active: bool,
        shell_backed_move_candidate: bool,
    ) -> bool {
        InputRoutingState::programs_menu_super_press_chord(
            pointer_button_pressed,
            shell_move_active,
            shell_resize_active,
            shell_backed_move_candidate,
        )
    }

    pub(crate) fn shell_send_keybind(&mut self, action: &str) {
        self.shell_send_keybind_ex(action, None);
    }

    pub(crate) fn shell_send_keybind_ex(&mut self, action: &str, target_window_id: Option<u32>) {
        self.shell_emit_chrome_event(ChromeEvent::Keybind {
            action: action.to_string(),
            target_window_id,
            output_name: self
                .new_toplevel_placement_output(None)
                .map(|output| output.name().to_string()),
        });
        if action != "toggle_programs_menu" {
            self.shell_nudge_cef_repaint();
        }
    }
}

impl CompositorState {
    pub(crate) fn accept_shell_dmabuf_from_cef(
        &mut self,
        width: u32,
        height: u32,
        drm_format: u32,
        modifier: u64,
        flags: u32,
        generation: u32,
        planes: &[shell_wire::FrameDmabufPlane],
        mut fds: Vec<OwnedFd>,
        dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
    ) {
        crate::cef::begin_frame_diag::note_shell_dmabuf_rx(width, height);
        if width == 0 || height == 0 || planes.is_empty() || planes.len() != fds.len() {
            fds.clear();
            return;
        }
        if self.shell_osr.shell_has_frame && generation <= self.shell_osr.shell_dmabuf_generation {
            fds.clear();
            return;
        }
        match self.apply_shell_frame_dmabuf(
            width,
            height,
            drm_format,
            modifier,
            flags,
            planes,
            &mut fds,
            dirty_buffer,
        ) {
            Ok(()) => {
                self.shell_osr.shell_dmabuf_generation = generation;
                shell_ipc::log_first_shell_dmabuf(
                    width,
                    height,
                    drm_format,
                    modifier,
                    planes.len(),
                );
            }
            Err(e) => {
                tracing::warn!(target: "derp_hotplug_shell", ?e, "shell dma-buf frame rejected")
            }
        }
    }

    pub(crate) fn accept_shell_software_frame_from_cef(
        &mut self,
        width: u32,
        height: u32,
        generation: u32,
        pixels: Vec<u8>,
        dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
    ) {
        if width == 0 || height == 0 || pixels.is_empty() {
            return;
        }
        if self.shell_osr.shell_has_frame && generation <= self.shell_osr.shell_software_generation
        {
            return;
        }
        match self.apply_shell_frame_software(width, height, pixels, dirty_buffer) {
            Ok(()) => {
                self.shell_osr.shell_software_generation = generation;
            }
            Err(e) => {
                tracing::warn!(target: "derp_hotplug_shell", ?e, "shell software frame rejected")
            }
        }
    }
}

impl CompositorState {
    pub(crate) fn shell_pointer_ipc_for_cef(&self, pos: Point<f64, Logical>) -> Option<(i32, i32)> {
        InputRoutingState::shell_pointer_ipc_for_cef(
            pos,
            self.output_topology.shell_canvas_logical_origin,
            self.output_topology.shell_canvas_logical_size,
        )
    }

    pub fn apply_shell_frame_dmabuf(
        &mut self,
        width: u32,
        height: u32,
        drm_format: u32,
        modifier: u64,
        flags: u32,
        planes: &[shell_wire::FrameDmabufPlane],
        fds: &mut Vec<OwnedFd>,
        dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
    ) -> Result<(), &'static str> {
        let workspace_ready = self.workspace_logical_bounds().is_some();
        let shell_output_logical_size = self.shell_output_logical_size();
        let applied = self.shell_osr.apply_shell_frame_dmabuf(
            width,
            height,
            drm_format,
            modifier,
            flags,
            planes,
            fds,
            dirty_buffer,
            workspace_ready,
            shell_output_logical_size,
        )?;
        let mut handoff_shell_move_proxy = false;
        let proxy_release_state = self
            .input_routing
            .shell_move_proxy
            .as_ref()
            .and_then(|proxy| proxy.release_state.map(|state| (proxy.window_id, state)));
        let released_move_proxy = match proxy_release_state {
            Some((_, ShellMoveProxyReleaseState::AwaitShellStateCommit(commit)))
                if commit != applied.commit =>
            {
                if let Some(proxy) = self.input_routing.shell_move_proxy.as_mut() {
                    proxy.release_state =
                        Some(ShellMoveProxyReleaseState::AwaitVisibleShellCommit {
                            commit: applied.commit,
                            ui_generation: self.shell_osr.shell_ui_windows_generation,
                        });
                }
                handoff_shell_move_proxy = true;
                false
            }
            Some((
                window_id,
                ShellMoveProxyReleaseState::AwaitVisibleShellCommit { commit, .. },
            )) if commit != applied.commit
                && self.shell_move_proxy_release_ready_now(window_id) =>
            {
                true
            }
            _ => false,
        };
        if released_move_proxy {
            self.input_routing.shell_move_proxy = None;
        }

        if handoff_shell_move_proxy || released_move_proxy {
            self.shell_send_interaction_state();
        }
        self.shell_move_proxy_try_arm_capture();
        self.shell_move_try_activate_deferred();
        self.shell_move_flush_pending_deltas();
        Ok(())
    }

    pub fn apply_shell_frame_software(
        &mut self,
        width: u32,
        height: u32,
        pixels: Vec<u8>,
        dirty_buffer: Option<Vec<(i32, i32, i32, i32)>>,
    ) -> Result<(), &'static str> {
        let workspace_ready = self.workspace_logical_bounds().is_some();
        self.shell_osr.apply_shell_frame_software(
            width,
            height,
            pixels,
            dirty_buffer,
            workspace_ready,
        )?;
        self.shell_move_proxy_try_arm_capture();
        self.shell_move_try_activate_deferred();
        self.shell_move_flush_pending_deltas();
        Ok(())
    }

    pub fn clear_shell_frame(&mut self) {
        self.shell_osr.clear_shell_frame();
        self.input_routing.shell_move_proxy = None;
        self.input_routing.shell_native_drag_preview = None;
        self.input_routing.shell_last_pointer_ipc_px = None;
        self.input_routing.shell_last_pointer_ipc_global_logical = None;
        self.input_routing.shell_last_pointer_ipc_modifiers = None;
        self.input_routing.touch_routes_to_cef = false;
    }

    /// Current keyboard → `cef_event_flags_t` (shift/control/alt/meta/caps/AltGr).
    pub(crate) fn shell_cef_event_flags(&self) -> u32 {
        self.input_routing.shell_cef_event_flags()
    }

    fn cef_flags_from_modifiers(m: &ModifiersState) -> u32 {
        InputRoutingState::cef_flags_from_modifiers(m)
    }

    pub(crate) fn shell_cef_sym_should_autorepeat(raw: u32) -> bool {
        InputRoutingState::shell_cef_sym_should_autorepeat(raw)
    }

    pub(crate) fn shell_cef_repeat_clear(&mut self, lh: &LoopHandle<CalloopData>) {
        self.input_routing.shell_cef_repeat_clear(lh);
    }

    pub(crate) fn shell_cef_repeat_arm(
        &mut self,
        lh: &LoopHandle<CalloopData>,
        keycode: Keycode,
        sym_raw: u32,
    ) {
        self.shell_cef_repeat_clear(lh);
        self.input_routing.shell_cef_repeat_keycode = Some(keycode);
        self.input_routing.shell_cef_repeat_sym_raw = Some(sym_raw);
        let lh2 = lh.clone();
        match lh.insert_source(
            Timer::from_duration(Duration::from_millis(200)),
            move |_, _, d: &mut CalloopData| d.state.shell_cef_repeat_on_tick(&lh2),
        ) {
            Ok(t) => self.input_routing.shell_cef_repeat_token = Some(t),
            Err(_) => {
                self.input_routing.shell_cef_repeat_keycode = None;
                self.input_routing.shell_cef_repeat_sym_raw = None;
            }
        }
    }

    fn shell_cef_repeat_on_tick(&mut self, lh: &LoopHandle<CalloopData>) -> TimeoutAction {
        let Some(keycode) = self.input_routing.shell_cef_repeat_keycode else {
            self.input_routing.shell_cef_repeat_token = None;
            return TimeoutAction::Drop;
        };
        let Some(keyboard) = self.input_routing.seat.get_keyboard().map(|k| k.clone()) else {
            self.shell_cef_repeat_clear(lh);
            return TimeoutAction::Drop;
        };
        if !keyboard.pressed_keys().contains(&keycode) {
            self.shell_cef_repeat_clear(lh);
            return TimeoutAction::Drop;
        }
        if !self.shell_keyboard_capture_active()
            || !self.shell_cef_active()
            || !self.shell_osr.shell_has_frame
        {
            self.shell_cef_repeat_clear(lh);
            return TimeoutAction::Drop;
        }
        let Some(sym_raw) = self.input_routing.shell_cef_repeat_sym_raw else {
            self.shell_cef_repeat_clear(lh);
            return TimeoutAction::Drop;
        };
        let mods = keyboard.modifier_state();
        let mut ticked = false;
        keyboard.with_pressed_keysyms(|handles| {
            let Some(h) = handles.iter().find(|h| h.modified_sym().raw() == sym_raw) else {
                return;
            };
            self.shell_ipc_forward_keyboard_to_cef(KeyState::Pressed, &mods, h, true);
            ticked = true;
        });
        if !ticked {
            self.shell_cef_repeat_clear(lh);
            return TimeoutAction::Drop;
        }
        TimeoutAction::ToDuration(Duration::from_millis(40))
    }

    fn keysym_raw_to_windows_vkey(raw: u32) -> i32 {
        match raw {
            keysyms::KEY_BackSpace => 0x08,
            keysyms::KEY_Tab => 0x09,
            keysyms::KEY_ISO_Left_Tab => 0x09,
            keysyms::KEY_Return => 0x0D,
            keysyms::KEY_KP_Enter => 0x0D,
            keysyms::KEY_Escape => 0x1B,
            keysyms::KEY_Left => 0x25,
            keysyms::KEY_Up => 0x26,
            keysyms::KEY_Right => 0x27,
            keysyms::KEY_Down => 0x28,
            keysyms::KEY_Page_Up => 0x21,
            keysyms::KEY_Page_Down => 0x22,
            keysyms::KEY_Home => 0x24,
            keysyms::KEY_End => 0x23,
            keysyms::KEY_Insert => 0x2D,
            keysyms::KEY_Delete => 0x2E,
            _ => 0,
        }
    }

    pub(crate) fn shell_ipc_forward_keyboard_to_cef(
        &mut self,
        key_state: KeyState,
        mods: &ModifiersState,
        keysym: &KeysymHandle<'_>,
        is_autorepeat: bool,
    ) {
        if !self.shell_cef_active() || !self.shell_osr.shell_has_frame {
            return;
        }
        let sym = keysym.modified_sym();
        let mut mods_u = Self::cef_flags_from_modifiers(mods);
        if key_state == KeyState::Pressed && is_autorepeat {
            mods_u |= InputRoutingState::CEF_EVENTFLAG_IS_REPEAT;
        }
        let native = sym.raw() as i32;
        let win_vk = Self::keysym_raw_to_windows_vkey(sym.raw());
        match key_state {
            KeyState::Pressed => {
                let raw = sym.raw();
                let ctl_char: Option<u32> = match raw {
                    keysyms::KEY_BackSpace => Some(0x08),
                    keysyms::KEY_Delete | keysyms::KEY_KP_Delete => Some(0x7f),
                    _ => None,
                };
                let printable = sym.key_char().filter(|c| !c.is_control());
                if is_autorepeat {
                    self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                        cef_key_type: shell_wire::CEF_KEYEVENT_KEYDOWN,
                        modifiers: mods_u,
                        windows_key_code: win_vk,
                        native_key_code: native,
                        character: 0,
                        unmodified_character: 0,
                    });
                    if let Some(cu) = ctl_char {
                        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                            cef_key_type: shell_wire::CEF_KEYEVENT_CHAR,
                            modifiers: mods_u,
                            windows_key_code: win_vk,
                            native_key_code: native,
                            character: cu,
                            unmodified_character: cu,
                        });
                    } else if let Some(ch) = printable {
                        let cu = ch as u32;
                        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                            cef_key_type: shell_wire::CEF_KEYEVENT_CHAR,
                            modifiers: mods_u,
                            windows_key_code: win_vk,
                            native_key_code: native,
                            character: cu,
                            unmodified_character: cu,
                        });
                    }
                } else {
                    self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                        cef_key_type: shell_wire::CEF_KEYEVENT_RAWKEYDOWN,
                        modifiers: mods_u,
                        windows_key_code: win_vk,
                        native_key_code: native,
                        character: 0,
                        unmodified_character: 0,
                    });
                    if let Some(cu) = ctl_char {
                        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                            cef_key_type: shell_wire::CEF_KEYEVENT_CHAR,
                            modifiers: mods_u,
                            windows_key_code: win_vk,
                            native_key_code: native,
                            character: cu,
                            unmodified_character: cu,
                        });
                    } else if let Some(ch) = printable {
                        let cu = ch as u32;
                        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                            cef_key_type: shell_wire::CEF_KEYEVENT_CHAR,
                            modifiers: mods_u,
                            windows_key_code: win_vk,
                            native_key_code: native,
                            character: cu,
                            unmodified_character: cu,
                        });
                    }
                }
            }
            KeyState::Released => {
                self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Key {
                    cef_key_type: shell_wire::CEF_KEYEVENT_KEYUP,
                    modifiers: mods_u,
                    windows_key_code: win_vk,
                    native_key_code: native,
                    character: 0,
                    unmodified_character: 0,
                });
            }
        }
    }

    /// Solid / CEF OSR is composited from dma-buf, not a Wayland surface under the cursor — forward moves to `cef_host`.
    pub(crate) fn shell_ipc_maybe_forward_pointer_move(&mut self, pos: Point<f64, Logical>) {
        if !self.shell_cef_active() || !self.shell_osr.shell_has_frame {
            return;
        }
        self.sync_shell_shared_state_for_input();
        let route = self.shell_pointer_should_ipc_to_cef(pos);
        if !route
            && !self.shell_move_is_active()
            && !self.shell_resize_is_active()
            && self.input_routing.shell_ui_pointer_grab.is_none()
        {
            return;
        }
        let Some((bx, by)) = self.shell_pointer_coords_for_cef(pos) else {
            return;
        };
        let global_key = (pos.x.round() as i32, pos.y.round() as i32);
        let modifiers = self.shell_cef_event_flags();
        if self.input_routing.shell_last_pointer_ipc_global_logical == Some(global_key)
            && self.input_routing.shell_last_pointer_ipc_modifiers == Some(modifiers)
        {
            return;
        }
        self.input_routing.shell_last_pointer_ipc_global_logical = Some(global_key);
        self.input_routing.shell_last_pointer_ipc_px = Some((bx, by));
        self.input_routing.shell_last_pointer_ipc_modifiers = Some(modifiers);
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::PointerMove {
            x: bx,
            y: by,
            modifiers,
        });
    }

    /// Forward scroll / pointer axis to `cef_host` when the pointer is over the Solid shell (OSR).
    pub(crate) fn shell_ipc_maybe_forward_pointer_axis(&mut self, delta_x: i32, delta_y: i32) {
        if !self.shell_cef_active() || !self.shell_osr.shell_has_frame {
            return;
        }
        if delta_x == 0 && delta_y == 0 {
            return;
        }
        let Some(pointer) = self.input_routing.seat.get_pointer() else {
            return;
        };
        let pos = pointer.current_location();
        self.sync_shell_shared_state_for_input();
        let route = self.shell_pointer_should_ipc_to_cef(pos);
        if !route
            && !self.shell_move_is_active()
            && !self.shell_resize_is_active()
            && self.input_routing.shell_ui_pointer_grab.is_none()
        {
            return;
        }
        let Some((bx, by)) = self.shell_pointer_coords_for_cef(pos) else {
            return;
        };
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::PointerAxis {
            x: bx,
            y: by,
            delta_x,
            delta_y,
            modifiers: self.shell_cef_event_flags(),
        });
    }

    pub(crate) fn shell_ipc_refresh_pointer_modifiers(&mut self) {
        let Some(pointer) = self.input_routing.seat.get_pointer() else {
            return;
        };
        self.shell_ipc_maybe_forward_pointer_move(pointer.current_location());
    }

    pub(crate) fn apply_cursor_settings(
        &mut self,
        settings: crate::session::settings_config::CursorSettingsFile,
    ) -> Result<crate::session::settings_config::CursorSettingsFile, String> {
        let settings = crate::session::settings_config::write_cursor_settings(settings)?;
        crate::session::settings_config::mirror_cursor_settings_to_gnome(&settings);
        self.input_routing
            .cursor_theme
            .apply_settings(settings.clone());
        self.core.loop_signal.wakeup();
        Ok(settings)
    }
}
