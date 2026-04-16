//! [`crate::CalloopData`] implements Smithay’s X11 / xwayland-shell handler traits so X11 events on
//! the calloop loop forward into [`crate::CompositorState`] (the Wayland display still dispatches `CompositorState`).

use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::{
    input::{dnd::DndGrabHandler, pointer::CursorImageStatus, Seat, SeatHandler, SeatState},
    utils::{Logical, Rectangle},
    wayland::selection::{
        data_device::{DataDeviceHandler, DataDeviceState, WaylandDndGrabHandler},
        SelectionHandler, SelectionSource, SelectionTarget,
    },
    wayland::xwayland_shell::XWaylandShellHandler,
    xwayland::{
        xwm::{Reorder, ResizeEdge, X11Window, XwmId},
        X11Surface, X11Wm, XwmHandler,
    },
};

use crate::CalloopData;

impl SeatHandler for CalloopData {
    type KeyboardFocus = WlSurface;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<Self> {
        unsafe {
            &mut *(<crate::CompositorState as SeatHandler>::seat_state(&mut self.state)
                as *mut SeatState<crate::CompositorState>
                as *mut SeatState<Self>)
        }
    }

    fn cursor_image(&mut self, seat: &Seat<Self>, image: CursorImageStatus) {
        let seat = unsafe { &*(seat as *const Seat<Self> as *const Seat<crate::CompositorState>) };
        <crate::CompositorState as SeatHandler>::cursor_image(&mut self.state, seat, image);
    }

    fn focus_changed(&mut self, seat: &Seat<Self>, focused: Option<&WlSurface>) {
        let seat = unsafe { &*(seat as *const Seat<Self> as *const Seat<crate::CompositorState>) };
        <crate::CompositorState as SeatHandler>::focus_changed(&mut self.state, seat, focused);
    }
}

impl DndGrabHandler for CalloopData {}

impl SelectionHandler for CalloopData {
    type SelectionUserData = std::sync::Arc<Vec<u8>>;

    fn new_selection(
        &mut self,
        ty: SelectionTarget,
        source: Option<SelectionSource>,
        seat: Seat<Self>,
    ) {
        let seat = unsafe { &*(&seat as *const Seat<Self> as *const Seat<crate::CompositorState>) };
        <crate::CompositorState as SelectionHandler>::new_selection(
            &mut self.state,
            ty,
            source,
            seat.clone(),
        );
    }

    fn send_selection(
        &mut self,
        ty: SelectionTarget,
        mime_type: String,
        fd: std::os::fd::OwnedFd,
        seat: Seat<Self>,
        user_data: &Self::SelectionUserData,
    ) {
        let seat = unsafe { &*(&seat as *const Seat<Self> as *const Seat<crate::CompositorState>) };
        <crate::CompositorState as SelectionHandler>::send_selection(
            &mut self.state,
            ty,
            mime_type,
            fd,
            seat.clone(),
            user_data,
        );
    }
}

impl WaylandDndGrabHandler for CalloopData {}

impl DataDeviceHandler for CalloopData {
    fn data_device_state(&mut self) -> &mut DataDeviceState {
        &mut self.state.data_device_state
    }
}

impl XWaylandShellHandler for CalloopData {
    fn xwayland_shell_state(
        &mut self,
    ) -> &mut smithay::wayland::xwayland_shell::XWaylandShellState {
        XWaylandShellHandler::xwayland_shell_state(&mut self.state)
    }

    fn surface_associated(&mut self, xwm_id: XwmId, surface: WlSurface, window: X11Surface) {
        XWaylandShellHandler::surface_associated(&mut self.state, xwm_id, surface, window);
    }
}

impl XwmHandler for CalloopData {
    fn xwm_state(&mut self, xwm: XwmId) -> &mut X11Wm {
        self.state.xwm_state(xwm)
    }

    fn new_window(&mut self, xwm: XwmId, window: X11Surface) {
        self.state.new_window(xwm, window);
    }

    fn new_override_redirect_window(&mut self, xwm: XwmId, window: X11Surface) {
        self.state.new_override_redirect_window(xwm, window);
    }

    fn map_window_request(&mut self, xwm: XwmId, window: X11Surface) {
        self.state.map_window_request(xwm, window);
    }

    fn mapped_override_redirect_window(&mut self, xwm: XwmId, window: X11Surface) {
        self.state.mapped_override_redirect_window(xwm, window);
    }

    fn unmapped_window(&mut self, xwm: XwmId, window: X11Surface) {
        self.state.unmapped_window(xwm, window);
    }

    fn destroyed_window(&mut self, xwm: XwmId, window: X11Surface) {
        self.state.destroyed_window(xwm, window);
    }

    fn configure_request(
        &mut self,
        xwm: XwmId,
        window: X11Surface,
        x: Option<i32>,
        y: Option<i32>,
        w: Option<u32>,
        h: Option<u32>,
        reorder: Option<Reorder>,
    ) {
        self.state
            .configure_request(xwm, window, x, y, w, h, reorder);
    }

    fn configure_notify(
        &mut self,
        xwm: XwmId,
        window: X11Surface,
        geometry: Rectangle<i32, Logical>,
        above: Option<X11Window>,
    ) {
        self.state.configure_notify(xwm, window, geometry, above);
    }

    fn resize_request(&mut self, xwm: XwmId, window: X11Surface, button: u32, edge: ResizeEdge) {
        self.state.resize_request(xwm, window, button, edge);
    }

    fn move_request(&mut self, xwm: XwmId, window: X11Surface, button: u32) {
        self.state.move_request(xwm, window, button);
    }

    fn allow_selection_access(&mut self, xwm: XwmId, selection: SelectionTarget) -> bool {
        XwmHandler::allow_selection_access(&mut self.state, xwm, selection)
    }

    fn send_selection(
        &mut self,
        xwm: XwmId,
        selection: SelectionTarget,
        mime_type: String,
        fd: std::os::fd::OwnedFd,
    ) {
        XwmHandler::send_selection(&mut self.state, xwm, selection, mime_type, fd);
    }

    fn new_selection(&mut self, xwm: XwmId, selection: SelectionTarget, mime_types: Vec<String>) {
        XwmHandler::new_selection(&mut self.state, xwm, selection, mime_types);
    }

    fn cleared_selection(&mut self, xwm: XwmId, selection: SelectionTarget) {
        XwmHandler::cleared_selection(&mut self.state, xwm, selection);
    }

    fn disconnected(&mut self, xwm: XwmId) {
        self.state.disconnected(xwm);
    }
}
