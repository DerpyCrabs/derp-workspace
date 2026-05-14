use std::sync::OnceLock;

use input as libinput;
use smithay::backend::libinput::LibinputInputBackend;
use smithay::desktop::space::SpaceElement;
use smithay::{
    backend::{
        input::{
            AbsolutePositionEvent, Axis, AxisSource, ButtonState, Event,
            GestureBeginEvent as BackendGestureBeginEvent,
            GestureEndEvent as BackendGestureEndEvent,
            GesturePinchUpdateEvent as BackendGesturePinchUpdateEvent,
            GestureSwipeUpdateEvent as BackendGestureSwipeUpdateEvent, InputEvent, KeyState,
            KeyboardKeyEvent, Keycode, PointerAxisEvent, PointerButtonEvent, PointerMotionEvent,
            TouchEvent, TouchSlot,
        },
        session::Session,
    },
    input::{
        keyboard::{keysyms, FilterResult},
        pointer::{
            AxisFrame, ButtonEvent, GestureHoldBeginEvent, GestureHoldEndEvent,
            GesturePinchBeginEvent, GesturePinchEndEvent, GesturePinchUpdateEvent,
            GestureSwipeBeginEvent, GestureSwipeEndEvent, GestureSwipeUpdateEvent, MotionEvent,
            RelativeMotionEvent,
        },
        touch::{
            DownEvent as TouchDownEvent, MotionEvent as TouchMotionEvent, UpEvent as TouchUpEvent,
        },
    },
    reexports::calloop::timer::{TimeoutAction, Timer},
    reexports::{calloop::LoopHandle, wayland_server::protocol::wl_surface::WlSurface},
    utils::{Logical, Point, Rectangle, Serial, Size, SERIAL_COUNTER},
    wayland::keyboard_shortcuts_inhibit::KeyboardShortcutsInhibitorSeat,
    wayland::pointer_constraints::{with_pointer_constraint, PointerConstraint},
};

use crate::{
    derp_space::DerpSpaceElem,
    state::{CompositorState, TouchRoute},
    CalloopData,
};

static TOUCH_LEFTMOST_FALLBACK_LOG: OnceLock<()> = OnceLock::new();

pub(crate) fn keysym_is_super(keysym: &smithay::input::keyboard::KeysymHandle<'_>) -> bool {
    keysym.raw_syms().into_iter().any(|sym| {
        matches!(
            sym.raw(),
            keysyms::KEY_Super_L | keysyms::KEY_Super_R | keysyms::KEY_Meta_L | keysyms::KEY_Meta_R
        )
    })
}

pub(crate) fn keysym_is_alt(keysym: &smithay::input::keyboard::KeysymHandle<'_>) -> bool {
    keysym
        .raw_syms()
        .into_iter()
        .any(|sym| matches!(sym.raw(), keysyms::KEY_Alt_L | keysyms::KEY_Alt_R))
}

/// Map libinput / Smithay pointer-axis values to integers for CEF [`send_mouse_wheel_event`].
fn pointer_axis_to_cef_delta(amount: f64, discrete_v120: Option<f64>) -> i32 {
    if let Some(v) = discrete_v120 {
        if v != 0.0 {
            return (v.round() as i32).clamp(-6000, 6000);
        }
    }
    ((amount * 40.0).round() as i32).clamp(-6000, 6000)
}

fn libinput_device_has(dev: &libinput::Device, cap: libinput::DeviceCapability) -> bool {
    dev.has_capability(cap)
}

fn libinput_device_is_touchpad_like(dev: &libinput::Device) -> bool {
    libinput_device_has(dev, libinput::DeviceCapability::Pointer)
        && libinput_device_has(dev, libinput::DeviceCapability::Gesture)
}

fn libinput_device_is_screen_touch(dev: &libinput::Device) -> bool {
    libinput_device_has(dev, libinput::DeviceCapability::Touch)
        && !libinput_device_is_touchpad_like(dev)
        && !libinput_device_has(dev, libinput::DeviceCapability::Pointer)
}

/// Ctrl+Alt+F*n* → Linux VT *n* (1..=12) for [`Session::change_vt`].
fn vt_number_from_fkey(sym: u32) -> Option<i32> {
    match sym {
        keysyms::KEY_F1 => Some(1),
        keysyms::KEY_F2 => Some(2),
        keysyms::KEY_F3 => Some(3),
        keysyms::KEY_F4 => Some(4),
        keysyms::KEY_F5 => Some(5),
        keysyms::KEY_F6 => Some(6),
        keysyms::KEY_F7 => Some(7),
        keysyms::KEY_F8 => Some(8),
        keysyms::KEY_F9 => Some(9),
        keysyms::KEY_F10 => Some(10),
        keysyms::KEY_F11 => Some(11),
        keysyms::KEY_F12 => Some(12),
        _ => None,
    }
}

