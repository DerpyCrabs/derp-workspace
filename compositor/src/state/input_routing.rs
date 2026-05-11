use super::*;

#[derive(Clone, Copy, Debug)]
pub(crate) struct XdgToplevelDragMoveState {
    pub(crate) window_id: u32,
    pub(crate) x_offset: i32,
    pub(crate) y_offset: i32,
}

#[derive(Clone, Debug)]
pub(crate) enum TouchRoute {
    Native {
        focus: WlSurface,
        surface_origin: Point<f64, Logical>,
    },
    ShellCef {
        last_pos: Point<f64, Logical>,
    },
    PointerEmulation {
        last_pos: Point<f64, Logical>,
    },
}

pub(crate) struct InputRoutingState {
    pub(crate) seat_state: SeatState<CompositorState>,
    pub(crate) seat: Seat<CompositorState>,
    pub(crate) data_device_state: DataDeviceState,
    pub(crate) data_control_state: DataControlState,
    pub(crate) idle_inhibit_surfaces: HashSet<(ClientId, u32)>,
    pub(crate) keyboard_shortcuts_inhibit_state: KeyboardShortcutsInhibitState,
    pub(crate) touch_abs_is_window_pixels: bool,
    pub(crate) touch_routes: HashMap<i32, TouchRoute>,
    pub(crate) shell_keyboard_capture: ShellKeyboardCapture,
    pub(crate) shell_cef_repeat_token: Option<RegistrationToken>,
    pub(crate) shell_cef_repeat_keycode: Option<Keycode>,
    pub(crate) shell_cef_repeat_sym_raw: Option<u32>,
    pub(crate) shell_super_held: bool,
    pub(crate) programs_menu_super_armed: bool,
    pub(crate) programs_menu_super_chord: bool,
    pub(crate) programs_menu_super_pending_toggle: bool,
    pub(crate) keyboard_layout_by_window: HashMap<u32, u32>,
    pub(crate) keyboard_layout_last_focus_window: Option<u32>,
    pub(crate) keyboard_layout_focus_queue: VecDeque<KeyboardLayoutFocusOp>,
    pub(crate) shell_keyboard_layout_label: String,
    pub(crate) hotkey_settings: crate::session::settings_config::HotkeySettingsFile,
    pub(crate) shell_pointer_norm: Option<(f64, f64)>,
    pub(crate) shell_initial_pointer_centered: bool,
    pub(crate) shell_last_pointer_ipc_px: Option<(i32, i32)>,
    pub(crate) shell_last_pointer_ipc_global_logical: Option<(i32, i32)>,
    pub(crate) shell_last_pointer_ipc_modifiers: Option<u32>,
    pub(crate) pointer_pressed_buttons: HashSet<u32>,
    pub(crate) pointer_cursor_image: CursorImageStatus,
    pub(crate) pointer_cursor_hidden_after_touch: bool,
    pub(crate) pointer_cursor_touch_hide_generation: u64,
    pub(crate) pointer_cursor_touch_hide_token: Option<RegistrationToken>,
    pub(crate) cursor_theme: crate::platform::cursor_fallback::CursorThemeManager,
    pub(crate) shell_move_window_id: Option<u32>,
    pub(crate) shell_move_pending_delta: (i32, i32),
    pub(crate) shell_move_pointer_driven: bool,
    pub(crate) shell_move_client_initiated: bool,
    pub(crate) shell_move_deferred: Option<ShellMoveDeferredStartState>,
    pub(crate) shell_move_proxy: Option<ShellMoveProxyState>,
    pub(crate) shell_toplevel_drag: Option<XdgToplevelDragMoveState>,
    pub(crate) shell_toplevel_drag_drop_pending_window_id: Option<u32>,
    pub(crate) xdg_toplevel_drag_allow_no_target_drop: Option<Arc<AtomicBool>>,
    pub(crate) shell_native_drag_preview: Option<NativeDragPreviewState>,
    pub(crate) shell_native_drag_preview_generation: u32,
    pub(crate) shell_backed_move_candidate: Option<(u32, Point<f64, Logical>)>,
    pub(crate) shell_resize_window_id: Option<u32>,
    pub(crate) shell_resize_edges: Option<crate::grabs::resize_grab::ResizeEdge>,
    pub(crate) shell_resize_initial_rect: Option<Rectangle<i32, Logical>>,
    pub(crate) shell_resize_accum: (f64, f64),
    pub(crate) shell_resize_shell_grab: Option<u32>,
    pub(crate) shell_ui_pointer_grab: Option<u32>,
    pub(crate) shell_interaction_revision: u64,
    pub(crate) shell_interaction_serial: u64,
    pub(crate) shell_interaction_serial_owner: (u32, u32, u32, u32),
    pub(crate) shell_interaction_last_sent_at: Option<Instant>,
    pub(crate) shell_move_last_flush_at: Option<Instant>,
}

