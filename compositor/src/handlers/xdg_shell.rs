use smithay::{
    delegate_xdg_shell,
    desktop::{
        find_popup_root_surface, get_popup_toplevel_coords, PopupKind, PopupManager, Space, Window,
    },
    input::{
        keyboard::{
            GrabStartData as KeyboardGrabStartData, KeyboardGrab, KeyboardInnerHandle, Keycode,
            ModifiersState,
        },
        pointer::{
            AxisFrame, ButtonEvent, Focus, GestureHoldBeginEvent, GestureHoldEndEvent,
            GesturePinchBeginEvent, GesturePinchEndEvent, GesturePinchUpdateEvent,
            GestureSwipeBeginEvent, GestureSwipeEndEvent, GestureSwipeUpdateEvent,
            GrabStartData as PointerGrabStartData, MotionEvent, PointerGrab, PointerInnerHandle,
            RelativeMotionEvent,
        },
        Seat,
    },
    reexports::{
        wayland_protocols::xdg::shell::server::xdg_toplevel,
        wayland_server::{
            protocol::{wl_output::WlOutput, wl_seat, wl_surface::WlSurface},
            Client, Resource,
        },
    },
    utils::{Serial, SERIAL_COUNTER},
    wayland::{
        compositor::with_states,
        seat::WaylandFocus,
        shell::xdg::{
            PopupSurface, PositionerState, ToplevelSurface, XdgShellHandler, XdgShellState,
            XdgToplevelSurfaceData,
        },
    },
};

use crate::state::{read_toplevel_tiling, shell_window_row_should_show};
use crate::{chrome_bridge::ChromeEvent, derp_space::DerpSpaceElem, CompositorState};

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

