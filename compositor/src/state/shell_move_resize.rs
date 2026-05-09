use super::*;

impl CompositorState {
    pub(crate) fn cancel_shell_move_resize_for_window(&mut self, window_id: u32) {
        self.shell_move_deferred_cancel(Some(window_id));
        if self.input_routing.shell_move_window_id == Some(window_id) {
            if self.windows.window_registry.is_shell_hosted(window_id) {
                self.shell_move_end_backed_only(window_id);
            } else {
                self.shell_move_end(window_id);
            }
        }
        if self.input_routing.shell_resize_window_id == Some(window_id) {
            if self.windows.window_registry.is_shell_hosted(window_id) {
                self.shell_resize_end_backed_only(window_id);
            } else {
                self.shell_resize_end(window_id);
            }
        }
    }

    pub(crate) fn shell_move_shell_hosted_frame_ready_now(&self, window_id: u32) -> bool {
        if self.shell_osr.shell_focused_ui_window_id != Some(window_id) {
            return false;
        }
        let placements = self.shell_visible_placements();
        let Some(placement) = placements
            .iter()
            .find(|placement| placement.id == window_id)
        else {
            return false;
        };
        let topmost = placements
            .iter()
            .max_by_key(|placement| (self.shell_placement_stack_z(placement), placement.id));
        topmost.is_some_and(|topmost| topmost.id == placement.id)
    }

    pub(crate) fn shell_move_shell_hosted_proxy_visible_now(
        &self,
        info: &WindowInfo,
        placement: &ShellUiWindowPlacement,
    ) -> bool {
        let outer = self.shell_backed_outer_global_rect(info);
        let outer_right = outer.loc.x.saturating_add(outer.size.w);
        let outer_bottom = outer.loc.y.saturating_add(outer.size.h);
        let placement_right = placement
            .global_rect
            .loc
            .x
            .saturating_add(placement.global_rect.size.w);
        let placement_bottom = placement
            .global_rect
            .loc
            .y
            .saturating_add(placement.global_rect.size.h);
        (placement.global_rect.loc.x - outer.loc.x).abs() <= 1
            && (placement.global_rect.loc.y - outer.loc.y).abs() <= 1
            && (placement_right - outer_right).abs() <= 1
            && (placement_bottom - outer_bottom).abs() <= 1
    }

    pub(crate) fn shell_move_proxy_release_ready_now(&self, window_id: u32) -> bool {
        if !self.windows.window_registry.is_shell_hosted(window_id) {
            return true;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return false;
        };
        let Some(placement) = self
            .shell_visible_placements()
            .into_iter()
            .find(|placement| placement.id == window_id)
        else {
            return false;
        };
        let outer = self.shell_backed_outer_global_rect(&info);
        let expected = self
            .workspace_logical_bounds()
            .map(|workspace| {
                Point::from((
                    outer.loc.x.max(workspace.loc.x),
                    outer.loc.y.max(workspace.loc.y),
                ))
            })
            .unwrap_or(outer.loc);
        (placement.global_rect.loc.x - expected.x).abs() <= 1
            && (placement.global_rect.loc.y - expected.y).abs() <= 1
    }

    pub(crate) fn shell_move_deferred_ready(&self, pending: &ShellMoveDeferredStartState) -> bool {
        if self.shell_osr.shell_dmabuf_commit == pending.wait_for_shell_commit {
            return false;
        }
        if self.shell_osr.shell_ui_windows_generation == pending.wait_for_ui_generation {
            return false;
        }
        self.windows
            .window_registry
            .is_shell_hosted(pending.window_id)
            && self.shell_move_shell_hosted_frame_ready_now(pending.window_id)
    }

    pub(crate) fn shell_move_deferred_cancel(&mut self, window_id: Option<u32>) {
        self.input_routing.shell_move_deferred_cancel(window_id);
    }

    pub(crate) fn shell_move_deferred_accumulate_delta(&mut self, dx: i32, dy: i32) {
        self.input_routing
            .shell_move_deferred_accumulate_delta(dx, dy);
    }