impl InputRoutingState {
    pub(crate) fn new(
        seat_state: SeatState<CompositorState>,
        seat: Seat<CompositorState>,
        data_device_state: DataDeviceState,
        data_control_state: DataControlState,
        keyboard_shortcuts_inhibit_state: KeyboardShortcutsInhibitState,
        cursor_theme: crate::platform::cursor_fallback::CursorThemeManager,
    ) -> Self {
        Self {
            seat_state,
            seat,
            data_device_state,
            data_control_state,
            idle_inhibit_surfaces: HashSet::new(),
            keyboard_shortcuts_inhibit_state,
            touch_abs_is_window_pixels: false,
            touch_routes: HashMap::new(),
            shell_keyboard_capture: ShellKeyboardCapture::None,
            shell_cef_repeat_token: None,
            shell_cef_repeat_keycode: None,
            shell_cef_repeat_sym_raw: None,
            shell_super_held: false,
            programs_menu_super_armed: false,
            programs_menu_super_chord: false,
            programs_menu_super_pending_toggle: false,
            keyboard_layout_by_window: HashMap::new(),
            keyboard_layout_last_focus_window: None,
            keyboard_layout_focus_queue: VecDeque::new(),
            shell_keyboard_layout_label: "?".into(),
            hotkey_settings: crate::session::settings_config::read_hotkey_settings(),
            shell_pointer_norm: None,
            shell_initial_pointer_centered: false,
            shell_last_pointer_ipc_px: None,
            shell_last_pointer_ipc_global_logical: None,
            shell_last_pointer_ipc_modifiers: None,
            pointer_pressed_buttons: HashSet::new(),
            pointer_cursor_image: CursorImageStatus::default_named(),
            pointer_cursor_hidden_after_touch: false,
            pointer_cursor_touch_hide_generation: 0,
            pointer_cursor_touch_hide_token: None,
            cursor_theme,
            shell_move_window_id: None,
            shell_move_pending_delta: (0, 0),
            shell_move_pointer_driven: false,
            shell_move_client_initiated: false,
            shell_move_deferred: None,
            shell_move_proxy: None,
            shell_toplevel_drag: None,
            shell_toplevel_drag_drop_pending_window_id: None,
            xdg_toplevel_drag_allow_no_target_drop: None,
            shell_native_drag_preview: None,
            shell_native_drag_preview_generation: 0,
            shell_backed_move_candidate: None,
            shell_resize_window_id: None,
            shell_resize_edges: None,
            shell_resize_initial_rect: None,
            shell_resize_accum: (0.0, 0.0),
            shell_resize_shell_grab: None,
            shell_ui_pointer_grab: None,
            shell_interaction_revision: 0,
            shell_interaction_serial: 0,
            shell_interaction_serial_owner: (0, 0, 0, 0),
            shell_interaction_last_sent_at: None,
            shell_move_last_flush_at: None,
        }
    }

    pub(crate) fn next_shell_interaction_revision(&mut self) -> u64 {
        self.shell_interaction_revision = self.shell_interaction_revision.wrapping_add(1);
        self.shell_interaction_revision
    }

    pub(crate) fn next_shell_interaction_serial(&mut self) -> u64 {
        self.shell_interaction_serial = self.shell_interaction_serial.wrapping_add(1).max(1);
        self.shell_interaction_serial
    }

