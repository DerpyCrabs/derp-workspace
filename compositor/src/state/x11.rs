use super::*;

impl XWaylandShellHandler for CompositorState {
    fn xwayland_shell_state(&mut self) -> &mut XWaylandShellState {
        &mut self.xwayland_shell_state
    }

    fn surface_associated(&mut self, _xwm_id: XwmId, surface: WlSurface, window: X11Surface) {
        tracing::warn!(
            wl_surface_protocol_id = surface.id().protocol_id(),
            x11_geo = ?window.geometry(),
            x11_override_redirect = window.is_override_redirect(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 surface_associated"
        );
        if let Some(info) = self.ensure_x11_window_registered(&surface, &window) {
            let restored = self.shell_restore_tray_hidden_x11_window(info.window_id, &window);
            if self.shell_pending_native_focus_window_id == Some(info.window_id) {
                self.shell_raise_and_focus_window(info.window_id);
            }
            let elem = DerpSpaceElem::X11(window.clone());
            if self.space.elements().any(|e| *e == elem) && (!info.minimized || restored) {
                let window_id = info.window_id;
                self.scratchpad_consider_window(window_id);
                let current_info = self.window_registry.window_info(window_id).unwrap_or(info);
                let output_name = current_info.output_name.clone();
                if !(self.scratchpad_windows.contains_key(&window_id) && current_info.minimized) {
                    self.shell_emit_chrome_event(ChromeEvent::WindowMapped { info: current_info });
                }
                if !self.scratchpad_windows.contains_key(&window_id) {
                    self.shell_consider_focus_spawned_toplevel(window_id);
                    let _ = self.workspace_apply_auto_layout_for_output_name(&output_name);
                }
            }
        }
        self.loop_signal.wakeup();
    }
}

impl XwmHandler for CompositorState {
    fn xwm_state(&mut self, xwm: XwmId) -> &mut X11Wm {
        let (id, wm) = self
            .x11_wm_slot
            .as_mut()
            .expect("X11 WM should exist while handling X11 events");
        assert_eq!(*id, xwm);
        wm
    }