impl CompositorState {
    pub(crate) fn keyboard_input_from_source(
        &mut self,
        source: &'static str,
        keycode: Keycode,
        key_state: KeyState,
        serial: Serial,
        time: u32,
        loop_handle: &LoopHandle<CalloopData>,
    ) -> Result<(), String> {
        let Some(keyboard) = self.input_routing.seat.get_keyboard() else {
            return Err("keyboard is unavailable".to_string());
        };
        let is_autorepeat =
            key_state == KeyState::Pressed && keyboard.pressed_keys().contains(&keycode);
        let keyboard_grabbed = keyboard.is_grabbed();
        let lh_kbd = loop_handle.clone();
        keyboard.input::<(), _>(
            self,
            keycode,
            key_state,
            serial,
            time,
            move |state, mods, keysym| {
                let raw_sym = keysym.modified_sym().raw();
                let is_super = keysym_is_super(&keysym);
                let is_alt = keysym_is_alt(&keysym);
                if is_super {
                    let next = key_state == KeyState::Pressed;
                    if state.input_routing.shell_super_held != next {
                        state.input_routing.shell_super_held = next;
                        if state.input_routing.shell_move_window_id.is_some()
                            || state.input_routing.shell_resize_window_id.is_some()
                        {
                            state.shell_send_interaction_state();
                        }
                    }
                }
                if state.screenshot_selection_active() {
                    if key_state == KeyState::Released && is_super {
                        state.input_routing.programs_menu_super_armed = false;
                        state.input_routing.programs_menu_super_chord = false;
                    }
                    if matches!(raw_sym, keysyms::KEY_Escape) && key_state == KeyState::Pressed {
                        state.cancel_screenshot_selection_mode();
                    }
                    return FilterResult::Intercept(());
                }
                if keyboard_grabbed
                    && !(source == "virtual_keyboard"
                        && state.session_services.osk_shell_text_input_active)
                {
                    return FilterResult::Forward;
                }
                if key_state == KeyState::Pressed {
                    if mods.ctrl && mods.alt {
                        if let (Some(vt), Some(ref mut sess)) = (
                            vt_number_from_fkey(raw_sym),
                            state.session_services.vt_session.as_mut(),
                        ) {
                            if let Err(e) = sess.change_vt(vt) {
                                tracing::warn!(?e, vt, "VT switch (Ctrl+Alt+F) failed");
                            }
                            return FilterResult::Intercept(());
                        }
                    }
                    if mods.ctrl
                        && mods.shift
                        && matches!(raw_sym, keysyms::KEY_q | keysyms::KEY_Q)
                        && !state.input_routing.seat.keyboard_shortcuts_inhibited()
                    {
                        state.stop_event_loop();
                        return FilterResult::Intercept(());
                    }
                }
                match crate::controls::volume::try_volume_key(&keysym, key_state) {
                    None => {}
                    Some(crate::controls::volume::VolumeKeyIntercept::ReleaseOnly) => {
                        return FilterResult::Intercept(());
                    }
                    Some(crate::controls::volume::VolumeKeyIntercept::PressHud {
                        volume_linear_percent_x100,
                        muted,
                        state_known,
                    }) => {
                        state.shell_send_to_cef(
                            shell_wire::DecodedCompositorToShellMessage::VolumeOverlay {
                                volume_linear_percent_x100,
                                muted,
                                state_known,
                            },
                        );
                        return FilterResult::Intercept(());
                    }
                }
                if key_state == KeyState::Pressed
                    && matches!(raw_sym, keysyms::KEY_Escape)
                    && state.shell_osr.shell_exclusion_overlay_open
                    && state.shell_cef_active()
                {
                    state.shell_dismiss_context_menu_from_compositor();
                    return FilterResult::Intercept(());
                }
                if key_state == KeyState::Pressed {
                    if is_super && !state.input_routing.seat.keyboard_shortcuts_inhibited() {
                        if state.input_routing.shell_move_window_id.is_some()
                            || state.input_routing.shell_resize_window_id.is_some()
                        {
                            return FilterResult::Intercept(());
                        }
                        state.programs_menu_prepare_super_press();
                        return FilterResult::Intercept(());
                    }
                    if matches!(raw_sym, keysyms::KEY_Tab)
                        && mods.alt
                        && !state.input_routing.seat.keyboard_shortcuts_inhibited()
                    {
                        if !is_autorepeat {
                            state.shell_window_switcher_cycle(mods.shift);
                        }
                        return FilterResult::Intercept(());
                    }
                    if state.input_routing.programs_menu_super_armed
                        && !is_super
                        && !state.input_routing.seat.keyboard_shortcuts_inhibited()
                    {
                        if let Some(action) = state
                            .super_hotkey_action_for_chord(raw_sym, mods.ctrl, mods.alt, mods.shift)
                        {
                            state.input_routing.programs_menu_super_chord = true;
                            if state.shell_cef_active() {
                                state.handle_super_hotkey_action(action);
                            }
                            return FilterResult::Intercept(());
                        }
                        state.input_routing.programs_menu_super_chord = true;
                        return FilterResult::Intercept(());
                    }
                } else if key_state == KeyState::Released
                    && is_super
                    && !state.input_routing.seat.keyboard_shortcuts_inhibited()
                {
                    let armed = state.input_routing.programs_menu_super_armed;
                    let chord = state.input_routing.programs_menu_super_chord;
                    state.input_routing.programs_menu_super_armed = false;
                    state.input_routing.programs_menu_super_chord = false;
                    if armed && !chord {
                        if state.shell_cef_active() {
                            state.programs_menu_toggle_from_super(serial);
                        } else {
                            tracing::warn!(
                                target: "derp_shell_menu",
                                source,
                                "queue pending launcher toggle until shell load success"
                            );
                            state.input_routing.programs_menu_super_pending_toggle = true;
                        }
                        return FilterResult::Intercept(());
                    }
                }
                if state.shell_window_switcher_open() {
                    if key_state == KeyState::Released && is_alt {
                        state.shell_window_switcher_commit();
                        return FilterResult::Intercept(());
                    }
                    if key_state == KeyState::Pressed && matches!(raw_sym, keysyms::KEY_Escape) {
                        state.shell_window_switcher_cancel();
                        return FilterResult::Intercept(());
                    }
                    return FilterResult::Intercept(());
                }
                if state.shell_keyboard_capture_active()
                    && state.shell_cef_active()
                    && state.shell_osr.shell_has_frame
                {
                    if key_state == KeyState::Pressed && is_autorepeat {
                        return FilterResult::Intercept(());
                    }
                    if key_state == KeyState::Released {
                        if state.input_routing.shell_cef_repeat_keycode == Some(keycode) {
                            state.shell_cef_repeat_clear(&lh_kbd);
                        }
                        state.shell_ipc_forward_keyboard_to_cef(key_state, mods, &keysym, false);
                        state.shell_ipc_refresh_pointer_modifiers();
                        return FilterResult::Intercept(());
                    }
                    state.shell_ipc_forward_keyboard_to_cef(key_state, mods, &keysym, false);
                    state.shell_ipc_refresh_pointer_modifiers();
                    if CompositorState::shell_cef_sym_should_autorepeat(raw_sym) {
                        let sr = keysym.modified_sym().raw();
                        state.shell_cef_repeat_arm(&lh_kbd, keycode, sr);
                    }
                    return FilterResult::Intercept(());
                }
                FilterResult::Forward
            },
        );
        Ok(())
    }

    fn pointer_cursor_touch_repaint(&mut self) {
        self.shell_osr.shell_exclusion_zones_need_full_damage = true;
        self.capture.capture_force_full_damage_frames =
            self.capture.capture_force_full_damage_frames.max(2);
    }

    fn pointer_cursor_touch_hide_arm(&mut self) {
        self.input_routing.pointer_cursor_touch_hide_generation = self
            .input_routing
            .pointer_cursor_touch_hide_generation
            .wrapping_add(1);
        if let Some(token) = self.input_routing.pointer_cursor_touch_hide_token.take() {
            let _ = self.core.loop_handle.remove(token);
        }
        let generation = self.input_routing.pointer_cursor_touch_hide_generation;
        let loop_handle = self.core.loop_handle.clone();
        match loop_handle.insert_source(
            Timer::from_duration(std::time::Duration::from_secs(1)),
            move |_, _, d: &mut CalloopData| {
                let state = &mut d.state;
                state.input_routing.pointer_cursor_touch_hide_token = None;
                if state.input_routing.pointer_cursor_touch_hide_generation == generation
                    && !state.input_routing.pointer_cursor_hidden_after_touch
                {
                    state.input_routing.pointer_cursor_hidden_after_touch = true;
                    state.pointer_cursor_touch_repaint();
                    if let Some(drms) = d.drm.as_mut() {
                        drms.request_render();
                    }
                }
                TimeoutAction::Drop
            },
        ) {
            Ok(token) => self.input_routing.pointer_cursor_touch_hide_token = Some(token),
            Err(_) => {
                self.input_routing.pointer_cursor_touch_hide_generation = self
                    .input_routing
                    .pointer_cursor_touch_hide_generation
                    .wrapping_add(1)
            }
        }
    }

    pub(crate) fn pointer_cursor_touch_reveal_for_pointer_motion(&mut self) {
        self.input_routing.pointer_cursor_touch_hide_generation = self
            .input_routing
            .pointer_cursor_touch_hide_generation
            .wrapping_add(1);
        if let Some(token) = self.input_routing.pointer_cursor_touch_hide_token.take() {
            let _ = self.core.loop_handle.remove(token);
        }
        if self.input_routing.pointer_cursor_hidden_after_touch {
            self.input_routing.pointer_cursor_hidden_after_touch = false;
            self.pointer_cursor_touch_repaint();
        }
    }

    fn pointer_gesture_should_route_to_native(&mut self) -> bool {
        let Some(pointer) = self.input_routing.seat.get_pointer() else {
            return false;
        };
        if self.shell_move_is_active()
            || self.shell_resize_is_active()
            || self.shell_ui_pointer_grab_active()
        {
            return false;
        }
        let pos = pointer.current_location();
        self.sync_shell_shared_state_for_input();
        if self.shell_pointer_should_ipc_to_cef(pos) {
            return false;
        }
        let in_excl = self.point_in_shell_exclusion_zones(pos);
        let in_shell_ui = self.shell_ui_placement_topmost_for_input_at(pos).is_some();
        let under_native = self.native_surface_under_no_shell_exclusion(pos).is_some();
        under_native && !in_excl && !in_shell_ui
    }

    pub(crate) fn pointer_gesture_swipe_begin(&mut self, fingers: u32, time_msec: u32) {
        if !self.pointer_gesture_should_route_to_native() {
            return;
        }
        let pointer = self.input_routing.seat.get_pointer().unwrap();
        pointer.gesture_swipe_begin(
            self,
            &GestureSwipeBeginEvent {
                serial: SERIAL_COUNTER.next_serial(),
                time: time_msec,
                fingers,
            },
        );
        pointer.frame(self);
    }