    pub(crate) fn shell_keyboard_capture_active(&self) -> bool {
        self.shell_keyboard_capture != ShellKeyboardCapture::None
    }

    pub(crate) fn shell_keyboard_capture_shell_ui(&mut self) {
        self.shell_keyboard_capture = ShellKeyboardCapture::ShellUi;
    }

    pub(crate) fn shell_keyboard_capture_programs_menu(&mut self, restore_window_id: Option<u32>) {
        self.shell_keyboard_capture = ShellKeyboardCapture::ProgramsMenu { restore_window_id };
    }

    pub(crate) fn shell_keyboard_capture_window_switcher(
        &mut self,
        restore_window_id: Option<u32>,
    ) {
        self.shell_keyboard_capture = ShellKeyboardCapture::WindowSwitcher { restore_window_id };
    }

    pub(crate) fn shell_keyboard_capture_clear(&mut self) {
        self.shell_keyboard_capture = ShellKeyboardCapture::None;
    }

    pub(crate) fn logical_focused_window_id<F>(
        &self,
        keyboard_focused_window_id: Option<u32>,
        shell_focused_ui_window_id: Option<u32>,
        valid: F,
    ) -> Option<u32>
    where
        F: Fn(u32) -> bool,
    {
        match self.shell_keyboard_capture {
            ShellKeyboardCapture::None => keyboard_focused_window_id,
            ShellKeyboardCapture::ShellUi => shell_focused_ui_window_id,
            ShellKeyboardCapture::ProgramsMenu { restore_window_id }
            | ShellKeyboardCapture::WindowSwitcher { restore_window_id } => restore_window_id
                .filter(|window_id| valid(*window_id))
                .or(shell_focused_ui_window_id),
        }
    }

    pub(crate) fn shell_window_switcher_restore_window_id(&self) -> Option<u32> {
        match self.shell_keyboard_capture {
            ShellKeyboardCapture::WindowSwitcher { restore_window_id } => restore_window_id,
            _ => None,
        }
    }

    pub(crate) fn shell_window_switcher_open(&self) -> bool {
        matches!(
            self.shell_keyboard_capture,
            ShellKeyboardCapture::WindowSwitcher { .. }
        )
    }

    pub(crate) fn keyboard_clear_per_window_layout_map(&mut self) {
        self.keyboard_layout_by_window.clear();
        self.keyboard_layout_last_focus_window = None;
        self.keyboard_layout_focus_queue.clear();
    }

    pub(crate) fn keyboard_forget_window(&mut self, window_id: u32) {
        self.keyboard_layout_by_window.remove(&window_id);
        if self.keyboard_layout_last_focus_window == Some(window_id) {
            self.keyboard_layout_last_focus_window = None;
        }
    }

    pub(crate) fn keyboard_save_layout_for_window(&mut self, window_id: u32, layout: u32) {
        self.keyboard_layout_by_window.insert(window_id, layout);
    }

    pub(crate) fn keyboard_layout_for_window_or_default(
        &self,
        window_id: u32,
        default_layout: u32,
    ) -> u32 {
        self.keyboard_layout_by_window
            .get(&window_id)
            .copied()
            .unwrap_or(default_layout)
    }

    pub(crate) fn keyboard_layout_label_short(name: &str) -> String {
        let s = name.split_whitespace().next().unwrap_or(name);
        let s = s.find('(').map(|i| s[..i].trim_end()).unwrap_or(s);
        let mut out: String = s.chars().take(12).collect();
        if out.is_empty() {
            out.push('?');
        }
        out.make_ascii_uppercase();
        let max = shell_wire::MAX_KEYBOARD_LAYOUT_LABEL_BYTES as usize;
        while out.len() > max {
            out.pop();
        }
        out
    }

    pub(crate) fn queue_keyboard_focus_change<F>(
        &mut self,
        new_wid: Option<u32>,
        shell_host: bool,
        should_track: F,
    ) where
        F: Fn(u32) -> bool,
    {
        let prev = self.keyboard_layout_last_focus_window.take();
        let save_from = prev.filter(|&w| should_track(w));
        let restore_for = new_wid.filter(|&w| should_track(w));
        self.keyboard_layout_last_focus_window = if restore_for.is_some() { new_wid } else { None };
        self.keyboard_layout_focus_queue
            .push_back(KeyboardLayoutFocusOp {
                save_from,
                restore_for,
                shell_host,
            });
    }