    pub(crate) fn shell_move_activate_backed_now(
        &mut self,
        window_id: u32,
        initial_pending_delta: (i32, i32),
        pointer_driven: bool,
    ) -> bool {
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return false;
        };
        if !self.windows.window_registry.is_shell_hosted(window_id) || info.minimized {
            return false;
        }
        self.input_routing
            .shell_move_begin_state(window_id, pointer_driven, initial_pending_delta);
        self.shell_move_proxy_cancel(Some(window_id));
        self.shell_keyboard_capture_shell_ui();
        if initial_pending_delta != (0, 0) {
            self.shell_move_flush_pending_deltas_backed();
        }
        self.shell_send_interaction_state();
        true
    }

    pub(crate) fn shell_move_try_activate_deferred(&mut self) {
        let Some(pending) = self.input_routing.shell_move_deferred.take() else {
            return;
        };
        if !self.shell_move_deferred_ready(&pending) {
            self.input_routing.shell_move_deferred = Some(pending);
            return;
        }
        if !self.shell_move_activate_backed_now(pending.window_id, pending.pending_delta, true) {
            self.shell_move_proxy_cancel(Some(pending.window_id));
            self.shell_send_interaction_state();
        }
    }

    pub(crate) fn shell_move_is_active(&self) -> bool {
        self.input_routing.shell_move_is_active()
    }

    pub(crate) fn shell_move_accepts_pointer_delta(&self) -> bool {
        self.input_routing.shell_move_accepts_pointer_delta()
    }

    pub(crate) fn shell_move_end_active(&mut self) {
        let Some(wid) = self.input_routing.shell_move_end_active_window() else {
            return;
        };
        self.shell_move_end(wid);
    }

    pub(crate) fn shell_move_proxy_try_arm_capture(&mut self) {
        let Some(window_id) = self
            .input_routing
            .shell_move_proxy
            .as_ref()
            .map(|proxy| proxy.window_id)
        else {
            return;
        };
        if self
            .input_routing
            .shell_move_proxy
            .as_ref()
            .is_some_and(|proxy| {
                proxy.pending_capture || proxy.texture.is_some() || proxy.release_state.is_some()
            })
        {
            return;
        }
        if self
            .input_routing
            .shell_move_proxy
            .as_ref()
            .and_then(|proxy| proxy.arm_after_shell_commit)
            .is_some_and(|commit| commit == self.shell_osr.shell_dmabuf_commit)
        {
            return;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return;
        };
        let shell_hosted = self.windows.window_registry.is_shell_hosted(window_id);
        if shell_hosted {
            let had_proxy = self.input_routing.shell_move_proxy.take().is_some();
            if had_proxy {
                self.shell_send_interaction_state();
            }
            return;
        }
        let visible_placement = self
            .shell_visible_placements()
            .into_iter()
            .find(|placement| placement.id == window_id);
        let request_opaque_source = self
            .input_routing
            .shell_move_proxy
            .as_ref()
            .is_some_and(|proxy| proxy.request_opaque_source);
        if shell_hosted && visible_placement.is_none() {
            if request_opaque_source {
                if let Some(proxy) = self.input_routing.shell_move_proxy.as_mut() {
                    proxy.request_opaque_source = false;
                    proxy.arm_after_shell_commit = None;
                }
                self.shell_send_interaction_state();
            }
            return;
        }
        if shell_hosted && !self.shell_move_shell_hosted_frame_ready_now(window_id) {
            if request_opaque_source {
                if let Some(proxy) = self.input_routing.shell_move_proxy.as_mut() {
                    proxy.request_opaque_source = false;
                    proxy.arm_after_shell_commit = None;
                }
                self.shell_send_interaction_state();
            }
            return;
        }
        let native_source_global_rect =
            (!shell_hosted).then(|| self.shell_native_outer_global_rect(&info));
        let native_texture_global_rect = if shell_hosted {
            None
        } else {
            native_source_global_rect.map(|outer| {
                let titlebar_h = info.y.saturating_sub(outer.loc.y).max(1);
                Rectangle::new(outer.loc, Size::from((outer.size.w.max(1), titlebar_h)))
            })
        };
        let native_texture_capture = if shell_hosted {
            None
        } else {
            native_texture_global_rect.and_then(|texture_global_rect| {
                self.shell_global_rect_to_buffer_mapping(&texture_global_rect)
            })
        };
        if !shell_hosted
            && (native_source_global_rect.is_none()
                || native_texture_global_rect.is_none()
                || native_texture_capture.is_none())
        {
            return;
        }
        let shell_hosted_proxy_visible = shell_hosted
            && visible_placement.as_ref().is_some_and(|placement| {
                self.shell_move_shell_hosted_proxy_visible_now(&info, placement)
            });
        if shell_hosted && !shell_hosted_proxy_visible {
            if request_opaque_source {
                if let Some(proxy) = self.input_routing.shell_move_proxy.as_mut() {
                    proxy.request_opaque_source = false;
                    proxy.arm_after_shell_commit = None;
                }
                self.shell_send_interaction_state();
            }
            return;
        }
        let Some(proxy) = self.input_routing.shell_move_proxy.as_mut() else {
            return;
        };
        if shell_hosted && !proxy.request_opaque_source {
            proxy.request_opaque_source = true;
            proxy.arm_after_shell_commit = Some(self.shell_osr.shell_dmabuf_commit);
            self.shell_send_interaction_state();
            return;
        }
        proxy.arm_after_shell_commit = None;
        proxy.source_client_rect = Rectangle::new(
            Point::from((info.x, info.y)),
            Size::from((info.width.max(1), info.height.max(1))),
        );
        if shell_hosted {
            let Some(placement) = visible_placement else {
                return;
            };
            proxy.source_global_rect = Some(placement.global_rect);
            proxy.texture_global_rect = Some(placement.global_rect);
            proxy.source_buffer_rect = Some(placement.buffer_rect);
        } else {
            let Some((capture_texture_global_rect, capture_source_buffer_rect)) =
                native_texture_capture
            else {
                return;
            };
            proxy.source_global_rect = native_source_global_rect;
            proxy.texture_global_rect = Some(capture_texture_global_rect);
            proxy.source_buffer_rect = Some(capture_source_buffer_rect);
        }
        proxy.pending_capture = true;
    }

    pub(crate) fn shell_move_proxy_target_global_rect(&self) -> Option<Rectangle<i32, Logical>> {
        let proxy = self.input_routing.shell_move_proxy.as_ref()?;
        let source_global_rect = proxy.source_global_rect?;
        let info = self.windows.window_registry.window_info(proxy.window_id)?;
        let dx = info.x.saturating_sub(proxy.source_client_rect.loc.x);
        let dy = info.y.saturating_sub(proxy.source_client_rect.loc.y);
        Some(Rectangle::new(
            Point::from((
                source_global_rect.loc.x.saturating_add(dx),
                source_global_rect.loc.y.saturating_add(dy),
            )),
            source_global_rect.size,
        ))
    }

    pub(crate) fn shell_move_proxy_release(&mut self, window_id: u32) {
        let can_keep = self.shell_osr.shell_has_frame && self.shell_osr.shell_frame_is_dmabuf;
        let current_commit = self.shell_osr.shell_dmabuf_commit;
        let Some(proxy) = self.input_routing.shell_move_proxy.as_mut() else {
            return;
        };
        if proxy.window_id != window_id {
            return;
        }
        if proxy.texture.is_none() || !can_keep {
            self.input_routing.shell_move_proxy = None;
            return;
        }
        proxy.release_state = Some(ShellMoveProxyReleaseState::AwaitShellStateCommit(
            current_commit,
        ));
    }

    pub(crate) fn shell_move_proxy_cancel(&mut self, window_id: Option<u32>) {
        if self
            .input_routing
            .shell_move_proxy
            .as_ref()
            .is_some_and(|proxy| window_id.is_none() || window_id == Some(proxy.window_id))
        {
            self.input_routing.shell_move_proxy = None;
        }
    }

    pub(crate) fn shell_drag_restore_rect_from_client_frame(
        pointer: Point<f64, Logical>,
        frame_x: i32,
        frame_y: i32,
        frame_w: i32,
        frame_h: i32,
        restore_w: i32,
        restore_h: i32,
    ) -> Rectangle<i32, Logical> {
        let fw = frame_w.max(1) as f64;
        let fh = frame_h.max(1) as f64;
        let rw = restore_w.max(1) as f64;
        let rh = restore_h.max(1) as f64;
        let ox = (pointer.x - frame_x as f64).clamp(0.0, fw);
        let oy = (pointer.y - frame_y as f64).clamp(0.0, fh);
        let rx = ox / fw;
        let ry = oy / fh;
        let clamped_rx = rx.clamp(0.3, 0.7);
        let x = (pointer.x - clamped_rx * rw).round() as i32;
        let y = (pointer.y - ry * rh).round() as i32;
        Rectangle::new(
            Point::from((x, y)),
            Size::from((restore_w.max(1), restore_h.max(1))),
        )
    }

    pub(crate) fn shell_restore_size_for_maximized_drag(
        &self,
        window_id: u32,
        info: &WindowInfo,
        kind: WindowKind,
    ) -> (i32, i32) {
        if kind == WindowKind::ShellHosted {
            if let Some(record) = self.windows.window_registry.window_record(window_id) {
                if let Some(rect) = record.shell_hosted_float_restore {
                    let w = rect.size.w.max(1);
                    let h = rect.size.h.max(1);
                    if w < info.width.saturating_sub(24) || h < info.height.saturating_sub(120) {
                        return (w, h);
                    }
                }
            }
        } else if let Some((_, _, w, h)) = self
            .windows
            .toplevel_floating_restore
            .get(&window_id)
            .copied()
        {
            let w = w.max(1);
            let h = h.max(1);
            if w < info.width.saturating_sub(24) || h < info.height.saturating_sub(120) {
                return (w, h);
            }
        }
        (
            (info.width.max(1) * 55 / 100).max(360),
            (info.height.max(1) * 55 / 100).max(280),
        )
    }

    pub(crate) fn shell_restore_maximized_drag_window_if_needed(&mut self, window_id: u32) {
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return;
        };
        if info.minimized || info.fullscreen || !info.maximized {
            return;
        }
        let kind = self
            .windows
            .window_registry
            .window_kind(window_id)
            .unwrap_or(WindowKind::Native);
        let Some(pointer) = self.input_routing.seat.get_pointer() else {
            return;
        };
        let (restore_w, restore_h) =
            self.shell_restore_size_for_maximized_drag(window_id, &info, kind);
        let rect = Self::shell_drag_restore_rect_from_client_frame(
            pointer.current_location(),
            info.x,
            info.y,
            info.width,
            info.height,
            restore_w,
            restore_h,
        );
        let (ox, oy) = self.output_topology.shell_canvas_logical_origin;
        self.shell_set_window_geometry(
            window_id,
            rect.loc.x.saturating_sub(ox),
            rect.loc.y.saturating_sub(oy),
            rect.size.w,
            rect.size.h,
            0,
        );
        if kind != WindowKind::ShellHosted {
            self.capture_refresh_window_source_cache(window_id);
            self.shell_native_drag_preview_begin(window_id);
        }
    }

    pub fn shell_move_begin(&mut self, window_id: u32) {
        self.shell_move_begin_inner(window_id, true);
    }

    pub fn shell_move_begin_from_shell(&mut self, window_id: u32) {
        self.shell_move_begin_inner(window_id, true);
    }

    pub(crate) fn shell_move_begin_inner(&mut self, window_id: u32, pointer_driven: bool) {
        self.shell_resize_end_active();
        if self.shell_move_try_begin_backed(window_id, pointer_driven) {
            return;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_begin: unknown window_id (registry)"
            );
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_begin: ignored (embedded Solid / shell host)"
            );
            return;
        }
        let Some(sid) = self
            .windows
            .window_registry
            .surface_id_for_window(window_id)
        else {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_begin: unknown surface (registry)"
            );
            return;
        };

        if self.input_routing.shell_move_window_id == Some(window_id) {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_begin: already active (no-op)"
            );
            return;
        }

        if let Some(prev) = self.input_routing.shell_move_window_id {
            if prev != window_id {
                self.shell_move_end(prev);
            }
        }
        if let Some(window) = self.find_window_by_surface_id(sid) {
            self.output_topology
                .space
                .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
            let Some(toplevel) = window.toplevel() else {
                return;
            };
            let wl_surface = toplevel.wl_surface().clone();
            let k_serial = SERIAL_COUNTER.next_serial();
            let Some(keyboard) = self.input_routing.seat.get_keyboard() else {
                return;
            };
            keyboard.set_focus(self, Some(wl_surface.clone()), k_serial);
            self.output_topology.space.elements().for_each(|e| {
                if let DerpSpaceElem::Wayland(w) = e {
                    if let Some(toplevel) = w.toplevel() {
                        toplevel.send_pending_configure();
                    }
                }
            });

            self.input_routing
                .shell_move_begin_state(window_id, pointer_driven, (0, 0));
            self.shell_native_drag_preview_begin(window_id);
            self.shell_send_interaction_state();
            return;
        }
        if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
            self.output_topology
                .space
                .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
            if let Some(wl_surface) = x11.wl_surface() {
                let k_serial = SERIAL_COUNTER.next_serial();
                self.input_routing.seat.get_keyboard().unwrap().set_focus(
                    self,
                    Some(wl_surface),
                    k_serial,
                );
            }
            self.output_topology.space.elements().for_each(|e| {
                if let DerpSpaceElem::Wayland(w) = e {
                    w.toplevel().unwrap().send_pending_configure();
                }
            });

            self.input_routing
                .shell_move_begin_state(window_id, pointer_driven, (0, 0));
            self.shell_native_drag_preview_begin(window_id);
            self.shell_send_interaction_state();
            return;
        }
        tracing::warn!(
            target: "derp_shell_move",
            window_id,
            sid,
            "shell_move_begin: surface not in space"
        );
    }

    /// Applies [`Self::shell_move_pending_delta`] to the active shell-move window in [`Self::space`].
    pub(crate) fn shell_move_flush_pending_deltas(&mut self) {
        if self
            .input_routing
            .shell_move_window_id
            .is_some_and(|wid| self.windows.window_registry.is_shell_hosted(wid))
        {
            self.shell_move_flush_pending_deltas_backed();
            return;
        }
        let Some(wid) = self.input_routing.shell_move_window_id else {
            return;
        };
        let (pdx, pdy) = self.input_routing.shell_move_pending_delta;
        if pdx == 0 && pdy == 0 {
            return;
        }
        let Some(sid) = self.windows.window_registry.surface_id_for_window(wid) else {
            tracing::warn!(target: "derp_shell_move", wid, "shell_move_flush: registry lost window");
            self.input_routing.shell_move_clear_active_state();
            self.shell_native_drag_preview_cancel(Some(wid));
            self.shell_move_proxy_cancel(Some(wid));
            self.shell_send_interaction_state();
            return;
        };
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let Some(loc) = self
                .output_topology
                .space
                .element_location(&DerpSpaceElem::Wayland(window.clone()))
            else {
                tracing::warn!(target: "derp_shell_move", wid, "shell_move_flush: no element_location");
                return;
            };
            let before = (loc.x, loc.y);
            let after = (loc.x + pdx, loc.y + pdy);
            self.output_topology.space.map_element(
                DerpSpaceElem::Wayland(window.clone()),
                after,
                true,
            );
            self.input_routing.shell_move_pending_delta = (0, 0);
            self.notify_geometry_for_window(&window, true);
            self.shell_send_interaction_state();
            tracing::debug!(
                target: "derp_shell_move",
                wid,
                pdx,
                pdy,
                before = ?before,
                after = ?after,
                "shell_move: flushed pending delta"
            );
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            tracing::warn!(target: "derp_shell_move", wid, sid, "shell_move_flush: window gone");
            self.input_routing.shell_move_clear_active_state();
            self.shell_native_drag_preview_cancel(Some(wid));
            self.shell_move_proxy_cancel(Some(wid));
            self.shell_send_interaction_state();
            return;
        };
        let Some(loc) = self
            .output_topology
            .space
            .element_location(&DerpSpaceElem::X11(x11.clone()))
        else {
            tracing::warn!(target: "derp_shell_move", wid, "shell_move_flush: no element_location");
            return;
        };
        let before = (loc.x, loc.y);
        let after = (loc.x + pdx, loc.y + pdy);
        let mut geometry = x11.geometry();
        geometry.loc = Point::from(after);
        if let Err(error) = x11.configure(Some(geometry)) {
            tracing::warn!(target: "derp_shell_move", wid, ?error, "shell_move_flush: x11 configure failed");
            self.input_routing.shell_move_clear_active_state();
            self.shell_native_drag_preview_cancel(Some(wid));
            self.shell_move_proxy_cancel(Some(wid));
            self.shell_send_interaction_state();
            return;
        }
        self.output_topology
            .space
            .map_element(DerpSpaceElem::X11(x11.clone()), after, true);
        self.input_routing.shell_move_pending_delta = (0, 0);
        self.emit_x11_window_updates(&x11, true, false);
        self.shell_send_interaction_state();
        tracing::debug!(
            target: "derp_shell_move",
            wid,
            pdx,
            pdy,
            before = ?before,
            after = ?after,
            "shell_move: flushed pending delta"
        );
    }

    pub fn shell_move_delta(&mut self, dx: i32, dy: i32) {
        let Some(wid) = self.input_routing.shell_move_window_id else {
            if self.input_routing.shell_move_deferred.is_some() {
                self.shell_move_deferred_accumulate_delta(dx, dy);
                return;
            }
            tracing::debug!(
                target: "derp_shell_move",
                dx,
                dy,
                "shell_move_delta: ignored (no active move)"
            );
            return;
        };
        self.shell_restore_maximized_drag_window_if_needed(wid);
        if self.windows.window_registry.is_shell_hosted(wid) {
            self.input_routing.shell_move_pending_delta.0 += dx;
            self.input_routing.shell_move_pending_delta.1 += dy;
            self.shell_move_proxy_try_arm_capture();
            if self.shell_move_delta_flush_due() {
                self.shell_move_flush_pending_deltas_backed();
            }
            return;
        }
        let Some(sid) = self.windows.window_registry.surface_id_for_window(wid) else {
            tracing::warn!(target: "derp_shell_move", wid, "shell_move_delta: registry lost window");
            self.input_routing.shell_move_clear_active_state();
            self.shell_native_drag_preview_cancel(Some(wid));
            self.shell_move_proxy_cancel(Some(wid));
            self.shell_send_interaction_state();
            return;
        };
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let Some(_loc) = self
                .output_topology
                .space
                .element_location(&DerpSpaceElem::Wayland(window.clone()))
            else {
                tracing::warn!(target: "derp_shell_move", wid, "shell_move_delta: no element_location");
                return;
            };
        } else if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
            let Some(_loc) = self
                .output_topology
                .space
                .element_location(&DerpSpaceElem::X11(x11.clone()))
            else {
                tracing::warn!(target: "derp_shell_move", wid, "shell_move_delta: no element_location");
                return;
            };
        } else {
            tracing::warn!(target: "derp_shell_move", wid, sid, "shell_move_delta: window gone from space");
            self.input_routing.shell_move_clear_active_state();
            self.shell_native_drag_preview_cancel(Some(wid));
            self.shell_move_proxy_cancel(Some(wid));
            self.shell_send_interaction_state();
            return;
        }
        self.input_routing.shell_move_pending_delta.0 += dx;
        self.input_routing.shell_move_pending_delta.1 += dy;
        tracing::trace!(
            target: "derp_shell_move",
            wid,
            dx,
            dy,
            accum = ?self.input_routing.shell_move_pending_delta,
            "shell_move_delta: flushing to space"
        );
        self.shell_move_proxy_try_arm_capture();
        if self.shell_move_delta_flush_due() {
            self.shell_move_flush_pending_deltas();
        }
    }

    pub(crate) fn shell_move_delta_flush_due(&mut self) -> bool {
        self.input_routing.shell_move_delta_flush_due()
    }

    /// Clears shell move state after `move_end` IPC, compositor button release, or disconnect.
    pub(crate) fn shell_move_end_cleanup(&mut self, window_id: u32, window: &Window) {
        if self.input_routing.shell_move_window_id != Some(window_id) {
            return;
        }
        self.input_routing.shell_move_clear_active_state();
        self.shell_native_drag_preview_cancel(Some(window_id));
        self.notify_geometry_for_window(window, true);
        self.shell_move_proxy_release(window_id);
        self.shell_send_interaction_state();
    }

    pub fn shell_move_end(&mut self, window_id: u32) {
        if self
            .input_routing
            .shell_move_deferred
            .as_ref()
            .is_some_and(|pending| pending.window_id == window_id)
        {
            self.input_routing.shell_move_deferred = None;
            return;
        }
        if self.input_routing.shell_move_window_id != Some(window_id) {
            tracing::debug!(
                target: "derp_shell_move",
                window_id,
                active = ?self.input_routing.shell_move_window_id,
                "shell_move_end: ignored (stale or no active move)"
            );
            return;
        }
        if self.windows.window_registry.is_shell_hosted(window_id) {
            self.shell_move_end_backed_only(window_id);
            return;
        }
        let Some(sid) = self
            .windows
            .window_registry
            .surface_id_for_window(window_id)
        else {
            tracing::warn!(
                target: "derp_shell_move",
                window_id,
                "shell_move_end: no surface; clearing active move"
            );
            self.input_routing.shell_move_clear_active_state();
            self.shell_native_drag_preview_cancel(Some(window_id));
            self.shell_move_proxy_cancel(Some(window_id));
            self.shell_send_interaction_state();
            return;
        };
        if let Some(window) = self.find_window_by_surface_id(sid) {
            self.shell_move_flush_pending_deltas();
            self.shell_move_end_cleanup(window_id, &window);
            return;
        }
        if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
            self.shell_move_flush_pending_deltas();
            self.input_routing.shell_move_clear_active_state();
            self.shell_native_drag_preview_cancel(Some(window_id));
            self.emit_x11_window_updates(&x11, true, false);
            self.shell_move_proxy_release(window_id);
            self.shell_send_interaction_state();
            return;
        }
        tracing::warn!(
            target: "derp_shell_move",
            window_id,
            sid,
            "shell_move_end: surface missing; clearing"
        );
        self.input_routing.shell_move_clear_active_state();
        self.shell_native_drag_preview_cancel(Some(window_id));
        self.shell_move_proxy_cancel(Some(window_id));
        self.shell_send_interaction_state();
    }

    pub(crate) fn shell_resize_is_active(&self) -> bool {
        self.input_routing.shell_resize_is_active()
    }

    pub(crate) fn shell_resize_end_active(&mut self) {
        if let Some(wid) = self.input_routing.shell_resize_active_window() {
            self.shell_resize_end(wid);
        }
        if self.input_routing.shell_resize_shell_grab_end() {
            self.shell_send_interaction_state();
        }
    }

    pub fn shell_resize_shell_grab_begin(&mut self, window_id: u32) {
        if window_id == 0 {
            return;
        }
        if let Some(mid) = self.input_routing.shell_move_window_id {
            if self.windows.window_registry.is_shell_hosted(mid) {
                self.shell_move_end_backed_only(mid);
            } else {
                self.shell_move_end(mid);
            }
        }
        if let Some(prev) = self.input_routing.shell_resize_window_id {
            if self.windows.window_registry.is_shell_hosted(prev) {
                self.shell_resize_end_backed_only(prev);
            } else {
                self.shell_resize_end(prev);
            }
        }
        self.input_routing.shell_resize_shell_grab_begin(window_id);
        self.shell_send_interaction_state();
    }

    pub fn shell_resize_shell_grab_end(&mut self) {
        if self.input_routing.shell_resize_shell_grab_end() {
            self.shell_send_interaction_state();
        }
    }

    pub fn shell_resize_begin(&mut self, window_id: u32, edges_wire: u32) {
        use crate::grabs::resize_grab::{
            resize_tracking_set_resizing, ResizeEdge as GrabResizeEdge,
        };
        use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;

        if let Some(mid) = self.input_routing.shell_move_window_id {
            if self.windows.window_registry.is_shell_hosted(mid) {
                self.shell_move_end_backed_only(mid);
            } else {
                self.shell_move_end(mid);
            }
        }
        self.input_routing.shell_resize_shell_grab = None;
        if self.input_routing.shell_resize_window_id == Some(window_id) {
            tracing::warn!(
                target: "derp_shell_resize",
                window_id,
                "shell_resize_begin: already active (no-op)"
            );
            return;
        }
        if let Some(prev) = self.input_routing.shell_resize_window_id {
            if self.windows.window_registry.is_shell_hosted(prev) {
                self.shell_resize_end_backed_only(prev);
            } else {
                self.shell_resize_end(prev);
            }
        }

        let Some(edges) = GrabResizeEdge::from_bits(edges_wire) else {
            tracing::warn!(
                target: "derp_shell_resize",
                edges_wire,
                "shell_resize_begin: invalid edges"
            );
            return;
        };
        if edges.is_empty() {
            return;
        }

        if self.shell_resize_try_begin_backed(window_id, edges_wire) {
            return;
        }

        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            tracing::warn!(
                target: "derp_shell_resize",
                window_id,
                "shell_resize_begin: unknown window"
            );
            return;
        };
        if self.window_info_is_solid_shell_host(&info) {
            tracing::warn!(
                target: "derp_shell_resize",
                window_id,
                "shell_resize_begin: ignored (shell host)"
            );
            return;
        }
        let Some(sid) = self
            .windows
            .window_registry
            .surface_id_for_window(window_id)
        else {
            return;
        };
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let Some(loc) = self
                .output_topology
                .space
                .element_location(&DerpSpaceElem::Wayland(window.clone()))
            else {
                return;
            };
            let geo = window.geometry();
            let initial_rect = Rectangle::new(loc, geo.size);
            let tl = window.toplevel().unwrap();
            let wl = tl.wl_surface();
            resize_tracking_set_resizing(wl, edges, initial_rect);
            tl.with_pending_state(|state| {
                state.states.set(xdg_toplevel::State::Resizing);
            });
            tl.send_pending_configure();

            self.input_routing
                .shell_resize_begin_state(window_id, edges, initial_rect);

            self.output_topology
                .space
                .raise_element(&DerpSpaceElem::Wayland(window.clone()), true);
            let k_serial = SERIAL_COUNTER.next_serial();
            self.input_routing.seat.get_keyboard().unwrap().set_focus(
                self,
                Some(wl.clone()),
                k_serial,
            );
            self.shell_send_interaction_state();
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            return;
        };
        let Some(loc) = self
            .output_topology
            .space
            .element_location(&DerpSpaceElem::X11(x11.clone()))
        else {
            return;
        };
        let geo = x11.geometry();
        let initial_rect = Rectangle::new(loc, geo.size);

        self.input_routing
            .shell_resize_begin_state(window_id, edges, initial_rect);

        self.output_topology
            .space
            .raise_element(&DerpSpaceElem::X11(x11.clone()), true);
        if let Some(wl) = x11.wl_surface() {
            let k_serial = SERIAL_COUNTER.next_serial();
            self.input_routing
                .seat
                .get_keyboard()
                .unwrap()
                .set_focus(self, Some(wl), k_serial);
        }
        self.shell_send_interaction_state();
    }

    pub(crate) fn shell_emit_interactive_resize_geometry(
        &mut self,
        window_id: u32,
        initial_rect: Rectangle<i32, Logical>,
        edges: crate::grabs::resize_grab::ResizeEdge,
        width: i32,
        height: i32,
    ) {
        let Some(mut info) = self.windows.window_registry.window_info(window_id) else {
            return;
        };
        let width = width.max(1);
        let height = height.max(1);
        let mut x = initial_rect.loc.x;
        let mut y = initial_rect.loc.y;
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::LEFT) {
            x = initial_rect.loc.x + initial_rect.size.w - width;
        }
        if edges.intersects(crate::grabs::resize_grab::ResizeEdge::TOP) {
            y = initial_rect.loc.y + initial_rect.size.h - height;
        }
        info.x = x;
        info.y = y;
        info.width = width;
        info.height = height;
        info.output_name = self
            .output_for_window_position(x, y, width, height)
            .unwrap_or_default();
        self.shell_emit_chrome_event(ChromeEvent::WindowGeometryChanged { info });
        self.shell_nudge_cef_repaint();
    }

    pub fn shell_resize_delta(&mut self, dx: i32, dy: i32) {
        use crate::grabs::resize_grab::compute_clamped_resize_size;
        use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;

        let Some(wid) = self.input_routing.shell_resize_window_id else {
            return;
        };
        let Some(edges) = self.input_routing.shell_resize_edges else {
            return;
        };
        let Some(initial_rect) = self.input_routing.shell_resize_initial_rect else {
            return;
        };
        if self.windows.window_registry.is_shell_hosted(wid) {
            self.shell_resize_delta_backed(dx, dy);
            return;
        }
        let Some(sid) = self.windows.window_registry.surface_id_for_window(wid) else {
            self.input_routing.shell_resize_clear_active_state();
            self.shell_send_interaction_state();
            return;
        };
        self.input_routing.shell_resize_accum.0 += dx as f64;
        self.input_routing.shell_resize_accum.1 += dy as f64;
        if let Some(window) = self.find_window_by_surface_id(sid) {
            let tl = window.toplevel().unwrap();
            let wl = tl.wl_surface();
            let last_size = compute_clamped_resize_size(
                self,
                wl,
                edges,
                initial_rect.size,
                self.input_routing.shell_resize_accum.0,
                self.input_routing.shell_resize_accum.1,
            );

            tl.with_pending_state(|state| {
                state.states.set(xdg_toplevel::State::Resizing);
                state.size = Some(last_size);
            });
            tl.send_pending_configure();
            self.shell_emit_interactive_resize_geometry(
                wid,
                initial_rect,
                edges,
                last_size.w,
                last_size.h,
            );
            return;
        }
        let Some(x11) = self.find_x11_window_by_surface_id(sid) else {
            self.input_routing.shell_resize_clear_active_state();
            self.shell_send_interaction_state();
            return;
        };
        let rect = self.x11_resize_rect(
            &x11,
            initial_rect,
            edges,
            self.input_routing.shell_resize_accum.0,
            self.input_routing.shell_resize_accum.1,
        );
        self.apply_x11_window_bounds(
            wid,
            &x11,
            rect,
            x11.is_maximized(),
            x11.is_fullscreen(),
            true,
        );
    }

    pub fn shell_resize_end(&mut self, window_id: u32) {
        use crate::grabs::resize_grab::{
            compute_clamped_resize_size, resize_tracking_set_waiting_last_commit,
        };
        use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;

        if self.input_routing.shell_resize_window_id != Some(window_id) {
            tracing::debug!(
                target: "derp_shell_resize",
                window_id,
                active = ?self.input_routing.shell_resize_window_id,
                "shell_resize_end: ignored"
            );
            return;
        }

        if self.windows.window_registry.is_shell_hosted(window_id) {
            self.shell_resize_end_backed_only(window_id);
            return;
        }

        let Some(sid) = self
            .windows
            .window_registry
            .surface_id_for_window(window_id)
        else {
            self.input_routing.shell_resize_clear_active_state();
            self.shell_send_interaction_state();
            return;
        };
        let Some(edges) = self.input_routing.shell_resize_edges else {
            self.input_routing.shell_resize_clear_active_state();
            self.shell_send_interaction_state();
            return;
        };
        let Some(initial_rect) = self.input_routing.shell_resize_initial_rect else {
            self.input_routing.shell_resize_clear_active_state();
            self.shell_send_interaction_state();
            return;
        };

        if let Some(window) = self.find_window_by_surface_id(sid) {
            let tl = window.toplevel().unwrap();
            let wl = tl.wl_surface();
            let last_size = compute_clamped_resize_size(
                self,
                wl,
                edges,
                initial_rect.size,
                self.input_routing.shell_resize_accum.0,
                self.input_routing.shell_resize_accum.1,
            );

            tl.with_pending_state(|state| {
                state.states.unset(xdg_toplevel::State::Resizing);
                state.size = Some(last_size);
            });
            tl.send_pending_configure();
            resize_tracking_set_waiting_last_commit(wl, edges, initial_rect);
            self.shell_emit_interactive_resize_geometry(
                window_id,
                initial_rect,
                edges,
                last_size.w,
                last_size.h,
            );
        } else if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
            let rect = self.x11_resize_rect(
                &x11,
                initial_rect,
                edges,
                self.input_routing.shell_resize_accum.0,
                self.input_routing.shell_resize_accum.1,
            );
            self.apply_x11_window_bounds(
                window_id,
                &x11,
                rect,
                x11.is_maximized(),
                x11.is_fullscreen(),
                true,
            );
        } else {
            self.input_routing.shell_resize_clear_active_state();
            self.shell_send_interaction_state();
            return;
        }

        self.input_routing.shell_resize_clear_active_state();
        self.shell_send_interaction_state();

        tracing::debug!(
            target: "derp_shell_resize",
            window_id,
            "shell_resize_end: finished"
        );
    }
}