    pub(crate) fn pointer_gesture_swipe_update(
        &mut self,
        delta: Point<f64, Logical>,
        time_msec: u32,
    ) {
        if !self.pointer_gesture_should_route_to_native() {
            return;
        }
        let pointer = self.input_routing.seat.get_pointer().unwrap();
        pointer.gesture_swipe_update(
            self,
            &GestureSwipeUpdateEvent {
                time: time_msec,
                delta,
            },
        );
        pointer.frame(self);
    }

    pub(crate) fn pointer_gesture_swipe_end(&mut self, cancelled: bool, time_msec: u32) {
        if !self.pointer_gesture_should_route_to_native() {
            return;
        }
        let pointer = self.input_routing.seat.get_pointer().unwrap();
        pointer.gesture_swipe_end(
            self,
            &GestureSwipeEndEvent {
                serial: SERIAL_COUNTER.next_serial(),
                time: time_msec,
                cancelled,
            },
        );
        pointer.frame(self);
    }

    pub(crate) fn pointer_gesture_pinch_begin(&mut self, fingers: u32, time_msec: u32) {
        if !self.pointer_gesture_should_route_to_native() {
            return;
        }
        let pointer = self.input_routing.seat.get_pointer().unwrap();
        pointer.gesture_pinch_begin(
            self,
            &GesturePinchBeginEvent {
                serial: SERIAL_COUNTER.next_serial(),
                time: time_msec,
                fingers,
            },
        );
        pointer.frame(self);
    }

    pub(crate) fn pointer_gesture_pinch_update(
        &mut self,
        delta: Point<f64, Logical>,
        scale: f64,
        rotation: f64,
        time_msec: u32,
    ) {
        if !self.pointer_gesture_should_route_to_native() {
            return;
        }
        let pointer = self.input_routing.seat.get_pointer().unwrap();
        pointer.gesture_pinch_update(
            self,
            &GesturePinchUpdateEvent {
                time: time_msec,
                delta,
                scale,
                rotation,
            },
        );
        pointer.frame(self);
    }

    pub(crate) fn pointer_gesture_pinch_end(&mut self, cancelled: bool, time_msec: u32) {
        if !self.pointer_gesture_should_route_to_native() {
            return;
        }
        let pointer = self.input_routing.seat.get_pointer().unwrap();
        pointer.gesture_pinch_end(
            self,
            &GesturePinchEndEvent {
                serial: SERIAL_COUNTER.next_serial(),
                time: time_msec,
                cancelled,
            },
        );
        pointer.frame(self);
    }

    pub(crate) fn pointer_gesture_hold_begin(&mut self, fingers: u32, time_msec: u32) {
        if !self.pointer_gesture_should_route_to_native() {
            return;
        }
        let pointer = self.input_routing.seat.get_pointer().unwrap();
        pointer.gesture_hold_begin(
            self,
            &GestureHoldBeginEvent {
                serial: SERIAL_COUNTER.next_serial(),
                time: time_msec,
                fingers,
            },
        );
        pointer.frame(self);
    }

    pub(crate) fn pointer_gesture_hold_end(&mut self, cancelled: bool, time_msec: u32) {
        if !self.pointer_gesture_should_route_to_native() {
            return;
        }
        let pointer = self.input_routing.seat.get_pointer().unwrap();
        pointer.gesture_hold_end(
            self,
            &GestureHoldEndEvent {
                serial: SERIAL_COUNTER.next_serial(),
                time: time_msec,
                cancelled,
            },
        );
        pointer.frame(self);
    }

    fn active_pointer_constraint(
        &self,
        pointer: &smithay::input::pointer::PointerHandle<Self>,
    ) -> Option<(
        WlSurface,
        Point<f64, Logical>,
        bool,
        Option<smithay::wayland::compositor::RegionAttributes>,
    )> {
        self.surface_under(pointer.current_location())
            .map(|(surface, _)| self.pointer_constraint_root_surface(&surface))
            .or_else(|| {
                pointer
                    .current_focus()
                    .map(|surface| self.pointer_constraint_root_surface(&surface))
            })
            .and_then(|surface| {
                let surface_loc = self.pointer_constraint_surface_origin(&surface)?;
                let mut state = None;
                with_pointer_constraint(&surface, pointer, |constraint| {
                    if let Some(constraint) = constraint {
                        if constraint.is_active() {
                            let locked = matches!(&*constraint, PointerConstraint::Locked(_));
                            state = Some((
                                surface.clone(),
                                surface_loc,
                                locked,
                                constraint.region().cloned(),
                            ));
                        }
                    }
                });
                state
            })
    }

    pub(crate) fn pointer_motion_relative(
        &mut self,
        delta: Point<f64, Logical>,
        delta_unaccel: Point<f64, Logical>,
        utime: u64,
        time_msec: u32,
    ) {
        self.pointer_cursor_touch_reveal_for_pointer_motion();
        let Some(ws) = self.workspace_logical_bounds() else {
            return;
        };
        let pointer = self.input_routing.seat.get_pointer().unwrap();
        let prev = pointer.current_location();
        let under = if pointer.is_grabbed()
            || self.shell_move_is_active()
            || self.shell_resize_is_active()
            || self.shell_ui_pointer_grab_active()
        {
            None
        } else {
            self.surface_under(prev)
        };

        pointer.relative_motion(
            self,
            under.clone(),
            &RelativeMotionEvent {
                delta,
                delta_unaccel,
                utime,
            },
        );

        let constraint = self.active_pointer_constraint(&pointer);

        if let Some((_surface, _surface_loc, true, _region)) = constraint {
            pointer.frame(self);
            return;
        }

        let mut pos = prev + delta;
        let min_x = ws.loc.x as f64;
        let min_y = ws.loc.y as f64;
        let max_x = (min_x + ws.size.w.max(0) as f64 - 1.0e-4).max(min_x);
        let max_y = (min_y + ws.size.h.max(0) as f64 - 1.0e-4).max(min_y);
        pos.x = pos.x.clamp(min_x, max_x);
        pos.y = pos.y.clamp(min_y, max_y);

        if let Some((surface, surface_loc, false, region)) = constraint {
            let point = (pos - surface_loc).to_i32_round();
            if region
                .as_ref()
                .is_some_and(|region| !region.contains(point))
            {
                pointer.frame(self);
                return;
            }
            let next_under = self.surface_under(pos);
            let same_surface = next_under
                .as_ref()
                .map(|(hit, _)| self.pointer_constraint_root_surface(hit))
                .is_some_and(|root| root == surface);
            if !same_surface {
                pointer.frame(self);
                return;
            }
        }

        let output = self
            .output_containing_global_point(pos)
            .or_else(|| self.leftmost_output())
            .unwrap();
        let output_geo = self.output_topology.space.output_geometry(&output).unwrap();
        let local = pos - output_geo.loc.to_f64();
        self.pointer_motion_output_local(output_geo, local, time_msec);
    }

