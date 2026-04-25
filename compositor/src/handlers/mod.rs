mod compositor;
mod layer_shell;
mod xdg_shell;

use std::io::Write;

use crate::{chrome_bridge::ChromeEvent, CompositorState};

use smithay::delegate_layer_shell;
use smithay::delegate_pointer_constraints;
use smithay::delegate_relative_pointer;
use smithay::input::{Seat, SeatHandler, SeatState};
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::reexports::wayland_server::Resource;
use smithay::utils::{Logical, Point, Serial};
use smithay::wayland::output::OutputHandler;
use smithay::wayland::pointer_constraints::{with_pointer_constraint, PointerConstraintsHandler};
use smithay::wayland::selection::data_device::{
    set_data_device_focus, DataDeviceHandler, DataDeviceState, WaylandDndGrabHandler,
};
use smithay::wayland::selection::wlr_data_control::DataControlHandler;
use smithay::wayland::selection::{SelectionHandler, SelectionSource, SelectionTarget};
use smithay::wayland::tablet_manager::TabletSeatHandler;
use smithay::wayland::xdg_activation::{
    XdgActivationHandler, XdgActivationState, XdgActivationToken, XdgActivationTokenData,
};
use smithay::{delegate_data_control, delegate_data_device, delegate_output, delegate_seat};

impl CompositorState {
    fn xdg_activation_token_max_age(&self) -> std::time::Duration {
        std::time::Duration::from_secs(10)
    }

    pub(crate) fn xdg_activation_prune_stale_tokens(&mut self) {
        let max_age = self.xdg_activation_token_max_age();
        self.xdg_activation_state
            .retain_tokens(|_, data| data.timestamp.elapsed() < max_age);
    }

    fn xdg_activation_serial_is_current(&self, serial: Serial) -> bool {
        self.seat
            .get_keyboard()
            .and_then(|keyboard| keyboard.last_enter())
            .is_some_and(|last_enter| serial.is_no_older_than(&last_enter))
            || self
                .seat
                .get_pointer()
                .and_then(|pointer| pointer.last_enter())
                .is_some_and(|last_enter| serial.is_no_older_than(&last_enter))
    }

    fn xdg_activation_surface_matches_current_focus(&self, surface: &WlSurface) -> bool {
        let root = self.pointer_constraint_root_surface(surface);
        self.seat
            .get_keyboard()
            .and_then(|keyboard| keyboard.current_focus())
            .is_some_and(|focus| self.pointer_constraint_root_surface(&focus) == root)
            || self
                .seat
                .get_pointer()
                .and_then(|pointer| pointer.current_focus())
                .is_some_and(|focus| self.pointer_constraint_root_surface(&focus) == root)
    }

    fn xdg_activation_window_id_for_surface(&self, surface: &WlSurface) -> Option<u32> {
        self.window_registry
            .window_id_for_wl_surface(surface)
            .or_else(|| {
                let root = self.pointer_constraint_root_surface(surface);
                self.window_registry.window_id_for_wl_surface(&root)
            })
    }

    pub(crate) fn pointer_constraint_root_surface(&self, surface: &WlSurface) -> WlSurface {
        let mut root = surface.clone();
        while let Some(parent) = smithay::wayland::compositor::get_parent(&root) {
            root = parent;
        }
        root
    }

    pub(crate) fn pointer_constraint_surface_origin(
        &self,
        surface: &WlSurface,
    ) -> Option<Point<f64, Logical>> {
        let root = self.pointer_constraint_root_surface(surface);
        if let Some(window) = self.wayland_window_containing_surface(&root) {
            let map_loc = self
                .space
                .element_location(&crate::DerpSpaceElem::Wayland(window.clone()))?;
            let render_loc = map_loc - window.geometry().loc;
            return Some(render_loc.to_f64());
        }
        if let Some(x11) = self.x11_window_containing_surface(&root) {
            let map_loc = self
                .space
                .element_location(&crate::DerpSpaceElem::X11(x11.clone()))?;
            let render_loc = map_loc - x11.geometry().loc;
            return Some(render_loc.to_f64());
        }
        None
    }