    pub(crate) fn programs_menu_close_restore_window(&mut self) -> Option<u32> {
        let restore_window_id = match self.shell_keyboard_capture {
            ShellKeyboardCapture::ProgramsMenu { restore_window_id } => restore_window_id,
            _ => None,
        };
        self.programs_menu_super_armed = false;
        self.programs_menu_super_chord = false;
        self.programs_menu_super_pending_toggle = false;
        self.shell_keyboard_capture = ShellKeyboardCapture::None;
        restore_window_id
    }

    pub(crate) fn programs_menu_clear_super_press(&mut self) {
        self.programs_menu_super_armed = false;
        self.programs_menu_super_chord = false;
    }

    pub(crate) fn programs_menu_prepare_super_press(
        &mut self,
        pointer_button_pressed: bool,
        shell_move_active: bool,
        shell_resize_active: bool,
        shell_backed_move_candidate: bool,
    ) {
        self.programs_menu_super_armed = true;
        self.programs_menu_super_chord = Self::programs_menu_super_press_chord(
            pointer_button_pressed,
            shell_move_active,
            shell_resize_active,
            shell_backed_move_candidate,
        );
    }

    pub(crate) fn programs_menu_super_press_chord(
        pointer_button_pressed: bool,
        shell_move_active: bool,
        shell_resize_active: bool,
        shell_backed_move_candidate: bool,
    ) -> bool {
        pointer_button_pressed
            || shell_move_active
            || shell_resize_active
            || shell_backed_move_candidate
    }

    pub(crate) fn programs_menu_mark_super_chord(&mut self) {
        self.programs_menu_super_chord = true;
    }

    pub(crate) fn programs_menu_take_pending_toggle(&mut self) -> bool {
        let pending = self.programs_menu_super_pending_toggle;
        self.programs_menu_super_pending_toggle = false;
        pending
    }

    pub(crate) fn shell_interaction_owner_signature(&self) -> (u32, u32, u32, u32) {
        let move_proxy_window_id = self
            .shell_move_proxy
            .as_ref()
            .and_then(|proxy| {
                proxy.texture.as_ref()?;
                match proxy.release_state {
                    Some(ShellMoveProxyReleaseState::AwaitVisibleShellCommit { .. }) => None,
                    _ => Some(proxy.window_id),
                }
            })
            .unwrap_or(0);
        let move_capture_window_id = self
            .shell_move_proxy
            .as_ref()
            .and_then(|proxy| proxy.request_opaque_source.then_some(proxy.window_id))
            .unwrap_or(0);
        (
            self.shell_move_window_id.unwrap_or(0),
            self.shell_resize_window_id.unwrap_or(0),
            move_proxy_window_id,
            move_capture_window_id,
        )
    }

    pub(crate) fn sync_shell_interaction_serial(&mut self) -> bool {
        let owner = self.shell_interaction_owner_signature();
        if owner == self.shell_interaction_serial_owner {
            return false;
        }
        self.shell_interaction_serial_owner = owner;
        self.next_shell_interaction_serial();
        true
    }

    pub(crate) fn shell_hot_interaction_due(
        last: &mut Option<Instant>,
        interval: Duration,
    ) -> bool {
        let now = Instant::now();
        if last.is_some_and(|sent| now.duration_since(sent) < interval) {
            return false;
        }
        *last = Some(now);
        true
    }

    pub(crate) fn shell_move_deferred_cancel(&mut self, window_id: Option<u32>) {
        if self
            .shell_move_deferred
            .as_ref()
            .is_some_and(|pending| window_id.map_or(true, |wid| wid == pending.window_id))
        {
            self.shell_move_deferred = None;
        }
    }

    pub(crate) fn shell_move_deferred_accumulate_delta(&mut self, dx: i32, dy: i32) {
        let Some(pending) = self.shell_move_deferred.as_mut() else {
            return;
        };
        pending.pending_delta.0 = pending.pending_delta.0.saturating_add(dx);
        pending.pending_delta.1 = pending.pending_delta.1.saturating_add(dy);
    }