    /// Logical pointer position **within the output** (`output_geo` from [`crate::state::CompositorState::space`]).
    pub(crate) fn pointer_motion_output_local(
        &mut self,
        output_geo: Rectangle<i32, Logical>,
        local: Point<f64, Logical>,
        time_msec: u32,
    ) {
        let pos = local + output_geo.loc.to_f64();
        let pointer = self.input_routing.seat.get_pointer().unwrap();
        let prev = pointer.current_location();
        let serial = SERIAL_COUNTER.next_serial();

        if self.screenshot_selection_active() {
            self.update_screenshot_selection_pointer(pos);
            pointer.motion(
                self,
                None,
                &MotionEvent {
                    location: pos,
                    serial,
                    time: time_msec,
                },
            );
            pointer.frame(self);
            return;
        }

        if let Some((surface, surface_loc, locked, region)) =
            self.active_pointer_constraint(&pointer)
        {
            if locked {
                pointer.frame(self);
                return;
            }
            let point = (pos - surface_loc).to_i32_round();
            if region
                .as_ref()
                .is_some_and(|region| !region.contains(point))
            {
                pointer.frame(self);
                return;
            }
            let next_under = self.surface_under(pos);
            let same_surface = next_under
                .as_ref()
                .map(|(hit, _)| self.pointer_constraint_root_surface(hit))
                .is_some_and(|root| root == surface);
            if !same_surface {
                pointer.frame(self);
                return;
            }
        }

        self.input_routing.shell_pointer_norm = self.shell_pointer_norm_from_global(pos);
        self.sync_shell_shared_state_for_input();
        let shell_toplevel_drag_window_id = self
            .input_routing
            .shell_toplevel_drag
            .map(|drag| drag.window_id);
        let client_move_window_id = self
            .input_routing
            .shell_move_client_initiated
            .then_some(self.input_routing.shell_move_window_id)
            .flatten();
        let under = if self.shell_resize_is_active() || self.shell_ui_pointer_grab_active() {
            None
        } else if let Some(window_id) = shell_toplevel_drag_window_id {
            self.surface_under_except_window_or_toplevel_bounds(pos, Some(window_id))
        } else if let Some(window_id) = client_move_window_id {
            self.surface_under_except_window(pos, Some(window_id))
        } else if self.shell_move_is_active() {
            None
        } else {
            self.surface_under(pos)
        };

        let dx = (pos.x - prev.x).round() as i32;
        let dy = (pos.y - prev.y).round() as i32;
        if dx != 0 || dy != 0 {
            if self.input_routing.shell_move_window_id.is_none()
                && !self.shell_ui_pointer_grab_active()
            {
                if let Some((window_id, start)) = self.input_routing.shell_backed_move_candidate {
                    let travel = ((pos.x - start.x).powi(2) + (pos.y - start.y).powi(2)).sqrt();
                    if travel >= 8.0 {
                        self.shell_move_begin(window_id);
                        self.input_routing.shell_backed_move_candidate = None;
                    }
                }
            }
        }

        let shell_toplevel_drag_active = self.input_routing.shell_toplevel_drag.is_some();
        if (dx != 0 || dy != 0) && shell_toplevel_drag_active {
            self.shell_toplevel_drag_update(pos);
        }

        pointer.motion(
            self,
            under,
            &MotionEvent {
                location: pos,
                serial,
                time: time_msec,
            },
        );
        pointer.frame(self);
        if let Some((surface, _surface_loc)) = self.surface_under_except_window(
            pos,
            shell_toplevel_drag_window_id.or(client_move_window_id),
        ) {
            self.pointer_constraint_maybe_activate(&surface, &pointer, pos);
        }
        if dx != 0 || dy != 0 {
            if !shell_toplevel_drag_active
                && self.shell_move_is_active()
                && self.shell_move_accepts_pointer_delta()
            {
                self.shell_move_delta(dx, dy);
            } else if self.input_routing.shell_move_deferred.is_some()
                && self.shell_move_accepts_pointer_delta()
            {
                self.shell_move_deferred_accumulate_delta(dx, dy);
            }
            if self.shell_resize_is_active() {
                self.shell_resize_delta(dx, dy);
            }
            if self.shell_move_is_active() || self.shell_resize_is_active() {
                self.shell_send_interaction_state_throttled();
            }
        }
        self.shell_ipc_maybe_forward_pointer_move(pos);
    }

    pub(crate) fn shell_seed_initial_pointer_position(&mut self) {
        if self.input_routing.shell_initial_pointer_centered {
            return;
        }
        let Some(output) = self.shell_effective_primary_output() else {
            return;
        };
        let Some(output_geo) = self.output_topology.space.output_geometry(&output) else {
            return;
        };
        if output_geo.size.w <= 0 || output_geo.size.h <= 0 {
            return;
        }
        self.input_routing.shell_initial_pointer_centered = true;
        self.pointer_motion_output_local(
            output_geo,
            Point::from((
                output_geo.size.w as f64 / 2.0,
                output_geo.size.h as f64 / 2.0,
            )),
            0,
        );
    }

    fn touch_workspace_local(
        &self,
        event: &impl AbsolutePositionEvent<LibinputInputBackend>,
        workspace_size: Size<i32, Logical>,
    ) -> Point<f64, Logical> {
        if self.input_routing.touch_abs_is_window_pixels {
            let (pw, ph) = self.shell_osr.shell_window_physical_px;
            let pw = pw.max(1) as f64;
            let ph = ph.max(1) as f64;
            let nx = (event.x() / pw).clamp(0.0, 1.0);
            let ny = (event.y() / ph).clamp(0.0, 1.0);
            Point::from((
                nx * workspace_size.w.max(1) as f64,
                ny * workspace_size.h.max(1) as f64,
            ))
        } else {
            event.position_transformed(workspace_size)
        }
    }

    fn touch_coordinate_geometry(&self, dev: &libinput::Device) -> Option<Rectangle<i32, Logical>> {
        if let Ok(override_name) = std::env::var("DERP_TOUCH_OUTPUT") {
            let override_name = override_name.trim();
            if !override_name.is_empty() {
                if let Some(out) = self
                    .output_topology
                    .space
                    .outputs()
                    .find(|o| o.name() == override_name)
                {
                    return self.output_topology.space.output_geometry(out);
                }
                tracing::warn!(
                    target: "derp_input",
                    name = %override_name,
                    "DERP_TOUCH_OUTPUT did not match a compositor output"
                );
            }
        }
        if let Some(n) = dev.output_name() {
            if let Some(out) = self.output_topology.space.outputs().find(|o| o.name() == n) {
                return self.output_topology.space.output_geometry(out);
            }
            if let Some(out) = self
                .output_topology
                .space
                .outputs()
                .find(|o| o.name().eq_ignore_ascii_case(&n))
            {
                return self.output_topology.space.output_geometry(out);
            }
            let names: Vec<String> = self
                .output_topology
                .space
                .outputs()
                .map(|o| o.name())
                .collect();
            tracing::warn!(
                target: "derp_input",
                libinput_output = %n,
                compositor_outputs = ?names,
                "touch output_name did not match; set DERP_TOUCH_OUTPUT"
            );
        }
        let n_out = self.output_topology.space.outputs().count();
        if n_out >= 2 && dev.output_name().is_none() {
            let left = self.leftmost_output()?;
            TOUCH_LEFTMOST_FALLBACK_LOG.get_or_init(|| {
                tracing::warn!(
                    target: "derp_input",
                    device = %dev.name(),
                    "touch has no libinput output_name; mapping to leftmost output (DERP_TOUCH_OUTPUT to pick another)"
                );
            });
            return self.output_topology.space.output_geometry(&left);
        }
        None
    }

    fn touch_global_point(
        &self,
        event: &(impl AbsolutePositionEvent<LibinputInputBackend> + Event<LibinputInputBackend>),
        workspace: Rectangle<i32, Logical>,
    ) -> Point<f64, Logical> {
        if self.input_routing.touch_abs_is_window_pixels {
            return workspace.loc.to_f64() + self.touch_workspace_local(event, workspace.size);
        }
        let dev: libinput::Device = event.device();
        if let Some(geo) = self.touch_coordinate_geometry(&dev) {
            return geo.loc.to_f64() + event.position_transformed(geo.size);
        }
        workspace.loc.to_f64() + event.position_transformed(workspace.size)
    }

