use smithay::{
    backend::{
        input::{
            AbsolutePositionEvent, Axis, AxisSource, ButtonState, Event, InputBackend, InputEvent,
            KeyState, KeyboardKeyEvent, PointerAxisEvent, PointerButtonEvent, PointerMotionEvent,
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

use crate::state::CompositorState;

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

/// Map Linux evdev button codes to `shell_wire` / CEF button index (0 left, 1 middle, 2 right).
fn linux_evdev_button_to_shell(button: u32) -> u32 {
    match button {
        0x112 => 1, // BTN_MIDDLE
        0x111 => 2, // BTN_RIGHT
        _ => 0,     // BTN_LEFT (0x110) and others
    }
}

impl CompositorState {
    /// Logical pointer position **within the output** (`output_geo` from [`crate::state::CompositorState::space`]).
    fn pointer_motion_output_local(&mut self, output_geo: Rectangle<i32, Logical>, local: Point<f64, Logical>, time_msec: u32) {
        let (nx, ny) =
            if let Some((ox, oy, cw, ch)) = self.shell_letterbox_logical(output_geo.size) {
                let pw = cw.max(1) as f64;
                let ph = ch.max(1) as f64;
                (
                    ((local.x - ox as f64) / pw).clamp(0.0, 1.0),
                    ((local.y - oy as f64) / ph).clamp(0.0, 1.0),
                )
            } else {
                let gw = output_geo.size.w.max(1) as f64;
                let gh = output_geo.size.h.max(1) as f64;
                (
                    (local.x / gw).clamp(0.0, 1.0),
                    (local.y / gh).clamp(0.0, 1.0),
                )
            };
        self.shell_pointer_norm = Some((nx, ny));

        let pos = local + output_geo.loc.to_f64();

        let serial = SERIAL_COUNTER.next_serial();

        let pointer = self.seat.get_pointer().unwrap();

        let route_cef = self.shell_pointer_route_to_cef(pos);

        if route_cef {
            if let Some((vx, vy)) = self.shell_pointer_buffer_pixels(nx, ny) {
                let pkt = shell_wire::encode_compositor_pointer_move(vx, vy);
                self.shell_ipc_try_write(&pkt);
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
        }

        let under = self.surface_under(pos);

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
                        FilterResult::Forward
                    },
                );
            }
            InputEvent::PointerMotion { event, .. } => {
                let output = self.space.outputs().next().unwrap();
                let output_geo = self.space.output_geometry(output).unwrap();
                let pointer = self.seat.get_pointer().unwrap();
                let mut pos = pointer.current_location() + event.delta();
                let min_x = output_geo.loc.x as f64;
                let min_y = output_geo.loc.y as f64;
                let max_x = min_x + output_geo.size.w.max(0) as f64;
                let max_y = min_y + output_geo.size.h.max(0) as f64;
                pos.x = pos.x.clamp(min_x, max_x);
                pos.y = pos.y.clamp(min_y, max_y);
                let local = pos - output_geo.loc.to_f64();
                self.pointer_motion_output_local(output_geo, local, Event::time_msec(&event));
                self.needs_winit_redraw = true;
            }
            InputEvent::PointerMotionAbsolute { event, .. } => {
                let output = self.space.outputs().next().unwrap();

                let output_geo = self.space.output_geometry(output).unwrap();

                let local = event.position_transformed(output_geo.size);
                self.pointer_motion_output_local(output_geo, local, event.time_msec());
                self.needs_winit_redraw = true;
            }
            InputEvent::PointerButton { event, .. } => {
                let pointer = self.seat.get_pointer().unwrap();
                let keyboard = self.seat.get_keyboard().unwrap();

                let serial = SERIAL_COUNTER.next_serial();

                let button = event.button_code();

                let button_state = event.state();

                let pos = pointer.current_location();
                let norm = self
                    .shell_pointer_norm
                    .or_else(|| self.shell_pointer_norm_from_global(pos));
                let route_cef = self.shell_pointer_route_to_cef(pos);
                let shell_px = if route_cef {
                    norm.and_then(|(nx, ny)| self.shell_pointer_buffer_pixels(nx, ny))
                        .or_else(|| self.shell_pointer_view_px(pos))
                } else {
                    None
                };
                if let Some((vx, vy)) = shell_px {
                    let b = linux_evdev_button_to_shell(button);
                    let mouse_up = button_state != ButtonState::Pressed;
                    let pkt = shell_wire::encode_compositor_pointer_button(vx, vy, b, mouse_up);
                    self.shell_ipc_try_write(&pkt);
                    if ButtonState::Pressed == button_state && !pointer.is_grabbed() {
                        self.space.elements().for_each(|window| {
                            window.set_activated(false);
                            window.toplevel().unwrap().send_pending_configure();
                        });
                        keyboard.set_focus(self, Option::<WlSurface>::None, serial);
                    }
                    pointer.button(
                        self,
                        &ButtonEvent {
                            button,
                            state: button_state,
                            serial,
                            time: event.time_msec(),
                        },
                    );
                    pointer.frame(self);
                    return;
                }

                if ButtonState::Pressed == button_state && !pointer.is_grabbed() {
                    if let Some((window, _loc)) = self
                        .space
                        .element_under(pointer.current_location())
                        .map(|(w, l)| (w.clone(), l))
                    {
                        self.space.raise_element(&window, true);
                        keyboard.set_focus(
                            self,
                            Some(window.toplevel().unwrap().wl_surface().clone()),
                            serial,
                        );
                        self.space.elements().for_each(|window| {
                            window.toplevel().unwrap().send_pending_configure();
                        });
                    } else {
                        self.space.elements().for_each(|window| {
                            window.set_activated(false);
                            window.toplevel().unwrap().send_pending_configure();
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
                        time: event.time_msec(),
                    },
                );
                pointer.frame(self);
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

                let pointer = self.seat.get_pointer().unwrap();
                pointer.axis(self, frame);
                pointer.frame(self);
            }
            _ => {}
        }
    }
}
