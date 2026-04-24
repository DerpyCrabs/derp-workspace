use std::sync::OnceLock;

use input as libinput;
use smithay::backend::libinput::LibinputInputBackend;
use smithay::desktop::space::SpaceElement;
use smithay::{
    backend::{
        input::{
            AbsolutePositionEvent, Axis, AxisSource, ButtonState, Event, InputEvent, KeyState,
            KeyboardKeyEvent, PointerAxisEvent, PointerButtonEvent, PointerMotionEvent, TouchEvent,
        },
        session::Session,
    },
    input::{
        keyboard::{keysyms, FilterResult},
        pointer::{AxisFrame, ButtonEvent, MotionEvent},
    },
    reexports::{calloop::LoopHandle, wayland_server::protocol::wl_surface::WlSurface},
    utils::{Logical, Point, Rectangle, Size, SERIAL_COUNTER},
    wayland::keyboard_shortcuts_inhibit::KeyboardShortcutsInhibitorSeat,
};

use crate::{derp_space::DerpSpaceElem, state::CompositorState, CalloopData};

static TOUCH_LEFTMOST_FALLBACK_LOG: OnceLock<()> = OnceLock::new();

#[allow(non_upper_case_globals)]
pub(crate) fn super_keybind_action(raw_sym: u32, ctrl: bool, shift: bool) -> Option<&'static str> {
    use keysyms::*;
    if ctrl {
        return match raw_sym {
            KEY_s | KEY_S => Some("screenshot_current_output"),
            _ => None,
        };
    }
    if shift {
        return match raw_sym {
            KEY_s | KEY_S => Some("screenshot_region"),
            KEY_Left => Some("move_monitor_left"),
            KEY_Right => Some("move_monitor_right"),
            _ => None,
        };
    }
    match raw_sym {
        KEY_space => Some("cycle_keyboard_layout"),
        KEY_comma => Some("open_settings"),
        KEY_Return | KEY_KP_Enter => Some("launch_terminal"),
        KEY_q | KEY_Q => Some("close_focused"),
        KEY_d | KEY_D => Some("toggle_programs_menu"),
        KEY_f | KEY_F => Some("toggle_fullscreen"),
        KEY_m | KEY_M => Some("toggle_maximize"),
        KEY_bracketleft => Some("tab_previous"),
        KEY_bracketright => Some("tab_next"),
        KEY_Left => Some("tile_left"),
        KEY_Right => Some("tile_right"),
        KEY_Up => Some("tile_up"),
        KEY_Down => Some("tile_down"),
        _ => None,
    }
}

