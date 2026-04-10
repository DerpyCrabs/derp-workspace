use crate::{derp_space::DerpSpaceElem, grabs::resize_grab, state::ClientState, CompositorState};
use smithay::{
    backend::renderer::utils::on_commit_buffer_handler,
    delegate_compositor, delegate_shm,
    reexports::wayland_server::{
        protocol::{wl_buffer, wl_surface::WlSurface},
        Client,
    },
    wayland::{
        buffer::BufferHandler,
        compositor::{
            get_parent, is_sync_subsurface, CompositorClientState, CompositorHandler,
            CompositorState as WlCompositorState,
        },
        shm::{ShmHandler, ShmState},
    },
    xwayland::XWaylandClientData,
};

use super::{layer_shell, xdg_shell};

impl CompositorHandler for CompositorState {
    fn compositor_state(&mut self) -> &mut WlCompositorState {
        &mut self.compositor_state
    }

    fn client_compositor_state<'a>(&self, client: &'a Client) -> &'a CompositorClientState {
        client
            .get_data::<ClientState>()
            .map(|s| &s.compositor_state)
            .or_else(|| {
                client
                    .get_data::<XWaylandClientData>()
                    .map(|x| &x.compositor_state)
            })
            .expect("wayland client missing compositor state")
    }

    fn commit(&mut self, surface: &WlSurface) {
        on_commit_buffer_handler::<Self>(surface);
        if !is_sync_subsurface(surface) {
            let mut root = surface.clone();
            while let Some(parent) = get_parent(&root) {
                root = parent;
            }
            if let Some(window) = self.space.elements().find_map(|e| {
                if let DerpSpaceElem::Wayland(w) = e {
                    (w.toplevel().unwrap().wl_surface() == &root).then_some(w)
                } else {
                    None
                }
            }) {
                window.on_commit();
            }
            self.xdg_sync_pending_deferred_toplevel(&root);
            layer_shell::handle_commit(self, &root);
        }

        xdg_shell::handle_commit(&mut self.popups, &self.space, surface);
        resize_grab::handle_commit(&mut self.space, surface);

        if !is_sync_subsurface(surface) {
            let mut root = surface.clone();
            while let Some(parent) = get_parent(&root) {
                root = parent;
            }
            let window = self.space.elements().find_map(|e| {
                if let DerpSpaceElem::Wayland(w) = e {
                    (w.toplevel().unwrap().wl_surface() == &root).then_some(w.clone())
                } else {
                    None
                }
            });
            if let Some(window) = window {
                self.finalize_gnome_initial_toplevel_layout(&window);
                self.notify_geometry_if_changed(&window);
            }
        }
    }

    fn destroyed(&mut self, _surface: &WlSurface) {}
}

impl BufferHandler for CompositorState {
    fn buffer_destroyed(&mut self, _buffer: &wl_buffer::WlBuffer) {}
}

impl ShmHandler for CompositorState {
    fn shm_state(&self) -> &ShmState {
        &self.shm_state
    }
}

delegate_compositor!(CompositorState);
delegate_shm!(CompositorState);
