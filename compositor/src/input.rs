use smithay::desktop::space::SpaceElement;
use smithay::{
    backend::{
        input::{
            AbsolutePositionEvent, Axis, AxisSource, ButtonState, Event, InputBackend, InputEvent,
            KeyState, KeyboardKeyEvent, PointerAxisEvent, PointerButtonEvent, PointerMotionEvent,
            TouchEvent,
        },
        session::Session,
    },
    input::{
        keyboard::{keysyms, FilterResult},
        pointer::{AxisFrame, ButtonEvent, MotionEvent},
    },
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Logical, Point, Rectangle, SERIAL_COUNTER},
};

use crate::{derp_space::DerpSpaceElem, state::CompositorState};

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
    fn pointer_motion_output_local(
        &mut self,
        output_geo: Rectangle<i32, Logical>,
        local: Point<f64, Logical>,
        time_msec: u32,
    ) {
        let gw = output_geo.size.w.max(1) as f64;
        let gh = output_geo.size.h.max(1) as f64;
        let (nx, ny) = (
            (local.x / gw).clamp(0.0, 1.0),
            (local.y / gh).clamp(0.0, 1.0),
        );
        self.shell_pointer_norm = Some((nx, ny));

        let pos = local + output_geo.loc.to_f64();

        let serial = SERIAL_COUNTER.next_serial();

        let pointer = self.seat.get_pointer().unwrap();

        let grabbed = pointer.is_grabbed();

        let under = if grabbed || self.shell_move_is_active() {
            None
        } else {
            self.surface_under(pos)
        };

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
        self.shell_ipc_maybe_forward_pointer_move(pos);
    }

    /// Touch position in **output-local logical** coords (matches [`Self::pointer_motion_output_local`]).
    fn touch_output_local<I: InputBackend>(
        &self,
        event: &impl AbsolutePositionEvent<I>,
        output_geo: Rectangle<i32, Logical>,
    ) -> Point<f64, Logical> {
        if self.touch_abs_is_window_pixels {
            let (pw, ph) = self.shell_window_physical_px;
            let pw = pw.max(1) as f64;
            let ph = ph.max(1) as f64;
            let nx = (event.x() / pw).clamp(0.0, 1.0);
            let ny = (event.y() / ph).clamp(0.0, 1.0);
            Point::from((
                nx * output_geo.size.w as f64,
                ny * output_geo.size.h as f64,
            ))
        } else {
            event.position_transformed(output_geo.size)
        }
    }

    fn process_pointer_button(
        &mut self,
        button: u32,
        button_state: ButtonState,
        time_msec: u32,
    ) {
        let pointer = self.seat.get_pointer().unwrap();
        let keyboard = self.seat.get_keyboard().unwrap();

        let serial = SERIAL_COUNTER.next_serial();

        let pos = pointer.current_location();
        let norm = self
            .shell_pointer_norm
            .or_else(|| self.shell_pointer_norm_from_global(pos));
        let route_cef = self.shell_pointer_route_to_cef(pos);
        tracing::debug!(
            target: "derp_input",
            button,
            ?button_state,
            pos_x = pos.x,
            pos_y = pos.y,
            route_cef,
            shell_norm = ?norm,
            "PointerButton"
        );
        const BTN_LEFT: u32 = 0x110;

        let shell_px = if route_cef || self.shell_move_is_active() {
            norm.and_then(|(nx, ny)| self.shell_pointer_buffer_pixels(nx, ny)).or_else(|| {
                self.shell_pointer_norm_from_global(pos)
                    .and_then(|(nx, ny)| self.shell_pointer_buffer_pixels(nx, ny))
            })
        } else {
            None
        };
        if shell_px.is_some() {
            if button == BTN_LEFT
                && button_state == ButtonState::Pressed
                && !pointer.is_grabbed()
            {
                if let Some(window) = self.window_for_titlebar_close_at(pos) {
                    let wl = window.toplevel().unwrap().wl_surface();
                    if let Some(wid) = self.window_registry.window_id_for_wl_surface(wl) {
                        self.shell_close_window(wid);
                    }
                } else if let Some(window) = self.window_for_titlebar_drag_at(pos) {
                    self.shell_ipc_keyboard_to_cef = false;
                    self.space
                        .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
                    keyboard.set_focus(
                        self,
                        Some(window.toplevel().unwrap().wl_surface().clone()),
                        serial,
                    );
                    self.space.elements().for_each(|e| {
                        if let DerpSpaceElem::Wayland(w) = e {
                            w.toplevel().unwrap().send_pending_configure();
                        }
                    });
                }
            }
            if ButtonState::Pressed == button_state
                && !pointer.is_grabbed()
                && !self.shell_point_in_any_window_decoration(pos)
            {
                self.space.elements().for_each(|e| {
                    e.set_activate(false);
                    if let DerpSpaceElem::Wayland(w) = e {
                        w.toplevel().unwrap().send_pending_configure();
                    }
                });
                keyboard.set_focus(self, Option::<WlSurface>::None, serial);
                self.shell_ipc_keyboard_to_cef = true;
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
            let chrome_suppress_cef = button == BTN_LEFT
                && button_state == ButtonState::Pressed
                && !pointer.is_grabbed()
                && (self.window_for_titlebar_close_at(pos).is_some()
                    || self.window_for_titlebar_drag_at(pos).is_some());
            if route_cef
                && !chrome_suppress_cef
                && !self.shell_ipc_conn.is_disconnected()
            {
                if let Some((bx, by)) = self.shell_pointer_view_px(pos) {
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
                    self.shell_ipc_try_write(&shell_wire::encode_compositor_pointer_move(
                        bx,
                        by,
                        mod_flags,
                    ));
                    self.shell_ipc_try_write(&shell_wire::encode_compositor_pointer_button(
                        bx,
                        by,
                        shell_btn,
                        mouse_up,
                        0,
                        mod_flags,
                    ));
                }
            }
            if button == BTN_LEFT && button_state == ButtonState::Released {
                self.shell_move_end_active();
            }
            return;
        }

        if ButtonState::Pressed == button_state && !pointer.is_grabbed() {
            self.shell_ipc_keyboard_to_cef = false;
            if let Some((elem, _loc)) = self
                .space
                .element_under(pointer.current_location())
                .map(|(w, l)| (w.clone(), l))
            {
                match elem {
                    DerpSpaceElem::Wayland(window) => {
                        self.space
                            .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
                        keyboard.set_focus(
                            self,
                            Some(window.toplevel().unwrap().wl_surface().clone()),
                            serial,
                        );
                        self.space.elements().for_each(|e| {
                            if let DerpSpaceElem::Wayland(w) = e {
                                w.toplevel().unwrap().send_pending_configure();
                            }
                        });
                    }
                    DerpSpaceElem::X11(x11) => {
                        if let Some(surf) = x11.wl_surface() {
                            self.space
                                .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
                            keyboard.set_focus(self, Some(surf), serial);
                        }
                    }
                }
            } else {
                self.space.elements().for_each(|e| {
                    e.set_activate(false);
                    if let DerpSpaceElem::Wayland(w) = e {
                        w.toplevel().unwrap().send_pending_configure();
                    }
                });
                keyboard.set_focus(self, Option::<WlSurface>::None, serial);
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
            self.shell_move_end_active();
        }
    }

    pub fn process_input_event<I: InputBackend>(&mut self, event: InputEvent<I>) {
        match event {
            InputEvent::Keyboard { event, .. } => {
                let serial = SERIAL_COUNTER.next_serial();
                let time = Event::time_msec(&event);
                let key_state = event.state();

                self.seat.get_keyboard().unwrap().input::<(), _>(
                    self,
                    event.key_code(),
                    key_state,
                    serial,
                    time,
                    move |state, mods, keysym| {
                        if key_state == KeyState::Pressed {
                            let sym = keysym.modified_sym().raw();
                            if mods.ctrl && mods.alt {
                                if let (Some(vt), Some(ref mut sess)) =
                                    (vt_number_from_fkey(sym), state.vt_session.as_mut())
                                {
                                    if let Err(e) = sess.change_vt(vt) {
                                        tracing::warn!(?e, vt, "VT switch (Ctrl+Alt+F) failed");
                                    }
                                    return FilterResult::Intercept(());
                                }
                            }
                            if mods.ctrl
                                && mods.shift
                                && matches!(sym, keysyms::KEY_q | keysyms::KEY_Q)
                            {
                                state.loop_signal.stop();
                                state.loop_signal.wakeup();
                                return FilterResult::Intercept(());
                            }
                        }
                        if state.shell_ipc_keyboard_to_cef
                            && !state.shell_ipc_conn.is_disconnected()
                            && state.shell_has_frame
                        {
                            state.shell_ipc_forward_keyboard_to_cef(key_state, mods, &keysym);
                            return FilterResult::Intercept(());
                        }
                        FilterResult::Forward
                    },
                );
            }
            InputEvent::PointerMotion { event, .. } => {
                let output = self.space.outputs().next().unwrap();
                let output_geo = self.space.output_geometry(output).unwrap();
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
                let min_x = output_geo.loc.x as f64;
                let min_y = output_geo.loc.y as f64;
                let max_x = min_x + output_geo.size.w.max(0) as f64;
                let max_y = min_y + output_geo.size.h.max(0) as f64;
                pos.x = pos.x.clamp(min_x, max_x);
                pos.y = pos.y.clamp(min_y, max_y);
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
                self.needs_winit_redraw = true;
            }
            InputEvent::PointerMotionAbsolute { event, .. } => {
                let output = self.space.outputs().next().unwrap();

                let output_geo = self.space.output_geometry(output).unwrap();

                let local = event.position_transformed(output_geo.size);
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
                self.needs_winit_redraw = true;
            }
            InputEvent::PointerButton { event, .. } => {
                self.process_pointer_button(
                    event.button_code(),
                    event.state(),
                    event.time_msec(),
                );
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
                let output = self.space.outputs().next().unwrap();
                let output_geo = self.space.output_geometry(output).unwrap();
                self.touch_emulation_slot = Some(event.slot());
                let local = self.touch_output_local(&event, output_geo);
                let time = Event::time_msec(&event);
                let pos = output_geo.loc.to_f64() + local;
                let cef_touch = self.shell_pointer_route_to_cef(pos)
                    && self.shell_has_frame
                    && !self.shell_ipc_conn.is_disconnected()
                    && self.shell_pointer_view_px(pos).is_some();
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
                    if let Some((bx, by)) = self.shell_pointer_view_px(pos) {
                        let tid = i32::from(event.slot());
                        self.shell_ipc_try_write(&shell_wire::encode_compositor_touch(
                            tid,
                            shell_wire::TOUCH_PHASE_PRESSED,
                            bx,
                            by,
                        ));
                    }
                    self.shell_ipc_keyboard_to_cef = true;
                } else {
                    self.process_pointer_button(0x110, ButtonState::Pressed, time);
                }
                self.needs_winit_redraw = true;
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
                let output = self.space.outputs().next().unwrap();
                let output_geo = self.space.output_geometry(output).unwrap();
                let local = self.touch_output_local(&event, output_geo);
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
                    let pos = output_geo.loc.to_f64() + local;
                    if let Some((bx, by)) = self.shell_pointer_view_px(pos) {
                        let tid = i32::from(event.slot());
                        self.shell_ipc_try_write(&shell_wire::encode_compositor_touch(
                            tid,
                            shell_wire::TOUCH_PHASE_MOVED,
                            bx,
                            by,
                        ));
                    }
                }
                self.needs_winit_redraw = true;
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
                    if let Some((bx, by)) = self.shell_pointer_view_px(pos) {
                        let tid = i32::from(event.slot());
                        self.shell_ipc_try_write(&shell_wire::encode_compositor_touch(
                            tid,
                            shell_wire::TOUCH_PHASE_RELEASED,
                            bx,
                            by,
                        ));
                    }
                } else {
                    self.process_pointer_button(0x110, ButtonState::Released, time);
                }
                self.touch_emulation_slot = None;
                self.touch_routes_to_cef = false;
                self.needs_winit_redraw = true;
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
                    if let Some((bx, by)) = self.shell_pointer_view_px(pos) {
                        let tid = i32::from(event.slot());
                        self.shell_ipc_try_write(&shell_wire::encode_compositor_touch(
                            tid,
                            shell_wire::TOUCH_PHASE_CANCELLED,
                            bx,
                            by,
                        ));
                    }
                } else {
                    self.process_pointer_button(0x110, ButtonState::Released, time);
                }
                self.touch_emulation_slot = None;
                self.touch_routes_to_cef = false;
                self.needs_winit_redraw = true;
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

                let delta_x = pointer_axis_to_cef_delta(horizontal_amount, horizontal_amount_discrete);
                let delta_y = pointer_axis_to_cef_delta(vertical_amount, vertical_amount_discrete);
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