pub(crate) fn keysym_is_super(keysym: &smithay::input::keyboard::KeysymHandle<'_>) -> bool {
    keysym.raw_syms().into_iter().any(|sym| {
        matches!(
            sym.raw(),
            keysyms::KEY_Super_L | keysyms::KEY_Super_R | keysyms::KEY_Meta_L | keysyms::KEY_Meta_R
        )
    })
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
    /// Logical pointer position **within the output** (`output_geo` from [`crate::state::CompositorState::space`]).
    pub(crate) fn pointer_motion_output_local(
        &mut self,
        output_geo: Rectangle<i32, Logical>,
        local: Point<f64, Logical>,
        time_msec: u32,
    ) {
        let pos = local + output_geo.loc.to_f64();
        self.shell_pointer_norm = self.shell_pointer_norm_from_global(pos);
        let pointer = self.seat.get_pointer().unwrap();
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

        self.sync_shell_shared_state_for_input();
        let grabbed = pointer.is_grabbed();

        let under = if grabbed
            || self.shell_move_is_active()
            || self.shell_resize_is_active()
            || self.shell_ui_pointer_grab_active()
        {
            None
        } else {
            self.surface_under(pos)
        };

        let dx = (pos.x - prev.x).round() as i32;
        let dy = (pos.y - prev.y).round() as i32;
        if dx != 0 || dy != 0 {
            if self.programs_menu_super_armed
                && (grabbed
                    || self.shell_move_is_active()
                    || self.shell_resize_is_active()
                    || self.shell_ui_pointer_grab_active()
                    || self.shell_backed_move_candidate.is_some())
            {
                self.programs_menu_super_chord = true;
            }
            self.shell_begin_frame_note_shell_input();
            if self.shell_move_window_id.is_none() && !self.shell_ui_pointer_grab_active() {
                if let Some((window_id, start)) = self.shell_backed_move_candidate {
                    let travel = ((pos.x - start.x).powi(2) + (pos.y - start.y).powi(2)).sqrt();
                    if travel >= 8.0 {
                        self.shell_move_begin(window_id);
                        self.shell_backed_move_candidate = None;
                    }
                }
            }
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
        if dx != 0 || dy != 0 {
            if self.shell_move_is_active() {
                self.shell_move_delta(dx, dy);
            } else if self.shell_move_deferred.is_some() {
                self.shell_move_deferred_accumulate_delta(dx, dy);
            }
            if self.shell_resize_is_active() {
                self.shell_resize_delta(dx, dy);
            }
            if self.shell_move_is_active() || self.shell_resize_is_active() {
                self.shell_send_interaction_state();
            }
        }
        self.shell_ipc_maybe_forward_pointer_move(pos);
    }

    pub(crate) fn shell_seed_initial_pointer_position(&mut self) {
        if self.shell_initial_pointer_centered {
            return;
        }
        let Some(output) = self.shell_effective_primary_output() else {
            return;
        };
        let Some(output_geo) = self.space.output_geometry(&output) else {
            return;
        };
        if output_geo.size.w <= 0 || output_geo.size.h <= 0 {
            return;
        }
        self.shell_initial_pointer_centered = true;
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
        if self.touch_abs_is_window_pixels {
            let (pw, ph) = self.shell_window_physical_px;
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
                if let Some(out) = self.space.outputs().find(|o| o.name() == override_name) {
                    return self.space.output_geometry(out);
                }
                tracing::warn!(
                    target: "derp_input",
                    name = %override_name,
                    "DERP_TOUCH_OUTPUT did not match a compositor output"
                );
            }
        }
        if let Some(n) = dev.output_name() {
            if let Some(out) = self.space.outputs().find(|o| o.name() == n) {
                return self.space.output_geometry(out);
            }
            if let Some(out) = self
                .space
                .outputs()
                .find(|o| o.name().eq_ignore_ascii_case(&n))
            {
                return self.space.output_geometry(out);
            }
            let names: Vec<String> = self.space.outputs().map(|o| o.name()).collect();
            tracing::warn!(
                target: "derp_input",
                libinput_output = %n,
                compositor_outputs = ?names,
                "touch output_name did not match; set DERP_TOUCH_OUTPUT"
            );
        }
        let n_out = self.space.outputs().count();
        if n_out >= 2 && dev.output_name().is_none() {
            let left = self.leftmost_output()?;
            TOUCH_LEFTMOST_FALLBACK_LOG.get_or_init(|| {
                tracing::warn!(
                    target: "derp_input",
                    device = %dev.name(),
                    "touch has no libinput output_name; mapping to leftmost output (DERP_TOUCH_OUTPUT to pick another)"
                );
            });
            return self.space.output_geometry(&left);
        }
        None
    }

    fn touch_global_point(
        &self,
        event: &(impl AbsolutePositionEvent<LibinputInputBackend> + Event<LibinputInputBackend>),
        workspace: Rectangle<i32, Logical>,
    ) -> Point<f64, Logical> {
        if self.touch_abs_is_window_pixels {
            return workspace.loc.to_f64() + self.touch_workspace_local(event, workspace.size);
        }
        let dev: libinput::Device = event.device();
        if let Some(geo) = self.touch_coordinate_geometry(&dev) {
            return geo.loc.to_f64() + event.position_transformed(geo.size);
        }
        workspace.loc.to_f64() + event.position_transformed(workspace.size)
    }

    pub(crate) fn process_pointer_button(
        &mut self,
        button: u32,
        button_state: ButtonState,
        time_msec: u32,
    ) {
        if self.programs_menu_super_armed {
            self.programs_menu_super_chord = true;
        }
        self.shell_begin_frame_note_shell_input();
        if self.handle_screenshot_pointer_button(button, button_state) {
            let pointer = self.seat.get_pointer().unwrap();
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
        let pointer = self.seat.get_pointer().unwrap();
        let keyboard = self.seat.get_keyboard().unwrap();

        let serial = SERIAL_COUNTER.next_serial();

        let pos = pointer.current_location();
        self.sync_shell_shared_state_for_input();
        let mut route_cef = self.shell_pointer_should_ipc_to_cef(pos);
        if button_state == ButtonState::Pressed
            && self.shell_exclusion_overlay_open
            && !self.shell_point_in_shell_floating_overlay_global(pos)
            && !route_cef
        {
            self.shell_dismiss_context_menu_from_compositor();
            route_cef = self.shell_pointer_should_ipc_to_cef(pos);
        }
        let norm = self
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
                .is_some_and(|window_id| !self.window_registry.is_shell_hosted(window_id));
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
                    self.shell_backed_move_candidate = self
                        .shell_backed_titlebar_window_at(pos)
                        .map(|window_id| (window_id, pos));
                } else {
                    self.space.elements().for_each(|e| {
                        e.set_activate(false);
                        if let DerpSpaceElem::Wayland(w) = e {
                            w.toplevel().unwrap().send_pending_configure();
                        }
                    });
                    keyboard.set_focus(self, Option::<WlSurface>::None, serial);
                    self.keyboard_on_focus_surface_changed(None);
                    self.shell_ipc_keyboard_to_cef = true;
                    self.shell_emit_shell_ui_focus_from_point(pos);
                    if button == BTN_LEFT {
                        self.shell_backed_move_candidate = self
                            .shell_backed_titlebar_window_at(pos)
                            .map(|window_id| (window_id, pos));
                    }
                }
            }
            if !in_shell_ui {
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
                        self.shell_ipc_keyboard_to_cef = true;
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
                    self.shell_last_pointer_ipc_px = Some((bx, by));
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
                self.shell_backed_move_candidate = None;
                self.shell_resize_end_active();
                self.shell_move_end_active();
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
            self.shell_ipc_keyboard_to_cef = false;
            let pos = pointer.current_location();
            if let Some((elem, _loc)) = self.element_under_respecting_shell_exclusions(pos) {
                let shell_ui_focus = self
                    .derp_elem_window_id(&elem)
                    .filter(|wid| self.window_registry.is_shell_hosted(*wid));
                if shell_ui_focus.is_some() {
                    self.shell_emit_shell_ui_focus_if_changed(shell_ui_focus);
                }
                match elem {
                    DerpSpaceElem::Wayland(window) => {
                        let window_id = self
                            .window_registry
                            .window_id_for_wl_surface(window.toplevel().unwrap().wl_surface());
                        self.space.elements().for_each(|e| {
                            e.set_activate(false);
                            if let DerpSpaceElem::Wayland(w) = e {
                                w.toplevel().unwrap().send_pending_configure();
                            }
                        });
                        let _ = window.set_activated(true);
                        self.space
                            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
                        keyboard.set_focus(
                            self,
                            Some(window.toplevel().unwrap().wl_surface().clone()),
                            serial,
                        );
                        if let Some(window_id) = window_id {
                            self.shell_window_stack_touch(window_id);
                            self.shell_reply_window_list();
                        }
                        self.space.elements().for_each(|e| {
                            if let DerpSpaceElem::Wayland(w) = e {
                                w.toplevel().unwrap().send_pending_configure();
                            }
                        });
                    }
                    DerpSpaceElem::X11(x11) => {
                        if let Some(surf) = x11.wl_surface() {
                            if !x11.is_override_redirect() {
                                let window_id =
                                    self.window_registry.window_id_for_wl_surface(&surf);
                                self.space.elements().for_each(|e| {
                                    e.set_activate(false);
                                    if let DerpSpaceElem::Wayland(w) = e {
                                        w.toplevel().unwrap().send_pending_configure();
                                    }
                                });
                                self.space
                                    .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
                                x11.set_activate(true);
                                keyboard.set_focus(self, Some(surf), serial);
                                if let Some(window_id) = window_id {
                                    self.shell_window_stack_touch(window_id);
                                    self.shell_reply_window_list();
                                }
                                self.space.elements().for_each(|e| {
                                    if let DerpSpaceElem::Wayland(w) = e {
                                        w.toplevel().unwrap().send_pending_configure();
                                    }
                                });
                            }
                        }
                    }
                }
            } else {
                self.shell_emit_shell_ui_focus_if_changed(None);
                self.space.elements().for_each(|e| {
                    e.set_activate(false);
                    if let DerpSpaceElem::Wayland(w) = e {
                        w.toplevel().unwrap().send_pending_configure();
                    }
                });
                keyboard.set_focus(self, Option::<WlSurface>::None, serial);
                self.keyboard_on_focus_surface_changed(None);
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
            self.shell_move_end_active();
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
                let keyboard = self.seat.get_keyboard().unwrap();
                let is_autorepeat =
                    key_state == KeyState::Pressed && keyboard.pressed_keys().contains(&keycode);

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
                        if state.screenshot_selection_active() {
                            if key_state == KeyState::Released && is_super {
                                state.programs_menu_super_armed = false;
                                state.programs_menu_super_chord = false;
                            }
                            if matches!(raw_sym, keysyms::KEY_Escape)
                                && key_state == KeyState::Pressed
                            {
                                state.cancel_screenshot_selection_mode();
                            }
                            return FilterResult::Intercept(());
                        }
                        if key_state == KeyState::Pressed {
                            if mods.ctrl && mods.alt {
                                if let (Some(vt), Some(ref mut sess)) =
                                    (vt_number_from_fkey(raw_sym), state.vt_session.as_mut())
                                {
                                    if let Err(e) = sess.change_vt(vt) {
                                        tracing::warn!(?e, vt, "VT switch (Ctrl+Alt+F) failed");
                                    }
                                    return FilterResult::Intercept(());
                                }
                            }
                            if mods.ctrl
                                && mods.shift
                                && matches!(raw_sym, keysyms::KEY_q | keysyms::KEY_Q)
                                && !state.seat.keyboard_shortcuts_inhibited()
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
                        if key_state == KeyState::Pressed {
                            if is_super && !state.seat.keyboard_shortcuts_inhibited() {
                                tracing::warn!(
                                    target: "derp_shell_menu",
                                    source = "libinput",
                                    key_state = "pressed",
                                    raw_sym,
                                    shell_cef_active = state.shell_cef_active(),
                                    shell_has_frame = state.shell_has_frame,
                                    shell_ipc_keyboard_to_cef = state.shell_ipc_keyboard_to_cef,
                                    pending_toggle = state.programs_menu_super_pending_toggle,
                                    "super key pressed"
                                );
                                state.programs_menu_super_armed = true;
                                state.programs_menu_super_chord = false;
                                return FilterResult::Intercept(());
                            }
                            if state.programs_menu_super_armed
                                && !is_super
                                && !state.seat.keyboard_shortcuts_inhibited()
                            {
                                let scratchpad_action = state.scratchpad_action_for_super_chord(
                                    raw_sym, mods.ctrl, mods.shift,
                                );
                                if let Some(action) = scratchpad_action.as_deref().or_else(|| {
                                    super_keybind_action(raw_sym, mods.ctrl, mods.shift)
                                }) {
                                    tracing::warn!(
                                        target: "derp_shell_menu",
                                        source = "libinput",
                                        %action,
                                        raw_sym,
                                        shell_cef_active = state.shell_cef_active(),
                                        shell_has_frame = state.shell_has_frame,
                                        shell_ipc_keyboard_to_cef = state.shell_ipc_keyboard_to_cef,
                                        pending_toggle = state.programs_menu_super_pending_toggle,
                                        "super chord matched action"
                                    );
                                    state.programs_menu_super_chord = true;
                                    if state.shell_cef_active() {
                                        state.handle_super_keybind(action);
                                    }
                                    return FilterResult::Intercept(());
                                }
                                state.programs_menu_super_chord = true;
                                return FilterResult::Intercept(());
                            }
                        } else if key_state == KeyState::Released
                            && is_super
                            && !state.seat.keyboard_shortcuts_inhibited()
                        {
                            let armed = state.programs_menu_super_armed;
                            let chord = state.programs_menu_super_chord;
                            tracing::warn!(
                                target: "derp_shell_menu",
                                source = "libinput",
                                key_state = "released",
                                raw_sym,
                                armed,
                                chord,
                                shell_cef_active = state.shell_cef_active(),
                                shell_has_frame = state.shell_has_frame,
                                shell_ipc_keyboard_to_cef = state.shell_ipc_keyboard_to_cef,
                                pending_toggle = state.programs_menu_super_pending_toggle,
                                "super key released"
                            );
                            state.programs_menu_super_armed = false;
                            state.programs_menu_super_chord = false;
                            if armed && !chord {
                                if state.shell_cef_active() {
                                    state.programs_menu_toggle_from_super(serial);
                                } else {
                                    tracing::warn!(
                                        target: "derp_shell_menu",
                                        source = "libinput",
                                        "queue pending launcher toggle until shell load success"
                                    );
                                    state.programs_menu_super_pending_toggle = true;
                                }
                                return FilterResult::Intercept(());
                            }
                        }
                        if state.shell_ipc_keyboard_to_cef
                            && state.shell_cef_active()
                            && state.shell_has_frame
                        {
                            if key_state == KeyState::Pressed && is_autorepeat {
                                return FilterResult::Intercept(());
                            }
                            if key_state == KeyState::Released {
                                if state.shell_cef_repeat_keycode == Some(keycode) {
                                    state.shell_cef_repeat_clear(&lh_kbd);
                                }
                                state.shell_ipc_forward_keyboard_to_cef(
                                    key_state, mods, &keysym, false,
                                );
                                state.shell_ipc_refresh_pointer_modifiers();
                                return FilterResult::Intercept(());
                            }
                            state
                                .shell_ipc_forward_keyboard_to_cef(key_state, mods, &keysym, false);
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
            }
            InputEvent::PointerMotion { event, .. } => {
                let Some(ws) = self.workspace_logical_bounds() else {
                    return;
                };
                let pointer = self.seat.get_pointer().unwrap();
                let d = event.delta();
                tracing::trace!(
                    target: "derp_input",
                    dx = d.x,
                    dy = d.y,
                    prev_x = pointer.current_location().x,
                    prev_y = pointer.current_location().y,
                    touch_window_px = self.touch_abs_is_window_pixels,
                    "PointerMotion (relative)"
                );
                let mut pos = pointer.current_location() + event.delta();
                let min_x = ws.loc.x as f64;
                let min_y = ws.loc.y as f64;
                let max_x = (min_x + ws.size.w.max(0) as f64 - 1.0e-4).max(min_x);
                let max_y = (min_y + ws.size.h.max(0) as f64 - 1.0e-4).max(min_y);
                pos.x = pos.x.clamp(min_x, max_x);
                pos.y = pos.y.clamp(min_y, max_y);
                let output = self
                    .output_containing_global_point(pos)
                    .or_else(|| self.leftmost_output())
                    .unwrap();
                let output_geo = self.space.output_geometry(&output).unwrap();
                let local = pos - output_geo.loc.to_f64();
                tracing::trace!(
                    target: "derp_input",
                    clamped_x = pos.x,
                    clamped_y = pos.y,
                    local_x = local.x,
                    local_y = local.y,
                    out_w = output_geo.size.w,
                    out_h = output_geo.size.h,
                    "PointerMotion → logical"
                );
                self.pointer_motion_output_local(output_geo, local, Event::time_msec(&event));
            }
            InputEvent::PointerMotionAbsolute { event, .. } => {
                let Some(ws) = self.workspace_logical_bounds() else {
                    return;
                };
                let local_ws = event.position_transformed(ws.size);
                let pos = ws.loc.to_f64() + local_ws;
                let output = self
                    .output_containing_global_point(pos)
                    .or_else(|| self.leftmost_output())
                    .unwrap();
                let output_geo = self.space.output_geometry(&output).unwrap();
                let local = pos - output_geo.loc.to_f64();
                tracing::trace!(
                    target: "derp_input",
                    raw_x = event.x(),
                    raw_y = event.y(),
                    local_x = local.x,
                    local_y = local.y,
                    touch_window_px = self.touch_abs_is_window_pixels,
                    shell_pw = self.shell_window_physical_px.0,
                    shell_ph = self.shell_window_physical_px.1,
                    "PointerMotionAbsolute"
                );
                self.pointer_motion_output_local(output_geo, local, event.time_msec());
            }
            InputEvent::PointerButton { event, .. } => {
                self.process_pointer_button(event.button_code(), event.state(), event.time_msec());
            }
            InputEvent::TouchDown { event, .. } => {
                if self.touch_emulation_slot.is_some() {
                    tracing::debug!(
                        target: "derp_input",
                        slot = ?event.slot(),
                        "TouchDown ignored (first finger still active)"
                    );
                    return;
                }
                let Some(ws) = self.workspace_logical_bounds() else {
                    return;
                };
                self.touch_emulation_slot = Some(event.slot());
                let pos = self.touch_global_point(&event, ws);
                if self.shell_exclusion_overlay_open
                    && !self.shell_point_in_shell_floating_overlay_global(pos)
                    && !self.shell_pointer_route_to_cef(pos)
                {
                    self.shell_dismiss_context_menu_from_compositor();
                }
                let output = self
                    .output_containing_global_point(pos)
                    .or_else(|| self.leftmost_output())
                    .unwrap();
                let output_geo = self.space.output_geometry(&output).unwrap();
                let local = pos - output_geo.loc.to_f64();
                let time = Event::time_msec(&event);
                self.sync_shell_shared_state_for_input();
                let cef_touch = self.shell_pointer_route_to_cef(pos)
                    && self.shell_has_frame
                    && self.shell_cef_active()
                    && self.shell_pointer_coords_for_cef(pos).is_some();
                self.touch_routes_to_cef = cef_touch;
                tracing::debug!(
                    target: "derp_input",
                    slot = ?event.slot(),
                    raw_x = event.x(),
                    raw_y = event.y(),
                    local_x = local.x,
                    local_y = local.y,
                    touch_window_px = self.touch_abs_is_window_pixels,
                    shell_pw = self.shell_window_physical_px.0,
                    shell_ph = self.shell_window_physical_px.1,
                    cef_touch,
                    "TouchDown"
                );
                self.pointer_motion_output_local(output_geo, local, time);
                if cef_touch {
                    self.shell_begin_frame_note_shell_input();
                    if let Some((bx, by)) = self.shell_pointer_coords_for_cef(pos) {
                        let tid = i32::from(event.slot());
                        self.shell_send_to_cef(
                            shell_wire::DecodedCompositorToShellMessage::Touch {
                                touch_id: tid,
                                phase: shell_wire::TOUCH_PHASE_PRESSED,
                                x: bx,
                                y: by,
                            },
                        );
                    }
                    self.shell_ipc_keyboard_to_cef = true;
                    self.shell_emit_shell_ui_focus_from_point(pos);
                } else {
                    self.process_pointer_button(0x110, ButtonState::Pressed, time);
                }
            }
            InputEvent::TouchMotion { event, .. } => {
                if self.touch_emulation_slot != Some(event.slot()) {
                    tracing::debug!(
                        target: "derp_input",
                        active = ?self.touch_emulation_slot,
                        slot = ?event.slot(),
                        "TouchMotion ignored (wrong slot)"
                    );
                    return;
                }
                let Some(ws) = self.workspace_logical_bounds() else {
                    return;
                };
                let pos = self.touch_global_point(&event, ws);
                let output = self
                    .output_containing_global_point(pos)
                    .or_else(|| self.leftmost_output())
                    .unwrap();
                let output_geo = self.space.output_geometry(&output).unwrap();
                let local = pos - output_geo.loc.to_f64();
                tracing::trace!(
                    target: "derp_input",
                    raw_x = event.x(),
                    raw_y = event.y(),
                    local_x = local.x,
                    local_y = local.y,
                    "TouchMotion"
                );
                self.pointer_motion_output_local(output_geo, local, Event::time_msec(&event));
                if self.touch_routes_to_cef {
                    self.shell_begin_frame_note_shell_input();
                    if let Some((bx, by)) = self.shell_pointer_coords_for_cef(pos) {
                        let tid = i32::from(event.slot());
                        self.shell_send_to_cef(
                            shell_wire::DecodedCompositorToShellMessage::Touch {
                                touch_id: tid,
                                phase: shell_wire::TOUCH_PHASE_MOVED,
                                x: bx,
                                y: by,
                            },
                        );
                    }
                }
            }
            InputEvent::TouchUp { event, .. } => {
                if self.touch_emulation_slot != Some(event.slot()) {
                    tracing::debug!(
                        target: "derp_input",
                        active = ?self.touch_emulation_slot,
                        slot = ?event.slot(),
                        "TouchUp ignored (wrong slot)"
                    );
                    return;
                }
                tracing::debug!(target: "derp_input", slot = ?event.slot(), "TouchUp");
                let time = Event::time_msec(&event);
                let pos = self.seat.get_pointer().unwrap().current_location();
                if self.touch_routes_to_cef {
                    self.shell_begin_frame_note_shell_input();
                    if let Some((bx, by)) = self.shell_pointer_coords_for_cef(pos) {
                        let tid = i32::from(event.slot());
                        self.shell_send_to_cef(
                            shell_wire::DecodedCompositorToShellMessage::Touch {
                                touch_id: tid,
                                phase: shell_wire::TOUCH_PHASE_RELEASED,
                                x: bx,
                                y: by,
                            },
                        );
                    }
                } else {
                    self.process_pointer_button(0x110, ButtonState::Released, time);
                }
                self.touch_emulation_slot = None;
                self.touch_routes_to_cef = false;
            }
            InputEvent::TouchCancel { event, .. } => {
                if self.touch_emulation_slot != Some(event.slot()) {
                    tracing::debug!(
                        target: "derp_input",
                        active = ?self.touch_emulation_slot,
                        slot = ?event.slot(),
                        "TouchCancel ignored (wrong slot)"
                    );
                    return;
                }
                tracing::debug!(target: "derp_input", slot = ?event.slot(), "TouchCancel");
                let time = Event::time_msec(&event);
                let pos = self.seat.get_pointer().unwrap().current_location();
                if self.touch_routes_to_cef {
                    self.shell_begin_frame_note_shell_input();
                    if let Some((bx, by)) = self.shell_pointer_coords_for_cef(pos) {
                        let tid = i32::from(event.slot());
                        self.shell_send_to_cef(
                            shell_wire::DecodedCompositorToShellMessage::Touch {
                                touch_id: tid,
                                phase: shell_wire::TOUCH_PHASE_CANCELLED,
                                x: bx,
                                y: by,
                            },
                        );
                    }
                } else {
                    self.process_pointer_button(0x110, ButtonState::Released, time);
                }
                self.touch_emulation_slot = None;
                self.touch_routes_to_cef = false;
            }
            InputEvent::TouchFrame { .. } => {}
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
                if delta_x != 0 || delta_y != 0 {
                    self.shell_begin_frame_note_shell_input();
                }
                self.shell_ipc_maybe_forward_pointer_axis(delta_x, delta_y);

                let pointer = self.seat.get_pointer().unwrap();
                pointer.axis(self, frame);
                pointer.frame(self);
            }
            _ => {
                // Gesture swipe/pinch/hold updates fire very often; use trace to avoid log floods.
                tracing::trace!(
                    target: "derp_input",
                    "unhandled InputEvent (Gesture*, Tablet*, Switch*, …); try RUST_LOG=derp_input=trace"
                );
            }
        }
    }
}