    pub(crate) fn pointer_constraint_maybe_activate(
        &self,
        surface: &WlSurface,
        pointer: &smithay::input::pointer::PointerHandle<Self>,
        pointer_location: Point<f64, Logical>,
    ) {
        let root = self.pointer_constraint_root_surface(surface);
        let Some(surface_origin) = self.pointer_constraint_surface_origin(&root) else {
            return;
        };
        with_pointer_constraint(&root, pointer, |constraint| {
            let Some(constraint) = constraint else {
                return;
            };
            if constraint.is_active() {
                return;
            }
            let point = (pointer_location - surface_origin).to_i32_round();
            if constraint
                .region()
                .is_none_or(|region| region.contains(point))
            {
                constraint.activate();
            }
        });
    }
}

impl SeatHandler for CompositorState {
    type KeyboardFocus = WlSurface;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<CompositorState> {
        &mut self.seat_state
    }

    fn cursor_image(
        &mut self,
        _seat: &Seat<Self>,
        image: smithay::input::pointer::CursorImageStatus,
    ) {
        self.pointer_cursor_image = image;
    }

    fn focus_changed(&mut self, seat: &Seat<Self>, focused: Option<&WlSurface>) {
        let dh = &self.display_handle;
        let client = focused.and_then(|s| dh.get_client(s.id()).ok());
        set_data_device_focus(dh, seat, client);

        self.keyboard_on_focus_surface_changed(focused);

        let window_id = focused.and_then(|s| self.window_registry.window_id_for_wl_surface(s));
        if let Some(wid) = window_id {
            if let Some(sid) = self.window_registry.surface_id_for_window(wid) {
                if let Some(window) = self.find_window_by_surface_id(sid) {
                    self.space
                        .raise_element(&crate::derp_space::DerpSpaceElem::Wayland(window), true);
                } else if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
                    self.space
                        .raise_element(&crate::derp_space::DerpSpaceElem::X11(x11), true);
                }
            }
            self.shell_window_stack_touch(wid);
            if let Some(info) = self.window_registry.window_info(wid) {
                if !self.window_info_is_solid_shell_host(&info) {
                    self.shell_note_non_shell_focus();
                }
            }
        }
        let surface_id = window_id.and_then(|w| self.window_registry.surface_id_for_window(w));
        self.shell_emit_chrome_event(ChromeEvent::FocusChanged {
            surface_id,
            window_id,
        });
    }
}

delegate_seat!(crate::CompositorState);

impl TabletSeatHandler for CompositorState {}

impl XdgActivationHandler for CompositorState {
    fn activation_state(&mut self) -> &mut XdgActivationState {
        &mut self.xdg_activation_state
    }

    fn token_created(&mut self, _token: XdgActivationToken, data: XdgActivationTokenData) -> bool {
        self.xdg_activation_prune_stale_tokens();
        let Some((serial, seat)) = data
            .serial
            .as_ref()
            .map(|(serial, seat)| (*serial, seat.clone()))
        else {
            return false;
        };
        if Seat::from_resource(&seat) != Some(self.seat.clone()) {
            return false;
        }
        if !self.xdg_activation_serial_is_current(serial) {
            return false;
        }
        if let Some(surface) = data.surface.as_ref() {
            return self.xdg_activation_surface_matches_current_focus(surface);
        }
        true
    }

    fn request_activation(
        &mut self,
        token: XdgActivationToken,
        token_data: XdgActivationTokenData,
        surface: WlSurface,
    ) {
        self.xdg_activation_prune_stale_tokens();
        if token_data.timestamp.elapsed() >= self.xdg_activation_token_max_age() {
            self.xdg_activation_state.remove_token(&token);
            return;
        }
        let Some(window_id) = self.xdg_activation_window_id_for_surface(&surface) else {
            self.xdg_activation_state.remove_token(&token);
            return;
        };
        let Some(info) = self.window_registry.window_info(window_id) else {
            self.xdg_activation_state.remove_token(&token);
            return;
        };
        if info.minimized {
            if self.scratchpad_windows.contains_key(&window_id) {
                self.xdg_activation_state.remove_token(&token);
                return;
            }
            self.shell_restore_minimized_window(window_id);
        } else if self.wayland_window_id_is_pending_deferred_toplevel(window_id) {
            self.shell_pending_native_focus_window_id = Some(window_id);
        } else {
            self.shell_raise_and_focus_window(window_id);
            if let Some(window_order) = self.shell_window_order_message_if_changed() {
                self.shell_send_to_cef(window_order);
            }
        }
        self.xdg_activation_state.remove_token(&token);
    }
}

