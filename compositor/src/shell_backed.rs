use crate::chrome_bridge::WindowInfo;
use crate::grabs::resize_grab::ResizeEdge;
use crate::state::{CompositorState, ShellUiWindowPlacement};
use serde::Deserialize;
use smithay::utils::{Logical, Point, Rectangle, Size};

#[derive(Debug, Deserialize)]
pub(crate) struct ShellBackedOpenParams {
    pub(crate) window_id: u32,
    pub(crate) title: String,
    pub(crate) app_id: String,
    pub(crate) output_name: String,
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) w: i32,
    pub(crate) h: i32,
}

fn truncate_shell_ipc_string(mut s: String) -> String {
    let max = shell_wire::MAX_WINDOW_STRING_BYTES as usize;
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s
}

impl CompositorState {
    pub(crate) fn shell_hosted_client_global_rect(info: &WindowInfo) -> Rectangle<i32, Logical> {
        Rectangle::new(
            Point::from((info.x, info.y)),
            Size::from((info.width.max(1), info.height.max(1))),
        )
    }

    pub(crate) fn shell_backed_outer_global_rect(
        &self,
        info: &WindowInfo,
    ) -> Rectangle<i32, Logical> {
        let th = self.shell_chrome_titlebar_h.max(0);
        let bd = self.shell_chrome_border_w.max(0);
        let inset = if info.maximized { 0 } else { bd };
        let c = Self::shell_hosted_client_global_rect(info);
        let ox = c.loc.x.saturating_sub(inset);
        let oy = c.loc.y.saturating_sub(th + inset);
        let ow = c.size.w + inset * 2;
        let oh = c.size.h + th + inset * 2;
        Rectangle::new(Point::from((ox, oy)), Size::from((ow.max(1), oh.max(1))))
    }

    pub(crate) fn shell_backed_placements(&self) -> Vec<ShellUiWindowPlacement> {
        let Some(ws) = self.workspace_logical_bounds() else {
            return Vec::new();
        };
        let mut placements = Vec::new();
        for info in self.window_registry.shell_hosted_infos() {
            if info.minimized {
                continue;
            }
            let id = info.window_id;
            let outer = self.shell_backed_outer_global_rect(&info);
            let Some(clamped) = outer.intersection(ws) else {
                continue;
            };
            let Some(br) = self.shell_global_rect_to_buffer_rect(&clamped) else {
                continue;
            };
            placements.push(ShellUiWindowPlacement {
                id,
                z: self.shell_window_stack_z(id),
                global_rect: clamped,
                buffer_rect: br,
            });
        }
        placements
    }

