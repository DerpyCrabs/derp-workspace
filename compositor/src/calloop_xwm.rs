//! [`crate::CalloopData`] implements Smithay’s X11 / xwayland-shell handler traits so X11 events on
//! the calloop loop forward into [`crate::CompositorState`] (the Wayland display still dispatches `CompositorState`).

use smithay::{
    utils::{Logical, Rectangle},
    wayland::xwayland_shell::XWaylandShellHandler,
    xwayland::{
        xwm::{Reorder, ResizeEdge, X11Window, XwmId},
        X11Surface, X11Wm, XwmHandler,
    },
};
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;

use crate::CalloopData;

impl XWaylandShellHandler for CalloopData {
    fn xwayland_shell_state(&mut self) -> &mut smithay::wayland::xwayland_shell::XWaylandShellState {
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

    fn disconnected(&mut self, xwm: XwmId) {
        self.state.disconnected(xwm);
    }
}