impl PointerConstraintsHandler for CompositorState {
    fn new_constraint(
        &mut self,
        surface: &WlSurface,
        pointer: &smithay::input::pointer::PointerHandle<Self>,
    ) {
        let pointer_root = self
            .surface_under(pointer.current_location())
            .map(|(hit, _)| self.pointer_constraint_root_surface(&hit))
            .or_else(|| {
                pointer
                    .current_focus()
                    .map(|focus| self.pointer_constraint_root_surface(&focus))
            });
        let pointer_root_window_id = pointer_root
            .as_ref()
            .and_then(|focus| self.window_registry.window_id_for_wl_surface(focus));
        let surface_window_id = self.window_registry.window_id_for_wl_surface(surface);
        let Some(current_focus) = pointer_root else {
            return;
        };
        let same_surface = match (pointer_root_window_id, surface_window_id) {
            (Some(focus_window_id), Some(surface_window_id)) => {
                focus_window_id == surface_window_id
            }
            _ => current_focus == *surface,
        };
        if !same_surface {
            return;
        }
        self.pointer_constraint_maybe_activate(surface, pointer, pointer.current_location());
    }

    fn cursor_position_hint(
        &mut self,
        surface: &WlSurface,
        pointer: &smithay::input::pointer::PointerHandle<Self>,
        location: Point<f64, Logical>,
    ) {
        let root = self.pointer_constraint_root_surface(surface);
        let active = with_pointer_constraint(&root, pointer, |constraint| {
            constraint.is_some_and(|constraint| constraint.is_active())
        });
        if !active {
            return;
        }
        let Some(origin) = self.pointer_constraint_surface_origin(&root) else {
            return;
        };
        pointer.set_location(origin + location);
    }
}

impl SelectionHandler for CompositorState {
    type SelectionUserData = std::sync::Arc<Vec<u8>>;

    fn new_selection(
        &mut self,
        ty: SelectionTarget,
        source: Option<SelectionSource>,
        _seat: Seat<Self>,
    ) {
        if ty != SelectionTarget::Clipboard {
            return;
        }
        let Some((_, xwm)) = self.x11_wm_slot.as_mut() else {
            return;
        };
        if let Err(error) = xwm.new_selection(ty, source.map(|source| source.mime_types())) {
            tracing::warn!(?error, ?ty, "failed to set xwayland selection");
        }
    }

    fn send_selection(
        &mut self,
        ty: smithay::wayland::selection::SelectionTarget,
        mime_type: String,
        fd: std::os::fd::OwnedFd,
        _seat: Seat<Self>,
        user_data: &Self::SelectionUserData,
    ) {
        if ty != SelectionTarget::Clipboard {
            return;
        }
        if user_data.is_empty() {
            let Some((_, xwm)) = self.x11_wm_slot.as_mut() else {
                return;
            };
            if let Err(error) = xwm.send_selection(ty, mime_type, fd) {
                tracing::warn!(?error, "failed to send x11 clipboard to wayland");
            }
            return;
        }
        if mime_type != "image/png" {
            return;
        }
        let mut file = std::fs::File::from(fd);
        if let Err(error) = file.write_all(user_data.as_slice()) {
            tracing::warn!(%error, "clipboard image write failed");
        }
    }
}

impl DataDeviceHandler for CompositorState {
    fn data_device_state(&mut self) -> &mut DataDeviceState {
        &mut self.data_device_state
    }
}

impl DataControlHandler for CompositorState {
    fn data_control_state(
        &mut self,
    ) -> &mut smithay::wayland::selection::wlr_data_control::DataControlState {
        &mut self.data_control_state
    }
}

impl WaylandDndGrabHandler for CompositorState {}

delegate_data_control!(crate::CompositorState);
delegate_data_device!(crate::CompositorState);

impl OutputHandler for CompositorState {}
delegate_output!(crate::CompositorState);
delegate_layer_shell!(crate::CompositorState);
delegate_relative_pointer!(crate::CompositorState);
delegate_pointer_constraints!(crate::CompositorState);
