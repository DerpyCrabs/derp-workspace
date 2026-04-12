mod compositor;
mod layer_shell;
mod xdg_shell;

use std::io::Write;

use crate::{chrome_bridge::ChromeEvent, CompositorState};

use smithay::delegate_layer_shell;
use smithay::input::{Seat, SeatHandler, SeatState};
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::reexports::wayland_server::Resource;
use smithay::wayland::output::OutputHandler;
use smithay::wayland::selection::data_device::{
    set_data_device_focus, DataDeviceHandler, DataDeviceState, WaylandDndGrabHandler,
};
use smithay::wayland::selection::SelectionHandler;
use smithay::wayland::tablet_manager::TabletSeatHandler;
use smithay::{delegate_data_device, delegate_output, delegate_seat};

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
            self.shell_window_stack_touch(wid);
            if let Some(info) = self.window_registry.window_info(wid) {
                if !self.window_info_is_solid_shell_host(&info) {
                    self.shell_note_non_shell_focus();
                    self.shell_last_non_shell_focus_window_id = Some(wid);
                    self.push_non_shell_focus_history(wid);
                }
            }
        }
        let surface_id = window_id.and_then(|w| self.window_registry.surface_id_for_window(w));
        self.shell_emit_chrome_event(ChromeEvent::FocusChanged {
            surface_id,
            window_id,
        });
        self.shell_reply_window_list();
    }
}

delegate_seat!(crate::CompositorState);

impl TabletSeatHandler for CompositorState {}

impl SelectionHandler for CompositorState {
    type SelectionUserData = std::sync::Arc<Vec<u8>>;

    fn send_selection(
        &mut self,
        ty: smithay::wayland::selection::SelectionTarget,
        mime_type: String,
        fd: std::os::fd::OwnedFd,
        _seat: Seat<Self>,
        user_data: &Self::SelectionUserData,
    ) {
        if ty != smithay::wayland::selection::SelectionTarget::Clipboard {
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

impl WaylandDndGrabHandler for CompositorState {}

delegate_data_device!(crate::CompositorState);

impl OutputHandler for CompositorState {}
delegate_output!(crate::CompositorState);
delegate_layer_shell!(crate::CompositorState);