    fn focus_native_window_for_touch(&mut self, pos: Point<f64, Logical>, serial: Serial) {
        let Some(keyboard) = self.input_routing.seat.get_keyboard() else {
            return;
        };
        self.shell_keyboard_capture_clear();
        let Some((elem, _loc)) = self.element_under_respecting_shell_exclusions(pos) else {
            return;
        };
        match elem {
            DerpSpaceElem::Wayland(window) => {
                let window_id = self
                    .windows
                    .window_registry
                    .window_id_for_wl_surface(window.toplevel().unwrap().wl_surface());
                self.output_topology.space.elements().for_each(|e| {
                    e.set_activate(false);
                    if let DerpSpaceElem::Wayland(w) = e {
                        w.toplevel().unwrap().send_pending_configure();
                    }
                });
                let _ = window.set_activated(true);
                self.output_topology
                    .space
                    .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
                keyboard.set_focus(
                    self,
                    Some(window.toplevel().unwrap().wl_surface().clone()),
                    serial,
                );
                if let Some(window_id) = window_id {
                    self.shell_window_stack_touch(window_id);
                    self.raise_shell_status_indicators();
                    self.shell_reply_window_list();
                }
                self.output_topology.space.elements().for_each(|e| {
                    if let DerpSpaceElem::Wayland(w) = e {
                        w.toplevel().unwrap().send_pending_configure();
                    }
                });
            }
            DerpSpaceElem::X11(x11) => {
                if let Some(surf) = x11.wl_surface() {
                    if !x11.is_override_redirect() {
                        let window_id =
                            self.windows.window_registry.window_id_for_wl_surface(&surf);
                        self.output_topology.space.elements().for_each(|e| {
                            e.set_activate(false);
                            if let DerpSpaceElem::Wayland(w) = e {
                                w.toplevel().unwrap().send_pending_configure();
                            }
                        });
                        self.output_topology
                            .space
                            .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
                        x11.set_activate(true);
                        keyboard.set_focus(self, Some(surf), serial);
                        if let Some(window_id) = window_id {
                            self.shell_window_stack_touch(window_id);
                            self.raise_shell_status_indicators();
                            self.shell_reply_window_list();
                        }
                        self.output_topology.space.elements().for_each(|e| {
                            if let DerpSpaceElem::Wayland(w) = e {
                                w.toplevel().unwrap().send_pending_configure();
                            }
                        });
                    }
                }
            }
        }
    }

