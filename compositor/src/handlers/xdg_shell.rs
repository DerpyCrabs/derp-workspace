use smithay::{
    delegate_xdg_shell,
    desktop::{
        find_popup_root_surface, get_popup_toplevel_coords, PopupKind, PopupManager, Space, Window,
    },
    input::{
        pointer::{Focus, GrabStartData as PointerGrabStartData},
        Seat,
    },
    reexports::{
        wayland_protocols::xdg::shell::server::xdg_toplevel,
        wayland_server::{
            protocol::{wl_output::WlOutput, wl_seat, wl_surface::WlSurface},
            Client, Resource,
        },
    },
    utils::{Rectangle, Serial},
    wayland::{
        compositor::with_states,
        shell::xdg::{
            PopupSurface, PositionerState, ToplevelSurface, XdgShellHandler, XdgShellState,
            XdgToplevelSurfaceData,
        },
    },
};

use crate::{
    chrome_bridge::ChromeEvent,
    derp_space::DerpSpaceElem,
    grabs::{MoveSurfaceGrab, ResizeSurfaceGrab},
    CompositorState,
};
use crate::state::read_toplevel_tiling;

fn toplevel_title_app_id(surface: &ToplevelSurface) -> (String, String) {
    with_states(surface.wl_surface(), |states| {
        let attrs = states
            .data_map
            .get::<XdgToplevelSurfaceData>()
            .unwrap()
            .lock()
            .unwrap();
        (
            attrs.title.clone().unwrap_or_default(),
            attrs.app_id.clone().unwrap_or_default(),
        )
    })
}

impl XdgShellHandler for CompositorState {
    fn xdg_shell_state(&mut self) -> &mut XdgShellState {
        &mut self.xdg_shell_state
    }

    fn new_toplevel(&mut self, surface: ToplevelSurface) {
        let wl0 = surface.wl_surface().clone();
        let (title, app_id) = toplevel_title_app_id(&surface);
        let wayland_client_pid = wl0
            .client()
            .and_then(|c: Client| c.get_credentials(&self.display_handle).ok())
            .map(|cr| cr.pid);
        let map_at_output_origin =
            self.toplevel_is_embedded_shell_host(&title, &app_id, wayland_client_pid);
        self.window_registry.register_toplevel(
            &wl0,
            title,
            app_id,
            wayland_client_pid,
        );
        let reg = self
            .window_registry
            .snapshot_for_wl_surface(&wl0)
            .expect("just registered");

        let window = Window::new_wayland_window(surface);

        let existing_before = self.space.elements().count();
        let (map_x, map_y) = if map_at_output_origin {
            self.primary_output_logical_origin()
        } else {
            self.new_toplevel_initial_location()
        };
        tracing::debug!(
            target: "derp_shell_sync",
            window_id = reg.window_id,
            surface_id = reg.surface_id,
            existing_before,
            map_x,
            map_y,
            "xdg new_toplevel initial map (logical)"
        );
        self.space
            .map_element(DerpSpaceElem::Wayland(window.clone()), (map_x, map_y), false);

        self.notify_geometry_if_changed(&window);
        let info = self
            .window_registry
            .snapshot_for_wl_surface(&wl0)
            .expect("xdg new_toplevel: registry row after notify");
        self.shell_emit_chrome_event(ChromeEvent::WindowMapped { info });
    }

