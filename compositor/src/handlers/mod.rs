mod compositor;
mod xdg_shell;

use crate::{chrome_bridge::ChromeEvent, CompositorState};

use smithay::input::{Seat, SeatHandler, SeatState};
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::reexports::wayland_server::Resource;
use smithay::wayland::output::OutputHandler;
use smithay::wayland::selection::data_device::{
    set_data_device_focus, ClientDndGrabHandler, DataDeviceHandler, DataDeviceState,
    ServerDndGrabHandler,
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
        self.needs_winit_redraw = true;
    }

    fn focus_changed(&mut self, seat: &Seat<Self>, focused: Option<&WlSurface>) {
        let dh = &self.display_handle;
        let client = focused.and_then(|s| dh.get_client(s.id()).ok());
        set_data_device_focus(dh, seat, client);

        let window_id = focused.and_then(|s| self.window_registry.window_id_for_wl_surface(s));
        if let Some(wid) = window_id {
            if let Some(info) = self.window_registry.window_info(wid) {
                if !self.window_info_is_solid_shell_host(&info) {
                    self.shell_last_non_shell_focus_window_id = Some(wid);
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

delegate_seat!(CompositorState);

impl TabletSeatHandler for CompositorState {}

impl SelectionHandler for CompositorState {
    type SelectionUserData = ();
}

impl DataDeviceHandler for CompositorState {
    fn data_device_state(&self) -> &DataDeviceState {
        &self.data_device_state
    }
}

impl ClientDndGrabHandler for CompositorState {}
impl ServerDndGrabHandler for CompositorState {}

delegate_data_device!(CompositorState);

impl OutputHandler for CompositorState {}
delegate_output!(CompositorState);