    fn new_window(&mut self, _xwm: XwmId, window: X11Surface) {
        tracing::warn!(
            x11_geo = ?window.geometry(),
            x11_override_redirect = window.is_override_redirect(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 new_window"
        );
    }

    fn new_override_redirect_window(&mut self, _xwm: XwmId, window: X11Surface) {
        tracing::warn!(
            x11_geo = ?window.geometry(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 new_override_redirect_window"
        );
    }

    fn map_window_request(&mut self, _xwm: XwmId, window: X11Surface) {
        tracing::warn!(
            x11_geo = ?window.geometry(),
            x11_override_redirect = window.is_override_redirect(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 map_window_request"
        );
        if window.is_override_redirect() {
            return;
        }
        if let Err(e) = window.set_mapped(true) {
            tracing::warn!(?e, "x11 map_window_request set_mapped");
            return;
        }
        let geo = self.x11_initial_map_rect(&window);
        if geo != window.geometry() {
            if let Err(error) = window.configure(Some(geo)) {
                tracing::warn!(?error, geometry = ?geo, "x11 map_window_request initial configure");
            }
        }
        let elem = DerpSpaceElem::X11(window.clone());
        let was_mapped = self.space.elements().any(|e| *e == elem);
        self.space.map_element(elem, (geo.loc.x, geo.loc.y), false);
        if let Some(surface) = window.wl_surface() {
            if let Some(info) = self.ensure_x11_window_registered(&surface, &window) {
                let restored = self.shell_restore_tray_hidden_x11_window(info.window_id, &window);
                if (!was_mapped || restored) && !info.minimized {
                    let window_id = info.window_id;
                    self.scratchpad_consider_window(window_id);
                    let current_info = self.window_registry.window_info(window_id).unwrap_or(info);
                    let output_name = current_info.output_name.clone();
                    if !(self.scratchpad_windows.contains_key(&window_id) && current_info.minimized)
                    {
                        self.shell_emit_chrome_event(ChromeEvent::WindowMapped {
                            info: current_info,
                        });
                    }
                    if !self.scratchpad_windows.contains_key(&window_id) {
                        self.shell_consider_focus_spawned_toplevel(window_id);
                        let _ = self.workspace_apply_auto_layout_for_output_name(&output_name);
                    }
                } else {
                    self.emit_x11_window_updates(&window, true, true);
                }
            }
        }
        self.loop_signal.wakeup();
    }

    fn mapped_override_redirect_window(&mut self, _xwm: XwmId, window: X11Surface) {
        tracing::warn!(
            x11_geo = ?window.geometry(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 mapped_override_redirect_window"
        );
        let geo = window.geometry();
        self.space.map_element(
            DerpSpaceElem::X11(window.clone()),
            (geo.loc.x, geo.loc.y),
            false,
        );
        self.loop_signal.wakeup();
    }

    fn unmapped_window(&mut self, _xwm: XwmId, window: X11Surface) {
        tracing::warn!(
            x11_geo = ?window.geometry(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 unmapped_window"
        );
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            if self.shell_x11_window_is_tray_hidden(window_id) {
                self.space.unmap_elem(&DerpSpaceElem::X11(window.clone()));
                self.shell_reply_window_list();
                self.loop_signal.wakeup();
                return;
            }
            if self.shell_minimized_x11_windows.contains_key(&window_id)
                && !self.shell_close_pending_native_windows.contains(&window_id)
            {
                self.space.unmap_elem(&DerpSpaceElem::X11(window.clone()));
                self.emit_x11_window_updates(&window, false, false);
                return;
            }
        }
        self.cleanup_x11_window(&window, true);
    }

    fn destroyed_window(&mut self, xwm: XwmId, window: X11Surface) {
        let _ = xwm;
        self.cleanup_x11_window(&window, true);
    }

    fn configure_request(
        &mut self,
        _xwm: XwmId,
        window: X11Surface,
        x: Option<i32>,
        y: Option<i32>,
        w: Option<u32>,
        h: Option<u32>,
        _reorder: Option<Reorder>,
    ) {
        tracing::warn!(
            request_x = x,
            request_y = y,
            request_w = w,
            request_h = h,
            x11_geo = ?window.geometry(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 configure_request"
        );
        let mut geo = window.geometry();
        if let Some(x) = x {
            geo.loc.x = x;
        }
        if let Some(y) = y {
            geo.loc.y = y;
        }
        if let Some(w) = w {
            geo.size.w = w as i32;
        }
        if let Some(h) = h {
            geo.size.h = h as i32;
        }
        if let Err(e) = window.configure(Some(geo)) {
            tracing::warn!(?e, "x11 configure_request");
        } else {
            self.emit_x11_window_updates(&window, true, false);
        }
    }

    fn configure_notify(
        &mut self,
        _xwm: XwmId,
        window: X11Surface,
        geometry: Rectangle<i32, Logical>,
        _above: Option<X11Window>,
    ) {
        tracing::warn!(
            geometry = ?geometry,
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 configure_notify"
        );
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            if self.shell_pending_native_focus_window_id == Some(window_id)
                && window.wl_surface().is_some()
            {
                self.shell_raise_and_focus_window(window_id);
            }
        }
        let elem = DerpSpaceElem::X11(window.clone());
        if self.space.elements().any(|e| *e == elem) {
            self.space
                .map_element(elem, (geometry.loc.x, geometry.loc.y), false);
        }
        self.emit_x11_window_updates(&window, true, false);
    }

    fn property_notify(
        &mut self,
        _xwm: XwmId,
        window: X11Surface,
        property: smithay::xwayland::xwm::WmWindowProperty,
    ) {
        tracing::warn!(
            ?property,
            x11_window_id = window.window_id(),
            x11_has_wl_surface = window.wl_surface().is_some(),
            "x11 property_notify"
        );
        let force_metadata_emit = matches!(
            property,
            smithay::xwayland::xwm::WmWindowProperty::Title
                | smithay::xwayland::xwm::WmWindowProperty::Class
                | smithay::xwayland::xwm::WmWindowProperty::MotifHints
                | smithay::xwayland::xwm::WmWindowProperty::Pid
        );
        let updated = self.emit_x11_window_updates(&window, false, force_metadata_emit);
        if force_metadata_emit {
            if let Some(info) = updated {
                self.scratchpad_consider_window(info.window_id);
            }
        }
    }

    fn maximize_request(&mut self, _xwm: XwmId, window: X11Surface) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            self.shell_set_window_maximized(window_id, true);
        }
    }

    fn unmaximize_request(&mut self, _xwm: XwmId, window: X11Surface) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            self.shell_set_window_maximized(window_id, false);
        }
    }