    fn toplevel_destroyed(&mut self, surface: ToplevelSurface) {
        let wl = surface.wl_surface();
        let window_opt = self.space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                (w.toplevel().unwrap().wl_surface() == wl).then_some(w.clone())
            } else {
                None
            }
        });
        if let Some(w) = window_opt {
            self.space.unmap_elem(&DerpSpaceElem::Wayland(w));
        }
        if let Some(wid) = self.window_registry.window_id_for_wl_surface(wl) {
            self.clear_toplevel_layout_maps(wid);
        }
        let removed = self.window_registry.snapshot_for_wl_surface(wl);
        if let Some(window_id) = self.window_registry.remove_by_wl_surface(wl) {
            if self.shell_last_non_shell_focus_window_id == Some(window_id) {
                self.shell_last_non_shell_focus_window_id = None;
            }
            self.shell_minimized_windows.remove(&window_id);
            self.shell_emit_chrome_window_unmapped(window_id, removed);
        }
    }

    fn title_changed(&mut self, surface: ToplevelSurface) {
        let wl = surface.wl_surface();
        let old = self.window_registry.snapshot_for_wl_surface(wl);
        let title = toplevel_title_app_id(&surface).0;
        if let Some(true) = self.window_registry.set_title(wl, title) {
            let info = self
                .window_registry
                .snapshot_for_wl_surface(wl)
                .expect("title_changed: registry row");
            let old_shell = old
                .as_ref()
                .map(|i| self.window_info_is_solid_shell_host(i))
                .unwrap_or(false);
            let new_shell = self.window_info_is_solid_shell_host(&info);
            if new_shell && !old_shell {
                self.shell_retract_phantom_shell_window(info.window_id);
            } else if !new_shell {
                self.shell_emit_chrome_event(ChromeEvent::WindowMetadataChanged { info });
            }
        }
    }

    fn app_id_changed(&mut self, surface: ToplevelSurface) {
        let wl = surface.wl_surface();
        let old = self.window_registry.snapshot_for_wl_surface(wl);
        let app_id = toplevel_title_app_id(&surface).1;
        if let Some(true) = self.window_registry.set_app_id(wl, app_id) {
            let info = self
                .window_registry
                .snapshot_for_wl_surface(wl)
                .expect("app_id_changed: registry row");
            let old_shell = old
                .as_ref()
                .map(|i| self.window_info_is_solid_shell_host(i))
                .unwrap_or(false);
            let new_shell = self.window_info_is_solid_shell_host(&info);
            if new_shell && !old_shell {
                self.shell_retract_phantom_shell_window(info.window_id);
            } else if !new_shell {
                self.shell_emit_chrome_event(ChromeEvent::WindowMetadataChanged { info });
            }
        }
    }

    fn new_popup(&mut self, surface: PopupSurface, _positioner: PositionerState) {
        self.unconstrain_popup(&surface);
        let _ = self.popups.track_popup(PopupKind::Xdg(surface));
    }

    fn reposition_request(
        &mut self,
        surface: PopupSurface,
        positioner: PositionerState,
        token: u32,
    ) {
        surface.with_pending_state(|state| {
            let geometry = positioner.get_geometry();
            state.geometry = geometry;
            state.positioner = positioner;
        });
        self.unconstrain_popup(&surface);
        surface.send_repositioned(token);
    }

    fn move_request(&mut self, surface: ToplevelSurface, seat: wl_seat::WlSeat, serial: Serial) {
        let wl_surface = surface.wl_surface();
        if let Some(info) = self.window_registry.snapshot_for_wl_surface(wl_surface) {
            if self.window_info_is_solid_shell_host(&info) {
                return;
            }
        }

        let seat = Seat::from_resource(&seat).unwrap();

        if let Some(start_data) = check_grab(&seat, wl_surface, serial) {
            let pointer = seat.get_pointer().unwrap();

            let window = self
                .space
                .elements()
                .find_map(|e| {
                    if let DerpSpaceElem::Wayland(w) = e {
                        (w.toplevel().unwrap().wl_surface() == wl_surface).then_some(w.clone())
                    } else {
                        None
                    }
                })
                .unwrap();
            let initial_window_location = self
                .space
                .element_location(&DerpSpaceElem::Wayland(window.clone()))
                .unwrap();

            let grab = MoveSurfaceGrab::new(start_data, window, initial_window_location);

            pointer.set_grab(self, grab, serial, Focus::Clear);
        }
    }

    fn resize_request(
        &mut self,
        surface: ToplevelSurface,
        seat: wl_seat::WlSeat,
        serial: Serial,
        edges: xdg_toplevel::ResizeEdge,
    ) {
        let seat = Seat::from_resource(&seat).unwrap();

        let wl_surface = surface.wl_surface();

        if let Some(start_data) = check_grab(&seat, wl_surface, serial) {
            let pointer = seat.get_pointer().unwrap();

            let window = self
                .space
                .elements()
                .find_map(|e| {
                    if let DerpSpaceElem::Wayland(w) = e {
                        (w.toplevel().unwrap().wl_surface() == wl_surface).then_some(w.clone())
                    } else {
                        None
                    }
                })
                .unwrap();
            let initial_window_location = self
                .space
                .element_location(&DerpSpaceElem::Wayland(window.clone()))
                .unwrap();
            let initial_window_size = window.geometry().size;

            surface.with_pending_state(|state| {
                state.states.set(xdg_toplevel::State::Resizing);
            });

            surface.send_pending_configure();

            let grab = ResizeSurfaceGrab::start(
                start_data,
                window,
                edges.into(),
                Rectangle::new(initial_window_location, initial_window_size),
            );

            pointer.set_grab(self, grab, serial, Focus::Clear);
        }
    }

    fn minimize_request(&mut self, surface: ToplevelSurface) {
        let wl = surface.wl_surface();
        let Some(window_id) = self.window_registry.window_id_for_wl_surface(wl) else {
            return;
        };
        self.shell_minimize_window(window_id);
    }

    fn maximize_request(&mut self, surface: ToplevelSurface) {
        let wl = surface.wl_surface();
        if let Some(info) = self.window_registry.snapshot_for_wl_surface(wl) {
            if self.window_info_is_solid_shell_host(&info) {
                return;
            }
        }
        let Some(window) = self.space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                (w.toplevel().unwrap().wl_surface() == wl).then_some(w.clone())
            } else {
                None
            }
        }) else {
            return;
        };
        let Some(window_id) = self.window_registry.window_id_for_wl_surface(wl) else {
            return;
        };
        if read_toplevel_tiling(wl).0 {
            return;
        }
        if read_toplevel_tiling(wl).1 {
            return;
        }
        if !self.toplevel_floating_restore.contains_key(&window_id) {
            if let Some(s) = self.toplevel_rect_snapshot(&window) {
                self.toplevel_floating_restore.insert(window_id, s);
            }
        }
        let _ = self.apply_toplevel_maximize_layout(&window);
    }

    fn unmaximize_request(&mut self, surface: ToplevelSurface) {
        let wl = surface.wl_surface();
        if let Some(info) = self.window_registry.snapshot_for_wl_surface(wl) {
            if self.window_info_is_solid_shell_host(&info) {
                return;
            }
        }
        let Some(window) = self.space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                (w.toplevel().unwrap().wl_surface() == wl).then_some(w.clone())
            } else {
                None
            }
        }) else {
            return;
        };
        let _ = self.toplevel_unmaximize(&window);
    }

    fn fullscreen_request(&mut self, surface: ToplevelSurface, output: Option<WlOutput>) {
        let wl = surface.wl_surface();
        if let Some(info) = self.window_registry.snapshot_for_wl_surface(wl) {
            if self.window_info_is_solid_shell_host(&info) {
                return;
            }
        }
        let Some(window) = self.space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                (w.toplevel().unwrap().wl_surface() == wl).then_some(w.clone())
            } else {
                None
            }
        }) else {
            return;
        };
        let Some(window_id) = self.window_registry.window_id_for_wl_surface(wl) else {
            return;
        };
        if read_toplevel_tiling(wl).1 {
            return;
        }
        if read_toplevel_tiling(wl).0 {
            self.toplevel_fullscreen_return_maximized.insert(window_id);
        } else {
            self.toplevel_fullscreen_return_maximized
                .remove(&window_id);
            if !self.toplevel_floating_restore.contains_key(&window_id) {
                if let Some(s) = self.toplevel_rect_snapshot(&window) {
                    self.toplevel_floating_restore.insert(window_id, s);
                }
            }
        }
        let _ = self.apply_toplevel_fullscreen_layout(&window, output);
    }

    fn unfullscreen_request(&mut self, surface: ToplevelSurface) {
        let wl = surface.wl_surface();
        if let Some(info) = self.window_registry.snapshot_for_wl_surface(wl) {
            if self.window_info_is_solid_shell_host(&info) {
                return;
            }
        }
        let Some(window) = self.space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                (w.toplevel().unwrap().wl_surface() == wl).then_some(w.clone())
            } else {
                None
            }
        }) else {
            return;
        };
        if !read_toplevel_tiling(wl).1 {
            return;
        }
        let _ = self.toplevel_unfullscreen(&window);
    }

    fn grab(&mut self, _surface: PopupSurface, _seat: wl_seat::WlSeat, _serial: Serial) {}
}

