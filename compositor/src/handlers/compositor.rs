use crate::{derp_space::DerpSpaceElem, grabs::resize_grab, state::ClientState, CompositorState};
use smithay::{
    backend::renderer::utils::on_commit_buffer_handler,
    delegate_compositor, delegate_shm,
    reexports::calloop::Interest,
    reexports::wayland_server::{
        protocol::{wl_buffer, wl_surface::WlSurface},
        Client, Resource,
    },
    wayland::{
        buffer::BufferHandler,
        compositor::{
            add_blocker, add_pre_commit_hook, get_parent, is_sync_subsurface, with_states,
            BufferAssignment, CompositorClientState, CompositorHandler,
            CompositorState as WlCompositorState, SurfaceAttributes,
        },
        dmabuf::get_dmabuf,
        drm_syncobj::DrmSyncobjCachedState,
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

    fn new_surface(&mut self, surface: &WlSurface) {
        add_pre_commit_hook::<Self, _>(surface, move |state, _dh, surface| {
            let mut acquire_point = None;
            let maybe_dmabuf = with_states(surface, |surface_data| {
                acquire_point.clone_from(
                    &surface_data
                        .cached_state
                        .get::<DrmSyncobjCachedState>()
                        .pending()
                        .acquire_point,
                );
                surface_data
                    .cached_state
                    .get::<SurfaceAttributes>()
                    .pending()
                    .buffer
                    .as_ref()
                    .and_then(|assignment| match assignment {
                        BufferAssignment::NewBuffer(buffer) => get_dmabuf(buffer).cloned().ok(),
                        _ => None,
                    })
            });
            if let Some(dmabuf) = maybe_dmabuf {
                if let Some(acquire_point) = acquire_point {
                    if let Ok((blocker, source)) = acquire_point.generate_blocker() {
                        if let Some(client) = surface.client() {
                            let res = state.loop_handle.insert_source(
                                source,
                                move |_, _, data: &mut crate::CalloopData| {
                                    let dh = data.display_handle.clone();
                                    <crate::CompositorState as CompositorHandler>::client_compositor_state(
                                        &data.state,
                                        &client,
                                    )
                                    .blocker_cleared(&mut data.state, &dh);
                                    Ok(())
                                },
                            );
                            if res.is_ok() {
                                add_blocker(surface, blocker);
                                return;
                            }
                        }
                    }
                }
                if let Ok((blocker, source)) = dmabuf.generate_blocker(Interest::READ) {
                    if let Some(client) = surface.client() {
                        let res = state.loop_handle.insert_source(
                            source,
                            move |_, _, data: &mut crate::CalloopData| {
                                let dh = data.display_handle.clone();
                                <crate::CompositorState as CompositorHandler>::client_compositor_state(
                                    &data.state,
                                    &client,
                                )
                                .blocker_cleared(&mut data.state, &dh);
                                Ok(())
                            },
                        );
                        if res.is_ok() {
                            add_blocker(surface, blocker);
                        }
                    }
                }
            }
        });
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
            self.hide_bufferless_native_window(&root);
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

delegate_compositor!(crate::CompositorState);
delegate_shm!(crate::CompositorState);