fn process_name_for_pid(pid: Option<i32>) -> Option<String> {
    let pid = pid?;
    if pid <= 0 {
        return None;
    }
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

impl XdgShellHandler for CompositorState {
    fn xdg_shell_state(&mut self) -> &mut XdgShellState {
        &mut self.xdg_shell_state
    }

    fn new_toplevel(&mut self, surface: ToplevelSurface) {
        let wl0 = surface.wl_surface().clone();
        let (raw_title, raw_app_id) = toplevel_title_app_id(&surface);
        let mut title = raw_title.clone();
        let mut app_id = raw_app_id.clone();
        let parent = surface.parent();
        let wayland_client_pid = wl0
            .client()
            .and_then(|c: Client| c.get_credentials(&self.core.display_handle).ok())
            .map(|cr| cr.pid);
        if title.trim().is_empty() && app_id.trim().is_empty() {
            if let Some(process_name) = process_name_for_pid(wayland_client_pid) {
                title.clone_from(&process_name);
                app_id = process_name;
            }
        }
        let map_at_output_origin =
            self.toplevel_is_embedded_shell_host(&title, &app_id, wayland_client_pid);
        let defer_map = crate::state::toplevel_should_defer_initial_map(
            parent.as_ref(),
            &raw_title,
            &raw_app_id,
            map_at_output_origin,
        );
        let window = Window::new_wayland_window(surface);
        let parent_protocol_id = parent.as_ref().map(|p| p.id().protocol_id());
        self.windows
            .window_registry
            .register_toplevel(&wl0, title, app_id, wayland_client_pid);
        let reg = self
            .windows
            .window_registry
            .snapshot_for_wl_surface(&wl0)
            .expect("just registered");
        self.capture_refresh_window_source_cache(reg.window_id);
        if let Some(toplevel) = window.toplevel() {
            self.prepare_xdg_toplevel_configure(&toplevel, None);
        }
        let initial_client_rect = if map_at_output_origin {
            None
        } else {
            self.new_toplevel_initial_client_rect(&window, parent.as_ref())
        };
        let defer_initial_map = defer_map || initial_client_rect.is_some();

        let existing_before = self.output_topology.space.elements().count();
        let (map_x, map_y) = if map_at_output_origin {
            self.primary_output_logical_origin()
        } else {
            self.new_toplevel_initial_location(&window, parent.as_ref())
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
        tracing::warn!(
            target: "derp_toplevel",
            window_id = reg.window_id,
            surface_id = reg.surface_id,
            title = %reg.title,
            app_id = %reg.app_id,
            wayland_client_pid = ?wayland_client_pid,
            parent_protocol_id = ?parent_protocol_id,
            defer_map = defer_initial_map,
            bbox = ?window.bbox(),
            geometry = ?window.geometry(),
            "xdg new_toplevel"
        );
        tracing::warn!(
            target: "derp_toplevel",
            window_id = reg.window_id,
            compositor_surface_id = reg.surface_id,
            wl_surface_protocol_id = wl0.id().protocol_id(),
            wayland_client_id = ?wl0.client().map(|c| c.id()),
            wayland_client_pid = ?wayland_client_pid,
            title_len = reg.title.len(),
            parent_wl_surface_protocol_id = ?parent.as_ref().map(|p| p.id().protocol_id()),
            defer_map = defer_initial_map,
            map_at_output_origin,
            will_emit_WindowMapped_immediately = !defer_initial_map,
            "xdg new_toplevel staging check"
        );
        if !map_at_output_origin {
            self.windows
                .pending_gnome_initial_toplevels
                .insert(reg.window_id);
        }
        if defer_initial_map {
            let _ = self.windows.window_registry.transition(
                reg.window_id,
                crate::window_registry::WindowLifecycleEvent::DeferInitialMap,
            );
            let key =
                crate::window_registry::wl_surface_key(&wl0).expect("new_toplevel surface key");
            self.windows.pending_deferred_toplevels.insert(
                key,
                crate::state::PendingDeferredToplevel {
                    window: window.clone(),
                    map_x,
                    map_y,
                    initial_client_rect,
                },
            );
            self.output_topology.space.map_element(
                DerpSpaceElem::Wayland(window.clone()),
                (map_x, map_y),
                false,
            );
            if let Some(tl) = window.toplevel() {
                if let Some(rect) = initial_client_rect {
                    tl.with_pending_state(|state| {
                        state.states.unset(xdg_toplevel::State::Fullscreen);
                        state.fullscreen_output = None;
                        state.states.unset(xdg_toplevel::State::Maximized);
                        state.size = Some(smithay::utils::Size::from((
                            rect.size.w.max(1),
                            rect.size.h.max(1),
                        )));
                    });
                }
                self.send_xdg_toplevel_configure(&tl, None);
            }
            tracing::warn!(
                target: "derp_toplevel",
                window_id = reg.window_id,
                wl_surface_protocol_id = wl0.id().protocol_id(),
                "xdg new_toplevel deferred until app_id"
            );
        } else {
            let _ = self.windows.window_registry.transition(
                reg.window_id,
                crate::window_registry::WindowLifecycleEvent::Map,
            );
            self.output_topology.space.map_element(
                DerpSpaceElem::Wayland(window.clone()),
                (map_x, map_y),
                false,
            );

            self.notify_geometry_if_changed(&window);
            let info = self
                .windows
                .window_registry
                .snapshot_for_wl_surface(&wl0)
                .expect("xdg new_toplevel: registry row after notify");
            tracing::warn!(
                target: "derp_toplevel",
                window_id = reg.window_id,
                title = %info.title,
                app_id = %info.app_id,
                "xdg new_toplevel emitted WindowMapped immediate map"
            );
            let spawn_focus_wid = info.window_id;
            self.scratchpad_consider_window(spawn_focus_wid);
            let current_info = self
                .windows
                .window_registry
                .window_info(spawn_focus_wid)
                .unwrap_or(info);
            let output_name = current_info.output_name.clone();
            let pending_activation_focus =
                self.windows.shell_pending_native_focus_window_id == Some(spawn_focus_wid);
            let shell_status_indicator = self.window_is_shell_status_indicator(&current_info);
            if !(self
                .workspace_layout
                .scratchpad_windows
                .contains_key(&spawn_focus_wid)
                && current_info.minimized)
            {
                self.shell_emit_chrome_event(ChromeEvent::WindowMapped { info: current_info });
            }
            if shell_status_indicator {
                self.raise_shell_status_indicators();
            } else if !self
                .workspace_layout
                .scratchpad_windows
                .contains_key(&spawn_focus_wid)
            {
                if pending_activation_focus {
                    self.shell_raise_and_focus_window(spawn_focus_wid);
                    self.shell_reply_window_list();
                } else {
                    self.shell_consider_focus_spawned_toplevel(spawn_focus_wid);
                }
                let _ = self.workspace_apply_auto_layout_for_output_name(&output_name);
                if pending_activation_focus {
                    let order = self.shell_window_order_message();
                    self.shell_send_to_cef(order);
                }
            }
        }
    }

    fn toplevel_destroyed(&mut self, surface: ToplevelSurface) {
        let wl = surface.wl_surface();
        let window_id_pre = self.windows.window_registry.window_id_for_wl_surface(wl);
        let keyboard_had_focus_here =
            window_id_pre.is_some_and(|id| self.keyboard_focused_window_id() == Some(id));
        let removed_pre = self.windows.window_registry.snapshot_for_wl_surface(wl);
        let mut had_pending_deferred = window_id_pre.is_some_and(|window_id| {
            self.windows.window_registry.lifecycle(window_id)
                == Some(crate::window_registry::WindowLifecycle::DeferredInitialMap)
        });
        if let Some(k) = crate::window_registry::wl_surface_key(wl) {
            let removed_pending_payload =
                self.windows.pending_deferred_toplevels.remove(&k).is_some();
            if removed_pending_payload {
                had_pending_deferred = true;
                tracing::warn!(
                    target: "derp_toplevel",
                    wl_surface_protocol_id = wl.id().protocol_id(),
                    ?removed_pre,
                    "toplevel_destroyed removed pending deferred surface"
                );
            }
        }
        let window_opt = self.output_topology.space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                (w.toplevel().unwrap().wl_surface() == wl).then_some(w.clone())
            } else {
                None
            }
        });
        if let Some(w) = window_opt {
            self.output_topology
                .space
                .unmap_elem(&DerpSpaceElem::Wayland(w));
        }
        if let Some(wid) = self.windows.window_registry.window_id_for_wl_surface(wl) {
            self.clear_toplevel_layout_maps(wid);
            self.windows.pending_gnome_initial_toplevels.remove(&wid);
        }
        let removed = self.windows.window_registry.snapshot_for_wl_surface(wl);
        if let Some(window_id) = self.windows.window_registry.remove_by_wl_surface(wl) {
            self.cancel_shell_move_resize_for_window(window_id);
            self.capture_forget_window_source_cache(window_id);
            self.windows
                .shell_close_pending_native_windows
                .remove(&window_id);
            self.shell_window_stack_forget(window_id);
            self.windows.window_registry.clear_restore_handle(window_id);
            let live_window_ids = self
                .windows
                .window_registry
                .all_infos()
                .into_iter()
                .map(|info| info.window_id)
                .collect::<Vec<_>>();
            self.workspace_layout
                .workspace_sync_from_live_window_ids(&live_window_ids);
            if let Some(ref meta) = removed {
                tracing::warn!(
                    target: "derp_toplevel",
                    window_id,
                    title = %meta.title,
                    app_id = %meta.app_id,
                    wl_surface_protocol_id = wl.id().protocol_id(),
                    "toplevel_destroyed registry removed"
                );
            }
            if !had_pending_deferred {
                self.shell_emit_chrome_window_unmapped(window_id, removed);
            }
            self.try_refocus_after_closed_window(window_id, keyboard_had_focus_here);
        }
    }

    fn title_changed(&mut self, surface: ToplevelSurface) {
        let wl = surface.wl_surface();
        let old = self.windows.window_registry.snapshot_for_wl_surface(wl);
        let title = toplevel_title_app_id(&surface).0;
        if let Some(true) = self.windows.window_registry.set_title(wl, title) {
            let info = self
                .windows
                .window_registry
                .snapshot_for_wl_surface(wl)
                .expect("title_changed: registry row");
            let old_shell = old
                .as_ref()
                .map(|i| self.window_info_is_solid_shell_host(i))
                .unwrap_or(false);
            let new_shell = self.window_info_is_solid_shell_host(&info);
            let old_visible = old
                .as_ref()
                .map(shell_window_row_should_show)
                .unwrap_or(false);
            let new_visible = shell_window_row_should_show(&info);
            if new_shell && !old_shell {
                self.shell_retract_phantom_shell_window(info.window_id);
            } else if old_visible && !new_visible {
                self.shell_retract_phantom_shell_window(info.window_id);
                self.raise_shell_status_indicators();
            } else if !new_shell && !self.window_id_is_deferred_initial_map(info.window_id) {
                let window_id = info.window_id;
                self.shell_emit_chrome_event(ChromeEvent::WindowMetadataChanged { info });
                self.scratchpad_consider_window(window_id);
            }
        }
        self.xdg_sync_pending_deferred_toplevel(wl);
    }

    fn app_id_changed(&mut self, surface: ToplevelSurface) {
        let wl = surface.wl_surface();
        let old = self.windows.window_registry.snapshot_for_wl_surface(wl);
        let app_id = toplevel_title_app_id(&surface).1;
        if let Some(true) = self.windows.window_registry.set_app_id(wl, app_id) {
            let info = self
                .windows
                .window_registry
                .snapshot_for_wl_surface(wl)
                .expect("app_id_changed: registry row");
            let old_shell = old
                .as_ref()
                .map(|i| self.window_info_is_solid_shell_host(i))
                .unwrap_or(false);
            let new_shell = self.window_info_is_solid_shell_host(&info);
            let old_visible = old
                .as_ref()
                .map(shell_window_row_should_show)
                .unwrap_or(false);
            let new_visible = shell_window_row_should_show(&info);
            if new_shell && !old_shell {
                self.shell_retract_phantom_shell_window(info.window_id);
            } else if old_visible && !new_visible {
                self.shell_retract_phantom_shell_window(info.window_id);
                self.raise_shell_status_indicators();
            } else if !new_shell && !self.window_id_is_deferred_initial_map(info.window_id) {
                let window_id = info.window_id;
                self.shell_emit_chrome_event(ChromeEvent::WindowMetadataChanged { info });
                self.scratchpad_consider_window(window_id);
            }
        }
        self.xdg_sync_pending_deferred_toplevel(wl);
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
        if let Some(info) = self
            .windows
            .window_registry
            .snapshot_for_wl_surface(wl_surface)
        {
            if self.window_info_is_solid_shell_host(&info) {
                return;
            }
        }

        let seat = Seat::from_resource(&seat).unwrap();

        if check_grab(&seat, wl_surface, serial).is_some() {
            if let Some(window_id) = self
                .windows
                .window_registry
                .window_id_for_wl_surface(wl_surface)
            {
                self.shell_client_move_begin(window_id);
            }
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

        if check_grab(&seat, wl_surface, serial).is_some() {
            if let Some(window_id) = self
                .windows
                .window_registry
                .window_id_for_wl_surface(wl_surface)
            {
                self.shell_resize_begin(window_id, xdg_resize_edges_to_wire(edges));
            }
        }
    }

    fn minimize_request(&mut self, surface: ToplevelSurface) {
        let wl = surface.wl_surface();
        let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl) else {
            return;
        };
        self.shell_minimize_window(window_id);
    }

    fn maximize_request(&mut self, surface: ToplevelSurface) {
        let wl = surface.wl_surface();
        if let Some(info) = self.windows.window_registry.snapshot_for_wl_surface(wl) {
            if self.window_info_is_solid_shell_host(&info) {
                return;
            }
        }
        let Some(window) = self.output_topology.space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                (w.toplevel().unwrap().wl_surface() == wl).then_some(w.clone())
            } else {
                None
            }
        }) else {
            return;
        };
        let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl) else {
            return;
        };
        if read_toplevel_tiling(wl).0 {
            return;
        }
        if read_toplevel_tiling(wl).1 {
            return;
        }
        if !self
            .windows
            .toplevel_floating_restore
            .contains_key(&window_id)
        {
            if let Some(s) = self.toplevel_rect_snapshot(&window) {
                self.windows.toplevel_floating_restore.insert(window_id, s);
            }
        }
        let _ = self.apply_toplevel_maximize_layout(&window);
    }

    fn unmaximize_request(&mut self, surface: ToplevelSurface) {
        let wl = surface.wl_surface();
        if let Some(info) = self.windows.window_registry.snapshot_for_wl_surface(wl) {
            if self.window_info_is_solid_shell_host(&info) {
                return;
            }
        }
        let Some(window) = self.output_topology.space.elements().find_map(|e| {
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
        if let Some(info) = self.windows.window_registry.snapshot_for_wl_surface(wl) {
            if self.window_info_is_solid_shell_host(&info) {
                return;
            }
        }
        let Some(window) = self.output_topology.space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                (w.toplevel().unwrap().wl_surface() == wl).then_some(w.clone())
            } else {
                None
            }
        }) else {
            return;
        };
        let Some(window_id) = self.windows.window_registry.window_id_for_wl_surface(wl) else {
            return;
        };
        if read_toplevel_tiling(wl).1 {
            return;
        }
        if read_toplevel_tiling(wl).0 {
            self.windows
                .toplevel_fullscreen_return_maximized
                .insert(window_id);
        } else {
            self.windows
                .toplevel_fullscreen_return_maximized
                .remove(&window_id);
            if !self
                .windows
                .toplevel_floating_restore
                .contains_key(&window_id)
            {
                if let Some(s) = self.toplevel_rect_snapshot(&window) {
                    self.windows.toplevel_floating_restore.insert(window_id, s);
                }
            }
        }
        let _ = self.apply_toplevel_fullscreen_layout(&window, output);
    }

    fn unfullscreen_request(&mut self, surface: ToplevelSurface) {
        let wl = surface.wl_surface();
        if let Some(info) = self.windows.window_registry.snapshot_for_wl_surface(wl) {
            if self.window_info_is_solid_shell_host(&info) {
                return;
            }
        }
        let Some(window) = self.output_topology.space.elements().find_map(|e| {
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

    fn grab(&mut self, surface: PopupSurface, seat: wl_seat::WlSeat, serial: Serial) {
        let Some(seat) = Seat::from_resource(&seat) else {
            return;
        };
        if seat != self.input_routing.seat {
            return;
        }
        let popup = PopupKind::Xdg(surface);
        let Ok(root) = find_popup_root_surface(&popup) else {
            return;
        };
        let Ok(mut grab) = self
            .popups
            .grab_popup::<CompositorState>(root, popup, &seat, serial)
        else {
            return;
        };
        if let Some(keyboard) = seat.get_keyboard() {
            if keyboard.is_grabbed()
                && !(keyboard.has_grab(serial)
                    || keyboard.has_grab(grab.previous_serial().unwrap_or(serial)))
            {
                let _ = grab.ungrab(smithay::desktop::PopupUngrabStrategy::All);
                return;
            }
            keyboard.set_focus(self, grab.current_grab(), serial);
            keyboard.set_grab(self, DerpPopupKeyboardGrab::new(&grab), serial);
        }
        if let Some(pointer) = seat.get_pointer() {
            if pointer.is_grabbed()
                && !(pointer.has_grab(serial)
                    || pointer.has_grab(grab.previous_serial().unwrap_or_else(|| grab.serial())))
            {
                let _ = grab.ungrab(smithay::desktop::PopupUngrabStrategy::All);
                return;
            }
            pointer.set_grab(self, DerpPopupPointerGrab::new(&grab), serial, Focus::Keep);
        }
    }
}

delegate_xdg_shell!(crate::CompositorState);

struct DerpPopupKeyboardGrab {
    popup_grab: smithay::desktop::PopupGrab<CompositorState>,
}

struct DerpPopupPointerGrab {
    popup_grab: smithay::desktop::PopupGrab<CompositorState>,
}

impl DerpPopupPointerGrab {
    fn new(popup_grab: &smithay::desktop::PopupGrab<CompositorState>) -> Self {
        Self {
            popup_grab: popup_grab.clone(),
        }
    }
}

impl PointerGrab<CompositorState> for DerpPopupPointerGrab {
    fn motion(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        focus: Option<(
            WlSurface,
            smithay::utils::Point<f64, smithay::utils::Logical>,
        )>,
        event: &MotionEvent,
    ) {
        if self.popup_grab.has_ended() {
            handle.unset_grab(self, data, event.serial, event.time, true);
            return;
        }
        if focus
            .as_ref()
            .and_then(|f1| {
                self.popup_grab
                    .current_grab()
                    .as_ref()
                    .and_then(|f2| f2.wl_surface())
                    .map(|s| f1.0.same_client_as(&s.id()))
            })
            .unwrap_or(false)
        {
            handle.motion(data, focus, event);
        } else {
            handle.motion(data, None, event);
        }
    }

    fn relative_motion(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        focus: Option<(
            WlSurface,
            smithay::utils::Point<f64, smithay::utils::Logical>,
        )>,
        event: &RelativeMotionEvent,
    ) {
        handle.relative_motion(data, focus, event);
    }

    fn button(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &ButtonEvent,
    ) {
        let serial = event.serial;
        let time = event.time;
        if self.popup_grab.has_ended() {
            handle.unset_grab(self, data, serial, time, true);
            handle.button(data, event);
            return;
        }
        if event.state == smithay::backend::input::ButtonState::Pressed
            && !handle
                .current_focus()
                .and_then(|f| {
                    self.popup_grab
                        .current_grab()
                        .and_then(|f2| f.0.wl_surface().map(|s| f2.same_client_as(&s.id())))
                })
                .unwrap_or(false)
        {
            let _ = self
                .popup_grab
                .ungrab(smithay::desktop::PopupUngrabStrategy::All);
            handle.unset_grab(self, data, serial, time, true);
            handle.button(data, event);
            return;
        }
        handle.button(data, event);
    }

    fn axis(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        details: AxisFrame,
    ) {
        handle.axis(data, details);
    }

    fn frame(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
    ) {
        handle.frame(data);
    }

    fn gesture_swipe_begin(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GestureSwipeBeginEvent,
    ) {
        handle.gesture_swipe_begin(data, event);
    }

    fn gesture_swipe_update(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GestureSwipeUpdateEvent,
    ) {
        handle.gesture_swipe_update(data, event);
    }

    fn gesture_swipe_end(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GestureSwipeEndEvent,
    ) {
        handle.gesture_swipe_end(data, event);
    }

    fn gesture_pinch_begin(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GesturePinchBeginEvent,
    ) {
        handle.gesture_pinch_begin(data, event);
    }

    fn gesture_pinch_update(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GesturePinchUpdateEvent,
    ) {
        handle.gesture_pinch_update(data, event);
    }

    fn gesture_pinch_end(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GesturePinchEndEvent,
    ) {
        handle.gesture_pinch_end(data, event);
    }

    fn gesture_hold_begin(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GestureHoldBeginEvent,
    ) {
        handle.gesture_hold_begin(data, event);
    }

    fn gesture_hold_end(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GestureHoldEndEvent,
    ) {
        handle.gesture_hold_end(data, event);
    }

    fn start_data(&self) -> &PointerGrabStartData<CompositorState> {
        self.popup_grab.pointer_grab_start_data()
    }

    fn unset(&mut self, _data: &mut CompositorState) {}
}

impl DerpPopupKeyboardGrab {
    fn new(popup_grab: &smithay::desktop::PopupGrab<CompositorState>) -> Self {
        Self {
            popup_grab: popup_grab.clone(),
        }
    }
}

impl KeyboardGrab<CompositorState> for DerpPopupKeyboardGrab {
    fn input(
        &mut self,
        data: &mut CompositorState,
        handle: &mut KeyboardInnerHandle<'_, CompositorState>,
        keycode: Keycode,
        state: smithay::backend::input::KeyState,
        modifiers: Option<ModifiersState>,
        serial: Serial,
        time: u32,
    ) {
        if state == smithay::backend::input::KeyState::Pressed
            && (keycode == Keycode::from(1u32) || keycode == Keycode::from(9u32))
        {
            let focus = self
                .popup_grab
                .ungrab(smithay::desktop::PopupUngrabStrategy::Topmost);
            handle.set_focus(data, focus, SERIAL_COUNTER.next_serial());
            if self.popup_grab.has_ended() {
                handle.unset_grab(self, data, serial, false);
            }
            return;
        }
        if let Some(focus) = self.popup_grab.current_grab() {
            handle.set_focus(data, Some(focus), serial);
        }
        if self.popup_grab.has_ended() {
            handle.unset_grab(self, data, serial, false);
        }
        handle.input(data, keycode, state, modifiers, serial, time)
    }

    fn set_focus(
        &mut self,
        data: &mut CompositorState,
        handle: &mut KeyboardInnerHandle<'_, CompositorState>,
        focus: Option<WlSurface>,
        serial: Serial,
    ) {
        if self.popup_grab.has_ended() {
            handle.set_focus(data, focus, serial);
            handle.unset_grab(self, data, serial, false);
            return;
        }
        if self.popup_grab.current_grab() == focus {
            handle.set_focus(data, focus, serial);
        }
    }

    fn start_data(&self) -> &KeyboardGrabStartData<CompositorState> {
        self.popup_grab.keyboard_grab_start_data()
    }

    fn unset(&mut self, _data: &mut CompositorState) {}
}

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

fn xdg_resize_edges_to_wire(edges: xdg_toplevel::ResizeEdge) -> u32 {
    match edges {
        xdg_toplevel::ResizeEdge::Top => shell_wire::RESIZE_EDGE_TOP,
        xdg_toplevel::ResizeEdge::Bottom => shell_wire::RESIZE_EDGE_BOTTOM,
        xdg_toplevel::ResizeEdge::Left => shell_wire::RESIZE_EDGE_LEFT,
        xdg_toplevel::ResizeEdge::Right => shell_wire::RESIZE_EDGE_RIGHT,
        xdg_toplevel::ResizeEdge::TopLeft => {
            shell_wire::RESIZE_EDGE_TOP | shell_wire::RESIZE_EDGE_LEFT
        }
        xdg_toplevel::ResizeEdge::BottomLeft => {
            shell_wire::RESIZE_EDGE_BOTTOM | shell_wire::RESIZE_EDGE_LEFT
        }
        xdg_toplevel::ResizeEdge::TopRight => {
            shell_wire::RESIZE_EDGE_TOP | shell_wire::RESIZE_EDGE_RIGHT
        }
        xdg_toplevel::ResizeEdge::BottomRight => {
            shell_wire::RESIZE_EDGE_BOTTOM | shell_wire::RESIZE_EDGE_RIGHT
        }
        _ => 0,
    }
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
        let Some(window) = self.output_topology.space.elements().find_map(|e| {
            if let DerpSpaceElem::Wayland(w) = e {
                (w.toplevel().unwrap().wl_surface() == &root).then_some(w.clone())
            } else {
                None
            }
        }) else {
            return;
        };

        let window_geo = self
            .output_topology
            .space
            .element_geometry(&DerpSpaceElem::Wayland(window.clone()))
            .unwrap();
        let wg = &window_geo;
        let output = self
            .output_for_global_xywh(wg.loc.x, wg.loc.y, wg.size.w, wg.size.h)
            .or_else(|| self.leftmost_output())
            .unwrap();
        let output_geo = self.output_topology.space.output_geometry(&output).unwrap();

        let mut target = output_geo;
        target.loc -= get_popup_toplevel_coords(&PopupKind::Xdg(popup.clone()));
        target.loc -= window_geo.loc;

        popup.with_pending_state(|state| {
            state.geometry = state.positioner.get_unconstrained_geometry(target);
        });
    }
}