    fn shell_backed_emit_geometry_messages(&mut self, info: &WindowInfo) {
        let Some(loc) = self.shell_window_info_to_output_local_layout(&info) else {
            return;
        };
        self.shell_send_to_cef(
            shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
                window_id: loc.window_id,
                surface_id: loc.surface_id,
                x: loc.x,
                y: loc.y,
                w: loc.width.max(1),
                h: loc.height.max(1),
                maximized: loc.maximized,
                fullscreen: false,
                client_side_decoration: false,
                output_name: loc.output_name.clone(),
            },
        );
    }

    fn shell_backed_emit_mapped_metas(&mut self, info: &WindowInfo) {
        let Some(loc) = self.shell_window_info_to_output_local_layout(&info) else {
            return;
        };
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowMapped {
            window_id: loc.window_id,
            surface_id: loc.surface_id,
            x: loc.x,
            y: loc.y,
            w: loc.width.max(1),
            h: loc.height.max(1),
            title: loc.title.clone(),
            app_id: loc.app_id.clone(),
            client_side_decoration: false,
            output_name: loc.output_name.clone(),
        });
        self.shell_send_to_cef(
            shell_wire::DecodedCompositorToShellMessage::WindowMetadata {
                window_id: loc.window_id,
                surface_id: loc.surface_id,
                title: loc.title.clone(),
                app_id: loc.app_id.clone(),
            },
        );
        self.shell_backed_emit_geometry_messages(info);
    }

    pub(crate) fn shell_backed_try_open_json(&mut self, json: &str) {
        let Ok(mut p) = serde_json::from_str::<ShellBackedOpenParams>(json) else {
            return;
        };
        if p.window_id == 0 {
            return;
        }
        p.title = truncate_shell_ipc_string(p.title);
        p.app_id = truncate_shell_ipc_string(p.app_id);
        p.output_name = truncate_shell_ipc_string(p.output_name);
        let lw = p.w.max(1);
        let lh = p.h.max(1);
        let Some((gx, gy, gw, gh)) =
            self.shell_output_local_rect_to_logical_global(p.x, p.y, lw, lh)
        else {
            return;
        };
        let client_global = Rectangle::new(
            Point::<i32, Logical>::from((gx, gy)),
            Size::<i32, Logical>::from((gw, gh)),
        );
        let id = p.window_id;

        let unmin = self
            .window_registry
            .window_info(id)
            .filter(|_| self.window_registry.is_shell_hosted(id))
            .is_some_and(|info| info.minimized);
        if unmin {
            let snap = self.window_registry.update_shell_hosted(id, |info, _| {
                info.minimized = false;
                info.clone()
            });
            self.shell_exclusion_zones_need_full_damage = true;
            self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowState {
                window_id: id,
                minimized: false,
            });
            if let Some(snap) = snap.as_ref() {
                self.shell_backed_emit_geometry_messages(snap);
            }
            self.shell_reply_window_list();
            self.shell_focus_shell_ui_window(id);
            return;
        }
        if self.window_registry.window_info(id).is_some() {
            return;
        }
        let inserted = self.window_registry.register_shell_hosted(
            id,
            p.title,
            p.app_id,
            p.output_name,
            client_global,
        );
        if inserted != Some(true) {
            return;
        }
        let info = self.window_registry.window_info(id).expect("inserted");
        self.shell_backed_emit_mapped_metas(&info);
        self.shell_exclusion_zones_need_full_damage = true;
        self.shell_reply_window_list();
        self.shell_focus_shell_ui_window(id);
    }

    pub(crate) fn shell_backed_close_if_any(&mut self, window_id: u32) -> bool {
        if !self.window_registry.is_shell_hosted(window_id) {
            return false;
        }
        self.cancel_shell_move_resize_for_window(window_id);
        if self.shell_focused_ui_window_id == Some(window_id) {
            self.shell_blur_shell_ui_focus();
        }
        self.window_registry.remove_shell_hosted(window_id);
        self.shell_window_stack_forget(window_id);
        self.shell_ui_pointer_grab = None;
        self.shell_send_to_cef(
            shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { window_id },
        );
        self.shell_exclusion_zones_need_full_damage = true;
        self.shell_reply_window_list();
        true
    }

    pub(crate) fn shell_backed_minimize_if_any(&mut self, window_id: u32) -> bool {
        let minimized = self
            .window_registry
            .update_shell_hosted(window_id, |info, _| {
                let already = info.minimized;
                if !already {
                    info.minimized = true;
                }
                already
            });
        let Some(already_minimized) = minimized else {
            return false;
        };
        if already_minimized {
            return true;
        }
        self.cancel_shell_move_resize_for_window(window_id);
        if self.shell_focused_ui_window_id == Some(window_id) {
            self.shell_emit_shell_ui_focus_if_changed(None);
        }
        self.shell_exclusion_zones_need_full_damage = true;
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowState {
            window_id,
            minimized: true,
        });
        self.shell_reply_window_list();
        true
    }

    pub(crate) fn shell_backed_restore_minimized_if_any(&mut self, window_id: u32) -> bool {
        let snap = self
            .window_registry
            .update_shell_hosted(window_id, |info, _| {
                if !info.minimized {
                    return None;
                }
                info.minimized = false;
                Some(info.clone())
            });
        let Some(Some(snap)) = snap else {
            return false;
        };
        self.shell_exclusion_zones_need_full_damage = true;
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::WindowState {
            window_id,
            minimized: false,
        });
        self.shell_backed_emit_geometry_messages(&snap);
        self.shell_reply_window_list();
        true
    }

    pub(crate) fn shell_backed_taskbar_activate(&mut self, window_id: u32) -> bool {
        if !self.window_registry.is_shell_hosted(window_id) {
            return false;
        }
        let minned = self
            .window_registry
            .window_info(window_id)
            .is_some_and(|info| info.minimized);
        if minned {
            self.shell_backed_restore_minimized_if_any(window_id);
            self.shell_focus_shell_ui_window(window_id);
            return true;
        }
        let ui = self.shell_focused_ui_window_id == Some(window_id)
            || (self.shell_focused_ui_window_id.is_none()
                && self.shell_ipc_keyboard_to_cef
                && self.shell_last_sent_ui_focus_id == Some(window_id));
        if ui {
            let _ = self.shell_backed_minimize_if_any(window_id);
        } else {
            self.shell_focus_shell_ui_window(window_id);
        }
        true
    }

    pub(crate) fn shell_move_try_begin_backed(&mut self, window_id: u32) -> bool {
        let Some(info) = self.window_registry.window_info(window_id) else {
            return false;
        };
        if !self.window_registry.is_shell_hosted(window_id) || info.minimized {
            return false;
        }
        if let Some(prev) = self.shell_move_window_id {
            if prev != window_id {
                if self.window_registry.is_shell_hosted(prev) {
                    self.shell_move_end_backed_only(prev);
                } else {
                    self.shell_move_end(prev);
                }
            }
        }
        self.shell_resize_end_active();
        self.shell_move_window_id = Some(window_id);
        self.shell_move_pending_delta = (0, 0);
        self.shell_ipc_keyboard_to_cef = true;
        self.shell_focus_shell_ui_window(window_id);
        true
    }

    pub(crate) fn shell_move_flush_pending_deltas_backed(&mut self) {
        let Some(wid) = self.shell_move_window_id else {
            return;
        };
        if !self.window_registry.is_shell_hosted(wid) {
            return;
        }
        let (pdx, pdy) = self.shell_move_pending_delta;
        if pdx == 0 && pdy == 0 {
            return;
        }
        let Some(snap) = self
            .window_registry
            .update_shell_hosted(wid, |info, float_restore| {
                if info.maximized {
                    info.maximized = false;
                    if float_restore.is_none() {
                        *float_restore = Some(Self::shell_hosted_client_global_rect(info));
                    }
                }
                info.x = info.x.saturating_add(pdx);
                info.y = info.y.saturating_add(pdy);
                info.clone()
            })
        else {
            self.shell_move_window_id = None;
            self.shell_move_pending_delta = (0, 0);
            return;
        };
        self.shell_move_pending_delta = (0, 0);
        self.shell_backed_emit_geometry_messages(&snap);
        self.shell_exclusion_zones_need_full_damage = true;
    }

    pub(crate) fn shell_move_end_backed_only(&mut self, window_id: u32) {
        if self.shell_move_window_id != Some(window_id)
            || !self.window_registry.is_shell_hosted(window_id)
        {
            return;
        }
        self.shell_move_flush_pending_deltas_backed();
        self.shell_move_window_id = None;
        self.shell_move_pending_delta = (0, 0);
        if let Some(info) = self.window_registry.window_info(window_id) {
            self.shell_backed_emit_geometry_messages(&info);
        }
        self.shell_reply_window_list();
    }

    pub(crate) fn shell_resize_try_begin_backed(
        &mut self,
        window_id: u32,
        edges_wire: u32,
    ) -> bool {
        let edges = ResizeEdge::from_bits_truncate(edges_wire);
        if edges.is_empty() {
            return false;
        }
        let Some(info) = self.window_registry.window_info(window_id) else {
            return false;
        };
        if !self.window_registry.is_shell_hosted(window_id) || info.minimized || info.maximized {
            return false;
        }
        let r = Self::shell_hosted_client_global_rect(&info);
        self.shell_resize_shell_grab = None;
        if let Some(mid) = self.shell_move_window_id {
            if self.window_registry.is_shell_hosted(mid) {
                self.shell_move_end_backed_only(mid);
            } else {
                self.shell_move_end(mid);
            }
        }
        if let Some(prev) = self.shell_resize_window_id {
            if self.window_registry.is_shell_hosted(prev) {
                self.shell_resize_end_backed_only(prev);
            } else {
                self.shell_resize_end(prev);
            }
        }
        self.shell_resize_window_id = Some(window_id);
        self.shell_resize_edges = Some(edges);
        self.shell_resize_initial_rect = Some(r);
        self.shell_resize_accum = (0.0, 0.0);
        self.shell_ipc_keyboard_to_cef = true;
        self.shell_focus_shell_ui_window(window_id);
        true
    }

    fn shell_resize_clamped_client_rect_backed(
        &self,
        edges: ResizeEdge,
        initial: Rectangle<i32, Logical>,
        accum_dx: f64,
        accum_dy: f64,
    ) -> Rectangle<i32, Logical> {
        let mut delta_x = accum_dx;
        let mut delta_y = accum_dy;
        if edges.intersects(ResizeEdge::LEFT) {
            delta_x = -delta_x;
        }
        if edges.intersects(ResizeEdge::TOP) {
            delta_y = -delta_y;
        }
        let min_w = 280i32;
        let min_h = 200i32;
        let mut nw = initial.size.w;
        let mut nh = initial.size.h;
        if edges.intersects(ResizeEdge::LEFT | ResizeEdge::RIGHT) {
            nw = (initial.size.w as f64 + delta_x) as i32;
        }
        if edges.intersects(ResizeEdge::TOP | ResizeEdge::BOTTOM) {
            nh = (initial.size.h as f64 + delta_y) as i32;
        }
        nw = nw.max(min_w);
        nh = nh.max(min_h);
        let mut x = initial.loc.x;
        let mut y = initial.loc.y;
        if edges.intersects(ResizeEdge::LEFT) {
            x = initial.loc.x + initial.size.w - nw;
        }
        if edges.intersects(ResizeEdge::TOP) {
            y = initial.loc.y + initial.size.h - nh;
        }
        Rectangle::new(Point::from((x, y)), Size::from((nw, nh)))
    }

    pub(crate) fn shell_resize_delta_backed(&mut self, dx: i32, dy: i32) {
        let Some(wid) = self.shell_resize_window_id else {
            return;
        };
        if !self.window_registry.is_shell_hosted(wid) {
            return;
        }
        let Some(edges) = self.shell_resize_edges else {
            return;
        };
        let Some(initial) = self.shell_resize_initial_rect else {
            return;
        };
        self.shell_resize_accum.0 += dx as f64;
        self.shell_resize_accum.1 += dy as f64;
        let nr = self.shell_resize_clamped_client_rect_backed(
            edges,
            initial,
            self.shell_resize_accum.0,
            self.shell_resize_accum.1,
        );
        let Some(snap) = self.window_registry.update_shell_hosted(wid, |info, _| {
            info.x = nr.loc.x;
            info.y = nr.loc.y;
            info.width = nr.size.w.max(1);
            info.height = nr.size.h.max(1);
            info.clone()
        }) else {
            self.shell_resize_window_id = None;
            self.shell_resize_edges = None;
            self.shell_resize_initial_rect = None;
            self.shell_resize_accum = (0.0, 0.0);
            return;
        };
        self.shell_backed_emit_geometry_messages(&snap);
        self.shell_exclusion_zones_need_full_damage = true;
    }

    pub(crate) fn shell_resize_end_backed_only(&mut self, window_id: u32) {
        if self.shell_resize_window_id != Some(window_id)
            || !self.window_registry.is_shell_hosted(window_id)
        {
            return;
        }
        self.shell_resize_window_id = None;
        self.shell_resize_edges = None;
        self.shell_resize_initial_rect = None;
        self.shell_resize_accum = (0.0, 0.0);
        if let Some(info) = self.window_registry.window_info(window_id) {
            self.shell_backed_emit_geometry_messages(&info);
        }
        self.shell_reply_window_list();
    }

    pub(crate) fn shell_backed_set_window_geometry_ipc(
        &mut self,
        window_id: u32,
        lx: i32,
        ly: i32,
        lw: i32,
        lh: i32,
        layout_state: u32,
    ) -> bool {
        let Some((gx, gy, gw, gh)) =
            self.shell_output_local_rect_to_logical_global(lx, ly, lw.max(1), lh.max(1))
        else {
            return false;
        };
        let max_work = if layout_state == 1 {
            let out = self
                .shell_effective_primary_output()
                .or_else(|| self.leftmost_output());
            out.as_ref()
                .and_then(|o| self.shell_maximize_work_area_global_for_output(o))
        } else {
            None
        };
        let target_output_name = if let Some(work) = max_work {
            self.output_for_window_position(work.loc.x, work.loc.y, work.size.w, work.size.h)
        } else {
            self.output_for_window_position(gx, gy, gw, gh)
        }
        .unwrap_or_default();
        let snap = self
            .window_registry
            .update_shell_hosted(window_id, |info, float_restore| {
                if info.minimized {
                    return Some(info.clone());
                }
                if layout_state == 1 {
                    if let Some(work) = max_work {
                        if !info.maximized && float_restore.is_none() {
                            *float_restore = Some(Self::shell_hosted_client_global_rect(info));
                        }
                        info.x = work.loc.x;
                        info.y = work.loc.y;
                        info.width = work.size.w.max(1);
                        info.height = work.size.h.max(1);
                        info.maximized = true;
                    }
                } else {
                    info.maximized = false;
                    info.x = gx;
                    info.y = gy;
                    info.width = gw.max(1);
                    info.height = gh.max(1);
                }
                info.output_name = target_output_name.clone();
                Some(info.clone())
            });
        let Some(Some(snap)) = snap else {
            return false;
        };
        self.shell_backed_emit_geometry_messages(&snap);
        self.shell_exclusion_zones_need_full_damage = true;
        self.shell_reply_window_list();
        true
    }
}
