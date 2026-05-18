use super::*;

impl CompositorState {
    pub fn find_window_by_surface_id(&self, surface_id: u32) -> Option<Window> {
        self.windows
            .find_window_by_surface_id(&self.output_topology.space, surface_id)
    }

    pub(crate) fn x11_window_id_for_surface(&self, window: &X11Surface) -> Option<u32> {
        self.windows.x11_window_id_for_surface(window)
    }

    pub(crate) fn find_x11_window_by_surface_id(&self, surface_id: u32) -> Option<X11Surface> {
        self.windows
            .find_x11_window_by_surface_id(&self.output_topology.space, surface_id)
    }

    pub(crate) fn find_x11_window_by_window_id(&self, window_id: u32) -> Option<X11Surface> {
        self.windows
            .find_x11_window_by_window_id(&self.output_topology.space, window_id)
    }

    pub(crate) fn xwayland_scale_for_window_id(&self, window_id: u32) -> Option<f64> {
        let x11 = self.find_x11_window_by_window_id(window_id)?;
        Some(self.xwayland_scale_for_space_element(&DerpSpaceElem::X11(x11)))
    }

    pub(crate) fn x11_window_title_app_id(window: &X11Surface) -> (String, String) {
        WindowManagementState::x11_window_title_app_id(window)
    }

    pub(crate) fn x11_window_should_hide_to_tray_on_close(&self, info: &WindowInfo) -> bool {
        self.tray_notifications
            .x11_window_should_hide_to_tray_on_close(info)
    }

    pub(crate) fn x11_window_is_shell_status_indicator(&self, window: &X11Surface) -> bool {
        window.is_above()
            || window.is_skip_taskbar()
            || matches!(
                window.window_type(),
                Some(
                    WmWindowType::Notification
                        | WmWindowType::Utility
                        | WmWindowType::Tooltip
                        | WmWindowType::Splash
                )
            )
    }

    pub(crate) fn window_is_shell_status_indicator(&self, info: &WindowInfo) -> bool {
        if window_title_is_screen_sharing_indicator(&info.title) {
            return true;
        }
        self.find_x11_window_by_window_id(info.window_id)
            .is_some_and(|window| self.x11_window_is_shell_status_indicator(&window))
    }