    fn fullscreen_request(&mut self, _xwm: XwmId, window: X11Surface) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            self.shell_set_window_fullscreen(window_id, true);
        }
    }

    fn unfullscreen_request(&mut self, _xwm: XwmId, window: X11Surface) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            self.shell_set_window_fullscreen(window_id, false);
        }
    }

    fn minimize_request(&mut self, _xwm: XwmId, window: X11Surface) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            self.shell_minimize_window(window_id);
        }
    }

    fn unminimize_request(&mut self, _xwm: XwmId, window: X11Surface) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            self.shell_restore_minimized_window(window_id);
        }
    }

    fn resize_request(&mut self, _xwm: XwmId, window: X11Surface, _button: u32, edges: ResizeEdge) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            let edges_wire = match edges {
                ResizeEdge::Top => crate::grabs::resize_grab::ResizeEdge::TOP,
                ResizeEdge::Bottom => crate::grabs::resize_grab::ResizeEdge::BOTTOM,
                ResizeEdge::Left => crate::grabs::resize_grab::ResizeEdge::LEFT,
                ResizeEdge::TopLeft => crate::grabs::resize_grab::ResizeEdge::TOP_LEFT,
                ResizeEdge::BottomLeft => crate::grabs::resize_grab::ResizeEdge::BOTTOM_LEFT,
                ResizeEdge::Right => crate::grabs::resize_grab::ResizeEdge::RIGHT,
                ResizeEdge::TopRight => crate::grabs::resize_grab::ResizeEdge::TOP_RIGHT,
                ResizeEdge::BottomRight => crate::grabs::resize_grab::ResizeEdge::BOTTOM_RIGHT,
            };
            self.shell_resize_begin(window_id, edges_wire.bits());
        }
    }

    fn move_request(&mut self, _xwm: XwmId, window: X11Surface, _button: u32) {
        if let Some(window_id) = self.x11_window_id_for_surface(&window) {
            self.shell_move_begin(window_id);
        }
    }

    fn allow_selection_access(&mut self, xwm: XwmId, _selection: SelectionTarget) -> bool {
        self.seat
            .get_keyboard()
            .and_then(|keyboard| keyboard.current_focus())
            .and_then(|surface| self.x11_window_containing_surface(&surface))
            .is_some_and(|window| window.xwm_id() == Some(xwm))
    }

    fn send_selection(
        &mut self,
        _xwm: XwmId,
        selection: SelectionTarget,
        mime_type: String,
        fd: OwnedFd,
    ) {
        if selection != SelectionTarget::Clipboard {
            return;
        }
        if let Some(user_data) = current_data_device_selection_userdata(&self.seat) {
            if user_data.is_empty() || mime_type != "image/png" {
                return;
            }
            let mut file = std::fs::File::from(fd);
            if let Err(error) = file.write_all(user_data.as_slice()) {
                tracing::warn!(%error, "clipboard image write failed");
            }
            return;
        }
        if let Err(error) = request_data_device_client_selection(&self.seat, mime_type, fd) {
            tracing::warn!(
                ?error,
                "failed to request current wayland clipboard for xwayland"
            );
        }
    }

    fn new_selection(&mut self, _xwm: XwmId, selection: SelectionTarget, mime_types: Vec<String>) {
        if selection != SelectionTarget::Clipboard {
            return;
        }
        set_data_device_selection(
            &self.display_handle,
            &self.seat,
            mime_types,
            Arc::new(Vec::new()),
        );
    }

    fn cleared_selection(&mut self, _xwm: XwmId, selection: SelectionTarget) {
        if selection != SelectionTarget::Clipboard {
            return;
        }
        if current_data_device_selection_userdata(&self.seat).is_some() {
            clear_data_device_selection(&self.display_handle, &self.seat);
        }
    }

    fn disconnected(&mut self, _xwm: XwmId) {
        tracing::warn!("XWayland WM disconnected from X server");
        self.x11_wm_slot = None;
        self.x11_client = None;
    }
}