delegate_xdg_shell!(CompositorState);

fn check_grab(
    seat: &Seat<CompositorState>,
    surface: &WlSurface,
    serial: Serial,
) -> Option<PointerGrabStartData<CompositorState>> {
    let pointer = seat.get_pointer()?;

    if !pointer.has_grab(serial) {
        return None;
    }

    let start_data = pointer.grab_start_data()?;

    let (focus, _) = start_data.focus.as_ref()?;
    if !focus.id().same_client_as(&surface.id()) {
        return None;
    }

    Some(start_data)
}

pub fn handle_commit(popups: &mut PopupManager, space: &Space<DerpSpaceElem>, surface: &WlSurface) {
    if let Some(window) = space.elements().find_map(|e| {
        if let DerpSpaceElem::Wayland(w) = e {
            (w.toplevel().unwrap().wl_surface() == surface).then_some(w.clone())
        } else {
            None
        }
    }) {
        let initial_configure_sent = with_states(surface, |states| {
            states
                .data_map
                .get::<XdgToplevelSurfaceData>()
                .unwrap()
                .lock()
                .unwrap()
                .initial_configure_sent
        });

        if !initial_configure_sent {
            window.toplevel().unwrap().send_configure();
        }
    }

    popups.commit(surface);
    if let Some(popup) = popups.find_popup(surface) {
        match popup {
            PopupKind::Xdg(ref xdg) => {
                if !xdg.is_initial_configure_sent() {
                    xdg.send_configure().expect("initial configure failed");
                }
            }
            PopupKind::InputMethod(ref _input_method) => {}
        }
    }
}

impl CompositorState {
    fn unconstrain_popup(&self, popup: &PopupSurface) {
        let Ok(root) = find_popup_root_surface(&PopupKind::Xdg(popup.clone())) else {
            return;
        };
        let Some(window) = self.space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                (w.toplevel().unwrap().wl_surface() == &root).then_some(w.clone())
            } else {
                None
            }
        }) else {
            return;
        };

        let window_geo = self
            .space
            .element_geometry(&DerpSpaceElem::Wayland(window.clone()))
            .unwrap();
        let wg = &window_geo;
        let output = self
            .output_for_global_xywh(wg.loc.x, wg.loc.y, wg.size.w, wg.size.h)
            .or_else(|| self.leftmost_output())
            .unwrap();
        let output_geo = self.space.output_geometry(&output).unwrap();

        let mut target = output_geo;
        target.loc -= get_popup_toplevel_coords(&PopupKind::Xdg(popup.clone()));
        target.loc -= window_geo.loc;

        popup.with_pending_state(|state| {
            state.geometry = state.positioner.get_unconstrained_geometry(target);
        });
    }
}