    pub(crate) fn shell_move_is_active(&self) -> bool {
        self.shell_move_window_id.is_some()
    }

    pub(crate) fn shell_move_accepts_pointer_delta(&self) -> bool {
        self.shell_move_pointer_driven
    }

    pub(crate) fn shell_move_end_active_window(&mut self) -> Option<u32> {
        if self.shell_move_deferred.take().is_some() {
            return None;
        }
        self.shell_move_window_id
    }

    pub(crate) fn shell_move_begin_state(
        &mut self,
        window_id: u32,
        pointer_driven: bool,
        pending_delta: (i32, i32),
        client_initiated: bool,
    ) {
        self.shell_move_window_id = Some(window_id);
        self.shell_move_pending_delta = pending_delta;
        self.shell_move_pointer_driven = pointer_driven;
        self.shell_move_client_initiated = client_initiated;
        self.shell_move_last_flush_at = None;
    }

    pub(crate) fn shell_move_clear_active_state(&mut self) {
        self.shell_move_window_id = None;
        self.shell_move_pending_delta = (0, 0);
        self.shell_move_pointer_driven = false;
        self.shell_move_client_initiated = false;
        self.shell_toplevel_drag = None;
        self.shell_toplevel_drag_drop_pending_window_id = None;
        self.shell_move_last_flush_at = None;
    }

    pub(crate) fn shell_move_delta_flush_due(&mut self) -> bool {
        Self::shell_hot_interaction_due(
            &mut self.shell_move_last_flush_at,
            Duration::from_millis(16),
        )
    }

    pub(crate) fn shell_resize_is_active(&self) -> bool {
        self.shell_resize_window_id.is_some() || self.shell_resize_shell_grab.is_some()
    }

    pub(crate) fn shell_resize_active_window(&self) -> Option<u32> {
        self.shell_resize_window_id
    }

    pub(crate) fn shell_resize_shell_grab_begin(&mut self, window_id: u32) {
        self.shell_resize_shell_grab = Some(window_id);
    }

    pub(crate) fn shell_resize_clear_active_state(&mut self) {
        self.shell_resize_window_id = None;
        self.shell_resize_edges = None;
        self.shell_resize_initial_rect = None;
        self.shell_resize_accum = (0.0, 0.0);
    }

    pub(crate) fn shell_resize_begin_state(
        &mut self,
        window_id: u32,
        edges: crate::grabs::resize_grab::ResizeEdge,
        initial_rect: Rectangle<i32, Logical>,
    ) {
        self.shell_resize_window_id = Some(window_id);
        self.shell_resize_edges = Some(edges);
        self.shell_resize_initial_rect = Some(initial_rect);
        self.shell_resize_accum = (0.0, 0.0);
    }

    pub(crate) fn shell_resize_shell_grab_end(&mut self) -> bool {
        self.shell_resize_shell_grab.take().is_some()
    }

    pub(crate) fn shell_cef_event_flags(&self) -> u32 {
        let Some(kb) = self.seat.get_keyboard() else {
            return 0;
        };
        let mut flags = Self::cef_flags_from_modifiers(&kb.modifier_state());
        flags |= self.cef_flags_from_pressed_pointer_buttons();
        flags
    }

    pub(crate) const CEF_EVENTFLAG_IS_REPEAT: u32 = 1 << 13;
    const CEF_EVENTFLAG_LEFT_MOUSE_BUTTON: u32 = 1 << 4;
    const CEF_EVENTFLAG_MIDDLE_MOUSE_BUTTON: u32 = 1 << 5;
    const CEF_EVENTFLAG_RIGHT_MOUSE_BUTTON: u32 = 1 << 6;
    const BTN_LEFT: u32 = 0x110;
    const BTN_RIGHT: u32 = 0x111;
    const BTN_MIDDLE: u32 = 0x112;