    pub(crate) fn raise_shell_status_indicators(&mut self) -> bool {
        let mut raised = false;
        let stack_z_by_window_id = self.stack_z_by_window_id();
        let mut indicators: Vec<(u32, u32)> = self
            .windows
            .window_registry
            .all_infos()
            .into_iter()
            .filter(|info| !info.minimized && self.window_is_shell_status_indicator(info))
            .map(|info| {
                (
                    stack_z_by_window_id
                        .get(&info.window_id)
                        .copied()
                        .unwrap_or(0),
                    info.window_id,
                )
            })
            .collect();
        indicators.sort_unstable();
        for (_, window_id) in indicators {
            let Some(sid) = self
                .windows
                .window_registry
                .surface_id_for_window(window_id)
            else {
                continue;
            };
            if let Some(window) = self.find_window_by_surface_id(sid) {
                self.output_topology
                    .space
                    .raise_element(&DerpSpaceElem::Wayland(window.clone()), false);
                self.shell_window_stack_touch(window_id);
                raised = true;
                continue;
            }
            if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
                self.output_topology
                    .space
                    .raise_element(&DerpSpaceElem::X11(x11.clone()), false);
                self.shell_window_stack_touch(window_id);
                raised = true;
            }
        }
        raised
    }

    pub(crate) fn shell_x11_window_is_tray_hidden(&self, window_id: u32) -> bool {
        self.tray_notifications
            .shell_x11_window_is_tray_hidden(window_id)
    }

    pub(crate) fn remember_tray_hidden_x11_window_id(
        &mut self,
        window_id: u32,
        info: Option<&WindowInfo>,
    ) {
        self.tray_notifications
            .remember_tray_hidden_x11_window_id(window_id, info);
    }

    pub(crate) fn forget_tray_hidden_x11_window_id(&mut self, window_id: u32) -> bool {
        self.tray_notifications
            .forget_tray_hidden_x11_window_id(window_id)
    }

    pub(crate) fn refresh_tray_hidden_x11_notifier_window_ids(&mut self) {
        let records: Vec<WindowInfo> = self
            .windows
            .window_registry
            .all_records()
            .into_iter()
            .filter(|record| {
                record.kind == WindowKind::Native
                    && self.shell_x11_window_is_tray_hidden(record.info.window_id)
            })
            .map(|record| record.info)
            .collect();
        self.tray_notifications
            .refresh_tray_hidden_x11_notifier_window_ids(records.iter());
    }

    pub(crate) fn shell_hide_x11_window_to_tray(&mut self, window_id: u32, x11: &X11Surface) {
        self.windows
            .shell_close_pending_native_windows
            .remove(&window_id);
        self.windows.shell_close_refocus_targets.remove(&window_id);
        let info = self.windows.window_registry.window_info(window_id);
        self.remember_tray_hidden_x11_window_id(window_id, info.as_ref());
        self.tray_notifications
            .shell_tray_hidden_x11_windows
            .insert(window_id, x11.clone());
        self.windows
            .shell_known_x11_windows
            .insert(window_id, x11.clone());
        let _ = self
            .windows
            .window_registry
            .set_restore_handle(window_id, RestoreHandle::X11(x11.clone()));
        let _ = self
            .windows
            .window_registry
            .transition(window_id, WindowLifecycleEvent::HideToTray);
        if self.windows.shell_pending_native_focus_window_id == Some(window_id) {
            self.windows.shell_pending_native_focus_window_id = None;
        }
        if self.keyboard_focused_window_id() == Some(window_id) {
            let serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat.get_keyboard().unwrap().set_focus(
                self,
                Option::<WlSurface>::None,
                serial,
            );
            self.keyboard_on_focus_surface_changed(None);
        }
        if let Err(error) = x11.set_activated(false) {
            tracing::warn!(window_id, ?error, "x11 set_activated failed");
        }
        if let Err(error) = x11.set_hidden(true) {
            tracing::warn!(window_id, ?error, "x11 set_hidden failed");
        }
        if let Err(error) = x11.set_mapped(false) {
            tracing::warn!(window_id, ?error, "x11 set_mapped(false) failed");
        }
        self.output_topology
            .space
            .unmap_elem(&DerpSpaceElem::X11(x11.clone()));
        self.shell_emit_chrome_window_unmapped(
            window_id,
            self.windows.window_registry.window_info(window_id),
        );
        self.shell_force_next_dmabuf_full_damage();
        self.core.loop_signal.wakeup();
    }

    pub(crate) fn shell_restore_tray_hidden_x11_window(
        &mut self,
        window_id: u32,
        x11: &X11Surface,
    ) -> bool {
        let had_surface = self
            .tray_notifications
            .shell_tray_hidden_x11_windows
            .remove(&window_id)
            .is_some();
        let had_id = self.forget_tray_hidden_x11_window_id(window_id);
        if !had_surface && !had_id {
            return false;
        }
        self.windows.shell_pending_native_focus_window_id = Some(window_id);
        let _ = self
            .windows
            .window_registry
            .transition(window_id, WindowLifecycleEvent::Restore);
        self.windows.window_registry.clear_restore_handle(window_id);
        if let Err(error) = x11.set_hidden(false) {
            tracing::warn!(window_id, ?error, "x11 set_hidden(false) failed");
        }
        self.shell_reply_window_list();
        true
    }

    pub(crate) fn shell_restore_tray_hidden_x11_window_to_space(&mut self, window_id: u32) -> bool {
        let Some(x11) = self
            .tray_notifications
            .shell_tray_hidden_x11_windows
            .get(&window_id)
            .or_else(|| self.windows.shell_known_x11_windows.get(&window_id))
            .cloned()
        else {
            return false;
        };
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return false;
        };
        if let Err(error) = x11.set_mapped(true) {
            tracing::warn!(window_id, ?error, "x11 set_mapped(true) failed");
            return false;
        }
        let rect = Rectangle::new(
            Point::from((info.x, info.y)),
            Size::from((info.width.max(1), info.height.max(1))),
        );
        if let Err(error) = x11.configure(Some(rect)) {
            tracing::warn!(window_id, ?error, "x11 configure restore failed");
        }
        self.output_topology.space.map_element(
            DerpSpaceElem::X11(x11.clone()),
            (info.x, info.y),
            false,
        );
        self.refresh_x11_surface_fractional_scale(&x11);
        if !self.shell_restore_tray_hidden_x11_window(window_id, &x11) {
            return false;
        }
        let current_info = self
            .windows
            .window_registry
            .window_info(window_id)
            .unwrap_or(info);
        self.shell_emit_chrome_event(ChromeEvent::WindowMapped { info: current_info });
        self.shell_raise_and_focus_window(window_id);
        self.core.loop_signal.wakeup();
        true
    }

    pub(crate) fn sync_registry_from_x11_surface(
        &mut self,
        window: &X11Surface,
    ) -> Option<X11SyncResult> {
        let geometry = window.geometry();
        let location = self
            .output_topology
            .space
            .element_location(&DerpSpaceElem::X11(window.clone()))
            .unwrap_or(geometry.loc);
        let elem = DerpSpaceElem::X11(window.clone());
        let in_space = self.output_topology.space.elements().any(|e| *e == elem);
        let width = geometry.size.w.max(1);
        let height = geometry.size.h.max(1);
        let output_name = self.output_for_window_position(location.x, location.y, width, height);
        let result =
            self.windows
                .sync_registry_from_x11_surface(window, location, in_space, output_name)?;
        self.refresh_x11_surface_fractional_scale(window);
        let info = &result.info;
        self.capture_refresh_window_source_cache(info.window_id);
        Some(result)
    }

    pub(crate) fn emit_x11_window_updates(
        &mut self,
        window: &X11Surface,
        force_geometry_emit: bool,
        force_metadata_emit: bool,
    ) -> Option<WindowInfo> {
        let result = self.sync_registry_from_x11_surface(window)?;
        if force_metadata_emit || result.metadata_changed {
            self.shell_emit_chrome_event(ChromeEvent::WindowMetadataChanged {
                info: result.info.clone(),
            });
        }
        if force_geometry_emit || result.geometry_changed {
            self.shell_emit_chrome_event(ChromeEvent::WindowGeometryChanged {
                info: result.info.clone(),
            });
        }
        if result.state_changed {
            self.shell_emit_chrome_event(ChromeEvent::WindowStateChanged {
                info: result.info.clone(),
                minimized: result.info.minimized,
            });
        }
        Some(result.info)
    }

    pub(crate) fn ensure_x11_window_registered(
        &mut self,
        surface: &WlSurface,
        window: &X11Surface,
    ) -> Option<WindowInfo> {
        if window.is_override_redirect() {
            return None;
        }
        if self
            .windows
            .window_registry
            .window_id_for_wl_surface(surface)
            .is_none()
        {
            let (title, app_id) = Self::x11_window_title_app_id(window);
            let pid = window.pid().and_then(|pid| i32::try_from(pid).ok());
            let window_id = self
                .windows
                .window_registry
                .register_toplevel(surface, title, app_id, pid);
            let _ = self
                .windows
                .window_registry
                .set_native_backend(window_id, WindowBackend::X11);
        }
        let info = self.emit_x11_window_updates(window, false, true);
        if let Some(info) = &info {
            let elem = DerpSpaceElem::X11(window.clone());
            if self.output_topology.space.elements().any(|e| *e == elem)
                && self.windows.window_registry.lifecycle(info.window_id)
                    != Some(WindowLifecycle::Minimized)
            {
                let _ = self
                    .windows
                    .window_registry
                    .transition(info.window_id, WindowLifecycleEvent::Map);
            }
            self.windows
                .shell_known_x11_windows
                .insert(info.window_id, window.clone());
        }
        info
    }

    pub(crate) fn cleanup_x11_window(&mut self, window: &X11Surface, emit_unmapped: bool) {
        let Some(surface) = window.wl_surface() else {
            self.output_topology
                .space
                .unmap_elem(&DerpSpaceElem::X11(window.clone()));
            return;
        };
        let window_id_pre = self
            .windows
            .window_registry
            .window_id_for_wl_surface(&surface);
        let keyboard_had_focus = window_id_pre
            .is_some_and(|window_id| self.keyboard_focused_window_id() == Some(window_id));
        self.output_topology
            .space
            .unmap_elem(&DerpSpaceElem::X11(window.clone()));
        if let Some(window_id) = window_id_pre {
            self.windows.shell_known_x11_windows.remove(&window_id);
            self.clear_toplevel_layout_maps(window_id);
            self.windows
                .shell_close_pending_native_windows
                .remove(&window_id);
            self.windows.window_registry.clear_restore_handle(window_id);
            if self.windows.shell_pending_native_focus_window_id == Some(window_id) {
                self.windows.shell_pending_native_focus_window_id = None;
            }
            self.shell_window_stack_forget(window_id);
            self.tray_notifications
                .shell_tray_hidden_x11_windows
                .remove(&window_id);
            self.forget_tray_hidden_x11_window_id(window_id);
        }
        let removed = self
            .windows
            .window_registry
            .snapshot_for_wl_surface(&surface);
        if let Some(window_id) = self.windows.window_registry.remove_by_wl_surface(&surface) {
            self.capture_forget_window_source_cache(window_id);
            if emit_unmapped {
                self.shell_emit_chrome_window_unmapped(window_id, removed);
            }
            self.try_refocus_after_closed_window(window_id, keyboard_had_focus);
        }
    }

    pub(crate) fn x11_resize_rect(
        &self,
        window: &X11Surface,
        initial_rect: Rectangle<i32, Logical>,
        edges: crate::grabs::resize_grab::ResizeEdge,
        dx: f64,
        dy: f64,
    ) -> Rectangle<i32, Logical> {
        let mut width = initial_rect.size.w;
        let mut height = initial_rect.size.h;
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::LEFT) {
            width = width.saturating_sub(dx.round() as i32);
        }
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::RIGHT) {
            width = width.saturating_add(dx.round() as i32);
        }
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::TOP) {
            height = height.saturating_sub(dy.round() as i32);
        }
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::BOTTOM) {
            height = height.saturating_add(dy.round() as i32);
        }
        if let Some(min_size) = window.min_size() {
            width = width.max(min_size.w.max(1));
            height = height.max(min_size.h.max(1));
        } else {
            width = width.max(1);
            height = height.max(1);
        }
        if let Some(max_size) = window.max_size() {
            if max_size.w > 0 {
                width = width.min(max_size.w);
            }
            if max_size.h > 0 {
                height = height.min(max_size.h);
            }
        }
        let mut x = initial_rect.loc.x;
        let mut y = initial_rect.loc.y;
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::LEFT) {
            x = initial_rect.loc.x + initial_rect.size.w - width;
        }
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::TOP) {
            y = initial_rect.loc.y + initial_rect.size.h - height;
        }
        Rectangle::new(Point::from((x, y)), Size::from((width, height)))
    }

    pub(crate) fn x11_target_output(&self, window_id: u32) -> Option<Output> {
        let info = self.windows.window_registry.window_info(window_id)?;
        self.output_topology
            .space
            .outputs()
            .find(|output| output.name() == info.output_name.as_str())
            .cloned()
            .or_else(|| self.output_for_global_xywh(info.x, info.y, info.width, info.height))
            .or_else(|| self.leftmost_output())
    }

    pub(crate) fn x11_initial_map_rect(&self, window: &X11Surface) -> Rectangle<i32, Logical> {
        let mut rect = window.geometry();
        if rect.loc.x != 0 || rect.loc.y != 0 {
            rect.size.w = rect.size.w.max(1);
            rect.size.h = rect.size.h.max(1);
            return rect;
        }
        rect.size.w = rect.size.w.max(DEFAULT_XDG_TOPLEVEL_WIDTH.max(1));
        rect.size.h = rect.size.h.max(DEFAULT_XDG_TOPLEVEL_HEIGHT.max(1));
        let Some(output) = self.new_toplevel_placement_output(None) else {
            rect.loc = Point::from((DEFAULT_XDG_TOPLEVEL_OFFSET_X, DEFAULT_XDG_TOPLEVEL_OFFSET_Y));
            return rect;
        };
        let Some(work) = self.shell_maximize_work_area_global_for_output(&output) else {
            rect.loc = Point::from((DEFAULT_XDG_TOPLEVEL_OFFSET_X, DEFAULT_XDG_TOPLEVEL_OFFSET_Y));
            return rect;
        };
        if let Some(window_id) = self.x11_window_id_for_surface(window) {
            if let Some(client_rect) =
                self.workspace_auto_layout_initial_client_rect_for_window(&output.name(), window_id)
            {
                return client_rect;
            }
            if self.x11_window_is_shell_status_indicator(window) {
                if let Some(info) = self.windows.window_registry.window_info(window_id) {
                    if let Some((x, y)) = self.shell_status_indicator_initial_location(
                        &info.title,
                        &info.app_id,
                        rect.size.w,
                        rect.size.h,
                    ) {
                        rect.loc = Point::from((x, y));
                        return rect;
                    }
                }
            }
        }
        rect.size.w = rect.size.w.min(work.size.w.max(1));
        rect.size.h = rect.size.h.min(work.size.h.max(1));
        rect.loc = Point::from(self.staggered_toplevel_origin_for_output(
            &output,
            &work,
            rect.size.w,
            rect.size.h,
        ));
        rect
    }

    pub(crate) fn apply_x11_window_bounds(
        &mut self,
        window_id: u32,
        window: &X11Surface,
        rect: Rectangle<i32, Logical>,
        maximized: bool,
        fullscreen: bool,
        raise: bool,
    ) -> bool {
        if let Err(error) = window.set_fullscreen(fullscreen) {
            tracing::warn!(window_id, ?error, "x11 set_fullscreen failed");
        }
        if let Err(error) = window.set_maximized(maximized) {
            tracing::warn!(window_id, ?error, "x11 set_maximized failed");
        }
        if let Err(error) = window.configure(Some(rect)) {
            tracing::warn!(window_id, ?error, "x11 configure failed");
            return false;
        }
        self.output_topology.space.map_element(
            DerpSpaceElem::X11(window.clone()),
            (rect.loc.x, rect.loc.y),
            raise,
        );
        self.refresh_x11_surface_fractional_scale(window);
        self.emit_x11_window_updates(window, true, false);
        true
    }
}