    fn send_touch_to_cef(&mut self, slot: i32, phase: u32, pos: Point<f64, Logical>) {
        if !self.shell_osr.shell_has_frame || !self.shell_cef_active() {
            return;
        }
        if let Some((bx, by)) = self.shell_pointer_coords_for_cef(pos) {
            self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::Touch {
                touch_id: slot,
                phase,
                x: bx,
                y: by,
            });
        }
    }

    fn touch_output_geo_and_local(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(Rectangle<i32, Logical>, Point<f64, Logical>)> {
        let output = self
            .output_containing_global_point(pos)
            .or_else(|| self.leftmost_output())?;
        let output_geo = self.output_topology.space.output_geometry(&output)?;
        Some((output_geo, pos - output_geo.loc.to_f64()))
    }

    fn touch_update_pointer_position(&mut self, pos: Point<f64, Logical>, time_msec: u32) {
        if let Some((output_geo, local)) = self.touch_output_geo_and_local(pos) {
            self.pointer_motion_output_local(output_geo, local, time_msec);
        }
    }

    fn touch_route_for_down(&mut self, pos: Point<f64, Logical>) -> TouchRoute {
        self.sync_shell_shared_state_for_input();
        if self.screenshot_selection_active() {
            return TouchRoute::PointerEmulation { last_pos: pos };
        }
        let in_osk_fallback = self.point_in_osk_fallback_touch_area(pos);
        if self.shell_osr.shell_exclusion_overlay_open
            && !in_osk_fallback
            && !self.shell_point_in_shell_floating_overlay_global(pos)
            && !self.shell_pointer_route_to_cef(pos)
        {
            self.shell_dismiss_context_menu_from_compositor();
            self.sync_shell_shared_state_for_input();
        }
        let in_excl = self.point_in_shell_exclusion_zones(pos);
        let in_shell_ui = self.shell_ui_placement_topmost_for_input_at(pos).is_some();
        if !in_excl && !in_shell_ui && in_osk_fallback {
            if self.session_services.osk_shell_text_input_active {
                return TouchRoute::ShellOskKey { last_pos: pos };
            }
            return TouchRoute::PointerEmulation { last_pos: pos };
        }
        if !in_excl && !in_shell_ui {
            if let Some((_window_id, surface, surface_origin)) =
                self.native_surface_under_no_shell_exclusion(pos)
            {
                return TouchRoute::Native {
                    focus: surface,
                    surface_origin,
                };
            }
        }
        if self.shell_pointer_route_to_cef(pos)
            && self.shell_osr.shell_has_frame
            && self.shell_cef_active()
            && self.shell_pointer_coords_for_cef(pos).is_some()
        {
            TouchRoute::ShellCef { last_pos: pos }
        } else {
            TouchRoute::PointerEmulation { last_pos: pos }
        }
    }

    pub(crate) fn process_touch_down(
        &mut self,
        slot: TouchSlot,
        pos: Point<f64, Logical>,
        time_msec: u32,
    ) {
        self.pointer_cursor_touch_hide_arm();
        let slot_id = i32::from(slot);
        if self.input_routing.touch_routes.contains_key(&slot_id) {
            return;
        }
        let route = self.touch_route_for_down(pos);
        match &route {
            TouchRoute::Native {
                focus,
                surface_origin,
            } => {
                let serial = SERIAL_COUNTER.next_serial();
                self.allow_osk_for_touch_text_input_at(pos);
                self.focus_native_window_for_touch(pos, serial);
                if let Some(touch) = self.input_routing.seat.get_touch() {
                    touch.down(
                        self,
                        Some((focus.clone(), *surface_origin)),
                        &TouchDownEvent {
                            slot,
                            location: pos,
                            serial,
                            time: time_msec,
                        },
                    );
                    touch.frame(self);
                }
            }
            TouchRoute::ShellCef { .. } => {
                self.touch_update_pointer_position(pos, time_msec);
                self.send_touch_to_cef(slot_id, shell_wire::TOUCH_PHASE_PRESSED, pos);
                self.shell_keyboard_capture_shell_ui();
                self.shell_emit_shell_ui_focus_from_point(pos);
            }
            TouchRoute::ShellOskKey { .. } => {}
            TouchRoute::PointerEmulation { .. } => {
                if let Some((output_geo, local)) = self.touch_output_geo_and_local(pos) {
                    self.pointer_motion_output_local(output_geo, local, time_msec);
                    self.process_pointer_button(0x110, ButtonState::Pressed, time_msec);
                }
            }
        }
        self.input_routing.touch_routes.insert(slot_id, route);
    }

    pub(crate) fn process_touch_motion(
        &mut self,
        slot: TouchSlot,
        pos: Point<f64, Logical>,
        time_msec: u32,
    ) {
        self.pointer_cursor_touch_hide_arm();
        let slot_id = i32::from(slot);
        let Some(route) = self.input_routing.touch_routes.get(&slot_id).cloned() else {
            return;
        };
        match route {
            TouchRoute::Native {
                focus,
                surface_origin,
            } => {
                if let Some(touch) = self.input_routing.seat.get_touch() {
                    touch.motion(
                        self,
                        Some((focus, surface_origin)),
                        &TouchMotionEvent {
                            slot,
                            location: pos,
                            time: time_msec,
                        },
                    );
                    touch.frame(self);
                }
            }
            TouchRoute::ShellCef { .. } => {
                self.send_touch_to_cef(slot_id, shell_wire::TOUCH_PHASE_MOVED, pos);
                if self.shell_move_is_active()
                    || self.shell_resize_is_active()
                    || self.shell_ui_pointer_grab_active()
                {
                    self.touch_update_pointer_position(pos, time_msec);
                }
                self.input_routing
                    .touch_routes
                    .insert(slot_id, TouchRoute::ShellCef { last_pos: pos });
            }
            TouchRoute::ShellOskKey { .. } => {
                self.input_routing
                    .touch_routes
                    .insert(slot_id, TouchRoute::ShellOskKey { last_pos: pos });
            }
            TouchRoute::PointerEmulation { .. } => {
                if let Some((output_geo, local)) = self.touch_output_geo_and_local(pos) {
                    self.pointer_motion_output_local(output_geo, local, time_msec);
                    self.input_routing
                        .touch_routes
                        .insert(slot_id, TouchRoute::PointerEmulation { last_pos: pos });
                }
            }
        }
    }

    pub(crate) fn process_touch_up(&mut self, slot: TouchSlot, time_msec: u32) {
        self.pointer_cursor_touch_hide_arm();
        let slot_id = i32::from(slot);
        let Some(route) = self.input_routing.touch_routes.remove(&slot_id) else {
            return;
        };
        match route {
            TouchRoute::Native { .. } => {
                if let Some(touch) = self.input_routing.seat.get_touch() {
                    touch.up(
                        self,
                        &TouchUpEvent {
                            slot,
                            serial: SERIAL_COUNTER.next_serial(),
                            time: time_msec,
                        },
                    );
                    touch.frame(self);
                }
            }
            TouchRoute::ShellCef { last_pos } => {
                self.send_touch_to_cef(slot_id, shell_wire::TOUCH_PHASE_RELEASED, last_pos);
            }
            TouchRoute::ShellOskKey { last_pos } => {
                if let Some(ch) = self.shell_osk_key_for_point(last_pos) {
                    let text = ch.to_string();
                    let _ = self.shell_ipc_commit_text_to_cef(&text);
                }
            }
            TouchRoute::PointerEmulation { last_pos } => {
                if let Some((output_geo, local)) = self.touch_output_geo_and_local(last_pos) {
                    self.pointer_motion_output_local(output_geo, local, time_msec);
                }
                self.process_pointer_button(0x110, ButtonState::Released, time_msec);
            }
        }
    }

    pub(crate) fn process_touch_cancel(&mut self, slot: Option<TouchSlot>, time_msec: u32) {
        self.pointer_cursor_touch_hide_arm();
        let routes: Vec<(i32, TouchRoute)> = if let Some(slot) = slot {
            let slot_id = i32::from(slot);
            self.input_routing
                .touch_routes
                .remove(&slot_id)
                .map(|route| vec![(slot_id, route)])
                .unwrap_or_default()
        } else {
            self.input_routing.touch_routes.drain().collect()
        };
        let mut cancel_native = false;
        for (slot_id, route) in routes {
            match route {
                TouchRoute::Native { .. } => {
                    cancel_native = true;
                }
                TouchRoute::ShellCef { last_pos } => {
                    self.send_touch_to_cef(slot_id, shell_wire::TOUCH_PHASE_CANCELLED, last_pos);
                }
                TouchRoute::ShellOskKey { .. } => {}
                TouchRoute::PointerEmulation { last_pos } => {
                    if let Some((output_geo, local)) = self.touch_output_geo_and_local(last_pos) {
                        self.pointer_motion_output_local(output_geo, local, time_msec);
                    }
                    self.process_pointer_button(0x110, ButtonState::Released, time_msec);
                }
            }
        }
        if cancel_native {
            if let Some(touch) = self.input_routing.seat.get_touch() {
                touch.cancel(self);
                touch.frame(self);
            }
        }
    }

    pub(crate) fn process_touch_frame(&mut self) {
        if self
            .input_routing
            .touch_routes
            .values()
            .any(|route| matches!(route, TouchRoute::Native { .. }))
        {
            if let Some(touch) = self.input_routing.seat.get_touch() {
                touch.frame(self);
            }
        }
    }

    pub(crate) fn process_pointer_button(
        &mut self,
        button: u32,
        button_state: ButtonState,
        time_msec: u32,
    ) {
        match button_state {
            ButtonState::Pressed => {
                self.input_routing.pointer_pressed_buttons.insert(button);
            }
            ButtonState::Released => {
                self.input_routing.pointer_pressed_buttons.remove(&button);
            }
        }
        if self.input_routing.programs_menu_super_armed && button_state == ButtonState::Pressed {
            self.input_routing.programs_menu_super_chord = true;
        }
        if self.handle_screenshot_pointer_button(button, button_state) {
            let pointer = self.input_routing.seat.get_pointer().unwrap();
            let serial = SERIAL_COUNTER.next_serial();
            pointer.button(
                self,
                &ButtonEvent {
                    button,
                    state: button_state,
                    serial,
                    time: time_msec,
                },
            );
            pointer.frame(self);
            return;
        }
        let pointer = self.input_routing.seat.get_pointer().unwrap();
        let keyboard = self.input_routing.seat.get_keyboard().unwrap();

        let serial = SERIAL_COUNTER.next_serial();

        let pos = pointer.current_location();
        self.sync_shell_shared_state_for_input();
        let mut route_cef = self.shell_pointer_should_ipc_to_cef(pos);
        if button_state == ButtonState::Pressed
            && self.shell_osr.shell_exclusion_overlay_open
            && !self.shell_point_in_shell_floating_overlay_global(pos)
            && !route_cef
        {
            self.shell_dismiss_context_menu_from_compositor();
            route_cef = self.shell_pointer_should_ipc_to_cef(pos);
        }
        let norm = self
            .input_routing
            .shell_pointer_norm
            .or_else(|| self.shell_pointer_norm_from_global(pos));
        const BTN_LEFT: u32 = 0x110;

        let cef_ipc = self.shell_pointer_coords_for_cef(pos);
        let shell_px = if route_cef
            || self.shell_move_is_active()
            || self.shell_resize_is_active()
            || self.shell_ui_pointer_grab_active()
        {
            norm.and_then(|(nx, ny)| self.shell_pointer_buffer_pixels(nx, ny))
                .or_else(|| {
                    self.shell_pointer_norm_from_global(pos)
                        .and_then(|(nx, ny)| self.shell_pointer_buffer_pixels(nx, ny))
                })
        } else {
            None
        };
        let in_excl = self.point_in_shell_exclusion_zones(pos);
        let popup_grab_root = keyboard.current_focus().and_then(|focus| {
            self.popups
                .find_popup(&focus)
                .and_then(|popup| smithay::desktop::find_popup_root_surface(&popup).ok())
        });
        if popup_grab_root.is_some()
            && pointer.is_grabbed()
            && !self.shell_move_is_active()
            && !self.shell_resize_is_active()
            && !self.shell_ui_pointer_grab_active()
        {
            let keyboard_focus_root = popup_grab_root;
            pointer.motion(
                self,
                self.surface_under(pos),
                &MotionEvent {
                    location: pos,
                    serial: SERIAL_COUNTER.next_serial(),
                    time: time_msec,
                },
            );
            pointer.button(
                self,
                &ButtonEvent {
                    button,
                    state: button_state,
                    serial,
                    time: time_msec,
                },
            );
            pointer.frame(self);
            if !pointer.is_grabbed() && keyboard.is_grabbed() {
                keyboard.unset_grab(self);
                if let Some(root) = keyboard_focus_root {
                    keyboard.set_focus(self, Some(root), SERIAL_COUNTER.next_serial());
                }
            }
            return;
        }
        let shell_ui_hit_window_id = self
            .shell_ui_placement_topmost_for_input_at(pos)
            .map(|placement| placement.id);
        let in_shell_ui = shell_ui_hit_window_id.is_some();
        let native_hit = self.native_surface_under_no_shell_exclusion(pos);
        let under_native = native_hit.is_some();
        let force_native_buttons =
            under_native && !in_excl && !in_shell_ui && !self.shell_ui_pointer_grab_active();
        let preserve_native_shell_ui_focus = button_state == ButtonState::Pressed
            && !pointer.is_grabbed()
            && !self.shell_move_is_active()
            && !self.shell_resize_is_active()
            && shell_ui_hit_window_id
                .is_some_and(|window_id| !self.windows.window_registry.is_shell_hosted(window_id));
        let take_shell_base = shell_px.is_some()
            || (self.shell_cef_active() && route_cef && cef_ipc.is_some())
            || self.shell_move_is_active()
            || self.shell_resize_is_active()
            || (self.shell_cef_active()
                && self.shell_ui_pointer_grab_active()
                && cef_ipc.is_some());
        let take_shell = if force_native_buttons
            && !self.shell_move_is_active()
            && !self.shell_resize_is_active()
        {
            false
        } else {
            take_shell_base
        };
        tracing::debug!(
            target: "derp_input",
            button,
            ?button_state,
            pos_x = pos.x,
            pos_y = pos.y,
            route_cef,
            shell_norm = ?norm,
            force_native_buttons,
            take_shell,
            "PointerButton"
        );
        if take_shell {
            if ButtonState::Pressed == button_state && !pointer.is_grabbed() {
                if preserve_native_shell_ui_focus {
                    self.input_routing.shell_backed_move_candidate = self
                        .shell_backed_titlebar_window_at(pos)
                        .map(|window_id| (window_id, pos));
                } else {
                    self.output_topology.space.elements().for_each(|e| {
                        e.set_activate(false);
                        if let DerpSpaceElem::Wayland(w) = e {
                            w.toplevel().unwrap().send_pending_configure();
                        }
                    });
                    keyboard.set_focus(self, Option::<WlSurface>::None, serial);
                    self.keyboard_on_focus_surface_changed(None);
                    self.shell_keyboard_capture_shell_ui();
                    self.shell_emit_shell_ui_focus_from_point(pos);
                    if button == BTN_LEFT {
                        self.input_routing.shell_backed_move_candidate = self
                            .shell_backed_titlebar_window_at(pos)
                            .map(|window_id| (window_id, pos));
                    }
                }
            }
            if !in_shell_ui || (button_state == ButtonState::Released && pointer.is_grabbed()) {
                pointer.button(
                    self,
                    &ButtonEvent {
                        button,
                        state: button_state,
                        serial,
                        time: time_msec,
                    },
                );
                pointer.frame(self);
            }
            if (route_cef || self.shell_ui_pointer_grab_active()) && self.shell_cef_active() {
                if let Some((bx, by)) = cef_ipc {
                    if button_state == ButtonState::Pressed {
                        self.shell_keyboard_capture_shell_ui();
                    }
                    const BTN_RIGHT: u32 = 0x111;
                    const BTN_MIDDLE: u32 = 0x112;
                    let shell_btn = match button {
                        BTN_MIDDLE => 1u32,
                        BTN_RIGHT => 2u32,
                        _ => 0u32,
                    };
                    let mouse_up = button_state == ButtonState::Released;
                    let mod_flags = self.shell_cef_event_flags();
                    self.input_routing.shell_last_pointer_ipc_px = Some((bx, by));
                    self.shell_send_to_cef(
                        shell_wire::DecodedCompositorToShellMessage::PointerMove {
                            x: bx,
                            y: by,
                            modifiers: mod_flags,
                        },
                    );
                    self.shell_send_to_cef(
                        shell_wire::DecodedCompositorToShellMessage::PointerButton {
                            x: bx,
                            y: by,
                            button: shell_btn,
                            mouse_up,
                            titlebar_drag_window_id: 0,
                            modifiers: mod_flags,
                        },
                    );
                }
            }
            if button == BTN_LEFT && button_state == ButtonState::Released {
                self.input_routing.shell_backed_move_candidate = None;
                self.shell_resize_end_active();
                if let Some(window_id) = self
                    .input_routing
                    .shell_toplevel_drag_drop_pending_window_id
                    .take()
                {
                    self.shell_move_end(window_id);
                } else {
                    self.shell_move_end_active();
                }
                self.shell_ui_pointer_grab_end();
            }
            return;
        }

        if !pointer.is_grabbed() {
            let sync_serial = SERIAL_COUNTER.next_serial();
            let under = self.surface_under(pos);
            pointer.motion(
                self,
                under,
                &MotionEvent {
                    location: pos,
                    serial: sync_serial,
                    time: time_msec,
                },
            );
            pointer.frame(self);
        }

        if ButtonState::Pressed == button_state && !pointer.is_grabbed() {
            self.shell_keyboard_capture_clear();
            let pos = pointer.current_location();
            if let Some((elem, _loc)) = self.element_under_respecting_shell_exclusions(pos) {
                let shell_ui_focus = self
                    .derp_elem_window_id(&elem)
                    .filter(|wid| self.windows.window_registry.is_shell_hosted(*wid));
                if shell_ui_focus.is_some() {
                    self.shell_emit_shell_ui_focus_if_changed(shell_ui_focus);
                }
                match elem {
                    DerpSpaceElem::Wayland(window) => {
                        self.disallow_osk_for_pointer_text_input();
                        let window_id = self
                            .windows
                            .window_registry
                            .window_id_for_wl_surface(window.toplevel().unwrap().wl_surface());
                        self.output_topology.space.elements().for_each(|e| {
                            e.set_activate(false);
                            if let DerpSpaceElem::Wayland(w) = e {
                                w.toplevel().unwrap().send_pending_configure();
                            }
                        });
                        let _ = window.set_activated(true);
                        self.output_topology
                            .space
                            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
                        keyboard.set_focus(
                            self,
                            Some(window.toplevel().unwrap().wl_surface().clone()),
                            serial,
                        );
                        if let Some(window_id) = window_id {
                            self.shell_window_stack_touch(window_id);
                            self.raise_shell_status_indicators();
                            self.shell_reply_window_list();
                        }
                        self.output_topology.space.elements().for_each(|e| {
                            if let DerpSpaceElem::Wayland(w) = e {
                                w.toplevel().unwrap().send_pending_configure();
                            }
                        });
                    }
                    DerpSpaceElem::X11(x11) => {
                        if let Some(surf) = x11.wl_surface() {
                            if !x11.is_override_redirect() {
                                self.disallow_osk_for_pointer_text_input();
                                let window_id =
                                    self.windows.window_registry.window_id_for_wl_surface(&surf);
                                self.output_topology.space.elements().for_each(|e| {
                                    e.set_activate(false);
                                    if let DerpSpaceElem::Wayland(w) = e {
                                        w.toplevel().unwrap().send_pending_configure();
                                    }
                                });
                                self.output_topology
                                    .space
                                    .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
                                x11.set_activate(true);
                                keyboard.set_focus(self, Some(surf), serial);
                                if let Some(window_id) = window_id {
                                    self.shell_window_stack_touch(window_id);
                                    self.raise_shell_status_indicators();
                                    self.shell_reply_window_list();
                                }
                                self.output_topology.space.elements().for_each(|e| {
                                    if let DerpSpaceElem::Wayland(w) = e {
                                        w.toplevel().unwrap().send_pending_configure();
                                    }
                                });
                            }
                        }
                    }
                }
            } else {
                if self.upper_layer_surface_under(pos).is_none() {
                    self.shell_emit_shell_ui_focus_if_changed(None);
                    self.output_topology.space.elements().for_each(|e| {
                        e.set_activate(false);
                        if let DerpSpaceElem::Wayland(w) = e {
                            w.toplevel().unwrap().send_pending_configure();
                        }
                    });
                    keyboard.set_focus(self, Option::<WlSurface>::None, serial);
                    self.keyboard_on_focus_surface_changed(None);
                }
            }
        }

        pointer.button(
            self,
            &ButtonEvent {
                button,
                state: button_state,
                serial,
                time: time_msec,
            },
        );
        pointer.frame(self);
        if button == BTN_LEFT && button_state == ButtonState::Released {
            self.shell_resize_end_active();
            if let Some(window_id) = self
                .input_routing
                .shell_toplevel_drag_drop_pending_window_id
                .take()
            {
                self.shell_move_end(window_id);
            } else {
                self.shell_move_end_active();
            }
            self.shell_ui_pointer_grab_end();
        }
    }

    pub fn process_input_event(
        &mut self,
        event: InputEvent<LibinputInputBackend>,
        loop_handle: &LoopHandle<CalloopData>,
    ) {
        match event {
            InputEvent::Keyboard { event, .. } => {
                let serial = SERIAL_COUNTER.next_serial();
                let time = Event::time_msec(&event);
                let key_state = event.state();
                let keycode = event.key_code();
                let _ = self.keyboard_input_from_source(
                    "libinput",
                    keycode,
                    key_state,
                    serial,
                    time,
                    loop_handle,
                );
            }
            InputEvent::PointerMotion { event, .. } => {
                let pointer = self.input_routing.seat.get_pointer().unwrap();
                let d = event.delta();
                tracing::trace!(
                    target: "derp_input",
                    dx = d.x,
                    dy = d.y,
                    prev_x = pointer.current_location().x,
                    prev_y = pointer.current_location().y,
                    touch_window_px = self.input_routing.touch_abs_is_window_pixels,
                    "PointerMotion (relative)"
                );
                self.pointer_motion_relative(
                    d,
                    event.delta_unaccel(),
                    event.time(),
                    Event::time_msec(&event),
                );
            }
            InputEvent::PointerMotionAbsolute { event, .. } => {
                let dev: libinput::Device = event.device();
                if libinput_device_is_touchpad_like(&dev) {
                    return;
                }
                let Some(ws) = self.workspace_logical_bounds() else {
                    return;
                };
                let local_ws = event.position_transformed(ws.size);
                let pos = ws.loc.to_f64() + local_ws;
                let output = self
                    .output_containing_global_point(pos)
                    .or_else(|| self.leftmost_output())
                    .unwrap();
                let output_geo = self.output_topology.space.output_geometry(&output).unwrap();
                let local = pos - output_geo.loc.to_f64();
                tracing::trace!(
                    target: "derp_input",
                    raw_x = event.x(),
                    raw_y = event.y(),
                    local_x = local.x,
                    local_y = local.y,
                    touch_window_px = self.input_routing.touch_abs_is_window_pixels,
                    shell_pw = self.shell_osr.shell_window_physical_px.0,
                    shell_ph = self.shell_osr.shell_window_physical_px.1,
                    "PointerMotionAbsolute"
                );
                self.pointer_cursor_touch_reveal_for_pointer_motion();
                self.pointer_motion_output_local(output_geo, local, event.time_msec());
            }
            InputEvent::PointerButton { event, .. } => {
                self.process_pointer_button(event.button_code(), event.state(), event.time_msec());
            }
            InputEvent::TouchDown { event, .. } => {
                let dev: libinput::Device = event.device();
                if !libinput_device_is_screen_touch(&dev) {
                    return;
                }
                let Some(ws) = self.workspace_logical_bounds() else {
                    return;
                };
                let pos = self.touch_global_point(&event, ws);
                let time = Event::time_msec(&event);
                tracing::debug!(
                    target: "derp_input",
                    slot = ?event.slot(),
                    raw_x = event.x(),
                    raw_y = event.y(),
                    global_x = pos.x,
                    global_y = pos.y,
                    touch_window_px = self.input_routing.touch_abs_is_window_pixels,
                    shell_pw = self.shell_osr.shell_window_physical_px.0,
                    shell_ph = self.shell_osr.shell_window_physical_px.1,
                    "TouchDown"
                );
                self.process_touch_down(event.slot(), pos, time);
            }
            InputEvent::TouchMotion { event, .. } => {
                let dev: libinput::Device = event.device();
                if !libinput_device_is_screen_touch(&dev) {
                    return;
                }
                let Some(ws) = self.workspace_logical_bounds() else {
                    return;
                };
                let pos = self.touch_global_point(&event, ws);
                tracing::trace!(
                    target: "derp_input",
                    raw_x = event.x(),
                    raw_y = event.y(),
                    global_x = pos.x,
                    global_y = pos.y,
                    "TouchMotion"
                );
                self.process_touch_motion(event.slot(), pos, Event::time_msec(&event));
            }
            InputEvent::TouchUp { event, .. } => {
                let dev: libinput::Device = event.device();
                if !libinput_device_is_screen_touch(&dev) {
                    return;
                }
                tracing::debug!(target: "derp_input", slot = ?event.slot(), "TouchUp");
                self.process_touch_up(event.slot(), Event::time_msec(&event));
            }
            InputEvent::TouchCancel { event, .. } => {
                let dev: libinput::Device = event.device();
                if !libinput_device_is_screen_touch(&dev) {
                    return;
                }
                tracing::debug!(target: "derp_input", slot = ?event.slot(), "TouchCancel");
                self.process_touch_cancel(Some(event.slot()), Event::time_msec(&event));
            }
            InputEvent::TouchFrame { .. } => {
                self.process_touch_frame();
            }
            InputEvent::PointerAxis { event, .. } => {
                let source = event.source();

                let horizontal_amount = event.amount(Axis::Horizontal).unwrap_or_else(|| {
                    event.amount_v120(Axis::Horizontal).unwrap_or(0.0) * 15.0 / 120.
                });
                let vertical_amount = event.amount(Axis::Vertical).unwrap_or_else(|| {
                    event.amount_v120(Axis::Vertical).unwrap_or(0.0) * 15.0 / 120.
                });
                let horizontal_amount_discrete = event.amount_v120(Axis::Horizontal);
                let vertical_amount_discrete = event.amount_v120(Axis::Vertical);

                tracing::debug!(
                    target: "derp_input",
                    ?source,
                    horizontal_amount,
                    vertical_amount,
                    "PointerAxis"
                );

                let mut frame = AxisFrame::new(event.time_msec()).source(source);
                if horizontal_amount != 0.0 {
                    frame = frame.value(Axis::Horizontal, horizontal_amount);
                    if let Some(discrete) = horizontal_amount_discrete {
                        frame = frame.v120(Axis::Horizontal, discrete as i32);
                    }
                }
                if vertical_amount != 0.0 {
                    frame = frame.value(Axis::Vertical, vertical_amount);
                    if let Some(discrete) = vertical_amount_discrete {
                        frame = frame.v120(Axis::Vertical, discrete as i32);
                    }
                }

                if source == AxisSource::Finger {
                    if event.amount(Axis::Horizontal) == Some(0.0) {
                        frame = frame.stop(Axis::Horizontal);
                    }
                    if event.amount(Axis::Vertical) == Some(0.0) {
                        frame = frame.stop(Axis::Vertical);
                    }
                }

                let delta_x =
                    pointer_axis_to_cef_delta(horizontal_amount, horizontal_amount_discrete);
                let delta_y = pointer_axis_to_cef_delta(vertical_amount, vertical_amount_discrete);
                self.shell_ipc_maybe_forward_pointer_axis(delta_x, delta_y);

                let pointer = self.input_routing.seat.get_pointer().unwrap();
                pointer.axis(self, frame);
                pointer.frame(self);
            }
            InputEvent::GestureSwipeBegin { event, .. } => {
                self.pointer_gesture_swipe_begin(event.fingers(), event.time_msec());
            }
            InputEvent::GestureSwipeUpdate { event, .. } => {
                self.pointer_gesture_swipe_update(event.delta(), event.time_msec());
            }
            InputEvent::GestureSwipeEnd { event, .. } => {
                self.pointer_gesture_swipe_end(event.cancelled(), event.time_msec());
            }
            InputEvent::GesturePinchBegin { event, .. } => {
                self.pointer_gesture_pinch_begin(event.fingers(), event.time_msec());
            }
            InputEvent::GesturePinchUpdate { event, .. } => {
                self.pointer_gesture_pinch_update(
                    event.delta(),
                    event.scale(),
                    event.rotation(),
                    event.time_msec(),
                );
            }
            InputEvent::GesturePinchEnd { event, .. } => {
                self.pointer_gesture_pinch_end(event.cancelled(), event.time_msec());
            }
            InputEvent::GestureHoldBegin { event, .. } => {
                self.pointer_gesture_hold_begin(event.fingers(), event.time_msec());
            }
            InputEvent::GestureHoldEnd { event, .. } => {
                self.pointer_gesture_hold_end(event.cancelled(), event.time_msec());
            }
            _ => {
                tracing::trace!(
                    target: "derp_input",
                    "unhandled InputEvent (Tablet*, Switch*, …); try RUST_LOG=derp_input=trace"
                );
            }
        }
    }
}