    fn cef_flags_from_pressed_pointer_buttons(&self) -> u32 {
        let mut flags = 0u32;
        if self.pointer_pressed_buttons.contains(&Self::BTN_LEFT) {
            flags |= Self::CEF_EVENTFLAG_LEFT_MOUSE_BUTTON;
        }
        if self.pointer_pressed_buttons.contains(&Self::BTN_MIDDLE) {
            flags |= Self::CEF_EVENTFLAG_MIDDLE_MOUSE_BUTTON;
        }
        if self.pointer_pressed_buttons.contains(&Self::BTN_RIGHT) {
            flags |= Self::CEF_EVENTFLAG_RIGHT_MOUSE_BUTTON;
        }
        flags
    }

    pub(crate) fn cef_flags_from_modifiers(m: &ModifiersState) -> u32 {
        let mut f = 0u32;
        if m.caps_lock {
            f |= 1;
        }
        if m.shift {
            f |= 2;
        }
        if m.ctrl {
            f |= 4;
        }
        if m.alt {
            f |= 8;
        }
        if m.logo {
            f |= 128;
        }
        if m.iso_level3_shift {
            f |= 4096;
        }
        f
    }

    pub(crate) fn shell_cef_sym_should_autorepeat(raw: u32) -> bool {
        !matches!(
            raw,
            keysyms::KEY_Shift_L
                | keysyms::KEY_Shift_R
                | keysyms::KEY_Control_L
                | keysyms::KEY_Control_R
                | keysyms::KEY_Alt_L
                | keysyms::KEY_Alt_R
                | keysyms::KEY_Caps_Lock
        )
    }

    pub(crate) fn shell_cef_repeat_clear(&mut self, lh: &LoopHandle<CalloopData>) {
        if let Some(t) = self.shell_cef_repeat_token.take() {
            let _ = lh.remove(t);
        }
        self.shell_cef_repeat_keycode = None;
        self.shell_cef_repeat_sym_raw = None;
    }

    pub(crate) fn shell_pointer_ipc_for_cef(
        pos: Point<f64, Logical>,
        shell_canvas_logical_origin: (i32, i32),
        shell_canvas_logical_size: (u32, u32),
    ) -> Option<(i32, i32)> {
        let (cox, coy) = shell_canvas_logical_origin;
        let (clw, clh) = shell_canvas_logical_size;
        let clwf = clw.max(1) as f64;
        let clhf = clh.max(1) as f64;
        let lx = pos.x - cox as f64;
        let ly = pos.y - coy as f64;
        if lx < 0.0 || ly < 0.0 || lx >= clwf || ly >= clhf {
            return None;
        }
        let xmax = clw.saturating_sub(1) as i32;
        let ymax = clh.saturating_sub(1) as i32;
        let x = (lx.round() as i32).clamp(0, xmax);
        let y = (ly.round() as i32).clamp(0, ymax);
        Some((x, y))
    }

    pub(crate) fn shell_pointer_norm_from_global(
        pos: Point<f64, Logical>,
        workspace: Rectangle<i32, Logical>,
    ) -> (f64, f64) {
        let local = pos - workspace.loc.to_f64();
        let gw = workspace.size.w.max(1) as f64;
        let gh = workspace.size.h.max(1) as f64;
        (
            (local.x / gw).clamp(0.0, 1.0),
            (local.y / gh).clamp(0.0, 1.0),
        )
    }

    pub(crate) fn shell_pointer_buffer_pixels(
        nx: f64,
        ny: f64,
        shell_view_px: Option<(u32, u32)>,
        shell_output_logical_size: Option<(u32, u32)>,
    ) -> Option<(i32, i32)> {
        let (buf_w, buf_h) = shell_view_px?;
        let content_h = buf_h.max(1);
        let (lw, lh) = shell_output_logical_size?;
        let (ox, oy, cw, ch) = crate::shell::shell_letterbox::letterbox_logical(
            Size::from((lw as i32, lh as i32)),
            buf_w,
            content_h,
        )?;
        let nx = nx.clamp(0.0, 1.0);
        let ny = ny.clamp(0.0, 1.0);
        let lx = nx * lw as f64 - ox as f64;
        let ly = ny * lh as f64 - oy as f64;
        crate::shell::shell_letterbox::local_in_letterbox_to_buffer_px(
            lx, ly, cw, ch, buf_w, content_h,
        )
    }
}
